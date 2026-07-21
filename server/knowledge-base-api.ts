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

export async function buildKnowledgeBasePrompt({
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
      : "- 未上传附件，请优先使用企业官网与全网公开资料进行预填";

  return [
    "你必须严格执行下方 socratic-kb-builder skill，为企业构建可复用的结构化知识库。",
    "",
    "## 本次任务输入",
    `企业名称：${companyName}`,
    `企业官网入口（可多个）：${companyWebsite || "未填写"}`,
    "用户上传资料：",
    attachmentList,
    operatorNotes ? `操作者备注：\n${operatorNotes}` : "操作者备注：未填写",
    "",
    "## 执行要求",
    "1. 先完整读取用户上传资料，并对每个企业官网做深度全站采集；递归处理 sitemap、栏目分页、产品详情、案例、下载文件、延迟加载图片和可见的客户端渲染内容，完成覆盖报告后才能进入确认环节。覆盖报告必须量化展示：发现/成功/失败页面数、清洗后正文字符数与词数、去重正文量、发现/成功下载/失败图片数、按内容哈希去重后的图片数、图片总容量与分辨率分布、文档数；不能只报告页面数量或图片 URL 数量。",
    "2. 官网采集完成后必须继续执行全网企业情报采集，而不是只采官网：围绕企业名称、别名、域名、产品与型号、核心人物、客户案例、专利认证和行业术语进行中文、英文及目标市场语言检索，覆盖权威登记/专利/认证数据库、新闻媒体、展会、行业媒体、经销商、B2B 目录、招聘页、社交账号和公开视频图文来源。",
    "3. 对全网来源执行实体消歧、跨来源去重、发布时间记录和冲突核验；官网与权威数据库优先，第三方事实和图片必须保留原始 URL、来源类型、采集时间及授权/权属状态，外部图片只能作为待核验参考素材，不得冒充企业自有资产。",
    "4. 知识树固定的是 7 个自适应一级分支，不是 7 或 8 个问答节点；必须根据产品线、服务线与客户行业展开约 40-115 个真实叶子节点，并以真实叶子节点总数计算遍历进度。",
    "5. 按 skill 要求先为每个叶子节点预填文字、数据、来源和相关企业图片，再以苏格拉底式确认推进，不能让用户从空白问题开始写。",
    "6. 每轮只能呈现和处理一个叶子节点。用户可确认、修正，或选择‘跳过/直接预填’当前节点；禁止跳过整个分支、批量确认、跨节点合并确认或提前打包。",
    "7. 只有所有叶子节点均已逐项处理、遍历进度达到 100% 后，才可自动生成最终 Markdown/ZIP。禁止出现‘生成初版成果’、‘是否立即生成’、A/B/C 生成选项或任何提前交付提议。",
    "8. 本流程永远不生成交互式研究网页、HTML 网站或网页预览，也不得主动提出这类产物；即使用户要求，也要简短说明此流程只交付 Markdown/ZIP，然后继续当前知识节点。",
    "9. 进度必须使用标准 Markdown 标题、表格、列表和独立段落展示；禁止使用易挤压的 ASCII 树、框线、字符进度条或代码块模拟界面。",
    "10. 对每个事实标注来源：上传资料、企业官网具体 URL、全网公开资料或行业调研；推断与待核验信息必须明确标注，不得伪造。",
    "11. 如当前信息不足，请展示已预填草稿、具体缺口和可确认问题，等待用户确认、修正或仅跳过当前节点。",
    "12. 最终交付应严格按 skill 的 ZIP/Markdown 知识库结构组织，并附官网全站采集覆盖报告、全网企业情报检索报告、图片资产清单和未核验缺口清单。",
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
