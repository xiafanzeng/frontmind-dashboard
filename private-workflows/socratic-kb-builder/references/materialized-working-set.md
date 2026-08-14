# Materialized working-set contract

## Initial bundle

Return `frontmind-kb-bundle-<operationId>.zip` with `BUNDLE.json` at the root.
Extra top-level fields are forbidden.

```json
{
  "kind": "frontmind.kb-working-set",
  "schemaVersion": 1,
  "operationId": "operation-coordinate-from-input",
  "buildId": "uuid-from-input",
  "generation": 1,
  "contentVersion": 1,
  "skill": {
    "name": "socratic-kb-builder",
    "version": "5",
    "contentHash": "64-lowercase-hex"
  },
  "treePolicyVersion": 2,
  "company": { "name": "Example", "website": "https://example.com" },
  "researchCoverage": {},
  "branches": [{ "branchId": "identity", "title": "企业身份", "ordinal": 0 }],
  "evidenceLedger": [
    {
      "path": "evidence/1.1/source.md",
      "sha256": "64-lowercase-hex",
      "leafId": "1.1",
      "sourceUrl": "https://example.com/",
      "retrievedAt": "2026-08-14T00:00:00.000Z"
    }
  ],
  "leaves": [
    {
      "leafId": "1.1",
      "branchId": "identity",
      "branchTitle": "企业身份",
      "title": "企业概况",
      "ordinal": 0,
      "contentPath": "nodes/0001.md",
      "contentSha256": "64-lowercase-hex",
      "evidencePaths": ["evidence/1.1/source.md"],
      "assetIds": []
    }
  ],
  "assets": [],
  "logo": { "status": "missing", "assetId": null },
  "counts": { "leaves": 30, "evidenceFiles": 30, "assets": 0 }
}
```

Requirements:

- `operationId`, `buildId`, `generation`, Skill coordinates and company
  identity equal the application instructions exactly.
- `contentVersion` is `1` for an initial bundle.
- Branch ordinals and leaf ordinals are contiguous from zero.
- Leaf count is 30–115; every leaf has a non-empty declared body.
- Every `branchId` resolves and `branchTitle` equals the branch title.
- Every content/evidence/asset path is safe, unique and present.
- Every declared SHA-256 equals the exact uncompressed file bytes.
- Every `evidencePaths` entry resolves to exactly one `evidenceLedger` row for
  that leaf. Evidence without an exact hash is invalid.
- `counts` equals the actual manifest/file inventory.
- `logo.status` is `available` only when `assetId` resolves to the sole valid
  official Logo; otherwise it is `missing` and `assetId` is null.
- No ZIP entry may be undeclared except `BUNDLE.json`.

Asset entries use:

```json
{
  "assetId": "asset-company-logo",
  "path": "assets/company-logo.png",
  "sha256": "64-lowercase-hex",
  "mimeType": "image/png",
  "bytes": 12345,
  "width": 512,
  "height": 512,
  "provenance": {
    "sourceKind": "official_web",
    "sourcePageUrl": "https://example.com/",
    "sourceAssetUrl": "https://example.com/logo.png"
  },
  "documentIds": ["1.1"]
}
```

`documentIds` and leaf `assetIds` are bidirectional.

## Leaf patch

Return `frontmind-kb-patch-<operationId>.zip` with `PATCH.json` at the root.

```json
{
  "kind": "frontmind.kb-node-patch",
  "schemaVersion": 1,
  "operationId": "operation-coordinate-from-input",
  "buildId": "uuid-from-input",
  "generation": 1,
  "baseContentVersion": 1,
  "baseWorkingSetSha256": "64-lowercase-hex",
  "targetLeafId": "1.1",
  "contentPath": "node/1.1.md",
  "contentSha256": "64-lowercase-hex",
  "evidence": {
    "add": [
      { "path": "evidence/1.1/new-source.md", "sha256": "64-lowercase-hex" }
    ],
    "remove": []
  },
  "assets": { "add": [], "remove": [] }
}
```

Requirements:

- All base and target coordinates equal the operation instructions.
- The replacement body is non-empty and its hash matches.
- Added evidence stays under `evidence/<targetLeafId>/`.
- Added assets name only `targetLeafId` in `documentIds`.
- Removed evidence paths and asset IDs already belong to the target leaf.
- The patch contains no branch list, leaf list, other node, global report,
  progress state or confirmation state.
- No ZIP entry may be undeclared except `PATCH.json`.

Dashboard assembles a new immutable working set and independently validates the
whole result. Never emit the assembled result in a revision task.
