import { createHash } from "node:crypto";

import axios from "axios";

import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { waitForUpstreamFilesReady } from "./upstream-file-readiness";

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

export class UpstreamTaskAttachmentPendingError extends Error {
  readonly code = "UPSTREAM_FILE_PENDING";

  constructor(readonly fileId: string) {
    super("Task attachment is still processing upstream");
    this.name = "UpstreamTaskAttachmentPendingError";
  }
}

export type UpstreamTaskAttachmentContentProofFailureClass =
  | "transient"
  | "deterministic";

export type UpstreamTaskAttachmentContentProofReason =
  | "network"
  | "http_status"
  | "invalid_stream"
  | "stream_interrupted"
  | "invalid_chunk"
  | "size_mismatch"
  | "sha256_mismatch";

/**
 * Safe, credential-free classification for an existing generated file whose
 * authenticated /content proof could not be completed. The message never
 * contains a provider file id, filename, URL, response body, or API key.
 */
export class UpstreamTaskAttachmentContentProofError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    readonly failureClass: UpstreamTaskAttachmentContentProofFailureClass,
    readonly reason: UpstreamTaskAttachmentContentProofReason,
    readonly httpStatus?: number,
  ) {
    super(
      failureClass === "transient"
        ? "Provider attachment content proof is temporarily unavailable"
        : "Provider attachment content proof failed integrity validation",
    );
    this.name = "UpstreamTaskAttachmentContentProofError";
    this.code =
      failureClass === "transient"
        ? "UPSTREAM_FILE_CONTENT_PROOF_UNAVAILABLE"
        : "UPSTREAM_FILE_CONTENT_PROOF_INVALID";
    this.retryable = failureClass === "transient";
  }
}

function contentProofHttpFailureClass(
  status: number,
): UpstreamTaskAttachmentContentProofFailureClass {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "transient"
    : "deterministic";
}

async function assertProviderContentMatches(input: {
  baseUrl: string;
  fileId: string;
  filename: string;
  bytes: Buffer;
  authHeaders: Record<string, string>;
}) {
  let content;
  try {
    content = await axios.get(
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
  } catch {
    throw new UpstreamTaskAttachmentContentProofError("transient", "network");
  }
  if (content.status < 200 || content.status >= 300) {
    destroyProviderContent(content.data);
    throw new UpstreamTaskAttachmentContentProofError(
      contentProofHttpFailureClass(content.status),
      "http_status",
      content.status,
    );
  }

  const stream = content.data as
    | (AsyncIterable<unknown> & { destroy?: () => void })
    | null
    | undefined;
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    destroyProviderContent(content.data);
    throw new UpstreamTaskAttachmentContentProofError(
      "deterministic",
      "invalid_stream",
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
      throw new UpstreamTaskAttachmentContentProofError(
        "transient",
        "stream_interrupted",
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
      throw new UpstreamTaskAttachmentContentProofError(
        "deterministic",
        "invalid_chunk",
      );
    }
    actualSize += chunk.length;
    if (actualSize > input.bytes.length) {
      destroyProviderContent(stream);
      throw new UpstreamTaskAttachmentContentProofError(
        "deterministic",
        "size_mismatch",
      );
    }
    actualSha256.update(chunk);
  }
  if (actualSize !== input.bytes.length) {
    throw new UpstreamTaskAttachmentContentProofError(
      "deterministic",
      "size_mismatch",
    );
  }
  if (actualSha256.digest("hex") !== expectedSha256) {
    throw new UpstreamTaskAttachmentContentProofError(
      "deterministic",
      "sha256_mismatch",
    );
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
  /** Bounded provider readiness wait; production defaults to five minutes. */
  readinessDeadlineMs?: number;
  /** Test seam for readiness backoff without changing production timing. */
  readinessSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  const mimeType = input.mimeType || "application/zip";
  const authHeaders = {
    API_KEY: input.apiKey,
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
      const readiness = await waitForUpstreamFilesReady({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        files: [{ fileId, filename: input.filename }],
        deadlineMs: input.readinessDeadlineMs,
        sleep: input.readinessSleep,
      });
      if (readiness.pending.length > 0) {
        throw new UpstreamTaskAttachmentPendingError(fileId);
      }
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
    const readiness = await waitForUpstreamFilesReady({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      files: [{ fileId, filename: input.filename }],
      deadlineMs: input.readinessDeadlineMs,
      sleep: input.readinessSleep,
    });
    if (readiness.pending.length > 0) {
      throw new UpstreamTaskAttachmentPendingError(fileId);
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
