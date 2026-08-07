import { describe, expect, it } from "vitest";

import {
  KEYWORD_CATEGORY_OPTIONS,
  isKeywordCategoryColumn,
  keywordCategoryColumnIndex,
  keywordCategoryKey,
  keywordCategoryLabel,
} from "./keyword-categories";

describe("keyword category normalization", () => {
  it.each([
    ["品类行业词", "industry", "行业排名词"],
    ["行业词", "industry", "行业排名词"],
    ["竞品对比词", "competitor_comparison", "竞品对比词"],
    ["品牌核心词", "reputation", "美誉舆情词"],
    ["场景痛点词", "product_scenario", "产品场景词"],
    ["product_scenario", "product_scenario", "产品场景词"],
  ])("maps %s into the four customer labels", (source, key, label) => {
    expect(keywordCategoryKey(source)).toBe(key);
    expect(keywordCategoryLabel(source)).toBe(label);
  });

  it("keeps the category order and renamed industry label stable", () => {
    expect(KEYWORD_CATEGORY_OPTIONS.map((item) => item.label)).toEqual([
      "行业排名词",
      "竞品对比词",
      "美誉舆情词",
      "产品场景词",
    ]);
  });

  it("prefers the uploaded workbook's 核心词分类 column", () => {
    expect(isKeywordCategoryColumn(" 核心词分类 ")).toBe(true);
    expect(
      keywordCategoryColumnIndex(["问题", "分类", "核心词分类", "热度"]),
    ).toBe(2);
  });

  it("does not guess unknown source categories", () => {
    expect(keywordCategoryKey("尚未定义的分类")).toBeNull();
    expect(keywordCategoryLabel("尚未定义的分类")).toBeNull();
  });
});
