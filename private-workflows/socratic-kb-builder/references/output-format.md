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
markers. Customer-visible content must total 80,000–180,000 characters, with a
120,000-character target. Each evidence-backed leaf must contain at least 120
effective formal characters. Do not use “第一方原始快照” or
“第一方页面摘录”, “原始快照”, “页面摘录”, `raw evidence`, or
`page excerpt` inside the formal block.

## `00_package_manifest.json`

Use this exact top-level contract. Extra fields are forbidden:

```json
{
  "schemaVersion": 1,
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
      "assetIds": ["asset-product-family-a"],
      "customerVisible": true
    }
  ],
  "assets": [
    {
      "id": "asset-product-family-a",
      "path": "branches/products/images/family-a.webp",
      "sha256": "64-lowercase-hex-characters",
      "mimeType": "image/webp",
      "bytes": 123456,
      "width": 1600,
      "height": 900,
      "caption": "产品族 A 官方主图",
      "alt": "产品族 A 外观",
      "branchId": "products",
      "documentIds": ["overview-products", "leaf-product-family-a"],
      "sourcePageUrl": "https://official.example/products/a",
      "sourceAssetUrl": "https://official.example/media/a.webp",
      "ownership": "first_party"
    }
  ],
  "counts": {
    "totalFiles": 400,
    "customerVisibleCharacters": 120000,
    "evidenceCharacters": 1800000,
    "packagedImages": 420
  },
  "imageSelection": {
    "eligibleFirstPartyImages": 438
  }
}
```

Allowed document kinds are `overview`, `leaf`, `evidence`, `report`, and
`index`. Allowed evidence states are `verified_first_party`,
`verified_authoritative`, `supported_third_party`, `inferred`,
`needs_verification`, and `not_applicable`. Every customer-visible overview
and leaf must declare one of those six states; `00_completeness.json` counts
the states of the 40–115 true leaf documents. `customerVisible` is true only
for polished overviews and leaves. Document and asset IDs are stable and
unique. Every `assetIds` and `documentIds` relationship must resolve in both
directions.

`imageSelection.eligibleFirstPartyImages` is the measured unique useful
first-party candidate count. If it is at least 360, package 360–480 images. If
it is below 360, package every eligible useful image and provide a non-empty
`shortfallReason`. Omit `shortfallReason` entirely when the eligible count is
at least 360; never write it as `null`. A measured eligible count of zero is
valid only when no suitable first-party image exists, the ZIP contains zero
images, and a concrete reason is recorded. Never reduce this number to make a
shortfall pass.

The manifest counts must match the actual ZIP:

- `totalFiles`: all ordinary files under the common root.
- `customerVisibleCharacters`: validator-counted formal characters.
- `evidenceCharacters`: retained deduplicated evidence characters, maximum
  3,000,000.
- `packagedImages`: unique validated first-party image files, maximum 480.

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
- Keep total packaged image bytes at or below 160 MiB.
- Rasterize useful SVG to PNG/WebP; raw SVG does not count as an asset.
- Ownership must be exactly `first_party`.
- Every asset must belong to a branch and at least one customer-visible
  document.

## Required reports

The crawl report records actual discovered/succeeded/failed/skipped pages,
links, cleaned/deduplicated characters, image discovery/download/deduplication
and bytes, document parsing, upload processing, and budget stops.

The public-web report records every query, language, result domain,
selected/rejected source, conflict, and unresolved gap. The media-gap report
explains image shortfall when fewer than 360 eligible assets exist.

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
`totalLeaves` is the 40–115 true leaf count,
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
