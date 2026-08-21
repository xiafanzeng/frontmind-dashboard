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

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;

function notFound(res: express.Response) {
  res.status(404).json({ error: "NOT_FOUND" });
}

function sendError(res: express.Response, error: unknown) {
  const code = error instanceof Error ? error.message : "SITEOPS_FILE_ERROR";
  if (code === "NOT_FOUND") return notFound(res);
  res.status(409).json({ error: code.slice(0, 128) });
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

export function rewriteSiteOpsPreviewDocument(input: {
  bytes: Buffer;
  mimeType: string;
  previewPrefix: string;
}) {
  const mediaType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/html" && mediaType !== "text/css") {
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
  disposition?: "inline" | "attachment";
}) {
  const asset = await readSiteOpsArtifact({
    userId: input.userId,
    localAssetId: input.localAssetId,
    expectedSha256: input.expectedSha256,
  });
  if (!asset) return notFound(input.res);
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

siteOpsArtifactApi.get("/style-previews/:sampleId", async (req, res) => {
  try {
    const userId = req.frontmindUser?.id;
    if (!userId) return notFound(res);
    const db = await requireDb();
    const rows = await db
      .select({
        localAssetId: websiteStyleSamples.previewLocalAssetId,
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
          eq(websiteStyleSampleBatches.status, "published"),
        ),
      )
      .limit(1);
    const localAssetId = rows[0]?.localAssetId;
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
    if (!entry || entry.name.includes("\\") || entry.name.includes("..")) {
      return notFound(res);
    }
    const mode = Number(entry.unixPermissions ?? 0);
    if (mode && (mode & 0o170000) === 0o120000) {
      throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
    }
    let bytes = await entry.async("nodebuffer");
    if (bytes.length > 20 * 1024 * 1024) {
      throw new Error("SITEOPS_PREVIEW_FILE_TOO_LARGE");
    }
    const mimeType = previewMimeType(entry.name);
    bytes = rewriteSiteOpsPreviewDocument({
      bytes,
      mimeType,
      previewPrefix: `/api/site-ops/builds/${encodeURIComponent(req.params.buildId)}/preview/`,
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'",
    );
    res.setHeader("Content-Length", String(bytes.length));
    res.send(bytes);
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
