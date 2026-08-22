import { randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
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
  composeTwentyFirstQueries,
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
  visualSelectionBundleV2Schema,
  type SiteBrief,
} from "../../shared/siteops";
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
import type {
  SiteOpsProviderHandler,
  SiteOpsProviderResult,
} from "./providers";

const OPERATION_MARKER_PREFIX = "siteops-21st-operation:";

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
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
};

type MirroredCandidate = MirroredReference & { optionLabel: string };

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
};

export type TwentyFirstBoardPersistenceInput = {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  selectionBundle: z.infer<typeof visualSelectionBundleV2Schema>;
  selectionBundleArtifact: PreviewArtifact;
  mirroredCandidates: MirroredCandidate[];
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
      "该操作不是有效的 21st 视觉检索任务。",
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

async function retrieveFunnel(input: {
  session: TwentyFirstReadOnlySession;
  brief: SiteBrief;
  signal: AbortSignal;
  diagnostics: VisualSearchDiagnostics;
}) {
  const queries = composeTwentyFirstQueries(input.brief);
  const searchEnvelopes: TwentyFirstSearchEnvelope[] = [];
  for (const query of queries) {
    if (input.signal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉检索已超时，请重置后重新开始。",
      );
    }
    const envelope: TwentyFirstSearchEnvelope = {
      role: query.role,
      axis: query.axis,
      limit: query.limit,
      payload: await input.session.search({
        query: query.query,
        type: "component",
        limit: query.limit,
      }),
    };
    searchEnvelopes.push(envelope);
    input.diagnostics.searchedByAxis[query.axis] =
      normalizeTwentyFirstSearchResults([envelope]).length;
  }
  const funnel = buildTwentyFirstSearchOnlyFunnel({ searchEnvelopes });
  input.diagnostics.normalizedUnique = funnel.searchedCandidates.length;
  input.diagnostics.shortlistCount = funnel.retrievalShortlist.length;
  input.diagnostics.withPreviewReference = funnel.searchedCandidates.filter(
    (candidate) => candidate.previewUrl,
  ).length;
  return { queries, funnel };
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
        "21st 预览图片格式不受支持。",
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
}) {
  const mirrored: MirroredReference[] = [];
  const seenPreviewHashes = new Set<string>();
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
          return { candidate, preview } as const;
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
      const { candidate, preview } = downloadedItem;
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
          providerItemKey: item.candidate.providerItemKey,
          queryAxis: item.candidate.queryAxis,
          title: item.candidate.title,
          description: item.candidate.description,
          author: item.candidate.author,
          sourceUrl: item.candidate.sourceUrl,
          visualEvidence: item.visualEvidence,
          taxonomy: {
            ...item.taxonomy,
            scoreAxes: item.candidate.scoreBreakdown,
          },
          score: item.candidate.score,
          rationale: item.candidate.rationale,
        },
        label: item.optionLabel,
        note: item.candidate.title,
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
        input.mirroredCandidates.length === 9
          ? "已准备 9 个真实视觉方向，请选择 A–I，或明确委托 AI 选择最高分。"
          : `当前目录可用 ${input.mirroredCandidates.length} 个真实视觉方向，已按实际结果展示，未使用假图补齐。`,
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
            targets: [18, 12, 9],
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
      message: "21st 目录工具参数协议暂不兼容，请稍后重试。",
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
          ? "21st API Key 无效，或当前连接缺少必要的只读目录能力。"
          : "21st 目录服务暂时不可用，请稍后重试。",
      result: diagnostics,
    };
  }
  if (stage === "mcp_retrieval") {
    return {
      status: "attention_required",
      code: "MCP_UNAVAILABLE",
      message: "21st 目录服务暂时不可用，请稍后重试。",
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
          "该视觉检索固定的 21st API Key 版本不可用。",
          "attention_required",
        );
      }
      activeApiKey = credential.apiKey;
      stage = "mcp_retrieval";
      const { queries, funnel } = await client.withReadOnlySession(
        credential.apiKey,
        (session) =>
          retrieveFunnel({
            session,
            brief: context.brief,
            signal,
            diagnostics,
          }),
        { signal },
      );
      if (diagnostics.normalizedUnique === 0) {
        throw new TwentyFirstProviderFailure(
          "MCP_SEARCH_EMPTY",
          "21st 本轮没有返回可解析的真实目录结果。",
        );
      }
      if (diagnostics.withPreviewReference === 0) {
        throw new TwentyFirstProviderFailure(
          "NO_SAFE_PREVIEW_REFERENCES",
          "21st 本轮目录结果没有可安全读取的 HTTPS 视觉预览。",
        );
      }
      stage = "mirror_previews";
      const mirrored = await mirrorCandidates({
        operation,
        context,
        candidates: funnel.retrievalShortlist,
        signal,
        fetchPreview,
        persistArtifact,
        diagnostics,
      });
      if (mirrored.length === 0) {
        throw new TwentyFirstProviderFailure(
          "PREVIEW_MIRROR_FAILED",
          "21st 返回了真实预览，但本轮下载、解码或安全保存均未成功。",
        );
      }
      const foundation = mirrored.filter(
        (item) => item.candidate.queryRole === "foundation",
      );
      const nonFoundation = mirrored.filter(
        (item) => item.candidate.queryRole !== "foundation",
      );
      const displayReferences = [...foundation, ...nonFoundation].slice(0, 9);
      const mirroredCandidates: MirroredCandidate[] = displayReferences.map(
        (item, index) => ({
          ...item,
          optionLabel: String.fromCharCode(65 + index),
        }),
      );
      const displayedIds = new Set(
        displayReferences.map((item) => item.candidate.providerItemKey),
      );
      const supportingReferences = nonFoundation
        .filter((item) => !displayedIds.has(item.candidate.providerItemKey))
        .slice(0, 2);
      const degradedReasons = funnel.degradedReasons.filter(
        (reason) => !reason.startsWith("PRESENTATION_RESULTS_INSUFFICIENT:"),
      );
      const rejectedPreviews = Object.values(
        diagnostics.rejectedByReason,
      ).reduce((sum, count) => sum + (count ?? 0), 0);
      if (rejectedPreviews > 0) {
        degradedReasons.push(`PREVIEW_RESULTS_REJECTED:${rejectedPreviews}`);
      }
      if (mirroredCandidates.length < 9) {
        degradedReasons.push(
          `PRESENTATION_RESULTS_INSUFFICIENT:${mirroredCandidates.length}/9`,
        );
      }
      stage = "persist_selection_bundle";
      const selectionBundle = visualSelectionBundleV2Schema.parse({
        schemaVersion: 2,
        queryPlanHash: canonicalSha256(queries),
        searchTarget: 18,
        shortlistTarget: 12,
        displayTarget: 9,
        candidates: mirroredCandidates.map((item) => ({
          id: item.sampleId,
          label: item.optionLabel,
          queryAxis: item.candidate.queryAxis,
          providerItemKey: item.candidate.providerItemKey,
          title: item.candidate.title,
          description: item.candidate.description,
          author: item.candidate.author,
          sourceUrl: item.candidate.sourceUrl,
          visualEvidence: item.visualEvidence,
          previewLocalAssetId: item.previewLocalAssetId,
          previewSha256: item.previewSha256,
          taxonomy: item.taxonomy,
          score: item.candidate.score,
          rationale: item.candidate.rationale,
        })),
        supportingCandidates: supportingReferences.map((item) => ({
          id: item.sampleId,
          queryAxis: item.candidate.queryAxis,
          providerItemKey: item.candidate.providerItemKey,
          title: item.candidate.title,
          description: item.candidate.description,
          author: item.candidate.author,
          sourceUrl: item.candidate.sourceUrl,
          visualEvidence: item.visualEvidence,
          previewLocalAssetId: item.previewLocalAssetId,
          previewSha256: item.previewSha256,
          taxonomy: item.taxonomy,
          score: item.candidate.score,
          rationale: item.candidate.rationale,
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
            searched: funnel.actual.searched,
            shortlisted: funnel.actual.shortlisted,
            mirrored: diagnostics.mirrorSucceeded,
            presented: mirroredCandidates.length,
          },
          diagnostics,
          degradedReasons: selectionBundle.degradedReasons,
        },
        message:
          mirroredCandidates.length === 9
            ? "9 个真实视觉方向已准备完成，请选择 A–I。"
            : `${mirroredCandidates.length} 个真实视觉方向已按实际可用结果展示。`,
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
