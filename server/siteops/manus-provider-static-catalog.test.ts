import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { VisualSelectionBundleV7 } from "../../shared/siteops";
import { ManusV2ApiError } from "../manus-v2-client";
import { siteOpsArtifactIdForIdempotency } from "./artifact-store";
import {
  FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_VERSION,
  NATIVE_RUNTIME_ROUTE_MODULE,
} from "./native-react-source";

const catalogMocks = vi.hoisted(() => ({
  requireActiveStaticTemplateCatalog: vi.fn(),
  requireStaticTemplateCatalogVersion: vi.fn(),
  openStaticTemplateCatalogVersionSource: vi.fn(),
  staticTemplateAdmissionEvidenceSha256: vi.fn(
    (input: { rawSourceSha256: string }) => input.rawSourceSha256,
  ),
}));

// This unit exercises catalog selection and transport only. Keep heavyweight
// browser build runtimes out of the module graph so it can run without a
// Playwright browser installation.
vi.mock("./build-runtime", () => ({}));
vi.mock("./native-react-build-runtime", () => ({
  NativeReactBuildError: class NativeReactBuildError extends Error {},
}));
vi.mock("./native-visual-source", () => ({
  SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION: "2.7.0",
  SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION: "2.5.0",
  SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION: "2.8.0",
  VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE:
    "application/vnd.frontmind.visual-selection-bundle-v5+zip",
  VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES: 192 * 1024 * 1024,
  VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES: 52 * 1024 * 1024,
}));

vi.mock("./static-template-catalog", () => ({
  STATIC_TEMPLATE_SOURCE_MAX_BYTES: 192 * 1024 * 1024,
  requireActiveStaticTemplateCatalog:
    catalogMocks.requireActiveStaticTemplateCatalog,
  requireStaticTemplateCatalogVersion:
    catalogMocks.requireStaticTemplateCatalogVersion,
  openStaticTemplateCatalogVersionSource:
    catalogMocks.openStaticTemplateCatalogVersionSource,
  staticTemplateAdmissionEvidenceSha256:
    catalogMocks.staticTemplateAdmissionEvidenceSha256,
}));

import {
  createNativeSourceRuntimeRegistry,
  createManusSiteOpsProviderHandler,
  nativeSourceSystemPromptForWorkflow,
  nativeTemplateCoordinateDirective,
  selectedStaticNativeSourceArchive,
  type NativeSourceRuntimeRegistry,
  type NativeSourceRuntimeRegistryEntry,
} from "./manus-provider";

const HASH = "a".repeat(64);
const PREVIEW_HASH = "b".repeat(64);
const COMMIT = "c".repeat(40);
const CATALOG_VERSION = "frontmind-static-template-catalog-v1";

function candidate(
  index: number,
  source: { bytes: number; sha256: string } = {
    bytes: 64 * 1024 * 1024,
    sha256: HASH,
  },
) {
  const order = index + 1;
  const catalogCandidateId = `static-template-${String(order).padStart(2, "0")}-template-${order}`;
  const rawSourceSha256 = createHash("sha256")
    .update(`raw-static-source-${order}`, "utf8")
    .digest("hex");
  const evidenceHash = (kind: string) =>
    createHash("sha256")
      .update(`${kind}:${catalogCandidateId}`, "utf8")
      .digest("hex");
  return {
    id: `sample-${order}`,
    sampleId: `sample-${order}`,
    label: String.fromCharCode(65 + index),
    title: `Template ${order}`,
    description: null,
    catalogVersion: CATALOG_VERSION,
    catalogPosition: order,
    catalogCandidateId,
    providerTemplateId: `provider/template-${order}`,
    providerSlug: `template-${order}`,
    providerVersion: COMMIT,
    sourceOwner: "provider",
    sourceRepo: "templates",
    sourceCommitSha: COMMIT,
    sourceSubdirectory: `templates/template-${order}`,
    sourceLicense: "MIT" as const,
    sourceAssetId: `${CATALOG_VERSION}/source/${catalogCandidateId}`,
    sourceArchiveSha256: source.sha256,
    sourceArchiveBytes: source.bytes,
    previewAssetId: `${CATALOG_VERSION}/preview/${catalogCandidateId}`,
    previewSha256: PREVIEW_HASH,
    previewMimeType: "image/png" as const,
    previewWidth: 1440,
    previewHeight: 900,
    executionAdmission: {
      status: "admitted" as const,
      rawSourceSha256,
      normalizedSourceSha256: source.sha256,
      sourceTreeSha256: evidenceHash("tree"),
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      deliveryContractSha256: evidenceHash("delivery-contract"),
      distSha256: evidenceHash("dist"),
      qaSha256: evidenceHash("qa"),
      browserReceiptSha256: evidenceHash("browser"),
      qaStatus: "passed" as const,
      admissionEvidenceSha256: rawSourceSha256,
    },
  };
}

function bundle(): VisualSelectionBundleV7 {
  return {
    schemaVersion: 7,
    renderer: "frontmind_static_template_catalog_v1",
    workflowVersion: "2.8.0",
    catalogVersion: CATALOG_VERSION,
    pageNumber: 1,
    pageSize: 8,
    pageCount: 4,
    displayTarget: 8,
    candidates: Array.from({ length: 8 }, (_, index) => ({
      ...candidate(index, {
        bytes: 64 * 1024 * 1024,
        sha256:
          index === 0
            ? HASH
            : createHash("sha256")
                .update(`static-source-${index}`, "utf8")
                .digest("hex"),
      }),
      previewSha256:
        index === 0
          ? PREVIEW_HASH
          : createHash("sha256")
              .update(`static-preview-${index}`, "utf8")
              .digest("hex"),
    })),
    selectedCandidateId: null,
    delegated: false,
    degradedReasons: [],
  };
}

function entryFor(selected: ReturnType<typeof candidate>) {
  const admission = selected.executionAdmission;
  return {
    order: selected.catalogPosition,
    page: 1,
    pageIndex: selected.catalogPosition - 1,
    candidateId: selected.catalogCandidateId,
    providerTemplateId: selected.providerTemplateId,
    providerSlug: selected.providerSlug,
    providerName: selected.title,
    providerDescription: selected.title,
    providerVersion: selected.providerVersion,
    sourceOwner: selected.sourceOwner,
    sourceRepo: selected.sourceRepo,
    sourceCommitSha: selected.sourceCommitSha,
    sourceSubdirectory: selected.sourceSubdirectory,
    sourceLicense: selected.sourceLicense,
    rawSourceAssetId: `${CATALOG_VERSION}/raw-source/${selected.catalogCandidateId}`,
    rawSourcePath: `raw-sources/${selected.catalogCandidateId}.zip`,
    rawSourceSha256: admission.rawSourceSha256,
    rawSourceBytes: selected.sourceArchiveBytes + 1,
    rawSourceFileCount: 110,
    rawSourceExpandedBytes: 130 * 1024 * 1024,
    sourceAssetId: selected.sourceAssetId,
    sourcePath: `sources/${selected.catalogCandidateId}.zip`,
    sourceSha256: selected.sourceArchiveSha256,
    sourceBytes: selected.sourceArchiveBytes,
    sourceFileCount: 100,
    sourceExpandedBytes: 128 * 1024 * 1024,
    previewAssetId: selected.previewAssetId,
    previewPath: `previews/${selected.catalogCandidateId}.png`,
    previewSha256: selected.previewSha256,
    previewBytes: 1_024,
    previewMimeType: selected.previewMimeType,
    previewWidth: selected.previewWidth,
    previewHeight: selected.previewHeight,
    tags: [],
    executionAdmission: {
      status: "admitted" as const,
      binding: {
        catalogVersion: selected.catalogVersion,
        candidateId: selected.catalogCandidateId,
        rawSourceSha256: admission.rawSourceSha256,
      },
      framework: "vite_react" as const,
      normalizedSourceAssetId: selected.sourceAssetId,
      normalizedSourcePath: `sources/${selected.catalogCandidateId}.zip`,
      normalizedSourceSha256: selected.sourceArchiveSha256,
      normalizedSourceBytes: selected.sourceArchiveBytes,
      normalizedSourceFileCount: 100,
      normalizedSourceExpandedBytes: 128 * 1024 * 1024,
      sourceTreeSha256: admission.sourceTreeSha256,
      runtimeContractSha256: admission.runtimeContractSha256,
      executionShellSha256: admission.executionShellSha256,
      deliveryContractAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/delivery-contract`,
      deliveryContractPath: `admissions/${selected.catalogCandidateId}/delivery-contract.json`,
      deliveryContractSha256: admission.deliveryContractSha256,
      deliveryContractBytes: 1024,
      distAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/dist`,
      distPath: `admissions/${selected.catalogCandidateId}/dist.zip`,
      distSha256: admission.distSha256,
      distBytes: 2048,
      qaAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/qa`,
      qaPath: `admissions/${selected.catalogCandidateId}/qa.json`,
      qaSha256: admission.qaSha256,
      qaBytes: 1024,
      browserReceiptAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/browser`,
      browserReceiptPath: `admissions/${selected.catalogCandidateId}/browser.json`,
      browserReceiptSha256: admission.browserReceiptSha256,
      browserReceiptBytes: 1024,
      qaStatus: admission.qaStatus,
      admissionEvidenceSha256: admission.admissionEvidenceSha256,
    },
  };
}

const temporaryRoots: string[] = [];

async function sha256File(sourcePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(sourcePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function testRuntimeEntry(label: "a" | "b"): NativeSourceRuntimeRegistryEntry {
  const hash = (kind: string) =>
    createHash("sha256").update(`${label}:${kind}`, "utf8").digest("hex");
  const coordinates = {
    contractVersion: `test-runtime-contract-${label}`,
    contractSha256: hash("contract"),
    executionShellVersion: `test-runtime-shell-${label}`,
    executionShellSha256: hash("shell"),
    preflightVersion: `test-runtime-preflight-${label}`,
    preflightSha256: hash("preflight"),
  };
  return {
    coordinates,
    attachments: ["contract", "shell", "preflight"].map((kind) => ({
      filename: `runtime-${label}-${kind}.json`,
      mime_type: "application/json",
      file_data: `data:application/json;base64,${Buffer.from(`${label}:${kind}`).toString("base64")}`,
    })),
    receiptSchema: z
      .object({
        operationToken: z.string(),
        baseSourceSha256: z.string(),
        archiveSha256: z.string(),
        fileCount: z.number().int(),
        preflightVersion: z.literal(coordinates.preflightVersion),
        preflightStatus: z.literal("passed"),
        preflightSha256: z.literal(coordinates.preflightSha256),
        runtimeContractVersion: z.literal(coordinates.contractVersion),
        runtimeContractSha256: z.literal(coordinates.contractSha256),
        executionShellSha256: z.literal(coordinates.executionShellSha256),
        executionBaselineSha256: z.string(),
      })
      .strict(),
    validate: vi.fn(async () => {
      throw new Error("TEST_RUNTIME_VALIDATOR_MUST_NOT_RUN");
    }),
    audit: vi.fn(() => ({ ok: true, issues: [] })),
  };
}

function nativeResultEvents(input: {
  operationToken: string;
  receipt: Record<string, unknown>;
  archive: Buffer;
}) {
  const timestamp = Date.now();
  return [
    {
      id: `marker:${input.operationToken}`,
      type: "user_message",
      timestamp,
      user_message: {
        content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: input.operationToken })}`,
      },
    },
    {
      id: `receipt:${input.operationToken}`,
      type: "structured_output_result",
      timestamp: timestamp + 1,
      structured_output_result: { success: true, value: input.receipt },
    },
    {
      id: `source:${input.operationToken}`,
      type: "assistant_message",
      timestamp: timestamp + 2,
      assistant_message: {
        content: "source",
        attachments: [
          {
            filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
            content_type: "application/zip",
            url: `data:application/zip;base64,${input.archive.toString("base64")}`,
          },
        ],
      },
    },
    {
      id: `stopped:${input.operationToken}`,
      type: "status_update",
      timestamp: timestamp + 3,
      status_update: { agent_status: "stopped" },
    },
  ];
}

async function createProviderHarness(input: {
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  failCreateUnknownOnce?: boolean;
  createOutcomeUnknownOnce?: boolean;
  createRetryableOnce?: boolean;
  sendOutcomeUnknownOnce?: boolean;
  sendRetryableOnce?: boolean;
  feedback?: string;
  nativeSourceRuntimeRegistry?: NativeSourceRuntimeRegistry;
  materializeNativeSite?: (input: any) => Promise<any>;
  persistArtifact?: (input: any) => Promise<any>;
}) {
  const selected = candidate(0, {
    bytes: input.sourceBytes,
    sha256: input.sourceSha256,
  });
  const staticBundle = bundle();
  staticBundle.candidates[0] = selected;
  const entry = entryFor(selected);
  catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
    catalogVersion: CATALOG_VERSION,
    entries: [entry],
  });
  catalogMocks.openStaticTemplateCatalogVersionSource.mockImplementation(
    async () => ({
      entry,
      path: input.sourcePath,
      stream: createReadStream(input.sourcePath),
    }),
  );

  const selectionBytes = Buffer.from(JSON.stringify(staticBundle), "utf8");
  const selectionSha256 = createHash("sha256")
    .update(selectionBytes)
    .digest("hex");
  const snapshotBytes = Buffer.from("x", "utf8");
  const snapshotSha256 = createHash("sha256")
    .update(snapshotBytes)
    .digest("hex");
  const operation = {
    id: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000002",
    userId: 7,
    conversationTurnId: null,
    buildId: "30000000-0000-4000-8000-000000000003",
    kind: "site_build",
    status: "running",
    clientRequestId: "request-static-template",
    inputHash: "d".repeat(64),
    input: {
      credentialScope: "customer",
      buildId: "30000000-0000-4000-8000-000000000003",
      manusCredentialId: "40000000-0000-4000-8000-000000000004",
      manusCredentialVersion: 9,
      agentProfile: "frontmind-base",
      ...(input.feedback ? { feedback: input.feedback } : {}),
    },
    provider: "manus",
    providerOperationId: null,
    providerTaskId: null,
    leaseOwner: "lease-static-template",
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
  const brief = {
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
  };
  const context = {
    build: {
      id: operation.buildId,
      projectId: operation.projectId,
      userId: operation.userId,
      knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
      knowledgeArchiveHash: snapshotSha256,
      workflowVersion: "2.8.0",
      brief,
      selectionHash: createHash("sha256")
        .update("static-selection", "utf8")
        .digest("hex"),
      repairAttempts: 0,
      parentBuildId: null,
      upstreamManusTaskId: null as string | null,
      contractLocalAssetId: null,
      sourceLocalAssetId: null,
      distLocalAssetId: null,
      qaLocalAssetId: null,
      provenanceLocalAssetId: null,
      status: "queued",
    },
    project: { id: operation.projectId },
    snapshot: {
      id: "50000000-0000-4000-8000-000000000005",
      userId: operation.userId,
      archiveHash: snapshotSha256,
      totalBytes: snapshotBytes.length,
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
      previewLocalAssetId: null,
      sourceMetadata: {
        schemaVersion: 7,
        renderer: staticBundle.renderer,
        workflowVersion: staticBundle.workflowVersion,
        ...selected,
      },
    },
    batch: {
      selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
      selectionBundleHash: selectionSha256,
    },
  };
  const query: any = {};
  query.from = () => query;
  query.innerJoin = () => query;
  query.where = () => query;
  query.limit = async () => [context];
  let persistedOperationResult: unknown = null;
  let failCreateUnknownOnce = input.failCreateUnknownOnce ?? false;
  const db = {
    select: () => query,
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if ("result" in values) {
            const state = values.result as { stage?: string };
            if (failCreateUnknownOnce && state.stage === "create_unknown") {
              failCreateUnknownOnce = false;
              throw new Error("SITEOPS_OPERATION_LEASE_LOST");
            }
            persistedOperationResult = values.result;
          } else {
            Object.assign(context.build, values);
          }
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };
  const uploadFile = vi.fn(async () => ({
    fileId: "provider-static-source",
    detail: { expiresAt: Math.floor(Date.now() / 1_000) + 60 * 60 },
  }));
  let createOutcomeUnknownOnce = input.createOutcomeUnknownOnce ?? false;
  let createRetryableOnce = input.createRetryableOnce ?? false;
  const createTask = vi.fn(async () => {
    if (createOutcomeUnknownOnce) {
      createOutcomeUnknownOnce = false;
      throw new ManusV2ApiError(
        "task.create",
        null,
        "TRANSPORT_UNKNOWN",
        true,
        true,
      );
    }
    if (createRetryableOnce) {
      createRetryableOnce = false;
      throw new ManusV2ApiError(
        "task.create",
        429,
        "HTTP_429",
        true,
        false,
        null,
        25_000,
      );
    }
    return { taskId: "static-manus-task" };
  });
  const findCreatedTask = vi.fn(async () => {
    const task = { id: "static-manus-task" };
    return {
      candidates: [task],
      matches: [task],
      unresolved: [],
      unresolvedEvidenceCount: 0,
      unique: task,
    };
  });
  let sendOutcomeUnknownOnce = input.sendOutcomeUnknownOnce ?? false;
  let sendRetryableOnce = input.sendRetryableOnce ?? false;
  const sendMessage = vi.fn(async () => {
    if (sendOutcomeUnknownOnce) {
      sendOutcomeUnknownOnce = false;
      throw new ManusV2ApiError(
        "task.sendMessage",
        null,
        "TRANSPORT_UNKNOWN",
        true,
        true,
      );
    }
    if (sendRetryableOnce) {
      sendRetryableOnce = false;
      throw new ManusV2ApiError(
        "task.sendMessage",
        429,
        "HTTP_429",
        true,
        false,
        null,
        25_000,
      );
    }
  });
  const client = {
    uploadFile,
    createTask,
    sendMessage,
    findCreatedTask,
    taskDetail: vi.fn(async () => ({ status: "running" })),
    listAllMessages: vi.fn(async () => []),
  };
  const handler = createManusSiteOpsProviderHandler({
    getDb: async () => db as never,
    getCredential: async () => ({
      id: operation.input.manusCredentialId,
      userId: operation.userId,
      version: operation.input.manusCredentialVersion,
      apiKey: "customer-personal-key",
    }),
    createClient: () => client as never,
    readSnapshotArchive: async () => snapshotBytes,
    readArtifact: async (artifactInput) =>
      (artifactInput.localAssetId === context.batch.selectionBundleLocalAssetId
        ? {
            row: {
              id: context.batch.selectionBundleLocalAssetId,
              scope: "managed_user",
              accountUserId: operation.userId,
              storageKey: `siteops:${operation.projectId}:static-selection`,
              mimeType: "application/json",
              contentSha256: selectionSha256,
              sizeBytes: selectionBytes.length,
            },
            stored: {
              sizeBytes: selectionBytes.length,
              createReadStream: () => Readable.from([selectionBytes]),
            },
          }
        : null) as never,
    materializeSite: vi.fn() as never,
    materializeNativeSite: (input.materializeNativeSite ?? vi.fn()) as never,
    materializeNativeTrustedFallbackSite: vi.fn() as never,
    persistArtifact: (input.persistArtifact ?? vi.fn()) as never,
    generateSocial: vi.fn() as never,
    ...(input.nativeSourceRuntimeRegistry
      ? { nativeSourceRuntimeRegistry: input.nativeSourceRuntimeRegistry }
      : {}),
  });
  return {
    client,
    context,
    createTask,
    getPersistedOperationResult: () => persistedOperationResult,
    handler,
    operation,
    selected,
    uploadFile,
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("V7 static Template Manus source", () => {
  it("uses the complete Template adaptation prompt without inventing an entrypoint coordinate", () => {
    expect(nativeSourceSystemPromptForWorkflow("2.8.0")).toBe(
      nativeSourceSystemPromptForWorkflow("2.7.0"),
    );
    expect(nativeSourceSystemPromptForWorkflow("2.8.0")).toContain(
      "不得把模板改造成通用卡片站",
    );
    const selected = candidate(0);
    const directive = nativeTemplateCoordinateDirective({
      bundle: { schemaVersion: 7 },
      candidate: selected,
    } as never);
    expect(directive).not.toBeNull();
    const encoded = directive!.attachment.file_data.split(",", 2)[1]!;
    const coordinate = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(coordinate).toMatchObject({
      schemaVersion: 1,
      sourceFormat: "static_catalog_archive_v1",
      catalogVersion: CATALOG_VERSION,
      catalogCandidateId: selected.catalogCandidateId,
      sourceAssetId: selected.sourceAssetId,
      providerSlug: selected.providerSlug,
      sourceSubdirectory: selected.sourceSubdirectory,
      sourceArchiveSha256: selected.sourceArchiveSha256,
    });
    expect(coordinate).not.toHaveProperty("entrypoint");
    expect(coordinate).not.toHaveProperty("sourceRoot");
    expect(directive!.promptInstruction).toContain("从源码确定入口");
  });

  it("buffers a verified catalog source only when it is within the 20 MiB inline boundary", async () => {
    const sourceBytes = Buffer.from("verified-small-static-template", "utf8");
    const selected = candidate(0, {
      bytes: sourceBytes.byteLength,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    });
    const entry = entryFor(selected);
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-inline-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
      catalogVersion: CATALOG_VERSION,
      entries: [entry],
    });
    catalogMocks.openStaticTemplateCatalogVersionSource.mockResolvedValue({
      entry,
      path: sourcePath,
      stream: createReadStream(sourcePath),
    });

    const staticBundle = bundle();
    staticBundle.candidates[0] = selected;
    const result = await selectedStaticNativeSourceArchive({
      bundle: staticBundle,
      selectedCandidateId: selected.id,
    });

    expect(result.archiveBytes).toEqual(sourceBytes);
    expect(result.archiveByteLength).toBe(sourceBytes.byteLength);
    expect(result.archiveSha256).toBe(selected.sourceArchiveSha256);
  });

  it("streams the frozen 64 MiB catalog version after active switches and returns fresh streams", async () => {
    const selected = candidate(0);
    const entry = entryFor(selected);
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-source-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.truncate(selected.sourceArchiveBytes);
    await handle.close();
    catalogMocks.requireActiveStaticTemplateCatalog.mockResolvedValue({
      catalogVersion: "future-static-catalog-v2",
      entries: [],
    });
    catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
      catalogVersion: CATALOG_VERSION,
      entries: [entry],
    });
    catalogMocks.openStaticTemplateCatalogVersionSource.mockResolvedValue({
      entry,
      path: sourcePath,
      stream: createReadStream(sourcePath),
    });

    const result = await selectedStaticNativeSourceArchive({
      bundle: bundle(),
      selectedCandidateId: selected.id,
    });

    expect(result.archiveBytes).toBeNull();
    expect(result.archiveByteLength).toBe(64 * 1024 * 1024);
    expect(result.archiveSha256).toBe(HASH);
    expect(
      catalogMocks.requireStaticTemplateCatalogVersion,
    ).toHaveBeenCalledWith(CATALOG_VERSION);
    expect(
      catalogMocks.openStaticTemplateCatalogVersionSource,
    ).toHaveBeenCalledWith(CATALOG_VERSION, selected.catalogCandidateId);
    expect(
      catalogMocks.requireActiveStaticTemplateCatalog,
    ).not.toHaveBeenCalled();
    const first = result.createArchiveReadStream();
    const second = result.createArchiveReadStream();
    expect(first).not.toBe(second);
    first.destroy();
    second.destroy();
  });

  it("keeps a small V7 source inline when the provider task is created", async () => {
    const sourceBytes = Buffer.from("verified-inline-static-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-task-inline-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      feedback: "将首页 CTA 改为预约演示。",
    });

    const result = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: { stage: "native_source_pending" },
    });
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    expect(Array.from(createInput.prompt).length).toBeLessThanOrEqual(3_000);
    const sourceAttachment = createInput.attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-selected-21st-source-v1.zip",
    );
    expect(sourceAttachment).not.toHaveProperty("file_id");
    expect(
      Buffer.from(sourceAttachment.file_data.split(",", 2)[1], "base64"),
    ).toEqual(sourceBytes);
    expect(result.result).not.toHaveProperty("nativeInputProviderFile");
  });

  it("reconciles create outcome-unknown without creating a second task", async () => {
    const sourceBytes = Buffer.from("verified-inline-static-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-create-unknown-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      createOutcomeUnknownOnce: true,
    });

    const first = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(first).toMatchObject({
      status: "pending",
      result: {
        stage: "create_unknown",
        nativeSourceContractVersion: 2,
      },
    });

    const reconciled = await harness.handler({
      operation: {
        ...harness.operation,
        result: first.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(reconciled).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: {
        stage: "native_source_pending",
        taskId: "static-manus-task",
      },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    expect(harness.client.findCreatedTask).toHaveBeenCalledTimes(1);
    expect(harness.client.sendMessage).not.toHaveBeenCalled();
    expect(harness.client.taskDetail).not.toHaveBeenCalled();
    expect(harness.client.listAllMessages).not.toHaveBeenCalled();
  });

  it("retries a known retryable create rejection from a durable ready state", async () => {
    const sourceBytes = Buffer.from("verified-create-retry-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-create-retry-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      createRetryableOnce: true,
    });

    const first = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(first).toMatchObject({
      status: "pending",
      result: {
        stage: "native_input_ready",
        nativeSourceContractVersion: 2,
      },
    });
    expect(first.result).toHaveProperty("providerNextPollAt");
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    expect(harness.client.findCreatedTask).not.toHaveBeenCalled();

    const beforeRetry = await harness.handler({
      operation: {
        ...harness.operation,
        result: first.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(beforeRetry).toMatchObject({
      status: "pending",
      result: { stage: "native_input_ready" },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(1);

    const retried = await harness.handler({
      operation: {
        ...harness.operation,
        result: {
          ...first.result,
          providerNextPollAt: new Date(Date.now() - 1).toISOString(),
        },
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(retried).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: {
        stage: "native_source_pending",
        taskId: "static-manus-task",
      },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(2);
    expect(harness.client.findCreatedTask).not.toHaveBeenCalled();
  });

  it("replays frozen runtime A after deployment B becomes current", async () => {
    const sourceBytes = Buffer.from("verified-runtime-replay-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-runtime-replay-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();

    const runtimeA = testRuntimeEntry("a");
    const runtimeB = testRuntimeEntry("b");
    const deploymentA = createNativeSourceRuntimeRegistry({
      current: runtimeA,
      entries: [runtimeA, runtimeB],
    });
    const deploymentB = createNativeSourceRuntimeRegistry({
      current: runtimeB,
      entries: [runtimeA, runtimeB],
    });
    const operationToken =
      "siteops-native-source:10000000-0000-4000-8000-000000000001:0";
    const runtimeArchive = Buffer.from("runtime-a-provider-source", "utf8");
    const runtimeArchiveSha256 = createHash("sha256")
      .update(runtimeArchive)
      .digest("hex");
    const runtimeReceipt = {
      operationToken,
      baseSourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      archiveSha256: runtimeArchiveSha256,
      fileCount: 4,
      preflightVersion: runtimeA.coordinates.preflightVersion,
      preflightStatus: "passed",
      preflightSha256: runtimeA.coordinates.preflightSha256,
      runtimeContractVersion: runtimeA.coordinates.contractVersion,
      runtimeContractSha256: runtimeA.coordinates.contractSha256,
      executionShellSha256: runtimeA.coordinates.executionShellSha256,
      executionBaselineSha256: createHash("sha256")
        .update(sourceBytes)
        .digest("hex"),
    } as const;
    const runtimeFiles = new Map<string, Buffer>([
      ["package.json", Buffer.from('{"dependencies":{}}', "utf8")],
      ["index.html", Buffer.from('<div id="root"></div>', "utf8")],
      ["src/main.tsx", Buffer.from("export {};", "utf8")],
      [NATIVE_RUNTIME_ROUTE_MODULE, Buffer.from("export {};", "utf8")],
    ]);
    vi.mocked(runtimeA.validate).mockResolvedValue({
      receipt: runtimeReceipt,
      archiveSha256: runtimeArchiveSha256,
      sourceSha256: runtimeArchiveSha256,
      sourceZip: runtimeArchive,
      fileCount: runtimeFiles.size,
      htmlEntrypoint: "index.html",
      entrypoint: "src/main.tsx",
      packageJson: {},
      files: runtimeFiles,
    } as never);
    vi.mocked(runtimeB.audit).mockImplementation(() => {
      throw new Error("DEPLOYMENT_B_AUDITOR_MUST_NOT_RUN");
    });
    const artifactBytes = {
      contractJson: Buffer.from('{"contractKind":"test"}', "utf8"),
      distZip: Buffer.from("runtime-a-dist", "utf8"),
      qaJson: Buffer.from('{"passed":true,"mode":"preview"}', "utf8"),
      visualQaZip: Buffer.from("runtime-a-qa", "utf8"),
      provenanceJson: Buffer.from("{}\n", "utf8"),
    };
    const materializeNativeSite = vi.fn(async (materializeInput: any) => {
      expect(materializeInput.runtimeAudit).toBe(runtimeA.audit);
      expect(
        materializeInput.runtimeAudit({
          files: materializeInput.validatedSource.files,
          expectedRoutePaths: ["/"],
        }),
      ).toEqual({ ok: true, issues: [] });
      return {
        contractJson: artifactBytes.contractJson,
        contractSha256: createHash("sha256")
          .update(artifactBytes.contractJson)
          .digest("hex"),
        sourceZip: runtimeArchive,
        sourceSha256: runtimeArchiveSha256,
        distZip: artifactBytes.distZip,
        distSha256: createHash("sha256")
          .update(artifactBytes.distZip)
          .digest("hex"),
        qaJson: artifactBytes.qaJson,
        qaSha256: createHash("sha256")
          .update(artifactBytes.qaJson)
          .digest("hex"),
        visualQaZip: artifactBytes.visualQaZip,
        visualQaSha256: createHash("sha256")
          .update(artifactBytes.visualQaZip)
          .digest("hex"),
        provenanceJson: artifactBytes.provenanceJson,
        provenanceSha256: createHash("sha256")
          .update(artifactBytes.provenanceJson)
          .digest("hex"),
        buildLog: Buffer.from("ok", "utf8"),
        files: new Map(),
        buildDelivery: {
          renderMode: "twenty_first_native",
          qaStatus: "passed",
          warningCodes: [],
        },
      };
    });
    const persistArtifact = vi.fn(async (artifactInput: any) => ({
      id: siteOpsArtifactIdForIdempotency({
        userId: artifactInput.userId,
        projectId: artifactInput.projectId,
        kind: artifactInput.kind,
        idempotencyKey: artifactInput.idempotencyKey,
      }),
      contentSha256: createHash("sha256")
        .update(artifactInput.buffer)
        .digest("hex"),
      sizeBytes: artifactInput.buffer.length,
    }));
    let deployed = deploymentA;
    const registry: NativeSourceRuntimeRegistry = {
      get current() {
        return deployed.current;
      },
      resolve(coordinates) {
        return deployed.resolve(coordinates);
      },
    };
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      failCreateUnknownOnce: true,
      nativeSourceRuntimeRegistry: registry,
      materializeNativeSite,
      persistArtifact,
    });

    await expect(
      harness.handler({
        operation: harness.operation as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      }),
    ).rejects.toThrow("SITEOPS_OPERATION_LEASE_LOST");
    const frozen = harness.getPersistedOperationResult() as Record<
      string,
      unknown
    >;
    expect(frozen).toMatchObject({
      stage: "native_input_ready",
      nativeSourceContractVersion: 2,
      nativeSourceRuntimeCoordinates: runtimeA.coordinates,
    });

    deployed = deploymentB;
    const resumed = await harness.handler({
      operation: { ...harness.operation, result: frozen } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(resumed).toMatchObject({
      status: "pending",
      result: {
        nativeSourceRuntimeCoordinates: runtimeA.coordinates,
      },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    expect(
      createInput.attachments.some(
        (attachment: any) => attachment.filename === "runtime-a-contract.json",
      ),
    ).toBe(true);
    expect(
      createInput.attachments.some((attachment: any) =>
        String(attachment.filename).startsWith("runtime-b-"),
      ),
    ).toBe(false);
    expect(
      createInput.structuredOutputSchema.properties.runtimeContractSha256.enum,
    ).toEqual([runtimeA.coordinates.contractSha256]);

    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({
        operationToken,
        receipt: runtimeReceipt,
        archive: runtimeArchive,
      }),
    );
    const finished = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: "static-manus-task",
        result: resumed.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(finished).toMatchObject({
      status: "succeeded",
      projectStatus: "preview_ready",
      buildStatus: "preview_ready",
      result: {
        artifactBindings: {
          contract: expect.any(Object),
          source: expect.any(Object),
          dist: expect.any(Object),
          qa: expect.any(Object),
          provenance: expect.any(Object),
        },
      },
    });
    expect(runtimeA.validate).toHaveBeenCalledTimes(1);
    expect(runtimeA.audit).toHaveBeenCalledTimes(2);
    expect(runtimeB.audit).not.toHaveBeenCalled();
    expect(materializeNativeSite).toHaveBeenCalledTimes(1);
  });

  it("keeps a historical V1 task terminal and never sends a repair", async () => {
    const sourceBytes = Buffer.from("verified-v1-template", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-v1-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    const taskId = "historical-v1-task";
    harness.context.build.upstreamManusTaskId = taskId;
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const invalidArchive = Buffer.from("not-a-zip", "utf8");
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256: createHash("sha256").update(invalidArchive).digest("hex"),
      fileCount: 1,
    };
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({ operationToken, receipt, archive: invalidArchive }),
    );
    const state = {
      schemaVersion: 2,
      stage: "native_source_pending",
      taskId,
      attempts: {
        extraction: 0,
        design: 0,
        content: 0,
        materialization: 0,
      },
      nativeRepairAttempt: 0,
      phaseOperationToken: operationToken,
      buildPhase: "source_waiting",
    };

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: state,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "NATIVE_SOURCE_ZIP_INVALID",
    });
    expect(harness.client.sendMessage).not.toHaveBeenCalled();
    expect(harness.createTask).not.toHaveBeenCalled();
    expect(harness.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps V2 repair on the frozen runtime and reconciles an unknown send without resending", async () => {
    const sourceBytes = Buffer.from("verified-v2-template", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-v2-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
      sendOutcomeUnknownOnce: true,
    });
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(created.status).toBe("pending");
    const frozenCoordinates = (created.result as any)
      .nativeSourceRuntimeCoordinates;
    const taskId = String(created.providerTaskId);
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const invalidArchive = Buffer.from("not-a-v2-zip", "utf8");
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256: createHash("sha256").update(invalidArchive).digest("hex"),
      fileCount: 1,
      preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
      preflightStatus: "passed",
      preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      executionBaselineSha256: sourceSha256,
    };
    const baselineEvents = nativeResultEvents({
      operationToken,
      receipt,
      archive: invalidArchive,
    });
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(baselineEvents);

    const repairUnknown = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    expect(repairUnknown).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_send_unknown",
        nativeSourceContractVersion: 2,
        nativeSourceRuntimeCoordinates: frozenCoordinates,
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        buildPhase: "source_repairing",
      },
    });
    const persistedRepairUnknown = JSON.parse(
      JSON.stringify(repairUnknown.result),
    );
    expect(persistedRepairUnknown).not.toHaveProperty("nativeSourceFileId");
    expect(persistedRepairUnknown).not.toHaveProperty(
      "nativeSourceAttachmentScope",
    );
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    const repairInput = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(Array.from(repairInput.prompt).length).toBeLessThanOrEqual(3_000);
    expect(
      repairInput.structuredOutputSchema.properties.runtimeContractSha256.enum,
    ).toEqual([frozenCoordinates.contractSha256]);

    harness.client.taskDetail.mockResolvedValue({ status: "running" });
    harness.client.listAllMessages.mockResolvedValue(baselineEvents);
    const reconciled = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: repairUnknown.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(reconciled).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_send_unknown",
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        nativeSourceRuntimeCoordinates: frozenCoordinates,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.createTask).toHaveBeenCalledTimes(1);
  });

  it("repairs an aggregate V2 route-manifest mismatch before materialization", async () => {
    const sourceBytes = Buffer.from("verified-v2-route-baseline", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-route-repair-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    (harness.context.build.brief.routes as Array<Record<string, unknown>>).push(
      {
        id: "about",
        slug: "/about/",
        title: "关于我们",
        sourceDocumentIds: ["overview"],
      },
    );
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const taskId = String(created.providerTaskId);
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const sourceZip = new JSZip();
    for (const file of NATIVE_RUNTIME_EXECUTION_SHELL_V1.files) {
      sourceZip.file(file.path, file.text);
    }
    sourceZip.file(
      NATIVE_RUNTIME_ROUTE_MODULE,
      'import Home from "./home";\nexport const FRONTMIND_ROUTE_PATHS = ["/"] as const;\nexport default function FrontMindRoutes() { return <Home />; }\n',
    );
    sourceZip.file(
      "src/home.tsx",
      "export default function Home() { return <main>首页</main>; }\n",
    );
    const archive = await sourceZip.generateAsync({ type: "nodebuffer" });
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
      fileCount: NATIVE_RUNTIME_EXECUTION_SHELL_V1.files.length + 2,
      preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
      preflightStatus: "passed",
      preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      executionBaselineSha256: sourceSha256,
    };
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({ operationToken, receipt, archive }),
    );

    const repaired = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(repaired).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        buildPhase: "source_repairing",
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    const repairInput = harness.client.sendMessage.mock.calls[0]![0] as any;
    const diagnosticsAttachment = repairInput.attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-native-runtime-diagnostics-v1.json",
    );
    const diagnostics = JSON.parse(
      Buffer.from(
        diagnosticsAttachment.file_data.split(",", 2)[1],
        "base64",
      ).toString("utf8"),
    );
    expect(diagnostics).toMatchObject({
      attempt: 1,
      kind: "hard_safety",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "ROUTE_MANIFEST_MISMATCH" }),
      ]),
    });
  });

  it("resumes a persisted repair-send-ready phase without reusing prior intake state", async () => {
    const sourceBytes = Buffer.from("verified-v2-ready-replay", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-repair-ready-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const taskId = String(created.providerTaskId);
    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    const readyState = {
      ...(created.result as Record<string, unknown>),
      stage: "native_repair_send_ready",
      taskId,
      nativeRepairAttempt: 1,
      nativeLastErrorSignature: "f".repeat(64),
      nativeRepairInput: {
        attempt: 1,
        kind: "hard_safety",
        diagnostics: [
          {
            code: "NATIVE_SOURCE_ZIP_INVALID",
            file: null,
            line: null,
            column: null,
          },
        ],
      },
      nativeSourceFileId: undefined,
      nativeSourceAttachmentEventId: undefined,
      nativeSourceAttachmentIdentity: undefined,
      nativeSourceAttachmentScope: undefined,
      nativeSourceStaging: undefined,
      buildCheckpoint: undefined,
      phaseOperationToken: repairToken,
      phaseStartedAt: new Date().toISOString(),
      providerSyncStartedAt: new Date().toISOString(),
      buildPhase: "source_repairing",
    };

    const resumed = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: readyState,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(resumed).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        buildPhase: "source_repairing",
      },
    });
    expect(resumed.result).not.toHaveProperty("nativeRepairInput");
    expect(resumed.result).not.toHaveProperty("nativeSourceAttachmentIdentity");
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.client.taskDetail).not.toHaveBeenCalled();
    expect(harness.client.listAllMessages).not.toHaveBeenCalled();
  });

  it("returns an explicitly rejected retryable repair POST to durable send-ready", async () => {
    const sourceBytes = Buffer.from("verified-v2-ready-retry", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-repair-retry-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
      sendRetryableOnce: true,
    });
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const taskId = String(created.providerTaskId);
    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    const readyState = {
      ...(created.result as Record<string, unknown>),
      stage: "native_repair_send_ready",
      taskId,
      nativeRepairAttempt: 1,
      nativeLastErrorSignature: "e".repeat(64),
      nativeRepairInput: {
        attempt: 1,
        kind: "hard_safety",
        diagnostics: [
          {
            code: "NATIVE_SOURCE_ZIP_INVALID",
            file: null,
            line: null,
            column: null,
          },
        ],
      },
      phaseOperationToken: repairToken,
      phaseStartedAt: new Date().toISOString(),
      buildPhase: "source_repairing",
    };

    const retry = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: readyState,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(retry).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      nextPollMs: 25_000,
      result: {
        stage: "native_repair_send_ready",
        nativeRepairAttempt: 1,
        nativeRepairInput: { attempt: 1 },
        providerNextPollAt: expect.any(String),
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.client.taskDetail).not.toHaveBeenCalled();
    expect(harness.client.listAllMessages).not.toHaveBeenCalled();
  });

  it("persists and reuses a streamed V7 upload above 52 MiB across worker reclaim", async () => {
    const sourceBytes = 64 * 1024 * 1024;
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-task-stream-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.truncate(sourceBytes);
    await handle.close();
    const sourceSha256 = await sha256File(sourcePath);
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes,
      sourceSha256,
      failCreateUnknownOnce: true,
    });

    await expect(
      harness.handler({
        operation: harness.operation as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      }),
    ).rejects.toThrow("SITEOPS_OPERATION_LEASE_LOST");

    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.createTask).not.toHaveBeenCalled();
    const uploadInput = harness.uploadFile.mock.calls[0]![0] as any;
    expect(uploadInput).toMatchObject({
      filename: "frontmind-selected-21st-source-v1.zip",
      byteLength: sourceBytes,
      contentType: "application/zip",
    });
    expect(uploadInput).not.toHaveProperty("bytes");
    const firstUploadStream = uploadInput.createReadStream();
    const secondUploadStream = uploadInput.createReadStream();
    expect(firstUploadStream).not.toBe(secondUploadStream);
    expect(path.resolve(String(firstUploadStream.path))).toBe(
      path.resolve(sourcePath),
    );
    firstUploadStream.destroy();
    secondUploadStream.destroy();

    const uploadedState = harness.getPersistedOperationResult() as any;
    expect(uploadedState).toMatchObject({
      schemaVersion: 2,
      stage: "native_input_ready",
      nativeInputProviderFile: {
        sourceArchiveSha256: sourceSha256,
        bytes: sourceBytes,
        filename: "frontmind-selected-21st-source-v1.zip",
        fileId: "provider-static-source",
        status: "uploaded",
      },
    });
    expect(sourceBytes).toBeGreaterThan(52 * 1024 * 1024);

    const reclaimed = await harness.handler({
      operation: {
        ...harness.operation,
        result: uploadedState,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(reclaimed).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: {
        stage: "native_source_pending",
        nativeInputProviderFile: {
          bytes: sourceBytes,
          fileId: "provider-static-source",
        },
      },
    });
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    const sourceAttachment = createInput.attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-selected-21st-source-v1.zip",
    );
    expect(sourceAttachment).toEqual({
      file_id: "provider-static-source",
      filename: "frontmind-selected-21st-source-v1.zip",
    });

    await expect(
      harness.handler({
        operation: {
          ...harness.operation,
          providerTaskId: "static-manus-task",
          result: reclaimed.result,
        } as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      }),
    ).resolves.toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
    });
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.createTask).toHaveBeenCalledTimes(1);
  });

  it("rejects a V7 source asset coordinate before opening catalog bytes", async () => {
    const selected = candidate(0);
    const entry = entryFor(selected);
    catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
      catalogVersion: CATALOG_VERSION,
      entries: [entry],
    });
    const invalid = bundle();
    invalid.candidates[0] = {
      ...invalid.candidates[0],
      sourceAssetId: `${CATALOG_VERSION}/source/wrong-template`,
    };

    await expect(
      selectedStaticNativeSourceArchive({
        bundle: invalid,
        selectedCandidateId: selected.id,
      }),
    ).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
    });
    expect(
      catalogMocks.openStaticTemplateCatalogVersionSource,
    ).not.toHaveBeenCalled();
  });
});
