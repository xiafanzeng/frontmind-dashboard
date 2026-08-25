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
  designV3: "frontmind-site-design-wire-v3.json",
  content: "frontmind-page-content-wire-v2.json",
  contentV3: "frontmind-page-content-wire-v3.json",
});

const SITEOPS_WIRE_OUTPUT_MAX_BYTES = Object.freeze({
  design: 256 * 1024,
  content: 2 * 1024 * 1024,
});

export type SiteOpsWireOutputPhase = "design" | "content";

type JsonObject = Record<string, unknown>;

type FetchPinnedPublicHttps = typeof fetchPinnedPublicHttps;

export class SiteOpsWireOutputResolutionError extends Error {
  constructor(
    readonly code:
      | "SITEOPS_WIRE_OUTPUT_INVALID"
      | "SITEOPS_WIRE_OUTPUT_CONFLICT"
      | "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    readonly validationError?: unknown,
    readonly validationCandidate?: Pick<
      SiteOpsWireOutputResolution,
      "sha256" | "source"
    >,
  ) {
    super(code);
  }
}

export type SiteOpsWireOutputResolution = {
  value: JsonObject;
  sha256: string;
  byteCount: number;
  source: "structured" | "attachment" | "assistant_json";
  sources: Array<"structured" | "attachment" | "assistant_json">;
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
  const semanticCandidate = { ...parsed };
  delete semanticCandidate.operationToken;
  return {
    value: parsed,
    // The operation token is a causal boundary, not model content. Excluding
    // it keeps the validation coordinate stable across repair attempts so an
    // otherwise identical invalid payload cannot consume the next budget.
    sha256: createHash("sha256")
      .update(canonicalJsonValue(semanticCandidate), "utf8")
      .digest("hex"),
    byteCount: Buffer.byteLength(canonical, "utf8"),
  };
}

function assertOneCandidate(
  values: ReadonlyArray<SiteOpsWireOutputResolution>,
) {
  if (values.length === 0) return null;
  if (new Set(values.map((value) => value.sha256)).size !== 1) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_CONFLICT");
  }
  const sourceOrder = ["structured", "assistant_json", "attachment"] as const;
  const sources = sourceOrder.filter((source) =>
    values.some((value) => value.source === source),
  );
  const selected = values.find((value) => value.source === sources[0])!;
  return { ...selected, sources };
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
  if (isRecord(message.content)) return message.content;
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
): { attachments: JsonAttachment[]; invalid: boolean } {
  const raw = [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(message.content) ? message.content : []),
  ];
  const attachments: JsonAttachment[] = [];
  let invalid = false;
  const expectedWireVersion = expectedFilename.match(
    /[-_]wire[-_]v([23])\.json$/u,
  )?.[1];
  if (!expectedWireVersion) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const phaseStem =
    phase === "design"
      ? `frontmind[-_]site[-_]design[-_]wire[-_]v${expectedWireVersion}`
      : `frontmind[-_]page[-_]content[-_]wire[-_]v${expectedWireVersion}`;
  const providerFilenamePattern = new RegExp(
    `^${phaseStem}(?:[-_]repair[-_][1-3])?\\.json$`,
    "u",
  );
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const url = optionalString(value, ["url", "file_url", "fileUrl"]);
    if (!url) continue;
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
    if (!filename) continue;
    if (
      filename !== filename.normalize("NFKC") ||
      filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/u.test(filename)
    ) {
      invalid = true;
      continue;
    }
    if (
      filename !== expectedFilename &&
      !providerFilenamePattern.test(filename)
    )
      continue;
    const mime = declaredMime?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    if (mime !== null && mime !== "application/json") {
      invalid = true;
      continue;
    }
    const declaredHash = optionalString(value, [
      "sha256",
      "content_sha256",
      "contentSha256",
    ]);
    if (declaredHash !== null && !SHA256_PATTERN.test(declaredHash)) {
      invalid = true;
      continue;
    }
    attachments.push({ url, expectedSha256: declaredHash });
  }
  return { attachments, invalid };
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
      throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
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
 * Every valid source in the exact operation-token window participates in one
 * canonical decision. Identical candidates merge; distinct valid candidates
 * fail closed. A malformed or unavailable source cannot hide a valid sibling.
 */
export async function resolveSiteOpsWireOutput(input: {
  events: readonly ManusV2MessageEvent[];
  operationToken: string;
  phase: SiteOpsWireOutputPhase;
  expectedFilename: string;
  taskCompleted: boolean;
  signal?: AbortSignal;
  fetchPinned?: FetchPinnedPublicHttps;
  validateCandidate?: (
    value: JsonObject,
    source: SiteOpsWireOutputResolution["source"],
  ) => void;
}): Promise<SiteOpsWireOutputResolution | null> {
  const allowedFilenames: readonly string[] =
    input.phase === "design"
      ? [SITEOPS_WIRE_OUTPUT_FILES.design, SITEOPS_WIRE_OUTPUT_FILES.designV3]
      : [
          SITEOPS_WIRE_OUTPUT_FILES.content,
          SITEOPS_WIRE_OUTPUT_FILES.contentV3,
        ];
  const maxBytes = SITEOPS_WIRE_OUTPUT_MAX_BYTES[input.phase];
  if (!allowedFilenames.includes(input.expectedFilename)) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const expectedFilename = input.expectedFilename;
  // A structured result is phase output only after the task has stopped for
  // that phase. Accepting it while running can send the next message into the
  // same task before the current response is complete.
  if (!input.taskCompleted) return null;
  const window = currentOperationWindow(input.events, input.operationToken);
  if (!window) return null;
  const candidates: SiteOpsWireOutputResolution[] = [];
  let sawInvalid = false;
  let sawUnavailable = false;
  let validationError: unknown;
  let validationCandidate:
    | Pick<SiteOpsWireOutputResolution, "sha256" | "source">
    | undefined;
  const addCandidate = (
    value: unknown,
    source: SiteOpsWireOutputResolution["source"],
  ) => {
    let parsed: ReturnType<typeof candidate> = null;
    try {
      parsed = candidate(value, input.operationToken, maxBytes);
    } catch (error) {
      sawInvalid = true;
      validationError ??= error;
      return;
    }
    if (!parsed) {
      sawInvalid = true;
      return;
    }
    try {
      input.validateCandidate?.(parsed.value, source);
    } catch (error) {
      sawInvalid = true;
      validationError ??= error;
      validationCandidate ??= { sha256: parsed.sha256, source };
      return;
    }
    candidates.push({ ...parsed, source, sources: [source] });
  };
  for (const event of window) {
    if (event.type !== "structured_output_result") continue;
    const envelope = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (envelope.kind === "accepted") {
      addCandidate(envelope.value, "structured");
      continue;
    }
    const raw = isRecord(event.structured_output_result)
      ? event.structured_output_result
      : null;
    if (raw && Object.prototype.hasOwnProperty.call(raw, "value")) {
      addCandidate(raw.value, "structured");
    }
  }
  for (const event of window) {
    const message = assistantMessage(event);
    if (!message) continue;
    const body = assistantJsonBody(message);
    if (body) {
      addCandidate(body, "assistant_json");
    }
    const attachmentSet = jsonAttachments(
      message,
      input.phase,
      expectedFilename,
    );
    sawInvalid ||= attachmentSet.invalid;
    for (const attachment of attachmentSet.attachments) {
      try {
        const value = await downloadAttachment({
          attachment,
          maxBytes,
          signal: input.signal,
          fetchPinned: input.fetchPinned ?? fetchPinnedPublicHttps,
        });
        addCandidate(value, "attachment");
      } catch (error) {
        if (
          error instanceof SiteOpsWireOutputResolutionError &&
          error.code === "SITEOPS_WIRE_OUTPUT_UNAVAILABLE"
        ) {
          sawUnavailable = true;
        } else if (error instanceof SiteOpsWireOutputResolutionError) {
          sawInvalid = true;
        } else {
          throw error;
        }
      }
    }
  }
  const resolved = assertOneCandidate(candidates);
  if (resolved) return resolved;
  if (sawInvalid) {
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_INVALID",
      validationError,
      validationCandidate,
    );
  }
  if (sawUnavailable) {
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    );
  }
  return null;
}
