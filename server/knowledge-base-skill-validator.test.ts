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
          : "index",
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
  const discoveryMethods = [
    "img",
    "srcset",
    "lazy_load",
    "picture",
    "css_background",
    "open_graph",
    "gallery",
    "official_document",
  ];
  const overviewPath = "branches/products/00_overview.md";
  const overviewEvidencePath = "branches/products/evidence/overview.md";
  files[`${root}/${overviewEvidencePath}`] = "证".repeat(100);
  documents.push({
    id: "evidence-overview-products",
    path: overviewEvidencePath,
    kind: "evidence",
    title: "产品综述证据",
    branchId: "products",
    sourceIds: ["source-official"],
    assetIds: [],
    customerVisible: false,
  });
  files[`${root}/${overviewPath}`] = formalDocument(
    "产品与服务综述",
    "综".repeat(120),
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
    evidenceDocumentIds: ["evidence-overview-products"],
    assetIds: [],
    customerVisible: true,
    evidenceCharacters: 100,
    requiredFormalCharacters: 120,
    contentStatus: "limited_evidence",
  });
  for (let index = 0; index < 40; index += 1) {
    const leafPath = `branches/products/leaf-${index + 1}.md`;
    const evidencePath = `branches/products/evidence/leaf-${index + 1}.md`;
    const sourceId = `source-official-${index + 1}`;
    files[`${root}/${evidencePath}`] = String.fromCodePoint(
      0x3400 + index,
    ).repeat(100);
    documents.push({
      id: `evidence-leaf-${index + 1}`,
      path: evidencePath,
      kind: "evidence",
      title: `知识叶子 ${index + 1} 证据`,
      branchId: "products",
      sourceIds: [sourceId],
      assetIds: [],
      customerVisible: false,
    });
    files[`${root}/${leafPath}`] = formalDocument(
      `知识叶子 ${index + 1}`,
      String.fromCodePoint(0x4e00 + index).repeat(80),
    );
    documents.push({
      id: `leaf-${index + 1}`,
      path: leafPath,
      kind: "leaf",
      title: `知识叶子 ${index + 1}`,
      branchId: "products",
      productFamilyId: "family-a",
      order: index + 1,
      evidenceStatus: "verified_first_party",
      sourceIds: [sourceId],
      evidenceDocumentIds: [`evidence-leaf-${index + 1}`],
      assetIds: [],
      customerVisible: true,
      evidenceCharacters: 100,
      requiredFormalCharacters: 80,
      contentStatus: "limited_evidence",
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
    schemaVersion: 3,
    profile: "dashboard-enterprise-v1",
    documents,
    assets: [],
    counts: {
      totalFiles: documents.length + 2,
      customerVisibleCharacters: 3_320,
      evidenceCharacters: 4_100,
      packagedImages: 0,
    },
    imageSelection: {
      status: "source_limited",
      discoveredCandidateImages: 0,
      inspectedCandidateImages: 0,
      eligibleFirstPartyImages: 0,
      rejectedCandidateImages: 0,
      scannedSourcePages: 0,
      discoveryMethods,
      candidates: [],
      rejectionReasons: [],
      stopReason: "已检查所有官方页面和资料",
      productFamilyCoverage: [
        {
          familyId: "family-a",
          familyName: "产品族 A",
          officialImageAvailable: false,
          assetIds: [],
          checkedSources: ["https://example.com/products"],
          gapReason: "官方来源未提供可交付图片",
        },
      ],
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

  it("accepts evidence-limited prose below the writing target without padding", async () => {
    const archivePath = await writeArchive(validDeepArchiveFiles());

    const result = await runValidator(archivePath);

    expect(result.code).toBe(0);
  });

  it("rejects customer-facing audit language while allowing it in internal gaps", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    files[`${root}/branches/products/leaf-1.md`] = `# 知识叶子 1

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${"这些内容属于企业自我定义，不宜直接转换为已量化达成的影响。对客户而言，可将其落实为可观察行动。".repeat(4)}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-official
`;
    const completeness = JSON.parse(
      String(files[`${root}/00_completeness.json`]),
    );
    completeness.gaps = [
      "本轮没有形成可逐项核验的证书名称与有效期，待企业补充。",
    ];
    files[`${root}/00_completeness.json`] = JSON.stringify(completeness);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "customer-facing audit language or internal reasoning",
    );
  });

  it("rejects a rich evidence relationship reported as zero characters", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const overview = manifest.documents.find(
      (document: { id?: string }) => document.id === "overview-products",
    );
    overview.evidenceCharacters = 0;
    overview.requiredFormalCharacters = 60;
    overview.contentStatus = "needs_verification";
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "evidenceCharacters must equal validator-recomputed evidence characters 100",
    );
  });

  it("rejects a product family omitted from the media coverage audit", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    manifest.imageSelection.productFamilyCoverage = [];
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "productFamilyCoverage IDs must exactly match product/service leaf family IDs",
    );
  });

  it("rejects evidence duplicated after normalization", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const duplicatePath = "branches/products/evidence/copied-overview.md";
    files[`${root}/${duplicatePath}`] = "证， ".repeat(100);
    manifest.documents.push({
      id: "evidence-copied-overview",
      path: duplicatePath,
      kind: "evidence",
      title: "复制产品综述证据",
      branchId: "products",
      sourceIds: ["source-official"],
      assetIds: [],
      customerVisible: false,
    });
    manifest.counts.totalFiles += 1;
    manifest.counts.evidenceCharacters += 100;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("duplicate normalized evidence content");
  });

  it("rejects acquired evidence omitted from every formal document", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const omittedPath = "branches/products/evidence/omitted.md";
    files[`${root}/${omittedPath}`] = "未".repeat(100);
    manifest.documents.push({
      id: "evidence-omitted",
      path: omittedPath,
      kind: "evidence",
      title: "未整理证据",
      branchId: "products",
      sourceIds: ["source-official"],
      assetIds: [],
      customerVisible: false,
    });
    manifest.counts.totalFiles += 1;
    manifest.counts.evidenceCharacters += 100;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "v2 evidence document must be referenced by at least one overview/leaf",
    );
  });

  it("rejects referenced evidence without an explicit matching branchId", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    delete manifest.documents.find(
      (document: { id?: string }) =>
        document.id === "evidence-overview-products",
    ).branchId;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "must explicitly belong to the same branchId",
    );
  });

  it("uses productFamilyId instead of title keywords for product branches", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    for (const document of manifest.documents) {
      if (document.branchId === "products") document.branchId = "catalog-a";
      if (document.id === "overview-products") document.title = "核心目录";
    }
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).toBe(0);
  });

  it("rejects a product branch with a partially declared family", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    delete manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    ).productFamilyId;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "product/service branch leaf requires productFamilyId",
    );
  });

  it("rejects v2 without any product or service family", async () => {
    const files = validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    for (const document of manifest.documents) {
      delete document.productFamilyId;
    }
    manifest.imageSelection.productFamilyCoverage = [];
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "schema v2 must declare at least one product/service family",
    );
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
      schemaVersion: 2,
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
        status: "target_met",
        discoveredCandidateImages: 420,
        inspectedCandidateImages: 420,
        eligibleFirstPartyImages: 420,
        rejectedCandidateImages: 0,
        scannedSourcePages: 1,
        discoveryMethods: [
          "img",
          "srcset",
          "lazy_load",
          "picture",
          "css_background",
          "open_graph",
          "gallery",
          "official_document",
        ],
        rejectionReasons: [],
        stopReason: "已检查所有官方页面和资料",
        productFamilyCoverage: [],
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
        sourcePageUrl: "https://example.com/products",
        sourceAssetUrl: "https://example.com/assets/header-only.jpg",
        ownership: "first_party",
        assetType: "product_ui",
        displayRole: "inline",
      },
    ];
    manifest.counts.totalFiles += 1;
    manifest.counts.packagedImages = 1;
    manifest.imageSelection = {
      status: "source_limited",
      discoveredCandidateImages: 1,
      inspectedCandidateImages: 1,
      eligibleFirstPartyImages: 1,
      rejectedCandidateImages: 0,
      scannedSourcePages: 0,
      discoveryMethods: [
        "img",
        "srcset",
        "lazy_load",
        "picture",
        "css_background",
        "open_graph",
        "gallery",
        "official_document",
      ],
      candidates: [
        {
          url: "https://example.com/assets/header-only.jpg",
          sourcePageUrl: "https://example.com/products",
          method: "img",
          status: "eligible",
          assetId: "asset-header-only",
        },
      ],
      rejectionReasons: [],
      stopReason: "已检查所有官方页面和资料",
      productFamilyCoverage: [
        {
          familyId: "family-a",
          familyName: "产品族 A",
          officialImageAvailable: true,
          assetIds: ["asset-header-only"],
          checkedSources: ["https://example.com/products"],
        },
      ],
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
