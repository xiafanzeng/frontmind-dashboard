import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";
import {
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_WORKFLOW,
  visualSelectionBundleV5Schema,
} from "../../shared/siteops";
import {
  FRONTMIND_VISUAL_FAMILIES_V3,
  referenceBlueprintV4ForFamily,
} from "../../shared/siteops-design";

const remotePreview = vi.hoisted(() => ({
  fetchPinnedPublicHttps: vi.fn(),
}));

vi.mock("./remote-preview", () => ({
  fetchPinnedPublicHttps: remotePreview.fetchPinnedPublicHttps,
}));

import { createManusSiteOpsProviderHandler } from "./manus-provider";
import { SiteOpsMaterializationError } from "./materialization-error";
import { ManusV2ApiError } from "../manus-v2-client";
import {
  createNativeSourceArchive,
  createVisualSelectionBundleV5Artifact,
  normalizeTwentyFirstNativeSource,
} from "./native-visual-source";

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
  it("uses the trusted 2.4 brief fallback when the single content-draft task is unavailable", async () => {
    const preview = Buffer.from("frozen-hero-preview", "utf8");
    const realizationPreview = Buffer.from(
      "frozen-host-realization-preview",
      "utf8",
    );
    const previewSha256 = sha256(preview);
    const realizationPreviewSha256 = sha256(realizationPreview);
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:143",
      metadataSha256: "c".repeat(64),
      providerResponseSha256: "d".repeat(64),
      previewSha256,
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const referenceBlueprint = referenceBlueprintV4ForFamily({
      candidateId: "60000000-0000-4000-8000-000000000006",
      providerItemKey: visualEvidence.providerItemKey,
      referencePreviewLocalAssetId: "80000000-0000-4000-8000-000000000008",
      referencePreviewSha256: previewSha256,
      realizationPreviewLocalAssetId: "81000000-0000-4000-8000-000000000008",
      realizationPreviewSha256,
      heroFamily: "split_media",
      inspirationEvidenceId: visualEvidence.evidenceSha256,
      inspirationTaxonomy: {
        role: "foundation",
        palette: [],
        typography: [],
        layout: ["split-layout"],
        motion: [],
        accessibility: ["reduced-motion"],
      },
    });
    const buildOperation = {
      ...baseOperation,
      input: { ...baseOperation.input, referenceBlueprint },
    } as const;

    const context = {
      build: {
        id: baseOperation.buildId,
        projectId: baseOperation.projectId,
        userId: baseOperation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
        workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
        workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
        workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
        starterVersion: SITEOPS_WORKFLOW.starterVersion,
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
    const perceptualHashes = [
      "0000000000000000",
      "ffffffffffffffff",
      "aaaaaaaaaaaaaaaa",
      "5555555555555555",
      "cccccccccccccccc",
      "3333333333333333",
      "f0f0f0f0f0f0f0f0",
      "0f0f0f0f0f0f0f0f",
      "9696969696969696",
    ] as const;
    const families = [
      "split_media",
      ...FRONTMIND_VISUAL_FAMILIES_V3.filter(
        (family) => family !== "split_media",
      ),
    ] as const;
    const selectionCandidates = families.map((heroFamily, index) => {
      const selected = index === 0;
      const suffix = String(index + 10).padStart(12, "0");
      const candidateId = selected
        ? context.sample.id
        : `60000000-0000-4000-8000-${suffix}`;
      const providerItemKey = selected ? "n:143" : `n:${200 + index}`;
      const referencePreviewLocalAssetId = selected
        ? context.sample.previewLocalAssetId
        : `80000000-0000-4000-8000-${suffix}`;
      const realizationPreviewLocalAssetId = selected
        ? referenceBlueprint.previewLocalAssetId
        : `81000000-0000-4000-8000-${suffix}`;
      const referenceSha = selected
        ? previewSha256
        : sha256(`provider-reference-${index}`);
      const realizationSha = selected
        ? realizationPreviewSha256
        : sha256(`host-realization-${index}`);
      const candidateEvidence = selected
        ? visualEvidence
        : createVisualEvidenceV1({
            evidenceKind: "catalog_metadata_preview_v1",
            providerItemKey,
            metadataSha256: sha256(`metadata-${index}`),
            providerResponseSha256: sha256(`response-${index}`),
            previewSha256: referenceSha,
            taxonomyDerivationVersion: "catalog-metadata-preview-v1",
          });
      const candidateTaxonomy = {
        role: "foundation" as const,
        palette: [] as string[],
        typography: [] as string[],
        layout: [`${heroFamily}-layout`],
        motion: [] as string[],
        accessibility: ["reduced-motion"],
      };
      const blueprint = selected
        ? referenceBlueprint
        : referenceBlueprintV4ForFamily({
            candidateId,
            providerItemKey,
            referencePreviewLocalAssetId,
            referencePreviewSha256: referenceSha,
            realizationPreviewLocalAssetId,
            realizationPreviewSha256: realizationSha,
            heroFamily,
            inspirationEvidenceId: candidateEvidence.evidenceSha256,
            inspirationTaxonomy: candidateTaxonomy,
          });
      return {
        id: candidateId,
        label: String.fromCharCode(65 + index),
        queryAxis: "foundation_split" as const,
        providerItemKey,
        title: `${heroFamily} Hero`,
        description: "Enterprise hero reference",
        author: "21st",
        sourceUrl: `https://21st.dev/community/components/${heroFamily}`,
        visualEvidence: candidateEvidence,
        previewLocalAssetId: referencePreviewLocalAssetId,
        previewSha256: referenceSha,
        realizationPreviewLocalAssetId,
        realizationPreviewSha256: realizationSha,
        referencePerceptualHash: perceptualHashes[index]!,
        realizationPerceptualHash: perceptualHashes[(index + 4) % 9]!,
        referenceBlueprint: blueprint,
        taxonomy: candidateTaxonomy,
        score: 90 - index,
        rationale: "合格 Hero 视觉证据",
      };
    });
    const selectionBundle = {
      schemaVersion: 4,
      queryPlanHash: "f".repeat(64),
      searchTarget: 162,
      referenceTarget: 9,
      displayTarget: 9,
      candidates: selectionCandidates,
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
      const isRealization =
        input.localAssetId === referenceBlueprint.previewLocalAssetId;
      const bytes = isSelection
        ? selectionBytes
        : isRealization
          ? realizationPreview
          : preview;
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

    const fallbackTaskId = `frontmind-host-fallback:${baseOperation.id}`;
    const createTask = vi.fn(async () => {
      timeline.push("provider:create");
      throw new ManusV2ApiError("task.create", 503, "HTTP_503", true, false);
    });
    const sendMessage = vi.fn(async () => {
      timeline.push("provider:send");
    });
    const client = {
      createTask,
      sendMessage,
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => {
        throw new Error("fallback must not poll a provider task");
      }),
      listAllMessages: vi.fn(async () => {
        throw new Error("fallback must not read provider messages");
      }),
    };

    const contractJson = Buffer.from('{"contract":true}', "utf8");
    const sourceZip = Buffer.from("source-zip", "utf8");
    const distZip = Buffer.from("dist-zip", "utf8");
    const qaJson = Buffer.from('{"passed":true,"mode":"preview"}', "utf8");
    const visualQaZip = Buffer.from("visual-qa-zip", "utf8");
    const provenanceJson = Buffer.from('{"provenance":true}', "utf8");
    const materialized = {
      contract: { specHash: "9".repeat(64) },
      buildDelivery: {
        renderMode: "primary",
        qaStatus: "passed",
        warningCodes: [],
      },
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
              sections: expect.arrayContaining([
                expect.objectContaining({
                  slotId: "overview",
                  paragraphs: ["星河智造提供设备服务。"],
                  sourceDocumentIds: ["overview"],
                }),
              ]),
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

    remotePreview.fetchPinnedPublicHttps.mockReset();

    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: getCredential as never,
      createClient,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
      materializeSite,
      persistArtifact: persistArtifact as never,
    });
    const sweep = (operation: typeof buildOperation) =>
      handler({
        operation: operation as never,
        signal: new AbortController().signal,
        assertLeaseActive,
      });

    const created = await sweep(buildOperation);
    expect(created).toMatchObject({
      status: "pending",
      providerTaskId: fallbackTaskId,
      result: {
        stage: "content_pending",
        taskId: fallbackTaskId,
        providerDraftUnavailable: true,
        design: {
          designSpec: {
            schemaVersion: 2,
            routeCompositions: [expect.objectContaining({ routeId: "home" })],
          },
        },
      },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      agentProfile: "manus-1.6",
    });
    expect(createTask.mock.calls[0]![0].prompt).toContain("SiteContentDraftV1");
    expect(createTask.mock.calls[0]![0].prompt).not.toContain("SiteDesignWire");
    expect(
      JSON.stringify(createTask.mock.calls[0]![0].structuredOutputSchema),
    ).not.toMatch(/(?:layoutArchetype|routeSlots|palette|component)/u);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(materializeSite).not.toHaveBeenCalled();

    timeline.length = 0;
    const leaseCallsBeforeFinal = assertLeaseActive.mock.calls.length;
    const finished = await sweep(
      operationWithState(
        buildOperation,
        fallbackTaskId,
        created.result,
      ) as never,
    );

    expect(finished).toMatchObject({
      status: "succeeded",
      providerTaskId: fallbackTaskId,
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
    expect(remotePreview.fetchPinnedPublicHttps).not.toHaveBeenCalled();
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
    expect(sendMessage).not.toHaveBeenCalled();
    expect(context.build.repairAttempts).toBe(0);
    expect(getCredential).toHaveBeenCalledTimes(2);
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

  it("binds the selected V5 source ZIP through Manus receipt, native materialization, and persisted preview", async () => {
    const selectedIndex = 7;
    const sourceArchives = new Map<string, Buffer>();
    const candidates = [];
    for (let index = 0; index < 9; index += 1) {
      const label = String.fromCharCode(65 + index);
      const candidateId = `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const providerItemKey = `n:${index + 1}`;
      const source = normalizeTwentyFirstNativeSource({
        candidate: { providerItemId: index + 1, providerItemKey } as never,
        payload: {
          id: index + 1,
          version: `v${index + 1}`,
          componentCode: `import React from "react";export default function Native${label}(){return <main>Native ${label}</main>}`,
          demoCode: `import React from "react";import Native from "./component";export default function Demo${label}(){return <Native/>}`,
          globalsCss: `body{--candidate:${index + 1}}`,
          dependencies: ["react@19.2.1", "react-dom@19.2.1"],
        },
      });
      const sourceArchive = await createNativeSourceArchive(source);
      sourceArchives.set(candidateId, sourceArchive);
      const referencePreviewSha256 = sha256(`reference-${label}`);
      const evidence = createVisualEvidenceV1({
        evidenceKind: "catalog_metadata_preview_v1",
        providerItemKey,
        metadataSha256: sha256(`metadata-${label}`),
        providerResponseSha256: sha256(`response-${label}`),
        previewSha256: referencePreviewSha256,
        taxonomyDerivationVersion: "catalog-metadata-preview-v1",
      });
      candidates.push({
        id: candidateId,
        label,
        queryAxis: "foundation_split" as const,
        providerItemId: String(index + 1),
        providerItemKey,
        providerVersion: `v${index + 1}`,
        title: `Native ${label}`,
        description: null,
        author: null,
        sourceUrl: `https://21st.dev/community/components/${index + 1}`,
        visualEvidence: evidence,
        referencePreviewLocalAssetId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        referencePreviewSha256,
        referencePerceptualHash: sha256(`phash-${label}`).slice(0, 16),
        previewLocalAssetId: `80000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        previewSha256: sha256(`native-preview-${label}`),
        taxonomy: {
          role: "foundation" as const,
          palette: ["#ffffff", "#111111"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        score: 90 - index,
        rationale: "真实原生源码候选",
        sourceTreeSha256: source.sourceTreeSha256,
        sourceArchiveSha256: sha256(sourceArchive),
        sourceArchivePath: `candidates/${label}/source.zip`,
        entrypoint: source.entrypoint,
        demoEntrypoint: source.demoEntrypoint,
        sourceDirectory: "source" as const,
      });
    }
    const selected = candidates[selectedIndex]!;
    const bundle = visualSelectionBundleV5Schema.parse({
      schemaVersion: 5,
      renderer: "twenty_first_native_react_v1",
      queryPlanHash: sha256("native-query-plan"),
      searchTarget: 162,
      displayTarget: 9,
      candidates,
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const selectionBytes = await createVisualSelectionBundleV5Artifact({
      bundle,
      sourceArchives,
    });

    const finalZip = new JSZip();
    finalZip.file(
      "package.json",
      JSON.stringify({
        type: "module",
        dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
      }),
    );
    finalZip.file(
      "index.html",
      '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    );
    finalZip.file(
      "src/main.tsx",
      'import React from "react";import{createRoot}from"react-dom/client";createRoot(document.getElementById("root")!).render(<main>企业官网</main>);',
    );
    const finalSourceZip = await finalZip.generateAsync({ type: "nodebuffer" });
    const finalSourceSha256 = sha256(finalSourceZip);
    const operationToken = `siteops-native-source:${baseOperation.id}:0`;
    const selectedBaseSha256 = selected.sourceArchiveSha256;
    const receipt = {
      operationToken,
      baseSourceSha256: selectedBaseSha256,
      archiveSha256: finalSourceSha256,
      fileCount: 3,
    };
    const context = {
      build: {
        id: baseOperation.buildId,
        projectId: baseOperation.projectId,
        userId: baseOperation.userId,
        knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
        knowledgeArchiveHash: "a".repeat(64),
        workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_5.upstreamVersion,
        workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_5.upstreamSha256,
        workflowVersion: SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
        workflowPackageHash: SITEOPS_MATERIALIZER_V2_5.runtimeManifestSha256,
        starterVersion: SITEOPS_MATERIALIZER_V2_5.starterVersion,
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
        selectionHash: sha256("native-selection"),
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
        id: selected.id,
        batchId: "70000000-0000-4000-8000-000000000007",
        previewLocalAssetId: selected.previewLocalAssetId,
        sourceMetadata: {
          schemaVersion: 5,
          renderer: "twenty_first_native_react_v1",
          providerItemKey: selected.providerItemKey,
          providerVersion: selected.providerVersion,
          sourceTreeSha256: selected.sourceTreeSha256,
          sourceArchiveSha256: selected.sourceArchiveSha256,
          visualEvidence: selected.visualEvidence,
          taxonomy: selected.taxonomy,
        },
      },
      batch: {
        selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
        selectionBundleHash: sha256(selectionBytes),
      },
    };
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
            if (!("result" in values)) Object.assign(context.build, values);
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };
    const taskId = "native-manus-task";
    const createTask = vi.fn(async () => ({ taskId }));
    const client = {
      createTask,
      sendMessage: vi.fn(),
      findCreatedTask: vi.fn(),
      taskDetail: vi.fn(async () => ({ status: "stopped" })),
      listAllMessages: vi.fn(async () => [
        operationMarker(operationToken, 0),
        {
          id: "native-receipt",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: { success: true, value: receipt },
        },
        {
          id: "native-source",
          type: "assistant_message",
          timestamp: 2,
          assistant_message: {
            content: "完整源码已返回。",
            attachments: [
              {
                filename: "frontmind-site-source-v1.zip",
                content_type: "application/zip",
                url: `data:application/zip;base64,${finalSourceZip.toString("base64")}`,
              },
            ],
          },
        },
        {
          id: "native-stopped",
          type: "status_update",
          timestamp: 3,
          status_update: { agent_status: "stopped" },
        },
      ]),
    };
    const contractJson = Buffer.from(
      JSON.stringify({ contractKind: "twenty_first_native_build_contract" }),
    );
    const distZip = Buffer.from("native-dist");
    const qaJson = Buffer.from(
      JSON.stringify({ passed: true, mode: "preview" }),
    );
    const qaZip = Buffer.from("native-qa");
    const provenanceJson = Buffer.from("{}\n");
    const materialized = {
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip: finalSourceZip,
      sourceSha256: finalSourceSha256,
      distZip,
      distSha256: sha256(distZip),
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip: qaZip,
      visualQaSha256: sha256(qaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog: Buffer.from("ok"),
      files: new Map<string, Buffer>(),
      buildDelivery: {
        renderMode: "twenty_first_native" as const,
        qaStatus: "passed" as const,
        warningCodes: [],
      },
    };
    const materializeNativeSite = vi.fn(async (input: any) => {
      expect(input.sourceZip.equals(finalSourceZip)).toBe(true);
      expect(input.mode).toBe("preview");
      return materialized as never;
    });
    const persistArtifact = vi.fn(
      async (input: { kind: string; buffer: Buffer }) => ({
        id: `asset-${input.kind}`,
        contentSha256: sha256(input.buffer),
      }),
    );
    const readArtifact = vi.fn(async () => ({
      row: {
        id: context.batch.selectionBundleLocalAssetId,
        scope: "managed_user",
        accountUserId: baseOperation.userId,
        storageKey: `siteops:${baseOperation.projectId}:native-selection`,
        mimeType: "application/zip",
        contentSha256: context.batch.selectionBundleHash,
        sizeBytes: selectionBytes.length,
      },
      stored: {
        sizeBytes: selectionBytes.length,
        createReadStream: () => Readable.from([selectionBytes]),
      },
    }));
    const handler = createManusSiteOpsProviderHandler({
      getDb: async () => db as never,
      getCredential: vi.fn(async () => ({
        id: baseOperation.input.manusCredentialId,
        userId: baseOperation.userId,
        version: baseOperation.input.manusCredentialVersion,
        apiKey: "customer-personal-key",
      })) as never,
      createClient: () => client as never,
      readSnapshotArchive: async () => Buffer.from("x"),
      readArtifact: readArtifact as never,
      materializeNativeSite,
      persistArtifact: persistArtifact as never,
    });
    const assertLeaseActive = vi.fn(async () => undefined);
    const created = await handler({
      operation: baseOperation as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(created).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: { stage: "native_source_pending", nativeRepairAttempt: 0 },
    });
    const createInput = createTask.mock.calls[0]![0] as any;
    expect(createInput.prompt).toContain("不是视觉设计师");
    expect(createInput.prompt).toContain(selectedBaseSha256);
    const baseAttachment = createInput.attachments.find(
      (item: any) => item.filename === "frontmind-selected-21st-source-v1.zip",
    );
    expect(
      Buffer.from(baseAttachment.file_data.split(",", 2)[1], "base64").equals(
        sourceArchives.get(selected.id)!,
      ),
    ).toBe(true);

    const finished = await handler({
      operation: operationWithState(
        baseOperation,
        taskId,
        created.result,
      ) as never,
      signal: new AbortController().signal,
      assertLeaseActive,
    });
    expect(finished).toMatchObject({
      status: "succeeded",
      projectStatus: "preview_ready",
      buildStatus: "preview_ready",
      result: {
        buildId: baseOperation.buildId,
        distHash: materialized.distSha256,
        buildDelivery: { renderMode: "twenty_first_native" },
      },
    });
    expect(materializeNativeSite).toHaveBeenCalledTimes(1);
    expect(persistArtifact).toHaveBeenCalledTimes(5);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
