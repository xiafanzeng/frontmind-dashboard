# {brand} 营销图谱报告

> **框架版本**：营销图谱分析 v3.5
> **生成时间**：{created_at}
> **数据来源**：`S1_{brand}_品牌事实图谱.json`（S1）
> **监控问题口径**：S2 只做用户意图与营销场景分析，不生成、不推荐、不打印 S5 AI 监控问题。S5 的问题来源为客户在暂停 2 中自行确认的问题和上传的 AI 监测数据。

---

## 一、图谱概览

| 指标 | 数值 |
| :--- | :--- |
| 三元组数量 | {triplet_count} |
| 核心话题数 | {topic_count} |
| 子场景总数 | {sub_scene_count} |
| 意图类型数 | {intent_count} |
| 品类拦截型意图占比 | {no_brand_ratio} |
| 用户画像数 | {profile_count} |

---

## 二、用户画像矩阵

### 2.1 画像总览

| 画像 ID | 角色 | 行业 | 决策层级 | 核心痛点 | 信息渠道 |
| :--- | :--- | :--- | :--- | :--- | :--- |
{user_profiles_table}

### 2.2 画像详情

#### 画像 {profile_id}：{role_name}

| 维度 | 描述 |
| :--- | :--- |
| 行业 | {industry} |
| 角色 | {role} |
| 决策层级 | {decision_level} |
| 核心痛点 | {pain_points} |
| 信息获取渠道 | {info_channels} |
| 决策周期 | {decision_cycle} |

---

## 三、用户—场景—意图三元组

共 {triplet_count} 条三元组，覆盖 {industry_count} 个行业、{scenario_count} 个场景类型、{intent_count} 类意图。

### 3.1 三元组分布

| 场景类型 | 数量 | 占比 | 典型三元组 |
| :--- | :--- | :--- | :--- |
| 业务场景 | {business_count} | {business_ratio} | {business_example} |
| 决策场景 | {decision_count} | {decision_ratio} | {decision_example} |
| 使用场景 | {usage_count} | {usage_ratio} | {usage_example} |
| 服务场景 | {service_count} | {service_ratio} | {service_example} |

### 3.2 三元组详情

| 编号 | 用户角色 | 场景描述 | 意图类型 | 查询模式 | 信息需求 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| T001 | {role} | {scenario} | {intent} | {query_pattern} | {need} |

---

## 四、核心话题与场景矩阵

{topics_section}

### TOPIC-{N}：{topic_title}

**痛点**：{topic_pain_point}  
**搜索量信号**：{search_volume_signal}  
**品牌相关度**：{brand_relevance}  
**关联三元组**：{mapped_triplet_clusters}

| 子场景 ID | 子场景描述 | 用户角色 | 触发条件 | 意图类型 | 内容触点 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| {sub_scene_id} | {sub_scene_description} | {user_role} | {trigger} | {intent_type} | {content_touchpoints} |

---

## 五、意图分类与决策因素

| 意图类型 | 用户目标 | 典型查询模式 | 决策因素 | 内容承接建议 |
| :--- | :--- | :--- | :--- | :--- |
| 信息搜索 | {informational_goal} | {informational_pattern} | {informational_factor} | {informational_content} |
| 比较评估 | {comparative_goal} | {comparative_pattern} | {comparative_factor} | {comparative_content} |
| 决策支撑 | {transactional_goal} | {transactional_pattern} | {transactional_factor} | {transactional_content} |
| 服务查询 | {navigational_goal} | {navigational_pattern} | {navigational_factor} | {navigational_content} |

---

## 六、关键词体系与内容触点

### 6.1 核心关键词

| 关键词 | 搜索量级 | 意图类型 | 关联三元组 |
| :--- | :--- | :--- | :--- |
| {keyword} | {volume} | {intent} | {triplets} |

### 6.2 长尾关键词

| 关键词 | 意图类型 | 对应场景 | 内容建议 |
| :--- | :--- | :--- | :--- |
| {keyword} | {intent} | {scenario} | {suggestion} |

### 6.3 风险/疑虑关键词

| 关键词 | 风险等级 | 应对策略 |
| :--- | :--- | :--- |
| {keyword} | {risk} | {strategy} |

---

## 七、下游使用说明

| 下游节点 | 使用方式 |
| :--- | :--- |
| S3 | 使用用户意图、关键词和场景信息辅助判断品类趋势与信号扫描方向 |
| S4 | 使用用户画像、三元组和决策因素验证品牌定位是否匹配用户心智 |
| S5 | **不从 S2 读取监控问题**；仅以客户确认的问题和上传的 AI 监测数据为诊断输入 |
| S8 | 使用 S2 的场景、意图、关键词和内容触点构建问答架构 |
| S9 | 使用 S2 的用户旅程与内容触点生成业务赋能建议 |

---

## 八、校验结果

```
{validation_output}
```
