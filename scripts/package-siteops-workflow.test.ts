import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SITEOPS_MATERIALIZER_V1_5,
  SITEOPS_MATERIALIZER_V1_6,
  SITEOPS_MATERIALIZER_V2_0,
  SITEOPS_MATERIALIZER_V2_1,
  SITEOPS_MATERIALIZER_V2_2,
  SITEOPS_WORKFLOW,
} from "../shared/siteops";
import {
  SITEOPS_MATERIALIZER_VERSION,
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

  it("has a current deterministic FrontMind 2.3.0 React static visual contract", async () => {
    const generated = await createSiteOpsRuntimeManifest();
    expect(generated).toMatchObject({
      version: SITEOPS_RUNTIME_VERSION,
      upstream: { archiveSha256: SITEOPS_UPSTREAM_SHA256 },
      host: {
        starterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        componentLibraryVersion: SITEOPS_RUNTIME_VERSION,
        materializerVersion: SITEOPS_MATERIALIZER_VERSION,
        materializerSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    await expect(verifySiteOpsRuntimeWorkflow()).resolves.toEqual(generated);
    const runtime = JSON.parse(
      await readFile(
        `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/runtime-contract.json`,
        "utf8",
      ),
    );
    expect(runtime.visualProvider).toEqual({
      owner: "dashboard",
      name: "21st",
      requiredTools: ["search"],
      optionalTools: ["get_component"],
      normalPathTools: ["search"],
      primaryReferenceRole: "one-real-provider-reference-per-candidate",
      supportReferenceRoles: [],
      promptRequired: false,
      providerCodeReuse: false,
      hostFamilyMappingRequired: true,
      providerReferenceCount: 9,
      uniqueProviderItemRequired: true,
      uniqueProviderPreviewRequired: true,
      perceptualDiversityRequired: true,
      globalTaxonomyMergeAllowed: false,
      hostRenderedCandidateCount: 9,
      uniqueHostFamiliesRequired: true,
    });
    expect(runtime.knowledgeInput).toMatchObject({
      transport: "manifest-verified-json-attachments",
      inlineKnowledgeAllowed: false,
      messageCharacterLimit: 3000,
    });
    expect(runtime.providerWire).toMatchObject({
      phaseOneSchema: "schemas/site-design-wire-v3.schema.json",
      phaseOneCanonical:
        "SiteDesignSpecV2-with-host-injected-ReferenceBlueprintV4",
      phaseOneOutputFilename: "frontmind-site-design-wire-v3.json",
      phaseTwoSchema: "schemas/page-content-wire-v3.schema.json",
      phaseTwoCanonical: "PageContentSpecV2",
      phaseTwoOutputFilename: "frontmind-page-content-wire-v3.json",
      maximumSchemaDepth: 5,
      referenceCoordinatesAcceptedFromProvider: false,
    });
    expect(runtime.aiTask).toMatchObject({
      taskCount: 1,
      sameTaskForBothPhases: true,
      phaseOneOutput: "SiteDesignWireV3",
      phaseOneOutputFilename: "frontmind-site-design-wire-v3.json",
      phaseTwoOutput: "PageContentWireV3",
      phaseTwoOutputFilename: "frontmind-page-content-wire-v3.json",
    });
    expect(runtime.host).toMatchObject({
      profile: "react-static-html",
      sourceDataOwner: "dashboard",
      sourceDataFormat: "canonical-json",
      templateOwner: "dashboard",
      templateRuntime: "react-dom/server",
      hydrationAllowed: false,
      runtimeJavaScriptAllowed: false,
      providerTextInterpolationIntoSource: false,
    });
    expect(runtime.assetProjection).toEqual({
      decisionIdentity: "asset-id",
      contentIdentity: "sha256",
      duplicateSha256Allowed: true,
      publishAndOmitSameSha256Allowed: true,
      publishedBrandBinding: "exact-asset-id-and-sha256",
      quarantineConflictPolicy: "reject-emitted-sha256",
    });
    expect(runtime.renderer).toMatchObject({
      kind: "react_static_v2",
      componentLibraryVersion: SITEOPS_RUNTIME_VERSION,
      materializerVersion: SITEOPS_RUNTIME_VERSION,
      renderMethod: "renderToStaticMarkup",
      routeDocuments: true,
    });
    expect(runtime.referenceBlueprint).toMatchObject({
      schema: "ReferenceBlueprintV4",
      familyFrozenByDashboard: true,
      candidateReferencePreviewOwner: "provider-safe-mirror",
      candidateRealizationPreviewOwner: "dashboard",
      candidateRealizationPreviewRenderer: "trusted-react-host",
      oneReferencePerBlueprint: true,
      providerCodeAccepted: false,
    });
    expect(runtime.contentSystem).toMatchObject({
      canonical: "PageContentSpecV2",
      buildContract: "BuildContractV4",
      inventorySource: "frozen-knowledge-snapshot-only",
      companyNewsAbsentPolicy: "host-owned-empty-state-excluded-from-discovery",
      externalAcquisitionAllowed: false,
      publicSourceLabels: false,
      conditionalJsonLd: true,
      conditionalSitemapAndLlms: true,
    });
    expect(runtime.typedMaterialization).toEqual({
      schema: "schemas/materialization-stage-v2.schema.json",
      phases: [
        "input_validation",
        "asset_projection",
        "source_generation",
        "react_static_build",
        "static_qa",
        "browser_qa",
        "lighthouse",
        "qa_packaging",
        "artifact_persistence",
      ],
      retryClasses: ["content_repair", "host_transient", "host_deterministic"],
      contentRepairOwner: "ai-task-output",
      hostFailureRepairByAiAllowed: false,
    });
    const manifestBytes = await readFile(
      `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/MANIFEST.json`,
    );
    expect(SITEOPS_WORKFLOW).toMatchObject({
      frontMindVersion: SITEOPS_RUNTIME_VERSION,
      runtimeManifestSha256: createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      starterVersion: SITEOPS_RUNTIME_VERSION,
      starterSha256: generated.host.starterSha256,
      materializerVersion: SITEOPS_MATERIALIZER_VERSION,
      materializerSha256: generated.host.materializerSha256,
      qaPolicyVersion: "siteops-qa-v4",
    });
  });

  it("retains immutable historical coordinates while 2.3 freezes complete visual coordinates", async () => {
    const [legacyManifest, envelope, stageSchema, starter] = await Promise.all([
      readFile(
        "private-workflows/astro-company-site-workflow-v1.5.0/MANIFEST.json",
      ),
      readFile(
        `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/schemas/frontmind-run-envelope.schema.json`,
        "utf8",
      ),
      readFile(
        `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/schemas/materialization-stage-v2.schema.json`,
        "utf8",
      ),
      readFile(
        `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/assets/host-starter-contract.json`,
        "utf8",
      ),
    ]);
    expect(createHash("sha256").update(legacyManifest).digest("hex")).toBe(
      SITEOPS_MATERIALIZER_V1_5.runtimeManifestSha256,
    );
    const astro16Manifest = await readFile(
      "private-workflows/astro-company-site-workflow-v1.6.0/MANIFEST.json",
    );
    expect(createHash("sha256").update(astro16Manifest).digest("hex")).toBe(
      SITEOPS_MATERIALIZER_V1_6.runtimeManifestSha256,
    );
    const react20Manifest = await readFile(
      "private-workflows/react-static-company-site-workflow-v2.0.0/MANIFEST.json",
    );
    expect(createHash("sha256").update(react20Manifest).digest("hex")).toBe(
      SITEOPS_MATERIALIZER_V2_0.runtimeManifestSha256,
    );
    const react21Manifest = await readFile(
      "private-workflows/react-static-company-site-workflow-v2.1.0/MANIFEST.json",
    );
    expect(createHash("sha256").update(react21Manifest).digest("hex")).toBe(
      SITEOPS_MATERIALIZER_V2_1.runtimeManifestSha256,
    );
    const react22Manifest = await readFile(
      "private-workflows/react-static-company-site-workflow-v2.2.0/MANIFEST.json",
    );
    expect(createHash("sha256").update(react22Manifest).digest("hex")).toBe(
      SITEOPS_MATERIALIZER_V2_2.runtimeManifestSha256,
    );
    for (const version of ["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"]) {
      const preserved = JSON.parse(
        await readFile(
          `private-workflows/astro-company-site-workflow-v${version}/MANIFEST.json`,
          "utf8",
        ),
      );
      expect(preserved.version).toBe(version);
    }

    const frozenEnvelope = JSON.parse(envelope) as {
      properties: {
        schemaVersion: unknown;
        workflow: { required: string[]; properties: Record<string, unknown> };
      };
    };
    expect(frozenEnvelope.properties.schemaVersion).toEqual({ const: 8 });
    expect(frozenEnvelope.properties.workflow.required.sort()).toEqual(
      [
        "version",
        "manifestSha256",
        "starterVersion",
        "starterSha256",
        "componentLibraryVersion",
        "materializerVersion",
        "materializerSha256",
        "qaPolicyVersion",
      ].sort(),
    );
    expect(frozenEnvelope.properties.workflow.properties).toMatchObject({
      version: { const: SITEOPS_RUNTIME_VERSION },
      starterVersion: { const: SITEOPS_RUNTIME_VERSION },
      componentLibraryVersion: { const: SITEOPS_RUNTIME_VERSION },
      materializerVersion: { const: SITEOPS_MATERIALIZER_VERSION },
      qaPolicyVersion: { const: "siteops-qa-v4" },
    });

    const stages = JSON.parse(stageSchema) as {
      properties: {
        phase: { enum: string[] };
        retryClass: { enum: string[] };
      };
    };
    const runtime = JSON.parse(
      await readFile(
        `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}/runtime-contract.json`,
        "utf8",
      ),
    );
    expect(stages.properties.phase.enum).toEqual(
      runtime.typedMaterialization.phases,
    );
    expect(stages.properties.retryClass.enum).toEqual(
      runtime.typedMaterialization.retryClasses,
    );

    expect(JSON.parse(starter)).toMatchObject({
      schema: "frontmind-siteops-host-starter/v4",
      version: SITEOPS_RUNTIME_VERSION,
      contentBoundary: {
        customerAndProviderText: "canonical-json-data-only",
        reactComponents: "host-owned-only",
        providerTextInterpolationIntoSource: false,
      },
      assetDecisionPolicy: {
        duplicateSha256Allowed: true,
        publishAndOmitSameSha256Allowed: true,
      },
      heroFamilies: [
        "floating_orbit",
        "feature_grid",
        "bento",
        "split_media",
        "editorial",
        "centered_dual_cta",
        "immersive_visual",
        "product_stage",
        "full_bleed_statement",
      ],
    });
  });

  it("ships provider-compatible flat wire schemas", async () => {
    const workflowRoot = `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}`;
    const [design, content] = await Promise.all([
      readFile(
        `${workflowRoot}/schemas/site-design-wire-v3.schema.json`,
        "utf8",
      ),
      readFile(
        `${workflowRoot}/schemas/page-content-wire-v3.schema.json`,
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
    expect(designSchema.properties).not.toHaveProperty("heroFamily");
    expect(designSchema.properties).not.toHaveProperty("referenceBlueprint");
    expect(routeSlotSchema.properties).not.toHaveProperty("order");
    expect(
      (JSON.parse(content) as { properties: { schemaVersion: unknown } })
        .properties.schemaVersion,
    ).toEqual({ type: "number", enum: [3] });
  });
});
