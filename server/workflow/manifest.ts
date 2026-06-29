import fs from "fs/promises";
import path from "path";
import type {
  WorkflowManifest,
  WorkflowStepKind,
  WorkflowStepPublic,
} from "../../shared/workflow";

interface PrivateWorkflowStep extends WorkflowStepPublic {
  privateSources: string[];
}

const commonControlSources = [
  "Master_Control/FrontMind_Master_Control.md",
  "00.FrontMind总控路由.skill",
];

function strategySources(...sources: string[]) {
  return [
    ...commonControlSources,
    "Strategy_Workflow/shared",
    ...sources,
  ];
}

function executionSources(...sources: string[]) {
  return [
    ...commonControlSources,
    "Execution_Workflow/shared",
    ...sources,
  ];
}

function step(
  data: Omit<PrivateWorkflowStep, "sequence"> & { sequence: number }
): PrivateWorkflowStep {
  return data;
}

const steps: PrivateWorkflowStep[] = [
  step({
    id: "S0",
    layer: "strategy",
    kind: "agent",
    sequence: 10,
    title: "策略编排",
    buttonLabel: "启动策略",
    description: "建立策略层任务上下文，确认品牌目标、资料边界和产物路线。",
    owner: "S0 策略编排师",
    inputs: ["品牌名称", "业务目标", "已有资料"],
    outputs: ["策略任务路由", "执行顺序", "待确认清单"],
    dependencies: [],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S0.策略编排师.skill"),
  }),
  step({
    id: "S1",
    layer: "strategy",
    kind: "agent",
    sequence: 20,
    title: "策略启动与品牌事实",
    buttonLabel: "启动品牌事实",
    description: "建立策略上下文，并抽取品牌、产品、渠道、客户与证据，形成统一事实底座。",
    owner: "S1 品牌事实与策略编排",
    inputs: ["品牌名称", "业务目标", "已有资料", "官网", "产品资料", "销售资料"],
    outputs: ["策略任务路由", "brand_facts.json", "brand_knowledge.md", "待确认清单"],
    dependencies: [],
    phase: "策略层",
    privateSources: strategySources(
      "Strategy_Workflow/S0.策略编排师.skill",
      "Strategy_Workflow/S1.品牌资产知识库.skill"
    ),
  }),
  step({
    id: "SP1",
    layer: "strategy",
    kind: "pause",
    sequence: 30,
    title: "确认品牌事实",
    buttonLabel: "确认事实",
    description: "人工确认 S1 的品牌事实图谱，避免后续策略建立在错误资料上。",
    owner: "人工确认点 1",
    inputs: ["S1 产物", "修正意见"],
    outputs: ["事实确认记录"],
    dependencies: ["S1"],
    phase: "策略层确认",
    privateSources: [],
  }),
  step({
    id: "S2",
    layer: "strategy",
    kind: "agent",
    sequence: 40,
    title: "营销图谱",
    buttonLabel: "营销图谱",
    description: "建立用户场景、搜索意图、问题簇与 AI 问答探针。",
    owner: "S2 营销图谱专家",
    inputs: ["品牌事实", "客户场景"],
    outputs: ["用户-场景-意图三元组", "AI 探针问题"],
    dependencies: ["SP1"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S2.营销图谱专家.skill"),
  }),
  step({
    id: "S3",
    layer: "strategy",
    kind: "agent",
    sequence: 50,
    title: "品类趋势",
    buttonLabel: "品类趋势",
    description: "判断品类搜索趋势、竞争强度、AI 推荐语境和机会窗口。",
    owner: "S3 品类趋势研判师",
    inputs: ["品类关键词", "竞争品牌"],
    outputs: ["趋势研判报告", "品类机会评分"],
    dependencies: ["S2"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S3.品类趋势研判师.skill"),
  }),
  step({
    id: "S4",
    layer: "strategy",
    kind: "agent",
    sequence: 60,
    title: "品牌定位",
    buttonLabel: "品牌定位",
    description: "形成品牌定位声明、差异化矩阵和核心竞争理由。",
    owner: "S4 品牌定位分析师",
    inputs: ["品牌事实", "趋势研判", "竞品资料"],
    outputs: ["定位声明", "差异化矩阵"],
    dependencies: ["S3"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S4.品牌定位分析师.skill"),
  }),
  step({
    id: "SP2",
    layer: "strategy",
    kind: "pause",
    sequence: 70,
    title: "资料补充判断",
    buttonLabel: "补充判断",
    description: "决定是否进入品牌资料补充表，补齐定位与诊断前的缺口。",
    owner: "人工确认点 2",
    inputs: ["S4 产物", "资料缺口"],
    outputs: ["资料补充判断", "pause_2 记录"],
    dependencies: ["S4"],
    phase: "策略层确认",
    privateSources: [],
  }),
  step({
    id: "SP3",
    layer: "strategy",
    kind: "pause",
    sequence: 80,
    title: "地域与监测数据",
    buttonLabel: "地域数据",
    description: "选择 AI 可见性监测地域，复用 S2/S4.5 代表题，并上传或确认监测数据。",
    owner: "人工确认点 3",
    inputs: ["目标地域", "AI 可见性数据", "S2 15 个代表题"],
    outputs: ["地域范围", "监测数据索引"],
    dependencies: ["SP2"],
    phase: "策略层确认",
    privateSources: [],
  }),
  step({
    id: "S5",
    layer: "strategy",
    kind: "agent",
    sequence: 90,
    title: "AI 可见性诊断",
    buttonLabel: "可见性诊断",
    description: "分析品牌在 AI 搜索、问答、推荐语境中的出现率与缺口。",
    owner: "S5 品牌诊断专家",
    inputs: ["监测数据", "品牌事实", "定位声明"],
    outputs: ["AI 可见性诊断", "缺口报告"],
    dependencies: ["SP3"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S5.品牌诊断专家.skill"),
  }),
  step({
    id: "S5_5",
    layer: "strategy",
    kind: "agent",
    sequence: 100,
    title: "语义资产审计",
    buttonLabel: "语义审计",
    description: "评估品牌在语义资产、实体关系和可引用证据上的完整度。",
    owner: "S5.5 品牌语义资产审计师",
    inputs: ["S5 诊断", "品牌知识库"],
    outputs: ["语义资产评分卡", "补强建议"],
    dependencies: ["S5"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S5.5.品牌语义资产审计师.skill"),
  }),
  step({
    id: "S6",
    layer: "strategy",
    kind: "agent",
    sequence: 110,
    title: "话语体系",
    buttonLabel: "话语体系",
    description: "沉淀品牌语气、价值表达、核心句式和可复用语言资产。",
    owner: "S6 品牌话语体系",
    inputs: ["定位声明", "语义审计"],
    outputs: ["品牌话语手册", "brand_voice_token.json"],
    dependencies: ["S5_5"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S6.品牌话语体系.skill"),
  }),
  step({
    id: "S7",
    layer: "strategy",
    kind: "agent",
    sequence: 120,
    title: "视觉符号",
    buttonLabel: "视觉体系",
    description: "定义品牌视觉提示词、画面风格、禁用元素和资产生成规范。",
    owner: "S7 视觉符号体系",
    inputs: ["品牌定位", "话语体系"],
    outputs: ["visual_prompt_pack.json", "视觉规范"],
    dependencies: ["S6"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S7.视觉符号体系.skill"),
  }),
  step({
    id: "S8",
    layer: "strategy",
    kind: "agent",
    sequence: 130,
    title: "问答架构",
    buttonLabel: "问答矩阵",
    description: "规划 AI 可引用内容的问答树、内容矩阵、主题日历和落地页蓝图。",
    owner: "S8 问答架构师",
    inputs: ["营销图谱", "话语体系", "视觉规范"],
    outputs: ["QA tree", "内容矩阵", "内容日历", "落地页蓝图"],
    dependencies: ["S7"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S8.问答架构师.skill"),
  }),
  step({
    id: "S9",
    layer: "strategy",
    kind: "agent",
    sequence: 140,
    title: "业务赋能规划",
    buttonLabel: "业务赋能",
    description: "汇总 S1-S8 企业问题，转为 GEO 业务建议与优先行动清单。",
    owner: "S9 业务赋能规划师",
    inputs: ["S1-S8 产物"],
    outputs: ["GEO 行动清单", "业务赋能建议"],
    dependencies: ["S8"],
    phase: "策略层",
    privateSources: strategySources("Strategy_Workflow/S9.业务赋能规划师.skill"),
  }),
  step({
    id: "S10",
    layer: "strategy",
    kind: "agent",
    sequence: 150,
    title: "品牌信息确认表",
    buttonLabel: "确认表",
    description: "基于 S1-S9 策略成果和应答逻辑确认表，生成客户最终确认用的品牌信息确认表。",
    owner: "S10 品牌信息确认表生成师",
    inputs: ["S1-S9 资料包", "应答逻辑确认表", "客户确认口径"],
    outputs: [
      "S10_{brand}_品牌信息确认表.xlsx",
      "{brand}_品牌信息修改清单.json",
    ],
    dependencies: ["S9"],
    phase: "策略层最终确认",
    privateSources: strategySources("Strategy_Workflow/S10.品牌信息确认表生成师.skill"),
  }),
  step({
    id: "STRATEGY_PACK",
    layer: "strategy",
    kind: "export",
    sequence: 160,
    title: "策略包导出",
    buttonLabel: "导出策略包",
    description: "封装 S1-S10 工程资产与客户确认记录，形成执行层唯一交接文件。",
    owner: "S0 策略编排师",
    inputs: ["S1-S10 工程产物", "客户确认记录", "pause_log"],
    outputs: ["S0_{brand}_strategy_pack_vN.json", "策略层执行日志"],
    dependencies: ["S10"],
    phase: "策略层交付",
    privateSources: strategySources("Strategy_Workflow/S0.策略编排师.skill"),
  }),
  step({
    id: "E0",
    layer: "execution",
    kind: "agent",
    sequence: 210,
    title: "执行编排",
    buttonLabel: "导入策略包",
    description: "读取 strategy_pack，建立执行层任务上下文与产物路线。",
    owner: "E0 执行编排师",
    inputs: ["strategy_pack_vN.json", "recommended_business_actions", "企业提交图片库"],
    outputs: ["执行路由", "任务拆分", "图片库校验报告"],
    dependencies: ["STRATEGY_PACK"],
    phase: "执行层",
    privateSources: executionSources("Execution_Workflow/E0.执行编排师.skill"),
  }),
  step({
    id: "E1",
    layer: "execution",
    kind: "agent",
    sequence: 220,
    title: "内容策略菜单",
    buttonLabel: "内容菜单",
    description: "生成主题矩阵、优先级、内容类型和待生产清单。",
    owner: "E1 内容策略师",
    inputs: ["strategy_pack", "业务目标"],
    outputs: ["topic_matrix.json", "content_menu.md"],
    dependencies: ["E0"],
    phase: "执行层",
    privateSources: executionSources("Execution_Workflow/E1.内容策略师.skill"),
  }),
  step({
    id: "EP4",
    layer: "execution",
    kind: "pause",
    sequence: 230,
    title: "审批生产内容",
    buttonLabel: "审批内容",
    description: "确认本轮要生产的文章、素材和优先级。",
    owner: "人工确认点 4",
    inputs: ["E1 菜单", "审批意见"],
    outputs: ["已批准内容清单"],
    dependencies: ["E1"],
    phase: "执行层确认",
    privateSources: [],
  }),
  step({
    id: "E2",
    layer: "execution",
    kind: "agent",
    sequence: 240,
    title: "文字内容生成",
    buttonLabel: "生成文章",
    description: "按获批主题生成文章、FAQ、摘要和图片需求说明。",
    owner: "E2 文字内容生成师",
    inputs: ["获批主题", "话语体系", "内容要求"],
    outputs: ["article.md", "image_requirements.json"],
    dependencies: ["EP4"],
    phase: "执行层",
    privateSources: executionSources("Execution_Workflow/E2.文字内容生成师.skill"),
  }),
  step({
    id: "E3",
    layer: "execution",
    kind: "agent",
    sequence: 250,
    title: "视觉资产生成",
    buttonLabel: "生成视觉",
    description: "根据视觉规范与图片需求生成或组织图片资产。",
    owner: "E3 视觉资产生成师",
    inputs: ["image_requirements", "visual_prompt_pack"],
    outputs: ["视觉图片", "校验记录"],
    dependencies: ["E2"],
    phase: "执行层",
    privateSources: executionSources("Execution_Workflow/E3.视觉资产生成师.skill"),
  }),
  step({
    id: "E4",
    layer: "execution",
    kind: "agent",
    sequence: 260,
    title: "审查与组装",
    buttonLabel: "审查组装",
    description: "完成质量检查、品牌一致性审查和文档装配。",
    owner: "E4 质量审查与组装师",
    inputs: ["文章", "图片", "品牌规则"],
    outputs: ["DOCX", "质量审查报告"],
    dependencies: ["E3"],
    phase: "执行层",
    privateSources: executionSources(
      "Execution_Workflow/E4.质量审查与组装师.skill"
    ),
  }),
  step({
    id: "E5",
    layer: "execution",
    kind: "agent",
    sequence: 270,
    title: "分发编排",
    buttonLabel: "分发编排",
    description: "适配渠道、生成分发计划和 GEO 优化建议。",
    owner: "E5 分发编排师",
    inputs: ["已审内容", "渠道要求"],
    outputs: ["channel_plan.json", "分发清单"],
    dependencies: ["E4"],
    phase: "执行层",
    privateSources: executionSources("Execution_Workflow/E5.分发编排师.skill"),
  }),
  step({
    id: "EP5",
    layer: "execution",
    kind: "pause",
    sequence: 280,
    title: "继续生产确认",
    buttonLabel: "继续确认",
    description: "E5 完成后确认结束、回选题审批、回 E1 或返回策略层。",
    owner: "E5-END 继续生产确认",
    inputs: ["E5 分发正本", "继续生产选择"],
    outputs: ["结束 / 回暂停5 / 回 E1 / 返回策略层"],
    dependencies: ["E5"],
    phase: "执行层确认",
    privateSources: [],
  }),
];

const workflowRootCandidates = [
  process.env.FRONTMIND_WORKFLOW_ROOT,
  path.resolve(import.meta.dirname, "..", "private-workflows", "FrontMind_Workflow"),
  path.resolve(import.meta.dirname, "..", "..", "private-workflows", "FrontMind_Workflow"),
].filter(Boolean) as string[];

export const workflowManifest: WorkflowManifest = {
  workflowId: "frontmind-unified-workflow",
  title: "FrontMind Workflow",
  version: "v3.1-panorama-report",
  description: "",
  steps: steps
    .filter((stepData) => stepData.id !== "S0")
    .map(({ privateSources: _privateSources, ...publicStep }) => publicStep),
  securityRules: [],
};

export function getPrivateWorkflowStep(stepId: string) {
  return steps.find((item) => item.id === stepId) ?? null;
}

export async function resolveWorkflowRoot() {
  for (const candidate of workflowRootCandidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function isInsideRoot(candidatePath: string, rootPath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readPrivateFileStats(filePath: string) {
  const content = await fs.readFile(filePath);
  return {
    checkedFiles: 1,
    availableFiles: 1,
    loadedBytes: content.byteLength,
  };
}

async function readPrivateDirectoryStats(dirPath: string): Promise<{
  checkedFiles: number;
  availableFiles: number;
  loadedBytes: number;
}> {
  let checkedFiles = 0;
  let availableFiles = 0;
  let loadedBytes = 0;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of visibleEntries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await readPrivateDirectoryStats(entryPath);
      checkedFiles += nested.checkedFiles;
      availableFiles += nested.availableFiles;
      loadedBytes += nested.loadedBytes;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    checkedFiles += 1;
    try {
      const fileStats = await readPrivateFileStats(entryPath);
      availableFiles += fileStats.availableFiles;
      loadedBytes += fileStats.loadedBytes;
    } catch {
      // Count the file as checked but unavailable.
    }
  }

  return { checkedFiles, availableFiles, loadedBytes };
}

async function readPrivateSourceStats(workflowRoot: string, relativeSource: string) {
  const rootPath = path.resolve(workflowRoot);
  const fullPath = path.resolve(rootPath, relativeSource);

  if (!isInsideRoot(fullPath, rootPath)) {
    return { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
  }

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const directoryStats = await readPrivateDirectoryStats(fullPath);
      return directoryStats.checkedFiles > 0
        ? directoryStats
        : { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
    }

    if (stat.isFile()) {
      return readPrivateFileStats(fullPath);
    }
  } catch {
    // Missing expected source.
  }

  return { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
}

function artifactKind(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json" as const;
  if (lower.endsWith(".html") || lower.includes("网站") || lower.includes("astro") || lower.includes("json-ld")) return "site" as const;
  if (lower.endsWith(".docx") || lower.endsWith(".pdf") || lower.endsWith(".xlsx") || lower.includes("docx")) return "document" as const;
  if (lower.endsWith(".md") || lower.includes("报告") || lower.includes("清单")) return "markdown" as const;
  if (lower.includes("图片") || lower.includes("视觉")) return "image" as const;
  return "package" as const;
}

export async function loadPrivateSkillPackage(stepId: string) {
  const stepData = getPrivateWorkflowStep(stepId);
  if (!stepData) {
    return null;
  }

  const workflowRoot = await resolveWorkflowRoot();
  if (!workflowRoot) {
    return {
      step: stepData,
      workflowRootConfigured: false,
      checkedSources: stepData.privateSources.length,
      availableSources: 0,
      loadedBytes: 0,
      loaded: stepData.privateSources.length === 0,
      artifactPlaceholders: stepData.outputs.map((name) => ({ name, kind: artifactKind(name) })),
    };
  }

  let checkedSources = 0;
  let availableSources = 0;
  let loadedBytes = 0;

  for (const relativeSource of stepData.privateSources) {
    const sourceStats = await readPrivateSourceStats(workflowRoot, relativeSource);
    checkedSources += sourceStats.checkedFiles;
    availableSources += sourceStats.availableFiles;
    loadedBytes += sourceStats.loadedBytes;
  }

  return {
    step: stepData,
    workflowRootConfigured: true,
    checkedSources,
    availableSources,
    loadedBytes,
    loaded: stepData.privateSources.length === 0 || (checkedSources > 0 && availableSources === checkedSources),
    artifactPlaceholders: stepData.outputs.map((name) => ({ name, kind: artifactKind(name) })),
  };
}

export function buildOperatorMessages(
  kind: WorkflowStepKind,
  title: string,
  inputs: string[],
  outputs: string[],
  hasOperatorNotes: boolean
) {
  if (kind === "pause") {
    return [
      `${title} 已记录为人工确认节点。`,
      hasOperatorNotes ? "操作者补充意见已记录。" : "当前可直接确认，也可以补充修正意见后再确认。",
      `确认后将解锁下一步，预期输出：${outputs.join("、")}。`,
    ];
  }

  return [
    `${title} 已进入当前任务。`,
    hasOperatorNotes ? "操作者补充已记录。" : `建议补充：${inputs.join("、")}。`,
    `本环节预期生成：${outputs.join("、")}。`,
  ];
}
