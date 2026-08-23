import { createHash } from "node:crypto";
import { z } from "zod";
import { siteBriefSchema, visualTaxonomySchema } from "./siteops";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const siteLayoutArchetypeSchema = z.enum([
  "hero_led",
  "editorial",
  "modular",
  "split",
  "asymmetric",
]);
export const siteHeroVariantSchema = z.enum([
  "split_media",
  "centered_statement",
  "editorial_lede",
  "proof_grid",
]);
export const siteHeroFamilySchema = z.enum([
  "floating_orbit",
  "feature_grid",
  "bento",
  "split_media",
  "editorial",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "proof_grid",
  "full_bleed_statement",
]);
export const siteSectionVariantSchema = z.enum([
  "statement",
  "split",
  "cards",
  "timeline",
  "faq",
  "proof",
  "cta",
]);
export const siteSeoPlanSchema = z
  .object({
    siteTitle: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200),
    organizationType: z.enum([
      "Organization",
      "Corporation",
      "ProfessionalService",
    ]),
  })
  .strict();

export const siteDesignSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    layoutArchetype: siteLayoutArchetypeSchema,
    heroVariant: siteHeroVariantSchema,
    density: z.enum(["compact", "balanced", "spacious"]),
    surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    typeScale: z.enum(["restrained", "editorial", "display"]),
    imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
    motionLevel: z.enum(["none", "subtle"]),
    colorRoles: z
      .object({
        backgroundPaletteIndex: z.number().int().nonnegative().max(11),
        textPaletteIndex: z.number().int().nonnegative().max(11),
        accentPaletteIndex: z.number().int().nonnegative().max(11),
      })
      .strict(),
    routeCompositions: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slots: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    variant: siteSectionVariantSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    seoPlan: siteSeoPlanSchema,
  })
  .strict();

const referenceBlueprintV2BaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    candidateId: z.string().trim().min(1).max(191),
    providerItemKey: z
      .string()
      .trim()
      .min(3)
      .max(514)
      .regex(/^(?:n:[1-9]\d*|s:.+)$/u),
    previewSha256: sha256Schema,
    heroFamily: siteHeroFamilySchema,
    alignment: z.enum(["left", "center", "right"]),
    contentEmphasis: z.enum(["statement", "balanced", "product", "proof"]),
    mediaRegion: z.enum(["none", "inline", "split", "surround", "full_bleed"]),
    mediaRatio: z.enum(["none", "square", "portrait", "landscape", "wide"]),
    composition: z.enum([
      "centered",
      "split",
      "editorial",
      "modular",
      "immersive",
    ]),
    backgroundStyle: z.enum([
      "warm_light",
      "cool_light",
      "dark",
      "gradient",
      "image_stage",
    ]),
    gradientStyle: z.enum(["none", "soft_radial", "mesh", "spotlight"]),
    borderStyle: z.enum(["none", "subtle", "defined"]),
    radiusStyle: z.enum(["none", "soft", "rounded", "pill"]),
    decorationStyle: z.enum([
      "none",
      "orbital",
      "grid",
      "glow",
      "editorial_lines",
    ]),
    navStyle: z.enum(["minimal", "floating", "bordered"]),
    ctaStyle: z.enum(["single", "dual", "pill", "text_link"]),
    cardStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    containerStyle: z.enum(["contained", "wide", "edge_to_edge"]),
    typographyStyle: z.enum([
      "restrained",
      "editorial",
      "display",
      "technical",
    ]),
    density: z.enum(["compact", "balanced", "spacious"]),
    responsiveBehavior: z.enum(["stack", "reflow", "crop_safe"]),
    motionLevel: z.enum(["none", "subtle", "floating_subtle"]),
    mediaStrategy: z.enum(["customer_asset", "procedural_brand_svg", "none"]),
  })
  .strict();

export const referenceBlueprintV2Schema = referenceBlueprintV2BaseSchema
  .extend({ blueprintHash: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { blueprintHash: _blueprintHash, ...coordinates } = value;
    if (blueprintHashForReference(coordinates) !== value.blueprintHash) {
      context.addIssue({
        code: "custom",
        path: ["blueprintHash"],
        message: "Reference blueprint hash does not match its coordinates",
      });
    }
  });

export const siteDesignSpecV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    referenceBlueprint: referenceBlueprintV2Schema,
    layoutArchetype: siteLayoutArchetypeSchema,
    density: z.enum(["compact", "balanced", "spacious"]),
    surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    typeScale: z.enum(["restrained", "editorial", "display"]),
    imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
    motionLevel: z.enum(["none", "subtle"]),
    colorRoles: z
      .object({
        backgroundPaletteIndex: z.number().int().nonnegative().max(11),
        textPaletteIndex: z.number().int().nonnegative().max(11),
        accentPaletteIndex: z.number().int().nonnegative().max(11),
      })
      .strict(),
    routeCompositions: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            slots: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    variant: siteSectionVariantSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    seoPlan: siteSeoPlanSchema,
  })
  .strict();

export const pageContentSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    routes: z
      .array(
        z
          .object({
            routeId: z.string().trim().min(1).max(64),
            eyebrow: z.string().trim().min(1).max(100).optional(),
            heading: z.string().trim().min(1).max(180),
            summary: z.string().trim().min(1).max(600),
            sections: z
              .array(
                z
                  .object({
                    slotId: z
                      .string()
                      .trim()
                      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
                    heading: z.string().trim().min(1).max(160),
                    paragraphs: z
                      .array(z.string().trim().min(1).max(2_000))
                      .min(1)
                      .max(8),
                    sourceDocumentIds: z
                      .array(z.string().trim().min(1).max(191))
                      .min(1)
                      .max(30),
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

export const siteDesignResultV1Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    designSpec: siteDesignSpecV1Schema,
  })
  .strict();
export const siteDesignResultV2Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    designSpec: siteDesignSpecV2Schema,
  })
  .strict();
export const pageContentResultV1Schema = z
  .object({
    operationToken: z.string().min(1).max(128),
    pageContent: pageContentSpecV1Schema,
  })
  .strict();

export const siteOpsRuntimeVisualEvidenceV1Schema = z
  .object({
    queryHash: sha256Schema,
    selectedCandidateId: z.string().trim().min(1).max(191),
    providerItemKey: z.string().trim().min(1).max(512),
    visualEvidenceSha256: sha256Schema,
    previewSha256: sha256Schema,
    supportEvidenceSha256s: z.array(sha256Schema).max(2).default([]),
    taxonomy: visualTaxonomySchema,
  })
  .strict();

export const siteOpsRuntimeVisualEvidenceV2Schema =
  siteOpsRuntimeVisualEvidenceV1Schema
    .extend({
      schemaVersion: z.literal(2),
      referenceBlueprint: referenceBlueprintV2Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.selectedCandidateId !== value.referenceBlueprint.candidateId ||
        value.providerItemKey !== value.referenceBlueprint.providerItemKey ||
        value.previewSha256 !== value.referenceBlueprint.previewSha256
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceBlueprint"],
          message: "Reference blueprint does not match frozen visual evidence",
        });
      }
    });

export const buildContractV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    source: z
      .object({
        knowledgeSnapshotId: z.string().uuid(),
        archiveSha256: sha256Schema,
        sourceBuildId: z.string().max(191).nullable(),
        sourceBuildRevision: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    workflow: z
      .object({
        upstreamSha256: sha256Schema,
        version: z.string().max(32),
        manifestSha256: sha256Schema,
        starterVersion: z.string().max(32),
        starterSha256: sha256Schema,
        componentLibraryVersion: z.string().max(32),
        materializerVersion: z.string().max(32),
        materializerSha256: sha256Schema,
      })
      .strict(),
    identity: z
      .object({
        companyName: z.string().min(1).max(255),
        primaryLanguage: z.string().min(2).max(32),
        verifiedContacts: z.array(z.string().max(512)).max(20),
      })
      .strict(),
    visual: siteOpsRuntimeVisualEvidenceV1Schema
      .extend({
        designSpecHash: sha256Schema,
        componentLibraryVersion: z.string().max(32),
      })
      .strict(),
    routes: siteBriefSchema.shape.routes,
    assets: z
      .array(
        z
          .object({
            id: z.string().max(191),
            sha256: sha256Schema,
            decision: z.enum(["publish", "omit", "quarantine"]),
          })
          .strict(),
      )
      .max(500),
    seo: siteSeoPlanSchema
      .extend({
        environment: z.enum(["preview", "production"]),
        canonicalPolicy: z.enum(["forbidden", "exact_https_origin"]),
      })
      .strict(),
    target: z
      .object({
        environment: z.enum(["preview", "global_excluding_cn", "mainland_cn"]),
        canonicalOrigin: z.string().url().nullable(),
      })
      .strict(),
    qaPolicyVersion: z.string().max(64),
    specHash: sha256Schema,
  })
  .strict();

const buildPlanContractV3BaseSchema = z
  .object({
    schemaVersion: z.literal(3),
    contractKind: z.literal("build_plan"),
    source: buildContractV2Schema.shape.source,
    workflow: buildContractV2Schema.shape.workflow,
    renderer: z
      .object({
        kind: z.literal("react_static_v1"),
        reactVersion: z.string().trim().min(1).max(32),
        componentLibraryVersion: z.literal("2.0.0"),
        materializerVersion: z.literal("2.0.0"),
      })
      .strict(),
    identity: buildContractV2Schema.shape.identity,
    visual: siteOpsRuntimeVisualEvidenceV1Schema,
    referenceBlueprint: referenceBlueprintV2Schema,
    designSpecHash: sha256Schema,
    routes: buildContractV2Schema.shape.routes,
    assets: buildContractV2Schema.shape.assets,
    seo: buildContractV2Schema.shape.seo,
    target: buildContractV2Schema.shape.target,
    qaPolicyVersion: z.string().max(64),
    specHash: sha256Schema,
  })
  .strict();

function validateBuildContractV3Coordinates(
  value: Pick<
    z.infer<typeof buildPlanContractV3BaseSchema>,
    "visual" | "referenceBlueprint" | "workflow" | "renderer"
  >,
  context: z.RefinementCtx,
) {
  if (
    value.visual.selectedCandidateId !== value.referenceBlueprint.candidateId ||
    value.visual.providerItemKey !== value.referenceBlueprint.providerItemKey ||
    value.visual.previewSha256 !== value.referenceBlueprint.previewSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["referenceBlueprint"],
      message: "Build contract blueprint does not match visual evidence",
    });
  }
  if (
    value.workflow.componentLibraryVersion !==
      value.renderer.componentLibraryVersion ||
    value.workflow.materializerVersion !== value.renderer.materializerVersion
  ) {
    context.addIssue({
      code: "custom",
      path: ["renderer"],
      message: "Renderer coordinates do not match workflow coordinates",
    });
  }
}

/** Pre-materialization projection sent to the content phase of the same AI
 * task. It is deliberately not named BuildContract: artifact digests do not
 * exist yet. */
export const buildPlanContractV3Schema =
  buildPlanContractV3BaseSchema.superRefine(validateBuildContractV3Coordinates);

/** Final immutable host contract. `sourceHash` is the digest of canonical
 * source entries excluding build-contract.json, so the contract cannot hash
 * itself. */
export const buildContractV3Schema = buildPlanContractV3BaseSchema
  .omit({ contractKind: true })
  .extend({
    contractKind: z.literal("build_contract"),
    sourceHash: sha256Schema,
    distHash: sha256Schema,
  })
  .strict()
  .superRefine(validateBuildContractV3Coordinates);

export type SiteDesignSpecV1 = z.infer<typeof siteDesignSpecV1Schema>;
export type SiteHeroFamily = z.infer<typeof siteHeroFamilySchema>;
export type ReferenceBlueprintV2 = z.infer<typeof referenceBlueprintV2Schema>;
export type SiteDesignSpecV2 = z.infer<typeof siteDesignSpecV2Schema>;
export type SiteDesignSpec = SiteDesignSpecV1 | SiteDesignSpecV2;
export type PageContentSpecV1 = z.infer<typeof pageContentSpecV1Schema>;
export type SiteOpsRuntimeVisualEvidenceV1 = z.infer<
  typeof siteOpsRuntimeVisualEvidenceV1Schema
>;
export type SiteOpsRuntimeVisualEvidenceV2 = z.infer<
  typeof siteOpsRuntimeVisualEvidenceV2Schema
>;
export type BuildContractV2 = z.infer<typeof buildContractV2Schema>;
export type BuildPlanContractV3 = z.infer<typeof buildPlanContractV3Schema>;
export type BuildContractV3 = z.infer<typeof buildContractV3Schema>;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object")
    throw new TypeError("Unsupported canonical JSON value");
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function canonicalSiteOpsSha256(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function blueprintHashForReference(
  value: z.infer<typeof referenceBlueprintV2BaseSchema>,
) {
  return canonicalSiteOpsSha256(value);
}

export function composeReferenceBlueprintV2(
  input: z.infer<typeof referenceBlueprintV2BaseSchema>,
): ReferenceBlueprintV2 {
  return referenceBlueprintV2Schema.parse({
    ...input,
    blueprintHash: blueprintHashForReference(input),
  });
}

type FrozenHeroEligibility = {
  variant?:
    | "centered_statement"
    | "split_media"
    | "editorial_modular"
    | "immersive_visual";
};

export function referenceBlueprintForVisualCandidate(input: {
  candidateId: string;
  providerItemKey: string;
  previewSha256: string;
  title?: string | null;
  sourceUrl?: string | null;
  heroEligibility?: FrozenHeroEligibility | null;
}) {
  const evidence = `${input.title ?? ""} ${input.sourceUrl ?? ""}`
    .normalize("NFKC")
    .toLowerCase();
  const heroFamily = (() => {
    if (input.providerItemKey === "n:8435") return "floating_orbit" as const;
    if (/(?:floating|orbit|hero[-_ ]section[-_ ]7)/u.test(evidence))
      return "floating_orbit" as const;
    if (/(?:bento|masonry|modular)/u.test(evidence)) return "bento" as const;
    if (/(?:feature[-_ ]?(?:grid|hero)|features)/u.test(evidence))
      return "feature_grid" as const;
    if (/(?:full[-_ ]?bleed|fullscreen|full[-_ ]?screen)/u.test(evidence))
      return "full_bleed_statement" as const;
    if (/(?:immersive|cinematic|spatial|\b3d\b)/u.test(evidence))
      return "immersive_visual" as const;
    if (/(?:product[-_ ]?(?:stage|visual)|showcase)/u.test(evidence))
      return "product_stage" as const;
    if (/(?:proof[-_ ]?grid|trust[-_ ]?grid)/u.test(evidence))
      return "proof_grid" as const;
    if (/(?:split|two[-_ ]column|side[-_ ]by[-_ ]side)/u.test(evidence))
      return "split_media" as const;
    if (/(?:editorial|magazine|asymmetric)/u.test(evidence))
      return "editorial" as const;
    if (input.heroEligibility?.variant === "split_media")
      return "split_media" as const;
    if (input.heroEligibility?.variant === "editorial_modular")
      return "editorial" as const;
    if (input.heroEligibility?.variant === "immersive_visual")
      return "immersive_visual" as const;
    return "centered_dual_cta" as const;
  })();

  const familyCoordinates: Record<
    z.infer<typeof siteHeroFamilySchema>,
    Omit<
      z.infer<typeof referenceBlueprintV2BaseSchema>,
      | "schemaVersion"
      | "candidateId"
      | "providerItemKey"
      | "previewSha256"
      | "heroFamily"
    >
  > = {
    floating_orbit: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "surround",
      mediaRatio: "square",
      composition: "centered",
      backgroundStyle: "warm_light",
      gradientStyle: "soft_radial",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "orbital",
      navStyle: "minimal",
      ctaStyle: "dual",
      cardStyle: "soft_depth",
      containerStyle: "contained",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "reflow",
      motionLevel: "floating_subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    feature_grid: {
      alignment: "left",
      contentEmphasis: "balanced",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "modular",
      backgroundStyle: "cool_light",
      gradientStyle: "soft_radial",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "grid",
      navStyle: "bordered",
      ctaStyle: "dual",
      cardStyle: "bordered",
      containerStyle: "contained",
      typographyStyle: "technical",
      density: "balanced",
      responsiveBehavior: "stack",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    bento: {
      alignment: "left",
      contentEmphasis: "balanced",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "modular",
      backgroundStyle: "cool_light",
      gradientStyle: "mesh",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "grid",
      navStyle: "minimal",
      ctaStyle: "single",
      cardStyle: "layered",
      containerStyle: "wide",
      typographyStyle: "display",
      density: "balanced",
      responsiveBehavior: "reflow",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    split_media: {
      alignment: "left",
      contentEmphasis: "product",
      mediaRegion: "split",
      mediaRatio: "portrait",
      composition: "split",
      backgroundStyle: "warm_light",
      gradientStyle: "soft_radial",
      borderStyle: "none",
      radiusStyle: "soft",
      decorationStyle: "none",
      navStyle: "minimal",
      ctaStyle: "dual",
      cardStyle: "flat",
      containerStyle: "wide",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "stack",
      motionLevel: "subtle",
      mediaStrategy: "customer_asset",
    },
    editorial: {
      alignment: "left",
      contentEmphasis: "statement",
      mediaRegion: "inline",
      mediaRatio: "wide",
      composition: "editorial",
      backgroundStyle: "warm_light",
      gradientStyle: "none",
      borderStyle: "subtle",
      radiusStyle: "none",
      decorationStyle: "editorial_lines",
      navStyle: "minimal",
      ctaStyle: "text_link",
      cardStyle: "flat",
      containerStyle: "wide",
      typographyStyle: "editorial",
      density: "spacious",
      responsiveBehavior: "reflow",
      motionLevel: "none",
      mediaStrategy: "procedural_brand_svg",
    },
    centered_dual_cta: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "none",
      mediaRatio: "none",
      composition: "centered",
      backgroundStyle: "warm_light",
      gradientStyle: "soft_radial",
      borderStyle: "none",
      radiusStyle: "pill",
      decorationStyle: "glow",
      navStyle: "minimal",
      ctaStyle: "dual",
      cardStyle: "flat",
      containerStyle: "contained",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "stack",
      motionLevel: "subtle",
      mediaStrategy: "none",
    },
    immersive_visual: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "full_bleed",
      mediaRatio: "wide",
      composition: "immersive",
      backgroundStyle: "image_stage",
      gradientStyle: "spotlight",
      borderStyle: "none",
      radiusStyle: "none",
      decorationStyle: "glow",
      navStyle: "floating",
      ctaStyle: "dual",
      cardStyle: "layered",
      containerStyle: "edge_to_edge",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "crop_safe",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
    product_stage: {
      alignment: "center",
      contentEmphasis: "product",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "centered",
      backgroundStyle: "gradient",
      gradientStyle: "spotlight",
      borderStyle: "subtle",
      radiusStyle: "rounded",
      decorationStyle: "glow",
      navStyle: "floating",
      ctaStyle: "dual",
      cardStyle: "soft_depth",
      containerStyle: "wide",
      typographyStyle: "technical",
      density: "spacious",
      responsiveBehavior: "reflow",
      motionLevel: "subtle",
      mediaStrategy: "customer_asset",
    },
    proof_grid: {
      alignment: "left",
      contentEmphasis: "proof",
      mediaRegion: "inline",
      mediaRatio: "landscape",
      composition: "modular",
      backgroundStyle: "cool_light",
      gradientStyle: "none",
      borderStyle: "defined",
      radiusStyle: "soft",
      decorationStyle: "grid",
      navStyle: "bordered",
      ctaStyle: "single",
      cardStyle: "bordered",
      containerStyle: "contained",
      typographyStyle: "technical",
      density: "balanced",
      responsiveBehavior: "stack",
      motionLevel: "none",
      mediaStrategy: "none",
    },
    full_bleed_statement: {
      alignment: "center",
      contentEmphasis: "statement",
      mediaRegion: "full_bleed",
      mediaRatio: "wide",
      composition: "immersive",
      backgroundStyle: "dark",
      gradientStyle: "spotlight",
      borderStyle: "none",
      radiusStyle: "none",
      decorationStyle: "glow",
      navStyle: "floating",
      ctaStyle: "single",
      cardStyle: "flat",
      containerStyle: "edge_to_edge",
      typographyStyle: "display",
      density: "spacious",
      responsiveBehavior: "crop_safe",
      motionLevel: "subtle",
      mediaStrategy: "procedural_brand_svg",
    },
  };
  return composeReferenceBlueprintV2({
    schemaVersion: 2,
    candidateId: input.candidateId,
    providerItemKey: input.providerItemKey,
    previewSha256: input.previewSha256,
    heroFamily,
    ...familyCoordinates[heroFamily],
  });
}

export function composeBuildContractV2(
  input: Omit<BuildContractV2, "specHash">,
): BuildContractV2 {
  return buildContractV2Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}
export function composeBuildPlanContractV3(
  input: Omit<BuildPlanContractV3, "specHash">,
): BuildPlanContractV3 {
  return buildPlanContractV3Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}
export function composeBuildContractV3(
  input: Omit<BuildContractV3, "specHash">,
): BuildContractV3 {
  return buildContractV3Schema.parse({
    ...input,
    specHash: canonicalSiteOpsSha256(input),
  });
}

export function validateDesignAndContentBindings(input: {
  routeIds: readonly string[];
  paletteSize: number;
  designSpec: SiteDesignSpec;
  pageContent?: PageContentSpecV1;
}) {
  const expectedRoutes = new Set(input.routeIds);
  const compositions = new Map(
    input.designSpec.routeCompositions.map((route) => [route.routeId, route]),
  );
  if (
    input.designSpec.routeCompositions.length !== expectedRoutes.size ||
    compositions.size !== expectedRoutes.size ||
    [...compositions.keys()].some((id) => !expectedRoutes.has(id))
  ) {
    throw new Error("SITEOPS_DESIGN_ROUTE_SET_MISMATCH");
  }
  if (
    input.paletteSize < 1 ||
    Object.values(input.designSpec.colorRoles).some(
      (index) => index >= input.paletteSize,
    )
  ) {
    throw new Error("SITEOPS_DESIGN_PALETTE_INDEX_INVALID");
  }
  for (const route of compositions.values()) {
    if (
      new Set(route.slots.map((slot) => slot.slotId)).size !==
      route.slots.length
    ) {
      throw new Error("SITEOPS_DESIGN_SLOT_DUPLICATE");
    }
  }
  if (!input.pageContent) return;
  const contentByRoute = new Map(
    input.pageContent.routes.map((route) => [route.routeId, route]),
  );
  if (
    input.pageContent.routes.length !== expectedRoutes.size ||
    contentByRoute.size !== expectedRoutes.size ||
    [...contentByRoute.keys()].some((id) => !expectedRoutes.has(id))
  ) {
    throw new Error("SITEOPS_CONTENT_ROUTE_SET_MISMATCH");
  }
  for (const [routeId, composition] of compositions) {
    const content = contentByRoute.get(routeId);
    if (!content) throw new Error("SITEOPS_CONTENT_ROUTE_SET_MISMATCH");
    const slots = content.sections.map((section) => section.slotId);
    if (
      composition.slots.length !== slots.length ||
      composition.slots.some((slot, index) => slot.slotId !== slots[index])
    ) {
      throw new Error("SITEOPS_CONTENT_SLOT_SET_MISMATCH");
    }
  }
}
