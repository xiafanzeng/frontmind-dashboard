# Dashboard enterprise archive contract

## Canonical ZIP layout

The ZIP may have one common company-named root. Paths in the manifest are
relative to that root.

```text
{company}_knowledge_base/
├── README.md
├── 00_completeness.json
├── 00_package_manifest.json
├── 00_knowledge_tree.md
├── 00_crawl_coverage_report.md
├── 00_web_intelligence_report.md
├── 00_source_index.md
├── 00_media_gaps.md
├── 09_media_assets/
│   └── asset_inventory.md
├── branches/
│   └── {branch_id}_{slug}/
│       ├── 00_overview.md
│       ├── {leaf_id}_{slug}.md
│       ├── evidence/
│       └── images/
└── 10_reference_assets/
    └── reference_asset_inventory.md
```

Do not package HTML, executables, raw site snapshots, duplicate clean-text
copies, or third-party image binaries. Evidence excerpts and reports belong in
`evidence/` or root reports, never inside the customer-visible formal block.

## Formal content markers

Every customer-visible overview and leaf must contain exactly one block:

```markdown
<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

[Publication-ready content. Use stable asset IDs for image relationships; do
not embed raw source URLs here.]

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-id: ...
```

The validator counts only effective non-whitespace characters inside these
markers. Customer-visible content targets 80,000–120,000 characters and must
not exceed 180,000. It has no fixed global minimum: each overview and leaf
must instead satisfy its evidence-proportional requirement declared in the
manifest. Do not use “第一方原始快照” or
“第一方页面摘录”, “原始快照”, “页面摘录”, `raw evidence`, or
`page excerpt` inside the formal block.

## `00_package_manifest.json`

Use this exact top-level contract. Extra fields are forbidden:

```json
{
  "schemaVersion": 3,
  "profile": "dashboard-enterprise-v1",
  "documents": [
    {
      "id": "overview-products",
      "path": "branches/products/00_overview.md",
      "kind": "overview",
      "title": "产品与服务综述",
      "branchId": "products",
      "order": 10,
      "evidenceStatus": "verified_first_party",
      "sourceIds": ["source-official-products"],
      "evidenceDocumentIds": ["evidence-official-products"],
      "assetIds": [],
      "customerVisible": true,
      "evidenceCharacters": 24000,
      "requiredFormalCharacters": 5000,
      "contentStatus": "complete"
    },
    {
      "id": "leaf-product-family-a",
      "path": "branches/products/family-a.md",
      "kind": "leaf",
      "title": "产品族 A",
      "branchId": "products",
      "order": 20,
      "evidenceStatus": "verified_first_party",
      "sourceIds": ["source-official-products"],
      "evidenceDocumentIds": ["evidence-official-products"],
      "assetIds": ["asset-company-logo"],
      "customerVisible": true,
      "evidenceCharacters": 24000,
      "requiredFormalCharacters": 500,
      "contentStatus": "complete",
      "productFamilyId": "family-a"
    },
    {
      "id": "evidence-official-products",
      "path": "branches/products/evidence/official-products.md",
      "kind": "evidence",
      "title": "产品官方资料摘录",
      "branchId": "products",
      "sourceIds": ["source-official-products"],
      "assetIds": [],
      "customerVisible": false
    }
  ],
  "assets": [
    {
      "id": "asset-company-logo",
      "path": "09_media_assets/company-logo.png",
      "sha256": "64-lowercase-hex-characters",
      "mimeType": "image/png",
      "bytes": 123456,
      "width": 512,
      "height": 512,
      "caption": "企业官方 Logo",
      "alt": "企业 Logo",
      "branchId": "products",
      "documentIds": ["leaf-product-family-a"],
      "sourcePageUrl": "https://official.example/",
      "sourceAssetUrl": "https://official.example/media/logo.png",
      "ownership": "first_party",
      "assetType": "brand_identity",
      "displayRole": "badge"
    }
  ],
  "counts": {
    "totalFiles": 400,
    "customerVisibleCharacters": 120000,
    "evidenceCharacters": 1800000,
    "packagedImages": 1
  },
  "imageSelection": {
    "status": "target_met",
    "discoveredCandidateImages": 2,
    "inspectedCandidateImages": 2,
    "eligibleFirstPartyImages": 1,
    "rejectedCandidateImages": 1,
    "scannedSourcePages": 1,
    "discoveryMethods": [
      "img",
      "srcset",
      "lazy_load",
      "picture",
      "css_background",
      "open_graph",
      "gallery",
      "official_document"
    ],
    "rejectionReasons": [{ "reason": "favicon 不是企业主 Logo", "count": 1 }],
    "stopReason": "已取得企业官方 Logo，停止图片发现",
    "candidates": [
      {
        "url": "https://official.example/media/logo.png",
        "sourcePageUrl": "https://official.example/",
        "method": "img",
        "status": "eligible",
        "assetId": "asset-company-logo"
      },
      {
        "url": "https://official.example/favicon.ico",
        "sourcePageUrl": "https://official.example/",
        "method": "img",
        "status": "rejected",
        "rejectionReason": "favicon 不是企业主 Logo"
      }
    ]
  }
}
```

Allowed document kinds are `overview`, `leaf`, `evidence`, `report`, and
`index`. Allowed evidence states are `verified_first_party`,
`verified_authoritative`, `supported_third_party`, `inferred`,
`needs_verification`, and `not_applicable`. Every customer-visible overview
and leaf must declare one of those six states plus `evidenceDocumentIds`,
`evidenceCharacters`, `requiredFormalCharacters`, and `contentStatus`.
Every evidence document ID must resolve to a packaged `kind: evidence`
document sharing at least one `sourceId` with the overview/leaf. The evidence
document must explicitly declare the same `branchId`; global or missing
evidence branch scope is not implicit. One real evidence document may support
multiple related leaves in that same branch. Evidence documents must be unique
after Markdown stripping plus Unicode, case, whitespace, and punctuation
normalization; copied excerpts cannot increase evidence volume. Every packaged
`kind: evidence` document must appear in at least one overview/leaf
`evidenceDocumentIds` list, so acquired evidence cannot be omitted from formal
organization.
`evidenceCharacters` must equal the validator-recomputed total effective
characters from the unique referenced evidence documents. Allowed content
statuses are `complete`, `limited_evidence`, and `needs_verification`.
`00_completeness.json` counts the evidence states of the 8–115 true leaf
documents. `customerVisible` is true only for polished overviews and leaves.
Document and asset IDs are stable and unique. Every `assetIds` and
`documentIds` relationship must resolve in both directions.

## Conversational presentation assets

Associate the archive's sole official company Logo only with the manifest's
first leaf. Return that one validated local byte as an actual response
image/file attachment on the initial first-leaf turn. Do not return source
hotlinks or only write a relative Markdown path. Every later turn is text-only. Each
non-null `FRONTMIND_KB_PRESENTATION` envelope therefore uses
`imageState: no_eligible_asset`, `assetIds: []`, and `imageCount: 0`;
`not_applicable` is reserved for `leafId: null` after completion.

For schema version 2, compute `requiredFormalCharacters` exactly:

- Overview with evidence: `max(120, min(target, floor(evidence * 0.25)))`,
  where `target` is 5,000 when the overview's branch has leaves declaring
  `productFamilyId`, and 2,500 for every other branch.
- Leaf with evidence:
  `max(80, min(500, floor(evidence * 0.20)))`.
- Overview with zero evidence: 60; leaf with zero evidence: 40. Both must use
  `contentStatus: needs_verification` and an evidence status of
  `needs_verification` or `not_applicable`.
- Use `complete` only when the computed target is reached by the available
  evidence; otherwise use `limited_evidence`. Formal content must meet the
  computed requirement, but must not be padded to reach the target.

`imageSelection` is an auditable Logo-discovery funnel. `inspectedCandidateImages`
equals eligible plus rejected candidates and cannot exceed discovered
candidates. Rejection-reason counts sum to rejected candidates. List every
discovery method actually checked. Every product/service leaf must still carry
`productFamilyId`; this field identifies product/service families and their
branches independently of image selection. At least one family is required. If
one leaf in a branch has `productFamilyId`, every leaf in that branch must
declare it.

List every inspected candidate with URL, source page, actual method and
`eligible`, `rejected`, or `uninspected` status. Use `target_met` only when all
candidates were inspected and exactly one official company Logo is packaged as
`brand_identity` with display role `badge`. Use
`source_limited` after inspecting
every candidate when a concrete coverage gap remains, or `budget_limited` when
real candidates remain uninspected. Both limited statuses require a non-empty
`shortfallReason` and `stopReason`. Stop image discovery immediately after
the first eligible official company Logo. Never reduce a counter to make a
shortfall pass.

The manifest counts must match the actual ZIP:

- `totalFiles`: all ordinary files under the common root.
- `customerVisibleCharacters`: validator-counted formal characters.
- `evidenceCharacters`: retained deduplicated evidence characters, maximum
  3,000,000.
- `packagedImages`: unique validated first-party image files, exactly 1.

Keep all existing `00_completeness.json` fields, evidence statuses, and
completeness calculations unchanged. Do not derive completeness from resource
use or target attainment.

## Image requirements

- Accept AVIF, WebP, PNG, JPEG, and GIF only.
- MIME, extension, magic bytes, declared byte length, and SHA-256 must match.
- Reopen and decode the complete raster payload, reject header-only or corrupt
  files, and set width and height from the decoded image rather than trusting
  metadata supplied by the task.
- Deduplicate by content hash.
- Keep total packaged image bytes at or below 30 MiB.
- Rasterize useful SVG to PNG/WebP; raw SVG does not count as an asset.
- Ownership must be exactly `first_party`.
- Every asset must belong to a branch and at least one customer-visible
  document.
- The sole v3 asset declares `assetType: brand_identity` and
  `displayRole: badge`, and is at least 256×256. No business, hero, product,
  UI, architecture, case, team, environment, certificate or other image may be
  packaged.
- `imageSelection.scannedSourcePages` must not exceed successfully parsed
  official pages; only pages actually inspected for the primary official Logo
  count here.

## Required reports

The crawl report records actual discovered/succeeded/failed/skipped pages,
links, cleaned/deduplicated characters, image discovery/download/deduplication
and bytes, document parsing, upload processing, and budget stops.

The public-web report records every query, language, result domain,
selected/rejected source, conflict, and unresolved gap. The media-gap report
explains any Logo discovery or inspection gap. It does not request
product-family or business imagery.

## `00_completeness.json`

Keep the established object shape unchanged and use no extra fields:

```text
{
  "counts": {
    "totalLeaves": TOTAL_LEAVES,
    "verifiedFirstParty": VERIFIED_FIRST_PARTY_LEAVES,
    "verifiedAuthoritative": VERIFIED_AUTHORITATIVE_LEAVES,
    "supportedThirdParty": SUPPORTED_THIRD_PARTY_LEAVES,
    "inferred": INFERRED_LEAVES,
    "needsVerification": NEEDS_VERIFICATION_LEAVES,
    "notApplicable": NOT_APPLICABLE_LEAVES
  },
  "acquisition": {
    "officialPages": { "completed": OFFICIAL_PAGES_COMPLETED, "total": OFFICIAL_PAGES_DISCOVERED },
    "images": { "completed": PACKAGED_IMAGES, "total": IMAGES_DISCOVERED },
    "documents": { "completed": DOCUMENTS_PARSED, "total": DOCUMENTS_DISCOVERED },
    "webQueries": { "completed": WEB_QUERIES_EXECUTED, "total": WEB_QUERIES_PLANNED }
  },
  "gaps": [CURRENT_RUN_GAP_STRINGS],
  "evaluatedAt": CURRENT_RUN_ISO_8601_STRING
}
```

Replace every uppercase token with the current run's actual value.
`totalLeaves` is the 8–115 true leaf count,
not the overview count. The six evidence-state counts must be non-negative,
sum to `totalLeaves`, and match the leaf manifests. `images.completed` must
equal the actual deduplicated packaged image count. Each acquisition
`completed` value is no greater than `total`. Do not calculate or store a
completeness score, grade, percentage, or resource-consumption proxy.

## Final gate

Run `python3 scripts/validate_archive.py FINAL.zip`. A non-zero exit forbids
delivery. Fix structure, formal content, manifest relationships, image bytes,
or budget violations with existing evidence and rerun. Never silence the
validator or edit counts to match a false claim.
