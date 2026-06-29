# 场景与意图图谱设计原理（v3.5）

本文档说明 S2 营销图谱专家如何构建用户—场景—意图分析结构。自 v3.5 起，S2 不再承担 AI 监控问题推荐职责，也不再输出任何供 S5 直接使用的问题清单。

---

## 一、设计目标

S2 的目标是回答四个分析问题：

1. 品牌面对哪些典型用户与决策角色？
2. 这些用户在什么场景下会产生搜索、比较、验证或咨询需求？
3. 这些需求对应哪些搜索意图、关键词和内容触点？
4. 后续 S3/S4/S8/S9 应如何利用这些用户心智信息？

S2 不回答：

```text
客户应该监控哪些 AI 问题？
S5 应该以哪些问题作为诊断样本？
哪些问题必须被客户逐条测试？
```

上述内容只在 S4 后的暂停 2 由客户自行确认。

---

## 二、三层结构

```text
核心话题（Topic）
  └─ 子场景（Sub-Scene）
       └─ 意图模式（Intent Pattern）
```

### 2.1 核心话题

核心话题从用户痛点、产品价值和竞争环境中提炼，建议保留 3-5 个。

```json
{
  "id": "TOPIC-01",
  "title": "节能改造方案评估",
  "pain_point": "用户需要判断哪类节能设备适合自身工况",
  "search_volume_signal": "medium",
  "brand_relevance": "direct",
  "mapped_triplet_clusters": ["T001", "T005", "T012"]
}
```

### 2.2 子场景

子场景来自“用户角色 × 触发条件 × 约束条件”。

| 用户角色 | 触发条件 | 约束条件 | 子场景 |
| :--- | :--- | :--- | :--- |
| 采购负责人 | 设备升级 | 预算有限 | 评估性价比更高的供应商 |
| 技术主管 | 产线改造 | 环保合规 | 判断方案是否满足排放要求 |
| 老板/决策者 | 降本增效 | 投资回报 | 评估项目 ROI 与实施周期 |

### 2.3 意图模式

意图模式用于解释用户搜索行为，不等于 S5 监控问题。

| 意图类型 | 用户目标 | 典型查询模式 |
| :--- | :--- | :--- |
| 信息搜索 | 了解品类或技术原理 | “什么是……”“如何判断……” |
| 比较评估 | 对比方案或品牌 | “A 和 B 有什么区别”“怎么选” |
| 决策支撑 | 了解价格、周期、资质、案例 | “报价”“案例”“资质”“合作流程” |
| 服务查询 | 查找售后、联系方式、维保 | “联系方式”“售后响应”“维修” |

---

## 三、与 S5 的边界

| 项目 | S2 | S5 |
| :--- | :--- | :--- |
| 主要任务 | 营销图谱与用户意图分析 | AI 可见性诊断 |
| 问题来源 | 不生成监控问题 | 客户自行确认的问题 |
| 数据来源 | S1 品牌事实图谱 | 客户上传的 AI 监测数据 |
| 输出用途 | 支撑 S3/S4/S8/S9 分析 | 诊断 AI 平台表现与信源缺口 |

**强制规则**：

```text
S5 不得从 S2 读取问题清单。
S2 不得把意图模式、查询模式或示例语句标记为 S5 监控问题。
暂停 2 不得复用 S2 自动生成的问题。
```

---

## 四、JSON 结构建议

```json
{
  "meta": {
    "framework_version": "marketing_atlas_v3_5",
    "monitoring_question_policy": "customer_confirmed_only"
  },
  "user_profiles": [
    {
      "id": "UP-01",
      "role": "采购负责人",
      "industry": "制造业",
      "decision_level": "评估者",
      "pain_points": ["节能效果难判断", "售后响应要求高"],
      "info_channels": ["AI 搜索", "行业平台", "官网"]
    }
  ],
  "triplets": [
    {
      "id": "T001",
      "user": {"role": "采购负责人"},
      "scenario": {"description": "设备升级前评估供应商"},
      "intent": {"type": "comparative", "query_pattern": "节能设备厂家怎么选"}
    }
  ],
  "topics": [
    {
      "id": "TOPIC-01",
      "title": "节能改造方案评估",
      "sub_scenes": [
        {
          "id": "TOPIC-01-SC01",
          "description": "采购负责人评估设备供应商",
          "intent_type": "comparative",
          "query_pattern_example": "节能设备厂家怎么选",
          "content_touchpoints": ["官网产品页", "案例文章", "技术白皮书"]
        }
      ]
    }
  ],
  "keyword_system": {
    "core_keywords": [],
    "long_tail_keywords": [],
    "risk_keywords": []
  },
  "downstream_policy": {
    "s5_question_source": "customer_confirmed_monitoring_questions_only",
    "s2_does_not_generate_monitoring_questions": true
  }
}
```

---

## 五、质量标准

| 维度 | 标准 |
| :--- | :--- |
| 三元组数量 | 建议 ≥ 30 条 |
| 核心话题 | 3-5 个 |
| 子场景 | 建议 ≥ 12 个 |
| 意图覆盖 | 至少覆盖信息搜索、比较评估、决策支撑、服务查询中的 3 类 |
| 用户画像 | 至少 3 个行业/角色；单一行业项目至少覆盖 3 个决策链角色 |
| 下游边界 | 必须明确 `s5_question_source=customer_confirmed_monitoring_questions_only` |

---

## 六、S0 暂停 2 口径

S0 在暂停 2 中应直接向客户索要：

```text
1. 客户自行确认的 AI 监控问题；
2. 监控地域；
3. 监控平台；
4. AI 监测结果 JSON。
```

S0 不应展示 S2 自动生成的问题，也不应要求客户按 S2 的分析示例进行监控。
