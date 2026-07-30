import { describe, expect, it } from "vitest";

import { stripKnowledgeBaseReferenceAppendix } from "../shared/knowledge-base-output";

describe("stripKnowledgeBaseReferenceAppendix", () => {
  it.each([
    "**参考资料**",
    "## 参考资料",
    "References",
    "### Sources",
  ])("removes the standalone %s appendix and everything after it", (heading) => {
    expect(
      stripKnowledgeBaseReferenceAppendix(
        [
          "## 中文名称、英文品牌与视觉识别",
          "",
          "硅基流动的英文品牌名称为 SiliconFlow。",
          "",
          heading,
          "[1] https://siliconflow.cn/",
          '<!-- FRONTMIND_KB_PROGRESS {"revision":0} -->',
        ].join("\n"),
      ),
    ).toBe(
      [
        "## 中文名称、英文品牌与视觉识别",
        "",
        "硅基流动的英文品牌名称为 SiliconFlow。",
      ].join("\n"),
    );
  });

  it("does not truncate an ordinary sentence that mentions reference material", () => {
    const text = "企业提供的参考资料包括产品手册与品牌规范。";
    expect(stripKnowledgeBaseReferenceAppendix(text)).toBe(text);
  });
});
