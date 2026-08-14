#!/usr/bin/env python3
"""Validate the portable v5 working-set or leaf-patch ZIP contract."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys
import zipfile

SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$")
MAX_FILES = 1500
MAX_UNCOMPRESSED = 120 * 1024 * 1024


def fail(message: str) -> None:
    raise ValueError(message)


def safe_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        fail("unsafe path")
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail("unsafe path")
    return value


def read_json(archive: zipfile.ZipFile, name: str) -> dict:
    try:
        value = json.loads(archive.read(name))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid {name}: {error}")
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def declared_file(archive: zipfile.ZipFile, path: object, digest: object) -> str:
    name = safe_path(path)
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        fail(f"invalid sha256 for {name}")
    try:
        payload = archive.read(name)
    except KeyError:
        fail(f"missing {name}")
    if hashlib.sha256(payload).hexdigest() != digest:
        fail(f"sha256 mismatch for {name}")
    return name


def validate_bundle(archive: zipfile.ZipFile, manifest: dict) -> set[str]:
    required = {
        "kind", "schemaVersion", "operationId", "buildId", "generation",
        "contentVersion", "skill", "treePolicyVersion", "company",
        "researchCoverage", "branches", "evidenceLedger", "leaves", "assets", "logo", "counts",
    }
    if set(manifest) != required:
        fail("BUNDLE.json fields do not match the contract")
    if manifest.get("kind") != "frontmind.kb-working-set" or manifest.get("schemaVersion") != 1:
        fail("invalid bundle identity")
    if manifest.get("contentVersion") != 1:
        fail("initial contentVersion must be 1")
    leaves = manifest.get("leaves")
    branches = manifest.get("branches")
    assets = manifest.get("assets")
    if not isinstance(leaves, list) or not 30 <= len(leaves) <= 115:
        fail("bundle must contain 30-115 leaves")
    if not isinstance(branches, list) or not branches:
        fail("bundle branches are missing")
    if not isinstance(assets, list) or len(assets) > 100:
        fail("bundle assets are invalid")
    declared = {"BUNDLE.json"}
    branch_map: dict[str, str] = {}
    for index, branch in enumerate(branches):
        if not isinstance(branch, dict) or set(branch) != {"branchId", "title", "ordinal"}:
            fail("invalid branch")
        if branch.get("ordinal") != index or not SAFE_ID.fullmatch(str(branch.get("branchId", ""))):
            fail("branch order/id is invalid")
        branch_map[branch["branchId"]] = str(branch.get("title", ""))
    leaf_ids: set[str] = set()
    asset_refs: dict[str, set[str]] = {}
    ledger = manifest.get("evidenceLedger")
    if not isinstance(ledger, list):
        fail("bundle evidenceLedger is missing")
    evidence_by_path: dict[str, dict] = {}
    for entry in ledger:
        required_evidence = {"path", "sha256", "leafId", "sourceUrl", "retrievedAt"}
        if not isinstance(entry, dict) or set(entry) != required_evidence:
            fail("invalid evidence ledger entry")
        name = declared_file(archive, entry.get("path"), entry.get("sha256"))
        if name in evidence_by_path or not archive.read(name).strip():
            fail("evidence path is duplicate or empty")
        evidence_by_path[name] = entry
    for index, leaf in enumerate(leaves):
        required_leaf = {
            "leafId", "branchId", "branchTitle", "title", "ordinal",
            "contentPath", "contentSha256", "evidencePaths", "assetIds",
        }
        if not isinstance(leaf, dict) or not required_leaf.issubset(leaf) or not set(leaf).issubset(required_leaf | {"productFamilyId"}):
            fail("invalid leaf")
        leaf_id = str(leaf.get("leafId", ""))
        if leaf.get("ordinal") != index or not SAFE_ID.fullmatch(leaf_id) or leaf_id in leaf_ids:
            fail("leaf order/id is invalid")
        leaf_ids.add(leaf_id)
        if branch_map.get(str(leaf.get("branchId", ""))) != leaf.get("branchTitle"):
            fail("leaf branch does not resolve")
        content_path = declared_file(archive, leaf.get("contentPath"), leaf.get("contentSha256"))
        if content_path in declared or not archive.read(content_path).strip():
            fail("leaf body is duplicate or empty")
        declared.add(content_path)
        evidence_paths = leaf.get("evidencePaths")
        if not isinstance(evidence_paths, list):
            fail("leaf evidencePaths is invalid")
        for evidence_path in evidence_paths:
            name = safe_path(evidence_path)
            if name in declared:
                fail("evidence path is duplicated")
            if evidence_by_path.get(name, {}).get("leafId") != leaf_id:
                fail("evidence ledger does not resolve to the leaf")
            declared.add(name)
        refs = leaf.get("assetIds")
        if not isinstance(refs, list) or any(not SAFE_ID.fullmatch(str(value)) for value in refs):
            fail("leaf assetIds is invalid")
        for asset_id in refs:
            asset_refs.setdefault(str(asset_id), set()).add(leaf_id)
    asset_ids: set[str] = set()
    for asset in assets:
        required_asset = {
            "assetId", "path", "sha256", "mimeType", "bytes", "width",
            "height", "provenance", "documentIds",
        }
        if not isinstance(asset, dict) or set(asset) != required_asset:
            fail("invalid asset")
        asset_id = str(asset.get("assetId", ""))
        if not SAFE_ID.fullmatch(asset_id) or asset_id in asset_ids:
            fail("asset id is invalid")
        asset_ids.add(asset_id)
        name = declared_file(archive, asset.get("path"), asset.get("sha256"))
        payload = archive.read(name)
        if name in declared or asset.get("bytes") != len(payload):
            fail("asset path/size is invalid")
        declared.add(name)
        document_ids = asset.get("documentIds")
        if not isinstance(document_ids, list) or set(map(str, document_ids)) != asset_refs.get(asset_id, set()):
            fail("asset documentIds are not bidirectional")
    if set(evidence_by_path) != {path for path in declared if path.startswith("evidence/")}:
        fail("evidence ledger contains an unreferenced file")
    if asset_ids != set(asset_refs):
        fail("leaf asset reference does not resolve")
    counts = manifest.get("counts")
    if counts != {"leaves": len(leaves), "evidenceFiles": len(evidence_by_path), "assets": len(assets)}:
        fail("bundle counts are invalid")
    logo = manifest.get("logo")
    if not isinstance(logo, dict) or set(logo) != {"status", "assetId"}:
        fail("logo state is invalid")
    if logo.get("status") == "available":
        if logo.get("assetId") not in asset_ids:
            fail("logo asset does not resolve")
    elif logo != {"status": "missing", "assetId": None}:
        fail("logo state is invalid")
    return declared


def validate_patch(archive: zipfile.ZipFile, manifest: dict) -> set[str]:
    required = {
        "kind", "schemaVersion", "operationId", "buildId", "generation",
        "baseContentVersion", "baseWorkingSetSha256", "targetLeafId",
        "contentPath", "contentSha256", "evidence", "assets",
    }
    if set(manifest) != required:
        fail("PATCH.json fields do not match the contract")
    if manifest.get("kind") != "frontmind.kb-node-patch" or manifest.get("schemaVersion") != 1:
        fail("invalid patch identity")
    target = str(manifest.get("targetLeafId", ""))
    if not SAFE_ID.fullmatch(target) or not SHA256.fullmatch(str(manifest.get("baseWorkingSetSha256", ""))):
        fail("invalid patch coordinates")
    declared = {"PATCH.json"}
    body = declared_file(archive, manifest.get("contentPath"), manifest.get("contentSha256"))
    if not archive.read(body).strip():
        fail("patch body is empty")
    declared.add(body)
    evidence = manifest.get("evidence")
    assets = manifest.get("assets")
    if not isinstance(evidence, dict) or set(evidence) != {"add", "remove"}:
        fail("patch evidence delta is invalid")
    if not isinstance(assets, dict) or set(assets) != {"add", "remove"}:
        fail("patch asset delta is invalid")
    for item in evidence.get("add", []):
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            fail("patch evidence addition is invalid")
        name = declared_file(archive, item.get("path"), item.get("sha256"))
        prefix = f"evidence/{target}/"
        if not name.startswith(prefix) or name in declared:
            fail("patch evidence is outside the target leaf")
        declared.add(name)
    for asset in assets.get("add", []):
        if not isinstance(asset, dict) or set(asset.get("documentIds", [])) != {target}:
            fail("patch asset is outside the target leaf")
        name = declared_file(archive, asset.get("path"), asset.get("sha256"))
        if name in declared or asset.get("bytes") != len(archive.read(name)):
            fail("patch asset is invalid")
        declared.add(name)
    return declared


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate_working_set.py <archive.zip>")
    with zipfile.ZipFile(sys.argv[1]) as archive:
        entries = archive.infolist()
        if not 1 <= len(entries) <= MAX_FILES:
            fail("archive file count is invalid")
        if sum(item.file_size for item in entries) > MAX_UNCOMPRESSED:
            fail("archive is too large")
        names: set[str] = set()
        for item in entries:
            name = safe_path(item.filename)
            if item.is_dir() or name in names or item.flag_bits & 1 or (item.external_attr >> 16) & 0o170000 == 0o120000:
                fail("archive contains an unsafe entry")
            names.add(name)
        if "BUNDLE.json" in names and "PATCH.json" not in names:
            manifest = read_json(archive, "BUNDLE.json")
            declared = validate_bundle(archive, manifest)
            label = "frontmind.kb-working-set.v1"
        elif "PATCH.json" in names and "BUNDLE.json" not in names:
            manifest = read_json(archive, "PATCH.json")
            declared = validate_patch(archive, manifest)
            label = "frontmind.kb-node-patch.v1"
        else:
            fail("archive must contain exactly one contract manifest")
        if names != declared:
            fail("archive contains undeclared files")
    print(f"VALID {label}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"INVALID: {error}", file=sys.stderr)
        raise SystemExit(1)
