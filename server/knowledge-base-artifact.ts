import { createHash } from "node:crypto";

const MAX_ARCHIVE_CANDIDATES = 32;
const MAX_FILE_ID_LENGTH = 255;
const MAX_FILENAME_LENGTH = 512;
const MAX_URL_LENGTH = 8_192;

export interface KnowledgeArchiveDescriptor {
  outputItemId: string;
  fileId?: string;
  url?: string;
  filename: string;
  mimeType: string;
}

export function knowledgeArchiveFileIdFromUrl(value: string) {
  const match = value.match(/\/v1\/files\/([^/?#]+)(?:\/content)?(?:[?#]|$)/i);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]).slice(0, MAX_FILE_ID_LENGTH);
  } catch {
    return match[1].slice(0, MAX_FILE_ID_LENGTH);
  }
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function descriptorFromTypedFile(
  value: unknown,
  outputItemId: string,
): KnowledgeArchiveDescriptor | null {
  const item = asObject(value);
  if (!item) return null;
  const type = String(item.type ?? "").toLowerCase();
  if (type !== "output_file" && type !== "file") return null;

  const filename = String(
    item.fileName ?? item.file_name ?? item.filename ?? item.name ?? "",
  )
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  const mimeType = String(
    item.mimeType ?? item.mime_type ?? item.content_type ?? "",
  )
    .trim()
    .toLowerCase()
    .slice(0, 255);
  const rawFileId = String(item.file_id ?? item.fileId ?? "").trim();
  const rawUrl = String(
    item.file_url ?? item.fileUrl ?? item.url ?? "",
  ).trim();
  const fileId = (rawFileId || knowledgeArchiveFileIdFromUrl(rawUrl) || "").slice(
    0,
    MAX_FILE_ID_LENGTH,
  );
  const url = rawUrl.slice(0, MAX_URL_LENGTH);
  const isZip =
    filename.toLowerCase().endsWith(".zip") ||
    mimeType.includes("application/zip") ||
    mimeType.includes("application/x-zip");
  if (!isZip || (!fileId && !url)) return null;

  return {
    outputItemId: outputItemId.slice(0, 255),
    fileId: fileId || undefined,
    url: url || undefined,
    filename: filename || "knowledge-base.zip",
    mimeType: mimeType || "application/zip",
  };
}

/**
 * Only trusts typed file records emitted directly by the task or inside an
 * assistant message. Metadata, reasoning, user messages and arbitrary nested
 * objects are deliberately outside this boundary.
 */
export function collectKnowledgeArchiveDescriptors(
  output: unknown,
): KnowledgeArchiveDescriptor[] {
  if (!Array.isArray(output)) return [];
  const descriptors: KnowledgeArchiveDescriptor[] = [];

  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    if (descriptors.length >= MAX_ARCHIVE_CANDIDATES) break;
    const item = asObject(output[outputIndex]);
    if (!item || item.role === "user") continue;
    const parentId = String(item.id || `output:${outputIndex}`).slice(0, 191);

    const topLevel = descriptorFromTypedFile(item, parentId);
    if (topLevel) descriptors.push(topLevel);
    if (descriptors.length >= MAX_ARCHIVE_CANDIDATES) break;

    const type = String(item.type || "message").toLowerCase();
    if (
      item.role !== "assistant" ||
      (type !== "message" && type !== "output_message") ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (
      let contentIndex = 0;
      contentIndex < item.content.length;
      contentIndex += 1
    ) {
      if (descriptors.length >= MAX_ARCHIVE_CANDIDATES) break;
      const descriptor = descriptorFromTypedFile(
        item.content[contentIndex],
        `${parentId}:content:${contentIndex}`,
      );
      if (descriptor) descriptors.push(descriptor);
    }
  }

  return descriptors;
}

export function knowledgeArchiveDescriptorHash(
  descriptor: KnowledgeArchiveDescriptor,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outputItemId: descriptor.outputItemId,
        fileId: descriptor.fileId || null,
        urlHash: descriptor.fileId
          ? null
          : createHash("sha256")
              .update(descriptor.url || "")
              .digest("hex"),
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
      }),
    )
    .digest("hex");
}
