import { describe, expect, it } from "vitest";

import { siteContentPatchV1Schema } from "../../shared/siteops-content-patch";
import type { SiteBrief } from "../../shared/siteops";
import { canonicalizeSiteContentDraft } from "./site-content-draft";
import { applySiteContentPatchV1 } from "./site-content-patch";

const operationToken = "siteops-patch:00000000-0000-4000-8000-000000000001";
const baseSourceSha256 = "a".repeat(64);

function brief(): SiteBrief {
  return {
    companyName: "可信企业",
    primaryLanguage: "zh-CN",
    contacts: [],
    offerings: ["可信服务"],
    audience: ["企业客户"],
    conversionGoal: "联系企业",
    contentInventory: {
      schemaVersion: 1,
      source: "frozen_knowledge_snapshot",
      entries: [],
    },
    routes: [
      {
        id: "home",
        slug: "/",
        title: "首页",
        sourceDocumentIds: ["doc-home"],
      },
    ],
    verifiedFacts: [
      {
        statement: "冻结资料中的企业介绍。",
        sourceDocumentIds: ["doc-home"],
      },
    ],
    publicAssetIds: [],
    unknowns: [],
  };
}

function baseline() {
  return canonicalizeSiteContentDraft({
    draft: null,
    operationToken,
    brief: brief(),
    seo: {
      siteTitle: "可信企业",
      description: "可信企业官网",
      organizationType: "Organization",
    },
  });
}

describe("SiteContentPatchV1", () => {
  it("applies only source-bound text/list values to frozen coordinates", () => {
    const result = applySiteContentPatchV1({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "richText",
                value: "企业 <script>bad()</script> 可信介绍",
                sourceIds: ["doc-home"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: baseline(),
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });

    expect(result.warnings).toEqual([]);
    expect(result.canonical.routes[0]?.sections[0]).toMatchObject({
      slotId: "overview",
      paragraphs: ["企业 bad() 可信介绍"],
      sourceDocumentIds: ["doc-home"],
    });
    expect(JSON.stringify(result.canonical)).not.toContain("<script>");
  });

  it("keeps baseline values for unknown or ungrounded children", () => {
    const trusted = baseline();
    const result = applySiteContentPatchV1({
      patch: {
        schemaVersion: 1,
        operationToken,
        baseSourceSha256,
        pages: [
          {
            routeId: "unknown",
            slots: [],
          },
          {
            routeId: "home",
            slots: [
              {
                slotId: "overview",
                kind: "text",
                value: "不得采用的无来源文本",
                sourceIds: ["other-document"],
              },
            ],
          },
        ],
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
      baseline: trusted,
      allowedSourceIdsByRoute: { home: ["doc-home"] },
    });

    expect(result.canonical).toEqual(trusted);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unknown_route",
      "source_binding_invalid",
    ]);
  });

  it("rejects task/hash mismatches and executable fields", () => {
    const common = {
      schemaVersion: 1 as const,
      operationToken,
      baseSourceSha256,
      pages: [],
    };
    expect(() =>
      applySiteContentPatchV1({
        patch: { ...common, operationToken: `${operationToken}:other` },
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        baseline: baseline(),
        allowedSourceIdsByRoute: {},
      }),
    ).toThrow("SITE_CONTENT_PATCH_TOKEN_MISMATCH");
    expect(
      siteContentPatchV1Schema.safeParse({
        ...common,
        script: "alert(1)",
      }).success,
    ).toBe(false);
  });
});
