import { describe, expect, it } from "vitest";

import { buildKnowledgeBasePrompt } from "./knowledge-base-api";

describe("knowledge base execution contract", () => {
  it("requires exhaustive crawling and one-by-one leaf traversal before packaging", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "示例企业",
      companyWebsite:
        "https://www.lasermaxwave.com/\nhttps://hantencnc.com/",
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
    expect(prompt).toContain("每轮只能呈现和处理一个叶子节点");
    expect(prompt).toContain("遍历进度达到 100%");
    expect(prompt).toContain("禁止出现‘生成初版成果’");
    expect(prompt).toContain("永远不生成交互式研究网页");
    expect(prompt).toContain("标准 Markdown 标题、表格、列表和独立段落");
    expect(prompt).toContain("https://www.lasermaxwave.com/");
    expect(prompt).toContain("https://hantencnc.com/");
    expect(prompt).toContain("catalog.pdf");
  });
});
