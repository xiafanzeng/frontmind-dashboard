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
  buildTwentyFirstVisualFunnel,
  composeTwentyFirstQueries,
  normalizeTwentyFirstDetail,
  normalizeTwentyFirstSearchResults,
  type NormalizedTwentyFirstCandidate,
  type SafeVisualDirective,
  type TwentyFirstDetailEnvelope,
  type TwentyFirstQueryRole,
  type TwentyFirstSearchEnvelope,
} from "../../shared/siteops-workflow";
import {
  siteBriefSchema,
  visualSelectionBundleSchema,
  type SiteBrief,
} from "../../shared/siteops";
import { AuthServiceError } from "../auth-service";
import { getDb } from "../db";
import {
  TwentyFirstClient,
  getTwentyFirstCredentialById,
  type TwentyFirstReadOnlySession,
} from "../twenty-first-service";
import { persistSiteOpsArtifact } from "./artifact-store";
import { registerSiteOpsProviderHandler } from "./providers";
import { fetchSafeVisualPreview } from "./remote-preview";
import type { SiteOpsProviderHandler, SiteOpsProviderResult } from "./providers";

const visualSearchOperationInputSchema = z
  .object({
    knowledgeSnapshotId: z.string().uuid(),
    credentialId: z.string().uuid(),
    credentialVersion: z.number().int().positive(),
    workflowVersion: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

const SEARCH_LIMITS: Readonly<Record<TwentyFirstQueryRole, number>> = {
  foundation: 10,
  section: 6,
  motion: 2,
};

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

type MirroredCandidate = {
  sampleId: string;
  optionLabel: string;
  candidate: NormalizedTwentyFirstCandidate;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  previewLocalAssetId: string;
  previewSha256: string;
};

export type TwentyFirstBoardPersistenceInput = {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  selectionBundle: z.infer<typeof visualSelectionBundleSchema>;
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
) {
  const values = (prefixes: readonly string[]) =>
    directives
      .filter((directive) =>
        prefixes.some((prefix) => directive.startsWith(`${prefix}:`)),
      )
      .map((directive) => directive.slice(directive.indexOf(":") + 1));
  return {
    role,
    palette: values(["color"]),
    typography: values(["typography"]),
    layout: values(["structure", "surface", "imagery", "tone"]),
    motion: values(["motion"]),
    accessibility: values(["responsive"]).concat(
      directives.includes("motion:reduced-motion-required")
        ? ["reduced-motion-required"]
        : [],
    ),
  };
}

function safeSearchEnvelopes(
  envelopes: readonly TwentyFirstSearchEnvelope[],
): TwentyFirstSearchEnvelope[] {
  const candidates = normalizeTwentyFirstSearchResults(envelopes);
  const sources = new Set<string>();
  const previews = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (
        !/^[A-Za-z0-9._-]{1,512}$/u.test(candidate.providerItemId) ||
        /^21st_sk_/iu.test(candidate.providerItemId)
      ) {
        return false;
      }
      if (!candidate.previewUrl) return false;
      if (sources.has(candidate.sourceUrl) || previews.has(candidate.previewUrl)) {
        return false;
      }
      sources.add(candidate.sourceUrl);
      previews.add(candidate.previewUrl);
      return true;
    })
    .map((candidate) => ({
      role: candidate.queryRole,
      payload: {
        results: [
          {
            id: candidate.providerItemId,
            title: candidate.title,
            author: candidate.author,
            sourceUrl: candidate.sourceUrl,
            previewUrl: candidate.previewUrl,
            dependencies: candidate.dependencies,
          },
        ],
      },
    }));
}

async function retrieveFunnel(input: {
  session: TwentyFirstReadOnlySession;
  brief: SiteBrief;
}) {
  const queries = composeTwentyFirstQueries(input.brief);
  const rawSearchEnvelopes: TwentyFirstSearchEnvelope[] = [];
  for (const query of queries) {
    rawSearchEnvelopes.push({
      role: query.role,
      payload: await input.session.search(query.query, SEARCH_LIMITS[query.role]),
    });
  }
  const searchEnvelopes = safeSearchEnvelopes(rawSearchEnvelopes);
  const searchItems = normalizeTwentyFirstSearchResults(searchEnvelopes);
  const details: TwentyFirstDetailEnvelope[] = [];
  let rejectedDetails = 0;
  for (const searchItem of searchItems) {
    const detail: TwentyFirstDetailEnvelope = {
      operation: "get_component",
      requestedProviderItemId: searchItem.providerItemId,
      payload: await input.session.getComponent(searchItem.providerItemId),
    };
    try {
      const normalized = normalizeTwentyFirstDetail({ searchItem, detail });
      if (!normalized) {
        rejectedDetails += 1;
        continue;
      }
      details.push(detail);
      if (details.length >= 12) break;
    } catch {
      rejectedDetails += 1;
    }
  }
  const funnel = buildTwentyFirstVisualFunnel({ searchEnvelopes, details });
  if (rejectedDetails > 0) {
    funnel.degradedReasons.push(`DETAIL_RESULTS_REJECTED:${rejectedDetails}`);
  }
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

async function mirrorCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  candidates: NormalizedTwentyFirstCandidate[];
  signal: AbortSignal;
  fetchPreview: typeof fetchSafeVisualPreview;
  persistArtifact: typeof persistSiteOpsArtifact;
}) {
  const mirrored: MirroredCandidate[] = [];
  let rejectedPreviews = 0;
  for (const candidate of input.candidates) {
    if (mirrored.length >= 9) break;
    if (!candidate.previewUrl) continue;
    try {
      const preview = await input.fetchPreview({
        url: candidate.previewUrl,
        signal: input.signal,
      });
      const asset = await input.persistArtifact({
        userId: input.operation.userId,
        projectId: input.context.project.id,
        kind: "21st-visual-preview",
        filename: `21st-${candidate.candidateId.slice(0, 120)}.${extensionForMimeType(preview.mimeType)}`,
        mimeType: preview.mimeType,
        buffer: preview.buffer,
        maxBytes: 5 * 1024 * 1024,
      });
      if (asset.contentSha256 !== preview.sha256) {
        throw new Error("PREVIEW_ARTIFACT_HASH_MISMATCH");
      }
      mirrored.push({
        sampleId: randomUUID(),
        optionLabel: String.fromCharCode(65 + mirrored.length),
        candidate,
        taxonomy: taxonomyFromDirectives(
          candidate.queryRole,
          candidate.normalizedDirectives,
        ),
        previewLocalAssetId: asset.id,
        previewSha256: preview.sha256,
      });
    } catch {
      rejectedPreviews += 1;
    }
  }
  return { mirrored, rejectedPreviews };
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
          providerItemId: item.candidate.providerItemId,
          promptSha256: item.candidate.promptSha256,
          responseSha256: item.candidate.responseSha256,
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

function safeProviderFailure(error: unknown): SiteOpsProviderResult {
  if (error instanceof TwentyFirstProviderFailure) {
    return { status: error.status, code: error.code, message: error.message };
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
    };
  }
  return {
    status: "attention_required",
    code: "VISUAL_SEARCH_PERSISTENCE_FAILED",
    message: "视觉方向未能安全保存，请稍后重试。",
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
    try {
      const db = await dbGetter();
      if (!db) {
        throw new TwentyFirstProviderFailure(
          "DATABASE_UNAVAILABLE",
          "AI 建站服务暂时不可用。",
          "attention_required",
        );
      }
      const parsedInput = visualSearchOperationInputSchema.parse(
        operation.input,
      );
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
      const credential = await getCredential(parsedInput.credentialId);
      if (!credential || credential.version !== parsedInput.credentialVersion) {
        throw new TwentyFirstProviderFailure(
          "PINNED_CREDENTIAL_UNAVAILABLE",
          "该视觉检索固定的 21st API Key 版本不可用。",
          "attention_required",
        );
      }
      const { queries, funnel } = await client.withReadOnlySession(
        credential.apiKey,
        (session) => retrieveFunnel({ session, brief: context.brief }),
        { signal },
      );
      const foundationCandidates = funnel.retrievalShortlist
        .filter(
          (candidate) =>
            candidate.queryRole === "foundation" && candidate.previewUrl,
        )
        .sort(
          (left, right) =>
            right.score - left.score || left.searchRank - right.searchRank,
        );
      const { mirrored, rejectedPreviews } = await mirrorCandidates({
        operation,
        context,
        candidates: foundationCandidates,
        signal,
        fetchPreview,
        persistArtifact,
      });
      if (mirrored.length === 0) {
        throw new TwentyFirstProviderFailure(
          "ZERO_VISUAL_CANDIDATES",
          "21st 本轮没有可安全展示的真实视觉候选；未生成假图补位。",
        );
      }
      const degradedReasons = funnel.degradedReasons.filter(
        (reason) => !reason.startsWith("PRESENTATION_RESULTS_INSUFFICIENT:"),
      );
      if (rejectedPreviews > 0) {
        degradedReasons.push(`PREVIEW_RESULTS_REJECTED:${rejectedPreviews}`);
      }
      if (mirrored.length < 9) {
        degradedReasons.push(
          `PRESENTATION_RESULTS_INSUFFICIENT:${mirrored.length}/9`,
        );
      }
      const selectionBundle = visualSelectionBundleSchema.parse({
        queryHash: canonicalSha256(queries),
        searchTarget: 18,
        detailTarget: 12,
        displayTarget: 9,
        candidates: mirrored.map((item) => ({
          id: item.sampleId,
          label: item.optionLabel,
          providerItemId: item.candidate.providerItemId,
          promptSha256: item.candidate.promptSha256,
          responseSha256: item.candidate.responseSha256,
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
      const selectionBuffer = Buffer.from(canonicalJson(selectionBundle), "utf8");
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
      const board = await persistBoard(db, {
        operation,
        context,
        selectionBundle,
        selectionBundleArtifact,
        mirroredCandidates: mirrored,
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
            promptRetrieved: funnel.actual.promptRetrieved,
            presented: mirrored.length,
          },
          degradedReasons: selectionBundle.degradedReasons,
        },
        message:
          mirrored.length === 9
            ? "9 个真实视觉方向已准备完成，请选择 A–I。"
            : `${mirrored.length} 个真实视觉方向已按实际可用结果展示。`,
      };
    } catch (error) {
      return safeProviderFailure(error);
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
