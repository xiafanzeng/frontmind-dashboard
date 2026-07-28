import { randomUUID } from "node:crypto";

import { serviceContracts, serviceQuotaPeriods } from "../drizzle/schema";
import {
  SERVICE_PLAN_CATALOG,
  servicePlanCodeSchema,
  type ServicePlanCode,
} from "../shared/service-portal";
import {
  AuthServiceError,
  createManagedUserWithSetupToken,
  type AuthenticatedUser,
} from "./auth-service";
import {
  hasSystemAdminAccess,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";
import { getDb } from "./db";
import { getServiceContractTermEnd } from "./service-entitlement";

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
 * Creates a login account, one-time password setup token and a commercially
 * inactive contract selection in one transaction. No quota is minted here:
 * the existing system-admin service update flow must verify order, contract and
 * signing evidence before it can schedule or activate the selected plan.
 */
export async function createManagedServiceUser(
  input: {
    actor: AuthenticatedUser;
    username: string;
    displayName?: string | null;
    planCode: ServicePlanCode;
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

  return transaction(async (executor) => {
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
    const contract: typeof serviceContracts.$inferInsert = {
      id: contractId,
      userId,
      planCode,
      planVersion: plan.planVersion,
      status: "pending_confirmation",
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
        quotaPeriods: [],
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
          entitlementStatus: "pending_confirmation",
          assignedToCreator: false,
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
        quotaPeriodCount: 0,
      } satisfies InitialManagedServiceContract,
      assignedToCreator: false,
    };
  });
}
