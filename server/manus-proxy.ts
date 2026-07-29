/**
 * FrontMind API Proxy
 * Proxies requests from /api/manus/* to the configured FrontMind API base URL.
 * This avoids CORS issues when calling the FrontMind API from the browser.
 *
 * Also provides:
 * - /proxy-upload: forwards file uploads to S3 presigned URLs
 * - /proxy-download: proxies binary download from any external URL (S3 etc.)
 * - /v1/files/:fileId: resolves file metadata then downloads binary from S3
 * - /v1/files/:fileId/content: same as above (compat alias)
 *
 * SANITIZATION:
 * - All text-based file downloads (md, txt, html, json, csv, etc.) are sanitized
 *   to replace "Manus" with "FrontMind" before being sent to the client.
 * - All PDF file downloads are sanitized by:
 *   a) Blanking out CID-encoded "Manus" glyphs in content streams
 *   b) Overlaying "FrontMind" text using a standard embedded font
 *   c) Tracking the full CTM (current transformation matrix) stack for correct positioning
 * - All JSON API responses are deep-sanitized to replace "Manus" with "FrontMind".
 *
 * The proxy reads the API key and base URL from request headers or falls back to defaults.
 */
import { Router, Request, Response } from "express";
import axios from "axios";
import zlib from "zlib";
import { randomUUID } from "crypto";
import fs from "node:fs/promises";
import {
  getFrontMindCredentials,
  translateTaskBodyForUpstream,
} from "./upstream-config";
import {
  getEffectiveDecryptedCredentialForAccount,
  recordUpstreamResource,
} from "./auth-service";
import { getAccountMonthlyCreditUsage } from "./dashboard-service";
import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import {
  redactSensitivePayload,
  redactSensitiveText,
  safeErrorForLog,
} from "./_core/sensitive-data";
import { preparedFileService } from "./prepared-file-service";

const router = Router();

// In-memory cache for file metadata (fileId -> { upload_url, filename })
// TTL: 10 minutes
const fileMetaCache = new Map<
  string,
  { upload_url: string; filename: string; cachedAt: number }
>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Short-lived direct download token cache. This lets the browser download via a
// normal same-origin URL, avoiding slow fetch->Blob->ObjectURL downloads and
// reducing browser "unsafe download" prompts caused by blob/data URLs.
const downloadTokenCache = new Map<
  string,
  {
    fileId: string;
    userId: number;
    credentialId: string;
    apiKey: string;
    baseUrl: string;
    createdAt: number;
  }
>();
const DOWNLOAD_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes
export const MAX_EXTERNAL_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export class ExternalDownloadTooLargeError extends Error {
  readonly code = "EXTERNAL_DOWNLOAD_TOO_LARGE";

  constructor(readonly maxBytes = MAX_EXTERNAL_DOWNLOAD_BYTES) {
    super("External download exceeds the permitted size");
    this.name = "ExternalDownloadTooLargeError";
  }
}

export function isPrivateUpstreamCollectionRequest(
  method: string,
  targetPath: string,
) {
  if (!["GET", "HEAD"].includes(method.toUpperCase())) return false;
  const pathname = targetPath.split("?")[0]?.replace(/\/+$/, "") || "/";
  return ["/v1/tasks", "/v1/responses", "/v1/files"].includes(pathname);
}

function safeUrlForLog(value: string) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 160);
  } catch {
    return "[invalid URL]";
  }
}

function cleanupExpiredDownloadTokens() {
  const now = Date.now();
  downloadTokenCache.forEach((data, token) => {
    if (now - data.createdAt > DOWNLOAD_TOKEN_TTL) {
      downloadTokenCache.delete(token);
    }
  });
}

function getCachedMeta(
  fileId: string,
): { upload_url: string; filename: string } | null {
  const entry = fileMetaCache.get(fileId);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL) {
    return { upload_url: entry.upload_url, filename: entry.filename };
  }
  fileMetaCache.delete(fileId);
  return null;
}

function setCachedMeta(
  fileId: string,
  meta: { upload_url: string; filename: string },
) {
  fileMetaCache.set(fileId, { ...meta, cachedAt: Date.now() });
}

/**
 * Infer MIME type from filename extension.
 */
function inferMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    pdf: "application/pdf",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    xml: "application/xml",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    js: "application/javascript",
    ts: "text/typescript",
    jsx: "text/jsx",
    tsx: "text/tsx",
    css: "text/css",
    py: "text/x-python",
    java: "text/x-java",
    c: "text/x-c",
    cpp: "text/x-c++",
    h: "text/x-c",
    // Images
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    // Archives
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
    // Documents
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Audio/Video
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return mimeMap[ext] || "application/octet-stream";
}

// ============================================================
// Manus -> FrontMind text sanitization
// ============================================================

/**
 * Check if a file is text-based and should be sanitized.
 * We sanitize: md, txt, html, htm, json, xml, csv, js, ts, jsx, tsx, css, py, java, c, cpp, h, svg
 */
function isTextBasedFile(filename: string, contentType?: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const textExtensions = [
    "md",
    "markdown",
    "txt",
    "html",
    "htm",
    "json",
    "xml",
    "csv",
    "js",
    "ts",
    "jsx",
    "tsx",
    "css",
    "py",
    "java",
    "c",
    "cpp",
    "h",
    "svg",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "log",
    "sh",
    "bash",
    "zsh",
    "bat",
    "ps1",
    "rb",
    "php",
    "go",
    "rs",
    "swift",
    "kt",
    "scala",
    "r",
    "sql",
    "graphql",
    "proto",
  ];
  if (textExtensions.includes(ext)) return true;

  // Also check content-type header
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (
      ct.startsWith("text/") ||
      ct.includes("json") ||
      ct.includes("xml") ||
      ct.includes("javascript") ||
      ct.includes("markdown") ||
      ct.includes("svg")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a file is a PDF by extension or content-type.
 */
function isPdfFile(filename: string, contentType?: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return true;
  if (contentType && contentType.toLowerCase().includes("application/pdf"))
    return true;
  return false;
}

/**
 * Check if a buffer starts with the PDF magic bytes (%PDF-).
 * This is a fallback for when the filename/content-type don't indicate PDF
 * (e.g., CDN returns application/octet-stream or the URL has no .pdf extension).
 */
function isPdfMagicBytes(data: Buffer): boolean {
  return data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-";
}

function getSourceBrandLower() {
  return ["ma", "nus"].join("");
}

function getSourceBrandTitle() {
  const lower = getSourceBrandLower();
  return lower[0].toUpperCase() + lower.slice(1);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitize text content by replacing FrontMind-related strings with FrontMind equivalents.
 * Same logic as the client-side sanitizeBrandText but applied server-side.
 */
function sanitizeText(text: string): string {
  if (!text || typeof text !== "string") return text || "";

  try {
    const sourceLower = getSourceBrandLower();
    const sourceTitle = getSourceBrandTitle();
    const sourceUpper = sourceLower.toUpperCase();
    return text
      .replace(
        new RegExp(`https?:\\/\\/api\\.${sourceLower}\\.`, "gi"),
        "https://api.frontmind.",
      )
      .replace(
        new RegExp(`https?:\\/\\/www\\.${sourceLower}\\.`, "gi"),
        "https://www.frontmind.",
      )
      .replace(
        new RegExp(`https?:\\/\\/${sourceLower}\\.`, "gi"),
        "https://frontmind.",
      )
      .replace(
        new RegExp(`\\b${escapeRegExp(sourceUpper)}\\b`, "g"),
        "FrontMind",
      )
      .replace(
        new RegExp(`\\b${escapeRegExp(sourceTitle)}\\b`, "g"),
        "FrontMind",
      )
      .replace(
        new RegExp(`\\b${escapeRegExp(sourceLower)}\\b`, "g"),
        "frontmind",
      );
  } catch (e) {
    console.error("[sanitizeText] Error:", e);
    return text;
  }
}

function sanitizeFilename(
  filename: string | undefined,
  fallback = "file",
): string {
  const sanitized = sanitizeText(filename || fallback)
    .replace(/[\\/\0]/g, "_")
    .trim();
  return sanitized || fallback;
}

function setSafeContentDisposition(
  res: Response,
  disposition: "inline" | "attachment",
  filename: string,
) {
  const safeFileName = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safeFileName);
  res.setHeader(
    "content-disposition",
    `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`,
  );
}

function hasUsableExtension(filename: string): boolean {
  const last = filename.split(/[\/]/).pop() || filename;
  return /\.[A-Za-z0-9]{1,10}$/.test(last);
}

function ensureFilenameMatchesContent(
  filename: string,
  data: Buffer,
  contentType?: string,
): string {
  const safe = sanitizeFilename(filename);
  const lower = safe.toLowerCase();

  if (
    (isPdfMagicBytes(data) || isPdfFile(safe, contentType)) &&
    !lower.endsWith(".pdf")
  ) {
    return hasUsableExtension(safe)
      ? safe.replace(/\.[^.\/]+$/, ".pdf")
      : `${safe}.pdf`;
  }

  return safe;
}

function normalizeContentTypeForBuffer(
  filename: string,
  data: Buffer,
  contentType?: string,
): string {
  const ct =
    typeof contentType === "string"
      ? contentType.split(";")[0].trim().toLowerCase()
      : "";

  if (isPdfMagicBytes(data) || isPdfFile(filename, contentType)) {
    return "application/pdf";
  }

  if (
    !ct ||
    ct === "application/octet-stream" ||
    ct === "binary/octet-stream"
  ) {
    return inferMimeType(filename);
  }

  return contentType || inferMimeType(filename);
}

function responseHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const normalized = value
      .filter((item): item is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof item),
      )
      .map(String);
    return normalized.length ? normalized.join(", ") : undefined;
  }
  return undefined;
}

function declaredContentLength(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const raw = responseHeaderValue(
    (headers as Record<string, unknown>)["content-length"],
  );
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function destroyDownloadStream(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { destroy?: unknown }).destroy === "function"
  ) {
    (value as { destroy: () => void }).destroy();
  }
}

/**
 * Buffer a response only after enforcing its declared size, then enforce the
 * same cap while consuming every chunk. The streaming check is authoritative
 * for chunked responses and for servers that under-report Content-Length.
 */
export async function readBoundedExternalDownload(
  data: unknown,
  headers: unknown,
  maxBytes = MAX_EXTERNAL_DOWNLOAD_BYTES,
): Promise<Buffer> {
  const declared = declaredContentLength(headers);
  if (declared !== undefined && declared > maxBytes) {
    destroyDownloadStream(data);
    throw new ExternalDownloadTooLargeError(maxBytes);
  }

  if (
    data &&
    typeof data === "object" &&
    Symbol.asyncIterator in data &&
    typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  ) {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      for await (const chunk of data as AsyncIterable<unknown>) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk));
        totalBytes += buffer.length;
        if (totalBytes > maxBytes) {
          throw new ExternalDownloadTooLargeError(maxBytes);
        }
        chunks.push(buffer);
      }
    } catch (error) {
      destroyDownloadStream(data);
      throw error;
    }
    return Buffer.concat(chunks, totalBytes);
  }

  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(String(data ?? ""));
  if (buffer.length > maxBytes) {
    throw new ExternalDownloadTooLargeError(maxBytes);
  }
  return buffer;
}

function isExternalDownloadTooLarge(error: unknown): boolean {
  if (error instanceof ExternalDownloadTooLargeError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "ERR_BAD_RESPONSE" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("maxContentLength")
  );
}

function sendExternalDownloadTooLarge(res: Response) {
  return res.status(413).json({
    error: {
      message: "文件超过允许的下载大小",
      code: "EXTERNAL_DOWNLOAD_TOO_LARGE",
    },
  });
}

async function fetchBoundedExternalDownload(
  url: string,
  options: Record<string, unknown>,
) {
  const response = await axios.get(url, {
    ...options,
    responseType: "stream",
    maxContentLength: MAX_EXTERNAL_DOWNLOAD_BYTES,
  });
  const data = await readBoundedExternalDownload(
    response.data,
    response.headers,
  );
  return { ...response, data };
}

/**
 * Keys whose string values should not be brand-renamed because they contain
 * identifiers, URLs, or encoded data that would break if modified. Security
 * redaction runs before this transform and never uses this allowlist.
 */
const SANITIZE_SKIP_KEYS = new Set([
  "id",
  "task_id",
  "file_id",
  "call_id",
  "response_id",
  "object",
  "upload_url",
  "upload_expires_at",
  "created_at",
  "updated_at",
  "url",
  "file_url",
  "fileUrl",
  "image_url",
  "imageUrl",
  "src",
  "href",
  "download_url",
  "base64",
  "data",
  "hash",
  "checksum",
  "etag",
  "previous_response_id",
  "previousResponseId",
  "task_url",
  "share_url",
]);

/**
 * Deep-sanitize a JSON value by recursively replacing source-brand references in all string fields.
 * This ensures that all API response text (task titles, output messages, file names, etc.)
 * has Manus replaced with FrontMind before reaching the client.
 *
 * IMPORTANT: Skips brand replacement for identifier/URL fields. Authentication
 * material is removed by publicUpstreamPayload before this function runs.
 */
function deepSanitizeJson(
  value: unknown,
  currentKey?: string,
  depth: number = 0,
): unknown {
  if (value === null || value === undefined) return value;

  // Prevent infinite recursion on deeply nested objects
  if (depth > 50) return value;

  if (typeof value === "string") {
    // Skip brand replacement for identifier and URL fields.
    if (currentKey && SANITIZE_SKIP_KEYS.has(currentKey)) {
      return value;
    }
    // Skip sanitization for strings that look like IDs (e.g., "task_xxx", "file-xxx", UUIDs)
    if (value.match(/^[a-zA-Z0-9_-]{8,}$/) && !value.includes(" ")) {
      return value;
    }
    // Skip very long strings (likely base64 or encoded data)
    if (value.length > 100_000) {
      return value;
    }
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepSanitizeJson(item, undefined, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = deepSanitizeJson(val, key, depth + 1);
    }
    return result;
  }

  // numbers, booleans, etc. - pass through
  return value;
}

export function publicUpstreamPayload(value: unknown, apiKey: string) {
  return deepSanitizeJson(
    redactSensitivePayload(value, {
      secrets: [apiKey],
    }),
  );
}

const PUBLIC_TASK_TOP_LEVEL_SCALAR_KEYS = [
  "id",
  "task_id",
  "response_id",
  "object",
  "status",
  "model",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "credit_usage",
  "task_url",
  "share_url",
  "task_title",
  "title",
] as const;

const PUBLIC_TASK_OUTPUT_SCALAR_KEYS = [
  "id",
  "type",
  "status",
  "name",
  "call_id",
  "text",
  "message",
  "output",
  "file_id",
  "fileId",
  "url",
  "file_url",
  "fileUrl",
  "image_url",
  "imageUrl",
  "filename",
  "fileName",
  "mime_type",
  "mimeType",
] as const;

const PUBLIC_TASK_CONTENT_SCALAR_KEYS = [
  "type",
  "text",
  "file_id",
  "fileId",
  "file_url",
  "fileUrl",
  "image_url",
  "imageUrl",
  "url",
  "filename",
  "fileName",
  "mime_type",
  "mimeType",
] as const;

const PUBLIC_TASK_METADATA_SCALAR_KEYS = [
  "credit_usage",
  "task_url",
  "share_url",
  "task_title",
  "title",
] as const;

const PUBLIC_TASK_ERROR_SCALAR_KEYS = [
  "message",
  "code",
  "type",
  "param",
  "status",
] as const;

const PUBLIC_TASK_ANNOTATION_SCALAR_KEYS = [
  "type",
  "url",
  "title",
  "start_index",
  "end_index",
  "file_id",
  "fileId",
  "filename",
  "fileName",
  "index",
  "quote",
] as const;

const PUBLIC_TASK_ACTION_SCALAR_KEYS = [
  "type",
  "url",
  "query",
  "selector",
  "x",
  "y",
] as const;

const PUBLIC_TASK_TELEMETRY_KEY =
  /^(?:(?:input|output)_(?:tokens?|credits?|cost|characters|count)(?:_|$)|(?:id|name|label|kind|version|status|stage|step|phase|progress|percent|percentage|current|total|completed|failed|success|successful|count|usage|credit|credits|token|tokens|cost|duration|elapsed|remaining|message|summary|visited|links|pages|characters|images|documents|queries|saved|downloaded|parsed|started|finished|created|updated)(?:_|$))/i;

function isPublicScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function pickPublicScalars(
  value: unknown,
  keys: readonly string[],
): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    if (isPublicScalar(source[key])) {
      result[key] = source[key];
    }
  }
  return result;
}

function publicTaskTelemetry(value: unknown, depth = 0): unknown {
  if (value === null || depth > 8) return undefined;
  if (isPublicScalar(value)) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => publicTaskTelemetry(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!PUBLIC_TASK_TELEMETRY_KEY.test(key)) continue;
    const sanitized = publicTaskTelemetry(item, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function publicTaskAnnotations(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const annotations = value
    .map((item) => pickPublicScalars(item, PUBLIC_TASK_ANNOTATION_SCALAR_KEYS))
    .filter((item) => Object.keys(item).length > 0);
  return annotations.length > 0 ? annotations : undefined;
}

function publicTaskContent(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const content: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const type =
      typeof source.type === "string" ? source.type.toLowerCase() : "";
    if (type.startsWith("input_") || type.includes("instruction")) continue;

    const sanitized: Record<string, unknown> = pickPublicScalars(
      source,
      PUBLIC_TASK_CONTENT_SCALAR_KEYS,
    );
    const annotations = publicTaskAnnotations(source.annotations);
    if (annotations) sanitized.annotations = annotations;
    if (Object.keys(sanitized).length > 0) content.push(sanitized);
  }
  return content;
}

function publicTaskOutput(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const output: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const role =
      typeof source.role === "string" ? source.role.toLowerCase() : "";
    const type =
      typeof source.type === "string" ? source.type.toLowerCase() : "";
    if (
      role === "user" ||
      role === "system" ||
      type.startsWith("input_") ||
      type.includes("instruction")
    ) {
      continue;
    }

    const sanitized: Record<string, unknown> = pickPublicScalars(
      source,
      PUBLIC_TASK_OUTPUT_SCALAR_KEYS,
    );
    if (role === "assistant") sanitized.role = "assistant";

    const content = publicTaskContent(source.content);
    if (content.length > 0) sanitized.content = content;

    if (Array.isArray(source.summary)) {
      const summary = source.summary
        .map((entry) => pickPublicScalars(entry, ["type", "text"]))
        .filter((entry) => Object.keys(entry).length > 0);
      if (summary.length > 0) sanitized.summary = summary;
    }
    if (Array.isArray(source.queries)) {
      const queries = source.queries.filter(
        (query): query is string => typeof query === "string",
      );
      if (queries.length > 0) sanitized.queries = queries;
    }
    const action = pickPublicScalars(
      source.action,
      PUBLIC_TASK_ACTION_SCALAR_KEYS,
    );
    if (Object.keys(action).length > 0) sanitized.action = action;

    if (Object.keys(sanitized).length > 0) output.push(sanitized);
  }
  return output;
}

function redactPublicTaskValues(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, [apiKey]);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicTaskValues(item, apiKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactPublicTaskValues(item, apiKey),
      ]),
    );
  }
  return value;
}

/**
 * Build the only task/response shape that is allowed to cross the generic
 * browser proxy. Upstream task objects may echo the complete request,
 * including server-injected Skills and knowledge-base context. A denylist is
 * not sufficient for that boundary, so request-shaped fields are discarded
 * by construction and only client-consumed result/status fields survive.
 */
export function publicUpstreamTaskPayload(value: unknown, apiKey: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = pickPublicScalars(
    source,
    PUBLIC_TASK_TOP_LEVEL_SCALAR_KEYS,
  );

  const metadata = pickPublicScalars(
    source.metadata,
    PUBLIC_TASK_METADATA_SCALAR_KEYS,
  );
  if (Object.keys(metadata).length > 0) result.metadata = metadata;

  if (Array.isArray(source.output)) {
    result.output = publicTaskOutput(source.output);
  }

  const error = pickPublicScalars(source.error, PUBLIC_TASK_ERROR_SCALAR_KEYS);
  if (Object.keys(error).length > 0) result.error = error;

  const usage = publicTaskTelemetry(source.usage);
  if (
    usage !== undefined &&
    (typeof usage !== "object" || Object.keys(usage as object).length > 0)
  ) {
    result.usage = usage;
  }
  const progress = publicTaskTelemetry(source.progress);
  if (
    progress !== undefined &&
    (typeof progress !== "object" || Object.keys(progress as object).length > 0)
  ) {
    result.progress = progress;
  }

  return deepSanitizeJson(redactPublicTaskValues(result, apiKey));
}

export function isPublicTaskPayloadRequest(
  method: string,
  targetPath: string,
): boolean {
  const path = targetPath.split("?")[0].replace(/\/+$/, "");
  const normalizedMethod = method.toUpperCase();
  if (
    normalizedMethod === "POST" &&
    (path === "/v1/tasks" || path === "/v1/responses")
  ) {
    return true;
  }
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") return false;
  return /^\/v1\/(?:tasks|responses)\/[^/]+$/.test(path);
}

function collectOutputFileIds(
  value: unknown,
  ids = new Set<string>(),
  currentKey?: string,
  depth = 0,
) {
  if (value === null || value === undefined || depth > 50) return ids;
  if (typeof value === "string") {
    if ((currentKey === "file_id" || currentKey === "fileId") && value) {
      ids.add(value);
    }
    if (
      currentKey === "url" ||
      currentKey === "file_url" ||
      currentKey === "fileUrl" ||
      currentKey === "image_url" ||
      currentKey === "imageUrl"
    ) {
      const match = value.match(/\/v1\/files\/([^/?#]+)/);
      if (match?.[1]) {
        try {
          ids.add(decodeURIComponent(match[1]));
        } catch {
          // Ignore malformed upstream URLs; they will not be downloadable.
        }
      }
    }
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      collectOutputFileIds(item, ids, undefined, depth + 1);
    return ids;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      collectOutputFileIds(item, ids, key, depth + 1);
    }
  }
  return ids;
}

interface OutputPdfDescriptor {
  fileId?: string;
  url?: string;
  filename: string;
}

function collectOutputPdfDescriptors(
  value: unknown,
  descriptors: OutputPdfDescriptor[] = [],
  depth = 0,
) {
  if (!value || depth > 50) return descriptors;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOutputPdfDescriptors(item, descriptors, depth + 1);
    }
    return descriptors;
  }
  if (typeof value !== "object") return descriptors;

  const object = value as Record<string, unknown>;
  const filename = String(
    object.fileName ?? object.file_name ?? object.filename ?? object.name ?? "",
  );
  const mimeType = String(
    object.mimeType ?? object.mime_type ?? object.content_type ?? "",
  ).toLowerCase();
  const type = String(object.type ?? "");
  const looksLikePdf =
    filename.toLowerCase().endsWith(".pdf") ||
    mimeType.includes("application/pdf");
  const looksLikeOutputFile =
    type === "output_file" ||
    type === "file" ||
    "file_id" in object ||
    "fileId" in object;

  if (looksLikePdf && looksLikeOutputFile) {
    const fileId = String(object.file_id ?? object.fileId ?? "");
    const url = String(object.file_url ?? object.fileUrl ?? object.url ?? "");
    descriptors.push({
      fileId: fileId || undefined,
      url: url || undefined,
      filename: filename || "document.pdf",
    });
  }

  for (const child of Object.values(object)) {
    collectOutputPdfDescriptors(child, descriptors, depth + 1);
  }
  return descriptors;
}

/**
 * Process a downloaded text file buffer: sanitize source-brand references.
 * Returns { buffer, wasSanitized }.
 */
function sanitizeTextFileBuffer(
  data: Buffer,
  filename: string,
  contentType?: string,
): { buffer: Buffer; wasSanitized: boolean } {
  if (!isTextBasedFile(filename, contentType)) {
    return { buffer: data, wasSanitized: false };
  }

  try {
    const text = data.toString("utf-8");
    const sanitized = sanitizeText(text);
    if (sanitized !== text) {
      console.log(
        `[FrontMind Proxy] Sanitized source-brand references in text file: ${filename}`,
      );
      return { buffer: Buffer.from(sanitized, "utf-8"), wasSanitized: true };
    }
    return { buffer: data, wasSanitized: false };
  } catch (e) {
    // If we can't decode as UTF-8, skip sanitization
    return { buffer: data, wasSanitized: false };
  }
}

// ============================================================
// PDF Sanitization - CID font glyph-level replacement + overlay
// ============================================================

/**
 * Sanitize a PDF buffer by:
 * 1. Parsing ToUnicode CMap streams to build unicode->glyph mappings (bfchar + bfrange)
 * 2. Scanning content streams for per-character Tj operator sequences matching "Manus" patterns
 * 3. Replacing matching glyph IDs with space glyphs (blanks text for pdftotext extraction)
 * 4. Tracking the full CTM (current transformation matrix) stack for correct page coordinates
 * 5. Overlaying "FrontMind" text using a standard embedded font at the exact position
 *
 * This handles:
 * - CID font encoding where each character is a separate <glyphID> Tj operator
 * - Nested coordinate transforms (cm operators) common in web-generated PDFs
 * - Both bfchar and bfrange CMap sections
 */
async function sanitizePdfBuffer(
  pdfBuffer: Buffer,
): Promise<{ buffer: Buffer; wasSanitized: boolean }> {
  try {
    const {
      PDFDocument,
      PDFName,
      decodePDFRawStream,
      PDFRawStream,
      StandardFonts,
      rgb,
      PDFHexString,
    } = await import("pdf-lib");

    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
    });
    const context = pdfDoc.context;

    // ── Step 0: Sanitize document metadata shown by PDF viewers ────────
    let pdfMetadataModified = false;
    const setSanitizedPdfStringMetadata = (
      getter: () => string | undefined,
      setter: (value: string) => void,
    ) => {
      try {
        const current = getter();
        if (!current) return;
        const sanitized = sanitizeText(current);
        if (sanitized !== current) {
          setter(sanitized);
          pdfMetadataModified = true;
        }
      } catch {
        /* skip unsupported metadata fields */
      }
    };

    setSanitizedPdfStringMetadata(
      () => pdfDoc.getTitle(),
      (value) => pdfDoc.setTitle(value),
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getSubject(),
      (value) => pdfDoc.setSubject(value),
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getAuthor(),
      (value) => pdfDoc.setAuthor(value),
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getCreator(),
      (value) => pdfDoc.setCreator(value),
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getProducer(),
      (value) => pdfDoc.setProducer(value),
    );

    // pdf-lib getters can miss raw Info dictionary entries in PDFs assembled by
    // other tools. Sanitize the dictionary directly so PDF properties do not leak
    // the upstream brand even when no visible content changed.
    try {
      const infoRef = (context as any).trailerInfo?.Info;
      const infoDict = infoRef ? context.lookup(infoRef) : undefined;
      const metadataKeys = [
        "Title",
        "Subject",
        "Author",
        "Creator",
        "Producer",
        "Keywords",
      ];
      if (
        infoDict &&
        typeof (infoDict as any).lookup === "function" &&
        typeof (infoDict as any).set === "function"
      ) {
        for (const key of metadataKeys) {
          const pdfKey = PDFName.of(key);
          const currentValue = (infoDict as any).lookup(pdfKey);
          const currentText =
            currentValue && typeof currentValue.decodeText === "function"
              ? currentValue.decodeText()
              : currentValue && typeof currentValue.asString === "function"
                ? currentValue.asString()
                : undefined;
          if (!currentText) continue;

          const sanitized = sanitizeText(currentText);
          if (sanitized !== currentText) {
            (infoDict as any).set(pdfKey, PDFHexString.fromText(sanitized));
            pdfMetadataModified = true;
          }
        }
      }
    } catch {
      /* skip malformed Info dictionaries */
    }

    // ── Step 1: Parse all ToUnicode CMap streams ──────────────────────
    interface FontCMap {
      unicodeToGlyph: Map<string, string>;
      glyphToUnicode: Map<string, string>;
    }

    const allCMaps: FontCMap[] = [];

    context.enumerateIndirectObjects().forEach(([_ref, obj]: [any, any]) => {
      if (!obj || obj.constructor.name !== "PDFRawStream") return;

      try {
        const decoded = decodePDFRawStream(obj as any);
        const cmapText = Buffer.from(decoded.decode()).toString("latin1");

        if (
          !cmapText.includes("beginbfchar") &&
          !cmapText.includes("beginbfrange")
        )
          return;

        const unicodeToGlyph = new Map<string, string>();
        const glyphToUnicode = new Map<string, string>();

        // Parse bfchar mappings: <glyphId> <unicodeHex>
        const charMapRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let match;
        while ((match = charMapRegex.exec(cmapText)) !== null) {
          try {
            const glyphHex = match[1].toLowerCase().padStart(4, "0");
            const buf = Buffer.from(match[2], "hex");
            let unicodeChar = "";
            for (let i = 0; i < buf.length; i += 2) {
              if (i + 1 < buf.length) {
                unicodeChar += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
              }
            }
            if (unicodeChar) {
              unicodeToGlyph.set(unicodeChar, glyphHex);
              glyphToUnicode.set(glyphHex, unicodeChar);
            }
          } catch {
            /* skip invalid entries */
          }
        }

        // Parse bfrange mappings: <start> <end> <unicodeStart>
        const bfrangeRegex = /beginbfrange\s*([\s\S]*?)\s*endbfrange/g;
        let rangeMatch;
        while ((rangeMatch = bfrangeRegex.exec(cmapText)) !== null) {
          const rangeEntryRegex =
            /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
          let entry;
          while ((entry = rangeEntryRegex.exec(rangeMatch[1])) !== null) {
            const start = parseInt(entry[1], 16);
            const end = parseInt(entry[2], 16);
            const unicodeStart = parseInt(entry[3], 16);
            for (let offset = 0; offset <= end - start; offset++) {
              const unicodeChar = String.fromCharCode(unicodeStart + offset);
              const glyphHex = (start + offset).toString(16).padStart(4, "0");
              unicodeToGlyph.set(unicodeChar, glyphHex);
              glyphToUnicode.set(glyphHex, unicodeChar);
            }
          }
        }

        if (unicodeToGlyph.size > 0) {
          allCMaps.push({ unicodeToGlyph, glyphToUnicode });
        }
      } catch {
        /* skip streams that can't be decoded */
      }
    });

    // ── Step 2: Build glyph patterns for target strings ──────────────
    const sourceLower = getSourceBrandLower();
    const sourceTitle = getSourceBrandTitle();
    const sourceUpper = sourceLower.toUpperCase();
    const targetStrings = [
      `${sourceTitle} AI`,
      `${sourceUpper} AI`,
      `${sourceLower} AI`,
      sourceTitle,
      sourceUpper,
      sourceLower,
    ];
    const replaceSimpleBrandEncodings = (content: string) => {
      let sanitized = content;
      const replacements = [...new Set(targetStrings)].sort(
        (left, right) => right.length - left.length,
      );
      for (const sourceText of replacements) {
        const replacement = "FrontMind";
        sanitized = sanitized.replace(
          new RegExp(escapeRegExp(sourceText), "g"),
          replacement,
        );
        const sourceHex = Buffer.from(sourceText, "latin1").toString("hex");
        const replacementHex = Buffer.from(replacement, "latin1").toString(
          "hex",
        );
        sanitized = sanitized.replace(
          new RegExp(escapeRegExp(sourceHex), "gi"),
          replacementHex,
        );
      }
      return sanitized;
    };
    interface GlyphPattern {
      target: string;
      glyphs: string[];
      spaceGlyph: string;
      glyphToUnicode: Map<string, string>;
    }
    const glyphPatterns: GlyphPattern[] = [];

    for (const cmap of allCMaps) {
      for (const target of targetStrings) {
        const glyphs: string[] = [];
        let canBuild = true;
        for (const char of target) {
          const glyph = cmap.unicodeToGlyph.get(char);
          if (!glyph) {
            canBuild = false;
            break;
          }
          glyphs.push(glyph);
        }
        if (canBuild) {
          glyphPatterns.push({
            target,
            glyphs,
            spaceGlyph: cmap.unicodeToGlyph.get(" ") || "0001",
            glyphToUnicode: cmap.glyphToUnicode,
          });
        }
      }
    }

    // Sort by length descending (replace "Manus AI" before "Manus" to avoid partial matches)
    glyphPatterns.sort((a, b) => b.glyphs.length - a.glyphs.length);

    if (glyphPatterns.length === 0) {
      // Standard PDF fonts may not include a ToUnicode CMap. Decode their
      // compressed content streams and replace both literal and hex strings.
      let simpleStreamsModified = 0;
      context.enumerateIndirectObjects().forEach(([ref, obj]: [any, any]) => {
        if (!obj || obj.constructor.name !== "PDFRawStream") return;
        try {
          const decoded = decodePDFRawStream(obj as any);
          const streamText = Buffer.from(decoded.decode()).toString("latin1");
          if (!streamText.includes("Tj") && !streamText.includes("TJ")) return;
          const sanitized = replaceSimpleBrandEncodings(streamText);
          if (sanitized === streamText) return;
          const compressed = zlib.deflateSync(Buffer.from(sanitized, "latin1"));
          const dict = (obj as any).dict.clone(context);
          dict.set(PDFName.of("Length"), context.obj(compressed.length));
          dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
          context.assign(ref, PDFRawStream.of(dict, compressed));
          simpleStreamsModified += 1;
        } catch {
          // Skip malformed or unsupported streams; final text validation
          // prevents an unmodified source brand from being published.
        }
      });
      if (simpleStreamsModified > 0 || pdfMetadataModified) {
        const savedBytes = await pdfDoc.save();
        console.log(
          `[FrontMind Proxy] PDF simple streams sanitized: ${simpleStreamsModified}, metadata=${pdfMetadataModified}`,
        );
        return { buffer: Buffer.from(savedBytes), wasSanitized: true };
      }
      return { buffer: pdfBuffer, wasSanitized: false };
    }

    // ── Step 3: Scan content streams, track CTM stack, blank glyphs ──
    interface TjInfo {
      glyph: string;
      lineIndex: number;
      glyphHexInLine: string;
      absX: number;
      absY: number;
      fontSize: number;
      tm: number[] | null;
      ctm: { sx: number; sy: number; tx: number; ty: number };
    }

    interface OverlayPosition {
      target: string;
      replacementText: string;
      pageX: number;
      pageY: number;
      pageWidth: number;
      effectiveFontSize: number;
      pageIndex: number;
    }

    const overlayPositions: OverlayPosition[] = [];
    let totalModified = 0;

    const replacementTextForTarget = (_target: string) => "FrontMind";

    const estimateGlyphAdvance = (
      glyph: string,
      glyphToUnicode: Map<string, string>,
      fontSize: number,
    ): number => {
      const char = glyphToUnicode.get(glyph);
      if (!char) return fontSize * 0.6;
      if (char === " ") return fontSize * 0.32;

      const codePoint = char.codePointAt(0) || 0;
      if (
        codePoint > 0x2e80 ||
        codePoint === 0xff1a ||
        codePoint === 0xff08 ||
        codePoint === 0xff09
      ) {
        return fontSize;
      }

      if (/[ilI1.,:;|!]/.test(char)) return fontSize * 0.3;
      if (/[MW@#%]/.test(char)) return fontSize * 0.78;
      return fontSize * 0.56;
    };

    interface TjArrayHexToken {
      start: number;
      end: number;
      rawHex: string;
      chunks: string[];
      modified: boolean;
    }

    interface TjArrayGlyph {
      glyph: string;
      tokenIndex: number;
      chunkIndex: number;
    }

    interface TjArrayToken {
      kind: "hex" | "number";
      tokenIndex?: number;
      value?: number;
    }

    const splitGlyphHex = (rawHex: string): string[] => {
      if (!rawHex) return [];
      const normalized =
        rawHex.length % 4 === 0
          ? rawHex
          : rawHex.padStart(Math.ceil(rawHex.length / 4) * 4, "0");
      const chunks: string[] = [];
      for (let i = 0; i < normalized.length; i += 4) {
        chunks.push(normalized.slice(i, i + 4));
      }
      return chunks;
    };

    const calculateTjGlyphAdvance = (
      tokens: TjArrayToken[],
      hexTokens: TjArrayHexToken[],
      glyphIndexLimit: number,
      pattern: GlyphPattern,
      fontSize: number,
    ): number => {
      let glyphIndex = 0;
      let advance = 0;

      for (const token of tokens) {
        if (token.kind === "number") {
          advance += -((token.value || 0) / 1000) * fontSize;
          continue;
        }

        const hexToken = hexTokens[token.tokenIndex ?? -1];
        if (!hexToken) continue;

        for (const glyph of hexToken.chunks) {
          if (glyphIndex >= glyphIndexLimit) return advance;
          advance += estimateGlyphAdvance(
            glyph.toLowerCase().padStart(4, "0"),
            pattern.glyphToUnicode,
            fontSize,
          );
          glyphIndex++;
        }
      }

      return advance;
    };

    const rebuildTjArrayBody = (
      body: string,
      hexTokens: TjArrayHexToken[],
    ): string => {
      const modifiedTokens = hexTokens.filter((token) => token.modified);
      if (modifiedTokens.length === 0) return body;

      let rebuilt = "";
      let cursor = 0;
      for (const token of modifiedTokens.sort((a, b) => a.start - b.start)) {
        rebuilt += body.slice(cursor, token.start + 1);
        rebuilt += token.chunks.join("").toUpperCase();
        rebuilt += body.slice(token.start + 1 + token.rawHex.length, token.end);
        cursor = token.end;
      }
      rebuilt += body.slice(cursor);
      return rebuilt;
    };

    // Map stream refs to page indices
    const pages = pdfDoc.getPages();
    const streamRefToPageIndex = new Map<string, number>();
    const streamObjectToPageIndex = new WeakMap<object, number>();
    const registerPageContent = (content: any, pageIndex: number) => {
      if (!content) return;

      if (content.constructor?.name === "PDFRawStream") {
        streamObjectToPageIndex.set(content, pageIndex);
      }

      if (typeof content.toString === "function") {
        streamRefToPageIndex.set(content.toString(), pageIndex);
      }

      if (content.objectNumber !== undefined) {
        streamRefToPageIndex.set(
          `${content.objectNumber} ${content.generationNumber} R`,
          pageIndex,
        );
      }

      if (
        typeof content.size === "function" &&
        typeof content.get === "function"
      ) {
        for (let i = 0; i < content.size(); i++) {
          registerPageContent(content.get(i), pageIndex);
        }
      }
    };

    for (let pi = 0; pi < pages.length; pi++) {
      try {
        const contentsRef = (pages[pi] as any).node.Contents();
        registerPageContent(contentsRef, pi);
      } catch {
        /* skip */
      }
    }

    context.enumerateIndirectObjects().forEach(([ref, obj]: [any, any]) => {
      if (!obj || obj.constructor.name !== "PDFRawStream") return;

      try {
        const decoded = decodePDFRawStream(obj as any);
        const bytes = decoded.decode();
        const streamText = Buffer.from(bytes).toString("latin1");

        // Only process content streams (those with Tj/TJ operators)
        if (!streamText.includes("Tj") && !streamText.includes("TJ")) return;

        const simpleSanitizedStream = replaceSimpleBrandEncodings(streamText);
        const lines = simpleSanitizedStream.split("\n");

        // Track CTM (current transformation matrix) stack
        const ctmStack: { sx: number; sy: number; tx: number; ty: number }[] = [
          { sx: 1, sy: 1, tx: 0, ty: 0 },
        ];
        let currentCtm = { sx: 1, sy: 1, tx: 0, ty: 0 };

        let currentFontSize = 0;
        let currentTm: number[] | null = null;
        let tdAccumX = 0;
        let tdAccumY = 0;

        const tjInfos: TjInfo[] = [];
        let streamModified = simpleSanitizedStream !== streamText;

        const getPageIndexForStream = () => {
          const objectPageIndex = streamObjectToPageIndex.get(obj as object);
          if (objectPageIndex !== undefined) return objectPageIndex;

          const refStr = ref.toString();
          let pageIndex = 0;
          let found = false;
          streamRefToPageIndex.forEach((idx, key) => {
            if (found) return;
            const refObjectNumber = refStr.split(" ")[0];
            const exactRefPattern = new RegExp(
              `(^|\\D)${refObjectNumber}\\s+0\\s+R(\\D|$)`,
            );
            if (refStr === key || exactRefPattern.test(key)) {
              pageIndex = idx;
              found = true;
            }
          });
          return pageIndex;
        };

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();

          // Track q (save graphics state)
          if (line === "q") {
            ctmStack.push({ ...currentCtm });
          }

          // Track Q (restore graphics state)
          if (line === "Q") {
            if (ctmStack.length > 1) {
              ctmStack.pop();
              currentCtm = { ...ctmStack[ctmStack.length - 1] };
            }
          }

          // Track cm (concat matrix) - for diagonal affine transforms [a, b, c, d, e, f]
          const cmMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+cm$/,
          );
          if (cmMatch) {
            const [a, , , d, e, f] = cmMatch.slice(1, 7).map(Number);
            // Compose: new = current * incoming (for diagonal matrices)
            const newCtm = {
              sx: currentCtm.sx * a,
              sy: currentCtm.sy * d,
              tx: currentCtm.sx * e + currentCtm.tx,
              ty: currentCtm.sy * f + currentCtm.ty,
            };
            currentCtm = newCtm;
            ctmStack[ctmStack.length - 1] = { ...currentCtm };
          }

          // Track Tm (text matrix)
          const tmMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+Tm$/,
          );
          if (tmMatch) {
            currentTm = tmMatch.slice(1, 7).map(Number);
            tdAccumX = 0;
            tdAccumY = 0;
          }

          // Track BT (begin text)
          if (line === "BT") {
            tdAccumX = 0;
            tdAccumY = 0;
          }

          // Track font
          const fontMatch = line.match(/^\/(\w+)\s+([\d.]+)\s+Tf$/);
          if (fontMatch) {
            currentFontSize = parseFloat(fontMatch[2]);
          }

          // Td + Tj on same line: "16.0 0 Td <002E> Tj"
          const tdTjMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td\s+<([0-9a-fA-F]+)>\s+Tj$/,
          );
          if (tdTjMatch) {
            tdAccumX += parseFloat(tdTjMatch[1]);
            tdAccumY += parseFloat(tdTjMatch[2]);
            tjInfos.push({
              glyph: tdTjMatch[3].toLowerCase().padStart(4, "0"),
              lineIndex: i,
              glyphHexInLine: tdTjMatch[3],
              absX: tdAccumX,
              absY: tdAccumY,
              fontSize: currentFontSize,
              tm: currentTm ? [...currentTm] : null,
              ctm: { ...currentCtm },
            });
            continue;
          }

          // Standalone Td
          const tdMatch = line.match(/^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td$/);
          if (tdMatch) {
            tdAccumX += parseFloat(tdMatch[1]);
            tdAccumY += parseFloat(tdMatch[2]);
          }

          // TJ arrays are the dominant format in WeasyPrint / pypdf output:
          // [<26fc>0<7e16>0<f6ae>0<002e>0<0042>...] TJ
          // The older sanitizer handled only standalone Tj operators, so these
          // visible PDF author lines were passing through unchanged.
          if (line.includes("TJ")) {
            const originalLine = lines[i];
            let lineWasModified = false;
            const arrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
            lines[i] = originalLine.replace(
              arrayRegex,
              (fullMatch, body: string) => {
                const hexTokens: TjArrayHexToken[] = [];
                const orderedTokens: TjArrayToken[] = [];
                const glyphs: TjArrayGlyph[] = [];
                const tokenRegex =
                  /<([0-9a-fA-F]*)>|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
                let tokenMatch: RegExpExecArray | null;

                while ((tokenMatch = tokenRegex.exec(body)) !== null) {
                  if (tokenMatch[1] !== undefined) {
                    const tokenIndex = hexTokens.length;
                    const chunks = splitGlyphHex(tokenMatch[1]);
                    hexTokens.push({
                      start: tokenMatch.index,
                      end: tokenMatch.index + tokenMatch[0].length,
                      rawHex: tokenMatch[1],
                      chunks,
                      modified: false,
                    });
                    orderedTokens.push({ kind: "hex", tokenIndex });

                    chunks.forEach((chunk, chunkIndex) => {
                      glyphs.push({
                        glyph: chunk.toLowerCase().padStart(4, "0"),
                        tokenIndex,
                        chunkIndex,
                      });
                    });
                  } else if (tokenMatch[2] !== undefined) {
                    orderedTokens.push({
                      kind: "number",
                      value: Number(tokenMatch[2]),
                    });
                  }
                }

                if (glyphs.length === 0) return fullMatch;

                const replacedGlyphIndexes = new Set<number>();
                let arrayWasModified = false;

                for (const pattern of glyphPatterns) {
                  const patLen = pattern.glyphs.length;
                  if (patLen === 0 || glyphs.length < patLen) continue;

                  for (let gi = 0; gi <= glyphs.length - patLen; gi++) {
                    if (replacedGlyphIndexes.has(gi)) continue;

                    let matches = true;
                    for (let pj = 0; pj < patLen; pj++) {
                      if (
                        replacedGlyphIndexes.has(gi + pj) ||
                        glyphs[gi + pj].glyph !== pattern.glyphs[pj]
                      ) {
                        matches = false;
                        break;
                      }
                    }
                    if (!matches) continue;

                    for (let pj = 0; pj < patLen; pj++) {
                      const glyphInfo = glyphs[gi + pj];
                      const token = hexTokens[glyphInfo.tokenIndex];
                      const originalChunk =
                        token.chunks[glyphInfo.chunkIndex] || "0000";
                      token.chunks[glyphInfo.chunkIndex] = pattern.spaceGlyph
                        .toUpperCase()
                        .padStart(originalChunk.length, "0");
                      token.modified = true;
                      replacedGlyphIndexes.add(gi + pj);
                    }

                    arrayWasModified = true;
                    lineWasModified = true;

                    if (currentTm) {
                      const tm = currentTm;
                      const ctm = currentCtm;
                      const matchAdvance = calculateTjGlyphAdvance(
                        orderedTokens,
                        hexTokens,
                        gi,
                        pattern,
                        currentFontSize,
                      );
                      const matchWidth = Math.max(
                        calculateTjGlyphAdvance(
                          orderedTokens,
                          hexTokens,
                          gi + patLen,
                          pattern,
                          currentFontSize,
                        ) - matchAdvance,
                        pattern.glyphs.length * currentFontSize * 0.55,
                      );
                      const contentX = tm[4] + tdAccumX + matchAdvance;
                      const contentY = tm[5] + tdAccumY;
                      const pageX = ctm.sx * contentX + ctm.tx;
                      const pageY = ctm.sy * contentY + ctm.ty;
                      const effectiveFontSize =
                        Math.abs(ctm.sx) * currentFontSize;
                      const pageWidth = Math.abs(ctm.sx) * matchWidth;
                      const pageIndex = getPageIndexForStream();

                      overlayPositions.push({
                        target: pattern.target,
                        replacementText: replacementTextForTarget(
                          pattern.target,
                        ),
                        pageX,
                        pageY,
                        pageWidth,
                        effectiveFontSize,
                        pageIndex,
                      });

                      console.log(
                        `[FrontMind Proxy] PDF TJ overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`,
                      );
                    }
                  }
                }

                if (!arrayWasModified) return fullMatch;
                return `[${rebuildTjArrayBody(body, hexTokens)}] TJ`;
              },
            );

            if (lineWasModified) {
              streamModified = true;
            }
          }

          // Standalone Tj: "<002E> Tj" or Skia-style multi-CID string "<00300044005100580056> Tj"
          const tjMatch = line.match(/^<([0-9a-fA-F]+)>\s+Tj$/);
          if (tjMatch) {
            const originalHex = tjMatch[1];
            const fullHexLower = originalHex.toLowerCase();

            // Some browser-generated PDFs put the whole word in one hex string, with one 4-hex CID per glyph.
            // Example: <00300044005100580056> Tj maps through ToUnicode to "Manus".
            if (fullHexLower.length >= 8 && fullHexLower.length % 4 === 0) {
              let multiGlyphMatched = false;

              for (const pattern of glyphPatterns) {
                const needle = pattern.glyphs.join("").toLowerCase();
                const matchOffset = fullHexLower.indexOf(needle);
                if (matchOffset < 0 || matchOffset % 4 !== 0) continue;

                const replacementHex = pattern.glyphs
                  .map(() => pattern.spaceGlyph.toUpperCase().padStart(4, "0"))
                  .join("");
                const newHex =
                  originalHex.slice(0, matchOffset) +
                  replacementHex +
                  originalHex.slice(matchOffset + needle.length);
                lines[i] = lines[i].replace(`<${originalHex}>`, `<${newHex}>`);
                streamModified = true;
                multiGlyphMatched = true;

                if (currentTm) {
                  const glyphOffset = matchOffset / 4;
                  const tm = currentTm;
                  const ctm = currentCtm;
                  const contentX =
                    tm[4] + tdAccumX + glyphOffset * currentFontSize * 0.55;
                  const contentY = tm[5];
                  const pageX = ctm.sx * contentX + ctm.tx;
                  const pageY = ctm.sy * contentY + ctm.ty;
                  const effectiveFontSize = Math.abs(ctm.sx) * currentFontSize;
                  const pageWidth =
                    Math.abs(ctm.sx) *
                    pattern.glyphs.length *
                    currentFontSize *
                    0.65;

                  const pageIndex = getPageIndexForStream();

                  overlayPositions.push({
                    target: pattern.target,
                    replacementText: replacementTextForTarget(pattern.target),
                    pageX,
                    pageY,
                    pageWidth,
                    effectiveFontSize,
                    pageIndex,
                  });

                  console.log(
                    `[FrontMind Proxy] PDF multi-CID overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`,
                  );
                }
                break;
              }

              if (multiGlyphMatched) continue;
            }

            tjInfos.push({
              glyph: tjMatch[1].toLowerCase().padStart(4, "0"),
              lineIndex: i,
              glyphHexInLine: tjMatch[1],
              absX: tdAccumX,
              absY: tdAccumY,
              fontSize: currentFontSize,
              tm: currentTm ? [...currentTm] : null,
              ctm: { ...currentCtm },
            });
          }
        }

        // Search for pattern matches in the Tj sequence
        const alreadyReplaced = new Set<number>();

        for (const pattern of glyphPatterns) {
          const patLen = pattern.glyphs.length;

          for (let i = 0; i <= tjInfos.length - patLen; i++) {
            if (alreadyReplaced.has(i)) continue;

            let matches = true;
            for (let j = 0; j < patLen; j++) {
              if (
                tjInfos[i + j].glyph !== pattern.glyphs[j] ||
                alreadyReplaced.has(i + j)
              ) {
                matches = false;
                break;
              }
            }

            if (matches) {
              console.log(
                `[FrontMind Proxy] FOUND "${pattern.target}" in PDF stream ${ref.toString()}`,
              );

              // Replace each glyph with space glyph
              for (let j = 0; j < patLen; j++) {
                const tj = tjInfos[i + j];
                const oldHex = tj.glyphHexInLine;
                const newHex = pattern.spaceGlyph
                  .toUpperCase()
                  .padStart(oldHex.length, "0");
                lines[tj.lineIndex] = lines[tj.lineIndex].replace(
                  `<${oldHex}>`,
                  `<${newHex}>`,
                );
                alreadyReplaced.add(i + j);
              }
              streamModified = true;

              // Calculate page coordinates for overlay
              const firstTj = tjInfos[i];
              if (firstTj.tm) {
                const tm = firstTj.tm;
                const ctm = firstTj.ctm;

                // Content stream position (Tm translation + Td accumulation)
                const contentX = tm[4] + firstTj.absX;
                const contentY = tm[5]; // Y from Tm (horizontal text has Td y=0)

                // Transform to page coordinates using full CTM chain
                const pageX = ctm.sx * contentX + ctm.tx;
                const pageY = ctm.sy * contentY + ctm.ty;

                // Effective font size in page space
                const effectiveFontSize = Math.abs(ctm.sx) * firstTj.fontSize;

                // Width in content space (sum of Td x-offsets + estimated last char width)
                let contentWidth = 0;
                for (let j = 1; j < patLen; j++) {
                  contentWidth += tjInfos[i + j].absX - tjInfos[i + j - 1].absX;
                }
                contentWidth += firstTj.fontSize * 0.6; // Approximate last char width

                // Width in page space
                const pageWidth = Math.abs(ctm.sx) * contentWidth;

                // Determine which page this stream belongs to
                const pageIndex = getPageIndexForStream();

                overlayPositions.push({
                  target: pattern.target,
                  replacementText: replacementTextForTarget(pattern.target),
                  pageX,
                  pageY,
                  pageWidth,
                  effectiveFontSize,
                  pageIndex,
                });

                console.log(
                  `[FrontMind Proxy] PDF overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`,
                );
              }
            }
          }
        }

        if (streamModified) {
          // Recompress and replace the modified stream
          const newText = lines.join("\n");
          const newBytes = Buffer.from(newText, "latin1");
          const compressed = zlib.deflateSync(newBytes);
          const dict = (obj as any).dict.clone(context);
          dict.set(PDFName.of("Length"), context.obj(compressed.length));
          dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
          context.assign(ref, PDFRawStream.of(dict, compressed));
          totalModified++;
        }
      } catch {
        /* skip streams that can't be processed */
      }
    });

    // ── Step 4: Add overlay text using standard font ─────────────────
    if (overlayPositions.length > 0) {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      for (const pos of overlayPositions) {
        const page = pages[pos.pageIndex] || pages[0];
        const replacementText = pos.replacementText;
        const replacementWidth = font.widthOfTextAtSize(
          replacementText,
          pos.effectiveFontSize,
        );

        // Draw white rectangle to cover any visual remnants of the original glyphs
        page.drawRectangle({
          x: pos.pageX - 1,
          y: pos.pageY - 2,
          width: Math.max(pos.pageWidth, replacementWidth) + 4,
          height: pos.effectiveFontSize + 4,
          color: rgb(1, 1, 1),
          opacity: 1,
        });

        // Draw replacement text at the same position
        page.drawText(replacementText, {
          x: pos.pageX,
          y: pos.pageY,
          size: pos.effectiveFontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }

    if (totalModified > 0 || pdfMetadataModified) {
      const savedBytes = await pdfDoc.save();
      console.log(
        `[FrontMind Proxy] PDF sanitized: ${totalModified} stream(s) modified, ${overlayPositions.length} overlay(s) applied, metadata=${pdfMetadataModified}`,
      );
      return { buffer: Buffer.from(savedBytes), wasSanitized: true };
    }

    return { buffer: pdfBuffer, wasSanitized: false };
  } catch (err: any) {
    console.error("[FrontMind Proxy] PDF sanitization error:", err.message);
    // Never release an unsanitized original when brand replacement failed.
    throw new Error(`PDF sanitization failed: ${err.message}`);
  }
}

/**
 * Path-based boundary used by the PDF worker. The worker invokes this for a
 * small document or for one split page at a time, so the HTTP process never
 * retains a complete large PDF in memory.
 */
export async function sanitizePdfFile(
  inputPath: string,
  outputPath: string,
): Promise<{ wasSanitized: boolean }> {
  const input = await fs.readFile(inputPath);
  const result = await sanitizePdfBuffer(input);
  await fs.writeFile(outputPath, result.buffer, { mode: 0o600 });
  return { wasSanitized: result.wasSanitized };
}

// ============================================================
// End PDF sanitization
// ============================================================

// ============================================================
// Office Open XML (DOCX/XLSX/PPTX) Sanitization
// ============================================================

/**
 * Check if a file is an Office Open XML format (DOCX, XLSX, PPTX).
 */
function isOfficeXmlFile(filename: string, contentType?: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const officeExtensions = ["docx", "xlsx", "pptx", "doc", "xls", "ppt"];
  if (officeExtensions.includes(ext)) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (
      ct.includes("officedocument") ||
      ct.includes("msword") ||
      ct.includes("ms-excel") ||
      ct.includes("ms-powerpoint")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a buffer starts with the ZIP magic bytes (PK\x03\x04).
 * DOCX/XLSX/PPTX are all ZIP-based formats.
 */
function isZipMagicBytes(data: Buffer): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    data[2] === 0x03 &&
    data[3] === 0x04
  );
}

/**
 * Sanitize an Office Open XML file (DOCX/XLSX/PPTX) by:
 * 1. Unzipping the archive in memory
 * 2. Replacing "Manus" with "FrontMind" in all XML files inside
 * 3. Re-zipping and returning the modified buffer
 *
 * DOCX stores text in word/document.xml, word/header*.xml, word/footer*.xml
 * XLSX stores text in xl/sharedStrings.xml, xl/worksheets/sheet*.xml
 * PPTX stores text in ppt/slides/slide*.xml
 */
async function sanitizeOfficeXmlBuffer(
  data: Buffer,
): Promise<{ buffer: Buffer; wasSanitized: boolean }> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(data);

    let modified = false;

    // Process all files in the ZIP
    const fileNames = Object.keys(zip.files);
    for (const fname of fileNames) {
      const file = zip.files[fname];
      if (file.dir) continue;

      // Only process XML-based files inside the archive
      const lowerName = fname.toLowerCase();
      if (
        lowerName.endsWith(".xml") ||
        lowerName.endsWith(".rels") ||
        lowerName === "[content_types].xml"
      ) {
        try {
          const content = await file.async("string");
          const sanitized = sanitizeText(content);
          if (sanitized !== content) {
            zip.file(fname, sanitized);
            modified = true;
          }
        } catch {
          // Skip files that can't be read as text
        }
      }
    }

    if (modified) {
      const newBuffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      console.log(`[FrontMind Proxy] Office XML file sanitized`);
      return { buffer: newBuffer, wasSanitized: true };
    }

    return { buffer: data, wasSanitized: false };
  } catch (err: any) {
    console.error(
      `[FrontMind Proxy] Office XML sanitization error: ${err.message}`,
    );
    return { buffer: data, wasSanitized: false };
  }
}

// ============================================================
// End Office XML sanitization
// ============================================================

/**
 * Master file sanitization function.
 * Handles text files, PDFs, and Office Open XML (DOCX/XLSX/PPTX).
 * Uses magic bytes as fallback detection when filename/content-type are unreliable.
 */
async function sanitizeFileBuffer(
  data: Buffer,
  filename: string,
  contentType?: string,
): Promise<{ buffer: Buffer; wasSanitized: boolean }> {
  // Check if it's a PDF by extension/content-type OR by magic bytes
  if (isPdfFile(filename, contentType) || isPdfMagicBytes(data)) {
    console.log(
      `[FrontMind Proxy] Detected PDF file: ${filename} (magic=${isPdfMagicBytes(data)}, ext/ct=${isPdfFile(filename, contentType)})`,
    );
    return sanitizePdfBuffer(data);
  }

  // Check if it's an Office Open XML file (DOCX/XLSX/PPTX)
  if (
    isOfficeXmlFile(filename, contentType) ||
    (isZipMagicBytes(data) && !isTextBasedFile(filename, contentType))
  ) {
    console.log(`[FrontMind Proxy] Detected Office XML file: ${filename}`);
    return sanitizeOfficeXmlBuffer(data);
  }

  // Check if it's a text-based file
  return sanitizeTextFileBuffer(data, filename, contentType);
}

// ============================================================
// End sanitization helpers
// ============================================================

/**
 * Proxy-upload endpoint: forwards raw body to an external presigned S3 URL.
 *
 * The browser sends application/octet-stream, so the JSON parser leaves this
 * request untouched. The incoming stream is forwarded with backpressure
 * instead of buffering the complete file in Node memory.
 */
router.put("/proxy-upload", async (req: Request, res: Response) => {
  try {
    const rawTarget = req.query.target as string;
    if (!rawTarget) {
      return res.status(400).json({ error: { message: "Missing target URL" } });
    }
    const target = assertSafeExternalUrl(rawTarget);

    console.log(`[FrontMind Proxy] Proxy-upload to: ${safeUrlForLog(target)}`);

    const realContentType =
      (req.headers["x-original-content-type"] as string) ||
      req.headers["content-type"] ||
      "application/octet-stream";
    const uploadHeaders: Record<string, string> = {
      "Content-Type": realContentType,
    };
    if (typeof req.headers["content-length"] === "string") {
      uploadHeaders["Content-Length"] = req.headers["content-length"];
    }
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    const response = await axios.put(target, req, {
      ...safeExternalRequestOptions,
      headers: uploadHeaders,
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: 1024 * 1024,
      signal: controller.signal,
      validateStatus: () => true,
    });

    console.log(`[FrontMind Proxy] Proxy-upload response: ${response.status}`);
    res.status(response.status).send(response.data || "");
  } catch (error: any) {
    if (error instanceof ExternalUrlRejectedError) {
      return res.status(400).json({
        error: {
          message: "外部文件链接不可用",
          code: "INVALID_EXTERNAL_URL",
        },
      });
    }
    console.error("[FrontMind Proxy] Proxy-upload error:", error.message);
    res.status(500).json({
      error: {
        message: "文件上传失败，请稍后重试",
        code: "PROXY_UPLOAD_ERROR",
      },
    });
  }
});

/**
 * Proxy-download endpoint: proxies binary download from any external URL.
 * Used by the frontend to download files from S3 or other external sources
 * without CORS issues.
 *
 * Text-based files and PDFs are sanitized to replace Manus -> FrontMind.
 *
 * Usage: GET /api/manus/proxy-download?url=<encoded-external-url>
 */
router.get("/proxy-download", async (req: Request, res: Response) => {
  try {
    const rawTargetUrl = req.query.url as string;
    const requestedFilename =
      typeof req.query.filename === "string" ? req.query.filename : "";
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    if (!rawTargetUrl) {
      return res
        .status(400)
        .json({ error: { message: "Missing url parameter" } });
    }
    const targetUrl = assertSafeExternalUrl(rawTargetUrl);
    const urlFilenameRaw = targetUrl.split("/").pop()?.split("?")[0] || "file";
    const candidateFilename =
      requestedFilename || decodeURIComponent(urlFilenameRaw);

    // Legacy callers may still request a PDF through proxy-download. Route
    // those requests into the same asynchronous prepared-asset pipeline.
    if (isPdfFile(candidateFilename) && req.frontmindUser) {
      const credential = await getEffectiveDecryptedCredentialForAccount(
        req.frontmindUser.id,
      );
      const asset = await preparedFileService.registerExternal({
        ownerUserId: req.frontmindUser.id,
        credentialId: credential?.id || "external",
        url: targetUrl,
        filename: candidateFilename,
      });
      if (asset.status !== "ready") {
        return res.status(202).json(asset);
      }
      const suffix = disposition === "attachment" ? "?download=1" : "";
      return res.redirect(307, `${asset.contentUrl}${suffix}`);
    }

    console.log(
      `[FrontMind Proxy] Proxy-download: ${safeUrlForLog(targetUrl)}`,
    );

    const response = await fetchBoundedExternalDownload(targetUrl, {
      ...safeExternalRequestOptions,
      timeout: 120000,
      validateStatus: () => true,
    });

    console.log(
      `[FrontMind Proxy] Proxy-download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`,
    );

    res.status(response.status);

    // Sanitize file content (text files and PDFs - with magic byte detection)
    const rawBuffer = Buffer.from(response.data);
    // Try to extract filename from URL or content-disposition. The caller-provided
    // filename wins; otherwise we fall back to the URL tail and repair the extension
    // from magic bytes so UUID-like signed URLs still download as real PDFs.
    const upstreamContentType = responseHeaderValue(
      response.headers["content-type"],
    );
    const urlFilename = ensureFilenameMatchesContent(
      candidateFilename,
      rawBuffer,
      upstreamContentType,
    );
    const finalContentType = normalizeContentTypeForBuffer(
      urlFilename,
      rawBuffer,
      upstreamContentType,
    );

    // Forward safe cache validators only. Content-Type and Content-Disposition are
    // controlled below so an upstream `attachment` header cannot break iframe preview
    // and an upstream octet-stream response cannot make PDFs download as UUID blobs.
    for (const header of ["cache-control", "etag", "last-modified"]) {
      const value = responseHeaderValue(response.headers[header]);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("content-type", finalContentType);
    setSafeContentDisposition(
      res,
      disposition as "inline" | "attachment",
      urlFilename,
    );

    const { buffer: sanitizedBuffer, wasSanitized } = await sanitizeFileBuffer(
      rawBuffer,
      urlFilename,
      finalContentType,
    );

    // Update content-length if sanitized (size may have changed)
    if (wasSanitized) {
      res.setHeader("content-length", String(sanitizedBuffer.length));
    } else {
      const contentLength = responseHeaderValue(
        response.headers["content-length"],
      );
      if (contentLength) res.setHeader("content-length", contentLength);
    }

    res.send(sanitizedBuffer);
  } catch (error: any) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    if (error instanceof ExternalUrlRejectedError) {
      return res.status(400).json({
        error: {
          message: "外部文件链接不可用",
          code: "INVALID_EXTERNAL_URL",
        },
      });
    }
    console.error("[FrontMind Proxy] Proxy-download error:", error.message);
    res.status(500).json({
      error: {
        message: "文件下载失败，请稍后重试",
        code: "PROXY_DOWNLOAD_ERROR",
      },
    });
  }
});

/**
 * Fetch file metadata from the FrontMind API.
 * Returns { upload_url, filename } or null if not found.
 */
async function fetchFileMetadata(
  baseUrl: string,
  fileId: string,
  apiKey: string,
): Promise<{ upload_url: string; filename: string } | null> {
  // Check cache first
  const cached = getCachedMeta(fileId);
  if (cached) {
    console.log(`[FrontMind Proxy] File metadata cache hit for ${fileId}`);
    return cached;
  }

  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  const metadataUrl = `${cleanBaseUrl}/v1/files/${fileId}`;

  console.log(`[FrontMind Proxy] Fetching file metadata: GET ${metadataUrl}`);

  const response = await axios.get(metadataUrl, {
    headers: {
      API_KEY: apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    console.error(
      `[FrontMind Proxy] File metadata request failed: ${response.status}`,
    );
    return null;
  }

  const data = response.data;
  console.log(
    `[FrontMind Proxy] File metadata: id=${data.id}, filename=${data.filename}, status=${data.status}, has_upload_url=${!!data.upload_url}`,
  );

  if (data.upload_url) {
    const meta = {
      upload_url: data.upload_url,
      filename: data.filename || fileId,
    };
    setCachedMeta(fileId, meta);
    return meta;
  }

  // If no upload_url in metadata, return filename at least
  return { upload_url: "", filename: data.filename || fileId };
}

/**
 * Download binary file content from S3 URL and stream to response.
 * Text-based files and PDFs are sanitized to replace Manus -> FrontMind.
 */
async function downloadFromS3(
  res: Response,
  s3Url: string,
  filename: string,
  disposition: "inline" | "attachment" = "inline",
): Promise<void> {
  const safeS3Url = assertSafeExternalUrl(s3Url);
  console.log(
    `[FrontMind Proxy] Downloading from object storage: ${safeUrlForLog(safeS3Url)}`,
  );

  const response = await fetchBoundedExternalDownload(safeS3Url, {
    ...safeExternalRequestOptions,
    timeout: 120000,
    validateStatus: () => true,
  });

  console.log(
    `[FrontMind Proxy] S3 download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`,
  );

  if (response.status !== 200) {
    res.status(response.status);
    res.json({
      error: {
        message: `S3 download failed with status ${response.status}`,
        code: "S3_DOWNLOAD_ERROR",
      },
    });
    return;
  }

  res.status(200);

  // Sanitize file content (text files and PDFs - with magic byte detection)
  const rawBuffer = Buffer.from(response.data);
  const upstreamContentType = responseHeaderValue(
    response.headers["content-type"],
  );
  const finalFilename = ensureFilenameMatchesContent(
    filename,
    rawBuffer,
    upstreamContentType,
  );
  const finalContentType = normalizeContentTypeForBuffer(
    finalFilename,
    rawBuffer,
    upstreamContentType,
  );

  // Forward safe cache validators only. Content-Type and Content-Disposition are
  // controlled locally so PDF previews remain inline even when S3 says attachment,
  // and UUID-like filenames are repaired to include .pdf when magic bytes prove it.
  for (const header of ["cache-control", "etag", "last-modified"]) {
    const value = responseHeaderValue(response.headers[header]);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("content-type", finalContentType);
  setSafeContentDisposition(res, disposition, finalFilename);

  const { buffer: sanitizedBuffer } = await sanitizeFileBuffer(
    rawBuffer,
    finalFilename,
    finalContentType,
  );

  // Update content-length after sanitization
  res.setHeader("content-length", String(sanitizedBuffer.length));

  res.send(sanitizedBuffer);
}

/**
 * Core file download handler.
 * Strategy:
 * 1. GET /v1/files/:fileId to get metadata (JSON with upload_url)
 * 2. Use upload_url (S3 presigned URL) to download binary content
 * 3. Stream binary content back to the client with correct content-type
 */
async function handleFileDownload(
  res: Response,
  baseUrl: string,
  fileId: string,
  apiKey: string,
  disposition: "inline" | "attachment" = "inline",
  ownerUserId?: number,
  credentialId?: string,
): Promise<void> {
  // Step 1: Get file metadata
  const meta = await fetchFileMetadata(baseUrl, fileId, apiKey);

  if (!meta) {
    res.status(404).json({
      error: {
        message: `File not found: ${fileId}`,
        code: "FILE_NOT_FOUND",
      },
    });
    return;
  }

  if (isPdfFile(meta.filename) && ownerUserId && credentialId) {
    const asset = await preparedFileService.registerFile({
      ownerUserId,
      credentialId,
      fileId,
      filename: meta.filename,
    });
    if (asset.status !== "ready") {
      res.status(202).json(asset);
      return;
    }
    const suffix = disposition === "attachment" ? "?download=1" : "";
    res.redirect(307, `${asset.contentUrl}${suffix}`);
    return;
  }

  if (!meta.upload_url) {
    // No S3 URL available - try a direct download from the API as last resort
    console.warn(
      `[FrontMind Proxy] No upload_url for file ${fileId}, trying direct API download`,
    );

    // Try the /content endpoint as a last resort (some API versions may support it)
    const cleanBaseUrl = baseUrl.replace(/\/$/, "");
    const contentUrl = `${cleanBaseUrl}/v1/files/${fileId}/content`;

    try {
      const response = await fetchBoundedExternalDownload(contentUrl, {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120000,
        validateStatus: () => true,
      });

      const upstreamContentType = responseHeaderValue(
        response.headers["content-type"],
      );
      if (
        response.status === 200 &&
        upstreamContentType !== "application/json"
      ) {
        console.log(
          `[FrontMind Proxy] Direct /content download succeeded: ${response.status}`,
        );
        res.status(200);

        for (const header of ["content-type", "content-disposition"]) {
          const value = responseHeaderValue(response.headers[header]);
          if (value) {
            if (header === "content-disposition") {
              res.setHeader(header, sanitizeText(value));
            } else {
              res.setHeader(header, value);
            }
          }
        }

        // Sanitize file content (text files and PDFs - with magic byte detection)
        const rawBuffer = Buffer.from(response.data);
        const finalFilename = ensureFilenameMatchesContent(
          meta.filename,
          rawBuffer,
          upstreamContentType,
        );
        const finalContentType = normalizeContentTypeForBuffer(
          finalFilename,
          rawBuffer,
          upstreamContentType,
        );
        res.setHeader("content-type", finalContentType);
        setSafeContentDisposition(res, disposition, finalFilename);

        const { buffer: sanitizedBuffer } = await sanitizeFileBuffer(
          rawBuffer,
          finalFilename,
          finalContentType,
        );

        res.setHeader("content-length", String(sanitizedBuffer.length));
        res.send(sanitizedBuffer);
        return;
      }
    } catch (e: any) {
      if (isExternalDownloadTooLarge(e)) throw e;
      console.warn(
        "[FrontMind Proxy] Direct /content download failed:",
        safeErrorForLog(e, { secrets: [apiKey] }),
      );
    }

    res.status(404).json({
      error: {
        message: `No download URL available for file ${fileId}`,
        code: "NO_DOWNLOAD_URL",
      },
    });
    return;
  }

  // Step 2: Download binary from S3
  await downloadFromS3(res, meta.upload_url, meta.filename, disposition);
}

/**
 * Create a short-lived same-origin direct download URL.
 * The API key stays server-side in memory and is never placed into the URL.
 */
router.post("/download-token", async (req: Request, res: Response) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    cleanupExpiredDownloadTokens();
    const fileId = (req.body?.fileId as string) || "";

    if (!apiKey) {
      return res.status(401).json({
        error: { message: "Missing API key", code: "MISSING_API_KEY" },
      });
    }
    if (!fileId) {
      return res.status(400).json({
        error: { message: "Missing fileId", code: "MISSING_FILE_ID" },
      });
    }

    const token = randomUUID();
    if (!req.frontmindUser || !req.frontmindCredential) {
      return res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
    }
    downloadTokenCache.set(token, {
      fileId,
      userId: req.frontmindUser.id,
      credentialId: req.frontmindCredential.id,
      apiKey,
      baseUrl,
      createdAt: Date.now(),
    });
    res.json({
      downloadUrl: `/api/frontmind/download/${token}`,
      expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL,
    });
  } catch (error: any) {
    console.error(
      "[FrontMind Proxy] Create download token error:",
      safeErrorForLog(error, { secrets: [apiKey] }),
    );
    res.status(500).json({
      error: {
        message: "创建下载链接失败，请稍后重试",
        code: "DOWNLOAD_TOKEN_ERROR",
      },
    });
  }
});

/**
 * Same-origin direct file download endpoint used by the browser's native
 * download manager. It avoids client-side blob generation for AI output files.
 */
router.get("/download/:token", async (req: Request, res: Response) => {
  let logSecret = "";
  try {
    cleanupExpiredDownloadTokens();
    const token = req.params.token;
    const data = downloadTokenCache.get(token);
    if (!data) {
      return res.status(410).json({
        error: {
          message: "Download link expired",
          code: "DOWNLOAD_LINK_EXPIRED",
        },
      });
    }
    logSecret = data.apiKey;

    if (!req.frontmindUser || req.frontmindUser.id !== data.userId) {
      return res.status(403).json({
        error: {
          message: "下载链接不属于当前账号",
          code: "DOWNLOAD_FORBIDDEN",
        },
      });
    }

    // One-time use reduces accidental link sharing risk while keeping UX fast.
    downloadTokenCache.delete(token);
    await handleFileDownload(
      res,
      data.baseUrl,
      data.fileId,
      data.apiKey,
      "attachment",
      data.userId,
      data.credentialId,
    );
  } catch (error: any) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    console.error(
      "[FrontMind Proxy] Direct token download error:",
      safeErrorForLog(error, { secrets: [logSecret] }),
    );
    res.status(500).json({
      error: {
        message: "下载链接已失效或文件下载失败",
        code: "DIRECT_DOWNLOAD_ERROR",
      },
    });
  }
});

/**
 * Binary-safe file download endpoint.
 * Handles /v1/files/:fileId requests by:
 * 1. Fetching file metadata from the API
 * 2. Using the upload_url (S3) to download binary content
 * 3. Streaming binary content with correct headers
 */
router.get("/v1/files/:fileId", async (req: Request, res: Response) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    const fileId = req.params.fileId;

    await handleFileDownload(
      res,
      baseUrl,
      fileId,
      apiKey,
      "inline",
      req.frontmindUser?.id,
      req.frontmindCredential?.id,
    );
  } catch (error: any) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    console.error(
      "[FrontMind Proxy] File download error:",
      safeErrorForLog(error, { secrets: [apiKey] }),
    );
    res.status(500).json({
      error: {
        message: "文件下载失败，请稍后重试",
        code: "FILE_DOWNLOAD_ERROR",
      },
    });
  }
});

/**
 * Binary-safe file content endpoint (compat alias).
 * Handles /v1/files/:fileId/content requests.
 */
router.get("/v1/files/:fileId/content", async (req: Request, res: Response) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    const fileId = req.params.fileId;

    await handleFileDownload(
      res,
      baseUrl,
      fileId,
      apiKey,
      "inline",
      req.frontmindUser?.id,
      req.frontmindCredential?.id,
    );
  } catch (error: any) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    console.error(
      "[FrontMind Proxy] File content download error:",
      safeErrorForLog(error, { secrets: [apiKey] }),
    );
    res.status(500).json({
      error: {
        message: "文件内容下载失败，请稍后重试",
        code: "FILE_CONTENT_ERROR",
      },
    });
  }
});

router.get("/account-credit-usage", async (req: Request, res: Response) => {
  if (!req.frontmindUser) {
    res
      .status(401)
      .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
    return;
  }
  if (req.frontmindUser.role !== "admin") {
    res
      .status(403)
      .json({ error: { message: "仅管理员可查看积分", code: "FORBIDDEN" } });
    return;
  }
  try {
    const result = await getAccountMonthlyCreditUsage(req.frontmindUser.id);
    res.json(result);
  } catch (error) {
    console.error(
      "[FrontMind Proxy] Credit usage error",
      safeErrorForLog(error, {
        secrets: [req.frontmindCredential?.apiKey],
      }),
    );
    res.status(503).json({
      error: {
        message: "暂时无法读取当前 Key 的积分使用情况",
        code: "CREDIT_USAGE_UNAVAILABLE",
      },
    });
  }
});

router.get("/credential-check", async (req: Request, res: Response) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    const response = await axios.get(
      `${baseUrl.replace(/\/$/, "")}/v1/tasks?limit=1`,
      {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeout: 15_000,
        validateStatus: () => true,
      },
    );
    if (response.status === 401 || response.status === 403) {
      res.status(401).json({
        error: { message: "API Key 无效", code: "INVALID_CREDENTIAL" },
      });
      return;
    }
    if (response.status < 200 || response.status >= 300) {
      res.status(503).json({
        error: {
          message: "上游服务暂时无法验证 API Key",
          code: "UPSTREAM_UNAVAILABLE",
        },
      });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(
      "[FrontMind Proxy] Credential check error",
      safeErrorForLog(error, { secrets: [apiKey] }),
    );
    res.status(503).json({
      error: {
        message: "上游服务暂时无法验证 API Key",
        code: "UPSTREAM_UNAVAILABLE",
      },
    });
  }
});

// Proxy all other requests under /api/frontmind/*
router.all("/*", async (req: Request, res: Response) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    if (!apiKey) {
      return res.status(401).json({
        error: { message: "Missing API key", code: "MISSING_API_KEY" },
      });
    }

    // Build the target URL - strip public proxy prefix.
    const targetPath = req.originalUrl.replace(/^\/api\/frontmind/, "");
    if (isPrivateUpstreamCollectionRequest(req.method, targetPath)) {
      res.status(403).json({
        error: {
          message: "任务与文件目录仅按当前账号的本地记录展示",
          code: "UPSTREAM_COLLECTION_FORBIDDEN",
        },
      });
      return;
    }
    const targetUrl = `${baseUrl.replace(/\/$/, "")}${targetPath}`;

    console.log(`[FrontMind Proxy] ${req.method} ${targetPath}`);

    // Forward the request with correct Manus auth headers
    const headers: Record<string, string> = {
      "Content-Type": req.headers["content-type"] || "application/json",
      API_KEY: apiKey,
      Authorization: `Bearer ${apiKey}`,
    };

    const axiosConfig: any = {
      method: req.method,
      url: targetUrl,
      headers,
      timeout: 300000,
      validateStatus: () => true,
    };

    // Include body for POST/PUT/PATCH
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      axiosConfig.data = translateTaskBodyForUpstream(req.body);
    }

    const response = await axios(axiosConfig);

    if (
      response.status >= 200 &&
      response.status < 300 &&
      req.frontmindUser &&
      req.frontmindCredential &&
      response.data &&
      typeof response.data === "object"
    ) {
      const resourceId = String(
        response.data.id || response.data.task_id || "",
      );
      const isTaskCreate =
        req.method === "POST" && targetPath.split("?")[0] === "/v1/tasks";
      const isFileCreate =
        req.method === "POST" && targetPath.split("?")[0] === "/v1/files";
      if (resourceId && (isTaskCreate || isFileCreate)) {
        await recordUpstreamResource({
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: isTaskCreate ? "task" : "file",
          upstreamId: resourceId,
        });
      }

      // Generated output files are discovered in task responses rather than
      // through this application's upload endpoint. Record them before the
      // browser receives their URLs so later preview/download requests remain
      // bound to the same account and credential version.
      for (const fileId of collectOutputFileIds(response.data)) {
        await recordUpstreamResource({
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: "file",
          upstreamId: fileId,
        });
      }

      // Registration is metadata-only. The single background worker downloads
      // and brand-sanitizes generated PDFs without holding this API request.
      for (const descriptor of collectOutputPdfDescriptors(response.data)) {
        try {
          if (descriptor.fileId) {
            await preparedFileService.registerFile({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              fileId: descriptor.fileId,
              filename: descriptor.filename,
            });
            continue;
          }
          if (!descriptor.url) continue;
          const match = descriptor.url.match(/\/v1\/files\/([^/?#]+)/);
          if (match?.[1]) {
            await preparedFileService.registerFile({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              fileId: decodeURIComponent(match[1]),
              filename: descriptor.filename,
            });
          } else {
            await preparedFileService.registerExternal({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              url: descriptor.url,
              filename: descriptor.filename,
            });
          }
        } catch (error) {
          // Do not block task polling. Opening the PDF retries registration and
          // surfaces a precise error to the current user.
          console.warn(
            "[PreparedFiles] Auto-registration failed",
            safeErrorForLog(error, { secrets: [apiKey] }),
          );
        }
      }
    }

    const publicResponse =
      typeof response.data === "object"
        ? isPublicTaskPayloadRequest(req.method, targetPath)
          ? publicUpstreamTaskPayload(response.data, apiKey)
          : publicUpstreamPayload(response.data, apiKey)
        : typeof response.data === "string"
          ? sanitizeText(redactSensitiveText(response.data, [apiKey]))
          : response.data;

    // Log only an allowlisted summary of the already-redacted public payload.
    if (
      publicResponse &&
      typeof publicResponse === "object" &&
      !Array.isArray(publicResponse) &&
      Array.isArray((publicResponse as Record<string, unknown>).output)
    ) {
      const publicRecord = publicResponse as Record<string, any>;
      const outputSummary = (publicRecord.output as any[])
        .map(
          (item: any, i: number) =>
            `${i}:${item.type || "message"}${item.id ? "(" + item.id.slice(0, 8) + ")" : ""}`,
        )
        .join(", ");
      console.log(
        `[FrontMind Proxy] Response: ${response.status} id=${String(publicRecord.id || "").slice(0, 12)} status=${String(publicRecord.status || "")} output=[${publicRecord.output.length} items: ${outputSummary.slice(0, 300)}]`,
      );
    } else {
      console.log(`[FrontMind Proxy] Response: ${response.status}`);
    }

    // Forward status and response
    res.status(response.status);

    // Forward relevant headers
    const contentType = responseHeaderValue(response.headers["content-type"]);
    if (contentType) res.setHeader("content-type", contentType);

    // Send the response data - with deep sanitization for JSON responses
    if (typeof publicResponse === "object") {
      res.json(publicResponse);
    } else if (typeof publicResponse === "string") {
      res.send(publicResponse);
    } else {
      res.send(publicResponse);
    }
  } catch (error: any) {
    console.error(
      "[FrontMind Proxy] Error:",
      safeErrorForLog(error, { secrets: [apiKey] }),
    );

    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      res.status(502).json({
        error: {
          message: "无法连接到服务，请稍后重试或检查配置",
          code: "PROXY_CONNECTION_ERROR",
        },
      });
    } else if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
      res.status(504).json({
        error: {
          message: "API 请求超时",
          code: "PROXY_TIMEOUT",
        },
      });
    } else {
      res.status(500).json({
        error: {
          message: "服务请求失败，请稍后重试",
          code: "PROXY_ERROR",
        },
      });
    }
  }
});

export default router;
