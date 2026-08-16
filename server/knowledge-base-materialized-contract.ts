import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";

import {
  DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS,
  ModelOutputRepairError,
  parseExactJson,
  repairStructuredJsonCandidate,
} from "../shared/model-output-repair";
import { customerSafeKnowledgeAssetLabel } from "../shared/knowledge-base-public-artifacts";
import {
  canonicalizeKnowledgeBaseCompanyName,
  canonicalizeKnowledgeBaseWebsite,
  KnowledgeBaseCompanyIdentityNormalizationError,
} from "./knowledge-base-company-identity";
import { canonicalKnowledgeBaseMarkdown } from "./knowledge-base-package-validation";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/u;
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_500;
const MAX_COMPRESSION_RATIO = 200;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const PATCH_WARNING_LIMIT = 50;

export const KNOWLEDGE_BASE_ASSET_TYPES = [
  "brand_identity",
  "product_ui",
  "product_diagram",
  "case_photo",
  "team_photo",
  "environment_photo",
  "certificate_badge",
  "document_figure",
  "customer_supplied",
  "other",
] as const;
export const KNOWLEDGE_BASE_ASSET_DISPLAY_ROLES = [
  "hero",
  "inline",
  "badge",
] as const;

type KnowledgeBaseAssetType = (typeof KNOWLEDGE_BASE_ASSET_TYPES)[number];
type KnowledgeBaseAssetDisplayRole =
  (typeof KNOWLEDGE_BASE_ASSET_DISPLAY_ROLES)[number];

const FORMAL_CONTENT_MARKERS = [
  ["FRONTMIND_FORMAL_CONTENT_START", "FRONTMIND_FORMAL_CONTENT_END"],
  [
    "<!-- FRONTMIND_FORMAL_CONTENT_START -->",
    "<!-- FRONTMIND_FORMAL_CONTENT_END -->",
  ],
] as const;
const INTERNAL_NODE_HEADINGS = new Set(["## 资料元数据", "## 证据与核验说明"]);
const INTERNAL_NODE_FIELD_RE =
  /^\s*(?:[-*+]\s+)?(?:documentRole|evidenceStatus|sourceIds|evidenceDocumentIds|sameBranchEvidenceDocumentIds|evidenceCharacters|formalCharacters|requiredFormalCharacters)\s*[:：=]/imu;
const FORMAL_CONTENT_MARKER_RE = /FRONTMIND_FORMAL_CONTENT_(?:START|END)/u;

type JsonObject = Record<string, unknown>;

export type KnowledgeBaseWorkingSetBranch = {
  branchId: string;
  title: string;
  ordinal: number;
};

export type KnowledgeBaseWorkingSetEvidence = {
  path: string;
  sha256: string;
  leafId: string;
  sourceUrl: string | null;
  retrievedAt: string | null;
};

export type KnowledgeBaseWorkingSetAsset = {
  assetId: string;
  path: string;
  sha256: string;
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/gif"
    | "image/avif";
  bytes: number;
  width: number;
  height: number;
  provenance: JsonObject;
  documentIds: string[];
  assetType?: KnowledgeBaseAssetType;
  displayRole?: KnowledgeBaseAssetDisplayRole;
  caption?: string;
};

export type KnowledgeBasePatchAttachmentSourceProof = Readonly<{
  index: number;
  contentSha256: string;
  sizeBytes: number;
  mimeType: string;
}>;

export type KnowledgeBaseWorkingSetLeaf = {
  leafId: string;
  branchId: string;
  branchTitle: string;
  title: string;
  ordinal: number;
  contentPath: string;
  contentSha256: string;
  evidencePaths: string[];
  assetIds: string[];
  productFamilyId?: string;
};

export type KnowledgeBaseWorkingSetManifest = {
  kind: "frontmind.kb-working-set";
  schemaVersion: 1;
  operationId: string;
  buildId: string;
  generation: number;
  contentVersion: number;
  skill: {
    name: "socratic-kb-builder";
    version: "5";
    contentHash: string;
  };
  treePolicyVersion: 2;
  company: { name: string; website: string | null };
  researchCoverage: JsonObject;
  branches: KnowledgeBaseWorkingSetBranch[];
  evidenceLedger: KnowledgeBaseWorkingSetEvidence[];
  leaves: KnowledgeBaseWorkingSetLeaf[];
  assets: KnowledgeBaseWorkingSetAsset[];
  logo:
    | { status: "missing"; assetId: null }
    | { status: "available"; assetId: string };
  counts: { leaves: number; evidenceFiles: number; assets: number };
};

/**
 * Immutable coordinates owned by Dashboard for one initial materialization.
 * The provider must only copy these values into BUNDLE.json; it never derives
 * them from the Skill archive, customer files, or an earlier response.
 */
export type KnowledgeBaseWorkingSetExpectation = Readonly<{
  operationId: string;
  buildId: string;
  generation: number;
  contentVersion: number;
  skillContentHash: string;
  treePolicyVersion: number;
  companyName: string;
  companyWebsite: string | null;
  expectedUploadsRead?: number;
}>;

export type KnowledgeBaseInitialBundleExpectation = Readonly<
  Omit<
    KnowledgeBaseWorkingSetExpectation,
    "contentVersion" | "treePolicyVersion" | "expectedUploadsRead"
  > & {
    contentVersion: 1;
    treePolicyVersion: 2;
    expectedUploadsRead: number;
  }
>;

export type KnowledgeBaseNodePatchManifest = {
  kind: "frontmind.kb-node-patch";
  schemaVersion: 1;
  operationId: string;
  buildId: string;
  generation: number;
  baseContentVersion: number;
  baseWorkingSetSha256: string;
  targetLeafId: string;
  contentPath: string;
  contentSha256: string;
  evidence: {
    add: Array<Pick<KnowledgeBaseWorkingSetEvidence, "path" | "sha256">>;
    remove: string[];
  };
  assets: {
    add: KnowledgeBaseWorkingSetAsset[];
    remove: string[];
  };
};

export type ValidatedKnowledgeBaseWorkingSet = {
  manifest: KnowledgeBaseWorkingSetManifest;
  files: ReadonlyMap<string, Buffer>;
  /** Dashboard-authored deterministic bytes; Provider ZIP bytes are staging-only. */
  archiveBytes: Buffer;
  packageSha256: string;
  manifestSha256: string;
  warnings: Array<{
    code:
      | "RESULT_INCOMPLETE"
      | "EVIDENCE_INCOMPLETE"
      | "PRESENTATION_NORMALIZED"
      | "OPTIONAL_ASSET_SKIPPED";
    area?: string;
  }>;
  droppedOptionalCount: number;
};

export type ValidatedKnowledgeBaseNodePatch = {
  manifest: KnowledgeBaseNodePatchManifest;
  files: ReadonlyMap<string, Buffer>;
  archiveBytes: Buffer;
  packageSha256: string;
  manifestSha256: string;
  components: {
    content: "valid" | "invalid";
    evidence: "valid" | "invalid";
    assets: "valid" | "invalid";
  };
  warnings: Array<{
    code:
      | "MANIFEST_NORMALIZED"
      | "PRESENTATION_NORMALIZED"
      | "EVIDENCE_INCOMPLETE"
      | "OPTIONAL_ASSET_SKIPPED";
    area: "manifest" | "content" | "evidence" | "assets";
  }>;
  droppedComponents: {
    evidence: number;
    assets: number;
    presentationFields: number;
  };
};

export class KnowledgeBaseMaterializedContractError extends Error {
  readonly code = "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID";

  constructor(
    message: string,
    readonly category:
      | "contract"
      | "manifest_parse"
      | "frozen_source_conflict" = "contract",
  ) {
    super(message);
    this.name = "KnowledgeBaseMaterializedContractError";
  }
}

function fail(
  message: string,
  category: KnowledgeBaseMaterializedContractError["category"] = "contract",
): never {
  throw new KnowledgeBaseMaterializedContractError(message, category);
}

export function isKnowledgeBasePatchManifestParseError(error: unknown) {
  return (
    error instanceof KnowledgeBaseMaterializedContractError &&
    error.category === "manifest_parse"
  );
}

/**
 * Projects a provider-authored node into the one customer-visible Markdown
 * representation used by Working Set bytes, database rows and final packages.
 * The adapter only removes deterministic transport wrappers; it never rewrites
 * the customer's prose or guesses between multiple candidate bodies.
 */
export function projectKnowledgeBaseCustomerMarkdown(input: {
  leafTitle: string;
  markdown: string;
}) {
  const source = canonicalKnowledgeBaseMarkdown(input.markdown);
  const title = canonicalKnowledgeBaseMarkdown(input.leafTitle).replace(
    /\n+/gu,
    " ",
  );
  if (!source || !title) fail("节点客户正文不得为空");

  const lines = source.split("\n");
  let body = source;
  const matchedRanges: Array<{ start: number; end: number }> = [];
  for (const [startMarker, endMarker] of FORMAL_CONTENT_MARKERS) {
    const starts = lines.flatMap((line, index) =>
      line.trim() === startMarker ? [index] : [],
    );
    const ends = lines.flatMap((line, index) =>
      line.trim() === endMarker ? [index] : [],
    );
    if (starts.length || ends.length) {
      if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) {
        fail("节点正式正文标记不唯一或顺序无效");
      }
      matchedRanges.push({ start: starts[0]!, end: ends[0]! });
    }
  }
  if (matchedRanges.length > 1) fail("节点包含多组正式正文标记");
  if (matchedRanges.length === 1) {
    const range = matchedRanges[0]!;
    body = lines.slice(range.start + 1, range.end).join("\n");
  } else {
    const internalHeadingIndex = lines.findIndex((line) =>
      INTERNAL_NODE_HEADINGS.has(line.trim()),
    );
    if (internalHeadingIndex >= 0) {
      body = lines.slice(0, internalHeadingIndex).join("\n");
    }
  }

  body = canonicalKnowledgeBaseMarkdown(body);
  const bodyLines = body.split("\n");
  const firstLineTitle = bodyLines[0]?.match(/^#\s+(.+)$/u)?.[1]?.trim();
  if (firstLineTitle === title) {
    body = canonicalKnowledgeBaseMarkdown(bodyLines.slice(1).join("\n"));
  }
  if (
    !body ||
    FORMAL_CONTENT_MARKER_RE.test(body) ||
    body.split("\n").some((line) => INTERNAL_NODE_HEADINGS.has(line.trim())) ||
    INTERNAL_NODE_FIELD_RE.test(body)
  ) {
    fail("节点客户正文为空或仍包含内部元数据");
  }
  return canonicalKnowledgeBaseMarkdown(`# ${title}\n\n${body}`);
}

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    fail(`${label} 字段不符合合同`);
  }
}

function string(value: unknown, label: string, max = 1_024) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) fail(`${label} 无效`);
  return normalized;
}

function nullableString(value: unknown, label: string, max = 2_048) {
  if (value === null) return null;
  return string(value, label, max);
}

function integer(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} 无效`);
  }
  return Number(value);
}

function id(value: unknown, label: string) {
  const normalized = string(value, label, 191);
  if (!SAFE_ID_RE.test(normalized)) fail(`${label} 无效`);
  return normalized;
}

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(`${label} 无效`);
  }
  return value;
}

function safeArchivePath(value: unknown, label: string) {
  const path = string(value, label, 1_024);
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label} 包含不安全路径`);
  }
  return path;
}

function stringArray(value: unknown, label: string, mapper = string) {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  return value.map((item, index) => mapper(item, `${label}[${index}]`));
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail(`${label} 包含重复项`);
}

async function loadSafeArchive(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) {
    fail("ZIP 压缩字节数无效");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    fail("ZIP 无法解析或 CRC 校验失败");
  }
  const entries = Object.values(zip.files);
  if (!entries.length || entries.length > MAX_ENTRY_COUNT) {
    fail("ZIP 文件数量无效");
  }
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const entry of entries) {
    const raw = entry as typeof entry & {
      unsafeOriginalName?: string;
      unixPermissions?: number | string | null;
      _data?: { compressedSize?: number; uncompressedSize?: number };
    };
    const path = safeArchivePath(entry.name, "ZIP 文件名");
    if (raw.unsafeOriginalName && raw.unsafeOriginalName !== path) {
      fail("ZIP 包含路径穿越文件名");
    }
    const unixPermissions =
      typeof raw.unixPermissions === "string"
        ? Number.parseInt(raw.unixPermissions, 8)
        : raw.unixPermissions;
    if (
      entry.dir ||
      (typeof unixPermissions === "number" &&
        (unixPermissions & 0o170000) === 0o120000)
    ) {
      fail("ZIP 不得包含目录或符号链接");
    }
    if (files.has(path)) fail("ZIP 文件名重复");
    const uncompressedHint = Number(raw._data?.uncompressedSize || 0);
    const compressedHint = Number(raw._data?.compressedSize || 0);
    if (
      uncompressedHint > 0 &&
      compressedHint > 0 &&
      uncompressedHint / compressedHint > MAX_COMPRESSION_RATIO
    ) {
      fail("ZIP 压缩比异常");
    }
    const payload = await entry.async("nodebuffer");
    totalBytes += payload.length;
    if (totalBytes > MAX_ARCHIVE_BYTES) fail("ZIP 解压总字节数超限");
    files.set(path, payload);
  }
  return files;
}

type MaterializedManifestNormalization =
  | "bom"
  | "markdown_fence"
  | "serialized_string";

function rejectAmbiguousMaterializedJsonFailure(
  candidate: string,
  path: string,
) {
  try {
    repairStructuredJsonCandidate(candidate);
  } catch (error) {
    if (
      error instanceof ModelOutputRepairError &&
      ["DUPLICATE_KEY", "MULTIPLE_CANDIDATES"].includes(error.code)
    ) {
      fail(`${path} 包含重复键或多个 JSON 值`);
    }
  }
}

function parseMaterializedJsonEnvelope(text: string, path: string) {
  const normalizations: MaterializedManifestNormalization[] = [];
  let candidate = text;
  if (candidate.startsWith("\uFEFF")) {
    candidate = candidate.slice(1);
    normalizations.push("bom");
  }
  if (candidate.length > DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS) {
    fail(`${path} 超过安全 JSON 上限`);
  }

  let parsed: unknown;
  try {
    parsed = parseExactJson(candidate);
  } catch (initialError) {
    if (
      initialError instanceof ModelOutputRepairError &&
      initialError.code === "DUPLICATE_KEY"
    ) {
      fail(`${path} 包含重复 JSON 键`);
    }
    rejectAmbiguousMaterializedJsonFailure(candidate, path);
    const fenced = candidate.match(
      /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/iu,
    );
    if (!fenced || fenced[1]!.includes("```")) {
      fail(
        `${path} 不是有效 JSON`,
        fenced?.[1]?.includes("```") ? "contract" : "manifest_parse",
      );
    }
    candidate = fenced[1]!;
    normalizations.push("markdown_fence");
    try {
      parsed = parseExactJson(candidate);
    } catch (error) {
      if (
        error instanceof ModelOutputRepairError &&
        error.code === "DUPLICATE_KEY"
      ) {
        fail(`${path} 包含重复 JSON 键`);
      }
      rejectAmbiguousMaterializedJsonFailure(candidate, path);
      // Keep duplicate keys, multiple values and ambiguous fenced content on
      // the same hard-failure boundary as the exact parser.
      void initialError;
      fail(`${path} 不是有效 JSON`, "manifest_parse");
    }
  }

  if (typeof parsed === "string") {
    normalizations.push("serialized_string");
    const serialized = parsed;
    try {
      parsed = parseExactJson(serialized);
    } catch (error) {
      if (
        error instanceof ModelOutputRepairError &&
        error.code === "DUPLICATE_KEY"
      ) {
        fail(`${path} 包含重复 JSON 键`);
      }
      rejectAmbiguousMaterializedJsonFailure(serialized, path);
      fail(`${path} 不是有效 JSON`, "manifest_parse");
    }
    if (typeof parsed === "string") {
      fail(`${path} 不得被重复序列化`);
    }
  }
  return {
    value: object(parsed, path),
    normalizations,
  };
}

function parseJsonFileDetailed(
  files: ReadonlyMap<string, Buffer>,
  path: string,
) {
  const bytes = files.get(path);
  if (!bytes) fail(`ZIP 缺少 ${path}`);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseMaterializedJsonEnvelope(text, path);
  } catch (error) {
    if (error instanceof KnowledgeBaseMaterializedContractError) throw error;
    fail(`${path} 不是有效 JSON`, "manifest_parse");
  }
}

function parseJsonFile(files: ReadonlyMap<string, Buffer>, path: string) {
  return parseJsonFileDetailed(files, path).value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function canonicalWorkingSetArchive(input: {
  manifest: KnowledgeBaseWorkingSetManifest;
  files: ReadonlyMap<string, Buffer>;
}) {
  const files = new Map<string, Buffer>();
  const leaves = input.manifest.leaves.map((leaf) => {
    const source = input.files.get(leaf.contentPath);
    if (!source) fail(`节点 ${leaf.leafId} 正文不存在`);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      fail(`节点 ${leaf.leafId} 正文不是有效 UTF-8`);
    }
    const markdown = projectKnowledgeBaseCustomerMarkdown({
      leafTitle: leaf.title,
      markdown: decoded,
    });
    const bytes = Buffer.from(markdown, "utf8");
    files.set(leaf.contentPath, bytes);
    return { ...leaf, contentSha256: sha256(bytes) };
  });
  for (const evidence of input.manifest.evidenceLedger) {
    const bytes = input.files.get(evidence.path);
    if (!bytes) fail(`证据 ${evidence.path} 不存在`);
    files.set(evidence.path, bytes);
    evidence.sha256 = sha256(bytes);
  }
  for (const asset of input.manifest.assets) {
    const bytes = input.files.get(asset.path);
    if (!bytes) fail(`资产 ${asset.assetId} 不存在`);
    files.set(asset.path, bytes);
    asset.sha256 = sha256(bytes);
    asset.bytes = bytes.length;
  }
  const manifest: KnowledgeBaseWorkingSetManifest = {
    ...input.manifest,
    leaves,
    counts: {
      leaves: leaves.length,
      evidenceFiles: input.manifest.evidenceLedger.length,
      assets: input.manifest.assets.length,
    },
  };
  const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
  files.set("BUNDLE.json", manifestBytes);
  const zip = new JSZip();
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    zip.file(path, bytes, {
      binary: true,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return {
    manifest,
    files,
    archiveBytes,
    packageSha256: sha256(archiveBytes),
    manifestSha256: sha256(manifestBytes),
  };
}

async function canonicalPatchArchive(input: {
  manifest: KnowledgeBaseNodePatchManifest;
  files: ReadonlyMap<string, Buffer>;
}) {
  const files = new Map<string, Buffer>();
  const content = input.files.get(input.manifest.contentPath);
  if (content) files.set(input.manifest.contentPath, content);
  for (const evidence of input.manifest.evidence.add) {
    const bytes = input.files.get(evidence.path);
    if (!bytes) fail(`canonical Patch 缺少证据 ${evidence.path}`);
    files.set(evidence.path, bytes);
  }
  for (const asset of input.manifest.assets.add) {
    const bytes = input.files.get(asset.path);
    if (!bytes) fail(`canonical Patch 缺少资产 ${asset.assetId}`);
    files.set(asset.path, bytes);
  }
  const manifestBytes = Buffer.from(stableJson(input.manifest), "utf8");
  files.set("PATCH.json", manifestBytes);
  const zip = new JSZip();
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    zip.file(path, bytes, {
      binary: true,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return {
    files,
    archiveBytes,
    packageSha256: sha256(archiveBytes),
    manifestSha256: sha256(manifestBytes),
  };
}

function declaredFile(input: {
  files: ReadonlyMap<string, Buffer>;
  path: unknown;
  expectedSha256: unknown;
  label: string;
}) {
  const path = safeArchivePath(input.path, `${input.label}.path`);
  const expectedSha256 = digest(input.expectedSha256, `${input.label}.sha256`);
  const bytes = input.files.get(path);
  if (!bytes) fail(`${input.label} 文件不存在`);
  if (sha256(bytes) !== expectedSha256) fail(`${input.label} 哈希不一致`);
  return { path, bytes, sha256: expectedSha256 };
}

function actualDeclaredFile(input: {
  files: ReadonlyMap<string, Buffer>;
  path: unknown;
  label: string;
}) {
  const path = safeArchivePath(input.path, `${input.label}.path`);
  const bytes = input.files.get(path);
  if (!bytes) fail(`${input.label} 文件不存在`);
  return { path, bytes, sha256: sha256(bytes) };
}

function imageMagicMatches(mimeType: string, bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  if (mimeType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (mimeType === "image/avif") {
    return (
      bytes.length >= 16 &&
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      (bytes.subarray(8, 32).includes(Buffer.from("avif")) ||
        bytes.subarray(8, 32).includes(Buffer.from("avis")))
    );
  }
  return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
}

function imageMimeTypeFromBytes(
  bytes: Buffer,
): KnowledgeBaseWorkingSetAsset["mimeType"] | null {
  return (
    (
      [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
      ] as const
    ).find((mimeType) => imageMagicMatches(mimeType, bytes)) ?? null
  );
}

const REQUIRED_ASSET_KEYS = [
  "assetId",
  "path",
  "sha256",
  "mimeType",
  "bytes",
  "width",
  "height",
  "provenance",
  "documentIds",
] as const;
const PRESENTATION_ASSET_KEYS = [
  "assetType",
  "displayRole",
  "caption",
] as const;

function requiredKeys(
  value: JsonObject,
  required: readonly string[],
  label: string,
) {
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail(`${label} 字段不符合合同`);
  }
}

function canonicalAssetPresentation(input: {
  value: JsonObject;
  onNormalized?: (count: number) => void;
}) {
  let normalizedCount = Object.keys(input.value).filter(
    (key) =>
      !REQUIRED_ASSET_KEYS.includes(
        key as (typeof REQUIRED_ASSET_KEYS)[number],
      ) &&
      !PRESENTATION_ASSET_KEYS.includes(
        key as (typeof PRESENTATION_ASSET_KEYS)[number],
      ),
  ).length;
  const assetType = KNOWLEDGE_BASE_ASSET_TYPES.includes(
    input.value.assetType as KnowledgeBaseAssetType,
  )
    ? (input.value.assetType as KnowledgeBaseAssetType)
    : undefined;
  if (input.value.assetType !== undefined && !assetType) normalizedCount += 1;
  const displayRole = KNOWLEDGE_BASE_ASSET_DISPLAY_ROLES.includes(
    input.value.displayRole as KnowledgeBaseAssetDisplayRole,
  )
    ? (input.value.displayRole as KnowledgeBaseAssetDisplayRole)
    : undefined;
  if (input.value.displayRole !== undefined && !displayRole) {
    normalizedCount += 1;
  }
  const captionCandidate =
    typeof input.value.caption === "string" && input.value.caption.length <= 512
      ? customerSafeKnowledgeAssetLabel(input.value.caption)
      : undefined;
  if (input.value.caption !== undefined && !captionCandidate) {
    normalizedCount += 1;
  }
  if (normalizedCount) input.onNormalized?.(normalizedCount);
  return {
    ...(assetType ? { assetType } : {}),
    ...(displayRole ? { displayRole } : {}),
    ...(captionCandidate ? { caption: captionCandidate } : {}),
  };
}

async function parseAsset(input: {
  value: unknown;
  files: ReadonlyMap<string, Buffer>;
  label: string;
  recomputeDerived?: boolean;
  onPresentationNormalized?: (count: number) => void;
}) {
  const value = object(input.value, input.label);
  requiredKeys(value, REQUIRED_ASSET_KEYS, input.label);
  const file = input.recomputeDerived
    ? actualDeclaredFile({
        files: input.files,
        path: value.path,
        label: input.label,
      })
    : declaredFile({
        files: input.files,
        path: value.path,
        expectedSha256: value.sha256,
        label: input.label,
      });
  const declaredMimeType = input.recomputeDerived
    ? null
    : string(value.mimeType, `${input.label}.mimeType`, 64);
  const mimeType = input.recomputeDerived
    ? imageMimeTypeFromBytes(file.bytes)
    : declaredMimeType &&
        imageMimeTypeFromBytes(file.bytes) === declaredMimeType
      ? (declaredMimeType as KnowledgeBaseWorkingSetAsset["mimeType"])
      : null;
  if (
    !file.bytes.length ||
    file.bytes.length > MAX_ASSET_BYTES ||
    !mimeType ||
    (!input.recomputeDerived &&
      integer(value.bytes, `${input.label}.bytes`, 1) !== file.bytes.length)
  ) {
    fail(`${input.label} 图片字节无效`);
  }
  let metadata: { width?: number; height?: number };
  try {
    const image = sharp(file.bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    metadata = await image.metadata();
    await image.stats();
  } catch {
    fail(`${input.label} 图片无法解码`);
  }
  const width = integer(metadata.width, `${input.label}.actualWidth`, 1);
  const height = integer(metadata.height, `${input.label}.actualHeight`, 1);
  if (
    !input.recomputeDerived &&
    (integer(value.width, `${input.label}.width`, 1) !== width ||
      integer(value.height, `${input.label}.height`, 1) !== height)
  ) {
    fail(`${input.label} 图片尺寸不一致`);
  }
  const documentIds = input.recomputeDerived
    ? []
    : stringArray(value.documentIds, `${input.label}.documentIds`, id);
  if (!input.recomputeDerived) {
    assertUnique(documentIds, `${input.label}.documentIds`);
  }
  return {
    assetId: id(value.assetId, `${input.label}.assetId`),
    path: file.path,
    sha256: file.sha256,
    mimeType: mimeType as KnowledgeBaseWorkingSetAsset["mimeType"],
    bytes: file.bytes.length,
    width,
    height,
    provenance: object(value.provenance, `${input.label}.provenance`),
    documentIds,
    ...canonicalAssetPresentation({
      value,
      onNormalized: input.onPresentationNormalized,
    }),
  } satisfies KnowledgeBaseWorkingSetAsset;
}

function assertExpected(
  actual: string | number | null,
  expected: string | number | null | undefined,
  label: string,
) {
  if (expected !== undefined && actual !== expected)
    fail(`${label} 与任务坐标不一致`);
}

export async function validateKnowledgeBaseWorkingSetArchive(
  bytes: Buffer,
  expected: Partial<KnowledgeBaseWorkingSetExpectation> = {},
): Promise<ValidatedKnowledgeBaseWorkingSet> {
  const files = await loadSafeArchive(bytes);
  if (!files.has("BUNDLE.json") || files.has("PATCH.json")) {
    fail("初始 Working Set 必须且只能包含 BUNDLE.json 合同");
  }
  const raw = parseJsonFile(files, "BUNDLE.json");
  exactKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "buildId",
      "generation",
      "contentVersion",
      "skill",
      "treePolicyVersion",
      "company",
      "researchCoverage",
      "branches",
      "evidenceLedger",
      "leaves",
      "assets",
      "logo",
      "counts",
    ],
    "BUNDLE.json",
  );
  if (raw.kind !== "frontmind.kb-working-set" || raw.schemaVersion !== 1) {
    fail("Working Set 合同版本无效");
  }
  const operationId = string(raw.operationId, "operationId", 128);
  const buildId = string(raw.buildId, "buildId", 36);
  const generation = integer(raw.generation, "generation", 1);
  const contentVersion = integer(raw.contentVersion, "contentVersion", 1);
  assertExpected(operationId, expected.operationId, "operationId");
  assertExpected(buildId, expected.buildId, "buildId");
  assertExpected(generation, expected.generation, "generation");
  assertExpected(contentVersion, expected.contentVersion, "contentVersion");

  const skillRaw = object(raw.skill, "skill");
  exactKeys(skillRaw, ["name", "version", "contentHash"], "skill");
  if (skillRaw.name !== "socratic-kb-builder" || skillRaw.version !== "5") {
    fail("Working Set 必须由 socratic-kb-builder v5 生成");
  }
  const skillHash = digest(skillRaw.contentHash, "skill.contentHash");
  assertExpected(skillHash, expected.skillContentHash, "skill.contentHash");
  if (raw.treePolicyVersion !== 2) fail("treePolicyVersion 必须为 2");
  assertExpected(
    raw.treePolicyVersion,
    expected.treePolicyVersion,
    "treePolicyVersion",
  );

  const companyRaw = object(raw.company, "company");
  exactKeys(companyRaw, ["name", "website"], "company");
  let actualCompanyName: string;
  let actualCompanyWebsite: string | null;
  let expectedCompanyName: string | undefined;
  let expectedCompanyWebsite: string | null | undefined;
  try {
    actualCompanyName = canonicalizeKnowledgeBaseCompanyName(
      string(companyRaw.name, "company.name", 255),
    );
    actualCompanyWebsite = canonicalizeKnowledgeBaseWebsite(
      companyRaw.website === null
        ? null
        : nullableString(companyRaw.website, "company.website"),
    );
    expectedCompanyName =
      expected.companyName === undefined
        ? undefined
        : canonicalizeKnowledgeBaseCompanyName(expected.companyName);
    expectedCompanyWebsite =
      expected.companyWebsite === undefined
        ? undefined
        : canonicalizeKnowledgeBaseWebsite(expected.companyWebsite);
  } catch (error) {
    if (error instanceof KnowledgeBaseCompanyIdentityNormalizationError) {
      fail(error.message);
    }
    throw error;
  }
  assertExpected(actualCompanyName, expectedCompanyName, "company.name");
  assertExpected(
    actualCompanyWebsite,
    expectedCompanyWebsite,
    "company.website",
  );
  const company = {
    name: expectedCompanyName ?? actualCompanyName,
    website:
      expectedCompanyWebsite === undefined
        ? actualCompanyWebsite
        : expectedCompanyWebsite,
  };
  let researchCoverage = object(raw.researchCoverage, "researchCoverage");
  const warnings: ValidatedKnowledgeBaseWorkingSet["warnings"] = [];
  let droppedOptionalCount = 0;
  const canonicalInputFiles = new Map(files);

  if (!Array.isArray(raw.branches) || !raw.branches.length) {
    fail("branches 不能为空");
  }
  const branches = raw.branches.map((item, index) => {
    const branch = object(item, `branches[${index}]`);
    exactKeys(branch, ["branchId", "title", "ordinal"], `branches[${index}]`);
    if (integer(branch.ordinal, `branches[${index}].ordinal`) !== index) {
      fail("branch ordinal 必须从 0 连续递增");
    }
    return {
      branchId: id(branch.branchId, `branches[${index}].branchId`),
      title: string(branch.title, `branches[${index}].title`, 255),
      ordinal: index,
    };
  });
  assertUnique(
    branches.map((branch) => branch.branchId),
    "branchId",
  );
  const branchById = new Map(
    branches.map((branch) => [branch.branchId, branch]),
  );

  if (!Array.isArray(raw.evidenceLedger)) fail("evidenceLedger 必须是数组");
  const rawEvidenceIdentities = raw.evidenceLedger.map((item, index) => {
    const evidence = object(item, `evidenceLedger[${index}]`);
    exactKeys(
      evidence,
      ["path", "sha256", "leafId", "sourceUrl", "retrievedAt"],
      `evidenceLedger[${index}]`,
    );
    return {
      index,
      value: evidence,
      path: safeArchivePath(evidence.path, `evidenceLedger[${index}].path`),
    };
  });
  assertUnique(
    rawEvidenceIdentities.map((entry) => entry.path),
    "evidenceLedger.path",
  );
  let evidenceLedger: KnowledgeBaseWorkingSetEvidence[] = [];
  for (const entry of rawEvidenceIdentities) {
    try {
      const file = actualDeclaredFile({
        files,
        path: entry.path,
        label: `evidenceLedger[${entry.index}]`,
      });
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        file.bytes,
      );
      if (!decoded.trim()) fail("证据文件不得为空");
      evidenceLedger.push({
        path: file.path,
        sha256: file.sha256,
        leafId: id(entry.value.leafId, `evidenceLedger[${entry.index}].leafId`),
        sourceUrl: nullableString(
          entry.value.sourceUrl,
          `evidenceLedger[${entry.index}].sourceUrl`,
        ),
        retrievedAt: nullableString(
          entry.value.retrievedAt,
          `evidenceLedger[${entry.index}].retrievedAt`,
          64,
        ),
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warnings.push({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
    }
  }
  const evidenceByPath = new Map(
    evidenceLedger.map((entry) => [entry.path, entry]),
  );

  if (!Array.isArray(raw.assets) || raw.assets.length > 100) {
    fail("assets 数量无效");
  }
  const rawAssetIdentities = raw.assets.map((value, index) => {
    const asset = object(value, `assets[${index}]`);
    return {
      index,
      value,
      assetId: id(asset.assetId, `assets[${index}].assetId`),
      path: safeArchivePath(asset.path, `assets[${index}].path`),
    };
  });
  assertUnique(
    rawAssetIdentities.map((asset) => asset.assetId),
    "assetId",
  );
  assertUnique(
    rawAssetIdentities.map((asset) => asset.path),
    "asset.path",
  );
  const assets: KnowledgeBaseWorkingSetAsset[] = [];
  const droppedAssetIds = new Set<string>();
  for (const entry of rawAssetIdentities) {
    try {
      assets.push(
        await parseAsset({
          value: entry.value,
          files,
          label: `assets[${entry.index}]`,
          recomputeDerived: true,
          onPresentationNormalized: () => {
            warnings.push({
              code: "PRESENTATION_NORMALIZED",
              area: "assets",
            });
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedAssetIds.add(entry.assetId);
      droppedOptionalCount += 1;
      warnings.push({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
    }
  }
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));

  if (
    !Array.isArray(raw.leaves) ||
    raw.leaves.length < 1 ||
    raw.leaves.length > 115
  ) {
    fail("Working Set 必须包含 1–115 个安全叶子节点");
  }
  const rawLeafIdentities = raw.leaves.map((item, index) => {
    const leaf = object(item, `leaves[${index}]`);
    return {
      leafId: id(leaf.leafId, `leaves[${index}].leafId`),
      contentPath: safeArchivePath(
        leaf.contentPath,
        `leaves[${index}].contentPath`,
      ),
    };
  });
  assertUnique(
    rawLeafIdentities.map((leaf) => leaf.leafId),
    "leafId",
  );
  assertUnique(
    rawLeafIdentities.map((leaf) => leaf.contentPath),
    "contentPath",
  );
  const parsedLeaves = raw.leaves.map((item, index) => {
    const leaf = object(item, `leaves[${index}]`);
    const required = [
      "leafId",
      "branchId",
      "branchTitle",
      "title",
      "ordinal",
      "contentPath",
      "contentSha256",
      "evidencePaths",
      "assetIds",
    ];
    const allowed = [...required, "productFamilyId"];
    if (
      required.some((key) => !(key in leaf)) ||
      Object.keys(leaf).some((key) => !allowed.includes(key))
    ) {
      fail(`leaves[${index}] 字段不符合合同`);
    }
    if (integer(leaf.ordinal, `leaves[${index}].ordinal`) !== index) {
      fail("leaf ordinal 必须从 0 连续递增");
    }
    const leafId = id(leaf.leafId, `leaves[${index}].leafId`);
    const branchId = id(leaf.branchId, `leaves[${index}].branchId`);
    const branch = branchById.get(branchId);
    const branchTitle = string(
      leaf.branchTitle,
      `leaves[${index}].branchTitle`,
      255,
    );
    if (!branch || branch.title !== branchTitle)
      fail("leaf branch 不存在或标题不一致");
    const title = string(leaf.title, `leaves[${index}].title`, 512);
    let content: ReturnType<typeof actualDeclaredFile>;
    let projectedContent: string;
    try {
      content = actualDeclaredFile({
        files,
        path: leaf.contentPath,
        label: `leaves[${index}].content`,
      });
      const decodedContent = new TextDecoder("utf-8", { fatal: true }).decode(
        content.bytes,
      );
      projectedContent = projectKnowledgeBaseCustomerMarkdown({
        leafTitle: title,
        markdown: decodedContent,
      });
      canonicalInputFiles.set(
        content.path,
        Buffer.from(projectedContent, "utf8"),
      );
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warnings.push({ code: "RESULT_INCOMPLETE", area: "nodes" });
      return null;
    }
    const declaredEvidencePaths = stringArray(
      leaf.evidencePaths,
      `leaves[${index}].evidencePaths`,
      safeArchivePath,
    );
    const declaredAssetIds = stringArray(
      leaf.assetIds,
      `leaves[${index}].assetIds`,
      id,
    );
    assertUnique(declaredEvidencePaths, `leaves[${index}].evidencePaths`);
    assertUnique(declaredAssetIds, `leaves[${index}].assetIds`);
    const evidencePaths = declaredEvidencePaths.filter(
      (path) => evidenceByPath.get(path)?.leafId === leafId,
    );
    const assetIds = declaredAssetIds.filter((assetId) =>
      assetById.has(assetId),
    );
    if (evidencePaths.length !== declaredEvidencePaths.length) {
      droppedOptionalCount +=
        declaredEvidencePaths.length - evidencePaths.length;
      warnings.push({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
    }
    if (assetIds.length !== declaredAssetIds.length) {
      droppedOptionalCount += declaredAssetIds.length - assetIds.length;
      warnings.push({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
    }
    return {
      leafId,
      branchId,
      branchTitle,
      title,
      ordinal: index,
      contentPath: content.path,
      contentSha256: sha256(Buffer.from(projectedContent!, "utf8")),
      evidencePaths,
      assetIds,
      ...(leaf.productFamilyId === undefined
        ? {}
        : {
            productFamilyId: id(
              leaf.productFamilyId,
              `leaves[${index}].productFamilyId`,
            ),
          }),
    };
  });
  const leaves = parsedLeaves
    .filter(
      (leaf): leaf is NonNullable<(typeof parsedLeaves)[number]> =>
        leaf !== null,
    )
    .map((leaf, ordinal) => ({ ...leaf, ordinal }));
  if (!leaves.length) fail("Working Set 未保留任何安全叶子节点");
  const leafIds = new Set(leaves.map((leaf) => leaf.leafId));
  const referencedEvidence = new Set(
    leaves.flatMap((leaf) => leaf.evidencePaths),
  );
  const retainedEvidenceLedger = evidenceLedger.filter(
    (entry) => leafIds.has(entry.leafId) && referencedEvidence.has(entry.path),
  );
  if (retainedEvidenceLedger.length !== evidenceLedger.length) {
    droppedOptionalCount +=
      evidenceLedger.length - retainedEvidenceLedger.length;
    warnings.push({ code: "EVIDENCE_INCOMPLETE" });
  }
  evidenceLedger = retainedEvidenceLedger;
  if (
    expected.expectedUploadsRead !== undefined &&
    (!Number.isSafeInteger(expected.expectedUploadsRead) ||
      expected.expectedUploadsRead < 0 ||
      expected.expectedUploadsRead > 100)
  ) {
    fail("客户上传资料计数坐标无效");
  }
  researchCoverage = {
    ...researchCoverage,
    ...(expected.expectedUploadsRead === undefined
      ? {}
      : { uploadsRead: expected.expectedUploadsRead }),
    sourceCount: evidenceLedger.length,
  };
  for (const asset of assets) {
    const expectedDocuments = leaves
      .filter((leaf) => leaf.assetIds.includes(asset.assetId))
      .map((leaf) => leaf.leafId)
      .sort();
    asset.documentIds = expectedDocuments;
    if (asset.provenance.sourceKind === "user_upload") {
      asset.assetType = "customer_supplied";
      asset.displayRole = "inline";
    }
  }

  const logoRaw = object(raw.logo, "logo");
  exactKeys(logoRaw, ["status", "assetId"], "logo");
  let logo: KnowledgeBaseWorkingSetManifest["logo"];
  if (logoRaw.status === "missing" && logoRaw.assetId === null) {
    logo = { status: "missing", assetId: null };
  } else if (logoRaw.status === "available") {
    const assetId = id(logoRaw.assetId, "logo.assetId");
    logo = assetById.has(assetId)
      ? { status: "available", assetId }
      : { status: "missing", assetId: null };
    const officialLogo = assetById.get(assetId);
    if (officialLogo) {
      officialLogo.assetType = "brand_identity";
      officialLogo.displayRole = "badge";
    }
    if (!assetById.has(assetId) && !droppedAssetIds.has(assetId)) {
      warnings.push({ code: "OPTIONAL_ASSET_SKIPPED", area: "logo" });
      droppedOptionalCount += 1;
    }
  } else {
    fail("Logo 状态无效");
  }

  const countsRaw = object(raw.counts, "counts");
  exactKeys(countsRaw, ["leaves", "evidenceFiles", "assets"], "counts");
  const counts = {
    leaves: leaves.length,
    evidenceFiles: evidenceLedger.length,
    assets: assets.length,
  };

  const declared = new Set([
    "BUNDLE.json",
    ...rawLeafIdentities
      .map((leaf) => leaf.contentPath)
      .filter((path) => files.has(path)),
    ...rawEvidenceIdentities.map((entry) => entry.path),
    ...rawAssetIdentities.map((asset) => asset.path),
  ]);
  if (
    declared.size !== files.size ||
    [...files.keys()].some((path) => !declared.has(path))
  ) {
    fail("ZIP 包含未登记文件或重复文件引用");
  }
  const manifest: KnowledgeBaseWorkingSetManifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId,
    buildId,
    generation,
    contentVersion,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: skillHash,
    },
    treePolicyVersion: 2,
    company,
    researchCoverage,
    branches,
    evidenceLedger,
    leaves,
    assets,
    logo,
    counts,
  };
  return {
    ...(await canonicalWorkingSetArchive({
      manifest,
      files: canonicalInputFiles,
    })),
    warnings,
    droppedOptionalCount,
  };
}

type KnowledgeBaseNodePatchExpectation = {
  operationId?: string;
  buildId?: string;
  generation?: number;
  baseContentVersion?: number;
  baseWorkingSetSha256?: string;
  targetLeafId?: string;
  attachmentSourceProofs?: readonly KnowledgeBasePatchAttachmentSourceProof[];
};

function normalizedMediaType(value: unknown) {
  return typeof value === "string"
    ? value.split(";", 1)[0]!.trim().toLowerCase()
    : "";
}

function imageExtension(mimeType: KnowledgeBaseWorkingSetAsset["mimeType"]) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}

function normalizedAttachmentSourceProofs(
  proofs: KnowledgeBaseNodePatchExpectation["attachmentSourceProofs"],
) {
  if (!proofs) return [];
  const normalized = proofs.map((proof, proofIndex) => {
    const index = integer(
      proof.index,
      `attachmentSourceProofs[${proofIndex}].index`,
    );
    const contentSha256 = digest(
      proof.contentSha256,
      `attachmentSourceProofs[${proofIndex}].contentSha256`,
    );
    const sizeBytes = integer(
      proof.sizeBytes,
      `attachmentSourceProofs[${proofIndex}].sizeBytes`,
      1,
    );
    const mimeType = normalizedMediaType(proof.mimeType);
    if (!mimeType) fail("attachmentSourceProofs MIME 无效");
    return { index, contentSha256, sizeBytes, mimeType };
  });
  assertUnique(
    normalized.map((proof) => String(proof.index)),
    "attachmentSourceProofs.index",
  );
  return normalized;
}

function rawAssetClaimsFrozenUpload(value: JsonObject) {
  const provenance =
    value.provenance &&
    typeof value.provenance === "object" &&
    !Array.isArray(value.provenance)
      ? (value.provenance as JsonObject)
      : {};
  return (
    value.assetType === "customer_supplied" ||
    provenance.sourceKind === "user_upload" ||
    provenance.originalUploadSha256 !== undefined ||
    provenance.sourceUploadSha256 !== undefined
  );
}

function assertFrozenUploadClaimsMatch(input: {
  raw: JsonObject;
  asset: KnowledgeBaseWorkingSetAsset;
  proof: ReturnType<typeof normalizedAttachmentSourceProofs>[number];
}) {
  const provenance = object(input.raw.provenance, "asset.provenance");
  for (const claimed of [
    provenance.originalUploadSha256,
    provenance.sourceUploadSha256,
  ]) {
    if (claimed !== undefined && claimed !== input.proof.contentSha256) {
      fail(
        "Patch frozen upload 哈希声明与 Dashboard 证明不一致",
        "frozen_source_conflict",
      );
    }
  }
  if (
    input.asset.sha256 !== input.proof.contentSha256 ||
    input.asset.bytes !== input.proof.sizeBytes ||
    normalizedMediaType(input.asset.mimeType) !== input.proof.mimeType
  ) {
    fail(
      "Patch frozen upload 的字节、MIME 或哈希与 Dashboard 证明不一致",
      "frozen_source_conflict",
    );
  }
}

function canonicalFrozenUploadAsset(input: {
  operationId: string;
  targetLeafId: string;
  asset: KnowledgeBaseWorkingSetAsset;
  proof: ReturnType<typeof normalizedAttachmentSourceProofs>[number];
}) {
  const stableIdentity = sha256(
    `frontmind.kb-patch-asset.v1\0${input.operationId}\0${input.proof.contentSha256}`,
  ).slice(0, 32);
  return {
    ...input.asset,
    assetId: `asset-${stableIdentity}`,
    path: `assets/${input.targetLeafId}/${stableIdentity}.${imageExtension(input.asset.mimeType)}`,
    provenance: {
      sourceKind: "user_upload",
      ownership: "first_party",
      sourceUploadIndex: input.proof.index,
      sourceUploadMimeType: input.asset.mimeType,
      sourceUploadSizeBytes: input.asset.bytes,
      sourceUploadSha256: input.asset.sha256,
    },
    documentIds: [input.targetLeafId],
    assetType: "customer_supplied",
    displayRole: "inline",
  } satisfies KnowledgeBaseWorkingSetAsset;
}

async function validateKnowledgeBaseNodePatchArchiveInternal(
  bytes: Buffer,
  expected: KnowledgeBaseNodePatchExpectation,
  verifyCanonicalRoundtrip: boolean,
): Promise<ValidatedKnowledgeBaseNodePatch> {
  const files = await loadSafeArchive(bytes);
  if (!files.has("PATCH.json") || files.has("BUNDLE.json")) {
    fail("Revision 必须且只能包含 PATCH.json 合同");
  }
  const parsedEnvelope = parseJsonFileDetailed(files, "PATCH.json");
  const raw = parsedEnvelope.value;
  const warnings: ValidatedKnowledgeBaseNodePatch["warnings"] = [];
  const droppedComponents = {
    evidence: 0,
    assets: 0,
    presentationFields: 0,
  };
  const warn = (
    warning: ValidatedKnowledgeBaseNodePatch["warnings"][number],
  ) => {
    if (warnings.length < PATCH_WARNING_LIMIT) warnings.push(warning);
  };
  if (parsedEnvelope.normalizations.length) {
    warn({ code: "MANIFEST_NORMALIZED", area: "manifest" });
  }
  exactKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "buildId",
      "generation",
      "baseContentVersion",
      "baseWorkingSetSha256",
      "targetLeafId",
      "contentPath",
      "contentSha256",
      "evidence",
      "assets",
    ],
    "PATCH.json",
  );
  if (raw.kind !== "frontmind.kb-node-patch" || raw.schemaVersion !== 1) {
    fail("Patch 合同版本无效");
  }
  const operationId = string(raw.operationId, "operationId", 128);
  const buildId = string(raw.buildId, "buildId", 36);
  const generation = integer(raw.generation, "generation", 1);
  const baseContentVersion = integer(
    raw.baseContentVersion,
    "baseContentVersion",
    1,
  );
  const baseWorkingSetSha256 = digest(
    raw.baseWorkingSetSha256,
    "baseWorkingSetSha256",
  );
  const targetLeafId = id(raw.targetLeafId, "targetLeafId");
  assertExpected(operationId, expected.operationId, "operationId");
  assertExpected(buildId, expected.buildId, "buildId");
  assertExpected(generation, expected.generation, "generation");
  assertExpected(
    baseContentVersion,
    expected.baseContentVersion,
    "baseContentVersion",
  );
  assertExpected(
    baseWorkingSetSha256,
    expected.baseWorkingSetSha256,
    "baseWorkingSetSha256",
  );
  assertExpected(targetLeafId, expected.targetLeafId, "targetLeafId");
  const sourceProofs = normalizedAttachmentSourceProofs(
    expected.attachmentSourceProofs,
  );
  const contentPath = safeArchivePath(raw.contentPath, "patch.content.path");
  let contentStatus: "valid" | "invalid" = "valid";
  let content = {
    path: contentPath,
    sha256: files.has(contentPath)
      ? sha256(files.get(contentPath)!)
      : "0".repeat(64),
  };
  try {
    const declaredContent = declaredFile({
      files,
      path: contentPath,
      expectedSha256: raw.contentSha256,
      label: "patch.content",
    });
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      declaredContent.bytes,
    );
    if (!canonicalKnowledgeBaseMarkdown(decoded)) fail("Patch 正文不得为空");
    content = {
      path: declaredContent.path,
      sha256: declaredContent.sha256,
    };
  } catch (error) {
    if (!(error instanceof KnowledgeBaseMaterializedContractError)) throw error;
    contentStatus = "invalid";
    content = { path: contentPath, sha256: "0".repeat(64) };
  }

  const evidenceRaw = object(raw.evidence, "evidence");
  exactKeys(evidenceRaw, ["add", "remove"], "evidence");
  if (!Array.isArray(evidenceRaw.add)) fail("evidence.add 必须是数组");
  const evidenceInputs = evidenceRaw.add.map((item, index) => {
    const row = object(item, `evidence.add[${index}]`);
    exactKeys(row, ["path", "sha256"], `evidence.add[${index}]`);
    const path = safeArchivePath(row.path, `evidence.add[${index}].path`);
    if (!path.startsWith(`evidence/${targetLeafId}/`)) {
      fail("Patch 证据必须属于目标节点");
    }
    return { index, path, sha256: row.sha256 };
  });
  const evidenceRemove = stringArray(
    evidenceRaw.remove,
    "evidence.remove",
    safeArchivePath,
  );
  assertUnique(
    evidenceInputs.map((entry) => entry.path),
    "evidence.add.path",
  );
  assertUnique(evidenceRemove, "evidence.remove");
  let evidenceStatus: "valid" | "invalid" = "valid";
  const parsedEvidenceAdd: Array<{ path: string; sha256: string }> = [];
  for (const entry of evidenceInputs) {
    try {
      const file = declaredFile({
        files,
        path: entry.path,
        expectedSha256: entry.sha256,
        label: `evidence.add[${entry.index}]`,
      });
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        file.bytes,
      );
      if (!decoded.trim()) fail("Patch 证据不得为空");
      parsedEvidenceAdd.push({ path: file.path, sha256: file.sha256 });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      evidenceStatus = "invalid";
      droppedComponents.evidence += 1;
      warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
    }
  }
  const evidenceAdd = parsedEvidenceAdd;

  const assetsRaw = object(raw.assets, "assets");
  exactKeys(assetsRaw, ["add", "remove"], "assets");
  if (!Array.isArray(assetsRaw.add)) fail("assets.add 必须是数组");
  const assetInputs = assetsRaw.add.map((value, index) => {
    const asset = object(value, `assets.add[${index}]`);
    requiredKeys(asset, REQUIRED_ASSET_KEYS, `assets.add[${index}]`);
    const assetId = id(asset.assetId, `assets.add[${index}].assetId`);
    const path = safeArchivePath(asset.path, `assets.add[${index}].path`);
    const documentIds = stringArray(
      asset.documentIds,
      `assets.add[${index}].documentIds`,
      id,
    );
    if (documentIds.length !== 1 || documentIds[0] !== targetLeafId) {
      fail("Patch 新资产只能绑定目标节点");
    }
    return { index, value, assetId, path };
  });
  assertUnique(
    assetInputs.map((asset) => asset.assetId),
    "assets.add.assetId",
  );
  assertUnique(
    assetInputs.map((asset) => asset.path),
    "assets.add.path",
  );
  const assetsRemove = stringArray(assetsRaw.remove, "assets.remove", id);
  assertUnique(assetsRemove, "assets.remove");
  if (
    assetInputs.some((asset) => assetsRemove.includes(asset.assetId)) ||
    evidenceInputs.some((entry) => evidenceRemove.includes(entry.path))
  ) {
    fail("Patch 同一组件不得同时新增和删除");
  }
  let assetsStatus: "valid" | "invalid" = "valid";
  const parsedAssetsAdd: KnowledgeBaseWorkingSetAsset[] = [];
  const canonicalFiles = new Map(files);
  for (const entry of assetInputs) {
    const rawAsset = object(entry.value, `assets.add[${entry.index}]`);
    const claimsFrozen = rawAssetClaimsFrozenUpload(rawAsset);
    const rawAssetBytes = files.get(entry.path);
    const detectedMimeType = rawAssetBytes
      ? imageMimeTypeFromBytes(rawAssetBytes)
      : null;
    const matchingProofs = rawAssetBytes
      ? sourceProofs.filter(
          (proof) =>
            proof.contentSha256 === sha256(rawAssetBytes) &&
            proof.sizeBytes === rawAssetBytes.length &&
            proof.mimeType === detectedMimeType,
        )
      : [];
    if (matchingProofs.length > 1) {
      fail("Patch 图片对应多个 frozen upload 证明", "frozen_source_conflict");
    }
    if (claimsFrozen && matchingProofs.length !== 1) {
      fail(
        "Patch 声称使用 frozen upload，但无法绑定 Dashboard 证明",
        "frozen_source_conflict",
      );
    }
    const proof = matchingProofs[0];
    try {
      if (
        proof &&
        (digest(rawAsset.sha256, `assets.add[${entry.index}].sha256`) !==
          proof.contentSha256 ||
          integer(rawAsset.bytes, `assets.add[${entry.index}].bytes`, 1) !==
            proof.sizeBytes ||
          normalizedMediaType(
            string(
              rawAsset.mimeType,
              `assets.add[${entry.index}].mimeType`,
              64,
            ),
          ) !== proof.mimeType)
      ) {
        fail(
          "Patch frozen upload 的字节、MIME 或哈希声明不一致",
          "frozen_source_conflict",
        );
      }
      const parsedAsset = await parseAsset({
        value: entry.value,
        files,
        label: `assets.add[${entry.index}]`,
        // Frozen browser bytes are the authority for derived dimensions and
        // encoding metadata. Provider presentation declarations cannot turn
        // those already-proven bytes into an optional invalid component.
        recomputeDerived: Boolean(proof),
        onPresentationNormalized: (count) => {
          droppedComponents.presentationFields += count;
          warn({ code: "PRESENTATION_NORMALIZED", area: "assets" });
        },
      });
      const canonicalAsset = proof
        ? (() => {
            assertFrozenUploadClaimsMatch({
              raw: rawAsset,
              asset: parsedAsset,
              proof,
            });
            return canonicalFrozenUploadAsset({
              operationId,
              targetLeafId,
              asset: parsedAsset,
              proof,
            });
          })()
        : parsedAsset;
      const assetBytes = rawAssetBytes!;
      canonicalFiles.set(canonicalAsset.path, assetBytes);
      parsedAssetsAdd.push(canonicalAsset);
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      if (
        claimsFrozen ||
        proof ||
        error.category === "frozen_source_conflict"
      ) {
        throw error.category === "frozen_source_conflict"
          ? error
          : new KnowledgeBaseMaterializedContractError(
              "Patch frozen upload 图片未通过字节校验",
              "frozen_source_conflict",
            );
      }
      assetsStatus = "invalid";
      droppedComponents.assets += 1;
      warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
    }
  }
  const assetsAdd = parsedAssetsAdd;
  assertUnique(
    assetsAdd.map((asset) => asset.assetId),
    "canonical assets.add.assetId",
  );
  assertUnique(
    assetsAdd.map((asset) => asset.path),
    "canonical assets.add.path",
  );

  const declared = new Set(
    [
      "PATCH.json",
      contentPath,
      ...evidenceInputs.map((entry) => entry.path),
      ...assetInputs.map((asset) => asset.path),
    ].filter((path) => files.has(path)),
  );
  if (
    declared.size !== files.size ||
    [...files.keys()].some((path) => !declared.has(path))
  ) {
    fail("Patch ZIP 包含未登记文件或重复文件引用");
  }
  if (contentStatus === "valid") {
    const markdown = canonicalKnowledgeBaseMarkdown(
      new TextDecoder("utf-8", { fatal: true }).decode(files.get(contentPath)!),
    );
    const canonicalContent = Buffer.from(markdown, "utf8");
    canonicalFiles.set(contentPath, canonicalContent);
    content = { path: contentPath, sha256: sha256(canonicalContent) };
  } else {
    canonicalFiles.delete(contentPath);
  }
  const manifest: KnowledgeBaseNodePatchManifest = {
    kind: "frontmind.kb-node-patch",
    schemaVersion: 1,
    operationId,
    buildId,
    generation,
    baseContentVersion,
    baseWorkingSetSha256,
    targetLeafId,
    contentPath: content.path,
    contentSha256: content.sha256,
    evidence: { add: evidenceAdd, remove: evidenceRemove },
    assets: { add: assetsAdd, remove: assetsRemove },
  };
  const canonical = await canonicalPatchArchive({
    manifest,
    files: canonicalFiles,
  });
  const result: ValidatedKnowledgeBaseNodePatch = {
    manifest,
    ...canonical,
    components: {
      content: contentStatus,
      evidence: evidenceStatus,
      assets: assetsStatus,
    },
    warnings,
    droppedComponents,
  };
  if (verifyCanonicalRoundtrip) {
    const roundtrip = await validateKnowledgeBaseNodePatchArchiveInternal(
      canonical.archiveBytes,
      expected,
      false,
    );
    if (
      stableJson(roundtrip.manifest) !== stableJson(manifest) ||
      !roundtrip.archiveBytes.equals(canonical.archiveBytes)
    ) {
      fail("canonical Patch 自校验不一致");
    }
  }
  return result;
}

export async function validateKnowledgeBaseNodePatchArchive(
  bytes: Buffer,
  expected: KnowledgeBaseNodePatchExpectation = {},
): Promise<ValidatedKnowledgeBaseNodePatch> {
  return validateKnowledgeBaseNodePatchArchiveInternal(bytes, expected, true);
}

/**
 * Rebuild the narrowest possible Patch after the caller has locked the active
 * build, Working Set and current revise turn. This function has no discovery
 * behavior: it accepts exactly one expected node and only image bytes that
 * bind one-to-one to the supplied Dashboard-frozen attachment proofs.
 */
export async function salvageKnowledgeBaseNodePatchArchive(input: {
  bytes: Buffer;
  expected: Required<
    Omit<KnowledgeBaseNodePatchExpectation, "attachmentSourceProofs">
  > & {
    attachmentSourceProofs: readonly KnowledgeBasePatchAttachmentSourceProof[];
  };
  dbAuthorityLocked: true;
}): Promise<ValidatedKnowledgeBaseNodePatch> {
  void input.dbAuthorityLocked;
  const files = await loadSafeArchive(input.bytes);
  if (!files.has("PATCH.json") || files.has("BUNDLE.json")) {
    fail("salvage 只接受含 PATCH.json 的 revision ZIP");
  }
  try {
    parseJsonFileDetailed(files, "PATCH.json");
    fail("可解析 manifest 不允许进入 salvage");
  } catch (error) {
    if (!isKnowledgeBasePatchManifestParseError(error)) throw error;
  }

  const operationId = string(input.expected.operationId, "operationId", 128);
  const buildId = string(input.expected.buildId, "buildId", 36);
  const generation = integer(input.expected.generation, "generation", 1);
  const baseContentVersion = integer(
    input.expected.baseContentVersion,
    "baseContentVersion",
    1,
  );
  const baseWorkingSetSha256 = digest(
    input.expected.baseWorkingSetSha256,
    "baseWorkingSetSha256",
  );
  const targetLeafId = id(input.expected.targetLeafId, "targetLeafId");
  const proofs = normalizedAttachmentSourceProofs(
    input.expected.attachmentSourceProofs,
  );
  const nodePath = `node/${targetLeafId}.md`;
  const nodeEntries = [...files.keys()].filter((path) =>
    path.startsWith("node/"),
  );
  if (nodeEntries.length !== 1 || nodeEntries[0] !== nodePath) {
    fail("salvage 必须且只能包含当前目标节点正文");
  }
  const contentBytes = files.get(nodePath)!;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
  } catch {
    fail("salvage 节点正文不是 UTF-8");
  }
  const markdown = canonicalKnowledgeBaseMarkdown(decoded);
  if (!markdown) fail("salvage 节点正文为空");

  const canonicalFiles = new Map<string, Buffer>();
  const canonicalContent = Buffer.from(markdown, "utf8");
  canonicalFiles.set(nodePath, canonicalContent);
  const assets: KnowledgeBaseWorkingSetAsset[] = [];
  const consumedProofIndexes = new Set<number>();
  const otherEntries = [...files.entries()].filter(
    ([path]) => path !== "PATCH.json" && path !== nodePath,
  );
  for (const [rawPath, assetBytes] of otherEntries) {
    const mimeType = imageMimeTypeFromBytes(assetBytes);
    if (
      !mimeType ||
      !assetBytes.length ||
      assetBytes.length > MAX_ASSET_BYTES
    ) {
      fail("salvage ZIP 包含未知或不可安全解码的额外文件");
    }
    const assetSha256 = sha256(assetBytes);
    const matches = proofs.filter(
      (proof) =>
        proof.contentSha256 === assetSha256 &&
        proof.sizeBytes === assetBytes.length &&
        proof.mimeType === mimeType,
    );
    if (matches.length !== 1 || consumedProofIndexes.has(matches[0]!.index)) {
      fail(
        "salvage 图片无法与 frozen upload 一一绑定",
        "frozen_source_conflict",
      );
    }
    let metadata: { width?: number; height?: number };
    try {
      const image = sharp(assetBytes, {
        animated: false,
        failOn: "warning",
        limitInputPixels: 40_000_000,
      });
      metadata = await image.metadata();
      await image.stats();
    } catch {
      fail("salvage 图片无法安全解码", "frozen_source_conflict");
    }
    const proof = matches[0]!;
    consumedProofIndexes.add(proof.index);
    const rawAsset: KnowledgeBaseWorkingSetAsset = {
      assetId: `salvage-${assets.length + 1}`,
      path: rawPath,
      sha256: assetSha256,
      mimeType,
      bytes: assetBytes.length,
      width: integer(metadata.width, "salvage asset width", 1),
      height: integer(metadata.height, "salvage asset height", 1),
      provenance: {},
      documentIds: [targetLeafId],
    };
    const asset = canonicalFrozenUploadAsset({
      operationId,
      targetLeafId,
      asset: rawAsset,
      proof,
    });
    canonicalFiles.set(asset.path, assetBytes);
    assets.push(asset);
  }
  assertUnique(
    assets.map((asset) => asset.assetId),
    "salvage assetId",
  );
  assertUnique(
    assets.map((asset) => asset.path),
    "salvage asset.path",
  );
  const manifest: KnowledgeBaseNodePatchManifest = {
    kind: "frontmind.kb-node-patch",
    schemaVersion: 1,
    operationId,
    buildId,
    generation,
    baseContentVersion,
    baseWorkingSetSha256,
    targetLeafId,
    contentPath: nodePath,
    contentSha256: sha256(canonicalContent),
    evidence: { add: [], remove: [] },
    assets: { add: assets, remove: [] },
  };
  const canonical = await canonicalPatchArchive({
    manifest,
    files: canonicalFiles,
  });
  const validated = await validateKnowledgeBaseNodePatchArchiveInternal(
    canonical.archiveBytes,
    input.expected,
    true,
  );
  return {
    ...validated,
    warnings: (
      [
        { code: "MANIFEST_NORMALIZED", area: "manifest" },
        ...validated.warnings,
      ] satisfies ValidatedKnowledgeBaseNodePatch["warnings"]
    ).slice(0, PATCH_WARNING_LIMIT),
  };
}

export const MATERIALIZED_KNOWLEDGE_BASE_ZIP_LIMITS = {
  maxCompressedOrExpandedBytes: MAX_ARCHIVE_BYTES,
  maxEntryCount: MAX_ENTRY_COUNT,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
} as const;
