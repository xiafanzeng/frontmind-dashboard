# FrontMind 企业提交图片库使用规范

> **适用范围**：执行层 E0-E5。本文档定义“企业实图”的唯一来源、引用、降级和审查规则。

---

## 一、核心原则

执行层启动时，输入不再只有策略包。**除 `strategy_pack_v{N}.json` 外，必须同时上传企业自己确认的图片库**，并由 E0 校验通过后才能进入 E1。

企业提交图片库是执行层视觉资产的第二个 SSOT：

1. **策略包**提供品牌定位、话语、问题路径、视觉风格方向；
2. **企业提交图片库**提供可被文章真实使用的实拍图、Logo、证书、案例、门店/办公室/团队/产品等素材。上传即视为本项目素材提交，不再要求额外填写 `image_library_manifest.json` 确认步骤。

S1/S7 中的视觉信息只能作为风格、事实和提示词参考，**不能替代客户提交图片库**。官网抓取图、搜索图、模型生成图都不能被冒充为“企业实图”。

---

## 二、启动输入要求

执行层启动前必须存在以下任一形式：

```text
Client_Submitted_Image_Library.zip
# 或
client_submitted_image_library/
```

推荐目录结构：

```text
client_submitted_image_library/
├── images/
│   ├── product/                           # 产品/服务实拍
│   ├── team/                              # 团队/创始人/顾问
│   ├── office/                            # 办公室/门店/环境
│   ├── certificate/                       # 资质/证书/授权
│   ├── case/                              # 案例/活动/客户现场
│   ├── event/                             # 发布会/媒体活动/展会
│   └── brand/                             # Logo/品牌物料/VI
├── usage_rights/                          # 可选，授权说明/版权证明
└── image_library_manifest.json            # 可选，不再必填
```

`image_library_manifest.json` 现在是**可选元数据文件**：

- 有 manifest：E0 读取其中的图片描述、用途、权限和推荐文章类型；
- 无 manifest：E0 自动扫描图片库，按目录名和文件名推断 asset_type、scene_keywords、visual_roles，并生成标准化 manifest；
- 用户上传图片库即视为“本项目可用素材提交”，不再要求额外提交图片库。

## 三、图片条目字段

E0 标准化输出中每张图片会被登记为：

```json
{
  "asset_id": "product_photo_001",
  "file_path": "images/product/product_photo_001.jpg",
  "asset_type": "product_photo",
  "description": "产品实拍图，适合品牌介绍首图或正文产品场景",
  "scene_keywords": ["产品实拍", "品牌展示"],
  "quality_grade": "high",
  "client_approved": true,
  "rights_status": "client_submitted_for_project",
  "allowed_usage": ["article", "docx", "media_submission", "social_distribution"],
  "restricted_contexts": [],
  "people_release_status": "not_applicable",
  "recommended_article_types": ["A", "B", "C"],
  "visual_roles": ["cover", "body", "certificate", "case_proof"]
}
```

### 3.1 asset_type 枚举

| 类型 | 用途 |
|---|---|
| `product_photo` | 产品、服务、设备、包装等实拍 |
| `team_photo` | 团队、创始人、专家、顾问 |
| `office_photo` | 办公室、门店、校区、展厅、工厂 |
| `certificate_photo` | 资质证书、授权书、奖项、证明材料 |
| `case_photo` | 客户案例、项目现场、活动现场 |
| `event_photo` | 发布会、展会、论坛、签约仪式 |
| `brand_material` | Logo、VI、品牌海报、手册截图 |
| `founder_photo` | 创始人/名人/IP 官方肖像 |
| `media_clip` | 媒体报道截图、官网截图、权威页面截图 |
| `service_scene` | 服务过程、咨询场景、交付场景 |
| `environment_photo` | 空间环境、校区/医院/门店/实验室 |

---

## 四、文章类型与图片来源约束

| 文章类型 | 图片策略 |
|---|---|
| A 类 GEO 文章 | 标题由 GEO 问题驱动；图片以数据图 + 客户提交实图为主。若首图为 AIGC 品牌海报，必须引用客户提交 Logo/品牌物料，不得伪造真实场景。 |
| B 类权威资产 | 案例图、产品图、证书图、技术/流程图必须来自客户提交图片库；数据图可由 Python 生成。 |
| C1a 事件新闻 | 事件现场、签约、发布会、活动图必须来自客户提交图片库；缺图则输出补图需求，不得用网图冒充。 |
| C1b 品牌深度稿 | 首图、团队/环境/证书/服务场景优先来自客户提交图片库；图片承担品牌可信背书作用。 |
| C2 媒体背书稿 | 媒体截图、报道截图、权威页面截图必须来自客户提交图片库或可核验来源，并记录来源。 |
| C3 行业评论稿 | 可使用数据图/信息图；涉及企业场景或团队时必须用客户提交图。 |
| C4 危机公关稿 | 图片极度克制，原则上只使用客户提交 Logo/声明图，不使用装饰性 AIGC。 |
| D 类知识/矫正 | 词条、地图、企业信息平台图片必须优先使用客户提交 Logo、门头、环境、证书、产品等素材。 |

---

## 五、强制阻断规则

以下情况必须阻断，不得降级绕过：

1. 文章 Brief 或 E2 图片需求标记 `requires_client_submitted_asset=true`，但 E3 找不到匹配素材；
2. 图片元数据中缺少 `source_asset_id` 或显式标记 `client_submitted=false`，却被作为 `enterprise_photo`、`brand_photo`、`certificate_photo`、`team_photo` 使用；
3. 使用网络图、图库图、AIGC 图表现企业真实团队、证书、案例、门店、医生/专家、工厂、客户现场；
4. 图片权利字段缺失，或 `rights_status` 为 `unknown` / `restricted_not_allowed`；
5. E4 发现图片语义与正文中“实拍/现场/授权/案例/团队”等事实性表达不一致。

阻断时输出：

```text
E3_{brand}_{article_id}_missing_client_image_request.json
```

列明缺少哪些图片、建议客户补充什么素材、可替代的图表/示意图是否允许。

---

## 六、向后流转字段

从 E0 到 E5，图片库信息必须一路保留：

```json
{
  "image_library_manifest_path": "E0_{brand}_submitted_image_library_manifest.json",
  "image_library_sha256": "sha256:...",
  "approved_asset_ids": ["product_photo_001", "certificate_002"],
  "requires_client_submitted_asset": true,
  "source_asset_id": "product_photo_001",
  "client_submitted": true,
  "rights_status": "client_submitted_for_project",
  "allowed_usage": ["article", "docx", "media_submission"]
}
```

E5 的分发正本必须确保所有图片已物理嵌入且来源可追溯，确保后续渠道执行知道哪些图片可用于投稿、社媒、官网或企业信息平台。
