import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import {
  apiCredentials,
  apiUsagePolicies,
  apiUsageSnapshots,
  presalesApiCredentials,
  userAdminAssignments,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import type { AuthenticatedUser } from "./auth-service";
import { AuthServiceError } from "./auth-service";
import {
  getManagedUserCreditUsage,
  getShanghaiCalendarMonthPeriod,
  getSharedKeyMonthlyCreditUsageForAccounts,
  isSystemAdmin,
} from "./dashboard-service";
import { getDb } from "./db";
import { getPresalesCreditUsage } from "./presales-service";

export const DEFAULT_API_USAGE_LIMIT = 230_000;
export const DEFAULT_API_USAGE_WARNING_RATIO = 0.8;
export const DEFAULT_API_USAGE_WINDOW_DAYS = 30;

type ApiUsageScope = "website_frontend" | "managed_user";
type ApiUsageSeverity = "normal" | "warning" | "critical" | "unavailable";

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
      .where(and(eq(users.role, "user"), eq(users.isActive, true)));
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
      })
      .from(users)
      .where(
        and(
          eq(users.role, "admin"),
          eq(users.adminAccessLevel, "delivery_admin"),
          eq(users.isActive, true),
        ),
      );
  }
  if (
    actor.role !== "admin" ||
    actor.adminAccessLevel !== "delivery_admin"
  ) {
    return [];
  }
  return [
    {
      id: actor.id,
      displayName: actor.displayName ?? null,
      username: actor.username,
    },
  ];
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

async function usageCredentialFingerprints(input: {
  executor: any;
  userIds: number[];
}) {
  const credentialRows = await input.executor
    .select({
      userId: apiCredentials.userId,
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
  const ownerByUser = new Map<number, number>(
    ownerRows.map((owner: any) => [
      Number(owner.userId),
      Number(owner.deliveryAdminId),
    ]),
  );
  const activeByOwner = new Map<number, string>();
  for (const row of credentialRows) {
    if (!activeByOwner.has(Number(row.userId))) {
      activeByOwner.set(Number(row.userId), row.fingerprint);
    }
  }
  const byUser = new Map<number, string>();
  for (const userId of input.userIds) {
    const credentialOwnerId = ownerByUser.get(userId) ?? userId;
    const fingerprint = activeByOwner.get(credentialOwnerId);
    if (fingerprint) byUser.set(userId, fingerprint);
  }
  const websiteRows = await input.executor
    .select({ fingerprint: presalesApiCredentials.fingerprint })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, "website"),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.createdAt))
    .limit(1);
  const website = websiteRows[0]?.fingerprint ?? null;
  return {
    byUser,
    website,
  };
}

export async function getApiUsageAlertOverview(actor: AuthenticatedUser) {
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
  const snapshotByPolicy = new Map(
    snapshots.map((snapshot) => [snapshot.policyId, snapshot]),
  );
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: workspaceUsers.map((user: any) => user.id),
  });
  const items = policies.map((policy, index) => {
    const scope = scopes[index]!;
    const snapshot = snapshotByPolicy.get(policy.id);
    const credentialFingerprint =
      policy.scope === "website_frontend"
        ? fingerprints.website
        : (fingerprints.byUser.get(policy.workspaceUserId!) ?? null);
    const syncStatus =
      snapshot?.credentialFingerprint === credentialFingerprint
        ? (snapshot?.syncStatus ??
          (credentialFingerprint ? "pending" : "unconfigured"))
        : credentialFingerprint
          ? "pending"
          : "unconfigured";
    const used =
      snapshot?.credentialFingerprint === credentialFingerprint
        ? Number(snapshot?.used ?? 0)
        : 0;
    const accountUsed =
      snapshot?.credentialFingerprint === credentialFingerprint
        ? Number(snapshot?.accountUsed ?? 0)
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
      windowDays: policy.windowDays,
      percentage,
      fetchedAt:
        snapshot?.credentialFingerprint === credentialFingerprint
          ? (snapshot?.fetchedAt?.getTime() ?? null)
          : null,
      periodStartedAt:
        snapshot?.credentialFingerprint === credentialFingerprint
          ? (snapshot?.windowStartedAt?.getTime() ?? null)
          : null,
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
  if (actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有管理员可以查看积分使用情况。",
    );
  }
  const db = await requireDb();
  const managers = await accessibleDeliveryAdmins(actor, db);
  const managerIds = managers.map((manager: any) => Number(manager.id));
  const ownerships =
    managerIds.length === 0
      ? []
      : await db
          .select({
            adminId: userUsageOwners.deliveryAdminId,
            userId: userUsageOwners.userId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.deliveryAdminId, managerIds));
  const customerIds = [
    ...new Set(ownerships.map((ownership: any) => Number(ownership.userId))),
  ];
  const customers =
    customerIds.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            enterpriseName: users.displayName,
            username: users.username,
            isActive: users.isActive,
          })
          .from(users)
          .where(
            and(
              eq(users.role, "user"),
              eq(users.isActive, true),
              inArray(users.id, customerIds),
            ),
          );
  const subjectIds = [...new Set([...managerIds, ...customerIds])];
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
  const snapshotByPolicy = new Map(
    snapshots.map((snapshot) => [snapshot.policyId, snapshot]),
  );
  const policyByUser = new Map(
    policies.map((policy) => [Number(policy.workspaceUserId), policy]),
  );
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: subjectIds,
  });
  const period = getShanghaiCalendarMonthPeriod();

  const usageFor = (userId: number) => {
    const policy = policyByUser.get(userId);
    const fingerprint = fingerprints.byUser.get(userId) ?? null;
    const snapshot = policy ? snapshotByPolicy.get(policy.id) : undefined;
    const currentSnapshot =
      snapshot?.credentialFingerprint === fingerprint &&
      snapshot?.windowStartedAt?.getTime() === period.startAt
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

  return {
    period,
    managers: managers.map((manager: any) => {
      const managerUsage = usageFor(Number(manager.id));
      const managedCustomers = ownerships
        .filter(
          (ownership: any) =>
            Number(ownership.adminId) === Number(manager.id),
        )
        .map((ownership: any) =>
          customerById.get(Number(ownership.userId)),
        )
        .filter(Boolean)
        .map((customer: any) => {
          const usage = usageFor(Number(customer.id));
          return {
            userId: Number(customer.id),
            enterpriseName:
              customer.enterpriseName?.trim() ||
              customer.username?.trim() ||
              `用户 ${customer.id}`,
            username: customer.username,
            monthUsed: usage.accountUsed,
            fingerprint: usage.fingerprint,
            usesManagerKey:
              Boolean(managerUsage.fingerprint) &&
              usage.fingerprint === managerUsage.fingerprint,
            syncStatus: usage.syncStatus,
            fetchedAt: usage.fetchedAt,
          };
        });
      const attributedUsed =
        managerUsage.accountUsed +
        managedCustomers
          .filter((customer) => customer.usesManagerKey)
          .reduce((sum, customer) => sum + customer.monthUsed, 0);
      return {
        adminId: Number(manager.id),
        displayName:
          manager.displayName?.trim() ||
          manager.username?.trim() ||
          `交付管理员 ${manager.id}`,
        username: manager.username,
        keyPool: {
          fingerprint: managerUsage.fingerprint,
          totalUsed: managerUsage.used,
          limit: managerUsage.limit,
          warningRatio: managerUsage.warningRatio,
          syncStatus: managerUsage.syncStatus,
          fetchedAt: managerUsage.fetchedAt,
          severity: managerUsage.severity,
        },
        ownAgentMonthUsed: managerUsage.accountUsed,
        attributedUsed,
        otherOrUnattributedUsed: Math.max(
          0,
          managerUsage.used - attributedUsed,
        ),
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
}) {
  const existing = await input.executor
    .select()
    .from(apiUsageSnapshots)
    .where(eq(apiUsageSnapshots.policyId, input.policy.id))
    .limit(1);
  const values = {
    credentialFingerprint: input.credentialFingerprint,
    used: Math.max(0, Math.round(input.used)),
    accountUsed: Math.max(0, Math.round(input.accountUsed ?? input.used)),
    windowStartedAt:
      input.windowStartedAt ??
      new Date(
        input.now.getTime() -
          input.policy.windowDays * 24 * 60 * 60 * 1_000,
      ),
    fetchedAt: input.status === "ok" ? input.now : null,
    syncStatus: input.status,
    errorCode: input.errorCode?.slice(0, 64) ?? null,
    updatedAt: input.now,
  } as const;
  if (existing[0]) {
    await input.executor
      .update(apiUsageSnapshots)
      .set(values)
      .where(eq(apiUsageSnapshots.policyId, input.policy.id));
  } else {
    await input.executor.insert(apiUsageSnapshots).values({
      id: randomUUID(),
      policyId: input.policy.id,
      ...values,
      createdAt: input.now,
    });
  }
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
  const db = await requireDb();
  const workspaceUsers = await accessibleWorkspaceUsers(actor, db);
  const deliveryAdmins = await accessibleDeliveryAdmins(actor, db);
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: [
      ...workspaceUsers.map((user: any) => user.id),
      ...deliveryAdmins.map((admin: any) => admin.id),
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
    if (!fingerprints.website) {
      await upsertSnapshot({
        executor: db,
        policy,
        credentialFingerprint: null,
        used: 0,
        status: "unconfigured",
        now,
      });
    } else {
      try {
        const usage = await getPresalesCreditUsage(policy.windowDays);
        await upsertSnapshot({
          executor: db,
          policy,
          credentialFingerprint: fingerprints.website,
          used: usage.totalUsed,
          status: "ok",
          now,
        });
        synced += 1;
      } catch (error) {
        await upsertSnapshot({
          executor: db,
          policy,
          credentialFingerprint: fingerprints.website,
          used: 0,
          status: "error",
          errorCode: error instanceof Error ? error.name : "SYNC_FAILED",
          now,
        });
        failed += 1;
      }
    }
  }
  const deliveryAdminIds = deliveryAdmins.map((admin: any) =>
    Number(admin.id),
  );
  const workspaceUserIds = workspaceUsers.map((user: any) =>
    Number(user.id),
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
  const ownershipRows = allWorkspaceOwnershipRows.filter((owner: any) =>
    deliveryAdminIds.includes(Number(owner.deliveryAdminId)),
  );
  const pooledUserIds = new Set(
    allWorkspaceOwnershipRows.map((owner: any) => Number(owner.userId)),
  );
  await mapWithConcurrency(deliveryAdmins, 3, async (admin: any) => {
    const childUserIds = ownershipRows
      .filter(
        (owner: any) =>
          Number(owner.deliveryAdminId) === Number(admin.id),
      )
      .map((owner: any) => Number(owner.userId));
    const accountIds = [Number(admin.id), ...childUserIds];
    const policies = await Promise.all(
      accountIds.map((accountId) =>
        ensureUsagePolicy({
          executor: db,
          scope: "managed_user",
          workspaceUserId: accountId,
        }),
      ),
    );
    const fingerprint = fingerprints.byUser.get(admin.id) ?? null;
    const monthPeriod = getShanghaiCalendarMonthPeriod(now.getTime());
    if (!fingerprint) {
      await Promise.all(
        policies.map((policy) =>
          upsertSnapshot({
            executor: db,
            policy,
            credentialFingerprint: null,
            used: 0,
            accountUsed: 0,
            status: "unconfigured",
            windowStartedAt: new Date(monthPeriod.startAt),
            now,
          }),
        ),
      );
      return;
    }
    try {
      const usage = await getSharedKeyMonthlyCreditUsageForAccounts({
        credentialOwnerId: admin.id,
        accountIds,
        now: now.getTime(),
      });
      await Promise.all(
        policies.map((policy, index) =>
          upsertSnapshot({
            executor: db,
            policy,
            credentialFingerprint: fingerprint,
            used: usage.totalUsed,
            accountUsed:
              usage.accounts.get(accountIds[index]!)?.accountUsed ?? 0,
            status: usage.complete ? "ok" : "error",
            errorCode: usage.complete ? null : "PARTIAL_TASK_SCAN",
            windowStartedAt: new Date(monthPeriod.startAt),
            now,
          }),
        ),
      );
      synced += 1;
      if (!usage.complete) failed += 1;
    } catch (error) {
      await Promise.all(
        policies.map((policy) =>
          upsertSnapshot({
            executor: db,
            policy,
            credentialFingerprint: fingerprint,
            used: 0,
            accountUsed: 0,
            status: "error",
            errorCode: error instanceof Error ? error.name : "SYNC_FAILED",
            windowStartedAt: new Date(monthPeriod.startAt),
            now,
          }),
        ),
      );
      failed += 1;
    }
  });
  await mapWithConcurrency(
    workspaceUsers.filter(
      (user: any) => !pooledUserIds.has(Number(user.id)),
    ),
    3,
    async (user: any) => {
    const policy = await ensureUsagePolicy({
      executor: db,
      scope: "managed_user",
      workspaceUserId: user.id,
    });
    const fingerprint = fingerprints.byUser.get(user.id) ?? null;
    const monthPeriod = getShanghaiCalendarMonthPeriod(now.getTime());
    if (!fingerprint) {
      await upsertSnapshot({
        executor: db,
        policy,
        credentialFingerprint: null,
        used: 0,
        accountUsed: 0,
        status: "unconfigured",
        windowStartedAt: new Date(monthPeriod.startAt),
        now,
      });
      return;
    }
    try {
      const usage = await getManagedUserCreditUsage(
        actor,
        user.id,
        policy.windowDays,
      );
      await upsertSnapshot({
        executor: db,
        policy,
        credentialFingerprint: fingerprint,
        used: usage.totalUsed,
        accountUsed: usage.accountUsed,
        status: "ok",
        windowStartedAt: new Date(monthPeriod.startAt),
        now,
      });
      synced += 1;
    } catch (error) {
      await upsertSnapshot({
        executor: db,
        policy,
        credentialFingerprint: fingerprint,
        used: 0,
        accountUsed: 0,
        status: "error",
        errorCode: error instanceof Error ? error.name : "SYNC_FAILED",
        windowStartedAt: new Date(monthPeriod.startAt),
        now,
      });
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
      windowDays: input.windowDays,
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
