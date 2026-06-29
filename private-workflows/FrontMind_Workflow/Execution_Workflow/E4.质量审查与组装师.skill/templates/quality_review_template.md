# 质量审查报告：{{ARTICLE_ID}} — {{ARTICLE_TITLE}}

> **品牌**：{{BRAND_NAME}}
> **文章类型**：{{ARTICLE_TYPE}}
> **审查时间**：{{REVIEW_TIMESTAMP}}
> **审查员**：E4 质量审查与组装师

---

## 总体评价

| 维度 | 得分 | 权重 | 加权分 | 等级 | 通过 |
|:---|:---|:---|:---|:---|:---|
| 文字审查 | {{TEXT_SCORE}} / 100 | 40% | {{TEXT_WEIGHTED}} | {{TEXT_GRADE}} | {{TEXT_PASS}} |
| 图片审查 | {{IMAGE_SCORE}} / 100 | 25% | {{IMAGE_WEIGHTED}} | {{IMAGE_GRADE}} | {{IMAGE_PASS}} |
| 图文匹配审查 | {{MATCH_SCORE}} / 100 | 20% | {{MATCH_WEIGHTED}} | {{MATCH_GRADE}} | {{MATCH_PASS}} |
| 合规审查 | {{COMPLIANCE_SCORE}} / 100 | 15% | {{COMPLIANCE_WEIGHTED}} | {{COMPLIANCE_GRADE}} | {{COMPLIANCE_PASS}} |
| **加权总分** | | | **{{TOTAL_SCORE}}** | **{{TOTAL_GRADE}}** | **{{OVERALL_PASS}}** |

---

## 一、文字审查详情

### 1.1 字数检查

| 指标 | 数值 |
|:---|:---|
| Brief 要求字数 | {{REQUIRED_WORDS}} |
| 实际字数 | {{ACTUAL_WORDS}} |
| 达标率 | {{WORD_RATE}} |
| 得分 | {{WORD_SCORE}} / 15 |

### 1.2 S6 话语 Token 命中率

| 指标 | 数值 |
|:---|:---|
| Token 总数 | {{TOKEN_TOTAL}} |
| 命中数 | {{TOKEN_HIT}} |
| 命中率 | {{TOKEN_RATE}} |
| 得分 | {{TOKEN_SCORE}} / 15 |

**命中的 Token**：{{HIT_TOKEN_LIST}}

**未命中的 Token**：{{MISS_TOKEN_LIST}}

### 1.3 结构完整性

| 检查项 | 结果 | 得分 |
|:---|:---|:---|
| 结论先行 | {{CONCLUSION_FIRST}} | {{CF_SCORE}} / 3 |
| 章节完整 | {{SECTION_COMPLETE}} | {{SC_SCORE}} / 3 |
| FAQ 区块 | {{FAQ_CHECK}} | {{FAQ_SCORE}} / 2 |
| 附录区块 | {{APPENDIX_CHECK}} | {{AP_SCORE}} / 2 |

### 1.4 内容质量

| 检查项 | 结果 | 得分 |
|:---|:---|:---|
| 事实准确性 | {{FACT_CHECK}} | {{FACT_SCORE}} / 4 |
| 逻辑连贯性 | {{LOGIC_CHECK}} | {{LOGIC_SCORE}} / 3 |
| 重复率 | {{DUP_RATE}} | {{DUP_SCORE}} / 3 |

---

## 二、图片审查详情

### 2.1 技术质量

| 图片 | 文件大小 | 分辨率 | 格式 | 通过 |
|:---|:---|:---|:---|:---|
| {{FIG1_ID}} | {{FIG1_SIZE}} KB | {{FIG1_RES}} | {{FIG1_FMT}} | {{FIG1_TECH_PASS}} |
| {{FIG2_ID}} | {{FIG2_SIZE}} KB | {{FIG2_RES}} | {{FIG2_FMT}} | {{FIG2_TECH_PASS}} |
| {{FIG3_ID}} | {{FIG3_SIZE}} KB | {{FIG3_RES}} | {{FIG3_FMT}} | {{FIG3_TECH_PASS}} |

### 2.2 S7 规范契合度

| 图片 | S7 引用 | 风格一致 | 文字控制 | 通过 |
|:---|:---|:---|:---|:---|
| {{FIG1_ID}} | {{FIG1_S7_REF}} | {{FIG1_STYLE}} | {{FIG1_TEXT}} | {{FIG1_S7_PASS}} |
| {{FIG2_ID}} | {{FIG2_S7_REF}} | {{FIG2_STYLE}} | {{FIG2_TEXT}} | {{FIG2_S7_PASS}} |
| {{FIG3_ID}} | {{FIG3_S7_REF}} | {{FIG3_STYLE}} | {{FIG3_TEXT}} | {{FIG3_S7_PASS}} |

---

## 三、图文匹配审查详情

| 图片 | 图说匹配 | 位置合理 | 通过 |
|:---|:---|:---|:---|
| {{FIG1_ID}} | {{FIG1_CAPTION_MATCH}} | {{FIG1_POS}} | {{FIG1_MATCH_PASS}} |
| {{FIG2_ID}} | {{FIG2_CAPTION_MATCH}} | {{FIG2_POS}} | {{FIG2_MATCH_PASS}} |
| {{FIG3_ID}} | {{FIG3_CAPTION_MATCH}} | {{FIG3_POS}} | {{FIG3_MATCH_PASS}} |

**IMAGE_SLOT 替换检查**：{{SLOT_REPLACE_STATUS}}

---

## 四、合规审查详情

### 4.1 扫描结果

| 违规类型 | 数量 | 扣分 | 详情 |
|:---|:---|:---|:---|
| 极限词 | {{EXTREME_COUNT}} | {{EXTREME_DEDUCT}} | {{EXTREME_DETAIL}} |
| 空话词 | {{EMPTY_COUNT}} | {{EMPTY_DEDUCT}} | {{EMPTY_DETAIL}} |
| 敏感词 | {{SENSITIVE_COUNT}} | {{SENSITIVE_DEDUCT}} | {{SENSITIVE_DETAIL}} |
| 竞品贬损 | {{COMPETITOR_COUNT}} | {{COMPETITOR_DEDUCT}} | {{COMPETITOR_DETAIL}} |
| 偷懒表述 | {{LAZY_COUNT}} | {{LAZY_DEDUCT}} | {{LAZY_DETAIL}} |

### 4.2 合规得分

**合规得分**：{{COMPLIANCE_SCORE}} / 100（需 = 100 才通过）

---

## 五、DOCX 组装结果

| 参数 | 数值 |
|:---|:---|
| WebP quality | {{WEBP_QUALITY}} |
| DOCX 文件大小 | {{DOCX_SIZE}} MB |
| 图片嵌入数 | {{EMBEDDED_IMAGES}} |
| Markdown 残留 | {{MD_RESIDUE_COUNT}} |
| 占位符残留 | {{PLACEHOLDER_COUNT}} |

---

## 六、修正建议

{{CORRECTION_SUGGESTIONS}}

---

**报告生成时间**：{{REPORT_TIMESTAMP}}
**报告版本**：v1.0
