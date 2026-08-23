import { describe, expect, it } from "vitest";

import {
  canonicalSiteOpsSha256,
  composeBuildContractV3,
  composeBuildPlanContractV3,
  composeBuildContractV2,
  FRONTMIND_VISUAL_FAMILIES_V3,
  referenceBlueprintForVisualCandidate,
  referenceBlueprintV3ForFamily,
  referenceBlueprintV2Schema,
  referenceBlueprintV3Schema,
  trustedVisualPreviewBlueprintV3,
  pageContentResultV1Schema,
  siteDesignResultV1Schema,
  validateDesignAndContentBindings,
} from "./siteops-design";

const H = (value: string) => canonicalSiteOpsSha256(value);

function design() {
  return {
    schemaVersion: 1 as const,
    layoutArchetype: "asymmetric" as const,
    heroVariant: "split_media" as const,
    density: "balanced" as const,
    surfaceStyle: "bordered" as const,
    typeScale: "display" as const,
    imageTreatment: "contained" as const,
    motionLevel: "subtle" as const,
    colorRoles: {
      backgroundPaletteIndex: 2,
      textPaletteIndex: 0,
      accentPaletteIndex: 1,
    },
    routeCompositions: [
      {
        routeId: "home",
        slots: [
          { slotId: "proof", variant: "proof" as const },
          { slotId: "contact", variant: "cta" as const },
        ],
      },
    ],
    seoPlan: {
      siteTitle: "FrontMind",
      description: "基于已验证企业知识的官网。",
      organizationType: "Organization" as const,
    },
  };
}

describe("SiteOps Manus design and content contracts", () => {
  it("accepts only allowlisted structured design and rejects executable output", () => {
    expect(
      siteDesignResultV1Schema.parse({
        operationToken: "siteops-design:1",
        designSpec: design(),
      }).designSpec.layoutArchetype,
    ).toBe("asymmetric");
    expect(() =>
      siteDesignResultV1Schema.parse({
        operationToken: "siteops-design:1",
        designSpec: {
          ...design(),
          astro: "<script>fetch('/secret')</script>",
        },
      }),
    ).toThrow();
  });

  it("binds every PageContentSpec route and slot to phase one in order", () => {
    const pageContent = pageContentResultV1Schema.parse({
      operationToken: "siteops-content:1",
      pageContent: {
        schemaVersion: 1,
        routes: [
          {
            routeId: "home",
            heading: "可靠的企业官网",
            summary: "严格引用企业知识。",
            sections: [
              {
                slotId: "proof",
                heading: "可信能力",
                paragraphs: ["所有事实均有来源。"],
                sourceDocumentIds: ["overview"],
              },
              {
                slotId: "contact",
                heading: "联系团队",
                paragraphs: ["通过已验证联系方式沟通。"],
                sourceDocumentIds: ["overview"],
              },
            ],
          },
        ],
      },
    }).pageContent;
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 3,
        designSpec: design(),
        pageContent,
      }),
    ).not.toThrow();
    expect(() =>
      validateDesignAndContentBindings({
        routeIds: ["home"],
        paletteSize: 3,
        designSpec: design(),
        pageContent: {
          ...pageContent,
          routes: [
            {
              ...pageContent.routes[0]!,
              sections: [...pageContent.routes[0]!.sections].reverse(),
            },
          ],
        },
      }),
    ).toThrow("SITEOPS_CONTENT_SLOT_SET_MISMATCH");
  });

  it("pins visual evidence, design and trusted host coordinates in BuildContractV2", () => {
    const contract = composeBuildContractV2({
      schemaVersion: 2,
      source: {
        knowledgeSnapshotId: "11111111-1111-4111-8111-111111111111",
        archiveSha256: H("archive"),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: H("upstream"),
        version: "1.2.0",
        manifestSha256: H("manifest"),
        starterVersion: "1.2.0",
        starterSha256: H("starter"),
        componentLibraryVersion: "1.0.0",
        materializerVersion: "1.0.0",
        materializerSha256: H("materializer"),
      },
      identity: {
        companyName: "FrontMind",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: H("query"),
        selectedCandidateId: "candidate-B",
        providerItemKey: "n:143",
        visualEvidenceSha256: H("evidence"),
        previewSha256: H("preview"),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation",
          palette: ["#10212B", "#EF6C45", "#F5F2EA"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        designSpecHash: canonicalSiteOpsSha256(design()),
        componentLibraryVersion: "1.0.0",
      },
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      assets: [],
      seo: {
        ...design().seoPlan,
        environment: "preview",
        canonicalPolicy: "forbidden",
      },
      target: { environment: "preview", canonicalOrigin: null },
      qaPolicyVersion: "siteops-qa-v1",
    });
    expect(contract.specHash).toHaveLength(64);
    expect(JSON.stringify(contract)).not.toContain("promptSha");
  });

  it("freezes the selected F catalog item to the floating-orbit React family", () => {
    const blueprint = referenceBlueprintForVisualCandidate({
      candidateId: "candidate-F",
      providerItemKey: "n:8435",
      previewSha256: H("preview-f"),
      title: "Hero Section 7",
      sourceUrl: "https://21st.dev/example/hero-section-7",
      heroEligibility: { variant: "centered_statement" },
    });
    expect(blueprint).toMatchObject({
      heroFamily: "floating_orbit",
      alignment: "center",
      mediaRegion: "surround",
      backgroundStyle: "warm_light",
      containerStyle: "contained",
      motionLevel: "floating_subtle",
      mediaStrategy: "procedural_brand_svg",
    });
    expect(() =>
      referenceBlueprintV2Schema.parse({
        ...blueprint,
        heroFamily: "centered_dual_cta",
      }),
    ).toThrow("Reference blueprint hash does not match");
  });

  it("freezes exactly nine distinct FrontMind-owned V3 visual families", () => {
    const blueprints = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily, index) =>
      referenceBlueprintV3ForFamily({
        candidateId: `candidate-${index + 1}`,
        providerItemKey: `s:frontmind:${heroFamily}`,
        previewLocalAssetId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        previewSha256: H(`preview-${heroFamily}`),
        heroFamily,
        inspirationEvidenceIds: [H("safe-21st-inspiration")],
      }),
    );
    expect(blueprints).toHaveLength(9);
    expect(new Set(blueprints.map((item) => item.heroFamily)).size).toBe(9);
    expect(
      blueprints.every((item) =>
        item.componentManifest.includes(`hero:${item.heroFamily}`),
      ),
    ).toBe(true);
    expect(() =>
      referenceBlueprintV3Schema.parse({
        ...blueprints[0],
        heroFamily: "proof_grid",
      }),
    ).toThrow();
  });

  it("projects only allowlisted inspiration taxonomy into the frozen V3 blueprint", () => {
    const darkEditorialPreview = trustedVisualPreviewBlueprintV3(
      "split_media",
      [
        {
          palette: ["#241238", "dark-canvas", "high-contrast"],
          typography: ["serif-editorial"],
          layout: ["editorial-rhythm", "premium-restrained"],
          motion: ["short-transition"],
          accessibility: ["reduced-motion-required"],
        },
      ],
    );
    const lightTechnicalPreview = trustedVisualPreviewBlueprintV3(
      "split_media",
      [
        {
          palette: ["#dbeafe", "light-canvas", "high-contrast"],
          typography: ["condensed-technical"],
          layout: ["modular-grid", "technical-precise"],
          motion: ["short-transition"],
          accessibility: ["reduced-motion-required"],
        },
      ],
    );

    expect(darkEditorialPreview).toMatchObject({
      heroFamily: "split_media",
      typeSystem: "editorial_serif",
      typographyStyle: "editorial",
      density: "spacious",
      decorationStyle: "editorial_lines",
      backgroundStyle: "dark",
      gradientStyle: "spotlight",
    });
    expect(lightTechnicalPreview).toMatchObject({
      heroFamily: "split_media",
      typeSystem: "technical_sans",
      typographyStyle: "technical",
      density: "compact",
      decorationStyle: "grid",
      backgroundStyle: "cool_light",
    });
    expect(darkEditorialPreview.palette).not.toEqual(
      lightTechnicalPreview.palette,
    );
    expect(Object.values(darkEditorialPreview.palette)).not.toContain(
      "#241238",
    );

    const common = {
      candidateId: "candidate-inspired",
      providerItemKey: "s:frontmind:split_media",
      previewLocalAssetId: "00000000-0000-4000-8000-000000000099",
      previewSha256: H("inspired-preview"),
      heroFamily: "split_media" as const,
      inspirationEvidenceIds: [H("safe-21st-inspiration")],
    };
    const darkFrozen = referenceBlueprintV3ForFamily({
      ...common,
      previewBlueprint: darkEditorialPreview,
    });
    const lightFrozen = referenceBlueprintV3ForFamily({
      ...common,
      previewBlueprint: lightTechnicalPreview,
    });
    expect(darkFrozen.blueprintHash).not.toBe(lightFrozen.blueprintHash);
    expect(darkFrozen.palette).toEqual(darkEditorialPreview.palette);
    expect(lightFrozen.palette).toEqual(lightTechnicalPreview.palette);
  });

  it("uses the family baseline when inspiration contains no qualifying safe tokens", () => {
    const baseline = trustedVisualPreviewBlueprintV3("floating_orbit");
    const unqualified = trustedVisualPreviewBlueprintV3("floating_orbit", [
      {
        palette: ["provider-secret-palette", "javascript:alert(1)"],
        typography: ["download-this-provider-font"],
        layout: ["copy-third-party-component"],
        motion: ["run-provider-animation-code"],
        accessibility: ["unknown-provider-directive"],
      },
    ]);

    expect(unqualified).toEqual(baseline);
    expect(baseline).toMatchObject({
      heroFamily: "floating_orbit",
      palette: {
        canvas: "#f7f1e8",
        ink: "#1f2937",
        accent: "#a34805",
        muted: "#eadfce",
      },
      typeSystem: "humanist_sans",
      density: "spacious",
      decorationStyle: "orbital",
      backgroundStyle: "warm_light",
    });
    expect(JSON.stringify(unqualified)).not.toContain("provider");
  });

  it("rejects a low-contrast V3 palette before the candidate blueprint is frozen", () => {
    const previewBlueprint = trustedVisualPreviewBlueprintV3("split_media");
    expect(() =>
      referenceBlueprintV3ForFamily({
        candidateId: "candidate-low-contrast",
        providerItemKey: "s:frontmind:split_media",
        previewLocalAssetId: "00000000-0000-4000-8000-000000000088",
        previewSha256: H("low-contrast-preview"),
        heroFamily: "split_media",
        inspirationEvidenceIds: [H("safe-21st-inspiration")],
        previewBlueprint: {
          ...previewBlueprint,
          palette: {
            canvas: "#ffffff",
            ink: "#eeeeee",
            accent: "#dddddd",
            muted: "#ffffff",
          },
        },
      }),
    ).toThrow("SITEOPS_VISUAL_PALETTE_CONTRAST_INVALID");
  });

  it("keeps pre-materialization plans distinct from final BuildContractV3", () => {
    const referenceBlueprint = referenceBlueprintForVisualCandidate({
      candidateId: "candidate-F",
      providerItemKey: "n:8435",
      previewSha256: H("preview-f"),
    });
    const base = {
      schemaVersion: 3 as const,
      source: {
        knowledgeSnapshotId: "11111111-1111-4111-8111-111111111111",
        archiveSha256: H("archive"),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: H("upstream"),
        version: "2.0.0",
        manifestSha256: H("manifest"),
        starterVersion: "2.0.0",
        starterSha256: H("starter"),
        componentLibraryVersion: "2.0.0",
        materializerVersion: "2.0.0",
        materializerSha256: H("materializer"),
      },
      renderer: {
        kind: "react_static_v1" as const,
        reactVersion: "19.2.1",
        componentLibraryVersion: "2.0.0" as const,
        materializerVersion: "2.0.0" as const,
      },
      identity: {
        companyName: "FrontMind",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: H("query"),
        selectedCandidateId: "candidate-F",
        providerItemKey: "n:8435",
        visualEvidenceSha256: H("visual-evidence"),
        previewSha256: H("preview-f"),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation" as const,
          palette: ["#F7F1E6", "#17201B", "#C96C3B"],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
      },
      referenceBlueprint,
      designSpecHash: H("design"),
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      assets: [],
      seo: {
        siteTitle: "FrontMind",
        description: "可信企业官网",
        organizationType: "Organization" as const,
        environment: "preview" as const,
        canonicalPolicy: "forbidden" as const,
      },
      target: { environment: "preview" as const, canonicalOrigin: null },
      qaPolicyVersion: "siteops-react-static-qa-v3",
    };
    const plan = composeBuildPlanContractV3({
      ...base,
      contractKind: "build_plan",
    });
    expect(plan).not.toHaveProperty("sourceHash");
    expect(plan.contractKind).toBe("build_plan");

    const contract = composeBuildContractV3({
      ...base,
      contractKind: "build_contract",
      sourceHash: H("canonical-source-entries"),
      distHash: H("dist"),
    });
    expect(contract.contractKind).toBe("build_contract");
    expect(contract.sourceHash).toHaveLength(64);
    expect(contract.specHash).not.toBe(plan.specHash);
  });
});
