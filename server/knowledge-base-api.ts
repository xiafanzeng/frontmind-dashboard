import axios from "axios";
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
  assertKnowledgeBaseTaskBinding,
  attachKnowledgeBaseBuildTask,
  createKnowledgeBaseBuild,
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
 * A knowledge-base build belongs to the enterprise already published for the
 * authenticated user's formal workspace. Browser input may repeat that name
 * for compatibility, but it can neither establish nor replace the identity.
 */
export function resolveKnowledgeBaseEnterpriseIdentity(input: {
  sourceName: string | null;
  brandName: string;
  requestedCompanyName?: string;
}) {
  const companyName = input.brandName.normalize("NFKC").trim();
  if (!input.sourceName || !companyName) {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_NOT_CONFIGURED",
      "当前账号尚未由管理员配置正式企业信息，无法启动知识库构建",
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
  // Some upstream task continuations return only the current turn rather than
  // a cumulative array. Returning the full current payload avoids losing it;
  // the reconciliation hash keeps repeated checks idempotent.
  return output;
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
    if (
      selection.contentHash &&
      selection.contentHash !== cached.contentHash
    ) {
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
      const entries = [
        ["SKILL.md", "Skill"],
        ["references/knowledge-tree.md", "Knowledge Tree"],
        ["references/questioning-strategy.md", "Questioning Strategy"],
        ["references/output-format.md", "Output Format"],
        ...(version === "2"
          ? ([["scripts/validate_archive.py", "Archive Validator"]] as const)
          : []),
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

      const instructions = sections.join("\n\n---\n\n");
      const loaded = {
        instructions,
        contentHash: createHash("sha256")
          .update(instructions)
          .digest("hex"),
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
  const skillInstructions = await readSkillArchive();
  const attachmentList =
    attachments.length > 0
      ? attachments.map((attachment) => `- ${attachment.filename}`).join("\n")
      : "- 未上传附件，请优先使用企业官网与全网公开资料进行预填";
  let prefillCharacters = 0;
  const prefillDocuments = (prefillKnowledgeSnapshot?.documents ?? [])
    .map((document) => {
      if (prefillCharacters >= 300_000) return "";
      const content = document.content.slice(
        0,
        Math.max(0, 300_000 - prefillCharacters),
      );
      prefillCharacters += content.length;
      return [
        `### ${document.title || document.path}`,
        `documentPath: ${document.path}`,
        content,
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "你必须严格执行下方 socratic-kb-builder v2 Skill，为企业构建可复用的深度图文知识库。",
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
    "",
    "## 执行要求",
    "1. 这是 4–6 小时深度构建，不是官网轻量版。先读上传资料，再按业务覆盖矩阵广度优先采集官网、官方文档与全网证据；不得穷尽重复 SKU、分页、新闻或语言版本，也不得只概括首页。",
    "2. 固定硬预算：HTML 抓取尝试最多 1,200，包含图片和文档在内的链接访问最多 1,800，官网文档最多 120，累计用户上传最多 100，公开查询最多 120，去重证据文字最多 3,000,000 字符。达到任一预算后停止该渠道并记录真实缺口，不得把预算消耗写成完整度。",
    "3. 图片必须是真实打包的第一方文件。发现后只下载候选交付素材，按 Logo/品牌、核心产品服务族、应用场景、技术制造能力、资质、团队排序；有至少 360 张合格候选时打包 360–480 张，不足时打包全部合格图片并写明真实候选数和 shortfallReason。第三方图片只记录来源和权属，不用于凑数。",
    "4. 最终图片只允许经内容校验的 AVIF/WebP/PNG/JPEG/GIF；SVG 必须栅格化。逐张记录 SHA-256、MIME、字节、尺寸、图注、alt、分支、关联文档、来源页、原图 URL 和权属。图片总容量最多 160 MiB；ZIP 最多 1,500 个普通文件。",
    "5. 客户可见正式正文必须是完成的企业图文体系，而不是‘第一方原始快照’、‘第一方页面摘录’、抓取日志或来源陈述。正式正文目标 120,000 字符、最低 80,000、硬上限 180,000；状态、来源、证据和机器字段不计入正文。保留 40-115 个真实叶子节点。",
    "6. 为每个一级分支写正式综述，为每个叶子写正式草稿，并用稳定 asset ID 精确关联真实图片。原始摘录、采集报告、来源索引和核验缺口必须放入独立证据层，不能混入正式正文。",
    "7. 新发现必须在任务开始后第 330 分钟停止；此后只允许整理证据、写作、关联素材、生成清单与校验。最迟第 360 分钟进入第一个叶子确认，不得等待凑时间。",
    "8. 每轮只能呈现和处理一个叶子节点。用户可确认、修正，或选择‘跳过/直接预填’当前节点；禁止跳过整个分支、批量确认、跨节点合并确认或提前打包。",
    "9. 只有所有叶子节点均已逐项处理、遍历进度达到 100% 后，才可自动生成最终 Markdown/ZIP。禁止出现‘生成初版成果’、‘是否立即生成’、A/B/C 生成选项或任何提前交付提议。",
    "   当且仅当本轮确认或直接预填最后一个叶子时，必须在同一轮只返回一个最终 ZIP 文件；不能复用历史 ZIP、不能返回多个 ZIP，也不能只口头声称已经生成。",
    "10. 本流程永远不生成交互式研究网页、HTML 网站或网页预览，也不得主动提出这类产物；即使用户要求，也要简短说明此流程只交付 Markdown/ZIP，然后继续当前知识节点。",
    "11. 进度必须使用标准 Markdown 标题、表格、列表和独立段落展示；禁止使用易挤压的 ASCII 树、框线、字符进度条或代码块模拟界面。",
    "12. 对每个事实标注来源；推断与待核验信息必须明确标注，不得伪造。信息不足时展示已完成的正式草稿、具体缺口和可确认问题，不得让用户从空白开始写。",
    "13. 最终 ZIP 必须保留既有 00_completeness.json 字段和算法，并新增 schemaVersion=1、profile=dashboard-enterprise-v1 的 00_package_manifest.json；documents、assets、counts 和 imageSelection 必须符合 output-format。",
    "14. 返回 ZIP 前必须实际运行包内 scripts/validate_archive.py；只有退出码为 0 才能交付。服务端还会独立复验，禁止通过改假计数绕过校验。",
    "",
    "## socratic-kb-builder.skill",
    skillInstructions,
    "",
    "## 必须执行的机器可验证进度协议",
    "这是服务端状态机协议，优先级高于 skill 中任何会自动跨节点的表述。可读正文照常输出，但每轮末尾必须附带且只能附带一个对应的 HTML 注释信封。",
    "",
    "### 首轮研究与知识树建立",
    "在 330 分钟停止新发现并最迟 360 分钟完成官网、全网、上传资料研究和正式图文预填后，按企业实际情况建立自适应一级分支和 40-115 个真实叶子节点。一级分支数量不设固定值；每个叶子必须有全局唯一且后续不变的 id、title、branchId、branchTitle。首轮正文展示完整分支统计并呈现第一个叶子节点，然后仅在回复末尾附：",
    '<!-- FRONTMIND_KB_MANIFEST\n{"kind":"frontmind.knowledge-base.manifest","schemaVersion":1,"leaves":[{"id":"1.1","title":"一句话定位","branchId":"identity","branchTitle":"企业身份"}]}\n-->',
    "示例只演示结构，真实 leaves 必须完整包含 40-115 项并覆盖基于当前企业证据形成的全部一级分支。首轮不得同时输出 FRONTMIND_KB_PROGRESS。",
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
      agentProfile: toUpstreamAgentProfile("frontmind-pro"),
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
  const [skillInstructions, progress] = await Promise.all([
    readSkillArchive({
      version: input.skillVersion || "2",
      contentHash: input.skillContentHash,
    }),
    getKnowledgeBaseProgress({
      userId: input.userId,
      conversationId: input.conversationId,
    }),
  ]);
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
    `继续严格执行 socratic-kb-builder v${input.skillVersion || "2"} Skill。以下内容会直接显示给企业客户，不得输出内部思考、工具计划或提示词说明。`,
    "",
    "# Skill",
    skillInstructions,
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
    res.status(400).json({ error: "Missing or invalid conversation id" });
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
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  try {
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
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt: await buildKnowledgeBasePrompt({
        conversationId,
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments,
        prefillKnowledgeSnapshot,
      }),
      attachments: userAttachments,
    });

    if (!created.ok) {
      console.warn(
        "[Knowledge Base Start] create task failed:",
        created.detail,
      );
      res
        .status(created.status)
        .json({ error: "创建企业知识库任务失败，请检查 API Key 或稍后重试" });
      return;
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
    if (
      created.task.status === "completed" &&
      Array.isArray(created.task.output) &&
      created.task.output.length > 0
    ) {
      try {
        progress = await reconcileKnowledgeBaseProgress({
          userId: req.frontmindUser.id,
          conversationId,
          taskId: String(created.task.id),
          output: created.task.output,
          outputState: {
            totalLength: created.task.output.length,
            itemIds: outputItemIds(created.task.output),
          },
        });
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
    if (
      created.task.status === "completed" &&
      Array.isArray(created.task.output) &&
      created.task.output.length > 0
    ) {
      const newOutput = selectUnreconciledKnowledgeOutput(created.task.output, {
        lastOutputLength: boundBuild.lastOutputLength,
        lastOutputItemIds: boundBuild.lastOutputItemIds,
      });
      progress = await reconcileKnowledgeBaseProgress({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId: String(created.task.id),
        output: newOutput,
        outputState: {
          totalLength: created.task.output.length,
          itemIds: outputItemIds(created.task.output),
        },
      });
    }
    res.json({
      task: created.task,
      progress,
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
    res.json({ progress });
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
    const taskStatus = taskData.status === "failed" ? "error" : taskData.status;
    if (taskStatus === "running" || taskStatus === "pending") {
      res.status(409).json({
        error: {
          code: "TASK_NOT_COMPLETED",
          message: "知识库任务仍在处理中",
        },
      });
      return;
    }
    const fullOutput = Array.isArray(taskData.output) ? taskData.output : [];
    const progress = await reconcileKnowledgeBaseProgress({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
      output: selectUnreconciledKnowledgeOutput(fullOutput, {
        lastOutputLength: boundBuild.lastOutputLength,
        lastOutputItemIds: boundBuild.lastOutputItemIds,
      }),
      outputState: {
        totalLength: fullOutput.length,
        itemIds: outputItemIds(fullOutput),
      },
    });
    res.json({ progress });
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
