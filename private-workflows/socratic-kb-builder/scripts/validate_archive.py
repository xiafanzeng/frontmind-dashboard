#!/usr/bin/env python3
"""Validate a dashboard-enterprise-v1 knowledge-base ZIP deterministically."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # The service still performs an independent native decode.
    Image = None
    UnidentifiedImageError = OSError

MIB = 1024 * 1024
MAX_COMPRESSED_BYTES = 250 * MIB
MAX_UNCOMPRESSED_BYTES = 200 * MIB
MAX_IMAGE_BYTES = 160 * MIB
MAX_FILES = 1_500
MAX_IMAGES = 480
MIN_TARGET_IMAGES = 360
MIN_LEAVES = 40
MAX_LEAVES = 115
MIN_FORMAL_CHARACTERS = 80_000
MAX_FORMAL_CHARACTERS = 180_000
MAX_EVIDENCE_CHARACTERS = 3_000_000
MIN_LEAF_FORMAL_CHARACTERS = 120
MAX_PARSED_DOCUMENTS = 220
MAX_PUBLIC_QUERIES = 120
MAX_OFFICIAL_PAGES = 1_200

FORMAL_START = "<!-- FRONTMIND_FORMAL_CONTENT_START -->"
FORMAL_END = "<!-- FRONTMIND_FORMAL_CONTENT_END -->"
ALLOWED_DOCUMENT_KINDS = {"overview", "leaf", "evidence", "report", "index"}
ALLOWED_EVIDENCE_STATUSES = {
    "verified_first_party",
    "verified_authoritative",
    "supported_third_party",
    "inferred",
    "needs_verification",
    "not_applicable",
}
EVIDENCE_STATUS_COUNT_KEYS = {
    "verified_first_party": "verifiedFirstParty",
    "verified_authoritative": "verifiedAuthoritative",
    "supported_third_party": "supportedThirdParty",
    "inferred": "inferred",
    "needs_verification": "needsVerification",
    "not_applicable": "notApplicable",
}
IMAGE_TYPES = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
REQUIRED_ROOT_FILES = {
    "README.md",
    "00_completeness.json",
    "00_package_manifest.json",
    "00_knowledge_tree.md",
    "00_crawl_coverage_report.md",
    "00_web_intelligence_report.md",
    "00_source_index.md",
    "00_media_gaps.md",
    "09_media_assets/asset_inventory.md",
    "10_reference_assets/reference_asset_inventory.md",
}
FORBIDDEN_FORMAL_PHRASES = (
    "第一方原始快照",
    "第一方页面摘录",
    "原始快照",
    "页面摘录",
    "raw evidence",
    "page excerpt",
)
MANIFEST_KEYS = {
    "schemaVersion",
    "profile",
    "documents",
    "assets",
    "counts",
    "imageSelection",
}
DOCUMENT_KEYS = {
    "id",
    "path",
    "kind",
    "title",
    "branchId",
    "branchTitle",
    "order",
    "evidenceStatus",
    "sourceIds",
    "assetIds",
    "customerVisible",
}
DOCUMENT_REQUIRED_KEYS = {
    "id",
    "path",
    "kind",
    "title",
    "sourceIds",
    "assetIds",
    "customerVisible",
}
ASSET_KEYS = {
    "id",
    "path",
    "sha256",
    "mimeType",
    "bytes",
    "width",
    "height",
    "caption",
    "alt",
    "branchId",
    "documentIds",
    "sourcePageUrl",
    "sourceAssetUrl",
    "ownership",
}
ASSET_REQUIRED_KEYS = {
    "id",
    "path",
    "sha256",
    "mimeType",
    "bytes",
    "width",
    "height",
    "caption",
    "branchId",
    "documentIds",
    "ownership",
}
COUNTS_KEYS = {
    "totalFiles",
    "customerVisibleCharacters",
    "evidenceCharacters",
    "packagedImages",
}


class Validation:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def require(self, condition: bool, message: str) -> bool:
        if not condition:
            self.errors.append(message)
        return condition


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def safe_relative_name(name: str) -> bool:
    if not name or "\x00" in name or "\\" in name:
        return False
    path = PurePosixPath(name)
    return (
        not path.is_absolute()
        and not re.match(r"^[A-Za-z]:", name)
        and ".." not in path.parts
    )


def normalized_entries(
    infos: list[zipfile.ZipInfo], validation: Validation
) -> tuple[dict[str, zipfile.ZipInfo], str | None]:
    files: list[tuple[PurePosixPath, zipfile.ZipInfo]] = []
    for info in infos:
        original = info.filename
        if not validation.require(
            safe_relative_name(original), f"unsafe ZIP path: {original!r}"
        ):
            continue
        if info.flag_bits & 0x1:
            validation.errors.append(f"encrypted ZIP entry is forbidden: {original}")
        unix_mode = (info.external_attr >> 16) & 0o170000
        if unix_mode == 0o120000:
            validation.errors.append(f"symbolic link is forbidden: {original}")
        if info.is_dir():
            continue
        if info.file_size > 0 and info.compress_size > 0:
            ratio = info.file_size / info.compress_size
            if ratio > 200:
                validation.errors.append(
                    f"suspicious compression ratio ({ratio:.1f}): {original}"
                )
        files.append((PurePosixPath(original), info))

    first_parts = {path.parts[0] for path, _ in files if path.parts}
    use_root = (
        len(first_parts) == 1
        and files
        and all(len(path.parts) > 1 for path, _ in files)
    )
    validation.require(
        bool(use_root),
        "archive must contain exactly one company-named root directory",
    )
    root = next(iter(first_parts)) if use_root else None
    result: dict[str, zipfile.ZipInfo] = {}
    for path, info in files:
        relative = PurePosixPath(*path.parts[1:]) if root else path
        key = relative.as_posix()
        if key in result:
            validation.errors.append(f"duplicate normalized ZIP path: {key}")
        result[key] = info
    return result, root


def read_json(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    name: str,
    validation: Validation,
) -> dict[str, Any] | None:
    info = entries.get(name)
    if not validation.require(info is not None, f"missing required file: {name}"):
        return None
    try:
        value = json.loads(archive.read(info).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        validation.errors.append(f"invalid UTF-8 JSON in {name}: {exc}")
        return None
    if not validation.require(isinstance(value, dict), f"{name} must be an object"):
        return None
    return value


def require_string(
    obj: dict[str, Any],
    key: str,
    where: str,
    validation: Validation,
    *,
    optional: bool = False,
) -> str:
    value = obj.get(key)
    if optional and value is None:
        return ""
    if not isinstance(value, str) or not value.strip():
        validation.errors.append(f"{where}.{key} must be a non-empty string")
        return ""
    return value.strip()


def require_string_list(
    obj: dict[str, Any], key: str, where: str, validation: Validation
) -> list[str]:
    value = obj.get(key)
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        validation.errors.append(f"{where}.{key} must be a string array")
        return []
    return [item.strip() for item in value]


def require_exact_keys(
    obj: dict[str, Any],
    *,
    allowed: set[str],
    required: set[str],
    where: str,
    validation: Validation,
) -> None:
    actual = set(obj)
    unexpected = sorted(actual - allowed)
    missing = sorted(required - actual)
    validation.require(not unexpected, f"{where} has unexpected fields: {unexpected}")
    validation.require(not missing, f"{where} is missing fields: {missing}")


def image_magic_matches(data: bytes, mime: str) -> bool:
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if mime == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if mime == "image/avif":
        return (
            len(data) >= 16
            and data[4:8] == b"ftyp"
            and any(brand in data[8:32] for brand in (b"avif", b"avis"))
        )
    return False


def image_dimensions(data: bytes, mime: str) -> tuple[int, int] | None:
    if mime == "image/png" and len(data) >= 24:
        return (
            int.from_bytes(data[16:20], "big"),
            int.from_bytes(data[20:24], "big"),
        )
    if mime == "image/gif" and len(data) >= 10:
        return (
            int.from_bytes(data[6:8], "little"),
            int.from_bytes(data[8:10], "little"),
        )
    if mime == "image/jpeg" and len(data) >= 4:
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            if marker in {0xD8, 0xD9}:
                offset += 2
                continue
            segment_length = int.from_bytes(data[offset + 2 : offset + 4], "big")
            if segment_length < 2 or offset + 2 + segment_length > len(data):
                break
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                return (
                    int.from_bytes(data[offset + 7 : offset + 9], "big"),
                    int.from_bytes(data[offset + 5 : offset + 7], "big"),
                )
            offset += 2 + segment_length
        return None
    if mime == "image/webp" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            return (
                int.from_bytes(data[24:27], "little") + 1,
                int.from_bytes(data[27:30], "little") + 1,
            )
        if chunk == b"VP8L" and data[20] == 0x2F and len(data) >= 25:
            packed = int.from_bytes(data[21:25], "little")
            return ((packed & 0x3FFF) + 1, ((packed >> 14) & 0x3FFF) + 1)
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            return (
                int.from_bytes(data[26:28], "little") & 0x3FFF,
                int.from_bytes(data[28:30], "little") & 0x3FFF,
            )
        return None
    if mime == "image/avif":
        offset = data.find(b"ispe")
        if offset >= 4 and offset + 16 <= len(data):
            box_size = int.from_bytes(data[offset - 4 : offset], "big")
            if box_size >= 20 and offset - 4 + box_size <= len(data):
                return (
                    int.from_bytes(data[offset + 8 : offset + 12], "big"),
                    int.from_bytes(data[offset + 12 : offset + 16], "big"),
                )
    return None


def decoded_image_dimensions(data: bytes, mime: str) -> tuple[int, int] | None:
    dimensions = image_dimensions(data, mime)
    if not image_magic_matches(data, mime) or not dimensions or 0 in dimensions:
        return None
    if dimensions[0] * dimensions[1] > 40_000_000:
        return None
    if Image is None:
        return dimensions
    expected_format = {
        "image/png": "PNG",
        "image/jpeg": "JPEG",
        "image/gif": "GIF",
        "image/webp": "WEBP",
        "image/avif": "AVIF",
    }[mime]
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != expected_format or image.size != dimensions:
                return None
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    except (OSError, SyntaxError, ValueError, UnidentifiedImageError):
        # Pillow builds without an AVIF plugin cannot decode a valid AVIF.
        # The service performs a mandatory native libvips decode afterwards.
        return dimensions if mime == "image/avif" else None
    return dimensions


def formal_block(content: str, path: str, validation: Validation) -> str:
    start_count = content.count(FORMAL_START)
    end_count = content.count(FORMAL_END)
    if start_count != 1 or end_count != 1:
        validation.errors.append(
            f"{path} must contain exactly one formal-content marker pair"
        )
        return ""
    start = content.index(FORMAL_START) + len(FORMAL_START)
    end = content.index(FORMAL_END)
    if end <= start:
        validation.errors.append(f"{path} has reversed formal-content markers")
        return ""
    return content[start:end]


def strip_leading_frontmatter(content: str) -> str:
    return re.sub(
        r"^\ufeff?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)",
        "",
        content,
        count=1,
    )


def countable_markdown_text(content: str, *, remove_headings: bool) -> str:
    value = strip_leading_frontmatter(content)
    value = re.sub(r"<!--[\s\S]*?-->", "", value)
    value = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"https?://[^\s)>\]]+", "", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", "", value)
    if remove_headings:
        value = re.sub(r"(?m)^#{1,6}\s+.*$", "", value)
    else:
        value = re.sub(r"(?m)^#{1,6}\s+", "", value)
    return value


def effective_characters(content: str) -> int:
    value = unicodedata.normalize("NFKC", content)
    value = re.sub(r"\s", "", value)
    value = re.sub(
        r"""[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]""",
        "",
        value,
    )
    return len(value)


def validate_archive(path: Path) -> list[str]:
    validation = Validation()
    if not path.is_file():
        return [f"archive does not exist: {path}"]
    validation.require(
        path.stat().st_size <= MAX_COMPRESSED_BYTES,
        f"compressed archive exceeds {MAX_COMPRESSED_BYTES} bytes",
    )

    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        return [f"invalid ZIP archive: {exc}"]

    with archive:
        bad_crc = archive.testzip()
        validation.require(bad_crc is None, f"ZIP CRC failed: {bad_crc}")
        entries, _root = normalized_entries(archive.infolist(), validation)
        validation.require(bool(entries), "archive contains no ordinary files")
        validation.require(
            len(entries) <= MAX_FILES,
            f"archive contains {len(entries)} files; maximum is {MAX_FILES}",
        )
        total_uncompressed = sum(info.file_size for info in entries.values())
        validation.require(
            total_uncompressed <= MAX_UNCOMPRESSED_BYTES,
            f"uncompressed archive exceeds {MAX_UNCOMPRESSED_BYTES} bytes",
        )
        allowed_suffixes = {
            ".avif",
            ".csv",
            ".doc",
            ".docx",
            ".gif",
            ".jpeg",
            ".jpg",
            ".json",
            ".md",
            ".pdf",
            ".png",
            ".ppt",
            ".pptx",
            ".sha256",
            ".webp",
            ".xls",
            ".xlsx",
        }
        forbidden_entries = {
            name
            for name in entries
            if PurePosixPath(name).suffix.lower() not in allowed_suffixes
        }
        validation.require(
            not forbidden_entries,
            "archive contains unsupported executable, webpage, or raw file "
            f"types: {sorted(forbidden_entries)[:8]}",
        )
        for required in REQUIRED_ROOT_FILES:
            validation.require(required in entries, f"missing required file: {required}")

        completeness = read_json(
            archive, entries, "00_completeness.json", validation
        )
        validation.require(
            completeness is not None,
            "00_completeness.json must retain its existing object contract",
        )
        manifest = read_json(
            archive, entries, "00_package_manifest.json", validation
        )
        if manifest is None:
            return validation.errors

        require_exact_keys(
            manifest,
            allowed=MANIFEST_KEYS,
            required=MANIFEST_KEYS,
            where="manifest",
            validation=validation,
        )
        validation.require(
            manifest.get("schemaVersion") == 1,
            "00_package_manifest.json schemaVersion must be 1",
        )
        validation.require(
            manifest.get("profile") == "dashboard-enterprise-v1",
            "00_package_manifest.json profile must be dashboard-enterprise-v1",
        )

        documents_value = manifest.get("documents")
        assets_value = manifest.get("assets")
        counts = manifest.get("counts")
        image_selection = manifest.get("imageSelection")
        validation.require(
            isinstance(documents_value, list), "manifest.documents must be an array"
        )
        validation.require(
            isinstance(assets_value, list), "manifest.assets must be an array"
        )
        validation.require(isinstance(counts, dict), "manifest.counts must be an object")
        validation.require(
            isinstance(image_selection, dict),
            "manifest.imageSelection must be an object",
        )
        if not isinstance(documents_value, list):
            documents_value = []
        if not isinstance(assets_value, list):
            assets_value = []
        if not isinstance(counts, dict):
            counts = {}
        if not isinstance(image_selection, dict):
            image_selection = {}
        require_exact_keys(
            counts,
            allowed=COUNTS_KEYS,
            required=COUNTS_KEYS,
            where="manifest.counts",
            validation=validation,
        )

        document_ids: set[str] = set()
        document_paths: set[str] = set()
        documents: dict[str, dict[str, Any]] = {}
        formal_total = 0
        evidence_total = 0
        leaf_count = 0
        branch_leaf_ids: dict[str, list[str]] = {}
        branch_overviews: dict[str, int] = {}
        formal_hashes: dict[str, str] = {}
        formal_paragraph_paths: dict[str, list[str]] = {}
        actual_leaf_status_counts = {
            status: 0 for status in ALLOWED_EVIDENCE_STATUSES
        }

        for index, raw_document in enumerate(documents_value):
            where = f"manifest.documents[{index}]"
            if not isinstance(raw_document, dict):
                validation.errors.append(f"{where} must be an object")
                continue
            require_exact_keys(
                raw_document,
                allowed=DOCUMENT_KEYS,
                required=DOCUMENT_REQUIRED_KEYS,
                where=where,
                validation=validation,
            )
            doc_id = require_string(raw_document, "id", where, validation)
            doc_path = require_string(raw_document, "path", where, validation)
            kind = require_string(raw_document, "kind", where, validation)
            require_string(raw_document, "title", where, validation)
            source_ids = require_string_list(
                raw_document, "sourceIds", where, validation
            )
            asset_ids = require_string_list(
                raw_document, "assetIds", where, validation
            )
            _ = source_ids, asset_ids
            validation.require(
                kind in ALLOWED_DOCUMENT_KINDS,
                f"{where}.kind must be one of {sorted(ALLOWED_DOCUMENT_KINDS)}",
            )
            validation.require(
                isinstance(raw_document.get("customerVisible"), bool),
                f"{where}.customerVisible must be boolean",
            )
            if "order" in raw_document:
                validation.require(
                    is_number(raw_document["order"]), f"{where}.order must be numeric"
                )
            if doc_id:
                validation.require(
                    doc_id not in document_ids, f"duplicate document id: {doc_id}"
                )
                document_ids.add(doc_id)
                documents[doc_id] = raw_document
            if doc_path:
                validation.require(
                    safe_relative_name(doc_path), f"unsafe document path: {doc_path}"
                )
                validation.require(
                    doc_path not in document_paths,
                    f"duplicate document path: {doc_path}",
                )
                document_paths.add(doc_path)
                validation.require(
                    doc_path in entries, f"manifest document is missing: {doc_path}"
                )
                validation.require(
                    PurePosixPath(doc_path).suffix.lower() == ".md",
                    f"manifest document must be Markdown: {doc_path}",
                )

            branch_id = require_string(
                raw_document, "branchId", where, validation, optional=True
            )
            evidence_status = require_string(
                raw_document,
                "evidenceStatus",
                where,
                validation,
                optional=True,
            )
            customer_visible = raw_document.get("customerVisible") is True
            if customer_visible:
                validation.require(
                    kind in {"overview", "leaf"},
                    f"{where} customerVisible documents must be overview or leaf",
                )
            if evidence_status:
                validation.require(
                    evidence_status in ALLOWED_EVIDENCE_STATUSES,
                    f"{where}.evidenceStatus must be one of "
                    f"{sorted(ALLOWED_EVIDENCE_STATUSES)}",
                )
            if kind in {"overview", "leaf"}:
                validation.require(
                    customer_visible,
                    f"{where} {kind} must be customerVisible",
                )
                validation.require(
                    bool(branch_id), f"{where}.{kind} requires branchId"
                )
                validation.require(
                    evidence_status in ALLOWED_EVIDENCE_STATUSES,
                    f"{where}.evidenceStatus must be one of "
                    f"{sorted(ALLOWED_EVIDENCE_STATUSES)}",
                )
                if evidence_status not in {
                    "needs_verification",
                    "not_applicable",
                }:
                    validation.require(
                        bool(source_ids),
                        f"{where} evidence-backed content requires sourceIds",
                    )
            if kind == "leaf":
                leaf_count += 1
                branch_leaf_ids.setdefault(branch_id, []).append(doc_id)
                if evidence_status in actual_leaf_status_counts:
                    actual_leaf_status_counts[evidence_status] += 1
            elif kind == "overview":
                branch_overviews[branch_id] = branch_overviews.get(branch_id, 0) + 1

            if not doc_path or doc_path not in entries:
                continue
            try:
                content = archive.read(entries[doc_path]).decode("utf-8")
            except UnicodeDecodeError:
                validation.errors.append(f"document is not UTF-8: {doc_path}")
                continue
            if customer_visible:
                formal = formal_block(content, doc_path, validation)
                validation.require(
                    not bool(
                        re.search(
                            r"(?im)^#{1,6}\s+.*"
                            r"(?:(?:原始|证据|引用|参考)?来源|素材清单|"
                            r"展示素材|机器清单|证据状态|状态头|"
                            r"sources?|references?|asset inventory)"
                            r".*$",
                            formal,
                        )
                    ),
                    f"{doc_path} formal block contains an evidence, source, "
                    "status, or asset-inventory section",
                )
                validation.require(
                    not bool(
                        re.search(
                            r"(?im)^\s*>\s*.*(?:状态|status)\s*[:：].*"
                            r"(?:来源|source)\s*[:：]",
                            formal,
                        )
                    ),
                    f"{doc_path} formal block contains a status/source header",
                )
                countable_formal = countable_markdown_text(
                    formal, remove_headings=True
                )
                formal_count = effective_characters(countable_formal)
                formal_total += formal_count
                if (
                    kind == "leaf"
                    and evidence_status
                    not in {"needs_verification", "not_applicable"}
                ):
                    validation.require(
                        formal_count >= MIN_LEAF_FORMAL_CHARACTERS,
                        f"{doc_path} has {formal_count} formal characters; "
                        f"leaf minimum is {MIN_LEAF_FORMAL_CHARACTERS}",
                    )
                normalized_formal_lower = unicodedata.normalize(
                    "NFKC", countable_formal
                ).lower()
                for phrase in FORBIDDEN_FORMAL_PHRASES:
                    validation.require(
                        phrase.lower() not in normalized_formal_lower,
                        f"{doc_path} formal content contains forbidden phrase: {phrase}",
                    )
                normalized_formal = re.sub(
                    r"\s+",
                    "",
                    unicodedata.normalize("NFKC", countable_formal),
                )
                if normalized_formal:
                    digest = hashlib.sha256(
                        normalized_formal.encode("utf-8")
                    ).hexdigest()
                    previous = formal_hashes.get(digest)
                    validation.require(
                        previous is None,
                        f"duplicate formal content: {previous} and {doc_path}",
                    )
                    formal_hashes[digest] = doc_path
                for paragraph in re.split(r"\n\s*\n", countable_formal):
                    normalized_paragraph = re.sub(
                        r"\s+",
                        "",
                        unicodedata.normalize("NFKC", paragraph),
                    )
                    if effective_characters(normalized_paragraph) < 120:
                        continue
                    paragraph_digest = hashlib.sha256(
                        re.sub(r"\d+", "#", normalized_paragraph).encode("utf-8")
                    ).hexdigest()
                    paths = formal_paragraph_paths.setdefault(
                        paragraph_digest, []
                    )
                    if doc_path not in paths:
                        paths.append(doc_path)
            else:
                evidence_total += effective_characters(
                    countable_markdown_text(content, remove_headings=False)
                )

        validation.require(
            MIN_LEAVES <= leaf_count <= MAX_LEAVES,
            f"manifest contains {leaf_count} leaf documents; expected {MIN_LEAVES}–{MAX_LEAVES}",
        )
        for branch_id in branch_leaf_ids:
            validation.require(
                branch_overviews.get(branch_id) == 1,
                f"branch {branch_id!r} must have exactly one overview",
            )
        for branch_id in branch_overviews:
            validation.require(
                branch_id in branch_leaf_ids,
                f"branch {branch_id!r} has an overview but no leaf",
            )
        repeated_template = next(
            (
                paths
                for paths in formal_paragraph_paths.values()
                if len(paths) >= 3
            ),
            None,
        )
        validation.require(
            repeated_template is None,
            "formal content repeats the same template paragraph across "
            f"{repeated_template or []}",
        )

        markdown_paths = {
            name for name in entries if PurePosixPath(name).suffix.lower() == ".md"
        }
        validation.require(
            markdown_paths <= document_paths,
            "every Markdown file must be registered in manifest.documents; "
            f"missing {sorted(markdown_paths - document_paths)[:8]}",
        )

        completeness_acquisition: dict[str, Any] = {}
        if completeness is not None:
            require_exact_keys(
                completeness,
                allowed={"counts", "acquisition", "gaps", "evaluatedAt"},
                required={"counts", "acquisition", "gaps", "evaluatedAt"},
                where="00_completeness.json",
                validation=validation,
            )
            completeness_counts = completeness.get("counts")
            completeness_acquisition_value = completeness.get("acquisition")
            validation.require(
                isinstance(completeness_counts, dict),
                "00_completeness.json.counts must be an object",
            )
            validation.require(
                isinstance(completeness_acquisition_value, dict),
                "00_completeness.json.acquisition must be an object",
            )
            if not isinstance(completeness_counts, dict):
                completeness_counts = {}
            if isinstance(completeness_acquisition_value, dict):
                completeness_acquisition = completeness_acquisition_value
            require_exact_keys(
                completeness_counts,
                allowed={"totalLeaves", *EVIDENCE_STATUS_COUNT_KEYS.values()},
                required={"totalLeaves", *EVIDENCE_STATUS_COUNT_KEYS.values()},
                where="00_completeness.json.counts",
                validation=validation,
            )
            for key in {"totalLeaves", *EVIDENCE_STATUS_COUNT_KEYS.values()}:
                value = completeness_counts.get(key)
                validation.require(
                    isinstance(value, int)
                    and not isinstance(value, bool)
                    and value >= 0,
                    f"00_completeness.json.counts.{key} must be a "
                    "non-negative integer",
                )
            validation.require(
                completeness_counts.get("totalLeaves") == leaf_count,
                "00_completeness.json.counts.totalLeaves must equal the "
                "actual leaf-document count",
            )
            for status, key in EVIDENCE_STATUS_COUNT_KEYS.items():
                validation.require(
                    completeness_counts.get(key)
                    == actual_leaf_status_counts[status],
                    f"00_completeness.json.counts.{key} does not match "
                    f"leaf evidenceStatus={status}",
                )
            require_exact_keys(
                completeness_acquisition,
                allowed={"officialPages", "images", "documents", "webQueries"},
                required={"officialPages", "images", "documents", "webQueries"},
                where="00_completeness.json.acquisition",
                validation=validation,
            )
            for dimension in (
                "officialPages",
                "images",
                "documents",
                "webQueries",
            ):
                raw_count = completeness_acquisition.get(dimension)
                validation.require(
                    isinstance(raw_count, dict),
                    f"00_completeness.json.acquisition.{dimension} "
                    "must be an object",
                )
                if not isinstance(raw_count, dict):
                    continue
                require_exact_keys(
                    raw_count,
                    allowed={"completed", "total"},
                    required={"completed", "total"},
                    where=f"00_completeness.json.acquisition.{dimension}",
                    validation=validation,
                )
                completed = raw_count.get("completed")
                total = raw_count.get("total")
                validation.require(
                    isinstance(completed, int)
                    and not isinstance(completed, bool)
                    and completed >= 0,
                    f"acquisition.{dimension}.completed must be a "
                    "non-negative integer",
                )
                validation.require(
                    isinstance(total, int)
                    and not isinstance(total, bool)
                    and total >= 0,
                    f"acquisition.{dimension}.total must be a "
                    "non-negative integer",
                )
                if isinstance(completed, int) and isinstance(total, int):
                    validation.require(
                        completed <= total,
                        f"acquisition.{dimension}.completed cannot exceed total",
                    )
            official_completed = (
                completeness_acquisition.get("officialPages", {}).get(
                    "completed"
                )
                if isinstance(
                    completeness_acquisition.get("officialPages"), dict
                )
                else None
            )
            documents_completed = (
                completeness_acquisition.get("documents", {}).get("completed")
                if isinstance(completeness_acquisition.get("documents"), dict)
                else None
            )
            query_count = completeness_acquisition.get("webQueries")
            validation.require(
                not isinstance(official_completed, int)
                or official_completed <= MAX_OFFICIAL_PAGES,
                f"parsed official pages exceed {MAX_OFFICIAL_PAGES}",
            )
            validation.require(
                not isinstance(documents_completed, int)
                or documents_completed <= MAX_PARSED_DOCUMENTS,
                f"parsed documents exceed {MAX_PARSED_DOCUMENTS}",
            )
            if isinstance(query_count, dict):
                validation.require(
                    all(
                        not isinstance(query_count.get(key), int)
                        or query_count[key] <= MAX_PUBLIC_QUERIES
                        for key in ("completed", "total")
                    ),
                    f"public-web queries exceed {MAX_PUBLIC_QUERIES}",
                )
            gaps = completeness.get("gaps")
            validation.require(
                isinstance(gaps, list)
                and all(
                    isinstance(gap, str) and bool(gap.strip()) for gap in gaps
                ),
                "00_completeness.json.gaps must be a string array",
            )
            evaluated_at = completeness.get("evaluatedAt")
            validation.require(
                isinstance(evaluated_at, str)
                and bool(
                    re.fullmatch(
                        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
                        r"(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
                        evaluated_at,
                    )
                ),
                "00_completeness.json.evaluatedAt must be ISO 8601",
            )

        asset_ids: set[str] = set()
        asset_paths: set[str] = set()
        asset_hashes: set[str] = set()
        image_bytes_total = 0
        assets: dict[str, dict[str, Any]] = {}
        for index, raw_asset in enumerate(assets_value):
            where = f"manifest.assets[{index}]"
            if not isinstance(raw_asset, dict):
                validation.errors.append(f"{where} must be an object")
                continue
            require_exact_keys(
                raw_asset,
                allowed=ASSET_KEYS,
                required=ASSET_REQUIRED_KEYS,
                where=where,
                validation=validation,
            )
            asset_id = require_string(raw_asset, "id", where, validation)
            asset_path = require_string(raw_asset, "path", where, validation)
            digest = require_string(raw_asset, "sha256", where, validation).lower()
            mime = require_string(raw_asset, "mimeType", where, validation).lower()
            require_string(raw_asset, "caption", where, validation)
            require_string(raw_asset, "alt", where, validation, optional=True)
            asset_branch_id = require_string(
                raw_asset, "branchId", where, validation
            )
            source_page_url = require_string(
                raw_asset,
                "sourcePageUrl",
                where,
                validation,
                optional=True,
            )
            source_asset_url = require_string(
                raw_asset,
                "sourceAssetUrl",
                where,
                validation,
                optional=True,
            )
            ownership = require_string(raw_asset, "ownership", where, validation)
            related_documents = require_string_list(
                raw_asset, "documentIds", where, validation
            )
            validation.require(
                ownership == "first_party",
                f"{where}.ownership must be first_party",
            )
            for key, url in (
                ("sourcePageUrl", source_page_url),
                ("sourceAssetUrl", source_asset_url),
            ):
                if not url:
                    continue
                validation.require(
                    bool(
                        re.fullmatch(
                            r"https?://[^/\s:@]+(?::\d+)?(?:/[^@\s]*)?",
                            url,
                            flags=re.IGNORECASE,
                        )
                    )
                    and "@" not in url.split("://", 1)[-1].split("/", 1)[0],
                    f"{where}.{key} must be a credential-free HTTP(S) URL",
                )
            for key in ("bytes", "width", "height"):
                value = raw_asset.get(key)
                validation.require(
                    is_number(value) and int(value) > 0,
                    f"{where}.{key} must be a positive number",
                )
            validation.require(
                bool(re.fullmatch(r"[0-9a-f]{64}", digest)),
                f"{where}.sha256 must be 64 lowercase hexadecimal characters",
            )
            if asset_id:
                validation.require(
                    asset_id not in asset_ids, f"duplicate asset id: {asset_id}"
                )
                asset_ids.add(asset_id)
                assets[asset_id] = raw_asset
            if asset_path:
                validation.require(
                    safe_relative_name(asset_path), f"unsafe asset path: {asset_path}"
                )
                validation.require(
                    asset_path not in asset_paths, f"duplicate asset path: {asset_path}"
                )
                asset_paths.add(asset_path)
            suffix = PurePosixPath(asset_path).suffix.lower()
            expected_mime = IMAGE_TYPES.get(suffix)
            validation.require(
                expected_mime is not None,
                f"unsupported image extension for {asset_path}",
            )
            validation.require(
                expected_mime == mime,
                f"MIME/extension mismatch for {asset_path}: {mime}",
            )
            info = entries.get(asset_path)
            if not validation.require(
                info is not None, f"manifest asset is missing: {asset_path}"
            ):
                continue
            data = archive.read(info)
            actual_digest = hashlib.sha256(data).hexdigest()
            validation.require(
                raw_asset.get("bytes") == len(data),
                f"declared byte length does not match {asset_path}",
            )
            validation.require(
                digest == actual_digest, f"SHA-256 does not match {asset_path}"
            )
            validation.require(
                image_magic_matches(data, mime),
                f"magic bytes do not match {mime} for {asset_path}",
            )
            dimensions = decoded_image_dimensions(data, mime)
            validation.require(
                dimensions is not None,
                f"could not decode a valid image for {asset_path}",
            )
            if dimensions is not None:
                validation.require(
                    raw_asset.get("width") == dimensions[0]
                    and raw_asset.get("height") == dimensions[1],
                    f"declared dimensions do not match {asset_path}",
                )
            validation.require(
                actual_digest not in asset_hashes,
                f"duplicate image content hash: {asset_path}",
            )
            asset_hashes.add(actual_digest)
            image_bytes_total += len(data)
            validation.require(
                bool(related_documents),
                f"{where}.documentIds must contain at least one document",
            )
            for document_id in related_documents:
                validation.require(
                    document_id in documents,
                    f"{where} references unknown document: {document_id}",
                )
                if document_id in documents:
                    validation.require(
                        documents[document_id].get("customerVisible") is True,
                        f"{where} may only link packaged images to customer-visible documents",
                    )
                    validation.require(
                        documents[document_id].get("branchId")
                        == asset_branch_id,
                        f"{where}.branchId must match linked document "
                        f"{document_id}",
                    )

        actual_image_paths = {
            name
            for name in entries
            if PurePosixPath(name).suffix.lower() in IMAGE_TYPES
        }
        unsupported_images = {
            name
            for name in entries
            if PurePosixPath(name).suffix.lower()
            in {".svg", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".ico"}
        }
        validation.require(
            not unsupported_images,
            "unsupported or non-rasterized image files are packaged: "
            f"{sorted(unsupported_images)[:8]}",
        )
        validation.require(
            actual_image_paths == asset_paths,
            "image files and manifest.assets paths differ; "
            f"unlisted={sorted(actual_image_paths - asset_paths)[:8]}, "
            f"missing={sorted(asset_paths - actual_image_paths)[:8]}",
        )
        validation.require(
            len(asset_paths) <= MAX_IMAGES,
            f"archive must contain no more than {MAX_IMAGES} real packaged images",
        )
        validation.require(
            image_bytes_total <= MAX_IMAGE_BYTES,
            f"packaged images use {image_bytes_total} bytes; maximum is {MAX_IMAGE_BYTES}",
        )

        for doc_id, document in documents.items():
            for asset_id in require_string_list(
                document, "assetIds", f"document {doc_id}", validation
            ):
                validation.require(
                    asset_id in assets,
                    f"document {doc_id} references unknown asset: {asset_id}",
                )
                if asset_id in assets:
                    validation.require(
                        doc_id in assets[asset_id].get("documentIds", []),
                        f"asset relationship is not reciprocal: {doc_id} / {asset_id}",
                    )
        for asset_id, asset in assets.items():
            for doc_id in asset.get("documentIds", []):
                if doc_id in documents:
                    validation.require(
                        asset_id in documents[doc_id].get("assetIds", []),
                        f"document relationship is not reciprocal: {doc_id} / {asset_id}",
                    )

        eligible = image_selection.get("eligibleFirstPartyImages")
        require_exact_keys(
            image_selection,
            allowed={"eligibleFirstPartyImages", "shortfallReason"},
            required=(
                {"eligibleFirstPartyImages"}
                if isinstance(eligible, int)
                and not isinstance(eligible, bool)
                and eligible >= MIN_TARGET_IMAGES
                else {"eligibleFirstPartyImages", "shortfallReason"}
            ),
            where="manifest.imageSelection",
            validation=validation,
        )
        validation.require(
            isinstance(eligible, int) and not isinstance(eligible, bool) and eligible >= 0,
            "imageSelection.eligibleFirstPartyImages must be a non-negative integer",
        )
        shortfall = image_selection.get("shortfallReason")
        if isinstance(eligible, int) and not isinstance(eligible, bool):
            validation.require(
                len(asset_paths) <= eligible,
                "packaged image count cannot exceed eligibleFirstPartyImages",
            )
            if eligible >= MIN_TARGET_IMAGES:
                validation.require(
                    MIN_TARGET_IMAGES <= len(asset_paths) <= MAX_IMAGES,
                    f"{eligible} eligible images require packaging {MIN_TARGET_IMAGES}–{MAX_IMAGES}",
                )
                validation.require(
                    "shortfallReason" not in image_selection,
                    "imageSelection.shortfallReason must be omitted when "
                    "at least 360 images are eligible",
                )
            else:
                validation.require(
                    len(asset_paths) == eligible,
                    "when fewer than 360 images are eligible, package every eligible image",
                )
                validation.require(
                    isinstance(shortfall, str) and bool(shortfall.strip()),
                    "imageSelection.shortfallReason is required below 360 eligible images",
                )
            discovered_images = (
                completeness_acquisition.get("images", {}).get("total")
                if isinstance(completeness_acquisition.get("images"), dict)
                else None
            )
            validation.require(
                not isinstance(discovered_images, int)
                or eligible <= discovered_images,
                "eligibleFirstPartyImages cannot exceed acquisition.images.total",
            )

        packaged_completed = (
            completeness_acquisition.get("images", {}).get("completed")
            if isinstance(completeness_acquisition.get("images"), dict)
            else None
        )
        validation.require(
            packaged_completed == len(asset_paths),
            "00_completeness.json acquisition.images.completed must equal "
            "the actual packaged image count",
        )
        crawl_report_info = entries.get("00_crawl_coverage_report.md")
        if crawl_report_info is not None:
            try:
                crawl_report = archive.read(crawl_report_info).decode("utf-8")
            except UnicodeDecodeError:
                crawl_report = ""
            reported_image_count: int | None = None
            for pattern in (
                r"(?:成功下载|已下载|已保存|保存并打包|downloaded|packaged|saved)"
                r"[^\n|]{0,30}(?:图片|图像|images?|assets?)[^\d]{0,12}([\d,]+)",
                r"(?:图片|图像|images?|assets?)[^\n|]{0,30}"
                r"(?:成功下载|已下载|已保存|保存并打包|downloaded|packaged|saved)"
                r"[^\d]{0,12}([\d,]+)",
                r"第一方图片资源[^\d\n|]{0,20}([\d,]+)",
            ):
                match = re.search(pattern, crawl_report, flags=re.IGNORECASE)
                if match:
                    reported_image_count = int(match.group(1).replace(",", ""))
                    break
            if reported_image_count is not None:
                validation.require(
                    reported_image_count == len(asset_paths),
                    "crawl report saved-image count does not match actual "
                    "packaged images",
                )

        expected_counts = {
            "totalFiles": len(entries),
            "customerVisibleCharacters": formal_total,
            "evidenceCharacters": evidence_total,
            "packagedImages": len(asset_paths),
        }
        for key, actual in expected_counts.items():
            validation.require(
                counts.get(key) == actual,
                f"manifest.counts.{key} must be {actual}, got {counts.get(key)!r}",
            )
        validation.require(
            MIN_FORMAL_CHARACTERS <= formal_total <= MAX_FORMAL_CHARACTERS,
            f"customer-visible formal content has {formal_total} characters; "
            f"expected {MIN_FORMAL_CHARACTERS}–{MAX_FORMAL_CHARACTERS}",
        )
        validation.require(
            evidence_total <= MAX_EVIDENCE_CHARACTERS,
            f"evidence content has {evidence_total} characters; "
            f"maximum is {MAX_EVIDENCE_CHARACTERS}",
        )

    return validation.errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a dashboard-enterprise-v1 knowledge-base ZIP."
    )
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    errors = validate_archive(args.archive.resolve())
    if errors:
        print(f"INVALID: {len(errors)} error(s)", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("VALID dashboard-enterprise-v1 archive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
