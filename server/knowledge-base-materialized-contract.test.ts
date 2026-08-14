import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  validateKnowledgeBaseNodePatchArchive,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";

const fixedDate = new Date("2000-01-01T00:00:00.000Z");
const buildId = "11111111-1111-4111-8111-111111111111";
const skillHash = "a".repeat(64);

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function bundle(
  mutate?: (manifest: Record<string, any>, zip: JSZip) => void,
) {
  const zip = new JSZip();
  const leaves = Array.from({ length: 30 }, (_, index) => {
    const leafId = `1.${index + 1}`;
    const path = `nodes/${String(index + 1).padStart(4, "0")}.md`;
    const content = `## ${leafId} 节点 ${index + 1}\n\n完整正文 ${index + 1}`;
    zip.file(path, content, { date: fixedDate, createFolders: false });
    return {
      leafId,
      branchId: "identity",
      branchTitle: "企业身份",
      title: `节点 ${index + 1}`,
      ordinal: index,
      contentPath: path,
      contentSha256: sha256(content),
      evidencePaths: [],
      assetIds: [],
    };
  });
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
    researchCoverage: {},
    branches: [{ branchId: "identity", title: "企业身份", ordinal: 0 }],
    evidenceLedger: [],
    leaves,
    assets: [],
    logo: { status: "missing", assetId: null },
    counts: { leaves: 30, evidenceFiles: 0, assets: 0 },
  };
  mutate?.(manifest, zip);
  zip.file("BUNDLE.json", JSON.stringify(manifest), {
    date: fixedDate,
    createFolders: false,
  });
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

async function patch(
  mutate?: (manifest: Record<string, any>, zip: JSZip) => void,
) {
  const zip = new JSZip();
  const content = "## 1.1 修订节点\n\n修订后的完整正文";
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

describe("materialized knowledge-base ZIP contracts", () => {
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
      },
    );

    expect(validated.manifest.leaves).toHaveLength(30);
    expect(validated.manifest.contentVersion).toBe(1);
    expect(validated.files).toHaveProperty("size", 31);
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
});
