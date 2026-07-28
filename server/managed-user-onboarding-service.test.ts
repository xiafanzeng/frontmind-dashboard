import { describe, expect, it, vi } from "vitest";

import {
  SERVICE_PLAN_CATALOG,
  type ServicePlanCode,
} from "../shared/service-portal";
import type { AuthenticatedUser } from "./auth-service";
import { createManagedServiceUser } from "./managed-user-onboarding-service";
import { deriveServicePortalState } from "./service-entitlement";

function actor(
  access: "delivery_admin" | "system_admin" = "delivery_admin",
): AuthenticatedUser {
  const now = new Date("2026-07-28T08:00:00.000Z");
  return {
    id: access === "system_admin" ? 1 : 42,
    openId: null,
    username: access === "system_admin" ? "admin" : "delivery.manager",
    displayName: "管理员",
    name: "管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel: access,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

type TestState = {
  accounts: number[];
  contracts: any[];
  quotaPeriods: any[];
  assignments: any[];
  audits: any[];
};

function cloneState(state: TestState): TestState {
  return {
    accounts: [...state.accounts],
    contracts: structuredClone(state.contracts),
    quotaPeriods: structuredClone(state.quotaPeriods),
    assignments: structuredClone(state.assignments),
    audits: structuredClone(state.audits),
  };
}

function harness(options?: { failAt?: "contract" | "audit" }) {
  let committed: TestState = {
    accounts: [],
    contracts: [],
    quotaPeriods: [],
    assignments: [],
    audits: [],
  };
  let nextId = 0;
  const dependencies = {
    now: () => new Date("2026-07-28T08:00:00.000Z"),
    randomId: () =>
      `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    transaction: async <T>(callback: (executor: unknown) => Promise<T>) => {
      const working = cloneState(committed);
      const result = await callback(working);
      committed = working;
      return result;
    },
    createAccount: async (_input: unknown, executor: unknown) => {
      const state = executor as TestState;
      state.accounts.push(501);
      return {
        user: {
          ...actor(),
          id: 501,
          username: "new.customer",
          role: "user" as const,
          adminAccessLevel: null,
        },
        setupToken: "one-time-setup-token",
        setupExpiresAt: new Date("2026-07-30T08:00:00.000Z"),
      };
    },
    persistContract: async (value: any, executor: unknown) => {
      if (options?.failAt === "contract") throw new Error("contract failed");
      const state = executor as TestState;
      state.contracts.push(value.contract);
      state.quotaPeriods.push(...value.quotaPeriods);
    },
    writeAudit: async (value: any, executor: unknown) => {
      if (options?.failAt === "audit") throw new Error("audit failed");
      (executor as TestState).audits.push(value);
    },
  };
  return {
    dependencies,
    state: () => committed,
  };
}

describe("managed user onboarding", () => {
  it.each<ServicePlanCode>(["basic", "advanced", "luxury"])(
    "records a commercially inactive %s selection without minting quota",
    async (planCode) => {
      const test = harness();
      const result = await createManagedServiceUser(
        {
          actor: actor("system_admin"),
          username: "new.customer",
          displayName: "新客户",
          planCode,
        },
        test.dependencies,
      );
      const state = test.state();

      expect(result.contract).toMatchObject({
        userId: 501,
        planCode,
        quotaPeriodCount: 0,
      });
      expect(result.assignedToCreator).toBe(false);
      expect(state.accounts).toEqual([501]);
      expect(state.contracts).toEqual([
        expect.objectContaining({
          userId: 501,
          planCode,
          planVersion: SERVICE_PLAN_CATALOG[planCode].planVersion,
          status: "pending_confirmation",
          source: "admin",
          amountFen: null,
          revision: 1,
        }),
      ]);
      expect(state.quotaPeriods).toEqual([]);
      expect(state.assignments).toEqual([]);
      expect(state.audits[0]).toMatchObject({
        action: "account.created",
        workspaceUserId: 501,
        metadata: {
          role: "user",
          setupRequired: true,
          planCode,
          contractId: result.contract.id,
          entitlementStatus: "pending_confirmation",
          assignedToCreator: false,
        },
      });
      const portal = deriveServicePortalState({
        userId: 501,
        now: new Date("2026-07-28T08:00:01.000Z"),
        account: {
          userId: 501,
          username: "new.customer",
          displayName: "新客户",
        },
        contract: state.contracts[0],
        contracts: state.contracts,
        quotaPeriod: state.quotaPeriods[0],
        quotaPeriods: state.quotaPeriods,
        selectedQuestions: [],
        knowledgeVersion: null,
        latestImportStatus: null,
        hasActiveKnowledgeBuild: false,
      });
      expect(portal.service).toMatchObject({
        planCode,
        status: "pending_confirmation",
      });
      expect(portal.quotas).toBeNull();
      expect(portal.capabilities.knowledgeBuild.allowed).toBe(false);
    },
  );

  it("lets a system administrator create a contracted user without inventing an ordinary-admin assignment", async () => {
    const test = harness();
    const result = await createManagedServiceUser(
      {
        actor: actor("system_admin"),
        username: "system.created.customer",
        planCode: "advanced",
      },
      test.dependencies,
    );

    expect(result.assignedToCreator).toBe(false);
    expect(test.state().contracts).toHaveLength(1);
    expect(test.state().assignments).toEqual([]);
  });

  it.each(["contract", "audit"] as const)(
    "rolls back the login account when %s persistence fails",
    async (failAt) => {
      const test = harness({ failAt });

      await expect(
        createManagedServiceUser(
          {
            actor: actor("system_admin"),
            username: "rollback.customer",
            planCode: "luxury",
          },
          test.dependencies,
        ),
      ).rejects.toThrow();
      expect(test.state()).toEqual({
        accounts: [],
        contracts: [],
        quotaPeriods: [],
        assignments: [],
        audits: [],
      });
    },
  );

  it("rejects a non-admin before opening a transaction", async () => {
    const test = harness();
    const userActor = { ...actor(), role: "user" as const };
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: userActor,
          username: "forbidden.customer",
          planCode: "basic",
        },
        test.dependencies,
      ),
    ).rejects.toThrow("只有系统管理员");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a delivery administrator before opening a transaction", async () => {
    const test = harness();
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: actor("delivery_admin"),
          username: "bypass.customer",
          planCode: "luxury",
        },
        test.dependencies,
      ),
    ).rejects.toThrow("只有系统管理员");
    expect(transaction).not.toHaveBeenCalled();
    expect(test.state()).toEqual({
      accounts: [],
      contracts: [],
      quotaPeriods: [],
      assignments: [],
      audits: [],
    });
  });
});
