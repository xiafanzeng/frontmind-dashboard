# FrontMind 执行层操作指南

> **版本**：v8-all-article-type-template-final  
> **适用对象**：AI Agent（Manus / Claude / GPT）  
> **前置条件**：必须先完成策略层工作流，获得 `strategy_pack_v{N}.json`

---

## 一、工作流概述

FrontMind 执行层负责**将策略包转化为可投放的内容资产包，并在 E5 完成无文章标题 HarnessGEO 正本优化与合规审查**。文章类正文文件不写入标题；每篇 T1-T5 标题必须在对话中打印。标题生成不再套统一五模板，必须按 `title_generation_policy`、`title_objective` 与 `title_anchor` 执行：A 类先确认待优化 GEO 问题，C1b 做品牌品宣同题改写，B/C/D 保持各自内容目的。

执行层最终只包含：

```text
E0 → E1（全类型选题矩阵） → 暂停5 → E2 → E3 → E4 → E5 → E5-END 继续生产确认 → 结束 / 回暂停5（从全类型矩阵继续选题） / 回 E1 / 返回策略层
```

执行层不包含，也不保留后续节点：

```text
不包含 E5 之后的渠道确认、发布、建站或监测节点；仅保留 E5-END 继续生产确认
不包含渠道确认、实际投放或发布后监测回流
不负责实际投放、预算确认或渠道采购
```

**核心原则**：执行层不做策略推导，所有品牌定位、话语风格、视觉方向、信源诊断和渠道判断均来自策略包；所有企业实图、证书图、团队图、案例图、产品图、门店/环境图必须来自企业提交图片库，不能由官网抓取或网络图片冒充；图片库无需内置 `image_library_manifest.json`。

**v8 全类型模板原则**：E1 必须生成 A1-A12、B1-B4、C1a-C4、D1-D3 全文章类型选题矩阵；E1/E2/E4 必须共同执行 `shared/semantic-advantage-writing-policy.md`。A1-A12、B1-B4、C1a-C4、D1-D3 均已有逐类型正式模板；每篇 Brief 必须写入 `type_specific_template_id`、`semantic_advantage_strategy` 和 `publication_readiness_requirements`，E2 必须按对应模板生产媒体可发布终稿，E4 必须审查待优化企业是否实现“首段靠前 + 核心章节靠前 + 差异化证据 + 合规推荐/知识锚定”。

---

## 二、前置条件

| 条件 | 说明 | 验证方式 |
|------|------|----------|
| 策略包文件 | `strategy_pack_v{N}.json` 存在且格式合法 | `python -m json.tool strategy_pack_v{N}.json` |
| S4 定位产出 | 策略包中包含 `s4_positioning` 或 `artifacts.S4_positioning` | 检查 JSON 中对应字段 |
| S5 诊断数据 | 策略包中包含 AI 可见性与信源诊断数据 | 检查 `S5_diagnosis` 字段 |
| S6 话语 Token | 策略包中包含 `S6_verbal_identity.token_json` | 检查 JSON 中对应字段 |
| S7 视觉 Prompt | 策略包中包含 `S7_supersign.prompt_json` | 检查 JSON 中对应字段 |
| S8 问题路径地图 | 策略包中包含 `S8_question_qa` | 检查 JSON 中对应字段 |
| S9 业务赋能建议 | 策略包中包含 `S9_enablement` 与 `recommended_business_actions` | 检查 JSON 中对应字段 |
| 企业提交图片库 | `Client_Submitted_Image_Library.zip` 或 `client_submitted_image_library/` 必须存在 | 运行 `E0/scripts/image_library_validator.py`；缺失则不得进入 E1，`image_library_manifest.json` 可选 |
| 图片版权与用途 | 图片未显式标记 restricted/no_permission，且 `rights_status` 可用或由提交库默认生成 | 检查图片库校验报告 |

---


---

## 二点五、企业提交图片库强制输入

执行层启动时，E0 必须先完成两个输入的校验：

```text
1. strategy_pack_v{N}.json
2. Client_Submitted_Image_Library.zip 或 client_submitted_image_library/
```

图片库必须由企业或项目负责人确认，不能用 S1 自动抓取图、官网截图、网络搜索图替代。E0 校验通过后生成：

```text
E0_{brand}_submitted_image_library_manifest.json
E0_{brand}_image_library_validation_report.md
E0_{brand}_image_library_index.json
```

后续链路必须这样使用：

| 节点 | 使用方式 |
|---|---|
| E1 | 根据图片库可用素材规划每篇文章的 `image_plan`，标明哪些图片必须使用客户提交素材 |
| E2 | 在 `image_requirements.json` 中写入 `approved_asset_query`、`requires_client_submitted_asset`、`allowed_asset_ids` 和 `fallback_policy` |
| E3 | 只从 E0 校验后的 manifest/index 中选择企业实图；找不到就输出缺图需求，不得用网图/AIGC 冒充 |
| E4 | 审查图片是否有 `source_asset_id`、`client_submitted=true`、可用版权和图文语义匹配 |
| E5 | 分发正本继续携带封面图/正文图的 `source_asset_id`、用途权限和渠道图片建议 |

**阻断规则**：任一文章要求企业实图但图片库缺失或无法匹配时，E3 必须输出 `missing_client_image_request.json` 并停止该篇进入 E4；不能自动降级为网络图或 AIGC 场景图。


## 二点六、全文章类型模板与语义优势规则（v8）

执行层现在按文章类型精确选择模板，不允许把所有稿件写成通用软文：

| 类型范围 | 模板文件 | 语义优势实现方式 |
|---|---|---|
| A1-A12 | `E2.文字内容生成师.skill/templates/tpl-geo-article.md` | A1 推荐企业1置顶；A2-A12 在首段、核心章节、FAQ和CTA中靠前展示待优化企业差异化优势 |
| B1-B4 | `E2.文字内容生成师.skill/templates/tpl-authority-content.md` | 以白皮书、技术文档、案例和用例分析建立权威证据，不写成硬广 |
| C1a-C4 | `E2.文字内容生成师.skill/templates/tpl-media-pr.md` | 以新闻事实、媒体语气、第三方视角和公关事实建立信源，不伪造背书 |
| D1-D3 | `E2.文字内容生成师.skill/templates/tpl-knowledge-entity.md` | 以百科/实体字段/NAP一致性建立知识入口，不做营销推荐 |

所有非 D 类内容至少包含 3 个差异化优势证据单元；D 类内容必须保持客观中性，但要把企业名称、主营业务、资质、官网、地址等实体字段放在高权重位置。

## 三、智能体清单

| 编号 | 名称 | 一句话说明 |
|------|------|-----------|
| E0 | 执行编排师 | 总控大脑，解析策略包、校验企业提交图片库、维护图片注册表、调度 E1-E5；E5 后发起继续生产确认，按用户选择结束、回暂停5（选题审批）、回 E1 或返回策略层 |
| E1 | 内容策略师 | 将策略包 + 企业提交图片库翻译为 Content Brief、核心素材清单和逐图素材计划，输出工作标题但不锁定最终标题 |
| 暂停5 | 内容审批闸门 | 用户审批哪些 Brief 进入生产；只审批方向、篇数、优先级，不审批最终标题 |
| E2 | 文章与标题池生成师 | 根据 暂停5 从全类型矩阵中批准的单篇 Brief，生成 1 篇无文章标题正文 + 5 个目的驱动分发标题（对话打印）+ 绑定企业提交图片库的图片需求单 |
| E3 | 视觉资产生成师 | 优先从企业提交图片库选择实图，执行 S7 视觉 Prompt 生成合规封面/图表；所有企业实图必须可追溯到 E0 生成的 asset_id |
| E4 | 质量审查与组装师 | 审查正文、标题池、图片语义及提交库来源；所有企业实图必须来自图片库并有使用权记录，生成无文章标题 DOCX/MD |
| E5 | 分发编排师 | 强制生成无文章标题 HarnessGEO 正本，并在分发正本中绑定封面/正文图的 approved asset_id、用途权限、渠道图片要求和标题映射 |

---

## 四、完整流程图

```text
strategy_pack_v{N}.json
        ↓
E0 导入策略包 + 企业提交图片库 / 校验图片库 / 建立 execution_context / 建立 image_registry
        ↓
E1 内容菜单 / Content Brief
        ↓
暂停5 选题审批内容方向
        ↓
获批 Brief 逐篇生产循环：
  E2 生成 1 篇无文章标题正文 + 5 个目的驱动标题（A类匹配确认GEO问题；对话打印）+ 图片需求
        ↓
  E3 生成视觉资产
        ↓
  E4 审查正文 / 图片 / 标题池并组装无文章标题 DOCX/MD
        ↓
全部获批文章通过 E4 后
        ↓
E5 无文章标题 HarnessGEO 正本优化 + S5/S9 渠道建议 + 合规审查报告 + 标题池（对话可见）
        ↓
E5-END 继续生产确认：
  A. 不继续 → 执行层结束并输出最终交付包
  B. 继续当前菜单中尚未生产的文章 → 回暂停5（选题审批）
  C. 制作其他文章类型或新选题 → 回 E1
  D. 策略口径需要调整 → 返回策略层重新确认
```

---

## 五、输出物清单

| 类别 | 文件 | 生成者 |
|------|------|--------|
| 核心素材清单 | `E1_{brand}_内容菜单.md` | E1 |
| Content Brief | `E1_{brand}_content_briefs.json` | E1 |
| 无文章标题正文 | `E2_{brand}_{article_id}_article.md` | E2 |
| 5 标题备选 | `E2_{brand}_{article_id}_title_options.json` | E2 |
| 标题验证报告 | `E2_{brand}_{article_id}_title_validation.txt` | E2 |
| 图片需求单 | `E2_{brand}_{article_id}_image_requirements.json` | E2 |
| 配图文件 | `E3_{brand}_{article_id}_visual_assets/` | E3 |
| 终稿 DOCX | `E4_{brand}_{article_id}_final.docx` | E4 |
| 终稿 MD | `E4_{brand}_{article_id}_final.md` | E4 |
| 审核后标题池 | `E4_{brand}_{article_id}_title_options_reviewed.json` | E4 |
| 标题验证报告 | `E4_{brand}_{article_id}_title_validation.txt` | E4 |
| 审查报告 | `E4_{brand}_{article_id}_review_report.md` | E4 |
| 无文章标题 HarnessGEO 优化正本 | `E5_{brand}_{article_id}_harnessgeo_optimized.md/.docx` | E5 |
| HarnessGEO 优化报告 | `E5_{brand}_{article_id}_harnessgeo_report.json` | E5 |
| 合规审查报告 | `E5_{brand}_compliance_report.md` | E5 |
| 交付清单 | `E5_{brand}_delivery_manifest.json` | E5 |
| 企业提交图片库 Manifest | `E0_{brand}_submitted_image_library_manifest.json` | E0 |
| 图片库校验报告 | `E0_{brand}_image_library_validation_report.md` | E0 |
| 图片库检索索引 | `E0_{brand}_image_library_index.json` | E0 |
| 缺图补充需求 | `E3_{brand}_{article_id}_missing_client_image_request.json` | E3（如缺图） |
| 图片注册表 | `E0_{brand}_image_registry.json` | E0 |
| 展示页 | `E0_{brand}_FrontMind全链路展示.html` | E0 |
| 全量包 | `E0_{brand}_FrontMind全链路产出.zip` | E0 |

---

## 六、E5-END 继续生产确认边界

E5 是单轮内容生产的最后业务节点。E5 完成后，E0 不直接硬退出，而是必须询问是否继续基于当前 strategy_pack 制作更多内容。

E5 必须完成：

1. 对每篇 E4 无文章标题终稿强制生成 1 篇无文章标题 HarnessGEO 优化正本；
2. 输出 HarnessGEO 优化报告和运行日志；
3. 基于 S5 信源诊断与 S9 业务建议给出渠道推荐；
4. 区分内容发布渠道与信源建设渠道；
5. 从 E4 审核通过的 5 个标题中为每个渠道选择标题，并在 E5 交付消息中打印标题池/标题映射；
6. 输出 HarnessGEO 优化正本和合规审查报告。

E5 与 E0 后续确认均不做：

```text
不等待渠道确认
不实际投放
不监测发布效果
不生成回流文件
不进入其他后续模块
不把继续生产确认误用为渠道确认
```

---

## 七、常见问题

**Q1：策略包格式不正确怎么办？**  
运行 `python -m json.tool strategy_pack_v{N}.json` 检查 JSON 合法性。如有字段缺失，需返回策略层补充。

**Q2：E4 审查不通过怎么办？**  
E0 会按问题归因打回 E2、E3 或 E4 自修。若超过打回上限仍无法通过，E0 会暂停并请求人工决策。

**Q3：为什么删除渠道确认暂停？**  
执行层只输出分发编排包，不负责实际投放、预算、渠道采购或外部合作确认。渠道确认应由后续投放运营层处理。

**Q4：为什么 E5 还要优化正文？**  
E4 的职责是内容质检和组装；E5 的职责是将 E4 无文章标题终稿转成更适合 AI 搜索、问答引擎和第三方信源引用的无文章标题 HarnessGEO 优化正本。


**Q5：继续生产时为什么有时回暂停5（选题审批），有时回 E1？**  
如果只是继续制作当前 E1 菜单里尚未生产的文章，应该回暂停5（选题审批） 继续审批/选择 Brief；如果要新增文章类型、新选题或新方向，则必须回 E1 重新生成 Content Brief，再进入 暂停5 选题审批。


## 八、多轮内容生产规则

当用户在 E5 后选择继续制作时，E0 必须维护 `execution_cycle_id`，避免下一轮文件覆盖上一轮产物。

```text
E5 完成 → E0 询问是否继续
  ├─ 选择 B：回到 暂停5，从当前 E1 内容菜单里继续审批未生产 Brief
  ├─ 选择 C：回到 E1，基于同一 strategy_pack 生成增量内容菜单
  └─ 选择 A/D：结束本轮执行层
```

选择回到 E1 时，E1 必须读取 `completed_article_ids`、`completed_content_types` 和上一轮 E5 分发摘要，避免重复生成已经完成的选题。每一轮新增 Brief 仍必须经过 暂停5 选题审批后才能进入 E2/E3/E4/E5。

---

## 九、V11 三类潜在风险修复规则

执行层在 V11 中新增 `shared/publication-risk-repair-policy.md`，并要求 E1/E2/E3/E4 同步执行：

1. **A 类自然媒体稿**：A1-A12 不得出现“本文采用口径”“搜索……用户真正想问”“资料来源与口径说明”“可验证证据包括”等内部思考或审稿话术；A1 继续分为 A1-多品类 多机构真实竞品对比型与 A1-单品类 单品牌深度推荐型。
2. **B 类权威资产防软文**：B1-B4 必须以研究、技术、案例或用例证据建立权威，不得使用“哪家好、推荐榜、优先咨询、首选、免费评估”等 A 类或销售表达。
3. **C 类媒体稿防广告**：C1a-C4 必须保持新闻、品牌报道、行业评论或事实回应语气，不得写成推荐稿、导购稿、销售页或第二人称推销。
4. **A 类首图终稿化**：A 类图1、品牌海报、推荐封面必须由 `gpt-image-2` 或批准的同级图像模型生成终稿；HTML/CSS/PPT 草图不得进入最终 DOCX。

E4 新增 `Gate 6.5D` 专项审查，任一项未通过不得组装最终 ZIP。
