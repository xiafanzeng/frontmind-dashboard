import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presalesApiCredentials, siteProjects } from "../../drizzle/schema";

const mocks = vi.hoisted(() => ({
  bindAliyunCustomerAccountFromOAuth: vi.fn(),
  getDb: vi.fn(),
  getServicePortal: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../service-entitlement", () => ({
  getServicePortal: mocks.getServicePortal,
}));
vi.mock("./aliyun-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aliyun-provider")>();
  return {
    ...actual,
    bindAliyunCustomerAccountFromOAuth:
      mocks.bindAliyunCustomerAccountFromOAuth,
  };
});

import { AliyunProviderError } from "./aliyun-provider";
import { completeSiteOpsAliyunOAuth } from "./service";

const projectId = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: 42,
  role: "user",
  username: "customer-42",
} as const;

function databaseFixture(
  input: {
    credentialActive?: boolean;
    projectOwned?: boolean;
  } = {},
) {
  const committed: Array<{ table: unknown; values: unknown }> = [];
  let pending: Array<{ table: unknown; values: unknown }> = [];
  let rolledBack = false;

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rows =
          table === siteProjects
            ? input.projectOwned === false
              ? []
              : [{ id: projectId }]
            : table === presalesApiCredentials
              ? input.credentialActive === false
                ? []
                : [{ id: credentialId }]
              : [];
        const query = {
          where: vi.fn(() => query),
          limit: vi.fn(() => query),
          for: vi.fn(async () => rows),
        };
        return query;
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => {
          pending.push({ table, values });
          return [{ affectedRows: 1 }];
        }),
      })),
    })),
  };
  const db = {
    transaction: vi.fn(async (callback: (executor: typeof tx) => unknown) => {
      pending = [];
      try {
        const result = await callback(tx);
        committed.push(...pending);
        return result;
      } catch (error) {
        rolledBack = true;
        pending = [];
        throw error;
      }
    }),
  };
  return {
    db,
    tx,
    committed,
    wasRolledBack: () => rolledBack,
  };
}

describe("SiteOps Aliyun OAuth atomic completion", () => {
  const originalEnabled = process.env.FRONTMIND_SITEOPS_ENABLED;

  beforeEach(() => {
    delete process.env.FRONTMIND_SITEOPS_ENABLED;
    mocks.bindAliyunCustomerAccountFromOAuth.mockReset().mockResolvedValue({
      connectionId: "33333333-3333-4333-8333-333333333333",
      status: "unverified",
      requiresRoleAuthorization: true,
    });
    mocks.getDb.mockReset();
    mocks.getServicePortal.mockReset().mockResolvedValue({
      service: { status: "unconfigured" },
      entitlementRollout: { mode: "compatibility" },
    });
  });

  afterEach(() => {
    if (originalEnabled == null) {
      delete process.env.FRONTMIND_SITEOPS_ENABLED;
    } else {
      process.env.FRONTMIND_SITEOPS_ENABLED = originalEnabled;
    }
  });

  it("verifies the exact active credential and binds through one transaction", async () => {
    const fixture = databaseFixture();
    mocks.getDb.mockResolvedValue(fixture.db);

    await expect(
      completeSiteOpsAliyunOAuth({
        actor: actor as never,
        credentialId,
        projectId,
        accountUid: "1234567890123456",
      }),
    ).resolves.toEqual({
      connected: false,
      authorizationRequired: true,
    });

    expect(fixture.db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.bindAliyunCustomerAccountFromOAuth).toHaveBeenCalledWith(
      {
        projectId,
        userId: 42,
        accountUid: "1234567890123456",
      },
      fixture.tx,
    );
    expect(fixture.committed).toHaveLength(1);
    expect(fixture.committed[0]).toMatchObject({
      table: presalesApiCredentials,
      values: {
        validationStatus: "verified",
        verifiedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
    expect(fixture.wasRolledBack()).toBe(false);
  });

  it("rejects a callback pinned to a credential that was rotated", async () => {
    const fixture = databaseFixture({ credentialActive: false });
    mocks.getDb.mockResolvedValue(fixture.db);

    await expect(
      completeSiteOpsAliyunOAuth({
        actor: actor as never,
        credentialId,
        projectId,
        accountUid: "1234567890123456",
      }),
    ).rejects.toMatchObject({
      code: "CREDENTIAL_ROTATED",
      statusCode: 409,
    });

    expect(mocks.bindAliyunCustomerAccountFromOAuth).not.toHaveBeenCalled();
    expect(fixture.committed).toEqual([]);
    expect(fixture.wasRolledBack()).toBe(true);
  });

  it("rolls back credential verification when account binding fails", async () => {
    const fixture = databaseFixture();
    mocks.getDb.mockResolvedValue(fixture.db);
    mocks.bindAliyunCustomerAccountFromOAuth.mockRejectedValueOnce(
      new AliyunProviderError(
        "CONNECTION_IN_USE",
        "provider-message-must-not-escape",
      ),
    );

    await expect(
      completeSiteOpsAliyunOAuth({
        actor: actor as never,
        credentialId,
        projectId,
        accountUid: "1234567890123456",
      }),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      statusCode: 409,
    });

    expect(fixture.tx.update).toHaveBeenCalledWith(presalesApiCredentials);
    expect(mocks.bindAliyunCustomerAccountFromOAuth).toHaveBeenCalledTimes(1);
    expect(fixture.committed).toEqual([]);
    expect(fixture.wasRolledBack()).toBe(true);
  });
});
