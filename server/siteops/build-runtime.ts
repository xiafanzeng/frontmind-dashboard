import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { z } from "zod";
import AxeBuilder from "@axe-core/playwright";
import { launch as launchChrome } from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromium } from "playwright";

import type {
  KnowledgeBaseSnapshot,
  KnowledgeDocumentRecord,
  SiteBuild,
} from "../../drizzle/schema";
import {
  SITEOPS_MATERIALIZER_V1_2,
  SITEOPS_MATERIALIZER_V1_3,
  SITEOPS_MATERIALIZER_V1_4,
  SITEOPS_MATERIALIZER_V1_5,
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  type SiteBrief,
} from "../../shared/siteops";
import { canonicalJson } from "../../shared/siteops-workflow";
import {
  buildContractV2Schema,
  canonicalSiteOpsSha256,
  composeBuildContractV2,
  siteDesignSpecV1Schema,
  siteOpsRuntimeVisualEvidenceV1Schema,
  validateDesignAndContentBindings,
  type BuildContractV2,
  type SiteDesignSpecV1,
  type SiteOpsRuntimeVisualEvidenceV1,
} from "../../shared/siteops-design";
import {
  freezeSiteBrandAsset,
  validateTrustedSiteBrandAsset,
  type FrozenSiteBrandAsset,
  type TrustedSiteBrandAsset,
} from "./knowledge-brand-asset";

type SiteOpsMaterializerCoordinates =
  | typeof SITEOPS_MATERIALIZER_V1_2
  | typeof SITEOPS_MATERIALIZER_V1_3
  | typeof SITEOPS_MATERIALIZER_V1_4
  | typeof SITEOPS_MATERIALIZER_V1_5;

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_DIST_BYTES = 30 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_BUILD_LOG_BYTES = 256 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
const ASTRO_VERSION = "7.2.4";
const TYPESCRIPT_VERSION = "6.0.3";
const SENSITIVE_TEXT =
  /(?:21st_sk_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*[A-Za-z0-9._~+/-]{12,})/iu;
const FORBIDDEN_DEMO_TEXT =
  /(?:https:\/\/example\.invalid|frontmind demo company)/iu;

const generatedSectionSchema = z
  .object({
    slotId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    heading: z.string().trim().min(1).max(160),
    paragraphs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
    sourceDocumentIds: z
      .array(z.string().trim().min(1).max(191))
      .min(1)
      .max(30),
  })
  .strict();

const generatedRouteSchema = z
  .object({
    routeId: z.string().trim().min(1).max(64),
    eyebrow: z.string().trim().min(1).max(100).optional(),
    heading: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(600),
    sections: z.array(generatedSectionSchema).min(1).max(16),
  })
  .strict();

export const siteOpsGeneratedContentSchema = z
  .object({
    seo: z
      .object({
        siteTitle: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(200),
        organizationType: z
          .enum(["Organization", "Corporation", "ProfessionalService"])
          .default("Organization"),
      })
      .strict(),
    routes: z.array(generatedRouteSchema).min(1).max(30),
  })
  .strict();

export const siteOpsRuntimeVisualSchema = siteOpsRuntimeVisualEvidenceV1Schema;

export const siteOpsAssetDecisionSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(["publish", "omit", "quarantine"]),
  })
  .strict();

export const siteOpsFrozenRuntimeInputSchema = z
  .object({
    schemaVersion: z.literal(2),
    build: z
      .object({
        id: z.string().uuid(),
        projectId: z.string().uuid(),
        userId: z.number().int().positive(),
        knowledgeSnapshotId: z.string().max(36),
        knowledgeArchiveHash: z.string().regex(/^[a-f0-9]{64}$/u),
        workflowUpstreamVersion: z.string().min(1).max(32),
        workflowUpstreamHash: z.string().regex(/^[a-f0-9]{64}$/u),
        workflowVersion: z.string().min(1).max(32),
        workflowPackageHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        starterVersion: z.string().min(1).max(32),
        selectionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
      })
      .strict(),
    host: z
      .object({
        starterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        componentLibraryVersion: z.string().min(1).max(32),
        materializerVersion: z.string().min(1).max(32),
        materializerSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    snapshot: z
      .object({
        id: z.string().max(36),
        userId: z.number().int().positive(),
        archiveHash: z.string().regex(/^[a-f0-9]{64}$/u),
        sourceBuildId: z.string().max(36).nullable(),
        sourceBuildRevision: z.number().int().nullable(),
        sourceDocumentIds: z
          .array(z.string().trim().min(1).max(191))
          .min(1)
          .max(1_000),
      })
      .strict(),
    brief: siteBriefSchema,
    visual: siteOpsRuntimeVisualSchema,
    designSpec: siteDesignSpecV1Schema,
    generatedContent: siteOpsGeneratedContentSchema,
    assetDecisions: z.array(siteOpsAssetDecisionSchema).max(500),
    brandAsset: z
      .object({
        schemaVersion: z.literal(1),
        assetId: z.string().trim().min(1).max(191),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/svg+xml",
          "image/webp",
        ]),
        publicPath: z.string().trim().min(1).max(191),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024),
        width: z.number().int().positive().max(8_192),
        height: z.number().int().positive().max(8_192),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type SiteOpsGeneratedContent = z.infer<
  typeof siteOpsGeneratedContentSchema
>;
export type SiteOpsRuntimeVisual = SiteOpsRuntimeVisualEvidenceV1;

type TrustedBuildCoordinates = Pick<
  SiteBuild,
  | "id"
  | "projectId"
  | "userId"
  | "knowledgeSnapshotId"
  | "knowledgeArchiveHash"
  | "workflowUpstreamVersion"
  | "workflowUpstreamHash"
  | "workflowVersion"
  | "workflowPackageHash"
  | "starterVersion"
  | "selectionHash"
>;

type TrustedSnapshot = Pick<
  KnowledgeBaseSnapshot,
  | "id"
  | "userId"
  | "archiveHash"
  | "sourceBuildId"
  | "sourceBuildRevision"
  | "documents"
>;

export type MaterializeAstroSiteInput = {
  build: TrustedBuildCoordinates;
  snapshot: TrustedSnapshot;
  brief: SiteBrief | unknown;
  visual: SiteOpsRuntimeVisual | unknown;
  designSpec: SiteDesignSpecV1 | unknown;
  generatedContent: SiteOpsGeneratedContent | unknown;
  mode: "preview" | "production";
  canonicalOrigin?: string | null;
  target?: "global_excluding_cn" | "mainland_cn";
  assetDecisions?: z.infer<typeof siteOpsAssetDecisionSchema>[];
  brandAsset?: TrustedSiteBrandAsset | null;
  timeoutMs?: number;
};

export type SiteOpsQaReport = {
  schemaVersion: 1;
  policyVersion: string;
  passed: true;
  mode: "preview" | "production";
  routes: string[];
  checks: Array<{ id: string; passed: true; detail: string }>;
  browser: {
    lighthouse: {
      performance: number;
      accessibility: number;
      bestPractices: number;
      seo: number;
      cls: number;
    };
    axeViolationCount: number;
    screenshotFiles: string[];
  };
  fileCount: number;
  totalBytes: number;
};

export type MaterializedAstroSite = {
  contract: BuildContractV2;
  contractJson: Buffer;
  contractSha256: string;
  sourceZip: Buffer;
  sourceSha256: string;
  distZip: Buffer;
  distSha256: string;
  qaJson: Buffer;
  qaSha256: string;
  visualQaZip: Buffer;
  visualQaSha256: string;
  provenanceJson: Buffer;
  provenanceSha256: string;
  buildLog: Buffer;
  files: ReadonlyMap<string, Buffer>;
};

type SourceFile = { path: string; bytes: Buffer };

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBuffer(value: unknown) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value: string) {
  return escapeHtml(value);
}

function assertNoSensitiveText(label: string, value: string) {
  if (SENSITIVE_TEXT.test(value) || FORBIDDEN_DEMO_TEXT.test(value)) {
    throw new Error(`SITEOPS_SENSITIVE_OR_DEMO_TEXT_REJECTED:${label}`);
  }
}

function normalizeRouteSlug(value: string) {
  const trimmed = value.trim();
  const withLeadingSlash =
    trimmed === "/" ? "/" : `/${trimmed.replace(/^\/+|\/+$/gu, "")}`;
  if (
    withLeadingSlash.includes("\\") ||
    withLeadingSlash.includes("%") ||
    withLeadingSlash.includes("?") ||
    withLeadingSlash.includes("#") ||
    withLeadingSlash.includes("\0") ||
    withLeadingSlash.normalize("NFKC") !== withLeadingSlash ||
    withLeadingSlash.length > 191
  ) {
    throw new Error("SITEOPS_ROUTE_SLUG_INVALID");
  }
  const segments = withLeadingSlash.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u.test(segment),
    )
  ) {
    throw new Error("SITEOPS_ROUTE_SLUG_INVALID");
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function validateCanonicalOrigin(
  mode: "preview" | "production",
  raw?: string | null,
) {
  if (mode === "preview") {
    if (raw) throw new Error("SITEOPS_PREVIEW_CANONICAL_FORBIDDEN");
    return null;
  }
  if (!raw) throw new Error("SITEOPS_PRODUCTION_CANONICAL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SITEOPS_CANONICAL_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname === "localhost"
  ) {
    throw new Error("SITEOPS_CANONICAL_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function validateInput(
  input: MaterializeAstroSiteInput,
  brandAsset: TrustedSiteBrandAsset | null,
  workflow: SiteOpsMaterializerCoordinates,
) {
  const coordinates = z
    .object({
      buildId: z.string().uuid(),
      projectId: z.string().uuid(),
      userId: z.number().int().positive(),
      snapshotId: z.string().uuid(),
    })
    .strict()
    .parse({
      buildId: input.build.id,
      projectId: input.build.projectId,
      userId: input.build.userId,
      snapshotId: input.snapshot.id,
    });
  const brief = siteBriefSchema.parse(input.brief);
  const visual = siteOpsRuntimeVisualSchema.parse(input.visual);
  const designSpec = siteDesignSpecV1Schema.parse(input.designSpec);
  const generatedContent = siteOpsGeneratedContentSchema.parse(
    input.generatedContent,
  );
  const canonicalOrigin = validateCanonicalOrigin(
    input.mode,
    input.canonicalOrigin,
  );
  if (
    !/^[a-f0-9]{64}$/u.test(input.build.knowledgeArchiveHash) ||
    input.snapshot.archiveHash !== input.build.knowledgeArchiveHash ||
    input.snapshot.id !== input.build.knowledgeSnapshotId ||
    input.snapshot.userId !== coordinates.userId
  ) {
    throw new Error("SITEOPS_SNAPSHOT_COORDINATES_MISMATCH");
  }
  if (
    input.build.workflowUpstreamVersion !== workflow.upstreamVersion ||
    input.build.workflowUpstreamHash !== workflow.upstreamSha256 ||
    input.build.workflowVersion !== workflow.frontMindVersion ||
    (input.build.workflowPackageHash !== null &&
      input.build.workflowPackageHash !== workflow.runtimeManifestSha256) ||
    input.build.starterVersion !== workflow.starterVersion
  ) {
    throw new Error("SITEOPS_WORKFLOW_COORDINATES_MISMATCH");
  }
  const sourceDocuments = new Map<string, KnowledgeDocumentRecord>();
  let sourceCharacters = 0;
  for (const document of input.snapshot.documents) {
    if (!document.id || sourceDocuments.has(document.id)) {
      throw new Error("SITEOPS_SOURCE_DOCUMENT_ID_INVALID");
    }
    sourceCharacters += document.content.length;
    if (sourceCharacters > 5_000_000 || input.snapshot.documents.length > 500) {
      throw new Error("SITEOPS_SOURCE_DOCUMENTS_TOO_LARGE");
    }
    sourceDocuments.set(document.id, document);
  }
  const routes = brief.routes.map((route) => ({
    ...route,
    slug: normalizeRouteSlug(route.slug),
  }));
  const routeIds = new Set(routes.map((route) => route.id));
  const slugs = new Set(routes.map((route) => route.slug));
  if (
    routeIds.size !== routes.length ||
    slugs.size !== routes.length ||
    !slugs.has("/") ||
    routes.some((route) =>
      route.sourceDocumentIds.some((id) => !sourceDocuments.has(id)),
    )
  ) {
    throw new Error("SITEOPS_ROUTE_CONTRACT_INVALID");
  }
  const generatedByRoute = new Map(
    generatedContent.routes.map((route) => [route.routeId, route]),
  );
  if (
    generatedByRoute.size !== routes.length ||
    generatedContent.routes.length !== routes.length ||
    generatedContent.routes.some((route) => !routeIds.has(route.routeId))
  ) {
    throw new Error("SITEOPS_GENERATED_ROUTE_SET_MISMATCH");
  }
  validateDesignAndContentBindings({
    routeIds: routes.map((route) => route.id),
    paletteSize: visual.taxonomy.palette.length,
    designSpec,
    pageContent: {
      schemaVersion: 1,
      routes: generatedContent.routes,
    },
  });
  if (
    canonicalJson(generatedContent.seo) !== canonicalJson(designSpec.seoPlan)
  ) {
    throw new Error("SITEOPS_SEO_PLAN_MISMATCH");
  }
  for (const route of routes) {
    const generated = generatedByRoute.get(route.id)!;
    const allowedSources = new Set(route.sourceDocumentIds);
    for (const section of generated.sections) {
      if (section.sourceDocumentIds.some((id) => !allowedSources.has(id))) {
        throw new Error("SITEOPS_GENERATED_SOURCE_MAPPING_INVALID");
      }
    }
  }
  const allText = canonicalJson({ brief, designSpec, generatedContent });
  if (Buffer.byteLength(allText, "utf8") > 2_000_000) {
    throw new Error("SITEOPS_GENERATED_CONTENT_TOO_LARGE");
  }
  assertNoSensitiveText("generated-content", allText);
  const assetDecisions = z
    .array(siteOpsAssetDecisionSchema)
    .max(500)
    .parse(input.assetDecisions ?? []);
  if (
    new Set(assetDecisions.map((item) => item.id)).size !==
    assetDecisions.length
  ) {
    throw new Error("SITEOPS_ASSET_DECISION_DUPLICATE");
  }
  const publishedAssets = assetDecisions.filter(
    (item) => item.decision === "publish",
  );
  if (
    publishedAssets.length > 1 ||
    (publishedAssets.length === 0 && brandAsset !== null) ||
    (publishedAssets.length === 1 &&
      (!brandAsset ||
        brandAsset.assetId !== publishedAssets[0]!.id ||
        brandAsset.sha256 !== publishedAssets[0]!.sha256))
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_DECISION_MISMATCH");
  }
  return {
    brief: { ...brief, routes },
    visual,
    designSpec,
    generatedContent,
    generatedByRoute,
    sourceDocuments,
    canonicalOrigin,
    assetDecisions,
    brandAsset,
  };
}

function routeOutputPath(slug: string) {
  return slug === "/" ? "index.html" : `${slug.slice(1)}index.html`;
}

function routeSourcePath(slug: string) {
  return slug === "/"
    ? "src/pages/index.astro"
    : `src/pages/${slug.slice(1)}index.astro`;
}

function routeCanonical(origin: string, slug: string) {
  return `${origin}${slug}`;
}

function safeContactHref(kind: "email" | "phone" | "address", value: string) {
  if (kind === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    return `mailto:${value}`;
  }
  if (kind === "phone" && /^[+()0-9\s-]{5,40}$/u.test(value)) {
    return `tel:${value.replace(/[^+0-9]/gu, "")}`;
  }
  return null;
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrastRatio(left: string, right: string) {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function siteDesignMaterializationProjectionFor(
  input: unknown,
  workflow: SiteOpsMaterializerCoordinates,
) {
  const design = siteDesignSpecV1Schema.parse(input);
  return {
    bodyClass: [
      `layout--${design.layoutArchetype}`,
      `surface--${design.surfaceStyle}`,
      `type--${design.typeScale}`,
      `image--${design.imageTreatment}`,
      `motion--${design.motionLevel}`,
    ].join(" "),
    heroClass: `hero hero--${design.heroVariant}`,
    componentManifest: {
      schemaVersion: 1 as const,
      componentLibraryVersion: workflow.componentLibraryVersion,
      materializerVersion: workflow.materializerVersion,
      layoutArchetype: design.layoutArchetype,
      heroVariant: design.heroVariant,
      routes: design.routeCompositions,
    },
  };
}

export function siteDesignMaterializationProjection(input: unknown) {
  return siteDesignMaterializationProjectionFor(input, SITEOPS_WORKFLOW);
}

function cssForVisual(visual: SiteOpsRuntimeVisual, design: SiteDesignSpecV1) {
  const colors = visual.taxonomy.palette.filter((value) =>
    /^#[a-f0-9]{6}$/iu.test(value),
  );
  const canvasCandidate =
    colors[design.colorRoles.backgroundPaletteIndex] ?? "#F5F2EA";
  const inkCandidate = colors[design.colorRoles.textPaletteIndex] ?? "#10212B";
  const accessiblePair =
    contrastRatio(inkCandidate, canvasCandidate) >= 7
      ? { canvas: canvasCandidate, ink: inkCandidate }
      : { canvas: "#F5F2EA", ink: "#10212B" };
  const { canvas, ink } = accessiblePair;
  const accentCandidate =
    colors[design.colorRoles.accentPaletteIndex] ?? "#A33A1B";
  const accent =
    contrastRatio(accentCandidate, canvas) >= 4.5 ? accentCandidate : "#A33A1B";
  const muted = colors[3] ?? "#DDE7E8";
  const radius =
    design.surfaceStyle === "soft_depth" || design.surfaceStyle === "layered"
      ? "22px"
      : design.surfaceStyle === "bordered"
        ? "8px"
        : "2px";
  const font =
    design.typeScale === "editorial"
      ? "Georgia, 'Times New Roman', serif"
      : "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const heroSize =
    design.typeScale === "restrained"
      ? "clamp(2.4rem,6vw,5.2rem)"
      : design.typeScale === "display"
        ? "clamp(3rem,9vw,7.4rem)"
        : "clamp(2.7rem,8vw,6.8rem)";
  const gap =
    design.density === "compact"
      ? "12px"
      : design.density === "spacious"
        ? "32px"
        : "20px";
  const sectionPadding =
    design.density === "compact"
      ? "24px"
      : design.density === "spacious"
        ? "56px"
        : "40px";
  return `:root{color-scheme:light;--ink:${ink};--accent:${accent};--canvas:${canvas};--muted:${muted};--radius:${radius};--gap:${gap};--section-pad:${sectionPadding};font-family:${font}}*{box-sizing:border-box}html{background:var(--canvas);color:var(--ink);scroll-behavior:${design.motionLevel === "subtle" ? "smooth" : "auto"}}body{margin:0;min-width:320px;line-height:1.65}a{color:inherit;text-underline-offset:.2em}a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.shell{width:min(1120px,calc(100% - 40px));margin-inline:auto}.site-header{border-bottom:1px solid color-mix(in srgb,var(--ink) 22%,transparent);background:color-mix(in srgb,var(--canvas) 94%,white);position:sticky;top:0;z-index:3}.nav{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-weight:800;letter-spacing:-.025em}.brand-logo{display:block;width:auto;height:40px;max-width:180px;object-fit:contain}.nav-links{display:flex;gap:20px;flex-wrap:wrap;justify-content:flex-end}.nav-links a{text-decoration:none;font-size:.94rem}.hero{padding:clamp(72px,10vw,144px) 0 64px}.hero--centered_statement .shell{text-align:center}.hero--centered_statement .lede,.hero--centered_statement h1{margin-inline:auto}.hero--split_media .shell,.hero--proof_grid .shell{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,.65fr);gap:var(--gap);align-items:end}.hero--split_media .lede,.hero--proof_grid .lede{border-left:3px solid var(--accent);padding-left:24px}.hero--editorial_lede h1{max-width:18ch}.eyebrow{color:var(--accent);font:700 .78rem/1.2 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase}.hero h1{max-width:900px;margin:.35em 0 .32em;font-size:${heroSize};line-height:.95;letter-spacing:-.06em;text-wrap:balance}.lede{max-width:720px;font-size:clamp(1.1rem,2vw,1.36rem)}.facts{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--gap);padding:28px 0 100px}.layout--editorial .facts{display:block;max-width:820px}.layout--modular .section{grid-column:span 4}.layout--split .section{grid-column:span 6}.layout--asymmetric .section:nth-child(3n+1){grid-column:span 7}.layout--asymmetric .section:nth-child(3n+2){grid-column:span 5}.section{grid-column:span 6;padding:24px 20px var(--section-pad)}.surface--bordered .section{border:1px solid color-mix(in srgb,var(--ink) 30%,transparent);border-top:3px solid var(--ink);border-radius:var(--radius)}.surface--soft_depth .section{background:color-mix(in srgb,var(--canvas) 88%,white);border-radius:var(--radius);box-shadow:0 18px 48px color-mix(in srgb,var(--ink) 10%,transparent)}.surface--layered .section{background:var(--muted);border-radius:var(--radius)}.surface--flat .section{border-top:3px solid var(--ink)}.section--statement{grid-column:span 12}.section--cta{background:var(--ink)!important;color:var(--canvas);border-radius:var(--radius)}.section--timeline{border-left:4px solid var(--accent)}.section--faq h2::before{content:'Q ';color:var(--accent)}.section--proof{border-top-color:var(--accent)}.section h2{font-size:clamp(1.5rem,3vw,2.5rem);line-height:1.1;margin:0 0 18px}.section p{max-width:64ch}.source-note{font:600 .72rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.62}.motion--subtle .section{transition:transform .18s ease,box-shadow .18s ease}.motion--subtle .section:hover{transform:translateY(-2px)}.image--masked .brand-logo{border-radius:50%}.image--contained .brand-logo{object-fit:contain}.image--wide .brand-logo{max-width:240px}.contact{background:var(--ink);color:var(--canvas);padding:56px 0}.contact-list{list-style:none;padding:0;display:grid;gap:10px}.site-footer{border-top:1px solid color-mix(in srgb,var(--ink) 22%,transparent);padding:28px 0 48px;font-size:.85rem}.footer-row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}@media(max-width:720px){.nav{align-items:flex-start;padding:18px 0}.nav-links{gap:10px 14px}.brand-logo{height:34px;max-width:132px}.facts,.hero--split_media .shell,.hero--proof_grid .shell{display:block}.section{padding-block:28px;margin-bottom:var(--gap)}.hero h1{letter-spacing:-.045em}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.motion--subtle .section{transition:none}.motion--subtle .section:hover{transform:none}}`;
}

function renderLayoutSource(input: {
  brief: SiteBrief;
  routes: Array<{ slug: string; title: string }>;
  designSpec: SiteDesignSpecV1;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  brandAsset: FrozenSiteBrandAsset | null;
}) {
  const projection = siteDesignMaterializationProjection(input.designSpec);
  const nav = input.routes.map((route) => ({
    href: route.slug,
    title: route.title,
  }));
  return `---
interface Props {
  title: string;
  description: string;
  canonical: string | null;
  jsonLd: Record<string, unknown> | null;
}
const { title, description, canonical, jsonLd } = Astro.props;
const navigation = ${JSON.stringify(nav)};
const companyName = ${JSON.stringify(input.brief.companyName)};
const language = ${JSON.stringify(input.brief.primaryLanguage)};
const socialImage = ${JSON.stringify(input.canonicalOrigin ? `${input.canonicalOrigin}/social-card.svg` : null)};
const brandLogo = ${JSON.stringify(input.brandAsset ? `/${input.brandAsset.publicPath.slice("public/".length)}` : null)};
const brandLogoWidth = ${JSON.stringify(input.brandAsset?.width ?? null)};
const brandLogoHeight = ${JSON.stringify(input.brandAsset?.height ?? null)};
const bodyClass = ${JSON.stringify(projection.bodyClass)};
// JSON-LD is raw script text, so JSON escaping alone is insufficient: a
// customer/provider value containing </script> would otherwise close the
// element in the HTML parser. Emit JSON-safe unicode escapes for every less-
// than sign and the two JavaScript line separators before using set:html.
const jsonLdText = jsonLd
  ? JSON.stringify(jsonLd)
      .replaceAll("<", String.fromCharCode(92) + "u003c")
      .replaceAll(String.fromCharCode(0x2028), String.fromCharCode(92) + "u2028")
      .replaceAll(String.fromCharCode(0x2029), String.fromCharCode(92) + "u2029")
  : null;
---
<!doctype html>
<html lang={language}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <meta name="robots" content=${JSON.stringify(input.mode === "preview" ? "noindex,nofollow" : "index,follow")} />
    <meta property="og:type" content="website" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    {canonical && <link rel="canonical" href={canonical} />}
    {canonical && <meta property="og:url" content={canonical} />}
    {socialImage && <meta property="og:image" content={socialImage} />}
    {socialImage && <meta name="twitter:card" content="summary_large_image" />}
    {socialImage && <meta name="twitter:image" content={socialImage} />}
    {jsonLdText && <script type="application/ld+json" set:html={jsonLdText} />}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles.css" />
    <title>{title}</title>
  </head>
  <body class={bodyClass}>
    <header class="site-header">
      <nav class="shell nav" aria-label="主导航">
        <a class="brand" href="/">
          {brandLogo && <img class="brand-logo" src={brandLogo} width={brandLogoWidth} height={brandLogoHeight} alt={companyName + " Logo"} />}
          <span>{companyName}</span>
        </a>
        <div class="nav-links">{navigation.map((item) => <a href={item.href}>{item.title}</a>)}</div>
      </nav>
    </header>
    <main><slot /></main>
    <footer class="site-footer"><div class="shell footer-row"><strong>{companyName}</strong><span>内容依据已确认的企业知识库生成</span></div></footer>
  </body>
</html>
`;
}

function renderPageSource(input: {
  sourcePath: string;
  route: SiteBrief["routes"][number];
  generated: z.infer<typeof generatedRouteSchema>;
  composition: SiteDesignSpecV1["routeCompositions"][number];
  designSpec: SiteDesignSpecV1;
  brief: SiteBrief;
  siteDescription: string;
  organizationType: string;
  canonical: string | null;
}) {
  const projection = siteDesignMaterializationProjection(input.designSpec);
  const sourceDir = path.posix.dirname(input.sourcePath);
  let layoutImport = path.posix.relative(
    sourceDir,
    "src/layouts/SiteLayout.astro",
  );
  if (!layoutImport.startsWith(".")) layoutImport = `./${layoutImport}`;
  const jsonLd = input.canonical
    ? {
        "@context": "https://schema.org",
        "@type": input.organizationType,
        name: input.brief.companyName,
        url: input.canonical,
        description: input.siteDescription,
      }
    : null;
  const variantBySlot = new Map(
    input.composition.slots.map((slot) => [slot.slotId, slot.variant]),
  );
  const sections = input.generated.sections
    .map(
      (
        section,
      ) => `<section class="section section--${variantBySlot.get(section.slotId)}" data-slot="${escapeHtml(section.slotId)}">
        <h2>${escapeHtml(section.heading)}</h2>
        ${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n        ")}
        <p class="source-note">知识来源：${section.sourceDocumentIds.map(escapeHtml).join("、")}</p>
      </section>`,
    )
    .join("\n");
  const contacts = input.brief.contacts
    .map((contact) => {
      const href = safeContactHref(contact.kind, contact.value);
      const label = escapeHtml(contact.value);
      return href
        ? `<li><a href="${escapeHtml(href)}">${label}</a></li>`
        : `<li>${label}</li>`;
    })
    .join("\n          ");
  return `---
import SiteLayout from ${JSON.stringify(layoutImport)};
const title = ${JSON.stringify(`${input.generated.heading} | ${input.brief.companyName}`)};
const description = ${JSON.stringify(input.generated.summary)};
const canonical = ${JSON.stringify(input.canonical)};
const jsonLd = ${JSON.stringify(jsonLd)};
---
<SiteLayout {title} {description} {canonical} {jsonLd}>
  <section class="${projection.heroClass}"><div class="shell">
    <p class="eyebrow">${escapeHtml(input.generated.eyebrow ?? input.brief.companyName)}</p>
    <h1>${escapeHtml(input.generated.heading)}</h1>
    <p class="lede">${escapeHtml(input.generated.summary)}</p>
  </div></section>
  <div class="shell facts">${sections}</div>
  ${contacts ? `<section class="contact"><div class="shell"><h2>联系我们</h2><ul class="contact-list">${contacts}</ul></div></section>` : ""}
</SiteLayout>
`;
}

function addTextFile(
  files: SourceFile[],
  filePath: string,
  content: string | Buffer,
) {
  const normalized = filePath.normalize("NFKC");
  if (
    normalized !== filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("SITEOPS_SOURCE_PATH_INVALID");
  }
  files.push({
    path: filePath,
    bytes: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
  });
}

function buildTrustedSource(input: {
  contract: BuildContractV2;
  frozenRuntimeInput: z.infer<typeof siteOpsFrozenRuntimeInputSchema>;
  brief: SiteBrief;
  visual: SiteOpsRuntimeVisual;
  designSpec: SiteDesignSpecV1;
  content: SiteOpsGeneratedContent;
  canonicalOrigin: string | null;
  mode: "preview" | "production";
  brandAsset: TrustedSiteBrandAsset | null;
  workflow: SiteOpsMaterializerCoordinates;
}) {
  const files: SourceFile[] = [];
  const routePairs = input.brief.routes.map((route) => ({
    route,
    generated: input.content.routes.find((item) => item.routeId === route.id)!,
  }));
  addTextFile(
    files,
    "package.json",
    `${JSON.stringify(
      {
        name: `frontmind-site-${input.contract.source.knowledgeSnapshotId}`,
        private: true,
        version: "1.0.0",
        type: "module",
        engines: { node: ">=22.19.0" },
        scripts: { build: "astro build" },
        dependencies: { astro: ASTRO_VERSION, typescript: TYPESCRIPT_VERSION },
      },
      null,
      2,
    )}\n`,
  );
  addTextFile(
    files,
    "frontmind-runtime-lock.json",
    jsonBuffer({
      schemaVersion: 1,
      packageManager: "host-owned",
      installAtCustomerBuildTime: false,
      node: ">=22.19.0",
      dependencies: { astro: ASTRO_VERSION, typescript: TYPESCRIPT_VERSION },
      workflowManifestSha256: input.workflow.runtimeManifestSha256,
    }),
  );
  addTextFile(
    files,
    "astro.config.mjs",
    `export default Object.freeze({ output: "static", trailingSlash: "always", build: { assets: "_assets" } });\n`,
  );
  addTextFile(
    files,
    "tsconfig.json",
    `${JSON.stringify({ compilerOptions: { strict: true }, exclude: ["dist"] }, null, 2)}\n`,
  );
  addTextFile(files, "build-contract.json", jsonBuffer(input.contract));
  addTextFile(
    files,
    "frontmind-runtime-input.json",
    jsonBuffer(input.frozenRuntimeInput),
  );
  addTextFile(
    files,
    "src/layouts/SiteLayout.astro",
    renderLayoutSource({
      brief: input.brief,
      routes: input.brief.routes,
      designSpec: input.designSpec,
      mode: input.mode,
      canonicalOrigin: input.canonicalOrigin,
      brandAsset: freezeSiteBrandAsset(input.brandAsset),
    }),
  );
  for (const { route, generated } of routePairs) {
    const sourcePath = routeSourcePath(route.slug);
    addTextFile(
      files,
      sourcePath,
      renderPageSource({
        sourcePath,
        route,
        generated,
        composition: input.designSpec.routeCompositions.find(
          (item) => item.routeId === route.id,
        )!,
        designSpec: input.designSpec,
        brief: input.brief,
        siteDescription: input.content.seo.description,
        organizationType: input.content.seo.organizationType,
        canonical: input.canonicalOrigin
          ? routeCanonical(input.canonicalOrigin, route.slug)
          : null,
      }),
    );
  }
  addTextFile(
    files,
    "frontmind-component-manifest.json",
    jsonBuffer(
      siteDesignMaterializationProjectionFor(input.designSpec, input.workflow)
        .componentManifest,
    ),
  );
  addTextFile(
    files,
    "src/pages/404.astro",
    `---\nimport SiteLayout from "../layouts/SiteLayout.astro";\nconst title = ${JSON.stringify(`页面未找到 | ${input.brief.companyName}`)};\nconst description = "请求的页面不存在。";\nconst canonical = null;\nconst jsonLd = null;\n---\n<SiteLayout {title} {description} {canonical} {jsonLd}><section class="hero"><div class="shell"><p class="eyebrow">404</p><h1>页面未找到</h1><p class="lede"><a href="/">返回首页</a></p></div></section></SiteLayout>\n`,
  );
  addTextFile(
    files,
    "public/styles.css",
    `${cssForVisual(input.visual, input.designSpec)}\n`,
  );
  if (input.brandAsset) {
    addTextFile(files, input.brandAsset.publicPath, input.brandAsset.bytes);
  }
  const brandColors = input.visual.taxonomy.palette.filter((value) =>
    /^#[a-f0-9]{6}$/iu.test(value),
  );
  const brandInk = brandColors[0] ?? "#10212B";
  const brandAccent = brandColors[1] ?? "#A33A1B";
  const brandCanvas = "#F5F2EA";
  const companyGlyph = escapeXml(
    Array.from(input.brief.companyName.trim()).slice(0, 1).join("") || "•",
  );
  const socialCompany = escapeXml(
    Array.from(input.brief.companyName).slice(0, 36).join(""),
  );
  const socialDescription = escapeXml(
    Array.from(input.content.seo.description).slice(0, 86).join(""),
  );
  addTextFile(
    files,
    "public/favicon.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(input.brief.companyName)}"><rect width="64" height="64" rx="14" fill="${brandInk}"/><circle cx="48" cy="16" r="8" fill="${brandAccent}"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="${brandCanvas}">${companyGlyph}</text></svg>\n`,
  );
  addTextFile(
    files,
    "public/social-card.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="${socialCompany}"><rect width="1200" height="630" fill="${brandCanvas}"/><rect x="0" y="0" width="28" height="630" fill="${brandAccent}"/><circle cx="1060" cy="108" r="150" fill="${brandInk}" opacity=".08"/><text x="92" y="230" font-family="Arial,sans-serif" font-size="72" font-weight="700" fill="${brandInk}">${socialCompany}</text><text x="94" y="325" font-family="Arial,sans-serif" font-size="32" fill="${brandAccent}">${socialDescription}</text><text x="94" y="535" font-family="Arial,sans-serif" font-size="22" fill="${brandInk}" opacity=".72">内容依据已确认的企业知识库生成</text></svg>\n`,
  );
  addTextFile(
    files,
    "public/robots.txt",
    input.mode === "preview"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\nSitemap: ${input.canonicalOrigin}/sitemap.xml\n`,
  );
  if (input.mode === "production") {
    const urls = input.brief.routes.map(
      (route) =>
        `<url><loc>${escapeXml(routeCanonical(input.canonicalOrigin!, route.slug))}</loc></url>`,
    );
    addTextFile(
      files,
      "public/sitemap.xml",
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`,
    );
    addTextFile(
      files,
      "public/llms.txt",
      `# ${input.brief.companyName}\n\n${input.content.seo.description}\n\n${input.brief.routes.map((route) => `- [${route.title}](${routeCanonical(input.canonicalOrigin!, route.slug)})`).join("\n")}\n`,
    );
  }
  if (files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("SITEOPS_SOURCE_ENTRY_LIMIT_EXCEEDED");
  }
  const totalBytes = files.reduce(
    (total, file) => total + file.bytes.length,
    0,
  );
  if (totalBytes > MAX_SOURCE_BYTES) {
    throw new Error("SITEOPS_SOURCE_SIZE_LIMIT_EXCEEDED");
  }
  const paths = files.map((file) => file.path);
  if (
    new Set(paths.map((value) => value.toLocaleLowerCase("en-US"))).size !==
    paths.length
  ) {
    throw new Error("SITEOPS_SOURCE_PATH_COLLISION");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertTrustedSourceAssetIsolation(input: {
  files: readonly SourceFile[];
  assetDecisions: readonly z.infer<typeof siteOpsAssetDecisionSchema>[];
  brandAsset: TrustedSiteBrandAsset | null;
}) {
  const fileHashes = new Map(
    input.files.map((file) => [file.path, sha256(file.bytes)]),
  );
  const published = input.assetDecisions.filter(
    (decision) => decision.decision === "publish",
  );
  if (
    published.length !== (input.brandAsset ? 1 : 0) ||
    (input.brandAsset &&
      (published[0]?.id !== input.brandAsset.assetId ||
        published[0]?.sha256 !== input.brandAsset.sha256 ||
        fileHashes.get(input.brandAsset.publicPath) !==
          input.brandAsset.sha256))
  ) {
    throw new Error("SITEOPS_SOURCE_BRAND_ASSET_MISMATCH");
  }
  const quarantinedHashes = new Set(
    input.assetDecisions
      .filter((decision) => decision.decision === "quarantine")
      .map((decision) => decision.sha256),
  );
  if ([...fileHashes.values()].some((hash) => quarantinedHashes.has(hash))) {
    throw new Error("SITEOPS_SOURCE_QUARANTINED_ASSET_PRESENT");
  }
}

async function deterministicZip(
  files: readonly SourceFile[],
  maxBytes: number,
) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.bytes, {
      binary: true,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (buffer.length < 1 || buffer.length > maxBytes) {
    throw new Error("SITEOPS_ARCHIVE_SIZE_INVALID");
  }
  return buffer;
}

async function writeSourceRoot(root: string, files: readonly SourceFile[]) {
  for (const file of files) {
    const target = path.join(root, ...file.path.split("/"));
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("SITEOPS_SOURCE_PATH_ESCAPE");
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
  }
}

async function runAstroBuild(root: string, timeoutMs: number) {
  const require = createRequire(import.meta.url);
  const astroPackage = require.resolve("astro/package.json");
  const astroPackageRoot = path.dirname(astroPackage);
  const packageMetadata = JSON.parse(await readFile(astroPackage, "utf8")) as {
    version?: unknown;
  };
  if (packageMetadata.version !== ASTRO_VERSION) {
    throw new Error("SITEOPS_ASTRO_RUNTIME_VERSION_MISMATCH");
  }
  // Bare Astro entrypoints used by Vite resolve from the generated project
  // root. Expose only the already installed, version-checked host package;
  // never run a package manager and never include this trusted runtime link in
  // the customer source archive.
  const runtimeModules = path.join(root, "node_modules");
  await mkdir(runtimeModules, { recursive: false, mode: 0o700 });
  await symlink(astroPackageRoot, path.join(runtimeModules, "astro"), "dir");
  const cli = path.join(astroPackageRoot, "bin", "astro.mjs");
  const boundedTimeout = Math.min(Math.max(timeoutMs, 5_000), 120_000);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=512", cli, "build", "--root", root],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          ASTRO_TELEMETRY_DISABLED: "1",
          NO_COLOR: "1",
          LANG: "C.UTF-8",
          TZ: "UTC",
          PATH: path.dirname(process.execPath),
        },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (raw: Buffer) => {
      if (overflow) return;
      bytes += raw.length;
      if (bytes > MAX_BUILD_LOG_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(raw);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), boundedTimeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const log = Buffer.concat(chunks, Math.min(bytes, MAX_BUILD_LOG_BYTES));
      if (overflow)
        return reject(new Error("SITEOPS_BUILD_LOG_LIMIT_EXCEEDED"));
      if (code !== 0) {
        const suffix = log
          .toString("utf8")
          .slice(-2_000)
          .replace(SENSITIVE_TEXT, "[redacted]");
        return reject(
          new Error(`SITEOPS_ASTRO_BUILD_FAILED:${signal ?? code}:${suffix}`),
        );
      }
      resolve(log);
    });
  });
}

async function collectDirectory(root: string) {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile())
        throw new Error("SITEOPS_DIST_FILE_TYPE_REJECTED");
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        relative.startsWith("../") ||
        relative.includes("\\") ||
        relative
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      ) {
        throw new Error("SITEOPS_DIST_PATH_INVALID");
      }
      const bytes = await readFile(absolute);
      totalBytes += bytes.length;
      if (
        files.length >= MAX_ARCHIVE_ENTRIES ||
        totalBytes > MAX_DIST_BYTES ||
        bytes.length > 10 * 1024 * 1024
      ) {
        throw new Error("SITEOPS_DIST_LIMIT_EXCEEDED");
      }
      files.push({ path: relative, bytes });
    }
  };
  await visit(root);
  if (files.length < 1) throw new Error("SITEOPS_DIST_EMPTY");
  return files;
}

function servedMimeType(filename: string) {
  const extension = path.posix.extname(filename).toLowerCase();
  return (
    (
      {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".xml": "application/xml; charset=utf-8",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

async function runBrowserQa(input: {
  files: readonly SourceFile[];
  routes: SiteBrief["routes"];
  mode: "preview" | "production";
  workRoot: string;
}) {
  const files = new Map(input.files.map((file) => [file.path, file.bytes]));
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const clean = decoded.replace(/^\/+|\/+$/gu, "");
      const candidates = clean
        ? path.posix.extname(clean)
          ? [clean]
          : [`${clean}/index.html`, clean]
        : ["index.html"];
      const filename = candidates.find((candidate) => files.has(candidate));
      const bytes = filename ? files.get(filename) : files.get("404.html");
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      const headers: Record<string, string | number> = {
        "Cache-Control": "no-store",
        "Content-Type": servedMimeType(filename ?? "404.html"),
        "Content-Length": bytes.length,
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      };
      if (input.mode === "preview") {
        headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
      }
      response.writeHead(filename ? 200 : 404, headers);
      response.end(bytes);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("SITEOPS_VISUAL_QA_SERVER_FAILED");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const closeServer = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const screenshotFiles: SourceFile[] = [];
  let axeViolationCount = 0;
  const browser = await chromium
    .launch({
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-background-networking", "--disable-sync"],
      env: {
        HOME: input.workRoot,
        LANG: "C.UTF-8",
        TZ: "UTC",
        PATH: path.dirname(process.execPath),
      },
    })
    .catch(async (error) => {
      await closeServer();
      throw error;
    });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const inspectedRoutes = input.routes.slice(0, 3);
    for (const route of inspectedRoutes) {
      const routeUrl = `${origin}${route.slug}`;
      const response = await page.goto(routeUrl, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      if (!response?.ok()) throw new Error("SITEOPS_VISUAL_QA_ROUTE_FAILED");
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = axe.violations.filter((violation) =>
        ["critical", "serious"].includes(violation.impact ?? ""),
      );
      axeViolationCount += blocking.length;
      for (const viewport of [
        { label: "390", width: 390, height: 844 },
        { label: "768", width: 768, height: 1024 },
        { label: "1440", width: 1440, height: 1000 },
      ] as const) {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        const png = await page.screenshot({ fullPage: true, type: "png" });
        const routeName = route.slug === "/" ? "home" : route.id;
        screenshotFiles.push({
          path: `screenshots/${routeName}-${viewport.label}.png`,
          bytes: Buffer.from(png),
        });
      }
    }
  } catch (error) {
    await closeServer();
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const chromeRoot = path.join(input.workRoot, "chrome");
  await mkdir(chromeRoot, { recursive: true, mode: 0o700 });
  const chromeProfile = path.join(chromeRoot, "profile");
  await mkdir(chromeProfile, { recursive: false, mode: 0o700 });
  const launched = await launchChrome({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-sandbox",
    ],
    userDataDir: chromeProfile,
    handleSIGINT: false,
    logLevel: "silent",
    envVars: {
      HOME: chromeRoot,
      LANG: "C.UTF-8",
      TZ: "UTC",
      PATH: path.dirname(process.execPath),
    },
  }).catch(async (error) => {
    await closeServer();
    throw error;
  });
  try {
    const result = await lighthouse(
      `${origin}/`,
      {
        port: launched.port,
        output: "json",
        logLevel: "silent",
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        skipAudits: input.mode === "preview" ? ["is-crawlable"] : undefined,
      },
      undefined,
    );
    if (!result?.lhr) throw new Error("SITEOPS_LIGHTHOUSE_NO_RESULT");
    const score = (category: string) =>
      Math.round((result.lhr.categories[category]?.score ?? 0) * 100);
    const lighthouseScores = {
      performance: score("performance"),
      accessibility: score("accessibility"),
      bestPractices: score("best-practices"),
      seo: score("seo"),
      cls: Number(
        result.lhr.audits["cumulative-layout-shift"]?.numericValue ?? 1,
      ),
    };
    if (
      lighthouseScores.performance < 85 ||
      lighthouseScores.accessibility < 95 ||
      lighthouseScores.bestPractices < 90 ||
      lighthouseScores.seo < 95 ||
      lighthouseScores.cls >= 0.1
    ) {
      const failedAudits = Object.entries(result.lhr.audits)
        .filter(([, audit]) => audit.score !== null && audit.score < 1)
        .map(([id, audit]) => `${id}:${audit.score}`)
        .slice(0, 30);
      throw new Error(
        `SITEOPS_LIGHTHOUSE_THRESHOLD_FAILED:${JSON.stringify(lighthouseScores)}:${failedAudits.join(",")}`,
      );
    }
    if (axeViolationCount > 0) {
      throw new Error(`SITEOPS_AXE_BLOCKING_VIOLATIONS:${axeViolationCount}`);
    }
    return {
      summary: {
        lighthouse: lighthouseScores,
        axeViolationCount,
        screenshotFiles: screenshotFiles.map((file) => file.path),
      },
      screenshotFiles,
    };
  } finally {
    try {
      launched.kill();
    } catch {
      // The process may already have exited after Lighthouse completion.
    }
    await closeServer();
  }
}

function htmlText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function qaDist(input: {
  files: readonly SourceFile[];
  brief: SiteBrief;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  assetDecisions: readonly z.infer<typeof siteOpsAssetDecisionSchema>[];
  brandAsset: FrozenSiteBrandAsset | null;
  qaPolicyVersion: string;
}) {
  const files = new Map(input.files.map((file) => [file.path, file.bytes]));
  const routeOutputs = input.brief.routes.map((route) =>
    routeOutputPath(route.slug),
  );
  const checks: SiteOpsQaReport["checks"] = [];
  const requireCheck = (id: string, condition: boolean, detail: string) => {
    if (!condition) throw new Error(`SITEOPS_QA_FAILED:${id}`);
    checks.push({ id, passed: true, detail });
  };
  requireCheck(
    "route-manifest",
    routeOutputs.every((output) => files.has(output)) && files.has("404.html"),
    `${routeOutputs.length} routes and 404 are present`,
  );
  const htmlFiles = [...files.entries()].filter(([name]) =>
    name.endsWith(".html"),
  );
  requireCheck(
    "static-html",
    htmlFiles.length >= routeOutputs.length + 1,
    "Astro emitted static HTML",
  );
  requireCheck(
    "brand-assets",
    files.has("favicon.svg") && files.has("social-card.svg"),
    "customer-derived favicon and social card are present",
  );
  const published = input.assetDecisions.filter(
    (decision) => decision.decision === "publish",
  );
  const expectedBrandPath = input.brandAsset
    ? input.brandAsset.publicPath.slice("public/".length)
    : null;
  requireCheck(
    "published-brand-asset",
    published.length === (input.brandAsset ? 1 : 0) &&
      (input.brandAsset
        ? published[0]?.id === input.brandAsset.assetId &&
          published[0]?.sha256 === input.brandAsset.sha256 &&
          Boolean(expectedBrandPath) &&
          files.has(expectedBrandPath!) &&
          sha256(files.get(expectedBrandPath!)!) === input.brandAsset.sha256
        : ![...files.keys()].some((name) =>
            /^brand-logo(?:\.|$)/iu.test(name),
          )),
    "every publish decision maps to the exact frozen official logo bytes",
  );
  const quarantinedHashes = new Set(
    input.assetDecisions
      .filter((decision) => decision.decision === "quarantine")
      .map((decision) => decision.sha256),
  );
  requireCheck(
    "quarantined-assets-absent",
    [...files.values()].every(
      (bytes) =>
        !quarantinedHashes.has(sha256(bytes)) &&
        ![...quarantinedHashes].some((hash) =>
          bytes.toString("utf8").includes(hash),
        ),
    ),
    "no quarantined asset bytes or hashes are emitted into the website",
  );
  for (const [name, bytes] of htmlFiles) {
    const html = bytes.toString("utf8");
    requireCheck(
      `no-js-shell:${name}`,
      htmlText(html).length >= 24 &&
        !/<div\s+id=["']root["'][^>]*>\s*<\/div>/iu.test(html),
      "meaningful text remains with JavaScript disabled",
    );
    requireCheck(
      `no-executable-script:${name}`,
      !/<script\b(?![^>]*type=["']application\/ld\+json["'])/iu.test(html) &&
        !/<script\b[^>]*\bsrc=/iu.test(html),
      "no executable or external script is present",
    );
    requireCheck(
      `no-sensitive-text:${name}`,
      !SENSITIVE_TEXT.test(html) && !FORBIDDEN_DEMO_TEXT.test(html),
      "no credential-shaped or demo text is present",
    );
    if (expectedBrandPath) {
      requireCheck(
        `brand-logo-rendered:${name}`,
        html.includes(`class="brand-logo"`) &&
          html.includes(`src="/${expectedBrandPath}"`),
        "the frozen official logo is rendered in the shared header",
      );
    }
    const hrefs = [...html.matchAll(/\bhref=["']([^"']+)["']/giu)].map(
      (match) => match[1]!,
    );
    for (const href of hrefs) {
      if (/^(?:https:|mailto:|tel:|#)/u.test(href)) continue;
      const pathname = new URL(href, "https://preview.invalid").pathname;
      const expected = pathname.endsWith("/")
        ? `${pathname.slice(1)}index.html` || "index.html"
        : pathname.slice(1);
      requireCheck(
        `internal-link:${name}:${href}`,
        files.has(expected),
        "internal link resolves to a generated file",
      );
    }
  }
  const robots = files.get("robots.txt")?.toString("utf8") ?? "";
  if (input.mode === "preview") {
    requireCheck(
      "preview-noindex",
      htmlFiles.every(([, bytes]) =>
        /<meta\s+name=["']robots["']\s+content=["']noindex,nofollow["']/iu.test(
          bytes.toString("utf8"),
        ),
      ),
      "every preview page is noindex,nofollow",
    );
    requireCheck(
      "preview-no-canonical",
      htmlFiles.every(
        ([, bytes]) => !/rel=["']canonical["']/iu.test(bytes.toString("utf8")),
      ),
      "preview contains no canonical link",
    );
    requireCheck(
      "preview-discovery-disabled",
      /Disallow:\s*\//u.test(robots) &&
        !files.has("sitemap.xml") &&
        !files.has("llms.txt"),
      "robots disallows crawling and discovery files are absent",
    );
  } else {
    requireCheck(
      "production-canonical",
      routeOutputs.every((output) =>
        files
          .get(output)!
          .toString("utf8")
          .includes(
            `rel="canonical" href="${routeCanonical(input.canonicalOrigin!, output === "index.html" ? "/" : `/${output.replace(/index\.html$/u, "")}`)}"`,
          ),
      ),
      "each public route has the exact HTTPS canonical",
    );
    requireCheck(
      "production-discovery",
      files.has("sitemap.xml") &&
        files.has("llms.txt") &&
        /Sitemap:\s*https:\/\//u.test(robots),
      "sitemap, robots and llms.txt are present",
    );
    requireCheck(
      "production-jsonld",
      routeOutputs.every((output) =>
        /type="application\/ld\+json"/u.test(
          files.get(output)!.toString("utf8"),
        ),
      ),
      "each public route contains JSON-LD",
    );
    requireCheck(
      "production-social-image",
      routeOutputs.every((output) =>
        files
          .get(output)!
          .toString("utf8")
          .includes(
            `property="og:image" content="${input.canonicalOrigin}/social-card.svg"`,
          ),
      ),
      "each public route references the exact canonical social card",
    );
  }
  requireCheck(
    "single-language",
    htmlFiles.every(([, bytes]) => !/hreflang=/iu.test(bytes.toString("utf8"))),
    "no false hreflang is emitted for the single-language site",
  );
  requireCheck(
    "no-javascript-assets",
    ![...files.keys()].some(
      (name) => name.endsWith(".js") || name.endsWith(".mjs"),
    ),
    "dist contains no JavaScript asset",
  );
  return {
    schemaVersion: 1,
    policyVersion: input.qaPolicyVersion,
    passed: true,
    mode: input.mode,
    routes: input.brief.routes.map((route) => route.slug),
    checks,
    fileCount: input.files.length,
    totalBytes: input.files.reduce(
      (total, file) => total + file.bytes.length,
      0,
    ),
  } satisfies Omit<SiteOpsQaReport, "browser">;
}

async function materializeAstroSiteWithWorkflow(
  input: MaterializeAstroSiteInput,
  workflow: SiteOpsMaterializerCoordinates,
): Promise<MaterializedAstroSite> {
  const brandAsset = input.brandAsset
    ? await validateTrustedSiteBrandAsset(input.brandAsset)
    : null;
  const validated = validateInput(input, brandAsset, workflow);
  const contract = composeBuildContractV2({
    schemaVersion: 2,
    source: {
      knowledgeSnapshotId: input.snapshot.id,
      archiveSha256: input.build.knowledgeArchiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
    },
    workflow: {
      upstreamSha256: workflow.upstreamSha256,
      version: workflow.frontMindVersion,
      manifestSha256: workflow.runtimeManifestSha256,
      starterVersion: workflow.starterVersion,
      starterSha256: workflow.starterSha256,
      componentLibraryVersion: workflow.componentLibraryVersion,
      materializerVersion: workflow.materializerVersion,
      materializerSha256: workflow.materializerSha256,
    },
    identity: {
      companyName: validated.brief.companyName,
      primaryLanguage: validated.brief.primaryLanguage,
      verifiedContacts: validated.brief.contacts.map(
        (contact) => `${contact.kind}:${contact.value}`,
      ),
    },
    visual: {
      ...validated.visual,
      designSpecHash: canonicalSiteOpsSha256(validated.designSpec),
      componentLibraryVersion: workflow.componentLibraryVersion,
    },
    routes: validated.brief.routes,
    assets: validated.assetDecisions,
    seo: {
      ...validated.designSpec.seoPlan,
      environment: input.mode,
      canonicalPolicy:
        input.mode === "preview" ? "forbidden" : "exact_https_origin",
    },
    target: {
      environment:
        input.mode === "preview"
          ? "preview"
          : (input.target ?? "global_excluding_cn"),
      canonicalOrigin: validated.canonicalOrigin,
    },
    qaPolicyVersion: workflow.qaPolicyVersion,
  });
  const frozenRuntimeInput = siteOpsFrozenRuntimeInputSchema.parse({
    schemaVersion: 2,
    build: {
      id: input.build.id,
      projectId: input.build.projectId,
      userId: input.build.userId,
      knowledgeSnapshotId: input.build.knowledgeSnapshotId,
      knowledgeArchiveHash: input.build.knowledgeArchiveHash,
      workflowUpstreamVersion: input.build.workflowUpstreamVersion,
      workflowUpstreamHash: input.build.workflowUpstreamHash,
      workflowVersion: input.build.workflowVersion,
      workflowPackageHash: input.build.workflowPackageHash,
      starterVersion: input.build.starterVersion,
      selectionHash: input.build.selectionHash,
    },
    host: {
      starterSha256: workflow.starterSha256,
      componentLibraryVersion: workflow.componentLibraryVersion,
      materializerVersion: workflow.materializerVersion,
      materializerSha256: workflow.materializerSha256,
    },
    snapshot: {
      id: input.snapshot.id,
      userId: input.snapshot.userId,
      archiveHash: input.snapshot.archiveHash,
      sourceBuildId: input.snapshot.sourceBuildId,
      sourceBuildRevision: input.snapshot.sourceBuildRevision,
      sourceDocumentIds: [...validated.sourceDocuments.keys()].sort(),
    },
    brief: validated.brief,
    visual: validated.visual,
    designSpec: validated.designSpec,
    generatedContent: validated.generatedContent,
    assetDecisions: validated.assetDecisions,
    brandAsset: freezeSiteBrandAsset(validated.brandAsset),
  });
  const contractJson = jsonBuffer(contract);
  const sourceFiles = buildTrustedSource({
    contract,
    frozenRuntimeInput,
    brief: validated.brief,
    visual: validated.visual,
    designSpec: validated.designSpec,
    content: validated.generatedContent,
    canonicalOrigin: validated.canonicalOrigin,
    mode: input.mode,
    brandAsset: validated.brandAsset,
    workflow,
  });
  assertTrustedSourceAssetIsolation({
    files: sourceFiles,
    assetDecisions: validated.assetDecisions,
    brandAsset: validated.brandAsset,
  });
  const sourceZip = await deterministicZip(sourceFiles, MAX_SOURCE_BYTES);
  const nonce = randomBytes(8).toString("hex");
  const buildRoot = await mkdtemp(
    path.join(tmpdir(), `frontmind-siteops-${input.build.id}-${nonce}-`),
  );
  try {
    await writeSourceRoot(buildRoot, sourceFiles);
    const buildLog = await runAstroBuild(
      buildRoot,
      input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    );
    const distRoot = path.join(buildRoot, "dist");
    const distFiles = await collectDirectory(distRoot);
    const staticQa = qaDist({
      files: distFiles,
      brief: validated.brief,
      mode: input.mode,
      canonicalOrigin: validated.canonicalOrigin,
      assetDecisions: validated.assetDecisions,
      brandAsset: freezeSiteBrandAsset(validated.brandAsset),
      qaPolicyVersion: workflow.qaPolicyVersion,
    });
    const browserQa = await runBrowserQa({
      files: distFiles,
      routes: validated.brief.routes,
      mode: input.mode,
      workRoot: buildRoot,
    });
    const qa: SiteOpsQaReport = {
      ...staticQa,
      browser: browserQa.summary,
    };
    const distZip = await deterministicZip(distFiles, MAX_DIST_BYTES);
    const qaJson = jsonBuffer(qa);
    const visualQaZip = await deterministicZip(
      [
        { path: "visual-qa/report.json", bytes: qaJson },
        ...browserQa.screenshotFiles,
      ],
      MAX_DIST_BYTES,
    );
    const provenance = {
      schemaVersion: 1,
      buildId: input.build.id,
      projectId: input.build.projectId,
      knowledgeSnapshotId: input.snapshot.id,
      knowledgeArchiveSha256: input.build.knowledgeArchiveHash,
      workflow: {
        upstreamSha256: workflow.upstreamSha256,
        runtimeManifestSha256: workflow.runtimeManifestSha256,
        version: workflow.frontMindVersion,
        starterVersion: workflow.starterVersion,
        starterSha256: workflow.starterSha256,
        componentLibraryVersion: workflow.componentLibraryVersion,
        materializerVersion: workflow.materializerVersion,
        materializerSha256: workflow.materializerSha256,
      },
      visual: {
        queryHash: validated.visual.queryHash,
        selectedCandidateId: validated.visual.selectedCandidateId,
        providerItemKey: validated.visual.providerItemKey,
        visualEvidenceSha256: validated.visual.visualEvidenceSha256,
        previewSha256: validated.visual.previewSha256,
        supportEvidenceSha256s: validated.visual.supportEvidenceSha256s,
        designSpecHash: canonicalSiteOpsSha256(validated.designSpec),
      },
      brandAsset: freezeSiteBrandAsset(validated.brandAsset),
      contractSha256: sha256(contractJson),
      sourceSha256: sha256(sourceZip),
      distSha256: sha256(distZip),
      providerCodeReused: false,
      providerPromptPersisted: false,
      packageOrConfigAcceptedFromProvider: false,
      runtimeInstallPerformed: false,
    };
    const provenanceJson = jsonBuffer(provenance);
    return {
      contract,
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip,
      sourceSha256: sha256(sourceZip),
      distZip,
      distSha256: sha256(distZip),
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip,
      visualQaSha256: sha256(visualQaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog,
      files: new Map(distFiles.map((file) => [file.path, file.bytes])),
    };
  } finally {
    await rm(buildRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export function materializeAstroSite(input: MaterializeAstroSiteInput) {
  return materializeAstroSiteWithWorkflow(input, SITEOPS_WORKFLOW);
}

function materializeAstroSiteV1_2(input: MaterializeAstroSiteInput) {
  return materializeAstroSiteWithWorkflow(input, SITEOPS_MATERIALIZER_V1_2);
}

function materializeAstroSiteV1_3(input: MaterializeAstroSiteInput) {
  return materializeAstroSiteWithWorkflow(input, SITEOPS_MATERIALIZER_V1_3);
}

function materializeAstroSiteV1_4(input: MaterializeAstroSiteInput) {
  return materializeAstroSiteWithWorkflow(input, SITEOPS_MATERIALIZER_V1_4);
}

function materializeAstroSiteV1_5(input: MaterializeAstroSiteInput) {
  return materializeAstroSiteWithWorkflow(input, SITEOPS_MATERIALIZER_V1_5);
}

const productionMaterializerRegistry = [
  {
    workflow: SITEOPS_MATERIALIZER_V1_2,
    materialize: materializeAstroSiteV1_2,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_3,
    materialize: materializeAstroSiteV1_3,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_4,
    materialize: materializeAstroSiteV1_4,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_5,
    materialize: materializeAstroSiteV1_5,
  },
] as const;

/**
 * Rebuilds the exact approved content for a production hostname from the
 * host-generated preview source bundle. Callers cannot supply page content,
 * paths, dependencies or source code at publication time.
 */
export async function materializeProductionSiteFromSource(input: {
  sourceZip: Buffer;
  expectedSourceSha256: string;
  canonicalOrigin: string;
  target: "global_excluding_cn" | "mainland_cn";
  timeoutMs?: number;
}) {
  if (
    input.sourceZip.length < 1 ||
    input.sourceZip.length > MAX_SOURCE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(input.expectedSourceSha256) ||
    sha256(input.sourceZip) !== input.expectedSourceSha256
  ) {
    throw new Error("SITEOPS_PRODUCTION_SOURCE_HASH_MISMATCH");
  }
  const canonicalOrigin = validateCanonicalOrigin(
    "production",
    input.canonicalOrigin,
  )!;
  const archive = await JSZip.loadAsync(input.sourceZip, { checkCRC32: true });
  const entries = Object.values(archive.files);
  if (entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("SITEOPS_PRODUCTION_SOURCE_STRUCTURE_INVALID");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.name.normalize("NFKC");
    const mode = Number(entry.unixPermissions ?? 0);
    if (
      normalized !== entry.name ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      entry.name.split("/").some((part) => part === "." || part === "..") ||
      (mode && (mode & 0o170000) === 0o120000)
    ) {
      throw new Error("SITEOPS_PRODUCTION_SOURCE_STRUCTURE_INVALID");
    }
    const collisionKey = normalized.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) {
      throw new Error("SITEOPS_PRODUCTION_SOURCE_PATH_COLLISION");
    }
    seen.add(collisionKey);
  }
  const runtimeEntry = archive.file("frontmind-runtime-input.json");
  if (!runtimeEntry) {
    throw new Error("SITEOPS_FROZEN_RUNTIME_INPUT_MISSING");
  }
  const runtimeBytes = await runtimeEntry.async("nodebuffer");
  if (runtimeBytes.length < 1 || runtimeBytes.length > 4 * 1024 * 1024) {
    throw new Error("SITEOPS_FROZEN_RUNTIME_INPUT_SIZE_INVALID");
  }
  let rawRuntime: unknown;
  try {
    rawRuntime = JSON.parse(runtimeBytes.toString("utf8"));
  } catch {
    throw new Error("SITEOPS_FROZEN_RUNTIME_INPUT_INVALID");
  }
  const frozen = siteOpsFrozenRuntimeInputSchema.parse(rawRuntime);
  if (
    frozen.build.knowledgeSnapshotId !== frozen.snapshot.id ||
    frozen.build.knowledgeArchiveHash !== frozen.snapshot.archiveHash ||
    frozen.build.userId !== frozen.snapshot.userId
  ) {
    throw new Error("SITEOPS_FROZEN_RUNTIME_COORDINATES_MISMATCH");
  }
  const registeredMaterializer = productionMaterializerRegistry.find(
    ({ workflow }) =>
      frozen.build.workflowUpstreamVersion === workflow.upstreamVersion &&
      frozen.build.workflowUpstreamHash === workflow.upstreamSha256 &&
      frozen.build.workflowVersion === workflow.frontMindVersion &&
      frozen.build.workflowPackageHash === workflow.runtimeManifestSha256 &&
      frozen.build.starterVersion === workflow.starterVersion &&
      frozen.host.starterSha256 === workflow.starterSha256 &&
      frozen.host.componentLibraryVersion ===
        workflow.componentLibraryVersion &&
      frozen.host.materializerVersion === workflow.materializerVersion &&
      frozen.host.materializerSha256 === workflow.materializerSha256,
  );
  if (!registeredMaterializer) {
    throw new Error("SITEOPS_FROZEN_HOST_COORDINATES_MISMATCH");
  }
  let brandAsset: TrustedSiteBrandAsset | null = null;
  if (frozen.brandAsset) {
    const brandEntry = archive.file(frozen.brandAsset.publicPath);
    if (!brandEntry) throw new Error("SITEOPS_FROZEN_BRAND_ASSET_MISSING");
    const brandBytes = await brandEntry.async("nodebuffer");
    brandAsset = await validateTrustedSiteBrandAsset({
      ...frozen.brandAsset,
      bytes: brandBytes,
    });
  } else if (
    entries.some(
      (entry) =>
        !entry.dir && /^public\/brand-logo(?:\.[^/]+)?$/iu.test(entry.name),
    )
  ) {
    throw new Error("SITEOPS_FROZEN_BRAND_ASSET_UNDECLARED");
  }
  const materialized = await registeredMaterializer.materialize({
    build: frozen.build,
    snapshot: {
      id: frozen.snapshot.id,
      userId: frozen.snapshot.userId,
      archiveHash: frozen.snapshot.archiveHash,
      sourceBuildId: frozen.snapshot.sourceBuildId,
      sourceBuildRevision: frozen.snapshot.sourceBuildRevision,
      documents: frozen.snapshot.sourceDocumentIds.map((id) => ({
        id,
        path: id,
        title: "",
        content: "",
        customerVisible: true,
      })),
    },
    brief: frozen.brief,
    visual: frozen.visual,
    designSpec: frozen.designSpec,
    generatedContent: frozen.generatedContent,
    assetDecisions: frozen.assetDecisions,
    brandAsset,
    mode: "production",
    target: input.target,
    canonicalOrigin,
    timeoutMs: input.timeoutMs,
  });
  return {
    contractJson: materialized.contractJson,
    contractSha256: materialized.contractSha256,
    sourceZip: materialized.sourceZip,
    sourceSha256: materialized.sourceSha256,
    distZip: materialized.distZip,
    distSha256: materialized.distSha256,
    qaZip: materialized.visualQaZip,
    qaSha256: materialized.visualQaSha256,
    qaReport: JSON.parse(
      materialized.qaJson.toString("utf8"),
    ) as SiteOpsQaReport,
    provenanceJson: materialized.provenanceJson,
    provenanceSha256: materialized.provenanceSha256,
  };
}

const socialSourceSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    title: z.string().trim().min(1).max(255),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

const socialSectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(100),
    paragraphs: z.array(z.string().trim().min(1).max(1_000)).min(1).max(5),
    sourceDocumentIds: z
      .array(z.string().trim().min(1).max(191))
      .min(1)
      .max(20),
  })
  .strict();

export const socialPackageInputSchema = z
  .object({
    channel: z.enum(["wechat", "xiaohongshu"]),
    companyName: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(80),
    deck: z.string().trim().min(1).max(240),
    sourceDocuments: z.array(socialSourceSchema).min(1).max(100),
    sections: z.array(socialSectionSchema).min(1).max(20),
    hashtags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  })
  .strict();

export type SocialPackageInput = z.infer<typeof socialPackageInputSchema>;
export type SocialPackageManifest = {
  schemaVersion: 1;
  channel: "wechat" | "xiaohongshu";
  brand: string;
  files: Array<{
    path: string;
    mimeType: string;
    bytes: number;
    sha256: string;
  }>;
};
export type GeneratedSocialPackage = {
  archive: Buffer;
  archiveSha256: string;
  manifest: SocialPackageManifest;
  manifestJson: Buffer;
  manifestSha256: string;
  qa: Record<string, unknown>;
  qaJson: Buffer;
  previews: Array<{
    filename: string;
    mimeType: "image/png";
    buffer: Buffer;
    sha256: string;
  }>;
};

const SOCIAL_PALETTES = [
  ["#10212B", "#F4EDE1", "#EF6C45", "#C7D8D9"],
  ["#171520", "#F5F0E8", "#6B65E8", "#E9BA5B"],
  ["#15332F", "#F3F0E5", "#D8523A", "#9FC5B7"],
] as const;

function brandPalette(companyName: string) {
  const index =
    Number.parseInt(sha256(companyName).slice(0, 2), 16) %
    SOCIAL_PALETTES.length;
  return SOCIAL_PALETTES[index]!;
}

function wrapVisualText(value: string, maxUnits: number, maxLines: number) {
  const characters = [...value.replace(/\s+/gu, " ").trim()];
  const lines: string[] = [];
  let current = "";
  let units = 0;
  const weight = (character: string) =>
    /^[\x00-\xff]$/u.test(character) ? 0.55 : 1;
  for (const character of characters) {
    const next = weight(character);
    if (units + next > maxUnits && current) {
      lines.push(current.trim());
      current = "";
      units = 0;
      if (lines.length >= maxLines) break;
    }
    current += character;
    units += next;
  }
  if (current.trim() && lines.length < maxLines) lines.push(current.trim());
  if (lines.join("").length < characters.join("").length && lines.length > 0) {
    lines[lines.length - 1] =
      `${lines[lines.length - 1]!.replace(/[，。；、,.!?！？\s]+$/u, "")}…`;
  }
  return lines;
}

function svgText(
  lines: string[],
  x: number,
  y: number,
  options: { size: number; fill: string; lineHeight: number; weight?: number },
) {
  return `<text x="${x}" y="${y}" font-family="Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="${options.size}" font-weight="${options.weight ?? 700}" fill="${options.fill}">${lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : options.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("")}</text>`;
}

async function pngFromSvg(svg: string, width: number, height: number) {
  const buffer = await sharp(Buffer.from(svg, "utf8"), {
    limitInputPixels: width * height,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (buffer.length < 1 || buffer.length > 8 * 1024 * 1024) {
    throw new Error("SITEOPS_SOCIAL_IMAGE_SIZE_INVALID");
  }
  return buffer;
}

async function wechatCover(input: SocialPackageInput, variant: number) {
  const [ink, canvas, accent, muted] = brandPalette(input.companyName);
  const title = wrapVisualText(input.title, 10.5, 4);
  const company = wrapVisualText(input.companyName, 18, 2);
  const illustration =
    variant === 0
      ? `<circle cx="1000" cy="300" r="178" fill="none" stroke="${accent}" stroke-width="34"/><circle cx="1000" cy="300" r="92" fill="${muted}"/><path d="M790 300h420M1000 90v420" stroke="${ink}" stroke-width="7" stroke-dasharray="14 18"/>`
      : variant === 1
        ? `<path d="M750 190h190v100H750zM970 250h190v100H970zM1190 310h150v100h-150z" fill="none" stroke="${ink}" stroke-width="8"/><path d="M940 240l30 30M1160 300l30 30" stroke="${accent}" stroke-width="18"/><circle cx="790" cy="240" r="18" fill="${accent}"/><circle cx="1235" cy="360" r="18" fill="${muted}"/>`
        : `<circle cx="1045" cy="300" r="74" fill="${accent}"/><circle cx="790" cy="170" r="48" fill="${muted}"/><circle cx="1270" cy="160" r="48" fill="${muted}"/><circle cx="790" cy="445" r="48" fill="${muted}"/><circle cx="1270" cy="445" r="48" fill="${muted}"/><path d="M834 192l144 75M1112 265l114-78M837 421l142-86M1110 336l116 82" stroke="${ink}" stroke-width="8"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1410" height="600" viewBox="0 0 1410 600"><rect width="1410" height="600" fill="${canvas}"/><rect x="600" width="810" height="600" fill="${variant === 1 ? muted : canvas}"/><rect x="46" y="44" width="64" height="8" fill="${accent}"/>${svgText(company, 46, 88, { size: 23, fill: ink, lineHeight: 30, weight: 700 })}${svgText(title, 46, 190, { size: 58, fill: ink, lineHeight: 69, weight: 800 })}<text x="46" y="548" font-family="Arial, 'PingFang SC', sans-serif" font-size="18" fill="${ink}">FrontMind · 企业知识内容</text>${illustration}<path d="M600 0v600" stroke="${ink}" stroke-width="2" opacity=".2"/></svg>`;
  return pngFromSvg(svg, 1410, 600);
}

async function xiaohongshuPage(input: SocialPackageInput, index: number) {
  const [ink, canvas, accent, muted] = brandPalette(input.companyName);
  const cover = index === 0;
  const section = input.sections[Math.max(0, index - 1)]!;
  const heading = cover ? input.title : section.heading;
  const headingLines = wrapVisualText(heading, cover ? 11 : 13, cover ? 4 : 3);
  const body = cover ? input.deck : section.paragraphs.join(" ");
  const bodyLines = wrapVisualText(body, 24, cover ? 5 : 11);
  const motif = index % 3;
  const visual =
    motif === 0
      ? `<circle cx="850" cy="360" r="230" fill="${muted}"/><circle cx="850" cy="360" r="112" fill="${accent}"/><path d="M580 360h540M850 90v540" stroke="${ink}" stroke-width="9" stroke-dasharray="20 22"/>`
      : motif === 1
        ? `<path d="M610 210h330v180H610zM760 430h250v150H760z" fill="none" stroke="${ink}" stroke-width="10"/><rect x="660" y="260" width="330" height="180" fill="${muted}"/><circle cx="1015" cy="220" r="55" fill="${accent}"/>`
        : `<path d="M620 260c110-150 330-150 440 0s-20 330-220 330-330-180-220-330z" fill="${muted}"/><path d="M670 520l340-240" stroke="${accent}" stroke-width="38"/><circle cx="690" cy="500" r="52" fill="${ink}"/><circle cx="990" cy="300" r="52" fill="${ink}"/>`;
  const citations = cover
    ? "基于企业知识库的可追溯内容"
    : `来源：${section.sourceDocumentIds.join(" / ")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440"><rect width="1080" height="1440" fill="${canvas}"/><rect x="0" y="0" width="1080" height="26" fill="${accent}"/><text x="70" y="104" font-family="Arial, 'PingFang SC', sans-serif" font-size="26" font-weight="700" fill="${ink}">${escapeXml(input.companyName)}</text><text x="930" y="104" text-anchor="end" font-family="Arial, sans-serif" font-size="24" fill="${ink}">${String(index + 1).padStart(2, "0")} / 09</text>${cover ? visual : ""}${svgText(headingLines, 70, cover ? 760 : 230, { size: cover ? 82 : 68, fill: ink, lineHeight: cover ? 96 : 82, weight: 800 })}${svgText(bodyLines, 70, cover ? 1140 : 540, { size: 31, fill: ink, lineHeight: 49, weight: 500 })}${!cover ? `<g transform="translate(0 720) scale(.65)">${visual}</g>` : ""}<line x1="70" x2="1010" y1="1325" y2="1325" stroke="${ink}" opacity=".25"/><text x="70" y="1372" font-family="Arial, 'PingFang SC', sans-serif" font-size="20" fill="${ink}" opacity=".75">${escapeXml(citations)}</text></svg>`;
  return pngFromSvg(svg, 1080, 1440);
}

function mimeTypeForSocialPath(filePath: string) {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function validateSocialInput(raw: SocialPackageInput | unknown) {
  const input = socialPackageInputSchema.parse(raw);
  if (input.channel === "xiaohongshu" && input.sections.length !== 8) {
    throw new Error("SITEOPS_XIAOHONGSHU_EIGHT_SECTIONS_REQUIRED");
  }
  const sourceIds = new Set(input.sourceDocuments.map((source) => source.id));
  if (
    sourceIds.size !== input.sourceDocuments.length ||
    input.sections.some((section) =>
      section.sourceDocumentIds.some((id) => !sourceIds.has(id)),
    )
  ) {
    throw new Error("SITEOPS_SOCIAL_SOURCE_MAPPING_INVALID");
  }
  assertNoSensitiveText("social-package", canonicalJson(input));
  return input;
}

export async function generateSocialPackage(
  raw: SocialPackageInput | unknown,
): Promise<GeneratedSocialPackage> {
  const input = validateSocialInput(raw);
  const payloadFiles: SourceFile[] = [];
  const previews: GeneratedSocialPackage["previews"] = [];
  const sources = {
    schemaVersion: 1,
    documents: input.sourceDocuments,
    claimMappings: input.sections.map((section, index) => ({
      section: index + 1,
      heading: section.heading,
      sourceDocumentIds: section.sourceDocumentIds,
    })),
  };
  if (input.channel === "wechat") {
    const article = `# ${input.title}\n\n${input.deck}\n\n${input.sections
      .map(
        (section) =>
          `## ${section.heading}\n\n${section.paragraphs.join("\n\n")}\n\n> 来源：${section.sourceDocumentIds.join("、")}`,
      )
      .join("\n\n")}\n\n---\n${input.companyName} · 内容依据企业知识库制作\n`;
    addTextFile(payloadFiles, "article.md", article);
    addTextFile(payloadFiles, "title.txt", `${input.title}\n`);
    addTextFile(payloadFiles, "sources.json", jsonBuffer(sources));
    for (let index = 0; index < 3; index += 1) {
      const buffer = await wechatCover(input, index);
      const filename = `covers/${String(index + 1).padStart(2, "0")}.png`;
      addTextFile(payloadFiles, filename, buffer);
      previews.push({
        filename,
        mimeType: "image/png",
        buffer,
        sha256: sha256(buffer),
      });
    }
  } else {
    for (let index = 0; index < 9; index += 1) {
      const buffer = await xiaohongshuPage(input, index);
      const suffix =
        index === 0 ? "cover" : `section-${String(index).padStart(2, "0")}`;
      const filename = `images/${String(index + 1).padStart(2, "0")}-${suffix}.png`;
      addTextFile(payloadFiles, filename, buffer);
      previews.push({
        filename,
        mimeType: "image/png",
        buffer,
        sha256: sha256(buffer),
      });
    }
    const postCopy = `${input.title}\n\n${input.deck}\n\n${input.sections.map((section) => `• ${section.heading}`).join("\n")}\n\n${input.hashtags.map((tag) => `#${tag.replace(/^#/u, "")}`).join(" ")}\n\n${input.companyName} · 内容依据企业知识库制作\n`;
    addTextFile(payloadFiles, "post-copy.md", postCopy);
    addTextFile(payloadFiles, "sources.json", jsonBuffer(sources));
  }
  const expectedPayloadCount = input.channel === "wechat" ? 6 : 11;
  if (payloadFiles.length !== expectedPayloadCount) {
    throw new Error("SITEOPS_SOCIAL_PAYLOAD_STRUCTURE_INVALID");
  }
  const qa = {
    schemaVersion: 1,
    passed: true,
    channel: input.channel,
    brand: input.companyName,
    sourceMappingsComplete: true,
    automatedPublishing: false,
    credentialsIncluded: false,
    imageCount: previews.length,
    imageDimensions:
      input.channel === "wechat"
        ? { width: 1410, height: 600 }
        : { width: 1080, height: 1440 },
  };
  const qaJson = jsonBuffer(qa);
  addTextFile(payloadFiles, "qa-report.json", qaJson);
  const manifest: SocialPackageManifest = {
    schemaVersion: 1,
    channel: input.channel,
    brand: input.companyName,
    files: payloadFiles
      .map((file) => ({
        path: file.path,
        mimeType: mimeTypeForSocialPath(file.path),
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const manifestJson = jsonBuffer(manifest);
  const archiveFiles = [...payloadFiles];
  addTextFile(archiveFiles, "manifest.json", manifestJson);
  archiveFiles.sort((left, right) => left.path.localeCompare(right.path));
  const archive = await deterministicZip(archiveFiles, MAX_DIST_BYTES);
  return {
    archive,
    archiveSha256: sha256(archive),
    manifest,
    manifestJson,
    manifestSha256: sha256(manifestJson),
    qa,
    qaJson,
    previews,
  };
}
