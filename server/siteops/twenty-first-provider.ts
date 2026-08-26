import { createHash, randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import {
  knowledgeBaseSnapshots,
  messages,
  siteOperations,
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
  visualSearchOperationInputSchema,
  VISUAL_EVIDENCE_KIND,
  VISUAL_TAXONOMY_DERIVATION_VERSION,
  type NormalizedTwentyFirstCandidate,
  type SafeVisualDirective,
  type TwentyFirstQueryAxis,
  type TwentyFirstQueryRole,
  type TwentyFirstSearchEnvelope,
  type VisualSearchOperationInput,
} from "../../shared/siteops-workflow";
import {
  siteBriefSchema,
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
  visualSelectionBundleV4Schema,
  visualSelectionBundleV5Schema,
  type SiteBrief,
  type VisualSelectionBundleV4,
  type VisualSelectionBundleV5,
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
import { getDb } from "../db";
import {
  TwentyFirstClient,
  TwentyFirstToolContractError,
  getTwentyFirstCredentialById,
  type TwentyFirstReadOnlySession,
} from "../twenty-first-service";
import { persistSiteOpsArtifact } from "./artifact-store";
import {
  SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION,
  VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES,
  VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE,
  createVisualSelectionBundleV5Artifact,
  prepareNativeVisualCandidate,
  type PreparedNativeVisualCandidate,
} from "./native-visual-source";
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
  /** Complete published pages observed while the operation context is loaded. */
  publishedPageCount?: number;
  previousReferences?: {
    providerItemKeys: string[];
    previewSha256s: string[];
    perceptualHashes: string[];
    sourceTreeSha256s?: string[];
    nativePreviewSha256s?: string[];
  };
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

type NativeBoardCandidate = {
  sampleId: string;
  optionLabel: string;
  queryAxis: "foundation_split" | "foundation_editorial_modular";
  providerItemId: string;
  providerItemKey: string;
  providerVersion: string | null;
  title: string;
  description: string | null;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  author: string | null;
  sourceUrl: string | null;
  referencePreviewLocalAssetId: string;
  referencePreviewSha256: string;
  referencePerceptualHash: string;
  previewLocalAssetId: string;
  previewSha256: string;
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
  sourceTreeSha256: string;
  sourceArchiveSha256: string;
  sourceArchive: Buffer;
  entrypoint: string;
  demoEntrypoint: string;
  score: number;
  rationale: string;
};

type BoardCandidate = FrontMindBoardCandidate | NativeBoardCandidate;

export type ResolvedVisualSearchPlan = {
  schemaVersion: 1 | 2;
  mode: "initial" | "supplemental";
  page: 1 | 2 | 3;
  admissionRevision: number;
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
  | "source"
  | "aborted";

export type VisualSearchDiagnostics = {
  diagnosticsVersion: 2;
  searchedByAxis: Record<TwentyFirstQueryAxis, number>;
  normalizedUnique: number;
  shortlistCount: number;
  withPreviewReference: number;
  mirrorAttempted: number;
  mirrorSucceeded: number;
  rejectedByReason: Partial<Record<PreviewRejectionReason, number>>;
  /** Safe aggregate graph diagnostics. Family names, queries and URLs are
   * deliberately absent so this object can be returned and logged. */
  eligibilityEdgeCount: number;
  exactEligibilityEdgeCount: number;
  safeFallbackEdgeCount: number;
  keyMatchingCardinality: number;
  compatibleMatchingCardinality: number;
  deficientFamilyCount: number;
  queryCalls: number;
  maximumQueryLimit: number;
  effectiveSearchLimit: number;
  generalHeroEligibleCount: number;
  exactEligibilityEdges: number;
  safeFallbackEdges: number;
  mirrorAttempts: number;
  terminalReason:
    | "complete"
    | "catalog_insufficient"
    | "matching_budget_exhausted"
    | "preview_failures"
    | null;
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
  searchPlan: ResolvedVisualSearchPlan;
  context: TwentyFirstProviderContext;
  selectionBundle: VisualSelectionBundleV4 | VisualSelectionBundleV5;
  selectionBundleArtifact: PreviewArtifact;
  mirroredCandidates: BoardCandidate[];
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
  prepareNativeCandidate?: typeof prepareNativeVisualCandidate;
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
  | "retrieve_native_sources"
  | "render_native_previews"
  | "render_host_previews"
  | "persist_selection_bundle"
  | "persist_board";

type SafeVisualStructuredStage =
  | "visual_query_capability"
  | "visual_matching"
  | "visual_mirror"
  | "visual_page_published";

/**
 * Deliberately closed structured log contract. Callers can report only
 * internal coordinates, opaque variant identifiers, numeric aggregates and
 * the safe terminal classification. Provider queries, family names, URLs,
 * customer prose and credentials cannot enter this helper.
 */
function logSafeVisualStage(input: {
  event: SafeVisualStructuredStage;
  operationId: string;
  projectId: string;
  page: 1 | 2 | 3;
  latencyMs: number;
  variantId?: string;
  actualLimit?: number;
  queryCalls?: number;
  normalizedUnique?: number;
  eligibilityEdges?: number;
  keyMatchingCardinality?: number;
  compatibleMatchingCardinality?: number;
  mirrorAttempts?: number;
  mirrorSucceeded?: number;
  rejectedPreviews?: number;
  candidateCount?: number;
  terminalReason?: VisualSearchDiagnostics["terminalReason"];
}) {
  console.info("[SiteOps21st] visual_stage", {
    event: input.event,
    operationId: input.operationId,
    projectId: input.projectId,
    page: input.page,
    latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    ...(input.variantId ? { variantId: input.variantId } : {}),
    ...(input.actualLimit === undefined
      ? {}
      : { actualLimit: input.actualLimit }),
    ...(input.queryCalls === undefined ? {} : { queryCalls: input.queryCalls }),
    ...(input.normalizedUnique === undefined
      ? {}
      : { normalizedUnique: input.normalizedUnique }),
    ...(input.eligibilityEdges === undefined
      ? {}
      : { eligibilityEdges: input.eligibilityEdges }),
    ...(input.keyMatchingCardinality === undefined
      ? {}
      : { keyMatchingCardinality: input.keyMatchingCardinality }),
    ...(input.compatibleMatchingCardinality === undefined
      ? {}
      : {
          compatibleMatchingCardinality: input.compatibleMatchingCardinality,
        }),
    ...(input.mirrorAttempts === undefined
      ? {}
      : { mirrorAttempts: input.mirrorAttempts }),
    ...(input.mirrorSucceeded === undefined
      ? {}
      : { mirrorSucceeded: input.mirrorSucceeded }),
    ...(input.rejectedPreviews === undefined
      ? {}
      : { rejectedPreviews: input.rejectedPreviews }),
    ...(input.candidateCount === undefined
      ? {}
      : { candidateCount: input.candidateCount }),
    ...(input.terminalReason === undefined
      ? {}
      : { terminalReason: input.terminalReason }),
  });
}

function createVisualSearchDiagnostics(): VisualSearchDiagnostics {
  return {
    diagnosticsVersion: 2,
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
    eligibilityEdgeCount: 0,
    exactEligibilityEdgeCount: 0,
    safeFallbackEdgeCount: 0,
    keyMatchingCardinality: 0,
    compatibleMatchingCardinality: 0,
    deficientFamilyCount: FRONTMIND_VISUAL_FAMILIES_V3.length,
    queryCalls: 0,
    maximumQueryLimit: 0,
    effectiveSearchLimit: 0,
    generalHeroEligibleCount: 0,
    exactEligibilityEdges: 0,
    safeFallbackEdges: 0,
    mirrorAttempts: 0,
    terminalReason: null,
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

function visualSearchSuperseded() {
  return new TwentyFirstProviderFailure(
    "VISUAL_SEARCH_SUPERSEDED",
    "本次视觉候选生成已被更新的流程替代。",
    "failed",
  );
}

export function resolveVisualSearchPlan(
  input: VisualSearchOperationInput,
  context: TwentyFirstProviderContext,
): ResolvedVisualSearchPlan {
  if ("schemaVersion" in input) {
    if (
      context.project.revision !== input.admissionRevision ||
      (context.publishedPageCount !== undefined &&
        context.publishedPageCount !== input.page - 1)
    ) {
      throw visualSearchSuperseded();
    }
    return {
      schemaVersion: 2,
      mode: input.mode,
      page: input.page,
      admissionRevision: input.admissionRevision,
    };
  }

  // Immutable V1 tasks did not freeze page coordinates. Default contexts can
  // recover them from already published complete pages; injected legacy test
  // contexts fall back to the durable reference count.
  const publishedPages =
    context.publishedPageCount ??
    Math.floor(
      (context.previousReferences?.providerItemKeys.length ?? 0) /
        SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
    );
  if (publishedPages >= SITEOPS_VISUAL_CANDIDATE_MAX_PAGES) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_PAGE_LIMIT_REACHED",
      "本轮已生成全部 27 个视觉候选，请直接选择视觉方向。",
      "attention_required",
    );
  }
  const page = (publishedPages + 1) as 1 | 2 | 3;
  return {
    schemaVersion: 1,
    mode: page === 1 ? "initial" : "supplemental",
    page,
    // V1 did not persist an admission revision. Freeze the revision observed
    // for this invocation so a historical lease cannot overwrite a project
    // that advances while provider work is in flight.
    admissionRevision: context.project.revision,
  };
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
  const input = visualSearchOperationInputSchema.parse(operation.input);
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
  const priorSampleRows = await db
    .select({
      batchId: websiteStyleSamples.batchId,
      sourceMetadata: websiteStyleSamples.sourceMetadata,
    })
    .from(websiteStyleSamples)
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.userId, operation.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  const priorMetadata: Array<Record<string, unknown>> = priorSampleRows.map(
    (row: { sourceMetadata: unknown }) =>
      (row.sourceMetadata ?? {}) as Record<string, unknown>,
  );
  const priorEvidence: Array<Record<string, unknown>> = priorMetadata.map(
    (metadata) => (metadata.visualEvidence ?? {}) as Record<string, unknown>,
  );
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
      "当前企业知识库校验未完成，请先完成知识库后重试。",
    );
  }
  const publishedSamplesByBatch = new Map<string, number>();
  for (const row of priorSampleRows as Array<{ batchId: string }>) {
    publishedSamplesByBatch.set(
      row.batchId,
      (publishedSamplesByBatch.get(row.batchId) ?? 0) + 1,
    );
  }
  return {
    project,
    snapshot,
    brief: resolveSiteBrief(project, snapshot),
    existingBoard,
    publishedPageCount: [...publishedSamplesByBatch.values()].filter(
      (sampleCount) => sampleCount === SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
    ).length,
    previousReferences: {
      providerItemKeys: priorMetadata.flatMap((metadata) =>
        typeof metadata.providerItemKey === "string"
          ? [metadata.providerItemKey]
          : [],
      ),
      previewSha256s: priorEvidence.flatMap((evidence) =>
        typeof evidence.previewSha256 === "string"
          ? [evidence.previewSha256]
          : [],
      ),
      perceptualHashes: priorMetadata.flatMap((metadata) =>
        typeof metadata.referencePerceptualHash === "string"
          ? [metadata.referencePerceptualHash]
          : [],
      ),
      sourceTreeSha256s: priorMetadata.flatMap((metadata) =>
        typeof metadata.sourceTreeSha256 === "string"
          ? [metadata.sourceTreeSha256]
          : [],
      ),
      nativePreviewSha256s: priorMetadata.flatMap((metadata) =>
        metadata.renderer === "twenty_first_native_react_v1" &&
        typeof metadata.previewSha256 === "string"
          ? [metadata.previewSha256]
          : [],
      ),
    },
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
  page: 1 | 2 | 3;
  role: "foundation";
  axis: "foundation_split" | "foundation_editorial_modular";
  limit: number;
  query: string;
};

type FamilyReferenceEvidence = "exact" | "safe_fallback";

type FamilyReferenceEdge = {
  candidate: NormalizedTwentyFirstCandidate;
  /** `exact` is proved by family-positive provider metadata.
   * `safe_fallback` passed the general Hero gate without contradicting the
   * target family. Query provenance never creates or upgrades an edge. */
  evidence: FamilyReferenceEvidence;
};

type FamilyReferencePools = Map<FrontMindVisualFamily, FamilyReferenceEdge[]>;

const MAX_FAMILY_SEARCH_CALLS = 18;
const MAX_MIRROR_ATTEMPTS = 36;
const MIRROR_CONCURRENCY = 3;

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

/**
 * Fixed family-specific variants prevent later pages from replaying the same
 * recommendation window. These are structural synonyms rather than generic
 * "fresh" suffixes. Provider output and customer prose cannot select a query.
 */
const FAMILY_PAGE_QUERY_VARIANTS: Record<
  FrontMindVisualFamily,
  Record<1 | 2 | 3, readonly [string, string]>
> = {
  floating_orbit: {
    1: ["", ""],
    2: ["kinetic radial constellation", "layered circular motion geometry"],
    3: ["generative particle field", "concentric spatial illustration"],
  },
  split_media: {
    1: ["", ""],
    2: ["asymmetric two panel masthead", "side by side image copy layout"],
    3: ["offset media text diptych", "dual column visual narrative"],
  },
  editorial: {
    1: ["", ""],
    2: ["publication cover typography", "art directed serif masthead"],
    3: ["newspaper inspired hierarchy", "asymmetric type image composition"],
  },
  bento: {
    1: ["", ""],
    2: ["masonry product story tiles", "modular card mosaic masthead"],
    3: ["nested information tile canvas", "irregular rounded panel collage"],
  },
  feature_grid: {
    1: ["", ""],
    2: ["capability card matrix", "technical benefit tile system"],
    3: ["icon feature matrix masthead", "structured product benefit cards"],
  },
  centered_dual_cta: {
    1: ["", ""],
    2: ["symmetrical conversion masthead", "centered two action statement"],
    3: ["minimal paired action header", "balanced headline button pair"],
  },
  immersive_visual: {
    1: ["", ""],
    2: ["cinematic spatial scene", "full viewport depth experience"],
    3: ["parallax environment masthead", "three dimensional visual canvas"],
  },
  product_stage: {
    1: ["", ""],
    2: ["software interface pedestal", "device mockup spotlight composition"],
    3: ["application preview theater", "layered product screen showcase"],
  },
  full_bleed_statement: {
    1: ["", ""],
    2: [
      "edge to edge typographic declaration",
      "oversized minimal type canvas",
    ],
    3: ["dramatic headline only masthead", "full viewport bold type statement"],
  },
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

function familyReferenceEvidence(
  family: FrontMindVisualFamily,
  candidate: NormalizedTwentyFirstCandidate,
): FamilyReferenceEvidence | null {
  if (
    !candidate.heroEligibility.eligible ||
    candidate.catalogRole !== "hero" ||
    !candidate.previewUrl
  ) {
    return null;
  }
  const metadata = [candidate.title, candidate.description, candidate.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC");
  const rule = FAMILY_ELIGIBILITY_RULES[family];
  if (rule.negativeMetadata.some((pattern) => pattern.test(metadata))) {
    return null;
  }
  const directives = new Set(candidate.normalizedDirectives);
  if (rule.negativeDirectives.some((directive) => directives.has(directive))) {
    return null;
  }
  const hasPositiveMetadata = rule.positiveMetadata.some((pattern) =>
    pattern.test(metadata),
  );
  if (hasPositiveMetadata) {
    // Exact family edges are proved only by the provider item's own metadata.
    // Query provenance is deliberately absent from this decision.
    return "exact";
  }
  // A catalog item that has independently passed the generic Hero classifier,
  // has a real preview and contradicts none of this family's safety rules may
  // fill a sparse family only as a lower-priority safe fallback.
  return "safe_fallback";
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
  page: 1 | 2 | 3;
  brief: SiteBrief;
}): FamilySearchQuery {
  const terms = FAMILY_SEARCH_TERMS[input.family];
  const termIndex = input.round === "primary" ? 0 : 1;
  const pageVariant =
    FAMILY_PAGE_QUERY_VARIANTS[input.family][input.page][termIndex];
  const context = safeFamilySearchContext(input.brief);
  return {
    family: input.family,
    round: input.round,
    page: input.page,
    role: "foundation",
    axis: familyQueryAxis(input.family),
    // The live client clamps this request to the advertised provider maximum.
    // Asking for eighteen immediately avoids replaying only the recommendation
    // head on supplemental pages; the number of calls remains independently
    // bounded below.
    limit: 18,
    query: `${terms[termIndex]}${pageVariant ? ` ${pageVariant}` : ""}${context ? ` for ${context}` : ""}`,
  };
}

function emptyFamilyReferencePools(): FamilyReferencePools {
  return new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.map((family) => [family, []] as const),
  );
}

function compareFamilyEdges(
  left: FamilyReferenceEdge,
  right: FamilyReferenceEdge,
) {
  return (
    (left.evidence === right.evidence
      ? 0
      : left.evidence === "exact"
        ? -1
        : 1) ||
    left.candidate.queryRank - right.candidate.queryRank ||
    left.candidate.searchRank - right.candidate.searchRank ||
    right.candidate.score - left.candidate.score ||
    left.candidate.providerItemKey.localeCompare(
      right.candidate.providerItemKey,
    )
  );
}

function addCandidateToFamilyGraph(input: {
  pools: FamilyReferencePools;
  candidate: NormalizedTwentyFirstCandidate;
  excludedProviderKeys?: ReadonlySet<string>;
}) {
  if (input.excludedProviderKeys?.has(input.candidate.providerItemKey)) return;
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    const evidence = familyReferenceEvidence(family, input.candidate);
    if (!evidence) continue;
    const pool = input.pools.get(family)!;
    const existingIndex = pool.findIndex(
      (edge) =>
        edge.candidate.providerItemKey === input.candidate.providerItemKey,
    );
    if (existingIndex < 0) {
      pool.push({ candidate: input.candidate, evidence });
    } else if (
      evidence === "exact" &&
      pool[existingIndex]!.evidence === "safe_fallback"
    ) {
      pool[existingIndex] = { candidate: input.candidate, evidence };
    }
    pool.sort(compareFamilyEdges);
  }
}

async function searchFamilyRound(input: {
  session: TwentyFirstReadOnlySession;
  brief: SiteBrief;
  families: readonly FrontMindVisualFamily[];
  round: FamilySearchRound;
  page: 1 | 2 | 3;
  pools: FamilyReferencePools;
  queries: FamilySearchQuery[];
  searchedCandidates: Map<
    string,
    ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
  >;
  signal: AbortSignal;
  diagnostics: VisualSearchDiagnostics;
  excludedProviderKeys?: ReadonlySet<string>;
  generalHeroEligibleKeys: Set<string>;
  effectiveSearchLimit: number;
  nativeSourceMode?: boolean;
}) {
  for (const family of input.families) {
    if (input.queries.length >= MAX_FAMILY_SEARCH_CALLS) break;
    if (input.signal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉检索已超时；可申请重置，批准后可从当前企业知识库重新开始。",
      );
    }
    const composedQuery = composeFamilySearchQuery({
      family,
      round: input.round,
      page: input.page,
      brief: input.brief,
    });
    const query: FamilySearchQuery = {
      ...composedQuery,
      query: input.nativeSourceMode
        ? `${composedQuery.query} complete responsive landing page homepage source`
        : composedQuery.query,
      limit: Math.max(
        1,
        Math.min(composedQuery.limit, Math.trunc(input.effectiveSearchLimit)),
      ),
    };
    const envelope: TwentyFirstSearchEnvelope = {
      role: query.role,
      axis: query.axis,
      limit: query.limit,
      payload: await input.session.search({
        query: query.query,
        type: "component",
        limit: query.limit,
        ...(input.nativeSourceMode ? {} : { tag: "hero" as const }),
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
      retrievalLimit: query.limit,
    });
    for (const candidate of funnel.retrievalShortlist) {
      input.generalHeroEligibleKeys.add(candidate.providerItemKey);
      addCandidateToFamilyGraph({
        pools: input.pools,
        candidate,
        excludedProviderKeys: input.excludedProviderKeys,
      });
    }
  }
}

function maximumKeyAssignment(
  pools: FamilyReferencePools,
  unavailableProviderKeys: ReadonlySet<string> = new Set(),
) {
  const assignment = new Map<FrontMindVisualFamily, FamilyReferenceEdge>();
  const ownerByProviderKey = new Map<string, FrontMindVisualFamily>();
  const visit = (
    family: FrontMindVisualFamily,
    visited: Set<string>,
  ): boolean => {
    for (const edge of pools.get(family) ?? []) {
      const key = edge.candidate.providerItemKey;
      if (unavailableProviderKeys.has(key) || visited.has(key)) continue;
      visited.add(key);
      const owner = ownerByProviderKey.get(key);
      if (!owner || visit(owner, visited)) {
        ownerByProviderKey.set(key, family);
        assignment.set(family, edge);
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

function hallDeficiencyFamilyClosure(input: {
  pools: FamilyReferencePools;
  assignment: ReadonlyMap<FrontMindVisualFamily, FamilyReferenceEdge>;
  unavailableProviderKeys?: ReadonlySet<string>;
}) {
  const unavailable = input.unavailableProviderKeys ?? new Set<string>();
  const ownerByProviderKey = new Map(
    [...input.assignment].map(
      ([family, edge]) => [edge.candidate.providerItemKey, family] as const,
    ),
  );
  const pending = FRONTMIND_VISUAL_FAMILIES_V3.filter(
    (family) => !input.assignment.has(family),
  );
  const closure = new Set<FrontMindVisualFamily>(pending);
  while (pending.length > 0) {
    const family = pending.shift()!;
    for (const edge of input.pools.get(family) ?? []) {
      const key = edge.candidate.providerItemKey;
      if (unavailable.has(key)) continue;
      const owner = ownerByProviderKey.get(key);
      if (owner && !closure.has(owner)) {
        closure.add(owner);
        pending.push(owner);
      }
    }
  }
  return closure;
}

function nextMirrorCandidates(input: {
  pools: FamilyReferencePools;
  keyAssignment: ReadonlyMap<FrontMindVisualFamily, FamilyReferenceEdge>;
  compatibleAssignment: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  attemptedProviderKeys: ReadonlySet<string>;
  unavailableProviderKeys: ReadonlySet<string>;
  limit: number;
}) {
  const selected = new Map<string, NormalizedTwentyFirstCandidate>();
  const add = (edge: FamilyReferenceEdge) => {
    const key = edge.candidate.providerItemKey;
    if (
      selected.size >= input.limit ||
      input.attemptedProviderKeys.has(key) ||
      input.unavailableProviderKeys.has(key)
    ) {
      return;
    }
    selected.set(key, edge.candidate);
  };
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    const edge = input.keyAssignment.get(family);
    if (edge) add(edge);
    if (selected.size >= input.limit) return [...selected.values()];
  }
  if (selected.size > 0) return [...selected.values()];

  // A full provider-key assignment can still be incompatible after preview
  // SHA/pHash checks. Rank unmirrored alternatives by how many currently
  // deficient families they can safely serve, then prefer exact metadata.
  const deficient = new Set(
    FRONTMIND_VISUAL_FAMILIES_V3.filter(
      (family) => !input.compatibleAssignment.has(family),
    ),
  );
  const edgeByKey = new Map<string, FamilyReferenceEdge>();
  const supportByKey = new Map<string, number>();
  const exactByKey = new Map<string, number>();
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    for (const edge of input.pools.get(family) ?? []) {
      const key = edge.candidate.providerItemKey;
      if (
        input.attemptedProviderKeys.has(key) ||
        input.unavailableProviderKeys.has(key)
      ) {
        continue;
      }
      const existing = edgeByKey.get(key);
      if (!existing || compareFamilyEdges(edge, existing) < 0) {
        edgeByKey.set(key, edge);
      }
      if (deficient.has(family)) {
        supportByKey.set(key, (supportByKey.get(key) ?? 0) + 1);
      }
      if (edge.evidence === "exact") {
        exactByKey.set(key, (exactByKey.get(key) ?? 0) + 1);
      }
    }
  }
  const ranked = [...edgeByKey.values()].sort(
    (left, right) =>
      (supportByKey.get(right.candidate.providerItemKey) ?? 0) -
        (supportByKey.get(left.candidate.providerItemKey) ?? 0) ||
      (exactByKey.get(right.candidate.providerItemKey) ?? 0) -
        (exactByKey.get(left.candidate.providerItemKey) ?? 0) ||
      compareFamilyEdges(left, right),
  );
  for (const edge of ranked) {
    add(edge);
    if (selected.size >= input.limit) break;
  }
  return [...selected.values()];
}

function nextHallRescueFamily(input: {
  pools: FamilyReferencePools;
  assignment: ReadonlyMap<FrontMindVisualFamily, FamilyReferenceEdge>;
  queried: ReadonlySet<FrontMindVisualFamily>;
}) {
  const closure = hallDeficiencyFamilyClosure({
    pools: input.pools,
    assignment: input.assignment,
  });
  const index = (family: FrontMindVisualFamily) =>
    FRONTMIND_VISUAL_FAMILIES_V3.indexOf(family);
  const choose = (families: readonly FrontMindVisualFamily[]) =>
    [...families]
      .filter((family) => !input.queried.has(family))
      .sort(
        (left, right) =>
          Number(input.assignment.has(left)) -
            Number(input.assignment.has(right)) ||
          (input.pools.get(left)?.length ?? 0) -
            (input.pools.get(right)?.length ?? 0) ||
          index(left) - index(right),
      )[0];
  // Query the alternating deficiency closure first. If all of it has already
  // been explored, use the remaining family allowlist; this makes the bound
  // complete even when a rescue query introduces a new cross-family edge.
  return choose([...closure]) ?? choose(FRONTMIND_VISUAL_FAMILIES_V3);
}

function compatibleKeyEdges(input: {
  pools: FamilyReferencePools;
  assignment: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
}) {
  const edges = new Map<FrontMindVisualFamily, FamilyReferenceEdge>();
  for (const [family, reference] of input.assignment) {
    const edge = (input.pools.get(family) ?? []).find(
      (candidateEdge) =>
        candidateEdge.candidate.providerItemKey ===
        reference.candidate.providerItemKey,
    );
    if (edge) edges.set(family, edge);
  }
  return edges;
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
  queries?: readonly FamilySearchQuery[];
  keyMatchingCardinality?: number;
  generalHeroEligibleKeys?: ReadonlySet<string>;
  effectiveSearchLimit?: number;
}) {
  const eligibleKeys = new Set(
    [...input.pools.values()].flatMap((pool) =>
      pool.map((edge) => edge.candidate.providerItemKey),
    ),
  );
  const edges = [...input.pools.values()].flat();
  input.diagnostics.normalizedUnique = input.searchedCandidates.size;
  input.diagnostics.withPreviewReference = [
    ...input.searchedCandidates.values(),
  ].filter((candidate) => candidate.previewUrl).length;
  input.diagnostics.shortlistCount = eligibleKeys.size;
  input.diagnostics.eligibilityEdgeCount = edges.length;
  input.diagnostics.exactEligibilityEdgeCount = edges.filter(
    (edge) => edge.evidence === "exact",
  ).length;
  input.diagnostics.safeFallbackEdgeCount = edges.filter(
    (edge) => edge.evidence === "safe_fallback",
  ).length;
  input.diagnostics.keyMatchingCardinality =
    input.keyMatchingCardinality ?? maximumKeyAssignment(input.pools).size;
  input.diagnostics.compatibleMatchingCardinality = input.assigned.size;
  input.diagnostics.deficientFamilyCount = Math.max(
    0,
    FRONTMIND_VISUAL_FAMILIES_V3.length - input.assigned.size,
  );
  input.diagnostics.queryCalls =
    input.queries?.length ?? input.diagnostics.diversity.familyQueriesRun;
  input.diagnostics.maximumQueryLimit = Math.max(
    0,
    ...(input.queries ?? []).map((query) => query.limit),
  );
  input.diagnostics.effectiveSearchLimit = Math.max(
    0,
    Math.trunc(
      input.effectiveSearchLimit ?? input.diagnostics.maximumQueryLimit,
    ),
  );
  input.diagnostics.generalHeroEligibleCount =
    input.generalHeroEligibleKeys?.size ?? eligibleKeys.size;
  input.diagnostics.exactEligibilityEdges =
    input.diagnostics.exactEligibilityEdgeCount;
  input.diagnostics.safeFallbackEdges = input.diagnostics.safeFallbackEdgeCount;
  input.diagnostics.mirrorAttempts = input.diagnostics.mirrorAttempted;
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
  priorPreviewHashes?: ReadonlySet<string>;
  priorPerceptualHashes?: ReadonlySet<string>;
}) {
  const mirrored: MirroredReference[] = [];
  const rejectedProviderKeys = new Set<string>();
  const priorPreviewHashes = input.priorPreviewHashes ?? new Set<string>();
  const priorPerceptualHashes =
    input.priorPerceptualHashes ?? new Set<string>();
  for (
    let offset = 0;
    offset < input.candidates.length;
    offset += MIRROR_CONCURRENCY
  ) {
    if (input.signal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉预览镜像已超时；可申请重置，批准后可从当前企业知识库重新开始。",
      );
    }
    const batch = input.candidates.slice(offset, offset + MIRROR_CONCURRENCY);
    const downloaded = await Promise.all(
      batch.map(async (candidate) => {
        input.diagnostics.mirrorAttempted += 1;
        try {
          const preview = await input.fetchPreview({
            url: candidate.previewUrl!,
            signal: input.signal,
          });
          const perceptualHash = await perceptualHash64(preview.buffer);
          return { candidate, preview, perceptualHash } as const;
        } catch (error) {
          if (input.signal.aborted) {
            throw new TwentyFirstProviderFailure(
              "VISUAL_SEARCH_TIMEOUT",
              "视觉预览镜像已超时；可申请重置，批准后可从当前企业知识库重新开始。",
            );
          }
          rejectDiagnostic(input.diagnostics, previewRejectionReason(error));
          rejectedProviderKeys.add(candidate.providerItemKey);
          return null;
        }
      }),
    );
    for (const downloadedItem of downloaded) {
      if (!downloadedItem) continue;
      const { candidate, preview, perceptualHash } = downloadedItem;
      if (
        priorPreviewHashes.has(preview.sha256) ||
        [...priorPerceptualHashes].some(
          (hash) => perceptualHashDistance(hash, perceptualHash) < 6,
        )
      ) {
        rejectDiagnostic(input.diagnostics, "duplicate");
        rejectedProviderKeys.add(candidate.providerItemKey);
        continue;
      }
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
        rejectedProviderKeys.add(candidate.providerItemKey);
        continue;
      }
      if (asset.contentSha256 !== preview.sha256) {
        rejectDiagnostic(input.diagnostics, "hash");
        rejectedProviderKeys.add(candidate.providerItemKey);
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
  return { mirrored, rejectedProviderKeys };
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
          (input.pools.get(family) ?? [])
            .flatMap((edge) => {
              const mirrored = mirroredByKey.get(
                edge.candidate.providerItemKey,
              );
              return mirrored ? [{ edge, mirrored }] : [];
            })
            .sort((left, right) => compareFamilyEdges(left.edge, right.edge)),
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
  const solverBudget = 250_000;
  const deadStates = new Set<string>();
  const visit = (
    index: number,
    assigned: Map<FrontMindVisualFamily, MirroredReference>,
    providerKeys: Set<string>,
    previewHashes: Set<string>,
    perceptualHashes: string[],
  ): boolean => {
    explored += 1;
    if (explored > solverBudget) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_MATCHING_BUDGET_EXHAUSTED",
        "视觉参考组合计算暂时超出安全上限，请稍后重试。",
        "attention_required",
      );
    }
    if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) {
      // The family-owned V4 baselines are asserted once when the final board
      // is rendered. Reference feasibility depends only on the processed
      // family index and selected provider keys/SHA/pHashes, which lets this
      // search memoize equivalent permutations safely.
      best = new Map(assigned);
      return true;
    }
    if (assigned.size > best.size) best = new Map(assigned);
    if (index >= familyOrder.length) return false;
    if (assigned.size + familyOrder.length - index <= best.size) return false;
    const stateKey = `${index}:${[...providerKeys].sort().join(",")}`;
    if (deadStates.has(stateKey)) return false;
    const family = familyOrder[index]!;
    for (const choice of choices.get(family) ?? []) {
      const reference = choice.mirrored;
      const key = reference.candidate.providerItemKey;
      if (
        providerKeys.has(key) ||
        previewHashes.has(reference.previewSha256) ||
        perceptualHashes.some(
          (hash) => perceptualHashDistance(hash, reference.perceptualHash) < 6,
        )
      ) {
        continue;
      }
      assigned.set(family, reference);
      providerKeys.add(key);
      previewHashes.add(reference.previewSha256);
      perceptualHashes.push(reference.perceptualHash);
      if (
        visit(
          index + 1,
          assigned,
          providerKeys,
          previewHashes,
          perceptualHashes,
        )
      ) {
        return true;
      }
      perceptualHashes.pop();
      previewHashes.delete(reference.previewSha256);
      providerKeys.delete(key);
      assigned.delete(family);
    }
    const completed = visit(
      index + 1,
      assigned,
      providerKeys,
      previewHashes,
      perceptualHashes,
    );
    if (!completed) deadStates.add(stateKey);
    return completed;
  };
  visit(0, new Map(), new Set(), new Set(), []);
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

async function createNativeBoardCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  inspirationByFamily: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  preparedByProviderKey: ReadonlyMap<string, PreparedNativeVisualCandidate>;
  persistArtifact: typeof persistSiteOpsArtifact;
}) {
  if (
    input.inspirationByFamily.size !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    FRONTMIND_VISUAL_FAMILIES_V3.some(
      (family) => !input.inspirationByFamily.has(family),
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "NATIVE_SOURCE_CANDIDATE_PAGE_INCOMPLETE",
      "9 个原生源码视觉候选未能完整生成，请稍后重试。",
      "attention_required",
    );
  }
  const candidates: NativeBoardCandidate[] = [];
  const seenSourceTrees = new Set<string>();
  const seenPreviewHashes = new Set<string>();
  for (let index = 0; index < FRONTMIND_VISUAL_FAMILIES_V3.length; index += 1) {
    const family = FRONTMIND_VISUAL_FAMILIES_V3[index]!;
    const reference = input.inspirationByFamily.get(family)!;
    const prepared = input.preparedByProviderKey.get(
      reference.candidate.providerItemKey,
    );
    if (
      !prepared ||
      seenSourceTrees.has(prepared.sourceTreeSha256) ||
      seenPreviewHashes.has(prepared.previewSha256)
    ) {
      throw new TwentyFirstProviderFailure(
        "NATIVE_SOURCE_CANDIDATE_PAGE_INCOMPLETE",
        "9 个原生源码视觉候选未能完整生成，请稍后重试。",
        "attention_required",
      );
    }
    seenSourceTrees.add(prepared.sourceTreeSha256);
    seenPreviewHashes.add(prepared.previewSha256);
    const previewAsset = await input.persistArtifact({
      userId: input.operation.userId,
      projectId: input.context.project.id,
      kind: "21st-native-react-preview",
      filename: `21st-native-${reference.candidate.candidateId.slice(0, 120)}.png`,
      mimeType: "image/png",
      buffer: prepared.preview,
      maxBytes: 5 * 1024 * 1024,
    });
    if (previewAsset.contentSha256 !== prepared.previewSha256) {
      throw new TwentyFirstProviderFailure(
        "NATIVE_PREVIEW_HASH_MISMATCH",
        "原生源码视觉候选写入校验失败。",
        "attention_required",
      );
    }
    candidates.push({
      sampleId: reference.sampleId,
      optionLabel: String.fromCharCode(65 + index),
      queryAxis: familyQueryAxis(family),
      providerItemId: String(reference.candidate.providerItemId),
      providerItemKey: reference.candidate.providerItemKey,
      providerVersion: prepared.providerVersion,
      title: reference.candidate.title,
      description: reference.candidate.description,
      taxonomy: reference.taxonomy,
      author: reference.candidate.author,
      sourceUrl: reference.candidate.sourceUrl,
      referencePreviewLocalAssetId: reference.previewLocalAssetId,
      referencePreviewSha256: reference.previewSha256,
      referencePerceptualHash: reference.perceptualHash,
      previewLocalAssetId: previewAsset.id,
      previewSha256: prepared.previewSha256,
      visualEvidence: reference.visualEvidence,
      sourceTreeSha256: prepared.sourceTreeSha256,
      sourceArchiveSha256: prepared.sourceArchiveSha256,
      sourceArchive: prepared.sourceArchive,
      entrypoint: prepared.entrypoint,
      demoEntrypoint: prepared.demoEntrypoint,
      score: reference.candidate.score,
      rationale:
        "该候选直接运行 21st 原生 React 源码；选择后以同一源码作为官网制作基线。",
    });
  }
  return candidates;
}

async function persistDefaultBoard(
  db: any,
  input: TwentyFirstBoardPersistenceInput,
) {
  if (
    input.mirroredCandidates.length !== SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE ||
    input.selectionBundle.candidates.length !==
      SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE
  ) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_PAGE_INCOMPLETE",
      "本组视觉候选未完整生成，请稍后重试。",
      "attention_required",
    );
  }
  return db.transaction(async (tx: any): Promise<ExistingBoard> => {
    // Keep the same lock order as customer actions: project, published visual
    // batches, then the active operation. This avoids a project↔operation
    // deadlock when a click races the final board commit.
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
      project.currentKnowledgeSnapshotId !== input.context.snapshot.id ||
      project.revision !== input.searchPlan.admissionRevision
    ) {
      throw visualSearchSuperseded();
    }
    const currentPublishedRows = await tx
      .select({ id: websiteStyleSampleBatches.id })
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, project.id),
          eq(websiteStyleSampleBatches.userId, input.operation.userId),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.status, "published"),
        ),
      )
      .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES)
      .for("update");
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
    const operationRows = await tx
      .select()
      .from(siteOperations)
      .where(eq(siteOperations.id, input.operation.id))
      .limit(1)
      .for("update");
    const leasedOperation = operationRows[0];
    if (
      !leasedOperation ||
      leasedOperation.status !== "running" ||
      !input.operation.leaseOwner ||
      leasedOperation.leaseOwner !== input.operation.leaseOwner ||
      !leasedOperation.leaseExpiresAt ||
      leasedOperation.leaseExpiresAt.getTime() <= Date.now()
    ) {
      throw visualSearchSuperseded();
    }
    const frozenOperationInput = visualSearchOperationInputSchema.safeParse(
      leasedOperation.input,
    );
    if (
      !frozenOperationInput.success ||
      frozenOperationInput.data.knowledgeSnapshotId !==
        input.context.snapshot.id ||
      canonicalSha256(frozenOperationInput.data) !==
        canonicalSha256(input.operation.input) ||
      leasedOperation.projectId !== input.context.project.id ||
      leasedOperation.userId !== input.operation.userId ||
      leasedOperation.kind !== "visual_search" ||
      leasedOperation.provider !== "21st"
    ) {
      throw visualSearchSuperseded();
    }
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
    if (currentPublishedRows.length !== input.searchPlan.page - 1) {
      throw visualSearchSuperseded();
    }
    if (currentPublishedRows.length >= SITEOPS_VISUAL_CANDIDATE_MAX_PAGES) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_CANDIDATE_PAGE_LIMIT_REACHED",
        "本轮已生成全部 27 个视觉候选，请直接选择视觉方向。",
        "attention_required",
      );
    }
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
          ...("sourceTreeSha256" in item
            ? {
                schemaVersion: 5,
                renderer: "twenty_first_native_react_v1" as const,
                providerItemId: item.providerItemId,
                providerVersion: item.providerVersion,
                sourceTreeSha256: item.sourceTreeSha256,
                sourceArchiveSha256: item.sourceArchiveSha256,
                entrypoint: item.entrypoint,
                demoEntrypoint: item.demoEntrypoint,
                referencePreviewLocalAssetId: item.referencePreviewLocalAssetId,
                referencePreviewSha256: item.referencePreviewSha256,
                referencePerceptualHash: item.referencePerceptualHash,
                previewSha256: item.previewSha256,
              }
            : {
                heroFamily: item.referenceBlueprint.heroFamily,
                heroEligibility: {
                  eligible: true,
                  confidence: "explicit",
                  variant: legacyHeroVariantForFamily(
                    item.referenceBlueprint.heroFamily,
                  ),
                  reasons: ["frontmind-trusted-react-family"],
                },
                referenceBlueprint: item.referenceBlueprint,
                realizationPreviewLocalAssetId:
                  item.realizationPreviewLocalAssetId,
                realizationPreviewSha256: item.realizationPreviewSha256,
                referencePerceptualHash: item.referencePerceptualHash,
                realizationPerceptualHash: item.realizationPerceptualHash,
              }),
          providerItemKey: item.providerItemKey,
          queryAxis: item.queryAxis,
          title: item.title,
          description: item.description,
          author: item.author,
          sourceUrl: item.sourceUrl,
          catalogRole: "hero",
          visualEvidence: item.visualEvidence,
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
      content:
        input.searchPlan.page === 1
          ? "已准备 9 个不同风格的视觉候选，请选择一个方向。"
          : `第 ${input.searchPlan.page} 组 9 个全新视觉候选已准备完成，请选择一个方向。`,
      sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
      metadata: {
        siteOps: {
          kind: "visual_board",
          subjectId: batchId,
          revision: project.revision + 1,
          status: "active",
          payload: {
            batchId,
            mode: input.searchPlan.mode,
            page: input.searchPlan.page,
            candidateCount: input.mirroredCandidates.length,
            targets: [18, 9],
            degradedReasons: input.selectionBundle.degradedReasons,
          },
        },
      },
    });
    const projectUpdated = await tx
      .update(siteProjects)
      .set({
        brief: input.context.brief,
        status: "awaiting_visual_selection",
        revision: project.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteProjects.id, project.id),
          eq(siteProjects.revision, project.revision),
        ),
      );
    const affectedRows = Number(
      (Array.isArray(projectUpdated)
        ? (projectUpdated[0] as { affectedRows?: unknown } | undefined)
            ?.affectedRows
        : (projectUpdated as { affectedRows?: unknown } | undefined)
            ?.affectedRows) ?? 0,
    );
    if (affectedRows !== 1) throw visualSearchSuperseded();
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
  diagnostics.queryCalls = Math.max(
    diagnostics.queryCalls,
    diagnostics.diversity.familyQueriesRun,
  );
  diagnostics.mirrorAttempts = diagnostics.mirrorAttempted;
  diagnostics.exactEligibilityEdges = diagnostics.exactEligibilityEdgeCount;
  diagnostics.safeFallbackEdges = diagnostics.safeFallbackEdgeCount;
  if (signal.aborted || abortLike(error)) {
    return {
      status: "failed",
      code: "VISUAL_SEARCH_TIMEOUT",
      message: "视觉检索已超时；可申请重置，批准后可从当前企业知识库重新开始。",
      result: diagnostics,
    };
  }
  if (error instanceof TwentyFirstProviderFailure) {
    if (error.code === "VISUAL_MATCHING_BUDGET_EXHAUSTED") {
      diagnostics.terminalReason = "matching_budget_exhausted";
    }
    diagnostics.mirrorAttempts = diagnostics.mirrorAttempted;
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
      message:
        "视觉检索任务合同不一致；可申请重置，批准后可从当前企业知识库重新开始。",
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

async function assertCommitLeaseActive(
  assertLeaseActive: (() => Promise<void>) | undefined,
) {
  if (!assertLeaseActive) return;
  try {
    await assertLeaseActive();
  } catch {
    throw visualSearchSuperseded();
  }
}

async function mapWithBoundedConcurrency<T, R>(input: {
  values: readonly T[];
  concurrency: number;
  map: (value: T, index: number) => Promise<R>;
}) {
  const results = new Array<R>(input.values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < input.values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await input.map(input.values[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          input.values.length,
          Math.max(1, Math.trunc(input.concurrency)),
        ),
      },
      worker,
    ),
  );
  return results;
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
  const prepareNativeCandidate =
    dependencies.prepareNativeCandidate ?? prepareNativeVisualCandidate;
  const persistArtifact =
    dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const persistBoard = dependencies.persistBoard ?? persistDefaultBoard;

  return async ({ operation, signal, assertLeaseActive }) => {
    const providerStartedAt = Date.now();
    let stage: VisualSearchStage = "validate_operation";
    const diagnostics = createVisualSearchDiagnostics();
    try {
      const parsedInput = visualSearchOperationInputSchema.parse(
        operation.input,
      );
      const nativeSourceMode =
        parsedInput.workflowVersion === SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION;
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
        if (
          context.existingBoard.candidateCount !==
          SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE
        ) {
          throw new TwentyFirstProviderFailure(
            "VISUAL_CANDIDATE_PAGE_INCOMPLETE",
            "已保存的视觉候选不完整，请稍后重试。",
            "attention_required",
          );
        }
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
      const searchPlan = resolveVisualSearchPlan(parsedInput, context);
      stage = "load_credential";
      const credential = await getCredential(parsedInput.credentialId);
      if (!credential || credential.version !== parsedInput.credentialVersion) {
        throw new TwentyFirstProviderFailure(
          "PINNED_CREDENTIAL_UNAVAILABLE",
          "该视觉检索固定的 FrontMind 目录连接版本不可用。",
          "attention_required",
        );
      }
      stage = "mcp_retrieval";
      const retrieval = await client.withReadOnlySession(
        credential.apiKey,
        async (session) => {
          if (nativeSourceMode && !session.getComponent) {
            throw new TwentyFirstProviderFailure(
              "MCP_GET_COMPONENT_REQUIRED",
              "当前 21st 连接缺少原生源码读取能力。",
              "attention_required",
            );
          }
          const pools = emptyFamilyReferencePools();
          const queries: FamilySearchQuery[] = [];
          const searchedCandidates = new Map<
            string,
            ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
          >();
          const generalHeroEligibleKeys = new Set<string>();
          const mirrored: MirroredReference[] = [];
          const preparedNativeByProviderKey = new Map<
            string,
            PreparedNativeVisualCandidate
          >();
          const attemptedProviderKeys = new Set<string>();
          const unavailableProviderKeys = new Set<string>();
          const excludedProviderKeys = new Set(
            context.previousReferences?.providerItemKeys ?? [],
          );
          const priorPreviewHashes = new Set(
            context.previousReferences?.previewSha256s ?? [],
          );
          const priorPerceptualHashes = new Set(
            context.previousReferences?.perceptualHashes ?? [],
          );
          const priorSourceTreeSha256s = new Set(
            context.previousReferences?.sourceTreeSha256s ?? [],
          );
          const priorNativePreviewSha256s = new Set(
            context.previousReferences?.nativePreviewSha256s ?? [],
          );
          const rescueQueriedFamilies = new Set<FrontMindVisualFamily>();
          const effectiveSearchLimit = Math.max(
            1,
            Math.min(18, Math.trunc(session.effectiveSearchLimit ?? 18)),
          );
          let queryLatencyMs = 0;
          const runSearchRound = async (input: {
            families: readonly FrontMindVisualFamily[];
            round: FamilySearchRound;
          }) => {
            const startedAt = Date.now();
            try {
              await searchFamilyRound({
                session,
                brief: context.brief,
                families: input.families,
                round: input.round,
                page: searchPlan.page,
                pools,
                queries,
                searchedCandidates,
                signal,
                diagnostics,
                excludedProviderKeys,
                generalHeroEligibleKeys,
                effectiveSearchLimit,
                nativeSourceMode,
              });
            } finally {
              queryLatencyMs += Date.now() - startedAt;
            }
          };
          const mirrorSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(nativeSourceMode ? 180_000 : 45_000),
          ]);
          const mirrorCandidateSet = async (
            candidates: NormalizedTwentyFirstCandidate[],
          ) => {
            for (const candidate of candidates) {
              attemptedProviderKeys.add(candidate.providerItemKey);
            }
            if (candidates.length < 1) return;
            await assertCommitLeaseActive(assertLeaseActive);
            stage = "mirror_previews";
            const result = await mirrorCandidates({
              operation,
              context,
              candidates,
              signal: mirrorSignal,
              fetchPreview,
              persistArtifact,
              diagnostics,
              priorPreviewHashes,
              priorPerceptualHashes,
            });
            result.rejectedProviderKeys.forEach((key) =>
              unavailableProviderKeys.add(key),
            );
            if (!nativeSourceMode) {
              mirrored.push(...result.mirrored);
              return;
            }
            stage = "retrieve_native_sources";
            // Each native preparation launches a bounded Vite build and one
            // isolated Chromium render. Keep this limit local even if a future
            // mirror implementation returns more than today's three-item
            // batches; an unbounded Promise.all would exhaust container memory.
            const prepared = await mapWithBoundedConcurrency({
              values: result.mirrored,
              concurrency: MIRROR_CONCURRENCY,
              map: async (reference) => {
                try {
                  const detail = await session.getComponent!(
                    reference.candidate.providerItemId,
                  );
                  stage = "render_native_previews";
                  const native = await prepareNativeCandidate({
                    candidate: reference.candidate,
                    payload: detail,
                    signal: mirrorSignal,
                  });
                  if (
                    priorSourceTreeSha256s.has(native.sourceTreeSha256) ||
                    priorNativePreviewSha256s.has(native.previewSha256) ||
                    [...preparedNativeByProviderKey.values()].some(
                      (existing) =>
                        existing.sourceTreeSha256 === native.sourceTreeSha256 ||
                        existing.previewSha256 === native.previewSha256,
                    )
                  ) {
                    throw new Error("NATIVE_SOURCE_DUPLICATE");
                  }
                  return { reference, native } as const;
                } catch {
                  rejectDiagnostic(diagnostics, "source");
                  unavailableProviderKeys.add(
                    reference.candidate.providerItemKey,
                  );
                  return null;
                }
              },
            });
            const acceptedSourceTrees = new Set(
              [...preparedNativeByProviderKey.values()].map(
                (item) => item.sourceTreeSha256,
              ),
            );
            const acceptedNativePreviews = new Set(
              [...preparedNativeByProviderKey.values()].map(
                (item) => item.previewSha256,
              ),
            );
            for (const item of prepared) {
              if (!item) continue;
              if (
                acceptedSourceTrees.has(item.native.sourceTreeSha256) ||
                acceptedNativePreviews.has(item.native.previewSha256)
              ) {
                rejectDiagnostic(diagnostics, "source");
                unavailableProviderKeys.add(
                  item.reference.candidate.providerItemKey,
                );
                continue;
              }
              acceptedSourceTrees.add(item.native.sourceTreeSha256);
              acceptedNativePreviews.add(item.native.previewSha256);
              mirrored.push(item.reference);
              preparedNativeByProviderKey.set(
                item.reference.candidate.providerItemKey,
                item.native,
              );
            }
          };

          stage = "mcp_retrieval";
          await runSearchRound({
            families: FRONTMIND_VISUAL_FAMILIES_V3,
            round: "primary",
          });
          const matchingStartedAt = Date.now();
          let keyAssignment = maximumKeyAssignment(
            pools,
            unavailableProviderKeys,
          );
          const searchRescueFamily = async (family: FrontMindVisualFamily) => {
            rescueQueriedFamilies.add(family);
            stage = "mcp_retrieval";
            await runSearchRound({
              families: [family],
              round: "supplemental",
            });
            keyAssignment = maximumKeyAssignment(
              pools,
              unavailableProviderKeys,
            );
          };
          const rescueUntilCompleteKeyMatching = async () => {
            while (
              keyAssignment.size < FRONTMIND_VISUAL_FAMILIES_V3.length &&
              queries.length < MAX_FAMILY_SEARCH_CALLS
            ) {
              const family = nextHallRescueFamily({
                pools,
                assignment: keyAssignment,
                queried: rescueQueriedFamilies,
              });
              if (!family) break;
              await searchRescueFamily(family);
            }
          };
          await rescueUntilCompleteKeyMatching();

          const mirrorStartedAt = Date.now();
          let assigned = new Map<FrontMindVisualFamily, MirroredReference>();
          while (
            keyAssignment.size === FRONTMIND_VISUAL_FAMILIES_V3.length &&
            diagnostics.mirrorAttempted < MAX_MIRROR_ATTEMPTS
          ) {
            assigned = assignDistinctMirroredReferences({ pools, mirrored });
            if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) break;
            const remaining = Math.min(
              MIRROR_CONCURRENCY,
              MAX_MIRROR_ATTEMPTS - diagnostics.mirrorAttempted,
            );
            const next = nextMirrorCandidates({
              pools,
              keyAssignment,
              compatibleAssignment: assigned,
              attemptedProviderKeys,
              unavailableProviderKeys,
              limit: remaining,
            });
            if (next.length < 1) {
              if (queries.length >= MAX_FAMILY_SEARCH_CALLS) break;
              const compatibleAssignment = compatibleKeyEdges({
                pools,
                assignment: assigned,
              });
              const rescueFamily = nextHallRescueFamily({
                pools,
                assignment: compatibleAssignment,
                queried: rescueQueriedFamilies,
              });
              if (!rescueFamily) break;
              await searchRescueFamily(rescueFamily);
              continue;
            }
            await mirrorCandidateSet(next);
            keyAssignment = maximumKeyAssignment(
              pools,
              unavailableProviderKeys,
            );
            if (keyAssignment.size < FRONTMIND_VISUAL_FAMILIES_V3.length) {
              await rescueUntilCompleteKeyMatching();
            }
          }
          assigned = assignDistinctMirroredReferences({ pools, mirrored });
          const previewFailureCount = Object.values(
            diagnostics.rejectedByReason,
          ).reduce((sum, count) => sum + (count ?? 0), 0);
          if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) {
            diagnostics.terminalReason = "complete";
          } else if (diagnostics.mirrorAttempted >= MAX_MIRROR_ATTEMPTS) {
            diagnostics.terminalReason = "matching_budget_exhausted";
          } else if (previewFailureCount > 0) {
            diagnostics.terminalReason = "preview_failures";
          } else if (keyAssignment.size < FRONTMIND_VISUAL_FAMILIES_V3.length) {
            diagnostics.terminalReason = "catalog_insufficient";
          } else {
            diagnostics.terminalReason = "catalog_insufficient";
          }
          refreshRetrievalDiagnostics({
            pools,
            searchedCandidates,
            mirrored,
            assigned,
            diagnostics,
            queries,
            keyMatchingCardinality: keyAssignment.size,
            generalHeroEligibleKeys,
            effectiveSearchLimit,
          });
          logSafeVisualStage({
            event: "visual_query_capability",
            operationId: operation.id,
            projectId: operation.projectId,
            page: searchPlan.page,
            // The identifier selects the fixed, allowlisted page variant. It
            // carries no family name or query material.
            variantId: `visual-query-v2-page-${searchPlan.page}`,
            actualLimit: effectiveSearchLimit,
            queryCalls: diagnostics.queryCalls,
            normalizedUnique: diagnostics.normalizedUnique,
            latencyMs: queryLatencyMs,
          });
          const rejectedPreviews = Object.values(
            diagnostics.rejectedByReason,
          ).reduce((sum, count) => sum + (count ?? 0), 0);
          logSafeVisualStage({
            event: "visual_matching",
            operationId: operation.id,
            projectId: operation.projectId,
            page: searchPlan.page,
            queryCalls: diagnostics.queryCalls,
            normalizedUnique: diagnostics.normalizedUnique,
            eligibilityEdges: diagnostics.eligibilityEdgeCount,
            keyMatchingCardinality: diagnostics.keyMatchingCardinality,
            compatibleMatchingCardinality:
              diagnostics.compatibleMatchingCardinality,
            terminalReason: diagnostics.terminalReason,
            latencyMs: Date.now() - matchingStartedAt,
          });
          logSafeVisualStage({
            event: "visual_mirror",
            operationId: operation.id,
            projectId: operation.projectId,
            page: searchPlan.page,
            mirrorAttempts: diagnostics.mirrorAttempts,
            mirrorSucceeded: diagnostics.mirrorSucceeded,
            rejectedPreviews,
            compatibleMatchingCardinality:
              diagnostics.compatibleMatchingCardinality,
            terminalReason: diagnostics.terminalReason,
            latencyMs: Date.now() - mirrorStartedAt,
          });
          return {
            queries,
            pools,
            mirrored,
            assigned,
            preparedNativeByProviderKey,
          };
        },
        { signal },
      );
      if (retrieval.assigned.size !== FRONTMIND_VISUAL_FAMILIES_V3.length) {
        if (diagnostics.terminalReason === "matching_budget_exhausted") {
          throw new TwentyFirstProviderFailure(
            "VISUAL_MATCHING_BUDGET_EXHAUSTED",
            "视觉参考组合计算达到本次安全上限，请稍后重试。",
            "attention_required",
          );
        }
        if (diagnostics.terminalReason === "preview_failures") {
          if (
            nativeSourceMode &&
            (diagnostics.rejectedByReason.source ?? 0) > 0
          ) {
            throw new TwentyFirstProviderFailure(
              "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE",
              "部分 21st 候选未提供可安全编译的完整 React 源码，已跳过并完成深层检索；本次仍不足 9 个，请稍后重试。",
              "attention_required",
            );
          }
          throw new TwentyFirstProviderFailure(
            "VISUAL_PREVIEW_REFERENCES_UNAVAILABLE",
            "部分真实 Hero 参考暂时无法安全读取，请稍后重试。",
            "attention_required",
          );
        }
        throw new TwentyFirstProviderFailure(
          "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
          `FrontMind 当前仅找到 ${retrieval.assigned.size}/9 个可安全区分的真实 Hero 参考，请稍后重试。`,
          "attention_required",
        );
      }
      const degradedReasons: string[] = [];
      await assertCommitLeaseActive(assertLeaseActive);
      const rejectedPreviews = Object.values(
        diagnostics.rejectedByReason,
      ).reduce((sum, count) => sum + (count ?? 0), 0);
      if (rejectedPreviews > 0) {
        degradedReasons.push(`PREVIEW_RESULTS_REJECTED:${rejectedPreviews}`);
      }
      let mirroredCandidates: BoardCandidate[];
      let selectionBundle: VisualSelectionBundleV4 | VisualSelectionBundleV5;
      let selectionBuffer: Buffer;
      let selectionFilename: string;
      let selectionMimeType: string;
      let selectionMaxBytes: number;
      let expectedSelectionHash: string;
      if (nativeSourceMode) {
        stage = "render_native_previews";
        const nativeCandidates = await createNativeBoardCandidates({
          operation,
          context,
          inspirationByFamily: retrieval.assigned,
          preparedByProviderKey: retrieval.preparedNativeByProviderKey,
          persistArtifact,
        });
        mirroredCandidates = nativeCandidates;
        selectionBundle = visualSelectionBundleV5Schema.parse({
          schemaVersion: 5,
          renderer: "twenty_first_native_react_v1",
          queryPlanHash: canonicalSha256(retrieval.queries),
          searchTarget: retrieval.queries.reduce(
            (sum, query) => sum + query.limit,
            0,
          ),
          displayTarget: 9,
          candidates: nativeCandidates.map((item) => ({
            id: item.sampleId,
            label: item.optionLabel,
            queryAxis: item.queryAxis,
            providerItemId: item.providerItemId,
            providerItemKey: item.providerItemKey,
            providerVersion: item.providerVersion,
            title: item.title,
            description: item.description,
            author: item.author,
            sourceUrl: item.sourceUrl,
            visualEvidence: item.visualEvidence,
            referencePreviewLocalAssetId: item.referencePreviewLocalAssetId,
            referencePreviewSha256: item.referencePreviewSha256,
            referencePerceptualHash: item.referencePerceptualHash,
            previewLocalAssetId: item.previewLocalAssetId,
            previewSha256: item.previewSha256,
            taxonomy: item.taxonomy,
            score: item.score,
            rationale: item.rationale,
            sourceTreeSha256: item.sourceTreeSha256,
            sourceArchiveSha256: item.sourceArchiveSha256,
            sourceArchivePath: `candidates/${item.optionLabel}/source.zip`,
            entrypoint: item.entrypoint,
            demoEntrypoint: item.demoEntrypoint,
            sourceDirectory: "source",
          })),
          selectedCandidateId: null,
          delegated: false,
          degradedReasons: Array.from(new Set(degradedReasons)),
        });
        selectionBuffer = await createVisualSelectionBundleV5Artifact({
          bundle: selectionBundle,
          sourceArchives: new Map(
            nativeCandidates.map((candidate) => [
              candidate.sampleId,
              candidate.sourceArchive,
            ]),
          ),
        });
        selectionFilename = `visual-selection-${operation.id}.zip`;
        selectionMimeType = VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE;
        selectionMaxBytes = VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES;
        expectedSelectionHash = sha256Buffer(selectionBuffer);
      } else {
        stage = "render_host_previews";
        const frontMindCandidates = await createFrontMindBoardCandidates({
          operation,
          context,
          inspirationByFamily: retrieval.assigned,
          signal,
          renderCandidates,
          persistArtifact,
          diagnostics,
        });
        mirroredCandidates = frontMindCandidates;
        selectionBundle = visualSelectionBundleV4Schema.parse({
          schemaVersion: 4,
          queryPlanHash: canonicalSha256(retrieval.queries),
          searchTarget: retrieval.queries.reduce(
            (sum, query) => sum + query.limit,
            0,
          ),
          referenceTarget: 9,
          displayTarget: 9,
          candidates: frontMindCandidates.map((item) => ({
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
        selectionBuffer = Buffer.from(canonicalJson(selectionBundle), "utf8");
        selectionFilename = `visual-selection-${operation.id}.json`;
        selectionMimeType = "application/json";
        selectionMaxBytes = 1_000_000;
        expectedSelectionHash = canonicalSha256(selectionBundle);
      }
      await assertCommitLeaseActive(assertLeaseActive);
      stage = "persist_selection_bundle";
      const selectionBundleArtifact = await persistArtifact({
        userId: operation.userId,
        projectId: context.project.id,
        kind: "21st-selection-bundle",
        filename: selectionFilename,
        mimeType: selectionMimeType,
        buffer: selectionBuffer,
        maxBytes: selectionMaxBytes,
      });
      if (selectionBundleArtifact.contentSha256 !== expectedSelectionHash) {
        throw new TwentyFirstProviderFailure(
          "SELECTION_BUNDLE_HASH_MISMATCH",
          "视觉选择包写入校验失败。",
          "attention_required",
        );
      }
      await assertCommitLeaseActive(assertLeaseActive);
      stage = "persist_board";
      const board = await persistBoard(db, {
        operation,
        searchPlan,
        context,
        selectionBundle,
        selectionBundleArtifact,
        mirroredCandidates,
      });
      logSafeVisualStage({
        event: "visual_page_published",
        operationId: operation.id,
        projectId: operation.projectId,
        page: searchPlan.page,
        queryCalls: diagnostics.queryCalls,
        mirrorAttempts: diagnostics.mirrorAttempts,
        mirrorSucceeded: diagnostics.mirrorSucceeded,
        candidateCount: board.candidateCount,
        terminalReason: "complete",
        latencyMs: Date.now() - providerStartedAt,
      });
      return {
        status: "succeeded",
        projectStatus: "awaiting_visual_selection",
        result: {
          batchId: board.batchId,
          mode: searchPlan.mode,
          page: searchPlan.page,
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
      const failure = safeProviderFailure(error, stage, diagnostics, signal);
      console.error("[SiteOps21st] visual_search_failed", {
        operationId: operation.id,
        projectId: operation.projectId,
        stage,
        operationStatus: failure.status,
        errorCode: "code" in failure ? failure.code : "PROVIDER_ERROR",
      });
      return failure;
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
