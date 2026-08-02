import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import {
  apiCredentials,
  apiUsageCredentialCoverage,
  apiUsagePolicies,
  apiUsageSnapshots,
  presalesApiCredentials,
  userAdminAssignments,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import { usageCoverageSupportsReplacement } from "./api-usage-ledger";
import {
  AuthServiceError,
  deleteActiveApiCredentialInTransaction,
  replaceApiCredentialInTransaction,
  validateUpstreamApiKey,
  type AuthenticatedUser,
} from "./auth-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  getShanghaiRollingUsagePeriod,
  getSharedKeyMonthlyCreditUsageForAccounts,
  isSystemAdmin,
} from "./dashboard-service";
import { getDb } from "./db";
import { getPresalesCreditUsage } from "./presales-service";

export const DEFAULT_API_USAGE_LIMIT = 230_000;
export const DEFAULT_API_USAGE_WARNING_RATIO = 0.8;
export const DEFAULT_API_USAGE_WINDOW_DAYS = 30;
export const API_USAGE_SNAPSHOT_FRESHNESS_MS = 30 * 60 * 1_000;
// A current-Key group may also scan credentials from an account's history.
// Serialize groups until that historical work is deduplicated by physical
// fingerprint; concurrent groups can otherwise invalidate each other's
// coverage claim and turn a complete total into PARTIAL_TASK_SCAN.
export const API_USAGE_SCAN_CONCURRENCY = 1;

type ApiUsageScope = "website_frontend" | "managed_user";
type ApiUsageSeverity = "normal" | "warning" | "critical" | "unavailable";
export type ManagedApiKeyTargetKind =
  | "customer"
  | "delivery_admin"
  | "system_admin"
  | "engineer";

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂时不可用。");
  }
  return db;
}

export function apiUsageSeverity(input: {
  used: number;
  limit: number;
  warningRatio: number;
  syncStatus: "pending" | "ok" | "error" | "unconfigured";
}): ApiUsageSeverity {
  if (input.syncStatus !== "ok") return "unavailable";
  if (input.limit <= 0 || input.used >= input.limit) return "critical";
  if (input.used >= input.limit * input.warningRatio) return "warning";
  return "normal";
}

export function assertManagedApiKeyTarget(input: {
  kind: ManagedApiKeyTargetKind;
  target?: {
    id: number;
    role: string;
    adminAccessLevel?: string | null;
  } | null;
  actualVersion: number;
  expectedVersion: number;
}) {
  const matches =
    input.kind === "customer"
      ? input.target?.role === "user"
      : input.kind === "engineer"
        ? input.target?.role === "delivery_member"
        : input.target?.role === "admin" &&
          input.target?.adminAccessLevel === input.kind;
  if (!matches) {
    throw new AuthServiceError(
      "NOT_FOUND",
      "API Key 管理目标不存在或类型不匹配",
    );
  }
  if (input.actualVersion !== input.expectedVersion) {
    throw new AuthServiceError(
      "CONFLICT",
      "API Key 状态已变化，请刷新后重试；迟到请求不会覆盖较新的 Key",
    );
  }
}

export async function replaceManagedApiKeyTarget(input: {
  actor: AuthenticatedUser;
  kind: ManagedApiKeyTargetKind;
  userId: number;
  apiKey: string;
  expectedVersion: number;
  reason?: string;
  allowIncompleteHistory?: boolean;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以替换账号 API Key。",
    );
  }
  // One-click replacement performs a targeted old-Key scan itself. It never
  // blocks this single-account mutation on a global all-account refresh.
  await validateUpstreamApiKey(input.apiKey);
  const db = await requireDb();
  const initialActiveRows = await db
    .select({ fingerprint: apiCredentials.fingerprint })
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.userId, input.userId),
        eq(apiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  if (initialActiveRows[0]) {
    try {
      await getSharedKeyMonthlyCreditUsageForAccounts({
        credentialOwnerIds: [input.userId],
        accountIds: [input.userId],
        poolFingerprint: initialActiveRows[0].fingerprint,
        windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      });
    } catch {
      // The coverage proof below controls normal versus explicit emergency
      // replacement. Failed scans never become zero-valued facts.
    }
  }
  const existingActiveRows = await db
    .select({
      fingerprint: apiCredentials.fingerprint,
      coverage: apiUsageCredentialCoverage,
    })
    .from(apiCredentials)
    .leftJoin(
      apiUsageCredentialCoverage,
      and(
        eq(apiUsageCredentialCoverage.scope, "managed_user"),
        eq(
          apiUsageCredentialCoverage.credentialFingerprint,
          apiCredentials.fingerprint,
        ),
      ),
    )
    .where(
      and(
        eq(apiCredentials.userId, input.userId),
        eq(apiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const nowMs = Date.now();
  const existingActive = existingActiveRows[0];
  const historyIncomplete = Boolean(
    existingActive &&
      !usageCoverageSupportsReplacement({
        coverage: existingActive.coverage,
        periodStartMs: getShanghaiRollingUsagePeriod(
          DEFAULT_API_USAGE_WINDOW_DAYS,
          nowMs,
        ).startAt,
        nowMs,
      }),
  );
  if (historyIncomplete && !input.allowIncompleteHistory) {
    throw new AuthServiceError(
      "CONFLICT",
      "旧 API Key 无法完成近 30 天扫描或仍有进行中任务。若旧 Key 已失效，可明确选择“允许历史用量暂时不可用”后应急替换；系统不会把缺失历史显示为 0。",
    );
  }
  const replacement = await db.transaction(async (tx) => {
    const targetRows = await tx
      .select({
        id: users.id,
        role: users.role,
        adminAccessLevel: users.adminAccessLevel,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    const credentialRows = await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.userId, input.userId))
      .orderBy(desc(apiCredentials.version))
      .limit(1)
      .for("update");
    const actualVersion = credentialRows[0]?.version ?? 0;
    assertManagedApiKeyTarget({
      kind: input.kind,
      target: targetRows[0],
      actualVersion,
      expectedVersion: input.expectedVersion,
    });
    const currentCredential = credentialRows[0];
    const coverageRows = currentCredential
      ? await tx
          .select()
          .from(apiUsageCredentialCoverage)
          .where(
            and(
              eq(apiUsageCredentialCoverage.scope, "managed_user"),
              eq(
                apiUsageCredentialCoverage.credentialFingerprint,
                currentCredential.fingerprint,
              ),
            ),
          )
          .limit(1)
          .for("update")
      : [];
    const coverage = coverageRows[0];
    const transactionHistoryIncomplete = Boolean(
      currentCredential &&
        !usageCoverageSupportsReplacement({
          coverage,
          periodStartMs: getShanghaiRollingUsagePeriod(
            DEFAULT_API_USAGE_WINDOW_DAYS,
            Date.now(),
          ).startAt,
          nowMs: Date.now(),
        }),
    );
    if (transactionHistoryIncomplete && !input.allowIncompleteHistory) {
      throw new AuthServiceError(
        "CONFLICT",
        "旧 API Key 扫描后出现了新任务或覆盖证明已变化，本次替换已停止；请重试。",
      );
    }
    const credential = await replaceApiCredentialInTransaction({
      executor: tx,
      userId: input.userId,
      apiKey: input.apiKey,
    });
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "admin.api_credential.replaced",
        targetType: input.kind,
        targetId: input.userId,
        workspaceUserId: input.kind === "customer" ? input.userId : null,
        reason: input.reason,
        metadata: {
          targetKind: input.kind,
          previousVersion: actualVersion,
          credentialVersion: credential.version,
          configured: credential.configured,
          historyIncomplete: transactionHistoryIncomplete,
          emergencyReplacement: Boolean(
            transactionHistoryIncomplete && input.allowIncompleteHistory,
          ),
        },
      },
      tx,
    );
    return {
      credential,
      historyIncomplete: transactionHistoryIncomplete,
      previousFingerprint: currentCredential?.fingerprint ?? null,
    };
  });
  // A post-retirement scan binds the final old-Key observation to retiredAt.
  // Failure is intentionally non-destructive: snapshots become unavailable,
  // never a misleading zero.
  try {
    if (!replacement.previousFingerprint) return replacement.credential;
    await getSharedKeyMonthlyCreditUsageForAccounts({
      credentialOwnerIds: [input.userId],
      accountIds: [input.userId],
      poolFingerprint: replacement.previousFingerprint,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
    });
  } catch {
    // The next snapshot sync records the explicit unavailable state.
  }
  return replacement.credential;
}

export async function revokeManagedApiKeyTarget(input: {
  actor: AuthenticatedUser;
  kind: ManagedApiKeyTargetKind;
  userId: number;
  expectedVersion: number;
  reason?: string;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以撤销账号 API Key。",
    );
  }
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select({
        id: users.id,
        role: users.role,
        adminAccessLevel: users.adminAccessLevel,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    const credentialRows = await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.userId, input.userId))
      .orderBy(desc(apiCredentials.version))
      .limit(1)
      .for("update");
    const latest = credentialRows[0];
    const actualVersion = latest?.version ?? 0;
    assertManagedApiKeyTarget({
      kind: input.kind,
      target: targetRows[0],
      actualVersion,
      expectedVersion: input.expectedVersion,
    });
    if (latest?.status !== "active") {
      throw new AuthServiceError("CONFLICT", "API Key 尚未配置或已被撤销");
    }
    // This keeps the credential lock and all in-flight/recovery dependency
    // checks in the same transaction as the CAS decision.
    const deletion = await deleteActiveApiCredentialInTransaction({
      executor: tx,
      userId: input.userId,
    });
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "admin.api_credential.revoked",
        targetType: input.kind,
        targetId: input.userId,
        workspaceUserId: input.kind === "customer" ? input.userId : null,
        reason: input.reason,
        metadata: {
          targetKind: input.kind,
          previousVersion: actualVersion,
          credentialVersion: deletion.version,
          configured: false,
        },
      },
      tx,
    );
    return { success: true as const, version: deletion.version };
  });
}

function policyKey(scope: ApiUsageScope, userId?: number | null) {
  return scope === "website_frontend"
    ? "website_frontend"
    : `managed_user:${userId}`;
}

async function accessibleWorkspaceUsers(
  actor: AuthenticatedUser,
  executor: any,
) {
  if (isSystemAdmin(actor)) {
    return executor
      .select({
        id: users.id,
        enterpriseName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(eq(users.role, "user"));
  }
  return executor
    .select({
      id: users.id,
      enterpriseName: users.displayName,
      username: users.username,
    })
    .from(userAdminAssignments)
    .innerJoin(users, eq(users.id, userAdminAssignments.userId))
    .where(
      and(
        eq(userAdminAssignments.adminId, actor.id),
        eq(users.role, "user"),
        eq(users.isActive, true),
      ),
    );
}

async function accessibleDeliveryAdmins(
  actor: AuthenticatedUser,
  executor: any,
) {
  if (isSystemAdmin(actor)) {
    return executor
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        adminAccessLevel: users.adminAccessLevel,
      })
      .from(users)
      .where(eq(users.role, "admin"));
  }
  if (actor.role !== "admin" || actor.adminAccessLevel !== "delivery_admin") {
    return [];
  }
  return [
    {
      id: actor.id,
      displayName: actor.displayName ?? null,
      username: actor.username,
      adminAccessLevel: actor.adminAccessLevel,
    },
  ];
}

async function accessibleDeliveryEngineers(
  actor: AuthenticatedUser,
  executor: any,
) {
  if (!isSystemAdmin(actor)) return [];
  return executor
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.role, "delivery_member"));
}

async function ensureUsagePolicy(input: {
  executor: any;
  scope: ApiUsageScope;
  workspaceUserId?: number | null;
}) {
  const key = policyKey(input.scope, input.workspaceUserId);
  const rows = await input.executor
    .select()
    .from(apiUsagePolicies)
    .where(eq(apiUsagePolicies.policyKey, key))
    .limit(1);
  if (rows[0]) return rows[0];
  const id = randomUUID();
  await input.executor.insert(apiUsagePolicies).values({
    id,
    policyKey: key,
    scope: input.scope,
    workspaceUserId: input.workspaceUserId ?? null,
    limit: DEFAULT_API_USAGE_LIMIT,
    warningRatioBasisPoints: Math.round(
      DEFAULT_API_USAGE_WARNING_RATIO * 10_000,
    ),
    windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
  });
  const created = await input.executor
    .select()
    .from(apiUsagePolicies)
    .where(eq(apiUsagePolicies.policyKey, key))
    .limit(1);
  return created[0];
}

export function resolveEffectiveUsageCredentials(input: {
  userIds: number[];
  credentialRows: Array<{
    id?: string;
    userId: number;
    version?: number;
    fingerprint: string;
    createdAt?: Date;
  }>;
  ownerRows: Array<{ userId: number; deliveryAdminId: number }>;
}) {
  const ownerByUser = new Map<number, number>(
    input.ownerRows.map((owner) => [
      Number(owner.userId),
      Number(owner.deliveryAdminId),
    ]),
  );
  const activeByOwner = new Map<
    number,
    (typeof input.credentialRows)[number]
  >();
  for (const row of input.credentialRows) {
    if (!activeByOwner.has(Number(row.userId))) {
      activeByOwner.set(Number(row.userId), row);
    }
  }
  const byUser = new Map<number, string>();
  const credentialOwnerByUser = new Map<number, number>();
  const credentialIdByUser = new Map<number, string>();
  const credentialVersionByUser = new Map<number, number>();
  const credentialCreatedAtByUser = new Map<number, number>();
  for (const userId of input.userIds) {
    // New managed customers own their credential directly. Only legacy
    // customers without a direct credential inherit their usage owner's Key.
    const credentialOwnerId = activeByOwner.has(userId)
      ? userId
      : (ownerByUser.get(userId) ?? userId);
    const credential = activeByOwner.get(credentialOwnerId);
    if (credential) {
      byUser.set(userId, credential.fingerprint);
      credentialOwnerByUser.set(userId, credentialOwnerId);
      if (credential.id) credentialIdByUser.set(userId, credential.id);
      if (credential.version !== undefined) {
        credentialVersionByUser.set(userId, credential.version);
      }
      if (credential.createdAt) {
        credentialCreatedAtByUser.set(userId, credential.createdAt.getTime());
      }
    }
  }
  return {
    byUser,
    credentialOwnerByUser,
    credentialIdByUser,
    credentialVersionByUser,
    credentialCreatedAtByUser,
  };
}

async function usageCredentialFingerprints(input: {
  executor: any;
  userIds: number[];
}) {
  const credentialRows = await input.executor
    .select({
      id: apiCredentials.id,
      userId: apiCredentials.userId,
      version: apiCredentials.version,
      fingerprint: apiCredentials.fingerprint,
      createdAt: apiCredentials.createdAt,
    })
    .from(apiCredentials)
    .where(eq(apiCredentials.status, "active"))
    .orderBy(desc(apiCredentials.createdAt));
  const ownerRows =
    input.userIds.length === 0
      ? []
      : await input.executor
          .select({
            userId: userUsageOwners.userId,
            deliveryAdminId: userUsageOwners.deliveryAdminId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, input.userIds));
  const effective = resolveEffectiveUsageCredentials({
    userIds: input.userIds,
    credentialRows,
    ownerRows,
  });
  const websiteRows = await input.executor
    .select({
      id: presalesApiCredentials.id,
      version: presalesApiCredentials.version,
      fingerprint: presalesApiCredentials.fingerprint,
      createdAt: presalesApiCredentials.createdAt,
    })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, "website"),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.createdAt))
    .limit(1);
  const websiteCredential = websiteRows[0] ?? null;
  return {
    ...effective,
    website: websiteCredential?.fingerprint ?? null,
    websiteCredential,
  };
}

export function isRollingUsageSnapshotCurrent(input: {
  snapshot?: {
    credentialFingerprint: string | null;
    windowStartedAt: Date;
    fetchedAt: Date | null;
    updatedAt?: Date | null;
  };
  fingerprint: string | null;
  credentialCreatedAt?: number | null;
  windowDays: number;
  now?: number;
  maxAgeMs?: number;
}) {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.credentialFingerprint !== input.fingerprint) {
    return false;
  }
  const snapshotAt = (snapshot.fetchedAt ?? snapshot.updatedAt)?.getTime();
  if (!snapshotAt) return false;
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? API_USAGE_SNAPSHOT_FRESHNESS_MS;
  if (snapshotAt > now || now - snapshotAt > maxAgeMs) return false;
  if (
    input.credentialCreatedAt != null &&
    snapshotAt < input.credentialCreatedAt
  ) {
    return false;
  }
  const period = getShanghaiRollingUsagePeriod(input.windowDays, snapshotAt);
  return snapshot.windowStartedAt.getTime() === period.startAt;
}

export function usageCredentialPoolKey(input: {
  fingerprint?: string | null;
  credentialId: string | null;
  credentialVersion: number | null;
  windowDays?: number;
}) {
  const identity = input.fingerprint
    ? `fingerprint:${input.fingerprint}`
    : input.credentialId && input.credentialVersion !== null
      ? `credential:${input.credentialId}:${input.credentialVersion}`
      : null;
  if (!identity) return null;
  return `${identity}${
    input.windowDays === undefined ? "" : `:${input.windowDays}`
  }`;
}

export function latestUsageSnapshotByPolicy<
  T extends {
    policyId: string;
    fetchedAt?: Date | null;
    updatedAt?: Date | null;
    createdAt?: Date | null;
  },
>(snapshots: T[]) {
  const latest = new Map<string, T>();
  for (const snapshot of snapshots) {
    const existing = latest.get(snapshot.policyId);
    const timestamp =
      (
        snapshot.fetchedAt ??
        snapshot.updatedAt ??
        snapshot.createdAt
      )?.getTime() ?? 0;
    const existingTimestamp = existing
      ? ((
          existing.fetchedAt ??
          existing.updatedAt ??
          existing.createdAt
        )?.getTime() ?? 0)
      : -1;
    if (!existing || timestamp >= existingTimestamp) {
      latest.set(snapshot.policyId, snapshot);
    }
  }
  return latest;
}

export function usageSnapshotUsageValues(input: {
  status: "ok" | "error" | "unconfigured";
  credentialFingerprint: string | null;
  used: number;
  accountUsed: number;
  existing?: {
    credentialFingerprint: string | null;
    used: number;
    accountUsed: number;
  } | null;
}) {
  const preserveLastKnownUsage =
    input.status === "error" &&
    input.existing?.credentialFingerprint === input.credentialFingerprint;
  return {
    used: preserveLastKnownUsage
      ? Number(input.existing?.used ?? 0)
      : Math.max(0, Math.round(input.used)),
    accountUsed: preserveLastKnownUsage
      ? Number(input.existing?.accountUsed ?? 0)
      : Math.max(0, Math.round(input.accountUsed)),
  };
}

export async function getApiUsageAlertOverview(actor: AuthenticatedUser) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以查看 Key 与积分总览。",
    );
  }
  const db = await requireDb();
  const workspaceUsers = await accessibleWorkspaceUsers(actor, db);
  const scopes = [
    ...(isSystemAdmin(actor)
      ? [
          {
            scope: "website_frontend" as const,
            workspaceUserId: null,
            enterpriseName: "官网前台",
          },
        ]
      : []),
    ...workspaceUsers.map((user: any) => ({
      scope: "managed_user" as const,
      workspaceUserId: user.id as number,
      enterpriseName:
        user.enterpriseName?.trim() ||
        user.username?.trim() ||
        `用户 ${user.id}`,
    })),
  ];
  const policies = await Promise.all(
    scopes.map((scope) =>
      ensureUsagePolicy({
        executor: db,
        scope: scope.scope,
        workspaceUserId: scope.workspaceUserId,
      }),
    ),
  );
  const snapshots = policies.length
    ? await db
        .select()
        .from(apiUsageSnapshots)
        .where(
          inArray(
            apiUsageSnapshots.policyId,
            policies.map((policy) => policy.id),
          ),
        )
    : [];
  const snapshotByPolicy = latestUsageSnapshotByPolicy(snapshots);
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: workspaceUsers.map((user: any) => user.id),
  });
  const observationNow = Date.now();
  const items = policies.map((policy, index) => {
    const scope = scopes[index]!;
    const snapshot = snapshotByPolicy.get(policy.id);
    const credentialFingerprint =
      policy.scope === "website_frontend"
        ? fingerprints.website
        : (fingerprints.byUser.get(policy.workspaceUserId!) ?? null);
    const credentialCreatedAt =
      policy.scope === "website_frontend"
        ? (fingerprints.websiteCredential?.createdAt?.getTime() ?? null)
        : (fingerprints.credentialCreatedAtByUser.get(
            policy.workspaceUserId!,
          ) ?? null);
    const currentSnapshot = isRollingUsageSnapshotCurrent({
      snapshot,
      fingerprint: credentialFingerprint,
      credentialCreatedAt,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      now: observationNow,
    })
      ? snapshot
      : undefined;
    const syncStatus = currentSnapshot
      ? (snapshot?.syncStatus ??
        (credentialFingerprint ? "pending" : "unconfigured"))
      : credentialFingerprint
        ? "pending"
        : "unconfigured";
    const used = currentSnapshot ? Number(currentSnapshot.used ?? 0) : 0;
    const accountUsed = currentSnapshot
      ? Number(currentSnapshot.accountUsed ?? 0)
      : 0;
    const warningRatio = policy.warningRatioBasisPoints / 10_000;
    const percentage =
      policy.limit > 0 ? Math.min(100, (used / policy.limit) * 100) : 100;
    return {
      id: policy.id,
      scope: policy.scope,
      userId: policy.workspaceUserId,
      enterpriseName: scope.enterpriseName,
      credentialFingerprint,
      used,
      accountUsed,
      limit: policy.limit,
      warningRatio,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      percentage,
      fetchedAt: currentSnapshot?.fetchedAt?.getTime() ?? null,
      periodStartedAt: currentSnapshot?.windowStartedAt?.getTime() ?? null,
      syncStatus,
      severity: apiUsageSeverity({
        used,
        limit: policy.limit,
        warningRatio,
        syncStatus,
      }),
      errorMessage:
        syncStatus === "error"
          ? "用量暂时无法读取"
          : syncStatus === "unconfigured"
            ? "尚未配置 API Key"
            : null,
    };
  });
  return { items };
}

export async function getAdminApiUsageHierarchy(actor: AuthenticatedUser) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以查看 Key 与积分使用情况。",
    );
  }
  const db = await requireDb();
  const [accessibleManagers, engineers, customers] = await Promise.all([
    accessibleDeliveryAdmins(actor, db),
    accessibleDeliveryEngineers(actor, db),
    accessibleWorkspaceUsers(actor, db),
  ]);
  const managers = isSystemAdmin(actor)
    ? accessibleManagers.filter(
        (manager: any) => manager.adminAccessLevel === "delivery_admin",
      )
    : accessibleManagers;
  const systemAdministrators = accessibleManagers.filter(
    (manager: any) => manager.adminAccessLevel === "system_admin",
  );
  const managerIds = managers.map((manager: any) => Number(manager.id));
  const systemAdministratorIds = systemAdministrators.map((manager: any) =>
    Number(manager.id),
  );
  const engineerIds = engineers.map((engineer: any) => Number(engineer.id));
  const customerIds = customers.map((customer: any) => Number(customer.id));
  const ownerships =
    customerIds.length === 0
      ? []
      : await db
          .select({
            adminId: userUsageOwners.deliveryAdminId,
            userId: userUsageOwners.userId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, customerIds));
  const subjectIds = [
    ...new Set([
      ...systemAdministratorIds,
      ...managerIds,
      ...customerIds,
      ...engineerIds,
    ]),
  ];
  const policies = await Promise.all(
    subjectIds.map((subjectId) =>
      ensureUsagePolicy({
        executor: db,
        scope: "managed_user",
        workspaceUserId: subjectId,
      }),
    ),
  );
  const snapshots = policies.length
    ? await db
        .select()
        .from(apiUsageSnapshots)
        .where(
          inArray(
            apiUsageSnapshots.policyId,
            policies.map((policy) => policy.id),
          ),
        )
    : [];
  const snapshotByPolicy = latestUsageSnapshotByPolicy(snapshots);
  const policyByUser = new Map(
    policies.map((policy) => [Number(policy.workspaceUserId), policy]),
  );
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: subjectIds,
  });
  const managedCredentialUserIds = [
    ...systemAdministratorIds,
    ...managerIds,
    ...engineerIds,
    ...customerIds,
  ];
  const managedCredentialRows =
    managedCredentialUserIds.length === 0
      ? []
      : await db
          .select({
            userId: apiCredentials.userId,
            version: apiCredentials.version,
            status: apiCredentials.status,
          })
          .from(apiCredentials)
          .where(inArray(apiCredentials.userId, managedCredentialUserIds))
          .orderBy(desc(apiCredentials.version));
  const latestManagedCredentialById = new Map<
    number,
    (typeof managedCredentialRows)[number]
  >();
  for (const credential of managedCredentialRows) {
    if (!latestManagedCredentialById.has(Number(credential.userId))) {
      latestManagedCredentialById.set(Number(credential.userId), credential);
    }
  }
  const now = Date.now();
  const period = getShanghaiRollingUsagePeriod(
    DEFAULT_API_USAGE_WINDOW_DAYS,
    now,
  );

  const usageFor = (userId: number) => {
    const policy = policyByUser.get(userId);
    const fingerprint = fingerprints.byUser.get(userId) ?? null;
    const snapshot = policy ? snapshotByPolicy.get(policy.id) : undefined;
    const credentialCreatedAt =
      fingerprints.credentialCreatedAtByUser.get(userId) ?? null;
    const currentSnapshot = isRollingUsageSnapshotCurrent({
      snapshot,
      fingerprint,
      credentialCreatedAt,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      now,
    })
      ? snapshot
      : undefined;
    const syncStatus = currentSnapshot
      ? currentSnapshot.syncStatus
      : fingerprint
        ? "pending"
        : "unconfigured";
    const used = Number(currentSnapshot?.used ?? 0);
    const accountUsed = Number(currentSnapshot?.accountUsed ?? 0);
    const limit = Number(policy?.limit ?? DEFAULT_API_USAGE_LIMIT);
    const warningRatio =
      Number(policy?.warningRatioBasisPoints ?? 8_000) / 10_000;
    return {
      fingerprint,
      credentialOwnerId: fingerprints.credentialOwnerByUser.get(userId) ?? null,
      credentialId: fingerprints.credentialIdByUser.get(userId) ?? null,
      credentialVersion:
        fingerprints.credentialVersionByUser.get(userId) ?? null,
      used,
      accountUsed,
      limit,
      warningRatio,
      syncStatus,
      fetchedAt: currentSnapshot?.fetchedAt?.getTime() ?? null,
      severity: apiUsageSeverity({
        used,
        limit,
        warningRatio,
        syncStatus,
      }),
    };
  };
  const customerById = new Map(
    customers.map((customer: any) => [Number(customer.id), customer]),
  );
  const adminById = new Map<
    number,
    { displayName?: string | null; username?: string | null }
  >(accessibleManagers.map((manager: any) => [Number(manager.id), manager]));
  const ownerByCustomerId = new Map(
    ownerships.map((ownership: any) => [
      Number(ownership.userId),
      Number(ownership.adminId),
    ]),
  );

  const customerUsage = customers.map((customer: any) => {
    const customerId = Number(customer.id);
    const usage = usageFor(customerId);
    const latestCredential = latestManagedCredentialById.get(customerId);
    const ownerId = ownerByCustomerId.get(customerId) ?? null;
    const owner = ownerId == null ? null : adminById.get(ownerId);
    const directApiKeyConfigured = latestCredential?.status === "active";
    return {
      userId: customerId,
      enterpriseName:
        customer.enterpriseName?.trim() ||
        customer.username?.trim() ||
        `客户 ${customer.id}`,
      username: customer.username,
      deliveryAdminId: ownerId,
      deliveryAdminName:
        owner?.displayName?.trim() || owner?.username?.trim() || null,
      apiKeyConfigured: directApiKeyConfigured,
      apiKeyVersion: latestCredential?.version ?? 0,
      usesInheritedKey:
        !directApiKeyConfigured &&
        usage.credentialOwnerId !== null &&
        usage.credentialOwnerId !== customerId,
      keyTotalUsed: usage.used,
      ownAgentMonthUsed: usage.accountUsed,
      otherOrUnattributedUsed: Math.max(0, usage.used - usage.accountUsed),
      fingerprint: usage.fingerprint,
      syncStatus: usage.syncStatus,
      fetchedAt: usage.fetchedAt,
    };
  });

  const engineerUsage = engineers.map((engineer: any) => {
    const usage = usageFor(Number(engineer.id));
    const latestCredential = latestManagedCredentialById.get(
      Number(engineer.id),
    );
    return {
      engineerId: Number(engineer.id),
      displayName:
        engineer.displayName?.trim() ||
        engineer.username?.trim() ||
        `工程师 ${engineer.id}`,
      username: engineer.username,
      apiKeyConfigured: latestCredential?.status === "active",
      apiKeyVersion: latestCredential?.version ?? 0,
      keyTotalUsed: usage.used,
      ownAgentMonthUsed: usage.accountUsed,
      otherOrUnattributedUsed: Math.max(0, usage.used - usage.accountUsed),
      fingerprint: usage.fingerprint,
      syncStatus: usage.syncStatus,
      fetchedAt: usage.fetchedAt,
    };
  });

  return {
    period,
    systemAdmins: systemAdministrators.map((administrator: any) => {
      const usage = usageFor(Number(administrator.id));
      const latestCredential = latestManagedCredentialById.get(
        Number(administrator.id),
      );
      return {
        adminId: Number(administrator.id),
        displayName:
          administrator.displayName?.trim() ||
          administrator.username?.trim() ||
          `系统管理员 ${administrator.id}`,
        username: administrator.username,
        apiKeyConfigured: latestCredential?.status === "active",
        apiKeyVersion: latestCredential?.version ?? 0,
        keyTotalUsed: usage.used,
        ownAgentMonthUsed: usage.accountUsed,
        otherOrUnattributedUsed: Math.max(0, usage.used - usage.accountUsed),
        fingerprint: usage.fingerprint,
        syncStatus: usage.syncStatus,
        fetchedAt: usage.fetchedAt,
      };
    }),
    customers: customerUsage,
    engineers: engineerUsage,
    managers: managers.map((manager: any) => {
      const managerUsage = usageFor(Number(manager.id));
      const latestManagerCredential = latestManagedCredentialById.get(
        Number(manager.id),
      );
      const managedCustomerRecords = ownerships
        .filter(
          (ownership: any) => Number(ownership.adminId) === Number(manager.id),
        )
        .map((ownership: any) => customerById.get(Number(ownership.userId)))
        .filter(Boolean)
        .map((customer: any) => {
          const usage = usageFor(Number(customer.id));
          return {
            customer,
            usage,
          };
        });
      const managedCustomers = managedCustomerRecords.map(
        ({ customer, usage }) => {
          const usesManagerKey = usage.credentialOwnerId === Number(manager.id);
          return {
            userId: Number(customer.id),
            enterpriseName:
              customer.enterpriseName?.trim() ||
              customer.username?.trim() ||
              `用户 ${customer.id}`,
            username: customer.username,
            monthUsed: usage.accountUsed,
            fingerprint: usage.fingerprint,
            usesManagerKey,
            credentialSource: !usage.fingerprint
              ? ("unconfigured" as const)
              : usesManagerKey
                ? ("manager" as const)
                : ("customer" as const),
            syncStatus: usage.syncStatus,
            fetchedAt: usage.fetchedAt,
          };
        },
      );
      // The manager row represents only the manager's current physical Key.
      // A directly configured customer owns a separate pool and must never be
      // added to the manager's Key total.
      const keyPoolTotalUsed = managerUsage.used;
      const keyPoolLimit = managerUsage.limit;
      const keyPoolWarningRatio = managerUsage.warningRatio;
      const keyPoolSyncStatus = managerUsage.syncStatus;
      const attributedUsed =
        managerUsage.accountUsed +
        managedCustomers.reduce(
          (sum, customer) =>
            sum + (customer.usesManagerKey ? customer.monthUsed : 0),
          0,
        );
      return {
        adminId: Number(manager.id),
        displayName:
          manager.displayName?.trim() ||
          manager.username?.trim() ||
          `交付管理员 ${manager.id}`,
        username: manager.username,
        apiKeyConfigured: latestManagerCredential?.status === "active",
        apiKeyVersion: latestManagerCredential?.version ?? 0,
        keyPool: {
          fingerprint: managerUsage.fingerprint,
          credentialCount: managerUsage.fingerprint ? 1 : 0,
          totalUsed: keyPoolTotalUsed,
          limit: keyPoolLimit,
          warningRatio: keyPoolWarningRatio,
          syncStatus: keyPoolSyncStatus,
          fetchedAt: managerUsage.fetchedAt,
          severity: apiUsageSeverity({
            used: keyPoolTotalUsed,
            limit: keyPoolLimit,
            warningRatio: keyPoolWarningRatio,
            syncStatus: keyPoolSyncStatus,
          }),
        },
        ownAgentMonthUsed: managerUsage.accountUsed,
        attributedUsed,
        otherOrUnattributedUsed: Math.max(0, keyPoolTotalUsed - attributedUsed),
        users: managedCustomers,
      };
    }),
  };
}

async function upsertSnapshot(input: {
  executor: any;
  policy: typeof apiUsagePolicies.$inferSelect;
  credentialFingerprint: string | null;
  used: number;
  accountUsed?: number;
  status: "ok" | "error" | "unconfigured";
  errorCode?: string | null;
  windowStartedAt?: Date;
  now: Date;
  syncToken?: string;
}) {
  const existing = await input.executor
    .select()
    .from(apiUsageSnapshots)
    .where(eq(apiUsageSnapshots.policyId, input.policy.id))
    .limit(1);
  const usageValues = usageSnapshotUsageValues({
    status: input.status,
    credentialFingerprint: input.credentialFingerprint,
    used: input.used,
    accountUsed: input.accountUsed ?? input.used,
    existing: existing[0],
  });
  const values = {
    credentialFingerprint: input.credentialFingerprint,
    ...usageValues,
    windowStartedAt:
      input.windowStartedAt ??
      new Date(
        input.now.getTime() -
          DEFAULT_API_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
      ),
    fetchedAt: input.status === "ok" ? input.now : null,
    syncStatus: input.status,
    errorCode: input.errorCode?.slice(0, 64) ?? null,
    updatedAt: input.now,
  } as const;
  const finalizeConditions = [
    eq(apiUsageSnapshots.policyId, input.policy.id),
    lte(apiUsageSnapshots.updatedAt, input.now),
    ...(input.syncToken
      ? [eq(apiUsageSnapshots.syncToken, input.syncToken)]
      : []),
  ];
  if (existing[0]) {
    await input.executor
      .update(apiUsageSnapshots)
      .set(values)
      .where(and(...finalizeConditions));
  } else {
    try {
      await input.executor.insert(apiUsageSnapshots).values({
        id: randomUUID(),
        policyId: input.policy.id,
        ...values,
        createdAt: input.now,
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== "ER_DUP_ENTRY") throw error;
      await input.executor
        .update(apiUsageSnapshots)
        .set(values)
        .where(and(...finalizeConditions));
    }
  }
}

async function claimUsageSnapshotRefresh(input: {
  executor: any;
  policy: typeof apiUsagePolicies.$inferSelect;
  now: Date;
}) {
  const syncToken = randomUUID();
  const initial = {
    id: randomUUID(),
    policyId: input.policy.id,
    credentialFingerprint: null,
    used: 0,
    accountUsed: 0,
    windowStartedAt: new Date(
      input.now.getTime() -
        DEFAULT_API_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
    ),
    fetchedAt: null,
    syncStatus: "pending" as const,
    errorCode: null,
    syncGeneration: 1,
    syncToken,
    syncStartedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  };
  try {
    await input.executor.insert(apiUsageSnapshots).values(initial);
    return syncToken;
  } catch (error) {
    if ((error as { code?: string })?.code !== "ER_DUP_ENTRY") throw error;
  }
  await input.executor
    .update(apiUsageSnapshots)
    .set({
      syncGeneration: sql`${apiUsageSnapshots.syncGeneration} + 1`,
      syncToken,
      syncStartedAt: input.now,
    })
    .where(eq(apiUsageSnapshots.policyId, input.policy.id));
  return syncToken;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await callback(values[index]!);
      }
    }),
  );
}

export async function syncApiUsageSnapshots(actor: AuthenticatedUser) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以同步 Key 与积分使用情况。",
    );
  }
  const db = await requireDb();
  const [workspaceUsers, allAdministrators, deliveryEngineers] =
    await Promise.all([
      accessibleWorkspaceUsers(actor, db),
      accessibleDeliveryAdmins(actor, db),
      accessibleDeliveryEngineers(actor, db),
    ]);
  const deliveryAdmins = allAdministrators.filter(
    (administrator: any) => administrator.adminAccessLevel === "delivery_admin",
  );
  const systemAdministrators = allAdministrators.filter(
    (administrator: any) => administrator.adminAccessLevel === "system_admin",
  );
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: [
      ...workspaceUsers.map((user: any) => user.id),
      ...deliveryAdmins.map((admin: any) => admin.id),
      ...systemAdministrators.map((admin: any) => admin.id),
      ...deliveryEngineers.map((engineer: any) => engineer.id),
    ],
  });
  const now = new Date();
  let synced = 0;
  let failed = 0;
  if (isSystemAdmin(actor)) {
    const policy = await ensureUsagePolicy({
      executor: db,
      scope: "website_frontend",
      workspaceUserId: null,
    });
    const websiteSyncToken = await claimUsageSnapshotRefresh({
      executor: db,
      policy,
      now,
    });
    if (!fingerprints.website) {
      await upsertSnapshot({
        executor: db,
        policy,
        credentialFingerprint: null,
        used: 0,
        status: "unconfigured",
        now,
        syncToken: websiteSyncToken,
      });
    } else {
      try {
        const usage = await getPresalesCreditUsage(
          DEFAULT_API_USAGE_WINDOW_DAYS,
          now.getTime(),
        );
        await upsertSnapshot({
          executor: db,
          policy,
          credentialFingerprint: fingerprints.website,
          used: usage.keyTotalUsed,
          accountUsed: usage.websiteUsed,
          status: usage.complete ? "ok" : "error",
          errorCode: usage.complete ? null : "PARTIAL_TASK_SCAN",
          windowStartedAt: new Date(
            getShanghaiRollingUsagePeriod(
              DEFAULT_API_USAGE_WINDOW_DAYS,
              now.getTime(),
            ).startAt,
          ),
          now,
          syncToken: websiteSyncToken,
        });
        synced += 1;
        if (!usage.complete) failed += 1;
      } catch (error) {
        await upsertSnapshot({
          executor: db,
          policy,
          credentialFingerprint: fingerprints.website,
          used: 0,
          status: "error",
          errorCode: error instanceof Error ? error.name : "SYNC_FAILED",
          now,
          syncToken: websiteSyncToken,
        });
        failed += 1;
      }
    }
  }
  const deliveryAdminIds: number[] = deliveryAdmins.map((admin: any) =>
    Number(admin.id),
  );
  const systemAdministratorIds: number[] = systemAdministrators.map(
    (administrator: any) => Number(administrator.id),
  );
  const workspaceUserIds: number[] = workspaceUsers.map((user: any) =>
    Number(user.id),
  );
  const deliveryEngineerIds: number[] = deliveryEngineers.map((engineer: any) =>
    Number(engineer.id),
  );
  const allWorkspaceOwnershipRows =
    workspaceUserIds.length === 0
      ? []
      : await db
          .select({
            userId: userUsageOwners.userId,
            deliveryAdminId: userUsageOwners.deliveryAdminId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, workspaceUserIds));
  const ownerByWorkspaceUser = new Map(
    allWorkspaceOwnershipRows.map((owner: any) => [
      Number(owner.userId),
      Number(owner.deliveryAdminId),
    ]),
  );
  const syncableWorkspaceUserIds = workspaceUserIds.filter((userId) => {
    const ownerId = ownerByWorkspaceUser.get(userId);
    return ownerId === undefined || deliveryAdminIds.includes(ownerId);
  });
  const accountIds = [
    ...new Set([
      ...deliveryAdminIds,
      ...systemAdministratorIds,
      ...syncableWorkspaceUserIds,
      ...deliveryEngineerIds,
    ]),
  ];
  const policyEntries = await Promise.all(
    accountIds.map(async (accountId) => ({
      accountId,
      policy: await ensureUsagePolicy({
        executor: db,
        scope: "managed_user",
        workspaceUserId: accountId,
      }),
    })),
  );
  const policyByAccount = new Map(
    policyEntries.map((entry) => [entry.accountId, entry.policy]),
  );
  const syncTokenByAccount = new Map(
    await Promise.all(
      policyEntries.map(
        async ({ accountId, policy }) =>
          [
            accountId,
            await claimUsageSnapshotRefresh({ executor: db, policy, now }),
          ] as const,
      ),
    ),
  );
  const accountIdsByCredential = new Map<
    string,
    {
      fingerprint: string;
      credentialOwnerIds: Set<number>;
      accountIds: number[];
    }
  >();
  const unconfiguredAccountIds: number[] = [];
  for (const accountId of accountIds) {
    const fingerprint = fingerprints.byUser.get(accountId);
    const credentialOwnerId = fingerprints.credentialOwnerByUser.get(accountId);
    if (!fingerprint || !credentialOwnerId) {
      unconfiguredAccountIds.push(accountId);
      continue;
    }
    const poolKey = usageCredentialPoolKey({
      fingerprint,
      credentialId: fingerprints.credentialIdByUser.get(accountId) ?? null,
      credentialVersion:
        fingerprints.credentialVersionByUser.get(accountId) ?? null,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
    })!;
    const grouped = accountIdsByCredential.get(poolKey) ?? {
      fingerprint,
      credentialOwnerIds: new Set<number>(),
      accountIds: [],
    };
    grouped.credentialOwnerIds.add(credentialOwnerId);
    grouped.accountIds.push(accountId);
    accountIdsByCredential.set(poolKey, grouped);
  }
  await Promise.all(
    unconfiguredAccountIds.map((accountId) =>
      upsertSnapshot({
        executor: db,
        policy: policyByAccount.get(accountId)!,
        credentialFingerprint: null,
        used: 0,
        accountUsed: 0,
        status: "unconfigured",
        windowStartedAt: new Date(
          getShanghaiRollingUsagePeriod(
            DEFAULT_API_USAGE_WINDOW_DAYS,
            now.getTime(),
          ).startAt,
        ),
        now,
        syncToken: syncTokenByAccount.get(accountId),
      }),
    ),
  );
  await mapWithConcurrency(
    [...accountIdsByCredential.values()],
    API_USAGE_SCAN_CONCURRENCY,
    async ({
      fingerprint,
      credentialOwnerIds,
      accountIds: groupedAccountIds,
    }) => {
      try {
        const policy = policyByAccount.get(groupedAccountIds[0]!)!;
        const usage = await getSharedKeyMonthlyCreditUsageForAccounts({
          credentialOwnerIds: [...credentialOwnerIds],
          accountIds: groupedAccountIds,
          poolFingerprint: fingerprint,
          now: now.getTime(),
          windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
        });
        await Promise.all(
          groupedAccountIds.map((accountId) =>
            upsertSnapshot({
              executor: db,
              policy: policyByAccount.get(accountId)!,
              credentialFingerprint: fingerprints.byUser.get(accountId) ?? null,
              used: usage.totalUsed,
              accountUsed: usage.accounts.get(accountId)?.accountUsed ?? 0,
              status: usage.complete ? "ok" : "error",
              errorCode: usage.complete ? null : "PARTIAL_TASK_SCAN",
              windowStartedAt: new Date(usage.period.startAt),
              now,
              syncToken: syncTokenByAccount.get(accountId),
            }),
          ),
        );
        synced += 1;
        if (!usage.complete) failed += 1;
      } catch (error) {
        await Promise.all(
          groupedAccountIds.map((accountId) =>
            upsertSnapshot({
              executor: db,
              policy: policyByAccount.get(accountId)!,
              credentialFingerprint: fingerprints.byUser.get(accountId) ?? null,
              used: 0,
              accountUsed: 0,
              status: "error",
              errorCode: error instanceof Error ? error.name : "SYNC_FAILED",
              windowStartedAt: new Date(
                getShanghaiRollingUsagePeriod(
                  DEFAULT_API_USAGE_WINDOW_DAYS,
                  now.getTime(),
                ).startAt,
              ),
              now,
              syncToken: syncTokenByAccount.get(accountId),
            }),
          ),
        );
        failed += 1;
      }
    },
  );
  return { synced, failed, finishedAt: Date.now() };
}

export async function updateApiUsagePolicy(input: {
  actor: AuthenticatedUser;
  policyId: string;
  limit: number;
  warningRatio: number;
  windowDays: number;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以修改 API Key 用量策略。",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select()
    .from(apiUsagePolicies)
    .where(eq(apiUsagePolicies.id, input.policyId))
    .limit(1);
  if (!rows[0]) {
    throw new AuthServiceError("NOT_FOUND", "用量策略不存在。");
  }
  await db
    .update(apiUsagePolicies)
    .set({
      limit: input.limit,
      warningRatioBasisPoints: Math.round(input.warningRatio * 10_000),
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      updatedAt: new Date(),
    })
    .where(eq(apiUsagePolicies.id, input.policyId));
  return { success: true };
}

export async function startApiUsageSnapshotScheduler() {
  if (process.env.NODE_ENV === "test") return () => undefined;
  const db = await getDb();
  if (!db) {
    console.warn(
      "[API usage snapshot] Scheduler disabled because the database is not configured.",
    );
    return () => undefined;
  }
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        eq(users.adminAccessLevel, "system_admin"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.username) return () => undefined;
  const actor = {
    ...row,
    username: row.username,
    displayName: row.displayName ?? null,
  } as AuthenticatedUser;
  const run = () =>
    syncApiUsageSnapshots(actor).catch((error) => {
      console.error("[API usage snapshot] Scheduled sync failed", error);
    });
  const initial = setTimeout(run, 10_000);
  initial.unref();
  const interval = setInterval(run, 15 * 60 * 1_000);
  interval.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
