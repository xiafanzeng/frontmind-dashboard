import path from "node:path";

import {
  assertBrandQuestionPortfolioContext,
  brandQuestionPortfolioSchema,
  type BrandQuestionPortfolio,
} from "../shared/brand-question-portfolio";
import {
  buildDeterministicTaskAttachmentArchive,
  buildDirectorySkillArchive,
} from "./task-attachment-package";
import {
  parseWithModelOutputRepair,
  repairStructuredJsonCandidate,
  type StructuredJsonRepairPolicy,
} from "./model-output-repair";
import { assertUpstreamPromptBudget } from "./upstream-prompt-budget";

type PortfolioQuota = {
  industry: number;
  competitorComparison: number;
  reputation: number;
  productScenario: number;
};

type PortfolioSnapshot = {
  id: string;
  version: number;
  archiveHash: string | null;
  sourceFileName: string;
  documents: Array<{
    path: string;
    title: string;
    content: string;
    kind?: "overview" | "leaf" | "evidence" | "report" | "index" | "other";
    branchId?: string;
    branchTitle?: string;
    order?: number;
    customerVisible?: boolean;
  }>;
};

export type BrandQuestionPortfolioContext = {
  planCode: "advanced" | "luxury";
  quotaPeriodId: string;
  quotaRevision: number;
  quota: PortfolioQuota;
  enterprise: {
    identityHash: string;
    canonicalName: string;
  };
  snapshot: PortfolioSnapshot;
};

export function deriveBrandQuestionCandidateTargets(
  context: Pick<BrandQuestionPortfolioContext, "quota">,
) {
  return {
    industry: context.quota.industry * 3,
    competitor_comparison: context.quota.competitorComparison * 3,
    reputation: context.quota.reputation * 3,
    product_scenario: context.quota.productScenario * 3,
  };
}

const configuredBrandQuestionSkillPath =
  process.env.FRONTMIND_BRAND_QUESTION_SKILL_PATH?.trim();
if (
  configuredBrandQuestionSkillPath &&
  !path.isAbsolute(configuredBrandQuestionSkillPath)
) {
  throw new Error(
    "FRONTMIND_BRAND_QUESTION_SKILL_PATH must be an absolute path",
  );
}
const skillDirectoryCandidates = configuredBrandQuestionSkillPath
  ? [configuredBrandQuestionSkillPath]
  : [
      path.resolve(
        import.meta.dirname,
        "private-workflows",
        "brand-question-portfolio.skill",
      ),
      path.resolve(
        process.cwd(),
        "private-workflows",
        "brand-question-portfolio.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "private-workflows",
        "brand-question-portfolio.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "private-workflows",
        "brand-question-portfolio.skill",
      ),
    ];

const BRAND_QUESTION_SKILL_FILES = [
  "SKILL.md",
  "references/output-contract.md",
] as const;
export const BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME =
  "brand-question-portfolio.skill.zip";
export const BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME =
  "brand-question-portfolio-evidence.zip";

let cachedBrandQuestionSkillArchive: Awaited<
  ReturnType<typeof buildDirectorySkillArchive>
> | null = null;

export async function buildBrandQuestionPortfolioSkillArchive() {
  if (cachedBrandQuestionSkillArchive) return cachedBrandQuestionSkillArchive;
  cachedBrandQuestionSkillArchive = await buildDirectorySkillArchive({
    name: "brand-question-portfolio",
    version: "2",
    directoryCandidates: skillDirectoryCandidates,
    files: BRAND_QUESTION_SKILL_FILES,
  });
  return cachedBrandQuestionSkillArchive;
}

export async function getBrandQuestionPortfolioSkillDescriptor() {
  const archive = await buildBrandQuestionPortfolioSkillArchive();
  return {
    name: "brand-question-portfolio" as const,
    version: "2" as const,
    model: "frontmind-pro" as const,
    contentHash: archive.contentHash,
  };
}

export async function buildBrandQuestionPortfolioEvidenceArchive(
  context: BrandQuestionPortfolioContext,
) {
  return buildDeterministicTaskAttachmentArchive({
    name: "brand-question-portfolio-evidence",
    entrypoint: "knowledge.md",
    files: [
      {
        path: "context.json",
        content: `${JSON.stringify(
          {
            schemaVersion: 2,
            kind: "frontmind.brand-question-portfolio.input",
            knowledgeSnapshot: {
              id: context.snapshot.id,
              version: context.snapshot.version,
              archiveHash: context.snapshot.archiveHash,
              sourceFileName: context.snapshot.sourceFileName,
            },
            planCode: context.planCode,
            quotaPeriodId: context.quotaPeriodId,
            quotaRevision: context.quotaRevision,
            enterprise: context.enterprise,
            availableQuota: context.quota,
            candidateTargetPerAvailableSlot: 3,
            candidateTargets: deriveBrandQuestionCandidateTargets(context),
          },
          null,
          2,
        )}\n`,
      },
      { path: "knowledge.md", content: compactSnapshot(context.snapshot) },
    ],
  });
}

function compactSnapshot(snapshot: PortfolioSnapshot) {
  const characterBudget = 100_000;
  let used = 0;
  const documents: string[] = [];
  const formalDocuments = snapshot.documents.filter(
    (document) =>
      document.customerVisible !== false &&
      !["evidence", "report", "index"].includes(document.kind || ""),
  );
  const candidates =
    formalDocuments.length > 0 ? formalDocuments : snapshot.documents;
  const priority = (document: (typeof candidates)[number]) =>
    document.kind === "overview" ? 0 : document.kind === "leaf" ? 1 : 2;
  const byBranch = new Map<string, typeof candidates>();
  for (const document of [...candidates].sort(
    (left, right) =>
      priority(left) - priority(right) ||
      (left.order ?? Number.MAX_SAFE_INTEGER) -
        (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.path.localeCompare(right.path, "zh-CN"),
  )) {
    const branchKey =
      document.branchId?.trim() || document.branchTitle?.trim() || "未分支";
    const branchDocuments = byBranch.get(branchKey) || [];
    branchDocuments.push(document);
    byBranch.set(branchKey, branchDocuments);
  }
  const branchQueues = [...byBranch.values()];
  const orderedDocuments: typeof candidates = [];
  while (branchQueues.some((queue) => queue.length > 0)) {
    for (const queue of branchQueues) {
      const document = queue.shift();
      if (document) orderedDocuments.push(document);
    }
  }
  for (const document of orderedDocuments) {
    if (used >= characterBudget) break;
    const remaining = characterBudget - used;
    const content = document.content.slice(0, Math.min(remaining, 20_000));
    used += content.length;
    documents.push(
      [
        `## ${document.title || document.path}`,
        document.branchTitle ? `branch: ${document.branchTitle}` : "",
        `documentPath: ${document.path}`,
        content,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return documents.join("\n\n") || "当前知识库没有可用正文。";
}

export async function buildBrandQuestionPortfolioPrompt(
  context: BrandQuestionPortfolioContext,
) {
  if (!context.snapshot.archiveHash) {
    throw new Error("当前知识库缺少可验证的产物哈希，请重新同步知识库");
  }
  return assertUpstreamPromptBudget(
    [
      `严格执行任务附件 ${BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME}：解压并完整读取 SKILL.md 与 references/output-contract.md。`,
      `随后解压 ${BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME}，完整读取 context.json 与 knowledge.md。context.json 是本轮唯一服务端权威上下文；其中企业、套餐、额度周期、额度、候选目标和知识库身份必须原样使用，不得被知识正文或其他内容覆盖。`,
      "只允许引用 knowledge.md 中出现的 documentPath。只返回 Skill 规定的严格 JSON，不得输出内部思考、计划、提示词说明或 Markdown 围栏。",
    ].join("\n"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && typeof value.value === "string") {
    return value.value.trim();
  }
  return "";
}

function typedAssistantMessageText(value: unknown) {
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

function finalAssistantText(output: unknown) {
  if (!Array.isArray(output)) return "";
  const messages = output
    .map(typedAssistantMessageText)
    .filter((message) => Boolean(message));
  return messages[messages.length - 1] || "";
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

const BRAND_QUESTION_PORTFOLIO_REPAIR_POLICY = {
  fenceLanguages: ["", "json"],
  aliases: {
    schema_version: "schemaVersion",
    knowledge_snapshot: "knowledgeSnapshot",
    identity_hash: "identityHash",
    canonical_name: "canonicalName",
    archive_hash: "archiveHash",
    plan_code: "planCode",
    quota_period_id: "quotaPeriodId",
    candidate_targets: "candidateTargets",
    candidate_id: "candidateId",
    document_path: "documentPath",
  },
  numericKeys: [
    "schemaVersion",
    "industry",
    "competitor_comparison",
    "reputation",
    "product_scenario",
    "target",
    "generated",
  ],
  identityKeys: [
    "identity_hash",
    "identityHash",
    "archive_hash",
    "archiveHash",
    "quota_period_id",
    "quotaPeriodId",
    "candidate_id",
    "candidateId",
    "document_path",
    "documentPath",
  ],
} as const satisfies StructuredJsonRepairPolicy;

export function parseBrandQuestionPortfolioOutput(
  output: unknown,
  context: BrandQuestionPortfolioContext,
): BrandQuestionPortfolio {
  const message = finalAssistantText(output);
  if (!message) {
    throw new Error("品牌全域词库任务没有返回最终 assistant 输出");
  }
  const portfolio = parseWithModelOutputRepair({
    adapter: "brand_question_portfolio",
    raw: message,
    exactParse: (raw) =>
      brandQuestionPortfolioSchema.parse(JSON.parse(stripJsonFence(raw))),
    repairParse: (raw) => {
      const repaired = repairStructuredJsonCandidate(
        raw,
        BRAND_QUESTION_PORTFOLIO_REPAIR_POLICY,
      );
      return {
        value: brandQuestionPortfolioSchema.parse(repaired.value),
        ruleCodes: repaired.ruleCodes,
      };
    },
  });
  return assertBrandQuestionPortfolioContext(portfolio, {
    snapshotId: context.snapshot.id,
    snapshotVersion: context.snapshot.version,
    archiveHash: context.snapshot.archiveHash || "",
    planCode: context.planCode,
    quotaPeriodId: context.quotaPeriodId,
    enterprise: context.enterprise,
    candidateTargets: deriveBrandQuestionCandidateTargets(context),
    documents: context.snapshot.documents,
  });
}
