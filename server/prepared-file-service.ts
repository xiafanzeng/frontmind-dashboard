import axios from "axios";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Readable } from "node:stream";
import { getCredentialForUpstreamResource } from "./auth-service";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { getUpstreamBaseUrl } from "./upstream-config";

export type PreparedFilePhase =
  | "queued"
  | "downloading"
  | "sanitizing"
  | "optimizing"
  | "ready"
  | "failed";

export type PreparedFileStatus = "queued" | "processing" | "ready" | "failed";

type PreparedFileSource =
  | { kind: "file"; fileId: string }
  | { kind: "external"; url: string };

export interface PreparedFileManifest {
  version: 1;
  id: string;
  ownerUserId: number;
  credentialId: string;
  source: PreparedFileSource;
  filename: string;
  mimeType: "application/pdf";
  status: PreparedFileStatus;
  phase: PreparedFilePhase;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  sourceBytes?: number;
  size?: number;
  pageCount?: number;
  etag?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PreparedFilePublicStatus {
  assetId: string;
  filename: string;
  mimeType: string;
  status: PreparedFileStatus;
  phase: PreparedFilePhase;
  size?: number;
  sourceBytes?: number;
  pageCount?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  contentUrl: string;
  downloadTokenUrl: string;
}

interface RegisterFileInput {
  ownerUserId: number;
  credentialId: string;
  fileId: string;
  filename: string;
}

interface RegisterExternalInput {
  ownerUserId: number;
  credentialId: string;
  url: string;
  filename: string;
}

interface WorkerProgress {
  type: "progress";
  phase: "sanitizing" | "optimizing";
  page?: number;
  pageCount?: number;
}

interface WorkerComplete {
  type: "complete";
  pageCount: number;
  wasSanitized: boolean;
}

interface WorkerFailure {
  type: "error";
  code?: string;
  message: string;
}

type WorkerMessage = WorkerProgress | WorkerComplete | WorkerFailure;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const DISK_CHECK_INTERVAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_LARGE_PDF_THRESHOLD_BYTES = 64 * 1024 * 1024;

export class PreparedFileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PreparedFileError";
  }
}

function normalizeFilename(filename: string) {
  const safe = String(filename || "document.pdf")
    .replace(/[\\/\0]/g, "_")
    .trim();
  const withExtension = safe.toLowerCase().endsWith(".pdf")
    ? safe
    : `${safe || "document"}.pdf`;
  return withExtension || "document.pdf";
}

function stableExternalIdentity(url: string) {
  const parsed = new URL(url);
  const ephemeralNames = new Set([
    "accesskeyid",
    "credential",
    "expires",
    "googleaccessid",
    "key-pair-id",
    "policy",
    "security-token",
    "signature",
    "token",
  ]);
  const stableParameters = [...parsed.searchParams.entries()]
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return (
        !ephemeralNames.has(lower) &&
        !lower.startsWith("x-amz-") &&
        !lower.startsWith("x-goog-") &&
        !lower.startsWith("x-oss-")
      );
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    );
  const stableQuery = new URLSearchParams(stableParameters).toString();
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${
    stableQuery ? `?${stableQuery}` : ""
  }`;
}

export function createPreparedAssetId(
  ownerUserId: number,
  credentialId: string,
  source: PreparedFileSource,
) {
  const sourceIdentity =
    source.kind === "file"
      ? `file:${source.fileId}`
      : `external:${stableExternalIdentity(source.url)}`;
  return createHash("sha256")
    .update(`frontmind-pdf-v1\0${ownerUserId}\0${credentialId}\0${sourceIdentity}`)
    .digest("hex")
    .slice(0, 40);
}

function publicStatus(manifest: PreparedFileManifest): PreparedFilePublicStatus {
  return {
    assetId: manifest.id,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    status: manifest.status,
    phase: manifest.phase,
    size: manifest.size,
    sourceBytes: manifest.sourceBytes,
    pageCount: manifest.pageCount,
    errorCode: manifest.errorCode,
    errorMessage: manifest.errorMessage,
    retryAfterMs:
      manifest.status === "queued" || manifest.status === "processing"
        ? 2_000
        : undefined,
    contentUrl: `/api/frontmind/assets/${manifest.id}/content`,
    downloadTokenUrl: `/api/frontmind/assets/${manifest.id}/download-token`,
  };
}

function finitePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathSize(targetPath: string): Promise<number> {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(targetPath);
    let total = 0;
    for (const entry of entries) {
      total += await pathSize(path.join(targetPath, entry));
    }
    return total;
  } catch {
    return 0;
  }
}

async function commandAvailable(command: string, args: string[]) {
  return new Promise<boolean>(resolve => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", code => resolve(code === 0));
  });
}

async function hashFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export class PreparedFileService {
  readonly rootDir: string;

  private readonly manifests = new Map<string, PreparedFileManifest>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Set<string>();
  private readonly manifestWrites = new Map<string, Promise<void>>();
  private readonly workerConcurrency: number;
  private readonly retentionMs: number;
  private readonly largePdfThresholdBytes: number;
  private initPromise: Promise<void> | null = null;
  private processing = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(rootDir?: string) {
    this.rootDir =
      rootDir ||
      process.env.FRONTMIND_PREPARED_FILE_DIR ||
      (process.env.NODE_ENV === "production"
        ? "/var/lib/frontmind/prepared-files"
        : path.resolve(process.cwd(), ".frontmind-prepared-files"));
    this.workerConcurrency = finitePositiveInteger(
      process.env.FRONTMIND_PDF_WORKERS,
      1,
    );
    this.retentionMs = finitePositiveInteger(
      process.env.FRONTMIND_PREPARED_FILE_TTL_MS,
      THIRTY_DAYS_MS,
    );
    this.largePdfThresholdBytes = finitePositiveInteger(
      process.env.FRONTMIND_LARGE_PDF_THRESHOLD_BYTES,
      DEFAULT_LARGE_PDF_THRESHOLD_BYTES,
    );
  }

  async initialize() {
    if (!this.initPromise) {
      this.initPromise = this.initializeOnce();
    }
    return this.initPromise;
  }

  private async initializeOnce() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
    const tooling = await Promise.all([
      commandAvailable("pdfinfo", ["-v"]),
      commandAvailable("pdftotext", ["-v"]),
      commandAvailable("pdfseparate", ["-v"]),
      commandAvailable("pdfunite", ["-v"]),
      commandAvailable("gs", ["--version"]),
    ]);
    if (tooling.some(available => !available)) {
      throw new PreparedFileError(
        "PDF_TOOLING_UNAVAILABLE",
        "PDF 服务依赖不完整，请安装 poppler-utils 与 ghostscript",
      );
    }

    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(this.rootDir, entry.name);
      if (
        entry.isDirectory() &&
        (entry.name.endsWith(".work") || entry.name.endsWith(".tmp-work"))
      ) {
        await fs.rm(fullPath, { recursive: true, force: true });
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith(".source.tmp") ||
          entry.name.endsWith(".prepared.tmp") ||
          entry.name.endsWith(".json.tmp"))
      ) {
        await fs.rm(fullPath, { force: true });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      try {
        const parsed = JSON.parse(
          await fs.readFile(fullPath, "utf8"),
        ) as PreparedFileManifest;
        if (
          parsed.version !== 1 ||
          !/^[a-f0-9]{40}$/.test(parsed.id) ||
          parsed.id !== entry.name.slice(0, -5)
        ) {
          continue;
        }
        if (parsed.status === "processing") {
          parsed.status = "queued";
          parsed.phase = "queued";
          parsed.updatedAt = Date.now();
          await this.persistManifest(parsed);
        }
        this.manifests.set(parsed.id, parsed);
        if (parsed.status === "queued") this.enqueue(parsed.id);
      } catch (error) {
        console.warn(
          `[PreparedFiles] Ignoring invalid manifest ${entry.name}`,
          error,
        );
      }
    }

    await this.cleanup();
    this.cleanupTimer = setInterval(
      () => void this.cleanup(),
      24 * 60 * 60 * 1000,
    );
    this.cleanupTimer.unref();
  }

  async registerFile(input: RegisterFileInput) {
    await this.initialize();
    const source: PreparedFileSource = { kind: "file", fileId: input.fileId };
    return this.register({
      id: createPreparedAssetId(
        input.ownerUserId,
        input.credentialId,
        source,
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      source,
      filename: normalizeFilename(input.filename),
    });
  }

  async registerExternal(input: RegisterExternalInput) {
    await this.initialize();
    const source: PreparedFileSource = {
      kind: "external",
      url: assertSafeExternalUrl(input.url),
    };
    return this.register({
      id: createPreparedAssetId(
        input.ownerUserId,
        input.credentialId,
        source,
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      source,
      filename: normalizeFilename(input.filename),
    });
  }

  private async register(input: {
    id: string;
    ownerUserId: number;
    credentialId: string;
    source: PreparedFileSource;
    filename: string;
  }) {
    const now = Date.now();
    const existing = this.manifests.get(input.id);
    if (existing) {
      existing.filename = input.filename;
      existing.lastAccessedAt = now;
      if (input.source.kind === "external") {
        // Refresh an expiring signed URL without changing the stable asset id.
        existing.source = input.source;
      }
      if (existing.status === "failed" && existing.errorCode === "SOURCE_EXPIRED") {
        existing.status = "queued";
        existing.phase = "queued";
        delete existing.errorCode;
        delete existing.errorMessage;
        this.enqueue(existing.id);
      }
      await this.persistManifest(existing);
      return publicStatus(existing);
    }

    const manifest: PreparedFileManifest = {
      version: 1,
      id: input.id,
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      source: input.source,
      filename: input.filename,
      mimeType: "application/pdf",
      status: "queued",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
    };
    this.manifests.set(manifest.id, manifest);
    await this.persistManifest(manifest);
    this.enqueue(manifest.id);
    return publicStatus(manifest);
  }

  async getStatus(assetId: string, ownerUserId: number) {
    const manifest = await this.requireOwned(assetId, ownerUserId);
    await this.touch(manifest);
    return publicStatus(manifest);
  }

  async getReadyManifest(assetId: string, ownerUserId: number) {
    const manifest = await this.requireOwned(assetId, ownerUserId);
    await this.touch(manifest);
    if (manifest.status !== "ready") return manifest;
    if (!(await fileExists(this.pdfPath(assetId)))) {
      manifest.status = "queued";
      manifest.phase = "queued";
      delete manifest.size;
      delete manifest.etag;
      await this.persistManifest(manifest);
      this.enqueue(assetId);
    }
    return manifest;
  }

  async retry(assetId: string, ownerUserId: number) {
    const manifest = await this.requireOwned(assetId, ownerUserId);
    if (manifest.status === "ready") return publicStatus(manifest);
    manifest.status = "queued";
    manifest.phase = "queued";
    manifest.updatedAt = Date.now();
    delete manifest.errorCode;
    delete manifest.errorMessage;
    await this.persistManifest(manifest);
    this.enqueue(assetId);
    return publicStatus(manifest);
  }

  contentPath(assetId: string) {
    return this.pdfPath(assetId);
  }

  beginUse(assetId: string) {
    this.active.add(assetId);
  }

  endUse(assetId: string) {
    this.active.delete(assetId);
  }

  async health() {
    await this.initialize();
    const stats = await fs.statfs(this.rootDir);
    return {
      cacheDirectory: this.rootDir,
      availableBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      queueLength: this.queue.length,
      activeWorkers: this.processing,
    };
  }

  private async requireOwned(assetId: string, ownerUserId: number) {
    await this.initialize();
    if (!/^[a-f0-9]{40}$/.test(assetId)) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "文件不存在");
    }
    const manifest = this.manifests.get(assetId);
    if (!manifest || manifest.ownerUserId !== ownerUserId) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "文件不存在");
    }
    return manifest;
  }

  private enqueue(assetId: string) {
    if (this.queued.has(assetId)) return;
    this.queued.add(assetId);
    this.queue.push(assetId);
    queueMicrotask(() => void this.drainQueue());
  }

  private async drainQueue() {
    while (
      this.processing < this.workerConcurrency &&
      this.queue.length > 0
    ) {
      const assetId = this.queue.shift();
      if (!assetId) return;
      this.queued.delete(assetId);
      const manifest = this.manifests.get(assetId);
      if (!manifest || manifest.status !== "queued") continue;
      this.processing += 1;
      void this.processAsset(manifest)
        .catch(error => {
          console.error(
            `[PreparedFiles] Unhandled job error for ${manifest.id}`,
            error,
          );
        })
        .finally(() => {
          this.processing -= 1;
          void this.drainQueue();
        });
    }
  }

  private async processAsset(manifest: PreparedFileManifest) {
    const sourcePath = this.sourcePath(manifest.id);
    const preparedTempPath = this.preparedTempPath(manifest.id);
    const workDir = this.workPath(manifest.id);
    this.active.add(manifest.id);

    try {
      manifest.status = "processing";
      manifest.phase = "downloading";
      manifest.updatedAt = Date.now();
      delete manifest.errorCode;
      delete manifest.errorMessage;
      await this.persistManifest(manifest);

      await this.ensureDiskSpace();
      const sourceBytes = await this.downloadSource(
        manifest,
        sourcePath,
        async downloadedBytes => {
          manifest.sourceBytes = downloadedBytes;
          manifest.updatedAt = Date.now();
          await this.persistManifest(manifest);
        },
      );
      manifest.sourceBytes = sourceBytes;
      manifest.phase = "sanitizing";
      manifest.updatedAt = Date.now();
      await this.persistManifest(manifest);

      const result = await this.runWorker(
        manifest,
        sourcePath,
        preparedTempPath,
        workDir,
      );
      manifest.phase = "optimizing";
      manifest.updatedAt = Date.now();
      await this.persistManifest(manifest);

      const outputStat = await fs.stat(preparedTempPath);
      if (outputStat.size < 5) {
        throw new PreparedFileError(
          "INVALID_PDF",
          "处理后的 PDF 文件为空",
        );
      }
      const handle = await fs.open(preparedTempPath, "r");
      try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString("ascii") !== "%PDF-") {
          throw new PreparedFileError(
            "INVALID_PDF",
            "处理结果不是有效的 PDF",
          );
        }
      } finally {
        await handle.close();
      }

      const etag = await hashFile(preparedTempPath);
      await fs.rename(preparedTempPath, this.pdfPath(manifest.id));
      await fs.chmod(this.pdfPath(manifest.id), 0o600).catch(() => undefined);

      manifest.status = "ready";
      manifest.phase = "ready";
      manifest.size = outputStat.size;
      manifest.pageCount = result.pageCount;
      manifest.etag = etag;
      manifest.updatedAt = Date.now();
      manifest.lastAccessedAt = Date.now();
      await this.persistManifest(manifest);
      await this.cleanup();
    } catch (error) {
      const preparedError =
        error instanceof PreparedFileError
          ? error
          : new PreparedFileError(
              "PDF_PREPARATION_FAILED",
              error instanceof Error ? error.message : "PDF 处理失败",
            );
      manifest.status = "failed";
      manifest.phase = "failed";
      manifest.errorCode = preparedError.code;
      manifest.errorMessage = preparedError.message;
      manifest.updatedAt = Date.now();
      await this.persistManifest(manifest);
      console.error(
        `[PreparedFiles] Failed to prepare ${manifest.id}: ${preparedError.code} ${preparedError.message}`,
      );
    } finally {
      this.active.delete(manifest.id);
      await fs.rm(sourcePath, { force: true }).catch(() => undefined);
      await fs.rm(preparedTempPath, { force: true }).catch(() => undefined);
      await fs.rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async downloadSource(
    manifest: PreparedFileManifest,
    destination: string,
    persistProgress: (bytes: number) => Promise<void>,
  ) {
    let sourceUrl: string;
    let headers: Record<string, string> | undefined;

    if (manifest.source.kind === "file") {
      const credential = await getCredentialForUpstreamResource(
        manifest.ownerUserId,
        "file",
        manifest.source.fileId,
      );
      if (!credential || credential.id !== manifest.credentialId) {
        throw new PreparedFileError(
          "SOURCE_FORBIDDEN",
          "文件所属 API Key 已删除或不可用",
        );
      }
      const baseUrl = getUpstreamBaseUrl();
      const metadataResponse = await axios.get(
        `${baseUrl}/v1/files/${encodeURIComponent(manifest.source.fileId)}`,
        {
          headers: {
            API_KEY: credential.apiKey,
            Authorization: `Bearer ${credential.apiKey}`,
          },
          timeout: FIVE_MINUTES_MS,
          validateStatus: () => true,
        },
      );
      if (metadataResponse.status !== 200) {
        throw new PreparedFileError(
          metadataResponse.status === 404
            ? "SOURCE_NOT_FOUND"
            : "SOURCE_METADATA_FAILED",
          `获取文件信息失败 (${metadataResponse.status})`,
        );
      }
      if (metadataResponse.data?.filename) {
        manifest.filename = normalizeFilename(metadataResponse.data.filename);
      }
      if (!metadataResponse.data?.upload_url) {
        sourceUrl = `${baseUrl}/v1/files/${encodeURIComponent(
          manifest.source.fileId,
        )}/content`;
        headers = {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        };
      } else {
        sourceUrl = assertSafeExternalUrl(metadataResponse.data.upload_url);
      }
    } else {
      sourceUrl = assertSafeExternalUrl(manifest.source.url);
    }

    const controller = new AbortController();
    let lastProgressAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt >= FIVE_MINUTES_MS) {
        controller.abort(
          new PreparedFileError(
            "SOURCE_STALLED",
            "文件下载连续 5 分钟没有进展",
          ),
        );
      }
    }, 30_000);
    watchdog.unref();

    try {
      const response = await axios.get(sourceUrl, {
        ...safeExternalRequestOptions,
        headers,
        responseType: "stream",
        timeout: FIVE_MINUTES_MS,
        maxContentLength: Infinity,
        signal: controller.signal,
        validateStatus: () => true,
      });
      if (response.status !== 200) {
        throw new PreparedFileError(
          response.status === 401 ||
            response.status === 403 ||
            response.status === 404
            ? "SOURCE_EXPIRED"
            : "SOURCE_DOWNLOAD_FAILED",
          `上游文件下载失败 (${response.status})`,
        );
      }

      const output = await fs.open(destination, "w", 0o600);
      let total = 0;
      let nextDiskCheck = DISK_CHECK_INTERVAL_BYTES;
      let nextPersist = DISK_CHECK_INTERVAL_BYTES;
      try {
        for await (const rawChunk of response.data as Readable) {
          const chunk = Buffer.isBuffer(rawChunk)
            ? rawChunk
            : Buffer.from(rawChunk);
          await output.write(chunk);
          total += chunk.length;
          lastProgressAt = Date.now();
          if (total >= nextPersist) {
            await persistProgress(total);
            nextPersist = total + DISK_CHECK_INTERVAL_BYTES;
          }
          if (total >= nextDiskCheck) {
            await this.ensureDiskSpace();
            nextDiskCheck = total + DISK_CHECK_INTERVAL_BYTES;
          }
        }
      } finally {
        await output.close();
      }
      await persistProgress(total);
      return total;
    } catch (error: any) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof PreparedFileError) throw reason;
        throw new PreparedFileError(
          "SOURCE_STALLED",
          "文件下载连续 5 分钟没有进展",
        );
      }
      if (error instanceof PreparedFileError) throw error;
      throw new PreparedFileError(
        "SOURCE_DOWNLOAD_FAILED",
        error?.message || "上游文件下载失败",
      );
    } finally {
      clearInterval(watchdog);
    }
  }

  private async runWorker(
    manifest: PreparedFileManifest,
    inputPath: string,
    outputPath: string,
    workDir: string,
  ) {
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    const production = process.env.NODE_ENV === "production";
    const workerUrl = new URL(
      production
        ? "./pdf-prepare-worker.js"
        : "./pdf-prepare-worker-bootstrap.mjs",
      import.meta.url,
    );

    return new Promise<WorkerComplete>((resolve, reject) => {
      let settled = false;
      let lastProgressAt = Date.now();
      let lastProgressPersistedAt = 0;
      let checkingDisk = false;
      const worker = new Worker(workerUrl, {
        workerData: {
          inputPath,
          outputPath,
          workDir,
          largePdfThresholdBytes: this.largePdfThresholdBytes,
        },
        execArgv: [],
      });

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        callback();
      };

      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt >= FIVE_MINUTES_MS) {
          void worker.terminate();
          finish(() =>
            reject(
              new PreparedFileError(
                "PDF_PROCESSING_STALLED",
                "PDF 处理连续 5 分钟没有进展",
              ),
            ),
          );
          return;
        }
        if (checkingDisk) return;
        checkingDisk = true;
        void this.ensureDiskSpace()
          .catch(error => {
            void worker.terminate();
            finish(() =>
              reject(
                error instanceof PreparedFileError
                  ? error
                  : new PreparedFileError(
                      "INSUFFICIENT_STORAGE",
                      "服务器可用磁盘空间不足，请清理缓存后重试",
                    ),
              ),
            );
          })
          .finally(() => {
            checkingDisk = false;
          });
      }, 30_000);
      watchdog.unref();

      worker.on("message", (message: WorkerMessage) => {
        lastProgressAt = Date.now();
        if (message.type === "progress") {
          manifest.phase = message.phase;
          manifest.updatedAt = Date.now();
          if (message.pageCount) manifest.pageCount = message.pageCount;
          if (
            Date.now() - lastProgressPersistedAt >= 1_000 ||
            (message.pageCount && message.page === message.pageCount)
          ) {
            lastProgressPersistedAt = Date.now();
            void this.persistManifest(manifest);
          }
          return;
        }
        if (message.type === "complete") {
          finish(() => resolve(message));
          return;
        }
        finish(() =>
          reject(
            new PreparedFileError(
              message.code || "PDF_PREPARATION_FAILED",
              message.message,
            ),
          ),
        );
      });
      worker.on("error", error => {
        finish(() =>
          reject(
            new PreparedFileError(
              "PDF_WORKER_FAILED",
              error.message || "PDF Worker 启动失败",
            ),
          ),
        );
      });
      worker.on("exit", code => {
        if (code !== 0) {
          finish(() =>
            reject(
              new PreparedFileError(
                "PDF_WORKER_FAILED",
                `PDF Worker 异常退出 (${code})`,
              ),
            ),
          );
        }
      });
    });
  }

  private async touch(manifest: PreparedFileManifest) {
    const now = Date.now();
    if (now - manifest.lastAccessedAt < 60 * 60 * 1000) return;
    manifest.lastAccessedAt = now;
    await this.persistManifest(manifest);
  }

  private persistManifest(manifest: PreparedFileManifest) {
    const destination = this.manifestPath(manifest.id);
    const temporary = `${destination}.tmp`;
    const snapshot = `${JSON.stringify(manifest)}\n`;
    const previous =
      this.manifestWrites.get(manifest.id) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.writeFile(temporary, snapshot, {
          encoding: "utf8",
          mode: 0o600,
        });
        await fs.rename(temporary, destination);
      });
    this.manifestWrites.set(manifest.id, operation);
    return operation.finally(() => {
      if (this.manifestWrites.get(manifest.id) === operation) {
        this.manifestWrites.delete(manifest.id);
      }
    });
  }

  private async ensureDiskSpace() {
    const stats = await fs.statfs(this.rootDir);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
    const maximumCacheBytes = Math.min(
      Math.floor(totalBytes * 0.8),
      Math.max(0, totalBytes - reserveBytes),
    );
    const cacheBytes = await this.cacheSize();
    if (
      availableBytes >= reserveBytes &&
      cacheBytes <= maximumCacheBytes
    ) {
      return;
    }
    await this.cleanup();
    const refreshed = await fs.statfs(this.rootDir);
    const refreshedAvailable = refreshed.bavail * refreshed.bsize;
    const refreshedCacheBytes = await this.cacheSize();
    if (
      refreshedAvailable < reserveBytes ||
      refreshedCacheBytes > maximumCacheBytes
    ) {
      throw new PreparedFileError(
        "INSUFFICIENT_STORAGE",
        "服务器可用磁盘空间不足，请清理缓存后重试",
      );
    }
  }

  async cleanup() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const candidates = [...this.manifests.values()]
      .filter(manifest => !this.active.has(manifest.id))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    for (const manifest of candidates) {
      if (now - manifest.lastAccessedAt <= this.retentionMs) continue;
      await this.deleteAsset(manifest.id);
    }

    const stats = await fs.statfs(this.rootDir);
    const totalBytes = stats.blocks * stats.bsize;
    const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
    const maximumCacheBytes = Math.min(
      Math.floor(totalBytes * 0.8),
      Math.max(0, totalBytes - reserveBytes),
    );
    let cacheBytes = await this.cacheSize();
    let availableBytes = stats.bavail * stats.bsize;
    if (
      cacheBytes <= maximumCacheBytes &&
      availableBytes >= reserveBytes
    ) {
      return;
    }

    for (const manifest of candidates) {
      if (
        cacheBytes <= maximumCacheBytes &&
        availableBytes >= reserveBytes
      ) {
        break;
      }
      if (
        this.active.has(manifest.id) ||
        manifest.status === "processing" ||
        manifest.status === "queued"
      ) {
        continue;
      }
      const before = await this.assetSize(manifest.id);
      await this.deleteAsset(manifest.id);
      cacheBytes = Math.max(0, cacheBytes - before);
      const refreshed = await fs.statfs(this.rootDir);
      availableBytes = refreshed.bavail * refreshed.bsize;
    }
  }

  private async assetSize(assetId: string) {
    let size = 0;
    for (const filePath of [
      this.manifestPath(assetId),
      this.pdfPath(assetId),
      this.sourcePath(assetId),
      this.preparedTempPath(assetId),
      this.workPath(assetId),
    ]) {
      size += await pathSize(filePath);
    }
    return size;
  }

  private async cacheSize() {
    return pathSize(this.rootDir);
  }

  private async deleteAsset(assetId: string) {
    if (this.active.has(assetId)) return;
    this.manifests.delete(assetId);
    this.queued.delete(assetId);
    const queueIndex = this.queue.indexOf(assetId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    await Promise.all([
      fs.rm(this.manifestPath(assetId), { force: true }),
      fs.rm(this.pdfPath(assetId), { force: true }),
      fs.rm(this.sourcePath(assetId), { force: true }),
      fs.rm(this.preparedTempPath(assetId), { force: true }),
      fs.rm(this.workPath(assetId), { recursive: true, force: true }),
    ]);
  }

  private manifestPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.json`);
  }

  private sourcePath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.source.tmp`);
  }

  private preparedTempPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.prepared.tmp`);
  }

  private pdfPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.pdf`);
  }

  private workPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.work`);
  }
}

export const preparedFileService = new PreparedFileService();
