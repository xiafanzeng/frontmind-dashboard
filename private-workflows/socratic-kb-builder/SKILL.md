---
name: socratic-kb-builder
description: Build a deep, evidence-backed enterprise knowledge base with polished Chinese overview and leaf content, real first-party images, adaptive 40–115 leaf structure, and one-leaf-at-a-time Socratic confirmation. Use for long-running enterprise knowledge-base construction, corporate material organization, website content preparation, or “帮我构建企业知识库”.
---

# Socratic Enterprise Knowledge Base Builder

Build a reusable enterprise knowledge system. Research deeply within explicit
budgets, write customer-ready content, attach real first-party images, and then
confirm one prefilled leaf at a time.

## Non-negotiable outcome

- Deliver a polished illustrated knowledge system, not a collection of
  “first-party snapshots”, page excerpts, crawl notes, or source summaries.
- Keep customer-visible overview and leaf prose separate from evidence reports,
  raw excerpts, source indexes, and machine manifests.
- Package actual validated first-party image bytes. Image URLs, download claims,
  filenames, or inventory rows do not count as packaged images.
- Preserve every material product/service family and business dimension while
  merging repetitive SKUs, pagination, news, and language variants.
- Never invent facts, images, completeness, or resource counts. Mark gaps and
  conflicts explicitly.

## Fixed execution and resource budget

Treat each value as a hard ceiling unless described as a target:

| Resource                                          |                                                  Budget |
| ------------------------------------------------- | ------------------------------------------------------: |
| Official HTML fetch attempts                      |                                                   1,200 |
| All visited links, including images and documents |                                                   1,800 |
| Packaged first-party images                       |                             target 360–480, maximum 480 |
| Official linked documents                         |                                                     120 |
| User uploads                                      | cumulative maximum 100; process before linked documents |
| Public-web queries                                |                                                     120 |
| Deduplicated retained evidence text               |                                    3,000,000 characters |
| Customer-visible formal prose                     |       target 80,000–120,000; maximum 180,000 characters |
| Adaptive leaf nodes                               |                                                  40–115 |
| Ordinary ZIP files                                |                                                   1,500 |
| Packaged image bytes                              |                                                 160 MiB |

Aim to complete deep discovery, evidence processing, and the first prefilled
leaf in 4–6 hours. Stop all new discovery at elapsed minute 330. From then on,
only synthesize, link assets, build the manifest, run validation, and present
the first leaf. Reach the first leaf by minute 360. Never wait or pause to fill
time.

When a budget is exhausted, stop that acquisition channel, preserve breadth
already established, and record the exact unresolved gap. A budget limit is
not evidence of completeness.

## Phase 1: intake and bounded deep research

1. Use the account-bound enterprise name as authoritative. Accept official
   domain URLs and up to the remaining cumulative upload budget.
2. Build an evidence coverage matrix for enterprise identity, team,
   products/services, capabilities, industries/cases, differentiation, and
   cooperation/support.
3. Read uploads first. Extract text, tables, images, claims, and document
   provenance.
4. Crawl official domains breadth-first. Use robots/sitemaps, navigation,
   product/service families, cases, capability pages, about/team, support,
   downloads, and useful language variants. Stop repetitive pagination,
   duplicate SKUs, translated duplicates, and low-value news before they crowd
   out uncovered business dimensions.
5. Process up to 120 useful official documents. A document is parsed only when
   its binary was fetched and its content was actually extracted.
6. Use up to 120 public queries in Chinese, English, and relevant target-market
   languages to resolve identity, certifications, patents, cases, terminology,
   and material gaps. Separate third-party facts and media; retain URLs and
   ownership but do not package third-party images to fill the first-party
   target.
7. Maintain actual cumulative counters for pages, links, text, images,
   documents, uploads, and queries. Counts must be non-negative and
   monotonically increasing.

## Image discovery, selection, and validation

Discover broadly, but download only likely delivery assets. Rank: logo and
brand marks, core product/service families, application scenes,
technology/manufacturing capability, qualifications, and team.

- Inspect HTML `img`/`srcset`, lazy-load attributes, `picture/source`, CSS
  backgrounds, Open Graph images, product galleries, and useful images inside
  official documents. Record the discovery method, source page, candidate
  result, and rejection reason in the package manifest.
- Treat 360–480 as a quality target, not a minimum. If at least 360 unique
  eligible first-party images exist, package 360–480. If fewer exist, package
  every useful eligible image and declare `source_limited` or `budget_limited`
  with a specific reason and an arithmetically complete candidate funnel.
- Associate every core product/service family that has official imagery with
  at least one asset. For a family without an official image, record the
  checked sources and a concrete media gap.
- Assign every product/service leaf a stable `productFamilyId`; do not infer
  product/service scope from titles. At least one family is required. Once any
  leaf in a branch has `productFamilyId`, every leaf in that branch must have
  one. The manifest `productFamilyCoverage` IDs must exactly match the distinct
  leaf family IDs, so a discovered family cannot be silently omitted.
- Deduplicate by decoded content hash while retaining all document/source
  relationships.
- Accept only validated AVIF, WebP, PNG, JPEG, or GIF bytes. Rasterize useful
  SVG artwork to PNG/WebP; do not count or preview raw SVG.
- Record SHA-256, MIME, byte length, dimensions, caption, alt text, branch,
  related document IDs, source page, source asset URL, and ownership.
- Never count a discovered URL, failed response, HTML error page, or duplicate
  as a packaged image.

## Phase 2: adaptive tree and evidence-proportional formal synthesis

Read `references/knowledge-tree.md`. Derive an adaptive 40–115 leaf inventory.
Keep the complete real product/service family breadth; consolidate repetitive
models into family leaves and deepen only strategically important families.

Before user confirmation, write:

- One customer-ready overview for every top-level branch.
- One customer-ready draft for every leaf.
- Exact evidence and source relationships outside the formal prose block.
- Relevant first-party asset relationships by stable asset ID.

Treat prose sizes as targets. Do not invent or repeat content to reach them.
For each overview and leaf, record `evidenceDocumentIds`,
`evidenceCharacters`, `requiredFormalCharacters`, and `contentStatus` in the
package manifest. `evidenceCharacters` must equal the validator-recomputed
effective characters in those packaged `kind: evidence` documents; never
self-report a smaller evidence total to lower the writing requirement.
Normalize and deduplicate evidence content before packaging: two evidence
documents that differ only by Markdown, Unicode form, whitespace, case, or
punctuation invalidate the archive. Every evidence document used by
`evidenceDocumentIds` must explicitly declare the same `branchId` as the
overview/leaf. A real evidence document may support multiple related leaves
in that one branch. Every packaged `kind: evidence` document must be referenced
by at least one overview or leaf; acquired evidence may not remain hidden and
unorganized in the archive.

- `complete`: evidence supports the target depth.
- `limited_evidence`: discovery was performed but the available evidence only
  supports shorter, factual prose.
- `needs_verification`: no confirmable evidence exists; write a concise,
  structured gap note describing checked sources and requested materials.

Calculate the deterministic requirement from deduplicated related evidence:

- Ordinary overview: `min(2500, floor(evidenceCharacters * 0.25))`, with a
  120-character readable minimum when evidence exists.
- Overview for a branch whose leaves declare `productFamilyId`: use the same
  formula with a 5,000-character target.
- Leaf: `min(500, floor(evidenceCharacters * 0.20))`, with an 80-character
  readable minimum when evidence exists.
- With zero evidence, require only a 60-character overview gap note or a
  40-character leaf gap note and use `needs_verification`.

The 80,000–120,000 overall prose range is a quality target. Only the
180,000-character ceiling is a hard global gate. A small or white-label
enterprise may legitimately deliver less formal prose when every short branch
passes its evidence-proportional requirement.

Use the formal-content markers defined in `references/output-format.md`.
Formal prose must explain the enterprise in natural, publication-ready
language. Do not use “第一方原始快照”, “第一方页面摘录”, raw navigation labels,
or repeated source/status boilerplate as customer-visible content.

## Phase 3: one-leaf Socratic confirmation

Read `references/questioning-strategy.md`.

1. Present exactly one prefilled leaf with its relevant real images and concise
   source attribution.
2. Ask the user to confirm, correct, upload evidence, or direct-prefill it.
3. Advance exactly one leaf only after explicit confirmation or explicit
   direct-prefill/skip.
4. Treat corrections, supplements, questions, and uploads as
   `needs_verification`; update and re-present the same leaf.
5. Calculate traversal progress only as
   `(confirmed + direct_prefilled) / total`. Research coverage is not traversal
   completion.
6. Never offer branch skips, bulk confirmation, early packaging, HTML output,
   or an interactive research website.

When the application supplies `FRONTMIND_KB_MANIFEST`,
`FRONTMIND_KB_PROGRESS`, or `FRONTMIND_KB_REOPEN`, follow that protocol
exactly. The service state is authoritative.

## Phase 4: package only at 100%

Read `references/output-format.md`. Preserve the existing
`00_completeness.json` fields and completeness rules. Use schema version 2 of
the exact `00_package_manifest.json` contract. Historical schema-version-1
archives remain readable, but every new v2 build must emit schema version 2.

Before returning a ZIP:

1. Finish the formal overviews and all leaf drafts.
2. Package actual first-party image files next to related branches. Reopen and
   decode every raster; a matching suffix and magic prefix alone never proves
   that an image is valid.
3. Generate source, crawl, web-intelligence, media-gap, and evidence reports.
4. Run:

   `python3 scripts/validate_archive.py /absolute/path/to/final.zip`

5. Fix every reported error using existing evidence. Do not claim success
   unless the command exits with status 0.
6. Return exactly one new ZIP only after every leaf is handled and validation
   passes. Never reuse a historical ZIP.

## References

- Read `references/knowledge-tree.md` before creating the manifest.
- Read `references/questioning-strategy.md` before the first confirmation.
- Read `references/output-format.md` before synthesis and packaging.
- Execute `scripts/validate_archive.py` before delivery.
