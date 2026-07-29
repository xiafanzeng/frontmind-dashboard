import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import {
  apiCredentials,
  serviceContracts,
  serviceQuotaPeriods,
  userAdminAssignments,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import { DELIVERY_TICKET_LIMITS } from "../shared/delivery-ticket";
import {
  SERVICE_PLAN_CATALOG,
  servicePlanCodeSchema,
  type ServicePlanCode,
} from "../shared/service-portal";
import {
  AuthServiceError,
  createManagedUserWithSetupToken,
  getApiKeyFingerprint,
  replaceApiCredentialInTransaction,
  validateUpstreamApiKey,
  type AuthenticatedUser,
} from "./auth-service";
import {
  hasSystemAdminAccess,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";
import { getDb } from "./db";
import {
  createServiceQuotaWindows,
  getServiceContractTermEnd,
} from "./service-entitlement";

type SetupAccount = Awaited<ReturnType<typeof createManagedUserWithSetupToken>>;

export type InitialManagedServiceContract = {
  id: string;
  userId: number;
  planCode: ServicePlanCode;
  startsAt: Date;
  endsAt: Date;
  quotaPeriodCount: number;
};

type ManagedUserOnboardingDependencies = {
  transaction?: <T>(callback: (executor: unknown) => Promise<T>) => Promise<T>;
  createAccount?: (
    input: {
      username: string;
      displayName?: string | null;
      createdByUserId: number;
      now: Date;
    },
    executor: unknown,
  ) => Promise<SetupAccount>;
  persistContract?: (
    input: {
      contract: typeof serviceContracts.$inferInsert;
      quotaPeriods: Array<typeof serviceQuotaPeriods.$inferInsert>;
    },
    executor: unknown,
  ) => Promise<void>;
  persistCredentialAndAssignment?: (
    input: {
      userId: number;
      actorUserId: number;
      deliveryAdminId: number;
      apiKey: string;
      now: Date;
    },
    executor: unknown,
  ) => Promise<void>;
  validateDeliveryAdmin?: (
    deliveryAdminId: number,
    executor: unknown,
  ) => Promise<void>;
  validateApiKey?: (apiKey: string) => Promise<void>;
  writeAudit?: (
    input: Parameters<typeof writeWorkspaceAuditEvent>[0],
    executor: unknown,
  ) => Promise<unknown>;
  now?: () => Date;
  randomId?: () => string;
};

async function defaultTransaction() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return <T>(callback: (executor: unknown) => Promise<T>) =>
    db.transaction((executor) => callback(executor));
}

/**
 * Creates a login account, one-time password setup token, direct credential,
 * active contract, quota windows and responsible-admin assignment in one
 * transaction after the credential has been validated upstream.
 */
export async function createManagedServiceUser(
  input: {
    actor: AuthenticatedUser;
    username: string;
    displayName?: string | null;
    planCode: ServicePlanCode;
    deliveryAdminId: number;
    apiKey: string;
  },
  dependencies: ManagedUserOnboardingDependencies = {},
) {
  if (!hasSystemAdminAccess(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以创建客户账号并发起商业开通",
    );
  }
  const planCode = servicePlanCodeSchema.parse(input.planCode);
  const now = dependencies.now?.() ?? new Date();
  const contractId = dependencies.randomId?.() ?? randomUUID();
  const plan = SERVICE_PLAN_CATALOG[planCode];
  const startsAt = now;
  const endsAt = getServiceContractTermEnd(planCode, startsAt);
  await (dependencies.validateApiKey ?? validateUpstreamApiKey)(input.apiKey);
  const transaction = dependencies.transaction ?? (await defaultTransaction());
  const createAccount =
    dependencies.createAccount ??
    ((accountInput, executor) =>
      createManagedUserWithSetupToken(accountInput, executor));
  const persistContract =
    dependencies.persistContract ??
    (async (value, executor) => {
      const tx = executor as any;
      await tx.insert(serviceContracts).values(value.contract);
      if (value.quotaPeriods.length) {
        await tx.insert(serviceQuotaPeriods).values(value.quotaPeriods);
      }
    });
  const writeAudit =
    dependencies.writeAudit ??
    ((event, executor) => writeWorkspaceAuditEvent(event, executor));
  const persistCredentialAndAssignment =
    dependencies.persistCredentialAndAssignment ??
    (async (value, executor) => {
      const tx = executor as any;
      await replaceApiCredentialInTransaction({
        executor: tx,
        userId: value.userId,
        apiKey: value.apiKey,
        now: value.now,
      });
      await tx.insert(userAdminAssignments).values({
        userId: value.userId,
        adminId: value.deliveryAdminId,
        assignedByUserId: value.actorUserId,
      });
      await tx.insert(userUsageOwners).values({
        userId: value.userId,
        deliveryAdminId: value.deliveryAdminId,
        revision: 1,
      });
    });
  const validateDeliveryAdmin =
    dependencies.validateDeliveryAdmin ??
    (async (deliveryAdminId, executor) => {
      const tx = executor as any;
      const rows = await tx
        .select({
          id: users.id,
          role: users.role,
          adminAccessLevel: users.adminAccessLevel,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, deliveryAdminId))
        .limit(1)
        .for("update");
      const admin = rows[0];
      if (
        !admin ||
        admin.role !== "admin" ||
        admin.adminAccessLevel !== "delivery_admin" ||
        admin.isActive !== true
      ) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          "请选择一个已启用的交付管理员作为客户主负责人",
        );
      }
    });

  return transaction(async (executor) => {
    await validateDeliveryAdmin(input.deliveryAdminId, executor);
    const setup = await createAccount(
      {
        username: input.username,
        displayName: input.displayName,
        createdByUserId: input.actor.id,
        now,
      },
      executor,
    );
    const userId = setup.user.id;
    const quotaPeriods = createServiceQuotaWindows(planCode, startsAt).map(
      (window) => ({
        id: dependencies.randomId?.() ?? randomUUID(),
        contractId,
        userId,
        ordinal: window.ordinal,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        ...window.limits,
        contentAssetPublishLimit:
          DELIVERY_TICKET_LIMITS[planCode].content_asset_publish,
        websiteContentPublishLimit:
          DELIVERY_TICKET_LIMITS[planCode].website_content_publish,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const contract: typeof serviceContracts.$inferInsert = {
      id: contractId,
      userId,
      planCode,
      planVersion: plan.planVersion,
      status: "active",
      startsAt,
      endsAt,
      source: "admin",
      amountFen: null,
      currency: "CNY",
      prepaidMonths: plan.prepaidMonths,
      orderReference: null,
      externalContractReference: null,
      signedAt: null,
      signatoryId: null,
      signingEvidence: null,
      replacesContractIds: [],
      sourceReference: `managed-user-onboarding:${contractId}`,
      revision: 1,
      createdByUserId: input.actor.id,
      createdAt: now,
      updatedAt: now,
    };
    await persistContract(
      {
        contract,
        quotaPeriods,
      },
      executor,
    );
    await persistCredentialAndAssignment(
      {
        userId,
        actorUserId: input.actor.id,
        deliveryAdminId: input.deliveryAdminId,
        apiKey: input.apiKey,
        now,
      },
      executor,
    );

    await writeAudit(
      {
        actor: input.actor,
        action: "account.created",
        targetType: "user",
        targetId: userId,
        workspaceUserId: userId,
        metadata: {
          role: "user",
          setupRequired: true,
          planCode,
          contractId,
          entitlementStatus: "active",
          deliveryAdminId: input.deliveryAdminId,
          quotaPeriodCount: quotaPeriods.length,
        },
      },
      executor,
    );

    return {
      ...setup,
      contract: {
        id: contractId,
        userId,
        planCode,
        startsAt,
        endsAt,
        quotaPeriodCount: quotaPeriods.length,
      } satisfies InitialManagedServiceContract,
      assignedToCreator: input.deliveryAdminId === input.actor.id,
      assignedDeliveryAdminId: input.deliveryAdminId,
    };
  });
}

type CompleteProvisioningDependencies = {
  transaction?: <T>(callback: (executor: any) => Promise<T>) => Promise<T>;
  validateApiKey?: (apiKey: string) => Promise<void>;
  validateDeliveryAdmin?: (
    deliveryAdminId: number,
    executor: any,
  ) => Promise<void>;
  now?: () => Date;
  randomId?: () => string;
};

export async function completeManagedServiceUserProvisioning(
  input: {
    actor: AuthenticatedUser;
    userId: number;
    expectedRevision: number;
    deliveryAdminId: number;
    apiKey: string;
  },
  dependencies: CompleteProvisioningDependencies = {},
) {
  if (!hasSystemAdminAccess(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以补全客户开通",
    );
  }
  await (dependencies.validateApiKey ?? validateUpstreamApiKey)(input.apiKey);
  const transaction = dependencies.transaction ?? (await defaultTransaction());
  const now = dependencies.now?.() ?? new Date();
  const expectedFingerprint = getApiKeyFingerprint(input.apiKey);

  return transaction(async (tx) => {
    const validateDeliveryAdmin =
      dependencies.validateDeliveryAdmin ??
      (async (deliveryAdminId: number, executor: any) => {
        const rows = await executor
          .select({
            id: users.id,
            role: users.role,
            adminAccessLevel: users.adminAccessLevel,
            isActive: users.isActive,
          })
          .from(users)
          .where(eq(users.id, deliveryAdminId))
          .limit(1)
          .for("update");
        const admin = rows[0];
        if (
          !admin ||
          admin.role !== "admin" ||
          admin.adminAccessLevel !== "delivery_admin" ||
          admin.isActive !== true
        ) {
          throw new AuthServiceError(
            "INVALID_CREDENTIAL",
            "请选择一个已启用的交付管理员作为客户主负责人",
          );
        }
      });
    await validateDeliveryAdmin(input.deliveryAdminId, tx);
    const accountRows = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!accountRows[0] || accountRows[0].role !== "user") {
      throw new AuthServiceError("NOT_FOUND", "客户账号不存在");
    }
    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(eq(serviceContracts.userId, input.userId))
      .orderBy(desc(serviceContracts.revision))
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    if (!contract) {
      throw new AuthServiceError("CONFLICT", "客户尚未选择套餐");
    }
    if (contract.revision !== input.expectedRevision) {
      throw new AuthServiceError("CONFLICT", "服务版本已变化，请刷新后重试");
    }
    const existingQuotaRows = await tx
      .select({ id: serviceQuotaPeriods.id })
      .from(serviceQuotaPeriods)
      .where(eq(serviceQuotaPeriods.contractId, contract.id))
      .for("update");
    const directCredentials = await tx
      .select({
        fingerprint: apiCredentials.fingerprint,
      })
      .from(apiCredentials)
      .where(
        and(
          eq(apiCredentials.userId, input.userId),
          eq(apiCredentials.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    const ownerRows = await tx
      .select()
      .from(userUsageOwners)
      .where(eq(userUsageOwners.userId, input.userId))
      .limit(1)
      .for("update");

    if (contract.status === "active") {
      if (
        existingQuotaRows.length > 0 &&
        directCredentials[0]?.fingerprint === expectedFingerprint &&
        ownerRows[0]?.deliveryAdminId === input.deliveryAdminId
      ) {
        return {
          userId: input.userId,
          contractId: contract.id,
          planCode: contract.planCode,
          quotaPeriodCount: existingQuotaRows.length,
          assignedToCreator: input.deliveryAdminId === input.actor.id,
          assignedDeliveryAdminId: input.deliveryAdminId,
          idempotent: true,
        };
      }
      throw new AuthServiceError(
        "CONFLICT",
        "客户已经开通，当前 Key 或额度状态与本次请求不一致",
      );
    }
    if (contract.status !== "pending_confirmation") {
      throw new AuthServiceError("CONFLICT", "只有待确认套餐可以使用补全开通");
    }
    if (existingQuotaRows.length > 0 || directCredentials[0]) {
      throw new AuthServiceError(
        "CONFLICT",
        "待确认账号存在不完整的 Key 或额度数据，请联系技术支持",
      );
    }
    const contractPlanCode = servicePlanCodeSchema.parse(contract.planCode);

    const quotaRows = createServiceQuotaWindows(
      contractPlanCode,
      contract.startsAt,
    ).map((window) => ({
      id: dependencies.randomId?.() ?? randomUUID(),
      contractId: contract.id,
      userId: input.userId,
      ordinal: window.ordinal,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      ...window.limits,
      contentAssetPublishLimit:
        DELIVERY_TICKET_LIMITS[contractPlanCode].content_asset_publish,
      websiteContentPublishLimit:
        DELIVERY_TICKET_LIMITS[contractPlanCode].website_content_publish,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    await tx.insert(serviceQuotaPeriods).values(quotaRows);
    await tx
      .update(serviceContracts)
      .set({ status: "active", updatedAt: now })
      .where(eq(serviceContracts.id, contract.id));
    await replaceApiCredentialInTransaction({
      executor: tx,
      userId: input.userId,
      apiKey: input.apiKey,
      now,
    });
    await tx
      .insert(userAdminAssignments)
      .values({
        userId: input.userId,
        adminId: input.deliveryAdminId,
        assignedByUserId: input.actor.id,
      })
      .onDuplicateKeyUpdate({
        set: { assignedByUserId: input.actor.id },
      });
    if (ownerRows[0]) {
      await tx
        .update(userUsageOwners)
        .set({
          deliveryAdminId: input.deliveryAdminId,
          revision: ownerRows[0].revision + 1,
          updatedAt: now,
        })
        .where(eq(userUsageOwners.userId, input.userId));
    } else {
      await tx.insert(userUsageOwners).values({
        userId: input.userId,
        deliveryAdminId: input.deliveryAdminId,
        revision: 1,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "account.provisioning_completed",
        targetType: "user",
        targetId: input.userId,
        workspaceUserId: input.userId,
        metadata: {
          contractId: contract.id,
          planCode: contractPlanCode,
          expectedRevision: input.expectedRevision,
          quotaPeriodCount: quotaRows.length,
          credentialFingerprint: expectedFingerprint,
          deliveryAdminId: input.deliveryAdminId,
        },
      },
      tx,
    );
    return {
      userId: input.userId,
      contractId: contract.id,
      planCode: contractPlanCode,
      quotaPeriodCount: quotaRows.length,
      assignedToCreator: input.deliveryAdminId === input.actor.id,
      assignedDeliveryAdminId: input.deliveryAdminId,
      idempotent: false,
    };
  });
}
