import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  siteProjects,
  siteProviderConnections,
  type SiteDnsRecord,
} from "../../drizzle/schema";
import {
  aliyunDnsExpectedRecordsHash,
  aliyunCustomerRoleName,
  aliyunFinancialSessionPolicy,
  assertAliyunDnsTargetCurrent,
  assertAliyunRenewalTarget,
  bindAliyunCustomerAccountFromOAuth,
  bindAliyunDnsPlan,
  classifyAliyunFinancialReconciliation,
  executeAliyunFinancialMutation,
  openAliyunExternalId,
  planAliyunDnsRecords,
  prepareAliyunDomainQuote,
  projectExistingAliyunDomainState,
  readExistingAliyunDomainFromOwnedAccount,
  sealAliyunExternalId,
  type AliyunDomainApi,
  type AliyunDomainCheck,
  type AliyunDomainDetails,
  type AliyunRegistrantProfile,
} from "./aliyun-provider";

function verifiedProfile(): AliyunRegistrantProfile {
  return {
    profileId: "123456",
    holderType: "enterprise",
    maskedName: "北**司",
    realNameVerified: true,
    emailVerified: true,
    isDefault: true,
  };
}

function domainCheck(amountMinor = 8_800): AliyunDomainCheck {
  return {
    domain: "example.com",
    available: true,
    availabilityCode: "1",
    premium: false,
    amountMinor,
    currency: "CNY",
    reason: null,
    requestId: "request-1",
  };
}

function domainDetails(): AliyunDomainDetails {
  return {
    domain: "example.com",
    instanceId: "instance-1",
    expirationDateMs: Date.UTC(2027, 7, 22),
    realNameStatus: "SUCCEED",
    emailStatus: "1",
    clientHold: false,
    autoRenewEnabled: false,
  };
}

function fakeDomainApi(
  overrides: Partial<AliyunDomainApi> = {},
): AliyunDomainApi {
  return {
    checkDomain: vi.fn(async () => domainCheck()),
    listVerifiedRegistrantProfiles: vi.fn(async () => [verifiedProfile()]),
    getDomain: vi.fn(async () => domainDetails()),
    submitPurchase: vi.fn(async () => ({
      taskNo: "task-purchase",
      requestId: "request-purchase",
    })),
    submitRenewal: vi.fn(async () => ({
      taskNo: "task-renewal",
      requestId: "request-renewal",
    })),
    setAutoRenew: vi.fn(async () => ({ ok: true, requestId: "request-auto" })),
    getTask: vi.fn(async (taskNo, domain) => ({
      taskNo,
      state: "pending",
      domain,
      taskType: "purchase",
      message: null,
      instanceId: null,
    })),
    findTaskCandidates: vi.fn(async () => []),
    ...overrides,
  };
}

function expectedDnsRecord(
  overrides: Partial<SiteDnsRecord> = {},
): SiteDnsRecord {
  const now = new Date();
  return {
    id: "record-row-1",
    projectId: "project-1",
    userId: 1,
    domainOperationId: null,
    domainAscii: "example.com",
    domainRevision: 2,
    recordType: "CNAME",
    rr: "www",
    expectedValue: "edge.example.net",
    expectedTtl: 600,
    beforeValue: null,
    beforeTtl: null,
    observedValue: null,
    observedTtl: null,
    providerRecordId: null,
    remarkMarker: "frontmind:project-1:2",
    status: "planned",
    verifiedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Aliyun SiteOps provider", () => {
  const originalEncryptionKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
      32,
      61,
    ).toString("base64")}`;
  });

  afterEach(() => {
    if (originalEncryptionKey == null) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  it("binds encrypted ExternalId to the connection-specific AAD", () => {
    const sealed = sealAliyunExternalId(
      "11111111-1111-4111-8111-111111111111",
      "external-id-1",
    );
    expect(
      openAliyunExternalId({
        id: "11111111-1111-4111-8111-111111111111",
        ...sealed,
      }),
    ).toBe("external-id-1");
    expect(() =>
      openAliyunExternalId({
        id: "22222222-2222-4222-8222-222222222222",
        ...sealed,
      }),
    ).toThrow();
  });

  it("binds an OAuth account through the caller transaction executor", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const insertedValues: unknown[] = [];
    const select = vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rows =
          table === siteProjects
            ? [{ id: projectId }]
            : table === siteProviderConnections
              ? []
              : [];
        const query = {
          where: vi.fn(() => query),
          limit: vi.fn(async () => rows),
        };
        return query;
      }),
    }));
    const insert = vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        insertedValues.push(values);
      }),
    }));
    const transaction = {
      select,
      insert,
      update: vi.fn(),
    };

    const binding = await bindAliyunCustomerAccountFromOAuth(
      {
        projectId,
        userId: 42,
        accountUid: "1234567890123456",
      },
      transaction as never,
    );
    expect(binding).toMatchObject({
      status: "unverified",
      requiresRoleAuthorization: true,
    });

    expect(select).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith(siteProviderConnections);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      projectId,
      userId: 42,
      provider: "aliyun_cn",
      accountUid: "1234567890123456",
      roleArn: `acs:ram::1234567890123456:role/${aliyunCustomerRoleName(binding.connectionId)}`,
      capabilities: [],
      status: "unverified",
    });
  });

  it("changes the exact quote hash when the provider price changes", async () => {
    let amount = 8_800;
    const api = fakeDomainApi({
      checkDomain: vi.fn(async () => domainCheck(amount)),
    });
    const first = await prepareAliyunDomainQuote({
      api,
      kind: "purchase",
      domain: "Example.COM",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });
    amount = 9_900;
    const fresh = await prepareAliyunDomainQuote({
      api,
      kind: "purchase",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:20.000Z"),
    });
    expect(first.amountMinor).toBe(8_800);
    expect(fresh.amountMinor).toBe(9_900);
    expect(fresh.quoteHash).not.toBe(first.quoteHash);
  });

  it("uses account-scoped domain details, never availability, to prove an existing domain", async () => {
    const checkDomain = vi.fn(async () => domainCheck());
    const getDomain = vi.fn(async () => domainDetails());
    const api = fakeDomainApi({ checkDomain, getDomain });

    await expect(
      readExistingAliyunDomainFromOwnedAccount(api, "Example.COM"),
    ).resolves.toMatchObject({
      domain: "example.com",
      instanceId: "instance-1",
    });
    expect(getDomain).toHaveBeenCalledWith("example.com");
    expect(checkDomain).not.toHaveBeenCalled();

    await expect(
      readExistingAliyunDomainFromOwnedAccount(
        fakeDomainApi({ getDomain: vi.fn(async () => null) }),
        "example.com",
      ),
    ).rejects.toMatchObject({ code: "DOMAIN_NOT_OWNED" });
  });

  it("bumps revision and clears ICP only when an existing-domain sync changes hostname", () => {
    const current = {
      domain: "old.example.com",
      normalizedAsciiDomain: "old.example.com",
      domainRevision: 4,
      revision: 8,
      icpStatus: "approved" as const,
      icpNumber: "京ICP备12345678号",
      icpDomainRevision: 4,
      icpVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      autoRenewDesired: true,
      dnsStatus: "active",
    };
    const now = new Date("2026-08-22T00:00:00.000Z");
    const switched = projectExistingAliyunDomainState({
      current,
      requestedDomain: "example.com",
      accountUid: "123456789012",
      details: domainDetails(),
      now,
    });
    expect(switched.switchingDomain).toBe(true);
    expect(switched.nextDomainRevision).toBe(5);
    expect(switched.values).toMatchObject({
      normalizedAsciiDomain: "example.com",
      providerAccountUid: "123456789012",
      domainRevision: 5,
      icpStatus: "not_submitted",
      icpNumber: null,
      icpDomainRevision: null,
      icpVerifiedAt: null,
      dnsStatus: "pending",
      autoRenewDesired: false,
      autoRenewObserved: false,
    });

    const same = projectExistingAliyunDomainState({
      current: {
        ...current,
        domain: "example.com",
        normalizedAsciiDomain: "EXAMPLE.COM",
      },
      requestedDomain: "example.com",
      accountUid: "123456789012",
      details: { ...domainDetails(), autoRenewEnabled: true },
      now,
    });
    expect(same.switchingDomain).toBe(false);
    expect(same.nextDomainRevision).toBe(4);
    expect(same.values).not.toHaveProperty("icpStatus");
    expect(same.values).not.toHaveProperty("icpNumber");
    expect(same.values).not.toHaveProperty("dnsStatus");
    expect(same.values.autoRenewObserved).toBe(true);
  });

  it("requires an explicit eligible registrant profile when several exist", async () => {
    const second = {
      ...verifiedProfile(),
      profileId: "654321",
      maskedName: "上**司",
      isDefault: false,
    };
    const api = fakeDomainApi({
      listVerifiedRegistrantProfiles: vi.fn(async () => [
        { ...verifiedProfile(), isDefault: false },
        second,
      ]),
    });
    await expect(
      prepareAliyunDomainQuote({
        api,
        kind: "purchase",
        domain: "example.com",
        accountUid: "123456789012",
        years: 1,
      }),
    ).rejects.toMatchObject({
      code: "REGISTRANT_PROFILE_SELECTION_REQUIRED",
      details: {
        availableRegistrantProfiles: expect.arrayContaining([
          expect.objectContaining({ profileId: "123456" }),
          expect.objectContaining({ profileId: "654321" }),
        ]),
      },
    });
    const selected = await prepareAliyunDomainQuote({
      api,
      kind: "purchase",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      registrantProfileId: "654321",
    });
    expect(selected.registrantProfileId).toBe("654321");
    expect(selected.maskedRegistrantName).toBe("上**司");
  });

  it("never resubmits a purchase after a response-loss attempt", async () => {
    const submitPurchase = vi.fn(async () => {
      throw new Error("socket closed after write");
    });
    const findTaskCandidates = vi.fn(async () => []);
    const api = fakeDomainApi({ submitPurchase, findTaskCandidates });
    const quote = await prepareAliyunDomainQuote({
      api,
      kind: "purchase",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });
    const first = await executeAliyunFinancialMutation({
      api,
      quote,
      mutationAttempted: false,
      operationCreatedAt: new Date("2026-08-22T00:00:10.000Z"),
      now: new Date("2026-08-22T00:00:20.000Z"),
      beforeMutation: vi.fn(async () => undefined),
    });
    expect(first.status).toBe("pending");
    expect(submitPurchase).toHaveBeenCalledTimes(1);

    const second = await executeAliyunFinancialMutation({
      api,
      quote,
      mutationAttempted: true,
      operationCreatedAt: new Date("2026-08-22T00:00:10.000Z"),
      now: new Date("2026-08-22T00:00:30.000Z"),
    });
    expect(second.status).toBe("pending");
    expect(submitPurchase).toHaveBeenCalledTimes(1);
    expect(findTaskCandidates).toHaveBeenCalledTimes(2);
  });

  it("keeps account ownership lookup in paid purchase and renewal sessions", () => {
    for (const kind of ["purchase", "renewal"] as const) {
      const policy = JSON.parse(aliyunFinancialSessionPolicy(kind)) as {
        Statement: Array<{ Action: string[] }>;
      };
      expect(policy.Statement[0]?.Action).toEqual(
        expect.arrayContaining([
          "domain:QueryDomain",
          "domain:QueryCommonInfo",
        ]),
      );
      expect(policy.Statement[0]?.Action).not.toContain(
        "sts:GetCallerIdentity",
      );
    }
  });

  it("verifies customer ownership after a paid purchase task succeeds", async () => {
    const getDomain = vi.fn(async () => domainDetails());
    const api = fakeDomainApi({
      getDomain,
      getTask: vi.fn(async (taskNo, domain) => ({
        taskNo,
        state: "succeeded",
        domain,
        taskType: "purchase",
        message: null,
        instanceId: "instance-1",
      })),
    });
    const quote = await prepareAliyunDomainQuote({
      api,
      kind: "purchase",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });

    await expect(
      executeAliyunFinancialMutation({
        api,
        quote,
        providerTaskNo: "task-purchase",
        mutationAttempted: true,
        operationCreatedAt: new Date("2026-08-22T00:00:10.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        domain: "example.com",
        instanceId: "instance-1",
      },
    });
    expect(getDomain).toHaveBeenCalledWith("example.com");
  });

  it("treats an explicitly failed provider task as terminal without submitting again", async () => {
    const submitPurchase = vi.fn();
    const getDomain = vi.fn(async () => domainDetails());
    const api = fakeDomainApi({
      submitPurchase,
      getDomain,
      getTask: vi.fn(async () => ({
        taskNo: "task-failed",
        state: "failed" as const,
        domain: "example.com",
        taskType: "purchase" as const,
        message: "provider rejected the order",
        instanceId: null,
      })),
    });
    const quote = await prepareAliyunDomainQuote({
      api,
      kind: "purchase",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });

    await expect(
      executeAliyunFinancialMutation({
        api,
        quote,
        providerTaskNo: "task-failed",
        mutationAttempted: true,
        operationCreatedAt: new Date("2026-08-22T00:00:10.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "ALIYUN_DOMAIN_TASK_FAILED",
      providerTaskId: "task-failed",
      result: { mutationAttempted: true },
    });
    expect(submitPurchase).not.toHaveBeenCalled();
    expect(getDomain).not.toHaveBeenCalled();
  });

  it("verifies the exact expiration extension after a paid renewal succeeds", async () => {
    const currentExpirationDateMs = Date.UTC(2027, 7, 22);
    const renewedExpirationDateMs = Date.UTC(2028, 7, 22);
    const getDomain = vi
      .fn<AliyunDomainApi["getDomain"]>()
      .mockResolvedValueOnce({
        ...domainDetails(),
        expirationDateMs: currentExpirationDateMs,
      })
      .mockResolvedValueOnce({
        ...domainDetails(),
        expirationDateMs: renewedExpirationDateMs,
      });
    const api = fakeDomainApi({
      getDomain,
      getTask: vi.fn(async (taskNo, domain) => ({
        taskNo,
        state: "succeeded",
        domain,
        taskType: "renewal",
        message: null,
        instanceId: "instance-1",
      })),
    });
    const quote = await prepareAliyunDomainQuote({
      api,
      kind: "renewal",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });

    await expect(
      executeAliyunFinancialMutation({
        api,
        quote,
        providerTaskNo: "task-renewal",
        mutationAttempted: true,
        operationCreatedAt: new Date("2026-08-22T00:00:10.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: { expirationDateMs: renewedExpirationDateMs },
    });
    expect(getDomain).toHaveBeenCalledTimes(2);
  });

  it("marks a completed renewal mismatch as an attempted financial mutation", async () => {
    const current = domainDetails();
    const getDomain = vi.fn(async () => current);
    const api = fakeDomainApi({
      getDomain,
      getTask: vi.fn(async (taskNo, domain) => ({
        taskNo,
        state: "succeeded",
        domain,
        taskType: "renewal",
        message: null,
        instanceId: current.instanceId,
      })),
    });
    const quote = await prepareAliyunDomainQuote({
      api,
      kind: "renewal",
      domain: "example.com",
      accountUid: "123456789012",
      years: 1,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });

    await expect(
      executeAliyunFinancialMutation({
        api,
        quote,
        providerTaskNo: "task-renewal",
        mutationAttempted: true,
        operationCreatedAt: new Date("2026-08-22T00:00:10.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "RENEWAL_EXPIRATION_MISMATCH",
      result: { mutationAttempted: true },
    });
  });

  it("freezes renewal to the exact current hostname and domain revision", () => {
    expect(() =>
      assertAliyunRenewalTarget({
        current: {
          normalizedAsciiDomain: "example.com",
          domainRevision: 4,
        },
        quoteDomain: "example.com",
        expectedCanonicalHostname: "example.com",
        expectedDomainRevision: 4,
        mutationAttempted: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertAliyunRenewalTarget({
        current: {
          normalizedAsciiDomain: "new.example.com",
          domainRevision: 5,
        },
        quoteDomain: "example.com",
        expectedCanonicalHostname: "example.com",
        expectedDomainRevision: 4,
        mutationAttempted: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "RENEWAL_DOMAIN_REVISION_CHANGED",
        details: { mutationAttempted: true },
      }),
    );
  });

  it("only requeues the exact unresolved financial reservation with mutation evidence", () => {
    const operation = {
      id: "operation-1",
      projectId: "project-1",
      userId: 7,
      kind: "domain_purchase" as const,
      status: "attention_required" as const,
      provider: "aliyun_domain",
      providerTaskId: null,
      result: { mutationAttempted: true },
    };
    const ledger = {
      operationId: "operation-1",
      projectId: "project-1",
      userId: 7,
      kind: "purchase" as const,
      status: "attention_required" as const,
      activeFinancialKey: "financial-key",
      providerTaskNo: null,
      providerResult: { mutationAttempted: true },
    };

    expect(
      classifyAliyunFinancialReconciliation({ operation, ledger }),
    ).toEqual({ action: "requeue" });
    expect(() =>
      classifyAliyunFinancialReconciliation({
        operation,
        ledger: { ...ledger, userId: 8 },
      }),
    ).toThrowError(expect.objectContaining({ code: "DOMAIN_LEDGER_MISMATCH" }));
    expect(() =>
      classifyAliyunFinancialReconciliation({
        operation: { ...operation, result: null },
        ledger: { ...ledger, providerResult: null },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "FINANCIAL_RECONCILIATION_NOT_ALLOWED",
      }),
    );
  });

  it("makes financial reconciliation idempotent while queued and after a verified terminal result", () => {
    const commonOperation = {
      id: "operation-1",
      projectId: "project-1",
      userId: 7,
      kind: "domain_renewal" as const,
      provider: "aliyun_domain",
      providerTaskId: "task-1",
      result: { mutationAttempted: true },
    };
    const commonLedger = {
      operationId: "operation-1",
      projectId: "project-1",
      userId: 7,
      kind: "renewal" as const,
      providerTaskNo: "task-1",
      providerResult: { mutationAttempted: true },
    };

    expect(
      classifyAliyunFinancialReconciliation({
        operation: { ...commonOperation, status: "queued" as const },
        ledger: {
          ...commonLedger,
          status: "attention_required" as const,
          activeFinancialKey: "financial-key",
        },
      }),
    ).toEqual({ action: "already_pending" });
    expect(
      classifyAliyunFinancialReconciliation({
        operation: { ...commonOperation, status: "succeeded" as const },
        ledger: {
          ...commonLedger,
          status: "succeeded" as const,
          activeFinancialKey: null,
        },
      }),
    ).toEqual({ action: "terminal", status: "succeeded" });
  });

  it("rejects a queued DNS write after the current hostname or domain revision changes", () => {
    const active = {
      normalizedAsciiDomain: "example.com",
      domainRevision: 2,
      domainStatus: "completed" as const,
      domainOwnershipStatus: "verified",
    };
    expect(() =>
      assertAliyunDnsTargetCurrent(active, {
        domain: "EXAMPLE.com",
        revision: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertAliyunDnsTargetCurrent(active, {
        domain: "new.example.com",
        revision: 3,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "DNS_DOMAIN_REVISION_STALE" }),
    );
    expect(() =>
      assertAliyunDnsTargetCurrent(
        { ...active, domainOwnershipStatus: "pending" },
        { domain: "example.com", revision: 2 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "DNS_DOMAIN_REVISION_STALE" }),
    );
  });

  it("freezes desired DNS tuples independently from provider reconciliation state", () => {
    const expected = expectedDnsRecord();
    const applyHash = aliyunDnsExpectedRecordsHash({
      mode: "apply",
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      records: [expected],
    });
    const reconciledHash = aliyunDnsExpectedRecordsHash({
      mode: "apply",
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      records: [
        {
          ...expected,
          providerRecordId: "record-created-after-apply",
          beforeValue: "customer-before.example.net",
          beforeTtl: 300,
          observedValue: expected.expectedValue,
          observedTtl: expected.expectedTtl,
          status: "propagating",
        },
      ],
    });
    const driftedHash = aliyunDnsExpectedRecordsHash({
      mode: "apply",
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      records: [{ ...expected, expectedValue: "silently-changed.example.net" }],
    });
    expect(reconciledHash).toBe(applyHash);
    expect(driftedHash).not.toBe(applyHash);

    const rollbackHash = aliyunDnsExpectedRecordsHash({
      mode: "rollback",
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      records: [
        {
          ...expected,
          providerRecordId: "frontmind-record",
          beforeValue: "customer-before.example.net",
          beforeTtl: 300,
        },
      ],
    });
    const rollbackDriftedHash = aliyunDnsExpectedRecordsHash({
      mode: "rollback",
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      records: [
        {
          ...expected,
          providerRecordId: "different-record",
          beforeValue: "customer-before.example.net",
          beforeTtl: 300,
        },
      ],
    });
    expect(rollbackDriftedHash).not.toBe(rollbackHash);
  });

  it("reports a foreign same-RR/type record as conflict", () => {
    const plan = planAliyunDnsRecords(
      [expectedDnsRecord()],
      [
        {
          recordId: "customer-record",
          rr: "www",
          type: "CNAME",
          value: "customer.example.net",
          ttl: 600,
          remark: "managed-by-customer",
        },
      ],
    );
    expect(plan).toEqual([
      expect.objectContaining({
        action: "conflict",
        reason: expect.stringContaining("非 FrontMind"),
      }),
    ]);
  });

  it("does not issue a second DNS update after an unknown result", () => {
    const expected = expectedDnsRecord({
      providerRecordId: "frontmind-record",
      status: "outcome_unknown",
    });
    const plan = planAliyunDnsRecords(
      [expected],
      [
        {
          recordId: "frontmind-record",
          rr: "www",
          type: "CNAME",
          value: "old-edge.example.net",
          ttl: 600,
          remark: expected.remarkMarker,
        },
      ],
    );
    expect(plan[0]).toEqual(
      expect.objectContaining({
        action: "unknown",
        reason: expect.stringContaining("拒绝自动再次"),
      }),
    );
  });

  it("treats a crash after DNS reservation as unknown instead of creating", () => {
    const plan = planAliyunDnsRecords(
      [expectedDnsRecord({ status: "applying" })],
      [],
    );
    expect(plan[0]).toEqual(
      expect.objectContaining({
        action: "unknown",
        reason: expect.stringContaining("拒绝重复新增"),
      }),
    );
  });

  it("refuses to delete a FrontMind record that the customer later changed", () => {
    const expected = expectedDnsRecord({
      providerRecordId: "frontmind-record",
      beforeValue: null,
    });
    const plan = planAliyunDnsRecords(
      [expected],
      [
        {
          recordId: "frontmind-record",
          rr: "www",
          type: "CNAME",
          value: "customer-changed.example.net",
          ttl: 600,
          remark: expected.remarkMarker,
        },
      ],
      "rollback",
    );
    expect(plan[0]).toEqual(
      expect.objectContaining({
        action: "conflict",
        reason: expect.stringContaining("客户后续修改"),
      }),
    );
  });

  it("binds a DNS plan to the exact expected tuple and provider snapshot", () => {
    const expected = expectedDnsRecord();
    const initial = planAliyunDnsRecords([expected], []);
    const bound = bindAliyunDnsPlan({
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      expectedRecords: [expected],
      plan: initial,
    });
    const repeated = bindAliyunDnsPlan({
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      expectedRecords: [expected],
      plan: initial,
    });
    const driftedPlan = planAliyunDnsRecords(
      [expected],
      [
        {
          recordId: "customer-record",
          rr: expected.rr,
          type: expected.recordType,
          value: "customer.example.net",
          ttl: expected.expectedTtl,
          remark: null,
        },
      ],
    );
    const drifted = bindAliyunDnsPlan({
      domain: expected.domainAscii,
      revision: expected.domainRevision,
      expectedRecords: [expected],
      plan: driftedPlan,
    });

    expect(bound).toEqual(repeated);
    expect(bound.canApply).toBe(true);
    expect(bound.items[0]).toEqual(
      expect.objectContaining({
        action: "create",
        rr: expected.rr,
        expectedValue: expected.expectedValue,
      }),
    );
    expect(drifted.canApply).toBe(false);
    expect(drifted.providerSnapshotHash).not.toBe(bound.providerSnapshotHash);
    expect(drifted.planHash).not.toBe(bound.planHash);
  });
});
