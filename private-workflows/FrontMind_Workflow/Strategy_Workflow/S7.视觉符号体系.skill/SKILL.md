---
name: frontmind-supersign-engine
description: >
  S7 视觉符号体系（策略层第 7 位 / 视觉资产中枢）。输出可直接喂给 Lovart / Midjourney /
  即梦 / Sora 的视觉 Prompt 包 JSON，以及视觉符号体系报告。
  v2.6 升级：以 S1 留存的真实视觉资产（Logo/配色/截图）作为刚性约束输入，
  杜绝"纯文本盲绘"导致的品牌视觉失真。
  适用场景：S6 品牌话语体系完成后触发。
---

# 视觉符号体系 (Visual Symbol System)

从品牌定位和话语体系出发，**以 S1 留存的真实视觉资产为刚性约束**，构建品牌的**视觉符号体系系统**——包括视觉语言定义和可直接执行的 AI 绘画 Prompt 包，让品牌在 AI 时代拥有统一、可复制、可扩展的视觉资产体系。

> **★ v2.6 核心升级**：S7 不再从纯文本语义推导视觉元素。所有视觉决策（色彩、符号、构图）必须优先锚定 S1 留存的真实视觉资产——包括 Logo 文件、提取的品牌色、官网截图。只有在 S1 视觉资产清单为空时，才退化为纯文本推导模式（并在报告中明确标注"无视觉约束，纯推导模式"）。

**上游**：
- `S4_{brand}_定位声明.json`（S4）+ `S6_{brand}_话语token.json`（S6）
- **`S1_{brand}_视觉资产清单.json`（S1 视觉资产清单）** ← v2.6 新增刚性输入
- **`visual_assets/` 目录（S1 留存的物理图片文件）** ← v2.6 新增刚性输入
- `S1_{brand}_品牌事实图谱.json`（S1 事实图谱，含 `brand_assets` 字段）

**下游**：`S7_{brand}_视觉Prompt包.json` + `S7_{brand}_视觉符号体系报告.md` （PDF 由 S0 统一生成） → S8 问答架构师、S9 业务赋能规划师、E3 视觉资产生成师

---

## 标准输入输出文件

**输入文件**：

| 输入项 | 文件名规范 | 来源 | 必要性 |
| :--- | :--- | :--- | :--- |
| 品牌定位声明 | `S4_{brand}_定位声明.json` | S4 | **必须** |
| 话语 Token | `S6_{brand}_话语token.json` | S6 | **必须** |
| **视觉资产清单** | **`S1_{brand}_视觉资产清单.json`** | **S1** | **★ 必须（v2.6 刚性输入）** |
| **视觉资产文件目录** | **`visual_assets/`** | **S1** | **★ 必须（v2.6 刚性输入）** |
| 品牌事实图谱 | `S1_{brand}_品牌事实图谱.json` | S1 | **必须** |
| Gap 报告 | `S5_{brand}_Gap报告.md` | S5 | 建议 |

**输出文件**：

| 输出物 | 文件名规范 | 格式 | 下游消费者 |
| :--- | :--- | :--- | :--- |
| 视觉 Prompt 包 | `S7_{brand}_视觉Prompt包.json` | JSON | E3 视觉资产生成师 |
| 视觉符号体系报告 | `S7_{brand}_视觉符号体系报告.md` | Markdown | 操作者、客户、S8/S9 |
| 视觉符号体系报告 PDF | `S7_{brand}_视觉符号体系报告.pdf` | PDF | 操作者、客户 |
| 视觉契合度评分（A 分支） | `{brand}_视觉契合度评分.md` | Markdown | 客户 |
| 局部重绘 Prompt（A 分支） | `{brand}_局部重绘Prompt.json` | JSON | E3 |

---

## 绝对禁止事项

1. **禁止忽略 S1 视觉资产清单**：如果 `S1_{brand}_视觉资产清单.json` 存在且包含 Logo 文件，**禁止**自行想象或重新定义 Logo 的视觉形态。必须以真实 Logo 为基础进行视觉体系设计。
2. **禁止抛弃企业现有资产**：除非用户明确要求彻底重塑，否则必须将企业现有的 Logo、标准色、核心图形作为视觉体系的基石（资产继承原则）。
3. **禁止色彩凭空臆造**：品牌色必须优先使用 S1 视觉资产清单中 `extracted_palette.dominant_colors` 的真实色值。只有在无任何提取色值时，才可基于行业惯例和品牌人格推导色彩。
4. **禁止元素堆砌与过度复杂化**：视觉符号体系必须是"少而精"的，禁止在一条 Prompt 中堆砌超过 3 个核心视觉元素。
5. **禁止输出无色彩约束的 Prompt**：每条 Prompt 必须包含品牌色 hex 值。
6. **禁止 Prompt 与定位脱节**：所有视觉描述必须可追溯到 S4 定位和 S6 话语。
7. **禁止生成过多低质 Prompt**：Prompt 数量必须控制在 3-5 个核心视觉母题（Visual Motifs）内，重质不重量。

---

## 核心要求：思维链（CoT）与视觉资产锚定

在构建视觉 Prompt 时，必须在思考过程中显式输出以下思维链（CoT）：

### CoT-0：视觉资产清单审查（v2.6 新增，最高优先级）

在进行任何视觉推导之前，**必须先审查 S1 视觉资产清单**：

```
[视觉资产审查]
├── Logo 文件是否存在？ → 是/否（文件路径：visual_assets/logo_001.png）
├── Logo 主色调是什么？ → #1B4F72（从 extracted_palette.from_logo 获取）
├── 官网配色是什么？ → #1B4F72(42次), #E67E22(18次)（从 extracted_palette.from_website 获取）
├── 推测品牌主色？ → #1B4F72（从 extracted_palette.primary_color_guess 获取）
├── 字体线索？ → PingFang SC, Helvetica Neue（从 typography_hints 获取）
├── 官网截图是否存在？ → 是/否（文件路径：visual_assets/screenshot_homepage.png）
└── 视觉资产评分？ → 4.0/5.0（从 S1 缺口报告获取）
```

**基于审查结果确定工作模式**：

| 视觉资产评分 | 工作模式 | 色彩来源 | 符号来源 |
| :--- | :--- | :--- | :--- |
| ≥ 3.0 | **约束模式**（正常） | 从 Logo/官网提取的真实色值 | 从真实 Logo 形态延展 |
| 1.0-2.9 | **半约束模式** | 提取色值 + 行业推导补充 | 从品牌名含义 + 行业惯例推导 |
| < 1.0 | **纯推导模式**（退化） | 完全基于行业惯例推导 | 完全基于语义推导 |

> **★ 关键规则**：在约束模式下，S7 输出的 `color_hex` 必须以 S1 提取的真实色值为主。禁止用"感觉更合适"的理由替换真实品牌色。

### CoT-1：视觉隐喻推导

说明如何将抽象的品牌价值转化为具体的视觉元素。**必须标注推导的锚定来源**：

```
[视觉隐喻推导]
├── 品牌核心价值："安全、专业、引领"（来源：S4 定位声明）
├── 真实 Logo 形态：指南针图形（来源：S1 视觉资产清单 logo_001.png）  ← v2.6 锚定
├── 视觉隐喻：指南针 → 方向引领 → 北极星光芒
├── 锚定说明：保留 Logo 中的指南针核心形态，将其延展为"北极星"意象
└── 禁止：不得将 Logo 重新想象为其他不相关的图形（如树、山、盾牌）
```

### CoT-2：构图与光影设定

解释为什么选择特定的构图和光影。

### CoT-3：工具特性适配

针对 Midjourney v6、Flux.1 和 SDXL 的不同特性，说明 Prompt 参数调整的理由。

**主流 AI 绘图工具特定参数后缀（必须包含）**：

| 工具 | 核心参数语法 | 适用场景 | 示例后缀 |
| :--- | :--- | :--- | :--- |
| **Midjourney v6** | `--ar` (比例), `--stylize` (风格化), `--v 6.0`, `--style raw` | 高质感摄影、艺术插画 | `--ar 16:9 --stylize 250 --v 6.0 --style raw` |
| **Flux.1** | 自然语言极强，无需复杂负面词，支持精准文字渲染 | 包含品牌文字的海报、复杂多元素融合 | `Text "BRAND" clearly visible, highly detailed, 8k resolution` |
| **SDXL** | 权重语法 `(keyword:1.5)`，强依赖负面词 | 需要精准控制特定元素权重的场景 | `(brand color #6B21A8:1.3), masterpiece, best quality` |

---

## A/B 双分支逻辑（v2.6 升级）

v2.6 的 A/B 分支判断不再依赖"用户是否上传了 Logo"的口头询问，而是**基于 S1 视觉资产清单的客观数据**自动判断：

| 条件 | 触发分支 | 核心任务 |
| :--- | :--- | :--- |
| S1 视觉资产清单中 `has_logo == true` | **分支 A** | 以真实 Logo 为锚点评估视觉契合度 + 输出改进建议 + 局部重绘 Prompt |
| S1 视觉资产清单中 `has_logo == false` | **分支 B** | 从 S4 定位出发设计全新视觉语言 + 输出完整 Prompt 包 |

> **注意**：即使触发分支 B，如果 S1 抓取到了 Favicon 或官网配色，这些信息仍然必须作为色彩约束输入。

---

## 工作流程

### Step 0：加载视觉资产清单（v2.6 新增，强制执行）

在进行任何视觉推导之前，**必须先加载并解析 S1 视觉资产清单**：

```python
import json
import os

# 加载视觉资产清单
manifest_path = f"S1_{brand}_视觉资产清单.json"
if os.path.exists(manifest_path):
    with open(manifest_path, "r") as f:
        visual_manifest = json.load(f)
    
    has_logo = visual_manifest.get("summary", {}).get("has_logo", False)
    primary_color = visual_manifest.get("extracted_palette", {}).get("primary_color_guess")
    dominant_colors = visual_manifest.get("extracted_palette", {}).get("dominant_colors", [])
    logo_files = visual_manifest.get("assets", {}).get("logos", [])
    screenshots = visual_manifest.get("assets", {}).get("screenshots", [])
    typography_hints = visual_manifest.get("typography_hints", [])
    
    # 确定工作模式
    score = visual_manifest.get("summary", {}).get("total_assets_downloaded", 0)
    if has_logo and len(dominant_colors) > 0:
        work_mode = "constrained"      # 约束模式
    elif len(dominant_colors) > 0:
        work_mode = "semi_constrained"  # 半约束模式
    else:
        work_mode = "inference_only"    # 纯推导模式
else:
    # 视觉资产清单不存在，退化为纯推导模式
    visual_manifest = None
    work_mode = "inference_only"
    print("⚠️ 警告：S1 视觉资产清单不存在，将使用纯推导模式")

# 同时加载事实图谱中的 brand_assets
with open(f"S1_{brand}_品牌事实图谱.json", "r") as f:
    brand_facts = json.load(f)
brand_assets = brand_facts.get("facts", {}).get("brand_assets", {})
```

### Step 1：提取视觉基因

从 S4 定位声明和 S6 话语 Token 中提取视觉基因，**并与 S1 视觉资产进行交叉锚定**：

```python
import json

# 加载定位声明
with open(f"S4_{brand}_定位声明.json", "r") as f:
    positioning = json.load(f)

# 加载话语 Token
with open(f"S6_{brand}_话语token.json", "r") as f:
    verbal = json.load(f)

# 提取视觉基因
visual_genes = {
    "brand_personality": verbal["tone_tokens"]["tone_description"],
    "core_value": positioning["positioning_statement"]["differentiator"],
    "emotional_value": positioning["value_triangle"]["emotional_value"],
    "target_audience": positioning["positioning_statement"]["target_audience"],
    "tone_formal_casual": verbal["tone_tokens"]["formal_casual"],
    "tone_serious_funny": verbal["tone_tokens"]["serious_funny"],
}

# v2.6 新增：将 S1 视觉资产锚定到视觉基因中
visual_genes["anchored_colors"] = {
    "source": "S1_visual_manifest",
    "primary": primary_color,          # 从 S1 提取的真实主色
    "palette": dominant_colors,         # 从 S1 提取的完整色板
    "override_allowed": False           # 禁止覆盖（除非用户明确要求）
}
visual_genes["anchored_logo"] = {
    "has_logo": has_logo,
    "logo_files": [l.get("local_path") for l in logo_files],
    "logo_colors": logo_files[0].get("extracted_colors", []) if logo_files else []
}
visual_genes["anchored_typography"] = typography_hints
```

从语调打分推导视觉调性：

| 语调维度 | 低分（1-2）视觉倾向 | 高分（4-5）视觉倾向 |
| :--- | :--- | :--- |
| 正式度 | 几何、对称、冷色调 | 手绘、不规则、暖色调 |
| 严肃度 | 简约、留白、单色 | 丰富、饱和、多色 |
| 尊重度 | 经典、传统、衬线体 | 前卫、实验、无衬线体 |
| 热情度 | 静态、克制、低对比 | 动态、张力、高对比 |

### Step 2A：分支 A——现有视觉评估（基于 S1 真实资产）

当 S1 视觉资产清单中 `has_logo == true` 时触发。

**v2.6 升级**：评估不再依赖用户临时上传的文件，而是直接使用 S1 已留存的视觉资产文件。

1. **加载 Logo 文件**：从 `visual_assets/` 目录读取 S1 留存的 Logo 文件
2. **加载官网截图**：从 `visual_assets/` 目录读取 S1 留存的官网截图
3. **执行 5 维契合度评估**：

| 评估维度 | 评估方法 | 数据来源 | 评分标准 |
| :--- | :--- | :--- | :--- |
| 色彩契合度 | S1 提取色彩 vs 定位推导色彩 | `extracted_palette` | 0-100 |
| 构图契合度 | 官网截图构图风格 vs 语调推导构图 | `screenshots` | 0-100 |
| 调性契合度 | 整体视觉调性 vs 品牌人格 | Logo + 截图 | 0-100 |
| 符号契合度 | Logo 核心视觉符号 vs 品牌差异点 | `logos` | 0-100 |
| 一致性 | 多张图片之间的视觉一致性 | 全部留存文件 | 0-100 |

输出：
- `{brand}_视觉契合度评分.md`：5 维评分 + 详细分析
- `{brand}_视觉改进清单.md`：具体改进建议
- `{brand}_局部重绘Prompt.json`：针对不达标维度的局部重绘 Prompt

### Step 2B：分支 B——全新视觉语言设计

当 S1 视觉资产清单中 `has_logo == false` 时触发。

**v2.6 注意**：即使无 Logo，如果 S1 抓取到了官网配色或 Favicon，这些信息仍然必须作为色彩约束。
**v2.6.1 修正**：若 `work_mode == "inference_only"`（既无 Logo 也无官网配色），S7 **必须**基于 S4 定位和 S6 调性反向推导一套初始品牌色（Primary Color 及辅色），并将其注入到输出 JSON 的 `visual_asset_summary.inferred_palette` 中，供下游 E3（配图）和外部官网改造团队使用，以弥补视觉资产缺失。

**视觉符号体系推导流程**（参考华与华视觉符号体系方法论）：

1. **文化母体识别**：从品牌所在品类和目标人群的文化背景中，找到一个人人都认识的文化符号
2. **符号私有化**：将文化母体符号与品牌差异点结合，创造品牌专属的视觉符号体系
3. **色彩体系**：**优先使用 S1 提取的真实色值**，不足部分基于品牌人格和行业惯例补充（主色 + 辅色 + 点缀色，均含 hex 值）
4. **构图规则**：定义品牌视觉的构图偏好
5. **风格关键词**：提取 5-8 个视觉风格关键词

> **详细方法论**：参见 `references/visual-symbol-system-method.md`。

### Step 3：构建三层视觉体系与核心视觉母题（Visual Motifs）

参照顶级品牌咨询公司的方法论，视觉体系必须分为清晰的三层，并提炼出 3-5 个核心视觉母题。

**三层视觉体系**：

1. **符号化识别层（Symbolic Identity）**：
   - **资产继承**：**必须基于 S1 留存的真实 Logo 文件**进行规范化使用描述。如无 Logo 则设计新符号。
   - **视觉符号体系**：从文化母体中提取的、能代表品牌核心价值的极简图形。必须极度克制。
2. **主视觉语言层（Primary Visual Language）**：
   - **色彩体系**：**主色必须来自 S1 `extracted_palette.primary_color_guess`**，辅色和点缀色从 `dominant_colors` 中选取或基于色彩理论补充。
   - **辅助图形/纹理**：由视觉符号体系延展出的动态模式或背景纹理。
   - **构图与光影**：定义品牌专属的视觉张力。
3. **品牌情感场景层（Emotional Scenarios）**：
   - 将符号和语言应用到具体的业务场景中，传达品牌的人格与情感。

**核心视觉母题（Visual Motifs）Prompt 包**：

| 母题类型 | 编号 | 核心任务 | 数量要求 |
| :--- | :--- | :--- | :--- |
| 符号化识别演绎 | motif_symbol | 将视觉符号体系或 Logo 融入极简的材质/光影中 | 1-2 条 |
| 核心业务场景 | motif_scenario | 展现品牌核心服务/产品的标志性瞬间 | 1-2 条 |
| 品牌情感意境 | motif_emotion | 抽象表达品牌价值的意境图 | 1 条 |

**每条 Prompt 的必填字段（v2.6 升级，新增 2 个字段）**：

| 字段 | 类型 | 说明 | 示例 |
| :--- | :--- | :--- | :--- |
| `prompt_id` | string | 唯一标识 | "hero_001" |
| `positive_prompt` | string | 正面描述（英文） | "A modern tech office..." |
| `style_keywords` | array | 风格关键词 | ["minimalist", "clean"] |
| `color_hex` | array | 色彩约束（hex 值） | ["#6B21A8", "#1A1A1A"] |
| `color_source` | string | **v2.6 新增**：色彩来源标注 | "S1_extracted" / "inferred" |
| `composition` | string | 构图规则 | "rule of thirds, wide angle" |
| `negative_prompt` | string | 负面词 | "blurry, low quality, text" |
| `reference_assets` | array | **v2.6 新增**：引用的 S1 视觉资产文件路径 | ["visual_assets/logo_001.png"] |

**可选字段**：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `aspect_ratio` | string | 宽高比 |
| `recommended_tool` | string | 推荐 AI 绘画工具 |
| `tool_specific_params` | string | 工具特定参数后缀 |
| `category` | string | 所属类别 |
| `usage_scenario` | string | 使用场景描述 |
| `img2img_reference` | string | **v2.6 新增**：图生图/垫图参考文件路径（供 E3 使用） |

### Step 4：Prompt 语法适配

> **详细语法对照**：参见 `references/ai-image-tool-prompt-syntax.md`。

为每条 Prompt 提供多工具适配版本：

| 工具 | 语法特点 | 适配要点 |
| :--- | :--- | :--- |
| Midjourney v6 | `--ar` `--stylize` `--v 6.0` `--style raw` `--cref` | 必须添加版本和比例参数；**v2.6：如有 Logo 文件，建议使用 `--cref` 角色参考功能** |
| Flux.1 | 自然语言极强，支持文字渲染 | 减少负面词堆砌，直接用自然语言描述 |
| SDXL | 权重语法 `(keyword:1.5)` | 使用权重语法强调品牌核心元素 |
| Lovart | 类似 SD 语法 + 风格预设 | 优先使用平台内置的风格预设 |
| **ControlNet/IP-Adapter** | **v2.6 新增**：图像条件控制 | **如有 Logo 文件，建议 E3 使用 IP-Adapter 将 Logo 风格注入生成图** |

### Step 5：校验与输出

```bash
# 校验 Prompt 包
python3 S7.视觉符号体系.skill/scripts/prompt_pack_validator.py S7_{brand}_视觉Prompt包.json

# 不生成 PDF；PDF 由 S0 仅在 S10 品牌信息确认表完成后用户确认需要时统一生成
```

---

## Prompt 包 JSON 结构示例（v2.6）

```json
{
  "meta": {
    "brand": "{brand}",
    "version": "2.6",
    "generated_at": "2026-04-28",
    "branch": "A",
    "work_mode": "constrained",
    "total_prompts": 4,
    "visual_asset_manifest": "S1_{brand}_视觉资产清单.json"
  },
  "visual_asset_summary": {
    "logo_file": "visual_assets/logo_001.png",
    "logo_colors": ["#1B4F72", "#E67E22"],
    "primary_color": "#1B4F72",
    "dominant_palette": ["#1B4F72", "#E67E22", "#F4F6F7"],
    "color_source": "S1_extracted",
    "typography_hints": ["PingFang SC", "Helvetica Neue"],
    "screenshot_homepage": "visual_assets/screenshot_homepage.png"
  },
  "visual_identity": {
    "layer_1_symbolic": {
      "asset_inheritance": "保留 S1 留存的深蓝色指南针 Logo（visual_assets/logo_001.png），Logo 主色 #1B4F72 作为品牌核心识别色",
      "super_sign": "从 Logo 中的指南针形态延展出'北极星'光芒符号，象征指引与希望"
    },
    "layer_2_language": {
      "primary_color": {"hex": "#1B4F72", "source": "S1_extracted_from_logo"},
      "secondary_colors": [
        {"hex": "#F4F6F7", "source": "S1_extracted_from_website"},
        {"hex": "#1A1A1A", "source": "inferred_neutral"}
      ],
      "accent_color": {"hex": "#E67E22", "source": "S1_extracted_from_logo"},
      "composition_preference": "大面积留白，中心对称，强调秩序感与专业度",
      "style_keywords": ["minimalist", "authoritative", "warm-light", "clean"]
    },
    "layer_3_emotion": {
      "core_vibe": "专业、可靠、充满希望的升学引路人"
    }
  },
  "visual_motifs": [
    {
      "motif_id": "motif_symbol_01",
      "motif_type": "符号化识别演绎",
      "positive_prompt": "Minimalist abstract macro photography, a subtle glowing 'North Star' compass symbol embossed on premium matte navy blue paper (#1B4F72), warm golden accent light (#E67E22) hitting the edge, clean white background (#F4F6F7), extreme close-up, elegant, professional, corporate identity, high-end editorial style",
      "style_keywords": ["minimalist", "macro", "embossed", "premium"],
      "color_hex": ["#1B4F72", "#E67E22", "#F4F6F7"],
      "color_source": "S1_extracted",
      "composition": "center focused, macro shot, generous negative space",
      "negative_prompt": "blurry, low quality, text, watermark, cluttered, complex shapes, people, buildings, 3D render, cheap",
      "reference_assets": ["visual_assets/logo_001.png"],
      "img2img_reference": "visual_assets/logo_001.png",
      "aspect_ratio": "16:9",
      "recommended_tool": "Midjourney",
      "tool_specific_params": "--ar 16:9 --stylize 250 --v 6.0 --style raw --cref visual_assets/logo_001.png",
      "usage_scenario": "品牌主视觉 / 官网首屏背景"
    }
  ]
}
```

---


---

## 产出交付规则（v2.6.2 新增）

**必须执行**：本节点的所有源文件（JSON/MD/Prompt 包/图片资产等）生成并校验通过后，**必须立即使用 `message` 工具（type="info" 或 type="result"）将源文件作为附件发送给用户**。PDF 不在本节点内生成，统一由 S0 在 S10 品牌信息确认表完成后按用户确认生成。
**禁止暂停**：发送产出后，**禁止**等待用户确认（除非遇到硬性错误或到达预设的全局暂停点），必须立即通知 S0 编排师继续执行下一个节点。

## 校验闸门

| 序号 | 校验条件 | 不达标动作 |
| :--- | :--- | :--- |
| 1 | Prompt 总数在 3-5 条之间，且 `visual_identity` 包含三层结构 | 打回重做 |
| 2 | 每条 Prompt 必填字段齐全（含 v2.6 新增的 `color_source` 和 `reference_assets`） | 打回补充 |
| 3 | **约束模式下，`color_hex` 中至少 1 个色值来自 S1 提取的真实色值** | **打回修复色彩** |
| 4 | 每条 Prompt 包含 `negative_prompt` | 打回补充 |
| 5 | A 分支 5 维契合度评分齐全 | 打回补充 |
| 6 | Prompt 包通过 schema 校验 | 修复后重新校验 |
| 7 | **视觉符号体系报告 MD 存在且非空；PDF 不作为 S7 完成条件** | **强制打回重做** |
| 8 | **`meta.work_mode` 正确反映当前视觉资产状态** | 修复 meta 信息 |
| 9 | **`visual_asset_summary` 与 S1 视觉资产清单数据一致** | 打回修复 |

---

## 子文件引用

| 文件路径 | 用途 | 引用时机 |
| :--- | :--- | :--- |
| `references/visual-symbol-system-method.md` | 视觉符号体系方法论 | Step 2B |
| `references/ai-image-tool-prompt-syntax.md` | AI 绘画工具 Prompt 语法对照 | Step 4 |
| `templates/visual_prompt_pack_schema.json` | Prompt 包 JSON Schema（v2.6 含新字段） | Step 5 校验 |
| `scripts/prompt_pack_validator.py` | Prompt 包校验器（v2.6 含视觉资产校验） | Step 5 |
| `scripts/clip_similarity_scorer.py` | CLIP 相似度评分器（A 分支） | Step 2A |
