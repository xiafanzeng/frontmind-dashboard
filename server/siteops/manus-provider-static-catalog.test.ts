import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  requireActiveStaticTemplateCatalog:
    catalogMocks.requireActiveStaticTemplateCatalog,
  requireStaticTemplateCatalogVersion:
    catalogMocks.requireStaticTemplateCatalogVersion,
  openStaticTemplateCatalogVersionSource:
    catalogMocks.openStaticTemplateCatalogVersionSource,
}));

import {
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
    candidates: Array.from({ length: 8 }, (_, index) => candidate(index)),
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
