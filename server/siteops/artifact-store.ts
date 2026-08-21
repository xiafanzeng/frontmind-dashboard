import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";

import { localAssets, type LocalAsset } from "../../drizzle/schema";
import { getDb } from "../db";
import { sealLocalAssetStorageIdentity } from "../local-asset-storage-key";
import {
  readStoredPresalesFile,
  removeStoredPresalesFile,
  stagePresalesFileContent,
} from "../presales-file-store";

const MAX_SITEOPS_ARTIFACT_BYTES = 100 * 1024 * 1024;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

function safeFilename(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
    .trim();
  if (!normalized || normalized.length > 240) {
    throw new Error("SITEOPS_ARTIFACT_FILENAME_INVALID");
  }
  return normalized;
}

function safeMimeType(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
      normalized,
    )
  ) {
    throw new Error("SITEOPS_ARTIFACT_MIME_INVALID");
  }
  return normalized;
}

/**
 * Stores an immutable SiteOps artifact through the existing local file store.
 * The database row is the tenant ownership boundary; callers never receive a
 * filesystem path or choose a storage key.
 */
export async function persistSiteOpsArtifact(input: {
  userId: number;
  projectId: string;
  kind: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  maxBytes?: number;
}): Promise<LocalAsset> {
  const filename = safeFilename(input.filename);
  const mimeType = safeMimeType(input.mimeType);
  const maxBytes = Math.min(
    Math.max(1, input.maxBytes ?? MAX_SITEOPS_ARTIFACT_BYTES),
    MAX_SITEOPS_ARTIFACT_BYTES,
  );
  if (input.buffer.length < 1 || input.buffer.length > maxBytes) {
    throw new Error("SITEOPS_ARTIFACT_SIZE_INVALID");
  }

  const db = await requireDb();
  const id = randomUUID();
  const storageKey = `siteops:${input.projectId}:${input.kind}:${id}`;
  const staged = await stagePresalesFileContent({
    fileId: id,
    stream: Readable.from(input.buffer),
    maxBytes,
  });
  try {
    await staged.commit({ filename, mimeType });
    await db.insert(localAssets).values(
      sealLocalAssetStorageIdentity({
        id,
        scope: "managed_user" as const,
        accountUserId: input.userId,
        presalesProjectId: null,
        filename,
        mimeType,
        sizeBytes: staged.sizeBytes,
        contentSha256: staged.sha256,
        storageKey,
        refCount: 1,
        // Site builds/deployments pin these rows. Retention is managed by the
        // referencing domain records instead of an arbitrary time window.
        retainUntil: null,
      }),
    );
  } catch (error) {
    await staged.discard().catch(() => undefined);
    await removeStoredPresalesFile(id).catch(() => undefined);
    throw error;
  }
  const rows = await db
    .select()
    .from(localAssets)
    .where(
      and(
        eq(localAssets.id, id),
        eq(localAssets.scope, "managed_user"),
        eq(localAssets.accountUserId, input.userId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("SITEOPS_ARTIFACT_COMMIT_LOST");
  return rows[0];
}

export async function readSiteOpsArtifact(input: {
  userId: number;
  localAssetId: string;
  expectedSha256?: string | null;
  expectedMimeTypes?: readonly string[];
}) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(localAssets)
    .where(
      and(
        eq(localAssets.id, input.localAssetId),
        eq(localAssets.scope, "managed_user"),
        eq(localAssets.accountUserId, input.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    input.expectedSha256 &&
    row.contentSha256 !== input.expectedSha256.toLowerCase()
  ) {
    throw new Error("SITEOPS_ARTIFACT_HASH_MISMATCH");
  }
  if (
    input.expectedMimeTypes &&
    !input.expectedMimeTypes.includes(row.mimeType)
  ) {
    throw new Error("SITEOPS_ARTIFACT_MIME_MISMATCH");
  }
  const stored = await readStoredPresalesFile(row.id);
  if (
    !stored ||
    stored.sizeBytes !== row.sizeBytes ||
    (stored.sha256 && stored.sha256 !== row.contentSha256)
  ) {
    throw new Error("SITEOPS_ARTIFACT_BODY_MISMATCH");
  }
  return { row, stored };
}
