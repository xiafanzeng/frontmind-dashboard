import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  siteDomainOperations,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  type SiteProviderConnection,
} from "../../drizzle/schema";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: dbMock.getDb,
}));

import {
  ALIYUN_ROLE_MIGRATION_DEFERRED_CODE,
  AliyunProviderError,
  aliyunCustomerRoleName,
  getAliyunCustomerRoleAuthorizationPackage,
  prepareAliyunCustomerRoleProvisioning,
  probeAliyunCustomerConnection,
  sealAliyunExternalId,
  type AliyunProviderSdkFactory,
} from "./aliyun-provider";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = 7;
const ACCOUNT_UID = "123456789012";
const LEGACY_ROLE_ARN = `acs:ram::${ACCOUNT_UID}:role/FrontMindSiteOpsAccess`;
const UNIQUE_ROLE_ARN = `acs:ram::${ACCOUNT_UID}:role/FrontMindSiteOps-222222222222`;

function customerConnection(
  overrides: Partial<SiteProviderConnection> = {},
): SiteProviderConnection {
  const now = new Date();
  return {
    id: CONNECTION_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    provider: "aliyun_cn",
    accountUid: ACCOUNT_UID,
    roleArn: UNIQUE_ROLE_ARN,
    ...sealAliyunExternalId(CONNECTION_ID, "external-id-for-probe"),
    capabilities: [],
    status: "unverified",
    verifiedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeDb(
  connection: SiteProviderConnection,
  input: { updateAffectedRows?: number } = {},
) {
  let currentConnection = { ...connection };
  const updateValues: Array<Record<string, unknown>> = [];
  const updateWhere = vi.fn();
  const db = {
    select: vi.fn(() => {
      let rows: unknown[] = [];
      const query = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(async () => rows),
      };
      query.from.mockImplementation((table: unknown) => {
        rows =
          table === siteProjects
            ? [{ id: PROJECT_ID }]
            : table === siteProviderConnections
              ? [currentConnection]
              : table === siteOperations || table === siteDomainOperations
                ? []
                : [];
        return query;
      });
      query.where.mockReturnValue(query);
      return query;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        return {
          where: vi.fn(async () => {
            updateWhere();
            const affectedRows = input.updateAffectedRows ?? 1;
            if (affectedRows === 1) {
              currentConnection = {
                ...currentConnection,
                ...values,
              } as SiteProviderConnection;
            }
            return [{ affectedRows }];
          }),
        };
      }),
    })),
  };
  return {
    db,
    updateValues,
    updateWhere,
    currentConnection: () => currentConnection,
  };
}

function accessDenied() {
  return Object.assign(new Error("access denied"), {
    name: "ResponseError",
    code: "NoPermission",
    statusCode: 403,
  });
}

function providerFactory() {
  const credentials = {
    accessKeyId: "temporary-id",
    accessKeySecret: "temporary-secret",
    securityToken: "temporary-token",
    expiration: null,
    assumedRoleArn: null,
  };
  const domainRead = vi.fn(async () => []);
  const dnsRead = vi.fn(async () => []);
  const factory: AliyunProviderSdkFactory = {
    assumeRole: vi.fn(async (input) => {
      if (input.externalId == null) throw accessDenied();
      return credentials;
    }),
    getCallerAccount: vi.fn(async () => ACCOUNT_UID),
    domain: vi.fn(
      () =>
        ({
          listVerifiedRegistrantProfiles: domainRead,
        }) as never,
    ),
    dns: vi.fn(
      () =>
        ({
          listDomains: dnsRead,
        }) as never,
    ),
  };
  return { credentials, domainRead, dnsRead, factory };
}

describe("Aliyun customer role provisioning and probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
      32,
      68,
    ).toString("base64")}`;
  });

  it("derives a deterministic connection-scoped role name", () => {
    expect(aliyunCustomerRoleName(CONNECTION_ID)).toBe(
      "FrontMindSiteOps-222222222222",
    );
    expect(aliyunCustomerRoleName(SECOND_CONNECTION_ID)).toBe(
      "FrontMindSiteOps-333333333333",
    );
    expect(aliyunCustomerRoleName(CONNECTION_ID)).not.toBe(
      aliyunCustomerRoleName(SECOND_CONNECTION_ID),
    );
  });

  it("moves a missing legacy role to its unique creation name without rotating ExternalId", async () => {
    const connection = customerConnection({ roleArn: LEGACY_ROLE_ARN });
    const database = fakeDb(connection);
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
      Object.assign(new Error("role not found"), {
        code: "EntityNotExist.Role",
        statusCode: 404,
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        {
          projectId: PROJECT_ID,
          userId: USER_ID,
        },
        sdk.factory,
      ),
    ).resolves.toEqual({
      connectionId: CONNECTION_ID,
      accountUid: ACCOUNT_UID,
      roleArn: UNIQUE_ROLE_ARN,
      roleName: "FrontMindSiteOps-222222222222",
      status: "unverified",
      roleChanged: true,
    });
    expect(database.updateValues).toHaveLength(2);
    expect(database.updateValues[0]).toMatchObject({
      status: "unverified",
      lastErrorCode: "ALIYUN_ROLE_NOT_READY",
    });
    expect(database.updateValues[0]).not.toHaveProperty("roleArn");
    expect(database.updateValues[1]).toMatchObject({
      roleArn: UNIQUE_ROLE_ARN,
      status: "unverified",
      lastErrorCode: null,
    });
    expect(database.updateValues[1]).not.toHaveProperty("encryptedExternalId");
    expect(database.updateValues[1]).not.toHaveProperty(
      "externalIdFingerprint",
    );
    expect(database.currentConnection()).toMatchObject({
      roleArn: UNIQUE_ROLE_ARN,
      encryptedExternalId: connection.encryptedExternalId,
      externalIdFingerprint: connection.externalIdFingerprint,
    });
  });

  it("activates a correctly configured legacy role without renaming it", async () => {
    const database = fakeDb(customerConnection({ roleArn: LEGACY_ROLE_ARN }));
    const sdk = providerFactory();
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      connectionId: CONNECTION_ID,
      accountUid: ACCOUNT_UID,
      roleArn: LEGACY_ROLE_ARN,
      roleName: "FrontMindSiteOpsAccess",
      status: "active",
      roleChanged: false,
    });
    expect(database.updateValues).toHaveLength(1);
    expect(database.updateValues[0]).toMatchObject({
      status: "active",
      capabilities: ["sts_assume_role", "domain_read", "alidns_read"],
      lastErrorCode: null,
    });
    expect(database.updateValues[0]).not.toHaveProperty("roleArn");
  });

  it.each([
    [
      "provider retry",
      (sdk: ReturnType<typeof providerFactory>) =>
        vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
          Object.assign(new Error("temporary outage"), {
            code: "ServiceUnavailable",
            statusCode: 503,
          }),
        ),
      "provider_retry",
    ],
    [
      "permission propagation",
      (sdk: ReturnType<typeof providerFactory>) =>
        sdk.domainRead.mockRejectedValueOnce(accessDenied()),
      "permission_propagating",
    ],
    [
      "trust-policy propagation",
      (sdk: ReturnType<typeof providerFactory>) =>
        vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(accessDenied()),
      "permission_propagating",
    ],
  ] as const)(
    "does not rename a legacy role during %s",
    async (_label, arrange, reason) => {
      const database = fakeDb(customerConnection({ roleArn: LEGACY_ROLE_ARN }));
      const sdk = providerFactory();
      arrange(sdk);
      dbMock.getDb.mockResolvedValue(database.db);

      await expect(
        prepareAliyunCustomerRoleProvisioning(
          { projectId: PROJECT_ID, userId: USER_ID },
          sdk.factory,
        ),
      ).rejects.toMatchObject({
        code: ALIYUN_ROLE_MIGRATION_DEFERRED_CODE,
        details: { reason },
      });
      expect(database.updateValues.some((values) => "roleArn" in values)).toBe(
        false,
      );
    },
  );

  it("renames a legacy role after a deterministic permission failure", async () => {
    const database = fakeDb(
      customerConnection({
        roleArn: LEGACY_ROLE_ARN,
        lastErrorCode: "ALIYUN_PERMISSION_PROPAGATING",
        updatedAt: new Date(Date.now() - 3 * 60_000),
      }),
    );
    const sdk = providerFactory();
    sdk.domainRead.mockRejectedValueOnce(accessDenied());
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toMatchObject({
      roleArn: UNIQUE_ROLE_ARN,
      status: "unverified",
      roleChanged: true,
    });
    expect(database.updateValues).toHaveLength(2);
    expect(database.updateValues[0]).toMatchObject({
      status: "invalid",
      lastErrorCode: "ALIYUN_PERMISSION_INCOMPLETE",
    });
    expect(database.updateValues[1]).toMatchObject({
      roleArn: UNIQUE_ROLE_ARN,
      status: "unverified",
      lastErrorCode: null,
    });
  });

  it("advances a bad unique role to a new repair name on every confirmed failure", async () => {
    const connection = customerConnection();
    const database = fakeDb(connection);
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockResolvedValue(sdk.credentials);
    dbMock.getDb.mockResolvedValue(database.db);

    const first = await prepareAliyunCustomerRoleProvisioning(
      { projectId: PROJECT_ID, userId: USER_ID },
      sdk.factory,
    );
    expect(first).toMatchObject({
      status: "unverified",
      roleChanged: true,
    });
    expect(first.roleName).toMatch(/^FrontMindSiteOps-[a-f0-9]{12}$/u);
    expect(first.roleName).not.toBe("FrontMindSiteOps-222222222222");

    const second = await prepareAliyunCustomerRoleProvisioning(
      { projectId: PROJECT_ID, userId: USER_ID },
      sdk.factory,
    );
    expect(second).toMatchObject({
      status: "unverified",
      roleChanged: true,
    });
    expect(second.roleName).toMatch(/^FrontMindSiteOps-[a-f0-9]{12}$/u);
    expect(second.roleName).not.toBe(first.roleName);
    expect(database.currentConnection()).toMatchObject({
      roleArn: second.roleArn,
      encryptedExternalId: connection.encryptedExternalId,
      encryptionIv: connection.encryptionIv,
      encryptionAuthTag: connection.encryptionAuthTag,
      externalIdFingerprint: connection.externalIdFingerprint,
    });
  });

  it("does not rename a legacy role when its caller account mismatches", async () => {
    const database = fakeDb(customerConnection({ roleArn: LEGACY_ROLE_ARN }));
    const sdk = providerFactory();
    vi.mocked(sdk.factory.getCallerAccount).mockResolvedValueOnce(
      "999999999999",
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).rejects.toMatchObject({ code: "CALLER_ACCOUNT_MISMATCH" });
    expect(database.updateValues.some((values) => "roleArn" in values)).toBe(
      false,
    );
  });

  it("keeps an active legacy role unchanged", async () => {
    const database = fakeDb(
      customerConnection({
        roleArn: LEGACY_ROLE_ARN,
        status: "active",
        capabilities: ["sts_assume_role", "domain_read", "alidns_read"],
        verifiedAt: new Date(),
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning({
        projectId: PROJECT_ID,
        userId: USER_ID,
      }),
    ).resolves.toMatchObject({
      roleArn: LEGACY_ROLE_ARN,
      roleName: "FrontMindSiteOpsAccess",
      status: "active",
      roleChanged: false,
    });
    expect(database.updateValues).toHaveLength(0);
  });

  it("activates a correctly configured unique role without renaming it", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toMatchObject({
      roleArn: UNIQUE_ROLE_ARN,
      status: "active",
      roleChanged: false,
    });
    expect(database.updateValues).toHaveLength(1);
    expect(database.updateValues[0]).toMatchObject({ status: "active" });
    expect(database.updateValues[0]).not.toHaveProperty("roleArn");
  });

  it("does not rename a unique role while its permissions are propagating", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    sdk.domainRead.mockRejectedValueOnce(accessDenied());
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).rejects.toMatchObject({
      code: ALIYUN_ROLE_MIGRATION_DEFERRED_CODE,
      details: { reason: "permission_propagating" },
    });
    expect(database.currentConnection().roleArn).toBe(UNIQUE_ROLE_ARN);
    expect(database.updateValues.some((values) => "roleArn" in values)).toBe(
      false,
    );
  });

  it("keeps a missing invalid unique role name and ExternalId for retry", async () => {
    const connection = customerConnection({
      status: "invalid",
      lastErrorCode: "ALIYUN_ROLE_NOT_READY",
    });
    const database = fakeDb(connection);
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
      Object.assign(new Error("role not found"), {
        code: "EntityNotExist.Role",
        statusCode: 404,
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning(
        {
          projectId: PROJECT_ID,
          userId: USER_ID,
        },
        sdk.factory,
      ),
    ).resolves.toMatchObject({
      roleArn: UNIQUE_ROLE_ARN,
      status: "unverified",
      roleChanged: false,
    });
    expect(database.updateValues).toHaveLength(1);
    expect(database.updateValues[0]).toMatchObject({
      status: "unverified",
      lastErrorCode: "ALIYUN_ROLE_NOT_READY",
    });
    expect(database.updateValues[0]).not.toHaveProperty("roleArn");
    expect(database.currentConnection()).toMatchObject({
      encryptedExternalId: connection.encryptedExternalId,
      externalIdFingerprint: connection.externalIdFingerprint,
    });
  });

  it("projects the persisted unique role into the authorization package", async () => {
    const database = fakeDb(customerConnection());
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      getAliyunCustomerRoleAuthorizationPackage({
        projectId: PROJECT_ID,
        userId: USER_ID,
        trustedPrincipalArn: "acs:ram::999999999999:user/frontmind-siteops",
      }),
    ).resolves.toMatchObject({
      roleName: "FrontMindSiteOps-222222222222",
      trustPolicyDocument: {
        Statement: [
          {
            Condition: {
              StringEquals: { "sts:ExternalId": "external-id-for-probe" },
            },
          },
        ],
      },
    });
  });

  it("requires positive AssumeRole, negative ExternalId denial, Domain, and AliDNS before activation", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "active",
      connected: true,
      accountUid: ACCOUNT_UID,
      capabilities: ["sts_assume_role", "domain_read", "alidns_read"],
    });
    expect(sdk.factory.assumeRole).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sdk.factory.assumeRole).mock.calls[0]?.[0]).toMatchObject({
      externalId: "external-id-for-probe",
    });
    expect(
      vi.mocked(sdk.factory.assumeRole).mock.calls[1]?.[0],
    ).not.toHaveProperty("externalId");
    expect(vi.mocked(sdk.factory.assumeRole).mock.calls[2]?.[0]).toMatchObject({
      externalId: "external-id-for-probe",
    });
    expect(sdk.domainRead).toHaveBeenCalledTimes(1);
    expect(sdk.dnsRead).toHaveBeenCalledTimes(1);
    expect(database.updateValues[0]).toMatchObject({
      status: "active",
      capabilities: ["sts_assume_role", "domain_read", "alidns_read"],
      lastErrorCode: null,
    });
  });

  it("invalidates a role that can be assumed without ExternalId", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockResolvedValue(sdk.credentials);
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "attention_required",
      connected: false,
      reason: "external_id_not_enforced",
      retryable: false,
    });
    expect(database.updateValues[0]).toMatchObject({
      status: "invalid",
      capabilities: [],
      verifiedAt: null,
      lastErrorCode: "ALIYUN_EXTERNAL_ID_NOT_ENFORCED",
    });
    expect(sdk.factory.getCallerAccount).not.toHaveBeenCalled();
  });

  it("does not accept an ExternalId parameter error as proof of enforcement", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole)
      .mockResolvedValueOnce(sdk.credentials)
      .mockRejectedValueOnce(
        Object.assign(new Error("invalid ExternalId parameter"), {
          code: "InvalidParameter.ExternalId",
          statusCode: 400,
        }),
      );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "pending",
      connected: false,
      reason: "provider_retry",
      retryAfterMs: 5_000,
    });
    expect(database.updateValues[0]).toMatchObject({
      status: "unverified",
      lastErrorCode: "ALIYUN_PROVIDER_RETRY",
    });
    expect(sdk.factory.getCallerAccount).not.toHaveBeenCalled();
  });

  it("keeps a missing role unverified", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
      Object.assign(new Error("role not found"), {
        code: "EntityNotExist.Role",
        statusCode: 404,
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "pending",
      connected: false,
      reason: "role_not_ready",
      retryAfterMs: 2_000,
    });
    expect(database.updateValues[0]).toMatchObject({
      status: "unverified",
      lastErrorCode: "ALIYUN_ROLE_NOT_READY",
    });
  });

  it("does not churn the row while the same pending reason repeats", async () => {
    const database = fakeDb(
      customerConnection({ lastErrorCode: "ALIYUN_ROLE_NOT_READY" }),
    );
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
      Object.assign(new Error("role not found"), {
        code: "EntityNotExist.Role",
        statusCode: 404,
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toMatchObject({
      status: "pending",
      reason: "role_not_ready",
    });
    expect(database.updateValues).toHaveLength(0);
  });

  it.each([
    ["rate limit", { code: "Throttling.User", statusCode: 429 }],
    ["provider 5xx", { code: "ServiceUnavailable", statusCode: 503 }],
    ["network timeout", { code: "ETIMEDOUT" }],
  ])("keeps an unverified connection pending on %s", async (_label, shape) => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
      Object.assign(new Error("temporary provider failure"), shape),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "pending",
      connected: false,
      reason: "provider_retry",
      retryAfterMs: 5_000,
    });
    expect(database.updateValues[0]).toMatchObject({
      status: "unverified",
      lastErrorCode: "ALIYUN_PROVIDER_RETRY",
    });
  });

  it("allows permission propagation, then marks a persistent denial incomplete", async () => {
    const freshDatabase = fakeDb(customerConnection());
    const freshSdk = providerFactory();
    freshSdk.domainRead.mockRejectedValueOnce(accessDenied());
    dbMock.getDb.mockResolvedValueOnce(freshDatabase.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        freshSdk.factory,
      ),
    ).resolves.toMatchObject({
      status: "pending",
      reason: "permission_propagating",
    });
    expect(freshDatabase.updateValues[0]).toMatchObject({
      status: "unverified",
      lastErrorCode: "ALIYUN_PERMISSION_PROPAGATING",
    });

    const staleDatabase = fakeDb(
      customerConnection({
        lastErrorCode: "ALIYUN_PERMISSION_PROPAGATING",
        updatedAt: new Date(Date.now() - 3 * 60_000),
      }),
    );
    const staleSdk = providerFactory();
    staleSdk.domainRead.mockRejectedValueOnce(accessDenied());
    dbMock.getDb.mockResolvedValueOnce(staleDatabase.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        staleSdk.factory,
      ),
    ).resolves.toEqual({
      status: "attention_required",
      connected: false,
      reason: "permission_incomplete",
      retryable: false,
    });
    expect(staleDatabase.updateValues[0]).toMatchObject({
      status: "invalid",
      lastErrorCode: "ALIYUN_PERMISSION_INCOMPLETE",
    });
  });

  it("keeps an active connection active during a transient provider failure", async () => {
    const originalCapabilities = [
      "sts_assume_role",
      "domain_read",
      "alidns_read",
    ];
    const verifiedAt = new Date("2026-08-25T00:00:00.000Z");
    const database = fakeDb(
      customerConnection({
        status: "active",
        capabilities: originalCapabilities,
        verifiedAt,
      }),
    );
    const sdk = providerFactory();
    vi.mocked(sdk.factory.assumeRole).mockRejectedValueOnce(
      Object.assign(new Error("throttled"), {
        code: "Throttling.User",
        statusCode: 429,
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "pending",
      connected: false,
      reason: "provider_retry",
      retryAfterMs: 5_000,
    });
    expect(database.updateValues[0]).toMatchObject({
      status: "active",
      capabilities: originalCapabilities,
      verifiedAt,
      lastErrorCode: "ALIYUN_PROVIDER_RETRY",
    });
  });

  it("invalidates a deterministic account mismatch", async () => {
    const database = fakeDb(customerConnection());
    const sdk = providerFactory();
    vi.mocked(sdk.factory.getCallerAccount).mockResolvedValueOnce(
      "999999999999",
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).resolves.toEqual({
      status: "attention_required",
      connected: false,
      reason: "account_mismatch",
      retryable: false,
    });
    expect(database.updateValues[0]).toMatchObject({
      status: "invalid",
      capabilities: [],
      lastErrorCode: "CALLER_ACCOUNT_MISMATCH",
    });
  });

  it("does not confuse a provisioning CAS race with a provider result", async () => {
    const database = fakeDb(customerConnection(), { updateAffectedRows: 0 });
    const sdk = providerFactory();
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      probeAliyunCustomerConnection(
        { projectId: PROJECT_ID, userId: USER_ID },
        sdk.factory,
      ),
    ).rejects.toMatchObject({
      code: "ALIYUN_CONNECTION_CHANGED",
    });
  });

  it.each([
    "customer-managed-role",
    "FrontMindSiteOps-ABCDEF123456",
    "FrontMindSiteOps-1234567890123",
  ])("rejects unmanaged or malformed role name %s", async (roleName) => {
    const database = fakeDb(
      customerConnection({
        roleArn: `acs:ram::${ACCOUNT_UID}:role/${roleName}`,
      }),
    );
    dbMock.getDb.mockResolvedValue(database.db);

    await expect(
      prepareAliyunCustomerRoleProvisioning({
        projectId: PROJECT_ID,
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(AliyunProviderError);
    expect(database.updateValues).toHaveLength(0);
  });
});
