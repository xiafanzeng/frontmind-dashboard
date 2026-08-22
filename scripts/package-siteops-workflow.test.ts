import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SITEOPS_WORKFLOW } from "../shared/siteops";
import {
  SITEOPS_UPSTREAM_SHA256,
  SITEOPS_RUNTIME_VERSION,
  createSiteOpsRuntimeManifest,
  verifySiteOpsRuntimeWorkflow,
  verifyUpstreamSiteOpsWorkflow,
} from "./package-siteops-workflow.mjs";

const providerUnsupportedKeywords = new Set([
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "uniqueItems",
]);

function assertProviderWireSchema(rawSchema: unknown, depth = 1): number {
  expect(depth).toBeLessThanOrEqual(5);
  expect(rawSchema).toBeTypeOf("object");
  expect(rawSchema).not.toBeNull();
  const schema = rawSchema as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    expect(
      providerUnsupportedKeywords.has(key),
      `unsupported keyword: ${key}`,
    ).toBe(false);
  }
  let deepest = depth;
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toBeTypeOf("object");
    const properties = schema.properties as Record<string, unknown>;
    expect([...(schema.required as string[])].sort()).toEqual(
      Object.keys(properties).sort(),
    );
    for (const property of Object.values(properties)) {
      deepest = Math.max(
        deepest,
        assertProviderWireSchema(property, depth + 1),
      );
    }
  }
  if (schema.type === "array") {
    deepest = Math.max(
      deepest,
      assertProviderWireSchema(schema.items, depth + 1),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf) {
      deepest = Math.max(deepest, assertProviderWireSchema(option, depth + 1));
    }
  }
  return deepest;
}

describe("SiteOps runtime workflow package", () => {
  it("retains and verifies the exact read-only upstream 1.0.0 archive", async () => {
    await expect(verifyUpstreamSiteOpsWorkflow()).resolves.toEqual({
      archiveHash: SITEOPS_UPSTREAM_SHA256,
      files: 58,
    });
  });

  it("has a current deterministic FrontMind 1.5.0 Hero and attachment contract", async () => {
    const generated = await createSiteOpsRuntimeManifest();
    expect(generated).toMatchObject({
      version: SITEOPS_RUNTIME_VERSION,
      upstream: { archiveSha256: SITEOPS_UPSTREAM_SHA256 },
      host: {
        starterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        componentLibraryVersion: "1.0.0",
        materializerVersion: "1.0.0",
        materializerSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    await expect(verifySiteOpsRuntimeWorkflow()).resolves.toEqual(generated);
    const runtime = JSON.parse(
      await readFile(
        `private-workflows/astro-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/runtime-contract.json`,
        "utf8",
      ),
    );
    expect(runtime.visualProvider).toEqual({
      owner: "dashboard",
      name: "21st",
      requiredTools: ["search"],
      optionalTools: ["get_component"],
      normalPathTools: ["search"],
      primaryReferenceRole: "hero",
      supportReferenceRoles: ["section", "motion"],
      promptRequired: false,
      providerCodeReuse: false,
    });
    expect(runtime.knowledgeInput).toMatchObject({
      transport: "manifest-verified-json-attachments",
      inlineKnowledgeAllowed: false,
      messageCharacterLimit: 3000,
    });
    expect(runtime.providerWire).toMatchObject({
      phaseOneSchema: "schemas/site-design-wire-v2.schema.json",
      phaseOneCanonical: "SiteDesignSpecV1",
      phaseOneOutputFilename: "frontmind-site-design-wire-v2.json",
      phaseTwoSchema: "schemas/page-content-wire-v2.schema.json",
      phaseTwoCanonical: "PageContentSpecV1",
      phaseTwoOutputFilename: "frontmind-page-content-wire-v2.json",
      maximumSchemaDepth: 5,
    });
    expect(runtime.aiTask).toMatchObject({
      taskCount: 1,
      sameTaskForBothPhases: true,
      phaseOneOutput: "SiteDesignWireV2",
      phaseOneOutputFilename: "frontmind-site-design-wire-v2.json",
      phaseTwoOutput: "PageContentWireV2",
      phaseTwoOutputFilename: "frontmind-page-content-wire-v2.json",
    });
    const manifestBytes = await readFile(
      `private-workflows/astro-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/MANIFEST.json`,
    );
    expect(SITEOPS_WORKFLOW).toMatchObject({
      frontMindVersion: SITEOPS_RUNTIME_VERSION,
      runtimeManifestSha256: createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      starterVersion: SITEOPS_RUNTIME_VERSION,
      starterSha256: generated.host.starterSha256,
      materializerSha256: generated.host.materializerSha256,
    });
  });

  it("ships provider-compatible flat wire schemas", async () => {
    const workflowRoot = `private-workflows/astro-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}`;
    const [design, content] = await Promise.all([
      readFile(
        `${workflowRoot}/schemas/site-design-wire-v2.schema.json`,
        "utf8",
      ),
      readFile(
        `${workflowRoot}/schemas/page-content-wire-v2.schema.json`,
        "utf8",
      ),
    ]);
    expect(assertProviderWireSchema(JSON.parse(design))).toBeLessThanOrEqual(5);
    expect(assertProviderWireSchema(JSON.parse(content))).toBeLessThanOrEqual(
      5,
    );
    const designSchema = JSON.parse(design) as {
      properties: Record<string, unknown>;
    };
    const routeSlotSchema = (
      designSchema.properties.routeSlots as {
        items: { properties: Record<string, unknown> };
      }
    ).items;
    expect(designSchema.properties).not.toHaveProperty("organizationType");
    expect(routeSlotSchema.properties).not.toHaveProperty("order");
    expect(
      (JSON.parse(content) as { properties: { schemaVersion: unknown } })
        .properties.schemaVersion,
    ).toEqual({ type: "number", enum: [2] });
  });
});
