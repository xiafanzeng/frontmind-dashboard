---
name: frontmind-brand-diagnostician
description: >
  S5 品牌诊断专家（策略层第 5 位 / AI 可见性诊断中心）。用 AI 平台真实回答与 S4 定位
  对标，输出 7 维诊断报告、Gap 报告和信源分析数据。
  适用场景：当用户上传 AI 平台可见性监测 JSON 后触发（暂停2 恢复后）。
---

# 品牌诊断专家 (Brand Diagnostician)

用 AI 平台真实回答与 S4 定位声明对标，输出 **7 维诊断报告**、**Gap 报告**、**信源分析数据**和 **AI 排名位次诊断数据**，揭示品牌在 AI 搜索中的真实表现、出现位次与理想定位之间的差距，并为 S5.5 语义资产评分和执行层 E5 分发编排师提供核心数据依据。

**上游**：AI 可见性监测 JSON（用户上传）+ 客户在暂停 2 确认的监控问题/地域/平台 + `S4_{brand}_定位声明.json`（S4）
**下游**：`S5_{brand}_品牌诊断数据.json` + `S5_{brand}_品牌诊断数据.md` （PDF 由 S0 统一生成） + `S5_{brand}_Gap报告.md` → S5.5 语义资产审计、S6 品牌话语体系、S7 视觉符号体系、S8 问答架构师、S9 业务赋能规划师、**E5 分发编排师**；全景报告已由其他 Workflow 负责，策略层不再生成全景 HTML/PDF；S5 诊断结论会被 S10 品牌信息确认表与执行层引用。

---

## 标准输入输出文件

**输入文件**：

| 输入项 | 文件名规范 | 来源 | 必要性 |
| :--- | :--- | :--- | :--- |
| AI 可见性监测 JSON | `{brand}_AI可见性监测数据.json` | 用户上传（必须对应客户在暂停 2 自行确认的监控问题；也允许只上传已完成的部分题目/部分平台数据） | **必须；按实际样本分析** |
| 定位声明 | `S4_{brand}_定位声明.json` | S4 | **必须** |
| 品牌事实图谱 | `S1_{brand}_品牌事实图谱.json` | S1 | 建议 |

**输出文件**：

| 输出物 | 文件名规范 | 格式 | 下游消费者 |
| :--- | :--- | :--- | :--- |
| 诊断数据 | `S5_{brand}_品牌诊断数据.json` | JSON | **S5.5**/S6/S8/S9/**E5** |
| 诊断报告（MD） | `S5_{brand}_品牌诊断数据.md` | Markdown | S6/S9/**E5** |
| 诊断报告（PDF） | `S5_{brand}_品牌诊断数据.pdf` | PDF | 操作者、客户 |
| Gap 报告 | `S5_{brand}_Gap报告.md` | Markdown | S6/S7/S8/S9 |

> **数据优先输出**：S5 只负责生成可被下游消费的诊断数据 JSON、诊断 Markdown 与 Gap 报告；PDF 与最终 HTML 均不在 S5 内生成。

---

## 绝对禁止事项

1. **禁止编造监测数据**：所有诊断数据必须来自用户上传的 AI 监测 JSON，不得凭空编造 AI 平台的回答。
2. **禁止跳过 Gap 分析**：必须将 AI 实际呈现与 S4 定位声明逐维对标，不得省略。
3. **禁止输出不完整的 7 维诊断**：7 个维度必须全部有评分和分析，不得留空。
4. **禁止跳过信源分析**：必须从监测数据中提取信源域名频次统计和高频信源，不得省略。若实际样本不足 Top 10 或无可解析信源，必须按实际数量输出并说明原因；不得为了凑数编造信源。此数据是 E5 分发编排师渠道选择的第一优先级输入。
5. **禁止把排名位次留到 S5.5 才计算**：必须在 S5 `S5_{brand}_品牌诊断数据.json` 顶层生成 `ranking_position_diagnostics`，S5.5 只能优先复用该字段进行语义资产评分解释。
6. **禁止从 S2 生成或推导监控问题**：S2 只提供营销图谱和意图背景。S5 不得读取 `S2.probes`、`is_probe`、`representative_questions`、`recommended_questions` 等字段作为题源；若历史文件中存在这些字段，也必须忽略。
7. **禁止因样本未跑满而判定“数据不完全”**：S5 的诊断口径是“按实际上传样本分析”，也就是用户上传了多少有效 AI 回答，就基于多少有效回答进行分析。问题数量较少、未覆盖 3 个以上平台、信源不足 10 条或竞品缺口矩阵为空，均只能作为“样本覆盖限制”写入报告，不能作为打回理由；只有完全没有有效回答、文件不可解析、或关键字段缺失到无法判断单条回答时，才可要求用户补传。

---

## 核心要求：思维链（CoT）与诊断深度

在执行品牌诊断时，必须在思考过程中显式输出以下思维链（CoT）：
1. **数据异常点识别**：识别监测数据中与常识或 S1 事实图谱严重不符的"幻觉"或"偏见"。
2. **平台差异归因**：分析为什么不同 AI 平台（如 ChatGPT vs Claude）对同一问题的回答存在显著差异（如训练数据截止时间、模型偏好）。
3. **Gap 根因剖析**：不仅要指出 AI 实际呈现与 S4 定位的偏差，还要推测造成这种偏差的根本原因（如官网信息陈旧、竞品公关声量过大）。
4. **信源模式识别**：分析各 AI 平台引用信源的共性与差异，识别跨平台高频信源和平台特有信源偏好。

---

## 核心概念：7 维诊断指标体系

> **详细指标定义**：参见 `references/diagnosis-metrics.md`。

### 7 维概览

| 维度 | 编号 | 定义 | 数据来源 | 评分标准 |
| :--- | :--- | :--- | :--- | :--- |
| AI 可见度 | D1 | 品牌在 AI 回答中被提及的频率和位置 | 监测 JSON | 0-100 |
| 语义准确度 | D2 | AI 描述的品牌信息与事实图谱的一致性 | 监测 JSON + S1 | 0-100 |
| E-E-A-T 信号 | D3 | AI 回答中体现的经验/专业/权威/可信度 | 监测 JSON | 0-100 |
| 竞品对比 | D4 | 品牌与竞品在 AI 回答中的相对位置 | 监测 JSON | 0-100 |
| 用户意图覆盖 | D5 | AI 回答覆盖客户确认监控问题意图的完整度 | 监测 JSON | 0-100 |
| 负面舆情 | D6 | AI 回答中负面信息的出现频率和严重度 | 监测 JSON | 0-100（越高越好） |
| 定位 Gap | D7 | AI 实际呈现与 S4 理想定位的偏差程度 | 监测 JSON + S4 | 0-100（越高越好） |

> **S5.5 前置数据要求**：除 7 维评分外，S5 必须把 AI 回答中的品牌出现位次结构化为 `ranking_position_diagnostics`。该对象不是 S5.5 的补采结果，而是 S5 从用户上传监测 JSON 的 `responses[].answers.*.position` 与竞品位次解析中生成的标准上游数据。

### 综合评级

| 综合分 | 等级 | 含义 |
| :--- | :--- | :--- |
| 90-100 | A+ | AI 可见性卓越，定位传达精准 |
| 80-89 | A | AI 可见性优秀，少量偏差 |
| 70-79 | B | AI 可见性良好，有明显改进空间 |
| 60-69 | C | AI 可见性一般，需要系统性优化 |
| 0-59 | D | AI 可见性差，需要全面重建 |

---

## 工作流程

### Step 1：解析监测 JSON、识别实际样本范围与地域口径

从用户上传的 AI 监测 JSON 中提取数据，并先生成 `sample_scope` 说明：实际覆盖多少个客户确认问题、多少个平台、多少条有效回答、覆盖哪些地域平台、样本覆盖限制是什么。**S5 不以固定题量或至少 3 个平台作为完成条件，而是按用户已经上传的有效数据即时诊断**。

地域校验只用于解释样本适用范围，不用于机械打回：
- **海外市场**：优先识别 ChatGPT、Claude、Gemini、Perplexity 等海外平台；若实际只上传 1-2 个海外平台，也必须继续分析，并在报告中标注“海外样本覆盖有限”。
- **国内市场**：优先识别 DeepSeek、文心一言、Kimi、豆包 等国内平台；若实际只上传 1-2 个国内平台，也必须继续分析，并在报告中标注“国内样本覆盖有限”。
- **全球双市场**：若只上传单一区域平台，必须继续分析已上传区域，并说明当前结论不能代表另一市场。

仅当上传数据与用户声明市场完全无关、或 JSON 中不存在任何有效回答时，才要求用户重新上传。

按问题/平台/品牌三个维度切片：

```python
# 伪代码：解析监测 JSON
with open(f"{brand}_AI可见性监测数据.json", "r") as f:
    monitoring = json.load(f)

platforms = monitoring["platforms"]  # ["chatgpt", "claude", "perplexity", ...]
responses = monitoring["responses"]  # 实际上传的回答数据；来自客户确认的监控问题，可为部分题目/部分平台样本

# 按问题切片
for resp in responses:
    question_id = resp["question_id"]
    for platform, answer in resp["answers"].items():
        mentioned = answer["mentioned"]      # 品牌是否被提及
        position = answer["position"]        # 提及位置（1-5名）
        sentiment = answer["sentiment"]      # 情感倾向
        text = answer["text"]                # 完整回答文本
        sources = answer.get("sources", [])  # 引用信源列表（URL/域名）
```

数据可用性检查：
- 必须至少包含 1 条可解析的 AI 回答；这是唯一的最小样本硬门槛。
- `question_count`、`platform_count` 与 `response_count` 均按实际上传数据计算，不得用 S2 规划题量倒推填充。
- 允许只包含部分客户确认问题，允许只包含 1-2 个平台；未覆盖部分应写入 `meta.sample_scope.coverage_limitations` 与 MD 报告的“样本覆盖说明”。
- 每个有效回答优先包含 `mentioned`、`position`、`sentiment`、`text` 四个字段；若部分字段缺失，应尽量从文本推断或置为 `null`/`unknown` 并标注，不得因为少量字段缺失整体判定失败。
- 每个回答应包含 `sources` 字段（引用信源列表）；若监测 JSON 未提供此字段，则从 `text` 中提取引用标注。若仍无可用信源，则 `citation_sources` 可按空数组输出，并在报告中说明“当前样本未提供可解析信源”。

---

### Step 2：信源提取与频次统计（★ 核心步骤 — E5 渠道选择的第一优先级输入）

> **本步骤产出是 E5 分发编排师渠道选择的第一优先级输入，绝对禁止跳过。**
> 详细方法论参见 `references/citation-intelligence.md`。

#### 2.1 信源提取

从各 AI 平台回答中提取被引用的信源 URL 和媒体名称。AI 平台回答中的信源通常以以下形式出现：

| 标注形式 | 示例 | 提取方法 |
| :--- | :--- | :--- |
| 脚注链接 | `[1] https://example.com/article` | 直接提取 URL |
| 行内引用 | `据XX网报道...` | 提取媒体名称 |
| 参考来源列表 | `参考来源：XX网、YY号` | 逐条提取 |
| 蓝色超链接 | 可点击的品牌/媒体链接 | 提取链接目标 |
| 来源标签 | `来源：百家号/XX作者` | 提取平台+作者 |

#### 2.2 域名归一化

将提取的信源统一到域名级别：

| 原始 URL 示例 | 归一化域名 |
| :--- | :--- |
| `baijiahao.baidu.com/xxx` | 百家号 |
| `zhuanlan.zhihu.com/xxx` | 知乎专栏 |
| `mp.weixin.qq.com/xxx` | 微信公众号 |
| `www.sohu.com/a/xxx` | 搜狐 |
| `www.163.com/dy/xxx` | 网易 |
| `www.bilibili.com/read/xxx` | B站图文 |
| `www.toutiao.com/xxx` | 今日头条 |
| `maimai.cn/xxx` | 脉脉 |
| `news.qq.com/xxx` | 腾讯新闻 |

#### 2.3 频次统计

对每个归一化后的信源域名，统计以下维度：

1. **绝对引用频次**：在所有 AI 回答中被引用的总次数
2. **平台覆盖率**：被多少个不同 AI 平台引用（/总平台数）
3. **问题覆盖率**：在多少个不同问题的回答中被引用
4. **引用位置权重**：排在引用列表前 3 位的次数
5. **竞品共现率**：与竞品内容同时出现在同一回答中的比例

综合评分公式：

```
信源价值分 = 绝对频次 × 0.3 + 平台覆盖率 × 0.25 + 问题覆盖率 × 0.2
            + 引用位置权重 × 0.15 + (1 - 竞品共现率) × 0.1
```

#### 2.4 高频信源深度访问与类型判定（关键）

筛选出信源价值分最高的具体 URL，最多 Top 10；若实际样本中可解析信源不足 10 条，则按实际数量全部分析，不得为了凑满 Top 10 而编造信源。对可访问网页，**使用浏览器实际访问这些网页**，分析其实际内容，将其精准分类到 A-F 内容类型：

| 类型代码 | 类型名称 | 定义 | 典型特征 |
| :--- | :--- | :--- | :--- |
| A | GEO 文章 | 专为 AI 搜索优化的深度内容 | 结构化标题、数据引用、Q&A 格式 |
| B | 权威长内容 | 行业报告、白皮书、深度评测 | 长篇幅、专业术语、数据图表 |
| C | 媒体公关 | 新闻稿、品牌报道 | 新闻体裁、品牌正面叙事 |
| D | 社交媒体 | 社区讨论、用户评价 | UGC 内容、多方观点 |
| E | 官网内容 | 品牌官方网站页面 | 产品介绍、公司信息 |
| F | 多媒体 | 视频转录、音频内容 | 视频/音频的文字版本 |

对每个高频信源，记录：
- 具体 URL
- 归一化域名
- 媒体名称
- A-F 内容类型
- 引用频次
- 内容结构特征摘要（50-100 字）

#### 2.5 竞品信源缺口矩阵

标记竞品已占位但本品牌缺失的信源：

| 信源平台 | 本品牌覆盖 | 竞品A覆盖 | 竞品B覆盖 | 缺口优先级 |
| :--- | :--- | :--- | :--- | :--- |
| (逐行填写) | 有/无 | 有/无 | 有/无 | 高/中/低 |

缺口优先级判定：
- **高**：竞品已覆盖 + 高权值信源 + 高引用频次
- **中**：竞品已覆盖 + 中权值信源，或未覆盖 + 高权值信源
- **低**：双方均未覆盖，或低权值信源

---

### Step 2.6：构建 AI 排名位次诊断矩阵（S5→S5.5 强制数据层）

> **逻辑原则**：S5 负责回答“品牌是否出现、出现在哪一位、相对竞品领先还是落后”；S5.5 负责在此基础上回答“这些位次表现说明语义资产质量有多强”。因此，排名位次诊断必须在 S5 产出，而不是等到 S5.5 再临时补采。

> **舆情分流原则**：凡题干属于“某品牌有什么缺点/问题/不足/负面/投诉/口碑/风险/靠谱吗”等直接点名品牌的舆情类问题，**舆情类题目不参与可见度与排名计算**，也即不得纳入 D1 AI 可见度、平均位次、Top3/Top5、竞品排名差或品牌排名矩阵的评分口径。这类问题中品牌出现通常是题干指定导致的自然出现，可见度接近 100%，若继续计算可见度会高估品牌 GEO 表现。S5 必须把这类样本标记为 `question_type="reputation_issue"`、`ranking_metric_eligible=false`，并转入 `reputation_issue_diagnostics` 诊断负面认知、问题归因、舆情风险与回应建议。

从 AI 监测 JSON 的 `responses[].answers.{platform}.position` 字段逐题逐平台生成 `ranking_position_diagnostics` 顶层对象。若监测 JSON 同时提供 `competitor_ranks`、`competitor_positions` 或可从回答文本中识别竞品排列，则必须记录最强竞品位次并计算 `rank_gap = brand_rank - top_competitor_rank`，其中正值代表品牌落后。计算排名指标时必须先排除 `ranking_metric_eligible=false` 的舆情类样本；被排除样本仍保留在矩阵中供追溯，但不得进入排名分母。

| 聚合指标 | 计算口径 | 诊断意义 |
| :--- | :--- | :--- |
| `avg_rank` | 有效品牌位次均值 | 判断品牌被提及时平均排在第几位 |
| `first_place_rate` | 第 1 位样本数 ÷ 实际有效观测数 | 衡量首位心智占位 |
| `top3_rate` | Top3 样本数 ÷ 实际有效观测数 | 衡量高注意力区占位 |
| `top5_rate` | Top5 样本数 ÷ 实际有效观测数 | 衡量可见答案区占位 |
| `rank_distribution` | 第 1、2-3、4-5、6-10、11+ / 未提及分桶 | 识别位次结构是否健康 |
| `competitor_rank_gap` | 品牌平均位次 - 最强竞品平均位次 | 正值代表品牌落后竞品，负值代表领先 |
| `platform_breakdown` | 各平台 citation_rate、avg_rank、Top3/Top5 | 识别平台差异与修复优先级 |
| `per_question_rank_matrix` | 问题 × 平台级矩阵 | 为 S5.5、S8 和 E1 提供题级修复抓手 |

生成矩阵时必须包含：`question_id`、`question`、`platform`、`question_type`、`ranking_metric_eligible`、`ranking_exclusion_reason`、`brand_mentioned`、`brand_rank`、`competitor_ranks`、`top_competitor`、`top_competitor_rank`、`rank_gap`、`rank_bucket` 与 `diagnosis`。矩阵行数等于实际上传的“问题 × 平台”有效观测数，不要求达到任何固定题量；其中舆情类样本可出现在矩阵中，但必须标记为 `ranking_metric_eligible=false`，并说明“不参与可见度和排名分析”。可直接调用 `scripts/ranking_position_calculator.py` 从 AI 监测 JSON 生成该对象，并写入 `S5_{brand}_品牌诊断数据.json` 顶层。

---

### Step 3：计算 4 个核心指标

**指标 1：AI 引用率（Citation Rate）**

```
AI 引用率 = 品牌被提及的回答数 / 总回答数 × 100%
```

按平台分别计算，再取加权平均（权重按平台用户量分配）。

**指标 2：提及位次（Mention Position）**

```
平均位次 = Σ(品牌在每个回答中的位置) / 被提及的回答数
```

位次越靠前越好，第 1 位 = 100 分，第 5 位 = 20 分。

**指标 3：情感倾向（Sentiment Score）**

```
情感分 = (正面回答数 × 1 + 中性回答数 × 0.5 + 负面回答数 × 0) / 总回答数 × 100
```

**指标 4：事实正确率（Fact Accuracy）**

将 AI 回答中的品牌描述与 S1 事实图谱对比，计算正确率：

```
事实正确率 = 正确描述数 / 总描述数 × 100%
```

### Step 4：7 维诊断评分

**D1 AI 可见度**：基于 AI 引用率和提及位次的加权分。D1 只统计泛品类推荐、供应商推荐、品牌对比、方案选择等可排名问题；直接点名品牌的负面/舆情类问题必须从 D1 分母和位次计算中排除。

```
D1 = AI引用率 × 0.6 + 位次得分 × 0.4
```

**D2 语义准确度**：基于事实正确率和信息完整度。

```
D2 = 事实正确率 × 0.7 + 信息完整度 × 0.3
```

信息完整度 = AI 回答中包含的品牌关键信息数 / S1 事实图谱中的关键信息总数。

**D3 E-E-A-T 信号**：评估 AI 回答中是否体现了品牌的经验、专业性、权威性和可信度。

| 子维度 | 评估标准 | 权重 |
| :--- | :--- | :--- |
| Experience | AI 是否提及品牌的实际案例/经验 | 25% |
| Expertise | AI 是否提及品牌的专业资质/技术 | 25% |
| Authoritativeness | AI 是否将品牌描述为行业权威 | 25% |
| Trustworthiness | AI 是否引用可信来源支撑品牌描述 | 25% |

**D4 竞品对比**：品牌与竞品在 AI 回答中的相对位置。

```
D4 = (品牌优于竞品的回答数 / 含竞品对比的回答数) × 100
```

**D5 用户意图覆盖**：AI 回答覆盖 S2 营销图谱中用户意图的完整度。

```
D5 = (AI回答覆盖的意图类型数 / S2定义的意图类型总数) × 100
```

**D6 负面舆情**：AI 回答中负面信息的处理情况。D6 是负面/舆情类问题的主要承接指标，必须优先读取 `reputation_issue_diagnostics`，分析 AI 对品牌缺点、投诉、口碑、风险与争议的呈现方式。

```
D6 = 100 - (负面舆情回答数 / 实际上传的舆情类问题回答数) × 100
# 若本轮无舆情类问题，则 D6 改用全样本负面回答占比，并在样本说明中注明口径
```

**D7 定位 Gap**：AI 实际呈现与 S4 理想定位的匹配度。

> **Gap 计算详细方法**：参见 `scripts/gap_calculator.py`。

### Step 5：定位 Gap 深度分析

将 S4 定位声明的四要素与 AI 实际呈现逐项对标：

| Gap 维度 | 理想状态（S4） | AI 实际呈现 | 偏差描述 | 修复优先级 |
| :--- | :--- | :--- | :--- | :--- |
| 目标人群 | {S4 定义的人群} | AI 回答中隐含的受众 | {偏差} | {高/中/低} |
| 品类归属 | {S4 定义的品类} | AI 将品牌归入的品类 | {偏差} | {高/中/低} |
| 差异化价值点 | {S4 定义的差异点} | AI 描述的品牌特点 | {偏差} | {高/中/低} |
| 功能价值 | {S4 功能价值} | AI 提及的功能 | {偏差} | {高/中/低} |
| 情感价值 | {S4 情感价值} | AI 传达的情感 | {偏差} | {高/中/低} |
| 证据支撑 | {S4 列出的证据} | AI 引用的证据 | {偏差} | {高/中/低} |
| 话语一致性 | {S6 话语基准} | AI 使用的描述用词 | {偏差} | {高/中/低} |

每个 Gap 维度必须输出：
- 理想状态描述
- AI 实际呈现描述
- 偏差程度（0-100，0=完全一致，100=完全偏离）
- 修复建议（具体行动项）
- 修复优先级（高/中/低）

### Step 6：生成诊断数据 JSON

按 `templates/diagnosis_data_schema.json` 组装完整诊断数据：

```json
{
  "meta": {
    "brand": "{brand}",
    "diagnosed_at": "2026-04-27",
    "platforms": ["chatgpt", "claude"],
    "question_count": 2,
    "platform_count": 2,
    "response_count": 4,
    "planned_question_count": 2,
    "is_partial_sample": true,
    "sample_scope": {
      "analysis_basis": "按用户实际上传的 2 个问题 × 2 个平台样本分析；问题数量较少不构成失败",
      "coverage_limitations": ["当前仅代表已上传问题和平台的 AI 可见性表现", "未覆盖题目不得被推断为已监测"]
    }
  },
  "core_metrics": {
    "citation_rate": 73.3,
    "avg_position": 2.4,
    "sentiment_score": 82.0,
    "fact_accuracy": 88.5
  },
  "ranking_position_diagnostics": {
    "data_source": "客户确认监控问题的 AI 监测 JSON responses[].answers.*.position 与竞品位次解析；负面/舆情类问题已排除出排名指标",
    "total_observations": 3,
    "total_raw_observations": 4,
    "ranking_metric_observations": 3,
    "excluded_reputation_observations": 1,
    "ranked_observations": 2,
    "unmentioned_observations": 1,
    "avg_rank": 2.4,
    "first_place_rate": 0.18,
    "top3_rate": 0.62,
    "top5_rate": 0.73,
    "best_rank": 1,
    "worst_rank": 6,
    "rank_distribution": {"rank_1": 8, "rank_2_3": 20, "rank_4_5": 5, "rank_6_10": 0, "rank_11_plus": 12},
    "competitor_rank_gap": 0.8,
    "platform_breakdown": {
      "chatgpt": {"response_count": 15, "mentioned_count": 12, "citation_rate": 0.8, "avg_rank": 2.1, "top3_rate": 0.67, "top5_rate": 0.8}
    },
    "per_question_rank_matrix": [
      {"question_id": "TOPIC-01-SC01-V01", "question": "...", "platform": "chatgpt", "question_type": "ranking_visibility", "ranking_metric_eligible": true, "ranking_exclusion_reason": "", "brand_mentioned": true, "brand_rank": 2, "competitor_ranks": {"竞品A": 1}, "top_competitor": "竞品A", "top_competitor_rank": 1, "rank_gap": 1, "rank_bucket": "rank_2_3", "diagnosis": "品牌落后最强竞品 1 位，应补强该问题下的信源覆盖。"},
      {"question_id": "TOPIC-02-REP01", "question": "武汉曜华激光科技有限公司有什么缺点和问题", "platform": "chatgpt", "question_type": "reputation_issue", "ranking_metric_eligible": false, "ranking_exclusion_reason": "题干询问品牌缺点、问题、口碑、投诉或风险，属于舆情/认知风险诊断，不参与 D1 可见度、平均位次或 Top3/Top5 计算。", "brand_mentioned": true, "brand_rank": 1, "competitor_ranks": {}, "top_competitor": null, "top_competitor_rank": null, "rank_gap": null, "rank_bucket": "rank_1", "diagnosis": "不参与可见度和排名分析；转入 reputation_issue_diagnostics。"}
    ],
    "reputation_issue_diagnostics": {
      "data_source": "从被识别为负面/舆情/口碑/缺点/问题类的题目中生成；不参与 D1 可见度或排名评分",
      "total_observations": 1,
      "question_count": 1,
      "platform_breakdown": {
        "chatgpt": {"response_count": 1, "positive_count": 0, "neutral_count": 0, "negative_count": 1, "unknown_count": 0, "severity_distribution": {"high": 0, "medium": 1, "low": 0}}
      },
      "per_question_issue_matrix": [
        {"question_id": "TOPIC-02-REP01", "question": "武汉曜华激光科技有限公司有什么缺点和问题", "platform": "chatgpt", "brand_mentioned": true, "sentiment": "negative", "severity": "medium", "issue_summary": "AI 回答集中提到售后、交付或公开信息不足等问题。", "recommended_response": "补充官网 FAQ、案例证据、售后/质量说明与第三方评价材料，降低 AI 对单一负面信源的依赖。"}
      ]
    }
  },
  "seven_dimensions": {
    "D1_visibility": { "score": 75, "details": "..." },
    "D2_accuracy": { "score": 88, "details": "..." },
    "D3_eeat": { "score": 65, "details": "..." },
    "D4_competitive": { "score": 70, "details": "..." },
    "D5_intent_coverage": { "score": 80, "details": "..." },
    "D6_negative": { "score": 85, "details": "..." },
    "D7_positioning_gap": { "score": 60, "details": "..." }
  },
  "overall": {
    "score": 74.7,
    "grade": "B",
    "summary": "..."
  },
  "citation_sources": {
    "domain_frequency": [
      {
        "domain": "搜狐",
        "frequency": 18,
        "platform_coverage": 4,
        "question_coverage": 8,
        "position_weight": 12,
        "competitor_cooccurrence": 0.3,
        "value_score": 78.5
      }
    ],
    "top_sources": [
      {
        "url": "https://www.sohu.com/a/xxx",
        "domain": "搜狐",
        "media_name": "搜狐科技",
        "content_type": "C",
        "frequency": 8,
        "content_features": "新闻稿体裁，品牌正面叙事，含数据引用和行业背景..."
      }
    ],
    "competitor_gap_matrix": [
      {
        "platform": "知乎专栏",
        "brand_covered": false,
        "competitors_covered": ["竞品A", "竞品B"],
        "gap_priority": "high"
      }
    ]
  },
  "platform_details": { ... },
  "gap_analysis": [ ... ],
  "recommendations": [ ... ]
}
```

### Step 7：生成 Markdown 诊断报告（强制要求；PDF 由 S0 仅在 S10 品牌信息确认表完成后用户确认需要时统一生成）

> **重要变更**：S5 不再生成单独的 HTML 页面。原因是 S5 仅覆盖 AI 可见性诊断，只产出诊断数据 JSON、诊断 Markdown 与 Gap 报告。全景报告已由其他 Workflow 负责，策略层不再生成全景 HTML/PDF；S5 诊断结论会被 S10 品牌信息确认表与执行层引用。

MD 报告必须包含以下章节（供 E5 分发编排师消费）：

1. 各平台可见度评分与核心指标
2. 7 维诊断评分与分析
3. **AI 排名位次诊断**：平均位次、首位率、Top3/Top5、排名分布、竞品位次差、平台差异与实际样本的问题级排名矩阵（供 S5.5 直接评分复用）；必须明确说明已排除的舆情类问题数量，避免把品牌被点名的问题误读为可见度优势
4. **舆情问题诊断**：对 `reputation_issue_diagnostics` 中的缺点、问题、投诉、口碑、风险类样本进行负面认知归因、严重度判断、证据缺口与回应建议分析
5. 定位 Gap 分析
6. **信源域名频次统计**：各平台引用的域名列表、频次及平台覆盖情况（供 E5 分发编排师制定媒体矩阵）
7. **高频/标杆信源深度解析**：按实际可解析信源数量输出，包含具体 URL、媒体名称、A-F 内容类型、内容结构特征（供 E1 内容策略师逆向工程）
8. **竞品信源缺口矩阵**：标记竞品已占位但本品牌缺失的信源及优先级（供 E5 竞品补位决策）
9. 修复建议与优先级

```bash
# 生成 MD 报告
# （由 AI 基于诊断 JSON 直接撰写，包含上述所有章节）

# 不生成 PDF；PDF 由 S0 仅在 S10 品牌信息确认表完成后用户确认需要时统一生成
```

---

## 产出交付规则（v2.6.2 新增）

**必须执行**：本节点的所有源文件（JSON/MD/Prompt 包/图片资产等）生成并校验通过后，**必须立即使用 `message` 工具（type="info" 或 type="result"）将源文件作为附件发送给用户**。PDF 不在本节点内生成，统一由 S0 在 S10 品牌信息确认表完成后按用户确认生成。
**禁止暂停**：发送产出后，**禁止**等待用户确认（除非遇到硬性错误或到达预设的全局暂停点），必须立即通知 S0 编排师继续执行下一个节点。

---

## 校验闸门

| 序号 | 校验条件 | 不达标动作 |
| :--- | :--- | :--- |
| 1 | 诊断 JSON 中 7 个维度均有评分（无 N/A） | 打回补充评分 |
| 2 | Gap 报告包含 7 个维度的完整对标 | 打回补充 |
| 3 | **`S5_{brand}_品牌诊断数据.json`、`S5_{brand}_品牌诊断数据.md`、`S5_{brand}_Gap报告.md` 均存在且非空；PDF 不作为 S5 完成条件** | **强制打回重做** |
| 4 | 综合评分在 0-100 范围内 | 修复计算 |
| 5 | **`ranking_position_diagnostics` 顶层对象存在，且包含 `avg_rank`、`first_place_rate`、`top3_rate`、`top5_rate`、`rank_distribution`、`competitor_rank_gap`、`platform_breakdown`、`per_question_rank_matrix`；若存在舆情类问题，还必须包含 `reputation_issue_diagnostics`，且舆情样本在矩阵中标记为 `ranking_metric_eligible=false`** | **打回补充分流后的排名/舆情诊断** |
| 6 | **MD 报告包含“AI 排名位次诊断”章节，并展示实际样本的问题级排名矩阵；小样本必须展示样本覆盖说明；舆情类问题必须说明已从可见度和排名分母中排除** | **打回补充位次报告、样本说明或舆情排除说明** |
| 7 | **`citation_sources` 字段存在；`top_sources` 按实际可解析信源输出，可为 0-N 条，但不得编造；若少于 5 条必须在 MD 中解释原因** | **打回补充信源分析或原因说明** |
| 8 | **MD 报告包含"信源域名频次统计"和"高频/标杆信源深度解析"章节；如无可解析信源，必须明确写出“当前样本未提供可解析信源”** | **打回补充说明** |
| 9 | **`competitor_gap_matrix` 可为空数组；若为空，MD 必须说明是因为样本未出现竞品信源、竞品字段缺失，还是品牌/竞品均无可判定引用** | **打回补充竞品缺口说明** |

---

## 子文件引用

| 文件路径 | 用途 | 引用时机 |
| :--- | :--- | :--- |
| `references/diagnosis-metrics.md` | 7 维诊断指标体系的详细定义和计算公式 | Step 3-5 |
| `references/citation-intelligence.md` | 信源提取方法论、域名归一化、频次统计公式、竞品缺口矩阵 | **Step 2** |
| `templates/diagnosis_data_schema.json` | 诊断数据 JSON Schema | Step 6 |
| `scripts/gap_calculator.py` | Gap 计算器 | Step 5 |
| `scripts/ranking_position_calculator.py` | AI 排名位次诊断计算器，将监测 JSON 的 `position` 字段转译为 `ranking_position_diagnostics` | Step 2.6 / Step 6 |

---

## 与下游节点的数据流

| 下游节点 | 消费的数据 | 用途 |
| :--- | :--- | :--- |
| S6 品牌话语体系 | `gap_analysis`（话语一致性维度） | 识别话语偏差，构建修复性话语体系 |
| S7 视觉符号体系 | `gap_analysis`（视觉维度） | 识别视觉偏差，调整视觉策略 |
| S8 问答架构师 | `seven_dimensions.D5_intent_coverage` | 识别意图覆盖缺口，补充 Q&A |
| S9 业务赋能规划师 | `overall` + `recommendations` + `sample_scope` + `citation_sources` + `gap_analysis` + `ranking_position_diagnostics.reputation_issue_diagnostics` | 作为 S1-S8 问题总结与 GEO 业务建议的重要依据；小样本限制和舆情问题分流口径必须被带入结论解释 |
| **E5 分发编排师** | **`citation_sources`（域名频次 + 高频信源 + 竞品缺口矩阵）** | **双轨渠道评估的动态数据输入（第一优先级）；按实际可解析信源数量使用** |
| **E1 内容策略师** | **`citation_sources.top_sources`（高频信源内容特征，最多 Top 10）** | **逆向工程标杆内容结构；不足 10 条时按实际样本使用** |
| **S5.5 品牌语义资产审计师** | **`ranking_position_diagnostics`（平均位次、Top3/Top5、竞品位次差、问题级矩阵）** | **作为 BSAS 竞品语义占优度与位次质量诊断的唯一优先输入；必须只使用 `ranking_metric_eligible=true` 的样本计算位次质量，舆情样本只作为负面风险参考** |
