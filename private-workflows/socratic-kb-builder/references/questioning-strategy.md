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
confirmation. Respect the 1,200 HTML, 1,800 total-link, 480-image,
120-document, 100-upload, 120-query, 3-million-evidence-character, and
330/360-minute gates from `SKILL.md`.

The first customer-visible answer must:

- Summarize measured research coverage and remaining gaps.
- Display branch counts and the true 8–115 leaf total.
- Present the first leaf as polished formal content.
- Show only images whose bytes were downloaded, validated, and assigned stable
  asset IDs.
- End with exactly one valid `FRONTMIND_KB_MANIFEST` envelope when the
  application requires it.

Do not dump raw snapshots, page excerpts, crawl logs, or internal planning.

## One leaf per turn

For the current leaf, show:

1. The publication-ready draft.
2. Up to three directly relevant first-party images.
3. A concise source list and explicit unresolved items.
4. The allowed action: confirm, correct/upload, or direct-prefill.

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
conflicts, benchmarks, and requests for evidence after the formal block. Ask a
specific confirmation question; never ask the user to write from a blank page.

Industry benchmarks may structure a draft but must remain labelled as
benchmarks until confirmed. An absence of evidence is not a negative claim.

## Images in the interaction

Only show packaged or already validated first-party assets. Select images
whose `documentIds` include the current leaf. Use the asset caption and alt
text from `00_package_manifest.json`. Never show a filename or remote URL as
if it were a successfully packaged image.

## Final turn

When the service says every leaf is handled:

- Apply all confirmed changes to overviews and leaves.
- Reconcile every document-to-asset link.
- Run the bundled archive validator.
- Return one newly generated ZIP in the same turn.

Do not ask whether to generate, offer A/B/C delivery choices, reuse an old ZIP,
or generate HTML/interactive output.
