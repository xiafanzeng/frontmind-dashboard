# FrontMind 策略层工作流 (Strategy Workflow)

> **版本**：v3.5-s10-brand-info-confirmation（S10 品牌信息确认表）
> **更新日期**：2026-06-11
> **架构**：双层工作流 — 策略层
> **节点数**：12（S0-S10，包含 S5.5；S10 为品牌信息确认表生成器，旧 S9.5 已并入暂停3 应答逻辑确认表）

---

## 一、工作流定位

FrontMind 策略工作流是 FrontMind 双层工作流架构的**上层**，专注于品牌策略的研究、诊断与规划。其工程输出物——`S0_{brand}_strategy_pack_v{N}.json`——是下层执行工作流（Execution Workflow）的唯一输入凭证；其客户交付物还包括 S10 生成的《品牌信息确认表》XLSX（双子表）。全景报告已由其他 Workflow 负责，策略层不再生成全景报告。

```
┌─────────────────────────────────────────────────────────┐
│                    策略工作流（本包）                       │
│  S0 编排师 → S1 知识库 → S2 图谱 → S3 趋势 → S4 定位     │
│           → S5 诊断 → S5.5 审计 → S6 话语 → S7 符号 → S8 问答          │
│           → S9 赋能 →（暂停3：应答逻辑确认表回填）→ S10 品牌信息确认表 XLSX  │
│           →（暂停4：企业回填最终确认）→ 回灌 S1-S9 → 封装策略包         │
└──────────────────────────┬──────────────────────────────┘
                           ↓
┌──────────────────────────┴──────────────────────────────┐
│                    执行工作流（另包）                       │
│  E0 编排师 → E1 选题 → E2 文案 → E3 视觉 → E4 排版      │
│           → E5 HarnessGEO 正本优化与分发编排 → 结束       │
└─────────────────────────────────────────────────────────┘
```

---

## 二、目录结构

```
FrontMind_Strategy_Workflow/
├── README.md                              ← 本文件
├── shared/                                ← 全局共享资源
│   ├── brand_facts_schema.json            ← 品牌事实图谱 JSON Schema
│   ├── geo_pdf_generator.py               ← MD→PDF 转换工具
│   └── output-format-standard.md          ← 源文件先行 + S10 品牌信息确认表 + 统一 PDF 后置规范
│
├── S0.策略编排师.skill/                    ← 顶层总控（Meta Prompt 入口）
│   ├── SKILL.md                           ← ★ 策略层唯一入口
│   ├── references/
│   │   └── strategy-orchestration-rules.md
│   ├── templates/
│   │   └── strategy_pack_template.json
│   └── scripts/
│       ├── state_detector.py              ← 断点续跑检测器
│       └── pack_builder.py                ← 执行层工程策略包构建器
│
├── S1.品牌资产知识库.skill/                ← 事实底稿 + 全网公共情报中心
│   ├── SKILL.md
│   ├── references/
│   │   ├── brand-facts-schema.md
│   │   ├── info-collection-template.md
│   │   └── industry-intel-playbook.md  ← v2.8 新增：行业情报获取手册
│   ├── templates/
│   │   └── brand_knowledge_md_template.md
│   └── scripts/
│       ├── json_schema_validator.py
│       ├── gap_reporter.py
│       └── visual_scraper.py
│
├── S2.营销图谱专家.skill/                  ← 用户-场景-意图三元组
│   ├── SKILL.md
│   ├── references/
│   │   ├── atlas-methodology.md
│   │   └── two-layer-question-framework.md
│   ├── templates/
│   │   └── atlas_report_template.md
│   └── scripts/
│       └── atlas_validator.py
│
├── S3.品类趋势研判师.skill/                ← 品类趋势分析（优先消费 S1 信号快照）
│   ├── SKILL.md
│   ├── references/
│   │   ├── trend-frameworks.md
│   │   └── signal-source-list.md
│   ├── templates/
│   │   └── trend_scorecard.json
│   └── scripts/
│       └── signal_aggregator.py
│
├── S4.品牌定位分析师.skill/                ← 差异化定位声明
│   ├── SKILL.md
│   ├── references/
│   │   ├── positioning-frameworks.md
│   │   └── competitive-analysis-method.md
│   ├── templates/
│   │   └── positioning_statement_template.md
│   └── scripts/
│       └── positioning_validator.py
│
├── S5.品牌诊断专家.skill/                  ← AI 可见性 7 维诊断
│   ├── SKILL.md
│   ├── references/
│   │   └── diagnosis-metrics.md
│   ├── templates/
│   │   └── diagnosis_data_schema.json
│   └── scripts/
│       └── gap_calculator.py
│
├── S5.5.品牌语义资产审计师.skill/          ← 品牌语义资产量化打分
│   ├── SKILL.md
│   ├── references/
│   │   ├── bsas-methodology.md
│   │   └── scoring-benchmarks.md
│   ├── templates/
│   │   ├── bsas_scorecard_schema.json
│   │   └── bsas_report_template.md
│   └── scripts/
│       └── bsas_calculator.py
│
├── S6.品牌话语体系.skill/                  ← 品牌语言体系
│   ├── SKILL.md
│   ├── references/
│   │   └── verbal-identity-method.md
│   ├── templates/
│   │   ├── verbal_handbook_template.md
│   │   └── verbal_token_schema.json
│   └── scripts/
│       └── token_validator.py
│
├── S7.视觉符号体系.skill/                  ← 品牌视觉体系
│   ├── SKILL.md
│   ├── references/
│   │   ├── visual-symbol-system-method.md
│   │   └── ai-image-tool-prompt-syntax.md
│   ├── templates/
│   │   └── visual_prompt_pack_schema.json
│   └── scripts/
│       ├── prompt_pack_validator.py
│       └── clip_similarity_scorer.py
│
├── S8.问答架构师.skill/                ← 问答树 + 落地页蓝图
│   ├── SKILL.md
│   ├── references/
│   │   ├── question-path-framework.md           ← 5 段问题路径框架定义
│   │   ├── qa-architecture-method.md           ← GEO 内容策略方法论
│   │   └── landing-page-anatomy.md        ← 落地页 5 大标准模块
│   ├── templates/
│   │   ├── qa_tree_schema.json            ← 问答树 JSON Schema
│   │   ├── qa_matrix_schema.json          ← 问答矩阵 JSON Schema
│   │   ├── content_calendar_schema.json   ← 内容日历 JSON Schema
│   │   └── landing_page_blueprint.md      ← 落地页蓝图 MD 模板
│   └── scripts/
│       ├── qa_matrix_validator.py
│       └── token_hit_rate_checker.py
│
├── S9.业务赋能规划师.skill/                ← S1-S8 问题总结 + GEO 业务建议 + 完整性检查
│   ├── SKILL.md
│   ├── references/
│   │   ├── enablement-framework.md        ← 问题收口与 GEO 建议框架
│   │   └── enablement-modules.md          ← GEO 行动建议体系定义
│   ├── templates/
│   │   └── enablement_package_template.md ← 赋能建议包 MD 模板
│   └── scripts/
│       ├── completeness_checker.py        ← 策略完整性检查
│       └── strategy_pack_assembler.py     ← 策略包装配
│
├── S10.品牌信息确认表生成师.skill/         ← 最终客户品牌信息确认表 XLSX（双子表）
│   ├── SKILL.md
│   ├── references/
│   │   └── confirmation_sheet_spec.md      ← 双子表结构与配色规范
│   └── scripts/
│       └── brand_info_confirmation_generator.py ← 双子表 XLSX 生成器
```

---

## 三、快速开始

### 3.1 使用方式

### 3.2 提供品牌资料

上传品牌相关资料（PDF、PPT、Word、图片、链接等均可），S1 会自动解析并构建品牌事实图谱。

### 3.3 跟随 3 个策略层暂停点

| 暂停点 | 位置 | 用户操作 |
| :--- | :--- | :--- |
| 暂停 1 | S1 完成后 | 校验品牌事实图谱，确认/修正/补充缺口 |
| 暂停 2 | S4 完成后、S5 前 | 客户自行确认 AI 监控问题、监测地域/平台，并上传 AI 可见性监测 JSON。S5 只按客户确认问题与实际上传样本分析。 |
| 暂停 3 | S9 完成后、S10 前 | 生成 `{brand}_应答逻辑确认表.xlsx`，交企业现场讨论回填；企业回填后作为 S10 子表2 的数据源。 |

### 3.4 获取策略包与品牌信息确认表

---

## 四、执行流程

```
阶段 1：品牌资产构建
  步骤 1.0  输入解析与状态检测
  步骤 1.1  S1 品牌资产知识库 → 品牌事实图谱 + 知识库 + 缺口报告
            └─[暂停 1：客户校验事实图谱]

阶段 2：市场洞察
  步骤 2.1  S2 营销图谱专家 → 营销图谱 JSON + 报告 MD（只做营销图谱分析，不生成推荐监控问题；PDF 仅在 S10 后用户确认需要时统一生成）
  步骤 2.2  S3 品类趋势研判师 → 趋势报告 + 打分卡

阶段 3：品牌定位与 AI 监测
  步骤 3.1  S4 品牌定位分析师 → 定位声明 + 分析报告
  步骤 3.2  AI 可见性监测任务下发
            └─[暂停 2：客户自行确认监控问题/地域/平台并上传 AI 监测 JSON；允许先上传部分题目/平台结果，S5 按实际样本分析]
  步骤 3.3  S5 品牌诊断专家 → 诊断数据 + Gap 报告
  步骤 3.4  S5.5 品牌语义资产审计师 → 评分卡 JSON + 审计报告

阶段 4：品牌表达体系
  步骤 4.1  S6 品牌话语体系 → 话语手册 + 话语 Token
  步骤 4.2  S7 视觉符号体系 → 视觉 Prompt 包（A/B 分支）

阶段 5：问答、赋能与应答逻辑确认表回填
  步骤 5.1  S8 问答架构师 → 问答树 + 问答矩阵 + 内容日历 + 落地页蓝图
  步骤 5.2  S9 业务赋能规划师 → S1-S8 企业问题总结 + GEO 业务建议包
  步骤 5.3  生成 `{brand}_应答逻辑确认表.xlsx` 交企业回填
            └─[暂停 3：企业回填应答逻辑确认表后才进入 S10 和策略包封装]

阶段 6：最终客户品牌信息确认表
  步骤 6.1  S10 品牌信息确认表生成师 → 读取 S1-S9 成果 + 企业已回填的应答逻辑确认表，输出 `S10_{brand}_品牌信息确认表.xlsx`（双子表）

阶段 7：收尾与策略包
  步骤 7.1  询问用户是否额外生成 S1-S9 各步骤 PDF；确认后统一检查 S1-S9 源文件并批量生成，未回复则暂停等待
  步骤 7.3  生成并深度校验仅含 S1-S9 工程资产的 strategy_pack_v{N}.json，S10 品牌信息确认表写入 client_deliverables
  步骤 7.4  输出策略层执行日志
  步骤 7.5  移交 E0（提示用户启动执行工作流）
```

---

## 五、S9 问题总结与 GEO 业务建议

S9 不再输出固定赋能板块或运营菜单。S9 的输出重点是综合 S1-S8 已经发现的企业明显问题，并把这些问题转译为 GEO 业务建议和 `recommended_business_actions` 优先行动清单。

| action_id | 行动名称 | 策略来源 | 业务目标 |
| :--- | :--- | :--- | :--- |
| `GEO_A1_entity_facts` | 实体与事实资产修复 | S1 + S4 + S5.5 | 让 AI 能准确识别企业是谁、做什么、凭什么可信 |
| `GEO_A2_ai_visibility` | AI 可见性修复 | S5 | 提升 AI 回答中的提及率、排名、情绪和推荐概率 |
| `GEO_A3_qa_assets` | 问答内容资产建设 | S2 + S6 + S8 | 用高意图问题补齐可被 AI 引用的标准答案 |
| `GEO_A4_positioning_language` | 定位与话语一致性 | S4 + S6 + S8 | 统一品牌主张、RTB 与答案表达 |
| `GEO_A5_site_schema` | 网站与结构化数据 | S1 + S8 | 让官网和落地页更适合搜索引擎与生成式引擎读取 |
| `GEO_A6_distribution_citations` | 分发与引用路径 | S5 + S8 | 布局 AI 更可能引用的第三方信源和证明页面 |

---

## 六、S10 最终品牌信息确认表

S10 是策略层在 S9 与暂停3 之后执行的最后一个客户确认节点。它读取 S1-S9 的全部成果与企业已回填的《应答逻辑确认表》，整合总结为一份《品牌信息确认表》XLSX（双子表），不再生成全景报告（全景报告已由其他 Workflow 负责）：

| 子表 | 说明 |
| :--- | :--- |
| 子表1 品牌信息确认 | 参考《品牌信息收集表》结构，汇总 S1-S9 关键品牌信息供企业逐项确认；中间设「企业填写/修改」高亮列；删除收集表末尾的"提出的问题"区段 |
| 子表2 监控问题与应答逻辑确认 | 参考《应答逻辑确认表》，来源于企业已回填的应答逻辑确认表，逐条列出监控问题、应答逻辑、备注、参考资料；中间设「企业想修改」高亮列 |

两个子表统一遵循《品牌信息收集表》紫色配色：主标题 `#4A154B`、表头 `#6B3FA0`、企业填写/修改列浅黄 `#FFFDE7`。

S10 不再承担舆情/排名分流统计（该统计已在 S5 完成并写入诊断数据）。

---

## 七、校验闸门

每个策略节点完成后，S0 会自动执行校验。不达标的节点会被打回修正（最多 2 次）。

| 节点 | 核心校验条件 |
| :--- | :--- |
| S1 | JSON 通过 schema 校验；必填缺失 ≤ 5；MD 非空；PDF 仅在 S10 后用户确认需要时统一生成 |
| S2 | 三元组 ≥ 30；场景树/问法模式完整；不得生成推荐监控问题 |
| S3 | 趋势 ≥ 8；每条 ≥ 2 信号源；含文化弱信号 |
| S4 | 4 要素齐全；差异点 ≥ 3 支撑；不与竞品重叠 |
| S5 | JSON 0 N/A；Gap 7 维齐全；信源分析齐全 |
| S6 | Tone 4 维打分；Do/Don't ≥ 10 对；JSON schema 通过 |
| S7 | B 分支：≥ 18 Prompt、6 字段齐全、色彩一致；A 分支：5 维评分齐全 |
| S8 | 5 段×≥ 5 问题；标准答案完整；落地页 5 区块 |
| S9 | S1-S8 企业问题总结完整；每个问题有证据来源；GEO 建议与 `recommended_business_actions` 行动清单齐全 |
| S10 | 品牌信息确认表 XLSX 存在且非空；含两个子表；配色遵循收集表风格；子表2 条目数与企业回填的应答逻辑确认表一致 |

---

## 八、核心设计原则

| 原则 | 说明 |
| :--- | :--- |
| **单一职责** | 每个 Skill 只负责一个策略维度，S0 只调度不生产 |
| **数据驱动** | 所有策略决策基于结构化数据，非主观判断 |
| **闸门校验** | 每个节点输出必须通过校验闸门才能传递给下游 |
| **分层输出** | 节点内 JSON/MD 源文件 + S10 品牌信息确认表 + S10 后用户确认再统一生成 S1-S9 单节点 PDF |
| **话语一致性** | S6 话语 Token 贯穿 S7/S8/S9 全部下游节点 |
| **策略-执行解耦** | 策略层不关心执行细节，执行层不关心策略推导 |
| **子文件不可跳过** | 每个 Agent 的 references/templates/scripts 包含核心知识 |

---

## 九、输出文件清单

| 序号 | 文件名 | 来源 | 格式 |
| :--- | :--- | :--- | :--- |
| 1 | `S1_{brand}_品牌事实图谱.json` | S1 | JSON |
| 2 | `S1_{brand}_品牌知识库.md` | S1 | MD |
| 3 | `S2_{brand}_营销图谱.json` | S2 | JSON |
| 4 | `S3_{brand}_趋势打分卡.json` | S3 | JSON |
| 5 | `S4_{brand}_定位声明.json` | S4 | JSON |
| 6 | `{brand}_应答逻辑确认表.xlsx` | S0（暂停3 生成） | XLSX |
| 7 | `{brand}_应答逻辑确认表_现场讨论.xlsx` | 企业回填 | XLSX |
| 8 | `S5_{brand}_品牌诊断数据.json` | S5 | JSON |
| 9 | `S5.5_{brand}_语义资产评分卡.json` | S5.5 | JSON |
| 10 | `S5.5_{brand}_语义资产审计报告.md` | S5.5 | MD |
| 11 | `S6_{brand}_话语token.json` | S6 | JSON |
| 12 | `S6_{brand}_话语手册.md` | S6 | MD |
| 13 | `S7_{brand}_视觉Prompt包.json` | S7 | JSON |
| 14 | `S8_{brand}_问答树.json` | S8 | JSON |
| 15 | `S8_{brand}_问答矩阵.json` | S8 | JSON |
| 16 | `S8_{brand}_内容日历.json` | S8 | JSON |
| 17 | `S8_{brand}_落地页蓝图.md` | S8 | MD |
| 18 | `S9_{brand}_业务赋能建议包.md` | S9 | MD |
| 19 | `S9_{brand}_策略完整性检查.md` | S9 | MD |
| 20 | `S10_{brand}_品牌信息确认表.xlsx`（双子表） | S10 | XLSX |

此外，S1-S9 每个节点先输出对应的 JSON/Markdown 源报告；S10 整合 S1-S9 与企业已回填的应答逻辑确认表，生成《品牌信息确认表》XLSX（双子表）。S1-S9 单节点客户版 PDF 在 S10 后由 S0 询问用户是否需要额外生成，只有用户确认后才统一批量生成。

---

## 十一、注意事项

1. **子文件不可跳过**：每个 Agent 的 SKILL.md 引用的 `references/`、`templates/`、`scripts/` 子文件包含核心知识，必须完整阅读后再执行。
2. **暂停点不可跳过**：3 个策略层强制暂停点必须使用 `message(type="ask")` 等待用户确认。
4. **AI 监测数据由人工抓取**：S5 所需的 AI 可见性监测数据必须由用户在各 AI 平台手动抓取后上传。
5. **打回上限**：每个节点最多打回 2 次，仍不通过则向用户报告差异并请求人工决策。

---

> **版权声明**：本工作流由 FrontMind 团队设计，仅供授权用户使用。

