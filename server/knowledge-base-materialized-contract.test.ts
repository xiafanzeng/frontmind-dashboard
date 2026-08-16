import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  projectKnowledgeBaseCustomerMarkdown,
  salvageKnowledgeBaseNodePatchArchive,
  validateKnowledgeBaseNodePatchArchive,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";
import { canonicalizeKnowledgeBaseWebsite } from "./knowledge-base-company-identity";

const fixedDate = new Date("2000-01-01T00:00:00.000Z");
const buildId = "11111111-1111-4111-8111-111111111111";
const skillHash = "a".repeat(64);
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const researchDimensionIds = [
  "enterprise_identity",
  "team_and_organization",
  "products_and_services",
  "capabilities_and_delivery",
  "industries_scenarios_and_cases",
  "differentiation_and_evidence",
  "cooperation_delivery_and_support",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function bundle(
  mutate?: (manifest: Record<string, any>, zip: JSZip) => void,
  options: {
    leafCount?: number;
    reverseNodeInsertion?: boolean;
    entryDate?: Date;
    reverseManifestKeys?: boolean;
    bundleBom?: boolean;
  } = {},
) {
  const zip = new JSZip();
  const entryDate = options.entryDate ?? fixedDate;
  const nodeFiles: Array<{ path: string; content: string }> = [];
  const leaves = Array.from({ length: options.leafCount ?? 30 }, (_, index) => {
    const leafId = `1.${index + 1}`;
    const path = `nodes/${String(index + 1).padStart(4, "0")}.md`;
    const title = `节点 ${index + 1}`;
    const content = `# ${title}\n\n完整正文 ${index + 1}`;
    nodeFiles.push({ path, content });
    return {
      leafId,
      branchId: "identity",
      branchTitle: "企业身份",
      title,
      ordinal: index,
      contentPath: path,
      contentSha256: sha256(content),
      evidencePaths: index === 0 ? ["evidence/1.1/source.md"] : [],
      assetIds: [],
    };
  });
  for (const node of options.reverseNodeInsertion
    ? [...nodeFiles].reverse()
    : nodeFiles) {
    zip.file(node.path, node.content, {
      date: entryDate,
      createFolders: false,
    });
  }
  const evidence = "内部证据";
  zip.file("evidence/1.1/source.md", evidence, {
    date: entryDate,
    createFolders: false,
  });
  const leafIds = leaves.map((leaf) => leaf.leafId);
  const manifest: Record<string, any> = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId: "initial-operation",
    buildId,
    generation: 1,
    contentVersion: 1,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: skillHash,
    },
    treePolicyVersion: 2,
    company: { name: "示例企业", website: null },
    researchCoverage: {
      officialPages: {
        discovered: 12,
        attempted: 12,
        succeeded: 12,
        failed: 0,
      },
      publicQueries: 6,
      officialDocuments: 0,
      uploadsRead: 0,
      sourceCount: 1,
      productFamilies: [
        { id: "primary", name: "核心业务", leafIds: [...leafIds] },
      ],
      dimensions: researchDimensionIds.map((id) => ({
        id,
        status: "covered",
        leafIds: [leafIds[0]],
      })),
      stopReason: "coverage_complete",
    },
    branches: [{ branchId: "identity", title: "企业身份", ordinal: 0 }],
    evidenceLedger: [
      {
        path: "evidence/1.1/source.md",
        sha256: sha256(evidence),
        leafId: "1.1",
        sourceUrl: "https://example.test/source",
        retrievedAt: null,
      },
    ],
    leaves,
    assets: [],
    logo: { status: "missing", assetId: null },
    counts: { leaves: leaves.length, evidenceFiles: 1, assets: 0 },
  };
  mutate?.(manifest, zip);
  const serializedManifest = JSON.stringify(
    options.reverseManifestKeys
      ? Object.fromEntries(Object.entries(manifest).reverse())
      : manifest,
  );
  zip.file(
    "BUNDLE.json",
    `${options.bundleBom ? "\uFEFF" : ""}${serializedManifest}`,
    {
      date: entryDate,
      createFolders: false,
    },
  );
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

async function patch(
  mutate?: (manifest: Record<string, any>, zip: JSZip) => void,
) {
  const zip = new JSZip();
  const content = "# 修订节点\n\n修订后的完整正文";
  zip.file("node/1.1.md", content, { date: fixedDate, createFolders: false });
  const manifest: Record<string, any> = {
    kind: "frontmind.kb-node-patch",
    schemaVersion: 1,
    operationId: "revision-operation",
    buildId,
    generation: 1,
    baseContentVersion: 1,
    baseWorkingSetSha256: "b".repeat(64),
    targetLeafId: "1.1",
    contentPath: "node/1.1.md",
    contentSha256: sha256(content),
    evidence: { add: [], remove: [] },
    assets: { add: [], remove: [] },
  };
  mutate?.(manifest, zip);
  zip.file("PATCH.json", JSON.stringify(manifest), {
    date: fixedDate,
    createFolders: false,
  });
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

async function rewritePatchManifest(
  bytes: Buffer,
  serialize: (manifest: Record<string, any>) => string,
) {
  const zip = await JSZip.loadAsync(bytes);
  const manifest = JSON.parse(
    await zip.file("PATCH.json")!.async("string"),
  ) as Record<string, any>;
  zip.file("PATCH.json", serialize(manifest), {
    date: fixedDate,
    createFolders: false,
  });
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

function portablePatchFlags(targetLeafId = "1.1") {
  return [
    "--expected-operation-id",
    "revision-operation",
    "--expected-build-id",
    buildId,
    "--expected-generation",
    "1",
    "--expected-base-content-version",
    "1",
    "--expected-base-working-set-sha256",
    "b".repeat(64),
    "--expected-target-leaf-id",
    targetLeafId,
  ];
}

async function runPortableValidator(bytes: Buffer, args: string[]) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frontmind-materialized-validator-"),
  );
  temporaryDirectories.push(directory);
  const archivePath = path.join(directory, "result.zip");
  await fs.writeFile(archivePath, bytes);
  try {
    const result = await execFileAsync("python3", [
      path.resolve(
        process.cwd(),
        "private-workflows/socratic-kb-builder/scripts/validate_working_set.py",
      ),
      ...args,
      archivePath,
    ]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return {
      code: Number(error.code || 1),
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

function portableInitialFlags(company: {
  name: string;
  website: string | null;
}) {
  return [
    "--expected-operation-id",
    "initial-operation",
    "--expected-build-id",
    buildId,
    "--expected-generation",
    "1",
    "--expected-content-version",
    "1",
    "--expected-skill-content-hash",
    skillHash,
    "--expected-tree-policy-version",
    "2",
    "--expected-uploads-read",
    "0",
    "--expected-company-base64url",
    Buffer.from(JSON.stringify(company), "utf8").toString("base64url"),
  ];
}

describe("materialized knowledge-base ZIP contracts", () => {
  it.each([
    [
      "bare formal markers",
      [
        "# 节点一",
        "",
        "FRONTMIND_FORMAL_CONTENT_START",
        "",
        "干净正文。",
        "",
        "FRONTMIND_FORMAL_CONTENT_END",
        "",
        "## 资料元数据",
        "documentRole: internal",
      ].join("\n"),
    ],
    [
      "HTML formal markers",
      [
        "<!-- FRONTMIND_FORMAL_CONTENT_START -->",
        "干净正文。",
        "<!-- FRONTMIND_FORMAL_CONTENT_END -->",
        "## 证据与核验说明",
        "内部说明",
      ].join("\n"),
    ],
    [
      "internal suffix",
      "# 节点一\n\n干净正文。\n\n## 资料元数据\nsourceIds: [private]",
    ],
    ["already clean", "干净正文。"],
  ])("projects %s into one customer template", (_label, markdown) => {
    expect(
      projectKnowledgeBaseCustomerMarkdown({
        leafTitle: "节点一",
        markdown,
      }),
    ).toBe("# 节点一\n\n干净正文。");
  });

  it("rejects ambiguous, empty or internally contaminated projections", () => {
    for (const markdown of [
      "FRONTMIND_FORMAL_CONTENT_START\n正文\nFRONTMIND_FORMAL_CONTENT_START\n草稿\nFRONTMIND_FORMAL_CONTENT_END",
      "FRONTMIND_FORMAL_CONTENT_START\n\nFRONTMIND_FORMAL_CONTENT_END",
      "正文中残留 FRONTMIND_FORMAL_CONTENT_START 标记",
      "正文\nsourceIds: [private]",
      "正文\nrequiredFormalCharacters：中国式分隔符也不得展示",
    ]) {
      expect(() =>
        projectKnowledgeBaseCustomerMarkdown({
          leafTitle: "节点一",
          markdown,
        }),
      ).toThrow();
    }
  });

  it("retains 54 incident-shaped nodes as clean canonical customer bytes", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle(
        (manifest, zip) => {
          for (const leaf of manifest.leaves) {
            const raw = [
              `# ${leaf.title}`,
              "",
              "FRONTMIND_FORMAL_CONTENT_START",
              "",
              `客户可见正文 ${leaf.leafId}`,
              "",
              "FRONTMIND_FORMAL_CONTENT_END",
              "",
              "## 资料元数据",
              "documentRole: branch_overview_and_leaf",
              "evidenceStatus: complete",
              "sourceIds: [private-source]",
              "evidenceDocumentIds: [evidence/private/source.md]",
              "sameBranchEvidenceDocumentIds: [evidence/private/source.md]",
              "evidenceCharacters: 756",
              "formalCharacters: 184",
              "",
              "## 证据与核验说明",
              "内部证据说明",
            ].join("\n");
            zip.file(leaf.contentPath, raw, {
              date: fixedDate,
              createFolders: false,
            });
            leaf.contentSha256 = sha256(raw);
          }
        },
        { leafCount: 54 },
      ),
    );

    expect(validated.manifest.leaves).toHaveLength(54);
    expect(validated.warnings).toEqual([]);
    for (const leaf of validated.manifest.leaves) {
      const markdown = validated.files.get(leaf.contentPath)!.toString("utf8");
      expect(markdown).toBe(`# ${leaf.title}\n\n客户可见正文 ${leaf.leafId}`);
      expect(markdown).not.toMatch(/FRONTMIND_|sourceIds|source\.md/u);
      expect(leaf.contentSha256).toBe(sha256(markdown));
    }
  });

  it("accepts a complete 30-leaf initial Working Set with exact coordinates", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle(),
      {
        operationId: "initial-operation",
        buildId,
        generation: 1,
        contentVersion: 1,
        skillContentHash: skillHash,
        companyName: "示例企业",
        companyWebsite: null,
      },
    );

    expect(validated.manifest.leaves).toHaveLength(30);
    expect(validated.manifest.contentVersion).toBe(1);
    expect(validated.files).toHaveProperty("size", 32);
  });

  it("writes server-authoritative upload and retained-source counts into canonical coverage", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest) => {
        manifest.researchCoverage.uploadsRead = 99;
        manifest.researchCoverage.sourceCount = 99;
      }),
      { expectedUploadsRead: 3 },
    );

    expect(validated.manifest.researchCoverage).toMatchObject({
      uploadsRead: 3,
      sourceCount: 1,
    });
    const canonicalManifest = JSON.parse(
      validated.files.get("BUNDLE.json")!.toString("utf8"),
    );
    expect(canonicalManifest.researchCoverage).toMatchObject({
      uploadsRead: 3,
      sourceCount: 1,
    });
  });

  it("accepts one safe leaf so incomplete builds can remain display-only", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle(undefined, { leafCount: 1 }),
      {
        operationId: "initial-operation",
        buildId,
        generation: 1,
        contentVersion: 1,
        skillContentHash: skillHash,
        companyName: "示例企业",
        companyWebsite: null,
      },
    );

    expect(validated.manifest.leaves).toHaveLength(1);
    expect(validated.manifest.counts.leaves).toBe(1);
  });

  it("retains the other safe bodies when one declared leaf body is unusable", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest, zip) => {
        zip.remove(manifest.leaves[4].contentPath);
      }),
    );

    expect(validated.manifest.leaves).toHaveLength(29);
    expect(
      validated.manifest.leaves.some((leaf) => leaf.leafId === "1.5"),
    ).toBe(false);
    expect(validated.warnings).toContainEqual({
      code: "RESULT_INCOMPLETE",
      area: "nodes",
    });
  });

  it("drops only an ambiguously wrapped node and keeps the remaining projections", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest, zip) => {
        const leaf = manifest.leaves[4];
        const raw =
          "FRONTMIND_FORMAL_CONTENT_START\n正文\nFRONTMIND_FORMAL_CONTENT_START\n草稿\nFRONTMIND_FORMAL_CONTENT_END";
        zip.file(leaf.contentPath, raw, {
          date: fixedDate,
          createFolders: false,
        });
        leaf.contentSha256 = sha256(raw);
      }),
    );

    expect(validated.manifest.leaves).toHaveLength(29);
    expect(
      validated.manifest.leaves.some((leaf) => leaf.leafId === "1.5"),
    ).toBe(false);
    expect(validated.warnings).toContainEqual({
      code: "RESULT_INCOMPLETE",
      area: "nodes",
    });
  });

  it("produces identical canonical bytes for equivalent identity, Markdown, JSON and ZIP metadata", async () => {
    const expected = {
      operationId: "initial-operation",
      buildId,
      generation: 1,
      contentVersion: 1,
      skillContentHash: skillHash,
      companyName: "示例企业",
      companyWebsite: "https://example.test/",
    } as const;
    const ordinary = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest) => {
        manifest.company.website = "https://example.test/";
      }),
      expected,
    );
    const variant = await validateKnowledgeBaseWorkingSetArchive(
      await bundle(
        (manifest, zip) => {
          manifest.company = { name: "  示例企业  ", website: "EXAMPLE.test" };
          for (const [index, leaf] of manifest.leaves.entries()) {
            const canonical = `# 节点 ${index + 1}\n\n完整正文 ${index + 1}`;
            const raw = `\uFEFF${canonical.replace(/\n/g, "  \r\n")}  \r\n`;
            zip.file(leaf.contentPath, raw, {
              date: new Date("2026-08-15T12:34:56.000Z"),
              createFolders: false,
            });
            leaf.contentSha256 = sha256(raw);
          }
        },
        {
          reverseNodeInsertion: true,
          entryDate: new Date("2026-08-15T12:34:56.000Z"),
          reverseManifestKeys: true,
          bundleBom: true,
        },
      ),
      expected,
    );

    expect(variant.manifest.company).toEqual({
      name: "示例企业",
      website: "https://example.test/",
    });
    expect(variant.packageSha256).toBe(ordinary.packageSha256);
    expect(variant.archiveBytes.equals(ordinary.archiveBytes)).toBe(true);

    const revalidated = await validateKnowledgeBaseWorkingSetArchive(
      variant.archiveBytes,
      expected,
    );
    expect(revalidated.packageSha256).toBe(variant.packageSha256);
    expect(revalidated.archiveBytes.equals(variant.archiveBytes)).toBe(true);
  });

  it("rejects a company website that differs from the frozen build", async () => {
    await expect(
      validateKnowledgeBaseWorkingSetArchive(await bundle(), {
        companyWebsite: "https://different.example/",
      }),
    ).rejects.toThrow("company.website 与任务坐标不一致");
  });

  it("canonicalizes equivalent company coordinates to the frozen identity", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest) => {
        manifest.company = {
          name: "  示例   企业  ",
          website: "EXAMPLE.test",
        };
      }),
      {
        companyName: "示例 企业",
        companyWebsite: "https://example.test/",
      },
    );

    expect(validated.manifest.company).toEqual({
      name: "示例 企业",
      website: "https://example.test/",
    });
  });

  it("accepts a fully decoded AVIF working-set asset", async () => {
    const avif = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 4,
        background: { r: 20, g: 80, b: 140, alpha: 1 },
      },
    })
      .avif()
      .toBuffer();
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest, zip) => {
        zip.file("assets/brand.avif", avif, {
          date: fixedDate,
          createFolders: false,
        });
        manifest.assets = [
          {
            assetId: "brand-visual",
            path: "assets/brand.avif",
            sha256: "f".repeat(64),
            mimeType: "image/png",
            bytes: 1,
            width: 99,
            height: 98,
            provenance: { source: "official" },
            documentIds: ["wrong-node"],
          },
        ];
        manifest.leaves[0].assetIds = ["brand-visual"];
        manifest.leaves[0].contentSha256 = "e".repeat(64);
        manifest.counts = { leaves: 1, evidenceFiles: 77, assets: 55 };
      }),
    );

    expect(validated.manifest.assets[0]).toMatchObject({
      sha256: sha256(avif),
      mimeType: "image/avif",
      bytes: avif.length,
      width: 2,
      height: 3,
      documentIds: ["1.1"],
    });
    expect(validated.manifest.counts).toEqual({
      leaves: 30,
      evidenceFiles: 1,
      assets: 1,
    });
    expect(validated.manifest.leaves[0]!.contentSha256).not.toBe(
      "e".repeat(64),
    );
  });

  it("drops invalid optional evidence and assets without hiding safe node bodies", async () => {
    const validated = await validateKnowledgeBaseWorkingSetArchive(
      await bundle((manifest, zip) => {
        zip.remove("evidence/1.1/source.md");
        zip.file("evidence/1.1/bad.md", "", {
          date: fixedDate,
          createFolders: false,
        });
        zip.file("assets/bad.svg", "<svg/>", {
          date: fixedDate,
          createFolders: false,
        });
        manifest.evidenceLedger = [
          {
            path: "evidence/1.1/bad.md",
            sha256: "0".repeat(64),
            leafId: "1.1",
            sourceUrl: null,
            retrievedAt: null,
          },
        ];
        manifest.assets = [
          {
            assetId: "bad-optional-visual",
            path: "assets/bad.svg",
            sha256: "0".repeat(64),
            mimeType: "image/png",
            bytes: 6,
            width: 1,
            height: 1,
            provenance: {},
            documentIds: ["1.1"],
          },
        ];
        manifest.logo = {
          status: "available",
          assetId: "bad-optional-visual",
        };
        manifest.leaves[0].evidencePaths = ["evidence/1.1/bad.md"];
        manifest.leaves[0].assetIds = ["bad-optional-visual"];
      }),
    );

    expect(validated.manifest.leaves).toHaveLength(30);
    expect(validated.manifest.leaves[0]).toMatchObject({
      evidencePaths: [],
      assetIds: [],
    });
    expect(validated.manifest.evidenceLedger).toEqual([]);
    expect(validated.manifest.assets).toEqual([]);
    expect(validated.manifest.logo).toEqual({
      status: "missing",
      assetId: null,
    });
    expect(validated.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EVIDENCE_INCOMPLETE" }),
        expect.objectContaining({ code: "OPTIONAL_ASSET_SKIPPED" }),
      ]),
    );
    expect(validated.files.has("evidence/1.1/bad.md")).toBe(false);
    expect(validated.files.has("assets/bad.svg")).toBe(false);
  });

  it("rejects undeclared files and stale bundle coordinates", async () => {
    await expect(
      validateKnowledgeBaseWorkingSetArchive(
        await bundle((_manifest, zip) => {
          zip.file("undeclared.txt", "no", {
            date: fixedDate,
            createFolders: false,
          });
        }),
        { buildId },
      ),
    ).rejects.toThrow("未登记文件");

    await expect(
      validateKnowledgeBaseWorkingSetArchive(await bundle(), {
        generation: 2,
      }),
    ).rejects.toThrow("generation 与任务坐标不一致");
  });

  it("accepts only a target-scoped patch with exact base coordinates", async () => {
    const validated = await validateKnowledgeBaseNodePatchArchive(
      await patch(),
      {
        operationId: "revision-operation",
        buildId,
        generation: 1,
        baseContentVersion: 1,
        baseWorkingSetSha256: "b".repeat(64),
        targetLeafId: "1.1",
      },
    );
    expect(validated.manifest.targetLeafId).toBe("1.1");

    await expect(
      validateKnowledgeBaseNodePatchArchive(
        await patch((manifest, zip) => {
          const evidence = "wrong leaf";
          zip.file("evidence/1.2/source.md", evidence, {
            date: fixedDate,
            createFolders: false,
          });
          manifest.evidence.add.push({
            path: "evidence/1.2/source.md",
            sha256: sha256(evidence),
          });
        }),
        { targetLeafId: "1.1" },
      ),
    ).rejects.toThrow("Patch 证据必须属于目标节点");
  });

  it("canonicalizes equivalent Patch Markdown and ZIP metadata to one digest", async () => {
    const expected = {
      operationId: "revision-operation",
      buildId,
      generation: 1,
      baseContentVersion: 1,
      baseWorkingSetSha256: "b".repeat(64),
      targetLeafId: "1.1",
    };
    const ordinary = await validateKnowledgeBaseNodePatchArchive(
      await patch(),
      expected,
    );
    const variant = await validateKnowledgeBaseNodePatchArchive(
      await patch((manifest, zip) => {
        const raw = "\uFEFF# 修订节点  \r\n\r\n修订后的完整正文  \r\n";
        zip.file("node/1.1.md", raw, {
          date: new Date("2026-08-15T12:34:56.000Z"),
          createFolders: false,
        });
        manifest.contentSha256 = sha256(raw);
      }),
      expected,
    );

    expect(variant.packageSha256).toBe(ordinary.packageSha256);
    expect(variant.archiveBytes.equals(ordinary.archiveBytes)).toBe(true);
  });

  it("accepts the incident-equivalent customer asset in Python and TypeScript and rewrites a private canonical manifest", async () => {
    const png = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: 75, g: 24, b: 112, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const sourceSha256 = sha256(png);
    const raw = await patch((manifest, zip) => {
      zip.file("assets/1.1/customer-original-name.png", png, {
        date: fixedDate,
        createFolders: false,
      });
      manifest.assets.add = [
        {
          assetId: "provider-customer-filename-asset",
          path: "assets/1.1/customer-original-name.png",
          sha256: sourceSha256,
          mimeType: "image/png",
          bytes: png.length,
          width: 8,
          height: 6,
          provenance: {
            originalFilename: "customer-original-name.png",
            originalUploadSha256: sourceSha256,
            ownership: "first_party",
            sourceKind: "user_upload",
          },
          documentIds: ["1.1"],
          assetType: "customer_supplied",
          displayRole: "inline",
          caption: "customer-original-name.png",
          futurePresentationHint: "ignored",
        },
      ];
    });
    const expected = {
      operationId: "revision-operation",
      buildId,
      generation: 1,
      baseContentVersion: 1,
      baseWorkingSetSha256: "b".repeat(64),
      targetLeafId: "1.1",
      attachmentSourceProofs: [
        {
          index: 0,
          contentSha256: sourceSha256,
          sizeBytes: png.length,
          mimeType: "IMAGE/PNG; charset=binary",
        },
      ],
    } as const;

    await expect(
      runPortableValidator(raw, portablePatchFlags()),
    ).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID frontmind.kb-node-patch.v1"),
    });
    const validated = await validateKnowledgeBaseNodePatchArchive(
      raw,
      expected,
    );
    const asset = validated.manifest.assets.add[0]!;
    expect(asset).toMatchObject({
      assetType: "customer_supplied",
      displayRole: "inline",
      documentIds: ["1.1"],
      provenance: {
        sourceKind: "user_upload",
        ownership: "first_party",
        sourceUploadIndex: 0,
        sourceUploadSha256: sourceSha256,
      },
    });
    expect(asset.assetId).not.toContain("provider");
    expect(asset.path).not.toContain("customer-original-name");
    expect(asset.caption).toBeUndefined();
    expect(validated.warnings).toContainEqual({
      code: "PRESENTATION_NORMALIZED",
      area: "assets",
    });

    const canonicalZip = await JSZip.loadAsync(validated.archiveBytes, {
      checkCRC32: true,
    });
    const canonicalManifest = JSON.parse(
      await canonicalZip.file("PATCH.json")!.async("string"),
    );
    const canonicalAsset = canonicalManifest.assets.add[0];
    expect(canonicalAsset.futurePresentationHint).toBeUndefined();
    expect(canonicalAsset.provenance.originalFilename).toBeUndefined();
    expect(JSON.stringify(canonicalManifest)).not.toContain(
      "customer-original-name.png",
    );
    await expect(
      runPortableValidator(validated.archiveBytes, portablePatchFlags()),
    ).resolves.toMatchObject({ code: 0 });
  });

  it("isolates bad optional evidence and images while retaining safe siblings", async () => {
    const goodPng = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { r: 25, g: 80, b: 120, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const raw = await patch((manifest, zip) => {
      zip.file("evidence/1.1/good.md", "可信证据", {
        date: fixedDate,
        createFolders: false,
      });
      zip.file("evidence/1.1/bad.md", "", {
        date: fixedDate,
        createFolders: false,
      });
      zip.file("assets/1.1/good.png", goodPng, {
        date: fixedDate,
        createFolders: false,
      });
      zip.file("assets/1.1/bad.png", "not-an-image", {
        date: fixedDate,
        createFolders: false,
      });
      manifest.evidence.add = [
        {
          path: "evidence/1.1/good.md",
          sha256: sha256("可信证据"),
        },
        { path: "evidence/1.1/bad.md", sha256: sha256("") },
      ];
      const asset = (id: string, path: string, bytes: Buffer) => ({
        assetId: id,
        path,
        sha256: sha256(bytes),
        mimeType: "image/png",
        bytes: bytes.length,
        width: 4,
        height: 4,
        provenance: { sourceKind: "official_web" },
        documentIds: ["1.1"],
      });
      manifest.assets.add = [
        asset("good-asset", "assets/1.1/good.png", goodPng),
        asset("bad-asset", "assets/1.1/bad.png", Buffer.from("not-an-image")),
      ];
    });
    await expect(
      runPortableValidator(raw, portablePatchFlags()),
    ).resolves.toMatchObject({ code: 0 });
    const validated = await validateKnowledgeBaseNodePatchArchive(raw);

    expect(validated.components).toEqual({
      content: "valid",
      evidence: "invalid",
      assets: "invalid",
    });
    expect(validated.manifest.evidence.add).toHaveLength(1);
    expect(validated.manifest.assets.add.map((asset) => asset.assetId)).toEqual(
      ["good-asset"],
    );
    expect(validated.droppedComponents).toMatchObject({
      evidence: 1,
      assets: 1,
    });
    expect(validated.files.has("evidence/1.1/bad.md")).toBe(false);
    expect(validated.files.has("assets/1.1/bad.png")).toBe(false);
  });

  it("keeps frozen upload proof conflicts on the whole-package hard boundary", async () => {
    const png = await sharp({
      create: {
        width: 3,
        height: 3,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const sourceSha256 = sha256(png);
    const raw = await patch((manifest, zip) => {
      zip.file("assets/1.1/upload.png", png, {
        date: fixedDate,
        createFolders: false,
      });
      manifest.assets.add = [
        {
          assetId: "claimed-upload",
          path: "assets/1.1/upload.png",
          sha256: sourceSha256,
          mimeType: "image/png",
          bytes: png.length,
          width: 3,
          height: 3,
          provenance: {
            sourceKind: "user_upload",
            originalUploadSha256: "f".repeat(64),
          },
          documentIds: ["1.1"],
          assetType: "customer_supplied",
          displayRole: "inline",
        },
      ];
    });
    await expect(
      validateKnowledgeBaseNodePatchArchive(raw, {
        attachmentSourceProofs: [
          {
            index: 0,
            contentSha256: sourceSha256,
            sizeBytes: png.length,
            mimeType: "image/png",
          },
        ],
      }),
    ).rejects.toMatchObject({ category: "frozen_source_conflict" });
  });

  it("accepts only the bounded manifest envelopes and rejects ambiguous JSON", async () => {
    const ordinary = await patch();
    for (const encoded of [
      await rewritePatchManifest(
        ordinary,
        (manifest) =>
          `\uFEFF${JSON.stringify(manifest).replaceAll(",", ",\r\n")}`,
      ),
      await rewritePatchManifest(
        ordinary,
        (manifest) => `\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``,
      ),
      await rewritePatchManifest(ordinary, (manifest) =>
        JSON.stringify(JSON.stringify(manifest)),
      ),
    ]) {
      await expect(
        validateKnowledgeBaseNodePatchArchive(encoded),
      ).resolves.toMatchObject({
        manifest: { operationId: "revision-operation" },
      });
    }

    const ambiguous = [
      await rewritePatchManifest(
        ordinary,
        (manifest) => `说明\n${JSON.stringify(manifest)}`,
      ),
      await rewritePatchManifest(
        ordinary,
        (manifest) =>
          `\`\`\`json\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\`\n\`\`\``,
      ),
      await rewritePatchManifest(ordinary, (manifest) =>
        JSON.stringify(JSON.stringify(JSON.stringify(manifest))),
      ),
      await rewritePatchManifest(
        ordinary,
        (manifest) =>
          `${JSON.stringify(manifest)}\n${JSON.stringify({ extra: true })}`,
      ),
      await rewritePatchManifest(ordinary, (manifest) => {
        const json = JSON.stringify(manifest);
        return json.replace(
          '"kind":"frontmind.kb-node-patch"',
          '"kind":"frontmind.kb-node-patch","kind":"frontmind.kb-node-patch"',
        );
      }),
    ];
    for (const encoded of ambiguous) {
      await expect(
        validateKnowledgeBaseNodePatchArchive(encoded),
      ).rejects.toThrow();
    }
    await expect(
      validateKnowledgeBaseNodePatchArchive(ambiguous[3]!),
    ).rejects.toMatchObject({ category: "contract" });
    await expect(
      validateKnowledgeBaseNodePatchArchive(ambiguous[4]!),
    ).rejects.toMatchObject({ category: "contract" });
  });

  it("salvages only one locked leaf and one-to-one frozen image proofs", async () => {
    const png = await sharp({
      create: {
        width: 5,
        height: 7,
        channels: 4,
        background: { r: 90, g: 30, b: 110, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const sourceSha256 = sha256(png);
    const broken = new JSZip();
    broken.file("PATCH.json", "{", { date: fixedDate, createFolders: false });
    broken.file("node/1.1.md", "# 修订节点\n\n仍可安全保留的正文", {
      date: fixedDate,
      createFolders: false,
    });
    broken.file("provider-name.png", png, {
      date: fixedDate,
      createFolders: false,
    });
    const bytes = await broken.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
    });
    const expected = {
      operationId: "revision-operation",
      buildId,
      generation: 1,
      baseContentVersion: 1,
      baseWorkingSetSha256: "b".repeat(64),
      targetLeafId: "1.1",
      attachmentSourceProofs: [
        {
          index: 0,
          contentSha256: sourceSha256,
          sizeBytes: png.length,
          mimeType: "image/png",
        },
      ],
    } as const;
    const salvaged = await salvageKnowledgeBaseNodePatchArchive({
      bytes,
      expected,
      dbAuthorityLocked: true,
    });
    expect(salvaged.manifest.assets.add[0]).toMatchObject({
      assetType: "customer_supplied",
      displayRole: "inline",
      provenance: { sourceUploadSha256: sourceSha256 },
    });
    expect(JSON.stringify(salvaged.manifest)).not.toContain("provider-name");

    const ambiguous = await JSZip.loadAsync(bytes);
    ambiguous.file("node/1.2.md", "# 其他节点\n\n不得猜测", {
      date: fixedDate,
      createFolders: false,
    });
    await expect(
      salvageKnowledgeBaseNodePatchArchive({
        bytes: await ambiguous.generateAsync({
          type: "nodebuffer",
          platform: "UNIX",
        }),
        expected,
        dbAuthorityLocked: true,
      }),
    ).rejects.toThrow("只能包含当前目标节点");
  });

  it("makes the portable validator bind initial and patch ZIPs to named expected coordinates", async () => {
    const initialFlags = portableInitialFlags({
      name: "示例企业",
      website: null,
    });
    await expect(
      runPortableValidator(await bundle(), initialFlags),
    ).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID frontmind.kb-working-set.v1"),
    });
    const equivalentCompanyFlags = [
      ...initialFlags.slice(0, -1),
      Buffer.from(
        JSON.stringify({
          name: "示例 企业",
          website: "https://example.test/",
        }),
        "utf8",
      ).toString("base64url"),
    ];
    await expect(
      runPortableValidator(
        await bundle((manifest) => {
          manifest.company = {
            name: "  示例   企业  ",
            website: "https://example.test/",
          };
        }),
        equivalentCompanyFlags,
      ),
    ).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID frontmind.kb-working-set.v1"),
    });
    const idnaCompanyFlags = [
      ...initialFlags.slice(0, -1),
      Buffer.from(
        JSON.stringify({
          name: "示例企业",
          website: "https://xn--fsqu00a.xn--0zwm56d/",
        }),
        "utf8",
      ).toString("base64url"),
    ];
    await expect(
      runPortableValidator(
        await bundle((manifest) => {
          manifest.company = {
            name: "示例企业",
            website: "https://xn--fsqu00a.xn--0zwm56d/",
          };
        }),
        idnaCompanyFlags,
      ),
    ).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID frontmind.kb-working-set.v1"),
    });
    const staleInitial = await runPortableValidator(await bundle(), [
      ...initialFlags.slice(0, 1),
      "other-operation",
      ...initialFlags.slice(2),
    ]);
    expect(staleInitial.code).not.toBe(0);
    expect(staleInitial.stderr).toContain(
      "operationId does not match the expected task coordinate",
    );

    const patchFlags = portablePatchFlags();
    await expect(
      runPortableValidator(await patch(), patchFlags),
    ).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID frontmind.kb-node-patch.v1"),
    });
    const stalePatch = await runPortableValidator(await patch(), [
      ...patchFlags.slice(0, -1),
      "1.2",
    ]);
    expect(stalePatch.code).not.toBe(0);
    expect(stalePatch.stderr).toContain(
      "targetLeafId does not match the expected task coordinate",
    );
  });

  it("uses the same frozen website equivalence boundary in Python and TypeScript", async () => {
    const accepted = [
      {
        frozen: "https://example.test/",
        provider: "example.TEST",
      },
      {
        frozen: "https://example.test/",
        provider: "https://EXAMPLE.test:443",
      },
      {
        frozen: "http://example.test/",
        provider: "http://EXAMPLE.test:80",
      },
      {
        frozen: "https://xn--fsqu00a.xn--0zwm56d/",
        provider: "例子.测试",
      },
      {
        frozen: "https://xn--fa-hia.de/",
        provider: "https://faß.de:443",
      },
    ];
    for (const vector of accepted) {
      expect(canonicalizeKnowledgeBaseWebsite(vector.provider)).toBe(
        vector.frozen,
      );
      const result = await runPortableValidator(
        await bundle((manifest) => {
          manifest.company.website = vector.provider;
        }),
        portableInitialFlags({
          name: "示例企业",
          website: vector.frozen,
        }),
      );
      expect(result, JSON.stringify(vector)).toMatchObject({ code: 0 });
    }

    const rejected = [
      "http://example.test",
      "https://example.test/path",
      "https://example.test/?q=1",
      "https://www.example.test/",
      "https://example.test/#",
      "example.test#",
      "https://@example.test",
    ];
    for (const provider of rejected) {
      let typescriptCanonical: string | null = null;
      try {
        typescriptCanonical = canonicalizeKnowledgeBaseWebsite(provider);
      } catch {
        typescriptCanonical = null;
      }
      expect(typescriptCanonical, provider).not.toBe("https://example.test/");
      const result = await runPortableValidator(
        await bundle((manifest) => {
          manifest.company.website = provider;
        }),
        portableInitialFlags({
          name: "示例企业",
          website: "https://example.test/",
        }),
      );
      expect(result.code, provider).not.toBe(0);
    }
  });
});
