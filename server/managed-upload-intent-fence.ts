import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export type ManagedUploadFenceScope =
  | { kind: "user"; userId: number }
  | { kind: "credential"; userId: number; credentialId: string }
  | { kind: "project"; userId: number; projectAssignmentId: string };

export type ManagedUploadDeletionFenceToken = {
  scope: ManagedUploadFenceScope;
  nonce: string;
};

export class ManagedUploadDeletionFenceError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_INTENT"
      | "DELETION_IN_PROGRESS"
      | "STALE_DELETION_FENCE",
  ) {
    super(code);
    this.name = "ManagedUploadDeletionFenceError";
  }
}

const LOCK_STALE_MS = 2 * 60_000;
const FENCE_LEASE_MS = 21 * 60_000;
const FENCE_HEARTBEAT_MS = 30_000;

function assetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function intentRoot() {
  return path.join(assetRoot(), "managed-upload-intents");
}

function fenceRoot() {
  return path.join(intentRoot(), "deletion-fences");
}

function scopeCoordinate(scope: ManagedUploadFenceScope) {
  return scope.kind === "user"
    ? [scope.kind, scope.userId]
    : scope.kind === "credential"
      ? // Credential ids are globally unique. The credential owner can be an
        // administrator while the intent actor is a customer using that shared
        // key, so userId must not partition the cryptoshred fence.
        [scope.kind, scope.credentialId]
      : [scope.kind, scope.userId, scope.projectAssignmentId];
}

function scopeKey(scope: ManagedUploadFenceScope) {
  return createHash("sha256")
    .update(JSON.stringify(scopeCoordinate(scope)), "utf8")
    .digest("hex");
}

function fencePath(scope: ManagedUploadFenceScope) {
  return path.join(fenceRoot(), `${scopeKey(scope)}.json`);
}

function lockPath(scope: ManagedUploadFenceScope) {
  return path.join(fenceRoot(), "locks", `${scopeKey(scope)}.lock`);
}

async function ensurePrivateDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const firstCreated = await fs.mkdir(resolved, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  if (firstCreated) {
    let created = path.resolve(firstCreated);
    for (;;) {
      await fsyncDirectory(path.dirname(created));
      if (created === resolved) break;
      const next = path.relative(created, resolved).split(path.sep)[0];
      if (!next || next === "..") {
        throw new Error("MANAGED_UPLOAD_DIRECTORY_DURABILITY_INVALID");
      }
      created = path.join(created, next);
    }
  }
}

async function fsyncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(target: string, value: unknown) {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
    await fsyncDirectory(path.dirname(target));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireScopeLock(scope: ManagedUploadFenceScope) {
  const target = lockPath(scope);
  await ensurePrivateDirectory(path.dirname(target));
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(`${nonce}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(path.dirname(target));
      let heartbeat = Promise.resolve();
      const timer = setInterval(
        () => {
          heartbeat = heartbeat
            .then(async () => {
              const current = await fs.readFile(target, "utf8").catch(() => "");
              if (current.trim() !== nonce) return;
              const now = new Date();
              await fs.utimes(target, now, now);
            })
            .catch(() => undefined);
        },
        Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)),
      );
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        await heartbeat;
        const current = await fs.readFile(target, "utf8").catch(() => "");
        if (current.trim() === nonce) {
          await fs.rm(target, { force: true });
          await fsyncDirectory(path.dirname(target));
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(target).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
        const quarantine = `${target}.stale.${randomUUID()}`;
        try {
          await fs.rename(target, quarantine);
          const moved = await fs.stat(quarantine);
          if (Date.now() - moved.mtimeMs > LOCK_STALE_MS) {
            await fs.rm(quarantine, { force: true });
            await fsyncDirectory(path.dirname(target));
            continue;
          }
          await fs.rename(quarantine, target).catch(async () => {
            await fs.rm(quarantine, { force: true });
          });
        } catch (moveError) {
          if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw moveError;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
}

async function readFence(scope: ManagedUploadFenceScope) {
  try {
    const value = JSON.parse(
      await fs.readFile(fencePath(scope), "utf8"),
    ) as Record<string, unknown>;
    const deletingShapeValid =
      value.state !== "deleting" ||
      (typeof value.leaseOwner === "string" &&
        typeof value.leaseExpiresAt === "string" &&
        Number.isFinite(Date.parse(value.leaseExpiresAt)) &&
        typeof value.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.updatedAt)));
    const storedScope = value.scope as ManagedUploadFenceScope | undefined;
    const storedCoordinateValid =
      storedScope !== undefined &&
      JSON.stringify(scopeCoordinate(storedScope)) ===
        JSON.stringify(scopeCoordinate(scope));
    if (
      (value.state !== "deleting" && value.state !== "deleted") ||
      value.scopeKey !== scopeKey(scope) ||
      typeof value.nonce !== "string" ||
      !deletingShapeValid ||
      !storedCoordinateValid
    ) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_INVALID");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function manifestMatchesScope(
  value: Record<string, unknown>,
  scope: ManagedUploadFenceScope,
) {
  if (scope.kind === "credential") {
    return value.credentialId === scope.credentialId;
  }
  if (
    value.userId !== scope.userId &&
    value.credentialOwnerUserId !== scope.userId
  ) {
    return false;
  }
  if (scope.kind === "project") {
    if (value.userId !== scope.userId) return false;
    return value.projectAssignmentId === scope.projectAssignmentId;
  }
  return true;
}

async function hasActiveIntent(scope: ManagedUploadFenceScope) {
  const entries = await fs
    .readdir(intentRoot(), { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === "by-operation" ||
      entry.name === "deletion-fences"
    ) {
      continue;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(
        await fs.readFile(
          path.join(intentRoot(), entry.name, "manifest.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
    } catch {
      // Corrupt durable state might hide the exact deletion dependency. Every
      // permanent deletion fails closed until an administrator repairs it.
      return true;
    }
    const leaseIsActive =
      typeof value.leaseOwner === "string" &&
      typeof value.leaseExpiresAt === "string" &&
      Date.parse(value.leaseExpiresAt) > Date.now();
    const expiredHasKnownProvider =
      value.state === "expired" &&
      Array.isArray(value.provider) &&
      value.provider.some((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const generation = candidate as Record<string, unknown>;
        return (
          typeof generation.fileId === "string" &&
          generation.fileId.length > 0 &&
          generation.state !== "discarded"
        );
      });
    if (
      manifestMatchesScope(value, scope) &&
      (leaseIsActive ||
        expiredHasKnownProvider ||
        !["uploaded", "cancelled", "expired"].includes(String(value.state)))
    ) {
      return true;
    }
  }
  return false;
}

export async function assertManagedUploadScopesAvailable(
  scopes: ManagedUploadFenceScope[],
) {
  for (const scope of scopes) {
    if (await readFence(scope)) {
      throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
    }
  }
}

/** Holds every scope guard across intent allocation to close create/delete races. */
export async function acquireManagedUploadScopeGuards(
  scopes: ManagedUploadFenceScope[],
) {
  const unique = [
    ...new Map(scopes.map((scope) => [scopeKey(scope), scope])).values(),
  ].sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)));
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const scope of unique) releases.push(await acquireScopeLock(scope));
    await assertManagedUploadScopesAvailable(unique);
    return async () => {
      for (const release of releases.reverse()) await release();
    };
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
}

export async function acquireManagedUploadDeletionFence(
  scope: ManagedUploadFenceScope,
): Promise<ManagedUploadDeletionFenceToken> {
  const release = await acquireScopeLock(scope);
  try {
    const existing = await readFence(scope);
    if (existing) {
      if (
        existing.state === "deleting" &&
        Date.parse(String(existing.leaseExpiresAt)) <= Date.now()
      ) {
        throw new ManagedUploadDeletionFenceError("STALE_DELETION_FENCE");
      }
      throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
    }
    const token = { scope, nonce: randomUUID() };
    const timestamp = new Date();
    await writeAtomic(fencePath(scope), {
      schemaVersion: 1,
      scopeKey: scopeKey(scope),
      state: "deleting",
      nonce: token.nonce,
      scope,
      leaseOwner: token.nonce,
      leaseExpiresAt: new Date(
        timestamp.getTime() + FENCE_LEASE_MS,
      ).toISOString(),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
    if (await hasActiveIntent(scope)) {
      await fs.rm(fencePath(scope), { force: true });
      await fsyncDirectory(fenceRoot());
      throw new ManagedUploadDeletionFenceError("ACTIVE_INTENT");
    }
    return token;
  } finally {
    await release();
  }
}

/**
 * Reconciles only an expired deletion fence after the caller has checked the
 * authoritative database state. A live lease is never stolen merely because
 * the row still looks active while the first transaction is in flight.
 */
export async function reconcileStaleManagedUploadDeletionFence(
  scope: ManagedUploadFenceScope,
  disposition: "active" | "deleted",
) {
  const release = await acquireScopeLock(scope);
  try {
    const current = await readFence(scope);
    if (!current) return disposition;
    if (current.state === "deleted") return "deleted" as const;
    if (
      disposition === "active" &&
      Date.parse(String(current.leaseExpiresAt)) > Date.now()
    ) {
      throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
    }
    if (disposition === "deleted") {
      await writeAtomic(fencePath(scope), {
        schemaVersion: 1,
        scopeKey: scopeKey(scope),
        state: "deleted",
        nonce: current.nonce,
        scope,
        createdAt:
          typeof current.createdAt === "string"
            ? current.createdAt
            : new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    } else {
      await fs.rm(fencePath(scope), { force: true });
      await fsyncDirectory(fenceRoot());
    }
    return disposition;
  } finally {
    await release();
  }
}

export async function renewManagedUploadDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  const release = await acquireScopeLock(token.scope);
  try {
    const current = await readFence(token.scope);
    if (
      !current ||
      current.state !== "deleting" ||
      current.nonce !== token.nonce
    ) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_TOKEN_INVALID");
    }
    const timestamp = new Date();
    await writeAtomic(fencePath(token.scope), {
      ...current,
      leaseOwner: token.nonce,
      leaseExpiresAt: new Date(
        timestamp.getTime() + FENCE_LEASE_MS,
      ).toISOString(),
      updatedAt: timestamp.toISOString(),
    });
  } finally {
    await release();
  }
}

export function startManagedUploadDeletionFenceHeartbeat(
  token: ManagedUploadDeletionFenceToken,
) {
  let stopped = false;
  let failure: unknown = null;
  let current = Promise.resolve();
  const timer = setInterval(() => {
    current = current
      .then(() => renewManagedUploadDeletionFence(token))
      .catch((error) => {
        failure = error;
      });
  }, FENCE_HEARTBEAT_MS);
  timer.unref?.();
  return async () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
    await current;
    if (failure) throw failure;
  };
}

async function assertToken(token: ManagedUploadDeletionFenceToken) {
  const current = await readFence(token.scope);
  if (
    !current ||
    current.state !== "deleting" ||
    current.nonce !== token.nonce
  ) {
    throw new Error("MANAGED_UPLOAD_DELETION_FENCE_TOKEN_INVALID");
  }
}

export async function completeManagedUploadDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  const release = await acquireScopeLock(token.scope);
  try {
    await assertToken(token);
    await writeAtomic(fencePath(token.scope), {
      schemaVersion: 1,
      scopeKey: scopeKey(token.scope),
      state: "deleted",
      nonce: token.nonce,
      scope: token.scope,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
  } finally {
    await release();
  }
}

export async function listManagedUploadCredentialDeletionFenceScopes(
  ownerUserId: number,
) {
  const entries = await fs
    .readdir(fenceRoot(), { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  const scopes: Array<
    Extract<ManagedUploadFenceScope, { kind: "credential" }>
  > = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(
      await fs.readFile(path.join(fenceRoot(), entry.name), "utf8"),
    ) as Record<string, unknown>;
    const scope = value.scope as ManagedUploadFenceScope | undefined;
    if (!scope || scope.kind !== "credential" || scope.userId !== ownerUserId) {
      continue;
    }
    if (
      entry.name !== `${scopeKey(scope)}.json` ||
      value.scopeKey !== scopeKey(scope)
    ) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_INVALID");
    }
    // Re-read through the strict validator before returning authority-bearing
    // coordinates to auth-service.
    await readFence(scope);
    scopes.push(scope);
  }
  return scopes;
}

export async function rollbackManagedUploadDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  const release = await acquireScopeLock(token.scope);
  try {
    await assertToken(token);
    await fs.rm(fencePath(token.scope), { force: true });
    await fsyncDirectory(fenceRoot());
  } finally {
    await release();
  }
}

export function assertCredentialDeletionFenceToken(
  token: ManagedUploadDeletionFenceToken,
  input: { userId: number; credentialId: string },
) {
  if (
    token.scope.kind !== "credential" ||
    token.scope.userId !== input.userId ||
    token.scope.credentialId !== input.credentialId
  ) {
    throw new Error("MANAGED_UPLOAD_DELETION_FENCE_SCOPE_MISMATCH");
  }
}
