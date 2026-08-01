import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "../shared/dashboard";

import {
  KnowledgeBasePackageBindingError,
  assertKnowledgeBasePackageMatchesBuild,
  canonicalPackagedKnowledgeBaseLeafMarkdown,
  knowledgeBaseMarkdownSha256,
  selectLegacyKnowledgeBaseLogoAsset,
} from "./knowledge-base-package-validation";

const logoSha256 = "a".repeat(64);

function fixture() {
  return {
    nodes: [
      {
        leafId: "1.1",
        title: "一句话定位",
        branchId: "identity",
        branchTitle: "企业身份",
        ordinal: 0,
        status: "confirmed",
        contentMarkdown: "## 1.1 一句话定位\n\nFrontMind 超前智能。",
        contentSha256: knowledgeBaseMarkdownSha256(
          "## 1.1 一句话定位\n\nFrontMind 超前智能。",
        ),
      },
      {
        leafId: "1.2",
        title: "公司主体",
        branchId: "identity",
        branchTitle: "企业身份",
        ordinal: 1,
        status: "direct_prefilled",
        contentMarkdown: "## 1.2 公司主体\n\n北京示例公司。",
        contentSha256: knowledgeBaseMarkdownSha256(
          "## 1.2 公司主体\n\n北京示例公司。",
        ),
      },
    ],
    documents: [
      {
        id: "1.1",
        path: "leaves/1.1.md",
        kind: "leaf" as const,
        title: "一句话定位",
        branchId: "identity",
        branchTitle: "企业身份",
        order: 0,
        customerVisible: true,
        content: "## 1.1 一句话定位\r\n\r\nFrontMind 超前智能。\r\n",
      },
      {
        id: "1.2",
        path: "leaves/1.2.md",
        kind: "leaf" as const,
        title: "公司主体",
        branchId: "identity",
        branchTitle: "企业身份",
        order: 1,
        customerVisible: true,
        content: "## 1.2 公司主体\n\n北京示例公司。",
      },
    ],
    assets: [
      {
        id: "logo",
        key: "logo.png",
        path: "visual_assets/logo.png",
        mimeType: "image/png",
        size: 42,
        sha256: logoSha256,
        assetType: "brand_identity",
        displayRole: "badge",
      },
    ] as KnowledgeAsset[],
    expectedLogoSha256: logoSha256,
  };
}

describe("knowledge-base final package binding", () => {
  it("accepts the exact confirmed leaf set and original Logo bytes", () => {
    expect(assertKnowledgeBasePackageMatchesBuild(fixture())).toMatchObject({
      leafCount: 2,
      logoSha256,
    });
  });

  it("compares the single formal block, excluding the evidence appendix", () => {
    const input = fixture();
    input.documents[0]!.content = `# 外层成品标题\n\n<!-- FRONTMIND_FORMAL_CONTENT_START -->\n\n## 1.1 一句话定位\n\nFrontMind 超前智能。\n\n<!-- FRONTMIND_FORMAL_CONTENT_END -->\n\n## 证据与核验\n\n- 内部证据`;
    expect(
      canonicalPackagedKnowledgeBaseLeafMarkdown(input.documents[0]!.content),
    ).toBe(input.nodes[0]!.contentMarkdown);
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).not.toThrow();
  });

  it("rejects replacing one leaf with a same-count document", () => {
    const input = fixture();
    input.documents[1] = { ...input.documents[1]!, id: "1.3" };
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
      "缺少已确认节点：1.2",
    );
  });

  it("rejects branch, order, content and Logo substitutions", () => {
    const mutations = [
      (input: ReturnType<typeof fixture>) => {
        input.documents[0]!.branchId = "products";
      },
      (input: ReturnType<typeof fixture>) => {
        input.documents[0]!.order = 9;
      },
      (input: ReturnType<typeof fixture>) => {
        input.documents[0]!.content = "被替换的正文";
      },
      (input: ReturnType<typeof fixture>) => {
        input.assets[0]!.sha256 = "b".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const input = fixture();
      mutate(input);
      expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
        KnowledgeBasePackageBindingError,
      );
    }
  });

  it("rejects empty or unconfirmed nodes", () => {
    const input = fixture();
    input.nodes[1]!.status = "current";
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
      "仍有未确认节点",
    );
  });

  it("accepts a pinned v3 sparse order and extra visuals without weakening leaf hashes", () => {
    const input = fixture();
    input.documents[0]!.order = 10;
    input.documents[1]!.order = 20;
    input.assets.push(
      {
        id: "hero",
        key: "hero.webp",
        path: "visual_assets/hero.webp",
        mimeType: "image/webp",
        size: 100,
        sha256: "b".repeat(64),
        assetType: "environment_photo",
        displayRole: "hero",
      },
      {
        id: "product",
        key: "product.webp",
        path: "visual_assets/product.webp",
        mimeType: "image/webp",
        size: 100,
        sha256: "c".repeat(64),
        assetType: "product_ui",
        displayRole: "inline",
      },
    );
    input.assets[0]!.assetType = "brand_identity";
    input.assets[0]!.displayRole = "badge";

    expect(
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        legacyV3Compatibility: true,
      }),
    ).toMatchObject({ leafCount: 2, logoSha256 });
    expect(
      selectLegacyKnowledgeBaseLogoAsset({ assets: input.assets }),
    ).toMatchObject({ id: "logo", sha256: logoSha256 });

    input.documents[1]!.content = "被替换的正文";
    expect(() =>
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        legacyV3Compatibility: true,
      }),
    ).toThrow("正文与客户已确认版本不一致");
  });

  it("rejects ambiguous legacy brand badges instead of guessing a Logo", () => {
    const input = fixture();
    input.assets[0]!.assetType = "brand_identity";
    input.assets[0]!.displayRole = "badge";
    input.assets.push({
      ...input.assets[0]!,
      id: "alternate-logo",
      key: "alternate.png",
      path: "visual_assets/alternate.png",
      sha256: "d".repeat(64),
    });
    expect(() =>
      selectLegacyKnowledgeBaseLogoAsset({ assets: input.assets }),
    ).toThrow("多个不同的品牌 Logo");

    expect(() =>
      selectLegacyKnowledgeBaseLogoAsset({
        assets: [
          {
            ...input.assets[0]!,
            assetType: "product_ui",
            displayRole: "hero",
          },
        ],
      }),
    ).toThrow("未唯一标记官方主 Logo");
  });
});
