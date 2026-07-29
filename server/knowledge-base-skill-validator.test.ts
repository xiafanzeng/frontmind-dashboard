import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const validatorPath = path.resolve(
  process.cwd(),
  "private-workflows/socratic-kb-builder/scripts/validate_archive.py",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function writeArchive(files: Record<string, string | Uint8Array>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frontmind-kb-validator-"),
  );
  temporaryDirectories.push(directory);
  const archivePath = path.join(directory, "fixture.zip");
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  await fs.writeFile(
    archivePath,
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  return archivePath;
}

async function runValidator(archivePath: string) {
  try {
    const result = await execFileAsync("python3", [validatorPath, archivePath]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return {
      code: error.code,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

function validDeepArchiveFiles() {
  const root = "fixture_knowledge_base";
  const supportingPaths = [
    "README.md",
    "00_knowledge_tree.md",
    "00_crawl_coverage_report.md",
    "00_web_intelligence_report.md",
    "00_source_index.md",
    "00_media_gaps.md",
    "09_media_assets/asset_inventory.md",
    "10_reference_assets/reference_asset_inventory.md",
  ];
  const documents: Array<Record<string, unknown>> = supportingPaths.map(
    (documentPath, index) => ({
      id: `support-${index + 1}`,
      path: documentPath,
      kind: documentPath.includes("report")
        ? "report"
        : documentPath.includes("index") || documentPath.includes("inventory")
          ? "index"
          : "evidence",
      title: documentPath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    }),
  );
  const files: Record<string, string | Uint8Array> = Object.fromEntries(
    supportingPaths.map((documentPath) => [`${root}/${documentPath}`, "# "]),
  );
  const formalDocument = (title: string, narrative: string) => `# ${title}

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-official
`;
  const overviewCharacters = 80_000 - 40 * 120;
  const overviewPath = "branches/products/00_overview.md";
  files[`${root}/${overviewPath}`] = formalDocument(
    "产品与服务综述",
    "综".repeat(overviewCharacters),
  );
  documents.push({
    id: "overview-products",
    path: overviewPath,
    kind: "overview",
    title: "产品与服务综述",
    branchId: "products",
    order: 0,
    evidenceStatus: "verified_first_party",
    sourceIds: ["source-official"],
    assetIds: [],
    customerVisible: true,
  });
  for (let index = 0; index < 40; index += 1) {
    const leafPath = `branches/products/leaf-${index + 1}.md`;
    files[`${root}/${leafPath}`] = formalDocument(
      `知识叶子 ${index + 1}`,
      String.fromCodePoint(0x4e00 + index).repeat(120),
    );
    documents.push({
      id: `leaf-${index + 1}`,
      path: leafPath,
      kind: "leaf",
      title: `知识叶子 ${index + 1}`,
      branchId: "products",
      order: index + 1,
      evidenceStatus: "verified_first_party",
      sourceIds: ["source-official"],
      assetIds: [],
      customerVisible: true,
    });
  }
  files[`${root}/00_completeness.json`] = JSON.stringify({
    counts: {
      totalLeaves: 40,
      verifiedFirstParty: 40,
      verifiedAuthoritative: 0,
      supportedThirdParty: 0,
      inferred: 0,
      needsVerification: 0,
      notApplicable: 0,
    },
    acquisition: {
      officialPages: { completed: 0, total: 0 },
      images: { completed: 0, total: 0 },
      documents: { completed: 0, total: 0 },
      webQueries: { completed: 0, total: 0 },
    },
    gaps: ["官网没有可用于交付的第一方图片"],
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  });
  files[`${root}/00_package_manifest.json`] = JSON.stringify({
    schemaVersion: 1,
    profile: "dashboard-enterprise-v1",
    documents,
    assets: [],
    counts: {
      totalFiles: documents.length + 2,
      customerVisibleCharacters: 80_000,
      evidenceCharacters: 0,
      packagedImages: 0,
    },
    imageSelection: {
      eligibleFirstPartyImages: 0,
      shortfallReason: "官网没有可用于交付的第一方图片",
    },
  });
  return files;
}

describe("dashboard enterprise Skill archive validator", () => {
  it("accepts a complete deep archive with an honest zero-image shortfall", async () => {
    const archivePath = await writeArchive(validDeepArchiveFiles());

    const result = await runValidator(archivePath);

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
  });

  it("rejects a legacy snapshot-shaped archive without the v2 contracts", async () => {
    const archivePath = await writeArchive({
      "CompletenessReport.json": "{}",
      "leaves/identity.md": "# 企业身份\n\n第一方原始快照：这是一个页面摘录。",
    });

    const result = await runValidator(archivePath);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "missing required file: 00_package_manifest.json",
    );
    expect(result.stderr).toContain(
      "missing required file: 00_completeness.json",
    );
  });

  it("rejects a manifest that reports images but packages no image bytes", async () => {
    const manifest = {
      schemaVersion: 1,
      profile: "dashboard-enterprise-v1",
      documents: [],
      assets: [],
      counts: {
        totalFiles: 7,
        customerVisibleCharacters: 120000,
        evidenceCharacters: 0,
        packagedImages: 420,
      },
      imageSelection: {
        eligibleFirstPartyImages: 420,
        shortfallReason: null,
      },
    };
    const archivePath = await writeArchive({
      "00_completeness.json": "{}",
      "00_package_manifest.json": JSON.stringify(manifest),
      "00_knowledge_tree.md": "# Tree",
      "00_crawl_coverage_report.md": "# Crawl",
      "00_web_intelligence_report.md": "# Web",
      "00_source_index.md": "# Sources",
      "00_media_gaps.md": "# Media",
    });

    const result = await runValidator(archivePath);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "420 eligible images require packaging 360–480",
    );
    expect(result.stderr).toContain("manifest.counts.packagedImages must be 0");
  });

  it("rejects a header-only image that cannot be decoded", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const imagePath = "09_media_assets/product_images/header-only.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    files[`${root}/${imagePath}`] = bytes;
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const overview = manifest.documents.find(
      (document: { id?: string }) => document.id === "overview-products",
    );
    overview.assetIds = ["asset-header-only"];
    manifest.assets = [
      {
        id: "asset-header-only",
        path: imagePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/jpeg",
        bytes: bytes.length,
        width: 1,
        height: 1,
        caption: "伪图片",
        branchId: "products",
        documentIds: ["overview-products"],
        ownership: "first_party",
      },
    ];
    manifest.counts.totalFiles += 1;
    manifest.counts.packagedImages = 1;
    manifest.imageSelection = {
      eligibleFirstPartyImages: 1,
      shortfallReason: "仅发现一张候选素材",
    };
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);
    const completeness = JSON.parse(
      String(files[`${root}/00_completeness.json`]),
    );
    completeness.acquisition.images = { completed: 1, total: 1 };
    files[`${root}/00_completeness.json`] = JSON.stringify(completeness);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `could not decode a valid image for ${imagePath}`,
    );
  });
});
