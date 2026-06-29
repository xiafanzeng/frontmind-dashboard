# FrontMind 全局总控与契约规范

> **Single Source of Truth（SSOT）**：本文档是 FrontMind 双层工作流（策略层 + 执行层）的**唯一权威规范**。所有 Agent 的 SKILL.md 在涉及跨层交互、命名空间、产物契约、版本管理时，必须以本文档为准。若 Agent 内部定义与本文档冲突，以本文档为准。

---

> **v3.9 执行层企业提交图片库契约（2026-06-21）**：执行层启动输入不再只有策略包，必须同时提供 `Client_Submitted_Image_Library.zip` 或 `client_submitted_image_library/`。图片库不再需要内置或确认 `image_library_manifest.json`；E0 在进入 E1 前自动扫描图片库，校验图片文件、显式版权限制和用途，并生成标准化图片库 manifest/索引；E1-E5 所有企业实图、证书图、团队图、案例图、产品图、门店/环境图必须引用该图片库的 asset_id，不能用官网抓取图、网络图或 AIGC 冒充企业实图。当前执行层以 `E0 → E1 → 暂停5 → E2 → E3 → E4 → E5` 为单轮主线。E1/E0 必须为每篇文章明确 `title_generation_policy`、`title_objective` 与 `title_anchor`；A 类在进入 E2 前必须确认待优化 GEO 问题。E5 先强制生成不带文章标题的 HarnessGEO 优化唯一正文正本，再输出基于 S5/S9 的分发编排包、渠道建议、标题映射和信源建设清单；T1-T5 标题必须在对话中直接打印；所有标题均按文章类型和任务目的生成，禁止套用统一问答/盘点/方案/指南/趋势模板。E5 完成后，E0 必须询问用户是否继续制作更多内容：不继续则最终打包；继续当前菜单未生产内容则回暂停5（选题审批）；新增文章类型/新选题则回 E1；策略口径变化则返回策略层重新确认。该确认不是渠道确认，不触发发布、预算、建站或监测回流。

## 1. 架构总览

FrontMind 采用**策略-执行双层解耦架构**，通过一个标准化的 JSON 策略包（`strategy_pack_v{N}.json`）实现层间握手。

```
┌─────────────────────────────────────────────────────────────────┐
│                     FrontMind 全局总控                           │
│              FrontMind_Master_Control.md (本文档)                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ 定义契约 & 命名空间
          ┌────────────────┴────────────────┐
          ▼                                 ▼
┌─────────────────────┐          ┌─────────────────────┐
│    策略层 Workflow    │          │    执行层 Workflow    │
│  S0 → S1-S9 → S10确认表 → Pack │ ─成果zip▶│  E0 → E1-E5        │
│                      │          │  E5后继续生产确认   │
│  暂停 1 / 2 / 3 / 4 │          │  暂停5 + 收口确认   │
└─────────────────────┘          └─────────────────────┘
```

### 1.1 两层工作流的独立性

策略层和执行层是**两个独立的 Manus 会话**，分别上传各自的 ZIP 包启动。它们之间的唯一通信媒介是 `strategy_pack_v{N}.json` 文件。

| 属性 | 策略层 | 执行层 |
| :--- | :--- | :--- |
| 入口 Agent | S0 策略编排师 | E0 执行编排师 |
| 子 Agent | S1-S10（S10 为客户交付节点，执行层工程输入仍为 S1-S9） | E1-E5 |
| 启动方式 | 用户上传策略层 ZIP | 用户上传执行层 ZIP + 策略层成果 zip（含 strategy_pack_v{N}.json 与 S1-S9 全部源文件）+ 企业提交图片库 |
| 暂停点 | 暂停 1 / 2 / 3 / 4 | 暂停 5 + E5-END 继续生产确认 |
| 产出 | 策略包 JSON + S10 品牌信息确认表 XLSX（双子表）+ 可选 S1-S9 单节点 PDF | 无文章标题的文章 DOCX/MD + 5 标题池（对话打印）+ 视觉资产 + 无标题 HarnessGEO 正本 + 分发编排包 |
| 回流入口 | 可在下一轮策略启动时接收外部反馈文件 | 主线不产出回流 JSON |

### 1.2 设计原则

1. **单一职责**：策略层只做"想清楚"，执行层只做"做出来"。
2. **契约驱动**：层间通过 JSON Schema 严格约束，不允许口头约定。
3. **版本可追溯**：策略包有版本号，每次策略包重算版本号 +1。
4. **人工闸门**：全流程保留 5 个强制暂停点（策略层 4 + 执行层 1）；策略层暂停 4 用于品牌信息确认表最终确认与回灌，执行层暂停 5 用于审批 Content Brief。E5 后另有“继续生产确认”，只决定是否继续制作更多文章/文章类型，不用于渠道确认、预算确认或投放确认。
5. **降级容错**：非核心节点缺失时可降级执行，但必须记录并通知用户。

---

## 2. 统一命名空间

### 2.1 Agent 编号规范

| 编号 | 名称 | 层级 | 职责一句话 |
| :--- | :--- | :--- | :--- |
| **S0** | 策略编排师 | 策略层 | 调度 S1-S10，管理暂停 1/2/3/4，封装策略包并登记 S10 客户交付物（品牌信息确认表）；暂停4后按企业确认回灌 S1-S9 再封包 |
| **S1** | 品牌知识库构建师 | 策略层 | 品牌事实图谱 JSON + 知识库 MD |
| **S2** | 营销图谱构建师 | 策略层 | 用户-场景-意图三元组 + 场景/意图分析 |
| **S3** | 品类趋势分析师 | 策略层 | 品类趋势报告 + 打分卡 |
| **S4** | 品牌定位策略师 | 策略层 | 品牌定位声明 + 差异化矩阵 |
| **S5** | 品牌诊断专家 | 策略层 | AI 可见性诊断 + Gap 报告 |
| **S5.5** | 品牌语义资产审计师 | 策略层 | 品牌语义资产量化打分 |
| **S6** | 品牌话语架构师 | 策略层 | 话语手册 + 话语 Token JSON |
| **S7** | 视觉符号体系 | 策略层 | 视觉 Prompt 包 JSON |
| **S8** | 问答架构师 | 策略层 | 问答树 + 问答矩阵 + 内容日历 |
| **S9** | 业务赋能规划师 | 策略层 | S1-S8 企业问题总结 + GEO 业务建议 + 优先行动清单 |
| **S10** | 品牌信息确认表生成师 | 策略层 | 整合 S1-S9 成果与企业已回填的《应答逻辑确认表》，生成《品牌信息确认表》XLSX（双子表）；不再生成全景报告 |
| **E0** | 执行编排师 | 执行层 | 接收策略包和企业提交图片库，校验图片素材后调度 E1-E5；E5 后询问是否继续生产 |
| **E1** | 内容策略师 | 执行层 | 全文章类型 Content Brief + 工作标题 + 选题菜单 + 逐图素材计划 |
| **E2** | 文字内容生成师 | 执行层 | 单篇无文章标题正文 MD + 5 个目的驱动标题备选 JSON（A类匹配已确认GEO问题，C1b为品牌品宣同题改写；对话打印 T1-T5）+ 图片需求 JSON |
| **E3** | 视觉资产生成师 | 执行层 | 基于企业提交图片库与 S7 Prompt 生成/选择配图 PNG + 验证报告 |
| **E4** | 质量审查与组装师 | 执行层 | 无文章标题 DOCX/MD 组装 + 正文/图片/标题池审查（A类问题匹配、C1b防漂移、B/C/D目的一致）+ 对话打印审核后 T1-T5 |
| **E5** | 分发编排师 | 执行层 | 无文章标题 HarnessGEO 正本优化 + 合规审查 + 5 标题池（对话可见） |

### 2.2 产物文件命名规范

所有产物文件必须遵循以下命名模式：

```
{brand}_{产物描述}.{ext}
```

其中 `{brand}` 为品牌名称（中文或英文均可，但全流程保持一致）。

**策略层核心产物命名表**：

| Agent | 产物 | 文件名 |
| :--- | :--- | :--- |
| S1 | 品牌事实图谱 | `S1_{brand}_品牌事实图谱.json` |
| S1 | 品牌知识库 | `S1_{brand}_品牌知识库.md` / `.pdf` |
| S2 | 营销图谱 | `S2_{brand}_营销图谱.json` |
| S2 | 营销图谱报告 | `S2_{brand}_营销图谱报告.md` / `.pdf` |
| S3 | 品类趋势报告 | `S3_{brand}_品类趋势报告.md` / `.pdf` |
| S3 | 趋势打分卡 | `S3_{brand}_趋势打分卡.json` |
| S4 | 品牌定位声明 | `S4_{brand}_品牌定位声明.md` / `.pdf` |
| S4 | 定位声明 JSON | `S4_{brand}_定位声明.json` |
| S4 | 定位分析报告 | `S4_{brand}_定位分析报告.md` / `.pdf` |
| 暂停3 | 应答逻辑确认表（待回填） | `{brand}_应答逻辑确认表.xlsx` |
| 暂停3 | 应答逻辑确认表（企业回填版） | `{brand}_应答逻辑确认表_现场讨论.xlsx` |
| S5 | 品牌诊断数据 | `S5_{brand}_品牌诊断数据.json` / `.md` / `.pdf` |
| S5 | Gap 报告 | `S5_{brand}_Gap报告.md` |
| S5.5 | 语义资产评分卡 | `S5.5_{brand}_语义资产评分卡.json` |
| S5.5 | 语义资产审计报告 | `S5.5_{brand}_语义资产审计报告.md` / `.pdf` |
| S6 | 话语手册 | `S6_{brand}_话语手册.md` / `.pdf` |
| S6 | 话语 Token | `S6_{brand}_话语token.json` |
| S7 | 视觉 Prompt 包 | `S7_{brand}_视觉Prompt包.json` |
| S7 | 视觉符号体系报告 | `S7_{brand}_视觉符号体系报告.md` / `.pdf` |
| S8 | 问答树 | `S8_{brand}_问答树.json` |
| S8 | 问答矩阵 | `S8_{brand}_问答矩阵.json` |
| S8 | 内容日历 | `S8_{brand}_内容日历.json` |
| S8 | 问答报告 | `S8_{brand}_问答报告.md` / `.pdf` |
| S8 | 落地页蓝图 | `S8_{brand}_落地页蓝图.md` |
| S9 | 业务赋能建议包 | `S9_{brand}_业务赋能建议包.md` / `.pdf` |
| S9 | 策略完整性检查 | `S9_{brand}_策略完整性检查.md` |
| S10 | 品牌信息确认表（双子表） | `S10_{brand}_品牌信息确认表.xlsx` |

**执行层核心产物命名表**：

| Agent | 产物 | 文件名 |
| :--- | :--- | :--- |
| E1 | 全文章类型选题矩阵 | `E1_{brand}_选题矩阵.json` |
| E1 | 选题菜单 | `E1_{brand}_选题菜单.md` |
| E2 | 无文章标题正文 | `E2_{brand}_{article_id}_article.md` |
| E2 | 5 标题备选 | `E2_{brand}_{article_id}_title_options.json` |
| E2 | 标题验证 | `E2_{brand}_{article_id}_title_validation.txt` |
| E2 | 图片需求 | `E2_{brand}_{article_id}_image_requirements.json` |
| E2 | 文本验证 | `E2_{brand}_{article_id}_text_validation.txt` |
| E3 | 配图 | `images/E3_{article_id}_fig{N}_{desc}.png` |
| E4 | 组装 DOCX | `E4_{brand}_{article_id}_final.docx` |
| E4 | 审核后标题池 | `E4_{brand}_{article_id}_title_options_reviewed.json` |
| E4 | 标题验证 | `E4_{brand}_{article_id}_title_validation.txt` |
| E4 | 审查报告 | `E4_{brand}_{article_id}_quality_review.md` |
| E5 | 无文章标题 HarnessGEO 优化正本 | `E5_{brand}_{article_id}_harnessgeo_optimized.md` / `.docx` |
| E5 | HarnessGEO 优化报告 | `E5_{brand}_{article_id}_harnessgeo_report.json` |
| E5 | 合规审查报告 | `E5_{brand}_compliance_report.md` |
| E5 | 交付清单 | `E5_{brand}_delivery_manifest.json` |
| E0 | 企业提交图片库 Manifest | `E0_{brand}_submitted_image_library_manifest.json` |
| E0 | 图片库校验报告 | `E0_{brand}_image_library_validation_report.md` |
| E0 | 图片注册表 | `E0_{brand}_image_registry.json` |
| E0 | 全链路产出 ZIP | `E0_{brand}_FrontMind全链路产出.zip` |
| E0 | 展示网页 | `E0_{brand}_FrontMind全链路展示.html` |

---

## 3. 策略包契约（strategy_pack Schema）

`strategy_pack_v{N}.json` 是策略层移交执行层的**唯一凭证**。以下为其权威 Schema 定义。

### 3.1 顶层结构

```json
{
  "meta": { ... },
  "artifacts": { ... },
  "recommended_business_actions": [ ... ],
  "s7_branch": "B",
  "pause_log": { ... }
}
```

### 3.2 meta 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `brand` | string | 是 | 品牌名称 |
| `version` | integer | 是 | 策略包版本号，初始为 1，每次回流重算 +1 |
| `created_at` | string (ISO 8601) | 是 | 创建时间 |
| `created_by` | string | 是 | 固定值 `"S0_strategy_orchestrator"` |
| `strategy_nodes_completed` | array of string | 是 | 已完成的策略资产节点列表，如 `["S1","S2","S3","S4","S5","S5.5","S6","S7","S8","S9"]`；S10 作为客户交付节点可记录在 `meta.client_report_nodes_completed` |

### 3.3 artifacts 字段（★ 权威定义）

> **⚠️ 跨层契约警告**：E0 解析策略包时必须使用本节定义的 `artifacts` 结构。绝对不能使用任何旧版的 `nodes` 结构。

```json
{
  "artifacts": {
    "S1_brand_facts": {
      "json": "S1_{brand}_品牌事实图谱.json",
      "md": "S1_{brand}_品牌知识库.md",
      "pdf": "S1_{brand}_品牌知识库.pdf",
      "sha256": "..."
    },
    "S2_marketing_atlas": {
      "json": "S2_{brand}_营销图谱.json",
      "md": "S2_{brand}_营销图谱报告.md",
      "pdf": "S2_{brand}_营销图谱报告.pdf",
      "sha256": "..."
    },
    "S3_category_trend": {
      "json": "S3_{brand}_趋势打分卡.json",
      "md": "S3_{brand}_品类趋势报告.md",
      "pdf": "S3_{brand}_品类趋势报告.pdf",
      "sha256": "..."
    },
    "S4_positioning": {
      "json": "S4_{brand}_定位声明.json",
      "md": "S4_{brand}_品牌定位声明.md",
      "pdf": "S4_{brand}_品牌定位声明.pdf",
      "report_md": "S4_{brand}_定位分析报告.md",
      "report_pdf": "S4_{brand}_定位分析报告.pdf",
      "sha256": "..."
    },
    "S5_diagnosis": {
      "json": "S5_{brand}_品牌诊断数据.json",
      "md": "S5_{brand}_品牌诊断数据.md",
      "pdf": "S5_{brand}_品牌诊断数据.pdf",
      "gap_md": "S5_{brand}_Gap报告.md",
      "sha256": "..."
    },
    "S5.5_semantic_audit": {
      "json": "S5.5_{brand}_语义资产评分卡.json",
      "md": "S5.5_{brand}_语义资产审计报告.md",
      "pdf": "S5.5_{brand}_语义资产审计报告.pdf",
      "sha256": "..."
    },
    "S6_verbal_identity": {
      "md": "S6_{brand}_话语手册.md",
      "pdf": "S6_{brand}_话语手册.pdf",
      "token_json": "S6_{brand}_话语token.json",
      "sha256": "..."
    },
    "S7_supersign": {
      "prompt_json": "S7_{brand}_视觉Prompt包.json",
      "md": "S7_{brand}_视觉符号体系报告.md",
      "pdf": "S7_{brand}_视觉符号体系报告.pdf",
      "sha256": "..."
    },
    "S8_question_qa": {
      "json": "S8_{brand}_问答树.json",
      "matrix_json": "S8_{brand}_问答矩阵.json",
      "calendar_json": "S8_{brand}_内容日历.json",
      "md": "S8_{brand}_问答报告.md",
      "pdf": "S8_{brand}_问答报告.pdf",
      "blueprint_md": "S8_{brand}_落地页蓝图.md",
      "sha256": "..."
    },
    "S9_enablement": {
      "md": "S9_{brand}_业务赋能建议包.md",
      "pdf": "S9_{brand}_业务赋能建议包.pdf",
      "completeness_md": "S9_{brand}_策略完整性检查.md",
      "sha256": "..."
    }
  },
  "client_deliverables": {
    "brand_info_confirmation_sheet": "S10_{brand}_品牌信息确认表.xlsx",
    "answer_logic_confirmation_form": "{brand}_应答逻辑确认表.xlsx",
    "answer_logic_confirmation_form_confirmed": "{brand}_应答逻辑确认表_现场讨论.xlsx"
  }
}
```

### 3.3.1 S10 品牌信息确认表生成规则

S10 不再生成全景报告（全景报告由其他 Workflow 负责），而是整合 S1-S9 成果与企业已回填的《应答逻辑确认表》，生成《品牌信息确认表》XLSX，含两个子表：

| 子表 | 内容 | 数据来源 |
| :--- | :--- | :--- |
| 子表1 品牌信息确认 | 参考《品牌信息收集表》结构，逐项汇总品牌信息供企业确认；中间设「企业填写/修改」高亮列；删除收集表末尾“提出的问题”区段 | S1-S9 |
| 子表2 监控问题与应答逻辑确认 | 参考《应答逻辑确认表》，逐条列出监控问题、应答逻辑、备注、参考资料；中间设「企业想修改」高亮列 | 企业已回填的《应答逻辑确认表》 |

两个子表统一遵循《品牌信息收集表》紫色配色（主标题 `#4A154B`、表头 `#6B3FA0`、企业填写/修改列浅黄 `#FFFDE7`）。舆情/排名分流统计已在 S5 诊断完成，S10 不再承担。`client_deliverables` 中的 S10 XLSX 供客户确认、汇报和归档；E0 仍只把 `artifacts` 中的 S1-S9 资产作为执行层工程输入。

### 3.4 recommended_business_actions 字段

S9 不再输出旧的模块菜单，而是基于 S1-S8 的企业问题总结，写入 `recommended_business_actions` 行动清单。该字段用于记录 S9 建议优先推进的 GEO 业务动作，只表达问题来源、行动优先级、预期业务效果和执行线索。

| action_id | 行动名称 | 典型触发条件 | 执行理解 |
| :--- | :--- | :--- | :--- |
| `GEO_A1_entity_facts` | 实体与事实资产修复 | S1/S4 显示企业事实、资质、案例或 RTB 证据不足 | 先补齐可被 AI 引用的事实底座 |
| `GEO_A2_ai_visibility` | AI 可见性修复 | S5 显示提及率低、排名靠后、情绪弱或竞品占位 | 围绕 AI 监测结果修复高优先级问题 |
| `GEO_A3_qa_assets` | 问答内容资产建设 | S2/S8 显示高意图问题未被品牌内容承接 | 建设 FAQ、比较页、场景页和标准答案 |
| `GEO_A4_positioning_language` | 定位与话语一致性 | S4/S6/S8 存在主张、RTB、话语和答案断裂 | 统一品牌表达与 AI 可复用答案模板 |
| `GEO_A5_site_schema` | 网站与结构化数据 | 官网或落地页无法承接核心问题，Schema 缺失 | 补强实体页、服务页、FAQPage 与结构化数据 |
| `GEO_A6_distribution_citations` | 分发与引用路径 | S5 显示信源缺口或竞品占据高频引用源 | 布局 AI 常引用的第三方信源与证明页面 |

> **执行层消费规则**：E0 解析 `recommended_business_actions` 作为 S9 问题总结后的优先行动参考，不再把它当作旧模块开关。

### 3.5 pause_log 字段

记录策略层四个暂停/确认点的用户决策：pause_2 记录 AI 监测数据上传，pause_3 记录《应答逻辑确认表》的生成与企业回填，pause_4 记录《品牌信息确认表》的生成、企业回传与回灌结果。

```json
{
  "pause_log": {
    "pause_1": {"status": "confirmed", "user_feedback": "事实无误"},
    "pause_2": {"status": "completed|pending_upload", "region": "国内/海外/全球", "uploaded_file": "{brand}_AI可见性监测数据.json|null"},
    "pause_3": {"status": "completed|pending_generation|pending_client_confirmation", "generated_file": "{brand}_应答逻辑确认表.xlsx|null", "uploaded_file": "{brand}_应答逻辑确认表_现场讨论.xlsx|null", "confirmation_record": "{brand}_应答逻辑确认记录.json|null"},
    "pause_4": {"status": "completed|pending_client_confirmation", "generated_file": "S10_{brand}_品牌信息确认表.xlsx|null", "uploaded_file": "S10_{brand}_品牌信息确认表_已确认.xlsx|null", "diff_record": "{brand}_品牌信息修改清单.json|null"}
  }
}
```

---

## 3.7 问题阶段全局枚举（★ 新增）

> **⚠️ 跨层契约强制约束**：策略层（S8）和执行层（E1/E5）在标注问题阶段时，**必须且只能**使用以下 5 个枚举值。任何 Agent 的 Schema、模板或方法论文档中出现 `retention` 字样的，一律视为历史遗留错误，必须替换为 `usage`。

| 枚举值 | 中文名 | 阶段说明 | 对应 question_id 前缀 |
| :--- | :--- | :--- | :--- |
| `awareness` | 认知 | 用户首次接触品牌/品类 | AW |
| `consideration` | 考虑 | 用户对比评估多个选项 | CO |
| `decision` | 决策 | 用户做出购买/合作决定 | DE |
| `usage` | 使用 | 用户已购买，正在使用产品/服务 | US |
| `advocacy` | 倡导 | 用户主动推荐品牌给他人 | AD |

> **历史说明**：早期版本曾使用 `retention`（留存）作为第四阶段名称。自 v2.7 起统一为 `usage`（使用），因为"使用"更精确地描述了该阶段用户的行为状态——他们不是被动"留存"，而是主动"使用"产品并产生体验反馈。

---

## 4. 暂停点全局编号

FrontMind 全流程共 **5 个全局暂停/确认点**（策略层 4 + 执行层 1），编号全局唯一，不允许重复或跳号。其中暂停 2 是 AI 监测问题/地域/数据确认，暂停 3 是 S9 完成后生成《应答逻辑确认表》交企业现场讨论回填，暂停 4 是 S10 后企业回填《品牌信息确认表》做最终确认并回灌；执行层仅保留暂停 5（选题审批），不再设置渠道确认暂停。

| 暂停编号 | 所属层 | 所属 Agent | 时机 | 用户动作 |
| :--- | :--- | :--- | :--- | :--- |
| **暂停 1** | 策略层 | S0 | S1 品牌事实图谱完成后 | 确认事实准确性 |
| **暂停 2** | 策略层 | S0 | S4 定位完成后、S5 启动前 | 客户自行确认 AI 监控问题、监测地域/平台，并上传 AI 可见性监测数据；S2 不再提供 S5 问题来源 |
| **暂停 3** | 策略层 | S0 | S9 业务赋能完成后、S10 启动前 | 生成 `{brand}_应答逻辑确认表.xlsx` 交企业现场讨论回填，回填结果作为 S10 子表2 的数据源 |
| **暂停 4** | 策略层 | S0 | S10 品牌信息确认表生成后、封包前 | 企业回填《品牌信息确认表》两子表高亮列做最终确认，S0 据此逐项回灌受影响 S1-S9 节点后才封装策略包 |
| **暂停 5** | 执行层 | E0 | E1 核心素材清单完成后 | 审批整体内容方案，并确认要制作的文章 |

---

## 5. E5 输入契约映射（★ 关键修复）

E5 分发编排师的输入必须从 `strategy_pack` 的 `artifacts` 结构中提取，**不得使用旧版 GEO_Workflow 的 Agent 编号或产物名称**。

### 5.1 E5 输入映射表

| E5 需要的输入 | 旧版引用（已废弃） | 新版正确引用（strategy_pack 路径） |
| :--- | :--- | :--- |
| 品牌诊断数据 | `Agent 2 品牌诊断数据.md` | `artifacts.S5_diagnosis.md` 或 `.json` |
| 品牌策略报告 | `Agent 3 品牌策略报告.md` | `artifacts.S4_positioning.report_md`（定位分析报告）|
| D 类社媒方向建议 | `Agent 3 策略报告` | `artifacts.S9_enablement.md`（S9 问题总结与 GEO 行动建议中涉及分发、引用路径或问答资产的建议）|
| 核心素材文章 MD | `E4.3 产出` | E4 当前轮次产出（由 E0 传入）|
| 配图文件 | `E4.2 产出` | E3 当前轮次产出（由 E0 传入）|

### 5.2 E5 SKILL.md 中需要修改的具体位置

1. **name 字段**：从 `geo-distribution-orchestrator` 改为 `frontmind-distribution-orchestrator`
2. **description 中的引用**：
   - `内容生产流水线(4.1/4.2/4.3)` → `内容生产流水线(E2/E3/E4)`
   - `Agent 2（品牌诊断专家）` → `S5（品牌诊断专家，通过策略包引用）`
   - `Agent 3（品牌策略师）` → `S4（品牌定位策略师，通过策略包引用）+ S9（业务赋能规划师，通过策略包引用）`
3. **输入文件表**：
   - `S5_{brand}_品牌诊断数据.md` 来源从 `Agent 2` 改为 `S5（通过 strategy_pack.artifacts.S5_diagnosis）`
   - `{brand}_品牌策略报告.md` 来源从 `Agent 3` 改为 `S4（通过 strategy_pack.artifacts.S4_positioning）`
4. **并行关系说明**：删除 `与 Agent 6（SEO基建）基于策略报告并行执行` 的旧描述
5. **下游引用**：E5 为执行层终点，不再声明后续监测 Agent。

---

## 6. 共享资源规范

### 8.1 shared 目录

策略层和执行层各自维护一个 `shared/` 目录，包含以下共享资源：

| 文件 | 用途 | 两层共用 |
| :--- | :--- | :--- |
| `shared/output-format-standard.md` | 输出格式规范（源文件先行 + S10 品牌信息确认表 + 单节点 PDF 后置确认） | 是 |
| `shared/geo_pdf_generator.py` | PDF 生成脚本 | 是 |
| `shared/brand_compliance_rules.md` | 品牌合规规则（广告法等） | 是 |

### 8.2 PDF 生成统一命令

S1-S9 单节点 MD → PDF 转换在 S10 完成后、用户确认需要时使用以下统一命令（S10 本身输出 XLSX，无需 PDF 渲染）：

```bash
python3 shared/geo_pdf_generator.py {input}.md {output}.pdf --title "{标题}"
```

---

## 9. 错误处理与降级策略

### 9.1 打回机制

| 层级 | 打回上限 | 超限处理 |
| :--- | :--- | :--- |
| 策略层（S0 打回 S1-S10） | 每节点最多 2 次 | 向用户报告差异，请求人工决策 |
| 执行层（E0 打回 E2/E3/E4） | 每篇文章最多 2 次 | 向用户报告差异，请求人工决策 |

### 9.2 降级执行

当非核心输入缺失时，允许降级执行：

| 缺失输入 | 影响 Agent | 降级策略 |
| :--- | :--- | :--- |
| S8 问答树 | E1 | E1 仅基于 S5 诊断数据生成选题，问题阶段标注为"未分类" |
| S9 赋能建议 | E0 | 若缺失则跳过 S9 行动优先级读取，执行层基于 S5 诊断与 S8 问答资产继续生成基础 GEO 内容建议 |
| S7 视觉 Prompt 包 | E3 | E3 自行生成 Prompt（但标注"未使用 S7 模板"） |
| S6 话语 Token | E2 | E2 正常写作但跳过 Token 命中率校验 |

> **降级必须记录**：任何降级执行都必须在执行日志中记录，并在最终交付时通知用户。

---

## 10. 变更日志

| 版本 | 日期 | 变更内容 |
| :--- | :--- | :--- |
| v1.0 | 2026-04-26 | 初版。基于 FrontMind 双层工作流深度分析报告创建。 |

---

FrontMind 全链路自本版本起将策略层最终交付拆分为两类：

| 类别 | 文件 | 是否进入执行层必需输入 |
| :--- | :--- | :--- |
| 执行层工程包 | `strategy_pack_v{N}.json` 中的 S1-S9 artifacts | 是 |
| 客户品牌信息确认表 | `client_deliverables` 中的 S10 品牌信息确认表 XLSX 与应答逻辑确认表 | 否，供客户确认与归档 |
