import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { websiteProjectDeletionTombstones } from "../drizzle/schema";

const candidateBytes = Buffer.from("candidate artifact bytes");
const finalBytes = Buffer.from("finalized local knowledge archive bytes");
const candidateSha256 = createHash("sha256")
  .update(candidateBytes)
  .digest("hex");
const finalSha256 = createHash("sha256").update(finalBytes).digest("hex");
const candidateArtifactId = `artifact_${"a".repeat(64)}`;
const finalArtifactId = `artifact_${"b".repeat(64)}`;

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readArtifact: vi.fn(),
  readStoredFile: vi.fn(),
  readKnowledgeArchive: vi.fn(),
  removeStoredKnowledgeAssets: vi.fn(),
  persistKnowledgeSnapshotArchive: vi.fn(),
  removeKnowledgeSnapshotArchive: vi.fn(),
  assertKnowledgeArchiveEnterpriseIdentity: vi.fn(),
  createKnowledgeSnapshot: vi.fn(),
  getDashboardWorkspace: vi.fn(),
  getKnowledgeSnapshotById: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./presales-v2-store", () => ({
  readPresalesV2Artifact: mocks.readArtifact,
}));
vi.mock("./presales-file-store", () => ({
  readStoredPresalesFile: mocks.readStoredFile,
}));
vi.mock("./dashboard-api", () => ({
  assertKnowledgeArchiveEnterpriseIdentity:
    mocks.assertKnowledgeArchiveEnterpriseIdentity,
  readKnowledgeArchive: mocks.readKnowledgeArchive,
  removeStoredKnowledgeAssets: mocks.removeStoredKnowledgeAssets,
}));
vi.mock("./dashboard-service", () => ({
  createKnowledgeSnapshot: mocks.createKnowledgeSnapshot,
  getDashboardWorkspace: mocks.getDashboardWorkspace,
  getKnowledgeSnapshotById: mocks.getKnowledgeSnapshotById,
}));
vi.mock("./knowledge-snapshot-archive-store", () => ({
  persistKnowledgeSnapshotArchive: mocks.persistKnowledgeSnapshotArchive,
  removeKnowledgeSnapshotArchive: mocks.removeKnowledgeSnapshotArchive,
}));
vi.mock("./service-entitlement", () => {
  class ServiceEntitlementError extends Error {
    statusCode = 403;
  }
  return {
    assertServiceCapability: mocks.assertServiceCapability,
    ServiceEntitlementError,
  };
});
vi.mock("./knowledge-base-reset-service", () => ({
  assertKnowledgeBaseWritable: mocks.assertKnowledgeBaseWritable,
}));
vi.mock("./delivery-role-service", () => ({
  createKnowledgeMonitoringHandoff: mocks.createKnowledgeMonitoringHandoff,
}));

import { importWebsiteKnowledgeArtifact } from "./knowledge-import-service";

function queryResult<T>(rows: T[]) {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => query,
    for: async () => rows,
  };
  return query;
}

function importDatabase(transactionResults: unknown[][] = [[], []]) {
  const txUpdate = {
    set: () => txUpdate,
    where: vi.fn().mockResolvedValue(undefined),
  };
  const tx = {
    select: () => ({
      from: (table: unknown) =>
        table === websiteProjectDeletionTombstones
          ? queryResult([{ status: "active" }])
          : queryResult(transactionResults.shift() ?? []),
    }),
    insert: (table: unknown) => ({
      values:
        table === websiteProjectDeletionTombstones
          ? () => ({
              onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
            })
          : vi.fn().mockResolvedValue(undefined),
    }),
    update: () => txUpdate,
  };
  const provisionQuery = {
    from: () => provisionQuery,
    where: () => {
      const rows = [
        { userId: 7, companyName: "示例企业", status: "completed" },
      ];
      const result = Promise.resolve(rows) as Promise<typeof rows> & {
        limit: () => Promise<typeof rows>;
      };
      result.limit = async () => rows;
      return result;
    },
  };
  const updateQuery = {
    set: () => updateQuery,
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    select: () => provisionQuery,
    transaction: async (operation: (value: typeof tx) => unknown) =>
      operation(tx),
    update: () => updateQuery,
  };
}

function value(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5 as const,
    companyName: "示例企业",
    candidateArtifactId,
    finalArtifactId,
    candidateSha256,
    finalSha256,
    packageManifestSha256: "c".repeat(64),
    finalizerVersion: "website-kb-finalizer-v1" as const,
    ...overrides,
  };
}

function stored(bytes: Buffer, sha256: string, filename: string) {
  return {
    filename,
    mimeType: "application/zip",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256,
    uploadedAt: new Date(),
    contentExpiresAt: new Date(Date.now() + 60_000),
    contentStoredAt: new Date(),
    manifestUpdatedAt: new Date(),
    createReadStream: () => Readable.from(bytes),
  };
}

describe("website knowledge import v5 local artifact binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue(importDatabase());
    mocks.readArtifact.mockImplementation(async (artifactId: string) =>
      artifactId === candidateArtifactId
        ? {
            artifactId,
            projectId: "project-acceptance-001",
            filename: "candidate.zip",
            mimeType: "application/zip",
            bytes: candidateBytes.length,
            sha256: candidateSha256,
          }
        : artifactId === finalArtifactId
          ? {
              artifactId,
              projectId: "project-acceptance-001",
              filename: "示例企业_knowledge_base.zip",
              mimeType: "application/zip",
              bytes: finalBytes.length,
              sha256: finalSha256,
            }
          : null,
    );
    mocks.readStoredFile.mockImplementation(async (artifactId: string) =>
      artifactId === candidateArtifactId
        ? stored(candidateBytes, candidateSha256, "candidate.zip")
        : artifactId === finalArtifactId
          ? stored(
              finalBytes,
              finalSha256,
              "示例企业_knowledge_base.zip",
            )
          : null,
    );
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "c".repeat(64),
      storedAssetKeys: [],
      documents: [],
      assets: [],
    });
    mocks.removeStoredKnowledgeAssets.mockResolvedValue(undefined);
    mocks.persistKnowledgeSnapshotArchive.mockResolvedValue(
      "knowledge-archives/7/snapshot-new.zip",
    );
    mocks.removeKnowledgeSnapshotArchive.mockResolvedValue(undefined);
    mocks.getDashboardWorkspace.mockResolvedValue({
      payload: { brandName: "示例企业" },
    });
    mocks.createKnowledgeSnapshot.mockResolvedValue({
      id: "snapshot-new",
      version: 2,
    });
    mocks.getKnowledgeSnapshotById.mockResolvedValue({
      id: "snapshot-existing",
      version: 1,
    });
    mocks.assertServiceCapability.mockResolvedValue(undefined);
    mocks.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
    mocks.createKnowledgeMonitoringHandoff.mockResolvedValue({
      created: [],
      assigned: false,
    });
  });

  it("imports the exact final local bytes without any Provider lookup", async () => {
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-acceptance-v5",
        value: value(),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      replayed: false,
      snapshot: { id: "snapshot-new" },
    });
    expect(mocks.readKnowledgeArchive).toHaveBeenCalledWith(
      finalBytes,
      "示例企业_knowledge_base.zip",
      expect.any(String),
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: undefined,
      },
    );
    expect(mocks.persistKnowledgeSnapshotArchive).toHaveBeenCalledWith({
      userId: 7,
      snapshotId: expect.any(String),
      buffer: finalBytes,
      expectedSha256: finalSha256,
    });
    expect(mocks.createKnowledgeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: candidateArtifactId,
        sourceArtifactHash: candidateSha256,
        archiveHash: finalSha256,
      }),
    );
  });

  it("rejects project ownership and byte/hash mismatches before importing", async () => {
    mocks.readArtifact.mockImplementation(async (artifactId: string) => ({
      artifactId,
      projectId: "different-project",
      filename: "knowledge.zip",
      bytes:
        artifactId === candidateArtifactId
          ? candidateBytes.length
          : finalBytes.length,
      sha256:
        artifactId === candidateArtifactId ? candidateSha256 : finalSha256,
    }));
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-project-mismatch-v5",
        value: value(),
      }),
    ).rejects.toMatchObject({ code: "TASK_PROJECT_MISMATCH", status: 403 });
    expect(mocks.readKnowledgeArchive).not.toHaveBeenCalled();

    mocks.readArtifact.mockReset();
    mocks.readArtifact.mockResolvedValue({
      artifactId: candidateArtifactId,
      projectId: "project-acceptance-001",
      filename: "bad.zip",
      bytes: candidateBytes.length,
      sha256: "f".repeat(64),
    });
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-hash-mismatch-v5",
        value: value(),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH", status: 409 });
  });

  it("rejects a package manifest hash mismatch and removes staged assets", async () => {
    mocks.readKnowledgeArchive.mockResolvedValue({
      packageManifestSha256: "f".repeat(64),
      storedAssetKeys: ["staged-image.webp"],
      documents: [],
      assets: [],
    });
    await expect(
      importWebsiteKnowledgeArtifact({
        projectId: "project-acceptance-001",
        idempotencyKey: "website-kb-manifest-mismatch-v5",
        value: value(),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH", status: 409 });
    expect(mocks.removeStoredKnowledgeAssets).toHaveBeenCalledWith([
      "staged-image.webp",
    ]);
    expect(mocks.createKnowledgeSnapshot).not.toHaveBeenCalled();
  });
});
