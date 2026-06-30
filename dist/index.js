// server/_core/index.ts
import "dotenv/config";
import express3 from "express";
import { createServer } from "http";
import net2 from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/_core/notification.ts
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var protectedProcedure = t.procedure;
var adminProcedure = t.procedure;

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(() => null),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(COOKIE_NAME, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: -1
      });
      return {
        success: true
      };
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  return {
    req: opts.req,
    res: opts.res,
    user: null
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".frontmind-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginFrontMindDebugCollector() {
  return {
    name: "frontmind-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__frontmind__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__frontmind__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var vite_config_default = defineConfig(({ mode }) => {
  const isProduction = mode === "production";
  const plugins = [
    react(),
    tailwindcss(),
    !isProduction && jsxLocPlugin(),
    !isProduction && vitePluginFrontMindDebugCollector()
  ].filter(Boolean);
  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets")
      }
    },
    envDir: path.resolve(import.meta.dirname),
    root: path.resolve(import.meta.dirname, "client"),
    publicDir: path.resolve(import.meta.dirname, "client", "public"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true
    },
    server: {
      host: true,
      allowedHosts: ["localhost", "127.0.0.1"],
      fs: {
        strict: true,
        deny: ["**/.*"]
      }
    }
  };
});

// server/_core/vite.ts
function resolveViteConfig() {
  if (typeof vite_config_default === "function") {
    return vite_config_default({ command: "serve", mode: "development" });
  }
  return vite_config_default;
}
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...resolveViteConfig(),
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(
    "/assets",
    express.static(path2.resolve(distPath, "assets"), {
      maxAge: "1y",
      immutable: true
    })
  );
  app.use(
    express.static(distPath, {
      maxAge: "1h",
      // Exclude index.html from static serving - we handle it separately below
      index: false
    })
  );
  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/manus-proxy.ts
import { Router } from "express";
import axios from "axios";
import zlib from "zlib";
import { randomUUID } from "crypto";
import net from "net";

// server/upstream-config.ts
var UPSTREAM_VENDOR = ["ma", "nus"].join("");
var DEFAULT_UPSTREAM_BASE_URL = `https://api.${UPSTREAM_VENDOR}.im`;
function getUpstreamBaseUrl(req) {
  const configured = process.env.FRONTMIND_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL;
  const allowClientOverride = process.env.FRONTMIND_ALLOW_CLIENT_BASE_URL === "1";
  const clientBaseUrl = allowClientOverride && req ? String(req.headers["x-frontmind-base-url"] || "") : "";
  return (clientBaseUrl || configured).replace(/\/$/, "");
}
function getFrontMindApiKey(req) {
  return String(
    process.env.FRONTMIND_API_KEY || req.headers["x-frontmind-api-key"] || ""
  );
}
function getFrontMindCredentials(req) {
  return {
    apiKey: getFrontMindApiKey(req),
    baseUrl: getUpstreamBaseUrl(req)
  };
}
function toUpstreamAgentProfile(agentProfile) {
  switch (agentProfile) {
    case "frontmind-lite":
      return `${UPSTREAM_VENDOR}-1.6-lite`;
    case "frontmind-base":
      return `${UPSTREAM_VENDOR}-1.6`;
    case "frontmind-pro":
    case void 0:
    case "":
      return `${UPSTREAM_VENDOR}-1.6-max`;
    default:
      return agentProfile;
  }
}
function translateTaskBodyForUpstream(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const next = { ...body };
  if (typeof next.agentProfile === "string") {
    next.agentProfile = toUpstreamAgentProfile(next.agentProfile);
  }
  return next;
}

// server/manus-proxy.ts
var router2 = Router();
var fileMetaCache = /* @__PURE__ */ new Map();
var CACHE_TTL = 10 * 60 * 1e3;
var downloadTokenCache = /* @__PURE__ */ new Map();
var DOWNLOAD_TOKEN_TTL = 5 * 60 * 1e3;
var ExternalUrlRejectedError = class extends Error {
};
function isBlockedExternalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal" || host === "metadata.google.internal") {
    return true;
  }
  if (net.isIP(host) === 4) {
    const parts = host.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a >= 224;
  }
  if (net.isIP(host) === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.") || host.startsWith("::ffff:169.254.");
  }
  return false;
}
function assertSafeExternalUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ExternalUrlRejectedError("Invalid external URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ExternalUrlRejectedError("Unsupported external URL protocol");
  }
  if (parsed.username || parsed.password || isBlockedExternalHostname(parsed.hostname)) {
    throw new ExternalUrlRejectedError("Blocked external URL host");
  }
  return parsed.toString();
}
function cleanupExpiredDownloadTokens() {
  const now = Date.now();
  downloadTokenCache.forEach((data, token) => {
    if (now - data.createdAt > DOWNLOAD_TOKEN_TTL) {
      downloadTokenCache.delete(token);
    }
  });
}
function getCachedMeta(fileId) {
  const entry = fileMetaCache.get(fileId);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL) {
    return { upload_url: entry.upload_url, filename: entry.filename };
  }
  fileMetaCache.delete(fileId);
  return null;
}
function setCachedMeta(fileId, meta) {
  fileMetaCache.set(fileId, { ...meta, cachedAt: Date.now() });
}
function inferMimeType(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap = {
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
    webm: "video/webm"
  };
  return mimeMap[ext] || "application/octet-stream";
}
function isTextBasedFile(filename, contentType) {
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
    "proto"
  ];
  if (textExtensions.includes(ext)) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript") || ct.includes("markdown") || ct.includes("svg")) {
      return true;
    }
  }
  return false;
}
function isPdfFile(filename, contentType) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return true;
  if (contentType && contentType.toLowerCase().includes("application/pdf")) return true;
  return false;
}
function isPdfMagicBytes(data) {
  return data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-";
}
function getSourceBrandLower() {
  return ["ma", "nus"].join("");
}
function getSourceBrandTitle() {
  const lower = getSourceBrandLower();
  return lower[0].toUpperCase() + lower.slice(1);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sanitizeText(text) {
  if (!text || typeof text !== "string") return text || "";
  try {
    const sourceLower = getSourceBrandLower();
    const sourceTitle = getSourceBrandTitle();
    const sourceUpper = sourceLower.toUpperCase();
    return text.replace(new RegExp(`https?:\\/\\/api\\.${sourceLower}\\.`, "gi"), "https://api.frontmind.").replace(new RegExp(`https?:\\/\\/www\\.${sourceLower}\\.`, "gi"), "https://www.frontmind.").replace(new RegExp(`https?:\\/\\/${sourceLower}\\.`, "gi"), "https://frontmind.").replace(new RegExp(`\\b${escapeRegExp(sourceUpper)}\\b`, "g"), "FrontMind").replace(new RegExp(`\\b${escapeRegExp(sourceTitle)}\\b`, "g"), "FrontMind").replace(new RegExp(`\\b${escapeRegExp(sourceLower)}\\b`, "g"), "frontmind");
  } catch (e) {
    console.error("[sanitizeText] Error:", e);
    return text;
  }
}
function sanitizeFilename(filename, fallback = "file") {
  const sanitized = sanitizeText(filename || fallback).replace(/[\\/\0]/g, "_").trim();
  return sanitized || fallback;
}
function setSafeContentDisposition(res, disposition, filename) {
  const safeFileName = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safeFileName);
  res.setHeader("content-disposition", `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`);
}
function hasUsableExtension(filename) {
  const last = filename.split(/[\/]/).pop() || filename;
  return /\.[A-Za-z0-9]{1,10}$/.test(last);
}
function ensureFilenameMatchesContent(filename, data, contentType) {
  const safe = sanitizeFilename(filename);
  const lower = safe.toLowerCase();
  if ((isPdfMagicBytes(data) || isPdfFile(safe, contentType)) && !lower.endsWith(".pdf")) {
    return hasUsableExtension(safe) ? safe.replace(/\.[^.\/]+$/, ".pdf") : `${safe}.pdf`;
  }
  return safe;
}
function normalizeContentTypeForBuffer(filename, data, contentType) {
  const ct = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
  if (isPdfMagicBytes(data) || isPdfFile(filename, contentType)) {
    return "application/pdf";
  }
  if (!ct || ct === "application/octet-stream" || ct === "binary/octet-stream") {
    return inferMimeType(filename);
  }
  return contentType || inferMimeType(filename);
}
var SANITIZE_SKIP_KEYS = /* @__PURE__ */ new Set([
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
  "api_key",
  "apiKey",
  "token",
  "authorization",
  "base64",
  "data",
  "hash",
  "checksum",
  "etag",
  "previous_response_id",
  "previousResponseId",
  "task_url",
  "share_url"
]);
function deepSanitizeJson(value, currentKey, depth = 0) {
  if (value === null || value === void 0) return value;
  if (depth > 50) return value;
  if (typeof value === "string") {
    if (currentKey && SANITIZE_SKIP_KEYS.has(currentKey)) {
      return value;
    }
    if (value.match(/^[a-zA-Z0-9_-]{8,}$/) && !value.includes(" ")) {
      return value;
    }
    if (value.length > 1e5) {
      return value;
    }
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepSanitizeJson(item, void 0, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepSanitizeJson(val, key, depth + 1);
    }
    return result;
  }
  return value;
}
function sanitizeTextFileBuffer(data, filename, contentType) {
  if (!isTextBasedFile(filename, contentType)) {
    return { buffer: data, wasSanitized: false };
  }
  try {
    const text = data.toString("utf-8");
    const sanitized = sanitizeText(text);
    if (sanitized !== text) {
      console.log(`[FrontMind Proxy] Sanitized source-brand references in text file: ${filename}`);
      return { buffer: Buffer.from(sanitized, "utf-8"), wasSanitized: true };
    }
    return { buffer: data, wasSanitized: false };
  } catch (e) {
    return { buffer: data, wasSanitized: false };
  }
}
async function sanitizePdfBuffer(pdfBuffer) {
  try {
    const { PDFDocument, PDFName, decodePDFRawStream, PDFRawStream, StandardFonts, rgb, PDFHexString } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const context = pdfDoc.context;
    let pdfMetadataModified = false;
    const setSanitizedPdfStringMetadata = (getter, setter) => {
      try {
        const current = getter();
        if (!current) return;
        const sanitized = sanitizeText(current);
        if (sanitized !== current) {
          setter(sanitized);
          pdfMetadataModified = true;
        }
      } catch {
      }
    };
    setSanitizedPdfStringMetadata(() => pdfDoc.getTitle(), (value) => pdfDoc.setTitle(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getSubject(), (value) => pdfDoc.setSubject(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getAuthor(), (value) => pdfDoc.setAuthor(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getCreator(), (value) => pdfDoc.setCreator(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getProducer(), (value) => pdfDoc.setProducer(value));
    try {
      const infoRef = context.trailerInfo?.Info;
      const infoDict = infoRef ? context.lookup(infoRef) : void 0;
      const metadataKeys = ["Title", "Subject", "Author", "Creator", "Producer", "Keywords"];
      if (infoDict && typeof infoDict.lookup === "function" && typeof infoDict.set === "function") {
        for (const key of metadataKeys) {
          const pdfKey = PDFName.of(key);
          const currentValue = infoDict.lookup(pdfKey);
          const currentText = currentValue && typeof currentValue.decodeText === "function" ? currentValue.decodeText() : currentValue && typeof currentValue.asString === "function" ? currentValue.asString() : void 0;
          if (!currentText) continue;
          const sanitized = sanitizeText(currentText);
          if (sanitized !== currentText) {
            infoDict.set(pdfKey, PDFHexString.fromText(sanitized));
            pdfMetadataModified = true;
          }
        }
      }
    } catch {
    }
    const allCMaps = [];
    context.enumerateIndirectObjects().forEach(([_ref, obj]) => {
      if (!obj || obj.constructor.name !== "PDFRawStream") return;
      try {
        const decoded = decodePDFRawStream(obj);
        const cmapText = Buffer.from(decoded.decode()).toString("latin1");
        if (!cmapText.includes("beginbfchar") && !cmapText.includes("beginbfrange")) return;
        const unicodeToGlyph = /* @__PURE__ */ new Map();
        const glyphToUnicode = /* @__PURE__ */ new Map();
        const charMapRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let match;
        while ((match = charMapRegex.exec(cmapText)) !== null) {
          try {
            const glyphHex = match[1].toLowerCase().padStart(4, "0");
            const buf = Buffer.from(match[2], "hex");
            let unicodeChar = "";
            for (let i = 0; i < buf.length; i += 2) {
              if (i + 1 < buf.length) {
                unicodeChar += String.fromCharCode(buf[i] << 8 | buf[i + 1]);
              }
            }
            if (unicodeChar) {
              unicodeToGlyph.set(unicodeChar, glyphHex);
              glyphToUnicode.set(glyphHex, unicodeChar);
            }
          } catch {
          }
        }
        const bfrangeRegex = /beginbfrange\s*([\s\S]*?)\s*endbfrange/g;
        let rangeMatch;
        while ((rangeMatch = bfrangeRegex.exec(cmapText)) !== null) {
          const rangeEntryRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
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
      }
    });
    const sourceLower = getSourceBrandLower();
    const sourceTitle = getSourceBrandTitle();
    const sourceUpper = sourceLower.toUpperCase();
    const targetStrings = [
      `${sourceTitle} AI`,
      `${sourceUpper} AI`,
      `${sourceLower} AI`,
      sourceTitle,
      sourceUpper,
      sourceLower
    ];
    const glyphPatterns = [];
    for (const cmap of allCMaps) {
      for (const target of targetStrings) {
        const glyphs = [];
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
            glyphToUnicode: cmap.glyphToUnicode
          });
        }
      }
    }
    glyphPatterns.sort((a, b) => b.glyphs.length - a.glyphs.length);
    if (glyphPatterns.length === 0) {
      const rawStr = pdfBuffer.toString("latin1");
      const sourceTitleAi = `${sourceTitle} AI`;
      if (rawStr.includes(sourceTitleAi) || rawStr.includes(sourceTitle)) {
        let newStr = rawStr;
        newStr = newStr.replace(new RegExp(escapeRegExp(sourceTitleAi), "g"), "FrntMind");
        newStr = newStr.replace(new RegExp(`\\b${escapeRegExp(sourceTitle)}\\b`, "g"), "FrntM");
        if (newStr !== rawStr) {
          console.log("[FrontMind Proxy] PDF sanitized via ASCII binary replacement");
          return { buffer: Buffer.from(newStr, "latin1"), wasSanitized: true };
        }
      }
      if (pdfMetadataModified) {
        const savedBytes = await pdfDoc.save();
        console.log("[FrontMind Proxy] PDF metadata sanitized");
        return { buffer: Buffer.from(savedBytes), wasSanitized: true };
      }
      return { buffer: pdfBuffer, wasSanitized: false };
    }
    const overlayPositions = [];
    let totalModified = 0;
    const replacementTextForTarget = (_target) => "FrontMind";
    const estimateGlyphAdvance = (glyph, glyphToUnicode, fontSize) => {
      const char = glyphToUnicode.get(glyph);
      if (!char) return fontSize * 0.6;
      if (char === " ") return fontSize * 0.32;
      const codePoint = char.codePointAt(0) || 0;
      if (codePoint > 11904 || codePoint === 65306 || codePoint === 65288 || codePoint === 65289) {
        return fontSize;
      }
      if (/[ilI1.,:;|!]/.test(char)) return fontSize * 0.3;
      if (/[MW@#%]/.test(char)) return fontSize * 0.78;
      return fontSize * 0.56;
    };
    const splitGlyphHex = (rawHex) => {
      if (!rawHex) return [];
      const normalized = rawHex.length % 4 === 0 ? rawHex : rawHex.padStart(Math.ceil(rawHex.length / 4) * 4, "0");
      const chunks = [];
      for (let i = 0; i < normalized.length; i += 4) {
        chunks.push(normalized.slice(i, i + 4));
      }
      return chunks;
    };
    const calculateTjGlyphAdvance = (tokens, hexTokens, glyphIndexLimit, pattern, fontSize) => {
      let glyphIndex = 0;
      let advance = 0;
      for (const token of tokens) {
        if (token.kind === "number") {
          advance += -((token.value || 0) / 1e3) * fontSize;
          continue;
        }
        const hexToken = hexTokens[token.tokenIndex ?? -1];
        if (!hexToken) continue;
        for (const glyph of hexToken.chunks) {
          if (glyphIndex >= glyphIndexLimit) return advance;
          advance += estimateGlyphAdvance(glyph.toLowerCase().padStart(4, "0"), pattern.glyphToUnicode, fontSize);
          glyphIndex++;
        }
      }
      return advance;
    };
    const rebuildTjArrayBody = (body, hexTokens) => {
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
    const pages = pdfDoc.getPages();
    const streamRefToPageIndex = /* @__PURE__ */ new Map();
    const streamObjectToPageIndex = /* @__PURE__ */ new WeakMap();
    const registerPageContent = (content, pageIndex) => {
      if (!content) return;
      if (content.constructor?.name === "PDFRawStream") {
        streamObjectToPageIndex.set(content, pageIndex);
      }
      if (typeof content.toString === "function") {
        streamRefToPageIndex.set(content.toString(), pageIndex);
      }
      if (content.objectNumber !== void 0) {
        streamRefToPageIndex.set(`${content.objectNumber} ${content.generationNumber} R`, pageIndex);
      }
      if (typeof content.size === "function" && typeof content.get === "function") {
        for (let i = 0; i < content.size(); i++) {
          registerPageContent(content.get(i), pageIndex);
        }
      }
    };
    for (let pi = 0; pi < pages.length; pi++) {
      try {
        const contentsRef = pages[pi].node.Contents();
        registerPageContent(contentsRef, pi);
      } catch {
      }
    }
    context.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!obj || obj.constructor.name !== "PDFRawStream") return;
      try {
        const decoded = decodePDFRawStream(obj);
        const bytes = decoded.decode();
        const streamText = Buffer.from(bytes).toString("latin1");
        if (!streamText.includes("Tj") && !streamText.includes("TJ")) return;
        const lines = streamText.split("\n");
        const ctmStack = [
          { sx: 1, sy: 1, tx: 0, ty: 0 }
        ];
        let currentCtm = { sx: 1, sy: 1, tx: 0, ty: 0 };
        let currentFontSize = 0;
        let currentTm = null;
        let tdAccumX = 0;
        let tdAccumY = 0;
        const tjInfos = [];
        let streamModified = false;
        const getPageIndexForStream = () => {
          const objectPageIndex = streamObjectToPageIndex.get(obj);
          if (objectPageIndex !== void 0) return objectPageIndex;
          const refStr = ref.toString();
          let pageIndex = 0;
          let found = false;
          streamRefToPageIndex.forEach((idx, key) => {
            if (found) return;
            const refObjectNumber = refStr.split(" ")[0];
            const exactRefPattern = new RegExp(`(^|\\D)${refObjectNumber}\\s+0\\s+R(\\D|$)`);
            if (refStr === key || exactRefPattern.test(key)) {
              pageIndex = idx;
              found = true;
            }
          });
          return pageIndex;
        };
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === "q") {
            ctmStack.push({ ...currentCtm });
          }
          if (line === "Q") {
            if (ctmStack.length > 1) {
              ctmStack.pop();
              currentCtm = { ...ctmStack[ctmStack.length - 1] };
            }
          }
          const cmMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+cm$/
          );
          if (cmMatch) {
            const [a, , , d, e, f] = cmMatch.slice(1, 7).map(Number);
            const newCtm = {
              sx: currentCtm.sx * a,
              sy: currentCtm.sy * d,
              tx: currentCtm.sx * e + currentCtm.tx,
              ty: currentCtm.sy * f + currentCtm.ty
            };
            currentCtm = newCtm;
            ctmStack[ctmStack.length - 1] = { ...currentCtm };
          }
          const tmMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+Tm$/
          );
          if (tmMatch) {
            currentTm = tmMatch.slice(1, 7).map(Number);
            tdAccumX = 0;
            tdAccumY = 0;
          }
          if (line === "BT") {
            tdAccumX = 0;
            tdAccumY = 0;
          }
          const fontMatch = line.match(/^\/(\w+)\s+([\d.]+)\s+Tf$/);
          if (fontMatch) {
            currentFontSize = parseFloat(fontMatch[2]);
          }
          const tdTjMatch = line.match(/^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td\s+<([0-9a-fA-F]+)>\s+Tj$/);
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
              ctm: { ...currentCtm }
            });
            continue;
          }
          const tdMatch = line.match(/^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td$/);
          if (tdMatch) {
            tdAccumX += parseFloat(tdMatch[1]);
            tdAccumY += parseFloat(tdMatch[2]);
          }
          if (line.includes("TJ")) {
            const originalLine = lines[i];
            let lineWasModified = false;
            const arrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
            lines[i] = originalLine.replace(arrayRegex, (fullMatch, body) => {
              const hexTokens = [];
              const orderedTokens = [];
              const glyphs = [];
              const tokenRegex = /<([0-9a-fA-F]*)>|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
              let tokenMatch;
              while ((tokenMatch = tokenRegex.exec(body)) !== null) {
                if (tokenMatch[1] !== void 0) {
                  const tokenIndex = hexTokens.length;
                  const chunks = splitGlyphHex(tokenMatch[1]);
                  hexTokens.push({
                    start: tokenMatch.index,
                    end: tokenMatch.index + tokenMatch[0].length,
                    rawHex: tokenMatch[1],
                    chunks,
                    modified: false
                  });
                  orderedTokens.push({ kind: "hex", tokenIndex });
                  chunks.forEach((chunk, chunkIndex) => {
                    glyphs.push({
                      glyph: chunk.toLowerCase().padStart(4, "0"),
                      tokenIndex,
                      chunkIndex
                    });
                  });
                } else if (tokenMatch[2] !== void 0) {
                  orderedTokens.push({ kind: "number", value: Number(tokenMatch[2]) });
                }
              }
              if (glyphs.length === 0) return fullMatch;
              const replacedGlyphIndexes = /* @__PURE__ */ new Set();
              let arrayWasModified = false;
              for (const pattern of glyphPatterns) {
                const patLen = pattern.glyphs.length;
                if (patLen === 0 || glyphs.length < patLen) continue;
                for (let gi = 0; gi <= glyphs.length - patLen; gi++) {
                  if (replacedGlyphIndexes.has(gi)) continue;
                  let matches = true;
                  for (let pj = 0; pj < patLen; pj++) {
                    if (replacedGlyphIndexes.has(gi + pj) || glyphs[gi + pj].glyph !== pattern.glyphs[pj]) {
                      matches = false;
                      break;
                    }
                  }
                  if (!matches) continue;
                  for (let pj = 0; pj < patLen; pj++) {
                    const glyphInfo = glyphs[gi + pj];
                    const token = hexTokens[glyphInfo.tokenIndex];
                    const originalChunk = token.chunks[glyphInfo.chunkIndex] || "0000";
                    token.chunks[glyphInfo.chunkIndex] = pattern.spaceGlyph.toUpperCase().padStart(originalChunk.length, "0");
                    token.modified = true;
                    replacedGlyphIndexes.add(gi + pj);
                  }
                  arrayWasModified = true;
                  lineWasModified = true;
                  if (currentTm) {
                    const tm = currentTm;
                    const ctm = currentCtm;
                    const matchAdvance = calculateTjGlyphAdvance(orderedTokens, hexTokens, gi, pattern, currentFontSize);
                    const matchWidth = Math.max(
                      calculateTjGlyphAdvance(orderedTokens, hexTokens, gi + patLen, pattern, currentFontSize) - matchAdvance,
                      pattern.glyphs.length * currentFontSize * 0.55
                    );
                    const contentX = tm[4] + tdAccumX + matchAdvance;
                    const contentY = tm[5] + tdAccumY;
                    const pageX = ctm.sx * contentX + ctm.tx;
                    const pageY = ctm.sy * contentY + ctm.ty;
                    const effectiveFontSize = Math.abs(ctm.sx) * currentFontSize;
                    const pageWidth = Math.abs(ctm.sx) * matchWidth;
                    const pageIndex = getPageIndexForStream();
                    overlayPositions.push({
                      target: pattern.target,
                      replacementText: replacementTextForTarget(pattern.target),
                      pageX,
                      pageY,
                      pageWidth,
                      effectiveFontSize,
                      pageIndex
                    });
                    console.log(
                      `[FrontMind Proxy] PDF TJ overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`
                    );
                  }
                }
              }
              if (!arrayWasModified) return fullMatch;
              return `[${rebuildTjArrayBody(body, hexTokens)}] TJ`;
            });
            if (lineWasModified) {
              streamModified = true;
            }
          }
          const tjMatch = line.match(/^<([0-9a-fA-F]+)>\s+Tj$/);
          if (tjMatch) {
            const originalHex = tjMatch[1];
            const fullHexLower = originalHex.toLowerCase();
            if (fullHexLower.length >= 8 && fullHexLower.length % 4 === 0) {
              let multiGlyphMatched = false;
              for (const pattern of glyphPatterns) {
                const needle = pattern.glyphs.join("").toLowerCase();
                const matchOffset = fullHexLower.indexOf(needle);
                if (matchOffset < 0 || matchOffset % 4 !== 0) continue;
                const replacementHex = pattern.glyphs.map(() => pattern.spaceGlyph.toUpperCase().padStart(4, "0")).join("");
                const newHex = originalHex.slice(0, matchOffset) + replacementHex + originalHex.slice(matchOffset + needle.length);
                lines[i] = lines[i].replace(`<${originalHex}>`, `<${newHex}>`);
                streamModified = true;
                multiGlyphMatched = true;
                if (currentTm) {
                  const glyphOffset = matchOffset / 4;
                  const tm = currentTm;
                  const ctm = currentCtm;
                  const contentX = tm[4] + tdAccumX + glyphOffset * currentFontSize * 0.55;
                  const contentY = tm[5];
                  const pageX = ctm.sx * contentX + ctm.tx;
                  const pageY = ctm.sy * contentY + ctm.ty;
                  const effectiveFontSize = Math.abs(ctm.sx) * currentFontSize;
                  const pageWidth = Math.abs(ctm.sx) * pattern.glyphs.length * currentFontSize * 0.65;
                  const pageIndex = getPageIndexForStream();
                  overlayPositions.push({
                    target: pattern.target,
                    replacementText: replacementTextForTarget(pattern.target),
                    pageX,
                    pageY,
                    pageWidth,
                    effectiveFontSize,
                    pageIndex
                  });
                  console.log(
                    `[FrontMind Proxy] PDF multi-CID overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`
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
              ctm: { ...currentCtm }
            });
          }
        }
        const alreadyReplaced = /* @__PURE__ */ new Set();
        for (const pattern of glyphPatterns) {
          const patLen = pattern.glyphs.length;
          for (let i = 0; i <= tjInfos.length - patLen; i++) {
            if (alreadyReplaced.has(i)) continue;
            let matches = true;
            for (let j = 0; j < patLen; j++) {
              if (tjInfos[i + j].glyph !== pattern.glyphs[j] || alreadyReplaced.has(i + j)) {
                matches = false;
                break;
              }
            }
            if (matches) {
              console.log(`[FrontMind Proxy] FOUND "${pattern.target}" in PDF stream ${ref.toString()}`);
              for (let j = 0; j < patLen; j++) {
                const tj = tjInfos[i + j];
                const oldHex = tj.glyphHexInLine;
                const newHex = pattern.spaceGlyph.toUpperCase().padStart(oldHex.length, "0");
                lines[tj.lineIndex] = lines[tj.lineIndex].replace(`<${oldHex}>`, `<${newHex}>`);
                alreadyReplaced.add(i + j);
              }
              streamModified = true;
              const firstTj = tjInfos[i];
              if (firstTj.tm) {
                const tm = firstTj.tm;
                const ctm = firstTj.ctm;
                const contentX = tm[4] + firstTj.absX;
                const contentY = tm[5];
                const pageX = ctm.sx * contentX + ctm.tx;
                const pageY = ctm.sy * contentY + ctm.ty;
                const effectiveFontSize = Math.abs(ctm.sx) * firstTj.fontSize;
                let contentWidth = 0;
                for (let j = 1; j < patLen; j++) {
                  contentWidth += tjInfos[i + j].absX - tjInfos[i + j - 1].absX;
                }
                contentWidth += firstTj.fontSize * 0.6;
                const pageWidth = Math.abs(ctm.sx) * contentWidth;
                const pageIndex = getPageIndexForStream();
                overlayPositions.push({
                  target: pattern.target,
                  replacementText: replacementTextForTarget(pattern.target),
                  pageX,
                  pageY,
                  pageWidth,
                  effectiveFontSize,
                  pageIndex
                });
                console.log(
                  `[FrontMind Proxy] PDF overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`
                );
              }
            }
          }
        }
        if (streamModified) {
          const newText = lines.join("\n");
          const newBytes = Buffer.from(newText, "latin1");
          const compressed = zlib.deflateSync(newBytes);
          const dict = obj.dict.clone(context);
          dict.set(PDFName.of("Length"), context.obj(compressed.length));
          dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
          context.assign(ref, PDFRawStream.of(dict, compressed));
          totalModified++;
        }
      } catch {
      }
    });
    if (overlayPositions.length > 0) {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      for (const pos of overlayPositions) {
        const page = pages[pos.pageIndex] || pages[0];
        const replacementText = pos.replacementText;
        const replacementWidth = font.widthOfTextAtSize(replacementText, pos.effectiveFontSize);
        page.drawRectangle({
          x: pos.pageX - 1,
          y: pos.pageY - 2,
          width: Math.max(pos.pageWidth, replacementWidth) + 4,
          height: pos.effectiveFontSize + 4,
          color: rgb(1, 1, 1),
          opacity: 1
        });
        page.drawText(replacementText, {
          x: pos.pageX,
          y: pos.pageY,
          size: pos.effectiveFontSize,
          font,
          color: rgb(0, 0, 0)
        });
      }
    }
    if (totalModified > 0 || pdfMetadataModified) {
      const savedBytes = await pdfDoc.save();
      console.log(`[FrontMind Proxy] PDF sanitized: ${totalModified} stream(s) modified, ${overlayPositions.length} overlay(s) applied, metadata=${pdfMetadataModified}`);
      return { buffer: Buffer.from(savedBytes), wasSanitized: true };
    }
    return { buffer: pdfBuffer, wasSanitized: false };
  } catch (err) {
    console.error("[FrontMind Proxy] PDF sanitization error:", err.message);
    return { buffer: pdfBuffer, wasSanitized: false };
  }
}
function isOfficeXmlFile(filename, contentType) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const officeExtensions = ["docx", "xlsx", "pptx", "doc", "xls", "ppt"];
  if (officeExtensions.includes(ext)) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("officedocument") || ct.includes("msword") || ct.includes("ms-excel") || ct.includes("ms-powerpoint")) {
      return true;
    }
  }
  return false;
}
function isZipMagicBytes(data) {
  return data.length >= 4 && data[0] === 80 && data[1] === 75 && data[2] === 3 && data[3] === 4;
}
async function sanitizeOfficeXmlBuffer(data) {
  try {
    const JSZip2 = (await import("jszip")).default;
    const zip = await JSZip2.loadAsync(data);
    let modified = false;
    const fileNames = Object.keys(zip.files);
    for (const fname of fileNames) {
      const file = zip.files[fname];
      if (file.dir) continue;
      const lowerName = fname.toLowerCase();
      if (lowerName.endsWith(".xml") || lowerName.endsWith(".rels") || lowerName === "[content_types].xml") {
        try {
          const content = await file.async("string");
          const sanitized = sanitizeText(content);
          if (sanitized !== content) {
            zip.file(fname, sanitized);
            modified = true;
          }
        } catch {
        }
      }
    }
    if (modified) {
      const newBuffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });
      console.log(`[FrontMind Proxy] Office XML file sanitized`);
      return { buffer: newBuffer, wasSanitized: true };
    }
    return { buffer: data, wasSanitized: false };
  } catch (err) {
    console.error(`[FrontMind Proxy] Office XML sanitization error: ${err.message}`);
    return { buffer: data, wasSanitized: false };
  }
}
async function sanitizeFileBuffer(data, filename, contentType) {
  if (isPdfFile(filename, contentType) || isPdfMagicBytes(data)) {
    console.log(`[FrontMind Proxy] Detected PDF file: ${filename} (magic=${isPdfMagicBytes(data)}, ext/ct=${isPdfFile(filename, contentType)})`);
    return sanitizePdfBuffer(data);
  }
  if (isOfficeXmlFile(filename, contentType) || isZipMagicBytes(data) && !isTextBasedFile(filename, contentType)) {
    console.log(`[FrontMind Proxy] Detected Office XML file: ${filename}`);
    return sanitizeOfficeXmlBuffer(data);
  }
  return sanitizeTextFileBuffer(data, filename, contentType);
}
router2.put("/proxy-upload", async (req, res) => {
  try {
    const rawTarget = req.query.target;
    if (!rawTarget) {
      return res.status(400).json({ error: { message: "Missing target URL" } });
    }
    const target = assertSafeExternalUrl(rawTarget);
    console.log(`[FrontMind Proxy] Proxy-upload to: ${target.slice(0, 120)}...`);
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", resolve);
      req.on("error", reject);
    });
    let body = Buffer.concat(chunks);
    if (body.length === 0 && req.body != null) {
      if (Buffer.isBuffer(req.body)) {
        body = Buffer.from(req.body);
      } else if (typeof req.body === "string") {
        body = Buffer.from(req.body, "utf-8");
      } else if (typeof req.body === "object") {
        body = Buffer.from(JSON.stringify(req.body), "utf-8");
      }
      console.log(`[FrontMind Proxy] Recovered body from req.body (${body.length} bytes) \u2013 stream was consumed by body-parser`);
    }
    const realContentType = req.headers["x-original-content-type"] || req.headers["content-type"] || "application/octet-stream";
    const response = await axios.put(target, body, {
      headers: {
        "Content-Type": realContentType,
        "Content-Length": String(body.length)
      },
      timeout: 3e5,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true
    });
    console.log(`[FrontMind Proxy] Proxy-upload response: ${response.status}`);
    res.status(response.status).send(response.data || "");
  } catch (error) {
    if (error instanceof ExternalUrlRejectedError) {
      return res.status(400).json({
        error: {
          message: "\u5916\u90E8\u6587\u4EF6\u94FE\u63A5\u4E0D\u53EF\u7528",
          code: "INVALID_EXTERNAL_URL"
        }
      });
    }
    console.error("[FrontMind Proxy] Proxy-upload error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "PROXY_UPLOAD_ERROR"
      }
    });
  }
});
router2.get("/proxy-download", async (req, res) => {
  try {
    const rawTargetUrl = req.query.url;
    const requestedFilename = typeof req.query.filename === "string" ? req.query.filename : "";
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    if (!rawTargetUrl) {
      return res.status(400).json({ error: { message: "Missing url parameter" } });
    }
    const targetUrl = assertSafeExternalUrl(rawTargetUrl);
    console.log(`[FrontMind Proxy] Proxy-download: ${targetUrl.slice(0, 120)}...`);
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      timeout: 12e4,
      maxContentLength: Infinity,
      validateStatus: () => true
    });
    console.log(`[FrontMind Proxy] Proxy-download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`);
    res.status(response.status);
    const rawBuffer = Buffer.from(response.data);
    const urlFilenameRaw = targetUrl.split("/").pop()?.split("?")[0] || "file";
    const urlFilename = ensureFilenameMatchesContent(
      requestedFilename || decodeURIComponent(urlFilenameRaw),
      rawBuffer,
      response.headers["content-type"]
    );
    const finalContentType = normalizeContentTypeForBuffer(urlFilename, rawBuffer, response.headers["content-type"]);
    for (const header of ["cache-control", "etag", "last-modified"]) {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    }
    res.setHeader("content-type", finalContentType);
    setSafeContentDisposition(res, disposition, urlFilename);
    const { buffer: sanitizedBuffer, wasSanitized } = await sanitizeFileBuffer(
      rawBuffer,
      urlFilename,
      finalContentType
    );
    if (wasSanitized) {
      res.setHeader("content-length", String(sanitizedBuffer.length));
    } else if (response.headers["content-length"]) {
      res.setHeader("content-length", response.headers["content-length"]);
    }
    res.send(sanitizedBuffer);
  } catch (error) {
    if (error instanceof ExternalUrlRejectedError) {
      return res.status(400).json({
        error: {
          message: "\u5916\u90E8\u6587\u4EF6\u94FE\u63A5\u4E0D\u53EF\u7528",
          code: "INVALID_EXTERNAL_URL"
        }
      });
    }
    console.error("[FrontMind Proxy] Proxy-download error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "PROXY_DOWNLOAD_ERROR"
      }
    });
  }
});
async function fetchFileMetadata(baseUrl, fileId, apiKey) {
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
      Authorization: `Bearer ${apiKey}`
    },
    timeout: 3e4,
    validateStatus: () => true
  });
  if (response.status !== 200) {
    console.error(`[FrontMind Proxy] File metadata request failed: ${response.status}`);
    return null;
  }
  const data = response.data;
  console.log(`[FrontMind Proxy] File metadata: id=${data.id}, filename=${data.filename}, status=${data.status}, has_upload_url=${!!data.upload_url}`);
  if (data.upload_url) {
    const meta = { upload_url: data.upload_url, filename: data.filename || fileId };
    setCachedMeta(fileId, meta);
    return meta;
  }
  return { upload_url: "", filename: data.filename || fileId };
}
async function downloadFromS3(res, s3Url, filename, disposition = "inline") {
  console.log(`[FrontMind Proxy] Downloading from S3: ${s3Url.slice(0, 120)}...`);
  const response = await axios.get(s3Url, {
    responseType: "arraybuffer",
    timeout: 12e4,
    maxContentLength: Infinity,
    validateStatus: () => true
  });
  console.log(`[FrontMind Proxy] S3 download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`);
  if (response.status !== 200) {
    res.status(response.status);
    res.json({
      error: {
        message: `S3 download failed with status ${response.status}`,
        code: "S3_DOWNLOAD_ERROR"
      }
    });
    return;
  }
  res.status(200);
  const rawBuffer = Buffer.from(response.data);
  const finalFilename = ensureFilenameMatchesContent(filename, rawBuffer, response.headers["content-type"]);
  const finalContentType = normalizeContentTypeForBuffer(finalFilename, rawBuffer, response.headers["content-type"]);
  for (const header of ["cache-control", "etag", "last-modified"]) {
    if (response.headers[header]) {
      res.setHeader(header, response.headers[header]);
    }
  }
  res.setHeader("content-type", finalContentType);
  setSafeContentDisposition(res, disposition, finalFilename);
  const { buffer: sanitizedBuffer } = await sanitizeFileBuffer(
    rawBuffer,
    finalFilename,
    finalContentType
  );
  res.setHeader("content-length", String(sanitizedBuffer.length));
  res.send(sanitizedBuffer);
}
async function handleFileDownload(res, baseUrl, fileId, apiKey, disposition = "inline") {
  const meta = await fetchFileMetadata(baseUrl, fileId, apiKey);
  if (!meta) {
    res.status(404).json({
      error: {
        message: `File not found: ${fileId}`,
        code: "FILE_NOT_FOUND"
      }
    });
    return;
  }
  if (!meta.upload_url) {
    console.warn(`[FrontMind Proxy] No upload_url for file ${fileId}, trying direct API download`);
    const cleanBaseUrl = baseUrl.replace(/\/$/, "");
    const contentUrl = `${cleanBaseUrl}/v1/files/${fileId}/content`;
    try {
      const response = await axios.get(contentUrl, {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`
        },
        responseType: "arraybuffer",
        timeout: 12e4,
        maxContentLength: Infinity,
        validateStatus: () => true
      });
      if (response.status === 200 && response.headers["content-type"] !== "application/json") {
        console.log(`[FrontMind Proxy] Direct /content download succeeded: ${response.status}`);
        res.status(200);
        for (const header of ["content-type", "content-disposition"]) {
          if (response.headers[header]) {
            if (header === "content-disposition") {
              res.setHeader(header, sanitizeText(String(response.headers[header])));
            } else {
              res.setHeader(header, response.headers[header]);
            }
          }
        }
        const rawBuffer = Buffer.from(response.data);
        const finalFilename = ensureFilenameMatchesContent(meta.filename, rawBuffer, response.headers["content-type"]);
        const finalContentType = normalizeContentTypeForBuffer(finalFilename, rawBuffer, response.headers["content-type"]);
        res.setHeader("content-type", finalContentType);
        setSafeContentDisposition(res, disposition, finalFilename);
        const { buffer: sanitizedBuffer } = await sanitizeFileBuffer(
          rawBuffer,
          finalFilename,
          finalContentType
        );
        res.setHeader("content-length", String(sanitizedBuffer.length));
        res.send(sanitizedBuffer);
        return;
      }
    } catch (e) {
      console.warn(`[FrontMind Proxy] Direct /content download failed: ${e.message}`);
    }
    res.status(404).json({
      error: {
        message: `No download URL available for file ${fileId}`,
        code: "NO_DOWNLOAD_URL"
      }
    });
    return;
  }
  await downloadFromS3(res, meta.upload_url, meta.filename, disposition);
}
router2.post("/download-token", async (req, res) => {
  try {
    cleanupExpiredDownloadTokens();
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    const fileId = req.body?.fileId || "";
    if (!apiKey) {
      return res.status(401).json({ error: { message: "Missing API key", code: "MISSING_API_KEY" } });
    }
    if (!fileId) {
      return res.status(400).json({ error: { message: "Missing fileId", code: "MISSING_FILE_ID" } });
    }
    const token = randomUUID();
    downloadTokenCache.set(token, { fileId, apiKey, baseUrl, createdAt: Date.now() });
    res.json({ downloadUrl: `/api/frontmind/download/${token}`, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL });
  } catch (error) {
    console.error("[FrontMind Proxy] Create download token error:", error.message);
    res.status(500).json({ error: { message: "\u521B\u5EFA\u4E0B\u8F7D\u94FE\u63A5\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "DOWNLOAD_TOKEN_ERROR" } });
  }
});
router2.get("/download/:token", async (req, res) => {
  try {
    cleanupExpiredDownloadTokens();
    const token = req.params.token;
    const data = downloadTokenCache.get(token);
    if (!data) {
      return res.status(410).json({ error: { message: "Download link expired", code: "DOWNLOAD_LINK_EXPIRED" } });
    }
    downloadTokenCache.delete(token);
    await handleFileDownload(res, data.baseUrl, data.fileId, data.apiKey, "attachment");
  } catch (error) {
    console.error("[FrontMind Proxy] Direct token download error:", error.message);
    res.status(500).json({ error: { message: "\u4E0B\u8F7D\u94FE\u63A5\u5DF2\u5931\u6548\u6216\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25", code: "DIRECT_DOWNLOAD_ERROR" } });
  }
});
router2.get("/v1/files/:fileId", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    const fileId = req.params.fileId;
    await handleFileDownload(res, baseUrl, fileId, apiKey);
  } catch (error) {
    console.error("[FrontMind Proxy] File download error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "FILE_DOWNLOAD_ERROR"
      }
    });
  }
});
router2.get("/v1/files/:fileId/content", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    const fileId = req.params.fileId;
    await handleFileDownload(res, baseUrl, fileId, apiKey);
  } catch (error) {
    console.error("[FrontMind Proxy] File content download error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u5185\u5BB9\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "FILE_CONTENT_ERROR"
      }
    });
  }
});
router2.all("/*", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    if (!apiKey) {
      return res.status(401).json({ error: { message: "Missing API key", code: "MISSING_API_KEY" } });
    }
    const targetPath = req.originalUrl.replace(/^\/api\/frontmind/, "");
    const targetUrl = `${baseUrl.replace(/\/$/, "")}${targetPath}`;
    console.log(`[FrontMind Proxy] ${req.method} ${targetPath}`);
    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
      API_KEY: apiKey,
      Authorization: `Bearer ${apiKey}`
    };
    const axiosConfig = {
      method: req.method,
      url: targetUrl,
      headers,
      timeout: 3e5,
      validateStatus: () => true
    };
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      axiosConfig.data = translateTaskBodyForUpstream(req.body);
    }
    const response = await axios(axiosConfig);
    if (typeof response.data === "object" && response.data?.output) {
      const outputSummary = response.data.output.map(
        (item, i) => `${i}:${item.type || "message"}${item.id ? "(" + item.id.slice(0, 8) + ")" : ""}`
      ).join(", ");
      console.log(`[FrontMind Proxy] Response: ${response.status} id=${response.data.id?.slice(0, 12)} status=${response.data.status} output=[${response.data.output.length} items: ${outputSummary.slice(0, 300)}]`);
    } else {
      console.log(`[FrontMind Proxy] Response: ${response.status}`, typeof response.data === "object" ? JSON.stringify(response.data).slice(0, 200) : "");
    }
    res.status(response.status);
    if (response.headers["content-type"]) {
      res.setHeader("content-type", response.headers["content-type"]);
    }
    if (typeof response.data === "object") {
      const sanitized = deepSanitizeJson(response.data);
      res.json(sanitized);
    } else if (typeof response.data === "string") {
      res.send(sanitizeText(response.data));
    } else {
      res.send(response.data);
    }
  } catch (error) {
    console.error("[FrontMind Proxy] Error:", error.message);
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      res.status(502).json({
        error: {
          message: "\u65E0\u6CD5\u8FDE\u63A5\u5230\u670D\u52A1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u68C0\u67E5\u914D\u7F6E",
          code: "PROXY_CONNECTION_ERROR"
        }
      });
    } else if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
      res.status(504).json({
        error: {
          message: "API \u8BF7\u6C42\u8D85\u65F6",
          code: "PROXY_TIMEOUT"
        }
      });
    } else {
      res.status(500).json({
        error: {
          message: "\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
          code: "PROXY_ERROR"
        }
      });
    }
  }
});
var manus_proxy_default = router2;

// server/workflow-api.ts
import { randomUUID as randomUUID2 } from "crypto";
import fs4 from "fs/promises";
import path4 from "path";
import axios2 from "axios";
import express2, { Router as Router2 } from "express";
import JSZip from "jszip";

// server/workflow/manifest.ts
import fs3 from "fs/promises";
import path3 from "path";
var commonControlSources = [
  "Master_Control/FrontMind_Master_Control.md",
  "00.FrontMind\u603B\u63A7\u8DEF\u7531.skill"
];
function strategySources(...sources) {
  return [
    ...commonControlSources,
    "Strategy_Workflow/shared",
    ...sources
  ];
}
function executionSources(...sources) {
  return [
    ...commonControlSources,
    "Execution_Workflow/shared",
    ...sources
  ];
}
function step(data) {
  return data;
}
var steps = [
  step({
    id: "S0",
    layer: "strategy",
    kind: "agent",
    sequence: 10,
    title: "\u7B56\u7565\u7F16\u6392",
    buttonLabel: "\u542F\u52A8\u7B56\u7565",
    description: "\u5EFA\u7ACB\u7B56\u7565\u5C42\u4EFB\u52A1\u4E0A\u4E0B\u6587\uFF0C\u786E\u8BA4\u54C1\u724C\u76EE\u6807\u3001\u8D44\u6599\u8FB9\u754C\u548C\u4EA7\u7269\u8DEF\u7EBF\u3002",
    owner: "S0 \u7B56\u7565\u7F16\u6392\u5E08",
    inputs: ["\u54C1\u724C\u540D\u79F0", "\u4E1A\u52A1\u76EE\u6807", "\u5DF2\u6709\u8D44\u6599"],
    outputs: ["\u7B56\u7565\u4EFB\u52A1\u8DEF\u7531", "\u6267\u884C\u987A\u5E8F", "\u5F85\u786E\u8BA4\u6E05\u5355"],
    dependencies: [],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S0.\u7B56\u7565\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "S1",
    layer: "strategy",
    kind: "agent",
    sequence: 20,
    title: "\u7B56\u7565\u542F\u52A8\u4E0E\u54C1\u724C\u4E8B\u5B9E",
    buttonLabel: "\u542F\u52A8\u54C1\u724C\u4E8B\u5B9E",
    description: "\u5EFA\u7ACB\u7B56\u7565\u4E0A\u4E0B\u6587\uFF0C\u5E76\u62BD\u53D6\u54C1\u724C\u3001\u4EA7\u54C1\u3001\u6E20\u9053\u3001\u5BA2\u6237\u4E0E\u8BC1\u636E\uFF0C\u5F62\u6210\u7EDF\u4E00\u4E8B\u5B9E\u5E95\u5EA7\u3002",
    owner: "S1 \u54C1\u724C\u4E8B\u5B9E\u4E0E\u7B56\u7565\u7F16\u6392",
    inputs: ["\u54C1\u724C\u540D\u79F0", "\u4E1A\u52A1\u76EE\u6807", "\u5DF2\u6709\u8D44\u6599", "\u5B98\u7F51", "\u4EA7\u54C1\u8D44\u6599", "\u9500\u552E\u8D44\u6599"],
    outputs: ["\u7B56\u7565\u4EFB\u52A1\u8DEF\u7531", "brand_facts.json", "brand_knowledge.md", "\u5F85\u786E\u8BA4\u6E05\u5355"],
    dependencies: [],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources(
      "Strategy_Workflow/S0.\u7B56\u7565\u7F16\u6392\u5E08.skill",
      "Strategy_Workflow/S1.\u54C1\u724C\u8D44\u4EA7\u77E5\u8BC6\u5E93.skill"
    )
  }),
  step({
    id: "SP1",
    layer: "strategy",
    kind: "pause",
    sequence: 30,
    title: "\u786E\u8BA4\u54C1\u724C\u4E8B\u5B9E",
    buttonLabel: "\u786E\u8BA4\u4E8B\u5B9E",
    description: "\u4EBA\u5DE5\u786E\u8BA4 S1 \u7684\u54C1\u724C\u4E8B\u5B9E\u56FE\u8C31\uFF0C\u907F\u514D\u540E\u7EED\u7B56\u7565\u5EFA\u7ACB\u5728\u9519\u8BEF\u8D44\u6599\u4E0A\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 1",
    inputs: ["S1 \u4EA7\u7269", "\u4FEE\u6B63\u610F\u89C1"],
    outputs: ["\u4E8B\u5B9E\u786E\u8BA4\u8BB0\u5F55"],
    dependencies: ["S1"],
    phase: "\u7B56\u7565\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "S2",
    layer: "strategy",
    kind: "agent",
    sequence: 40,
    title: "\u8425\u9500\u56FE\u8C31",
    buttonLabel: "\u8425\u9500\u56FE\u8C31",
    description: "\u5EFA\u7ACB\u7528\u6237\u573A\u666F\u3001\u641C\u7D22\u610F\u56FE\u3001\u95EE\u9898\u7C07\u4E0E AI \u95EE\u7B54\u63A2\u9488\u3002",
    owner: "S2 \u8425\u9500\u56FE\u8C31\u4E13\u5BB6",
    inputs: ["\u54C1\u724C\u4E8B\u5B9E", "\u5BA2\u6237\u573A\u666F"],
    outputs: ["\u7528\u6237-\u573A\u666F-\u610F\u56FE\u4E09\u5143\u7EC4", "AI \u63A2\u9488\u95EE\u9898"],
    dependencies: ["SP1"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S2.\u8425\u9500\u56FE\u8C31\u4E13\u5BB6.skill")
  }),
  step({
    id: "S3",
    layer: "strategy",
    kind: "agent",
    sequence: 50,
    title: "\u54C1\u7C7B\u8D8B\u52BF",
    buttonLabel: "\u54C1\u7C7B\u8D8B\u52BF",
    description: "\u5224\u65AD\u54C1\u7C7B\u641C\u7D22\u8D8B\u52BF\u3001\u7ADE\u4E89\u5F3A\u5EA6\u3001AI \u63A8\u8350\u8BED\u5883\u548C\u673A\u4F1A\u7A97\u53E3\u3002",
    owner: "S3 \u54C1\u7C7B\u8D8B\u52BF\u7814\u5224\u5E08",
    inputs: ["\u54C1\u7C7B\u5173\u952E\u8BCD", "\u7ADE\u4E89\u54C1\u724C"],
    outputs: ["\u8D8B\u52BF\u7814\u5224\u62A5\u544A", "\u54C1\u7C7B\u673A\u4F1A\u8BC4\u5206"],
    dependencies: ["S2"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S3.\u54C1\u7C7B\u8D8B\u52BF\u7814\u5224\u5E08.skill")
  }),
  step({
    id: "S4",
    layer: "strategy",
    kind: "agent",
    sequence: 60,
    title: "\u54C1\u724C\u5B9A\u4F4D",
    buttonLabel: "\u54C1\u724C\u5B9A\u4F4D",
    description: "\u5F62\u6210\u54C1\u724C\u5B9A\u4F4D\u58F0\u660E\u3001\u5DEE\u5F02\u5316\u77E9\u9635\u548C\u6838\u5FC3\u7ADE\u4E89\u7406\u7531\u3002",
    owner: "S4 \u54C1\u724C\u5B9A\u4F4D\u5206\u6790\u5E08",
    inputs: ["\u54C1\u724C\u4E8B\u5B9E", "\u8D8B\u52BF\u7814\u5224", "\u7ADE\u54C1\u8D44\u6599"],
    outputs: ["\u5B9A\u4F4D\u58F0\u660E", "\u5DEE\u5F02\u5316\u77E9\u9635"],
    dependencies: ["S3"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S4.\u54C1\u724C\u5B9A\u4F4D\u5206\u6790\u5E08.skill")
  }),
  step({
    id: "SP2",
    layer: "strategy",
    kind: "pause",
    sequence: 70,
    title: "\u8D44\u6599\u8865\u5145\u5224\u65AD",
    buttonLabel: "\u8865\u5145\u5224\u65AD",
    description: "\u51B3\u5B9A\u662F\u5426\u8FDB\u5165\u54C1\u724C\u8D44\u6599\u8865\u5145\u8868\uFF0C\u8865\u9F50\u5B9A\u4F4D\u4E0E\u8BCA\u65AD\u524D\u7684\u7F3A\u53E3\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 2",
    inputs: ["S4 \u4EA7\u7269", "\u8D44\u6599\u7F3A\u53E3"],
    outputs: ["\u8D44\u6599\u8865\u5145\u5224\u65AD", "pause_2 \u8BB0\u5F55"],
    dependencies: ["S4"],
    phase: "\u7B56\u7565\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "SP3",
    layer: "strategy",
    kind: "pause",
    sequence: 80,
    title: "\u5730\u57DF\u4E0E\u76D1\u6D4B\u6570\u636E",
    buttonLabel: "\u5730\u57DF\u6570\u636E",
    description: "\u9009\u62E9 AI \u53EF\u89C1\u6027\u76D1\u6D4B\u5730\u57DF\uFF0C\u590D\u7528 S2/S4.5 \u4EE3\u8868\u9898\uFF0C\u5E76\u4E0A\u4F20\u6216\u786E\u8BA4\u76D1\u6D4B\u6570\u636E\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 3",
    inputs: ["\u76EE\u6807\u5730\u57DF", "AI \u53EF\u89C1\u6027\u6570\u636E", "S2 15 \u4E2A\u4EE3\u8868\u9898"],
    outputs: ["\u5730\u57DF\u8303\u56F4", "\u76D1\u6D4B\u6570\u636E\u7D22\u5F15"],
    dependencies: ["SP2"],
    phase: "\u7B56\u7565\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "S5",
    layer: "strategy",
    kind: "agent",
    sequence: 90,
    title: "AI \u53EF\u89C1\u6027\u8BCA\u65AD",
    buttonLabel: "\u53EF\u89C1\u6027\u8BCA\u65AD",
    description: "\u5206\u6790\u54C1\u724C\u5728 AI \u641C\u7D22\u3001\u95EE\u7B54\u3001\u63A8\u8350\u8BED\u5883\u4E2D\u7684\u51FA\u73B0\u7387\u4E0E\u7F3A\u53E3\u3002",
    owner: "S5 \u54C1\u724C\u8BCA\u65AD\u4E13\u5BB6",
    inputs: ["\u76D1\u6D4B\u6570\u636E", "\u54C1\u724C\u4E8B\u5B9E", "\u5B9A\u4F4D\u58F0\u660E"],
    outputs: ["AI \u53EF\u89C1\u6027\u8BCA\u65AD", "\u7F3A\u53E3\u62A5\u544A"],
    dependencies: ["SP3"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S5.\u54C1\u724C\u8BCA\u65AD\u4E13\u5BB6.skill")
  }),
  step({
    id: "S5_5",
    layer: "strategy",
    kind: "agent",
    sequence: 100,
    title: "\u8BED\u4E49\u8D44\u4EA7\u5BA1\u8BA1",
    buttonLabel: "\u8BED\u4E49\u5BA1\u8BA1",
    description: "\u8BC4\u4F30\u54C1\u724C\u5728\u8BED\u4E49\u8D44\u4EA7\u3001\u5B9E\u4F53\u5173\u7CFB\u548C\u53EF\u5F15\u7528\u8BC1\u636E\u4E0A\u7684\u5B8C\u6574\u5EA6\u3002",
    owner: "S5.5 \u54C1\u724C\u8BED\u4E49\u8D44\u4EA7\u5BA1\u8BA1\u5E08",
    inputs: ["S5 \u8BCA\u65AD", "\u54C1\u724C\u77E5\u8BC6\u5E93"],
    outputs: ["\u8BED\u4E49\u8D44\u4EA7\u8BC4\u5206\u5361", "\u8865\u5F3A\u5EFA\u8BAE"],
    dependencies: ["S5"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S5.5.\u54C1\u724C\u8BED\u4E49\u8D44\u4EA7\u5BA1\u8BA1\u5E08.skill")
  }),
  step({
    id: "S6",
    layer: "strategy",
    kind: "agent",
    sequence: 110,
    title: "\u8BDD\u8BED\u4F53\u7CFB",
    buttonLabel: "\u8BDD\u8BED\u4F53\u7CFB",
    description: "\u6C89\u6DC0\u54C1\u724C\u8BED\u6C14\u3001\u4EF7\u503C\u8868\u8FBE\u3001\u6838\u5FC3\u53E5\u5F0F\u548C\u53EF\u590D\u7528\u8BED\u8A00\u8D44\u4EA7\u3002",
    owner: "S6 \u54C1\u724C\u8BDD\u8BED\u4F53\u7CFB",
    inputs: ["\u5B9A\u4F4D\u58F0\u660E", "\u8BED\u4E49\u5BA1\u8BA1"],
    outputs: ["\u54C1\u724C\u8BDD\u8BED\u624B\u518C", "brand_voice_token.json"],
    dependencies: ["S5_5"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S6.\u54C1\u724C\u8BDD\u8BED\u4F53\u7CFB.skill")
  }),
  step({
    id: "S7",
    layer: "strategy",
    kind: "agent",
    sequence: 120,
    title: "\u89C6\u89C9\u7B26\u53F7",
    buttonLabel: "\u89C6\u89C9\u4F53\u7CFB",
    description: "\u5B9A\u4E49\u54C1\u724C\u89C6\u89C9\u63D0\u793A\u8BCD\u3001\u753B\u9762\u98CE\u683C\u3001\u7981\u7528\u5143\u7D20\u548C\u8D44\u4EA7\u751F\u6210\u89C4\u8303\u3002",
    owner: "S7 \u89C6\u89C9\u7B26\u53F7\u4F53\u7CFB",
    inputs: ["\u54C1\u724C\u5B9A\u4F4D", "\u8BDD\u8BED\u4F53\u7CFB"],
    outputs: ["visual_prompt_pack.json", "\u89C6\u89C9\u89C4\u8303"],
    dependencies: ["S6"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S7.\u89C6\u89C9\u7B26\u53F7\u4F53\u7CFB.skill")
  }),
  step({
    id: "S8",
    layer: "strategy",
    kind: "agent",
    sequence: 130,
    title: "\u95EE\u7B54\u67B6\u6784",
    buttonLabel: "\u95EE\u7B54\u77E9\u9635",
    description: "\u89C4\u5212 AI \u53EF\u5F15\u7528\u5185\u5BB9\u7684\u95EE\u7B54\u6811\u3001\u5185\u5BB9\u77E9\u9635\u3001\u4E3B\u9898\u65E5\u5386\u548C\u843D\u5730\u9875\u84DD\u56FE\u3002",
    owner: "S8 \u95EE\u7B54\u67B6\u6784\u5E08",
    inputs: ["\u8425\u9500\u56FE\u8C31", "\u8BDD\u8BED\u4F53\u7CFB", "\u89C6\u89C9\u89C4\u8303"],
    outputs: ["QA tree", "\u5185\u5BB9\u77E9\u9635", "\u5185\u5BB9\u65E5\u5386", "\u843D\u5730\u9875\u84DD\u56FE"],
    dependencies: ["S7"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S8.\u95EE\u7B54\u67B6\u6784\u5E08.skill")
  }),
  step({
    id: "S9",
    layer: "strategy",
    kind: "agent",
    sequence: 140,
    title: "\u4E1A\u52A1\u8D4B\u80FD\u89C4\u5212",
    buttonLabel: "\u4E1A\u52A1\u8D4B\u80FD",
    description: "\u6C47\u603B S1-S8 \u4F01\u4E1A\u95EE\u9898\uFF0C\u8F6C\u4E3A GEO \u4E1A\u52A1\u5EFA\u8BAE\u4E0E\u4F18\u5148\u884C\u52A8\u6E05\u5355\u3002",
    owner: "S9 \u4E1A\u52A1\u8D4B\u80FD\u89C4\u5212\u5E08",
    inputs: ["S1-S8 \u4EA7\u7269"],
    outputs: ["GEO \u884C\u52A8\u6E05\u5355", "\u4E1A\u52A1\u8D4B\u80FD\u5EFA\u8BAE"],
    dependencies: ["S8"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S9.\u4E1A\u52A1\u8D4B\u80FD\u89C4\u5212\u5E08.skill")
  }),
  step({
    id: "S10",
    layer: "strategy",
    kind: "agent",
    sequence: 150,
    title: "\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868",
    buttonLabel: "\u786E\u8BA4\u8868",
    description: "\u57FA\u4E8E S1-S9 \u7B56\u7565\u6210\u679C\u548C\u5E94\u7B54\u903B\u8F91\u786E\u8BA4\u8868\uFF0C\u751F\u6210\u5BA2\u6237\u6700\u7EC8\u786E\u8BA4\u7528\u7684\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868\u3002",
    owner: "S10 \u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868\u751F\u6210\u5E08",
    inputs: ["S1-S9 \u8D44\u6599\u5305", "\u5E94\u7B54\u903B\u8F91\u786E\u8BA4\u8868", "\u5BA2\u6237\u786E\u8BA4\u53E3\u5F84"],
    outputs: [
      "S10_{brand}_\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868.xlsx",
      "{brand}_\u54C1\u724C\u4FE1\u606F\u4FEE\u6539\u6E05\u5355.json"
    ],
    dependencies: ["S9"],
    phase: "\u7B56\u7565\u5C42\u6700\u7EC8\u786E\u8BA4",
    privateSources: strategySources("Strategy_Workflow/S10.\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868\u751F\u6210\u5E08.skill")
  }),
  step({
    id: "STRATEGY_PACK",
    layer: "strategy",
    kind: "export",
    sequence: 160,
    title: "\u7B56\u7565\u5305\u5BFC\u51FA",
    buttonLabel: "\u5BFC\u51FA\u7B56\u7565\u5305",
    description: "\u5C01\u88C5 S1-S10 \u5DE5\u7A0B\u8D44\u4EA7\u4E0E\u5BA2\u6237\u786E\u8BA4\u8BB0\u5F55\uFF0C\u5F62\u6210\u6267\u884C\u5C42\u552F\u4E00\u4EA4\u63A5\u6587\u4EF6\u3002",
    owner: "S0 \u7B56\u7565\u7F16\u6392\u5E08",
    inputs: ["S1-S10 \u5DE5\u7A0B\u4EA7\u7269", "\u5BA2\u6237\u786E\u8BA4\u8BB0\u5F55", "pause_log"],
    outputs: ["S0_{brand}_strategy_pack_vN.json", "\u7B56\u7565\u5C42\u6267\u884C\u65E5\u5FD7"],
    dependencies: ["S10"],
    phase: "\u7B56\u7565\u5C42\u4EA4\u4ED8",
    privateSources: strategySources("Strategy_Workflow/S0.\u7B56\u7565\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "E0",
    layer: "execution",
    kind: "agent",
    sequence: 210,
    title: "\u6267\u884C\u7F16\u6392",
    buttonLabel: "\u5BFC\u5165\u7B56\u7565\u5305",
    description: "\u8BFB\u53D6 strategy_pack\uFF0C\u5EFA\u7ACB\u6267\u884C\u5C42\u4EFB\u52A1\u4E0A\u4E0B\u6587\u4E0E\u4EA7\u7269\u8DEF\u7EBF\u3002",
    owner: "E0 \u6267\u884C\u7F16\u6392\u5E08",
    inputs: ["strategy_pack_vN.json", "recommended_business_actions", "\u4F01\u4E1A\u63D0\u4EA4\u56FE\u7247\u5E93"],
    outputs: ["\u6267\u884C\u8DEF\u7531", "\u4EFB\u52A1\u62C6\u5206", "\u56FE\u7247\u5E93\u6821\u9A8C\u62A5\u544A"],
    dependencies: ["STRATEGY_PACK"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E0.\u6267\u884C\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "E1",
    layer: "execution",
    kind: "agent",
    sequence: 220,
    title: "\u5185\u5BB9\u7B56\u7565\u83DC\u5355",
    buttonLabel: "\u5185\u5BB9\u83DC\u5355",
    description: "\u751F\u6210\u4E3B\u9898\u77E9\u9635\u3001\u4F18\u5148\u7EA7\u3001\u5185\u5BB9\u7C7B\u578B\u548C\u5F85\u751F\u4EA7\u6E05\u5355\u3002",
    owner: "E1 \u5185\u5BB9\u7B56\u7565\u5E08",
    inputs: ["strategy_pack", "\u4E1A\u52A1\u76EE\u6807"],
    outputs: ["topic_matrix.json", "content_menu.md"],
    dependencies: ["E0"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E1.\u5185\u5BB9\u7B56\u7565\u5E08.skill")
  }),
  step({
    id: "EP4",
    layer: "execution",
    kind: "pause",
    sequence: 230,
    title: "\u5BA1\u6279\u751F\u4EA7\u5185\u5BB9",
    buttonLabel: "\u5BA1\u6279\u5185\u5BB9",
    description: "\u786E\u8BA4\u672C\u8F6E\u8981\u751F\u4EA7\u7684\u6587\u7AE0\u3001\u7D20\u6750\u548C\u4F18\u5148\u7EA7\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 4",
    inputs: ["E1 \u83DC\u5355", "\u5BA1\u6279\u610F\u89C1"],
    outputs: ["\u5DF2\u6279\u51C6\u5185\u5BB9\u6E05\u5355"],
    dependencies: ["E1"],
    phase: "\u6267\u884C\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "E2",
    layer: "execution",
    kind: "agent",
    sequence: 240,
    title: "\u6587\u5B57\u5185\u5BB9\u751F\u6210",
    buttonLabel: "\u751F\u6210\u6587\u7AE0",
    description: "\u6309\u83B7\u6279\u4E3B\u9898\u751F\u6210\u6587\u7AE0\u3001FAQ\u3001\u6458\u8981\u548C\u56FE\u7247\u9700\u6C42\u8BF4\u660E\u3002",
    owner: "E2 \u6587\u5B57\u5185\u5BB9\u751F\u6210\u5E08",
    inputs: ["\u83B7\u6279\u4E3B\u9898", "\u8BDD\u8BED\u4F53\u7CFB", "\u5185\u5BB9\u8981\u6C42"],
    outputs: ["article.md", "image_requirements.json"],
    dependencies: ["EP4"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E2.\u6587\u5B57\u5185\u5BB9\u751F\u6210\u5E08.skill")
  }),
  step({
    id: "E3",
    layer: "execution",
    kind: "agent",
    sequence: 250,
    title: "\u89C6\u89C9\u8D44\u4EA7\u751F\u6210",
    buttonLabel: "\u751F\u6210\u89C6\u89C9",
    description: "\u6839\u636E\u89C6\u89C9\u89C4\u8303\u4E0E\u56FE\u7247\u9700\u6C42\u751F\u6210\u6216\u7EC4\u7EC7\u56FE\u7247\u8D44\u4EA7\u3002",
    owner: "E3 \u89C6\u89C9\u8D44\u4EA7\u751F\u6210\u5E08",
    inputs: ["image_requirements", "visual_prompt_pack"],
    outputs: ["\u89C6\u89C9\u56FE\u7247", "\u6821\u9A8C\u8BB0\u5F55"],
    dependencies: ["E2"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E3.\u89C6\u89C9\u8D44\u4EA7\u751F\u6210\u5E08.skill")
  }),
  step({
    id: "E4",
    layer: "execution",
    kind: "agent",
    sequence: 260,
    title: "\u5BA1\u67E5\u4E0E\u7EC4\u88C5",
    buttonLabel: "\u5BA1\u67E5\u7EC4\u88C5",
    description: "\u5B8C\u6210\u8D28\u91CF\u68C0\u67E5\u3001\u54C1\u724C\u4E00\u81F4\u6027\u5BA1\u67E5\u548C\u6587\u6863\u88C5\u914D\u3002",
    owner: "E4 \u8D28\u91CF\u5BA1\u67E5\u4E0E\u7EC4\u88C5\u5E08",
    inputs: ["\u6587\u7AE0", "\u56FE\u7247", "\u54C1\u724C\u89C4\u5219"],
    outputs: ["DOCX", "\u8D28\u91CF\u5BA1\u67E5\u62A5\u544A"],
    dependencies: ["E3"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources(
      "Execution_Workflow/E4.\u8D28\u91CF\u5BA1\u67E5\u4E0E\u7EC4\u88C5\u5E08.skill"
    )
  }),
  step({
    id: "E5",
    layer: "execution",
    kind: "agent",
    sequence: 270,
    title: "\u5206\u53D1\u7F16\u6392",
    buttonLabel: "\u5206\u53D1\u7F16\u6392",
    description: "\u9002\u914D\u6E20\u9053\u3001\u751F\u6210\u5206\u53D1\u8BA1\u5212\u548C GEO \u4F18\u5316\u5EFA\u8BAE\u3002",
    owner: "E5 \u5206\u53D1\u7F16\u6392\u5E08",
    inputs: ["\u5DF2\u5BA1\u5185\u5BB9", "\u6E20\u9053\u8981\u6C42"],
    outputs: ["channel_plan.json", "\u5206\u53D1\u6E05\u5355"],
    dependencies: ["E4"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E5.\u5206\u53D1\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "EP5",
    layer: "execution",
    kind: "pause",
    sequence: 280,
    title: "\u7EE7\u7EED\u751F\u4EA7\u786E\u8BA4",
    buttonLabel: "\u7EE7\u7EED\u786E\u8BA4",
    description: "E5 \u5B8C\u6210\u540E\u786E\u8BA4\u7ED3\u675F\u3001\u56DE\u9009\u9898\u5BA1\u6279\u3001\u56DE E1 \u6216\u8FD4\u56DE\u7B56\u7565\u5C42\u3002",
    owner: "E5-END \u7EE7\u7EED\u751F\u4EA7\u786E\u8BA4",
    inputs: ["E5 \u5206\u53D1\u6B63\u672C", "\u7EE7\u7EED\u751F\u4EA7\u9009\u62E9"],
    outputs: ["\u7ED3\u675F / \u56DE\u6682\u505C5 / \u56DE E1 / \u8FD4\u56DE\u7B56\u7565\u5C42"],
    dependencies: ["E5"],
    phase: "\u6267\u884C\u5C42\u786E\u8BA4",
    privateSources: []
  })
];
var workflowRootCandidates = [
  process.env.FRONTMIND_WORKFLOW_ROOT,
  path3.resolve(import.meta.dirname, "..", "private-workflows", "FrontMind_Workflow"),
  path3.resolve(import.meta.dirname, "..", "..", "private-workflows", "FrontMind_Workflow")
].filter(Boolean);
var workflowManifest = {
  workflowId: "frontmind-unified-workflow",
  title: "FrontMind Workflow",
  version: "v3.1-panorama-report",
  description: "",
  steps: steps.filter((stepData) => stepData.id !== "S0").map(({ privateSources: _privateSources, ...publicStep }) => publicStep),
  securityRules: []
};
function getPrivateWorkflowStep(stepId) {
  return steps.find((item) => item.id === stepId) ?? null;
}
async function resolveWorkflowRoot() {
  for (const candidate of workflowRootCandidates) {
    try {
      const stat = await fs3.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
    }
  }
  return null;
}
function isInsideRoot(candidatePath, rootPath) {
  const relative = path3.relative(rootPath, candidatePath);
  return relative === "" || !relative.startsWith("..") && !path3.isAbsolute(relative);
}
async function readPrivateFileStats(filePath) {
  const content = await fs3.readFile(filePath);
  return {
    checkedFiles: 1,
    availableFiles: 1,
    loadedBytes: content.byteLength
  };
}
async function readPrivateDirectoryStats(dirPath) {
  let checkedFiles = 0;
  let availableFiles = 0;
  let loadedBytes = 0;
  const entries = await fs3.readdir(dirPath, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith(".")).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of visibleEntries) {
    const entryPath = path3.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await readPrivateDirectoryStats(entryPath);
      checkedFiles += nested.checkedFiles;
      availableFiles += nested.availableFiles;
      loadedBytes += nested.loadedBytes;
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    checkedFiles += 1;
    try {
      const fileStats = await readPrivateFileStats(entryPath);
      availableFiles += fileStats.availableFiles;
      loadedBytes += fileStats.loadedBytes;
    } catch {
    }
  }
  return { checkedFiles, availableFiles, loadedBytes };
}
async function readPrivateSourceStats(workflowRoot, relativeSource) {
  const rootPath = path3.resolve(workflowRoot);
  const fullPath = path3.resolve(rootPath, relativeSource);
  if (!isInsideRoot(fullPath, rootPath)) {
    return { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
  }
  try {
    const stat = await fs3.stat(fullPath);
    if (stat.isDirectory()) {
      const directoryStats = await readPrivateDirectoryStats(fullPath);
      return directoryStats.checkedFiles > 0 ? directoryStats : { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
    }
    if (stat.isFile()) {
      return readPrivateFileStats(fullPath);
    }
  } catch {
  }
  return { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
}
function artifactKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".html") || lower.includes("\u7F51\u7AD9") || lower.includes("astro") || lower.includes("json-ld")) return "site";
  if (lower.endsWith(".docx") || lower.endsWith(".pdf") || lower.endsWith(".xlsx") || lower.includes("docx")) return "document";
  if (lower.endsWith(".md") || lower.includes("\u62A5\u544A") || lower.includes("\u6E05\u5355")) return "markdown";
  if (lower.includes("\u56FE\u7247") || lower.includes("\u89C6\u89C9")) return "image";
  return "package";
}
async function loadPrivateSkillPackage(stepId) {
  const stepData = getPrivateWorkflowStep(stepId);
  if (!stepData) {
    return null;
  }
  const workflowRoot = await resolveWorkflowRoot();
  if (!workflowRoot) {
    return {
      step: stepData,
      workflowRootConfigured: false,
      checkedSources: stepData.privateSources.length,
      availableSources: 0,
      loadedBytes: 0,
      loaded: stepData.privateSources.length === 0,
      artifactPlaceholders: stepData.outputs.map((name) => ({ name, kind: artifactKind(name) }))
    };
  }
  let checkedSources = 0;
  let availableSources = 0;
  let loadedBytes = 0;
  for (const relativeSource of stepData.privateSources) {
    const sourceStats = await readPrivateSourceStats(workflowRoot, relativeSource);
    checkedSources += sourceStats.checkedFiles;
    availableSources += sourceStats.availableFiles;
    loadedBytes += sourceStats.loadedBytes;
  }
  return {
    step: stepData,
    workflowRootConfigured: true,
    checkedSources,
    availableSources,
    loadedBytes,
    loaded: stepData.privateSources.length === 0 || checkedSources > 0 && availableSources === checkedSources,
    artifactPlaceholders: stepData.outputs.map((name) => ({ name, kind: artifactKind(name) }))
  };
}
function buildOperatorMessages(kind, title, inputs, outputs, hasOperatorNotes) {
  if (kind === "pause") {
    return [
      `${title} \u5DF2\u8BB0\u5F55\u4E3A\u4EBA\u5DE5\u786E\u8BA4\u8282\u70B9\u3002`,
      hasOperatorNotes ? "\u64CD\u4F5C\u8005\u8865\u5145\u610F\u89C1\u5DF2\u8BB0\u5F55\u3002" : "\u5F53\u524D\u53EF\u76F4\u63A5\u786E\u8BA4\uFF0C\u4E5F\u53EF\u4EE5\u8865\u5145\u4FEE\u6B63\u610F\u89C1\u540E\u518D\u786E\u8BA4\u3002",
      `\u786E\u8BA4\u540E\u5C06\u89E3\u9501\u4E0B\u4E00\u6B65\uFF0C\u9884\u671F\u8F93\u51FA\uFF1A${outputs.join("\u3001")}\u3002`
    ];
  }
  return [
    `${title} \u5DF2\u8FDB\u5165\u5F53\u524D\u4EFB\u52A1\u3002`,
    hasOperatorNotes ? "\u64CD\u4F5C\u8005\u8865\u5145\u5DF2\u8BB0\u5F55\u3002" : `\u5EFA\u8BAE\u8865\u5145\uFF1A${inputs.join("\u3001")}\u3002`,
    `\u672C\u73AF\u8282\u9884\u671F\u751F\u6210\uFF1A${outputs.join("\u3001")}\u3002`
  ];
}

// server/workflow-api.ts
var router3 = Router2();
var uploadsRoot = path4.resolve(process.cwd(), ".workflow-uploads");
var uploadIndexName = "index.json";
var defaultUploadRetentionMs = 24 * 60 * 60 * 1e3;
function sanitizeSegment(value, fallback) {
  const safe = String(value || "").replace(/[\\/\0]/g, "_").replace(/^\.+$/, "").trim().slice(0, 140);
  return safe || fallback;
}
function sanitizeFileName(value) {
  return sanitizeSegment(value, "upload.bin");
}
function safeDecodeHeader(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function getUploadDir(runId, stepId) {
  return path4.join(
    uploadsRoot,
    sanitizeSegment(runId, "run"),
    sanitizeSegment(stepId, "step")
  );
}
function toPublicUpload(file) {
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    stepId: file.stepId,
    uploadedAt: file.uploadedAt
  };
}
async function readUploadIndex(runId, stepId) {
  const indexPath = path4.join(getUploadDir(runId, stepId), uploadIndexName);
  try {
    const raw = await fs4.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function writeUploadIndex(runId, stepId, files) {
  const uploadDir = getUploadDir(runId, stepId);
  await fs4.mkdir(uploadDir, { recursive: true });
  await fs4.writeFile(path4.join(uploadDir, uploadIndexName), JSON.stringify(files, null, 2), "utf-8");
}
async function cleanupStaleWorkflowUploads() {
  const retentionMs = Number(process.env.FRONTMIND_WORKFLOW_UPLOAD_TTL_MS || defaultUploadRetentionMs);
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return;
  let entries;
  try {
    entries = await fs4.readdir(uploadsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionMs;
  await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const runPath = path4.join(uploadsRoot, entry.name);
      try {
        const stat = await fs4.stat(runPath);
        if (stat.mtimeMs < cutoff) {
          await fs4.rm(runPath, { recursive: true, force: true });
        }
      } catch {
      }
    })
  );
}
async function listPublicUploads(runId, stepId) {
  const files = await readUploadIndex(runId, stepId);
  return files.map(toPublicUpload);
}
async function addPathToZip(zip, workflowRoot, relativeSource) {
  const rootPath = path4.resolve(workflowRoot);
  const fullPath = path4.resolve(rootPath, relativeSource);
  const relativeToRoot = path4.relative(rootPath, fullPath);
  if (relativeToRoot.startsWith("..") || path4.isAbsolute(relativeToRoot)) {
    return;
  }
  const stat = await fs4.stat(fullPath);
  if (stat.isFile()) {
    const buffer = await fs4.readFile(fullPath);
    zip.file(path4.posix.join("workflow", relativeToRoot.split(path4.sep).join("/")), buffer);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const entries = await fs4.readdir(fullPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    await addPathToZip(zip, workflowRoot, path4.join(relativeSource, entry.name));
  }
}
function buildRunContextMarkdown(step2, body, uploads) {
  const fields = body.fields || {};
  const fieldRows = Object.entries(fields).filter(([, value]) => String(value || "").trim().length > 0).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- \u65E0";
  const uploadRows = uploads.map((file) => `- ${file.name} (${file.type || "application/octet-stream"}, ${file.size} bytes)`).join("\n") || "- \u65E0";
  return [
    `# FrontMind Workflow Run Context`,
    ``,
    `## Step`,
    `- id: ${step2.id}`,
    `- title: ${step2.title}`,
    `- owner: ${step2.owner}`,
    `- phase: ${step2.phase}`,
    ``,
    `## Operator Fields`,
    fieldRows,
    ``,
    `## Operator Notes`,
    String(body.operatorNotes || "").trim() || "\u65E0",
    ``,
    `## Uploaded Files`,
    uploadRows,
    ``,
    `## Expected Outputs`,
    step2.outputs.map((output) => `- ${output}`).join("\n"),
    ``
  ].join("\n");
}
function buildCurrentStepGateMarkdown(step2) {
  return [
    `# Current Step Gate`,
    ``,
    `## Current Step`,
    `- id: ${step2.id}`,
    `- title: ${step2.title}`,
    `- owner: ${step2.owner}`,
    `- phase: ${step2.phase}`,
    ``,
    `## Execution Boundary`,
    `This run loads the complete FrontMind Workflow package for global context.`,
    `Execute the workflow only until the current step above is complete, then stop.`,
    `Do not continue into downstream steps even if the original workflow instructions would normally proceed automatically.`,
    ``,
    `## Required Output Boundary`,
    `Begin the response with the current step id and title.`,
    `Output only the deliverables for this current step.`,
    `If required inputs are missing, list the missing items and pause at this step.`,
    ``,
    `## Current Step Expected Outputs`,
    step2.outputs.map((output) => `- ${output}`).join("\n"),
    ``
  ].join("\n");
}
async function buildExecutionBundle(step2, runId, body, uploads) {
  const workflowRoot = await resolveWorkflowRoot();
  if (!workflowRoot) {
    throw new Error("Workflow root not configured");
  }
  const zip = new JSZip();
  await addPathToZip(zip, workflowRoot, ".");
  const storedUploads = await readUploadIndex(runId, step2.id);
  const uploadDir = getUploadDir(runId, step2.id);
  for (const upload of storedUploads) {
    const uploadPath = path4.join(uploadDir, upload.storedName);
    const buffer = await fs4.readFile(uploadPath);
    zip.file(path4.posix.join("user_uploads", step2.id, upload.name), buffer);
  }
  zip.file("RUN_CONTEXT.md", buildRunContextMarkdown(step2, body, uploads));
  zip.file("CURRENT_STEP_GATE.md", buildCurrentStepGateMarkdown(step2));
  zip.file("PUBLIC_STEP.json", JSON.stringify({
    id: step2.id,
    layer: step2.layer,
    kind: step2.kind,
    title: step2.title,
    owner: step2.owner,
    inputs: step2.inputs,
    outputs: step2.outputs,
    dependencies: step2.dependencies,
    phase: step2.phase,
    currentStepOnly: true
  }, null, 2));
  zip.file("PUBLIC_WORKFLOW_MANIFEST.json", JSON.stringify(workflowManifest, null, 2));
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}
async function uploadBufferToFrontMind(baseUrl, apiKey, filename, buffer, contentType = "application/zip") {
  const fileRecordResponse = await axios2.post(
    `${baseUrl}/v1/files`,
    { filename },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 12e4,
      validateStatus: () => true
    }
  );
  if (fileRecordResponse.status < 200 || fileRecordResponse.status >= 300) {
    throw new Error(`Create file record failed (${fileRecordResponse.status})`);
  }
  const fileRecord = fileRecordResponse.data;
  if (!fileRecord?.id || !fileRecord?.upload_url) {
    throw new Error("Create file record failed: missing file id or upload url");
  }
  const uploadResponse = await axios2.put(fileRecord.upload_url, buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length)
    },
    timeout: 3e5,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true
  });
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new Error(`Upload file failed (${uploadResponse.status})`);
  }
  return { fileId: fileRecord.id, filename };
}
async function uploadStoredUserFiles(baseUrl, apiKey, runId, stepId) {
  const storedUploads = await readUploadIndex(runId, stepId);
  const uploadDir = getUploadDir(runId, stepId);
  const attachments = [];
  for (const upload of storedUploads) {
    const buffer = await fs4.readFile(path4.join(uploadDir, upload.storedName));
    const uploaded = await uploadBufferToFrontMind(
      baseUrl,
      apiKey,
      upload.name,
      buffer,
      upload.type || "application/octet-stream"
    );
    attachments.push({ file_id: uploaded.fileId, filename: uploaded.filename });
  }
  return attachments;
}
function buildAgentPrompt(step2) {
  return [
    `\u8BF7\u542F\u52A8\u5B8C\u6574 FrontMind Workflow\uFF0C\u5E76\u6267\u884C\u5230\u5F53\u524D\u95F8\u95E8\u73AF\u8282\uFF1A${step2.id}\u300C${step2.title}\u300D\u3002`,
    ``,
    `\u4F60\u4F1A\u6536\u5230\u4E00\u4E2A\u5B8C\u6574 workflow \u6267\u884C\u5305 ZIP\u3002\u8BF7\u5148\u89E3\u538B\u5E76\u6309\u987A\u5E8F\u8BFB\u53D6\uFF1A`,
    `1. RUN_CONTEXT.md\uFF1A\u672C\u6B21\u7528\u6237\u8F93\u5165\u3001\u4E0A\u4F20\u8D44\u6599\u548C\u8FD0\u884C\u4E0A\u4E0B\u6587\u3002`,
    `2. workflow/Master_Control/FrontMind_Master_Control.md \u4E0E workflow/00.FrontMind\u603B\u63A7\u8DEF\u7531.skill\uFF1A\u5B8C\u6574\u5DE5\u4F5C\u6D41\u603B\u63A7\u3002`,
    `3. CURRENT_STEP_GATE.md\uFF1A\u672C\u6B21\u5F3A\u5236\u505C\u987F\u7684\u5F53\u524D\u73AF\u8282\u3002`,
    `4. workflow/Strategy_Workflow \u4E0E workflow/Execution_Workflow\uFF1A\u5B8C\u6574\u7B56\u7565\u5C42\u4E0E\u6267\u884C\u5C42 skill\u3002`,
    `\u5982\u6709\u7528\u6237\u4E0A\u4F20\u8D44\u6599\uFF0C\u4E5F\u4F1A\u5728\u9644\u4EF6\u4E2D\u5355\u72EC\u63D0\u4F9B\uFF0C\u5E76\u5728 ZIP \u7684 user_uploads/ \u4E2D\u5907\u4EFD\u3002`,
    ``,
    `\u6267\u884C\u8981\u6C42\uFF1A`,
    `1. \u5148\u5EFA\u7ACB\u5B8C\u6574 FrontMind Workflow \u7684\u5168\u5C40\u4E0A\u4E0B\u6587\uFF0C\u518D\u8FDB\u5165 ${step2.id}\u300C${step2.title}\u300D\u3002`,
    `2. \u6309 ${step2.owner} \u7684\u804C\u8D23\u6267\u884C\u5F53\u524D\u73AF\u8282\u3002`,
    `3. \u53EA\u8F93\u51FA\u5F53\u524D\u73AF\u8282\u7ED3\u679C\uFF0C\u5F00\u5934\u660E\u786E\u6807\u6CE8\u201C\u5F53\u524D\u73AF\u8282\uFF1A${step2.id} ${step2.title}\u201D\u3002`,
    `4. \u5F53\u524D\u73AF\u8282\u5B8C\u6210\u540E\u5FC5\u987B\u6682\u505C\uFF0C\u4E0D\u8981\u81EA\u52A8\u7EE7\u7EED\u540E\u7EED S/E/P \u73AF\u8282\u3002`,
    `5. \u5982\u679C\u7F3A\u5C11\u5FC5\u8981\u8D44\u6599\uFF0C\u660E\u786E\u5217\u51FA\u7F3A\u53E3\u5E76\u505C\u5728\u5F53\u524D\u73AF\u8282\u3002`,
    ``,
    `\u5F53\u524D\u73AF\u8282\u9884\u671F\u4EA7\u7269\uFF1A`,
    step2.outputs.map((output) => `- ${output}`).join("\n")
  ].join("\n");
}
router3.get("/manifest", (_req, res) => {
  res.json(workflowManifest);
});
router3.delete("/runs/:runId", async (req, res) => {
  const runId = sanitizeSegment(String(req.params.runId || ""), "");
  if (!runId) {
    res.status(400).json({ error: "Missing run id" });
    return;
  }
  await fs4.rm(path4.join(uploadsRoot, runId), { recursive: true, force: true });
  res.json({ success: true });
});
router3.post(
  "/runs/:runId/steps/:stepId/uploads",
  express2.raw({ type: "application/octet-stream", limit: "100mb" }),
  async (req, res) => {
    const runId = sanitizeSegment(String(req.params.runId || ""), `wf_${randomUUID2()}`);
    const stepId = String(req.params.stepId || "");
    const step2 = getPrivateWorkflowStep(stepId);
    if (!step2) {
      res.status(404).json({ error: "Unknown workflow step" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Empty upload body" });
      return;
    }
    const originalName = sanitizeFileName(safeDecodeHeader(String(req.header("x-file-name") || "upload.bin")));
    const contentType = String(req.header("x-file-type") || "application/octet-stream");
    const id = randomUUID2();
    const storedName = `${id}_${originalName}`;
    const uploadDir = getUploadDir(runId, step2.id);
    await fs4.mkdir(uploadDir, { recursive: true });
    await fs4.writeFile(path4.join(uploadDir, storedName), req.body);
    const file = {
      id,
      storedName,
      name: originalName,
      type: contentType,
      size: req.body.length,
      stepId: step2.id,
      uploadedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const index = await readUploadIndex(runId, step2.id);
    index.push(file);
    await writeUploadIndex(runId, step2.id, index);
    const response = {
      runId,
      stepId: step2.id,
      file: toPublicUpload(file)
    };
    res.json(response);
  }
);
router3.post("/steps/:stepId/load", async (req, res) => {
  const stepId = String(req.params.stepId || "");
  const body = req.body || {};
  const loadedPackage = await loadPrivateSkillPackage(stepId);
  if (!loadedPackage) {
    res.status(404).json({ error: "Unknown workflow step" });
    return;
  }
  const runId = body.runId || `wf_${randomUUID2()}`;
  const sessionId = `exec_${stepId}_${randomUUID2()}`;
  const hasOperatorNotes = typeof body.operatorNotes === "string" && body.operatorNotes.trim().length > 0;
  const loaded = loadedPackage.loaded;
  const contextUploads = await listPublicUploads(runId, stepId);
  const uploadMessages = contextUploads.length > 0 ? [`\u5DF2\u7EB3\u5165 ${contextUploads.length} \u4E2A\u4E0A\u4F20\u6587\u4EF6\uFF1A${contextUploads.map((file) => file.name).join("\u3001")}\u3002`] : [];
  const response = {
    runId,
    stepId,
    status: loaded ? "loaded" : "missing_private_package",
    loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId,
    nextStatus: loaded ? "done" : "unavailable",
    serverLoad: {
      privatePackageLoaded: loaded,
      workflowRootConfigured: loadedPackage.workflowRootConfigured,
      checkedSources: loadedPackage.checkedSources,
      availableSources: loadedPackage.availableSources,
      loadedBytes: loadedPackage.loadedBytes,
      promptVisibleToClient: false,
      returnedPromptContent: false
    },
    contextUploads,
    operatorMessages: [
      ...buildOperatorMessages(
        loadedPackage.step.kind,
        loadedPackage.step.title,
        loadedPackage.step.inputs,
        loadedPackage.step.outputs,
        hasOperatorNotes
      ),
      ...uploadMessages
    ],
    artifactPlaceholders: loadedPackage.artifactPlaceholders,
    safety: {
      promptStoredServerSide: true,
      frontendReceivesPublicManifestOnly: true,
      rawSkillContentReturned: false
    }
  };
  res.json(response);
});
router3.post("/steps/:stepId/execute", async (req, res) => {
  const stepId = String(req.params.stepId || "");
  const body = req.body || {};
  const loadedPackage = await loadPrivateSkillPackage(stepId);
  const step2 = getPrivateWorkflowStep(stepId);
  if (!loadedPackage || !step2) {
    res.status(404).json({ error: "Unknown workflow step" });
    return;
  }
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  const runId = body.runId || `wf_${randomUUID2()}`;
  const sessionId = `exec_${stepId}_${randomUUID2()}`;
  const hasOperatorNotes = typeof body.operatorNotes === "string" && body.operatorNotes.trim().length > 0;
  const contextUploads = await listPublicUploads(runId, stepId);
  try {
    const bundle = await buildExecutionBundle(step2, runId, body, contextUploads);
    const bundleFile = await uploadBufferToFrontMind(
      baseUrl,
      apiKey,
      `FrontMind_${step2.id}_${runId}_full_workflow_bundle.zip`,
      bundle,
      "application/zip"
    );
    const userFileAttachments = await uploadStoredUserFiles(baseUrl, apiKey, runId, stepId);
    const attachments = [
      { filename: bundleFile.filename, file_id: bundleFile.fileId },
      ...userFileAttachments
    ];
    const taskResponse = await axios2.post(
      `${baseUrl}/v1/tasks`,
      {
        prompt: buildAgentPrompt(step2),
        agentProfile: toUpstreamAgentProfile(body.agentProfile),
        taskMode: "agent",
        attachments
      },
      {
        headers: {
          "Content-Type": "application/json",
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 12e4,
        validateStatus: () => true
      }
    );
    if (taskResponse.status < 200 || taskResponse.status >= 300) {
      const detail = taskResponse.data?.error?.message || taskResponse.data?.message || `Create task failed (${taskResponse.status})`;
      console.warn("[Workflow Execute] create task failed:", detail);
      res.status(taskResponse.status).json({ error: "\u521B\u5EFA\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u6216\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    const taskData = taskResponse.data || {};
    const taskId = taskData.id || taskData.task_id;
    if (!taskId) {
      res.status(502).json({ error: "Create task failed: missing task id" });
      return;
    }
    const normalizedStatus = taskData.status === "failed" ? "error" : taskData.status || "running";
    const uploadMessages = contextUploads.length > 0 ? [`\u5DF2\u7EB3\u5165 ${contextUploads.length} \u4E2A\u4E0A\u4F20\u6587\u4EF6\uFF1A${contextUploads.map((file) => file.name).join("\u3001")}\u3002`] : [];
    const response = {
      runId,
      stepId,
      status: loadedPackage.loaded ? "loaded" : "missing_private_package",
      loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
      sessionId,
      task: {
        id: taskId,
        status: normalizedStatus,
        taskUrl: taskData.task_url || taskData.metadata?.task_url,
        title: taskData.task_title || taskData.metadata?.task_title
      },
      nextStatus: loadedPackage.loaded ? "done" : "unavailable",
      serverLoad: {
        privatePackageLoaded: loadedPackage.loaded,
        workflowRootConfigured: loadedPackage.workflowRootConfigured,
        checkedSources: loadedPackage.checkedSources,
        availableSources: loadedPackage.availableSources,
        loadedBytes: loadedPackage.loadedBytes,
        promptVisibleToClient: false,
        returnedPromptContent: false
      },
      contextUploads,
      operatorMessages: [
        `\u5DF2\u8F7D\u5165\u5B8C\u6574 FrontMind Workflow \u5305\uFF0C\u5E76\u5B9A\u4F4D\u5230\u5F53\u524D\u73AF\u8282\uFF1A${step2.id}\u300C${step2.title}\u300D\u3002`,
        `\u672C\u6B21\u8FD0\u884C\u4F1A\u5728\u5F53\u524D\u73AF\u8282\u5B8C\u6210\u540E\u6682\u505C\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u7EE7\u7EED\u540E\u7EED\u73AF\u8282\u3002`,
        ...buildOperatorMessages(
          step2.kind,
          step2.title,
          step2.inputs,
          step2.outputs,
          hasOperatorNotes
        ),
        ...uploadMessages
      ],
      artifactPlaceholders: loadedPackage.artifactPlaceholders,
      safety: {
        promptStoredServerSide: true,
        frontendReceivesPublicManifestOnly: true,
        rawSkillContentReturned: false
      }
    };
    res.json(response);
  } catch (error) {
    console.error("[Workflow Execute] error:", error.message);
    res.status(500).json({ error: "\u6267\u884C\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
  }
});
var workflow_api_default = router3;

// server/news-release-api.ts
import axios3 from "axios";
import { Router as Router3 } from "express";
var router4 = Router3();
function sanitizeFilename2(value, fallback) {
  const safe = String(value || "").replace(/[\\/\0]/g, "_").replace(/^\.+$/, "").trim().slice(0, 160);
  return safe || fallback;
}
function normalizeUserAttachments(attachments) {
  return (attachments || []).map((attachment) => {
    const fileId = attachment.file_id || attachment.fileId || "";
    const filename = sanitizeFilename2(
      attachment.filename || attachment.name || "user_material",
      "user_material"
    );
    return fileId ? { file_id: fileId, filename } : null;
  }).filter(Boolean);
}
function buildPublishedNewsReleasePrompt(companyName, operatorNotes) {
  const template = `\u4F60\u662F\u4E00\u540D\u8D44\u6DF1\u4F01\u4E1A\u65B0\u95FB\u53D1\u5E03\u4F1A\u7B56\u5212\u4EBA\u3001\u8D22\u7ECF\u79D1\u6280\u5A92\u4F53\u4E3B\u7F16\u3001\u54C1\u724C\u6218\u7565\u987E\u95EE\u3001\u4E8B\u5B9E\u6838\u67E5\u7F16\u8F91\u548C\u89C6\u89C9\u521B\u610F\u603B\u76D1\u3002

\u8BF7\u56F4\u7ED5\u3010{\u4F01\u4E1A\u540D\u79F0}\u3011\u751F\u6210\u4E00\u4EFD\u53EF\u76F4\u63A5\u7528\u4E8E\u6B63\u5F0F\u5BF9\u5916\u53D1\u5E03\u7684\u9AD8\u7AEF\u65B0\u95FB\u53D1\u5E03\u4F1A\u56FE\u6587\u65B0\u95FB\u7A3F\uFF0C\u6700\u7EC8\u8F93\u51FA\u4E3A Markdown \u683C\u5F0F\u3002

\u6700\u7EC8\u7A3F\u5FC5\u987B\u662F\u9762\u5411\u5BA2\u6237\u3001\u5A92\u4F53\u548C\u516C\u4F17\u7684\u6210\u54C1\u65B0\u95FB\u7A3F\uFF0C\u4E0D\u5F97\u8F93\u51FA\u4EFB\u4F55\u4E2D\u95F4\u8FC7\u7A0B\u3001\u5199\u4F5C\u8BF4\u660E\u3001\u56FE\u7247\u751F\u6210 Prompt\u3001\u4E8B\u5B9E\u6838\u9A8C\u8868\u3001\u5BA1\u6821\u6E05\u5355\u3001\u5F85\u529E\u4E8B\u9879\u6216\u6A21\u578B\u81EA\u8BC4\u5185\u5BB9\u3002

---

## \u4E00\u3001\u57FA\u7840\u4FE1\u606F

\u4F01\u4E1A\u540D\u79F0\uFF1A{\u4F01\u4E1A\u540D\u79F0}

\u53D1\u5E03\u4E3B\u9898\uFF1A{\u53D1\u5E03\u4E3B\u9898 / \u65B0\u54C1\u53D1\u5E03 / \u6218\u7565\u5347\u7EA7 / \u6280\u672F\u6210\u679C / \u54C1\u724C\u53D1\u5E03 / \u9879\u76EE\u843D\u5730}

\u53D1\u5E03\u65E5\u671F\u4E0E\u5730\u70B9\uFF1A{\u65E5\u671F\u3001\u57CE\u5E02\uFF0C\u5982\u672A\u77E5\u8BF7\u4E0D\u8981\u5728\u6B63\u6587\u4E2D\u5F3A\u884C\u7F16\u9020}

\u76EE\u6807\u53D7\u4F17\uFF1A{\u5A92\u4F53 / \u6295\u8D44\u4EBA / \u5BA2\u6237 / \u653F\u5E9C / \u884C\u4E1A\u4F19\u4F34 / \u516C\u4F17}

\u884C\u4E1A\u9886\u57DF\uFF1A{\u884C\u4E1A}

\u4F01\u4E1A\u5B98\u7F51\u6216\u5B98\u65B9\u8D44\u6599\uFF1A{\u5B98\u7F51\u94FE\u63A5 / \u4E0A\u4F20\u56FE\u518C / \u4EA7\u54C1\u624B\u518C / \u65B0\u95FB\u8D44\u6599\u5305 / \u5B98\u65B9\u516C\u4F17\u53F7 / \u767D\u76AE\u4E66 / \u5E74\u62A5 / \u62DB\u80A1\u4E66}

\u5FC5\u987B\u4F7F\u7528\u7684\u4FE1\u606F\uFF1A{\u5982\u6709\uFF0C\u8BF7\u5217\u51FA}

\u7981\u6B62\u4F7F\u7528\u6216\u907F\u514D\u63D0\u53CA\u7684\u4FE1\u606F\uFF1A{\u5982\u6709\uFF0C\u8BF7\u5217\u51FA}

\u54C1\u724C\u8C03\u6027\uFF1A\u9AD8\u7AEF\u3001\u53EF\u4FE1\u3001\u514B\u5236\u3001\u56FD\u9645\u5316\u3001\u4E13\u4E1A\u3001\u6709\u65B0\u95FB\u4EF7\u503C\uFF0C\u907F\u514D\u7A7A\u6D1E\u8425\u9500\u8154\u3002

---

## \u4E8C\u3001\u8D44\u6599\u4E0E\u4E8B\u5B9E\u8981\u6C42

\u8BF7\u4F18\u5148\u4F7F\u7528\u4EE5\u4E0B\u6765\u6E90\u5B8C\u6210\u8D44\u6599\u5224\u65AD\u548C\u4E8B\u5B9E\u6838\u9A8C\uFF1A

1. \u4F01\u4E1A\u5B98\u7F51\u3001\u5B98\u65B9\u516C\u4F17\u53F7\u3001\u4EA7\u54C1\u624B\u518C\u3001\u767D\u76AE\u4E66\u3001\u5E74\u62A5\u3001\u62DB\u80A1\u4E66\u3001\u65B0\u95FB\u7A3F\u3001\u8BA4\u8BC1\u6587\u4EF6\uFF1B
2. \u7528\u6237\u4E0A\u4F20\u7684\u56FE\u518C\u3001\u4EA7\u54C1\u8D44\u6599\u3001\u5BA3\u4F20\u518C\u3001\u65B0\u95FB\u8D44\u6599\u5305\uFF1B
3. \u6743\u5A01\u5A92\u4F53\u62A5\u9053\uFF1B
4. \u653F\u5E9C\u3001\u534F\u4F1A\u3001\u4EA4\u6613\u6240\u3001\u76D1\u7BA1\u673A\u6784\u516C\u5F00\u4FE1\u606F\uFF1B
5. \u884C\u4E1A\u62A5\u544A\u3001\u5B66\u672F\u8BBA\u6587\u3001\u4E13\u5229\u6570\u636E\u5E93\u3002

\u6240\u6709\u5173\u952E\u4E8B\u5B9E\u5FC5\u987B\u53EF\u6838\u9A8C\u3002\u4E0D\u5F97\u7F16\u9020\u4EE5\u4E0B\u5185\u5BB9\uFF1A

- \u4F01\u4E1A\u8425\u6536\uFF1B
- \u878D\u8D44\u91D1\u989D\uFF1B
- \u5E02\u573A\u4EFD\u989D\uFF1B
- \u5BA2\u6237\u540D\u79F0\uFF1B
- \u5408\u4F5C\u4F19\u4F34\uFF1B
- \u8D44\u8D28\u8BA4\u8BC1\uFF1B
- \u9886\u5BFC\u59D3\u540D\u4E0E\u804C\u52A1\uFF1B
- \u53D1\u5E03\u4F1A\u5609\u5BBE\uFF1B
- \u4EA7\u54C1\u53C2\u6570\uFF1B
- \u4E13\u5229\u6570\u91CF\uFF1B
- \u5956\u9879\uFF1B
- \u653F\u5E9C\u80CC\u4E66\uFF1B
- \u4E0A\u5E02\u8BA1\u5212\uFF1B
- \u4EA7\u80FD\u6570\u636E\uFF1B
- \u9500\u552E\u6570\u636E\uFF1B
- \u7528\u6237\u89C4\u6A21\u3002

\u5982\u8D44\u6599\u4E0D\u8DB3\uFF0C\u8BF7\u5728\u6B63\u6587\u4E2D\u91C7\u7528\u514B\u5236\u3001\u4E2D\u6027\u3001\u53EF\u53D1\u5E03\u7684\u8868\u8FBE\u65B9\u5F0F\uFF0C\u4E0D\u5F97\u4F7F\u7528\u201C\u5F85\u786E\u8BA4\u201D\u201C\u8D44\u6599\u4E0D\u8DB3\u201D\u201C\u65E0\u6CD5\u786E\u8BA4\u201D\u7B49\u7834\u574F\u6210\u7A3F\u611F\u7684\u5B57\u6837\uFF0C\u4E5F\u4E0D\u5F97\u81EA\u884C\u5047\u8BBE\u3002

\u5982\u679C\u516C\u5F00\u8D44\u6599\u5B58\u5728\u51B2\u7A81\uFF0C\u8BF7\u4F18\u5148\u91C7\u7528\u4F01\u4E1A\u5B98\u65B9\u8D44\u6599\u3001\u76D1\u7BA1\u673A\u6784\u8D44\u6599\u6216\u66F4\u6743\u5A01\u3001\u66F4\u8FD1\u671F\u7684\u6765\u6E90\uFF0C\u4E0D\u8981\u5728\u6700\u7EC8\u65B0\u95FB\u7A3F\u4E2D\u66B4\u9732\u8D44\u6599\u51B2\u7A81\u8FC7\u7A0B\u3002

---

## \u4E09\u3001\u65B0\u95FB\u7A3F\u5199\u4F5C\u8981\u6C42

\u8BF7\u751F\u6210\u4E00\u7BC7\u8FBE\u5230\u9876\u7EA7\u5546\u4E1A\u5A92\u4F53\u3001\u79D1\u6280\u5A92\u4F53\u3001\u8D22\u7ECF\u5A92\u4F53\u53D1\u5E03\u6807\u51C6\u7684\u65B0\u95FB\u53D1\u5E03\u4F1A\u7A3F\u4EF6\u3002

\u65B0\u95FB\u7A3F\u5FC5\u987B\u5177\u5907\uFF1A

- \u660E\u786E\u65B0\u95FB\u4E8B\u4EF6\uFF1B
- \u6E05\u6670\u884C\u4E1A\u80CC\u666F\uFF1B
- \u771F\u5B9E\u4F01\u4E1A\u4FE1\u606F\uFF1B
- \u53EF\u4FE1\u4EA7\u54C1\u6216\u670D\u52A1\u63CF\u8FF0\uFF1B
- \u5177\u4F53\u5E94\u7528\u4EF7\u503C\uFF1B
- \u514B\u5236\u7684\u6218\u7565\u8868\u8FBE\uFF1B
- \u9AD8\u7AEF\u4F46\u4E0D\u6D6E\u5938\u7684\u8BED\u8A00\uFF1B
- \u5A92\u4F53\u53EF\u76F4\u63A5\u91C7\u7528\u7684\u6210\u7A3F\u8D28\u611F\u3002

\u6587\u7AE0\u7ED3\u6784\u5305\u62EC\uFF1A

### 1. \u4E3B\u6807\u9898

\u8981\u6C42\uFF1A

- \u5177\u6709\u65B0\u95FB\u4EF7\u503C\uFF1B
- \u7A81\u51FA\u53D1\u5E03\u4F1A\u6838\u5FC3\u4E8B\u4EF6\uFF1B
- \u4E0D\u6D6E\u5938\uFF1B
- \u4E0D\u4F7F\u7528\u201C\u9707\u64BC\u53D1\u5E03\u201D\u201C\u91CD\u78C5\u6765\u88AD\u201D\u201C\u5F15\u9886\u672A\u6765\u201D\u201C\u98A0\u8986\u884C\u4E1A\u201D\u7B49\u7A7A\u6CDB\u8868\u8FBE\u3002

### 2. \u526F\u6807\u9898

\u8981\u6C42\uFF1A

- \u8865\u5145\u6218\u7565\u610F\u4E49\u3001\u4EA7\u54C1\u4EF7\u503C\u3001\u884C\u4E1A\u80CC\u666F\u6216\u5546\u4E1A\u6210\u679C\uFF1B
- \u4E0E\u4E3B\u6807\u9898\u5F62\u6210\u9012\u8FDB\u5173\u7CFB\uFF1B
- \u8BED\u8A00\u514B\u5236\u3001\u4E13\u4E1A\u3001\u6709\u5A92\u4F53\u611F\u3002

### 3. \u5BFC\u8BED

\u8981\u6C42\uFF1A

- \u7528\u4E00\u6BB5\u8BDD\u4EA4\u4EE3\u65F6\u95F4\u3001\u5730\u70B9\u3001\u4F01\u4E1A\u3001\u53D1\u5E03\u5185\u5BB9\u548C\u6838\u5FC3\u610F\u4E49\uFF1B
- \u9075\u5FAA\u65B0\u95FB\u5199\u4F5C 5W1H\uFF1B
- \u4E0D\u5199\u6210\u5E7F\u544A\u8BED\u6216\u5BA3\u4F20\u7247\u65C1\u767D\u3002

### 4. \u6B63\u6587\u4E3B\u4F53

\u6B63\u6587\u8BF7\u6309\u4EE5\u4E0B\u903B\u8F91\u81EA\u7136\u5C55\u5F00\uFF1A

- \u53D1\u5E03\u4F1A\u6838\u5FC3\u4E8B\u4EF6\uFF1B
- \u4F01\u4E1A\u80CC\u666F\u4E0E\u4E1A\u52A1\u5B9A\u4F4D\uFF1B
- \u4EA7\u54C1\u3001\u6280\u672F\u6216\u670D\u52A1\u4EAE\u70B9\uFF1B
- \u884C\u4E1A\u75DB\u70B9\u4E0E\u89E3\u51B3\u65B9\u6848\uFF1B
- \u5E94\u7528\u573A\u666F\u6216\u5BA2\u6237\u4EF7\u503C\uFF1B
- \u4F01\u4E1A\u6218\u7565\u5E03\u5C40\uFF1B
- \u5BF9\u884C\u4E1A\u3001\u5BA2\u6237\u3001\u751F\u6001\u4F19\u4F34\u7684\u610F\u4E49\uFF1B
- \u540E\u7EED\u8BA1\u5212\u3002

### 5. \u6570\u636E\u4E0E\u4E8B\u5B9E

- \u6BCF\u4E2A\u5173\u952E\u6570\u636E\u5FC5\u987B\u6709\u53EF\u9760\u6765\u6E90\u652F\u6491\uFF1B
- \u4E0D\u786E\u5B9A\u6570\u636E\u4E0D\u5F97\u8FDB\u5165\u6B63\u6587\u4E3B\u53D9\u4E8B\uFF1B
- \u4E0D\u5F97\u4F7F\u7528\u65E0\u6CD5\u8BC1\u5B9E\u7684\u6392\u540D\u3001\u7B2C\u4E00\u3001\u9886\u5148\u3001\u552F\u4E00\u3001\u6700\u5927\u7B49\u7EDD\u5BF9\u5316\u8868\u8FF0\uFF1B
- \u5982\u9700\u5F15\u7528\u6765\u6E90\uFF0C\u53EF\u5728\u6587\u672B\u4EE5\u201C\u8D44\u6599\u6765\u6E90\u201D\u5F62\u5F0F\u7B80\u6D01\u5217\u51FA\u3002

### 6. \u7ED3\u5C3E

\u7ED3\u5C3E\u5E94\u5305\u62EC\uFF1A

- \u672C\u6B21\u53D1\u5E03\u4F1A\u7684\u603B\u7ED3\u6027\u610F\u4E49\uFF1B
- \u4F01\u4E1A\u672A\u6765\u65B9\u5411\uFF1B
- \u201C\u5173\u4E8E{\u4F01\u4E1A\u540D\u79F0}\u201D\u6807\u51C6\u516C\u53F8\u4ECB\u7ECD\uFF1B
- \u5A92\u4F53\u8054\u7CFB\u65B9\u5F0F\u3002

---

## \u56DB\u3001\u56FE\u7247\u4E0E\u89C6\u89C9\u8981\u6C42

\u8BF7\u5728\u6700\u7EC8 Markdown \u65B0\u95FB\u7A3F\u4E2D\u63D2\u5165\u81F3\u5C11 3 \u5F20\u56FE\u7247\u3002\u56FE\u7247\u5FC5\u987B\u670D\u52A1\u4E8E\u65B0\u95FB\u5185\u5BB9\uFF0C\u4E0D\u5F97\u53EA\u662F\u88C5\u9970\u56FE\u3002

\u56FE\u7247\u5E94\u5F53\u4E0E\u4F01\u4E1A\u771F\u5B9E\u4E1A\u52A1\u3001\u4EA7\u54C1\u3001\u670D\u52A1\u3001\u6280\u672F\u3001\u5E94\u7528\u573A\u666F\u6216\u54C1\u724C\u6C14\u8D28\u76F8\u5173\uFF0C\u5E76\u4F18\u5148\u53C2\u8003\u4F01\u4E1A\u5B98\u7F51\u3001\u4E0A\u4F20\u56FE\u518C\u3001\u4EA7\u54C1\u624B\u518C\u3001\u65B0\u95FB\u8D44\u6599\u5305\u6216\u516C\u5F00\u8D44\u6599\u4E2D\u7684\u771F\u5B9E\u5143\u7D20\u3002

\u56FE\u7247\u7C7B\u578B\u81F3\u5C11\u5305\u62EC\uFF1A

### \u56FE 1\uFF1A\u53D1\u5E03\u4F1A\u4E3B\u89C6\u89C9\u56FE

\u7528\u4E8E\u6587\u7AE0\u9876\u90E8\uFF0C\u4F53\u73B0\u53D1\u5E03\u4E3B\u9898\u3001\u4F01\u4E1A\u6C14\u8D28\u3001\u884C\u4E1A\u5C5E\u6027\u548C\u65B0\u95FB\u53D1\u5E03\u573A\u666F\u3002

\u8981\u6C42\uFF1A

- \u9AD8\u7AEF\u3001\u514B\u5236\u3001\u771F\u5B9E\u53EF\u4FE1\uFF1B
- \u50CF\u771F\u5B9E\u53D1\u5E03\u4F1A\u73B0\u573A\u3001\u4F01\u4E1A\u54C1\u724C\u5927\u7247\u6216\u5A92\u4F53\u5934\u56FE\uFF1B
- \u907F\u514D\u865A\u5047\u821E\u53F0\u3001\u5938\u5F20\u5149\u6548\u3001\u5EC9\u4EF7\u79D1\u6280\u80CC\u666F\u548C\u65E0\u5173\u89C6\u89C9\u5143\u7D20\uFF1B
- \u4E0D\u5F97\u865A\u6784\u4E0D\u5B58\u5728\u7684 Logo\u3001\u4F1A\u573A\u3001\u5609\u5BBE\u6216\u4F01\u4E1A\u6807\u8BC6\u3002

### \u56FE 2\uFF1A\u4EA7\u54C1 / \u670D\u52A1 / \u5E94\u7528\u573A\u666F\u56FE

\u7528\u4E8E\u5C55\u793A\u4F01\u4E1A\u5B9E\u9645\u4EA7\u54C1\u3001\u89E3\u51B3\u65B9\u6848\u3001\u5E73\u53F0\u3001\u8BBE\u5907\u3001\u5DE5\u5382\u3001\u95E8\u5E97\u3001\u8F6F\u4EF6\u754C\u9762\u6216\u670D\u52A1\u573A\u666F\u3002

\u8981\u6C42\uFF1A

- \u5FC5\u987B\u4E0E\u4F01\u4E1A\u771F\u5B9E\u4E1A\u52A1\u76F8\u5173\uFF1B
- \u4F18\u5148\u53C2\u8003\u4E0A\u4F20\u56FE\u518C\u3001\u5B98\u7F51\u4EA7\u54C1\u56FE\u6216\u516C\u5F00\u8D44\u6599\uFF1B
- \u4E0D\u5F97\u51ED\u7A7A\u521B\u9020\u6838\u5FC3\u4EA7\u54C1\u5916\u89C2\uFF1B
- \u4E0D\u5F97\u865A\u6784\u5BA2\u6237\u73B0\u573A\u3001\u5408\u4F5C\u4F19\u4F34\u6216\u5177\u4F53\u9879\u76EE\uFF1B
- \u5982\u65E0\u6CD5\u786E\u8BA4\u771F\u5B9E\u573A\u666F\uFF0C\u5E94\u91C7\u7528\u4E0D\u8BEF\u5BFC\u8BFB\u8005\u7684\u573A\u666F\u5316\u8868\u8FBE\u3002

### \u56FE 3\uFF1A\u4E1A\u52A1\u903B\u8F91\u56FE / \u6280\u672F\u67B6\u6784\u56FE / \u4EA7\u4E1A\u4EF7\u503C\u56FE

\u7528\u4E8E\u89E3\u91CA\u4F01\u4E1A\u5982\u4F55\u521B\u9020\u4EF7\u503C\uFF0C\u5E2E\u52A9\u8BFB\u8005\u7406\u89E3\u4F01\u4E1A\u7684\u4E1A\u52A1\u903B\u8F91\u3001\u6280\u672F\u8DEF\u5F84\u3001\u4EA7\u54C1\u77E9\u9635\u6216\u4EA7\u4E1A\u4F4D\u7F6E\u3002

\u8981\u6C42\uFF1A

- \u4FE1\u606F\u7ED3\u6784\u6E05\u6670\uFF1B
- \u6A21\u5757\u5173\u7CFB\u51C6\u786E\uFF1B
- \u89C6\u89C9\u5E72\u51C0\u4E13\u4E1A\uFF1B
- \u9002\u5408\u5A92\u4F53\u53D1\u5E03\uFF1B
- \u4E0D\u4F7F\u7528\u590D\u6742\u5C0F\u5B57\uFF1B
- \u4E0D\u4F7F\u7528\u8D5B\u535A\u670B\u514B\u3001\u9713\u8679\u3001\u5168\u606F\u3001\u5938\u5F20 3D \u6548\u679C\uFF1B
- \u98CE\u683C\u63A5\u8FD1\u4E13\u4E1A\u8D22\u7ECF\u5A92\u4F53\u3001\u54A8\u8BE2\u62A5\u544A\u6216\u4F01\u4E1A\u62DB\u80A1\u4E66\u4E2D\u7684\u4FE1\u606F\u56FE\u3002

---

## \u4E94\u3001\u56FE\u7247\u53BB AI \u5473\u513F\u8981\u6C42

\u6240\u6709\u56FE\u7247\u5FC5\u987B\u907F\u514D\u660E\u663E AI \u751F\u6210\u611F\u3002\u6574\u4F53\u89C6\u89C9\u5E94\u63A5\u8FD1\u771F\u5B9E\u5546\u4E1A\u6444\u5F71\u3001\u65B0\u95FB\u7EAA\u5B9E\u6444\u5F71\u3001\u4F01\u4E1A\u5B98\u7F51\u7EA7\u4EA7\u54C1\u6444\u5F71\u6216\u4E13\u4E1A\u4FE1\u606F\u56FE\u3002

\u56FE\u7247\u5E94\u5177\u5907\uFF1A

- \u771F\u5B9E\u5149\u7EBF\uFF1B
- \u771F\u5B9E\u6750\u8D28\uFF1B
- \u771F\u5B9E\u9634\u5F71\uFF1B
- \u81EA\u7136\u666F\u6DF1\uFF1B
- \u5408\u7406\u900F\u89C6\uFF1B
- \u514B\u5236\u6784\u56FE\uFF1B
- \u5E72\u51C0\u753B\u9762\uFF1B
- \u5546\u4E1A\u5A92\u4F53\u8D28\u611F\uFF1B
- \u4F01\u4E1A\u6B63\u5F0F\u5BF9\u5916\u53D1\u5E03\u7D20\u6750\u7684\u53EF\u4FE1\u5EA6\u3002

\u56FE\u7247\u5FC5\u987B\u907F\u514D\uFF1A

- AI \u6D77\u62A5\u611F\uFF1B
- \u5EC9\u4EF7\u84DD\u8272\u79D1\u6280\u611F\uFF1B
- \u5851\u6599\u8D28\u611F\uFF1B
- \u8721\u50CF\u4EBA\u7269\uFF1B
- \u7578\u5F62\u624B\u6307\uFF1B
- \u4E0D\u81EA\u7136\u7B11\u5BB9\uFF1B
- \u8FC7\u5EA6\u78E8\u76AE\uFF1B
- \u4E71\u7801\u6587\u5B57\uFF1B
- \u4F2A Logo\uFF1B
- \u865A\u6784\u5BA2\u6237\u540D\u79F0\uFF1B
- \u968F\u673A\u53D1\u5149\u7EBF\u6761\uFF1B
- \u6F02\u6D6E\u56FE\u6807\uFF1B
- \u5168\u606F\u6295\u5F71\uFF1B
- \u8D5B\u535A\u670B\u514B\u9713\u8679\uFF1B
- \u5938\u5F20\u955C\u5934\u5149\u6591\uFF1B
- \u8FC7\u5EA6\u9510\u5316\uFF1B
- \u8FC7\u9971\u548C\uFF1B
- \u5047 HDR\uFF1B
- \u7D20\u6750\u5E93\u62FC\u8D34\u611F\uFF1B
- \u6982\u5FF5\u6E32\u67D3\u611F\uFF1B
- \u4E0D\u771F\u5B9E\u7684\u5DE5\u5382\u3001\u5B9E\u9A8C\u5BA4\u3001\u95E8\u5E97\u3001\u4F1A\u573A\u6216\u4EA7\u54C1\u5916\u89C2\u3002

\u56FE\u7247\u5185\u6587\u5B57\u5E94\u5C3D\u91CF\u5C11\uFF0C\u5982\u5FC5\u987B\u51FA\u73B0\u6587\u5B57\uFF0C\u5E94\u6E05\u6670\u3001\u51C6\u786E\u3001\u65E0\u4E71\u7801\u3002\u4E0D\u5F97\u5728\u56FE\u7247\u4E2D\u52A0\u5165\u672A\u7ECF\u786E\u8BA4\u7684\u4F01\u4E1A\u53E3\u53F7\u3001\u6570\u636E\u3001\u6392\u540D\u3001\u5BA2\u6237\u540D\u79F0\u6216\u5408\u4F5C\u4F19\u4F34\u540D\u79F0\u3002

\u56FE\u7247\u5EFA\u8BAE\u4E3A 4K \u6216\u8FD1 4K \u8D28\u91CF\u3002\u5982\u9700 8K\uFF0C\u53EF\u5728\u56FE\u50CF\u751F\u6210\u540E\u901A\u8FC7\u5916\u90E8\u8D85\u5206\u8FA8\u7387\u5DE5\u5177\u4E8C\u6B21\u653E\u5927\u3002

---

## \u516D\u3001\u6700\u7EC8 Markdown \u8F93\u51FA\u683C\u5F0F

\u8BF7\u53EA\u8F93\u51FA\u4EE5\u4E0B\u6210\u54C1\u65B0\u95FB\u7A3F\u7ED3\u6784\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u989D\u5916\u8BF4\u660E\u3002

---

# {\u65B0\u95FB\u7A3F\u4E3B\u6807\u9898}

> \u526F\u6807\u9898\uFF1A{\u526F\u6807\u9898}

![\u53D1\u5E03\u4F1A\u4E3B\u89C6\u89C9\u56FE](./images/hero.png)
*\u56FE 1\uFF1A{\u56FE\u6CE8}*

## \u5BFC\u8BED

{\u65B0\u95FB\u5BFC\u8BED}

## \u4E00\u3001\u53D1\u5E03\u4F1A\u6838\u5FC3\u4FE1\u606F

{\u6B63\u6587\u5185\u5BB9}

## \u4E8C\u3001\u4F01\u4E1A\u80CC\u666F\u4E0E\u4E1A\u52A1\u5B9A\u4F4D

{\u6B63\u6587\u5185\u5BB9}

## \u4E09\u3001\u4EA7\u54C1 / \u6280\u672F / \u670D\u52A1\u4EAE\u70B9

{\u6B63\u6587\u5185\u5BB9}

![\u4EA7\u54C1\u6216\u5E94\u7528\u573A\u666F\u56FE](./images/product-scene.png)
*\u56FE 2\uFF1A{\u56FE\u6CE8}*

## \u56DB\u3001\u884C\u4E1A\u75DB\u70B9\u4E0E\u89E3\u51B3\u65B9\u6848

{\u6B63\u6587\u5185\u5BB9}

## \u4E94\u3001\u5E94\u7528\u573A\u666F\u4E0E\u5BA2\u6237\u4EF7\u503C

{\u6B63\u6587\u5185\u5BB9}

## \u516D\u3001\u6218\u7565\u5E03\u5C40\u4E0E\u672A\u6765\u8BA1\u5212

{\u6B63\u6587\u5185\u5BB9}

![\u4E1A\u52A1\u903B\u8F91\u56FE](./images/business-logic.png)
*\u56FE 3\uFF1A{\u56FE\u6CE8}*

## \u4E03\u3001\u5173\u4E8E{\u4F01\u4E1A\u540D\u79F0}

{100 \u81F3 200 \u5B57\u4F01\u4E1A\u4ECB\u7ECD}

## \u516B\u3001\u5A92\u4F53\u8054\u7CFB\u65B9\u5F0F

\u8054\u7CFB\u4EBA\uFF1A{\u8054\u7CFB\u4EBA}
\u7535\u8BDD\uFF1A{\u7535\u8BDD}
\u90AE\u7BB1\uFF1A{\u90AE\u7BB1}
\u5B98\u7F51\uFF1A{\u5B98\u7F51}

## \u8D44\u6599\u6765\u6E90

{\u4EC5\u5217\u51FA\u6B63\u6587\u4E2D\u5B9E\u9645\u4F7F\u7528\u7684\u91CD\u8981\u516C\u5F00\u8D44\u6599\u6765\u6E90\uFF1B\u5982\u4E0D\u9002\u5408\u516C\u5F00\u5C55\u793A\uFF0C\u53EF\u5220\u9664\u672C\u90E8\u5206}

---

## \u4E03\u3001\u6700\u7EC8\u8F93\u51FA\u9650\u5236

\u6700\u7EC8\u8F93\u51FA\u5FC5\u987B\u662F\u53EF\u76F4\u63A5\u53D1\u5E03\u7684 Markdown \u65B0\u95FB\u7A3F\u3002

\u4E0D\u5F97\u51FA\u73B0\u4EE5\u4E0B\u5185\u5BB9\uFF1A

- \u5199\u4F5C\u601D\u8DEF\uFF1B
- \u751F\u6210\u6B65\u9AA4\uFF1B
- \u56FE\u7247\u751F\u6210 Prompt\uFF1B
- \u8D1F\u9762 Prompt\uFF1B
- \u4E8B\u5B9E\u6838\u9A8C\u8868\uFF1B
- \u53D1\u5E03\u524D\u5BA1\u6821\u6E05\u5355\uFF1B
- \u7A3F\u4EF6\u8D28\u91CF\u81EA\u8BC4\uFF1B
- \u5F85\u786E\u8BA4\u4E8B\u9879\u6E05\u5355\uFF1B
- \u201C\u4F5C\u4E3A AI\u201D\uFF1B
- \u201C\u6211\u5EFA\u8BAE\u201D\uFF1B
- \u201C\u4EE5\u4E0B\u662F\u201D\uFF1B
- \u201C\u9700\u8981\u8FDB\u4E00\u6B65\u786E\u8BA4\u201D\uFF1B
- \u4EFB\u4F55\u9762\u5411\u5185\u90E8\u5236\u4F5C\u6D41\u7A0B\u7684\u8BF4\u660E\u3002

\u6240\u6709\u4E0D\u786E\u5B9A\u4FE1\u606F\u5FC5\u987B\u5728\u5199\u4F5C\u4E2D\u81EA\u7136\u89C4\u907F\uFF0C\u4E0D\u5F97\u7834\u574F\u65B0\u95FB\u7A3F\u7684\u6B63\u5F0F\u53D1\u5E03\u611F\u3002`;
  const lines = [template.replaceAll("{\u4F01\u4E1A\u540D\u79F0}", companyName)];
  if (operatorNotes.trim()) {
    lines.push("", "\u8865\u5145\u4FE1\u606F\uFF1A", operatorNotes.trim());
  }
  return lines.join("\n");
}
async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  agentProfile,
  attachments
}) {
  const taskResponse = await axios3.post(
    `${baseUrl}/v1/tasks`,
    {
      prompt,
      agentProfile: toUpstreamAgentProfile(agentProfile),
      taskMode: "agent",
      attachments
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 12e4,
      validateStatus: () => true
    }
  );
  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const detail = taskResponse.data?.error?.message || taskResponse.data?.message || `Create task failed (${taskResponse.status})`;
    return { ok: false, status: taskResponse.status, detail };
  }
  const taskData = taskResponse.data || {};
  const taskId = taskData.id || taskData.task_id;
  if (!taskId) {
    return { ok: false, status: 502, detail: "Create task failed: missing task id" };
  }
  return {
    ok: true,
    task: {
      id: taskId,
      status: taskData.status === "failed" ? "error" : taskData.status || "running",
      taskUrl: taskData.task_url || taskData.metadata?.task_url,
      title: taskData.task_title || taskData.metadata?.task_title,
      output: taskData.output || []
    }
  };
}
router4.post("/start", async (req, res) => {
  const body = req.body || {};
  const companyName = String(body.companyName || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();
  if (!companyName) {
    res.status(400).json({ error: "Missing company name" });
    return;
  }
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  try {
    const userAttachments = normalizeUserAttachments(body.attachments);
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt: buildPublishedNewsReleasePrompt(companyName, operatorNotes),
      agentProfile: body.agentProfile,
      attachments: userAttachments
    });
    if (!created.ok) {
      console.warn("[News Release Start] create task failed:", created.detail);
      res.status(created.status).json({ error: "\u521B\u5EFA\u65B0\u95FB\u7A3F\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u6216\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    res.json({
      visibleMessage: "\u5F00\u59CB\u5236\u4F5C\u54C1\u724C\u65B0\u95FB\u7A3F\u6837\u4F8B",
      task: created.task,
      startedAt: Date.now()
    });
  } catch (error) {
    console.error("[News Release Start] error:", error.message);
    res.status(500).json({ error: "\u542F\u52A8\u65B0\u95FB\u7A3F\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
  }
});
var news_release_api_default = router4;

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net2.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  const app = express3();
  const server = createServer(app);
  void cleanupStaleWorkflowUploads();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(express3.json({ limit: "50mb" }));
  app.use(express3.urlencoded({ limit: "50mb", extended: true }));
  app.use("/api/frontmind", manus_proxy_default);
  app.use("/api/manus", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  app.use("/api/workflow", workflow_api_default);
  app.use("/api/news-release", news_release_api_default);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  app.use((err, _req, res, next) => {
    if (err instanceof URIError) {
      res.status(400).end();
      return;
    }
    next(err);
  });
  const preferredPort = parseInt(process.env.PORT || "3001");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
  });
}
startServer().catch(console.error);
