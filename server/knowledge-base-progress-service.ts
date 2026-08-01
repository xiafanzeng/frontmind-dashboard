import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";

import {
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import type {
  KnowledgeBaseBuildStatus,
  KnowledgeBaseProgressDto,
  KnowledgeBaseProgressLeafDto,
} from "../shared/knowledge-base-progress";
import {
  stripKnowledgeBaseProtocolPayloads,
  stripKnowledgeBaseReferenceAppendix,
} from "../shared/knowledge-base-output";
import { AuthServiceError } from "./auth-service";
import { getDb } from "./db";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
} from "./knowledge-base-artifact";
import { customerFormalContentViolation } from "./knowledge-customer-content";
import {
  KnowledgeBaseProgressError,
  applyKnowledgeBaseProgressEnvelope,
  assertKnowledgeBasePresentationMatchesState,
  assertKnowledgeBaseReadyForPackage,
  canPackageKnowledgeBase,
  createKnowledgeBaseProgressState,
  getKnowledgeBaseProgressSummary,
  parseKnowledgeBaseManifestEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBaseReopenEnvelope,
  type KnowledgeBaseLeafStatus,
  type KnowledgeBasePresentationEnvelope,
  type KnowledgeBaseProgressState,
} from "./knowledge-base-progress";

export type KnowledgeBaseUserAction =
  | "initial"
  | "confirm"
  | "direct_prefill"
  | "revise";

export class KnowledgeBaseBuildError extends Error {
  constructor(
    public readonly code:
      | "BUILD_NOT_FOUND"
      | "PROGRESS_PROTOCOL_INVALID"
      | "PUBLISH_BLOCKED",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseBuildError";
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function normalizeConversationId(value: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 191) {
    throw new KnowledgeBaseBuildError("BUILD_NOT_FOUND", "知识库对话标识无效");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function collectKnowledgeBaseOutputImageKeys(
  value: unknown,
  result = new Set<string>(),
  depth = 0,
) {
  if (value === null || value === undefined || depth > 50) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKnowledgeBaseOutputImageKeys(item, result, depth + 1);
    }
    return result;
  }
  if (!isRecord(value)) return result;

  const type = stringValue(value.type).toLowerCase();
  const mimeType = stringValue(
    value.mimeType || value.mime_type || value.content_type,
  ).toLowerCase();
  const fileName = stringValue(
    value.fileName || value.file_name || value.filename || value.name,
  );
  const resourceId = stringValue(value.fileId || value.file_id);
  const resourceUrl = stringValue(
    value.fileUrl ||
      value.file_url ||
      value.imageUrl ||
      value.image_url ||
      value.url,
  );
  const isImage =
    type === "output_image" ||
    type === "image" ||
    mimeType.startsWith("image/") ||
    /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(fileName);
  if (isImage && (resourceId || resourceUrl)) {
    result.add(resourceId || resourceUrl);
  }

  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      collectKnowledgeBaseOutputImageKeys(item, result, depth + 1);
    }
  }
  return result;
}

/**
 * Return every usable alias carried by an image descriptor. Some upstream
 * versions provide both a durable file ID and a signed CDN URL for one image;
 * counting still uses one preferred key, while download authorization must
 * recognize both aliases.
 */
export function collectKnowledgeBaseOutputImageResourceAliases(
  value: unknown,
  result = new Set<string>(),
  depth = 0,
) {
  if (value === null || value === undefined || depth > 50) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKnowledgeBaseOutputImageResourceAliases(item, result, depth + 1);
    }
    return result;
  }
  if (!isRecord(value)) return result;

  const type = stringValue(value.type).toLowerCase();
  const mimeType = stringValue(
    value.mimeType || value.mime_type || value.content_type,
  ).toLowerCase();
  const fileName = stringValue(
    value.fileName || value.file_name || value.filename || value.name,
  );
  const resourceId = stringValue(value.fileId || value.file_id);
  const resourceUrl = stringValue(
    value.fileUrl ||
      value.file_url ||
      value.imageUrl ||
      value.image_url ||
      value.url,
  );
  const isImage =
    type === "output_image" ||
    type === "image" ||
    mimeType.startsWith("image/") ||
    /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(fileName);
  if (isImage) {
    if (resourceId) result.add(resourceId);
    if (resourceUrl) result.add(resourceUrl);
  }

  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      collectKnowledgeBaseOutputImageResourceAliases(item, result, depth + 1);
    }
  }
  return result;
}

export function latestKnowledgeBasePresentationOutput(output: unknown) {
  if (!Array.isArray(output)) return output;
  const assistantIndexes = output.flatMap((item, index) =>
    extractFinalKnowledgeBaseAssistantText([item]) ? [index] : [],
  );
  if (assistantIndexes.length === 0) return output;
  const presentationIndex =
    [...assistantIndexes]
      .reverse()
      .find((index) =>
        extractFinalKnowledgeBaseAssistantText([output[index]]).includes(
          "FRONTMIND_KB_PRESENTATION",
        ),
      ) ?? assistantIndexes[assistantIndexes.length - 1]!;
  return output.slice(presentationIndex);
}

export function assertKnowledgeBaseNodeImageDelivery(input: {
  presentation: KnowledgeBasePresentationEnvelope;
  output: unknown;
}) {
  const { presentation } = input;
  if (
    presentation.imageState === undefined ||
    presentation.assetIds === undefined ||
    presentation.imageCount === undefined
  ) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "当前节点缺少图片交付声明，本轮未推进",
    );
  }

  const actualImageCount = collectKnowledgeBaseOutputImageKeys(
    latestKnowledgeBasePresentationOutput(input.output),
  ).size;
  if (presentation.leafId === null) {
    if (
      presentation.imageState !== "not_applicable" ||
      presentation.assetIds.length !== 0 ||
      presentation.imageCount !== 0 ||
      actualImageCount !== 0
    ) {
      throw new KnowledgeBaseBuildError(
        "PROGRESS_PROTOCOL_INVALID",
        "知识库已完成，本轮图片交付声明必须为 not_applicable",
      );
    }
    return;
  }

  if (
    presentation.imageState !== "no_eligible_asset" ||
    presentation.assetIds.length !== 0 ||
    presentation.imageCount !== 0 ||
    actualImageCount !== 0
  ) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "图片只允许在首轮第一个节点展示；后续节点必须声明 no_eligible_asset 且不得返回图片附件",
    );
  }
}

export function assertKnowledgeBaseInitialImageDelivery(output: unknown) {
  const imageCount = collectKnowledgeBaseOutputImageKeys(
    latestKnowledgeBasePresentationOutput(output),
  ).size;
  if (imageCount !== 3) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      `首个知识节点必须展示恰好三张互不重复的经典企业图片，实际返回 ${imageCount} 张`,
    );
  }
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && typeof value.value === "string") {
    return value.value.trim();
  }
  return "";
}

function typedKnowledgeAssistantMessageText(value: unknown) {
  if (!isRecord(value) || value.role !== "assistant") return "";
  const type =
    typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  if (
    type &&
    !["message", "output_message", "output_text", "text"].includes(type)
  ) {
    return "";
  }

  const parts: string[] = [];
  for (const candidate of [
    value.output_text,
    value.text,
    typeof value.content === "string" ? value.content : undefined,
  ]) {
    const text = stringValue(candidate);
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (Array.isArray(value.content)) {
    for (const rawContent of value.content) {
      if (typeof rawContent === "string") {
        const text = rawContent.trim();
        if (text && !parts.includes(text)) parts.push(text);
        continue;
      }
      if (!isRecord(rawContent)) continue;
      const contentType =
        typeof rawContent.type === "string"
          ? rawContent.type.trim().toLowerCase()
          : "";
      if (!["output_text", "text", "message", ""].includes(contentType)) {
        continue;
      }
      const text = stringValue(
        rawContent.text ?? rawContent.output_text ?? rawContent.value,
      );
      if (text && !parts.includes(text)) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Only the final typed assistant message may drive the authoritative knowledge
 * state machine. User, reasoning, tool and role-less provider records are
 * deliberately excluded even when they contain a valid-looking envelope.
 */
export function extractFinalKnowledgeBaseAssistantText(
  output: unknown,
): string {
  if (!Array.isArray(output)) return "";
  const messages = output
    .map(typedKnowledgeAssistantMessageText)
    .filter((message) => Boolean(message));
  return (messages[messages.length - 1] || "").slice(-4_000_000);
}

export function assertKnowledgeBaseCustomerOutput(output: unknown) {
  const text = extractFinalKnowledgeBaseAssistantText(output);
  const customerVisibleText = stripKnowledgeBaseReferenceAppendix(
    stripKnowledgeBaseProtocolPayloads(text),
  );
  const violation = customerFormalContentViolation(customerVisibleText);
  if (violation) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      `客户可见知识库回复包含核验过程、建议或内部推理：${violation}`,
    );
  }
  return text;
}

function reconciliationHash(input: {
  output: unknown;
  userText: string;
  attachmentCount: number;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        output: input.output,
        userText: input.userText,
        attachmentCount: input.attachmentCount,
      }),
    )
    .digest("hex");
}

function modelOutputAudit(text: string) {
  const auditMarkdown = stripKnowledgeBaseProtocolPayloads(text)
    .trim()
    .slice(-2_000_000);
  const contentMarkdown =
    stripKnowledgeBaseReferenceAppendix(auditMarkdown).slice(-2_000_000);
  const sourceUrls = Array.from(
    new Set(auditMarkdown.match(/https?:\/\/[^\s<>)\]"']+/gi) || []),
  ).slice(0, 500);
  const imageUrls = Array.from(
    new Set(
      [
        ...Array.from(
          auditMarkdown.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi),
          (match) => match[1],
        ),
        ...sourceUrls.filter((url) =>
          /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(url),
        ),
      ].filter(Boolean),
    ),
  ).slice(0, 500);
  return { contentMarkdown, sourceUrls, imageUrls };
}

function mergeAuditUrls(existing: string[] | null, incoming: string[]) {
  return Array.from(new Set([...(existing || []), ...incoming])).slice(0, 500);
}

export function classifyKnowledgeBaseUserAction(
  userText: string,
  attachmentCount = 0,
): KnowledgeBaseUserAction {
  const normalized = String(userText || "")
    .normalize("NFKC")
    .trim()
    .replace(/[。！!]+$/g, "")
    .trim()
    .toLowerCase();
  if (attachmentCount > 0) return "revise";
  if (!normalized) return "initial";
  if (/^(确认|确认无误|无误|没问题|可以|通过|采用|ok|okay)$/.test(normalized)) {
    return "confirm";
  }
  if (
    /^(跳过|直接预填|采用预填|保留预填|按预填继续|使用预填)$/.test(normalized)
  ) {
    return "direct_prefill";
  }
  return "revise";
}

export function isAmbiguousKnowledgeBaseAdvance(userText: string) {
  const normalized = String(userText || "")
    .normalize("NFKC")
    .trim()
    .replace(/[。！!]+$/g, "")
    .trim()
    .toLowerCase();
  return /^(继续|下一步|下一个|继续吧|请继续|next)$/.test(normalized);
}

function stateFromRows(
  build: KnowledgeBaseBuild,
  rows: KnowledgeBaseBuildNode[],
): KnowledgeBaseProgressState {
  return {
    schemaVersion: 1,
    revision: build.revision,
    currentLeafId: build.currentLeafId,
    leaves: rows.map((row) => ({
      id: row.leafId,
      title: row.title,
      branchId: row.branchId,
      branchTitle: row.branchTitle,
      status: row.status as KnowledgeBaseLeafStatus,
    })),
  };
}

function buildDto(
  build: KnowledgeBaseBuild,
  rows: KnowledgeBaseBuildNode[],
): KnowledgeBaseProgressDto {
  const leaves: KnowledgeBaseProgressLeafDto[] = rows.map((row) => ({
    id: row.leafId,
    title: row.title,
    branchId: row.branchId,
    branchTitle: row.branchTitle,
    ordinal: row.ordinal,
    status: row.status,
  }));
  const branchMap = new Map<
    string,
    KnowledgeBaseProgressDto["branches"][number]
  >();
  for (const leaf of leaves) {
    let branch = branchMap.get(leaf.branchId);
    if (!branch) {
      branch = {
        id: leaf.branchId,
        title: leaf.branchTitle,
        total: 0,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 0,
        current: 0,
        needsVerification: 0,
        leaves: [],
      };
      branchMap.set(leaf.branchId, branch);
    }
    branch.total += 1;
    branch.leaves.push(leaf);
    if (leaf.status === "confirmed") {
      branch.confirmed += 1;
      branch.handled += 1;
    } else if (leaf.status === "direct_prefilled") {
      branch.directPrefilled += 1;
      branch.handled += 1;
    } else if (leaf.status === "current") {
      branch.current += 1;
    } else if (leaf.status === "needs_verification") {
      branch.needsVerification += 1;
    } else {
      branch.pending += 1;
    }
  }
  const confirmed = leaves.filter((leaf) => leaf.status === "confirmed").length;
  const directPrefilled = leaves.filter(
    (leaf) => leaf.status === "direct_prefilled",
  ).length;
  const pending = leaves.filter((leaf) => leaf.status === "pending").length;
  const current = leaves.filter((leaf) => leaf.status === "current").length;
  const needsVerification = leaves.filter(
    (leaf) => leaf.status === "needs_verification",
  ).length;
  const handled = confirmed + directPrefilled;
  const total = leaves.length;
  return {
    build: {
      id: build.id,
      conversationId: build.conversationId,
      companyName: build.companyName,
      skillVersion: build.skillVersion,
      status: build.status as KnowledgeBaseBuildStatus,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      protocolError: build.protocolError,
      awaitingResponseSince: build.awaitingResponseSince?.getTime() ?? null,
      updatedAt: build.updatedAt.getTime(),
    },
    summary: {
      total,
      handled,
      confirmed,
      directPrefilled,
      pending,
      current,
      needsVerification,
      overallPercent: total === 0 ? 0 : Math.round((handled / total) * 100),
    },
    branches: [...branchMap.values()],
    packageAllowed:
      total > 0 &&
      handled === total &&
      build.currentLeafId === null &&
      build.status === "ready_to_publish" &&
      build.packageRevision === build.revision &&
      build.packageTaskId === build.upstreamTaskId &&
      Boolean(build.packageOutputItemId) &&
      Boolean(build.packageDescriptorHash),
  };
}

async function loadBuild(
  executor: any,
  userId: number,
  conversationId: string,
  lock = false,
) {
  let query = executor
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const rows = await query;
  return rows[0] as KnowledgeBaseBuild | undefined;
}

async function loadNodes(executor: any, buildId: string) {
  return (await executor
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, buildId))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal))) as KnowledgeBaseBuildNode[];
}

export async function createKnowledgeBaseBuild(input: {
  userId: number;
  conversationId: string;
  companyName: string;
  companyWebsite?: string;
  skillName?: string;
  skillVersion?: string;
  skillContentHash?: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const companyName = String(input.companyName || "")
    .trim()
    .slice(0, 255);
  if (!companyName) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "企业名称不能为空",
    );
  }
  const build = await db.transaction(async (tx) => {
    const existing = await loadBuild(tx, input.userId, conversationId, true);
    if (existing) {
      await tx
        .delete(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, existing.id));
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          companyName,
          companyWebsite: input.companyWebsite?.trim() || null,
          skillName: input.skillName || "socratic-kb-builder",
          skillVersion: input.skillVersion || "1",
          skillContentHash: input.skillContentHash || null,
          upstreamTaskId: null,
          status: "researching",
          revision: 0,
          currentLeafId: null,
          totalNodeCount: 0,
          confirmedCount: 0,
          directPrefilledCount: 0,
          needsVerificationCount: 0,
          lastReconciledHash: null,
          lastOutputLength: 0,
          lastOutputItemIds: [],
          lastTurnUserText: null,
          lastTurnAttachmentCount: 0,
          awaitingResponseSince: new Date(),
          packageRevision: null,
          packageTaskId: null,
          packageOutputItemId: null,
          packageFileId: null,
          packageFilename: null,
          packageDescriptorHash: null,
          protocolError: null,
          publishedSnapshotId: null,
          completedAt: null,
          publishedAt: null,
        })
        .where(eq(knowledgeBaseBuilds.id, existing.id));
      return (await loadBuild(tx, input.userId, conversationId))!;
    }
    const id = randomUUID();
    await tx.insert(knowledgeBaseBuilds).values({
      id,
      userId: input.userId,
      conversationId,
      companyName,
      companyWebsite: input.companyWebsite?.trim() || null,
      skillName: input.skillName || "socratic-kb-builder",
      skillVersion: input.skillVersion || "1",
      skillContentHash: input.skillContentHash || null,
      status: "researching",
      awaitingResponseSince: new Date(),
    });
    return (await loadBuild(tx, input.userId, conversationId))!;
  });
  return buildDto(build, []);
}

export async function attachKnowledgeBaseBuildTask(input: {
  userId: number;
  conversationId: string;
  taskId: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  await db
    .update(knowledgeBaseBuilds)
    .set({ upstreamTaskId: String(input.taskId).slice(0, 255) })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    );
}

export async function recordKnowledgeBaseTurn(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  userText: string;
  attachmentCount: number;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const result = await db
    .update(knowledgeBaseBuilds)
    .set({
      upstreamTaskId: String(input.taskId).slice(0, 255),
      lastTurnUserText: String(input.userText || "").slice(0, 2_000_000),
      lastTurnAttachmentCount: Math.max(
        0,
        Math.trunc(input.attachmentCount || 0),
      ),
      awaitingResponseSince: new Date(),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    );
  if (!result[0]?.affectedRows) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
}

/**
 * Atomically locks one customer turn before the non-idempotent upstream task
 * call. This closes the server-side double-click race in addition to the UI
 * lock.
 */
export async function claimKnowledgeBaseTurn(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  userText: string;
  attachmentCount: number;
  expectedRevision?: number;
  expectedLeafId?: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const result = await db
    .update(knowledgeBaseBuilds)
    .set({
      lastTurnUserText: String(input.userText || "").slice(0, 2_000_000),
      lastTurnAttachmentCount: Math.max(
        0,
        Math.trunc(input.attachmentCount || 0),
      ),
      awaitingResponseSince: new Date(),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        eq(knowledgeBaseBuilds.status, "confirming"),
        isNotNull(knowledgeBaseBuilds.currentLeafId),
        isNull(knowledgeBaseBuilds.awaitingResponseSince),
        input.expectedRevision === undefined
          ? undefined
          : eq(knowledgeBaseBuilds.revision, input.expectedRevision),
        input.expectedLeafId
          ? eq(knowledgeBaseBuilds.currentLeafId, input.expectedLeafId)
          : undefined,
      ),
    );
  if (!result[0]?.affectedRows) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "当前节点已提交或尚未进入可回复状态，请等待本轮处理完成",
    );
  }
}

export async function releaseKnowledgeBaseTurnClaim(input: {
  userId: number;
  conversationId: string;
  taskId: string;
}) {
  const db = await requireDb();
  await db
    .update(knowledgeBaseBuilds)
    .set({
      awaitingResponseSince: null,
      lastTurnUserText: null,
      lastTurnAttachmentCount: 0,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(
          knowledgeBaseBuilds.conversationId,
          normalizeConversationId(input.conversationId),
        ),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        isNotNull(knowledgeBaseBuilds.awaitingResponseSince),
      ),
    );
}

export async function assertKnowledgeBaseTaskBinding(input: {
  userId: number;
  conversationId: string;
  taskId: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const build = await loadBuild(db, input.userId, conversationId);
  if (!build) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
  if (!build.upstreamTaskId || build.upstreamTaskId !== input.taskId) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "任务与当前知识库构建记录不匹配",
    );
  }
  return build;
}

export async function getKnowledgeBaseProgress(input: {
  userId: number;
  conversationId?: string;
}): Promise<KnowledgeBaseProgressDto | null> {
  const db = await requireDb();
  const buildRows = input.conversationId
    ? await db
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(
              knowledgeBaseBuilds.conversationId,
              normalizeConversationId(input.conversationId),
            ),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(knowledgeBaseBuilds)
        .where(eq(knowledgeBaseBuilds.userId, input.userId))
        .orderBy(desc(knowledgeBaseBuilds.updatedAt))
        .limit(1);
  const build = buildRows[0];
  if (!build) return null;
  return buildDto(build, await loadNodes(db, build.id));
}

function assertActionMatchesTransition(
  action: KnowledgeBaseUserAction,
  target: "confirmed" | "direct_prefilled" | "needs_verification",
) {
  const expected =
    action === "confirm"
      ? "confirmed"
      : action === "direct_prefill"
        ? "direct_prefilled"
        : "needs_verification";
  if (target !== expected) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      action === "revise"
        ? "当前回复属于补充或修订，节点必须继续停留在对话中等待明确确认"
        : "智能体返回的节点状态与用户本轮选择不一致，本轮未推进",
    );
  }
}

function friendlyProtocolError(error: unknown) {
  if (error instanceof KnowledgeBaseBuildError) return error.message;
  if (error instanceof KnowledgeBaseProgressError) {
    if (error.code === "INVALID_MANIFEST") {
      return "知识树信息尚不完整，请在对话中继续补充或重试本轮";
    }
    if (error.code === "STALE_REVISION") {
      return "本轮内容已处理，无需重复更新";
    }
    if (error.code === "WRONG_LEAF") {
      return "请先完成当前节点，再继续处理其他内容";
    }
    return "当前节点仍需确认或补充，本轮进度未更新";
  }
  return "知识库节点状态校验失败，本轮内容尚未更新";
}

function recordKnowledgeInputUnlock(
  build: typeof knowledgeBaseBuilds.$inferSelect,
) {
  if (!build.awaitingResponseSince) return;
  console.info(
    "[KnowledgeBaseInteraction] input_unlocked",
    JSON.stringify({
      buildId: build.id,
      conversationId: build.conversationId,
      revision: build.revision,
      waitMs: Math.max(0, Date.now() - build.awaitingResponseSince.getTime()),
    }),
  );
}

async function rememberProtocolError(input: {
  userId: number;
  conversationId: string;
  message: string;
}) {
  const db = await requireDb();
  await db
    .update(knowledgeBaseBuilds)
    .set({
      status: "protocol_error",
      protocolError: input.message,
      awaitingResponseSince: null,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, input.conversationId),
      ),
    );
}

export async function reconcileKnowledgeBaseProgress(input: {
  userId: number;
  conversationId: string;
  taskId?: string;
  userText?: string;
  attachmentCount?: number;
  output: unknown;
  outputState?: {
    totalLength: number;
    itemIds: string[];
  };
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const text = assertKnowledgeBaseCustomerOutput(input.output);
  const audit = modelOutputAudit(text);
  const outputLedger = {
    lastOutputLength: Math.max(
      0,
      Math.trunc(input.outputState?.totalLength || 0),
    ),
    lastOutputItemIds: (input.outputState?.itemIds || []).slice(-5_000),
  };

  try {
    return await db.transaction(async (tx) => {
      let build = await loadBuild(tx, input.userId, conversationId, true);
      if (!build) {
        throw new KnowledgeBaseBuildError(
          "BUILD_NOT_FOUND",
          "当前对话没有知识库构建记录",
        );
      }
      let rows = await loadNodes(tx, build.id);
      const userText =
        input.userText !== undefined
          ? String(input.userText)
          : String(build.lastTurnUserText || "");
      const attachmentCount =
        input.attachmentCount !== undefined
          ? Math.max(0, Math.trunc(input.attachmentCount || 0))
          : Math.max(0, build.lastTurnAttachmentCount || 0);
      const action = classifyKnowledgeBaseUserAction(userText, attachmentCount);
      const hash = reconciliationHash({
        output: input.output,
        userText,
        attachmentCount,
      });
      if (build.lastReconciledHash === hash) {
        return buildDto(build, rows);
      }

      if (rows.length === 0) {
        // The first visible user bubble contains the start command and company
        // details, so it is intentionally non-empty. A valid signed manifest
        // is authoritative for initialization and makes a failed first parse
        // recoverable on the next server-side task check.
        const manifest = parseKnowledgeBaseManifestEnvelope(text);
        assertKnowledgeBaseInitialImageDelivery(input.output);
        const state = createKnowledgeBaseProgressState(manifest.leaves);
        await tx.insert(knowledgeBaseBuildNodes).values(
          state.leaves.map((leaf, index) => ({
            id: randomUUID(),
            buildId: build!.id,
            leafId: leaf.id,
            branchId: leaf.branchId!,
            branchTitle: leaf.branchTitle!,
            title: leaf.title,
            ordinal: index,
            status: leaf.status,
            ...(index === 0
              ? {
                  contentMarkdown: audit.contentMarkdown || null,
                  lastUserInput: userText || null,
                  sourceUrls: audit.sourceUrls,
                  imageUrls: audit.imageUrls,
                  lastTaskId: input.taskId?.slice(0, 255) || null,
                  lastResponseAt: new Date(),
                }
              : {}),
          })),
        );
        await tx
          .update(knowledgeBaseBuilds)
          .set({
            upstreamTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
            status: "confirming",
            revision: state.revision,
            currentLeafId: state.currentLeafId,
            totalNodeCount: state.leaves.length,
            confirmedCount: 0,
            directPrefilledCount: 0,
            needsVerificationCount: 0,
            lastReconciledHash: hash,
            ...outputLedger,
            protocolError: null,
            awaitingResponseSince: null,
          })
          .where(eq(knowledgeBaseBuilds.id, build.id));
        recordKnowledgeInputUnlock(build);
        build = (await loadBuild(tx, input.userId, conversationId))!;
        rows = await loadNodes(tx, build.id);
        return buildDto(build, rows);
      }

      if (
        build.currentLeafId === null &&
        rows.every(
          (row) =>
            row.status === "confirmed" || row.status === "direct_prefilled",
        )
      ) {
        if (action !== "revise") {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "知识库已完成；如需更新，请直接说明要补充或修改的内容",
          );
        }
        const reopen = parseKnowledgeBaseReopenEnvelope(text);
        if (reopen.revision !== build.revision) {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "本轮修订基于旧版本，请重新提交最新内容",
          );
        }
        const target = rows.find((row) => row.leafId === reopen.leafId);
        if (!target) {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "本轮内容未匹配到现有知识节点，请补充更具体的修改对象",
          );
        }
        if (build.skillVersion === "3") {
          const reopenedRows = rows.map((row) =>
            row.id === target.id
              ? { ...row, status: "needs_verification" as const }
              : row,
          );
          const expectedReopenedState = stateFromRows(
            {
              ...build,
              revision: build.revision + 1,
              currentLeafId: target.leafId,
            },
            reopenedRows,
          );
          const presentation = assertKnowledgeBasePresentationMatchesState(
            expectedReopenedState,
            text,
          );
          assertKnowledgeBaseNodeImageDelivery({
            presentation,
            output: input.output,
          });
        }
        await tx
          .update(knowledgeBaseBuildNodes)
          .set({
            status: "needs_verification",
            transitionReason:
              reopen.reason || "根据企业补充内容重新核验当前节点",
            contentMarkdown: audit.contentMarkdown || target.contentMarkdown,
            lastUserInput: userText || null,
            sourceUrls: mergeAuditUrls(target.sourceUrls, audit.sourceUrls),
            imageUrls: mergeAuditUrls(target.imageUrls, audit.imageUrls),
            lastTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
            lastResponseAt: new Date(),
            confirmedAt: null,
          })
          .where(eq(knowledgeBaseBuildNodes.id, target.id));
        rows = await loadNodes(tx, build.id);
        const reopenedState = stateFromRows(
          {
            ...build,
            revision: build.revision + 1,
            currentLeafId: target.leafId,
          },
          rows,
        );
        const reopenedSummary = getKnowledgeBaseProgressSummary(reopenedState);
        await tx
          .update(knowledgeBaseBuilds)
          .set({
            upstreamTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
            status: "confirming",
            revision: build.revision + 1,
            currentLeafId: target.leafId,
            confirmedCount: reopenedSummary.confirmed,
            directPrefilledCount: reopenedSummary.directPrefilled,
            needsVerificationCount: reopenedSummary.needsVerification,
            lastReconciledHash: hash,
            ...outputLedger,
            protocolError: null,
            awaitingResponseSince: null,
            completedAt: null,
            packageRevision: null,
            packageTaskId: null,
            packageOutputItemId: null,
            packageFileId: null,
            packageFilename: null,
            packageDescriptorHash: null,
          })
          .where(eq(knowledgeBaseBuilds.id, build.id));
        recordKnowledgeInputUnlock(build);
        build = (await loadBuild(tx, input.userId, conversationId))!;
        rows = await loadNodes(tx, build.id);
        return buildDto(build, rows);
      }

      if (action === "initial") {
        throw new KnowledgeBaseBuildError(
          "PROGRESS_PROTOCOL_INVALID",
          "节点已开始确认，空白回复不能推进当前节点",
        );
      }

      const state = stateFromRows(build, rows);
      const envelope = parseKnowledgeBaseProgressEnvelope(text);
      assertActionMatchesTransition(action, envelope.transition.to);
      const nextState = applyKnowledgeBaseProgressEnvelope(state, envelope);
      if (build.skillVersion === "3") {
        const presentation = assertKnowledgeBasePresentationMatchesState(
          nextState,
          text,
        );
        assertKnowledgeBaseNodeImageDelivery({
          presentation,
          output: input.output,
        });
      }
      const summary = getKnowledgeBaseProgressSummary(nextState);
      const packageAllowed = canPackageKnowledgeBase(nextState);
      const packageDescriptors = packageAllowed
        ? collectKnowledgeArchiveDescriptors(
            Array.isArray(input.output) ? input.output : [],
          )
        : [];
      if (packageAllowed && packageDescriptors.length !== 1) {
        throw new KnowledgeBaseBuildError(
          "PROGRESS_PROTOCOL_INVALID",
          packageDescriptors.length === 0
            ? "所有节点已完成，但本轮尚未生成唯一的最终知识库 ZIP"
            : "本轮返回了多个知识库 ZIP，无法确认唯一发布版本",
        );
      }
      const packageDescriptor = packageDescriptors[0];
      const previousCurrentIndex = rows.findIndex(
        (row) => row.leafId === state.currentLeafId,
      );

      for (let index = 0; index < rows.length; index += 1) {
        const previous = rows[index]!;
        const next = nextState.leaves[index]!;
        const isCurrentLeaf = previous.leafId === state.currentLeafId;
        const isNextLeaf =
          nextState.currentLeafId !== null &&
          previous.leafId === nextState.currentLeafId;
        const storesRevisedCurrent = isCurrentLeaf && action === "revise";
        const storesNextPrefill =
          isNextLeaf &&
          nextState.currentLeafId !== state.currentLeafId &&
          action !== "revise";
        if (
          previous.status === next.status &&
          !isCurrentLeaf &&
          !storesNextPrefill
        ) {
          continue;
        }
        await tx
          .update(knowledgeBaseBuildNodes)
          .set({
            status: next.status,
            transitionReason:
              index === previousCurrentIndex
                ? envelope.transition.reason || null
                : null,
            ...(storesRevisedCurrent || storesNextPrefill
              ? {
                  contentMarkdown:
                    audit.contentMarkdown || previous.contentMarkdown,
                  lastUserInput: storesRevisedCurrent
                    ? userText || null
                    : previous.lastUserInput,
                  sourceUrls: mergeAuditUrls(
                    previous.sourceUrls,
                    audit.sourceUrls,
                  ),
                  imageUrls: mergeAuditUrls(
                    previous.imageUrls,
                    audit.imageUrls,
                  ),
                  lastTaskId:
                    input.taskId?.slice(0, 255) || build.upstreamTaskId,
                  lastResponseAt: new Date(),
                }
              : {}),
            confirmedAt:
              next.status === "confirmed" || next.status === "direct_prefilled"
                ? new Date()
                : null,
          })
          .where(eq(knowledgeBaseBuildNodes.id, previous.id));
      }

      await tx
        .update(knowledgeBaseBuilds)
        .set({
          upstreamTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
          status: packageAllowed ? "ready_to_publish" : "confirming",
          revision: nextState.revision,
          currentLeafId: nextState.currentLeafId,
          totalNodeCount: summary.total,
          confirmedCount: summary.confirmed,
          directPrefilledCount: summary.directPrefilled,
          needsVerificationCount: summary.needsVerification,
          lastReconciledHash: hash,
          ...outputLedger,
          protocolError: null,
          awaitingResponseSince: null,
          completedAt: packageAllowed ? new Date() : null,
          packageRevision: packageAllowed ? nextState.revision : null,
          packageTaskId: packageAllowed
            ? input.taskId?.slice(0, 255) || build.upstreamTaskId
            : null,
          packageOutputItemId: packageAllowed
            ? packageDescriptor!.outputItemId
            : null,
          packageFileId: packageAllowed
            ? packageDescriptor!.fileId || null
            : null,
          packageFilename: packageAllowed ? packageDescriptor!.filename : null,
          packageDescriptorHash: packageAllowed
            ? knowledgeArchiveDescriptorHash(packageDescriptor!)
            : null,
        })
        .where(eq(knowledgeBaseBuilds.id, build.id));

      recordKnowledgeInputUnlock(build);
      build = (await loadBuild(tx, input.userId, conversationId))!;
      rows = await loadNodes(tx, build.id);
      return buildDto(build, rows);
    });
  } catch (error) {
    if (
      error instanceof KnowledgeBaseBuildError &&
      error.code === "BUILD_NOT_FOUND"
    ) {
      throw error;
    }
    const message = friendlyProtocolError(error);
    const db = await requireDb();
    await db
      .update(knowledgeBaseBuilds)
      .set(outputLedger)
      .where(
        and(
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.conversationId, conversationId),
        ),
      );
    await rememberProtocolError({
      userId: input.userId,
      conversationId,
      message,
    });
    throw new KnowledgeBaseBuildError("PROGRESS_PROTOCOL_INVALID", message);
  }
}

export async function assertKnowledgeBasePublishable(input: {
  userId: number;
  conversationId: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const build = await loadBuild(db, input.userId, conversationId);
  if (!build) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
  const rows = await loadNodes(db, build.id);
  if (build.status === "published" && build.publishedSnapshotId) {
    return build;
  }
  if (build.status !== "ready_to_publish") {
    throw new KnowledgeBaseBuildError(
      "PUBLISH_BLOCKED",
      "知识库尚未完成全部节点确认",
    );
  }
  try {
    assertKnowledgeBaseReadyForPackage(stateFromRows(build, rows));
  } catch {
    const handled = build.confirmedCount + build.directPrefilledCount;
    throw new KnowledgeBaseBuildError(
      "PUBLISH_BLOCKED",
      `知识库尚未逐项走完，当前完成进度为 ${handled}/${build.totalNodeCount}`,
    );
  }
  if (
    build.packageRevision !== build.revision ||
    build.packageTaskId !== build.upstreamTaskId ||
    !build.packageOutputItemId ||
    !build.packageDescriptorHash
  ) {
    throw new KnowledgeBaseBuildError(
      "PUBLISH_BLOCKED",
      "最终知识库文件尚未与当前完成版本绑定",
    );
  }
  return build;
}

export async function markKnowledgeBasePublished(input: {
  userId: number;
  conversationId: string;
  snapshotId: string;
}) {
  const db = await requireDb();
  await db
    .update(knowledgeBaseBuilds)
    .set({
      status: "published",
      publishedSnapshotId: input.snapshotId,
      publishedAt: new Date(),
      protocolError: null,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(
          knowledgeBaseBuilds.conversationId,
          normalizeConversationId(input.conversationId),
        ),
      ),
    );
}
