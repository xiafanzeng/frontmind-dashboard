import axios from "axios";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { Router } from "express";
import fs from "fs/promises";
import JSZip from "jszip";
import path from "path";
import { createHash } from "node:crypto";
import {
  getFrontMindCredentials,
  getUpstreamBaseUrl,
  toUpstreamAgentProfile,
} from "./upstream-config";
import {
  credentialsUseSameUpstreamApiKey,
  getCredentialForUpstreamResource,
  recordUpstreamResource,
} from "./auth-service";
import {
  KnowledgeBaseBuildError,
  assertKnowledgeBaseCustomerOutput,
  assertKnowledgeBaseTaskBinding,
  attachKnowledgeBaseBuildTask,
  createKnowledgeBaseBuild,
  extractFinalKnowledgeBaseAssistantText,
  getKnowledgeBaseProgress,
  recordKnowledgeBaseTurn,
  reconcileKnowledgeBaseProgress,
} from "./knowledge-base-progress-service";
import {
  getDashboardWorkspace,
  getLatestKnowledgeSnapshot,
} from "./dashboard-service";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";
import type {
  KnowledgeBaseInteractionDto,
  KnowledgeBaseProgressDto,
} from "../shared/knowledge-base-progress";
import { knowledgeBaseBuilds } from "../drizzle/schema";
import { getDb } from "./db";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";

const router = Router();

async function requireKnowledgeBuildCapability(
  userId: number,
  res: import("express").Response,
) {
  try {
    await assertServiceCapability(userId, "knowledgeBuild");
    return true;
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return false;
    }
    throw error;
  }
}

interface KnowledgeBaseAttachment {
  file_id?: string;
  fileId?: string;
  filename?: string;
  name?: string;
}

interface KnowledgeBaseStartRequest {
  conversationId?: string;
  companyName?: string;
  companyWebsite?: string;
  operatorNotes?: string;
  attachments?: KnowledgeBaseAttachment[];
}

export type KnowledgeBaseEnterpriseIdentityErrorCode =
  | "ENTERPRISE_NOT_CONFIGURED"
  | "ENTERPRISE_IDENTITY_MISMATCH";

export class KnowledgeBaseEnterpriseIdentityError extends Error {
  readonly code: KnowledgeBaseEnterpriseIdentityErrorCode;

  constructor(code: KnowledgeBaseEnterpriseIdentityErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeBaseEnterpriseIdentityError";
    this.code = code;
  }
}

function normalizedEnterpriseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A knowledge-base build belongs to the enterprise name already assigned to
 * the authenticated account. Publishing an otherwise empty dashboard is not a
 * prerequisite. Browser input may repeat the name for compatibility, but it
 * can neither establish nor replace the identity.
 */
export function resolveKnowledgeBaseEnterpriseIdentity(input: {
  sourceName: string | null;
  brandName: string;
  requestedCompanyName?: string;
}) {
  const companyName = input.brandName.normalize("NFKC").trim();
  if (!companyName) {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_NOT_CONFIGURED",
      "当前账号尚未由管理员配置企业名称，无法启动知识库构建",
    );
  }

  const requestedCompanyName = String(input.requestedCompanyName || "").trim();
  if (
    requestedCompanyName &&
    normalizedEnterpriseName(requestedCompanyName) !==
      normalizedEnterpriseName(companyName)
  ) {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_IDENTITY_MISMATCH",
      "输入的企业名称与当前账号绑定企业不一致，请刷新后重试",
    );
  }

  return companyName;
}

function outputItemIds(output: unknown[]) {
  return output
    .map((item) =>
      item && typeof item === "object" && "id" in item
        ? String((item as { id?: unknown }).id || "")
        : "",
    )
    .filter(Boolean);
}

export function selectUnreconciledKnowledgeOutput(
  output: unknown[],
  ledger: { lastOutputLength: number; lastOutputItemIds: string[] },
) {
  if (output.length > ledger.lastOutputLength) {
    return output.slice(ledger.lastOutputLength);
  }
  const previousIds = new Set(ledger.lastOutputItemIds || []);
  const unseenById = output.filter((item) => {
    if (!item || typeof item !== "object" || !("id" in item)) return false;
    const id = String((item as { id?: unknown }).id || "");
    return Boolean(id) && !previousIds.has(id);
  });
  if (unseenById.length > 0) return unseenById;
  const currentIds = outputItemIds(output);
  if (currentIds.length > 0 && currentIds.every((id) => previousIds.has(id))) {
    return [];
  }
  // Some upstream task continuations return only the current turn rather than
  // a cumulative array. Returning the full current payload avoids losing it;
  // the reconciliation hash keeps repeated checks idempotent.
  return output;
}

const COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE =
  /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT =
  /<!--\s*FRONTMIND_KB_[A-Z_]+\b[\s\S]*?-->/i;

function normalizedUpstreamTaskStatus(status: unknown) {
  const value = String(status || "running")
    .trim()
    .toLowerCase();
  return value === "failed" ? "error" : value;
}

const knowledgeInteractionAlertAt = new Map<string, number>();

function observeKnowledgeInteraction(
  progress: KnowledgeBaseProgressDto | null,
  upstreamStatus: unknown,
) {
  const normalized = normalizedUpstreamTaskStatus(upstreamStatus);
  const now = Date.now();
  const knownStatuses = new Set([
    "created",
    "queued",
    "pending",
    "running",
    "in_progress",
    "awaiting_input",
    "awaiting_user",
    "awaiting_user_input",
    "waiting",
    "paused",
    "requires_action",
    "input_required",
    "completed",
    "error",
  ]);
  const alert = (kind: string, metadata: Record<string, unknown>) => {
    const key = `${progress?.build.id || "unbound"}:${kind}:${normalized}`;
    if ((knowledgeInteractionAlertAt.get(key) || 0) > now - 10 * 60_000) {
      return;
    }
    knowledgeInteractionAlertAt.set(key, now);
    console.warn(
      `[KnowledgeBaseInteraction] ${kind}`,
      JSON.stringify(metadata),
    );
  };
  if (!knownStatuses.has(normalized)) {
    alert("unknown_upstream_status", {
      buildId: progress?.build.id || null,
      upstreamStatus: normalized,
    });
  }
  const awaitingSince = progress?.build.awaitingResponseSince;
  if (
    typeof awaitingSince === "number" &&
    now - awaitingSince > 2 * 60 * 60_000
  ) {
    alert("execution_timeout", {
      buildId: progress?.build.id || null,
      upstreamStatus: normalized,
      waitMs: now - awaitingSince,
    });
  }
  if (knowledgeInteractionAlertAt.size > 1_000) {
    const expiry = now - 60 * 60_000;
    knowledgeInteractionAlertAt.forEach((lastSeen, key) => {
      if (lastSeen < expiry) knowledgeInteractionAlertAt.delete(key);
    });
  }
}

function upstreamTaskFailed(status: unknown) {
  const normalized = normalizedUpstreamTaskStatus(status);
  return normalized === "error" || normalized === "failed";
}

function upstreamTaskTerminal(status: unknown) {
  return (
    upstreamTaskFailed(status) ||
    normalizedUpstreamTaskStatus(status) === "completed"
  );
}

export function shouldReconcileKnowledgeOutput(
  output: unknown[],
  status: unknown,
) {
  const text = extractFinalKnowledgeBaseAssistantText(output);
  if (!text) return false;
  if (
    COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE.test(text) ||
    COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT.test(text)
  ) {
    return true;
  }
  // A terminal provider response without a complete protocol envelope is a
  // protocol failure. Waiting/running output may still be a partial stream, so
  // it must never poison the build or unlock input until a closed envelope is
  // present.
  return upstreamTaskTerminal(status);
}

export function deriveKnowledgeBaseInteraction(
  progress: KnowledgeBaseProgressDto | null,
  upstreamStatus: unknown,
): KnowledgeBaseInteractionDto {
  observeKnowledgeInteraction(progress, upstreamStatus);
  if (progress?.build.status === "published") {
    return {
      progress,
      interactionState: "published",
      canReply: false,
      canPublish: false,
      lockReason: "知识库已发布；后续修改请提交维护工单",
    };
  }
  if (
    progress?.packageAllowed &&
    progress.build.status === "ready_to_publish"
  ) {
    return {
      progress,
      interactionState: "ready_to_publish",
      canReply: false,
      canPublish: true,
      lockReason: "知识库已完成，请执行唯一一次直接更新",
    };
  }
  if (
    progress?.build.status === "protocol_error" ||
    progress?.build.status === "failed" ||
    upstreamTaskFailed(upstreamStatus)
  ) {
    return {
      progress,
      interactionState: "failed",
      canReply: false,
      canPublish: false,
      lockReason:
        progress?.build.protocolError || "知识库任务执行失败，请重新同步状态",
    };
  }
  if (
    progress?.build.status === "confirming" &&
    progress.build.currentLeafId &&
    progress.build.awaitingResponseSince === null
  ) {
    return {
      progress,
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    };
  }
  const interactionState =
    normalizedUpstreamTaskStatus(upstreamStatus) === "pending"
      ? "queued"
      : "executing";
  return {
    progress,
    interactionState,
    canReply: false,
    canPublish: false,
    lockReason: "FrontMind 正在整理当前知识节点",
  };
}

async function reconcileAvailableKnowledgeOutput(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  output: unknown[];
  upstreamStatus: unknown;
  ledger: { lastOutputLength: number; lastOutputItemIds: string[] };
}) {
  let progress = await getKnowledgeBaseProgress({
    userId: input.userId,
    conversationId: input.conversationId,
  });
  const unreconciled = selectUnreconciledKnowledgeOutput(
    input.output,
    input.ledger,
  );
  if (shouldReconcileKnowledgeOutput(unreconciled, input.upstreamStatus)) {
    progress = await reconcileKnowledgeBaseProgress({
      userId: input.userId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      output: unreconciled,
      outputState: {
        totalLength: input.output.length,
        itemIds: outputItemIds(input.output),
      },
    });
  }
  return progress;
}

export async function recoverOpenKnowledgeBaseTasks(options?: {
  limit?: number;
  concurrency?: number;
}) {
  const db = await getDb();
  if (!db) {
    return { scanned: 0, reconciled: 0, skipped: 0, failed: 0 };
  }
  const limit = Math.min(500, Math.max(1, Math.trunc(options?.limit ?? 100)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const builds = await db
    .select({
      id: knowledgeBaseBuilds.id,
      userId: knowledgeBaseBuilds.userId,
      conversationId: knowledgeBaseBuilds.conversationId,
      upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
      lastOutputLength: knowledgeBaseBuilds.lastOutputLength,
      lastOutputItemIds: knowledgeBaseBuilds.lastOutputItemIds,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        inArray(knowledgeBaseBuilds.status, ["researching", "confirming"]),
        isNotNull(knowledgeBaseBuilds.upstreamTaskId),
        or(
          eq(knowledgeBaseBuilds.status, "researching"),
          isNotNull(knowledgeBaseBuilds.awaitingResponseSince),
        ),
      ),
    )
    .limit(limit);

  const result = {
    scanned: builds.length,
    reconciled: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor = 0;
  const baseUrl = getUpstreamBaseUrl();
  const worker = async () => {
    while (cursor < builds.length) {
      const build = builds[cursor++];
      const taskId = String(build.upstreamTaskId || "");
      try {
        const credential = await getCredentialForUpstreamResource(
          build.userId,
          "task",
          taskId,
        );
        if (!credential) {
          result.skipped += 1;
          console.warn(
            "[KnowledgeBaseRecovery] credential_unavailable",
            JSON.stringify({ buildId: build.id, taskId }),
          );
          continue;
        }
        const taskResponse = await axios.get(
          `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
          {
            headers: {
              API_KEY: credential.apiKey,
              Authorization: `Bearer ${credential.apiKey}`,
            },
            timeout: 120000,
            validateStatus: () => true,
          },
        );
        if (taskResponse.status < 200 || taskResponse.status >= 300) {
          result.failed += 1;
          console.warn(
            "[KnowledgeBaseRecovery] task_read_failed",
            JSON.stringify({
              buildId: build.id,
              taskId,
              status: taskResponse.status,
            }),
          );
          continue;
        }
        const taskData = taskResponse.data || {};
        const output = Array.isArray(taskData.output) ? taskData.output : [];
        const taskStatus = normalizedUpstreamTaskStatus(taskData.status);
        if (!shouldReconcileKnowledgeOutput(output, taskStatus)) {
          observeKnowledgeInteraction(
            await getKnowledgeBaseProgress({
              userId: build.userId,
              conversationId: build.conversationId,
            }),
            taskStatus,
          );
          result.skipped += 1;
          continue;
        }
        await reconcileAvailableKnowledgeOutput({
          userId: build.userId,
          conversationId: build.conversationId,
          taskId,
          output,
          upstreamStatus: taskStatus,
          ledger: {
            lastOutputLength: build.lastOutputLength,
            lastOutputItemIds: build.lastOutputItemIds,
          },
        });
        result.reconciled += 1;
      } catch (error) {
        result.failed += 1;
        console.warn(
          "[KnowledgeBaseRecovery] reconcile_failed",
          JSON.stringify({
            buildId: build.id,
            taskId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, builds.length) }, worker),
  );
  return result;
}

const configuredKnowledgeBaseSkillPath =
  process.env.FRONTMIND_KB_SKILL_PATH?.trim();
if (
  configuredKnowledgeBaseSkillPath &&
  !path.isAbsolute(configuredKnowledgeBaseSkillPath)
) {
  throw new Error("FRONTMIND_KB_SKILL_PATH must be an absolute path");
}
const skillArchiveCandidates = configuredKnowledgeBaseSkillPath
  ? [configuredKnowledgeBaseSkillPath]
  : [
      path.resolve(
        import.meta.dirname,
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        process.cwd(),
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
    ];

const legacySkillArchiveCandidates = configuredKnowledgeBaseSkillPath
  ? [
      path.join(
        path.dirname(configuredKnowledgeBaseSkillPath),
        "socratic-kb-builder-v1.skill",
      ),
    ]
  : skillArchiveCandidates.map((candidate) =>
      path.join(path.dirname(candidate), "socratic-kb-builder-v1.skill"),
    );

interface KnowledgeBaseSkillSelection {
  version: string;
  contentHash?: string | null;
}

interface LoadedKnowledgeBaseSkill {
  instructions: string;
  contentHash: string;
  archivePath: string;
}

const skillArchiveCache = new Map<string, LoadedKnowledgeBaseSkill>();
export const KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME =
  "socratic-kb-builder.skill.zip";

function sanitizeFilename(value: string, fallback: string) {
  const safe = String(value || "")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, 160);
  return safe || fallback;
}

function normalizeUserAttachments(
  attachments: KnowledgeBaseAttachment[] | undefined,
) {
  return (attachments || [])
    .map((attachment) => {
      const fileId = attachment.file_id || attachment.fileId || "";
      const filename = sanitizeFilename(
        attachment.filename || attachment.name || "company_material",
        "company_material",
      );
      return fileId ? { file_id: fileId, filename } : null;
    })
    .filter(Boolean) as Array<{ file_id: string; filename: string }>;
}

async function loadSkillArchive(
  selection: KnowledgeBaseSkillSelection = { version: "2" },
) {
  const version = selection.version === "1" ? "1" : "2";
  const cached = skillArchiveCache.get(version);
  if (cached) {
    if (selection.contentHash && selection.contentHash !== cached.contentHash) {
      throw new Error(
        `Knowledge-base Skill v${version} content hash does not match the active build`,
      );
    }
    return cached;
  }

  let lastError: unknown;
  const candidates =
    version === "1" ? legacySkillArchiveCandidates : skillArchiveCandidates;
  for (const candidate of candidates) {
    try {
      const archive = await fs.readFile(candidate);
      const zip = await JSZip.loadAsync(archive);
      const entries =
        version === "2"
          ? ([["SKILL.md", "Skill"]] as const)
          : ([
              ["SKILL.md", "Skill"],
              ["references/knowledge-tree.md", "Knowledge Tree"],
              ["references/questioning-strategy.md", "Questioning Strategy"],
              ["references/output-format.md", "Output Format"],
            ] as const);

      const sections: string[] = [];
      for (const [entryName, title] of entries) {
        const entry = zip.file(entryName);
        if (!entry) {
          throw new Error(`Missing ${entryName} in socratic-kb-builder.skill`);
        }
        const content = await entry.async("string");
        sections.push(`# ${title}\n\n${content.trim()}`);
      }

      const instructions = sections.join("\n\n---\n\n");
      const loaded = {
        instructions,
        contentHash: createHash("sha256").update(instructions).digest("hex"),
        archivePath: candidate,
      };
      if (
        selection.contentHash &&
        selection.contentHash !== loaded.contentHash
      ) {
        throw new Error(
          `Knowledge-base Skill v${version} content hash does not match the active build`,
        );
      }
      skillArchiveCache.set(version, loaded);
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load socratic-kb-builder Skill v${version}`);
}

async function readSkillArchive(
  selection: KnowledgeBaseSkillSelection = { version: "2" },
) {
  return (await loadSkillArchive(selection)).instructions;
}

export async function readKnowledgeBaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection = { version: "2" },
) {
  const loaded = await loadSkillArchive(selection);
  const bytes = await fs.readFile(loaded.archivePath);
  return {
    filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
    bytes,
    contentHash: loaded.contentHash,
  };
}

export async function getKnowledgeBaseSkillDescriptor(
  selection: KnowledgeBaseSkillSelection = { version: "2" },
) {
  const version = selection.version === "1" ? "1" : "2";
  const loaded = await loadSkillArchive({
    version,
    contentHash: selection.contentHash,
  });
  return {
    name: "socratic-kb-builder",
    version,
    contentHash: loaded.contentHash,
  };
}

const KNOWLEDGE_PREFILL_MAX_CHARACTERS = 80_000;
const KNOWLEDGE_PREFILL_MAX_DOCUMENT_CHARACTERS = 12_000;

type KnowledgePrefillDocument = {
  path: string;
  title: string;
  content: string;
};

function knowledgePrefillBranch(pathname: string) {
  return pathname.normalize("NFKC").split("/").filter(Boolean)[0] || "root";
}

function isKnowledgePrefillOverview(document: KnowledgePrefillDocument) {
  return /(?:^|[/_-])(?:overview|readme|00[_-])|概览|总览|综述/i.test(
    `${document.path} ${document.title}`,
  );
}

function isKnowledgePrefillProduct(document: KnowledgePrefillDocument) {
  return /(?:^|[/_-])03(?:[/_-]|$)|products?|services?|产品|服务/i.test(
    `${document.path} ${document.title}`,
  );
}

export function buildKnowledgePrefillExcerpt(
  documents: KnowledgePrefillDocument[],
) {
  const ordered = [...documents].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const groups = new Map<string, KnowledgePrefillDocument[]>();
  for (const document of ordered) {
    const branch = knowledgePrefillBranch(document.path);
    const values = groups.get(branch) || [];
    values.push(document);
    groups.set(branch, values);
  }

  const selected: KnowledgePrefillDocument[] = [];
  const selectedPaths = new Set<string>();
  const add = (document: KnowledgePrefillDocument | undefined) => {
    if (!document || selectedPaths.has(document.path)) return;
    selected.push(document);
    selectedPaths.add(document.path);
  };

  for (const branch of [...groups.keys()].sort()) {
    const values = groups.get(branch) || [];
    add(values.find(isKnowledgePrefillOverview) || values[0]);
  }
  ordered.filter(isKnowledgePrefillProduct).forEach(add);

  let added = true;
  while (added) {
    added = false;
    for (const branch of [...groups.keys()].sort()) {
      const next = (groups.get(branch) || []).find(
        (document) => !selectedPaths.has(document.path),
      );
      if (next) {
        add(next);
        added = true;
      }
    }
  }

  let excerpt = "";
  for (const document of selected) {
    const prefix = [
      `### ${document.title || document.path}`,
      `documentPath: ${document.path}`,
      "",
    ].join("\n");
    const remaining = KNOWLEDGE_PREFILL_MAX_CHARACTERS - excerpt.length;
    if (remaining <= prefix.length) break;
    const content = document.content.slice(
      0,
      Math.min(
        KNOWLEDGE_PREFILL_MAX_DOCUMENT_CHARACTERS,
        remaining - prefix.length,
      ),
    );
    excerpt += `${excerpt ? "\n\n" : ""}${prefix}${content}`;
    if (excerpt.length >= KNOWLEDGE_PREFILL_MAX_CHARACTERS) break;
  }
  return excerpt.slice(0, KNOWLEDGE_PREFILL_MAX_CHARACTERS);
}

export async function buildKnowledgeBasePrompt({
  conversationId,
  companyName,
  companyWebsite,
  operatorNotes,
  attachments,
  prefillKnowledgeSnapshot,
}: {
  conversationId?: string;
  companyName: string;
  companyWebsite: string;
  operatorNotes: string;
  attachments: Array<{ file_id: string; filename: string }>;
  prefillKnowledgeSnapshot?: {
    version: number;
    sourceFileName: string;
    archiveHash: string | null;
    documentCount: number;
    imageCount: number;
    characterCount: number;
    documents: Array<{ path: string; title: string; content: string }>;
  } | null;
}) {
  const attachmentList =
    attachments.length > 0
      ? attachments.map((attachment) => `- ${attachment.filename}`).join("\n")
      : "- 未上传附件，请优先使用企业官网与全网公开资料进行预填";
  const prefillDocuments = buildKnowledgePrefillExcerpt(
    prefillKnowledgeSnapshot?.documents ?? [],
  );

  return [
    `严格执行随任务附带的 ${KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME}。先解压 ZIP 并完整读取根目录 SKILL.md，再开始工作。`,
    "该 ZIP 是本任务唯一的 socratic-kb-builder v2 工作规约；本段仅提供企业输入和服务端状态约束。",
    "不得开启、调用、切换或推荐 Wide Research / Deep Research；只使用当前 Pro Agent 模式下的普通浏览、搜索和文件工具。",
    "客户可见正文与本轮对话只能呈现百科事实，不得呈现任务过程、核验判断、采购/合规建议、读者指令、工具计划或模型推理。",
    "客户可见正文不得嵌入官网或 CDN 图片外链。图片必须先下载真实字节、解码校验并打入最终 ZIP，再以包内相对路径引用；防盗链、签名、过期或无法下载的地址只能进入内部来源记录，绝不能作为客户图片返回。",
    "",
    "## 本次任务输入",
    `构建会话标识：${conversationId || "未提供"}`,
    `企业名称（账号正式绑定）：${companyName}`,
    `企业官网入口（可多个）：${companyWebsite || "未填写"}`,
    "用户上传资料：",
    attachmentList,
    operatorNotes ? `操作者备注：\n${operatorNotes}` : "操作者备注：未填写",
    "",
    "## 官网已迁移的初步知识库预填证据",
    prefillKnowledgeSnapshot
      ? [
          `知识库版本：V${prefillKnowledgeSnapshot.version}`,
          `来源文件：${prefillKnowledgeSnapshot.sourceFileName}`,
          `产物哈希：${prefillKnowledgeSnapshot.archiveHash || "未记录"}`,
          `已解析文档：${prefillKnowledgeSnapshot.documentCount}；图片：${prefillKnowledgeSnapshot.imageCount}；字符：${prefillKnowledgeSnapshot.characterCount}`,
          "以下内容是预填证据，不代表节点已确认，也不得据此伪造 100% 对话进度：",
          prefillDocuments || "当前版本没有可读取的正文。",
        ].join("\n")
      : "当前账号没有已迁移的初步知识库，将从官网、全网与上传资料开始预填。",
    "## 必须执行的机器可验证进度协议",
    "这是服务端状态机协议，优先级高于 skill 中任何会自动跨节点的表述。可读正文照常输出，但每轮末尾必须附带且只能附带一个对应的 HTML 注释信封。",
    "",
    "### 首轮研究与知识树建立",
    "完成官网、公开来源、上传资料研究和正式图文预填后，按企业实际资料量建立自适应一级分支和 8-115 个真实叶子节点。白牌企业或只有宣传单时只保留有事实价值或明确缺口的必要叶子，不得为数量、字数或图片数填充内容。一级分支数量不设固定值；每个叶子必须有全局唯一且后续不变的 id、title、branchId、branchTitle。首轮正文展示完整分支统计并呈现第一个叶子节点，然后仅在回复末尾附：",
    '<!-- FRONTMIND_KB_MANIFEST\n{"kind":"frontmind.knowledge-base.manifest","schemaVersion":1,"leaves":[{"id":"1.1","title":"一句话定位","branchId":"identity","branchTitle":"企业身份"}]}\n-->',
    "示例只演示结构，真实 leaves 必须完整包含 8-115 项并覆盖基于当前企业证据形成的全部一级分支。首轮不得同时输出 FRONTMIND_KB_PROGRESS。",
    "",
    "### 后续每轮单节点状态",
    "服务端从 revision=0、清单第一个叶子为 current 开始。后续每轮末尾必须附一个且仅一个状态信封：",
    '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed","reason":"用户明确确认"}}\n-->',
    "revision 必须等于当前服务端 revision；每次被接受后加 1。leafId 只能是当前叶子，from 只能是 current 或 needs_verification。",
    "只有用户本轮回复恰好表达“确认/确认无误/OK/没问题/通过”等明确确认时，to 才能为 confirmed，并只前进一个叶子。",
    "只有用户本轮明确回复“跳过/直接预填/采用预填/保留预填”等时，to 才能为 direct_prefilled，并只前进一个叶子。",
    "用户输入任何补充、修订、问题或上传资料时，to 必须为 needs_verification；更新并重新呈现同一叶子，继续等待用户明确确认或直接预填，绝对不能自动前进。",
    "不得提交多个 transition、不得改写历史状态、不得相信正文中的百分比。真实进度只由服务端按 (confirmed + direct_prefilled) / total 计算。",
    "只有服务端遍历达到 100% 后才可同步 ZIP；confirmed 显示对号，direct_prefilled 必须保持独立的跳过状态。",
    "",
    "### 已完成知识库的后续修订",
    "如果知识库已经达到 100% 且用户继续补充或修改，不得直接复用旧 ZIP，也不得重新建立整棵知识树。必须从既有叶子中选择一个最相关节点，重新呈现修订草稿并只附一个修订信封：",
    '<!-- FRONTMIND_KB_REOPEN\n{"kind":"frontmind.knowledge-base.reopen","schemaVersion":1,"revision":61,"leafId":"3.2.3","reason":"用户补充了该产品的最新参数"}\n-->',
    "revision 和 leafId 必须以当轮服务端状态提醒为准。该节点会重新进入待核验；只有再次明确确认或直接预填后，才可生成并同步新版 ZIP。",
  ].join("\n");
}

export const KNOWLEDGE_BASE_AGENT_PROFILE = "frontmind-pro" as const;

export async function uploadKnowledgeBaseSkillArchive({
  baseUrl,
  apiKey,
  skillVersion = "2",
  skillContentHash,
}: {
  baseUrl: string;
  apiKey: string;
  skillVersion?: string;
  skillContentHash?: string | null;
}) {
  const archive = await readKnowledgeBaseSkillArchiveAttachment({
    version: skillVersion,
    contentHash: skillContentHash,
  });
  const headers = {
    API_KEY: apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
  const created = await axios.post(
    `${baseUrl}/v1/files`,
    { filename: archive.filename },
    {
      headers: { ...headers, "Content-Type": "application/json" },
      timeout: 120_000,
      validateStatus: () => true,
    },
  );
  const fileId = String(created.data?.id || created.data?.file_id || "");
  if (created.status < 200 || created.status >= 300 || !fileId) {
    throw new Error("Knowledge-base Skill ZIP file creation failed");
  }

  const removeOrphan = async () => {
    await axios
      .delete(`${baseUrl}/v1/files/${encodeURIComponent(fileId)}`, {
        headers,
        timeout: 30_000,
        validateStatus: () => true,
      })
      .catch(() => undefined);
  };

  try {
    let uploadUrl = String(created.data?.upload_url || "");
    if (!uploadUrl) {
      const metadata = await axios.get(
        `${baseUrl}/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers,
          timeout: 30_000,
          validateStatus: () => true,
        },
      );
      if (metadata.status < 200 || metadata.status >= 300) {
        throw new Error("Knowledge-base Skill ZIP upload URL lookup failed");
      }
      uploadUrl = String(metadata.data?.upload_url || "");
    }
    const target = assertSafeExternalUrl(uploadUrl);
    const uploaded = await axios.put(target, archive.bytes, {
      ...safeExternalRequestOptions,
      // The SigV4 query signs this exact URL; redirects invalidate it.
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(archive.bytes.length),
      },
      timeout: 120_000,
      maxBodyLength: archive.bytes.length,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true,
    });
    if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new Error("Knowledge-base Skill ZIP upload failed");
    }
    return {
      attachment: { file_id: fileId, filename: archive.filename },
      fileId,
      contentHash: archive.contentHash,
      removeOrphan,
    };
  } catch (error) {
    await removeOrphan();
    throw error;
  }
}

async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  attachments,
  taskId: existingTaskId,
}: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  attachments: Array<{ file_id: string; filename: string }>;
  taskId?: string;
}) {
  const taskResponse = await axios.post(
    `${baseUrl}/v1/tasks`,
    {
      prompt,
      agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
      taskMode: "agent",
      attachments,
      ...(existingTaskId ? { taskId: existingTaskId } : {}),
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120000,
      validateStatus: () => true,
    },
  );

  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const detail =
      taskResponse.data?.error?.message ||
      taskResponse.data?.message ||
      `Create task failed (${taskResponse.status})`;
    return { ok: false as const, status: taskResponse.status, detail };
  }

  const taskData = taskResponse.data || {};
  const taskId = taskData.id || taskData.task_id;
  if (!taskId) {
    return {
      ok: false as const,
      status: 502,
      detail: "Create task failed: missing task id",
    };
  }

  return {
    ok: true as const,
    task: {
      id: taskId,
      status:
        taskData.status === "failed" ? "error" : taskData.status || "running",
      taskUrl: taskData.task_url || taskData.metadata?.task_url,
      title: taskData.task_title || taskData.metadata?.task_title,
      output: taskData.output || [],
    },
  };
}

export async function buildKnowledgeBaseTurnPrompt(input: {
  userId: number;
  conversationId: string;
  userMessage: string;
  attachments: Array<{ file_id: string; filename: string }>;
  skillVersion?: string;
  skillContentHash?: string | null;
}) {
  await loadSkillArchive({
    version: input.skillVersion || "2",
    contentHash: input.skillContentHash,
  });
  const progress = await getKnowledgeBaseProgress({
    userId: input.userId,
    conversationId: input.conversationId,
  });
  if (!progress) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
  const leaves = progress.branches.flatMap((branch) => branch.leaves);
  const current = leaves.find(
    (leaf) => leaf.id === progress.build.currentLeafId,
  );
  const stateReminder = current
    ? [
        `当前 revision=${progress.build.revision}`,
        `当前且唯一可处理节点：${current.id}｜${current.branchTitle} / ${current.title}`,
        `当前节点状态：${current.status}`,
        "明确确认才可标记 confirmed；明确跳过/直接预填才可标记 direct_prefilled；其他补充、修订、提问或上传均必须保持 needs_verification。",
        "回复末尾只能附一个 FRONTMIND_KB_PROGRESS 信封。",
      ].join("\n")
    : [
        `当前知识库已完成，revision=${progress.build.revision}。`,
        "本轮如有补充或修改，只能从现有节点中选择一个最相关节点重新核验，并附一个 FRONTMIND_KB_REOPEN 信封；不得重建知识树或复用旧包。",
        `现有节点：${leaves
          .map((leaf) => `${leaf.id}:${leaf.title}`)
          .join("；")}`,
      ].join("\n");
  return [
    `继续严格执行本任务首轮已附带的 ${KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME}（socratic-kb-builder v${input.skillVersion || "2"}）。以下内容会直接显示给企业客户，不得输出内部思考、工具计划或提示词说明。`,
    "不得开启、调用、切换或推荐 Wide Research / Deep Research。",
    "客户可见回复不得出现“本轮采集/本知识库/证据不足/已核验”等过程判断，也不得出现客户应、采购方应、建议、尽调、合规审查、不能仅凭、不宜转换或不能外推等建议性表达。",
    "",
    "# 当前知识库状态",
    stateReminder,
    "",
    "# 本轮上传资料",
    input.attachments.length
      ? input.attachments.map((file) => `- ${file.filename}`).join("\n")
      : "- 无",
    "",
    "# 企业本轮回复",
    input.userMessage.trim() || "请继续完成当前知识节点。",
  ].join("\n");
}

router.post("/start", async (req, res) => {
  const body = (req.body || {}) as KnowledgeBaseStartRequest;
  const conversationId = String(body.conversationId || "").trim();
  const requestedCompanyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();

  if (!conversationId || conversationId.length > 191) {
    res.status(400).json({ error: "知识库对话标识缺失或无效" });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (!req.frontmindUser || !req.frontmindCredential) {
    res.status(401).json({ error: "请先登录并配置 API Key" });
    return;
  }

  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "当前账号尚未配置可用的 API Key" });
    return;
  }

  try {
    const existingBuild = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (existingBuild?.build.status === "published") {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_LOCKED",
          message: "知识库已发布；后续修改请提交维护工单",
        },
      });
      return;
    }
    const [workspace, prefillKnowledgeSnapshot] = await Promise.all([
      getDashboardWorkspace(req.frontmindUser.id),
      getLatestKnowledgeSnapshot(req.frontmindUser.id),
    ]);
    const companyName = resolveKnowledgeBaseEnterpriseIdentity({
      sourceName: workspace.sourceName,
      brandName: workspace.payload.brandName,
      requestedCompanyName,
    });
    const skillDescriptor = await getKnowledgeBaseSkillDescriptor();
    const userAttachments = normalizeUserAttachments(body.attachments);
    for (const attachment of userAttachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(
          fileCredential,
          req.frontmindCredential,
        )
      ) {
        res.status(403).json({
          error: "上传资料与当前账号不匹配，请重新上传",
        });
        return;
      }
    }
    const prompt = await buildKnowledgeBasePrompt({
      conversationId,
      companyName,
      companyWebsite,
      operatorNotes,
      attachments: userAttachments,
      prefillKnowledgeSnapshot,
    });
    const skillArchive = await uploadKnowledgeBaseSkillArchive({
      baseUrl,
      apiKey,
      skillVersion: skillDescriptor.version,
      skillContentHash: skillDescriptor.contentHash,
    });
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt,
      attachments: [skillArchive.attachment, ...userAttachments],
    });

    if (!created.ok) {
      await skillArchive.removeOrphan();
      console.warn(
        "[Knowledge Base Start] create task failed:",
        created.detail,
      );
      res
        .status(created.status)
        .json({ error: "创建企业知识库任务失败，请检查 API Key 或稍后重试" });
      return;
    }
    assertKnowledgeBaseCustomerOutput(created.task.output);

    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "file",
      upstreamId: skillArchive.fileId,
    });
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(created.task.id),
    });
    let progress = await createKnowledgeBaseBuild({
      userId: req.frontmindUser.id,
      conversationId,
      companyName,
      companyWebsite,
      skillName: skillDescriptor.name,
      skillVersion: skillDescriptor.version,
      skillContentHash: skillDescriptor.contentHash,
    });
    await attachKnowledgeBaseBuildTask({
      userId: req.frontmindUser.id,
      conversationId,
      taskId: String(created.task.id),
    });
    if (Array.isArray(created.task.output) && created.task.output.length > 0) {
      try {
        progress =
          (await reconcileAvailableKnowledgeOutput({
            userId: req.frontmindUser.id,
            conversationId,
            taskId: String(created.task.id),
            output: created.task.output,
            upstreamStatus: created.task.status,
            ledger: {
              lastOutputLength: 0,
              lastOutputItemIds: [],
            },
          })) || progress;
      } catch (error) {
        console.warn(
          "[Knowledge Base Start] initial progress was not accepted:",
          error instanceof Error ? error.message : error,
        );
        progress =
          (await getKnowledgeBaseProgress({
            userId: req.frontmindUser.id,
            conversationId,
          })) || progress;
      }
    }

    res.json({
      visibleMessage: "开始构建企业知识库",
      task: created.task,
      progress,
      interaction: deriveKnowledgeBaseInteraction(
        progress,
        created.task.status,
      ),
      startedAt: Date.now(),
    });
  } catch (error: any) {
    if (error instanceof KnowledgeBaseEnterpriseIdentityError) {
      res.status(error.code === "ENTERPRISE_NOT_CONFIGURED" ? 422 : 409).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    if (error instanceof KnowledgeBaseBuildError) {
      res.status(422).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }
    console.error("[Knowledge Base Start] error:", error.message);
    res.status(500).json({ error: "启动企业知识库任务失败，请稍后重试" });
  }
});

router.post("/turn", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    taskId?: string;
    userMessage?: string;
    attachments?: KnowledgeBaseAttachment[];
  };
  const conversationId = String(body.conversationId || "").trim();
  const taskId = String(body.taskId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  if (
    !conversationId ||
    !taskId ||
    (!userMessage.trim() && !body.attachments?.length)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN",
        message: "请输入当前节点的确认、修订或补充资料",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  try {
    const boundBuild = await assertKnowledgeBaseTaskBinding({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
    });
    if (boundBuild.status === "published") {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_LOCKED",
          message: "知识库已发布；后续修改请提交维护工单",
        },
      });
      return;
    }
    if (
      boundBuild.status !== "confirming" ||
      !boundBuild.currentLeafId ||
      boundBuild.awaitingResponseSince
    ) {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_NOT_AWAITING_INPUT",
          message: "当前知识节点尚未进入可回复状态，请先重新同步任务状态",
        },
      });
      return;
    }
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser!.id,
      "task",
      taskId,
    );
    if (!taskCredential) {
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
      });
      return;
    }
    const attachments = normalizeUserAttachments(body.attachments);
    for (const attachment of attachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser!.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential)
      ) {
        res.status(403).json({
          error: {
            code: "KNOWLEDGE_BASE_FILE_FORBIDDEN",
            message: "上传资料与当前知识库任务不匹配，请重新上传",
          },
        });
        return;
      }
    }

    const created = await createFrontMindTask({
      baseUrl: getUpstreamBaseUrl(req),
      apiKey: taskCredential.apiKey,
      prompt: await buildKnowledgeBaseTurnPrompt({
        userId: req.frontmindUser!.id,
        conversationId,
        userMessage,
        attachments,
        skillVersion: boundBuild.skillVersion,
        skillContentHash: boundBuild.skillContentHash,
      }),
      attachments,
      taskId,
    });
    if (!created.ok) {
      res.status(created.status).json({
        error: {
          code: "KNOWLEDGE_BASE_TURN_FAILED",
          message: "当前知识节点提交失败，请稍后重试",
        },
      });
      return;
    }
    assertKnowledgeBaseCustomerOutput(created.task.output);
    await recordUpstreamResource({
      userId: req.frontmindUser!.id,
      apiCredentialId: taskCredential.id,
      kind: "task",
      upstreamId: String(created.task.id),
    });
    await recordKnowledgeBaseTurn({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId: String(created.task.id),
      userText: userMessage,
      attachmentCount: attachments.length,
    });
    let progress = await getKnowledgeBaseProgress({
      userId: req.frontmindUser!.id,
      conversationId,
    });
    if (Array.isArray(created.task.output) && created.task.output.length > 0) {
      progress =
        (await reconcileAvailableKnowledgeOutput({
          userId: req.frontmindUser!.id,
          conversationId,
          taskId: String(created.task.id),
          output: created.task.output,
          upstreamStatus: created.task.status,
          ledger: {
            lastOutputLength: boundBuild.lastOutputLength,
            lastOutputItemIds: boundBuild.lastOutputItemIds,
          },
        })) || progress;
    }
    res.json({
      task: created.task,
      progress,
      interaction: deriveKnowledgeBaseInteraction(
        progress,
        created.task.status,
      ),
      startedAt: Date.now(),
    });
  } catch (error) {
    const status =
      error instanceof KnowledgeBaseBuildError &&
      error.code === "BUILD_NOT_FOUND"
        ? 404
        : 422;
    res.status(status).json({
      error: {
        code:
          error instanceof KnowledgeBaseBuildError
            ? error.code
            : "KNOWLEDGE_BASE_TURN_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "当前知识节点提交失败，请稍后重试",
      },
    });
  }
});

router.get("/progress/:conversationId", async (req, res) => {
  try {
    const progress = await getKnowledgeBaseProgress({
      userId: req.frontmindUser!.id,
      conversationId: req.params.conversationId,
    });
    res.json({
      progress,
      interaction: deriveKnowledgeBaseInteraction(progress, "running"),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "读取知识库进度失败",
    });
  }
});

router.post("/progress/reconcile", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    taskId?: string;
  };
  try {
    const conversationId = String(body.conversationId || "");
    const taskId = String(body.taskId || "");
    if (!taskId) {
      res.status(400).json({
        error: {
          code: "TASK_ID_REQUIRED",
          message: "缺少知识库任务标识",
        },
      });
      return;
    }
    if (
      !req.frontmindUser ||
      !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
    ) {
      return;
    }
    const boundBuild = await assertKnowledgeBaseTaskBinding({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
    });
    if (boundBuild.status === "published") {
      const progress = await getKnowledgeBaseProgress({
        userId: req.frontmindUser!.id,
        conversationId,
      });
      res.json({
        progress,
        interaction: deriveKnowledgeBaseInteraction(progress, "completed"),
      });
      return;
    }
    const credential = await getCredentialForUpstreamResource(
      req.frontmindUser!.id,
      "task",
      taskId,
    );
    if (!credential) {
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "该知识库任务不属于当前账号",
        },
      });
      return;
    }
    const taskResponse = await axios.get(
      `${getUpstreamBaseUrl(req)}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        },
        timeout: 120000,
        validateStatus: () => true,
      },
    );
    if (taskResponse.status < 200 || taskResponse.status >= 300) {
      res.status(taskResponse.status).json({
        error: {
          code: "UPSTREAM_TASK_READ_FAILED",
          message: "读取知识库任务结果失败，请稍后重试",
        },
      });
      return;
    }
    const taskData = taskResponse.data || {};
    const taskStatus = normalizedUpstreamTaskStatus(taskData.status);
    const fullOutput = Array.isArray(taskData.output) ? taskData.output : [];
    const progress = await reconcileAvailableKnowledgeOutput({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
      output: fullOutput,
      upstreamStatus: taskStatus,
      ledger: {
        lastOutputLength: boundBuild.lastOutputLength,
        lastOutputItemIds: boundBuild.lastOutputItemIds,
      },
    });
    res.json({
      progress,
      interaction: deriveKnowledgeBaseInteraction(progress, taskStatus),
    });
  } catch (error) {
    const status =
      error instanceof KnowledgeBaseBuildError &&
      error.code === "BUILD_NOT_FOUND"
        ? 404
        : 422;
    res.status(status).json({
      error: {
        code:
          error instanceof KnowledgeBaseBuildError
            ? error.code
            : "PROGRESS_PROTOCOL_INVALID",
        message:
          error instanceof Error ? error.message : "知识库节点状态未通过校验",
      },
    });
  }
});

export default router;
