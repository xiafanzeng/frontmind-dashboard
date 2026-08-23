import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";
import { SITEOPS_WORKFLOW } from "../../shared/siteops";

const remotePreview = vi.hoisted(() => ({
  fetchPinnedPublicHttps: vi.fn(),
}));

vi.mock("./remote-preview", () => ({
  fetchPinnedPublicHttps: remotePreview.fetchPinnedPublicHttps,
}));

import { createManusSiteOpsProviderHandler } from "./manus-provider";
import { SiteOpsMaterializationError } from "./materialization-error";

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

function operationWithState(
  operation: typeof baseOperation,
  providerTaskId: string | null,
  result: unknown,
) {
  return {
    ...operation,
    providerTaskId,
    result,
  };
}

const baseOperation = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  conversationTurnId: null,
  buildId: "30000000-0000-4000-8000-000000000003",
  kind: "site_build",
  status: "running",
  clientRequestId: "request-multisweep",
  inputHash: "a".repeat(64),
  input: {
    credentialScope: "customer",
    buildId: "30000000-0000-4000-8000-000000000003",
    manusCredentialId: "40000000-0000-4000-8000-000000000004",
    manusCredentialVersion: 9,
    agentProfile: "frontmind-base",
  },
  provider: "manus",
  providerOperationId: null,
  providerTaskId: null,
  leaseOwner: "lease-multisweep",
  leaseExpiresAt: new Date(Date.now() + 12 * 60_000),
  attempt: 1,
  result: null,
  errorCode: null,
  errorMessage: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

function operationMarker(operationToken: string, timestamp: number) {
  return {
    id: `marker-${timestamp}`,
    type: "user_message",
    timestamp,
    user_message: {
      content: `继续执行。\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
    },
  };
}

describe("SiteOps personal-key build multi-sweep integration", () => {
  it("waits for each stopped phase, resolves content, and returns one verified artifact set for atomic worker finalization", async () => {
    const taskId = "customer-private-task-1";
    const designToken = `siteops-design:${baseOperation.id}`;
    const contentToken = `siteops-content:${baseOperation.id}`;
    const preview = Buffer.from("frozen-hero-preview", "utf8");
    const previewSha256 = sha256(preview);
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:143",
      metadataSha256: "c".repeat(64),
      providerResponseSha256: "d".repeat(64),
      previewSha256,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const designWire = {
      operationToken: designToken,
      schemaVersion: 2,
      layoutArchetype: "split",
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
      routeSlots: [{ routeId: "home", slotId: "proof", variant: "proof" }],
    } as const;
    const contentWire = {
      operationToken: contentToken,
      schemaVersion: 2,
      routes: [
        {
          routeId: "home",
          eyebrow: "可信制造",
          heading: "让设备服务更可靠",
          summary: "基于经过核验的企业资料呈现服务能力。",
        },
      ],
      sections: [
        {
          routeId: "home",
          slotId: "proof",
          heading: "设备服务能力",
          paragraphs: ["星河智造提供经过知识来源核验的设备服务。"],
          sourceDocumentIds: ["overview"],
        },
      ],
    } as const;

    const context = {
      build: {
        id: baseOperation.buildId,
        projectId: baseOperation.projectId,
        userId: baseOperation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        workflowUpstreamVersion: "1.0.0",
        workflowUpstreamHash: "b".repeat(64),
        workflowVersion: "1.6.0",
        workflowPackageHash: "c".repeat(64),
        starterVersion: "1.6.0",
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
              statement: "星河智造提供设备服务。",
              sourceDocumentIds: ["overview"],
            },
          ],
          publicAssetIds: [],
          unknowns: [],
        },
        selectionHash: "e".repeat(64),
        repairAttempts: 0,
        upstreamManusTaskId: null as string | null,
        status: "queued",
      },
      project: { id: baseOperation.projectId },
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        userId: baseOperation.userId,
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
            kind: "leaf" as const,
            evidenceStatus: "verified_first_party" as const,
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
            layout: ["split-layout"],
            motion: [],
            accessibility: ["reduced-motion"],
          },
          score: 90,
          rationale: "合格 Hero 视觉证据",
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
          label: "A",
          queryAxis: "foundation_split",
          providerItemKey: "n:143",
          title: "Split Hero",
          description: "Enterprise split hero",
          author: "21st",
          sourceUrl: "https://21st.dev/community/components/split-hero",
          visualEvidence,
          previewLocalAssetId: context.sample.previewLocalAssetId,
          previewSha256,
          taxonomy: context.sample.sourceMetadata.taxonomy,
          score: 90,
          rationale: "合格 Hero 视觉证据",
        },
      ],
      supportingCandidates: [],
      selectedCandidateId: context.sample.id,
      delegated: false,
      degradedReasons: [],
    };
    const selectionBytes = Buffer.from(canonicalJson(selectionBundle), "utf8");
    context.batch.selectionBundleHash = sha256(selectionBytes);

    const timeline: string[] = [];
    const buildWrites: Array<Record<string, unknown>> = [];
    const query: any = {};
    query.from = () => query;
    query.innerJoin = () => query;
    query.where = () => query;
    query.limit = async () => [context];
    const db = {
      select: () => query,
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(db),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (!("result" in values)) {
              buildWrites.push(values);
              Object.assign(context.build, values);
              if (values.status === "qa_running")
                timeline.push("db:qa_running");
            }
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };

    const readArtifact = vi.fn(async (input: { localAssetId: string }) => {
      const isSelection =
        input.localAssetId === context.batch.selectionBundleLocalAssetId;
      const bytes = isSelection ? selectionBytes : preview;
      return {
        row: {
          id: input.localAssetId,
          scope: "managed_user",
          accountUserId: baseOperation.userId,
          storageKey: `siteops:${baseOperation.projectId}:fixture:${input.localAssetId}`,
          mimeType: isSelection ? "application/json" : "image/png",
          contentSha256: sha256(bytes),
        },
        stored: {
          sizeBytes: bytes.length,
          createReadStream: () => Readable.from([bytes]),
        },
      };
    });

    let upstreamStatus = "running";
    let upstreamEvents: unknown[] = [];
    const createTask = vi.fn(async () => {
      timeline.push("provider:create");
      return { taskId };
    });
    const sendMessage = vi.fn(async () => {
      timeline.push("provider:send");
    });
    const client = {
      createTask,
      sendMessage,
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => ({ status: upstreamStatus })),
      listAllMessages: vi.fn(async () => upstreamEvents),
    };

    const contractJson = Buffer.from('{"contract":true}', "utf8");
    const sourceZip = Buffer.from("source-zip", "utf8");
    const distZip = Buffer.from("dist-zip", "utf8");
    const qaJson = Buffer.from('{"passed":true,"mode":"preview"}', "utf8");
    const visualQaZip = Buffer.from("visual-qa-zip", "utf8");
    const provenanceJson = Buffer.from('{"provenance":true}', "utf8");
    const materialized = {
      contract: { specHash: "9".repeat(64) },
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip,
      sourceSha256: sha256(sourceZip),
      distZip,
      distSha256: sha256(distZip),
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip,
      visualQaSha256: sha256(visualQaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog: Buffer.from("ok", "utf8"),
      files: new Map<string, Buffer>(),
    };
    let materializeAttempts = 0;
    const materializeSite = vi.fn(async (input: unknown) => {
      timeline.push("materialize");
      expect(input).toMatchObject({
        mode: "preview",
        generatedContent: {
          routes: [
            {
              routeId: "home",
              sections: [{ slotId: "proof" }],
            },
          ],
        },
      });
      materializeAttempts += 1;
      if (materializeAttempts === 1) {
        throw new SiteOpsMaterializationError({
          phase: "browser_qa",
          code: "SITEOPS_BROWSER_RUNTIME_UNAVAILABLE",
          retryClass: "host_transient",
        });
      }
      return materialized as never;
    });
    const persistArtifact = vi.fn(
      async (input: { kind: string; buffer: Buffer }) => {
        timeline.push(`persist:${input.kind}`);
        return {
          id: `asset-${input.kind}`,
          contentSha256: sha256(input.buffer),
        } as never;
      },
    );
    const getCredential = vi.fn(async () => ({
      id: baseOperation.input.manusCredentialId,
      userId: baseOperation.userId,
      version: baseOperation.input.manusCredentialVersion,
      apiKey: "customer-personal-key",
    }));
    const createClient = vi.fn(() => client as never);
    const assertLeaseActive = vi.fn(async () => {
      timeline.push("lease");
    });

    remotePreview.fetchPinnedPublicHttps.mockImplementation(
      async (input: { url: string }) => {
        timeline.push("fetch:content-attachment");
        const body = JSON.stringify(contentWire);
        return {
          response: new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(Buffer.byteLength(body)),
            },
          }),
          finalUrl: new URL(input.url),
        };
      },
    );

    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: getCredential as never,
      createClient,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
      materializeSite,
      persistArtifact: persistArtifact as never,
    });
    const sweep = (operation: typeof baseOperation) =>
      handler({
        operation: operation as never,
        signal: new AbortController().signal,
        assertLeaseActive,
      });

    const created = await sweep(baseOperation);
    expect(created).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: { stage: "design_pending", taskId },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      agentProfile: "manus-1.6",
    });

    upstreamEvents = [
      operationMarker(designToken, 1),
      {
        id: "design-result",
        type: "structured_output_result",
        timestamp: 2,
        structured_output_result: { success: true, value: designWire },
      },
      {
        id: "design-stopped",
        type: "status_update",
        timestamp: 3,
        status_update: { agent_status: "stopped" },
      },
    ];
    upstreamStatus = "running";
    const designStillRunning = await sweep(
      operationWithState(baseOperation, taskId, created.result) as never,
    );
    expect(designStillRunning).toMatchObject({
      status: "pending",
      result: { stage: "design_pending", taskId },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(materializeSite).not.toHaveBeenCalled();

    upstreamStatus = "stopped";
    const designStopped = await sweep(
      operationWithState(
        baseOperation,
        taskId,
        designStillRunning.result,
      ) as never,
    );
    expect(designStopped).toMatchObject({
      status: "pending",
      result: { stage: "content_send_ready", taskId },
    });

    const contentSent = await sweep(
      operationWithState(baseOperation, taskId, designStopped.result) as never,
    );
    expect(contentSent).toMatchObject({
      status: "pending",
      result: { stage: "content_pending", taskId },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ taskId });

    upstreamEvents = [
      operationMarker(contentToken, 10),
      {
        id: "content-extraction-rejected",
        type: "structured_output_result",
        timestamp: 11,
        structured_output_result: {
          error: "structured extraction failed",
          value: 0,
        },
      },
      {
        id: "content-attachment",
        type: "assistant_message",
        timestamp: 12,
        assistant_message: {
          attachments: [
            {
              filename: "frontmind_page_content_wire_v2.json",
              content_type: "application/json; charset=utf-8",
              url: "https://files.example.test/content.json?signature=private",
            },
          ],
        },
      },
      {
        id: "content-stopped",
        type: "status_update",
        timestamp: 13,
        status_update: { agent_status: "stopped" },
      },
    ];
    upstreamStatus = "running";
    const contentStillRunning = await sweep(
      operationWithState(baseOperation, taskId, contentSent.result) as never,
    );
    expect(contentStillRunning).toMatchObject({
      status: "pending",
      result: { stage: "content_pending", taskId },
    });
    expect(remotePreview.fetchPinnedPublicHttps).not.toHaveBeenCalled();
    expect(materializeSite).not.toHaveBeenCalled();
    expect(persistArtifact).not.toHaveBeenCalled();

    timeline.length = 0;
    const leaseCallsBeforeFinal = assertLeaseActive.mock.calls.length;
    upstreamStatus = "stopped";
    const finished = await sweep(
      operationWithState(
        baseOperation,
        taskId,
        contentStillRunning.result,
      ) as never,
    );

    expect(finished).toMatchObject({
      status: "succeeded",
      providerTaskId: taskId,
      projectStatus: "preview_ready",
      buildStatus: "preview_ready",
      result: {
        buildId: baseOperation.buildId,
        specHash: materialized.contract.specHash,
        distHash: materialized.distSha256,
        artifactIds: {
          contract: "asset-site-contract",
          source: "asset-site-source",
          dist: "asset-site-dist",
          qa: "asset-site-qa",
          provenance: "asset-site-provenance",
        },
        artifactBindings: {
          contract: {
            id: "asset-site-contract",
            sha256: materialized.contractSha256,
            bytes: contractJson.length,
            mimeType: "application/json",
          },
          source: {
            id: "asset-site-source",
            sha256: materialized.sourceSha256,
            bytes: sourceZip.length,
            mimeType: "application/zip",
          },
        },
      },
    });
    expect(remotePreview.fetchPinnedPublicHttps).toHaveBeenCalledTimes(1);
    expect(materializeSite).toHaveBeenCalledTimes(2);
    expect(persistArtifact).toHaveBeenCalledTimes(5);
    expect(persistArtifact.mock.calls.map(([input]) => input.kind)).toEqual([
      "site-contract",
      "site-source",
      "site-dist",
      "site-qa",
      "site-provenance",
    ]);
    expect(buildWrites.some((write) => "contractLocalAssetId" in write)).toBe(
      false,
    );

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(context.build.repairAttempts).toBe(0);
    expect(getCredential).toHaveBeenCalledTimes(6);
    expect(
      getCredential.mock.calls.every(
        ([userId, credentialId]) =>
          userId === baseOperation.userId &&
          credentialId === baseOperation.input.manusCredentialId,
      ),
    ).toBe(true);
    expect(
      createClient.mock.calls.every(
        ([input]) =>
          input.apiKey === "customer-personal-key" &&
          input.credentialId === baseOperation.input.manusCredentialId,
      ),
    ).toBe(true);

    const finalLeaseCalls =
      assertLeaseActive.mock.calls.length - leaseCallsBeforeFinal;
    expect(finalLeaseCalls).toBeGreaterThanOrEqual(5);
    const materializeIndex = timeline.indexOf("materialize");
    const firstLeaseIndex = timeline.indexOf("lease");
    const lastPersistIndex = Math.max(
      ...timeline.map((entry, index) =>
        entry.startsWith("persist:") ? index : -1,
      ),
    );
    const finalLeaseIndex = timeline.lastIndexOf("lease");
    expect(firstLeaseIndex).toBeGreaterThanOrEqual(0);
    expect(materializeIndex).toBeGreaterThan(firstLeaseIndex);
    expect(finalLeaseIndex).toBeGreaterThan(lastPersistIndex);
    expect(timeline).toContain("db:qa_running");
  });
});
