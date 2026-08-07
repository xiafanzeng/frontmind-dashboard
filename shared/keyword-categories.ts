export const KEYWORD_CATEGORY_OPTIONS = [
  { key: "industry", label: "行业排名词" },
  { key: "competitor_comparison", label: "竞品对比词" },
  { key: "reputation", label: "美誉舆情词" },
  { key: "product_scenario", label: "产品场景词" },
] as const;

export type KeywordCategoryKey =
  (typeof KEYWORD_CATEGORY_OPTIONS)[number]["key"];
export type KeywordCategoryLabel =
  (typeof KEYWORD_CATEGORY_OPTIONS)[number]["label"];

const CATEGORY_LABEL_BY_KEY = Object.fromEntries(
  KEYWORD_CATEGORY_OPTIONS.map((category) => [category.key, category.label]),
) as Record<KeywordCategoryKey, KeywordCategoryLabel>;

function normalizedKeywordCategoryToken(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s_\-/]+/g, "")
    .replace(/[（）()【】\[\]：:]+/g, "");
}

const KEYWORD_CATEGORY_ALIASES = new Map<string, KeywordCategoryKey>(
  [
    [
      "industry",
      [
        "industry",
        "行业排名词",
        "行业词",
        "品类行业词",
        "行业品类词",
        "品类词",
      ],
    ],
    [
      "competitor_comparison",
      [
        "competitor_comparison",
        "competitorcomparison",
        "竞品对比词",
        "竞品比较词",
        "竞品词",
        "对比词",
      ],
    ],
    [
      "reputation",
      [
        "reputation",
        "美誉舆情词",
        "美誉词",
        "舆情词",
        "品牌核心词",
        "品牌核心",
        "品牌词",
      ],
    ],
    [
      "product_scenario",
      [
        "product_scenario",
        "productscenario",
        "产品场景词",
        "场景痛点词",
        "产品痛点词",
        "场景词",
        "痛点词",
      ],
    ],
  ].flatMap(([key, aliases]) =>
    (aliases as string[]).map(
      (alias) =>
        [
          normalizedKeywordCategoryToken(alias),
          key as KeywordCategoryKey,
        ] as const,
    ),
  ),
);

export function keywordCategoryKey(value: unknown): KeywordCategoryKey | null {
  return (
    KEYWORD_CATEGORY_ALIASES.get(normalizedKeywordCategoryToken(value)) ?? null
  );
}

export function keywordCategoryLabel(
  value: unknown,
): KeywordCategoryLabel | null {
  const key = keywordCategoryKey(value);
  return key ? CATEGORY_LABEL_BY_KEY[key] : null;
}

const KEYWORD_CATEGORY_HEADERS = new Set(
  [
    "核心词分类",
    "关键词分类",
    "词分类",
    "分类",
    "核心词类型",
    "关键词类型",
    "词类型",
  ].map(normalizedKeywordCategoryToken),
);

export function isKeywordCategoryColumn(value: unknown) {
  return KEYWORD_CATEGORY_HEADERS.has(normalizedKeywordCategoryToken(value));
}

export function keywordCategoryColumnIndex(columns: readonly unknown[]) {
  const exactCoreCategoryIndex = columns.findIndex(
    (column) => normalizedKeywordCategoryToken(column) === "核心词分类",
  );
  return exactCoreCategoryIndex >= 0
    ? exactCoreCategoryIndex
    : columns.findIndex(isKeywordCategoryColumn);
}
