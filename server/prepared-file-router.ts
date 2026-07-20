import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import {
  getCredentialForUpstreamResource,
  getDecryptedCredentialForUser,
} from "./auth-service";
import {
  PreparedFileError,
  preparedFileService,
  type PreparedFileManifest,
} from "./prepared-file-service";

const router = Router();
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;

const downloadTokens = new Map<
  string,
  { assetId: string; ownerUserId: number; expiresAt: number }
>();

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(
  rangeHeader: string | undefined,
  size: number,
): ByteRange | null | "invalid" {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size < 1) return "invalid";

  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sanitizeFilename(filename: string) {
  const source = ["ma", "nus"].join("");
  const replaced = String(filename || "document.pdf").replace(
    new RegExp(source, "gi"),
    "FrontMind",
  );
  return replaced.replace(/[\\/\0"]/g, "_").trim() || "document.pdf";
}

function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
) {
  const safe = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safe);
  return `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}

function sendPreparedError(res: Response, error: unknown) {
  if (error instanceof PreparedFileError) {
    const status =
      error.code === "ASSET_NOT_FOUND"
        ? 404
        : error.code === "INSUFFICIENT_STORAGE"
          ? 507
          : error.code === "SOURCE_FORBIDDEN"
            ? 403
            : 400;
    res.status(status).json({
      error: { message: error.message, code: error.code },
    });
    return;
  }
  console.error("[PreparedFiles] Request failed", error);
  res.status(500).json({
    error: {
      message: "文件准备服务暂时不可用",
      code: "PREPARED_FILE_SERVICE_ERROR",
    },
  });
}

function extractSource(fileUrl: string) {
  const parsed = new URL(fileUrl, "http://frontmind.local");
  const fileMatch = parsed.pathname.match(
    /(?:\/api\/frontmind)?\/v1\/files\/([^/]+)/,
  );
  if (fileMatch?.[1]) {
    return {
      kind: "file" as const,
      fileId: decodeURIComponent(fileMatch[1]),
    };
  }
  if (parsed.pathname.endsWith("/api/frontmind/proxy-download")) {
    const externalUrl = parsed.searchParams.get("url");
    if (externalUrl) {
      return { kind: "external" as const, url: externalUrl };
    }
  }
  if (/^https?:\/\//i.test(fileUrl)) {
    return { kind: "external" as const, url: fileUrl };
  }
  throw new PreparedFileError(
    "INVALID_FILE_SOURCE",
    "无法识别 PDF 文件来源",
  );
}

router.post("/prepare", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    const fileUrl = String(req.body?.fileUrl || "");
    const filename = sanitizeFilename(
      String(req.body?.fileName || "document.pdf"),
    );
    if (!fileUrl) {
      res.status(400).json({
        error: { message: "缺少文件地址", code: "MISSING_FILE_URL" },
      });
      return;
    }

    const source = extractSource(fileUrl);
    if (source.kind === "file") {
      const credential = await getCredentialForUpstreamResource(
        ownerUserId,
        "file",
        source.fileId,
      );
      if (!credential) {
        res.status(403).json({
          error: {
            message: "该文件不属于当前账号，或其原 API Key 已删除",
            code: "UPSTREAM_RESOURCE_FORBIDDEN",
          },
        });
        return;
      }
      res.json(
        await preparedFileService.registerFile({
          ownerUserId,
          credentialId: credential.id,
          fileId: source.fileId,
          filename,
        }),
      );
      return;
    }

    const credential = await getDecryptedCredentialForUser(ownerUserId);
    res.json(
      await preparedFileService.registerExternal({
        ownerUserId,
        credentialId: credential?.id || "external",
        url: source.url,
        filename,
      }),
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.get("/:assetId/status", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    res.json(
      await preparedFileService.getStatus(req.params.assetId, ownerUserId),
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.post("/:assetId/retry", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    res.json(
      await preparedFileService.retry(req.params.assetId, ownerUserId),
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

function cleanupDownloadTokens() {
  const now = Date.now();
  for (const [token, value] of downloadTokens) {
    if (value.expiresAt <= now) downloadTokens.delete(token);
  }
}

router.post("/:assetId/download-token", async (req, res) => {
  try {
    cleanupDownloadTokens();
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId,
    );
    if (manifest.status !== "ready") {
      res.status(409).json({
        error: {
          message: "文件仍在准备中",
          code: "FILE_NOT_READY",
          status: manifest.status,
          phase: manifest.phase,
        },
      });
      return;
    }
    const token = randomUUID();
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    downloadTokens.set(token, {
      assetId: manifest.id,
      ownerUserId,
      expiresAt,
    });
    res.json({
      downloadUrl: `/api/frontmind/assets/download/${token}`,
      expiresAt,
    });
  } catch (error) {
    sendPreparedError(res, error);
  }
});

async function streamPreparedFile(
  req: Request,
  res: Response,
  manifest: PreparedFileManifest,
  disposition: "inline" | "attachment",
) {
  const filePath = preparedFileService.contentPath(manifest.id);
  const stat = await fs.stat(filePath);
  const range = parseByteRange(
    typeof req.headers.range === "string" ? req.headers.range : undefined,
    stat.size,
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600, must-revalidate");
  res.setHeader(
    "Content-Disposition",
    contentDisposition(disposition, manifest.filename),
  );
  const etag = manifest.etag ? `"${manifest.etag}"` : undefined;
  const ifNoneMatch =
    typeof req.headers["if-none-match"] === "string"
      ? req.headers["if-none-match"]
      : undefined;
  if (etag) res.setHeader("ETag", etag);
  if (
    etag &&
    !req.headers.range &&
    ifNoneMatch
      ?.split(",")
      .map(value => value.trim())
      .includes(etag)
  ) {
    res.status(304).end();
    return;
  }

  if (range === "invalid") {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const contentLength = end - start + 1;
  res.setHeader("Content-Length", String(contentLength));
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  } else {
    res.status(200);
  }

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  preparedFileService.beginUse(manifest.id);
  const stream = createReadStream(filePath, { start, end });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    preparedFileService.endUse(manifest.id);
  };
  stream.on("error", error => {
    release();
    if (!res.headersSent) sendPreparedError(res, error);
    else res.destroy(error);
  });
  stream.on("close", release);
  res.on("close", () => {
    if (!res.writableEnded) stream.destroy();
    release();
  });
  stream.pipe(res);
}

router.get("/download/:token", async (req, res) => {
  try {
    cleanupDownloadTokens();
    const ownerUserId = req.frontmindUser?.id;
    const token = downloadTokens.get(req.params.token);
    if (!ownerUserId || !token || token.expiresAt <= Date.now()) {
      res.status(410).json({
        error: {
          message: "下载链接已失效",
          code: "DOWNLOAD_LINK_EXPIRED",
        },
      });
      return;
    }
    if (token.ownerUserId !== ownerUserId) {
      res.status(403).json({
        error: {
          message: "下载链接不属于当前账号",
          code: "DOWNLOAD_FORBIDDEN",
        },
      });
      return;
    }
    downloadTokens.delete(req.params.token);
    const manifest = await preparedFileService.getReadyManifest(
      token.assetId,
      ownerUserId,
    );
    if (manifest.status !== "ready") {
      res.status(409).json({
        error: { message: "文件尚未准备完成", code: "FILE_NOT_READY" },
      });
      return;
    }
    await streamPreparedFile(req, res, manifest, "attachment");
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.get("/:assetId/content", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId,
    );
    if (manifest.status !== "ready") {
      res.status(202).json({
        assetId: manifest.id,
        status: manifest.status,
        phase: manifest.phase,
        errorCode: manifest.errorCode,
        errorMessage: manifest.errorMessage,
        retryAfterMs: 2_000,
      });
      return;
    }
    await streamPreparedFile(
      req,
      res,
      manifest,
      req.query.download === "1" ? "attachment" : "inline",
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.head("/:assetId/content", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).end();
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId,
    );
    if (manifest.status !== "ready") {
      res.status(202).end();
      return;
    }
    await streamPreparedFile(req, res, manifest, "inline");
  } catch (error) {
    sendPreparedError(res, error);
  }
});

export default router;
