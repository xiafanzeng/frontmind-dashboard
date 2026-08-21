import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import {
  briefWithoutBrandAssets,
  createManusSiteOpsProviderHandler,
  frozenAssetDecisions,
  getSiteOpsSocialWorkflowReadiness,
  loadVerifiedSiteOpsSocialWorkflowPackage,
  loadVerifiedSiteOpsWorkflowPackage,
  safePublicDocuments,
} from "./manus-provider";

const operation = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  conversationTurnId: null,
  buildId: "30000000-0000-4000-8000-000000000003",
  kind: "site_build",
  status: "running",
  clientRequestId: "request-1",
  inputHash: "a".repeat(64),
  input: {
    buildId: "30000000-0000-4000-8000-000000000003",
    manusCredentialId: "40000000-0000-4000-8000-000000000004",
    manusCredentialVersion: 9,
  },
  provider: "manus",
  providerOperationId: null,
  providerTaskId: null,
  leaseOwner: "lease",
  leaseExpiresAt: new Date(),
  attempt: 1,
  result: null,
  errorCode: null,
  errorMessage: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

afterEach(() => vi.restoreAllMocks());

describe("Manus SiteOps provider boundary", () => {
  it("never sends official Logo identifiers through the Manus SiteBrief", () => {
    const promptBrief = briefWithoutBrandAssets({
      companyName: "星河智造",
      primaryLanguage: "zh-CN",
      contacts: [],
      offerings: ["设备服务"],
      audience: ["制造企业"],
      conversionGoal: "联系咨询",
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      verifiedFacts: [],
      publicAssetIds: ["secret-official-logo-id"],
      unknowns: [],
    });

    expect(promptBrief.publicAssetIds).toEqual([]);
    expect(JSON.stringify(promptBrief)).not.toContain("secret-official-logo-id");
  });

  it("passes customer-confirmed dashboard-core leaves but never inferred/evidence documents", () => {
    const documents = safePublicDocuments({
      documents: [
        {
          id: "1.1",
          path: "企业/简介.md",
          title: "企业简介",
          content: "客户已确认的企业事实",
          kind: "leaf",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
        {
          id: "evidence-1",
          path: "证据/营业执照.txt",
          title: "营业执照",
          content: "敏感证据",
          kind: "evidence",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
        {
          id: "guess-1",
          path: "推断.md",
          title: "推断",
          content: "模型推断",
          kind: "leaf",
          evidenceStatus: "inferred",
          customerVisible: true,
        },
      ],
    } as never);

    expect(documents.map((item) => item.id)).toEqual(["1.1"]);
  });

  it("publishes only the selected first-party logo and quarantines other assets", () => {
    const decisions = frozenAssetDecisions(
      {
        assets: [
          {
            id: "logo",
            key: "logo.png",
            path: "assets/logo.png",
            mimeType: "image/png",
            size: 10,
            sha256: "a".repeat(64),
            sourceKind: "official_logo_upload",
            ownership: "first_party",
          },
          {
            id: "license",
            key: "license.jpg",
            path: "assets/license.jpg",
            mimeType: "image/jpeg",
            size: 20,
            sha256: "b".repeat(64),
            sourceKind: "official_document",
            ownership: "unknown",
          },
        ],
      } as never,
      { publicAssetIds: ["logo"] } as never,
    );

    expect(decisions).toEqual([
      { id: "logo", sha256: "a".repeat(64), decision: "publish" },
      { id: "license", sha256: "b".repeat(64), decision: "quarantine" },
    ]);
  });

  it("packages the hash-verified FrontMind 1.1 workflow with SKILL and runtime contract", async () => {
    const bytes = await loadVerifiedSiteOpsWorkflowPackage();
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });

    expect(zip.file("SKILL.md")).not.toBeNull();
    expect(zip.file("runtime-contract.json")).not.toBeNull();
    expect(zip.file("MANIFEST.json")).not.toBeNull();
  });

  it("loads channel-specific brand-safe social workflows for runtime readiness", async () => {
    const [wechatBytes, xhsBytes, readiness] = await Promise.all([
      loadVerifiedSiteOpsSocialWorkflowPackage("wechat"),
      loadVerifiedSiteOpsSocialWorkflowPackage("xiaohongshu"),
      getSiteOpsSocialWorkflowReadiness(),
    ]);
    const [wechat, xhs] = await Promise.all([
      JSZip.loadAsync(wechatBytes, { checkCRC32: true }),
      JSZip.loadAsync(xhsBytes, { checkCRC32: true }),
    ]);
    expect(wechat.file("SKILL.md")).not.toBeNull();
    expect(wechat.file("runtime-contract.json")).not.toBeNull();
    expect(xhs.file("SKILL.md")).not.toBeNull();
    expect(xhs.file("runtime-contract.json")).not.toBeNull();
    expect(readiness).toMatchObject({
      ready: true,
      website: { version: "1.1.0" },
      workflows: [
        { channel: "wechat", version: "1.0.0" },
        { channel: "xiaohongshu", version: "1.0.0" },
      ],
    });
  });

  it("uses the immutable credential id and version frozen in the operation", async () => {
    const createClient = vi.fn();
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => ({}) as never,
      getCredential: async () => ({
        id: operation.input.manusCredentialId,
        version: 10,
        apiKey: "secret-key",
        fingerprint: "fingerprint",
        status: "active",
        verifiedAt: new Date(),
        retiredAt: null,
      }),
      createClient,
    });

    const result = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "MANUS_CREDENTIAL_VERSION_UNAVAILABLE",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("fails closed before any provider request when the frozen key was deleted", async () => {
    const createClient = vi.fn();
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => ({}) as never,
      getCredential: async () => null,
      createClient,
    });

    const result = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("attention_required");
    expect(createClient).not.toHaveBeenCalled();
  });
});
