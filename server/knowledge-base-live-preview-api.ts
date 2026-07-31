import axios from "axios";
import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import {
  buildKnowledgeBasePrompt,
  createFrontMindTask,
  getKnowledgeBaseSkillDescriptor,
  uploadKnowledgeBaseSkillArchive,
} from "./knowledge-base-api";
import { extractFinalKnowledgeBaseAssistantText } from "./knowledge-base-progress-service";
import {
  parseKnowledgeBaseManifestEnvelope,
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBaseReopenEnvelope,
} from "./knowledge-base-progress";
import { getUpstreamBaseUrl } from "./upstream-config";
import { normalizeKnowledgeCollectionCopy } from "../shared/knowledge-base-copy";
import {
  extractKnowledgeBaseProtocolObjects,
  stripKnowledgeBaseProtocolPayloads,
  stripKnowledgeBaseReferenceAppendix,
} from "../shared/knowledge-base-output";

const router = Router();
const SESSION_TTL_MS = 3 * 60 * 60 * 1_000;
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "done",
  "finished",
]);

export type KnowledgeBaseLivePreviewMode = "full" | "protocol_probe";

export const KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES = [
  {
    id: "1.1",
    title: "企业定位",
    branchId: "identity",
    branchTitle: "企业身份",
  },
  {
    id: "2.1",
    title: "核心团队",
    branchId: "team",
    branchTitle: "团队与组织",
  },
  {
    id: "3.1",
    title: "产品体系",
    branchId: "products",
    branchTitle: "产品与服务",
  },
  {
    id: "4.1",
    title: "技术能力",
    branchId: "capabilities",
    branchTitle: "能力体系",
  },
  {
    id: "5.1",
    title: "行业场景",
    branchId: "industries",
    branchTitle: "行业与场景",
  },
  {
    id: "6.1",
    title: "客户案例",
    branchId: "cases",
    branchTitle: "案例与成果",
  },
  {
    id: "7.1",
    title: "差异化优势",
    branchId: "differentiation",
    branchTitle: "品牌差异化",
  },
  {
    id: "8.1",
    title: "合作与支持",
    branchId: "cooperation",
    branchTitle: "合作与支持",
  },
] as const;

type LivePreviewSession = {
  taskId: string;
  apiKey: string | null;
  mode: KnowledgeBaseLivePreviewMode;
  createdAt: number;
  removeSkill: () => Promise<void>;
  skillRemoved: boolean;
  finalAnalysis: ReturnType<typeof analyzeKnowledgeBaseLiveTask> | null;
};

const livePreviewSessions = new Map<string, LivePreviewSession>();

function remoteAddress(req: Request) {
  return String(req.socket.remoteAddress || "").toLowerCase();
}

export function isLoopbackKnowledgePreviewRequest(req: Request) {
  const address = remoteAddress(req);
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function cleanupExpiredSessions() {
  const expiresBefore = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of livePreviewSessions) {
    if (session.createdAt >= expiresBefore) continue;
    livePreviewSessions.delete(sessionId);
    if (!session.skillRemoved) {
      session.skillRemoved = true;
      void session.removeSkill().catch(() => undefined);
    }
  }
}

router.use((req, res, next) => {
  if (
    process.env.NODE_ENV !== "development" ||
    !isLoopbackKnowledgePreviewRequest(req)
  ) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "接口不存在" },
    });
    return;
  }
  cleanupExpiredSessions();
  next();
});

function normalizedTaskStatus(value: unknown) {
  return String(value || "running")
    .trim()
    .toLowerCase();
}

function protocolDiagnostic(
  text: string,
  marker: string,
  kind: string,
  parser: (value: unknown) => unknown,
) {
  const count = extractKnowledgeBaseProtocolObjects(text).filter(
    (value) => value.kind === kind,
  ).length;
  if (count === 0 && !text.includes(marker)) return null;
  try {
    return { kind, count, valid: true as const, value: parser(text) };
  } catch (error) {
    return {
      kind,
      count,
      valid: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function analyzeKnowledgeBaseLiveTask(
  task: unknown,
  options: { mode?: KnowledgeBaseLivePreviewMode } = {},
) {
  const runMode = options.mode || "full";
  const taskRecord =
    task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : {};
  const status = normalizedTaskStatus(taskRecord.status);
  const output = Array.isArray(taskRecord.output) ? taskRecord.output : [];
  const assistantText = extractFinalKnowledgeBaseAssistantText(output);
  const protocolObjects = extractKnowledgeBaseProtocolObjects(assistantText);
  const legacySocraticStateCount = (
    assistantText.match(/<!--\s*SOCRATIC_KB_STATE\b/gi) || []
  ).length;
  const protocolKinds = protocolObjects.map((value) =>
    String(value.kind || ""),
  );
  const visibleMarkdown = normalizeKnowledgeCollectionCopy(
    stripKnowledgeBaseReferenceAppendix(
      stripKnowledgeBaseProtocolPayloads(assistantText),
    ),
  ).trim();

  const manifestDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_MANIFEST",
    "frontmind.knowledge-base.manifest",
    parseKnowledgeBaseManifestEnvelope,
  );
  const progressDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_PROGRESS",
    "frontmind.knowledge-base.progress",
    parseKnowledgeBaseProgressEnvelope,
  );
  const reopenDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_REOPEN",
    "frontmind.knowledge-base.reopen",
    parseKnowledgeBaseReopenEnvelope,
  );
  const presentationDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_PRESENTATION",
    "frontmind.knowledge-base.presentation",
    parseKnowledgeBasePresentationEnvelope,
  );
  const rawDiagnostics = [
    manifestDiagnostic,
    progressDiagnostic,
    reopenDiagnostic,
    presentationDiagnostic,
  ].filter(Boolean);
  const manifestTurn = Boolean(manifestDiagnostic);
  const diagnostics = rawDiagnostics.map((diagnostic) => ({
    ...diagnostic!,
    authoritative:
      !manifestTurn || diagnostic!.kind === "frontmind.knowledge-base.manifest",
  }));

  const manifest =
    manifestDiagnostic?.valid &&
    manifestDiagnostic.value &&
    typeof manifestDiagnostic.value === "object"
      ? (manifestDiagnostic.value as {
          leaves: Array<{
            id: string;
            title: string;
            branchId?: string;
            branchTitle?: string;
          }>;
        })
      : null;
  const branchCounts = manifest
    ? Object.entries(
        manifest.leaves.reduce<Record<string, number>>((counts, leaf) => {
          const branch = leaf.branchTitle || leaf.branchId || "未分组";
          counts[branch] = (counts[branch] || 0) + 1;
          return counts;
        }, {}),
      ).map(([title, leafCount]) => ({ title, leafCount }))
    : [];

  const issues: string[] = [];
  const terminal = TERMINAL_TASK_STATUSES.has(status);
  if (terminal && !assistantText) {
    issues.push("任务已结束，但没有找到带 assistant 角色的可解析文本输出");
  }
  if (terminal && !manifestDiagnostic) {
    issues.push("任务已结束，但没有找到知识树 manifest");
  }
  if (legacySocraticStateCount > 0) {
    issues.push("返回了已禁用的旧 SOCRATIC_KB_STATE 状态对象");
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.authoritative && !diagnostic.valid) {
      issues.push(`${diagnostic.kind}：${diagnostic.error}`);
    }
  }
  if (
    visibleMarkdown.includes("FRONTMIND_KB_") ||
    visibleMarkdown.includes("SOCRATIC_KB_STATE") ||
    visibleMarkdown.includes("frontmind.knowledge-base.") ||
    visibleMarkdown.includes("frontmind.workflow-state")
  ) {
    issues.push("客户可见正文仍包含机器协议");
  }
  if (runMode === "protocol_probe" && manifest) {
    const actualLeaves = manifest.leaves.map((leaf) => ({
      id: leaf.id,
      title: leaf.title,
      branchId: leaf.branchId,
      branchTitle: leaf.branchTitle,
    }));
    if (
      JSON.stringify(actualLeaves) !==
      JSON.stringify(KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES)
    ) {
      issues.push("协议探针 manifest 与预期的 8 个叶子不完全一致");
    }
  }

  return {
    runMode,
    taskId: String(taskRecord.id || taskRecord.task_id || ""),
    status,
    terminal,
    outputCount: output.length,
    assistantCharacterCount: assistantText.length,
    visibleCharacterCount: visibleMarkdown.length,
    visibleMarkdown,
    rawAssistantText: assistantText,
    protocolKinds,
    legacySocraticStateCount,
    protocolObjects,
    diagnostics,
    manifest: manifest
      ? {
          leafCount: manifest.leaves.length,
          branchCount: branchCounts.length,
          branchCounts,
          firstLeaf: manifest.leaves[0] || null,
          lastLeaf: manifest.leaves[manifest.leaves.length - 1] || null,
          leaves: manifest.leaves,
        }
      : null,
    issues,
  };
}

function resolveLivePreviewApiKey(value: unknown) {
  const supplied = typeof value === "string" ? value.trim() : "";
  return supplied || process.env.FRONTMIND_LIVE_TEST_API_KEY?.trim() || "";
}

export function buildKnowledgeBaseProtocolProbePrompt() {
  const sourceRows = KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES.map(
    (leaf) => `${leaf.id}|${leaf.title}|${leaf.branchId}|${leaf.branchTitle}`,
  ).join("\n");
  return [
    "FRONTMIND_KB_PROTOCOL_PROBE_V1",
    "严格执行随任务附带的 socratic-kb-builder v3 Skill 中的协议自检模式。",
    "这是本机开发环境的机器协议契约探针，不是企业知识库构建任务。",
    "禁止联网、搜索、浏览、调用工具、读取企业资料、生成文件或开展研究。",
    "把下面 8 行测试数据按原顺序转换为完整 leaves；每行字段依次为 id、title、branchId、branchTitle：",
    sourceRows,
    "",
    "回复只能包含一行可见文字“协议探针响应”，随后紧接且只接一个完整的 FRONTMIND_KB_MANIFEST 注释信封。",
    "信封内必须是严格 JSON：kind 为 frontmind.knowledge-base.manifest，schemaVersion 为 1，leaves 与以上 8 行逐字段完全一致。",
    "禁止输出裸 JSON、代码围栏、FRONTMIND_KB_PROGRESS、FRONTMIND_KB_PRESENTATION、SOCRATIC_KB_STATE、workflow-state、knowledge-base.message 或任何解释。",
  ].join("\n");
}

router.get("/configuration", (_req, res) => {
  res.json({
    serverCredentialConfigured: Boolean(
      process.env.FRONTMIND_LIVE_TEST_API_KEY?.trim(),
    ),
    upstreamBaseUrl: getUpstreamBaseUrl(),
  });
});

router.post("/start", async (req, res) => {
  const mode: KnowledgeBaseLivePreviewMode =
    req.body?.mode === "protocol_probe" ? "protocol_probe" : "full";
  const companyName =
    typeof req.body?.companyName === "string"
      ? req.body.companyName.normalize("NFKC").trim()
      : "";
  const companyWebsite =
    typeof req.body?.companyWebsite === "string"
      ? req.body.companyWebsite.trim()
      : "";
  const apiKey = resolveLivePreviewApiKey(req.body?.apiKey);

  if (!companyName || companyName.length > 255) {
    res.status(400).json({
      error: { code: "INVALID_COMPANY_NAME", message: "请输入有效企业名称" },
    });
    return;
  }
  if (!apiKey) {
    res.status(503).json({
      error: {
        code: "LIVE_API_KEY_REQUIRED",
        message:
          "本地服务未配置 FRONTMIND_LIVE_TEST_API_KEY；可在页面中提交一次性 API Key",
      },
    });
    return;
  }

  const baseUrl = getUpstreamBaseUrl();
  let skill:
    | Awaited<ReturnType<typeof uploadKnowledgeBaseSkillArchive>>
    | undefined;
  try {
    const descriptor = await getKnowledgeBaseSkillDescriptor();
    const prompt =
      mode === "protocol_probe"
        ? buildKnowledgeBaseProtocolProbePrompt()
        : await buildKnowledgeBasePrompt({
            conversationId: `live-preview-${Date.now()}`,
            companyName,
            companyWebsite,
            operatorNotes:
              "本地真实 API 与渲染回归。严格输出完整客户正文及规定的机器信封。",
            attachments: [],
            prefillKnowledgeSnapshot: null,
          });
    skill = await uploadKnowledgeBaseSkillArchive({
      baseUrl,
      apiKey,
      skillVersion: descriptor.version,
      skillContentHash: descriptor.contentHash,
    });
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt,
      attachments: [skill.attachment],
    });
    if (!created.ok) {
      await skill.removeOrphan().catch(() => undefined);
      res.status(created.status).json({
        error: {
          code: "UPSTREAM_TASK_CREATE_FAILED",
          message: created.detail,
        },
      });
      return;
    }

    const sessionId = randomUUID();
    const analysis = analyzeKnowledgeBaseLiveTask(created.task, { mode });
    const terminal = analysis.terminal;
    if (terminal) {
      await skill.removeOrphan().catch(() => undefined);
    }
    livePreviewSessions.set(sessionId, {
      taskId: created.task.id,
      apiKey: terminal ? null : apiKey,
      mode,
      createdAt: Date.now(),
      removeSkill: skill.removeOrphan,
      skillRemoved: terminal,
      finalAnalysis: terminal ? analysis : null,
    });
    res.status(201).json({
      sessionId,
      analysis,
    });
  } catch (error) {
    if (skill) await skill.removeOrphan().catch(() => undefined);
    res.status(502).json({
      error: {
        code: "LIVE_PREVIEW_START_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

router.get("/:sessionId", async (req, res) => {
  const session = livePreviewSessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({
      error: {
        code: "LIVE_PREVIEW_SESSION_NOT_FOUND",
        message: "本地验收会话不存在或已经过期",
      },
    });
    return;
  }
  if (session.finalAnalysis) {
    res.json({
      sessionId: req.params.sessionId,
      analysis: session.finalAnalysis,
    });
    return;
  }
  if (!session.apiKey) {
    res.status(410).json({
      error: {
        code: "LIVE_PREVIEW_CREDENTIAL_RELEASED",
        message: "本地验收会话已经结束",
      },
    });
    return;
  }

  try {
    const response = await axios.get(
      `${getUpstreamBaseUrl()}/v1/tasks/${encodeURIComponent(session.taskId)}`,
      {
        headers: {
          API_KEY: session.apiKey,
          Authorization: `Bearer ${session.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      res.status(response.status).json({
        error: {
          code: "UPSTREAM_TASK_READ_FAILED",
          message: `读取真实任务失败（${response.status}）`,
        },
      });
      return;
    }

    const analysis = analyzeKnowledgeBaseLiveTask(response.data, {
      mode: session.mode,
    });
    if (analysis.terminal) {
      session.finalAnalysis = analysis;
      session.apiKey = null;
      if (!session.skillRemoved) {
        session.skillRemoved = true;
        void session.removeSkill().catch(() => undefined);
      }
    }
    res.json({ sessionId: req.params.sessionId, analysis });
  } catch (error) {
    res.status(502).json({
      error: {
        code: "LIVE_PREVIEW_POLL_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

export default router;
