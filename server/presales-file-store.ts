import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type PresalesFileManifest = {
  schemaVersion: 1;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  state: "pending" | "stored";
  updatedAt: string;
};

type PresalesFileCreateReservation = {
  schemaVersion: 1;
  keyHash: string;
  requestHash: string;
  apiCredentialId: string;
  credentialVersion: number;
  status: "pending" | "completed" | "deleted";
  attemptId: string;
  leaseExpiresAt: string;
  upstreamFileId: string | null;
  upstreamFilename: string | null;
  upstreamStatus: string | null;
  uploadUrl: string | null;
  uploadExpiresAt: string | number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

type PresalesFileCreateIndex = {
  schemaVersion: 1;
  upstreamFileId: string;
  keyHash: string;
};

export type PresalesFileCreateReservationResult =
  | {
      state: "acquired";
      keyHash: string;
      attemptId: string;
      leaseExpiresAt: Date;
    }
  | {
      state: "completed";
      upstreamFileId: string;
      upstreamFilename: string | null;
      upstreamStatus: string | null;
      uploadUrl: string | null;
      uploadExpiresAt: string | number | null;
    }
  | { state: "deleted"; upstreamFileId: string }
  | { state: "conflict" }
  | { state: "pending"; retryAfterMs: number };

const FILE_CREATE_RESERVATION_LEASE_MS = 60_000;
const FILE_CREATE_LOCK_STALE_MS = 30_000;

export type StagedPresalesFile = {
  sizeBytes: number;
  sha256: string;
  createReadStream: () => ReadStream;
  commit: (input: { filename?: string; mimeType?: string }) => Promise<void>;
  discard: () => Promise<void>;
};

export type StoredPresalesFile = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  createReadStream: () => ReadStream;
};

function storageRoot() {
  const assetRoot = path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
  return path.join(assetRoot, "presales-files");
}

function storageKey(fileId: string) {
  return createHash("sha256").update(fileId, "utf8").digest("hex");
}

export function hashPresalesFileIdempotencyKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashPresalesFileCreatePayload(input: {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        filename: input.filename,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

function reservationRoot() {
  return path.join(storageRoot(), "create-reservations");
}

function reservationPaths(keyHash: string) {
  const root = reservationRoot();
  return {
    root,
    reservation: path.join(root, `${keyHash}.json`),
    lock: path.join(root, `${keyHash}.lock`),
  };
}

function reservationIndexPath(fileId: string) {
  return path.join(reservationRoot(), "by-file", `${storageKey(fileId)}.json`);
}

async function ensurePrivateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function writeJsonAtomic(target: string, value: unknown) {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseReservation(
  value: unknown,
  expectedKeyHash: string,
): PresalesFileCreateReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PRESALES_FILE_RESERVATION_INVALID");
  }
  const record = value as Partial<PresalesFileCreateReservation>;
  if (
    record.schemaVersion !== 1 ||
    record.keyHash !== expectedKeyHash ||
    typeof record.requestHash !== "string" ||
    typeof record.apiCredentialId !== "string" ||
    !Number.isSafeInteger(record.credentialVersion) ||
    (record.status !== "pending" &&
      record.status !== "completed" &&
      record.status !== "deleted") ||
    typeof record.attemptId !== "string" ||
    !Number.isFinite(Date.parse(String(record.leaseExpiresAt))) ||
    (record.upstreamFileId !== null &&
      typeof record.upstreamFileId !== "string") ||
    (record.upstreamFilename !== null &&
      typeof record.upstreamFilename !== "string") ||
    (record.upstreamStatus !== null &&
      typeof record.upstreamStatus !== "string") ||
    (record.uploadUrl !== null && typeof record.uploadUrl !== "string") ||
    (record.uploadExpiresAt !== null &&
      typeof record.uploadExpiresAt !== "string" &&
      typeof record.uploadExpiresAt !== "number") ||
    !Number.isFinite(Date.parse(String(record.createdAt))) ||
    !Number.isFinite(Date.parse(String(record.updatedAt))) ||
    (record.completedAt !== null &&
      !Number.isFinite(Date.parse(String(record.completedAt)))) ||
    (record.deletedAt !== null &&
      !Number.isFinite(Date.parse(String(record.deletedAt))))
  ) {
    throw new Error("PRESALES_FILE_RESERVATION_INVALID");
  }
  return record as PresalesFileCreateReservation;
}

async function readReservation(keyHash: string) {
  const { reservation } = reservationPaths(keyHash);
  try {
    return parseReservation(
      JSON.parse(await fs.readFile(reservation, "utf8")),
      keyHash,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withReservationLock<T>(
  keyHash: string,
  operation: () => Promise<T>,
): Promise<T> {
  const { root, lock } = reservationPaths(keyHash);
  await ensurePrivateDirectory(root);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lock, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(lock).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > FILE_CREATE_LOCK_STALE_MS) {
        await fs.rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("PRESALES_FILE_RESERVATION_LOCKED");
}

function completedReservationResult(
  reservation: PresalesFileCreateReservation,
): PresalesFileCreateReservationResult {
  if (!reservation.upstreamFileId) {
    throw new Error("PRESALES_FILE_RESERVATION_INVALID");
  }
  return {
    state: "completed",
    upstreamFileId: reservation.upstreamFileId,
    upstreamFilename: reservation.upstreamFilename,
    upstreamStatus: reservation.upstreamStatus,
    uploadUrl: reservation.uploadUrl,
    uploadExpiresAt: reservation.uploadExpiresAt,
  };
}

export async function acquirePresalesFileCreateReservation(input: {
  idempotencyKey: string;
  requestHash: string;
  apiCredentialId: string;
  credentialVersion: number;
  now?: Date;
  leaseMs?: number;
}): Promise<PresalesFileCreateReservationResult> {
  const keyHash = hashPresalesFileIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? FILE_CREATE_RESERVATION_LEASE_MS;
  const paths = reservationPaths(keyHash);
  await ensurePrivateDirectory(paths.root);

  const createPendingReservation = () => {
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const timestamp = now.toISOString();
    return {
      reservation: {
        schemaVersion: 1 as const,
        keyHash,
        requestHash: input.requestHash,
        apiCredentialId: input.apiCredentialId,
        credentialVersion: input.credentialVersion,
        status: "pending" as const,
        attemptId,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        upstreamFileId: null,
        upstreamFilename: null,
        upstreamStatus: null,
        uploadUrl: null,
        uploadExpiresAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        deletedAt: null,
      },
      result: {
        state: "acquired" as const,
        keyHash,
        attemptId,
        leaseExpiresAt,
      },
    };
  };

  const fresh = createPendingReservation();
  try {
    await fs.writeFile(
      paths.reservation,
      `${JSON.stringify(fresh.reservation)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return fresh.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  return withReservationLock(keyHash, async () => {
    const current = await readReservation(keyHash);
    if (!current) {
      const replacement = createPendingReservation();
      await writeJsonAtomic(paths.reservation, replacement.reservation);
      return replacement.result;
    }
    if (current.requestHash !== input.requestHash) {
      return { state: "conflict" };
    }
    // A completed operation is immutable. If its HTTP response was lost, a
    // retry after API-key rotation must return the one file already created,
    // rather than conflict or create a second file in another account. The
    // caller will copy that file under a new generation before creating any
    // task with the current credential. Deleted operations keep the same
    // cross-rotation tombstone barrier.
    if (current.status === "completed") {
      return completedReservationResult(current);
    }
    if (current.status === "deleted") {
      if (!current.upstreamFileId) {
        throw new Error("PRESALES_FILE_RESERVATION_INVALID");
      }
      return {
        state: "deleted",
        upstreamFileId: current.upstreamFileId,
      };
    }
    if (
      current.apiCredentialId !== input.apiCredentialId ||
      current.credentialVersion !== input.credentialVersion
    ) {
      return { state: "conflict" };
    }
    const remainingMs = Date.parse(current.leaseExpiresAt) - now.getTime();
    if (remainingMs > 0) {
      return {
        state: "pending",
        retryAfterMs: Math.max(1_000, Math.min(remainingMs, 5_000)),
      };
    }
    const replacement = createPendingReservation();
    await writeJsonAtomic(paths.reservation, {
      ...current,
      attemptId: replacement.reservation.attemptId,
      leaseExpiresAt: replacement.reservation.leaseExpiresAt,
      updatedAt: replacement.reservation.updatedAt,
    });
    return replacement.result;
  });
}

export async function releasePresalesFileCreateReservation(input: {
  keyHash: string;
  attemptId: string;
}) {
  await withReservationLock(input.keyHash, async () => {
    const current = await readReservation(input.keyHash);
    if (
      current?.status === "pending" &&
      current.attemptId === input.attemptId
    ) {
      await fs.rm(reservationPaths(input.keyHash).reservation, { force: true });
    }
  });
}

export async function completePresalesFileCreateReservation(input: {
  keyHash: string;
  attemptId: string;
  upstreamFileId: string;
  upstreamFilename?: string;
  upstreamStatus?: string;
  uploadUrl?: string;
  uploadExpiresAt?: string | number;
  now?: Date;
}) {
  await withReservationLock(input.keyHash, async () => {
    const current = await readReservation(input.keyHash);
    if (!current) throw new Error("PRESALES_FILE_RESERVATION_NOT_FOUND");
    if (current.status === "completed") {
      if (current.upstreamFileId === input.upstreamFileId) return;
      throw new Error("PRESALES_FILE_RESERVATION_CONFLICT");
    }
    if (current.status === "deleted") {
      throw new Error("PRESALES_FILE_RESERVATION_RETIRED");
    }
    if (current.attemptId !== input.attemptId) {
      throw new Error("PRESALES_FILE_RESERVATION_LEASE_LOST");
    }
    const index: PresalesFileCreateIndex = {
      schemaVersion: 1,
      upstreamFileId: input.upstreamFileId,
      keyHash: input.keyHash,
    };
    await writeJsonAtomic(reservationIndexPath(input.upstreamFileId), index);
    const now = input.now ?? new Date();
    await writeJsonAtomic(reservationPaths(input.keyHash).reservation, {
      ...current,
      status: "completed",
      upstreamFileId: input.upstreamFileId,
      upstreamFilename: input.upstreamFilename ?? null,
      upstreamStatus: input.upstreamStatus ?? null,
      uploadUrl: input.uploadUrl ?? null,
      uploadExpiresAt: input.uploadExpiresAt ?? null,
      leaseExpiresAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: now.toISOString(),
    } satisfies PresalesFileCreateReservation);
  });
}

export async function removePresalesFileCreateReservation(fileId: string) {
  const indexPath = reservationIndexPath(fileId);
  let index: PresalesFileCreateIndex | null = null;
  try {
    const parsed = JSON.parse(
      await fs.readFile(indexPath, "utf8"),
    ) as Partial<PresalesFileCreateIndex>;
    if (
      parsed.schemaVersion === 1 &&
      parsed.upstreamFileId === fileId &&
      typeof parsed.keyHash === "string" &&
      /^[a-f0-9]{64}$/.test(parsed.keyHash)
    ) {
      index = parsed as PresalesFileCreateIndex;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!index) {
    await fs.rm(indexPath, { force: true });
    return;
  }
  await withReservationLock(index.keyHash, async () => {
    const current = await readReservation(index!.keyHash);
    if (current?.upstreamFileId === fileId) {
      const now = new Date().toISOString();
      // Keep a compact permanent tombstone. Deleting the operation identity
      // would let a delayed retry recreate an already-cleaned temporary file.
      // Signed upload capabilities and filenames are discarded here, while
      // the hashed operation/request binding remains as the reuse barrier.
      await writeJsonAtomic(reservationPaths(index!.keyHash).reservation, {
        ...current,
        status: "deleted",
        upstreamFilename: null,
        upstreamStatus: null,
        uploadUrl: null,
        uploadExpiresAt: null,
        leaseExpiresAt: now,
        updatedAt: now,
        deletedAt: now,
      } satisfies PresalesFileCreateReservation);
    }
    await fs.rm(indexPath, { force: true });
  });
}

function pathsFor(fileId: string) {
  const root = storageRoot();
  const key = storageKey(fileId);
  return {
    root,
    content: path.join(root, `${key}.content`),
    manifest: path.join(root, `${key}.json`),
  };
}

function cleanFilename(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return normalized ? normalized.slice(0, 512) : fallback;
}

function cleanMimeType(value: unknown) {
  const normalized = String(value || "")
    .replace(/[\r\n]/g, "")
    .trim();
  return normalized && normalized.length <= 255
    ? normalized
    : "application/octet-stream";
}

async function readManifest(fileId: string) {
  const { manifest } = pathsFor(fileId);
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifest, "utf8"),
    ) as Partial<PresalesFileManifest>;
    if (parsed.schemaVersion !== 1 || parsed.fileId !== fileId) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeManifest(fileId: string, value: PresalesFileManifest) {
  const { root, manifest } = pathsFor(fileId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, manifest);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function recordPresalesFileDescriptor(input: {
  fileId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}) {
  await writeManifest(input.fileId, {
    schemaVersion: 1,
    fileId: input.fileId,
    filename: cleanFilename(input.filename, input.fileId),
    mimeType: cleanMimeType(input.mimeType),
    sizeBytes:
      Number.isSafeInteger(input.sizeBytes) && Number(input.sizeBytes) >= 0
        ? Number(input.sizeBytes)
        : null,
    sha256: null,
    state: "pending",
    updatedAt: new Date().toISOString(),
  });
}

export async function stagePresalesFileContent(input: {
  fileId: string;
  stream: Readable;
  maxBytes: number;
}): Promise<StagedPresalesFile> {
  const paths = pathsFor(input.fileId);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.root, 0o700).catch(() => undefined);
  const temporary = path.join(
    paths.root,
    `${storageKey(input.fileId)}.${randomUUID()}.upload.tmp`,
  );
  let sizeBytes = 0;
  const hash = createHash("sha256");
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > input.maxBytes) {
        callback(new Error("FILE_TOO_LARGE"));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });

  try {
    await pipeline(
      input.stream,
      limiter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  const sha256 = hash.digest("hex");
  let consumed = false;
  const discard = async () => {
    if (consumed) return;
    consumed = true;
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  };

  return {
    sizeBytes,
    sha256,
    createReadStream: () => createReadStream(temporary),
    discard,
    commit: async ({ filename, mimeType }) => {
      if (consumed) throw new Error("STAGED_FILE_ALREADY_CONSUMED");
      const previous = await readManifest(input.fileId);
      const manifest: PresalesFileManifest = {
        schemaVersion: 1,
        fileId: input.fileId,
        filename: cleanFilename(filename ?? previous?.filename, input.fileId),
        mimeType: cleanMimeType(mimeType ?? previous?.mimeType),
        sizeBytes,
        sha256,
        state: "stored",
        updatedAt: new Date().toISOString(),
      };
      try {
        await fs.rename(temporary, paths.content);
        consumed = true;
        await writeManifest(input.fileId, manifest);
      } catch (error) {
        consumed = true;
        await Promise.all([
          fs.rm(temporary, { force: true }).catch(() => undefined),
          fs.rm(paths.content, { force: true }).catch(() => undefined),
        ]);
        throw error;
      }
    },
  };
}

export async function readStoredPresalesFile(
  fileId: string,
): Promise<StoredPresalesFile | null> {
  const paths = pathsFor(fileId);
  let stats;
  try {
    stats = await fs.stat(paths.content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error("LOCAL_FILE_CONTENT_INVALID");
  }
  const manifest = await readManifest(fileId);
  if (
    manifest?.state === "stored" &&
    Number.isSafeInteger(manifest.sizeBytes) &&
    manifest.sizeBytes !== stats.size
  ) {
    throw new Error("LOCAL_FILE_CONTENT_SIZE_MISMATCH");
  }
  return {
    filename: cleanFilename(manifest?.filename, fileId),
    mimeType: cleanMimeType(manifest?.mimeType),
    sizeBytes: stats.size,
    sha256: typeof manifest?.sha256 === "string" ? manifest.sha256 : null,
    createReadStream: () => createReadStream(paths.content),
  };
}

export async function removeStoredPresalesFile(fileId: string) {
  const paths = pathsFor(fileId);
  await Promise.all([
    fs.rm(paths.content, { force: true }),
    fs.rm(paths.manifest, { force: true }),
  ]);
}
