import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  type ReadStream,
} from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type PresalesFileManifest = {
  schemaVersion: 1;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  state: "pending" | "stored";
  updatedAt: string;
};

export type StagedPresalesFile = {
  sizeBytes: number;
  sha256: string;
  createReadStream: () => ReadStream;
  commit: (input: { filename?: string; mimeType?: string }) => Promise<void>;
  discard: () => Promise<void>;
};

export type StoredPresalesFile = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  createReadStream: () => ReadStream;
};

function storageRoot() {
  const assetRoot = path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
  return path.join(assetRoot, "presales-files");
}

function storageKey(fileId: string) {
  return createHash("sha256").update(fileId, "utf8").digest("hex");
}

function pathsFor(fileId: string) {
  const root = storageRoot();
  const key = storageKey(fileId);
  return {
    root,
    content: path.join(root, `${key}.content`),
    manifest: path.join(root, `${key}.json`),
  };
}

function cleanFilename(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return normalized ? normalized.slice(0, 512) : fallback;
}

function cleanMimeType(value: unknown) {
  const normalized = String(value || "")
    .replace(/[\r\n]/g, "")
    .trim();
  return normalized && normalized.length <= 255
    ? normalized
    : "application/octet-stream";
}

async function readManifest(fileId: string) {
  const { manifest } = pathsFor(fileId);
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifest, "utf8"),
    ) as Partial<PresalesFileManifest>;
    if (parsed.schemaVersion !== 1 || parsed.fileId !== fileId) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeManifest(fileId: string, value: PresalesFileManifest) {
  const { root, manifest } = pathsFor(fileId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, manifest);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function recordPresalesFileDescriptor(input: {
  fileId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}) {
  await writeManifest(input.fileId, {
    schemaVersion: 1,
    fileId: input.fileId,
    filename: cleanFilename(input.filename, input.fileId),
    mimeType: cleanMimeType(input.mimeType),
    sizeBytes:
      Number.isSafeInteger(input.sizeBytes) && Number(input.sizeBytes) >= 0
        ? Number(input.sizeBytes)
        : null,
    sha256: null,
    state: "pending",
    updatedAt: new Date().toISOString(),
  });
}

export async function stagePresalesFileContent(input: {
  fileId: string;
  stream: Readable;
  maxBytes: number;
}): Promise<StagedPresalesFile> {
  const paths = pathsFor(input.fileId);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.root, 0o700).catch(() => undefined);
  const temporary = path.join(
    paths.root,
    `${storageKey(input.fileId)}.${randomUUID()}.upload.tmp`,
  );
  let sizeBytes = 0;
  const hash = createHash("sha256");
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > input.maxBytes) {
        callback(new Error("FILE_TOO_LARGE"));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });

  try {
    await pipeline(
      input.stream,
      limiter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  const sha256 = hash.digest("hex");
  let consumed = false;
  const discard = async () => {
    if (consumed) return;
    consumed = true;
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  };

  return {
    sizeBytes,
    sha256,
    createReadStream: () => createReadStream(temporary),
    discard,
    commit: async ({ filename, mimeType }) => {
      if (consumed) throw new Error("STAGED_FILE_ALREADY_CONSUMED");
      const previous = await readManifest(input.fileId);
      const manifest: PresalesFileManifest = {
        schemaVersion: 1,
        fileId: input.fileId,
        filename: cleanFilename(filename ?? previous?.filename, input.fileId),
        mimeType: cleanMimeType(mimeType ?? previous?.mimeType),
        sizeBytes,
        sha256,
        state: "stored",
        updatedAt: new Date().toISOString(),
      };
      try {
        await fs.rename(temporary, paths.content);
        consumed = true;
        await writeManifest(input.fileId, manifest);
      } catch (error) {
        consumed = true;
        await Promise.all([
          fs.rm(temporary, { force: true }).catch(() => undefined),
          fs.rm(paths.content, { force: true }).catch(() => undefined),
        ]);
        throw error;
      }
    },
  };
}

export async function readStoredPresalesFile(
  fileId: string,
): Promise<StoredPresalesFile | null> {
  const paths = pathsFor(fileId);
  let stats;
  try {
    stats = await fs.stat(paths.content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error("LOCAL_FILE_CONTENT_INVALID");
  }
  const manifest = await readManifest(fileId);
  if (
    manifest?.state === "stored" &&
    Number.isSafeInteger(manifest.sizeBytes) &&
    manifest.sizeBytes !== stats.size
  ) {
    throw new Error("LOCAL_FILE_CONTENT_SIZE_MISMATCH");
  }
  return {
    filename: cleanFilename(manifest?.filename, fileId),
    mimeType: cleanMimeType(manifest?.mimeType),
    sizeBytes: stats.size,
    sha256:
      typeof manifest?.sha256 === "string" ? manifest.sha256 : null,
    createReadStream: () => createReadStream(paths.content),
  };
}

export async function removeStoredPresalesFile(fileId: string) {
  const paths = pathsFor(fileId);
  await Promise.all([
    fs.rm(paths.content, { force: true }),
    fs.rm(paths.manifest, { force: true }),
  ]);
}
