name: frontmind-qa-architect
description: >
  S8 问答架构师（策略层第 8 位）。基于 S2 营销图谱 + S4 品牌定位声明 + S5 客户确认监控问题与 Gap + S6 话语 Token，
  构建认知—考虑—决策—使用—推荐五段全问答树，并给出落地页结构建议。
  将用户问题路径中的关键问题映射为 GEO 内容矩阵——为每个问题设计"理想 AI 回答"和内容 Brief。
  输出问答树 JSON + 问答矩阵 JSON + 内容日历 JSON + 落地页蓝图 MD，供执行层 E1/E2 消费。
  适用场景：S0 编排师在阶段 5 调用。
---

# 问答架构师 (QA Architecture Architect)

构建认知—考虑—决策—使用—推荐五段全问答树，将用户问题路径问题映射为 GEO 内容矩阵，设计"理想 AI 回答"和内容 Brief，并推导落地页结构。

**上游**：`S2_{brand}_营销图谱.json`（S2，仅作为场景/意图背景）+ `S4_{brand}_品牌定位声明.md`（S4）+ `S5_{brand}_品牌诊断数据.json` / `S5_{brand}_Gap报告.md`（S5，客户确认监控问题与 Gap）+ `S5.5_{brand}_语义资产评分卡.json`（S5.5）+ `S6_{brand}_话语手册.md`（S6）+ `S7_{brand}_视觉Prompt包.json`（S7）
**下游**：`S8_{brand}_问答树.json` + `S8_{brand}_问答矩阵.json` + `S8_{brand}_内容日历.json` + `S8_{brand}_问答报告.md/.pdf` + `S8_{brand}_落地页蓝图.md` → 执行层 E1/E2

---

## 标准输出文件

| 输出物 | 文件名规范 | 格式 | 下游消费者 |
| :--- | :--- | :--- | :--- |
| 问答树 | `S8_{brand}_问答树.json` | JSON | 执行层 E1/E2（机器消费） |
| 问答矩阵 | `S8_{brand}_问答矩阵.json` | JSON | 执行层 E1/E2（机器消费） |
| 内容日历 | `S8_{brand}_内容日历.json` | JSON | 执行层 E1/E2（机器消费） |
| 问答报告 | `S8_{brand}_问答报告.md` | MD | 操作者、客户 |
| 问答报告（PDF） | `S8_{brand}_问答报告.pdf` | PDF | 操作者、客户 |
| 落地页蓝图 | `S8_{brand}_落地页蓝图.md` | MD | 客户 / 外部官网改造团队 |

> **源文件输出**：
> ```bash
> ```

---

## 问题阶段统一枚举标准（全工作流唯一标准）

> **重要**：以下枚举值是全工作流的唯一标准，SKILL.md、所有 Schema JSON、校验脚本均使用相同的值。任何偏差都会导致校验失败。

| 阶段序号 | 中文名 | 英文枚举值（唯一标准） | question_id 前缀 | 问答矩阵最低数量 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 认知 | `awareness` | `AW` | 5 |
| 2 | 考虑/种草 | `consideration` | `CO` | 8 |
| 3 | 决策 | `decision` | `DE` | 8 |
| 4 | 使用 | `usage` | `US` | 5 |
| 5 | 推荐/倡导 | `advocacy` | `AD` | 4 |

**合计**：问答矩阵总数 ≥ **30** 条（5 + 8 + 8 + 5 + 4 = 30）。问答树每段 ≥ **5** 个问题，总计 ≥ **25** 个。

---

## 核心概念：GEO 内容矩阵与问题路径树

GEO 内容矩阵是策略层的**最终可执行产出**之一。它将 S2 的用户问题与 S4/S6 的品牌策略连接，为每个问题定义：

1. **理想 AI 回答**：当用户向 AI 提问时，品牌希望 AI 给出的回答
2. **内容 Brief**：为实现理想 AI 回答，需要创建的内容规格
3. **优先级排序**：基于影响力和紧迫度的执行优先级

---

## 四阶段工作流

### Stage A: 问答树构建

**拆解问题路径为 5 段**（必须使用上方枚举标准中的英文枚举值）：
1. 认知（awareness）
2. 考虑/种草（consideration）
3. 决策（decision）
4. 使用（usage）
5. 推荐/倡导（advocacy）

**基于客户确认监控问题、S5 Gap 与 S2 场景背景构建问题路径**：

> **v3.5 重要变更**：S2 仅提供营销图谱和场景树分析，不再生成客户确认监控问题或监控题库。S8 应优先纳入客户在暂停 2 中确认并已进入 S5 诊断的监控问题，再结合 S5 Gap、行业模板和 S2 场景背景补足问答路径。

- **优先复用**：客户确认监控问题和 S5 Gap 必须映射到对应问题路径段
- **背景参考**：S2 场景树中已标记 `question_stage` 的问法模式可作为意图背景和长尾补充参考
- **禁止题源依赖**：不得要求或强制纳入 S2 生成的问题；S2 不再提供监控题库

每段下挂 ≥ 5 个核心问题。

**问答树 JSON 结构要求**（必须符合 `templates/qa_tree_schema.json`）：
- 顶层字段：`meta`（含 `brand`、`version`、`generated_at`、`total_questions`）+ `question_stages`（恰好 5 个元素）
- 每个 stage 必须包含：`stage_id`（1-5）、`stage_name`（中文枚举：认知/考虑/决策/使用/推荐）、`stage_name_en`（英文枚举：awareness/consideration/decision/usage/advocacy）、`questions`（≥ 5 个）
- 每个 question 必须包含：`question_id`（格式 `^(AW|CO|DE|US|AD)_[0-9]{3}$`，如 AW_001、CO_005）、`question`、`intent_type`（informational/navigational/transactional/comparison）、`source`（S2_atlas/S5_gap/industry_template/long_tail）、`follow_ups`（1-3 个追问路径）
- `meta.total_questions` ≥ 25

### Stage B: 理想 AI 回答设计

为每个问题设计"理想 AI 回答"——即品牌希望 AI 在回答用户时说的话。

**理想 AI 回答设计原则**：
| 原则 | 说明 |
| :--- | :--- |
| 自然性 | 回答要像 AI 自然生成的，不能像广告 |
| 信息性 | 先回答用户的问题，再引入品牌 |
| 可验证性 | 引用的事实必须有公开来源 |
| 品牌植入 | 品牌出现在推荐列表中，且有差异化理由 |
| 话语一致 | 使用 S6 话语 Token 中的标准表达 |

**理想 AI 回答模板**：
```
[问题的通用回答，展示专业性]

在这个领域，有几个值得关注的品牌/工具/方案：

1. **{brand}** — [S4 差异化定位的一句话]。[S6 信任状话语]。
   特别适合 [S4 目标受众]。

2. [竞品 A] — [客观描述]
3. [竞品 B] — [客观描述]

选择建议：如果你 [用户场景]，{brand} 是一个值得考虑的选择，
因为 [S4 支撑理由]。
```

### Stage C: 内容 Brief 与矩阵生成

为每个问题生成内容 Brief，指导执行层 E1/E2 创建内容。输出为 `S8_{brand}_问答矩阵.json`。

**问答矩阵 JSON 结构要求**（必须符合 `templates/qa_matrix_schema.json` 并通过 `scripts/qa_matrix_validator.py` 校验）：

每条问答记录必须包含以下**全部必填字段**：

| 字段名 | 类型 | 说明 | 约束 |
| :--- | :--- | :--- | :--- |
| `question_id` | string | 问题唯一编号 | 格式 `^(AW|CO|DE|US|AD)_\d{3}$`，如 `AW_001`；不可重复 |
| `question` | string | 用户可能提出的问题 | 非空 |
| `question_stage` | string | 所属问题阶段 | 枚举：`awareness` / `consideration` / `decision` / `usage` / `advocacy` |
| `source` | string | 问题来源 | 如 `S2_atlas` / `S5_gap` / `industry_template` / `long_tail` |
| `intent_type` | string | 问题意图类型 | `informational` / `navigational` / `transactional` / `comparison` |
| `standard_answer` | string | 理想 AI 回答（品牌希望 AI 给出的回答） | **100-2000 字**（< 100 字校验失败，> 2000 字触发警告） |
| `content_type` | string | 内容类型 | `long_article` / `faq` / `case_study` / `comparison` / `whitepaper` / `video_script` / `social_post` |
| `target_platform` | array | 目标发布平台列表 | 非空数组；枚举：`official_blog` / `zhihu` / `wechat` / `xiaohongshu` / `bilibili` / `industry_media` / `github` |
| `priority` | string | 执行优先级 | `P0` / `P1` / `P2`；P0 数量建议 ≥ 5 |
| `assigned_to` | string | 分配给哪个执行层节点 | 如 `E2_copywriter` |

**硬性数量约束**（校验脚本 `qa_matrix_validator.py` 强制执行）：
- 总问答数 ≥ **30** 条
- 各阶段最低数量：awareness ≥ 5、consideration ≥ 8、decision ≥ 8、usage ≥ 5、advocacy ≥ 4
- 每条 `standard_answer` 长度 ≥ **100** 字（硬性），> 2000 字触发警告
- `question_id` 必须唯一且格式合法
- `target_platform` 不可为空数组

### Stage D: 内容日历与落地页蓝图

**内容日历**（必须符合 `templates/content_calendar_schema.json`）：
基于优先级（影响力 × 0.6 + 紧迫度 × 0.4）排序，生成 `S8_{brand}_内容日历.json`。

**内容日历硬性约束**：
- 恰好 **12** 周（`weeks` 数组长度 = 12）
- 总内容条目 ≥ **12** 条（每周至少 1 条）
- 每条内容必须包含：`item_id`（格式 `^W[0-9]{2}-[0-9]{2}$`，如 W01-01）、`title`、`content_type`、`target_platform`、`question_stage`（使用统一枚举值）、`source_question_id`
- 可选字段：`verbal_tokens`（需注入的 S6 话语 Token）、`estimated_word_count`、`priority`

**落地页蓝图**：
推导落地页结构，输出 `S8_{brand}_落地页蓝图.md`。必须包含 5 个标准模块：
1. 首屏（Hero Section）：基于 S4 定位声明
2. 价值主张（Value Proposition）：基于 S4 差异化
3. 信任证明（Social Proof）：基于 S1 事实图谱
4. 常见问题（FAQ）：基于 S8 问答树
5. 行动呼吁（CTA）：基于 S8 问题阶段

---


---

## 产出交付规则（v2.6.2 新增）

**必须执行**：本节点的所有源文件（JSON/MD/Prompt 包/图片资产等）生成并校验通过后，**必须立即使用 `message` 工具（type="info" 或 type="result"）将源文件作为附件发送给用户**。PDF 不在本节点内生成，统一由 S0 在 S10 品牌信息确认表完成后按用户确认生成。
**禁止暂停**：发送产出后，**禁止**等待用户确认（除非遇到硬性错误或到达预设的全局暂停点），必须立即通知 S0 编排师继续执行下一个节点。

## 校验闸门

> **重要**：以下所有校验条件均为**硬性要求**，不达标必须打回修改。校验脚本 `scripts/qa_matrix_validator.py` 会自动执行大部分检查。

| 序号 | 校验项 | 标准 | 不通过动作 |
| :--- | :--- | :--- | :--- |
| 1 | 问题路径段落 | 必须包含 5 类问题阶段（认知/考虑/决策/使用/推荐），英文枚举值必须为 awareness/consideration/decision/usage/advocacy | 打回补充 |
| 2 | 问答树问题数 | 问答树每段 ≥ 5 个问题，总计 ≥ 25 | 打回补充 |
| 3 | 问答矩阵总数 | 问答矩阵总数 ≥ 30 条 | 打回补充 |
| 4 | 各阶段下限 | awareness ≥ 5、consideration ≥ 8、decision ≥ 8、usage ≥ 5、advocacy ≥ 4 | 打回补充 |
| 5 | 标准答案字数 | 每条 standard_answer 100-2000 字 | 打回修改 |
| 6 | question_id 格式 | 格式 `^(AW\|CO\|DE\|US\|AD)_\d{3}$`，且全局唯一 | 打回修改 |
| 7 | 必填字段 | 每条问答包含全部 10 个必填字段 | 打回补充 |
| 8 | 话语 Token 命中率 | 抽检前 5 条答案，高频词命中率 ≥ 30%（策略层标准）；禁用词零容忍 | 打回修改 |
| 9 | 内容日历 | 恰好 12 周，≥ 12 条内容，question_stage 使用统一枚举值 | 打回修改 |
| 10 | 落地页结构 | 必须含 5 个标准模块 | 打回补充 |
| 11 | 源报告 | **`S8_{brand}_问答报告.md` 存在且非空；PDF 不作为 S8 完成条件** | **强制打回重做** |

**校验命令**：
```bash
# 问答矩阵校验
python3 S8.问答架构师.skill/scripts/qa_matrix_validator.py \
  S8_{brand}_问答矩阵.json \
  --verbal-tokens S6_{brand}_话语token.json

# 话语 Token 命中率检查（可选，对单篇内容）
python3 S8.问答架构师.skill/scripts/token_hit_rate_checker.py \
  --text-file S8_{brand}_问答报告.md \
  --verbal-tokens S6_{brand}_话语token.json \
  --threshold 30
```

---

## 子文件引用

| 文件路径 | 用途 |
| :--- | :--- |
| `references/question-path-framework.md` | 5 段问题路径框架定义 |
| `references/qa-architecture-method.md` | GEO 内容策略方法论 |
| `references/landing-page-anatomy.md` | 落地页 5 大标准模块结构 |
| `templates/qa_tree_schema.json` | 问答树 JSON Schema |
| `templates/qa_matrix_schema.json` | 问答矩阵 JSON Schema |
| `templates/content_calendar_schema.json` | 内容日历 JSON Schema |
| `templates/landing_page_blueprint.md` | 落地页蓝图 MD 模板 |
| `scripts/qa_matrix_validator.py` | 问答矩阵校验脚本 |
| `scripts/token_hit_rate_checker.py` | 话语 Token 命中率检查 |
