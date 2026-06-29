# 策略编排规则详解

本文档是 S0 策略编排师的核心参考文件，详细阐述五不原则的执行细节、节点依赖关系、错误处理规则、版本管理规则、回流处理完整规则和暂停点交互话术模板。

---

## 一、五不原则执行细节

### 1.1 不越俎代庖 — 职责边界矩阵

S0 的唯一职责是**调度**，以下行为属于越权：

| 越权行为 | 应由谁执行 | S0 的正确做法 |
| :--- | :--- | :--- |
| 直接撰写品牌定位声明 | S4 品牌定位分析师 | 读取 S4 SKILL.md 后按指令执行 |
| 直接编写话语手册 | S6 品牌话语体系 | 读取 S6 SKILL.md 后按指令执行 |
| 直接设计视觉 Prompt | S7 视觉符号体系 | 读取 S7 SKILL.md 后按指令执行 |
| 在 S5 阶段直接生成单点诊断 HTML | 已废弃：S10 不再生成全景报告（已由其他 Workflow 负责）| S5 仅产诊断数据，S10 末端整合 S1-S9 与应答逻辑确认表生成《品牌信息确认表》XLSX |
| 直接编写 SEO 建议 | S9 业务赋能规划师 | 读取 S9 SKILL.md 后按指令执行 |
| 修改其他节点的产出文件 | 对应节点 | 打回该节点重做 |
| 直接从资料中提取品牌信息 | S1 品牌资产知识库 | 调用 S1 执行 |
| 直接分析用户画像 | S2 营销图谱专家 | 调用 S2 执行 |

**S0 可以做的事情**：
- 解析客户资料并分发给对应节点
- 检测产出文件是否存在
- 执行校验闸门检查
- 维护执行日志
- 构建 strategy_pack JSON
- 处理 外部反馈信号
- 与用户交互（暂停点）

### 1.2 不省略子文件 — 阅读清单强制执行

每个 Skill 目录的完整知识体系由以下四层构成：

```
{编号}.{中文名}.skill/
├── SKILL.md              ← 第一层：入口指令（必读）
├── references/           ← 第二层：方法论与框架（必读）
├── templates/            ← 第三层：输出模板（必读）
└── scripts/              ← 第四层：可执行脚本（必读）
```

每次调用下游节点前，S0 必须按以下顺序阅读文件：

```
1. 读取 {节点}.skill/SKILL.md
2. 从 SKILL.md 中提取所有 references/ 引用 → 逐个阅读
3. 从 SKILL.md 中提取所有 templates/ 引用 → 逐个阅读
4. 从 SKILL.md 中提取所有 scripts/ 引用 → 了解接口和用法
5. 阅读 shared/output-format-standard.md（如尚未阅读）
6. 开始执行该节点的任务
```

**阅读确认检查表**（每个节点执行前在日志中记录）：

```markdown
### S{N} 阅读确认
- [x] SKILL.md 已阅读
- [x] references/xxx.md 已阅读
- [x] references/yyy.md 已阅读
- [x] templates/zzz.md 已阅读
- [x] scripts/aaa.py 接口已了解
- [x] shared/output-format-standard.md 已阅读
```

### 1.3 不跳过校验 — 校验执行协议

每个节点完成后，S0 必须执行以下校验流程：

```
1. 检查标准命名文件是否存在（文件名必须精确匹配）
2. 检查文件大小是否合理（非空文件）
3. 执行节点特定的校验闸门（见 SKILL.md 中各步骤的校验闸门）
4. 若有 JSON 输出 → 验证 JSON 格式合法性
5. 节点内禁止将 S1-S9 单节点 PDF 作为完成条件；S10 输出《品牌信息确认表》XLSX（无需 PDF），S1-S9 单节点 PDF 仅在 S10 后用户确认需要时统一生成
6. 记录校验结果到执行日志
7. 全部通过 → 进入下一步；任何失败 → 打回
```

校验结果必须以 ✅/❌ 标记记录在执行日志中。

### 1.4 不遗漏格式输出 — 格式检查矩阵

| 节点 | 必须输出的文件 | 格式检查 |
| :--- | :--- | :--- |
| S1 | 事实图谱 JSON + 知识库 MD + 缺口报告 MD + **视觉资产清单 JSON + visual_assets/ 目录（v2.6）** | JSON schema 校验 + MD 非空 + 视觉资产清单存在性 |
| S2 | 营销图谱 JSON（营销图谱/场景树 v3.5）+ 报告 MD | JSON 格式 + 场景树校验 + MD 非空；不得包含监控题库字段 |
| S3 | 趋势报告 MD + 打分卡 JSON | JSON 格式 + MD 非空 |
| S4 | 定位声明 MD + 定位 JSON + 分析报告 MD | JSON 格式 + MD 非空 |
| S5 | 诊断数据 JSON + MD + Gap MD | 数据完整性 + Gap 7 维 + 信源分析齐全 |
| S6 | 话语手册 MD + token JSON | JSON schema 校验 + MD 非空 |
| S7 | Prompt 包 JSON + 概念 MD（或评分+改进+重绘 JSON） | JSON 格式 + 字段完整性 + **视觉资产锚定校验（v2.6）** |
| S8 | 问答树 JSON + 问答矩阵 JSON + 内容日历 JSON + 报告 MD + 落地页蓝图 MD | JSON 格式 + MD 非空 + 落地页 5 区块 |
| S5.5 | 评分卡 JSON + 审计报告 MD | JSON schema 校验 + MD 非空 |
| S9 | 赋能包 MD + 完整性检查 MD | 5 模块分析完整 + 完整性检查覆盖 S1-S8 |
| S10_Brand_Info_Confirmation | S10 品牌信息确认表 XLSX（双子表）| 输入企业已回填的《应答逻辑确认表》+ S1-S9；检查 XLSX 存在性、双子表齐全、配色合规、企业填写/修改列存在 |
| S0_Unified_PDF | S1-S9 客户版 PDF | S10 后先询问用户；用户确认后统一生成 + PDF 存在性 + 源文件一致性检查；用户未回复则暂停等待，用户跳过则不生成 |

### 1.5 不放行未验证产物 — 验证脚本调用

对于有脚本校验的节点，S0 必须调用对应脚本：

```bash
# S1 事实图谱 schema 校验
python3 S1.品牌资产知识库.skill/scripts/json_schema_validator.py \
  --input "S1_{brand}_品牌事实图谱.json" \
  --schema shared/brand_facts_schema.json

# S2 营销图谱校验
python3 S2.营销图谱专家.skill/scripts/atlas_validator.py \
  --input "S2_{brand}_营销图谱.json"

# S2 放行附加闸门（人工/自动检查均必须执行）
# 1. S2_{brand}_营销图谱报告.md 必须只包含营销图谱分析，不得包含推荐监控问题清单。
# 2. 向用户发送 S2 产物时，消息正文只摘要用户画像、场景、意图和触点，不得列出 S5 监控题。
# 3. 暂停 2 的监控问题必须由客户自行确认，禁止复用或改写 S2 问法模式。

# S4 定位声明校验
python3 S4.品牌定位分析师.skill/scripts/positioning_validator.py \
  --input "S4_{brand}_定位声明.json" \
  --facts "S1_{brand}_品牌事实图谱.json"

# S6 话语 token 校验
python3 S6.品牌话语体系.skill/scripts/token_validator.py \
  --input "S6_{brand}_话语token.json"

# S7 Prompt 包校验（v2.6 新增 --visual-manifest 参数）
python3 S7.视觉符号体系.skill/scripts/prompt_pack_validator.py \
  "S7_{brand}_视觉Prompt包.json" \
  --verbal-tokens "S6_{brand}_话语token.json" \
  --visual-manifest "S1_{brand}_视觉资产清单.json" \
  --ai-feedback

# S8 问答矩阵校验
python3 S8.问答架构师.skill/scripts/qa_matrix_validator.py \
  --input "S8_{brand}_问答矩阵.json"

# S9 完整性检查
python3 S9.业务赋能规划师.skill/scripts/completeness_checker.py \
  --brand "{brand}" \
  --workspace "./"

# S10 品牌信息确认表生成（双子表 XLSX）
python3 S10.品牌信息确认表生成师.skill/scripts/brand_info_confirmation_generator.py \
  --brand "{brand}" \
  --work-dir "./" \
  --response-logic "{brand}_应答逻辑确认表_现场讨论.xlsx" \
  --out "S10_{brand}_品牌信息确认表.xlsx"
```

"产出存在"不等于"产出合格"。S10 额外要求：子表1 必须删除收集表末尾“提出的问题”区段、保留「企业填写/修改」列；子表2 必须逐条承接企业已回填的《应答逻辑确认表》并保留「企业想修改」列；两子表统一遵循收集表紫色配色。

S0 必须对每个产出执行以下验证：
1. **文件存在性**：标准命名文件是否存在
2. **格式合法性**：JSON 是否可解析、MD 是否有内容；S10 XLSX 在 S10 阶段检查是否可打开且双子表齐全；S1-S9 单节点 PDF 仅在 S10 后用户确认生成时检查
3. **内容完整性**：是否满足校验闸门中的所有硬性条件
4. **一致性**：产出内容是否与上游输入一致（如 S4 定位是否基于 S1 事实）

---

## 二、节点依赖关系图

### 2.1 串行依赖链

```
S1 ──→ S2 ──→ S3 ──→ S4 ──→ S5 ──→ S5.5 ──→ S6 ──→ S7 ──→ S8 ──→ S9 ──→ S10
```

所有节点必须严格按顺序执行，不允许跳过或并行。

| 依赖关系 | 原因 |
| :--- | :--- |
| S2 依赖 S1 | 营销图谱基于品牌事实图谱构建（三元组建模 → 话题聚类 → 场景树 → 问法模式分析） |
| S3 依赖 S1+S2 | 趋势分析需要品类边界（S1）和用户意图（S2） |
| S4 依赖 S1+S2+S3 | 定位需要事实、用户画像和趋势三重输入 |
| S5 依赖客户确认监控问题+AI监测数据+S4 | 诊断问题只能来自客户在暂停 2 中自行确认的问题和上传数据；S2 不作为 S5 问题来源 |
| S5.5 依赖 S1+S4+S5 | 语义资产打分需要定位锚点、AI诊断数据和品牌事实 |
| S6 依赖 S1+S4+S5+S5.5 | 话语体系基于定位声明、Gap 报告和语义资产短板分析 |
| S7 依赖 S1+S4+S6 | 视觉方案基于定位、话语和 **S1 视觉资产清单**（v2.6 新增刚性依赖） |
| S8 依赖 S2+S4+S5+S5.5+S6+S7 | 问答架构需要 S2 场景/意图背景、客户确认监控问题、S5 Gap 及 S5.5 提供的问题阶段覆盖度基线 |
| S9 依赖 S1-S8 | 业务赋能是全部策略的综合分析建议 |
| S10 依赖 S1-S9 + 企业回填的应答逻辑确认表 | 品牌信息确认表必须整合全部策略资料包与企业回填的应答逻辑，产出双子表 XLSX |

### 2.2 数据流向图

```
客户资料 ──→ [S1] ──→ 品牌事实图谱 ──┬──→ [S2] ──→ 营销图谱
                                      ├──→ [S3] ──→ 趋势报告
                                      ├──→ [S4] ──→ 定位声明
                                      └──→ [S6] ──→ 话语手册

营销图谱（场景树） ──→ [S3] + [S4] + [S5] + [S8]
趋势报告 ──→ [S4]
定位声明 ──→ [S5] + [S5.5] + [S6] + [S7] + [S8]
Gap 报告 ──→ [S6]
语义资产评分卡 ──→ [S6] + [S8]
话语手册 ──→ [S7] + [S8]
视觉资产清单 ──→ [S7]（v2.6 新增刚性依赖）
视觉Prompt ──→ [S8]
```

---

## 三、错误处理规则

### 3.1 节点执行失败

| 失败类型 | 处理策略 |
| :--- | :--- |
| 产出文件缺失 | 打回该节点重新执行，最多 2 次 |
| 校验闸门不通过 | 打回该节点修复特定问题，最多 2 次 |
| 上游数据不足 | 回退到上游节点补充数据 |
| 用户输入不完整 | 暂停并向用户请求补充信息 |
| 脚本执行报错 | 检查脚本依赖和输入格式，修复后重试 |

### 3.2 打回计数器

S0 必须为每个节点维护一个打回计数器：

```python
reject_counter = {
    "S1": 0, "S2": 0, "S3": 0, "S4": 0, "S5": 0,
    "S6": 0, "S7": 0, "S8": 0, "S9": 0
}

MAX_REJECTS = 2  # 每个节点最多打回 2 次

def handle_reject(node_id, issues):
    reject_counter[node_id] += 1
    if reject_counter[node_id] > MAX_REJECTS:
        # 超过打回上限，请求用户人工决策
        escalate_to_user(node_id, issues)
    else:
        # 打回并附带修复指令
        reject_node(node_id, issues)
```

### 3.3 回退策略

当某节点的问题源于上游数据不足时，S0 需要回退到上游节点：

| 当前节点 | 问题描述 | 回退目标 |
| :--- | :--- | :--- |
| S4 | 定位缺乏事实支撑 | 回退 S1 补充产品/技术信息 |
| S5 | 监测 JSON 格式错误 | 请求用户重新上传 |
| S6 | 定位声明模糊导致话语不聚焦 | 回退 S4 优化定位声明 |
| S7 | 品牌色信息缺失或视觉资产清单缺失 | **若客户明确无官网且无 Logo，允许跳过抓取直接进入 S7 的 `inference_only`（v2.6.1 修订）；否则**回退 S1 重新运行 `visual_scraper.py` 抓取视觉元素 |

---

## 四、版本管理规则

### 4.1 strategy_pack 版本递增逻辑

| 触发条件 | 版本变更 | 说明 |
| :--- | :--- | :--- |
| 首次完整执行 S1-S9 + S10 品牌信息确认表 | v1 | 初始版本 |
| 外部反馈触发 S1 重算 | v{N} → v{N+1} | 事实修正导致全链路更新 |
| 外部反馈触发 S4 重算 | v{N} → v{N+1} | 定位调整导致下游更新 |
| 用户主动要求修改某节点 | v{N} → v{N+1} | 人工干预触发 |

### 4.2 版本文件命名

```
{brand}_strategy_pack_v1.json   ← 首次
{brand}_strategy_pack_v2.json   ← 外部反馈后重算
{brand}_strategy_pack_v3.json   ← 用户修改后重算
```

### 4.3 策略包完整性校验

E0 接收策略包后必须执行的校验：

```python
import json
import hashlib
import os

def verify_strategy_pack(pack_path):
    """验证策略包完整性"""
    with open(pack_path, 'r', encoding='utf-8') as f:
        pack = json.load(f)

    errors = []

    # 1. 检查所有节点完成状态
    required_nodes = ['S1', 'S2', 'S3', 'S4', 'S5', 'S5.5', 'S6', 'S7', 'S8', 'S9']
    completed = pack['meta'].get('strategy_nodes_completed', [])
    for node in required_nodes:
        if node not in completed:
            errors.append(f"缺少节点 {node}")

    # 2. 检查所有文件存在性
    for artifact_key, artifact_data in pack['artifacts'].items():
        for file_key, file_path in artifact_data.items():
            if file_key == 'sha256':
                continue
            if not os.path.exists(file_path):
                errors.append(f"{artifact_key} 文件不存在: {file_path}")

    # 3. 检查暂停决策记录
    pause_log = pack.get('pause_log', {})
    if pause_log.get('pause_1', {}).get('status') != 'confirmed':
        errors.append("暂停1（事实图谱确认）未记录")
    if pause_log.get('pause_2', {}).get('status') != 'completed':
        errors.append("暂停2（AI 监测数据上传）未记录")
    if pause_log.get('pause_3', {}).get('status') != 'completed':
        errors.append("暂停3（应答逻辑确认表回填）未记录")
    # 暂停4：S10 品牌信息确认表必须已由企业最终确认并回灌，才能封包
    if pause_log.get('pause_4', {}).get('status') != 'completed':
        errors.append("暂停4（品牌信息确认表最终确认与回灌）未完成：企业未回传已确认表或修改未回灌，不得封包")

    return errors
```

### 4.4 增量更新协议

当 外部反馈触发部分节点重算时，S0 只重做受影响的节点，不重做全部：

**影响传播矩阵**：

| 被修改节点 | 必须级联重做的节点 | 可选重做的节点 |
| :--- | :--- | :--- |
| S1（事实图谱） | S4（若核心事实变更）→ S6 → S7 | S2, S3, S8, S9 |
| S4（定位声明） | S6, S7 | S8, S9 |
| S6（话语体系） | S7（若品牌色变更） | — |
| S2（营销图谱） | — | S3, S4, S8 |

### 4.5 E0 接收新版本的处理逻辑

E0 收到新版本 strategy_pack 后，需要比对变更范围：

| 变更节点 | E0 需要重做的执行层节点 |
| :--- | :--- |
| S1 变更 | E1 重新生成选题 → E2-E4 重新生产 |
| S4 变更 | E1 重新生成选题 → E2 重新注入定位约束 |
| S6 变更 | E2 重新注入话语 Token |
| S7 变更 | E3 重新使用新 Prompt 包 |
| S9 变更 | 仅更新赋能建议，不影响已完成内容 |

---

## 五、回流处理完整规则

### 5.1 回流文件格式

**external_feedback_to_S1.json**（事实修正）：

```json
{
  "feedback_type": "fact_correction",
  "source": "external_monitoring_layer",
  "timestamp": "2026-04-26T12:00:00Z",
  "corrections": [
    {
      "fact_path": "facts.products[0].name",
      "current_value": "产品A",
      "corrected_value": "产品A Pro",
      "evidence": {
        "source_url": "https://...",
        "description": "官方已更名"
      },
      "impact_assessment": "low"
    }
  ]
}
```

**external_feedback_to_orchestrator.json**（流程问题）：

```json
{
  "feedback_type": "process_issue",
  "source": "external_monitoring_layer",
  "timestamp": "2026-04-26T12:00:00Z",
  "issues": [
    {
      "affected_node": "S4",
      "issue_description": "定位声明中的差异点在市场上已被竞品占据",
      "suggested_action": "重新执行竞品分析，更新定位声明",
      "priority": "high"
    }
  ]
}
```

### 5.2 回流处理决策树

```
收到回流信号
  ├─ external_feedback_to_S1.json
  │   ├─ impact_assessment = "low" → 仅更新 S1，不级联
  │   ├─ impact_assessment = "medium" → 更新 S1 + 评估是否影响 S4
  │   └─ impact_assessment = "high" → 更新 S1 + 强制重做 S4 → S6 → S7
  │
  └─ external_feedback_to_orchestrator.json
      ├─ priority = "low" → 记录日志，下一轮处理
      ├─ priority = "medium" → 评估是否需要重做对应节点
      └─ priority = "high" → 立即重做对应节点 + 级联更新
```

### 5.3 版本回滚规则

- 每次重做前，S0 必须备份当前版本的所有受影响文件
- 备份命名：`{brand}_{filename}_backup_v{N}.{ext}`
- 若重做后质量更差（连续 2 次打回），回滚到备份版本并向用户报告

---

## 六、暂停点交互话术模板

### 6.1 通用暂停格式

所有暂停点必须使用 `message(type="ask")` 实现，话术格式统一为：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 {暂停点标题}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{暂停原因说明}

{展示内容}

{用户操作指引}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 6.2 进度报告格式

每完成一个节点后，向用户发送进度报告：

```
📊 策略层进度更新

已完成：S1 ✅ → S2 ✅ → S3 ✅ → S4 ✅
当前：S5 品牌诊断专家（执行中...）
待执行：S6 → S7 → S8 → S9

本节点产出已发送，请查看附件。
```

---

## 七、异常处理规则

### 7.1 节点执行超时

- 单个节点执行时间超过预期 → 向用户报告进度
- 不设硬性超时限制，但每个节点完成后必须立即输出产物

### 7.2 用户长时间未响应暂停点

- 暂停点等待用户响应时，不执行任何其他操作
- 用户回来后，从暂停点继续执行
- 不自动跳过任何暂停点

### 7.3 文件损坏或丢失

- 若检测到已完成节点的产出文件损坏或丢失 → 重新执行该节点
- 若多个节点文件丢失 → 从最早缺失的节点开始重做

### 7.4 客户资料不足

- S1 执行时若客户资料严重不足（缺口报告中必填缺失 > 5） → 暂停并向用户请求补充
- 不在资料不足的情况下强行推进后续节点
