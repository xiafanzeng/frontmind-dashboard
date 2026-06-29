# 品牌话语 Token Schema (Brand Voice Token Schema)

> 本文档定义策略包中 S6 话语 Token 的数据结构，供执行层所有 Agent 统一引用。

---

## 一、Schema 总览

S6 话语 Token 是策略工作流输出的品牌语言约束文件，以 JSON 格式存储，供执行层主线 E1-E5 在内容生产过程中引用。

```json
{
  "$schema": "frontmind-brand-voice-token-v1",
  "brand": "{brand_name}",
  "version": "{version}",
  "updated_at": "{iso_datetime}",
  "voice_profile": { ... },
  "vocabulary": { ... },
  "forbidden_words": [ ... ],
  "tone_rules": { ... },
  "style_guide": { ... }
}
```

---

## 二、字段详细定义

### 2.1 voice_profile（品牌语音画像）

| 字段 | 类型 | 说明 | 示例 |
| :--- | :--- | :--- | :--- |
| `personality` | string[] | 品牌人格特征（3-5个） | ["专业", "可信赖", "创新"] |
| `tone` | string | 整体语气 | "专业权威但不冰冷" |
| `formality` | number | 正式度（1-10） | 7 |
| `warmth` | number | 温暖度（1-10） | 5 |
| `confidence` | number | 自信度（1-10） | 8 |
| `target_reading_level` | string | 目标阅读水平 | "大学本科" |

```json
{
  "voice_profile": {
    "personality": ["专业", "可信赖", "创新", "务实"],
    "tone": "专业权威但不冰冷，用数据说话",
    "formality": 7,
    "warmth": 5,
    "confidence": 8,
    "target_reading_level": "大学本科"
  }
}
```

### 2.2 vocabulary（品牌词库）

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `preferred_terms` | object[] | 首选用词（替代通用词） |
| `brand_terms` | object[] | 品牌专有术语 |
| `industry_terms` | object[] | 行业术语（需解释） |
| `abbreviations` | object[] | 缩写对照表 |

```json
{
  "vocabulary": {
    "preferred_terms": [
      {
        "preferred": "检测认证",
        "avoid": ["检验检测", "测试认证"],
        "context": "泛指行业时使用"
      },
      {
        "preferred": "解决方案",
        "avoid": ["产品", "服务"],
        "context": "描述综合服务时使用"
      }
    ],
    "brand_terms": [
      {
        "term": "{brand_product_name}",
        "definition": "品牌旗舰产品名称",
        "usage": "首次出现时使用全称，后续可简称"
      }
    ],
    "industry_terms": [
      {
        "term": "GEO",
        "full_name": "Generative Engine Optimization",
        "chinese": "生成式引擎优化",
        "usage": "首次出现时标注全称"
      }
    ],
    "abbreviations": [
      {
        "abbr": "TIC",
        "full": "Testing, Inspection and Certification",
        "chinese": "检测、检验与认证"
      }
    ]
  }
}
```

### 2.3 forbidden_words（禁用词列表）

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `forbidden_words` | string[] | 绝对禁止使用的词汇 |
| `restricted_words` | object[] | 限制使用的词汇（需满足条件） |

```json
{
  "forbidden_words": [
    "最好", "第一", "唯一", "绝对", "100%",
    "震惊", "不看后悔", "必看",
    "竞品品牌名A", "竞品品牌名B"
  ],
  "restricted_words": [
    {
      "word": "领先",
      "condition": "必须有数据支撑",
      "example": "在XX领域市场占有率领先（数据来源：XX报告）"
    },
    {
      "word": "全球",
      "condition": "必须有国际业务实证",
      "example": "全球XX个国家和地区设有分支机构"
    }
  ]
}
```

### 2.4 tone_rules（语气规则）

```json
{
  "tone_rules": {
    "by_content_type": {
      "A1_industry_review": {
        "tone": "客观分析，数据驱动",
        "first_person": false,
        "data_citation": "required"
      },
      "A2_tech_explainer": {
        "tone": "专业但易懂，循序渐进",
        "first_person": false,
        "analogy_usage": "encouraged"
      },
      "A4_case_study": {
        "tone": "叙事性，展示成果",
        "first_person": false,
        "client_voice": "quoted"
      },
      "A5_brand_story": {
        "tone": "温暖自信，品牌人格化",
        "first_person": true,
        "emotional_appeal": "moderate"
      },
      "C1b_press_release": {
        "tone": "正式客观，新闻体",
        "first_person": false,
        "quote_required": true
      }
    },
    "universal_rules": [
      "避免使用感叹号（除引用语外）",
      "避免使用网络流行语和 meme",
      "数据必须标注来源",
      "避免绝对化表述",
      "使用主动语态优先"
    ]
  }
}
```

### 2.5 style_guide（文体指南）

```json
{
  "style_guide": {
    "paragraph_length": {
      "min": 80,
      "max": 200,
      "unit": "字"
    },
    "sentence_length": {
      "avg": 25,
      "max": 50,
      "unit": "字"
    },
    "heading_style": "陈述句或名词短语，不使用问句（除知乎标题外）",
    "number_format": {
      "large_numbers": "使用万/亿单位，如 1.2 亿",
      "percentages": "保留一位小数，如 23.5%",
      "currency": "人民币使用¥，美元使用$"
    },
    "citation_style": "文内标注来源名称和年份，如（Frost & Sullivan, 2025）",
    "image_caption_style": "图X：描述性标题（数据来源：XX）"
  }
}
```

---

## 三、执行层引用方式

各执行层 Agent 引用 S6 话语 Token 的标准方式：

```python
import json

# 加载 S6 话语 Token
with open(f"{brand}_话语Token.json", "r", encoding="utf-8") as f:
    s6 = json.load(f)

# 获取禁用词
forbidden = s6["forbidden_words"]

# 获取首选用词
preferred = s6["vocabulary"]["preferred_terms"]

# 获取语气规则
tone = s6["tone_rules"]["by_content_type"]["A1_industry_review"]
```

---

## 四、验证规则

| 检查项 | 规则 | 适用 Agent |
| :--- | :--- | :--- |
| 禁用词 | 文章中不得出现 `forbidden_words` 中的任何词汇 | E2, E4, E5 |
| 首选用词 | `avoid` 列表中的词汇应替换为 `preferred` | E2, E4 |
| 语气匹配 | 文章语气应符合对应 `content_type` 的 `tone` 规则 | E2, E4 |
| 数据引用 | 当 `data_citation` 为 `required` 时，所有数据必须标注来源 | E2, E4 |
| 段落长度 | 段落字数应在 `style_guide.paragraph_length` 范围内 | E2, E4 |
