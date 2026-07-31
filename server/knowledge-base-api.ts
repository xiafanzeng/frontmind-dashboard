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
  claimKnowledgeBaseTurn,
  classifyKnowledgeBaseUserAction,
  createKnowledgeBaseBuild,
  extractFinalKnowledgeBaseAssistantText,
  getKnowledgeBaseProgress,
  isAmbiguousKnowledgeBaseAdvance,
  recordKnowledgeBaseTurn,
  releaseKnowledgeBaseTurnClaim,
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
import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";
import { buildDeterministicTaskAttachmentArchive } from "./task-attachment-package";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import { KNOWLEDGE_COLLECTION_STATUS_COPY } from "../shared/knowledge-base-copy";
import { extractKnowledgeBaseProtocolObjects } from "../shared/knowledge-base-output";

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
  options: { replayStableOutput?: boolean } = {},
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
    // Some providers reuse the same output item ID and replace its content for
    // every continuation turn. While a task is running we must not replay the
    // previous closed envelope, but once the provider reports a terminal state
    // the complete payload is authoritative. The reconciliation content hash
    // below makes an unchanged terminal replay idempotent.
    return options.replayStableOutput ? output : [];
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
const COMPLETE_KNOWLEDGE_MANIFEST =
  /<!--\s*FRONTMIND_KB_MANIFEST\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_TRANSITION =
  /<!--\s*FRONTMIND_KB_(?:PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_PRESENTATION =
  /<!--\s*FRONTMIND_KB_PRESENTATION\b[\s\S]*?-->/i;

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
  options: { requirePresentation?: boolean } = {},
) {
  const text = extractFinalKnowledgeBaseAssistantText(output);
  if (!text) return false;
  const rawKinds = new Set(
    extractKnowledgeBaseProtocolObjects(text).map((value) => value.kind),
  );
  if (options.requirePresentation) {
    if (
      COMPLETE_KNOWLEDGE_MANIFEST.test(text) ||
      rawKinds.has("frontmind.knowledge-base.manifest")
    ) {
      return true;
    }
    if (
      (COMPLETE_KNOWLEDGE_TRANSITION.test(text) ||
        rawKinds.has("frontmind.knowledge-base.progress") ||
        rawKinds.has("frontmind.knowledge-base.reopen")) &&
      (COMPLETE_KNOWLEDGE_PRESENTATION.test(text) ||
        rawKinds.has("frontmind.knowledge-base.presentation"))
    ) {
      return true;
    }
    return upstreamTaskTerminal(status);
  }
  if (
    COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE.test(text) ||
    COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT.test(text) ||
    rawKinds.has("frontmind.knowledge-base.manifest") ||
    rawKinds.has("frontmind.knowledge-base.progress") ||
    rawKinds.has("frontmind.knowledge-base.reopen")
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
    { replayStableOutput: upstreamTaskTerminal(input.upstreamStatus) },
  );
  if (
    shouldReconcileKnowledgeOutput(unreconciled, input.upstreamStatus, {
      requirePresentation: progress?.build.skillVersion === "3",
    })
  ) {
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
        await assertKnowledgeBaseWritable(build.userId);
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
const currentSkillArchiveCandidates = skillArchiveCandidates.map((candidate) =>
  path.join(path.dirname(candidate), "socratic-kb-builder-v3.skill"),
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
  selection: KnowledgeBaseSkillSelection = { version: "3" },
) {
  const version =
    selection.version === "1" ? "1" : selection.version === "2" ? "2" : "3";
  const cacheKey = `${version}:${selection.contentHash || "latest"}`;
  const cached = skillArchiveCache.get(cacheKey);
  if (cached) {
    if (selection.contentHash && selection.contentHash !== cached.contentHash) {
      throw new Error(
        `Knowledge-base Skill v${version} content hash does not match the active build`,
      );
    }
    return cached;
  }

  let lastError: unknown;
  let contentHashMismatchError: Error | null = null;
  const candidates =
    version === "1"
      ? legacySkillArchiveCandidates
      : version === "2"
        ? skillArchiveCandidates
        : [
            ...(selection.contentHash
              ? currentSkillArchiveCandidates.map((candidate) =>
                  path.join(
                    path.dirname(candidate),
                    `socratic-kb-builder-v3-${selection.contentHash}.skill`,
                  ),
                )
              : []),
            ...currentSkillArchiveCandidates,
          ];
  for (const candidate of candidates) {
    try {
      const archive = await fs.readFile(candidate);
      const zip = await JSZip.loadAsync(archive);
      const entries =
        version !== "1"
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
        contentHashMismatchError = new Error(
          `Knowledge-base Skill v${version} content hash does not match the active build`,
        );
        continue;
      }
      skillArchiveCache.set(cacheKey, loaded);
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  if (contentHashMismatchError) {
    throw contentHashMismatchError;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load socratic-kb-builder Skill v${version}`);
}

async function readSkillArchive(
  selection: KnowledgeBaseSkillSelection = { version: "3" },
) {
  return (await loadSkillArchive(selection)).instructions;
}

export async function readKnowledgeBaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection = { version: "3" },
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
  selection: KnowledgeBaseSkillSelection = { version: "3" },
) {
  const version =
    selection.version === "1" ? "1" : selection.version === "2" ? "2" : "3";
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

type KnowledgePrefillSnapshot = {
  version: number;
  sourceFileName: string;
  archiveHash: string | null;
  documentCount: number;
  imageCount: number;
  characterCount: number;
  documents: KnowledgePrefillDocument[];
};

export const KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME =
  "knowledge-base-prefill-evidence.zip";

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

export async function buildKnowledgeBasePrefillEvidenceArchive(
  snapshot: KnowledgePrefillSnapshot,
) {
  return buildDeterministicTaskAttachmentArchive({
    name: "knowledge-base-prefill-evidence",
    entrypoint: "knowledge.md",
    files: [
      {
        path: "context.json",
        content: `${JSON.stringify(
          {
            schemaVersion: 1,
            knowledgeSnapshot: {
              version: snapshot.version,
              sourceFileName: snapshot.sourceFileName,
              archiveHash: snapshot.archiveHash,
              documentCount: snapshot.documentCount,
              imageCount: snapshot.imageCount,
              characterCount: snapshot.characterCount,
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "knowledge.md",
        content:
          buildKnowledgePrefillExcerpt(snapshot.documents) ||
          "当前版本没有可读取的正文。",
      },
    ],
  });
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
  prefillKnowledgeSnapshot?: KnowledgePrefillSnapshot | null;
}) {
  const attachmentList =
    attachments.length > 0
      ? attachments.map((attachment) => `- ${attachment.filename}`).join("\n")
      : "- 未上传附件，请优先使用企业官网与全网公开资料进行预填";
  return [
    `严格执行随任务附带的 ${KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME}。先解压 ZIP 并完整读取根目录 SKILL.md，再开始工作。`,
    "该 ZIP 是本任务唯一的 socratic-kb-builder v3 工作规约；本段仅提供企业输入和服务端状态约束。",
    "不得开启、调用、切换或推荐 Wide Research / Deep Research；只使用当前 Pro Agent 模式下的普通浏览、搜索和文件工具。",
    "客户可见正文与本轮对话只能呈现百科事实，不得呈现任务过程、核验判断、采购/合规建议、读者指令、工具计划或模型推理。",
    "客户可见回复只输出知识树统计（仅首轮需要）和实际展示节点的完整正文/合规配图。不得输出参考资料、参考来源、References、Sources、编号引用、外部引用链接、未决事项、核验备注、操作提示或确认问题；所有来源只进入内部证据文件。可见正文结束后直接附机器信封。",
    "客户可见正文不得嵌入官网或 CDN 图片外链。图片必须先下载真实字节、解码校验并打入最终 ZIP，再以包内相对路径引用；防盗链、签名、过期或无法下载的地址只能进入内部来源记录，绝不能作为客户图片返回。",
    "全任务只采集最多三张互不重复的经典企业图片：主 Logo、品牌主视觉、典型产品/UI/架构图各最多一张；取得三张后立即停止图片发现。只有首轮清单第一个叶子（通常为 1.1 一句话定位）可把已下载验证的本地字节作为 output_image 或 image MIME output_file 返回。后续所有节点、修订与重开轮次一律纯文字，不得重复或新增图片附件。首轮附件与最终 ZIP 必须使用同一资产字节。",
    `资料采集阶段统一向客户显示：${KNOWLEDGE_COLLECTION_STATUS_COPY}`,
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
          `完整预填证据见任务附件 ${KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME}。先解压并读取 knowledge.md 与 context.json；这些证据不代表节点已确认，也不得据此伪造 100% 对话进度。`,
        ].join("\n")
      : "当前账号没有已迁移的初步知识库，将从官网、全网与上传资料开始预填。",
    "## 必须执行的机器可验证进度协议",
    "这是服务端状态机协议，优先级高于 skill 中任何会自动跨节点的表述。可读正文照常输出：首轮末尾只能附一个清单信封；后续轮末尾必须依次附一个状态/重开信封和一个展示信封。",
    "信封的 `<!-- FRONTMIND_KB_...` 开头与 `-->` 结尾都是协议必填内容，必须原样保留；禁止输出裸 JSON，禁止输出 SOCRATIC_KB_STATE，禁止用 frontmind.workflow-state、frontmind.knowledge-base.message 或其他自创对象替代下列四种规定信封。",
    "",
    "### 首轮研究与知识树建立",
    "完成官网、公开来源、上传资料研究和正式图文预填后，按企业实际资料量建立自适应一级分支和 8-115 个真实叶子节点。白牌企业或只有宣传单时只保留有事实价值或明确缺口的必要叶子，不得为数量、字数或图片数填充内容。一级分支数量不设固定值；每个叶子必须有全局唯一且后续不变的 id、title、branchId、branchTitle。首轮正文展示完整分支统计并呈现第一个叶子节点，然后仅在回复末尾附：",
    '<!-- FRONTMIND_KB_MANIFEST\n{"kind":"frontmind.knowledge-base.manifest","schemaVersion":1,"leaves":[{"id":"1.1","title":"一句话定位","branchId":"identity","branchTitle":"企业身份"}]}\n-->',
    "示例只演示结构，真实 leaves 必须完整包含 8-115 项并覆盖基于当前企业证据形成的全部一级分支。首轮不得同时输出 FRONTMIND_KB_PROGRESS。",
    "",
    "### 后续每轮单节点状态",
    "服务端从 revision=0、清单第一个叶子为 current 开始。后续每轮末尾必须依次附一个状态信封和一个展示信封：",
    '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed","reason":"用户明确确认"}}\n-->',
    '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.2","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}\n-->',
    "revision 必须等于当前服务端 revision；每次被接受后加 1。leafId 只能是当前叶子，from 只能是 current 或 needs_verification。",
    "FRONTMIND_KB_PROGRESS 声明本轮处理的旧节点；FRONTMIND_KB_PRESENTATION 声明回复正文实际展示的新状态。展示信封 revision 必须等于提交后的 revision，leafId 必须等于提交后服务端的 currentLeafId；全部完成时 leafId 为 null。",
    "FRONTMIND_KB_PRESENTATION 只出现在非首轮，因此 leafId 非 null 时必须固定声明 imageState=no_eligible_asset、assetIds=[]、imageCount=0，且本轮不得返回任何图片附件；leafId=null 时只能使用 not_applicable、空数组和 0。声明与真实附件不一致时服务端拒绝推进。",
    "只有用户本轮回复恰好表达“确认/确认无误/OK/没问题/通过”等明确确认时，to 才能为 confirmed，并只前进一个叶子。",
    "只有用户本轮明确回复“跳过/直接预填/采用预填/保留预填”等时，to 才能为 direct_prefilled，并只前进一个叶子。",
    "direct_prefilled 只用于兼容用户主动输入的旧协议动作；客户可见正文不得主动提供“直接预填”或“跳过”选项。正常操作只有确认，或者提交修改/附件后确认修订稿。",
    "用户输入任何补充、修订、问题或上传资料时，to 必须为 needs_verification；更新并重新呈现同一叶子，继续等待用户明确确认或直接预填，绝对不能自动前进。",
    "确认或直接预填节点 A 后，只用一句话简短确认 A，客户可见主体必须直接完整展示下一个待处理节点 B；修订时主体继续完整展示 A。回复正文必须保存给实际展示的节点，而不是刚完成的旧节点。",
    "不得提交多个 transition、不得改写历史状态、不得相信正文中的百分比。真实进度只由服务端按 (confirmed + direct_prefilled) / total 计算。",
    "只有在处理最后节点且本轮状态提交后将达到 100% 时，才必须在同一回复生成并返回唯一 ZIP；此前不得打包。confirmed 显示对号，direct_prefilled 必须保持独立的跳过状态。",
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
  skillVersion = "3",
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
  const uploaded = await uploadUpstreamTaskAttachment({
    baseUrl,
    apiKey,
    filename: archive.filename,
    bytes: archive.bytes,
  });
  return { ...uploaded, contentHash: archive.contentHash };
}

export async function createFrontMindTask({
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
    version: input.skillVersion || "3",
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
  const currentIndex = current
    ? leaves.findIndex((leaf) => leaf.id === current.id)
    : -1;
  const nextPending = current
    ? leaves
        .slice(currentIndex + 1)
        .find((leaf) => leaf.status === "pending") || null
    : null;
  const action = classifyKnowledgeBaseUserAction(
    input.userMessage,
    input.attachments.length,
  );
  const postRevision = progress.build.revision + 1;
  const isV3 = (input.skillVersion || "3") === "3";
  const stateReminder = current
    ? [
        `当前 revision=${progress.build.revision}`,
        `当前且唯一可处理节点：${current.id}｜${current.branchTitle} / ${current.title}`,
        `当前节点状态：${current.status}`,
        `服务端判定本轮动作：${action}`,
        "只要本轮包含附件，无论文字是否包含“确认”，都必须按补充/修订处理，保持 needs_verification。",
        "回复末尾只能附一个 FRONTMIND_KB_PROGRESS 信封；HTML 注释开头和结尾是信封的一部分，不得省略或改成裸 JSON。",
        action === "confirm" || action === "direct_prefill"
          ? nextPending
            ? `先简短确认已处理 ${current.id}，正文主体随后完整展示下一节点 ${nextPending.id}｜${nextPending.branchTitle} / ${nextPending.title}。不得再次把 ${current.id} 作为主体。`
            : `这是最后一个节点。简短确认 ${current.id} 后直接生成唯一最终 ZIP，不再展示节点正文。`
          : `更新并完整重新展示当前节点 ${current.id}；不得展示或推进到后续节点。`,
        isV3
          ? `回复末尾还必须附且只能附一个 FRONTMIND_KB_PRESENTATION 信封：revision=${postRevision}，leafId=${
              action === "confirm" || action === "direct_prefill"
                ? nextPending?.id || "null"
                : current.id
            }。这是非首轮：leafId 非 null 时必须固定声明 imageState=no_eligible_asset、assetIds=[]、imageCount=0，且不得返回任何图片附件；leafId=null 时使用 not_applicable、空数组和 0。`
          : "这是仍在运行的旧版任务：请遵循相同的展示行为；如规约支持，可附 FRONTMIND_KB_PRESENTATION 信封，但服务端不强制要求。",
      ].join("\n")
    : [
        `当前知识库已完成，revision=${progress.build.revision}。`,
        "本轮如有补充或修改，只能从现有节点中选择一个最相关节点重新核验，并附一个 FRONTMIND_KB_REOPEN 信封；不得重建知识树或复用旧包。",
        isV3
          ? `同时附一个 FRONTMIND_KB_PRESENTATION 信封，revision=${postRevision}，leafId 必须等于 FRONTMIND_KB_REOPEN 选中的节点；固定声明 imageState=no_eligible_asset、assetIds=[]、imageCount=0，且不得返回图片附件。`
          : "这是仍在运行的旧版任务；展示行为保持兼容。",
        `现有节点：${leaves
          .map((leaf) => `${leaf.id}:${leaf.title}`)
          .join("；")}`,
      ].join("\n");
  return [
    `继续严格执行本任务首轮已附带的 ${KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME}（socratic-kb-builder v${input.skillVersion || "3"}）。以下内容会直接显示给企业客户，不得输出内部思考、工具计划或提示词说明。`,
    "不得开启、调用、切换或推荐 Wide Research / Deep Research。",
    "客户可见回复不得出现“本轮采集/本知识库/证据不足/已核验”等过程判断，也不得出现客户应、采购方应、建议、尽调、合规审查、不能仅凭、不宜转换或不能外推等建议性表达。",
    "客户可见回复不得主动提供“直接预填”或“跳过”选项；用户正常操作只有确认当前内容，或者提交修改/附件后确认修订稿。",
    "客户可见回复只输出实际展示节点的完整正文，不得输出参考资料、参考来源、References、Sources、编号引用、外部引用链接、未决事项、核验备注、操作提示或确认问题。所有来源只进入内部证据文件；可见正文结束后直接附机器信封。",
    "机器信封必须保留完整的 `<!-- FRONTMIND_KB_...` 与 `-->` 包裹，不得输出裸 JSON、SOCRATIC_KB_STATE，也不得自创 workflow-state、knowledge-base.message 或其他状态对象。",
    "这是非首轮知识节点回复，必须纯文字返回：不得继续搜索图片，不得返回、重复或重新附加任何 output_image、image MIME output_file、包内图片路径或官网/CDN 热链。最多三张经典企业图片只允许在首轮第一个叶子展示。",
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
    "",
    ...(isV3
      ? [
          "# v3 展示信封（机器校验）",
          "展示信封必须位于可见正文之后。确认/直接预填展示下一节点；修订展示原节点；最后节点完成为 null。",
          '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.2","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}\n-->',
        ]
      : []),
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
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
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
    const generatedAttachments: Array<{
      attachment: { file_id: string; filename: string };
      fileId: string;
      removeOrphan: () => Promise<void>;
    }> = [skillArchive];
    if (prefillKnowledgeSnapshot) {
      try {
        const prefillArchive = await buildKnowledgeBasePrefillEvidenceArchive(
          prefillKnowledgeSnapshot,
        );
        generatedAttachments.push(
          await uploadUpstreamTaskAttachment({
            baseUrl,
            apiKey,
            filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
            bytes: prefillArchive.bytes,
          }),
        );
      } catch (error) {
        await Promise.allSettled(
          generatedAttachments.map((attachment) => attachment.removeOrphan()),
        );
        throw error;
      }
    }
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt,
      attachments: [
        ...generatedAttachments.map((item) => item.attachment),
        ...userAttachments,
      ],
    });

    if (!created.ok) {
      await Promise.allSettled(
        generatedAttachments.map((attachment) => attachment.removeOrphan()),
      );
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

    for (const attachment of generatedAttachments) {
      await recordUpstreamResource({
        userId: req.frontmindUser.id,
        apiCredentialId: req.frontmindCredential.id,
        kind: "file",
        upstreamId: attachment.fileId,
      });
    }
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
    expectedRevision?: number;
    expectedLeafId?: string;
  };
  const conversationId = String(body.conversationId || "").trim();
  const taskId = String(body.taskId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedRevision = body.expectedRevision;
  const expectedLeafId = String(body.expectedLeafId || "").trim();
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
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_REVISION",
        message: "当前知识节点版本无效，请刷新后重试",
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
  if (
    !body.attachments?.length &&
    isAmbiguousKnowledgeBaseAdvance(userMessage)
  ) {
    res.status(422).json({
      error: {
        code: "AMBIGUOUS_KNOWLEDGE_BASE_ACTION",
        message:
          "“继续/下一步”不会推进知识节点。请点击“确认当前内容”；如需修改，请直接输入意见或上传资料。",
      },
    });
    return;
  }

  try {
    await assertKnowledgeBaseWritable(req.frontmindUser!.id);
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
    if (
      (expectedRevision !== undefined &&
        boundBuild.revision !== expectedRevision) ||
      (expectedLeafId && boundBuild.currentLeafId !== expectedLeafId)
    ) {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_STALE_PRESENTATION",
          message: "当前节点已更新，本次重复提交未执行；请以最新内容为准",
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

    await claimKnowledgeBaseTurn({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
      userText: userMessage,
      attachmentCount: attachments.length,
      expectedRevision,
      expectedLeafId: expectedLeafId || undefined,
    });
    let created: Awaited<ReturnType<typeof createFrontMindTask>>;
    try {
      created = await createFrontMindTask({
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
    } catch (error) {
      await releaseKnowledgeBaseTurnClaim({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
      });
      throw error;
    }
    if (!created.ok) {
      await releaseKnowledgeBaseTurnClaim({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
      });
      res.status(created.status).json({
        error: {
          code: "KNOWLEDGE_BASE_TURN_FAILED",
          message: "当前知识节点提交失败，请稍后重试",
        },
      });
      return;
    }
    await recordKnowledgeBaseTurn({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId: String(created.task.id),
      userText: userMessage,
      attachmentCount: attachments.length,
    });
    assertKnowledgeBaseCustomerOutput(created.task.output);
    await recordUpstreamResource({
      userId: req.frontmindUser!.id,
      apiCredentialId: taskCredential.id,
      kind: "task",
      upstreamId: String(created.task.id),
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
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
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
