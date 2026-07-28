import { describe, expect, it } from "vitest";

import {
  KnowledgeBaseEnterpriseIdentityError,
  buildKnowledgeBasePrompt,
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
  it("requires exhaustive crawling and one-by-one leaf traversal before packaging", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite:
        "https://company.example.invalid/\nhttps://evidence.example.invalid/",
      operatorNotes: "覆盖全部产品线",
      attachments: [{ file_id: "file-1", filename: "catalog.pdf" }],
    });

    expect(prompt).toContain("sitemap");
    expect(prompt).toContain("清洗后正文字符数与词数");
    expect(prompt).toContain("按内容哈希去重后的图片数");
    expect(prompt).toContain("图片总容量与分辨率分布");
    expect(prompt).toContain("全网企业情报采集");
    expect(prompt).toContain("中文、英文及目标市场语言检索");
    expect(prompt).toContain("第三方事实和图片");
    expect(prompt).toContain("全网企业情报检索报告");
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
