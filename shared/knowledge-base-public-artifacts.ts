import {
  containsPrivateProviderBrand,
  sanitizeFrontMindPublicText,
} from "./frontmind-public-brand";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/giu;

/**
 * Produce customer-owned text without changing the immutable source record.
 * Provider-owned URLs are removed instead of being rewritten into a URL that
 * FrontMind does not own; all remaining historical brand text is normalized.
 */
export function customerSafeKnowledgeText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return sanitizeFrontMindPublicText(
    text.replace(HTTP_URL_PATTERN, (url) =>
      containsPrivateProviderBrand(url) ? "" : url,
    ),
  );
}

export function customerSafeKnowledgeFilename(
  value: unknown,
  fallback = "FrontMind-knowledge-base.zip",
): string {
  const filename = customerSafeKnowledgeText(value)
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim();
  return filename || fallback;
}

export function customerSafeKnowledgeUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((candidate) => String(candidate ?? "").trim())
        .filter((candidate) => {
          if (!candidate || containsPrivateProviderBrand(candidate)) {
            return false;
          }
          try {
            const url = new URL(candidate);
            return url.protocol === "http:" || url.protocol === "https:";
          } catch {
            return false;
          }
        }),
    ),
  ].sort();
}

export function customerSafeKnowledgeReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean)
    .filter(
      (candidate) =>
        !/^https?:\/\//iu.test(candidate) ||
        !containsPrivateProviderBrand(candidate),
    )
    .map(customerSafeKnowledgeText);
}

export function customerSafeKnowledgeUrl(value: unknown): string | undefined {
  const candidate = String(value ?? "").trim();
  if (!candidate || containsPrivateProviderBrand(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function customerSafeKnowledgeValue(value: unknown): unknown {
  if (typeof value === "string") return customerSafeKnowledgeText(value);
  if (Array.isArray(value)) return value.map(customerSafeKnowledgeValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        customerSafeKnowledgeText(key),
        customerSafeKnowledgeValue(nested),
      ]),
    );
  }
  return value;
}

function customerSafeKnowledgeRecord<T extends Record<string, unknown>>(
  value: T,
): T {
  return customerSafeKnowledgeValue(value) as T;
}

export function toCustomerSafeKnowledgeDocument<
  T extends Record<string, unknown>,
>(document: T): T {
  return {
    ...customerSafeKnowledgeRecord(document),
    ...(typeof document.id === "string"
      ? { id: customerSafeKnowledgeText(document.id) }
      : {}),
    path: customerSafeKnowledgeText(document.path),
    title: customerSafeKnowledgeText(document.title),
    content: customerSafeKnowledgeText(document.content),
    ...(typeof document.branchId === "string"
      ? { branchId: customerSafeKnowledgeText(document.branchId) }
      : {}),
    ...(typeof document.branchTitle === "string"
      ? { branchTitle: customerSafeKnowledgeText(document.branchTitle) }
      : {}),
    ...(Array.isArray(document.sourceIds)
      ? { sourceIds: customerSafeKnowledgeReferenceIds(document.sourceIds) }
      : {}),
    ...(Array.isArray(document.evidenceDocumentIds)
      ? {
          evidenceDocumentIds: customerSafeKnowledgeReferenceIds(
            document.evidenceDocumentIds,
          ),
        }
      : {}),
    ...(Array.isArray(document.assetIds)
      ? { assetIds: customerSafeKnowledgeReferenceIds(document.assetIds) }
      : {}),
  } as T;
}

export function toCustomerSafeKnowledgeAsset<T extends Record<string, unknown>>(
  asset: T,
  index: number,
): T {
  const id =
    typeof asset.id === "string"
      ? customerSafeKnowledgeText(asset.id)
      : undefined;
  return {
    ...customerSafeKnowledgeRecord(asset),
    ...(id ? { id } : {}),
    // Storage keys and upstream file identities are not public capabilities.
    key: id || `public-asset-${index + 1}`,
    path: customerSafeKnowledgeText(asset.path),
    ...(typeof asset.caption === "string"
      ? { caption: customerSafeKnowledgeText(asset.caption) }
      : {}),
    ...(typeof asset.alt === "string"
      ? { alt: customerSafeKnowledgeText(asset.alt) }
      : {}),
    ...(typeof asset.branchId === "string"
      ? { branchId: customerSafeKnowledgeText(asset.branchId) }
      : {}),
    ...(typeof asset.sourceDocumentPath === "string"
      ? {
          sourceDocumentPath: customerSafeKnowledgeText(
            asset.sourceDocumentPath,
          ),
        }
      : {}),
    ...(typeof asset.sourceUploadFilename === "string"
      ? {
          sourceUploadFilename: customerSafeKnowledgeFilename(
            asset.sourceUploadFilename,
            "FrontMind-upload",
          ),
        }
      : {}),
    sourcePageUrl: customerSafeKnowledgeUrl(asset.sourcePageUrl),
    sourceAssetUrl: customerSafeKnowledgeUrl(asset.sourceAssetUrl),
    sourceUploadFileId: undefined,
    sourceUploadSha256: undefined,
  } as T;
}
