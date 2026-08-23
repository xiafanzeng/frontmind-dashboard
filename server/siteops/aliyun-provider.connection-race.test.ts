import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SiteProviderConnection } from "../../drizzle/schema";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: dbMock.getDb,
}));

import {
  sealAliyunExternalId,
  verifyAliyunCustomerConnection,
  type AliyunProviderSdkFactory,
} from "./aliyun-provider";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = 7;
const ACCOUNT_UID = "123456789012";

function activeConnection(): SiteProviderConnection {
  const now = new Date("2026-08-23T00:00:00.000Z");
  return {
    id: CONNECTION_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    provider: "aliyun_cn",
    accountUid: ACCOUNT_UID,
    roleArn: `acs:ram::${ACCOUNT_UID}:role/FrontMindSiteOpsAccess`,
    ...sealAliyunExternalId(CONNECTION_ID, "external-id-before-revoke"),
    capabilities: ["sts_assume_role", "domain_read", "alidns_read"],
    status: "active",
    verifiedAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeDb(input: { updateAffectedRows: number }) {
  const selected = [[{ id: PROJECT_ID }], [activeConnection()]];
  const updateValues: Array<Record<string, unknown>> = [];
  const updateWhere = vi.fn(async () => [
    { affectedRows: input.updateAffectedRows },
  ]);
  const db = {
    select: vi.fn(() => {
      const rows = selected.shift() ?? [];
      const query = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(async () => rows),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        return { where: updateWhere };
      }),
    })),
  };
  return { db, updateValues, updateWhere };
}

function successfulFactory(): AliyunProviderSdkFactory {
  const credentials = {
    accessKeyId: "temporary-id",
    accessKeySecret: "temporary-secret",
    securityToken: "temporary-token",
    expiration: null,
    assumedRoleArn: null,
  };
  return {
    assumeRole: vi.fn(async () => credentials),
    getCallerAccount: vi.fn(async () => ACCOUNT_UID),
    domain: vi.fn(
      () =>
        ({
          listVerifiedRegistrantProfiles: vi.fn(async () => []),
        }) as never,
    ),
    dns: vi.fn(
      () =>
        ({
          listDomains: vi.fn(async () => []),
        }) as never,
    ),
  };
}

describe("Aliyun connection verification CAS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
      32,
      67,
    ).toString("base64")}`;
  });

  it("does not report success when disconnect wins the verification race", async () => {
    const database = fakeDb({ updateAffectedRows: 0 });
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      verifyAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        successfulFactory(),
      ),
    ).rejects.toMatchObject({ code: "ALIYUN_CONNECTION_CHANGED" });

    expect(database.updateWhere).toHaveBeenCalledTimes(1);
    expect(database.updateValues).toHaveLength(1);
    expect(database.updateValues[0]).toMatchObject({ status: "active" });
  });

  it("does not restore a revoked active connection after a provider failure", async () => {
    const database = fakeDb({ updateAffectedRows: 0 });
    dbMock.getDb.mockResolvedValue(database.db);
    const factory = successfulFactory();
    vi.mocked(factory.assumeRole).mockRejectedValueOnce(
      new Error("temporary provider outage"),
    );

    await expect(
      verifyAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        factory,
      ),
    ).rejects.toMatchObject({ code: "ALIYUN_CONNECTION_CHANGED" });

    expect(database.updateWhere).toHaveBeenCalledTimes(1);
    expect(database.updateValues).toHaveLength(1);
    expect(database.updateValues[0]).toMatchObject({
      status: "active",
      lastErrorCode: "ALIYUN_CONNECTION_VERIFICATION_FAILED",
    });
  });
});
