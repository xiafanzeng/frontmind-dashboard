import { createHash, randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import {
  knowledgeBaseSnapshots,
  messages,
  siteProjects,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  type KnowledgeBaseSnapshot,
  type SiteOperation,
  type SiteProject,
} from "../../drizzle/schema";
import {
  canonicalJson,
  canonicalSha256,
  buildTwentyFirstSearchOnlyFunnel,
  createVisualEvidenceV1,
  normalizeTwentyFirstSearchResults,
  visualSearchOperationInputV1Schema,
  VISUAL_EVIDENCE_KIND,
  VISUAL_TAXONOMY_DERIVATION_VERSION,
  type NormalizedTwentyFirstCandidate,
  type SafeVisualDirective,
  type TwentyFirstQueryAxis,
  type TwentyFirstQueryRole,
  type TwentyFirstSearchEnvelope,
} from "../../shared/siteops-workflow";
import {
  siteBriefSchema,
  visualSelectionBundleV4Schema,
  type SiteBrief,
} from "../../shared/siteops";
import {
  FRONTMIND_VISUAL_FAMILIES_V3,
  FRONTMIND_VISUAL_FAMILY_LABELS_V3,
  assertVisualBlueprintDiversityV4,
  referenceBlueprintV4ForFamily,
  trustedVisualPreviewBlueprintV4,
  type ReferenceBlueprintV4,
} from "../../shared/siteops-design";
import { AuthServiceError } from "../auth-service";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import { getDb } from "../db";
import {
  TwentyFirstClient,
  TwentyFirstToolContractError,
  getTwentyFirstCredentialById,
  type TwentyFirstReadOnlySession,
} from "../twenty-first-service";
import { persistSiteOpsArtifact } from "./artifact-store";
import { registerSiteOpsProviderHandler } from "./providers";
import { fetchSafeVisualPreview } from "./remote-preview";
import { renderTrustedVisualCandidatePreviews } from "./react-static-runtime";
import type {
  SiteOpsProviderHandler,
  SiteOpsProviderResult,
} from "./providers";

const OPERATION_MARKER_PREFIX = "siteops-21st-operation:";
const SENSITIVE_SEARCH_CONTEXT =
  /(?:21st_sk_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

type ExistingBoard = {
  batchId: string;
  candidateCount: number;
  selectionBundleHash: string | null;
};

export type TwentyFirstProviderContext = {
  project: SiteProject;
  snapshot: KnowledgeBaseSnapshot;
  brief: SiteBrief;
  existingBoard: ExistingBoard | null;
};

type PreviewArtifact = {
  id: string;
  contentSha256: string;
};

type MirroredReference = {
  sampleId: string;
  candidate: NormalizedTwentyFirstCandidate;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  previewLocalAssetId: string;
  previewSha256: string;
  perceptualHash: string;
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
};

type FrontMindBoardCandidate = {
  sampleId: string;
  optionLabel: string;
  queryAxis: "foundation_split" | "foundation_editorial_modular";
  providerItemKey: string;
  title: string;
  description: string | null;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  author: string | null;
  sourceUrl: string | null;
  previewLocalAssetId: string;
  previewSha256: string;
  realizationPreviewLocalAssetId: string;
  realizationPreviewSha256: string;
  referencePerceptualHash: string;
  realizationPerceptualHash: string;
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
  referenceBlueprint: ReferenceBlueprintV4;
  score: number;
  rationale: string;
};

type PreviewRejectionReason =
  | "url"
  | "dns"
  | "connect"
  | "redirect"
  | "http"
  | "mime"
  | "size"
  | "decode"
  | "duplicate"
  | "persist"
  | "hash"
  | "aborted";

export type VisualSearchDiagnostics = {
  diagnosticsVersion: 1;
  searchedByAxis: Record<TwentyFirstQueryAxis, number>;
  normalizedUnique: number;
  shortlistCount: number;
  withPreviewReference: number;
  mirrorAttempted: number;
  mirrorSucceeded: number;
  rejectedByReason: Partial<Record<PreviewRejectionReason, number>>;
  diversity: SafeVisualDiversitySummary;
};

export type SafeVisualDiversitySummary = {
  summaryVersion: 1;
  requestedFamilies: 9;
  familyQueriesRun: number;
  eligibleReferences: number;
  mirroredReferences: number;
  assignedFamilies: number;
  distinctProviderItems: number;
  distinctReferenceHashes: number;
  distinctReferencePerceptualHashes: number;
  distinctRealizationHashes: number;
  distinctRealizationPerceptualHashes: number;
  distinctStyleSignatures: number;
  paletteVariants: number;
  backgroundVariants: number;
  typographyVariants: number;
  compositionVariants: number;
  minimumReferenceHammingDistance: number | null;
  minimumRealizationHammingDistance: number | null;
};

export type TwentyFirstBoardPersistenceInput = {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  selectionBundle: z.infer<typeof visualSelectionBundleV4Schema>;
  selectionBundleArtifact: PreviewArtifact;
  mirroredCandidates: FrontMindBoardCandidate[];
};

export type TwentyFirstProviderDependencies = {
  getDb?: () => Promise<any>;
  loadContext?: (
    db: any,
    operation: SiteOperation,
  ) => Promise<TwentyFirstProviderContext>;
  getCredential?: typeof getTwentyFirstCredentialById;
  client?: Pick<TwentyFirstClient, "withReadOnlySession">;
  fetchPreview?: typeof fetchSafeVisualPreview;
  renderCandidates?: typeof renderTrustedVisualCandidatePreviews;
  persistArtifact?: typeof persistSiteOpsArtifact;
  persistBoard?: (
    db: any,
    input: TwentyFirstBoardPersistenceInput,
  ) => Promise<ExistingBoard>;
};

class TwentyFirstProviderFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: "failed" | "attention_required" = "failed",
  ) {
    super(message);
    this.name = "TwentyFirstProviderFailure";
  }
}

type VisualSearchStage =
  | "validate_operation"
  | "load_context"
  | "load_credential"
  | "mcp_retrieval"
  | "mirror_previews"
  | "render_host_previews"
  | "persist_selection_bundle"
  | "persist_board";

function createVisualSearchDiagnostics(): VisualSearchDiagnostics {
  return {
    diagnosticsVersion: 1,
    searchedByAxis: {
      foundation_split: 0,
      foundation_editorial_modular: 0,
      section_proof_conversion: 0,
      motion_accessible: 0,
    },
    normalizedUnique: 0,
    shortlistCount: 0,
    withPreviewReference: 0,
    mirrorAttempted: 0,
    mirrorSucceeded: 0,
    rejectedByReason: {},
    diversity: {
      summaryVersion: 1,
      requestedFamilies: 9,
      familyQueriesRun: 0,
      eligibleReferences: 0,
      mirroredReferences: 0,
      assignedFamilies: 0,
      distinctProviderItems: 0,
      distinctReferenceHashes: 0,
      distinctReferencePerceptualHashes: 0,
      distinctRealizationHashes: 0,
      distinctRealizationPerceptualHashes: 0,
      distinctStyleSignatures: 0,
      paletteVariants: 0,
      backgroundVariants: 0,
      typographyVariants: 0,
      compositionVariants: 0,
      minimumReferenceHammingDistance: null,
      minimumRealizationHammingDistance: null,
    },
  };
}

function rejectDiagnostic(
  diagnostics: VisualSearchDiagnostics,
  reason: PreviewRejectionReason,
) {
  diagnostics.rejectedByReason[reason] =
    (diagnostics.rejectedByReason[reason] ?? 0) + 1;
}

function abortLike(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? String(error.code) : "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT"
  );
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function documentId(document: KnowledgeBaseSnapshot["documents"][number]) {
  return cleanText(document.id ?? document.path, "knowledge-document", 191);
}

/**
 * Uses only snapshot metadata and verified document titles when the stored
 * brief is not yet complete. It deliberately leaves facts/contacts empty.
 */
export function resolveSiteBrief(
  project: SiteProject,
  snapshot: KnowledgeBaseSnapshot,
): SiteBrief {
  const parsed = siteBriefSchema.safeParse(project.brief);
  if (parsed.success) return parsed.data;
  const visibleDocuments = snapshot.documents.filter(
    (document) =>
      document.customerVisible !== false && document.kind !== "evidence",
  );
  const lead =
    visibleDocuments.find((document) => document.kind === "overview") ??
    visibleDocuments[0];
  const sourceName = snapshot.sourceFileName.replace(/\.(?:zip|json)$/iu, "");
  const companyName = cleanText(lead?.title, sourceName || "企业官网", 255);
  const offeringTitles = Array.from(
    new Set(
      visibleDocuments
        .slice(0, 12)
        .map((document) => cleanText(document.title, "", 500))
        .filter(Boolean),
    ),
  );
  const routeSourceIds = visibleDocuments.slice(0, 30).map(documentId);
  return siteBriefSchema.parse({
    companyName,
    primaryLanguage: project.primaryLanguage || "zh-CN",
    contacts: [],
    offerings: offeringTitles,
    audience: [],
    conversionGoal: "了解企业信息并联系咨询",
    routes: [
      {
        id: "home",
        slug: "/",
        title: "首页",
        sourceDocumentIds: routeSourceIds,
      },
    ],
    verifiedFacts: [],
    publicAssetIds: [],
    unknowns: ["目标受众和具体转化目标仍需客户确认"],
  });
}

function operationMarker(operationId: string) {
  return `${OPERATION_MARKER_PREFIX}${operationId}`;
}

async function loadDefaultContext(
  db: any,
  operation: SiteOperation,
): Promise<TwentyFirstProviderContext> {
  if (operation.kind !== "visual_search" || operation.provider !== "21st") {
    throw new TwentyFirstProviderFailure(
      "INVALID_OPERATION",
      "该操作不是有效的 FrontMind 视觉检索任务。",
    );
  }
  const input = visualSearchOperationInputV1Schema.parse(operation.input);
  const projectRows = await db
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, operation.projectId),
        eq(siteProjects.userId, operation.userId),
      ),
    )
    .limit(1);
  const project = projectRows[0];
  if (!project) {
    throw new TwentyFirstProviderFailure(
      "PROJECT_NOT_FOUND",
      "AI 建站项目不存在。",
    );
  }
  if (project.currentKnowledgeSnapshotId !== input.knowledgeSnapshotId) {
    throw new TwentyFirstProviderFailure(
      "STALE_KNOWLEDGE_SNAPSHOT",
      "知识库版本已变化，请重新开始视觉检索。",
    );
  }
  const existingRows = await db
    .select()
    .from(websiteStyleSampleBatches)
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(
          websiteStyleSampleBatches.engineerNote,
          operationMarker(operation.id),
        ),
      ),
    )
    .limit(1);
  let existingBoard: ExistingBoard | null = null;
  if (existingRows[0]) {
    const sampleRows = await db
      .select({ id: websiteStyleSamples.id })
      .from(websiteStyleSamples)
      .where(eq(websiteStyleSamples.batchId, existingRows[0].id));
    existingBoard = {
      batchId: existingRows[0].id,
      candidateCount: sampleRows.length,
      selectionBundleHash: existingRows[0].selectionBundleHash,
    };
  }
  const snapshotRows = await db
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.knowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, operation.userId),
      ),
    )
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot || !/^[a-f0-9]{64}$/u.test(snapshot.archiveHash ?? "")) {
    throw new TwentyFirstProviderFailure(
      "KNOWLEDGE_SNAPSHOT_INVALID",
      "知识库 ZIP 快照缺少有效归档哈希。",
    );
  }
  return {
    project,
    snapshot,
    brief: resolveSiteBrief(project, snapshot),
    existingBoard,
  };
}

function taxonomyFromDirectives(
  role: TwentyFirstQueryRole,
  directives: readonly SafeVisualDirective[],
  preview?: {
    width: number;
    height: number;
    visualSignals?: {
      dominantHex: string;
      brightness: number;
      contrast: number;
    };
  },
) {
  const values = (prefixes: readonly string[]) =>
    directives
      .filter((directive) =>
        prefixes.some((prefix) => directive.startsWith(`${prefix}:`)),
      )
      .map((directive) => directive.slice(directive.indexOf(":") + 1));
  const layout = values(["structure", "surface", "imagery", "tone"]);
  if (
    preview &&
    preview.width / preview.height >= 1.4 &&
    !layout.includes("wide-crop")
  ) {
    layout.push("wide-crop");
  }
  const palette = values(["color"]);
  if (preview?.visualSignals) {
    palette.unshift(preview.visualSignals.dominantHex);
    if (
      preview.visualSignals.brightness <= 96 &&
      !palette.includes("dark-canvas")
    ) {
      palette.push("dark-canvas");
    } else if (
      preview.visualSignals.brightness >= 180 &&
      !palette.includes("light-canvas")
    ) {
      palette.push("light-canvas");
    }
    if (
      preview.visualSignals.contrast >= 60 &&
      !palette.includes("high-contrast")
    ) {
      palette.push("high-contrast");
    }
  }
  return {
    role,
    palette,
    typography: values(["typography"]),
    layout,
    motion: values(["motion"]),
    accessibility: values(["responsive"]).concat(
      directives.includes("motion:reduced-motion-required")
        ? ["reduced-motion-required"]
        : [],
    ),
  };
}

type FrontMindVisualFamily = (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number];

type FamilySearchRound = "primary" | "supplemental";

type FamilySearchQuery = {
  family: FrontMindVisualFamily;
  round: FamilySearchRound;
  role: "foundation";
  axis: "foundation_split" | "foundation_editorial_modular";
  limit: 4;
  query: string;
};

type FamilyReferencePools = Map<
  FrontMindVisualFamily,
  NormalizedTwentyFirstCandidate[]
>;

const FAMILY_SEARCH_TERMS: Record<
  FrontMindVisualFamily,
  readonly [string, string]
> = {
  floating_orbit: [
    "floating orbital geometric hero section organic circles",
    "playful abstract orbit landing page hero particles",
  ],
  split_media: [
    "split layout hero section product media two column",
    "split screen landing page hero image product visual",
  ],
  editorial: [
    "editorial hero section magazine typography asymmetric",
    "editorial landing page hero serif oversized headline",
  ],
  bento: [
    "bento hero section modular card grid landing page",
    "bento landing page hero dashboard modular cards",
  ],
  feature_grid: [
    "feature grid hero section product capabilities landing page",
    "feature cards grid landing page hero technical",
  ],
  centered_dual_cta: [
    "centered hero section dual CTA minimal landing page",
    "centered statement landing page hero two buttons",
  ],
  immersive_visual: [
    "immersive hero section cinematic visual 3d landing page",
    "spatial full screen landing page hero interactive visual",
  ],
  product_stage: [
    "product showcase hero section UI mockup stage landing page",
    "SaaS landing page hero product screenshot interface",
  ],
  full_bleed_statement: [
    "full bleed hero section bold statement oversized typography",
    "full screen landing page hero big headline minimal",
  ],
};

type FamilyEligibilityRule = {
  /** Query provenance is never a positive signal. These expressions run only
   * against provider-owned, sanitized title/description/page coordinates. */
  positiveMetadata: readonly RegExp[];
  negativeMetadata: readonly RegExp[];
  positiveDirectives: readonly SafeVisualDirective[];
  negativeDirectives: readonly SafeVisualDirective[];
};

/**
 * A real 21st Hero may only represent one FrontMind family when its own safe
 * catalog metadata describes that composition. The search query that happened
 * to return an item is deliberately absent from this contract: a generic
 * "Hero section" returned for a Bento query is still generic, not Bento.
 *
 * Directives are supporting/contradicting evidence derived from the same safe
 * metadata. Explicit family metadata is always required so broad directives
 * such as `structure:modular-grid` cannot collapse Bento and Feature Grid into
 * the same visual reference pool.
 */
const FAMILY_ELIGIBILITY_RULES: Record<
  FrontMindVisualFamily,
  FamilyEligibilityRule
> = {
  floating_orbit: {
    positiveMetadata: [
      /\b(?:floating|orbital?|orbiting|particle|radial)\b/iu,
      /\borganic[- ](?:circle|shape|blob)s?\b/iu,
    ],
    negativeMetadata: [
      /\b(?:split[- ](?:screen|layout)|two[- ]column|editorial|magazine|bento|masonry|feature[- ]grid|product[- ](?:stage|showcase)|full[- ]bleed)\b/iu,
    ],
    positiveDirectives: [
      "imagery:illustration-led",
      "motion:hover-depth",
      "motion:scroll-triggered",
    ],
    negativeDirectives: [
      "structure:split-layout",
      "structure:editorial-rhythm",
      "structure:modular-grid",
      "imagery:product-ui-led",
    ],
  },
  split_media: {
    positiveMetadata: [
      /\b(?:split[- ](?:screen|layout|media|image|hero)|two[- ]column|side[- ]by[- ]side)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:bento|masonry|editorial|magazine|feature[- ]grid|full[- ]bleed|centered[- ]statement)\b/iu,
    ],
    positiveDirectives: ["structure:split-layout", "imagery:masked-media"],
    negativeDirectives: [
      "structure:modular-grid",
      "structure:editorial-rhythm",
    ],
  },
  editorial: {
    positiveMetadata: [
      /\b(?:editorial|magazine|newspaper|publication|serif[- ]led)\b/iu,
      /\b(?:asymmetric|typographic)\s+(?:editorial|headline|layout)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:bento|masonry|feature[- ]grid|product[- ](?:stage|showcase)|ui[- ]mockup|full[- ]bleed)\b/iu,
    ],
    positiveDirectives: [
      "structure:editorial-rhythm",
      "typography:serif-editorial",
      "structure:asymmetric-grid",
    ],
    negativeDirectives: ["structure:split-layout", "imagery:product-ui-led"],
  },
  bento: {
    positiveMetadata: [
      /\b(?:bento|masonry|modular[- ]card[- ]grid|modular\s+(?:cards?|tiles?))\b/iu,
    ],
    negativeMetadata: [
      /\b(?:editorial|magazine|feature[- ]grid|capabilit(?:y|ies)[- ]grid|split[- ]layout|product[- ](?:stage|showcase))\b/iu,
    ],
    positiveDirectives: [
      "structure:modular-grid",
      "surface:rounded-containers",
    ],
    negativeDirectives: [
      "structure:split-layout",
      "structure:editorial-rhythm",
      "imagery:product-ui-led",
    ],
  },
  feature_grid: {
    positiveMetadata: [
      /\b(?:feature|capabilit(?:y|ies))[- ](?:card[- ])?grid\b/iu,
      /\b(?:feature|capabilit(?:y|ies))\s+cards?\b/iu,
    ],
    negativeMetadata: [
      /\b(?:bento|masonry|pricing|dashboard|sidebar|editorial|magazine|product[- ](?:stage|showcase))\b/iu,
    ],
    positiveDirectives: ["structure:modular-grid", "surface:border-defined"],
    negativeDirectives: [
      "structure:split-layout",
      "structure:editorial-rhythm",
      "imagery:product-ui-led",
    ],
  },
  centered_dual_cta: {
    positiveMetadata: [
      /\b(?:dual|two)[- ](?:cta|call[- ]to[- ]action|buttons?)s?\b/iu,
      /\bcentered\b[^.]{0,80}\b(?:cta|call[- ]to[- ]action|buttons?)s?\b/iu,
    ],
    negativeMetadata: [
      /\b(?:split[- ]layout|bento|masonry|feature[- ]grid|immersive|cinematic|product[- ](?:stage|showcase)|full[- ]bleed)\b/iu,
    ],
    positiveDirectives: [
      "structure:hero-led-hierarchy",
      "typography:display-led-hierarchy",
    ],
    negativeDirectives: [
      "structure:split-layout",
      "structure:modular-grid",
      "imagery:product-ui-led",
    ],
  },
  immersive_visual: {
    positiveMetadata: [
      /\b(?:immersive|cinematic|spatial|three[- ]dimensional|3d|parallax)\b/iu,
      /\bfull[- ]screen\b[^.]{0,80}\b(?:visual|scene|image|video|experience)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:full[- ]bleed[- ]statement|oversized[- ]headline|minimal[- ]statement|product[- ](?:stage|showcase)|ui[- ]mockup|bento|feature[- ]grid)\b/iu,
    ],
    positiveDirectives: [
      "imagery:wide-crop",
      "motion:scroll-triggered",
      "motion:controlled-reveal",
    ],
    negativeDirectives: ["structure:modular-grid", "imagery:product-ui-led"],
  },
  product_stage: {
    positiveMetadata: [
      /\b(?:product[- ]stage|product[- ]showcase|ui[- ]mockup|product[- ]screenshot|interface[- ]preview|app(?:lication)?[- ]preview|device[- ]mockup|software[- ]demo)\b/iu,
      /\b(?:hero\s+with\s+mockup|mockup[- ]display|dashboard[- ]preview(?:[- ]mockup)?)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:pricing|sidebar|admin|settings?|bento|masonry|editorial|magazine|full[- ]bleed|immersive)\b/iu,
    ],
    positiveDirectives: ["imagery:product-ui-led", "surface:soft-shadow-depth"],
    negativeDirectives: [
      "structure:editorial-rhythm",
      "typography:serif-editorial",
    ],
  },
  full_bleed_statement: {
    positiveMetadata: [
      /\bfull[- ]bleed\b[^.]{0,80}\b(?:statement|headline|typography|type)\b/iu,
      /\bfull[- ]screen\b[^.]{0,80}\b(?:statement|big[- ]headline|oversized[- ]headline|typography)\b/iu,
      /\b(?:oversized|big)[- ]headline\b[^.]{0,80}\b(?:statement|minimal|full[- ]screen)\b/iu,
      /\b(?:bold|large|minimal(?:ist)?)\b[^.]{0,80}\b(?:headline|typography|text)\b/iu,
      /\b(?:headline|typography|text)\b[^.]{0,80}\b(?:bold|large|minimal(?:ist)?|dramatic)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:immersive|cinematic|spatial|3d|parallax|product[- ](?:stage|showcase)|ui[- ]mockup|bento|feature[- ]grid|split[- ]layout|collage|overlapping[- ]images?)\b/iu,
    ],
    positiveDirectives: [
      "typography:display-led-hierarchy",
      "tone:bold-graphic",
    ],
    negativeDirectives: [
      "structure:modular-grid",
      "structure:split-layout",
      "imagery:product-ui-led",
    ],
  },
};

function familyEligibleReference(
  family: FrontMindVisualFamily,
  candidate: NormalizedTwentyFirstCandidate,
) {
  if (!candidate.heroEligibility.eligible) return false;
  const metadata = [candidate.title, candidate.description, candidate.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC");
  const rule = FAMILY_ELIGIBILITY_RULES[family];
  if (!rule.positiveMetadata.some((pattern) => pattern.test(metadata))) {
    return false;
  }
  if (rule.negativeMetadata.some((pattern) => pattern.test(metadata))) {
    return false;
  }
  const directives = new Set(candidate.normalizedDirectives);
  if (rule.negativeDirectives.some((directive) => directives.has(directive))) {
    return false;
  }
  // Positive directives strengthen an explicit metadata match. Some families
  // (for example floating orbit and centered dual CTA) have no dedicated
  // directive in the narrow allowlist, so an explicit family phrase remains
  // sufficient when no contradictory directive is present.
  return (
    rule.positiveDirectives.some((directive) => directives.has(directive)) ||
    candidate.heroEligibility.confidence === "explicit"
  );
}

function familyQueryAxis(
  family: FrontMindVisualFamily,
): FamilySearchQuery["axis"] {
  return family === "split_media" || family === "product_stage"
    ? "foundation_split"
    : "foundation_editorial_modular";
}

function safeFamilySearchContext(brief: SiteBrief) {
  const genericFragment =
    /^(?:企业与品牌概览|品牌概览|公司介绍|关于我们|产品与服务|首页|知识库|home|about(?: us)?|products?(?: and services)?|company overview)$/iu;
  return Array.from(
    new Set(
      [brief.companyName, ...brief.offerings.slice(0, 2)]
        .map((value) =>
          value
            .normalize("NFKC")
            .replace(/[\u0000-\u001f\u007f]/gu, " ")
            .replace(/[^\p{L}\p{N}\s+&._/-]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 64),
        )
        .filter(
          (value) =>
            value &&
            !genericFragment.test(value) &&
            !SENSITIVE_SEARCH_CONTEXT.test(value),
        ),
    ),
  )
    .slice(0, 3)
    .join(" ")
    .slice(0, 160);
}

function composeFamilySearchQuery(input: {
  family: FrontMindVisualFamily;
  round: FamilySearchRound;
  brief: SiteBrief;
}): FamilySearchQuery {
  const terms = FAMILY_SEARCH_TERMS[input.family];
  const context = safeFamilySearchContext(input.brief);
  return {
    family: input.family,
    round: input.round,
    role: "foundation",
    axis: familyQueryAxis(input.family),
    limit: 4,
    query: `${terms[input.round === "primary" ? 0 : 1]}${context ? ` for ${context}` : ""}`,
  };
}

function emptyFamilyReferencePools(): FamilyReferencePools {
  return new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.map((family) => [family, []] as const),
  );
}

async function searchFamilyRound(input: {
  session: TwentyFirstReadOnlySession;
  brief: SiteBrief;
  families: readonly FrontMindVisualFamily[];
  round: FamilySearchRound;
  pools: FamilyReferencePools;
  queries: FamilySearchQuery[];
  searchedCandidates: Map<
    string,
    ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
  >;
  signal: AbortSignal;
  diagnostics: VisualSearchDiagnostics;
}) {
  for (const family of input.families) {
    if (input.signal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉检索已超时，请重置后重新开始。",
      );
    }
    const query = composeFamilySearchQuery({
      family,
      round: input.round,
      brief: input.brief,
    });
    const envelope: TwentyFirstSearchEnvelope = {
      role: query.role,
      axis: query.axis,
      limit: query.limit,
      payload: await input.session.search({
        query: query.query,
        type: "component",
        limit: query.limit,
        tag: "hero",
        sort: "recommended",
      }),
    };
    input.queries.push(query);
    input.diagnostics.diversity.familyQueriesRun += 1;
    const normalized = normalizeTwentyFirstSearchResults([envelope]);
    input.diagnostics.searchedByAxis[query.axis] += normalized.length;
    for (const candidate of normalized) {
      input.searchedCandidates.set(candidate.providerItemKey, candidate);
    }
    const funnel = buildTwentyFirstSearchOnlyFunnel({
      searchEnvelopes: [envelope],
    });
    const pool = input.pools.get(family)!;
    const existingKeys = new Set(pool.map((item) => item.providerItemKey));
    for (const candidate of funnel.retrievalShortlist) {
      if (
        familyEligibleReference(family, candidate) &&
        !existingKeys.has(candidate.providerItemKey)
      ) {
        pool.push(candidate);
        existingKeys.add(candidate.providerItemKey);
      }
    }
  }
}

function maximumKeyAssignment(pools: FamilyReferencePools) {
  const assignment = new Map<FrontMindVisualFamily, string>();
  const ownerByProviderKey = new Map<string, FrontMindVisualFamily>();
  const visit = (
    family: FrontMindVisualFamily,
    visited: Set<string>,
  ): boolean => {
    for (const candidate of pools.get(family) ?? []) {
      const key = candidate.providerItemKey;
      if (visited.has(key)) continue;
      visited.add(key);
      const owner = ownerByProviderKey.get(key);
      if (!owner || visit(owner, visited)) {
        ownerByProviderKey.set(key, family);
        assignment.set(family, key);
        return true;
      }
    }
    return false;
  };
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    visit(family, new Set());
  }
  return assignment;
}

function refreshRetrievalDiagnostics(input: {
  pools: FamilyReferencePools;
  searchedCandidates: Map<
    string,
    ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
  >;
  mirrored: readonly MirroredReference[];
  assigned: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  diagnostics: VisualSearchDiagnostics;
}) {
  const eligibleKeys = new Set(
    [...input.pools.values()].flatMap((pool) =>
      pool.map((candidate) => candidate.providerItemKey),
    ),
  );
  input.diagnostics.normalizedUnique = input.searchedCandidates.size;
  input.diagnostics.withPreviewReference = [
    ...input.searchedCandidates.values(),
  ].filter((candidate) => candidate.previewUrl).length;
  input.diagnostics.shortlistCount = eligibleKeys.size;
  input.diagnostics.diversity.eligibleReferences = eligibleKeys.size;
  input.diagnostics.diversity.mirroredReferences = input.mirrored.length;
  input.diagnostics.diversity.assignedFamilies = input.assigned.size;
  input.diagnostics.diversity.distinctProviderItems = new Set(
    [...input.assigned.values()].map(
      (reference) => reference.candidate.providerItemKey,
    ),
  ).size;
  input.diagnostics.diversity.distinctReferenceHashes = new Set(
    [...input.assigned.values()].map((reference) => reference.previewSha256),
  ).size;
  const perceptualHashes = [...input.assigned.values()].map(
    (reference) => reference.perceptualHash,
  );
  input.diagnostics.diversity.distinctReferencePerceptualHashes = new Set(
    perceptualHashes,
  ).size;
  input.diagnostics.diversity.minimumReferenceHammingDistance =
    minimumPerceptualDistance(perceptualHashes);
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/avif":
      return "avif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      throw new TwentyFirstProviderFailure(
        "PREVIEW_MIME_INVALID",
        "视觉参考图片格式不受支持。",
      );
  }
}

function previewRejectionReason(error: unknown): PreviewRejectionReason {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const message = error instanceof Error ? error.message : "";
  const value = `${code}:${message}`;
  if (abortLike(error)) return "aborted";
  if (/HASH/u.test(value)) return "hash";
  if (/MIME/u.test(value)) return "mime";
  if (/(?:SIZE|LARGE|PIXEL)/u.test(value)) return "size";
  if (/(?:IMAGE|DECODE|SHARP)/iu.test(value)) return "decode";
  if (/REDIRECT/u.test(value)) return "redirect";
  if (/(?:ENOTFOUND|EAI_AGAIN|DNS)/u.test(value)) return "dns";
  if (/(?:ECONN|ENET|EHOST|TLS|SOCKET|CONNECTED_ADDRESS)/u.test(value)) {
    return "connect";
  }
  if (/(?:HTTP|FETCH|BODY)/u.test(value)) return "http";
  if (/(?:URL|PRIVATE_ADDRESS|UNSAFE)/u.test(value)) return "url";
  return "http";
}

async function mirrorCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  candidates: NormalizedTwentyFirstCandidate[];
  signal: AbortSignal;
  fetchPreview: typeof fetchSafeVisualPreview;
  persistArtifact: typeof persistSiteOpsArtifact;
  diagnostics: VisualSearchDiagnostics;
  seenPreviewHashes?: Set<string>;
}) {
  const mirrored: MirroredReference[] = [];
  const seenPreviewHashes = input.seenPreviewHashes ?? new Set<string>();
  const budget = AbortSignal.timeout(45_000);
  const mirrorSignal = AbortSignal.any([input.signal, budget]);
  for (let offset = 0; offset < input.candidates.length; offset += 3) {
    if (mirrorSignal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉预览镜像已超时，请重置后重新开始。",
      );
    }
    const batch = input.candidates.slice(offset, offset + 3);
    const downloaded = await Promise.all(
      batch.map(async (candidate) => {
        input.diagnostics.mirrorAttempted += 1;
        try {
          const preview = await input.fetchPreview({
            url: candidate.previewUrl!,
            signal: mirrorSignal,
          });
          const perceptualHash = await perceptualHash64(preview.buffer);
          return { candidate, preview, perceptualHash } as const;
        } catch (error) {
          if (mirrorSignal.aborted) {
            throw new TwentyFirstProviderFailure(
              "VISUAL_SEARCH_TIMEOUT",
              "视觉预览镜像已超时，请重置后重新开始。",
            );
          }
          rejectDiagnostic(input.diagnostics, previewRejectionReason(error));
          return null;
        }
      }),
    );
    for (const downloadedItem of downloaded) {
      if (!downloadedItem) continue;
      const { candidate, preview, perceptualHash } = downloadedItem;
      if (seenPreviewHashes.has(preview.sha256)) {
        rejectDiagnostic(input.diagnostics, "duplicate");
        continue;
      }
      seenPreviewHashes.add(preview.sha256);
      let asset: Awaited<ReturnType<typeof input.persistArtifact>>;
      try {
        asset = await input.persistArtifact({
          userId: input.operation.userId,
          projectId: input.context.project.id,
          kind: "21st-visual-preview",
          filename: `21st-${candidate.candidateId.slice(0, 120)}.${extensionForMimeType(preview.mimeType)}`,
          mimeType: preview.mimeType,
          buffer: preview.buffer,
          maxBytes: 5 * 1024 * 1024,
        });
      } catch {
        rejectDiagnostic(input.diagnostics, "persist");
        continue;
      }
      if (asset.contentSha256 !== preview.sha256) {
        rejectDiagnostic(input.diagnostics, "hash");
        continue;
      }
      mirrored.push({
        sampleId: randomUUID(),
        candidate,
        taxonomy: taxonomyFromDirectives(
          candidate.queryRole,
          candidate.normalizedDirectives,
          {
            width: preview.width,
            height: preview.height,
            visualSignals: preview.visualSignals,
          },
        ),
        previewLocalAssetId: asset.id,
        previewSha256: preview.sha256,
        perceptualHash,
        visualEvidence: createVisualEvidenceV1({
          evidenceKind: VISUAL_EVIDENCE_KIND,
          providerItemKey: candidate.providerItemKey,
          metadataSha256: candidate.metadataSha256,
          providerResponseSha256: candidate.providerResponseSha256,
          previewSha256: preview.sha256,
          taxonomyDerivationVersion: VISUAL_TAXONOMY_DERIVATION_VERSION,
        }),
      });
      input.diagnostics.mirrorSucceeded += 1;
    }
  }
  return mirrored;
}

function sha256Buffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function perceptualHash64(buffer: Buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .grayscale()
    .resize(9, 8, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels !== 1) {
    throw new Error("PREVIEW_IMAGE_DECODE_FAILED");
  }
  let hash = 0n;
  let bit = 63n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = data[row * 9 + column]!;
      const right = data[row * 9 + column + 1]!;
      if (left > right) hash |= 1n << bit;
      bit -= 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

function perceptualHashDistance(left: string, right: string) {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits > 0n) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}

function minimumPerceptualDistance(hashes: readonly string[]) {
  if (hashes.length < 2) return null;
  let minimum = 64;
  for (let left = 0; left < hashes.length; left += 1) {
    for (let right = left + 1; right < hashes.length; right += 1) {
      minimum = Math.min(
        minimum,
        perceptualHashDistance(hashes[left]!, hashes[right]!),
      );
    }
  }
  return minimum;
}

function assignDistinctMirroredReferences(input: {
  pools: FamilyReferencePools;
  mirrored: readonly MirroredReference[];
}) {
  const mirroredByKey = new Map(
    input.mirrored.map(
      (item) => [item.candidate.providerItemKey, item] as const,
    ),
  );
  const choices = new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.map(
      (family) =>
        [
          family,
          (input.pools.get(family) ?? []).flatMap((candidate) => {
            const mirrored = mirroredByKey.get(candidate.providerItemKey);
            return mirrored ? [mirrored] : [];
          }),
        ] as const,
    ),
  );
  const familyOrder = [...FRONTMIND_VISUAL_FAMILIES_V3].sort(
    (left, right) =>
      choices.get(left)!.length - choices.get(right)!.length ||
      FRONTMIND_VISUAL_FAMILIES_V3.indexOf(left) -
        FRONTMIND_VISUAL_FAMILIES_V3.indexOf(right),
  );
  let best = new Map<FrontMindVisualFamily, MirroredReference>();
  let explored = 0;
  const visit = (
    index: number,
    assigned: Map<FrontMindVisualFamily, MirroredReference>,
    providerKeys: Set<string>,
    hashes: string[],
  ): boolean => {
    explored += 1;
    if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) {
      try {
        assertVisualBlueprintDiversityV4(
          FRONTMIND_VISUAL_FAMILIES_V3.map((family) =>
            trustedVisualPreviewBlueprintV4(
              family,
              assigned.get(family)!.taxonomy,
            ),
          ),
        );
        best = new Map(assigned);
        return true;
      } catch {
        return false;
      }
    }
    if (assigned.size > best.size) best = new Map(assigned);
    if (index >= familyOrder.length || explored > 25_000) return false;
    if (assigned.size + familyOrder.length - index <= best.size) return false;
    const family = familyOrder[index]!;
    for (const reference of choices.get(family) ?? []) {
      const key = reference.candidate.providerItemKey;
      if (
        providerKeys.has(key) ||
        hashes.some(
          (hash) => perceptualHashDistance(hash, reference.perceptualHash) < 6,
        )
      ) {
        continue;
      }
      assigned.set(family, reference);
      providerKeys.add(key);
      hashes.push(reference.perceptualHash);
      if (visit(index + 1, assigned, providerKeys, hashes)) return true;
      hashes.pop();
      providerKeys.delete(key);
      assigned.delete(family);
    }
    return visit(index + 1, assigned, providerKeys, hashes);
  };
  visit(0, new Map(), new Set(), []);
  return new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.flatMap((family) => {
      const reference = best.get(family);
      return reference ? [[family, reference] as const] : [];
    }),
  );
}

function legacyHeroVariantForFamily(
  family: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
) {
  if (family === "split_media") return "split_media" as const;
  if (
    family === "editorial" ||
    family === "bento" ||
    family === "feature_grid"
  ) {
    return "editorial_modular" as const;
  }
  if (family === "immersive_visual" || family === "full_bleed_statement") {
    return "immersive_visual" as const;
  }
  return "centered_statement" as const;
}

async function createFrontMindBoardCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  inspirationByFamily: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  signal: AbortSignal;
  renderCandidates: typeof renderTrustedVisualCandidatePreviews;
  persistArtifact: typeof persistSiteOpsArtifact;
  diagnostics: VisualSearchDiagnostics;
}) {
  if (
    input.inspirationByFamily.size !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    FRONTMIND_VISUAL_FAMILIES_V3.some(
      (family) => !input.inspirationByFamily.has(family),
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
      "FrontMind 未能为 9 个视觉方向逐一绑定真实 Hero 参考。",
      "attention_required",
    );
  }
  const previewBlueprints = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily) => {
    const reference = input.inspirationByFamily.get(heroFamily)!;
    return trustedVisualPreviewBlueprintV4(heroFamily, reference.taxonomy);
  });
  const semanticDiversity = assertVisualBlueprintDiversityV4(previewBlueprints);
  input.diagnostics.diversity.distinctStyleSignatures =
    semanticDiversity.uniqueStyleSignatures;
  input.diagnostics.diversity.paletteVariants =
    semanticDiversity.uniquePalettes;
  input.diagnostics.diversity.backgroundVariants =
    semanticDiversity.uniqueBackgrounds;
  input.diagnostics.diversity.typographyVariants =
    semanticDiversity.uniqueTypeSystems;
  input.diagnostics.diversity.compositionVariants =
    semanticDiversity.uniqueCompositions;
  const previewBlueprintByFamily = new Map(
    previewBlueprints.map(
      (blueprint) => [blueprint.heroFamily, blueprint] as const,
    ),
  );
  const rendered = await input.renderCandidates({
    brief: input.context.brief,
    blueprints: previewBlueprints,
    signal: input.signal,
  });
  const renderedByFamily = new Map(
    rendered.map((item) => [item.heroFamily, item.buffer] as const),
  );
  if (
    rendered.length !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    renderedByFamily.size !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    FRONTMIND_VISUAL_FAMILIES_V3.some((family) => !renderedByFamily.has(family))
  ) {
    throw new TwentyFirstProviderFailure(
      "FRONTMIND_VISUAL_RENDER_INCOMPLETE",
      "9 个视觉候选未能完整生成，请稍后重试。",
      "attention_required",
    );
  }
  const candidates: FrontMindBoardCandidate[] = [];
  const seenRealizationHashes = new Set<string>();
  const realizationPerceptualHashes: string[] = [];
  for (let index = 0; index < FRONTMIND_VISUAL_FAMILIES_V3.length; index += 1) {
    const heroFamily = FRONTMIND_VISUAL_FAMILIES_V3[index]!;
    const inspiration = input.inspirationByFamily.get(heroFamily)!;
    const buffer = renderedByFamily.get(heroFamily)!;
    const previewBlueprint = previewBlueprintByFamily.get(heroFamily)!;
    const realizationPreviewSha256 = sha256Buffer(buffer);
    const realizationPerceptualHash = await perceptualHash64(buffer);
    if (seenRealizationHashes.has(realizationPreviewSha256)) {
      throw new TwentyFirstProviderFailure(
        "FRONTMIND_VISUAL_RENDER_DUPLICATE",
        "视觉候选未形成九种不同构图，请稍后重试。",
        "attention_required",
      );
    }
    if (
      realizationPerceptualHashes.some(
        (hash) => perceptualHashDistance(hash, realizationPerceptualHash) < 4,
      )
    ) {
      throw new TwentyFirstProviderFailure(
        "FRONTMIND_VISUAL_RENDER_PERCEPTUALLY_DUPLICATE",
        "视觉候选在感知上过于相似，请稍后重试。",
        "attention_required",
      );
    }
    seenRealizationHashes.add(realizationPreviewSha256);
    realizationPerceptualHashes.push(realizationPerceptualHash);
    const sampleId = randomUUID();
    const asset = await input.persistArtifact({
      userId: input.operation.userId,
      projectId: input.context.project.id,
      kind: "frontmind-visual-preview",
      filename: `frontmind-${heroFamily}.png`,
      mimeType: "image/png",
      buffer,
      maxBytes: 5 * 1024 * 1024,
    });
    if (asset.contentSha256 !== realizationPreviewSha256) {
      throw new TwentyFirstProviderFailure(
        "FRONTMIND_VISUAL_RENDER_HASH_MISMATCH",
        "视觉候选写入校验失败。",
        "attention_required",
      );
    }
    const referenceBlueprint = referenceBlueprintV4ForFamily({
      candidateId: sampleId,
      providerItemKey: inspiration.candidate.providerItemKey,
      referencePreviewLocalAssetId: inspiration.previewLocalAssetId,
      referencePreviewSha256: inspiration.previewSha256,
      realizationPreviewLocalAssetId: asset.id,
      realizationPreviewSha256,
      heroFamily,
      inspirationEvidenceId: inspiration.visualEvidence.evidenceSha256,
      inspirationTaxonomy: inspiration.taxonomy,
      previewBlueprint,
    });
    candidates.push({
      sampleId,
      optionLabel: String.fromCharCode(65 + index),
      queryAxis: familyQueryAxis(heroFamily),
      providerItemKey: inspiration.candidate.providerItemKey,
      title: FRONTMIND_VISUAL_FAMILY_LABELS_V3[heroFamily],
      description:
        inspiration.candidate.description ?? inspiration.candidate.title,
      taxonomy: inspiration.taxonomy,
      author: inspiration.candidate.author,
      sourceUrl: inspiration.candidate.sourceUrl,
      previewLocalAssetId: inspiration.previewLocalAssetId,
      previewSha256: inspiration.previewSha256,
      realizationPreviewLocalAssetId: asset.id,
      realizationPreviewSha256,
      referencePerceptualHash: inspiration.perceptualHash,
      realizationPerceptualHash,
      visualEvidence: inspiration.visualEvidence,
      referenceBlueprint,
      score: inspiration.candidate.score,
      rationale: `独立绑定 21st 真实 Hero 参考，并由 FrontMind 可信组件实现为${FRONTMIND_VISUAL_FAMILY_LABELS_V3[heroFamily]}。`,
    });
  }
  input.diagnostics.diversity.distinctRealizationHashes =
    seenRealizationHashes.size;
  input.diagnostics.diversity.distinctRealizationPerceptualHashes = new Set(
    realizationPerceptualHashes,
  ).size;
  input.diagnostics.diversity.minimumRealizationHammingDistance =
    minimumPerceptualDistance(realizationPerceptualHashes);
  return candidates;
}

async function persistDefaultBoard(
  db: any,
  input: TwentyFirstBoardPersistenceInput,
) {
  return db.transaction(async (tx: any): Promise<ExistingBoard> => {
    const lockedRows = await tx
      .select()
      .from(siteProjects)
      .where(
        and(
          eq(siteProjects.id, input.context.project.id),
          eq(siteProjects.userId, input.operation.userId),
        ),
      )
      .limit(1)
      .for("update");
    const project = lockedRows[0];
    if (
      !project ||
      project.currentKnowledgeSnapshotId !== input.context.snapshot.id
    ) {
      throw new TwentyFirstProviderFailure(
        "STALE_KNOWLEDGE_SNAPSHOT",
        "知识库版本已变化，请重新开始视觉检索。",
      );
    }
    const marker = operationMarker(input.operation.id);
    const existingRows = await tx
      .select()
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, project.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.engineerNote, marker),
        ),
      )
      .limit(1)
      .for("update");
    if (existingRows[0]) {
      const sampleRows = await tx
        .select({ id: websiteStyleSamples.id })
        .from(websiteStyleSamples)
        .where(eq(websiteStyleSamples.batchId, existingRows[0].id));
      return {
        batchId: existingRows[0].id,
        candidateCount: sampleRows.length,
        selectionBundleHash: existingRows[0].selectionBundleHash,
      };
    }
    const ordinalRows = await tx
      .select({ ordinal: max(websiteStyleSampleBatches.ordinal) })
      .from(websiteStyleSampleBatches)
      .where(eq(websiteStyleSampleBatches.userId, input.operation.userId));
    await tx
      .update(websiteStyleSampleBatches)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, project.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.status, "published"),
        ),
      );
    const batchId = randomUUID();
    const now = new Date();
    await tx.insert(websiteStyleSampleBatches).values({
      id: batchId,
      userId: input.operation.userId,
      ticketId: null,
      sourceKind: "siteops_21st",
      siteProjectId: project.id,
      selectionBundleLocalAssetId: input.selectionBundleArtifact.id,
      selectionBundleHash: input.selectionBundleArtifact.contentSha256,
      ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
      status: "published",
      engineerNote: marker,
      publishedByUserId: null,
      publishedAt: now,
    });
    await tx.insert(websiteStyleSamples).values(
      input.mirroredCandidates.map((item, index) => ({
        id: item.sampleId,
        batchId,
        attachmentId: null,
        previewLocalAssetId: item.previewLocalAssetId,
        sourceMetadata: {
          providerItemKey: item.providerItemKey,
          queryAxis: item.queryAxis,
          title: item.title,
          description: item.description,
          author: item.author,
          sourceUrl: item.sourceUrl,
          catalogRole: "hero",
          heroFamily: item.referenceBlueprint.heroFamily,
          heroEligibility: {
            eligible: true,
            confidence: "explicit",
            variant: legacyHeroVariantForFamily(
              item.referenceBlueprint.heroFamily,
            ),
            reasons: ["frontmind-trusted-react-family"],
          },
          visualEvidence: item.visualEvidence,
          referenceBlueprint: item.referenceBlueprint,
          realizationPreviewLocalAssetId: item.realizationPreviewLocalAssetId,
          realizationPreviewSha256: item.realizationPreviewSha256,
          referencePerceptualHash: item.referencePerceptualHash,
          realizationPerceptualHash: item.realizationPerceptualHash,
          taxonomy: {
            ...item.taxonomy,
          },
          score: item.score,
          rationale: item.rationale,
        },
        label: item.optionLabel,
        note: item.title,
        sortOrder: index + 1,
      })),
    );
    const sequenceRows = await tx
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, project.conversationId));
    await tx.insert(messages).values({
      id: randomUUID(),
      conversationId: project.conversationId,
      turnId: input.operation.conversationTurnId,
      userId: input.operation.userId,
      role: "assistant",
      content: "已准备 9 个不同风格的视觉候选，请选择一个方向。",
      sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
      metadata: {
        siteOps: {
          kind: "visual_board",
          subjectId: batchId,
          revision: project.revision + 1,
          status: "active",
          payload: {
            batchId,
            candidateCount: input.mirroredCandidates.length,
            targets: [18, 9],
            degradedReasons: input.selectionBundle.degradedReasons,
          },
        },
      },
    });
    await tx
      .update(siteProjects)
      .set({
        brief: input.context.brief,
        status: "awaiting_visual_selection",
        revision: project.revision + 1,
        updatedAt: now,
      })
      .where(eq(siteProjects.id, project.id));
    return {
      batchId,
      candidateCount: input.mirroredCandidates.length,
      selectionBundleHash: input.selectionBundleArtifact.contentSha256,
    };
  });
}

function safeProviderFailure(
  error: unknown,
  stage: VisualSearchStage,
  diagnostics: VisualSearchDiagnostics,
  signal: AbortSignal,
): SiteOpsProviderResult {
  if (signal.aborted || abortLike(error)) {
    return {
      status: "failed",
      code: "VISUAL_SEARCH_TIMEOUT",
      message: "视觉检索已超时，请重置后重新开始。",
      result: diagnostics,
    };
  }
  if (error instanceof TwentyFirstProviderFailure) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      result: diagnostics,
    };
  }
  if (error instanceof z.ZodError) {
    if (stage !== "validate_operation" && stage !== "load_context") {
      return {
        status: "attention_required",
        code: "VISUAL_BOARD_PERSISTENCE_FAILED",
        message: "视觉方向未能安全保存，请稍后重试。",
        result: diagnostics,
      };
    }
    return {
      status: "failed",
      code: "VISUAL_OPERATION_CONTRACT_MISMATCH",
      message: "视觉检索任务合同不一致，请重置后重新开始。",
      result: diagnostics,
    };
  }
  if (error instanceof TwentyFirstToolContractError) {
    return {
      status: "attention_required",
      code: "MCP_CONTRACT_INCOMPATIBLE",
      message: "FrontMind 视觉目录暂不兼容，请稍后重试。",
      result: diagnostics,
    };
  }
  if (error instanceof AuthServiceError) {
    return {
      status: "attention_required",
      code:
        error.code === "INVALID_CREDENTIAL"
          ? "MCP_AUTH_OR_CAPABILITY_FAILED"
          : "MCP_UNAVAILABLE",
      message:
        error.code === "INVALID_CREDENTIAL"
          ? "FrontMind 视觉目录连接无效，或缺少必要的只读能力。"
          : "FrontMind 视觉目录暂时不可用，请稍后重试。",
      result: diagnostics,
    };
  }
  if (stage === "mcp_retrieval") {
    return {
      status: "attention_required",
      code: "MCP_UNAVAILABLE",
      message: "FrontMind 视觉目录暂时不可用，请稍后重试。",
      result: diagnostics,
    };
  }
  if (stage === "render_host_previews") {
    return {
      status: "attention_required",
      code: "FRONTMIND_VISUAL_RENDER_FAILED",
      message: "9 个视觉候选暂未能完整生成，请稍后重试。",
      result: diagnostics,
    };
  }
  return {
    status: "attention_required",
    code: "VISUAL_BOARD_PERSISTENCE_FAILED",
    message: "视觉方向未能安全保存，请稍后重试。",
    result: diagnostics,
  };
}

export function createTwentyFirstSiteOpsProviderHandler(
  dependencies: TwentyFirstProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const loadContext = dependencies.loadContext ?? loadDefaultContext;
  const getCredential =
    dependencies.getCredential ?? getTwentyFirstCredentialById;
  const client = dependencies.client ?? new TwentyFirstClient();
  const fetchPreview = dependencies.fetchPreview ?? fetchSafeVisualPreview;
  const renderCandidates =
    dependencies.renderCandidates ?? renderTrustedVisualCandidatePreviews;
  const persistArtifact =
    dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const persistBoard = dependencies.persistBoard ?? persistDefaultBoard;

  return async ({ operation, signal }) => {
    let stage: VisualSearchStage = "validate_operation";
    let activeApiKey: string | undefined;
    const diagnostics = createVisualSearchDiagnostics();
    try {
      const parsedInput = visualSearchOperationInputV1Schema.parse(
        operation.input,
      );
      stage = "load_context";
      const db = await dbGetter();
      if (!db) {
        throw new TwentyFirstProviderFailure(
          "DATABASE_UNAVAILABLE",
          "AI 建站服务暂时不可用。",
          "attention_required",
        );
      }
      const context = await loadContext(db, operation);
      if (context.existingBoard) {
        return {
          status: "succeeded",
          projectStatus: "awaiting_visual_selection",
          result: {
            batchId: context.existingBoard.batchId,
            candidateCount: context.existingBoard.candidateCount,
            selectionBundleHash:
              context.existingBoard.selectionBundleHash ?? undefined,
          },
          message: "视觉方向已恢复，可继续选择。",
        };
      }
      stage = "load_credential";
      const credential = await getCredential(parsedInput.credentialId);
      if (!credential || credential.version !== parsedInput.credentialVersion) {
        throw new TwentyFirstProviderFailure(
          "PINNED_CREDENTIAL_UNAVAILABLE",
          "该视觉检索固定的 FrontMind 目录连接版本不可用。",
          "attention_required",
        );
      }
      activeApiKey = credential.apiKey;
      stage = "mcp_retrieval";
      const retrieval = await client.withReadOnlySession(
        credential.apiKey,
        async (session) => {
          const pools = emptyFamilyReferencePools();
          const queries: FamilySearchQuery[] = [];
          const searchedCandidates = new Map<
            string,
            ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
          >();
          const mirrored: MirroredReference[] = [];
          const attemptedProviderKeys = new Set<string>();
          const seenPreviewHashes = new Set<string>();
          const supplementedFamilies = new Set<FrontMindVisualFamily>();
          const mirrorNewCandidates = async () => {
            const unique = new Map<string, NormalizedTwentyFirstCandidate>();
            for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
              for (const candidate of pools.get(family) ?? []) {
                if (!attemptedProviderKeys.has(candidate.providerItemKey)) {
                  unique.set(candidate.providerItemKey, candidate);
                }
              }
            }
            const candidates = [...unique.values()];
            for (const candidate of candidates) {
              attemptedProviderKeys.add(candidate.providerItemKey);
            }
            if (candidates.length < 1) return;
            stage = "mirror_previews";
            mirrored.push(
              ...(await mirrorCandidates({
                operation,
                context,
                candidates,
                signal,
                fetchPreview,
                persistArtifact,
                diagnostics,
                seenPreviewHashes,
              })),
            );
          };

          stage = "mcp_retrieval";
          await searchFamilyRound({
            session,
            brief: context.brief,
            families: FRONTMIND_VISUAL_FAMILIES_V3,
            round: "primary",
            pools,
            queries,
            searchedCandidates,
            signal,
            diagnostics,
          });
          const provisional = maximumKeyAssignment(pools);
          const provisionallyMissing = FRONTMIND_VISUAL_FAMILIES_V3.filter(
            (family) => !provisional.has(family),
          );
          if (provisionallyMissing.length > 0) {
            stage = "mcp_retrieval";
            await searchFamilyRound({
              session,
              brief: context.brief,
              families: provisionallyMissing,
              round: "supplemental",
              pools,
              queries,
              searchedCandidates,
              signal,
              diagnostics,
            });
            provisionallyMissing.forEach((family) =>
              supplementedFamilies.add(family),
            );
          }
          await mirrorNewCandidates();
          let assigned = assignDistinctMirroredReferences({ pools, mirrored });
          const missingAfterMirror = FRONTMIND_VISUAL_FAMILIES_V3.filter(
            (family) =>
              !assigned.has(family) && !supplementedFamilies.has(family),
          );
          if (missingAfterMirror.length > 0) {
            stage = "mcp_retrieval";
            await searchFamilyRound({
              session,
              brief: context.brief,
              families: missingAfterMirror,
              round: "supplemental",
              pools,
              queries,
              searchedCandidates,
              signal,
              diagnostics,
            });
            missingAfterMirror.forEach((family) =>
              supplementedFamilies.add(family),
            );
            await mirrorNewCandidates();
            assigned = assignDistinctMirroredReferences({ pools, mirrored });
          }
          refreshRetrievalDiagnostics({
            pools,
            searchedCandidates,
            mirrored,
            assigned,
            diagnostics,
          });
          return { queries, pools, mirrored, assigned };
        },
        { signal },
      );
      if (retrieval.assigned.size !== FRONTMIND_VISUAL_FAMILIES_V3.length) {
        throw new TwentyFirstProviderFailure(
          "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
          `FrontMind 当前仅找到 ${retrieval.assigned.size}/9 个可安全区分的真实 Hero 参考，请稍后重试。`,
          "attention_required",
        );
      }
      const degradedReasons: string[] = [];
      stage = "render_host_previews";
      const mirroredCandidates = await createFrontMindBoardCandidates({
        operation,
        context,
        inspirationByFamily: retrieval.assigned,
        signal,
        renderCandidates,
        persistArtifact,
        diagnostics,
      });
      const rejectedPreviews = Object.values(
        diagnostics.rejectedByReason,
      ).reduce((sum, count) => sum + (count ?? 0), 0);
      if (rejectedPreviews > 0) {
        degradedReasons.push(`PREVIEW_RESULTS_REJECTED:${rejectedPreviews}`);
      }
      stage = "persist_selection_bundle";
      const selectionBundle = visualSelectionBundleV4Schema.parse({
        schemaVersion: 4,
        queryPlanHash: canonicalSha256(retrieval.queries),
        searchTarget: retrieval.queries.reduce(
          (sum, query) => sum + query.limit,
          0,
        ),
        referenceTarget: 9,
        displayTarget: 9,
        candidates: mirroredCandidates.map((item) => ({
          id: item.sampleId,
          label: item.optionLabel,
          queryAxis: item.queryAxis,
          providerItemKey: item.providerItemKey,
          title: item.title,
          description: item.description,
          author: item.author,
          sourceUrl: item.sourceUrl,
          visualEvidence: item.visualEvidence,
          previewLocalAssetId: item.previewLocalAssetId,
          previewSha256: item.previewSha256,
          realizationPreviewLocalAssetId: item.realizationPreviewLocalAssetId,
          realizationPreviewSha256: item.realizationPreviewSha256,
          referencePerceptualHash: item.referencePerceptualHash,
          realizationPerceptualHash: item.realizationPerceptualHash,
          taxonomy: item.taxonomy,
          score: item.score,
          rationale: item.rationale,
          referenceBlueprint: item.referenceBlueprint,
        })),
        selectedCandidateId: null,
        delegated: false,
        degradedReasons: Array.from(new Set(degradedReasons)),
      });
      const selectionBuffer = Buffer.from(
        canonicalJson(selectionBundle),
        "utf8",
      );
      const selectionBundleArtifact = await persistArtifact({
        userId: operation.userId,
        projectId: context.project.id,
        kind: "21st-selection-bundle",
        filename: `visual-selection-${operation.id}.json`,
        mimeType: "application/json",
        buffer: selectionBuffer,
        maxBytes: 1_000_000,
      });
      const expectedSelectionHash = canonicalSha256(selectionBundle);
      if (selectionBundleArtifact.contentSha256 !== expectedSelectionHash) {
        throw new TwentyFirstProviderFailure(
          "SELECTION_BUNDLE_HASH_MISMATCH",
          "视觉选择包写入校验失败。",
          "attention_required",
        );
      }
      stage = "persist_board";
      const board = await persistBoard(db, {
        operation,
        context,
        selectionBundle,
        selectionBundleArtifact,
        mirroredCandidates,
      });
      return {
        status: "succeeded",
        projectStatus: "awaiting_visual_selection",
        result: {
          batchId: board.batchId,
          candidateCount: board.candidateCount,
          selectionBundleHash: board.selectionBundleHash ?? undefined,
          actual: {
            searched: diagnostics.normalizedUnique,
            shortlisted: diagnostics.shortlistCount,
            mirrored: diagnostics.mirrorSucceeded,
            presented: mirroredCandidates.length,
          },
          diagnostics,
          diversity: diagnostics.diversity,
          degradedReasons: selectionBundle.degradedReasons,
        },
        message: "9 个不同风格的视觉候选已准备完成，请选择一个方向。",
      };
    } catch (error) {
      console.error("[SiteOps21st] visual_search_failed", {
        operationId: operation.id,
        projectId: operation.projectId,
        stage,
        error: runtimeErrorForLog(error, {
          additionalSecrets: activeApiKey ? [activeApiKey] : [],
        }),
      });
      return safeProviderFailure(error, stage, diagnostics, signal);
    }
  };
}

/** Explicit registration keeps importing this module side-effect free. */
export function registerTwentyFirstSiteOpsProvider(
  dependencies: TwentyFirstProviderDependencies = {},
) {
  return registerSiteOpsProviderHandler(
    "21st",
    createTwentyFirstSiteOpsProviderHandler(dependencies),
  );
}
