import { describe, expect, it } from "vitest";

import {
  KnowledgeBaseEnterpriseIdentityError,
  buildKnowledgeBasePrompt,
  getKnowledgeBaseSkillDescriptor,
  resolveKnowledgeBaseEnterpriseIdentity,
  selectUnreconciledKnowledgeOutput,
} from "./knowledge-base-api";

function expectEnterpriseIdentityError(
  action: () => unknown,
  code: KnowledgeBaseEnterpriseIdentityError["code"],
) {
  try {
    action();
    throw new Error("Expected KnowledgeBaseEnterpriseIdentityError");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseEnterpriseIdentityError);
    expect((error as KnowledgeBaseEnterpriseIdentityError).code).toBe(code);
  }
}

describe("knowledge base execution contract", () => {
  it("requires budgeted deep research, real illustrated prose, and one-by-one traversal", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite:
        "https://company.example.invalid/\nhttps://evidence.example.invalid/",
      operatorNotes: "覆盖全部产品线",
      attachments: [{ file_id: "file-1", filename: "catalog.pdf" }],
    });

    expect(prompt).toContain("sitemap");
    expect(prompt).toContain("HTML 抓取尝试最多 1,200");
    expect(prompt).toContain("链接访问最多 1,800");
    expect(prompt).toContain("打包 360–480 张");
    expect(prompt).toContain("官网文档最多 120");
    expect(prompt).toContain("累计用户上传最多 100");
    expect(prompt).toContain("公开查询最多 120");
    expect(prompt).toContain("3,000,000");
    expect(prompt).toContain("目标 120,000");
    expect(prompt).toContain("ZIP 最多 1,500");
    expect(prompt).toContain("160 MiB");
    expect(prompt).toContain("第 330 分钟停止");
    expect(prompt).toContain("第 360 分钟");
    expect(prompt).toContain("00_package_manifest.json");
    expect(prompt).toContain("dashboard-enterprise-v1");
    expect(prompt).toContain("scripts/validate_archive.py");
    expect(prompt).toContain("FRONTMIND_FORMAL_CONTENT_START");
    expect(prompt).not.toContain("Crawl every company website exhaustively");
    expect(prompt).not.toContain("traversed to exhaustion");
    expect(prompt).toContain("actual cumulative counters");
    expect(prompt).toContain("Deduplicate by decoded content hash");
    expect(prompt).toContain("width");
    expect(prompt).toContain("height");
    expect(prompt).toContain("public queries in Chinese, English");
    expect(prompt).toContain("third-party facts and media");
    expect(prompt).toContain("00_web_intelligence_report.md");
    expect(prompt).toContain("40-115");
    expect(prompt).toContain("一级分支数量不设固定值");
    expect(prompt).not.toContain("恰好 7 个一级分支");
    expect(prompt).not.toContain("7 universal top-level branches");
    expect(prompt).toContain("每轮只能呈现和处理一个叶子节点");
    expect(prompt).toContain("遍历进度达到 100%");
    expect(prompt).toContain("禁止出现‘生成初版成果’");
    expect(prompt).toContain("永远不生成交互式研究网页");
    expect(prompt).toContain("标准 Markdown 标题、表格、列表和独立段落");
    expect(prompt).toContain("https://company.example.invalid/");
    expect(prompt).toContain("https://evidence.example.invalid/");
    expect(prompt).toContain("catalog.pdf");
    expect(prompt).toContain("FRONTMIND_KB_MANIFEST");
    expect(prompt).toContain("FRONTMIND_KB_PROGRESS");
    expect(prompt).toContain("FRONTMIND_KB_REOPEN");
    expect(prompt).toContain("补充、修订、问题或上传资料");
    expect(prompt).toContain("to 必须为 needs_verification");
    expect(prompt).toContain("(confirmed + direct_prefilled) / total");
  });

  it("pins new builds to v2 while preserving the immutable v1 archive", async () => {
    const active = await getKnowledgeBaseSkillDescriptor();
    const legacy = await getKnowledgeBaseSkillDescriptor({ version: "1" });

    expect(active).toMatchObject({
      name: "socratic-kb-builder",
      version: "2",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(legacy).toMatchObject({
      name: "socratic-kb-builder",
      version: "1",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(active.contentHash).not.toBe(legacy.contentHash);

    await expect(
      getKnowledgeBaseSkillDescriptor({
        version: "1",
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow("content hash does not match");
  });

  it("uses the configured workspace enterprise and rejects client identity changes", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "管理员结构化编辑",
        brandName: " 验收企业 ",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expectEnterpriseIdentityError(
      () =>
        resolveKnowledgeBaseEnterpriseIdentity({
          sourceName: null,
          brandName: "企业知识中枢",
          requestedCompanyName: "验收企业",
        }),
      "ENTERPRISE_NOT_CONFIGURED",
    );

    expectEnterpriseIdentityError(
      () =>
        resolveKnowledgeBaseEnterpriseIdentity({
          sourceName: "dashboard.json",
          brandName: "验收企业",
          requestedCompanyName: "另一家企业",
        }),
      "ENTERPRISE_IDENTITY_MISMATCH",
    );
  });

  it("allows a compatible client to omit the repeated company name", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "dashboard.csv",
        brandName: "验收企业",
      }),
    ).toBe("验收企业");
  });

  it("selects only unseen cumulative output and preserves non-cumulative turns", () => {
    const cumulative = [
      { id: "out-1", role: "assistant", content: "first" },
      { id: "out-2", role: "assistant", content: "second" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: 1,
        lastOutputItemIds: ["out-1"],
      }),
    ).toEqual([cumulative[1]]);

    const currentTurn = [
      { id: "out-9", role: "assistant", content: "current only" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(currentTurn, {
        lastOutputLength: 8,
        lastOutputItemIds: ["out-1", "out-8"],
      }),
    ).toEqual(currentTurn);
  });
});
