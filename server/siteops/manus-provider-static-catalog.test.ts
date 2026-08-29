import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisualSelectionBundleV7 } from "../../shared/siteops";

const catalogMocks = vi.hoisted(() => ({
  requireActiveStaticTemplateCatalog: vi.fn(),
  requireStaticTemplateCatalogVersion: vi.fn(),
  openStaticTemplateCatalogVersionSource: vi.fn(),
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
}));

import {
  createManusSiteOpsProviderHandler,
  nativeSourceSystemPromptForWorkflow,
  nativeTemplateCoordinateDirective,
  selectedStaticNativeSourceArchive,
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

async function createProviderHarness(input: {
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  failCreateUnknownOnce?: boolean;
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
  const createTask = vi.fn(async () => ({ taskId: "static-manus-task" }));
  const client = {
    uploadFile,
    createTask,
    sendMessage: vi.fn(),
    findCreatedTask: vi.fn(async () => ({ matches: [], unique: null })),
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
    readArtifact: async () =>
      ({
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
      }) as never,
    materializeSite: vi.fn() as never,
    materializeNativeSite: vi.fn() as never,
    materializeNativeTrustedFallbackSite: vi.fn() as never,
    persistArtifact: vi.fn() as never,
    generateSocial: vi.fn() as never,
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
    expect(directive!.promptInstruction).toContain("按原模板源码检查真实入口");
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
