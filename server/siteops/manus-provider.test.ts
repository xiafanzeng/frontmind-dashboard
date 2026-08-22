import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";

import {
  briefWithoutBrandAssets,
  createManusSiteOpsProviderHandler,
  frozenAssetDecisions,
  getSiteOpsSocialWorkflowReadiness,
  loadVerifiedSiteOpsSocialWorkflowPackage,
  loadVerifiedSiteOpsWorkflowPackage,
  safePublicDocuments,
  visualPreviewAttachment,
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
    expect(JSON.stringify(promptBrief)).not.toContain(
      "secret-official-logo-id",
    );
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

  it("packages the hash-verified FrontMind 1.3 workflow with SKILL and runtime contract", async () => {
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
      website: { version: "1.3.0" },
      workflows: [
        { channel: "wechat", version: "1.0.0" },
        { channel: "xiaohongshu", version: "1.0.0" },
      ],
    });
  });

  it("attaches the frozen same-origin visual bytes to the first Manus task", async () => {
    const bytes = Buffer.from("normalized-png-preview", "utf8");
    const attachment = await visualPreviewAttachment(
      {
        row: {
          mimeType: "image/png",
          contentSha256: createHash("sha256").update(bytes).digest("hex"),
        },
        stored: {
          sizeBytes: bytes.length,
          createReadStream: () => Readable.from([bytes]),
        },
      } as never,
      "selected-visual.png",
    );

    expect(attachment).toEqual({
      filename: "selected-visual.png",
      mime_type: "image/png",
      file_data: `data:image/png;base64,${bytes.toString("base64")}`,
    });
  });

  it("creates one task with workflow and visual, then sends phase two to that same task", async () => {
    const preview = Buffer.from("frozen-preview", "utf8");
    const previewHash = createHash("sha256").update(preview).digest("hex");
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:143",
      metadataSha256: "c".repeat(64),
      providerResponseSha256: "d".repeat(64),
      previewSha256: previewHash,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const evidenceHash = visualEvidence.evidenceSha256;
    const supportOne = Buffer.from("frozen-support-one", "utf8");
    const supportTwo = Buffer.from("frozen-support-two", "utf8");
    const supportOneId = "81000000-0000-4000-8000-000000000008";
    const supportTwoId = "82000000-0000-4000-8000-000000000008";
    const supportOneHash = createHash("sha256")
      .update(supportOne)
      .digest("hex");
    const supportTwoHash = createHash("sha256")
      .update(supportTwo)
      .digest("hex");
    const supportOneEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:144",
      metadataSha256: "1".repeat(64),
      providerResponseSha256: "2".repeat(64),
      previewSha256: supportOneHash,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const supportTwoEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:145",
      metadataSha256: "3".repeat(64),
      providerResponseSha256: "4".repeat(64),
      previewSha256: supportTwoHash,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const designToken = `siteops-design:${operation.id}`;
    const designResult = {
      operationToken: designToken,
      designSpec: {
        schemaVersion: 1,
        layoutArchetype: "asymmetric",
        heroVariant: "split_media",
        density: "balanced",
        surfaceStyle: "bordered",
        typeScale: "display",
        imageTreatment: "contained",
        motionLevel: "subtle",
        colorRoles: {
          backgroundPaletteIndex: 2,
          textPaletteIndex: 0,
          accentPaletteIndex: 1,
        },
        routeCompositions: [
          {
            routeId: "home",
            slots: [{ slotId: "proof", variant: "proof" }],
          },
        ],
        seoPlan: {
          siteTitle: "星河智造",
          description: "经过知识来源核验的企业官网。",
          organizationType: "Organization",
        },
      },
    };
    const context = {
      build: {
        id: operation.buildId,
        projectId: operation.projectId,
        userId: operation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        brief: {
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
          verifiedFacts: [
            {
              statement: "提供设备服务",
              sourceDocumentIds: ["overview"],
            },
          ],
          publicAssetIds: [],
          unknowns: [],
        },
        selectionHash: "b".repeat(64),
        repairAttempts: 0,
        upstreamManusTaskId: null,
      },
      project: { id: operation.projectId },
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        archiveHash: "a".repeat(64),
        totalBytes: 1,
        sourceBuildId: null,
        sourceBuildRevision: null,
        assets: [],
        documents: [
          {
            id: "overview",
            path: "overview.md",
            title: "企业简介",
            content: "星河智造提供设备服务。",
            kind: "leaf",
            evidenceStatus: "verified_first_party",
            customerVisible: true,
          },
        ],
      },
      sample: {
        id: "60000000-0000-4000-8000-000000000006",
        batchId: "70000000-0000-4000-8000-000000000007",
        previewLocalAssetId: "80000000-0000-4000-8000-000000000008",
        sourceMetadata: {
          providerItemKey: "n:143",
          visualEvidence,
          taxonomy: {
            role: "foundation",
            palette: ["#10212B", "#EF6C45", "#F5F2EA"],
            typography: [],
            layout: [],
            motion: [],
            accessibility: ["reduced-motion"],
          },
          score: 90,
          rationale: "视觉证据完整",
        },
      },
      batch: {
        selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
        selectionBundleHash: "",
      },
    };
    const selectionBundle = {
      schemaVersion: 2,
      queryPlanHash: "f".repeat(64),
      searchTarget: 18,
      shortlistTarget: 12,
      displayTarget: 9,
      candidates: [
        {
          id: context.sample.id,
          label: "B",
          queryAxis: "foundation_split",
          providerItemKey: "n:143",
          title: "Split hero",
          description: "Enterprise split layout",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/split-hero",
          visualEvidence,
          previewLocalAssetId: context.sample.previewLocalAssetId,
          previewSha256: previewHash,
          taxonomy: context.sample.sourceMetadata.taxonomy,
          score: 90,
          rationale: "视觉证据完整",
        },
      ],
      supportingCandidates: [
        {
          id: "61000000-0000-4000-8000-000000000006",
          queryAxis: "section_proof_conversion",
          providerItemKey: "n:144",
          title: "Proof section",
          description: "Enterprise proof cards",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/proof",
          visualEvidence: supportOneEvidence,
          previewLocalAssetId: supportOneId,
          previewSha256: supportOneHash,
          taxonomy: {
            role: "section",
            palette: [],
            typography: [],
            layout: ["modular-grid"],
            motion: [],
            accessibility: ["reduced-motion"],
          },
          score: 85,
          rationale: "真实证明区参考",
        },
        {
          id: "62000000-0000-4000-8000-000000000006",
          queryAxis: "motion_accessible",
          providerItemKey: "n:145",
          title: "Accessible motion",
          description: "Reduced motion interaction",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/motion",
          visualEvidence: supportTwoEvidence,
          previewLocalAssetId: supportTwoId,
          previewSha256: supportTwoHash,
          taxonomy: {
            role: "motion",
            palette: [],
            typography: [],
            layout: [],
            motion: ["short-transition"],
            accessibility: ["reduced-motion"],
          },
          score: 80,
          rationale: "真实动效参考",
        },
      ],
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    };
    const selectionBytes = Buffer.from(canonicalJson(selectionBundle), "utf8");
    context.batch.selectionBundleHash = createHash("sha256")
      .update(selectionBytes)
      .digest("hex");
    const query: any = {};
    query.from = () => query;
    query.innerJoin = () => query;
    query.where = () => query;
    query.limit = async () => [context];
    const db = {
      select: () => query,
      update: () => ({
        set: () => ({ where: async () => undefined }),
      }),
    };
    const createTask = vi.fn(async () => ({ taskId: "manus-task-1" }));
    const sendMessage = vi.fn(async () => undefined);
    const client = {
      createTask,
      sendMessage,
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => ({ status: "running" })),
      listAllMessages: vi.fn(async () => [
        {
          id: "design-result",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: { success: true, value: designResult },
        },
      ]),
    };
    const readArtifact = vi.fn(async (input: { localAssetId: string }) => {
      const isSelection =
        input.localAssetId === context.batch.selectionBundleLocalAssetId;
      const bytes = isSelection
        ? selectionBytes
        : input.localAssetId === supportOneId
          ? supportOne
          : input.localAssetId === supportTwoId
            ? supportTwo
            : preview;
      return {
        row: {
          id: input.localAssetId,
          scope: "managed_user",
          accountUserId: operation.userId,
          storageKey: `siteops:${operation.projectId}:fixture:${input.localAssetId}`,
          mimeType: isSelection ? "application/json" : "image/png",
          contentSha256: createHash("sha256").update(bytes).digest("hex"),
        },
        stored: {
          sizeBytes: bytes.length,
          createReadStream: () => Readable.from([bytes]),
        },
      };
    });
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: async () =>
        ({
          id: operation.input.manusCredentialId,
          version: operation.input.manusCredentialVersion,
          apiKey: "secret-key",
        }) as never,
      createClient: () => client as never,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
    });

    const created = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });
    expect(created).toMatchObject({
      status: "pending",
      providerTaskId: "manus-task-1",
      result: { stage: "design_pending", taskId: "manus-task-1" },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0].attachments).toHaveLength(4);
    expect(createTask.mock.calls[0]![0].attachments[1]).toMatchObject({
      filename: "selected-visual.png",
      mime_type: "image/png",
    });
    expect(
      createTask.mock.calls[0]![0].attachments.map(
        (attachment: { filename: string }) => attachment.filename,
      ),
    ).toEqual([
      "frontmind-astro-company-site-workflow-1.3.0.zip",
      "selected-visual.png",
      "support-visual-1.png",
      "support-visual-2.png",
    ]);
    expect(createTask.mock.calls[0]![0].prompt).toContain(
      supportOneEvidence.evidenceSha256,
    );
    expect(createTask.mock.calls[0]![0].prompt).toContain(
      supportTwoEvidence.evidenceSha256,
    );

    const designed = await handler({
      operation: {
        ...operation,
        providerTaskId: "manus-task-1",
        result: created.result,
      } as never,
      signal: new AbortController().signal,
    });
    expect(designed).toMatchObject({
      status: "pending",
      result: { stage: "content_send_ready", taskId: "manus-task-1" },
    });

    const continued = await handler({
      operation: {
        ...operation,
        providerTaskId: "manus-task-1",
        result: designed.result,
      } as never,
      signal: new AbortController().signal,
    });
    expect(continued).toMatchObject({
      status: "pending",
      result: { stage: "content_pending", taskId: "manus-task-1" },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].taskId).toBe("manus-task-1");
    expect(
      readArtifact.mock.calls.filter(([input]) =>
        [
          context.sample.previewLocalAssetId,
          supportOneId,
          supportTwoId,
        ].includes(input.localAssetId),
      ),
    ).toHaveLength(3);
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
