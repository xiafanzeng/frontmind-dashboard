# Adaptive knowledge-tree contract

## Coverage model

Derive top-level branches from evidence rather than forcing a fixed count.
Cover every applicable business question:

| Business question              | Candidate dimension                    |
| ------------------------------ | -------------------------------------- |
| Who is the enterprise?         | 企业身份                               |
| Who delivers?                  | 团队与组织                             |
| What is offered?               | 产品与服务                             |
| How is it achieved?            | 技术、研发、制造、质量、合规或交付能力 |
| For whom and with what result? | 行业、场景与案例                       |
| Why choose it?                 | 差异化与证据                           |
| How does cooperation work?     | 合作、交付与支持                       |

Merge overlapping dimensions and split materially different business lines.
Add evidence-backed branches such as compliance or R&D. Omit only dimensions
that are genuinely inapplicable and explain the omission in the evidence
report.

## Leaf inventory

Build 30–115 stable leaves before confirmation:

| Enterprise scope                      | Typical leaves |
| ------------------------------------- | -------------: |
| 1–3 product/service families          |          40–55 |
| 4–6 families                          |          60–80 |
| 7+ families or several business lines |         85–115 |

Keep every real product/service family represented. Consolidate large SKU,
news, pagination, and language-version inventories into family leaves. Give
core families deeper leaves for positioning, capabilities/parameters,
applications, proof/cases, and FAQs. A typical enterprise with one to three
families should use 40–55 leaves. A sparse enterprise must still reach 30 by
auditing applicable unanswered business questions and creating distinct
`needs_verification` gap leaves. Never invent facts, duplicate prose, split one
fact mechanically, or repeat a generic disclaimer to meet the floor.

Use stable `id`, `title`, `branchId`, and `branchTitle` values. Never rename an
ID after the first `FRONTMIND_KB_MANIFEST`.

## Research coverage gate

Before fixing the inventory, read every initial upload and audit all seven
business questions above. A normal complete run executes at least six public
queries and successfully parses at least 12 official pages. A genuinely small
official site may finish with fewer successful pages only after its discovered
official queue is exhausted and the exact limitation is recorded.

Hard ceilings are 120 successfully parsed official pages, 200 visited links,
30 public queries and 30 useful official documents. The production manifest's
`researchCoverage` must use actual counters, list every product/service family
with real leaf IDs, and represent all seven dimensions as evidence-backed
coverage or a specific gap. A Website prefill contributes evidence but never
supplies the Dashboard branch/leaf structure, IDs, depth or traversal state.

## Required formal layer

Create one branch overview plus the associated leaf documents. The overview:

- Synthesizes the branch into coherent customer-ready prose.
- Connects facts rather than enumerating page titles.
- Has no image asset. The sole official company Logo belongs only to the first
  leaf and must not be repeated in an overview. If that Logo is initially
  unavailable, the manifest and first leaf still exist, but the first leaf
  remains current and cannot advance until Dashboard receives a qualifying Logo
  upload.
- Points to leaves for detail without copying their full text.

Assign every overview and leaf `complete`, `limited_evidence`, or
`needs_verification` independently from traversal status. Use the
evidence-proportional formula in `output-format.md`; do not delete applicable
business breadth or pad a sparse branch merely to reach a writing target.
A white-label or early-stage enterprise can legitimately have short prose
after uploads, official pages, documents, and public sources have been checked.
Sparse leaves state the verified facts in formal prose and move unresolved
items to the evidence/gap section. Status labels and source tables never count
as formal content.

## Status and traversal

| Status               | Meaning                                       |
| -------------------- | --------------------------------------------- |
| `confirmed`          | Explicitly confirmed by the user              |
| `direct_prefilled`   | User explicitly kept the prefill and advanced |
| `current`            | The only leaf shown for action                |
| `pending`            | Not yet presented                             |
| `needs_verification` | Updated or questioned; remains current        |

Handled progress is `confirmed + direct_prefilled`. Only `confirmed` displays
a checkmark. Every leaf is presented in a separate interaction. Packaging is
forbidden until every leaf is handled and the service authorizes it.

## Progress display

Use an ordinary Markdown table with one row per branch:

| 状态   | 分支       | 已处理 / 总数 | 待核验 |
| ------ | ---------- | ------------: | -----: |
| 进行中 | 产品与服务 |       14 / 28 |      2 |
| 待处理 | 能力体系   |         0 / 9 |      0 |

Then state the total, confirmed, direct-prefilled, pending, and current leaf.
Do not use ASCII trees, character bars, fenced UI simulations, or prose
percentages that conflict with the service state.
