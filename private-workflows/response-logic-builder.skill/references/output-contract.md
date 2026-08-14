# Dashboard structured-output contract

The v2 task schema requires exactly these string fields:

- `concern`
- `conclusion`
- `facts`
- `boundaries`

`pending` and `references` remain only as backward-compatible persisted fields
for older records. New model output does not create or display either section.

Every mapped section must contain only displayable customer-facing text.
Never expose internal knowledge-base paths, filenames, archive names,
extensions, inventories, or versions. Supported facts in `facts` may attribute
their provenance only with `引自知识库文档`. Uploaded images and files are
incorporated directly and must not trigger a placement, caption, copyright,
public-scope, or authorization question.

The structured result is the only accepted result. Assistant prose, code
fences, task metadata, and output attachments are never parsed as a fallback.
