import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";

import axios from "axios";

import { stripFrontMindGeneralChatOperationContract } from "../shared/frontmind-general-chat-contract";
import { upstreamTaskRecord } from "./upstream-task-adapter";

const GENERAL_CHAT_PROVIDER_EVIDENCE_SCHEMA_VERSION = 1 as const;
const MAX_ATTACHMENT_COUNT = 32;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = MAX_ATTACHMENT_COUNT * MAX_ATTACHMENT_BYTES;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const SUCCESS_CACHE_TTL_MS = 10 * 60_000;
const SUCCESS_CACHE_MAX_ENTRIES = 512;

const SIGNATURE_QUERY_PARAMETERS = new Set(
  [
    "policy",
    "signature",
    "key-pair-id",
    "expires",
    "awsaccesskeyid",
    "x-amz-algorithm",
    "x-amz-credential",
    "x-amz-date",
    "x-amz-expires",
    "x-amz-security-token",
    "x-amz-signature",
    "x-amz-signedheaders",
    "x-goog-algorithm",
    "x-goog-credential",
    "x-goog-date",
    "x-goog-expires",
    "x-goog-signature",
    "x-goog-signedheaders",
  ].map((value) => value.toLowerCase()),
);

const TRANSIENT_STREAM_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_CANCELED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
]);

export type GeneralChatLocalAttachmentManifestItem = {
  fileId: string;
  sha256: string;
  sizeBytes: number;
  filename?: string | null;
  mimeType?: string | null;
};

export type GeneralChatProviderAttachmentContentItem = {
  sha256: string;
  sizeBytes: number;
  filename: string | null;
  mimeType: string | null;
};

/**
 * Safe, durable evidence derived from a Provider user event. Signed URLs and
 * file bodies are deliberately absent. A descriptor digest excludes only
 * known signing coordinates while preserving every semantic query value.
 */
export type GeneralChatProviderAttachmentEvidence = {
  schemaVersion: typeof GENERAL_CHAT_PROVIDER_EVIDENCE_SCHEMA_VERSION;
  descriptorSha256: string[];
  contentManifest: GeneralChatProviderAttachmentContentItem[];
};

export type GeneralChatUserEventEvidenceDisposition =
  | {
      kind: "match";
      code: "GENERAL_CHAT_REQUEST_MATCH";
      evidence: GeneralChatProviderAttachmentEvidence | null;
    }
  | {
      kind: "mismatch";
      code:
        | "PROMPT_MISMATCH"
        | "ATTACHMENT_FILE_ID_MISMATCH"
        | "ATTACHMENT_COUNT_MISMATCH"
        | "ATTACHMENT_CONTENT_MISMATCH"
        | "UNEXPECTED_PROVIDER_ATTACHMENT";
      evidence: GeneralChatProviderAttachmentEvidence | null;
    }
  | {
      kind: "unresolved";
      code:
        | "ATTACHMENT_DESCRIPTOR_MISSING"
        | "ATTACHMENT_DESCRIPTOR_CONFLICT"
        | "ATTACHMENT_DESCRIPTOR_UNSAFE"
        | "ATTACHMENT_DOWNLOAD_FAILED"
        | "ATTACHMENT_DOWNLOAD_LIMIT"
        | "ATTACHMENT_DOWNLOAD_TIMEOUT"
        | "ATTACHMENT_EVIDENCE_INVALID";
      evidence: GeneralChatProviderAttachmentEvidence | null;
    };

export type GeneralChatProviderAttachmentReader = (input: {
  url: string;
  signal: AbortSignal;
  maxBytes: number;
  timeoutMs: number;
}) => Promise<{
  body: AsyncIterable<Uint8Array | string>;
  contentLength?: number | null;
  contentType?: string | null;
}>;

type ProviderAttachmentDescriptor = {
  url: string | null;
  filename: string | null;
  mimeType: string | null;
};

type SuccessCacheEntry = {
  expiresAt: number;
  evidence: GeneralChatProviderAttachmentEvidence;
};

const successfulEvidenceCache = new Map<string, SuccessCacheEntry>();

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function safeOptionalString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function firstOptionalString(values: readonly unknown[], maxLength: number) {
  for (const value of values) {
    const normalized = safeOptionalString(value, maxLength);
    if (normalized) return normalized;
  }
  return null;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function canonicalContentManifest(
  manifest: readonly GeneralChatProviderAttachmentContentItem[],
) {
  return [...manifest].sort(
    (left, right) =>
      left.sha256.localeCompare(right.sha256) ||
      left.sizeBytes - right.sizeBytes ||
      (left.filename ?? "").localeCompare(right.filename ?? "") ||
      (left.mimeType ?? "").localeCompare(right.mimeType ?? ""),
  );
}

export function parseGeneralChatProviderAttachmentEvidence(
  value: unknown,
): GeneralChatProviderAttachmentEvidence | null {
  const record = upstreamTaskRecord(value);
  if (
    record?.schemaVersion !== GENERAL_CHAT_PROVIDER_EVIDENCE_SCHEMA_VERSION ||
    !Array.isArray(record.descriptorSha256) ||
    !Array.isArray(record.contentManifest) ||
    record.descriptorSha256.length > MAX_ATTACHMENT_COUNT ||
    record.contentManifest.length > MAX_ATTACHMENT_COUNT
  ) {
    return null;
  }
  const descriptors = record.descriptorSha256;
  if (
    !descriptors.every(validSha256) ||
    new Set(descriptors).size !== descriptors.length
  ) {
    return null;
  }
  const manifest = record.contentManifest.flatMap((raw) => {
    const item = upstreamTaskRecord(raw);
    if (!item || !validSha256(item.sha256) || !validSize(item.sizeBytes)) {
      return [];
    }
    const filename =
      item.filename === null ? null : safeOptionalString(item.filename, 1_024);
    const mimeType =
      item.mimeType === null
        ? null
        : (safeOptionalString(item.mimeType, 255)?.toLowerCase() ?? null);
    if (
      (item.filename !== null && filename === null) ||
      (item.mimeType !== null && mimeType === null)
    ) {
      return [];
    }
    return [
      {
        sha256: item.sha256,
        sizeBytes: item.sizeBytes,
        filename,
        mimeType,
      },
    ];
  });
  if (
    manifest.length !== record.contentManifest.length ||
    descriptors.length !== manifest.length
  ) {
    return null;
  }
  return {
    schemaVersion: GENERAL_CHAT_PROVIDER_EVIDENCE_SCHEMA_VERSION,
    descriptorSha256: sortedUnique(descriptors),
    contentManifest: canonicalContentManifest(manifest),
  };
}

function evidenceDescriptorsEqual(
  left: GeneralChatProviderAttachmentEvidence,
  right: GeneralChatProviderAttachmentEvidence,
) {
  return (
    left.descriptorSha256.length === right.descriptorSha256.length &&
    left.descriptorSha256.every(
      (descriptor, index) => descriptor === right.descriptorSha256[index],
    )
  );
}

/**
 * A valid first durable observation wins. Concurrent/stale observations may
 * reuse it only when their stable URL descriptors agree. Invalid persisted
 * JSON or descriptor drift is an explicit conflict, never permission to
 * replace evidence and accidentally acknowledge a different request.
 */
export function arbitrateFirstDurableGeneralChatProviderAttachmentEvidence(input: {
  existing: unknown;
  incoming: unknown;
}): {
  kind: "accepted" | "conflict" | "none";
  evidence: GeneralChatProviderAttachmentEvidence | null;
  code: string;
} {
  const existingAbsent =
    input.existing === undefined || input.existing === null;
  const incomingAbsent =
    input.incoming === undefined || input.incoming === null;
  const existing = parseGeneralChatProviderAttachmentEvidence(input.existing);
  const incoming = parseGeneralChatProviderAttachmentEvidence(input.incoming);
  if (!existingAbsent && !existing) {
    return {
      kind: "conflict",
      evidence: null,
      code: "EXISTING_EVIDENCE_INVALID",
    };
  }
  if (!incomingAbsent && !incoming) {
    return {
      kind: "conflict",
      evidence: existing,
      code: "INCOMING_EVIDENCE_INVALID",
    };
  }
  if (existing && incoming && !evidenceDescriptorsEqual(existing, incoming)) {
    return {
      kind: "conflict",
      evidence: existing,
      code: "ATTACHMENT_DESCRIPTOR_CONFLICT",
    };
  }
  if (existing) {
    return {
      kind: "accepted",
      evidence: existing,
      code: "EXISTING_EVIDENCE_ACCEPTED",
    };
  }
  if (incoming) {
    return {
      kind: "accepted",
      evidence: incoming,
      code: "INCOMING_EVIDENCE_ACCEPTED",
    };
  }
  return { kind: "none", evidence: null, code: "EVIDENCE_ABSENT" };
}

export function generalChatProviderEvidenceHasUniqueMatch(input: {
  matchCount: number;
  unresolvedCount?: number;
  unresolvedPlausibleCount?: number;
}) {
  const unresolved =
    input.unresolvedPlausibleCount ?? input.unresolvedCount ?? 0;
  return input.matchCount === 1 && unresolved === 0;
}

function eventUserText(event: Record<string, unknown>) {
  if (event.type !== "user_message") return null;
  const message = upstreamTaskRecord(event.user_message);
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return null;
  const parts = message.content.flatMap((item) => {
    const record = upstreamTaskRecord(item);
    return typeof record?.text === "string" ? [record.text] : [];
  });
  return parts.length ? parts.join("\n") : null;
}

function attachmentRecordCoordinates(record: Record<string, unknown>) {
  const nested = upstreamTaskRecord(
    record.image_url ?? record.file_url ?? record.file ?? record.source,
  );
  return {
    fileId: firstOptionalString(
      [record.file_id, record.fileId, nested?.file_id, nested?.fileId],
      512,
    ),
    url: firstOptionalString(
      [
        record.url,
        record.file_url,
        record.fileUrl,
        record.image_url,
        record.download_url,
        record.downloadUrl,
        nested?.url,
        nested?.file_url,
        nested?.download_url,
      ],
      8_192,
    ),
    filename: firstOptionalString(
      [
        record.filename,
        record.file_name,
        record.name,
        nested?.filename,
        nested?.file_name,
        nested?.name,
      ],
      1_024,
    ),
    mimeType:
      firstOptionalString(
        [
          record.mime_type,
          record.content_type,
          record.mimeType,
          nested?.mime_type,
          nested?.content_type,
          nested?.mimeType,
        ],
        255,
      )?.toLowerCase() ?? null,
  };
}

function normalizedCompleteAttachmentUrl(value: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function attachmentAuxiliaryCoordinatesAgree(
  left: ReturnType<typeof attachmentRecordCoordinates>,
  right: ReturnType<typeof attachmentRecordCoordinates>,
) {
  return !(
    (left.filename && right.filename && left.filename !== right.filename) ||
    (left.mimeType && right.mimeType && left.mimeType !== right.mimeType)
  );
}

function attachmentRecords(event: Record<string, unknown>) {
  if (event.type !== "user_message") return [];
  const message = upstreamTaskRecord(event.user_message);
  const rawRecords = [
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
    ...(Array.isArray(message?.content) ? message.content : []),
  ].flatMap((value) => {
    const record = upstreamTaskRecord(value);
    if (!record) return [];
    const type = safeOptionalString(record.type, 64)?.toLowerCase();
    const nested = upstreamTaskRecord(
      record.image_url ?? record.file_url ?? record.file ?? record.source,
    );
    const hasFileCoordinate =
      record.file_id !== undefined ||
      record.fileId !== undefined ||
      record.url !== undefined ||
      record.file_url !== undefined ||
      record.fileUrl !== undefined ||
      record.image_url !== undefined ||
      record.download_url !== undefined ||
      record.downloadUrl !== undefined ||
      record.filename !== undefined ||
      record.file_name !== undefined ||
      record.mime_type !== undefined ||
      record.content_type !== undefined ||
      nested !== null;
    return !hasFileCoordinate && (type === "text" || "text" in record)
      ? []
      : [record];
  });
  const selected: Array<{
    record: Record<string, unknown>;
    coordinates: ReturnType<typeof attachmentRecordCoordinates>;
    normalizedUrl: string | null;
  }> = [];
  for (const record of rawRecords) {
    const coordinates = attachmentRecordCoordinates(record);
    const normalizedUrl = normalizedCompleteAttachmentUrl(coordinates.url);
    if (coordinates.fileId) {
      if (
        selected.some(
          (candidate) => candidate.coordinates.fileId === coordinates.fileId,
        )
      ) {
        continue;
      }
      // When the richer mirror carries a file id, it replaces only a
      // compatible URL-only mirror. Distinct file ids always remain distinct,
      // even when Provider happens to expose the same URL for both.
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        const candidate = selected[index]!;
        if (
          !candidate.coordinates.fileId &&
          normalizedUrl &&
          candidate.normalizedUrl === normalizedUrl &&
          attachmentAuxiliaryCoordinatesAgree(
            candidate.coordinates,
            coordinates,
          )
        ) {
          selected.splice(index, 1);
        }
      }
      selected.push({ record, coordinates, normalizedUrl });
      continue;
    }
    if (
      normalizedUrl &&
      selected.some(
        (candidate) =>
          candidate.normalizedUrl === normalizedUrl &&
          attachmentAuxiliaryCoordinatesAgree(
            candidate.coordinates,
            coordinates,
          ),
      )
    ) {
      continue;
    }
    selected.push({ record, coordinates, normalizedUrl });
  }
  return selected.map(({ record }) => record);
}

function allowedManusCdnHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized === "manuscdn.com" || normalized.endsWith(".manuscdn.com");
}

export function generalChatProviderAttachmentDescriptor(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    (parsed.port && parsed.port !== "443") ||
    parsed.username ||
    parsed.password ||
    !allowedManusCdnHostname(parsed.hostname)
  ) {
    throw new Error("Unsafe Manus CDN attachment descriptor");
  }
  const semanticEntries = Array.from(parsed.searchParams.entries())
    .filter(([key]) => !SIGNATURE_QUERY_PARAMETERS.has(key.toLowerCase()))
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
  parsed.search = "";
  for (const [key, value] of semanticEntries)
    parsed.searchParams.append(key, value);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (parsed.port === "443") parsed.port = "";
  return parsed.toString();
}

function ipv4Parts(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)
    ? parts
    : null;
}

function publicIpv4(address: string) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

function ipv6Words(address: string) {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mappedIpv4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  let candidate = normalized;
  if (mappedIpv4?.[1] && mappedIpv4[2]) {
    const parts = ipv4Parts(mappedIpv4[2]);
    if (!parts) return null;
    candidate = `${mappedIpv4[1]}${((parts[0]! << 8) | parts[1]!).toString(
      16,
    )}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = candidate.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const raw = [...left, ...Array(missing).fill("0"), ...right];
  if (raw.length !== 8 || raw.some((word) => !/^[a-f0-9]{1,4}$/u.test(word))) {
    return null;
  }
  return raw.map((word) => Number.parseInt(word, 16));
}

export function isGeneralChatProviderAttachmentAddressPublic(address: string) {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (!words) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return publicIpv4(
      `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${
        words[7]! & 0xff
      }`,
    );
  }
  return !(
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (words[0]! & 0xfe00) === 0xfc00 ||
    (words[0]! & 0xffc0) === 0xfe80 ||
    (words[0]! & 0xffc0) === 0xfec0 ||
    (words[0]! & 0xff00) === 0xff00 ||
    (words[0] === 0x2001 && words[1] === 0x0db8) ||
    (words[0] === 0x0064 && words[1] === 0xff9b)
  );
}

async function defaultAttachmentReader(
  input: Parameters<GeneralChatProviderAttachmentReader>[0],
): ReturnType<GeneralChatProviderAttachmentReader> {
  const descriptor = generalChatProviderAttachmentDescriptor(input.url);
  const parsed = new URL(descriptor);
  const addresses = await dnsLookup(parsed.hostname, {
    all: true,
    verbatim: true,
  });
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => !isGeneralChatProviderAttachmentAddressPublic(address),
    )
  ) {
    throw Object.assign(new Error("Unsafe Manus CDN DNS result"), {
      code: "UNSAFE_DNS_RESULT",
    });
  }
  const selected = addresses[0]!;
  const httpsAgent = new HttpsAgent({
    lookup: (_hostname, _options, callback) => {
      callback(null, selected.address, selected.family);
    },
  });
  const response = await axios.get(input.url, {
    responseType: "stream",
    signal: input.signal,
    timeout: input.timeoutMs,
    maxRedirects: 0,
    proxy: false,
    httpsAgent,
    maxContentLength: input.maxBytes,
    maxBodyLength: input.maxBytes,
    validateStatus: (status) => status === 200,
  });
  const rawLength = response.headers["content-length"];
  const parsedLength = Number(
    Array.isArray(rawLength) ? rawLength[0] : rawLength,
  );
  const rawType = response.headers["content-type"];
  return {
    body: response.data as AsyncIterable<Uint8Array | string>,
    contentLength:
      Number.isSafeInteger(parsedLength) && parsedLength >= 0
        ? parsedLength
        : null,
    contentType: safeOptionalString(
      Array.isArray(rawType) ? rawType[0] : rawType,
      255,
    ),
  };
}

export function classifyGeneralChatAttachmentStreamError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (TRANSIENT_STREAM_ERROR_CODES.has(code)) return "transient" as const;
  if (axios.isAxiosError(error)) {
    if (
      error.code &&
      TRANSIENT_STREAM_ERROR_CODES.has(String(error.code).toUpperCase())
    ) {
      return "transient" as const;
    }
    if (!error.response || Number(error.response.status) >= 500) {
      return "transient" as const;
    }
  }
  return "other" as const;
}

function evidenceCacheKey(descriptorSha256: readonly string[]) {
  return sha256(JSON.stringify(sortedUnique(descriptorSha256)));
}

function readSuccessfulCache(key: string, now: number) {
  const value = successfulEvidenceCache.get(key);
  if (!value) return null;
  if (value.expiresAt <= now) {
    successfulEvidenceCache.delete(key);
    return null;
  }
  successfulEvidenceCache.delete(key);
  successfulEvidenceCache.set(key, value);
  return value.evidence;
}

function writeSuccessfulCache(
  key: string,
  evidence: GeneralChatProviderAttachmentEvidence,
  now: number,
) {
  successfulEvidenceCache.delete(key);
  successfulEvidenceCache.set(key, {
    expiresAt: now + SUCCESS_CACHE_TTL_MS,
    evidence,
  });
  while (successfulEvidenceCache.size > SUCCESS_CACHE_MAX_ENTRIES) {
    const oldest = successfulEvidenceCache.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    successfulEvidenceCache.delete(oldest);
  }
}

export function clearGeneralChatProviderAttachmentEvidenceCacheForTests() {
  successfulEvidenceCache.clear();
}

function contentIdentityMatches(
  expected: readonly GeneralChatLocalAttachmentManifestItem[],
  observed: readonly GeneralChatProviderAttachmentContentItem[],
) {
  const expectedIdentity = expected
    .map((item) => `${item.sha256}\0${item.sizeBytes}`)
    .sort();
  const observedIdentity = observed
    .map((item) => `${item.sha256}\0${item.sizeBytes}`)
    .sort();
  return (
    expectedIdentity.length === observedIdentity.length &&
    expectedIdentity.every(
      (identity, index) => identity === observedIdentity[index],
    )
  );
}

function dispositionFromEvidence(
  evidence: GeneralChatProviderAttachmentEvidence,
  localAttachmentManifest: readonly GeneralChatLocalAttachmentManifestItem[],
): GeneralChatUserEventEvidenceDisposition {
  return contentIdentityMatches(
    localAttachmentManifest,
    evidence.contentManifest,
  )
    ? { kind: "match", code: "GENERAL_CHAT_REQUEST_MATCH", evidence }
    : {
        kind: "mismatch",
        code: "ATTACHMENT_CONTENT_MISMATCH",
        evidence,
      };
}

export async function resolveManusV2GeneralChatUserEventEvidence(input: {
  event: Record<string, unknown>;
  promptSha256: string;
  expectedAttachmentFileIds?: readonly string[];
  localAttachmentManifest?: readonly GeneralChatLocalAttachmentManifestItem[];
  cachedEvidence?: unknown;
  readUrl?: GeneralChatProviderAttachmentReader;
  now?: () => number;
  totalTimeoutMs?: number;
}): Promise<GeneralChatUserEventEvidenceDisposition> {
  const text = eventUserText(input.event);
  const expectedPromptSha256 = input.promptSha256.toLowerCase();
  if (!validSha256(expectedPromptSha256) || text === null) {
    return { kind: "mismatch", code: "PROMPT_MISMATCH", evidence: null };
  }
  const observedPromptSha256 = sha256(
    stripFrontMindGeneralChatOperationContract(text),
  );
  if (observedPromptSha256 !== expectedPromptSha256) {
    return { kind: "mismatch", code: "PROMPT_MISMATCH", evidence: null };
  }

  const expectedFileIds = sortedUnique(input.expectedAttachmentFileIds ?? []);
  const localManifest = input.localAttachmentManifest ?? [];
  if (
    localManifest.length > MAX_ATTACHMENT_COUNT ||
    localManifest.some(
      (item) =>
        !safeOptionalString(item.fileId, 512) ||
        !validSha256(item.sha256) ||
        !validSize(item.sizeBytes) ||
        item.sizeBytes > MAX_ATTACHMENT_BYTES,
    ) ||
    new Set(localManifest.map((item) => item.fileId)).size !==
      localManifest.length ||
    localManifest.some((item) => !expectedFileIds.includes(item.fileId))
  ) {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_EVIDENCE_INVALID",
      evidence: null,
    };
  }
  const observedAttachments = attachmentRecords(input.event).map(
    attachmentRecordCoordinates,
  );
  const observedFileIds = sortedUnique(
    observedAttachments.flatMap(({ fileId }) => (fileId ? [fileId] : [])),
  );
  if (observedFileIds.length > 0) {
    // Provider may mirror the same attachment in both `attachments` and
    // `content`; attachmentRecords has already removed those exact mirrors.
    // Any distinct descriptor that remains without a file id is therefore
    // not covered by the exact-id proof and must keep reconciliation closed.
    if (observedAttachments.some(({ fileId }) => fileId === null)) {
      return {
        kind: "unresolved",
        code: "ATTACHMENT_DESCRIPTOR_MISSING",
        evidence: null,
      };
    }
    const matches =
      observedFileIds.length === expectedFileIds.length &&
      observedFileIds.every(
        (fileId, index) => fileId === expectedFileIds[index],
      );
    return matches
      ? { kind: "match", code: "GENERAL_CHAT_REQUEST_MATCH", evidence: null }
      : {
          kind: "mismatch",
          code: "ATTACHMENT_FILE_ID_MISMATCH",
          evidence: null,
        };
  }

  const descriptors = observedAttachments.map(
    ({ url, filename, mimeType }) => ({
      url,
      filename,
      mimeType,
    }),
  );
  const urlDescriptors = descriptors.filter(
    (
      descriptor,
    ): descriptor is ProviderAttachmentDescriptor & { url: string } =>
      descriptor.url !== null,
  );
  if (expectedFileIds.length === 0) {
    return descriptors.length === 0
      ? { kind: "match", code: "GENERAL_CHAT_REQUEST_MATCH", evidence: null }
      : {
          kind: "mismatch",
          code: "UNEXPECTED_PROVIDER_ATTACHMENT",
          evidence: null,
        };
  }
  const cached = parseGeneralChatProviderAttachmentEvidence(
    input.cachedEvidence,
  );
  if (
    input.cachedEvidence !== undefined &&
    input.cachedEvidence !== null &&
    !cached
  ) {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_EVIDENCE_INVALID",
      evidence: null,
    };
  }
  if (localManifest.length !== expectedFileIds.length) {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_EVIDENCE_INVALID",
      evidence: null,
    };
  }
  if (descriptors.length === 0 || urlDescriptors.length === 0) {
    return cached
      ? dispositionFromEvidence(cached, localManifest)
      : {
          kind: "unresolved",
          code: "ATTACHMENT_DESCRIPTOR_MISSING",
          evidence: null,
        };
  }
  if (urlDescriptors.length !== descriptors.length) {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_MISSING",
      evidence: null,
    };
  }
  if (urlDescriptors.length !== expectedFileIds.length) {
    return {
      kind: "mismatch",
      code: "ATTACHMENT_COUNT_MISMATCH",
      evidence: null,
    };
  }
  if (urlDescriptors.length > MAX_ATTACHMENT_COUNT) {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_DOWNLOAD_LIMIT",
      evidence: null,
    };
  }

  let descriptorSha256: string[];
  try {
    descriptorSha256 = sortedUnique(
      urlDescriptors.map(({ url }) =>
        sha256(generalChatProviderAttachmentDescriptor(url)),
      ),
    );
  } catch {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_UNSAFE",
      evidence: null,
    };
  }
  if (descriptorSha256.length !== urlDescriptors.length) {
    return {
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_CONFLICT",
      evidence: null,
    };
  }

  if (cached) {
    if (
      cached.descriptorSha256.length !== descriptorSha256.length ||
      !cached.descriptorSha256.every(
        (descriptor, index) => descriptor === descriptorSha256[index],
      )
    ) {
      return {
        kind: "unresolved",
        code: "ATTACHMENT_DESCRIPTOR_CONFLICT",
        evidence: cached,
      };
    }
    return dispositionFromEvidence(cached, localManifest);
  }

  const now = input.now ?? Date.now;
  const observedNow = now();
  const cacheKey = evidenceCacheKey(descriptorSha256);
  const processCached = readSuccessfulCache(cacheKey, observedNow);
  if (processCached)
    return dispositionFromEvidence(processCached, localManifest);

  const timeoutMs = input.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const startedAt = now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const contentManifest: GeneralChatProviderAttachmentContentItem[] = [];
  let totalBytes = 0;
  try {
    for (const descriptor of urlDescriptors) {
      const remaining = timeoutMs - (now() - startedAt);
      if (remaining <= 0 || abortController.signal.aborted) {
        return {
          kind: "unresolved",
          code: "ATTACHMENT_DOWNLOAD_TIMEOUT",
          evidence: null,
        };
      }
      let response: Awaited<ReturnType<GeneralChatProviderAttachmentReader>>;
      try {
        response = await (input.readUrl ?? defaultAttachmentReader)({
          url: descriptor.url,
          signal: abortController.signal,
          maxBytes: MAX_ATTACHMENT_BYTES,
          timeoutMs: remaining,
        });
      } catch (error) {
        const timeoutFailure =
          abortController.signal.aborted ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            ["ABORT_ERR", "ECONNABORTED", "ETIMEDOUT"].includes(
              String((error as { code?: unknown }).code),
            ));
        return {
          kind: "unresolved",
          code: timeoutFailure
            ? "ATTACHMENT_DOWNLOAD_TIMEOUT"
            : "ATTACHMENT_DOWNLOAD_FAILED",
          evidence: null,
        };
      }
      if (
        response.contentLength !== undefined &&
        response.contentLength !== null &&
        (!validSize(response.contentLength) ||
          response.contentLength > MAX_ATTACHMENT_BYTES ||
          totalBytes + response.contentLength > MAX_TOTAL_ATTACHMENT_BYTES)
      ) {
        return {
          kind: "unresolved",
          code: "ATTACHMENT_DOWNLOAD_LIMIT",
          evidence: null,
        };
      }
      const digest = createHash("sha256");
      let fileBytes = 0;
      try {
        for await (const chunk of response.body) {
          if (abortController.signal.aborted) {
            return {
              kind: "unresolved",
              code: "ATTACHMENT_DOWNLOAD_TIMEOUT",
              evidence: null,
            };
          }
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          fileBytes += bytes.byteLength;
          totalBytes += bytes.byteLength;
          if (
            fileBytes > MAX_ATTACHMENT_BYTES ||
            totalBytes > MAX_TOTAL_ATTACHMENT_BYTES
          ) {
            return {
              kind: "unresolved",
              code: "ATTACHMENT_DOWNLOAD_LIMIT",
              evidence: null,
            };
          }
          digest.update(bytes);
        }
      } catch (error) {
        void classifyGeneralChatAttachmentStreamError(error);
        return {
          kind: "unresolved",
          code: abortController.signal.aborted
            ? "ATTACHMENT_DOWNLOAD_TIMEOUT"
            : "ATTACHMENT_DOWNLOAD_FAILED",
          evidence: null,
        };
      }
      contentManifest.push({
        sha256: digest.digest("hex"),
        sizeBytes: fileBytes,
        filename: descriptor.filename,
        mimeType:
          descriptor.mimeType ??
          safeOptionalString(response.contentType, 255)?.toLowerCase() ??
          null,
      });
    }
  } finally {
    clearTimeout(timeout);
  }

  const evidence: GeneralChatProviderAttachmentEvidence = {
    schemaVersion: GENERAL_CHAT_PROVIDER_EVIDENCE_SCHEMA_VERSION,
    descriptorSha256,
    contentManifest: canonicalContentManifest(contentManifest),
  };
  writeSuccessfulCache(cacheKey, evidence, now());
  return dispositionFromEvidence(evidence, localManifest);
}
