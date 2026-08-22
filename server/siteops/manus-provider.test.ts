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
  combinedTerminalTaskState,
  handledWaitingResolution,
  createManusSiteOpsProviderHandler,
  frozenAssetDecisions,
  getSiteOpsSocialWorkflowReadiness,
  loadVerifiedSiteOpsSocialWorkflowPackage,
  loadVerifiedSiteOpsWorkflowPackage,
  messageAskUserWaiting,
  safePublicDocuments,
  resultFailure,
  structuredResultGrace,
  terminalTaskState,
  visualPreviewAttachment,
} from "./manus-provider";
import {
  buildManusV2CreateTaskBody,
  buildManusV2SendMessageBody,
  ManusV2ApiError,
} from "../manus-v2-client";

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
    feedback: "保持事实不变并调整页面表达。".repeat(200),
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
  it("treats stopped as completion and waits up to 120 seconds for its structured result", () => {
    expect(terminalTaskState("stopped")).toEqual({
      completed: true,
      failed: false,
    });
    const started = structuredResultGrace(
      { schemaVersion: 1, stage: "design_pending", taskId: "task-1" },
      true,
      1_000,
    );
    expect(started).toMatchObject({
      expired: false,
      state: { resultPendingSince: new Date(1_000).toISOString() },
    });
    expect(structuredResultGrace(started.state, true, 120_999).expired).toBe(
      false,
    );
    expect(structuredResultGrace(started.state, true, 121_000).expired).toBe(
      true,
    );
    expect(combinedTerminalTaskState("running", "stopped")).toEqual({
      completed: true,
      failed: false,
    });
    expect(combinedTerminalTaskState("stopped", "error")).toEqual({
      completed: false,
      failed: true,
    });
    const waitingState = {
      schemaVersion: 1 as const,
      stage: "repair_pending" as const,
      taskId: "task-1",
      repairKind: "design" as const,
      repairAttempt: 1,
      handledWaitingEventId: "waiting-1",
      handledWaitingAt: new Date(5_000).toISOString(),
    };
    expect(handledWaitingResolution(waitingState, "waiting-1", 5_001)).toBe(
      "pending",
    );
    expect(handledWaitingResolution(waitingState, "waiting-2", 5_001)).toBe(
      "new",
    );
    expect(handledWaitingResolution(waitingState, "waiting-1", 125_000)).toBe(
      "expired",
    );
  });

  it("allows only a provider question to enter the same-task repair path", () => {
    expect(
      messageAskUserWaiting({ eventType: "messageAskUser" } as never),
    ).toBe(true);
    expect(messageAskUserWaiting({ eventType: "deploy" } as never)).toBe(false);
  });

  it("maps an explicit task.create 400 to a known FrontMind rejection", () => {
    const result = resultFailure(
      new ManusV2ApiError("task.create", 400, "invalid_argument", false, false),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "FRONTMIND_BUILD_REQUEST_INVALID",
      result: { stage: "create_rejected" },
    });
    expect(JSON.stringify(result)).not.toMatch(/manus|invalid_argument/iu);
  });

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

  it("keeps every safe document and its complete content for lossless dossier splitting", () => {
    const content = "完整知识".repeat(6_000);
    const documents = safePublicDocuments({
      documents: Array.from({ length: 81 }, (_, index) => ({
        id: `doc-${index + 1}`,
        path: `doc-${index + 1}.md`,
        title: `资料 ${index + 1}`,
        content,
        kind: "leaf",
        evidenceStatus: "verified_first_party",
        customerVisible: true,
      })),
    } as never);

    expect(documents).toHaveLength(81);
    expect(documents[0]?.content).toBe(content);
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

  it("packages the hash-verified FrontMind 1.4 workflow with SKILL and runtime contract", async () => {
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
      website: { version: "1.4.0" },
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
      schemaVersion: 1,
      layoutArchetype: "asymmetric",
      heroVariant: "split_media",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "display",
      imageTreatment: "contained",
      motionLevel: "subtle",
      backgroundPaletteIndex: 2,
      textPaletteIndex: 0,
      accentPaletteIndex: 1,
      siteTitle: "星河智造",
      description: "经过知识来源核验的企业官网。",
      organizationType: "Organization",
      routeSlots: [
        { routeId: "home", slotId: "proof", variant: "proof", order: 0 },
      ],
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
          verifiedFacts: Array.from({ length: 120 }, (_, index) => ({
            statement: `经过来源核验的企业事实 ${index + 1}`,
            sourceDocumentIds: ["overview"],
          })),
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
        documents: Array.from({ length: 56 }, (_, index) => ({
          id: index === 0 ? "overview" : `source-${index + 1}`,
          path: index === 0 ? "overview.md" : `source-${index + 1}.md`,
          title: index === 0 ? "企业简介" : `企业资料 ${index + 1}`,
          content:
            index === 0
              ? "星河智造提供设备服务。"
              : `经过来源核验的企业资料 ${index + 1}。`.repeat(100),
          kind: "leaf" as const,
          evidenceStatus: "verified_first_party" as const,
          customerVisible: true,
        })),
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
    expect(createTask.mock.calls[0]![0].attachments).toHaveLength(5);
    expect(createTask.mock.calls[0]![0].attachments[2]).toMatchObject({
      filename: "selected-visual.png",
      mime_type: "image/png",
    });
    expect(
      createTask.mock.calls[0]![0].attachments.map(
        (attachment: { filename: string }) => attachment.filename,
      ),
    ).toEqual([
      "frontmind-astro-company-site-workflow-1.4.0.zip",
      "frontmind-siteops-source-dossier-v1.json",
      "selected-visual.png",
      "support-visual-1.png",
      "support-visual-2.png",
    ]);
    expect(
      Array.from(createTask.mock.calls[0]![0].prompt).length,
    ).toBeLessThanOrEqual(3_000);
    expect(createTask.mock.calls[0]![0].prompt).not.toContain(
      "星河智造提供设备服务",
    );
    const createBody = buildManusV2CreateTaskBody(createTask.mock.calls[0]![0]);
    expect(createBody.message.content).toHaveLength(6);
    expect(JSON.stringify(createBody.structured_output_schema)).not.toMatch(
      /"(?:pattern|minimum|maximum|minItems|maxItems)"/u,
    );
    const dossierAttachment = createTask.mock.calls[0]![0].attachments[1];
    const dossier = JSON.parse(
      Buffer.from(
        dossierAttachment.file_data.split(",", 2)[1],
        "base64",
      ).toString("utf8"),
    );
    expect(dossier.visualEvidence.supportEvidenceSha256s).toEqual([
      supportOneEvidence.evidenceSha256,
      supportTwoEvidence.evidenceSha256,
    ]);
    expect(dossier.documents[0].content).toBe("星河智造提供设备服务。");
    expect(dossier.documents).toHaveLength(56);
    expect(dossier.brief.verifiedFacts).toHaveLength(120);

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
    expect(sendMessage.mock.calls[0]![0].attachments).toEqual([
      expect.objectContaining({
        filename: "frontmind-build-contract-v2.json",
        mime_type: "application/json",
      }),
      expect.objectContaining({
        filename: "frontmind-customer-feedback-v1.json",
        mime_type: "application/json",
      }),
    ]);
    expect(
      Array.from(sendMessage.mock.calls[0]![0].prompt).length,
    ).toBeLessThanOrEqual(3_000);
    const sendBody = buildManusV2SendMessageBody(sendMessage.mock.calls[0]![0]);
    expect(sendBody.task_id).toBe("manus-task-1");
    expect(sendBody.message.content).toHaveLength(3);
    expect(JSON.stringify(sendBody.structured_output_schema)).not.toMatch(
      /"(?:pattern|minimum|maximum|minItems|maxItems)"/u,
    );
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
