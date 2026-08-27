import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import { and, eq } from "drizzle-orm";

import {
  siteBuilds,
  siteProjects,
  socialPackages,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { readSiteOpsArtifact } from "./artifact-store";
import { exchangeAliyunOAuthCode } from "./aliyun-platform-service";
import { completeSiteOpsAliyunOAuth } from "./service";
import { customerVisibleStyleBatchStatusCondition } from "./visual-batch-visibility";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;

type AliyunOAuthCompletionStatus = "success" | "cancelled" | "failed";
type AliyunOAuthCallbackStage =
  | "session"
  | "provider_authorization"
  | "oauth_exchange"
  | "account_bind";

const SAFE_ALIYUN_OAUTH_ERROR_CODES = new Set([
  "CREDENTIAL_ROTATED",
  "DATABASE_UNAVAILABLE",
  "FORBIDDEN",
  "INVALID_CALLBACK",
  "INVALID_CREDENTIAL",
  "NOT_FOUND",
  "PROVIDER_AUTHORIZATION_FAILED",
  "PROVIDER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "STATE_CONFLICT",
  "UNAUTHENTICATED",
  "UPSTREAM_UNAVAILABLE",
]);

function safeAliyunOAuthErrorCode(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  return typeof code === "string" && SAFE_ALIYUN_OAUTH_ERROR_CODES.has(code)
    ? code
    : "UNEXPECTED_ERROR";
}

function logAliyunOAuthCallbackFailure(input: {
  correlationId: string;
  stage: AliyunOAuthCallbackStage;
  userId: number | null;
  errorCode: string;
  startedAt: number;
}) {
  const buildSha = process.env.FRONTMIND_BUILD_SHA?.trim() ?? "";
  console.error("[SiteOps Aliyun OAuth] callback_stage_failed", {
    event: "siteops_aliyun_oauth_callback_stage_failed",
    correlationId: input.correlationId,
    stage: input.stage,
    userId: input.userId,
    errorCode: SAFE_ALIYUN_OAUTH_ERROR_CODES.has(input.errorCode)
      ? input.errorCode
      : "UNEXPECTED_ERROR",
    latencyMs: Math.max(0, Date.now() - input.startedAt),
    releaseSha: /^[a-f0-9]{40}$/u.test(buildSha) ? buildSha : null,
  });
}

const ALIYUN_OAUTH_COMPLETION_COPY: Record<
  AliyunOAuthCompletionStatus,
  { title: string; description: string }
> = {
  success: {
    title: "阿里云授权已完成",
    description: "账号已经连接，可以返回 AI友好官网管理选择并配置域名。",
  },
  cancelled: {
    title: "已取消阿里云授权",
    description: "未保存新的客户账号连接，可以返回后重新发起授权。",
  },
  failed: {
    title: "阿里云授权暂时无法完成",
    description: "请返回 AI友好官网管理后重试，或联系 FrontMind 协助处理。",
  },
};

function sendAliyunOAuthCompletionPage(
  res: express.Response,
  status: AliyunOAuthCompletionStatus,
) {
  const nonce = randomBytes(18).toString("base64url");
  const copy = ALIYUN_OAUTH_COMPLETION_COPY[status];
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${copy.title}</title>
    <style nonce="${nonce}">
      :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f7f5fb; color: #25222d; }
      main { width: min(32rem, calc(100vw - 3rem)); padding: 2rem; border: 1px solid #e4deed; border-radius: 1.25rem; background: #fff; box-shadow: 0 1rem 3rem rgba(43, 34, 59, .08); }
      h1 { margin: 0 0 .75rem; font-size: 1.35rem; }
      p { margin: 0 0 1.25rem; color: #625b6d; line-height: 1.65; }
      a { display: inline-flex; padding: .7rem 1rem; border-radius: .75rem; background: #493b64; color: #fff; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${copy.title}</h1>
      <p>${copy.description}</p>
      <a href="/">返回 AI友好官网管理</a>
    </main>
    <script nonce="${nonce}">
      (() => {
        const message = Object.freeze({
          type: "frontmind:siteops:aliyun-oauth",
          status: "${status}"
        });
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, window.location.origin);
          if (message.status === "cancelled") {
            window.close();
          }
        }
      })();
    </script>
  </body>
</html>`;

  res.status(200);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
  );
  res.send(html);
}

function notFound(res: express.Response) {
  res.status(404).json({ error: "NOT_FOUND" });
}

export function publicSiteOpsArtifactError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return code === "NOT_FOUND"
    ? { status: 404, body: { error: "NOT_FOUND" } }
    : {
        status: 409,
        body: { error: "文件暂时无法打开，请稍后重试。" },
      };
}

function sendError(res: express.Response, error: unknown) {
  const projected = publicSiteOpsArtifactError(error);
  res.status(projected.status).json(projected.body);
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

async function streamToBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new Error("SITEOPS_ARTIFACT_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function safePreviewPath(raw: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw || "");
  } catch {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  const normalized = decoded.normalize("NFKC").replace(/^\/+|\/+$/gu, "");
  if (normalized.length > 1_024) {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  return normalized || "index.html";
}

function previewMimeType(filename: string) {
  const extension = path.posix.extname(filename).toLowerCase();
  return (
    (
      {
        ".avif": "image/avif",
        ".css": "text/css; charset=utf-8",
        ".gif": "image/gif",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".xml": "application/xml; charset=utf-8",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

function prefixPreviewRootUrl(value: string, prefix: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith(prefix)
  ) {
    return value;
  }
  return `${prefix}${value.slice(1)}`;
}

function rewriteCssRootUrls(value: string, prefix: string) {
  return value
    .replace(
      /url\(\s*(?:(["'])(\/(?!\/)[^"')]+)\1|(\/(?!\/)[^)\s]+))\s*\)/giu,
      (
        match,
        quote: string | undefined,
        quoted: string | undefined,
        bare: string | undefined,
      ) => {
        const url = quoted ?? bare;
        if (!url) return match;
        const rewritten = prefixPreviewRootUrl(url, prefix);
        return quote
          ? `url(${quote}${rewritten}${quote})`
          : `url(${rewritten})`;
      },
    )
    .replace(
      /(@import\s+)(["'])(\/(?!\/)[^"']+)\2/giu,
      (_match, keyword: string, quote: string, url: string) =>
        `${keyword}${quote}${prefixPreviewRootUrl(url, prefix)}${quote}`,
    );
}

function localPreviewAssetPath(raw: string, from: string) {
  const decoded = raw.trim();
  if (
    !decoded ||
    decoded.startsWith("#") ||
    /^(?:data:|blob:|mailto:|tel:|https?:|\/\/)/iu.test(decoded)
  ) {
    return null;
  }
  const withoutSuffix = decoded.split(/[?#]/u, 1)[0]!;
  const resolved = withoutSuffix.startsWith("/")
    ? withoutSuffix.slice(1)
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(from), withoutSuffix),
      );
  if (
    !resolved ||
    resolved.startsWith("../") ||
    resolved.includes("\\") ||
    resolved.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("SITEOPS_PREVIEW_PATH_INVALID");
  }
  return resolved;
}

async function replaceAsync(
  value: string,
  expression: RegExp,
  replacer: (...groups: string[]) => Promise<string>,
) {
  const matches = [...value.matchAll(expression)];
  if (matches.length === 0) return value;
  const replacements = await Promise.all(
    matches.map((match) =>
      replacer(match[0], ...match.slice(1).map((part) => part ?? "")),
    ),
  );
  let cursor = 0;
  let result = "";
  matches.forEach((match, index) => {
    result += value.slice(cursor, match.index) + replacements[index];
    cursor = (match.index ?? 0) + match[0].length;
  });
  return result + value.slice(cursor);
}

export async function createSandboxedPreviewDocument(input: {
  zip: JSZip;
  entryName: string;
  previewPrefix: string;
}) {
  const files = new Map(
    Object.values(input.zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => [entry.name, entry] as const),
  );
  const bytesCache = new Map<string, Buffer>();
  let expandedBytes = 0;
  const fileBytes = async (filename: string) => {
    const cached = bytesCache.get(filename);
    if (cached) return cached;
    const entry = files.get(filename);
    if (!entry || entry.name.includes("\\") || entry.name.includes("..")) {
      throw new Error("SITEOPS_PREVIEW_ASSET_MISSING");
    }
    const mode = Number(entry.unixPermissions ?? 0);
    if (mode && (mode & 0o170000) === 0o120000) {
      throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
    }
    const bytes = await entry.async("nodebuffer");
    expandedBytes += bytes.length;
    if (bytes.length > 20 * 1024 * 1024 || expandedBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("SITEOPS_PREVIEW_FILE_TOO_LARGE");
    }
    bytesCache.set(filename, bytes);
    return bytes;
  };
  const dataUrl = async (filename: string) => {
    const mimeType = previewMimeType(filename).split(";", 1)[0];
    return `data:${mimeType};base64,${(await fileBytes(filename)).toString("base64")}`;
  };
  const embedCssUrls = async (css: string, filename: string) =>
    await replaceAsync(
      css,
      /url\(\s*(?:(["'])([^"']+)\1|([^)'"\s]+))\s*\)/giu,
      async (match, quote, quoted, bare) => {
        const raw = quoted || bare;
        const local = localPreviewAssetPath(raw, filename);
        if (!local) return match;
        const embedded = await dataUrl(local);
        return `url(${quote || '"'}${embedded}${quote || '"'})`;
      },
    );
  const inlineCss = async (filename: string, visiting = new Set<string>()) => {
    if (visiting.has(filename)) {
      throw new Error("SITEOPS_PREVIEW_STYLE_CYCLE");
    }
    const nextVisiting = new Set(visiting).add(filename);
    let css = (await fileBytes(filename)).toString("utf8");
    css = await replaceAsync(
      css,
      /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?\s*;/giu,
      async (_match, _quote, raw) => {
        const local = localPreviewAssetPath(raw, filename);
        if (!local) throw new Error("SITEOPS_PREVIEW_STYLE_INVALID");
        return await inlineCss(local, nextVisiting);
      },
    );
    return await embedCssUrls(css, filename);
  };
  const embedAssetReferences = async (text: string, from: string) => {
    const assetPaths = [...files.keys()]
      .filter((filename) => filename !== input.entryName)
      .sort((left, right) => right.length - left.length);
    let result = text;
    for (const filename of assetPaths) {
      const embedded = await dataUrl(filename);
      for (const reference of [
        `/${filename}`,
        path.posix.relative(path.posix.dirname(from), filename),
      ]) {
        if (reference && reference !== ".") {
          result = result.split(reference).join(embedded);
        }
      }
    }
    return result;
  };

  const nonce = randomBytes(18).toString("base64url");
  let html = (await fileBytes(input.entryName)).toString("utf8");
  html = await replaceAsync(
    html,
    /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/giu,
    async (_match, raw) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) throw new Error("SITEOPS_PREVIEW_STYLE_INVALID");
      return `<style nonce="${nonce}">${await inlineCss(local)}</style>`;
    },
  );
  html = html.replace(
    /<link\b(?=[^>]*\brel=["'](?:modulepreload|preload)["'])[^>]*>/giu,
    "",
  );
  html = await replaceAsync(
    html,
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/giu,
    async (_match, before, raw, after) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) throw new Error("SITEOPS_PREVIEW_SCRIPT_INVALID");
      const embeddedSource = await embedAssetReferences(
        (await fileBytes(local)).toString("utf8"),
        local,
      );
      const source = rewriteSiteOpsPreviewDocument({
        bytes: Buffer.from(embeddedSource, "utf8"),
        mimeType: "text/javascript; charset=utf-8",
        previewPrefix: input.previewPrefix,
      }).toString("utf8");
      const attributes = `${before} ${after}`
        .replace(/\s(?:crossorigin|integrity)(?:=["'][^"']*["'])?/giu, "")
        .trim();
      return `<script nonce="${nonce}"${attributes ? ` ${attributes}` : ""}>${source.replace(/<\/script/giu, "<\\/script")}</script>`;
    },
  );
  html = await replaceAsync(
    html,
    /\b(src|poster)(\s*=\s*)(["'])([^"']+)\3/giu,
    async (match, name, equals, quote, raw) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) return match;
      return `${name}${equals}${quote}${await dataUrl(local)}${quote}`;
    },
  );
  html = await replaceAsync(
    html,
    /\bsrcset(\s*=\s*)(["'])([^"']*)\2/giu,
    async (_match, equals, quote, value) => {
      const candidates = await Promise.all(
        value.split(",").map(async (candidate) => {
          const [raw, ...descriptor] = candidate.trim().split(/\s+/u);
          const local = raw
            ? localPreviewAssetPath(raw, input.entryName)
            : null;
          return [local ? await dataUrl(local) : raw, ...descriptor]
            .filter(Boolean)
            .join(" ");
        }),
      );
      return `srcset${equals}${quote}${candidates.join(", ")}${quote}`;
    },
  );
  html = await replaceAsync(
    html,
    /<link\b(?=[^>]*\brel=["']icon["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/giu,
    async (match, raw) => {
      const local = localPreviewAssetPath(raw, input.entryName);
      if (!local) return match;
      return match.replace(raw, await dataUrl(local));
    },
  );
  html = await replaceAsync(
    html,
    /<style\b([^>]*)>([\s\S]*?)<\/style>/giu,
    async (_match, attributes, css) =>
      `<style${attributes}>${await embedCssUrls(css, input.entryName)}</style>`,
  );
  html = html
    .replace(
      /<style\b(?![^>]*\bnonce=)([^>]*)>/giu,
      `<style nonce="${nonce}"$1>`,
    )
    .replace(
      /<script\b(?![^>]*\bnonce=)([^>]*)>/giu,
      `<script nonce="${nonce}"$1>`,
    )
    .replace(
      /\bhref(\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/giu,
      (_match, equals: string, quote: string, url: string) =>
        `href${equals}${quote}${prefixPreviewRootUrl(url, input.previewPrefix)}${quote}`,
    );
  return { bytes: Buffer.from(html, "utf8"), nonce };
}

export function sandboxedPreviewContentSecurityPolicy(nonce: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(nonce)) {
    throw new Error("SITEOPS_PREVIEW_NONCE_INVALID");
  }
  return `sandbox allow-scripts; default-src 'none'; img-src data: blob:; font-src data:; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; media-src data: blob:; manifest-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
}

export function rewriteSiteOpsPreviewDocument(input: {
  bytes: Buffer;
  mimeType: string;
  previewPrefix: string;
}) {
  const mediaType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "text/html" &&
    mediaType !== "text/css" &&
    mediaType !== "text/javascript" &&
    mediaType !== "application/javascript"
  ) {
    return input.bytes;
  }
  let text = input.bytes.toString("utf8");
  if (mediaType === "text/html") {
    text = text
      .replace(
        /\b(href|src|action|poster|data|xlink:href)(\s*=\s*)(["'])(\/(?!\/)[^"'<>]*)\3/giu,
        (_match, name: string, equals: string, quote: string, url: string) =>
          `${name}${equals}${quote}${prefixPreviewRootUrl(url, input.previewPrefix)}${quote}`,
      )
      .replace(
        /\b(srcset)(\s*=\s*)(["'])([^"']*)\3/giu,
        (
          _match,
          name: string,
          equals: string,
          quote: string,
          value: string,
        ) => {
          const rewritten = value.replace(
            /(^|,\s*)(\/(?!\/)[^\s,]+)/gu,
            (_candidate, separator: string, url: string) =>
              `${separator}${prefixPreviewRootUrl(url, input.previewPrefix)}`,
          );
          return `${name}${equals}${quote}${rewritten}${quote}`;
        },
      );
  }
  if (
    mediaType === "text/javascript" ||
    mediaType === "application/javascript"
  ) {
    text = text
      .replace(
        /(["'`])(\/(?!\/)[A-Za-z0-9._~!$&()*+,;=:@%/?#-]*)\1/gu,
        (_match, quote: string, url: string) =>
          `${quote}${prefixPreviewRootUrl(url, input.previewPrefix)}${quote}`,
      )
      .replace(
        /(`)(\/(?!\/)(?=[A-Za-z0-9._~!$&()*+,;=:@%/?#${}-]))/gu,
        (_match, quote: string, root: string) =>
          `${quote}${prefixPreviewRootUrl(root, input.previewPrefix)}`,
      );
  }
  return Buffer.from(rewriteCssRootUrls(text, input.previewPrefix), "utf8");
}

async function ownedBuild(userId: number, buildId: string) {
  const db = await requireDb();
  const rows = await db
    .select({ build: siteBuilds, project: siteProjects })
    .from(siteBuilds)
    .innerJoin(siteProjects, eq(siteProjects.id, siteBuilds.projectId))
    .where(
      and(
        eq(siteBuilds.id, buildId),
        eq(siteBuilds.userId, userId),
        eq(siteProjects.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function sendOwnedAsset(input: {
  res: express.Response;
  userId: number;
  localAssetId: string;
  expectedSha256?: string | null;
  expectedMimeTypes?: string[];
  disposition?: "inline" | "attachment";
}) {
  const asset = await readSiteOpsArtifact({
    userId: input.userId,
    localAssetId: input.localAssetId,
    expectedSha256: input.expectedSha256,
    ...(input.expectedMimeTypes
      ? { expectedMimeTypes: input.expectedMimeTypes }
      : {}),
  });
  if (
    !asset ||
    (input.expectedMimeTypes &&
      !input.expectedMimeTypes.includes(asset.row.mimeType))
  ) {
    return notFound(input.res);
  }
  input.res.setHeader("Cache-Control", "private, no-store, max-age=0");
  input.res.setHeader("Content-Type", asset.row.mimeType);
  input.res.setHeader("Content-Length", String(asset.row.sizeBytes));
  input.res.setHeader("ETag", `"sha256:${asset.row.contentSha256}"`);
  input.res.setHeader(
    "Content-Disposition",
    `${input.disposition ?? "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.row.filename)}`,
  );
  asset.stored.createReadStream().pipe(input.res);
}

export const siteOpsArtifactApi = express.Router();

const STYLE_PREVIEW_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

function frozenStylePreviewSha256(sourceMetadata: unknown) {
  if (
    !sourceMetadata ||
    typeof sourceMetadata !== "object" ||
    Array.isArray(sourceMetadata)
  ) {
    return { valid: true as const, value: undefined };
  }
  const metadata = sourceMetadata as Record<string, unknown>;
  const strictSourceBackedPreview =
    metadata.schemaVersion === 5 ||
    metadata.schemaVersion === 6 ||
    metadata.renderer === "twenty_first_native_react_v1" ||
    metadata.renderer === "twenty_first_native_template_v1";
  const raw = metadata.previewSha256 ?? metadata.realizationPreviewSha256;
  if (raw === undefined || raw === null) {
    return strictSourceBackedPreview
      ? { valid: false as const, value: undefined }
      : { valid: true as const, value: undefined };
  }
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/iu.test(raw.trim())) {
    return { valid: false as const, value: undefined };
  }
  return { valid: true as const, value: raw.trim().toLowerCase() };
}

siteOpsArtifactApi.get("/aliyun/oauth/callback", async (req, res) => {
  const startedAt = Date.now();
  const correlationId = randomBytes(12).toString("hex");
  const actor = req.frontmindUser;
  const providerError =
    typeof req.query.error === "string" ? req.query.error : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!actor) {
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage: "session",
      userId: null,
      errorCode: "UNAUTHENTICATED",
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
    return;
  }
  if (providerError) {
    if (providerError === "access_denied") {
      sendAliyunOAuthCompletionPage(res, "cancelled");
      return;
    }
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage: "provider_authorization",
      userId: actor.id,
      errorCode: "PROVIDER_AUTHORIZATION_FAILED",
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
    return;
  }
  if (!code || !state) {
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage: "provider_authorization",
      userId: actor.id,
      errorCode: "INVALID_CALLBACK",
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
    return;
  }
  let stage: AliyunOAuthCallbackStage = "oauth_exchange";
  try {
    const identity = await exchangeAliyunOAuthCode({
      code,
      state,
      userId: actor.id,
    });
    stage = "account_bind";
    await completeSiteOpsAliyunOAuth({
      actor,
      credentialId: identity.credentialId,
      projectId: identity.projectId,
      accountUid: identity.accountUid,
      refreshToken: identity.refreshToken,
    });
    sendAliyunOAuthCompletionPage(res, "success");
  } catch (error) {
    logAliyunOAuthCallbackFailure({
      correlationId,
      stage,
      userId: actor.id,
      errorCode: safeAliyunOAuthErrorCode(error),
      startedAt,
    });
    sendAliyunOAuthCompletionPage(res, "failed");
  }
});

siteOpsArtifactApi.get("/style-previews/:sampleId", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const db = await requireDb();
    const rows = await db
      .select({
        localAssetId: websiteStyleSamples.previewLocalAssetId,
        sourceMetadata: websiteStyleSamples.sourceMetadata,
      })
      .from(websiteStyleSamples)
      .innerJoin(
        websiteStyleSampleBatches,
        eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
      )
      .where(
        and(
          eq(websiteStyleSamples.id, req.params.sampleId),
          eq(websiteStyleSampleBatches.userId, userId),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          customerVisibleStyleBatchStatusCondition(),
        ),
      )
      .limit(1);
    const row = rows[0];
    const localAssetId = row?.localAssetId;
    const expectedHash = frozenStylePreviewSha256(row?.sourceMetadata);
    if (!localAssetId || !expectedHash.valid) return notFound(res);
    await sendOwnedAsset({
      res,
      userId,
      localAssetId,
      expectedSha256: expectedHash.value,
      expectedMimeTypes: [...STYLE_PREVIEW_MIME_TYPES],
      disposition: "inline",
    });
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get("/builds/:buildId/source", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const owned = await ownedBuild(userId, req.params.buildId);
    if (!owned?.build.sourceLocalAssetId) return notFound(res);
    await sendOwnedAsset({
      res,
      userId,
      localAssetId: owned.build.sourceLocalAssetId,
      expectedSha256: owned.build.sourceHash,
    });
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get("/builds/:buildId/qa", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const owned = await ownedBuild(userId, req.params.buildId);
    if (!owned?.build.qaLocalAssetId) return notFound(res);
    await sendOwnedAsset({
      res,
      userId,
      localAssetId: owned.build.qaLocalAssetId,
    });
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get("/builds/:buildId/preview/*", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const owned = await ownedBuild(userId, req.params.buildId);
    if (!owned?.build.distLocalAssetId || !owned.build.distHash) {
      return notFound(res);
    }
    const asset = await readSiteOpsArtifact({
      userId,
      localAssetId: owned.build.distLocalAssetId,
      expectedSha256: owned.build.distHash,
      expectedMimeTypes: ["application/zip"],
    });
    if (!asset) return notFound(res);
    const archive = await streamToBuffer(
      asset.stored.createReadStream(),
      MAX_ARCHIVE_BYTES,
    );
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error("SITEOPS_DIST_STRUCTURE_INVALID");
    }
    const wildcard = (req.params as Record<string, string | undefined>)["0"];
    const requestPath = safePreviewPath(wildcard ?? "");
    const candidates = requestPath.endsWith("/")
      ? [`${requestPath}index.html`]
      : [requestPath, `${requestPath}/index.html`];
    const entry = candidates
      .map((candidate) => zip.file(candidate))
      .find(Boolean);
    if (
      !entry ||
      !entry.name.endsWith(".html") ||
      entry.name.includes("\\") ||
      entry.name.includes("..")
    ) {
      return notFound(res);
    }
    const mode = Number(entry.unixPermissions ?? 0);
    if (mode && (mode & 0o170000) === 0o120000) {
      throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
    }
    const document = await createSandboxedPreviewDocument({
      zip,
      entryName: entry.name,
      previewPrefix: `/api/site-ops/builds/${encodeURIComponent(req.params.buildId)}/preview/`,
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      sandboxedPreviewContentSecurityPolicy(document.nonce),
    );
    res.setHeader("Content-Length", String(document.bytes.length));
    res.send(document.bytes);
  } catch (error) {
    sendError(res, error);
  }
});

siteOpsArtifactApi.get(
  "/social-packages/:packageId/archive",
  async (req, res) => {
    try {
      const userId = req.frontmindUser?.id;
      if (!userId) return notFound(res);
      const db = await requireDb();
      const rows = await db
        .select()
        .from(socialPackages)
        .where(
          and(
            eq(socialPackages.id, req.params.packageId),
            eq(socialPackages.userId, userId),
            eq(socialPackages.status, "ready"),
          ),
        )
        .limit(1);
      const item = rows[0];
      if (!item?.archiveLocalAssetId || !item.archiveHash) return notFound(res);
      await db
        .update(socialPackages)
        .set({ downloadCount: item.downloadCount + 1 })
        .where(
          and(
            eq(socialPackages.id, item.id),
            eq(socialPackages.downloadCount, item.downloadCount),
          ),
        );
      await sendOwnedAsset({
        res,
        userId,
        localAssetId: item.archiveLocalAssetId,
        expectedSha256: item.archiveHash,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

siteOpsArtifactApi.get(
  "/social-packages/:packageId/preview/:index",
  async (req, res) => {
    try {
      const userId = req.frontmindUser?.id;
      if (!userId) return notFound(res);
      const index = Number(req.params.index);
      if (!Number.isSafeInteger(index) || index < 0 || index > 8) {
        return notFound(res);
      }
      const db = await requireDb();
      const rows = await db
        .select()
        .from(socialPackages)
        .where(
          and(
            eq(socialPackages.id, req.params.packageId),
            eq(socialPackages.userId, userId),
            eq(socialPackages.status, "ready"),
          ),
        )
        .limit(1);
      const localAssetId = rows[0]?.previewLocalAssetIds[index];
      if (!localAssetId) return notFound(res);
      await sendOwnedAsset({
        res,
        userId,
        localAssetId,
        disposition: "inline",
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);
