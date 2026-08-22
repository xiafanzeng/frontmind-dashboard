import { createHash } from "node:crypto";

import {
  classifyManusV2StructuredResultEnvelope,
  manusV2EventOperationToken,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "../manus-v2-client";
import { fetchPinnedPublicHttps } from "./remote-preview";

const WIRE_OUTPUT_TIMEOUT_MS = 15_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const SITEOPS_WIRE_OUTPUT_FILES = Object.freeze({
  design: "frontmind-site-design-wire-v2.json",
  content: "frontmind-page-content-wire-v2.json",
});

const SITEOPS_WIRE_OUTPUT_MAX_BYTES = Object.freeze({
  design: 256 * 1024,
  content: 2 * 1024 * 1024,
});

export type SiteOpsWireOutputPhase = keyof typeof SITEOPS_WIRE_OUTPUT_FILES;

type JsonObject = Record<string, unknown>;

type FetchPinnedPublicHttps = typeof fetchPinnedPublicHttps;

export class SiteOpsWireOutputResolutionError extends Error {
  constructor(
    readonly code:
      | "SITEOPS_WIRE_OUTPUT_INVALID"
      | "SITEOPS_WIRE_OUTPUT_CONFLICT"
      | "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
  ) {
    super(code);
  }
}

export type SiteOpsWireOutputResolution = {
  value: JsonObject;
  sha256: string;
  source: "structured" | "attachment" | "assistant_json";
};

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`)
    .join(",")}}`;
}

function candidate(value: unknown, operationToken: string, maxBytes: number) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed.operationToken !== operationToken)
    return null;
  const canonical = canonicalJsonValue(parsed);
  if (Buffer.byteLength(canonical, "utf8") > maxBytes) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  return {
    value: parsed,
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

function assertOneCandidate(
  values: ReadonlyArray<SiteOpsWireOutputResolution>,
) {
  if (values.length === 0) return null;
  if (new Set(values.map((value) => value.sha256)).size !== 1) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_CONFLICT");
  }
  return values[0]!;
}

function currentOperationWindow(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  const ordered = orderManusV2EventsByProviderRank(events, "oldest_first");
  let start = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) === operationToken) {
      start = index;
    }
  }
  if (start < 0) return null;
  let end = ordered.length;
  for (let index = start + 1; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) !== null) {
      end = index;
      break;
    }
  }
  return ordered.slice(start + 1, end);
}

function assistantMessage(event: ManusV2MessageEvent) {
  if (
    event.type !== "assistant_message" ||
    !isRecord(event.assistant_message)
  ) {
    return null;
  }
  return event.assistant_message;
}

function assistantJsonBody(message: JsonObject) {
  if (typeof message.content !== "string") return null;
  const text = message.content.trim();
  if (!text) return null;
  let jsonText = text;
  const fence = /^```json\s*\n([\s\S]*?)\n```$/iu.exec(text);
  if (fence) jsonText = fence[1]!.trim();
  else if (text.startsWith("```") || text.includes("```")) return null;
  try {
    const value = JSON.parse(jsonText);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function optionalString(record: JsonObject, aliases: readonly string[]) {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

type JsonAttachment = {
  url: string;
  expectedSha256: string | null;
};

function jsonAttachments(
  message: JsonObject,
  phase: SiteOpsWireOutputPhase,
  expectedFilename: string,
): JsonAttachment[] {
  const raw = [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(message.content) ? message.content : []),
  ];
  return raw.flatMap((value) => {
    if (!isRecord(value)) return [];
    const url = optionalString(value, ["url", "file_url", "fileUrl"]);
    if (!url) return [];
    const filename = optionalString(value, [
      "filename",
      "file_name",
      "fileName",
    ]);
    const declaredMime = optionalString(value, [
      "content_type",
      "mime_type",
      "mimeType",
    ]);
    // A signed URL alone is not a durable output identity. A phase-owned
    // filename is mandatory; `file_id` remains optional. Manus may
    // deterministically normalize hyphens to underscores and append a repair
    // ordinal, so accept that narrow provider form without accepting an
    // arbitrary JSON attachment. The operation token and local wire schema
    // remain the business authority.
    if (!filename) return [];
    if (
      filename !== filename.normalize("NFKC") ||
      filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/u.test(filename)
    ) {
      throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
    }
    const phaseStem =
      phase === "design"
        ? "frontmind[-_]site[-_]design[-_]wire[-_]v2"
        : "frontmind[-_]page[-_]content[-_]wire[-_]v2";
    const providerFilenamePattern = new RegExp(
      `^${phaseStem}(?:[-_]repair[-_][1-3])?\\.json$`,
      "u",
    );
    if (filename !== expectedFilename && !providerFilenamePattern.test(filename))
      return [];
    const mime = declaredMime?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    if (mime !== null && mime !== "application/json") {
      throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
    }
    const declaredHash = optionalString(value, [
      "sha256",
      "content_sha256",
      "contentSha256",
    ]);
    if (declaredHash !== null && !SHA256_PATTERN.test(declaredHash)) {
      throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
    }
    return [{ url, expectedSha256: declaredHash }];
  });
}

async function readBoundedJsonResponse(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const mime = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mime !== "application/json") {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const declaredHeader = response.headers.get("content-length");
  const declared =
    declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (
    Number.isFinite(declared) &&
    (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes)
  ) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        throw new SiteOpsWireOutputResolutionError(
          "SITEOPS_WIRE_OUTPUT_INVALID",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (bytes < 1) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const buffer = Buffer.concat(
    chunks.map((part) => Buffer.from(part)),
    bytes,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  if (!isRecord(value)) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  return {
    value,
    rawSha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

async function downloadAttachment(input: {
  attachment: JsonAttachment;
  maxBytes: number;
  signal?: AbortSignal;
  fetchPinned: FetchPinnedPublicHttps;
}) {
  const timeout = AbortSignal.timeout(WIRE_OUTPUT_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  let response: Response;
  try {
    ({ response } = await input.fetchPinned({
      url: input.attachment.url,
      signal,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "FrontMind-SiteOps-Wire/1.0",
      },
      maxRedirects: 3,
    }));
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const code = error instanceof Error ? error.message : "";
    if (
      /^(?:PREVIEW_URL_|PREVIEW_REDIRECT_|PREVIEW_CONNECTED_ADDRESS_UNSAFE)/u.test(
        code,
      )
    ) {
      throw new SiteOpsWireOutputResolutionError(
        "SITEOPS_WIRE_OUTPUT_INVALID",
      );
    }
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    );
  }
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    );
  }
  const downloaded = await readBoundedJsonResponse(response, input.maxBytes);
  if (
    input.attachment.expectedSha256 !== null &&
    downloaded.rawSha256 !== input.attachment.expectedSha256
  ) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  return downloaded.value;
}

/**
 * Resolve one task phase without weakening the internal Zod contract.
 * Structured-output success wins. Provider message/attachment recovery is
 * permitted only after completion and an explicit extraction rejection in
 * the exact operation-token window.
 */
export async function resolveSiteOpsWireOutput(input: {
  events: readonly ManusV2MessageEvent[];
  operationToken: string;
  phase: SiteOpsWireOutputPhase;
  expectedFilename: string;
  taskCompleted: boolean;
  signal?: AbortSignal;
  fetchPinned?: FetchPinnedPublicHttps;
}): Promise<SiteOpsWireOutputResolution | null> {
  const expectedFilename = SITEOPS_WIRE_OUTPUT_FILES[input.phase];
  const maxBytes = SITEOPS_WIRE_OUTPUT_MAX_BYTES[input.phase];
  if (input.expectedFilename !== expectedFilename) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  // A structured result is phase output only after the task has stopped for
  // that phase. Accepting it while running can send the next message into the
  // same task before the current response is complete.
  if (!input.taskCompleted) return null;
  const structured: SiteOpsWireOutputResolution[] = [];
  for (const event of input.events) {
    if (event.type !== "structured_output_result") continue;
    const envelope = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (envelope.kind !== "accepted") continue;
    const parsed = candidate(envelope.value, input.operationToken, maxBytes);
    if (parsed) structured.push({ ...parsed, source: "structured" });
  }
  const accepted = assertOneCandidate(structured);
  if (accepted) return accepted;

  // Never inspect assistant prose or output URLs while an upstream task is
  // still active. This prevents partial files from becoming durable input.
  const window = currentOperationWindow(input.events, input.operationToken);
  if (!window) return null;
  const explicitlyRejected = window.some((event) => {
    if (event.type !== "structured_output_result") return false;
    return (
      classifyManusV2StructuredResultEnvelope(event.structured_output_result)
        .kind === "rejected"
    );
  });
  if (!explicitlyRejected) return null;

  const fallback: SiteOpsWireOutputResolution[] = [];
  for (const event of window) {
    const message = assistantMessage(event);
    if (!message) continue;
    const body = assistantJsonBody(message);
    if (body) {
      const parsed = candidate(body, input.operationToken, maxBytes);
      if (!parsed) {
        throw new SiteOpsWireOutputResolutionError(
          "SITEOPS_WIRE_OUTPUT_INVALID",
        );
      }
      fallback.push({ ...parsed, source: "assistant_json" });
    }
    for (const attachment of jsonAttachments(
      message,
      input.phase,
      expectedFilename,
    )) {
      const value = await downloadAttachment({
        attachment,
        maxBytes,
        signal: input.signal,
        fetchPinned: input.fetchPinned ?? fetchPinnedPublicHttps,
      });
      const parsed = candidate(value, input.operationToken, maxBytes);
      if (!parsed) {
        throw new SiteOpsWireOutputResolutionError(
          "SITEOPS_WIRE_OUTPUT_INVALID",
        );
      }
      fallback.push({ ...parsed, source: "attachment" });
    }
  }
  return assertOneCandidate(fallback);
}
