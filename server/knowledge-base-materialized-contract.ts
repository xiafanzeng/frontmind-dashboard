import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/u;
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_500;
const MAX_COMPRESSION_RATIO = 200;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

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
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  width: number;
  height: number;
  provenance: JsonObject;
  documentIds: string[];
};

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
  packageSha256: string;
  manifestSha256: string;
};

export type ValidatedKnowledgeBaseNodePatch = {
  manifest: KnowledgeBaseNodePatchManifest;
  files: ReadonlyMap<string, Buffer>;
  packageSha256: string;
  manifestSha256: string;
};

export class KnowledgeBaseMaterializedContractError extends Error {
  readonly code = "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBaseMaterializedContractError";
  }
}

function fail(message: string): never {
  throw new KnowledgeBaseMaterializedContractError(message);
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

function parseJsonFile(files: ReadonlyMap<string, Buffer>, path: string) {
  const bytes = files.get(path);
  if (!bytes) fail(`ZIP 缺少 ${path}`);
  try {
    return object(
      JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")),
      path,
    );
  } catch (error) {
    if (error instanceof KnowledgeBaseMaterializedContractError) throw error;
    fail(`${path} 不是有效 JSON`);
  }
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
  return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
}

async function parseAsset(input: {
  value: unknown;
  files: ReadonlyMap<string, Buffer>;
  label: string;
}) {
  const value = object(input.value, input.label);
  exactKeys(
    value,
    [
      "assetId",
      "path",
      "sha256",
      "mimeType",
      "bytes",
      "width",
      "height",
      "provenance",
      "documentIds",
    ],
    input.label,
  );
  const file = declaredFile({
    files: input.files,
    path: value.path,
    expectedSha256: value.sha256,
    label: input.label,
  });
  const mimeType = string(value.mimeType, `${input.label}.mimeType`, 64);
  if (
    !(["image/png", "image/jpeg", "image/webp", "image/gif"] as const).includes(
      mimeType as never,
    )
  ) {
    fail(`${input.label}.mimeType 不受支持`);
  }
  if (
    !file.bytes.length ||
    file.bytes.length > MAX_ASSET_BYTES ||
    integer(value.bytes, `${input.label}.bytes`, 1) !== file.bytes.length ||
    !imageMagicMatches(mimeType, file.bytes)
  ) {
    fail(`${input.label} 图片字节无效`);
  }
  let metadata: { width?: number; height?: number };
  try {
    metadata = await sharp(file.bytes, { animated: false }).metadata();
  } catch {
    fail(`${input.label} 图片无法解码`);
  }
  const width = integer(value.width, `${input.label}.width`, 1);
  const height = integer(value.height, `${input.label}.height`, 1);
  if (metadata.width !== width || metadata.height !== height) {
    fail(`${input.label} 图片尺寸不一致`);
  }
  const documentIds = stringArray(
    value.documentIds,
    `${input.label}.documentIds`,
    id,
  );
  assertUnique(documentIds, `${input.label}.documentIds`);
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
  } satisfies KnowledgeBaseWorkingSetAsset;
}

function assertExpected(
  actual: string | number,
  expected: string | number | undefined,
  label: string,
) {
  if (expected !== undefined && actual !== expected)
    fail(`${label} 与任务坐标不一致`);
}

export async function validateKnowledgeBaseWorkingSetArchive(
  bytes: Buffer,
  expected: {
    operationId?: string;
    buildId?: string;
    generation?: number;
    contentVersion?: number;
    skillContentHash?: string;
    companyName?: string;
  } = {},
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

  const companyRaw = object(raw.company, "company");
  exactKeys(companyRaw, ["name", "website"], "company");
  const company = {
    name: string(companyRaw.name, "company.name", 255),
    website: nullableString(companyRaw.website, "company.website"),
  };
  assertExpected(company.name, expected.companyName, "company.name");
  const researchCoverage = object(raw.researchCoverage, "researchCoverage");

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
  const evidenceLedger = raw.evidenceLedger.map((item, index) => {
    const evidence = object(item, `evidenceLedger[${index}]`);
    exactKeys(
      evidence,
      ["path", "sha256", "leafId", "sourceUrl", "retrievedAt"],
      `evidenceLedger[${index}]`,
    );
    const file = declaredFile({
      files,
      path: evidence.path,
      expectedSha256: evidence.sha256,
      label: `evidenceLedger[${index}]`,
    });
    if (!file.bytes.toString("utf8").trim()) fail("证据文件不得为空");
    return {
      path: file.path,
      sha256: file.sha256,
      leafId: id(evidence.leafId, `evidenceLedger[${index}].leafId`),
      sourceUrl: nullableString(
        evidence.sourceUrl,
        `evidenceLedger[${index}].sourceUrl`,
      ),
      retrievedAt: nullableString(
        evidence.retrievedAt,
        `evidenceLedger[${index}].retrievedAt`,
        64,
      ),
    };
  });
  assertUnique(
    evidenceLedger.map((entry) => entry.path),
    "evidenceLedger.path",
  );
  const evidenceByPath = new Map(
    evidenceLedger.map((entry) => [entry.path, entry]),
  );

  if (!Array.isArray(raw.assets) || raw.assets.length > 100) {
    fail("assets 数量无效");
  }
  const assets = await Promise.all(
    raw.assets.map((value, index) =>
      parseAsset({ value, files, label: `assets[${index}]` }),
    ),
  );
  assertUnique(
    assets.map((asset) => asset.assetId),
    "assetId",
  );
  assertUnique(
    assets.map((asset) => asset.path),
    "asset.path",
  );
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));

  if (
    !Array.isArray(raw.leaves) ||
    raw.leaves.length < 30 ||
    raw.leaves.length > 115
  ) {
    fail("Working Set 必须包含 30–115 个叶子节点");
  }
  const leaves = raw.leaves.map((item, index) => {
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
    const content = declaredFile({
      files,
      path: leaf.contentPath,
      expectedSha256: leaf.contentSha256,
      label: `leaves[${index}].content`,
    });
    if (!content.bytes.toString("utf8").trim()) fail("节点正文不得为空");
    const evidencePaths = stringArray(
      leaf.evidencePaths,
      `leaves[${index}].evidencePaths`,
      safeArchivePath,
    );
    const assetIds = stringArray(
      leaf.assetIds,
      `leaves[${index}].assetIds`,
      id,
    );
    assertUnique(evidencePaths, `leaves[${index}].evidencePaths`);
    assertUnique(assetIds, `leaves[${index}].assetIds`);
    for (const path of evidencePaths) {
      if (evidenceByPath.get(path)?.leafId !== leafId) {
        fail(`节点 ${leafId} 的 evidenceLedger 绑定无效`);
      }
    }
    for (const assetId of assetIds) {
      if (!assetById.has(assetId)) fail(`节点 ${leafId} 引用了未知资产`);
    }
    return {
      leafId,
      branchId,
      branchTitle,
      title: string(leaf.title, `leaves[${index}].title`, 512),
      ordinal: index,
      contentPath: content.path,
      contentSha256: content.sha256,
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
  assertUnique(
    leaves.map((leaf) => leaf.leafId),
    "leafId",
  );
  assertUnique(
    leaves.map((leaf) => leaf.contentPath),
    "contentPath",
  );
  const leafIds = new Set(leaves.map((leaf) => leaf.leafId));
  if (evidenceLedger.some((entry) => !leafIds.has(entry.leafId))) {
    fail("evidenceLedger 引用了未知节点");
  }
  const referencedEvidence = new Set(
    leaves.flatMap((leaf) => leaf.evidencePaths),
  );
  if (
    referencedEvidence.size !== evidenceLedger.length ||
    evidenceLedger.some((entry) => !referencedEvidence.has(entry.path))
  ) {
    fail("evidenceLedger 必须与节点证据双向一致");
  }
  for (const asset of assets) {
    const expectedDocuments = leaves
      .filter((leaf) => leaf.assetIds.includes(asset.assetId))
      .map((leaf) => leaf.leafId)
      .sort();
    if (
      asset.documentIds.some((leafId) => !leafIds.has(leafId)) ||
      [...asset.documentIds].sort().join("\0") !== expectedDocuments.join("\0")
    ) {
      fail(`资产 ${asset.assetId} 的 documentIds 未与节点双向绑定`);
    }
  }

  const logoRaw = object(raw.logo, "logo");
  exactKeys(logoRaw, ["status", "assetId"], "logo");
  let logo: KnowledgeBaseWorkingSetManifest["logo"];
  if (logoRaw.status === "missing" && logoRaw.assetId === null) {
    logo = { status: "missing", assetId: null };
  } else if (logoRaw.status === "available") {
    const assetId = id(logoRaw.assetId, "logo.assetId");
    if (!assetById.has(assetId)) fail("Logo 资产不存在");
    logo = { status: "available", assetId };
  } else {
    fail("Logo 状态无效");
  }

  const countsRaw = object(raw.counts, "counts");
  exactKeys(countsRaw, ["leaves", "evidenceFiles", "assets"], "counts");
  const counts = {
    leaves: integer(countsRaw.leaves, "counts.leaves"),
    evidenceFiles: integer(countsRaw.evidenceFiles, "counts.evidenceFiles"),
    assets: integer(countsRaw.assets, "counts.assets"),
  };
  if (
    counts.leaves !== leaves.length ||
    counts.evidenceFiles !== evidenceLedger.length ||
    counts.assets !== assets.length
  ) {
    fail("counts 与实际清单不一致");
  }

  const declared = new Set([
    "BUNDLE.json",
    ...leaves.map((leaf) => leaf.contentPath),
    ...evidenceLedger.map((entry) => entry.path),
    ...assets.map((asset) => asset.path),
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
    manifest,
    files,
    packageSha256: sha256(bytes),
    manifestSha256: sha256(files.get("BUNDLE.json")!),
  };
}

export async function validateKnowledgeBaseNodePatchArchive(
  bytes: Buffer,
  expected: {
    operationId?: string;
    buildId?: string;
    generation?: number;
    baseContentVersion?: number;
    baseWorkingSetSha256?: string;
    targetLeafId?: string;
  } = {},
): Promise<ValidatedKnowledgeBaseNodePatch> {
  const files = await loadSafeArchive(bytes);
  if (!files.has("PATCH.json") || files.has("BUNDLE.json")) {
    fail("Revision 必须且只能包含 PATCH.json 合同");
  }
  const raw = parseJsonFile(files, "PATCH.json");
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
  const content = declaredFile({
    files,
    path: raw.contentPath,
    expectedSha256: raw.contentSha256,
    label: "patch.content",
  });
  if (!content.bytes.toString("utf8").trim()) fail("Patch 正文不得为空");

  const evidenceRaw = object(raw.evidence, "evidence");
  exactKeys(evidenceRaw, ["add", "remove"], "evidence");
  if (!Array.isArray(evidenceRaw.add)) fail("evidence.add 必须是数组");
  const evidenceAdd = evidenceRaw.add.map((item, index) => {
    const row = object(item, `evidence.add[${index}]`);
    exactKeys(row, ["path", "sha256"], `evidence.add[${index}]`);
    const file = declaredFile({
      files,
      path: row.path,
      expectedSha256: row.sha256,
      label: `evidence.add[${index}]`,
    });
    if (
      !file.path.startsWith(`evidence/${targetLeafId}/`) ||
      !file.bytes.toString("utf8").trim()
    ) {
      fail("Patch 证据必须属于目标节点且非空");
    }
    return { path: file.path, sha256: file.sha256 };
  });
  const evidenceRemove = stringArray(
    evidenceRaw.remove,
    "evidence.remove",
    safeArchivePath,
  );
  assertUnique(
    evidenceAdd.map((entry) => entry.path),
    "evidence.add.path",
  );
  assertUnique(evidenceRemove, "evidence.remove");

  const assetsRaw = object(raw.assets, "assets");
  exactKeys(assetsRaw, ["add", "remove"], "assets");
  if (!Array.isArray(assetsRaw.add)) fail("assets.add 必须是数组");
  const assetsAdd = await Promise.all(
    assetsRaw.add.map((value, index) =>
      parseAsset({ value, files, label: `assets.add[${index}]` }),
    ),
  );
  if (
    assetsAdd.some(
      (asset) =>
        asset.documentIds.length !== 1 || asset.documentIds[0] !== targetLeafId,
    )
  ) {
    fail("Patch 新资产只能绑定目标节点");
  }
  const assetsRemove = stringArray(assetsRaw.remove, "assets.remove", id);
  assertUnique(
    assetsAdd.map((asset) => asset.assetId),
    "assets.add.assetId",
  );
  assertUnique(assetsRemove, "assets.remove");

  const declared = new Set([
    "PATCH.json",
    content.path,
    ...evidenceAdd.map((entry) => entry.path),
    ...assetsAdd.map((asset) => asset.path),
  ]);
  if (
    declared.size !== files.size ||
    [...files.keys()].some((path) => !declared.has(path))
  ) {
    fail("Patch ZIP 包含未登记文件或重复文件引用");
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
  return {
    manifest,
    files,
    packageSha256: sha256(bytes),
    manifestSha256: sha256(files.get("PATCH.json")!),
  };
}

export const MATERIALIZED_KNOWLEDGE_BASE_ZIP_LIMITS = {
  maxCompressedOrExpandedBytes: MAX_ARCHIVE_BYTES,
  maxEntryCount: MAX_ENTRY_COUNT,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
} as const;
