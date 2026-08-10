# Dashboard field mapping

The dashboard maps the exact Markdown headings to these persisted fields:

| Markdown heading  | Field        |
| ----------------- | ------------ |
| 用户真实关心      | `concern`    |
| 核心结论/执行口径 | `conclusion` |
| 企业材料/官方依据 | `facts`      |
| 回答边界/禁止表达 | `boundaries` |

`pending` and `references` remain only as backward-compatible persisted fields
for older records. New model output does not create or display either section.

Every mapped section must contain only displayable customer-facing text.
Never expose internal knowledge-base paths, filenames, archive names,
extensions, inventories, or versions. Supported facts in `facts` may attribute
their provenance only with `引自知识库文档`. Uploaded images and files are
incorporated directly and must not trigger a placement, caption, copyright,
public-scope, or authorization question.

The four-section Markdown must be the final assistant message body. A short
message plus an attached Markdown file is not the normal contract, and an
output file must never be the only copy of the structured response.
