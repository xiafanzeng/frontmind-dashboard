import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

import {
  presalesApiCredentials,
  presalesOutputUrls,
  presalesMonitorRuns,
  presalesTaskRequests,
  presalesUpstreamResources,
  type PresalesApiCredential,
  type PresalesTaskRequest,
  type PresalesUpstreamResource,
} from "../drizzle/schema";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
  getApiKeyFingerprint,
  validateUpstreamApiKey,
} from "./auth-service";
import { getDb } from "./db";
import { getUpstreamBaseUrl } from "./upstream-config";

const PRESALES_CREDENTIAL_SLOT = "website";
export const PRESALES_REVOKABLE_STATUSES = ["active", "retired"] as const;
const CREDIT_USAGE_LOOKBACK_DAYS = 30;
const CREDIT_USAGE_PAGE_LIMIT = 100;
const CREDIT_USAGE_MAX_PAGES = 20;
const PRESALES_TASK_LEASE_MS = 3 * 60 * 1000;

export type PresalesCredentialStatus = {
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  version: number | null;
  verifiedAt: number | null;
  updatedAt: number | null;
};

export type DecryptedPresalesCredential = {
  id: string;
  version: number;
  apiKey: string;
  fingerprint: string;
  status: "active" | "retired";
  verifiedAt: Date | null;
};

export type PresalesCreditUsageTask = {
  id: string;
  title: string;
  creditUsage: number;
  createdAt: number | null;
};

export type WebsiteApiKeyUsage = {
  windowDays: number;
  keyTotalUsed: number;
  websiteUsed: number;
  recentWebsiteTasks: PresalesCreditUsageTask[];
  fetchedAt: number;
};

export type PresalesTaskReservation =
  | {
      state: "acquired";
      reservationId: string;
      attemptId: string;
      keyHash: string;
      leaseExpiresAt: Date;
    }
  | {
      state: "completed";
      upstreamTaskId: string;
      task: Record<string, unknown>;
    };

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function presalesCredentialAad(credentialId: string) {
  return `frontmind-presales-api-credential:v1:${PRESALES_CREDENTIAL_SLOT}:${credentialId}`;
}

export function encryptPresalesApiKey(credentialId: string, apiKey: string) {
  return encryptCredentialSecret(presalesCredentialAad(credentialId), apiKey);
}

export function decryptPresalesApiKey(
  credential: Pick<
    PresalesApiCredential,
    | "id"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(
    presalesCredentialAad(credential.id),
    credential,
  );
}

function toCredentialStatus(
  credential?: PresalesApiCredential | null,
): PresalesCredentialStatus {
  const isVisible = Boolean(credential && credential.status !== "deleted");
  const status =
    !credential || credential.status === "deleted"
      ? null
      : credential.validationStatus === "invalid"
        ? "invalid"
        : credential.status;
  return {
    configured: Boolean(credential && credential.status === "active"),
    fingerprint: isVisible ? (credential?.fingerprint ?? null) : null,
    status,
    version: isVisible ? (credential?.version ?? null) : null,
    verifiedAt: isVisible ? (credential?.verifiedAt?.getTime() ?? null) : null,
    updatedAt: isVisible ? (credential?.updatedAt?.getTime() ?? null) : null,
  };
}

export async function getPresalesCredentialStatus() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return toCredentialStatus(rows[0]);
}

export async function replacePresalesApiCredential(
  actorUserId: number,
  apiKey: string,
  validator: (apiKey: string) => Promise<void> = validateUpstreamApiKey,
) {
  await validator(apiKey);
  const db = await requireDb();
  const credentialId = randomUUID();
  const encrypted = encryptPresalesApiKey(credentialId, apiKey);
  const fingerprint = getApiKeyFingerprint(apiKey);
  const now = new Date();

  const inserted = await db.transaction(async (tx) => {
    const latest = await tx
      .select()
      .from(presalesApiCredentials)
      .where(eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT))
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    const nextVersion = (latest[0]?.version ?? 0) + 1;

    await tx
      .update(presalesApiCredentials)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(
          eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      );

    const credential = {
      id: credentialId,
      slot: PRESALES_CREDENTIAL_SLOT,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active" as const,
      validationStatus: "verified" as const,
      createdByUserId: actorUserId,
      verifiedAt: now,
      retiredAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(presalesApiCredentials).values(credential);
    return credential;
  });

  return toCredentialStatus(inserted);
}

export async function deletePresalesApiCredential(executor?: any) {
  const db = executor ?? (await requireDb());
  const now = new Date();
  const remove = async (tx: any) => {
    await tx
      .update(presalesApiCredentials)
      .set({
        status: "deleted",
        validationStatus: "unverified",
        deletedAt: now,
        encryptedKey: randomBytes(32).toString("base64"),
        encryptionIv: randomBytes(12).toString("base64"),
        encryptionAuthTag: randomBytes(16).toString("base64"),
      })
      .where(
        and(
          eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
          inArray(presalesApiCredentials.status, [
            ...PRESALES_REVOKABLE_STATUSES,
          ]),
        ),
      );
  };
  if (executor) await remove(db);
  else await db.transaction(remove);
}

function toDecryptedCredential(
  credential: PresalesApiCredential,
): DecryptedPresalesCredential {
  if (credential.status === "deleted") {
    throw new AuthServiceError(
      "NOT_FOUND",
      "Presales API credential not found",
    );
  }
  return {
    id: credential.id,
    version: credential.version,
    apiKey: decryptPresalesApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
  };
}

export async function getActivePresalesCredential() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return rows[0] ? toDecryptedCredential(rows[0]) : null;
}

/**
 * Resolve the immutable credential version bound to a durable presales run.
 * Retired credentials remain usable for their existing resources; deleted
 * credentials fail closed because their ciphertext has been cryptoshredded.
 */
export async function getPresalesCredentialById(credentialId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, credentialId),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ? toDecryptedCredential(rows[0]) : null;
}

export async function testPresalesApiCredential(apiKey?: string) {
  const credential = apiKey ? null : await getActivePresalesCredential();
  const value = apiKey ?? credential?.apiKey;
  if (!value) {
    throw new AuthServiceError("NOT_FOUND", "请先配置售前 API Key");
  }
  await validateUpstreamApiKey(value);
  return { ok: true } as const;
}

export async function getPresalesCredentialForResource(
  kind: "task" | "file",
  upstreamId: string,
): Promise<
  (DecryptedPresalesCredential & { resource: PresalesUpstreamResource }) | null
> {
  const db = await requireDb();
  const rows = await db
    .select({
      resource: presalesUpstreamResources,
      credential: presalesApiCredentials,
    })
    .from(presalesUpstreamResources)
    .innerJoin(
      presalesApiCredentials,
      eq(presalesUpstreamResources.apiCredentialId, presalesApiCredentials.id),
    )
    .where(
      and(
        eq(presalesUpstreamResources.kind, kind),
        eq(presalesUpstreamResources.upstreamId, upstreamId),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.credential.status === "deleted") return null;
  return {
    ...toDecryptedCredential(row.credential),
    resource: row.resource,
  };
}

type PresalesResourceCredential = DecryptedPresalesCredential & {
  resource: PresalesUpstreamResource;
};

type PresalesTaskCredentialResolverOptions = {
  getActive?: () => Promise<DecryptedPresalesCredential | null>;
  getForFile?: (fileId: string) => Promise<PresalesResourceCredential | null>;
};

/**
 * Tasks with attachments must use the immutable credential version that owns
 * those files. This keeps an older knowledge-base output usable after a key
 * rotation without ever mixing resources across upstream accounts.
 */
export async function resolvePresalesTaskCredentialForFiles(
  fileIds: string[],
  options: PresalesTaskCredentialResolverOptions = {},
) {
  const uniqueFileIds = [...new Set(fileIds)];
  if (uniqueFileIds.length === 0) {
    return (options.getActive ?? getActivePresalesCredential)();
  }

  const getForFile =
    options.getForFile ??
    ((fileId: string) => getPresalesCredentialForResource("file", fileId));
  const credentials = await Promise.all(uniqueFileIds.map(getForFile));
  if (credentials.some((credential) => !credential)) {
    throw new AuthServiceError(
      "NOT_FOUND",
      "附件不存在，或对应的售前 API Key 已被撤销",
    );
  }

  const resolved = credentials as PresalesResourceCredential[];
  const credentialIds = new Set(resolved.map((credential) => credential.id));
  if (credentialIds.size !== 1) {
    throw new AuthServiceError(
      "CONFLICT",
      "附件来自多个 API Key 版本，不能在同一任务中混用",
    );
  }

  const [credential] = resolved;
  return {
    id: credential.id,
    version: credential.version,
    apiKey: credential.apiKey,
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
  } satisfies DecryptedPresalesCredential;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashPresalesIdempotencyKey(idempotencyKey: string) {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}

export function hashPresalesTaskPayload(payload: unknown) {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

type PresalesTaskReservationDecision =
  | { state: "conflict" }
  | { state: "completed" }
  | { state: "pending"; retryAfterMs: number }
  | { state: "expired" };

export function evaluatePresalesTaskReservation(
  row: Pick<
    PresalesTaskRequest,
    | "requestHash"
    | "apiCredentialId"
    | "credentialVersion"
    | "status"
    | "leaseExpiresAt"
  > & { projectId?: string | null },
  input: {
    requestHash: string;
    projectId?: string;
    apiCredentialId: string;
    credentialVersion: number;
  },
  now = new Date(),
): PresalesTaskReservationDecision {
  if (
    row.requestHash !== input.requestHash ||
    (row.projectId ?? null) !== (input.projectId ?? null) ||
    row.apiCredentialId !== input.apiCredentialId ||
    row.credentialVersion !== input.credentialVersion
  ) {
    return { state: "conflict" };
  }
  if (row.status === "completed") return { state: "completed" };
  const remainingMs = row.leaseExpiresAt.getTime() - now.getTime();
  return remainingMs > 0
    ? {
        state: "pending",
        retryAfterMs: Math.max(1_000, Math.min(remainingMs, 5_000)),
      }
    : { state: "expired" };
}

function completedReservation(
  row: PresalesTaskRequest,
): PresalesTaskReservation {
  const upstreamTaskId = String(row.upstreamTaskId ?? "");
  if (!upstreamTaskId) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Completed task reservation is missing its upstream task id",
    );
  }
  return {
    state: "completed",
    upstreamTaskId,
    task: { id: upstreamTaskId, status: "queued" },
  };
}

export async function acquirePresalesTaskReservation(
  input: {
    idempotencyKey: string;
    requestHash: string;
    projectId?: string;
    apiCredentialId: string;
    credentialVersion: number;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
): Promise<PresalesTaskReservation> {
  const db = executor ?? (await requireDb());
  const keyHash = hashPresalesIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? PRESALES_TASK_LEASE_MS;

  for (let retry = 0; retry < 3; retry += 1) {
    const reservationId = randomUUID();
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const row = {
      id: reservationId,
      projectId: input.projectId ?? null,
      keyHash,
      requestHash: input.requestHash,
      apiCredentialId: input.apiCredentialId,
      credentialVersion: input.credentialVersion,
      status: "pending" as const,
      attemptId,
      leaseExpiresAt,
      upstreamTaskId: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.insert(presalesTaskRequests).values(row);
      return {
        state: "acquired",
        reservationId,
        attemptId,
        keyHash,
        leaseExpiresAt,
      };
    } catch (error) {
      const mysqlError = error as { code?: string };
      if (mysqlError.code !== "ER_DUP_ENTRY") throw error;
    }

    const existing = await db.transaction(async (tx: any) => {
      const rows = await tx
        .select()
        .from(presalesTaskRequests)
        .where(eq(presalesTaskRequests.keyHash, keyHash))
        .limit(1)
        .for("update");
      const current = rows[0] as PresalesTaskRequest | undefined;
      if (!current) return null;
      const decision = evaluatePresalesTaskReservation(current, input, now);
      if (decision.state === "conflict") {
        throw new AuthServiceError(
          "CONFLICT",
          "该幂等键已用于不同的任务请求或 API Key 版本",
        );
      }
      if (decision.state === "completed") return completedReservation(current);
      if (decision.state === "pending") {
        throw new AuthServiceError(
          "IDEMPOTENCY_PENDING",
          "相同任务正在创建中，请稍后重试",
          decision.retryAfterMs,
        );
      }

      await tx
        .update(presalesTaskRequests)
        .set({ attemptId, leaseExpiresAt, updatedAt: now })
        .where(eq(presalesTaskRequests.id, current.id));
      return {
        state: "acquired",
        reservationId: current.id,
        attemptId,
        keyHash,
        leaseExpiresAt,
      } satisfies PresalesTaskReservation;
    });
    if (existing) return existing;
  }

  throw new AuthServiceError(
    "IDEMPOTENCY_PENDING",
    "任务幂等预留正在更新，请稍后重试",
    1_000,
  );
}

/**
 * Resolves the immutable website project binding captured when the presales
 * task was created. Legacy tasks have no projectId and are deliberately not
 * eligible for the provisioning-v2 knowledge import path.
 */
export async function getPresalesTaskProjectBinding(
  taskId: string,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const rows = await db
    .select({
      projectId: presalesTaskRequests.projectId,
      apiCredentialId: presalesTaskRequests.apiCredentialId,
      credentialVersion: presalesTaskRequests.credentialVersion,
      status: presalesTaskRequests.status,
      upstreamTaskId: presalesTaskRequests.upstreamTaskId,
    })
    .from(presalesTaskRequests)
    .where(eq(presalesTaskRequests.upstreamTaskId, taskId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    row.status !== "completed" ||
    row.upstreamTaskId !== taskId ||
    !row.projectId
  ) {
    return null;
  }
  return {
    projectId: row.projectId,
    apiCredentialId: row.apiCredentialId,
    credentialVersion: row.credentialVersion,
    taskId,
  };
}

export async function releasePresalesTaskReservation(
  input: { reservationId: string; attemptId: string },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  await db.transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, input.reservationId))
      .limit(1)
      .for("update");
    const row = rows[0] as PresalesTaskRequest | undefined;
    if (!row || row.status !== "pending" || row.attemptId !== input.attemptId) {
      return;
    }
    await tx
      .delete(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, row.id));
  });
}

export async function completePresalesTaskReservation(
  input: {
    reservationId: string;
    attemptId: string;
    apiCredentialId: string;
    upstreamTaskId: string;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  await db.transaction(async (tx: any) => {
    const requests = await tx
      .select()
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, input.reservationId))
      .limit(1)
      .for("update");
    const request = requests[0] as PresalesTaskRequest | undefined;
    if (!request) {
      throw new AuthServiceError("NOT_FOUND", "Task reservation not found");
    }
    if (request.apiCredentialId !== input.apiCredentialId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Task reservation belongs to a different presales credential version",
      );
    }
    if (request.status === "completed") {
      if (request.upstreamTaskId === input.upstreamTaskId) return;
      throw new AuthServiceError(
        "CONFLICT",
        "Task reservation already completed",
      );
    }
    if (request.attemptId !== input.attemptId) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "Task reservation lease is owned by another request",
        1_000,
      );
    }

    const resources = await tx
      .select()
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.upstreamTaskId),
        ),
      )
      .limit(1);
    const resource = resources[0] as PresalesUpstreamResource | undefined;
    if (resource && resource.apiCredentialId !== input.apiCredentialId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream task belongs to a different presales credential version",
      );
    }
    if (!resource) {
      await tx.insert(presalesUpstreamResources).values({
        id: randomUUID(),
        apiCredentialId: input.apiCredentialId,
        kind: "task",
        upstreamId: input.upstreamTaskId,
        parentTaskId: null,
        createdAt: new Date(),
      });
    }

    const completedAt = new Date();
    await tx
      .update(presalesTaskRequests)
      .set({
        status: "completed",
        upstreamTaskId: input.upstreamTaskId,
        completedAt,
        leaseExpiresAt: completedAt,
        updatedAt: completedAt,
      })
      .where(eq(presalesTaskRequests.id, request.id));
  });
}

export async function recordPresalesUpstreamResource(input: {
  apiCredentialId: string;
  kind: "task" | "file";
  upstreamId: string;
  parentTaskId?: string | null;
}) {
  const db = await requireDb();
  const existing = await db
    .select()
    .from(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.kind, input.kind),
        eq(presalesUpstreamResources.upstreamId, input.upstreamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].apiCredentialId !== input.apiCredentialId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource belongs to a different presales credential version",
      );
    }
    if (
      input.parentTaskId &&
      existing[0].parentTaskId &&
      existing[0].parentTaskId !== input.parentTaskId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream file is already bound to a different presales task",
      );
    }
    if (!existing[0].parentTaskId && input.parentTaskId) {
      await db
        .update(presalesUpstreamResources)
        .set({ parentTaskId: input.parentTaskId })
        .where(eq(presalesUpstreamResources.id, existing[0].id));
      return { ...existing[0], parentTaskId: input.parentTaskId };
    }
    return existing[0];
  }

  const credential = await db
    .select({ id: presalesApiCredentials.id })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, input.apiCredentialId),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  if (!credential[0]) {
    throw new AuthServiceError(
      "NOT_FOUND",
      "Presales API credential not found",
    );
  }

  const resource: PresalesUpstreamResource = {
    id: randomUUID(),
    apiCredentialId: input.apiCredentialId,
    kind: input.kind,
    upstreamId: input.upstreamId,
    parentTaskId: input.parentTaskId ?? null,
    createdAt: new Date(),
  };
  try {
    await db.insert(presalesUpstreamResources).values(resource);
    return resource;
  } catch (error) {
    const mysqlError = error as { code?: string };
    if (mysqlError.code !== "ER_DUP_ENTRY") throw error;
    const raced = await db
      .select()
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, input.kind),
          eq(presalesUpstreamResources.upstreamId, input.upstreamId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1);
    if (raced[0]) return raced[0];
    throw new AuthServiceError("CONFLICT", "Upstream resource already exists");
  }
}

export function hashPresalesOutputUrl(url: string) {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

export async function syncPresalesOutputUrlGrants(
  input: {
    apiCredentialId: string;
    parentTaskId: string;
    urls: Array<{ url: string; hostname: string }>;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const uniqueUrls = [
    ...new Map(input.urls.map((item) => [item.url, item])).values(),
  ];
  await db.transaction(async (tx: any) => {
    const task = await tx
      .select({ id: presalesUpstreamResources.id })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.parentTaskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1);
    if (!task[0]) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "Presales task ownership could not be verified",
      );
    }

    await tx
      .delete(presalesOutputUrls)
      .where(
        and(
          eq(presalesOutputUrls.apiCredentialId, input.apiCredentialId),
          eq(presalesOutputUrls.parentTaskId, input.parentTaskId),
        ),
      );
    if (uniqueUrls.length > 0) {
      await tx.insert(presalesOutputUrls).values(
        uniqueUrls.map((item) => ({
          id: randomUUID(),
          apiCredentialId: input.apiCredentialId,
          parentTaskId: input.parentTaskId,
          urlHash: hashPresalesOutputUrl(item.url),
          hostname: item.hostname.slice(0, 255),
          createdAt: new Date(),
        })),
      );
    }
  });
}

export async function hasPresalesOutputUrlGrant(input: {
  apiCredentialId: string;
  parentTaskId: string;
  url: string;
}) {
  const db = await requireDb();
  const rows = await db
    .select({ id: presalesOutputUrls.id })
    .from(presalesOutputUrls)
    .where(
      and(
        eq(presalesOutputUrls.apiCredentialId, input.apiCredentialId),
        eq(presalesOutputUrls.parentTaskId, input.parentTaskId),
        eq(presalesOutputUrls.urlHash, hashPresalesOutputUrl(input.url)),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

function parseCreatedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function taskCreditUsage(task: any) {
  const value = Number(task?.credit_usage ?? task?.metadata?.credit_usage ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function getPresalesCreditUsage(
  windowDays = CREDIT_USAGE_LOOKBACK_DAYS,
): Promise<WebsiteApiKeyUsage> {
  const credential = await getActivePresalesCredential();
  const normalizedWindowDays =
    Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365
      ? windowDays
      : CREDIT_USAGE_LOOKBACK_DAYS;
  if (!credential) {
    return {
      windowDays: normalizedWindowDays,
      keyTotalUsed: 0,
      websiteUsed: 0,
      recentWebsiteTasks: [] as PresalesCreditUsageTask[],
      fetchedAt: Date.now(),
    };
  }

  const db = await requireDb();
  const [resourceRows, ownedRows, monitorRows] = await Promise.all([
    db
      .select({ upstreamTaskId: presalesUpstreamResources.upstreamId })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.apiCredentialId, credential.id),
          eq(presalesUpstreamResources.kind, "task"),
        ),
      ),
    db
      .select({ upstreamTaskId: presalesTaskRequests.upstreamTaskId })
      .from(presalesTaskRequests)
      .where(
        and(
          eq(presalesTaskRequests.apiCredentialId, credential.id),
          eq(presalesTaskRequests.status, "completed"),
        ),
      ),
    db
      .select({ upstreamTaskId: presalesMonitorRuns.upstreamTaskId })
      .from(presalesMonitorRuns)
      .where(eq(presalesMonitorRuns.apiCredentialId, credential.id)),
  ]);
  const websiteTaskIds = new Set(
    [...resourceRows, ...ownedRows, ...monitorRows]
      .map((row) => row.upstreamTaskId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  const cutoffMs = Date.now() - normalizedWindowDays * 24 * 60 * 60 * 1000;
  const recentWebsiteTasks: PresalesCreditUsageTask[] = [];
  const seen = new Set<string>();
  let keyTotalUsed = 0;
  let websiteUsed = 0;
  let after: string | undefined;
  let reachedCutoff = false;

  for (
    let page = 0;
    page < CREDIT_USAGE_MAX_PAGES && !reachedCutoff;
    page += 1
  ) {
    const params = new URLSearchParams({
      limit: String(CREDIT_USAGE_PAGE_LIMIT),
      order: "desc",
    });
    if (after) params.set("after", after);
    let response: globalThis.Response;
    try {
      response = await fetch(
        `${getUpstreamBaseUrl()}/v1/tasks?${params.toString()}`,
        {
          headers: {
            API_KEY: credential.apiKey,
            Authorization: `Bearer ${credential.apiKey}`,
            Accept: "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "暂时无法读取售前积分使用情况",
      );
    }
    if (!response.ok) {
      throw new AuthServiceError(
        response.status === 401 || response.status === 403
          ? "INVALID_CREDENTIAL"
          : "UPSTREAM_UNAVAILABLE",
        "暂时无法读取售前积分使用情况",
      );
    }

    const payload = (await response.json()) as any;
    const tasks = Array.isArray(payload?.data) ? payload.data : [];
    if (tasks.length === 0) break;

    for (const task of tasks) {
      const id = String(task?.id ?? task?.task_id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const createdAt = parseCreatedAt(task?.created_at);
      if (createdAt !== null && createdAt < cutoffMs) {
        reachedCutoff = true;
        break;
      }
      const creditUsage = taskCreditUsage(task);
      if (creditUsage <= 0) continue;
      keyTotalUsed += creditUsage;
      if (!websiteTaskIds.has(id)) continue;
      websiteUsed += creditUsage;
      recentWebsiteTasks.push({
        id,
        title: String(
          task?.metadata?.task_title ??
            task?.task_title ??
            task?.instructions?.slice?.(0, 40) ??
            id.slice(0, 12),
        ),
        creditUsage,
        createdAt,
      });
    }

    after =
      String(payload?.last_id ?? tasks[tasks.length - 1]?.id ?? "") ||
      undefined;
    if (!payload?.has_more || !after) break;
  }

  return {
    windowDays: normalizedWindowDays,
    keyTotalUsed,
    websiteUsed,
    recentWebsiteTasks,
    fetchedAt: Date.now(),
  };
}
