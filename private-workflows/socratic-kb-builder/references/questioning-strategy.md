# Prefill and confirmation strategy

## Source order

Use evidence in this order:

1. User uploads.
2. Official company pages and first-party media.
3. Official linked documents.
4. Authoritative registries, certifications, patents, and primary records.
5. Credible public ecosystem sources.
6. Industry benchmarks, clearly labelled.
7. Evidence-bound synthesis, clearly distinguished from fact.

Never present third-party media as enterprise-owned. Preserve exact source
page and direct asset URLs for every third-party lead.

## First research turn

Complete bounded research and the adaptive manifest before the first
confirmation. Respect the 1,200 HTML, 1,800 total-link, 3-image,
120-document, 100-upload, 120-query, 3-million-evidence-character, and
330/360-minute gates from `SKILL.md`.

The first customer-visible answer must:

- Display branch counts and the true 8–115 leaf total.
- Present the first leaf as polished formal content.
- Show up to three distinct classic images whose bytes were downloaded,
  validated, assigned stable asset IDs and associated only with the first leaf.
- End the visible body after the first leaf. Do not add citations, source
  lists, unresolved items, action guidance or a confirmation question.
- End with exactly one valid `FRONTMIND_KB_MANIFEST` envelope. The application
  always requires it on the first turn. Include the complete 8–115 item
  `leaves` array; a count or `SOCRATIC_KB_STATE` summary is invalid.

Do not dump raw snapshots, page excerpts, crawl logs, or internal planning.

## One leaf per turn

For the current leaf, show only:

1. The publication-ready draft.
2. On the initial first-leaf turn only, up to three distinct classic
   first-party images. Every later turn is text-only.

Do not add a `参考资料`, `参考来源`, `References` or `Sources` section. Do not
use numbered citation markers or external citation links in the visible body.
Do not append unresolved items, verification notes, action guidance or a
confirmation question. Keep sources and gaps in internal evidence/report
documents. After the visible body, emit only the required machine envelopes.

Interpret user input narrowly:

- “确认 / 确认无误 / OK / 没问题 / 通过” → `confirmed`; briefly acknowledge
  the old leaf, then fully present the next leaf as the body.
- “跳过 / 直接预填 / 采用预填 / 保留预填” →
  `direct_prefilled`.
- Any correction, supplement, question, or upload →
  `needs_verification`; update and re-present the same leaf. A turn containing
  a file never advances, even when its text contains confirmation language.
- On every non-initial turn, append one progress/reopen envelope and one
  `FRONTMIND_KB_PRESENTATION` envelope. The latter uses the post-transition
  revision and the leaf actually displayed; use `leafId: null` only when the
  final leaf has completed.

A correction is not confirmation. Never advance multiple leaves, skip a
branch, infer bulk approval, or package early.

## Sparse or conflicting evidence

Write verified facts as coherent formal prose. Put unknown parameters,
conflicts, benchmarks, and requests for evidence only in internal
evidence/report documents. Do not append them to the customer-visible turn.

Industry benchmarks may structure a draft but must remain labelled as
benchmarks until confirmed. An absence of evidence is not a negative claim.

## Images in the interaction

Only the initial first-leaf answer may show packaged, validated first-party
assets. Select at most one primary logo, one brand hero and one representative
product/UI/architecture image, deduplicated by visual content. Use captions and
alt text from `00_package_manifest.json`. Never show a filename or remote URL
as if it were a successfully packaged image. Never return an image attachment
on a later confirmation, revision or reopened-leaf turn.

## Final turn

When the service says every leaf is handled:

- Apply all confirmed changes to overviews and leaves.
- Reconcile every document-to-asset link.
- Run the bundled archive validator.
- Return one newly generated ZIP in the same turn.

Do not ask whether to generate, offer A/B/C delivery choices, reuse an old ZIP,
or generate HTML/interactive output.
