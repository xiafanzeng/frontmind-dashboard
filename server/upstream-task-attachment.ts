import { createHash } from "node:crypto";

import axios from "axios";

import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";

const REPLAYABLE_PRE_UPLOAD_STATUSES = new Set([
  "created",
  "not_uploaded",
  "pending",
  "upload_pending",
  "awaiting_upload",
]);

type ProviderReplayMetadata = Pick<
  CanonicalProviderFile,
  "id" | "filename" | "status"
>;

export type CanonicalProviderFile = {
  id: string;
  filename: string;
  sizeBytes: number | null;
  status: string;
  uploadUrl: string;
  mimeType: string | null;
  sha256: string | null;
};

function providerRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalStringAlias(
  source: Record<string, unknown>,
  aliases: readonly string[],
  normalize: (value: string) => string = (value) => value,
  nullIsMissing = false,
) {
  const values = aliases
    .filter((alias) => Object.prototype.hasOwnProperty.call(source, alias))
    .map((alias) => source[alias])
    .map((value) =>
      value === null && nullIsMissing
        ? undefined
        : typeof value === "string"
          ? normalize(value)
          : null,
    );
  if (values.some((value) => value === null)) return { valid: false } as const;
  const present = values.filter(
    (value): value is string => value !== undefined,
  );
  if (present.length === 0) return { valid: true, value: null } as const;
  if (present.some((value) => value !== present[0])) {
    return { valid: false } as const;
  }
  return { valid: true, value: present[0] } as const;
}

function canonicalSizeAlias(
  source: Record<string, unknown>,
  aliases: readonly string[],
) {
  const values = aliases
    .filter((alias) => Object.prototype.hasOwnProperty.call(source, alias))
    .map((alias) => source[alias])
    .map((value) => {
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        return value;
      }
      if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
      }
      return null;
    });
  if (values.some((value) => value === null)) return { valid: false } as const;
  const present = values as number[];
  if (present.length === 0) return { valid: true, value: null } as const;
  if (present.some((value) => value !== present[0])) {
    return { valid: false } as const;
  }
  return { valid: true, value: present[0] } as const;
}

export function canonicalProviderFile(
  value: unknown,
): CanonicalProviderFile | null {
  const source = providerRecord(value);
  if (!source) return null;
  const id = canonicalStringAlias(source, ["id", "file_id"]);
  const filename = canonicalStringAlias(source, ["filename", "file_name"]);
  const sizeBytes = canonicalSizeAlias(source, [
    "bytes",
    "size",
    "size_bytes",
    "sizeBytes",
  ]);
  const status = canonicalStringAlias(
    source,
    ["status", "upload_status", "uploadStatus"],
    (item) => item.trim().toLowerCase().replace(/[ -]+/gu, "_"),
  );
  const uploadUrl = canonicalStringAlias(
    source,
    ["upload_url"],
    (item) => item,
    true,
  );
  const mimeType = canonicalStringAlias(
    source,
    ["mime_type", "mimeType", "content_type", "contentType"],
    (item) => item.trim().toLowerCase().split(";", 1)[0] || "",
    true,
  );
  const sha256 = canonicalStringAlias(
    source,
    ["sha256", "content_sha256", "contentSha256", "checksum_sha256"],
    (item) => item.trim().toLowerCase(),
    true,
  );
  if (
    !id.valid ||
    !filename.valid ||
    !sizeBytes.valid ||
    !status.valid ||
    !uploadUrl.valid ||
    !mimeType.valid ||
    !sha256.valid
  ) {
    return null;
  }
  return {
    id: id.value || "",
    filename: filename.value || "",
    sizeBytes: sizeBytes.value,
    status: status.value || "",
    uploadUrl: uploadUrl.value || "",
    mimeType: mimeType.value,
    sha256: sha256.value,
  };
}

export function canonicalMimeType(value: string) {
  return value.trim().toLowerCase().split(";", 1)[0] || "";
}

function canonicalProviderReplayMetadata(
  value: unknown,
): ProviderReplayMetadata | null {
  const source = providerRecord(value);
  if (!source) return null;
  const id = canonicalStringAlias(source, ["id", "file_id"]);
  const filename = canonicalStringAlias(source, ["filename", "file_name"]);
  const status = canonicalStringAlias(
    source,
    ["status", "upload_status", "uploadStatus"],
    (item) => item.trim().toLowerCase().replace(/[ -]+/gu, "_"),
  );
  if (!id.valid || !filename.valid || !status.valid) return null;
  return {
    id: id.value || "",
    filename: filename.value || "",
    status: status.value || "",
  };
}

function destroyProviderContent(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "destroy" in value &&
    typeof value.destroy === "function"
  ) {
    value.destroy();
  }
}

async function assertProviderContentMatches(input: {
  baseUrl: string;
  fileId: string;
  filename: string;
  bytes: Buffer;
  authHeaders: Record<string, string>;
}) {
  const content = await axios.get(
    `${input.baseUrl}/v1/files/${encodeURIComponent(input.fileId)}/content`,
    {
      headers: input.authHeaders,
      responseType: "stream",
      timeout: 120_000,
      maxRedirects: 0,
      maxContentLength: input.bytes.length + 1,
      decompress: false,
      validateStatus: () => true,
    },
  );
  if (content.status < 200 || content.status >= 300) {
    destroyProviderContent(content.data);
    throw new Error(`Task attachment content lookup failed: ${input.filename}`);
  }

  const stream = content.data as
    | (AsyncIterable<unknown> & { destroy?: () => void })
    | null
    | undefined;
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    destroyProviderContent(content.data);
    throw new Error(
      `Task attachment content response is invalid: ${input.filename}`,
    );
  }

  const expectedSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const actualSha256 = createHash("sha256");
  let actualSize = 0;
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<unknown>;
    try {
      next = await iterator.next();
    } catch {
      destroyProviderContent(stream);
      throw new Error(
        `Task attachment content lookup failed: ${input.filename}`,
      );
    }
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : next.value instanceof Uint8Array
        ? Buffer.from(next.value)
        : typeof next.value === "string"
          ? Buffer.from(next.value)
          : null;
    if (!chunk) {
      destroyProviderContent(stream);
      throw new Error(
        `Task attachment content response is invalid: ${input.filename}`,
      );
    }
    actualSize += chunk.length;
    if (actualSize > input.bytes.length) {
      destroyProviderContent(stream);
      throw new Error(`Task attachment content mismatch: ${input.filename}`);
    }
    actualSha256.update(chunk);
  }
  if (
    actualSize !== input.bytes.length ||
    actualSha256.digest("hex") !== expectedSha256
  ) {
    throw new Error(`Task attachment content mismatch: ${input.filename}`);
  }
}

export async function uploadUpstreamTaskAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  /** Stable per-turn/per-slot key. Required by durable KB attachment callers. */
  idempotencyKey?: string;
  /** Completed reservation replay: verify/reuse this exact provider file. */
  existingFileId?: string;
  /** Persist file ownership before any byte upload can begin. */
  onFileResolved?: (fileId: string) => Promise<void>;
}) {
  const mimeType = input.mimeType || "application/zip";
  const authHeaders = {
    API_KEY: input.apiKey,
    Authorization: `Bearer ${input.apiKey}`,
  };
  let createdData: Record<string, unknown> = {};
  const suppliedFileId = String(input.existingFileId || "");
  const usesExistingFile = Boolean(suppliedFileId.trim());
  let fileId = suppliedFileId;
  if (!usesExistingFile) {
    const created = await axios.post(
      `${input.baseUrl}/v1/files`,
      { filename: input.filename },
      {
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(input.idempotencyKey
            ? { "Idempotency-Key": input.idempotencyKey }
            : {}),
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    createdData =
      created.data && typeof created.data === "object" ? created.data : {};
    fileId = String(createdData.id || createdData.file_id || "");
    if (created.status < 200 || created.status >= 300 || !fileId.trim()) {
      throw new Error(`Task attachment creation failed: ${input.filename}`);
    }
  }

  const removeOrphan = async () => {
    await axios
      .delete(`${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`, {
        headers: authHeaders,
        timeout: 30_000,
        validateStatus: () => true,
      })
      .catch(() => undefined);
  };

  try {
    // Once this callback commits, file id + credential + conversation cleanup
    // ownership are durable. Never delete the file on later upload failures;
    // recovery must inspect and reuse the same file id.
    await input.onFileResolved?.(fileId);
    const uploadUrl =
      typeof createdData.upload_url === "string" ? createdData.upload_url : "";
    if (usesExistingFile) {
      const metadata = await axios.get(
        `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers: authHeaders,
          timeout: 30_000,
          validateStatus: () => true,
        },
      );
      if (metadata.status < 200 || metadata.status >= 300) {
        throw new Error(
          `Task attachment metadata lookup failed: ${input.filename}`,
        );
      }
      const providerFile = canonicalProviderReplayMetadata(metadata.data);
      if (!providerFile) {
        throw new Error(
          `Task attachment metadata is invalid: ${input.filename}`,
        );
      }
      if (
        providerFile.id !== fileId ||
        providerFile.filename !== input.filename
      ) {
        throw new Error(`Task attachment metadata mismatch: ${input.filename}`);
      }
      if (providerFile.status === "uploaded") {
        await assertProviderContentMatches({
          baseUrl: input.baseUrl,
          fileId,
          filename: input.filename,
          bytes: input.bytes,
          authHeaders,
        });
        return {
          attachment: { file_id: fileId, filename: input.filename },
          fileId,
          removeOrphan,
        };
      }
      if (!REPLAYABLE_PRE_UPLOAD_STATUSES.has(providerFile.status)) {
        throw new Error(
          `Task attachment state is not safely replayable: ${input.filename}`,
        );
      }
      throw new Error(
        `Task attachment upload capability is unavailable for existing file: ${input.filename}`,
      );
    }
    if (!uploadUrl) {
      throw new Error(
        `Task attachment upload URL is unavailable: ${input.filename}`,
      );
    }
    const target = assertSafeExternalUrl(uploadUrl);
    const uploaded = await axios.put(target, input.bytes, {
      ...safeExternalRequestOptions,
      // Query-signed uploads must use the exact URL and cannot carry API auth.
      maxRedirects: 0,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(input.bytes.length),
      },
      timeout: 120_000,
      maxBodyLength: input.bytes.length,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true,
    });
    if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new Error(`Task attachment upload failed: ${input.filename}`);
    }
    return {
      attachment: { file_id: fileId, filename: input.filename },
      fileId,
      removeOrphan,
    };
  } catch (error) {
    if (!usesExistingFile && !input.onFileResolved) await removeOrphan();
    throw error;
  }
}
