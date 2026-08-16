import { createHash } from "node:crypto";

import JSZip from "jszip";

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

export function websiteKnowledgeImportFixtureEntries() {
  const entries = new Map<string, Buffer>();
  const supportingDocuments = [
    ["README.md", "# 示例企业知识库"],
    ["00_knowledge_tree.md", "# 知识树"],
    ["00_crawl_coverage_report.md", "# 官网采集报告"],
    ["00_web_intelligence_report.md", "# 公开信息报告"],
    ["00_source_index.md", "# 来源索引"],
    ["09_media_assets/asset_inventory.md", "# 第一方图片清单"],
    ["10_reference_assets/reference_asset_inventory.md", "# 第三方素材索引"],
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
  const customerCharacters = 8_004;
  const baseCharacters = 120;
  const firstDocumentCharacters =
    customerCharacters - (customerDocumentSpecs.length - 1) * baseCharacters;
  const customerDocuments = customerDocumentSpecs.map((document, index) => {
    const narrative = String.fromCodePoint(0x4e00 + index).repeat(
      index === 0 ? firstDocumentCharacters : baseCharacters,
    );
    entries.set(
      document.path,
      Buffer.from(
        `# ${document.title}\n\n> 最后更新: 2026-08-16 | 状态: verified_first_party | 来源: 企业官网\n\n${narrative}`,
        "utf8",
      ),
    );
    return {
      ...document,
      order: index + 1,
      evidenceStatus: "verified_first_party" as const,
      sourceIds: ["source-1"],
      assetIds: [],
      customerVisible: true,
    };
  });

  for (const [relativePath, content] of supportingDocuments) {
    entries.set(relativePath, Buffer.from(content, "utf8"));
  }
  const documents = [
    ...supportingDocuments.map(([relativePath]) => ({
      id: `doc-${relativePath}`,
      path: relativePath,
      kind: relativePath.includes("report") ? "report" : "index",
      title: relativePath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    })),
    ...customerDocuments,
  ];
  const evidenceCharacters = supportingDocuments.reduce(
    (total, [, content]) =>
      total +
      Array.from(
        content
          .replace(/^#{1,6}\s+/gmu, "")
          .replace(/\s/gu, "")
          .replace(
            /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/gu,
            "",
          ),
      ).length,
    0,
  );
  const completeness = {
    counts: {
      totalLeaves: customerDocuments.length,
      verifiedFirstParty: customerDocuments.length,
      verifiedAuthoritative: 0,
      supportedThirdParty: 0,
      inferred: 0,
      needsVerification: 0,
      notApplicable: 0,
    },
    acquisition: {
      images: { completed: 0, total: 0 },
    },
    gaps: [],
    evaluatedAt: "2026-08-16T00:00:00.000Z",
  };
  const manifest = {
    schemaVersion: 1,
    profile: "website-lead-v1",
    documents,
    assets: [],
    counts: {
      totalFiles: documents.length + 2,
      customerVisibleCharacters: customerCharacters,
      evidenceCharacters,
      packagedImages: 0,
    },
    imageSelection: {
      eligibleFirstPartyImages: 0,
      shortfallReason: "官网没有可用于交付的第一方图片",
    },
  };
  entries.set(
    "00_completeness.json",
    Buffer.from(JSON.stringify(completeness), "utf8"),
  );
  entries.set(
    "00_package_manifest.json",
    Buffer.from(JSON.stringify(manifest), "utf8"),
  );
  return entries;
}

export async function buildWebsiteKnowledgeImportFixture(options?: {
  root?: string;
  reverse?: boolean;
  date?: Date;
  unixPermissions?: number;
  compressionLevel?: number;
  mutate?: (entries: Map<string, Buffer>) => void;
}) {
  const entries = websiteKnowledgeImportFixtureEntries();
  options?.mutate?.(entries);
  const ordered = [...entries.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (options?.reverse) ordered.reverse();
  const prefix = options?.root ? `${options.root}/` : "";
  const zip = new JSZip();
  for (const [relativePath, bytes] of ordered) {
    zip.file(`${prefix}${relativePath}`, bytes, {
      binary: true,
      createFolders: false,
      date: options?.date ?? new Date("2026-08-16T04:00:00.000Z"),
      unixPermissions: options?.unixPermissions ?? 0o100600,
    });
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: options?.compressionLevel ?? 3 },
  });
  return {
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    packageManifestSha256: createHash("sha256")
      .update(entries.get("00_package_manifest.json")!)
      .digest("hex"),
  };
}
