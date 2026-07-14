import axios from "axios";
import { Router } from "express";
import fs from "fs/promises";
import JSZip from "jszip";
import path from "path";
import { getFrontMindCredentials, toUpstreamAgentProfile } from "./upstream-config";
import { recordUpstreamResource } from "./auth-service";

const router = Router();

interface KnowledgeBaseAttachment {
  file_id?: string;
  fileId?: string;
  filename?: string;
  name?: string;
}

interface KnowledgeBaseStartRequest {
  companyName?: string;
  companyWebsite?: string;
  operatorNotes?: string;
  agentProfile?: string;
  attachments?: KnowledgeBaseAttachment[];
}

const skillArchiveCandidates = [
  process.env.FRONTMIND_KB_SKILL_PATH,
  path.resolve(process.cwd(), "private-workflows", "socratic-kb-builder.skill"),
  path.resolve(import.meta.dirname, "..", "private-workflows", "socratic-kb-builder.skill"),
  path.resolve(import.meta.dirname, "..", "..", "private-workflows", "socratic-kb-builder.skill"),
].filter(Boolean) as string[];

let cachedSkillInstructions: string | null = null;

function sanitizeFilename(value: string, fallback: string) {
  const safe = String(value || "")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, 160);
  return safe || fallback;
}

function normalizeUserAttachments(attachments: KnowledgeBaseAttachment[] | undefined) {
  return (attachments || [])
    .map((attachment) => {
      const fileId = attachment.file_id || attachment.fileId || "";
      const filename = sanitizeFilename(
        attachment.filename || attachment.name || "company_material",
        "company_material"
      );
      return fileId ? { file_id: fileId, filename } : null;
    })
    .filter(Boolean) as Array<{ file_id: string; filename: string }>;
}

async function readSkillArchive() {
  if (cachedSkillInstructions) return cachedSkillInstructions;

  let lastError: unknown;
  for (const candidate of skillArchiveCandidates) {
    try {
      const archive = await fs.readFile(candidate);
      const zip = await JSZip.loadAsync(archive);
      const entries = [
        ["SKILL.md", "Skill"],
        ["references/knowledge-tree.md", "Knowledge Tree"],
        ["references/questioning-strategy.md", "Questioning Strategy"],
        ["references/output-format.md", "Output Format"],
      ] as const;

      const sections: string[] = [];
      for (const [entryName, title] of entries) {
        const entry = zip.file(entryName);
        if (!entry) {
          throw new Error(`Missing ${entryName} in socratic-kb-builder.skill`);
        }
        const content = await entry.async("string");
        sections.push(`# ${title}\n\n${content.trim()}`);
      }

      cachedSkillInstructions = sections.join("\n\n---\n\n");
      return cachedSkillInstructions;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not load socratic-kb-builder.skill");
}

async function buildKnowledgeBasePrompt({
  companyName,
  companyWebsite,
  operatorNotes,
  attachments,
}: {
  companyName: string;
  companyWebsite: string;
  operatorNotes: string;
  attachments: Array<{ file_id: string; filename: string }>;
}) {
  const skillInstructions = await readSkillArchive();
  const attachmentList =
    attachments.length > 0
      ? attachments.map((attachment) => `- ${attachment.filename}`).join("\n")
      : "- 未上传附件，请优先使用企业官网和公开资料进行预填";

  return [
    "你必须严格执行下方 socratic-kb-builder skill，为企业构建可复用的结构化知识库。",
    "",
    "## 本次任务输入",
    `企业名称：${companyName}`,
    `企业官网：${companyWebsite || "未填写"}`,
    "用户上传资料：",
    attachmentList,
    operatorNotes ? `操作者备注：\n${operatorNotes}` : "操作者备注：未填写",
    "",
    "## 执行要求",
    "1. 先读取用户上传资料，并结合企业官网和公开资料做深度研究。",
    "2. 按 skill 要求先预填知识树，再以苏格拉底式确认推进，不能让用户从空白问题开始写。",
    "3. 对每个事实标注来源：上传资料、企业官网、公开资料或行业调研。",
    "4. 如当前信息不足，请展示已预填草稿、缺口和可确认问题，等待用户确认或补充。",
    "5. 最终交付应按 skill 的 ZIP/Markdown 知识库结构组织。",
    "",
    "## socratic-kb-builder.skill",
    skillInstructions,
  ].join("\n");
}

async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  agentProfile,
  attachments,
}: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  agentProfile?: string;
  attachments: Array<{ file_id: string; filename: string }>;
}) {
  const taskResponse = await axios.post(
    `${baseUrl}/v1/tasks`,
    {
      prompt,
      agentProfile: toUpstreamAgentProfile(agentProfile),
      taskMode: "agent",
      attachments,
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120000,
      validateStatus: () => true,
    }
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
    return { ok: false as const, status: 502, detail: "Create task failed: missing task id" };
  }

  return {
    ok: true as const,
    task: {
      id: taskId,
      status: taskData.status === "failed" ? "error" : (taskData.status || "running"),
      taskUrl: taskData.task_url || taskData.metadata?.task_url,
      title: taskData.task_title || taskData.metadata?.task_title,
      output: taskData.output || [],
    },
  };
}

router.post("/start", async (req, res) => {
  const body = (req.body || {}) as KnowledgeBaseStartRequest;
  const companyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();

  if (!companyName) {
    res.status(400).json({ error: "Missing company name" });
    return;
  }

  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  try {
    const userAttachments = normalizeUserAttachments(body.attachments);
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt: await buildKnowledgeBasePrompt({
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments,
      }),
      agentProfile: body.agentProfile,
      attachments: userAttachments,
    });

    if (!created.ok) {
      console.warn("[Knowledge Base Start] create task failed:", created.detail);
      res.status(created.status).json({ error: "创建企业知识库任务失败，请检查 API Key 或稍后重试" });
      return;
    }

    if (!req.frontmindUser || !req.frontmindCredential) {
      res.status(401).json({ error: "请先登录并配置 API Key" });
      return;
    }
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(created.task.id),
    });

    res.json({
      visibleMessage: "开始构建企业知识库",
      task: created.task,
      startedAt: Date.now(),
    });
  } catch (error: any) {
    console.error("[Knowledge Base Start] error:", error.message);
    res.status(500).json({ error: "启动企业知识库任务失败，请稍后重试" });
  }
});

export default router;
