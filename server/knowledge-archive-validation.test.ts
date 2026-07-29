import { createHash } from "node:crypto";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeArchiveValidationError,
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";

const storedKeys: string[] = [];
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg1EwEAAC6AIxr7t1xAAAAAElFTkSuQmCC",
  "base64",
);

afterEach(async () => {
  await removeStoredKnowledgeAssets(storedKeys.splice(0));
});

type ArchiveOptions = {
  imageCount?: number;
  claimedImageCount?: number;
  customerCharacters?: number;
  duplicateImageBytes?: boolean;
  invalidImage?: boolean;
  malformedRaster?: "jpeg" | "webp" | "avif";
  rawSvg?: boolean;
};

function headerOnlyRaster(kind: "jpeg" | "webp" | "avif") {
  if (kind === "jpeg") return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const bytes = Buffer.alloc(16);
  if (kind === "webp") {
    bytes.write("RIFF", 0, "ascii");
    bytes.writeUInt32LE(8, 4);
    bytes.write("WEBP", 8, "ascii");
  } else {
    bytes.writeUInt32BE(16, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("avif", 8, "ascii");
  }
  return bytes;
}

async function websiteArchive(options: ArchiveOptions = {}) {
  const imageCount = options.imageCount ?? 36;
  const claimedImageCount = options.claimedImageCount ?? imageCount;
  const customerCharacters = options.customerCharacters ?? 8_004;
  const root = "示例企业_knowledge_base";
  const zip = new JSZip();
  const branchDirectories = [
    "01_company_overview",
    "02_team",
    "03_products",
    "04_technology",
    "05_manufacturing",
    "06_industries",
    "07_service",
    "08_competitive_advantages",
  ] as const;
  const overviewDirectories = branchDirectories.filter(
    (directory) => directory !== "05_manufacturing",
  );
  const customerDocumentSpecs = [
    ...overviewDirectories.map((directory, index) => ({
      id: `overview-${index + 1}`,
      path: `${directory}/00_overview.md`,
      kind: "overview" as const,
      title: `${directory} 综述`,
      branchId: directory,
    })),
    ...Array.from({ length: 33 }, (_, index) => {
      const directory = branchDirectories[index % branchDirectories.length]!;
      return {
        id: `leaf-${index + 1}`,
        path: `${directory}/knowledge-${index + 1}.md`,
        kind: "leaf" as const,
        title: `知识叶子 ${index + 1}`,
        branchId: directory,
      };
    }),
  ];
  const baseCharacters = 120;
  const firstDocumentCharacters = Math.max(
    0,
    customerCharacters - (customerDocumentSpecs.length - 1) * baseCharacters,
  );
  const customerDocuments = customerDocumentSpecs.map((document, index) => {
    const narrativeCharacters =
      index === 0 ? firstDocumentCharacters : baseCharacters;
    const narrative = String.fromCodePoint(0x4e00 + index).repeat(
      narrativeCharacters,
    );
    const content = `# ${document.title}

> 最后更新: 2026-07-29 | 状态: verified_first_party | 来源: 企业官网

${narrative}`;
    zip.file(`${root}/${document.path}`, content);
    return {
      ...document,
      order: index + 1,
      evidenceStatus: "verified_first_party" as const,
      sourceIds: ["source-1"],
      assetIds:
        index === 0
          ? Array.from(
              { length: imageCount },
              (_, assetIndex) => `asset-${assetIndex + 1}`,
            )
          : [],
      customerVisible: true,
    };
  });
  const supportingDocuments = [
    ["README.md", "# 示例企业知识库"],
    ["00_knowledge_tree.md", "# 知识树"],
    ["00_crawl_coverage_report.md", "# 官网采集报告"],
    ["00_web_intelligence_report.md", "# 公开信息报告"],
    ["00_source_index.md", "# 来源索引"],
    ["09_media_assets/asset_inventory.md", "# 第一方图片清单"],
    ["10_reference_assets/reference_asset_inventory.md", "# 第三方素材索引"],
  ] as const;
  for (const [relativePath, content] of supportingDocuments) {
    zip.file(`${root}/${relativePath}`, content);
  }

  const documents = [
    ...supportingDocuments.map(([relativePath]) => ({
      id: `doc-${relativePath}`,
      path: relativePath,
      kind: relativePath.includes("report")
        ? ("report" as const)
        : relativePath.includes("index") || relativePath.includes("inventory")
          ? ("index" as const)
          : ("evidence" as const),
      title: relativePath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    })),
    ...customerDocuments,
  ];
  const assets = Array.from({ length: imageCount }, (_, index) => {
    const malformedKind = index === 0 ? options.malformedRaster : undefined;
    const extension = malformedKind === "jpeg" ? "jpg" : malformedKind || "png";
    const mimeType =
      malformedKind === "jpeg"
        ? ("image/jpeg" as const)
        : malformedKind === "webp"
          ? ("image/webp" as const)
          : malformedKind === "avif"
            ? ("image/avif" as const)
            : ("image/png" as const);
    const relativePath = `09_media_assets/product_images/image-${index + 1}.${extension}`;
    const uniqueImageBytes = options.duplicateImageBytes
      ? pngBytes
      : Buffer.concat([
          pngBytes,
          Buffer.from([index & 0xff, (index >> 8) & 0xff]),
        ]);
    const bytes = malformedKind
      ? headerOnlyRaster(malformedKind)
      : options.invalidImage && index === 0
        ? Buffer.from("not-an-image")
        : uniqueImageBytes;
    zip.file(`${root}/${relativePath}`, bytes);
    return {
      id: `asset-${index + 1}`,
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
      bytes: bytes.length,
      width: 1,
      height: 1,
      caption: `示例图片 ${index + 1}`,
      branchId: "01_company_overview",
      documentIds: ["overview-1"],
      sourcePageUrl: "https://example.com/",
      sourceAssetUrl: `https://example.com/image-${index + 1}.${extension}`,
      ownership: "first_party" as const,
    };
  });
  if (options.rawSvg) {
    zip.file(
      `${root}/09_media_assets/vector.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
  }
  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
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
        images: { completed: claimedImageCount, total: claimedImageCount },
      },
      gaps: [],
      evaluatedAt: "2026-07-29T00:00:00.000Z",
    }),
  );
  const totalFiles =
    9 + customerDocumentSpecs.length + imageCount + (options.rawSvg ? 1 : 0);
  const evidenceCharacters = supportingDocuments.reduce(
    (total, [, content]) =>
      total +
      Array.from(
        content
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\s/g, "")
          .replace(
            /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/g,
            "",
          ),
      ).length,
    0,
  );
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 1,
      profile: "website-lead-v1",
      documents,
      assets,
      counts: {
        totalFiles,
        customerVisibleCharacters: customerCharacters,
        evidenceCharacters,
        packagedImages: imageCount,
      },
      imageSelection: {
        eligibleFirstPartyImages: imageCount,
        ...(imageCount < 36
          ? { shortfallReason: "官网真实可用第一方图片不足 36 张" }
          : {}),
      },
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function dashboardEnterpriseArchive() {
  const root = "深度企业_knowledge_base";
  const zip = new JSZip();
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
    (relativePath, index) => {
      zip.file(`${root}/${relativePath}`, "# ");
      return {
        id: `support-${index + 1}`,
        path: relativePath,
        kind: relativePath.includes("report")
          ? "report"
          : relativePath.includes("index") || relativePath.includes("inventory")
            ? "index"
            : "evidence",
        title: relativePath,
        sourceIds: [],
        assetIds: [],
        customerVisible: false,
      };
    },
  );
  const formalDocument = (title: string, narrative: string) => `# ${title}

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

证据区不应进入客户可见正文。
`;
  const overviewPath = "branches/products/00_overview.md";
  zip.file(
    `${root}/${overviewPath}`,
    formalDocument("产品与服务综述", "综".repeat(80_000 - 40 * 120)),
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
    const relativePath = `branches/products/leaf-${index + 1}.md`;
    zip.file(
      `${root}/${relativePath}`,
      formalDocument(
        `知识叶子 ${index + 1}`,
        String.fromCodePoint(0x4e00 + index).repeat(120),
      ),
    );
    documents.push({
      id: `leaf-${index + 1}`,
      path: relativePath,
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
  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
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
    }),
  );
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
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
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function parseWebsiteArchive(buffer: Buffer) {
  const result = await readKnowledgeArchive(
    buffer,
    "示例企业知识库.zip",
    "snapshot-test",
    { validationProfile: "website-lead-v1" },
  );
  storedKeys.push(...result.storedAssetKeys);
  return result;
}

describe("versioned knowledge archive quality gates", () => {
  it("accepts a deep v2 archive and stores only the marked formal prose", async () => {
    const result = await readKnowledgeArchive(
      await dashboardEnterpriseArchive(),
      "深度企业知识库.zip",
      "deep-snapshot-test",
      { validationProfile: "dashboard-enterprise-v1" },
    );
    storedKeys.push(...result.storedAssetKeys);

    const customerDocuments = result.documents.filter(
      (document) => document.customerVisible,
    );
    expect(customerDocuments).toHaveLength(41);
    expect(
      customerDocuments.every(
        (document) =>
          document.content.includes("正式正文") &&
          !document.content.includes("证据区不应进入客户可见正文"),
      ),
    ).toBe(true);
  });

  it.each([36, 48])(
    "accepts %s real first-party images and formal overview plus leaves",
    async (imageCount) => {
      const result = await parseWebsiteArchive(
        await websiteArchive({ imageCount }),
      );

      expect(result.assets).toHaveLength(imageCount);
      expect(
        result.documents.filter((document) => document.customerVisible),
      ).toHaveLength(40);
      expect(result.documents[0]?.kind).toBeDefined();
    },
  );

  it("rejects a report count that does not match packaged images", async () => {
    await expect(
      parseWebsiteArchive(
        await websiteArchive({ imageCount: 0, claimedImageCount: 36 }),
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects 49 images for the website profile", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ imageCount: 49 })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects an image whose bytes do not match its extension", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ invalidImage: true })),
    ).rejects.toThrow("知识库图片格式与内容不匹配");
  });

  it.each(["jpeg", "webp", "avif"] as const)(
    "rejects a header-only %s that cannot be decoded",
    async (malformedRaster) => {
      await expect(
        parseWebsiteArchive(await websiteArchive({ malformedRaster })),
      ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
        category: "media",
      });
    },
  );

  it("rejects packaged images that were not deduplicated by SHA-256", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ duplicateImageBytes: true })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects an SVG that was not rasterized before packaging", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ rawSvg: true })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects customer-visible content below 8,000 effective characters", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ customerCharacters: 7_999 })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "content",
    });
  });
});
