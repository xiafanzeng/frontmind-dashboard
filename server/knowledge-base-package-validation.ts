import { createHash } from "node:crypto";

import type { KnowledgeAsset, KnowledgeDocument } from "../shared/dashboard";

export type KnowledgeBasePackageNode = {
  leafId: string;
  title: string;
  branchId: string;
  branchTitle: string;
  ordinal: number;
  status: string;
  contentMarkdown: string | null;
  contentSha256?: string | null;
};

export class KnowledgeBasePackageBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBasePackageBindingError";
  }
}

/**
 * Knowledge-node Markdown is stored and packaged by two independent systems.
 * Keep their byte identity stable without treating line-ending or trailing
 * whitespace differences as customer-visible content changes.
 */
export function canonicalKnowledgeBaseMarkdown(value: string) {
  return String(value || "")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/u, ""))
    .join("\n")
    .trim();
}

export function knowledgeBaseMarkdownSha256(value: string) {
  return createHash("sha256")
    .update(canonicalKnowledgeBaseMarkdown(value), "utf8")
    .digest("hex");
}

function normalizedIdentity(value: string | undefined) {
  return String(value || "")
    .normalize("NFKC")
    .trim();
}

function packageLeafDocuments(documents: readonly KnowledgeDocument[]) {
  return documents.filter((document) => document.kind === "leaf");
}

function physicalAssetsByHash(assets: readonly KnowledgeAsset[]) {
  const byHash = new Map<string, KnowledgeAsset>();
  for (const asset of assets) {
    const hash = normalizedIdentity(asset.sha256).toLowerCase();
    if (/^[a-f0-9]{64}$/u.test(hash) && !byHash.has(hash)) {
      byHash.set(hash, asset);
    }
  }
  return byHash;
}

/**
 * Older v3 packages could contain many visuals. Only a uniquely identified
 * primary brand badge may be promoted into the v4 Dashboard Logo slot.
 */
export function selectLegacyKnowledgeBaseLogoAsset(input: {
  assets: readonly KnowledgeAsset[];
  expectedLogoSha256?: string | null;
}) {
  const physicalAssets = physicalAssetsByHash(input.assets);
  const expected = normalizedIdentity(
    input.expectedLogoSha256 || undefined,
  ).toLowerCase();
  if (expected) {
    const matched = physicalAssets.get(expected);
    if (!matched) {
      throw new KnowledgeBasePackageBindingError(
        "历史最终 ZIP 未包含此前绑定的官方主 Logo",
      );
    }
    return matched;
  }

  const tiers = [
    [...physicalAssets.values()].filter(
      (asset) =>
        asset.assetType === "brand_identity" && asset.displayRole === "badge",
    ),
    [...physicalAssets.values()].filter(
      (asset) => asset.assetType === "brand_identity",
    ),
  ];
  for (const candidates of tiers) {
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      throw new KnowledgeBasePackageBindingError(
        "历史最终 ZIP 包含多个不同的品牌 Logo，无法安全选择官方主 Logo",
      );
    }
  }
  throw new KnowledgeBasePackageBindingError(
    "历史最终 ZIP 未唯一标记官方主 Logo，不能自动重新绑定",
  );
}

/**
 * Enterprise archives may wrap the customer-approved leaf in an outer report
 * shell with an internal evidence appendix. Only the single formal block is
 * the leaf document. Builder v4 is required to copy the approved Markdown into
 * that block byte-for-byte modulo canonical whitespace.
 */
export function canonicalPackagedKnowledgeBaseLeafMarkdown(value: string) {
  const content = String(value || "");
  const startMarker = "<!-- FRONTMIND_FORMAL_CONTENT_START -->";
  const endMarker = "<!-- FRONTMIND_FORMAL_CONTENT_END -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (
    start >= 0 &&
    end > start &&
    content.indexOf(startMarker, start + startMarker.length) < 0 &&
    content.indexOf(endMarker, end + endMarker.length) < 0
  ) {
    return canonicalKnowledgeBaseMarkdown(
      content.slice(start + startMarker.length, end),
    );
  }
  return canonicalKnowledgeBaseMarkdown(content);
}

/**
 * Bind a validated enterprise archive to the exact build that the customer
 * confirmed. Package self-consistency is not enough: a model could otherwise
 * replace one leaf with another while keeping counts and manifest hashes valid.
 */
export function assertKnowledgeBasePackageMatchesBuild(input: {
  nodes: readonly KnowledgeBasePackageNode[];
  documents: readonly KnowledgeDocument[];
  assets: readonly KnowledgeAsset[];
  expectedLogoSha256: string;
  requireExactContent?: boolean;
  /**
   * Builder v3 used sparse document orders (10, 20, ...) and could package
   * additional first-party visuals. Keep the semantic order and the exact
   * approved Logo/content binding without pretending those archives were v4.
   */
  legacyV3Compatibility?: boolean;
}) {
  const handledNodes = input.nodes
    .filter(
      (node) =>
        node.status === "confirmed" || node.status === "direct_prefilled",
    )
    .sort((left, right) => left.ordinal - right.ordinal);
  if (handledNodes.length !== input.nodes.length || handledNodes.length === 0) {
    throw new KnowledgeBasePackageBindingError(
      "知识库仍有未确认节点，不能绑定最终 ZIP",
    );
  }

  const leafDocuments = packageLeafDocuments(input.documents);
  if (leafDocuments.length !== handledNodes.length) {
    throw new KnowledgeBasePackageBindingError(
      `最终 ZIP 叶子数量与已确认节点不一致：期望 ${handledNodes.length}，实际 ${leafDocuments.length}`,
    );
  }

  const documentsById = new Map<string, KnowledgeDocument>();
  for (const document of leafDocuments) {
    const id = normalizedIdentity(document.id);
    if (!id || documentsById.has(id)) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 包含空白或重复的叶子标识：${id || "<empty>"}`,
      );
    }
    documentsById.set(id, document);
  }

  if (input.legacyV3Compatibility) {
    const orderedDocuments = [...leafDocuments].sort((left, right) => {
      const leftOrder = left.order;
      const rightOrder = right.order;
      if (!Number.isInteger(leftOrder) || !Number.isInteger(rightOrder)) {
        return 0;
      }
      return leftOrder! - rightOrder!;
    });
    const orders = orderedDocuments.map((document) => document.order);
    if (
      orders.some((order) => !Number.isInteger(order) || order! < 0) ||
      new Set(orders).size !== orders.length ||
      orderedDocuments.some(
        (document, index) =>
          normalizedIdentity(document.id) !== handledNodes[index]?.leafId,
      )
    ) {
      throw new KnowledgeBasePackageBindingError(
        "历史最终 ZIP 节点顺序与已确认版本不一致",
      );
    }
  }

  for (const node of handledNodes) {
    const document = documentsById.get(node.leafId);
    if (!document) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 缺少已确认节点：${node.leafId}`,
      );
    }
    if (normalizedIdentity(document.title) !== normalizedIdentity(node.title)) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点标题与已确认版本不一致：${node.leafId}`,
      );
    }
    if (
      normalizedIdentity(document.branchId) !==
        normalizedIdentity(node.branchId) ||
      normalizedIdentity(document.branchTitle) !==
        normalizedIdentity(node.branchTitle)
    ) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点分支与已确认版本不一致：${node.leafId}`,
      );
    }
    if (!input.legacyV3Compatibility && document.order !== node.ordinal) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点顺序与已确认版本不一致：${node.leafId}`,
      );
    }

    const packagedContent = canonicalPackagedKnowledgeBaseLeafMarkdown(
      document.content,
    );
    const acceptedContent = canonicalKnowledgeBaseMarkdown(
      node.contentMarkdown || "",
    );
    if (!packagedContent || !acceptedContent) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 或已确认节点正文为空：${node.leafId}`,
      );
    }
    const acceptedHash = knowledgeBaseMarkdownSha256(acceptedContent);
    if (node.contentSha256 && node.contentSha256 !== acceptedHash) {
      throw new KnowledgeBasePackageBindingError(
        `数据库节点正文哈希无效：${node.leafId}`,
      );
    }
    if (
      input.requireExactContent !== false &&
      knowledgeBaseMarkdownSha256(packagedContent) !== acceptedHash
    ) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点正文与客户已确认版本不一致：${node.leafId}`,
      );
    }
  }

  const expectedLogoSha256 = normalizedIdentity(
    input.expectedLogoSha256,
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedLogoSha256)) {
    throw new KnowledgeBasePackageBindingError(
      "首轮官方主 Logo 尚未完成字节级绑定",
    );
  }
  const imageHashes = Array.from(
    new Set(
      input.assets
        .map((asset) => normalizedIdentity(asset.sha256).toLowerCase())
        .filter((hash) => /^[a-f0-9]{64}$/u.test(hash)),
    ),
  );
  const logoMatches = imageHashes.filter((hash) => hash === expectedLogoSha256);
  if (
    (input.legacyV3Compatibility && logoMatches.length !== 1) ||
    (!input.legacyV3Compatibility &&
      (imageHashes.length !== 1 || imageHashes[0] !== expectedLogoSha256))
  ) {
    throw new KnowledgeBasePackageBindingError(
      input.legacyV3Compatibility
        ? "历史最终 ZIP 未包含首轮已绑定的唯一官方主 Logo"
        : "最终 ZIP 必须只包含首轮已绑定的同一张官方主 Logo",
    );
  }

  return {
    leafCount: handledNodes.length,
    logoSha256: expectedLogoSha256,
    contentHashes: handledNodes.map((node) => ({
      leafId: node.leafId,
      sha256: knowledgeBaseMarkdownSha256(node.contentMarkdown || ""),
    })),
  };
}
