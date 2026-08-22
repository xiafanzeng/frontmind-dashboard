import { describe, expect, it } from "vitest";

import {
  assertSiteOpsStructuredOutputSchema,
  pageContentResultFromWire,
  pageContentWireOutputSchema,
  siteDesignResultFromWire,
  siteDesignWireOutputSchema,
  siteOpsSourceDossierAttachments,
  socialWireOutputSchema,
} from "./manus-wire-contract";

function visitSchema(value: unknown, found = new Set<string>()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const child of value) visitSchema(child, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    visitSchema(child, found);
  }
  return found;
}

describe("SiteOps provider wire contracts", () => {
  it("uses only the provider-supported structured-output subset", () => {
    const schemas = [
      siteDesignWireOutputSchema({
        operationToken: "design-token",
        routeIds: ["home", "about"],
        paletteSize: 3,
      }),
      pageContentWireOutputSchema({
        operationToken: "content-token",
        routeIds: ["home", "about"],
        sourceDocumentIds: ["overview", "about-source"],
      }),
      socialWireOutputSchema({
        operationToken: "social-token",
        channel: "xiaohongshu",
        sourceDocumentIds: ["overview"],
      }),
    ];
    for (const schema of schemas) {
      expect(() => assertSiteOpsStructuredOutputSchema(schema)).not.toThrow();
      const keys = visitSchema(schema);
      for (const forbidden of [
        "pattern",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
      ]) {
        expect(keys.has(forbidden)).toBe(false);
      }
    }
  });

  it("rejects an unsupported keyword before a request can be sent", () => {
    expect(() =>
      assertSiteOpsStructuredOutputSchema({
        type: "object",
        properties: { answer: { type: "string", pattern: "x" } },
        required: ["answer"],
        additionalProperties: false,
      }),
    ).toThrow("SITEOPS_WIRE_SCHEMA_KEY_UNSUPPORTED");
  });

  it("adapts flat design and content wire values back into strict host contracts", () => {
    const design = siteDesignResultFromWire(
      {
        operationToken: "design-token",
        schemaVersion: 1,
        layoutArchetype: "split",
        heroVariant: "split_media",
        density: "balanced",
        surfaceStyle: "bordered",
        typeScale: "display",
        imageTreatment: "contained",
        motionLevel: "subtle",
        backgroundPaletteIndex: 0,
        textPaletteIndex: 1,
        accentPaletteIndex: 2,
        siteTitle: "星河智造",
        description: "经过知识来源核验的企业官网。",
        organizationType: "Organization",
        routeSlots: [
          { routeId: "home", slotId: "cta", variant: "cta", order: 1 },
          {
            routeId: "home",
            slotId: "statement",
            variant: "statement",
            order: 0,
          },
        ],
      },
      ["home"],
    );
    expect(design.designSpec.routeCompositions[0]?.slots).toEqual([
      { slotId: "statement", variant: "statement" },
      { slotId: "cta", variant: "cta" },
    ]);

    const content = pageContentResultFromWire(
      {
        operationToken: "content-token",
        schemaVersion: 1,
        routes: [
          {
            routeId: "home",
            eyebrow: null,
            heading: "可信制造服务",
            summary: "基于企业知识库生成。",
          },
        ],
        sections: [
          {
            routeId: "home",
            slotId: "statement",
            heading: "服务能力",
            paragraphs: ["提供经过来源核验的设备服务。"],
            sourceDocumentIds: ["overview"],
          },
          {
            routeId: "home",
            slotId: "cta",
            heading: "联系团队",
            paragraphs: ["欢迎进一步沟通。"],
            sourceDocumentIds: ["overview"],
          },
        ],
      },
      ["home"],
      ["overview"],
    );
    expect(content.pageContent.routes[0]).toMatchObject({
      routeId: "home",
      sections: [{ slotId: "statement" }, { slotId: "cta" }],
    });
    expect(content.pageContent.routes[0]).not.toHaveProperty("eyebrow");
  });

  it("deterministically splits an oversized dossier without truncating document content", () => {
    const contents = ["甲", "乙", "丙"].map((character) =>
      character.repeat(3_000_000),
    );
    const attachments = siteOpsSourceDossierAttachments({
      operationToken: "design-token",
      snapshot: {
        id: "50000000-0000-4000-8000-000000000005",
        archiveSha256: "a".repeat(64),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      brief: { companyName: "星河智造" },
      visualEvidence: { previewSha256: "b".repeat(64) },
      documents: contents.map((content, index) => ({
        id: `doc-${index + 1}`,
        path: `doc-${index + 1}.md`,
        title: `资料 ${index + 1}`,
        content,
        kind: "leaf",
        customerVisible: true as const,
      })),
    });
    expect(attachments.length).toBeGreaterThan(1);
    expect(attachments[0]?.filename).toBe(
      "frontmind-siteops-source-dossier-v1.json",
    );
    const decoded = attachments.map((attachment) =>
      Buffer.from(attachment.file_data.split(",", 2)[1]!, "base64"),
    );
    expect(decoded.every((bytes) => bytes.length <= 16 * 1024 * 1024)).toBe(
      true,
    );
    const parts = decoded.slice(1).flatMap((bytes) => {
      const value = JSON.parse(bytes.toString("utf8"));
      return value.documents as Array<{
        id: string;
        content: string;
        contentPartIndex: number;
      }>;
    });
    for (const [index, content] of contents.entries()) {
      expect(
        parts
          .filter((document) => document.id === `doc-${index + 1}`)
          .sort((left, right) => left.contentPartIndex - right.contentPartIndex)
          .map((document) => document.content)
          .join(""),
      ).toBe(content);
    }
  });
});
