import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSiteOpsDeploymentTargetAvailable,
  assertSiteOpsSnapshotChangeState,
  hashSiteOpsRequest,
  isSiteOpsOperationReplay,
  isSiteOpsIcpApprovedForCurrentDomain,
  normalizeSiteOpsDomain,
  parseSiteOpsActionPayload,
  resolvePinnedTwentyFirstCredentialForBatch,
  siteBriefFromSnapshot,
  siteOpsActiveFinancialIntentKey,
  SiteOpsServiceError,
} from "./service";
import {
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsAliyunConnectionSetupInputSchema,
  siteOpsSendMessageInputSchema,
} from "../../shared/siteops";

describe("SiteOps core contracts", () => {
  it("hashes canonical object keys while preserving meaningful array order", () => {
    expect(hashSiteOpsRequest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashSiteOpsRequest({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashSiteOpsRequest({ items: ["A", "B"] })).not.toBe(
      hashSiteOpsRequest({ items: ["B", "A"] }),
    );
  });

  it("replays the same operation before reserving quota and rejects key reuse", () => {
    const requestHash = hashSiteOpsRequest({ action: "create_wechat_package" });
    expect(
      isSiteOpsOperationReplay({ inputHash: requestHash }, requestHash),
    ).toBe(true);
    expect(() =>
      isSiteOpsOperationReplay(
        { inputHash: requestHash },
        hashSiteOpsRequest({ action: "create_xiaohongshu_package" }),
      ),
    ).toThrow("该请求标识已用于不同操作");
    expect(isSiteOpsOperationReplay(null, requestHash)).toBe(false);
  });

  it("normalizes an IDN to its lower-case ASCII identity", () => {
    const domain = normalizeSiteOpsDomain("例子.公司.");
    expect(domain.domain).toBe("xn--fsqu00a.xn--55qx5d");
    expect(domain.domainUnicode).toBe("例子.公司");
  });

  it("deduplicates active financial intents across client request ids", () => {
    const base = {
      projectId: "30000000-0000-4000-8000-000000000003",
      accountUid: "123456789012",
      domain: "example.com",
      kind: "purchase" as const,
    };
    expect(siteOpsActiveFinancialIntentKey(base)).toBe(
      siteOpsActiveFinancialIntentKey({ ...base, domain: "EXAMPLE.COM" }),
    );
    expect(siteOpsActiveFinancialIntentKey(base)).not.toBe(
      siteOpsActiveFinancialIntentKey({ ...base, kind: "renewal" }),
    );
    expect(siteOpsActiveFinancialIntentKey(base)).not.toBe(
      siteOpsActiveFinancialIntentKey({
        ...base,
        accountUid: "123456789013",
      }),
    );
  });

  it("accepts ICP approval only for the exact current domain revision", () => {
    const profile = {
      icpStatus: "approved",
      icpNumber: "京ICP备12345678号",
      icpDomainRevision: 6,
      domainRevision: 6,
    };
    expect(isSiteOpsIcpApprovedForCurrentDomain(profile)).toBe(true);
    expect(
      isSiteOpsIcpApprovedForCurrentDomain({ ...profile, domainRevision: 7 }),
    ).toBe(false);
    expect(
      isSiteOpsIcpApprovedForCurrentDomain({
        ...profile,
        icpStatus: "not_required",
      }),
    ).toBe(false);
  });

  it("builds a sourced brief from dashboard-core customer-confirmed leaves", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "维他健康-knowledge-base.zip",
      documents: [
        {
          id: "1.1",
          path: "企业概览/公司简介.md",
          title: "企业概览",
          content: "公司名称：维他健康\n\n面向关注健康管理的企业客户。",
          kind: "leaf",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
        {
          id: "inferred-1",
          path: "推断.md",
          title: "推断内容",
          content: "不存在的客户案例",
          kind: "leaf",
          evidenceStatus: "inferred",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.companyName).toBe("维他健康");
    expect(brief.routes[0]?.sourceDocumentIds).toContain("1.1");
    expect(brief.verifiedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceDocumentIds: ["1.1"] }),
      ]),
    );
    expect(JSON.stringify(brief)).not.toContain("不存在的客户案例");
  });

  it.each(["localhost", "127.0.0.1", "bad domain.com", "-bad.example"])(
    "rejects a non-registrable or unsafe domain: %s",
    (domain) => {
      expect(() => normalizeSiteOpsDomain(domain)).toThrow(SiteOpsServiceError);
    },
  );

  it("keeps message and structured-action inputs strict", () => {
    const message = {
      conversationId: "siteops:7",
      clientRequestId: "request-0001",
      text: "请突出企业服务能力",
      localAssetIds: [],
      expectedProjectRevision: 1,
    };
    expect(siteOpsSendMessageInputSchema.parse(message)).toEqual(message);
    expect(() =>
      siteOpsSendMessageInputSchema.parse({ ...message, apiKey: "secret" }),
    ).toThrow();

    expect(() =>
      siteOpsActInputSchema.parse({
        conversationId: "siteops:7",
        action: "pay_from_free_text",
        clientRequestId: "request-0002",
        expectedRevision: 1,
        input: {},
      }),
    ).toThrow();
  });

  it("keeps existing-domain sync read-only and exact-confirmation shaped", () => {
    expect(
      parseSiteOpsActionPayload("domain_sync", {
        domain: "例子.公司",
        typedDomain: "例子.公司",
        customerConfirmed: true,
      }),
    ).toEqual({
      domain: "xn--fsqu00a.xn--55qx5d",
      domainUnicode: "例子.公司",
      typedDomain: "xn--fsqu00a.xn--55qx5d",
      customerConfirmed: true,
    });
    expect(() =>
      parseSiteOpsActionPayload("domain_sync", {
        domain: "example.com",
        typedDomain: "other.example.com",
        customerConfirmed: true,
      }),
    ).toThrow("必须完整输入");
    expect(() =>
      parseSiteOpsActionPayload("domain_sync", {
        domain: "example.com",
        typedDomain: "example.com",
        customerConfirmed: true,
        accessKeySecret: "must-not-be-accepted",
      }),
    ).toThrow();
  });

  it("admits a knowledge-source change only without active build work", () => {
    expect(() =>
      assertSiteOpsSnapshotChangeState({
        sameSnapshot: false,
        activeBuild: false,
        activeDeployment: false,
        activeVisualSearch: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertSiteOpsSnapshotChangeState({
        sameSnapshot: false,
        activeBuild: true,
        activeDeployment: false,
        activeVisualSearch: false,
      }),
    ).toThrow("任务在运行");
    expect(() =>
      assertSiteOpsSnapshotChangeState({
        sameSnapshot: true,
        activeBuild: false,
        activeDeployment: false,
        activeVisualSearch: false,
      }),
    ).toThrow("已经是当前版本");
    expect(
      parseSiteOpsActionPayload("change_snapshot", {
        knowledgeSnapshotId: "30000000-0000-4000-8000-000000000003",
      }),
    ).toEqual({
      knowledgeSnapshotId: "30000000-0000-4000-8000-000000000003",
    });
  });

  it("keeps the customer RAM Role boundary strict", () => {
    expect(
      siteOpsAliyunConnectionSetupInputSchema.parse({
        conversationId: "siteops:7",
        accountUid: "123456789012",
        roleArn: "acs:ram::123456789012:role/frontmind-siteops",
      }),
    ).toEqual({
      conversationId: "siteops:7",
      accountUid: "123456789012",
      roleArn: "acs:ram::123456789012:role/frontmind-siteops",
    });
    expect(() =>
      siteOpsAliyunConnectionSetupInputSchema.parse({
        conversationId: "siteops:7",
        accountUid: "123456789012",
        roleArn: "acs:ram::123456789012:role/frontmind-siteops",
        accessKeySecret: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(
      siteOpsAliyunConnectionInputSchema.parse({ conversationId: "siteops:7" }),
    ).toEqual({ conversationId: "siteops:7" });
  });

  it("pins a selected board to its original 21st credential after rotation or deletion", async () => {
    const visualOperationId = "10000000-0000-4000-8000-000000000001";
    const pinnedCredentialId = "20000000-0000-4000-8000-000000000002";
    const snapshotId = "30000000-0000-4000-8000-000000000003";
    const results = [
      [
        {
          input: {
            knowledgeSnapshotId: snapshotId,
            credentialId: pinnedCredentialId,
            credentialVersion: 7,
            workflowVersion: "1.1.0",
          },
        },
      ],
      [{ id: pinnedCredentialId, version: 7, status: "deleted" }],
    ];
    let cursor = 0;
    const tx = {
      select: vi.fn(() => {
        const rows = results[cursor++] ?? [];
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: async () => rows,
        };
        return chain;
      }),
    };

    await expect(
      resolvePinnedTwentyFirstCredentialForBatch(tx, {
        engineerNote: `siteops-21st-operation:${visualOperationId}`,
        projectId: "40000000-0000-4000-8000-000000000004",
        userId: 42,
        knowledgeSnapshotId: snapshotId,
      }),
    ).resolves.toMatchObject({ id: pinnedCredentialId, version: 7 });
  });

  it.each(["reserved", "deploying", "verifying"] as const)(
    "rejects a second ESA admission while the same target is %s",
    async (status) => {
      const forUpdate = vi.fn().mockResolvedValue([
        {
          id: "10000000-0000-4000-8000-000000000001",
          buildId: "20000000-0000-4000-8000-000000000002",
          intent: "deploy",
          status,
        },
      ]);
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({ for: forUpdate })),
            })),
          })),
        })),
      };

      await expect(
        assertSiteOpsDeploymentTargetAvailable(tx, {
          projectId: "30000000-0000-4000-8000-000000000003",
          target: "global_excluding_cn",
        }),
      ).rejects.toMatchObject({
        code: "STATE_CONFLICT",
        statusCode: 409,
      });
      expect(forUpdate).toHaveBeenCalledWith("update");
    },
  );

  it("admits an ESA target when no deployment is in flight", async () => {
    const forUpdate = vi.fn().mockResolvedValue([]);
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
    };

    await expect(
      assertSiteOpsDeploymentTargetAvailable(tx, {
        projectId: "30000000-0000-4000-8000-000000000003",
        target: "mainland_cn",
      }),
    ).resolves.toBeUndefined();
  });

  it("ships one additive migration with the eight SiteOps tables", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "drizzle/0064_siteops_v1.sql"),
      "utf8",
    );
    for (const table of [
      "site_projects",
      "site_operations",
      "site_builds",
      "site_deployments",
      "social_packages",
      "site_provider_connections",
      "site_domain_operations",
      "site_dns_records",
    ]) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/iu);
    expect(sql).toContain("website_style_samples_source_ck");
    expect(sql).toContain("workspace_site_profiles_ascii_domain_idx");
    expect(sql).toContain("`active_financial_key` varchar(64)");
    expect(sql).toContain(
      "site_domain_operations_active_financial_uq` UNIQUE(`active_financial_key`)",
    );
    expect(sql).toContain("`quota_period_id` varchar(36)");
    expect(sql).toContain(
      "site_builds_quota_period_state_idx` ON `site_builds` (`quota_period_id`,`quota_state`)",
    );
    expect(sql).toContain(
      "social_packages_quota_period_state_idx` ON `social_packages` (`quota_period_id`,`quota_state`)",
    );
  });
});
