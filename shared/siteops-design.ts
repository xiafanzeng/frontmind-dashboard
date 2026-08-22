import { createHash } from "node:crypto";
import { z } from "zod";
import {
  siteBriefSchema,
  visualTaxonomySchema,
} from "./siteops";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const siteLayoutArchetypeSchema = z.enum([
  "hero_led", "editorial", "modular", "split", "asymmetric",
]);
export const siteHeroVariantSchema = z.enum([
  "split_media", "centered_statement", "editorial_lede", "proof_grid",
]);
export const siteSectionVariantSchema = z.enum([
  "statement", "split", "cards", "timeline", "faq", "proof", "cta",
]);
export const siteSeoPlanSchema = z.object({
  siteTitle: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(200),
  organizationType: z.enum(["Organization", "Corporation", "ProfessionalService"]),
}).strict();

export const siteDesignSpecV1Schema = z.object({
  schemaVersion: z.literal(1),
  layoutArchetype: siteLayoutArchetypeSchema,
  heroVariant: siteHeroVariantSchema,
  density: z.enum(["compact", "balanced", "spacious"]),
  surfaceStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
  typeScale: z.enum(["restrained", "editorial", "display"]),
  imageTreatment: z.enum(["contained", "wide", "masked", "none"]),
  motionLevel: z.enum(["none", "subtle"]),
  colorRoles: z.object({
    backgroundPaletteIndex: z.number().int().nonnegative().max(11),
    textPaletteIndex: z.number().int().nonnegative().max(11),
    accentPaletteIndex: z.number().int().nonnegative().max(11),
  }).strict(),
  routeCompositions: z.array(z.object({
    routeId: z.string().trim().min(1).max(64),
    slots: z.array(z.object({
      slotId: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
      variant: siteSectionVariantSchema,
    }).strict()).min(1).max(16),
  }).strict()).min(1).max(30),
  seoPlan: siteSeoPlanSchema,
}).strict();

export const pageContentSpecV1Schema = z.object({
  schemaVersion: z.literal(1),
  routes: z.array(z.object({
    routeId: z.string().trim().min(1).max(64),
    eyebrow: z.string().trim().min(1).max(100).optional(),
    heading: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(600),
    sections: z.array(z.object({
      slotId: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
      heading: z.string().trim().min(1).max(160),
      paragraphs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
      sourceDocumentIds: z.array(z.string().trim().min(1).max(191)).min(1).max(30),
    }).strict()).min(1).max(16),
  }).strict()).min(1).max(30),
}).strict();

export const siteDesignResultV1Schema = z.object({
  operationToken: z.string().min(1).max(128),
  designSpec: siteDesignSpecV1Schema,
}).strict();
export const pageContentResultV1Schema = z.object({
  operationToken: z.string().min(1).max(128),
  pageContent: pageContentSpecV1Schema,
}).strict();

export const siteOpsRuntimeVisualEvidenceV1Schema = z.object({
  queryHash: sha256Schema,
  selectedCandidateId: z.string().trim().min(1).max(191),
  providerItemKey: z.string().trim().min(1).max(512),
  visualEvidenceSha256: sha256Schema,
  previewSha256: sha256Schema,
  supportEvidenceSha256s: z.array(sha256Schema).max(2).default([]),
  taxonomy: visualTaxonomySchema,
}).strict();

export const buildContractV2Schema = z.object({
  schemaVersion: z.literal(2),
  source: z.object({
    knowledgeSnapshotId: z.string().uuid(),
    archiveSha256: sha256Schema,
    sourceBuildId: z.string().max(191).nullable(),
    sourceBuildRevision: z.number().int().nonnegative().nullable(),
  }).strict(),
  workflow: z.object({
    upstreamSha256: sha256Schema,
    version: z.string().max(32),
    manifestSha256: sha256Schema,
    starterVersion: z.string().max(32),
    starterSha256: sha256Schema,
    componentLibraryVersion: z.string().max(32),
    materializerVersion: z.string().max(32),
    materializerSha256: sha256Schema,
  }).strict(),
  identity: z.object({
    companyName: z.string().min(1).max(255),
    primaryLanguage: z.string().min(2).max(32),
    verifiedContacts: z.array(z.string().max(512)).max(20),
  }).strict(),
  visual: siteOpsRuntimeVisualEvidenceV1Schema.extend({
    designSpecHash: sha256Schema,
    componentLibraryVersion: z.string().max(32),
  }).strict(),
  routes: siteBriefSchema.shape.routes,
  assets: z.array(z.object({
    id: z.string().max(191),
    sha256: sha256Schema,
    decision: z.enum(["publish", "omit", "quarantine"]),
  }).strict()).max(500),
  seo: siteSeoPlanSchema.extend({
    environment: z.enum(["preview", "production"]),
    canonicalPolicy: z.enum(["forbidden", "exact_https_origin"]),
  }).strict(),
  target: z.object({
    environment: z.enum(["preview", "global_excluding_cn", "mainland_cn"]),
    canonicalOrigin: z.string().url().nullable(),
  }).strict(),
  qaPolicyVersion: z.string().max(64),
  specHash: sha256Schema,
}).strict();

export type SiteDesignSpecV1 = z.infer<typeof siteDesignSpecV1Schema>;
export type PageContentSpecV1 = z.infer<typeof pageContentSpecV1Schema>;
export type SiteOpsRuntimeVisualEvidenceV1 = z.infer<typeof siteOpsRuntimeVisualEvidenceV1Schema>;
export type BuildContractV2 = z.infer<typeof buildContractV2Schema>;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("Unsupported canonical JSON value");
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function canonicalSiteOpsSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
export function composeBuildContractV2(input: Omit<BuildContractV2, "specHash">): BuildContractV2 {
  return buildContractV2Schema.parse({ ...input, specHash: canonicalSiteOpsSha256(input) });
}

export function validateDesignAndContentBindings(input: {
  routeIds: readonly string[];
  paletteSize: number;
  designSpec: SiteDesignSpecV1;
  pageContent?: PageContentSpecV1;
}) {
  const expectedRoutes = new Set(input.routeIds);
  const compositions = new Map(input.designSpec.routeCompositions.map((route) => [route.routeId, route]));
  if (
    input.designSpec.routeCompositions.length !== expectedRoutes.size ||
    compositions.size !== expectedRoutes.size ||
    [...compositions.keys()].some((id) => !expectedRoutes.has(id))
  ) {
    throw new Error("SITEOPS_DESIGN_ROUTE_SET_MISMATCH");
  }
  if (input.paletteSize < 1 || Object.values(input.designSpec.colorRoles).some((index) => index >= input.paletteSize)) {
    throw new Error("SITEOPS_DESIGN_PALETTE_INDEX_INVALID");
  }
  for (const route of compositions.values()) {
    if (new Set(route.slots.map((slot) => slot.slotId)).size !== route.slots.length) {
      throw new Error("SITEOPS_DESIGN_SLOT_DUPLICATE");
    }
  }
  if (!input.pageContent) return;
  const contentByRoute = new Map(input.pageContent.routes.map((route) => [route.routeId, route]));
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
    if (composition.slots.length !== slots.length || composition.slots.some((slot, index) => slot.slotId !== slots[index])) {
      throw new Error("SITEOPS_CONTENT_SLOT_SET_MISMATCH");
    }
  }
}
