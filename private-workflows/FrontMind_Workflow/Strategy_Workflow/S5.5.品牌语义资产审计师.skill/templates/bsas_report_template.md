# {brand} 品牌语义资产审计报告

> 本报告由 S5.5 品牌语义资产审计师自动生成，基于全网搜索 + AI 搜索双生态的语义内容体系进行量化评估。

---

## 一、评估概览

| 项目 | 内容 |
| :--- | :--- |
| 品牌名称 | {brand} |
| 评估日期 | {generated_at} |
| BSAS 总分 | **{bsas_total} / 100** |
| 等级判定 | **{grade}** |
| 评估关键词数 | {keywords_evaluated} 个 |
| 对标竞品数 | {competitors_count} 个 |
| 监测平台数 | {platforms_count} 个 |

### 品牌定位锚点（来自 S4）

> {positioning_statement}

---

## 二、五维评分详情

### 2.1 总分雷达图

```
语义可见度:     {visibility_bar} {visibility_score}/30
语义一致性:     {coherence_bar} {coherence_score}/20
语义多样性:     {richness_bar} {richness_score}/20
语义权威性:     {authority_bar} {authority_score}/15
竞品占优度:     {competitive_bar} {competitive_score}/15
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BSAS 总分:      {total_bar} {bsas_total}/100
```

### 2.2 维度一：语义可见度（{visibility_score}/30 分）

| 子指标 | 得分 | 满分 | 原始值 | 计算依据 |
| :--- | :--- | :--- | :--- | :--- |
| AI 搜索可见率 | {ai_vis_score} | 15 | {ai_vis_raw} | {ai_vis_basis} |
| 全网搜索占有率 | {sov_score} | 10 | {sov_raw} | {sov_basis} |
| 多平台覆盖度 | {platform_score} | 5 | {platform_raw} | {platform_basis} |

**分析**：{visibility_analysis}

### 2.3 维度二：语义一致性（{coherence_score}/20 分）

| 子指标 | 得分 | 满分 | 原始值 | 计算依据 |
| :--- | :--- | :--- | :--- | :--- |
| 核心主张命中率 | {proposition_score} | 12 | {proposition_raw} | {proposition_basis} |
| 语调与词汇偏差率 | {tone_score} | 8 | {tone_raw} | {tone_basis} |

**分析**：{coherence_analysis}

### 2.4 维度三：语义多样性与深度（{richness_score}/20 分）

| 子指标 | 得分 | 满分 | 原始值 | 计算依据 |
| :--- | :--- | :--- | :--- | :--- |
| 问题阶段覆盖度 | {question_stage_score} | 10 | {question_stage_raw} | {question_stage_basis} |
| 关联语义丰富度 | {entity_score} | 6 | {entity_raw} | {entity_basis} |
| 内容格式多样性 | {format_score} | 4 | {format_raw} | {format_basis} |

**分析**：{richness_analysis}

**问题阶段覆盖详情**：

| 问题阶段 | 覆盖状态 | 内容数量 | 质量评估 |
| :--- | :--- | :--- | :--- |
| 认知 (Awareness) | {aw_status} | {aw_count} | {aw_quality} |
| 考虑 (Consideration) | {co_status} | {co_count} | {co_quality} |
| 决策 (Decision) | {de_status} | {de_count} | {de_quality} |
| 使用 (Usage) | {us_status} | {us_count} | {us_quality} |
| 推荐 (Advocacy) | {ad_status} | {ad_count} | {ad_quality} |

### 2.5 维度四：语义权威性（{authority_score}/15 分）

| 子指标 | 得分 | 满分 | 原始值 | 计算依据 |
| :--- | :--- | :--- | :--- | :--- |
| 权威信源占比 | {auth_source_score} | 8 | {auth_source_raw} | {auth_source_basis} |
| 结构化数据完整度 | {schema_score} | 4 | {schema_raw} | {schema_basis} |
| 第三方背书密度 | {endorsement_score} | 3 | {endorsement_raw} | {endorsement_basis} |

**分析**：{authority_analysis}

### 2.6 维度五：竞品语义占优度（{competitive_score}/15 分）

| 子指标 | 得分 | 满分 | 原始值 | 计算依据 |
| :--- | :--- | :--- | :--- | :--- |
| AI 搜索首位提及率 | {first_mention_score} | 8 | {first_mention_raw} | {first_mention_basis} |
| 独占语义空间 | {exclusive_score} | 7 | {exclusive_raw} | {exclusive_basis} |
| 排名位次质量（非加权诊断） | {rank_quality_score} | 10 | {rank_quality_raw} | {rank_quality_basis} |

**分析**：{competitive_analysis}

### 2.7 AI 排名位次诊断

排名位次诊断用于回答“品牌是否只是被提及，还是能在 AI 回答/搜索结果中排在用户最先看到的位置”。该小节不替代五维总分，而是对维度一的可见度和维度五的竞品占优度进行位次质量解释。**本章节默认继承 S5 品牌诊断数据顶层 `ranking_position_diagnostics`，S5.5 不另起口径补采。**

> **数据来源**：{ranking_data_source}

| 位次指标 | 当前值 | 诊断含义 |
| :--- | :--- | :--- |
| 监测样本总数 | {total_observations} | S5 AI 搜索/回答监测中参与位次诊断的样本量 |
| 可识别排名 / 未提及样本 | {ranked_observations} / {unmentioned_observations} | 区分“被看见”和“未进入可识别排序”的样本基础 |
| 品牌平均位次 | {avg_rank} | 数值越小越好，反映跨客户确认监控问题的平均排序质量 |
| 首位率 | {first_place_rate} | 品牌获得第 1 位的问题比例 |
| Top3 占比 | {top3_rate} | 进入用户高注意力区的问题比例 |
| Top5 占比 | {top5_rate} | 进入可见候选集的问题比例 |
| 最佳 / 最差位次 | {best_rank} / {worst_rank} | 识别优势问题与掉队问题 |
| 竞品位次差 | {competitor_rank_gap} | 品牌平均位次 - 竞品平均位次；正值代表品牌落后 |

**排名分布**：第 1 位 {rank_1_count} 个；第 2-3 位 {rank_2_3_count} 个；第 4-5 位 {rank_4_5_count} 个；第 6-10 位 {rank_6_10_count} 个；第 11 位及以后/未提及 {rank_11_plus_count} 个。

**平台拆解**：{platform_rank_breakdown}

| 代表问题 | 品牌位次 | 竞品最高位次 | 位次差 | 诊断结论 |
| :--- | :--- | :--- | :--- | :--- |
{per_question_rank_rows}

---

## 三、竞品对比

| 品牌 | 估算 BSAS | 相对位置 | 主要优势维度 |
| :--- | :--- | :--- | :--- |
| **{brand}** | **{bsas_total}** | — | — |
| {competitor_1} | {comp1_score} | {comp1_position} | {comp1_strength} |
| {competitor_2} | {comp2_score} | {comp2_position} | {comp2_strength} |
| {competitor_3} | {comp3_score} | {comp3_position} | {comp3_strength} |

---

## 四、维度短板分析

### 4.1 最薄弱维度

{weakest_dimensions_analysis}

### 4.2 根因分析

{root_cause_analysis}

---

## 五、优先建设行动建议

| 优先级 | 对应维度 | 行动建议 | 预期影响 | 执行节点 |
| :--- | :--- | :--- | :--- | :--- |
| P1 | {p1_dimension} | {p1_action} | {p1_impact} | {p1_node} |
| P2 | {p2_dimension} | {p2_action} | {p2_impact} | {p2_node} |
| P3 | {p3_dimension} | {p3_action} | {p3_impact} | {p3_node} |
| P4 | {p4_dimension} | {p4_action} | {p4_impact} | {p4_node} |
| P5 | {p5_dimension} | {p5_action} | {p5_impact} | {p5_node} |

---

## 六、12 周提升目标

| 维度 | 当前得分 | 12 周目标 | 提升幅度 | 关键行动 |
| :--- | :--- | :--- | :--- | :--- |
| 语义可见度 | {vis_current}/30 | {vis_target}/30 | +{vis_delta} | {vis_action} |
| 语义一致性 | {coh_current}/20 | {coh_target}/20 | +{coh_delta} | {coh_action} |
| 语义多样性 | {rich_current}/20 | {rich_target}/20 | +{rich_delta} | {rich_action} |
| 语义权威性 | {auth_current}/15 | {auth_target}/15 | +{auth_delta} | {auth_action} |
| 竞品占优度 | {comp_current}/15 | {comp_target}/15 | +{comp_delta} | {comp_action} |
| **总分** | **{total_current}/100** | **{total_target}/100** | **+{total_delta}** | — |

---

## 七、对下游节点的指导

### 7.1 对 S6（品牌话语体系）的建议

{s6_guidance}

### 7.2 对 S8（问答架构师）的建议

{s8_guidance}

### 7.3 对 E1（内容策略师）的建议

{e1_guidance}

---

## 附注

- 本评分基于评估时点的全网语义状态，语义资产会随内容建设和市场变化而动态变化
- 建议每季度复评一次 BSAS，以量化内容执行效果
- 所有评分数据来源可追溯，详见评分卡 JSON 中各子指标的 `calculation_basis` 字段
- 竞品评分为估算值，基于同维度公开数据对比，非精确测量
