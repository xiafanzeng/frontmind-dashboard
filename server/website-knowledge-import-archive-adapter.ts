import { createHash } from "node:crypto";

import JSZip from "jszip";

import { validateKnowledgeArchiveEntryPath } from "./knowledge-archive-text-utils";

export const WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT =
  "frontmind_website_knowledge_base";

const CANONICAL_ROOT_PREFIX = `${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/`;
const CANONICAL_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 2_000;
const MAX_UNPACKED_BYTES = 220 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const PACKAGE_MANIFEST_PATH = "00_package_manifest.json";
const COMPLETENESS_PATH = "00_completeness.json";
const STANDARD_PACKAGE_PATHS = [
  "README.md",
  "00_knowledge_tree.md",
  "00_crawl_coverage_report.md",
  "00_web_intelligence_report.md",
  "00_source_index.md",
  "09_media_assets/asset_inventory.md",
  "10_reference_assets/reference_asset_inventory.md",
  PACKAGE_MANIFEST_PATH,
  COMPLETENESS_PATH,
] as const;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

type LoadedFile = {
  path: string;
  normalizedPath: string;
  bytes: Buffer;
};

export class WebsiteKnowledgeImportArchiveError extends Error {
  readonly code = "WEBSITE_KNOWLEDGE_IMPORT_ARCHIVE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WebsiteKnowledgeImportArchiveError";
  }
}

function invalid(message: string): never {
  throw new WebsiteKnowledgeImportArchiveError(message);
}

function normalizedPath(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function fileExtension(value: string) {
  const basename = value.slice(value.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function isIgnoredMetadataPath(value: string) {
  return (
    value.startsWith("__MACOSX/") ||
    value === ".DS_Store" ||
    value.endsWith("/.DS_Store")
  );
}

function unixPermissions(entry: JSZip.JSZipObject) {
  const value = entry.unixPermissions;
  return typeof value === "string" ? Number.parseInt(value, 8) : value;
}

function declaredSizes(entry: JSZip.JSZipObject) {
  const data = (
    entry as typeof entry & {
      _data?: { compressedSize?: number; uncompressedSize?: number };
    }
  )._data;
  return {
    compressed: Number(data?.compressedSize || 0),
    uncompressed: Number(data?.uncompressedSize || 0),
  };
}

function standardPathOccurrences(
  files: readonly LoadedFile[],
  standardPath: string,
) {
  const standard = normalizedPath(standardPath);
  return files.filter(
    (file) =>
      file.normalizedPath === standard ||
      file.normalizedPath.endsWith(`/${standard}`),
  );
}

function parentPath(value: string) {
  const slash = value.lastIndexOf("/");
  return slash < 0 ? "" : value.slice(0, slash);
}

function centralDirectoryEntryCount(buffer: Buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentBytes !== buffer.length) continue;
    const diskNumber = buffer.readUInt16LE(offset + 4);
    const directoryDisk = buffer.readUInt16LE(offset + 6);
    const entriesOnDisk = buffer.readUInt16LE(offset + 8);
    const totalEntries = buffer.readUInt16LE(offset + 10);
    if (
      diskNumber !== 0 ||
      directoryDisk !== 0 ||
      entriesOnDisk !== totalEntries ||
      totalEntries === 0xffff
    ) {
      invalid("Website 知识库 ZIP 不支持分卷或 ZIP64 目录");
    }
    return totalEntries;
  }
  invalid("Website 知识库 ZIP 缺少有效中央目录");
}

async function loadSafeWebsiteArchive(buffer: Buffer) {
  if (
    buffer.length < 4 ||
    buffer.length > MAX_ARCHIVE_BYTES ||
    !["PK\u0003\u0004", "PK\u0005\u0006", "PK\u0007\u0008"].includes(
      buffer.subarray(0, 4).toString("binary"),
    )
  ) {
    invalid("Website 知识库不是有效且有界的 ZIP 归档");
  }
  const declaredEntryCount = centralDirectoryEntryCount(buffer);
  if (
    declaredEntryCount === 0 ||
    declaredEntryCount > MAX_ARCHIVE_ENTRIES + MAX_ARCHIVE_DIRECTORY_ENTRIES
  ) {
    invalid("Website 知识库 ZIP 文件数量超出限制");
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    invalid("Website 知识库 ZIP 无法解析或 CRC 校验失败");
  }

  const entries = Object.values(archive.files);
  if (entries.length !== declaredEntryCount) {
    invalid("Website 知识库 ZIP 包含重复或含糊的中央目录路径");
  }
  const fileEntryCount = entries.filter((entry) => !entry.dir).length;
  if (fileEntryCount === 0 || fileEntryCount > MAX_ARCHIVE_ENTRIES) {
    invalid("Website 知识库 ZIP 文件数量超出限制");
  }

  const seenPaths = new Set<string>();
  const files: LoadedFile[] = [];
  let unpackedBytes = 0;
  for (const entry of entries) {
    const raw = entry as typeof entry & { unsafeOriginalName?: string };
    const rawName = raw.unsafeOriginalName || entry.name;
    const candidatePath = rawName.endsWith("/")
      ? rawName.slice(0, -1)
      : rawName;
    let safePath: string;
    try {
      safePath = validateKnowledgeArchiveEntryPath(candidatePath);
    } catch {
      invalid("Website 知识库 ZIP 包含不安全的文件路径");
    }
    const loadedPath = entry.name.endsWith("/")
      ? entry.name.slice(0, -1)
      : entry.name;
    if (loadedPath !== safePath) {
      invalid("Website 知识库 ZIP 包含经过路径清理的文件名");
    }
    const pathKey = normalizedPath(safePath);
    if (seenPaths.has(pathKey)) {
      invalid("Website 知识库 ZIP 包含重复规范路径");
    }
    seenPaths.add(pathKey);

    const permissions = unixPermissions(entry);
    if (
      typeof permissions === "number" &&
      (permissions & 0o170000) === 0o120000
    ) {
      invalid("Website 知识库 ZIP 不允许包含符号链接");
    }
    if (entry.dir) continue;

    const declared = declaredSizes(entry);
    const entryLimit = IMAGE_EXTENSIONS.has(fileExtension(safePath))
      ? MAX_IMAGE_BYTES
      : MAX_DOCUMENT_BYTES;
    if (
      declared.uncompressed > entryLimit ||
      (declared.uncompressed > 1024 * 1024 &&
        declared.compressed > 0 &&
        declared.uncompressed / declared.compressed > MAX_COMPRESSION_RATIO)
    ) {
      invalid("Website 知识库 ZIP 单文件大小或压缩比超出限制");
    }
    const bytes = await entry.async("nodebuffer");
    if (bytes.length > entryLimit) {
      invalid("Website 知识库 ZIP 单文件大小超出限制");
    }
    unpackedBytes += bytes.length;
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      invalid("Website 知识库 ZIP 解压后总大小超出限制");
    }
    if (isIgnoredMetadataPath(safePath)) continue;
    files.push({ path: safePath, normalizedPath: pathKey, bytes });
  }
  if (files.length === 0) {
    invalid("Website 知识库 ZIP 不包含可导入文件");
  }
  return files;
}

function resolveSourceRoot(files: readonly LoadedFile[]) {
  const manifestEntries = standardPathOccurrences(files, PACKAGE_MANIFEST_PATH);
  const completenessEntries = standardPathOccurrences(files, COMPLETENESS_PATH);
  if (manifestEntries.length !== 1 || completenessEntries.length !== 1) {
    invalid(
      "Website 知识库 ZIP 必须各包含一份 package manifest 和 completeness",
    );
  }
  const manifestRoot = parentPath(manifestEntries[0]!.path);
  const completenessRoot = parentPath(completenessEntries[0]!.path);
  if (
    manifestRoot !== completenessRoot ||
    (manifestRoot && manifestRoot.includes("/"))
  ) {
    invalid("Website 知识库 ZIP 的标准文件不在同一包根目录");
  }

  for (const standardPath of STANDARD_PACKAGE_PATHS) {
    const occurrences = standardPathOccurrences(files, standardPath);
    const expectedPath = manifestRoot
      ? `${manifestRoot}/${standardPath}`
      : standardPath;
    if (occurrences.length !== 1 || occurrences[0]!.path !== expectedPath) {
      invalid(`Website 知识库 ZIP 的标准文件重复或位置无效：${standardPath}`);
    }
  }
  return manifestRoot;
}

/**
 * Normalizes only the Website knowledge-import boundary. The original final
 * artifact identity remains bound to its raw bytes before this function runs;
 * the returned bytes are the sole archive consumed by the strict reader and
 * durable snapshot path.
 */
export async function canonicalizeWebsiteKnowledgeImportArchive(
  buffer: Buffer,
) {
  const files = await loadSafeWebsiteArchive(buffer);
  const sourceRoot = resolveSourceRoot(files);
  const sourcePrefix = sourceRoot ? `${sourceRoot}/` : "";
  const canonicalFiles: Array<{ path: string; bytes: Buffer }> = [];
  const seenRelativePaths = new Set<string>();
  for (const file of files) {
    if (sourcePrefix && !file.path.startsWith(sourcePrefix)) {
      invalid("Website 知识库 ZIP 在包根目录之外包含文件");
    }
    const relativePath = sourcePrefix
      ? file.path.slice(sourcePrefix.length)
      : file.path;
    let safeRelativePath: string;
    try {
      safeRelativePath = validateKnowledgeArchiveEntryPath(relativePath);
    } catch {
      invalid("Website 知识库 ZIP 包含无效的包内相对路径");
    }
    const relativeKey = normalizedPath(safeRelativePath);
    if (seenRelativePaths.has(relativeKey)) {
      invalid("Website 知识库 ZIP 归一化后包含重复路径");
    }
    seenRelativePaths.add(relativeKey);
    canonicalFiles.push({
      path: `${CANONICAL_ROOT_PREFIX}${safeRelativePath}`,
      bytes: file.bytes,
    });
  }
  canonicalFiles.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  const canonical = new JSZip();
  for (const file of canonicalFiles) {
    canonical.file(file.path, file.bytes, {
      binary: true,
      createFolders: false,
      date: CANONICAL_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const canonicalBuffer = await canonical.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    streamFiles: false,
  });
  return {
    buffer: canonicalBuffer,
    sha256: createHash("sha256").update(canonicalBuffer).digest("hex"),
  };
}
