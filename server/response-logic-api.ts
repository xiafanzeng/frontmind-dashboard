import axios from "axios";
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  RESPONSE_LOGIC_MODEL_SECTIONS,
  ResponseLogicOutputContractError,
  parseResponseLogicStructuredDraft,
  responseLogicDraftSchema,
  responseLogicQuestionSchema,
  type ResponseLogicAttachment,
  type ResponseLogicDraft,
  type ResponseLogicRecordDto,
  type ResponseLogicStructuredDraft,
} from "../shared/response-logic";
import {
  credentialsUseSameUpstreamApiKey,
  getCredentialForUpstreamResource,
} from "./auth-service";
import {
  getDashboardQuestion,
  getLatestKnowledgeSnapshot,
} from "./dashboard-service";
import {
  getFrontMindCredentials,
  getUpstreamBaseUrl,
  toUpstreamAgentProfile,
} from "./upstream-config";
import {
  ResponseLogicTaskActiveError,
  getResponseLogicEntry,
  recordResponseLogicTaskStart,
  releaseResponseLogicTaskBinding,
} from "./response-logic-service";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";
import {
  redactSensitivePayload,
  redactSensitiveText,
  safeErrorForLog,
} from "./_core/sensitive-data";

const router = Router();

const attachmentSchema = z.object({
  file_id: z.string().trim().min(1).max(255),
  filename: z.string().trim().min(1).max(512),
  mime_type: z.string().trim().min(1).max(255).optional(),
});

const responseLogicStartSchema = responseLogicQuestionSchema.extend({
  conversationId: z.string().trim().min(1).max(191),
  taskId: z.string().trim().min(1).max(255).optional(),
  userMessage: z.string().max(200_000),
  draft: responseLogicDraftSchema,
  attachments: z.array(attachmentSchema).max(100).default([]),
});

type ResponseLogicStartInput = z.infer<typeof responseLogicStartSchema>;

const responseLogicTaskStatusQuerySchema = z
  .object({
    questionId: z.string().trim().min(1).max(191),
    conversationId: z.string().trim().min(1).max(191),
  })
  .strict();

export class ResponseLogicTaskBindingError extends Error {
  constructor(
    public readonly code:
      | "RESPONSE_LOGIC_WORKSPACE_FORBIDDEN"
      | "RESPONSE_LOGIC_QUESTION_FORBIDDEN"
      | "RESPONSE_LOGIC_CONVERSATION_FORBIDDEN"
      | "RESPONSE_LOGIC_TASK_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "ResponseLogicTaskBindingError";
  }
}

export function responseLogicRecordMatchesConfiguredQuestion(input: {
  record: Pick<
    ResponseLogicRecordDto,
    "questionId" | "groupId" | "groupTitle" | "question" | "intent" | "summary"
  >;
  configuredQuestion: {
    questionId: string;
    groupId: string;
    groupTitle: string;
    question: string;
    intent: string;
    summary: string;
  };
}) {
  return (
    input.record.questionId === input.configuredQuestion.questionId &&
    input.record.groupId === input.configuredQuestion.groupId &&
    input.record.groupTitle === input.configuredQuestion.groupTitle &&
    input.record.question === input.configuredQuestion.question &&
    input.record.intent === input.configuredQuestion.intent &&
    input.record.summary === input.configuredQuestion.summary
  );
}

/**
 * The authenticated user ID is the tenant workspace ID in this application.
 * Keeping the complete binding check in one pure function makes it impossible
 * to accidentally validate only the upstream task ledger and omit the
 * question/conversation binding.
 */
export function assertResponseLogicTaskBinding(input: {
  authenticatedUserId: number;
  workspaceUserId: number;
  questionId: string;
  conversationId: string;
  taskId: string;
  record: ResponseLogicRecordDto | null;
  configuredQuestion: {
    questionId: string;
    groupId: string;
    groupTitle: string;
    question: string;
    intent: string;
    summary: string;
  };
}) {
  if (input.authenticatedUserId !== input.workspaceUserId) {
    throw new ResponseLogicTaskBindingError(
      "RESPONSE_LOGIC_WORKSPACE_FORBIDDEN",
      "当前工作区与登录账号不匹配",
    );
  }
  if (!input.record || input.record.questionId !== input.questionId) {
    throw new ResponseLogicTaskBindingError(
      "RESPONSE_LOGIC_QUESTION_FORBIDDEN",
      "当前问题与应答逻辑记录不匹配",
    );
  }
  if (
    input.configuredQuestion.questionId !== input.questionId ||
    !responseLogicRecordMatchesConfiguredQuestion({
      record: input.record,
      configuredQuestion: input.configuredQuestion,
    })
  ) {
    throw new ResponseLogicTaskBindingError(
      "RESPONSE_LOGIC_QUESTION_FORBIDDEN",
      "管理员已更新当前问题配置，请基于最新问题重新生成应答逻辑",
    );
  }
  if (input.record.conversationId !== input.conversationId) {
    throw new ResponseLogicTaskBindingError(
      "RESPONSE_LOGIC_CONVERSATION_FORBIDDEN",
      "当前会话与应答逻辑记录不匹配",
    );
  }
  if (input.record.lastTaskId !== input.taskId) {
    throw new ResponseLogicTaskBindingError(
      "RESPONSE_LOGIC_TASK_FORBIDDEN",
      "当前任务不是该问题的最新应答逻辑任务",
    );
  }
}

export type NormalizedResponseLogicTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "unknown";

export function normalizeResponseLogicTaskStatus(
  status: unknown,
): NormalizedResponseLogicTaskStatus {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (
    [
      "created",
      "queued",
      "pending",
      "running",
      "in_progress",
      "processing",
      "requires_action",
      "cancelling",
    ].includes(normalized)
  ) {
    return "running";
  }
  if (
    ["completed", "complete", "succeeded", "success", "done"].includes(
      normalized,
    )
  ) {
    return "completed";
  }
  if (
    [
      "failed",
      "error",
      "cancelled",
      "canceled",
      "expired",
      "incomplete",
    ].includes(normalized)
  ) {
    return "failed";
  }
  return "unknown";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (isObject(value) && typeof value.value === "string") {
    return value.value.trim();
  }
  return "";
}

function assistantMessageText(rawItem: unknown) {
  if (!isObject(rawItem)) return "";
  if (rawItem.role === "user") return "";
  const role = typeof rawItem.role === "string" ? rawItem.role : "";
  const type = typeof rawItem.type === "string" ? rawItem.type : "";
  const isAssistantMessage =
    role === "assistant" ||
    (!role && ["message", "output_text"].includes(type));
  if (!isAssistantMessage) {
    return "";
  }

  const parts: string[] = [];
  for (const candidate of [
    rawItem.output_text,
    rawItem.text,
    typeof rawItem.content === "string" ? rawItem.content : undefined,
  ]) {
    const text = stringValue(candidate);
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (Array.isArray(rawItem.content)) {
    for (const rawContent of rawItem.content) {
      if (typeof rawContent === "string") {
        const text = rawContent.trim();
        if (text && !parts.includes(text)) parts.push(text);
        continue;
      }
      if (!isObject(rawContent)) continue;
      const contentType =
        typeof rawContent.type === "string" ? rawContent.type : "";
      if (!["output_text", "text", "message", ""].includes(contentType)) {
        continue;
      }
      const text = stringValue(rawContent.text ?? rawContent.value);
      if (text && !parts.includes(text)) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Only the final typed assistant message is eligible for parsing. Reasoning,
 * tool output, user messages, task descriptions, and arbitrary metadata never
 * enter the structured response.
 */
export function extractFinalResponseLogicAssistantReply(task: unknown) {
  if (!isObject(task)) return "";
  const output = Array.isArray(task.output) ? task.output : [];
  const messages = output
    .map(assistantMessageText)
    .filter((message) => Boolean(message));
  if (messages.length > 0) return messages[messages.length - 1];
  return stringValue(task.output_text);
}

export function parseCompletedResponseLogicTask(
  task: unknown,
): ResponseLogicStructuredDraft {
  const reply = extractFinalResponseLogicAssistantReply(task);
  return parseResponseLogicStructuredDraft(reply);
}

const imageMimeTypesByExtension: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

function normalizedAttachmentMimeType(filename: string, claimed?: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const imageMimeType = imageMimeTypesByExtension[extension];
  if (imageMimeType) return imageMimeType;
  const normalizedClaim = claimed?.trim().toLowerCase();
  if (
    normalizedClaim &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
      normalizedClaim,
    )
  ) {
    return normalizedClaim;
  }
  return "application/octet-stream";
}

/**
 * Only call this after every file ID has passed the authenticated ownership
 * check. The resulting records contain no browser-local blobs or signed URLs.
 */
export function buildVerifiedResponseLogicAttachments(
  attachments: ResponseLogicStartInput["attachments"],
  uploadedAt = new Date(),
): ResponseLogicAttachment[] {
  const timestamp = uploadedAt.toISOString();
  return attachments.map((attachment) => {
    const mimeType = normalizedAttachmentMimeType(
      attachment.filename,
      attachment.mime_type,
    );
    return {
      fileId: attachment.file_id,
      filename: attachment.filename,
      mimeType,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      uploadedAt: timestamp,
    };
  });
}

type KnowledgeSnapshotForPrompt = {
  version: number;
  sourceFileName: string;
  documents: Array<{ path: string; title: string; content: string }>;
  assets: Array<{ path: string; mimeType: string; size: number }>;
} | null;

const configuredResponseLogicSkillPath =
  process.env.FRONTMIND_RESPONSE_LOGIC_SKILL_PATH?.trim();
if (
  configuredResponseLogicSkillPath &&
  !path.isAbsolute(configuredResponseLogicSkillPath)
) {
  throw new Error(
    "FRONTMIND_RESPONSE_LOGIC_SKILL_PATH must be an absolute path",
  );
}
const skillDirectoryCandidates = configuredResponseLogicSkillPath
  ? [configuredResponseLogicSkillPath]
  : [
      path.resolve(
        import.meta.dirname,
        "private-workflows",
        "response-logic-builder.skill",
      ),
      path.resolve(
        process.cwd(),
        "private-workflows",
        "response-logic-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "private-workflows",
        "response-logic-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "private-workflows",
        "response-logic-builder.skill",
      ),
    ];

let cachedSkillInstructions: string | null = null;
let cachedSkillContentHash: string | null = null;

async function readResponseLogicSkill() {
  if (cachedSkillInstructions) return cachedSkillInstructions;
  let lastError: unknown;

  for (const directory of skillDirectoryCandidates) {
    try {
      const [skill, outputContract] = await Promise.all([
        fs.readFile(path.join(directory, "SKILL.md"), "utf8"),
        fs.readFile(
          path.join(directory, "references", "output-contract.md"),
          "utf8",
        ),
      ]);
      cachedSkillInstructions = [
        "# Response Logic Skill",
        skill.trim(),
        "",
        "# Output Contract",
        outputContract.trim(),
      ].join("\n\n");
      cachedSkillContentHash = createHash("sha256")
        .update(cachedSkillInstructions)
        .digest("hex");
      return cachedSkillInstructions;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not load response-logic-builder.skill");
}

export async function getResponseLogicSkillDescriptor() {
  await readResponseLogicSkill();
  return {
    name: "response-logic-builder",
    version: "1",
    contentHash: cachedSkillContentHash!,
  };
}

function compactKnowledgeSnapshot(snapshot: KnowledgeSnapshotForPrompt) {
  if (!snapshot) {
    return "尚未发布企业知识库版本。只可使用本轮上传资料与用户明确确认的事实；其他企业事实必须列为待确认。";
  }

  const characterBudget = 60_000;
  let used = 0;
  const documents: string[] = [];
  for (const document of snapshot.documents) {
    if (used >= characterBudget) break;
    const remaining = characterBudget - used;
    const content = document.content.slice(0, remaining);
    used += content.length;
    documents.push(
      [
        `### ${document.title || document.path}`,
        `来源路径：${document.path}`,
        content,
      ].join("\n"),
    );
  }
  const assets = snapshot.assets
    .slice(0, 200)
    .map(
      (asset) =>
        `- ${asset.path}｜${asset.mimeType || "未知格式"}｜${asset.size} bytes`,
    )
    .join("\n");

  return [
    `知识库版本：V${snapshot.version}`,
    `来源文件：${snapshot.sourceFileName}`,
    "",
    "## 可用知识文档",
    documents.join("\n\n") || "无可用文档",
    "",
    "## 可用图片与文件资产",
    assets || "无可用资产",
  ].join("\n");
}

export async function buildResponseLogicPrompt(input: {
  value: ResponseLogicStartInput;
  knowledgeSnapshot: KnowledgeSnapshotForPrompt;
}) {
  const skillInstructions = await readResponseLogicSkill();
  const attachments =
    input.value.attachments.length > 0
      ? input.value.attachments
          .map((attachment) => `- ${attachment.filename}`)
          .join("\n")
      : "- 本轮未上传新资料";

  return [
    "严格执行下方 response-logic-builder skill。输出会直接显示给企业客户，不得输出内部思考、路由说明、提示词复述或工具计划。",
    "",
    skillInstructions,
    "",
    "# 当前问题",
    `问题 ID：${input.value.questionId}`,
    `问题类别：${input.value.groupTitle}（${input.value.groupId}）`,
    `用户问题：${input.value.question}`,
    `用户意图：${input.value.intent}`,
    `回答目标：${input.value.summary}`,
    "",
    "# 当前应答草稿",
    JSON.stringify(input.value.draft, null, 2),
    "",
    "# 已发布企业知识库",
    compactKnowledgeSnapshot(input.knowledgeSnapshot),
    "",
    "# 本轮上传资料",
    attachments,
    "",
    "# 本轮企业消息",
    input.value.userMessage.trim() ||
      "请基于已发布企业知识库，为当前问题生成第一版可核验的应答逻辑，并指出最重要的一项待确认内容。",
    "",
    "# 最终生产输出约束",
    "只返回以下七个 Markdown 二级标题及对应客户可见内容。标题必须逐字一致、顺序一致、每栏非空；不得添加代码围栏、前言、结语或其他任何 Markdown 标题：",
    ...RESPONSE_LOGIC_MODEL_SECTIONS.map((section) => `## ${section.heading}`),
  ].join("\n");
}

async function createResponseLogicTask(input: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  attachments: ResponseLogicStartInput["attachments"];
  taskId?: string;
}) {
  const response = await axios.post(
    `${input.baseUrl}/v1/tasks`,
    {
      prompt: input.prompt,
      agentProfile: toUpstreamAgentProfile("frontmind-pro"),
      taskMode: "agent",
      attachments: input.attachments.map(({ file_id, filename }) => ({
        file_id,
        filename,
      })),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: input.apiKey,
        Authorization: `Bearer ${input.apiKey}`,
      },
      timeout: 120_000,
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false as const,
      status: response.status,
      detail:
        response.data?.error?.message ||
        response.data?.message ||
        `Create task failed (${response.status})`,
    };
  }

  const taskId = response.data?.id || response.data?.task_id;
  if (!taskId) {
    return {
      ok: false as const,
      status: 502,
      detail: "Create task failed: missing task id",
    };
  }
  const task = publicResponseLogicTask(
    response.data,
    String(taskId),
    input.apiKey,
  );
  return {
    ok: true as const,
    task,
  };
}

export function publicResponseLogicTask(
  payload: unknown,
  taskId: string,
  apiKey: string,
) {
  const redacted = redactSensitivePayload(payload, {
    secrets: [apiKey],
  });
  const task =
    redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>)
      : {};
  const metadata =
    task.metadata &&
    typeof task.metadata === "object" &&
    !Array.isArray(task.metadata)
      ? (task.metadata as Record<string, unknown>)
      : {};
  const status =
    task.status === "failed"
      ? "error"
      : typeof task.status === "string" && task.status
        ? task.status
        : "running";
  const taskUrl =
    typeof task.task_url === "string"
      ? task.task_url
      : typeof metadata.task_url === "string"
        ? metadata.task_url
        : undefined;
  const taskTitle =
    typeof task.task_title === "string"
      ? task.task_title
      : typeof metadata.task_title === "string"
        ? metadata.task_title
        : undefined;
  const publicId = redactSensitiveText(taskId, [apiKey]);

  return {
    id: publicId,
    status,
    ...(typeof task.model === "string" ? { model: task.model } : {}),
    metadata: {
      ...(taskUrl ? { task_url: taskUrl } : {}),
      ...(taskTitle ? { task_title: taskTitle } : {}),
    },
    output: Array.isArray(task.output) ? task.output : [],
  };
}

async function cancelOrphanedResponseLogicTask(input: {
  baseUrl: string;
  apiKey: string;
  taskId: string;
}) {
  try {
    await axios.delete(
      `${input.baseUrl}/v1/tasks/${encodeURIComponent(input.taskId)}`,
      {
        headers: {
          API_KEY: input.apiKey,
          Authorization: `Bearer ${input.apiKey}`,
        },
        timeout: 15_000,
        validateStatus: () => true,
      },
    );
  } catch (error) {
    console.error(
      "[Response Logic Start] orphan task cleanup failed",
      safeErrorForLog(error, { secrets: [input.apiKey] }),
    );
  }
}

router.get("/tasks/:taskId/status", async (req, res) => {
  const parsedQuery = responseLogicTaskStatusQuerySchema.safeParse(req.query);
  const taskId = String(req.params.taskId || "").trim();
  if (!taskId || taskId.length > 255 || !parsedQuery.success) {
    res.status(400).json({
      error: {
        code: "INVALID_RESPONSE_LOGIC_TASK_STATUS_INPUT",
        message: "缺少当前问题、会话或任务标识",
      },
    });
    return;
  }
  const user = req.frontmindUser;
  if (!user) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }

  let logSecret = "";
  try {
    await assertServiceCapability(user.id, "responseLogic");
    const configuredQuestion = await getDashboardQuestion(
      user.id,
      parsedQuery.data.questionId,
    );
    if (!configuredQuestion) {
      res.status(422).json({
        error: {
          code: "RESPONSE_LOGIC_QUESTION_NOT_CONFIGURED",
          message: "当前问题尚未由管理员配置",
        },
      });
      return;
    }

    const [record, credential] = await Promise.all([
      getResponseLogicEntry(user.id, parsedQuery.data.questionId),
      getCredentialForUpstreamResource(user.id, "task", taskId),
    ]);
    assertResponseLogicTaskBinding({
      authenticatedUserId: user.id,
      workspaceUserId: user.id,
      questionId: parsedQuery.data.questionId,
      conversationId: parsedQuery.data.conversationId,
      taskId,
      record,
      configuredQuestion,
    });
    if (!credential) {
      throw new ResponseLogicTaskBindingError(
        "RESPONSE_LOGIC_TASK_FORBIDDEN",
        "当前任务不属于此账号，或其绑定的 API Key 已不可用",
      );
    }
    logSecret = credential.apiKey;

    const upstream = await axios.get(
      `${getUpstreamBaseUrl(req)}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (upstream.status < 200 || upstream.status >= 300) {
      console.warn(
        "[Response Logic Status] upstream read failed:",
        upstream.status,
      );
      if (upstream.status === 404 || upstream.status === 410) {
        await releaseResponseLogicTaskBinding({
          userId: user.id,
          questionId: parsedQuery.data.questionId,
          taskId,
        });
        res.status(422).json({
          error: {
            code: "RESPONSE_LOGIC_TASK_UNAVAILABLE",
            message: "原应答逻辑任务已不存在，请重新生成",
          },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: "RESPONSE_LOGIC_TASK_READ_FAILED",
          message: "读取应答逻辑任务失败，请稍后重试",
        },
      });
      return;
    }

    const task = upstream.data?.task || upstream.data || {};
    const returnedTaskId = String(task.id || task.task_id || "");
    if (returnedTaskId !== taskId) {
      res.status(409).json({
        error: {
          code: "RESPONSE_LOGIC_TASK_MISMATCH",
          message: "读取到的任务与当前问题不匹配",
        },
      });
      return;
    }
    const status = normalizeResponseLogicTaskStatus(task.status);
    if (status === "running") {
      res.status(202).json({
        status: "running",
        taskId,
        model: "frontmind-pro",
      });
      return;
    }
    if (status === "failed") {
      await releaseResponseLogicTaskBinding({
        userId: user.id,
        questionId: parsedQuery.data.questionId,
        taskId,
      });
      res.status(422).json({
        error: {
          code: "RESPONSE_LOGIC_TASK_FAILED",
          message: "应答逻辑任务执行失败，请重新生成",
        },
      });
      return;
    }
    if (status === "unknown") {
      res.status(502).json({
        error: {
          code: "RESPONSE_LOGIC_TASK_STATUS_INVALID",
          message: "应答逻辑任务返回了无法识别的状态，请稍后重试",
        },
      });
      return;
    }

    let structuredDraft: ResponseLogicStructuredDraft;
    try {
      structuredDraft = parseCompletedResponseLogicTask(task);
    } catch (error) {
      console.warn(
        "[Response Logic Status] completed task output rejected:",
        safeErrorForLog(error, { secrets: [logSecret] }),
      );
      await releaseResponseLogicTaskBinding({
        userId: user.id,
        questionId: parsedQuery.data.questionId,
        taskId,
      });
      res.status(422).json({
        error: {
          code: "RESPONSE_LOGIC_TASK_OUTPUT_INVALID",
          message: "模型输出未通过七栏目校验，未载入草稿；请重新生成",
        },
      });
      return;
    }

    res.json({
      status: "completed",
      taskId,
      model: "frontmind-pro",
      structuredDraft,
    });
  } catch (error) {
    if (error instanceof ResponseLogicTaskBindingError) {
      if (error.code === "RESPONSE_LOGIC_QUESTION_FORBIDDEN") {
        await releaseResponseLogicTaskBinding({
          userId: user.id,
          questionId: parsedQuery.data.questionId,
          taskId,
        });
      }
      res.status(403).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof ServiceEntitlementError) {
      res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof ResponseLogicOutputContractError) {
      res.status(422).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    console.error(
      "[Response Logic Status] error:",
      safeErrorForLog(error, { secrets: [logSecret] }),
    );
    res.status(500).json({
      error: {
        code: "RESPONSE_LOGIC_TASK_STATUS_FAILED",
        message: "读取应答逻辑任务失败，请稍后重试",
      },
    });
  }
});

router.post(["/start", "/turn"], async (req, res) => {
  const parsed = responseLogicStartSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "INVALID_RESPONSE_LOGIC_INPUT",
        message: "当前问题或应答草稿格式不完整",
      },
    });
    return;
  }
  if (!req.frontmindUser || !req.frontmindCredential) {
    if (!req.frontmindUser) {
      res.status(401).json({ error: { message: "请先登录" } });
      return;
    }
  }
  try {
    await assertServiceCapability(req.frontmindUser!.id, "responseLogic");
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }
  if (!req.frontmindCredential) {
    res.status(428).json({
      error: {
        code: "API_CREDENTIAL_REQUIRED",
        message: "当前账号尚未由管理员配置 API Key",
      },
    });
    return;
  }

  const isContinuation = req.path.endsWith("/turn");
  if (isContinuation && !parsed.data.taskId) {
    res.status(400).json({
      error: {
        code: "RESPONSE_LOGIC_TASK_REQUIRED",
        message: "缺少当前应答逻辑任务标识",
      },
    });
    return;
  }

  const activeCredentials = getFrontMindCredentials(req);
  if (!activeCredentials.apiKey) {
    res.status(401).json({ error: { message: "Missing API key" } });
    return;
  }

  let logSecret = activeCredentials.apiKey;
  try {
    const configuredQuestion = await getDashboardQuestion(
      req.frontmindUser.id,
      parsed.data.questionId,
    );
    if (!configuredQuestion) {
      res.status(422).json({
        error: {
          code: "RESPONSE_LOGIC_QUESTION_NOT_CONFIGURED",
          message: "当前问题尚未由管理员配置",
        },
      });
      return;
    }
    const value: ResponseLogicStartInput = {
      ...parsed.data,
      ...configuredQuestion,
    };
    if (!isContinuation) {
      const existingRecord = await getResponseLogicEntry(
        req.frontmindUser.id,
        value.questionId,
      );
      if (existingRecord?.lastTaskId) {
        if (
          responseLogicRecordMatchesConfiguredQuestion({
            record: existingRecord,
            configuredQuestion,
          })
        ) {
          throw new ResponseLogicTaskActiveError();
        }
        await releaseResponseLogicTaskBinding({
          userId: req.frontmindUser.id,
          questionId: value.questionId,
          taskId: existingRecord.lastTaskId,
        });
      }
    }
    let taskApiKey = activeCredentials.apiKey;
    let taskCredential = req.frontmindCredential;
    if (value.taskId) {
      const [boundTaskCredential, record] = await Promise.all([
        getCredentialForUpstreamResource(
          req.frontmindUser.id,
          "task",
          value.taskId,
        ),
        getResponseLogicEntry(req.frontmindUser.id, value.questionId),
      ]);
      assertResponseLogicTaskBinding({
        authenticatedUserId: req.frontmindUser.id,
        workspaceUserId: req.frontmindUser.id,
        questionId: value.questionId,
        conversationId: value.conversationId,
        taskId: value.taskId,
        record,
        configuredQuestion,
      });
      if (!boundTaskCredential) {
        throw new ResponseLogicTaskBindingError(
          "RESPONSE_LOGIC_TASK_FORBIDDEN",
          "当前问题与应答逻辑任务不匹配，请重新打开该问题",
        );
      }
      taskCredential = boundTaskCredential;
      taskApiKey = boundTaskCredential.apiKey;
      logSecret = taskApiKey;
    }

    for (const attachment of value.attachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential)
      ) {
        res.status(403).json({
          error: {
            code: "RESPONSE_LOGIC_FILE_FORBIDDEN",
            message: "上传资料与当前应答逻辑任务不匹配，请重新上传",
          },
        });
        return;
      }
    }
    const verifiedAttachments = buildVerifiedResponseLogicAttachments(
      value.attachments,
    );

    const skillDescriptor = await getResponseLogicSkillDescriptor();
    const knowledgeSnapshot = await getLatestKnowledgeSnapshot(
      req.frontmindUser.id,
    );
    const created = await createResponseLogicTask({
      baseUrl: getUpstreamBaseUrl(req),
      apiKey: taskApiKey,
      prompt: await buildResponseLogicPrompt({
        value,
        knowledgeSnapshot,
      }),
      attachments: value.attachments,
      taskId: value.taskId,
    });
    if (!created.ok) {
      console.warn(
        "[Response Logic Start] create task failed:",
        redactSensitiveText(created.detail, [logSecret]),
      );
      res.status(created.status).json({
        error: {
          code: "RESPONSE_LOGIC_TASK_FAILED",
          message: "应答逻辑任务创建失败，请检查 API Key 或稍后重试",
        },
      });
      return;
    }

    try {
      await recordResponseLogicTaskStart({
        userId: req.frontmindUser.id,
        apiCredentialId: taskCredential.id,
        value: {
          questionId: value.questionId,
          groupId: value.groupId,
          groupTitle: value.groupTitle,
          question: value.question,
          intent: value.intent,
          summary: value.summary,
          conversationId: value.conversationId,
          draft: value.draft,
        },
        taskId: String(created.task.id),
        skillName: skillDescriptor.name,
        skillVersion: skillDescriptor.version,
        skillContentHash: skillDescriptor.contentHash,
        verifiedAttachments,
      });
    } catch (persistenceError) {
      if (!isContinuation) {
        await cancelOrphanedResponseLogicTask({
          baseUrl: getUpstreamBaseUrl(req),
          apiKey: taskApiKey,
          taskId: String(created.task.id),
        });
      }
      throw persistenceError;
    }

    res.json({
      task: created.task,
      startedAt: Date.now(),
      knowledgeVersion: knowledgeSnapshot?.version ?? null,
    });
  } catch (error) {
    if (error instanceof ResponseLogicTaskActiveError) {
      res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof ResponseLogicTaskBindingError) {
      if (
        error.code === "RESPONSE_LOGIC_QUESTION_FORBIDDEN" &&
        parsed.success &&
        parsed.data.taskId &&
        req.frontmindUser
      ) {
        await releaseResponseLogicTaskBinding({
          userId: req.frontmindUser.id,
          questionId: parsed.data.questionId,
          taskId: parsed.data.taskId,
        });
      }
      res.status(403).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    console.error(
      "[Response Logic Start] error:",
      safeErrorForLog(error, { secrets: [logSecret] }),
    );
    res.status(500).json({
      error: {
        code: "RESPONSE_LOGIC_START_FAILED",
        message: "启动应答逻辑任务失败，请稍后重试",
      },
    });
  }
});

export default router;
