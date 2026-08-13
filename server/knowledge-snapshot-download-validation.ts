import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import {
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
  type KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import { getDb } from "./db";
import { knowledgeBuildArtifactLocalPackageStorageKey } from "./knowledge-build-artifact-store";
import {
  isDashboardOwnedKnowledgePackageBuild,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import { knowledgeBasePublicationBindingHash } from "./knowledge-base-publication-binding";

type SnapshotBindingFields = Pick<
  KnowledgeBaseSnapshot,
  | "id"
  | "userId"
  | "sourceFileName"
  | "sourceConversationId"
  | "sourceBuildId"
  | "sourceBuildRevision"
  | "sourceTaskId"
  | "sourceArtifactHash"
  | "archiveHash"
  | "totalBytes"
>;

type BuildBindingFields = Pick<
  KnowledgeBaseBuild,
  | "id"
  | "userId"
  | "conversationId"
  | "companyName"
  | "status"
  | "generation"
  | "revision"
  | "upstreamTaskId"
  | "canonicalTaskId"
  | "packageStatus"
  | "packageRevision"
  | "packageTaskId"
  | "packageOutputItemId"
  | "packageFilename"
  | "packageDescriptorHash"
  | "packageStorageKey"
  | "packageArchiveSha256"
  | "packageSizeBytes"
  | "publishedSnapshotId"
>;

export type DashboardOwnedSnapshotDownloadBinding = {
  buildId: string;
  archiveSha256: string;
  archiveBytes: number;
  expected: {
    buildId: string;
    generation: number;
    revision: number;
    companyName: string;
  };
};

export type KnowledgeSnapshotDownloadValidation =
  | { kind: "historical" }
  | (DashboardOwnedSnapshotDownloadBinding & {
      kind: "dashboard_owned";
      nodes: readonly KnowledgeBaseBuildNode[];
    });

export class KnowledgeSnapshotDownloadBindingError extends Error {
  constructor(message = "知识库本地归档与已发布版本绑定不一致") {
    super(message);
    this.name = "KnowledgeSnapshotDownloadBindingError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedSha256(value: string | null | undefined) {
  const normalized = String(value || "").toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

/**
 * A snapshot is treated as Dashboard-owned only when its persisted publication
 * receipt still binds exactly to the immutable local package row. A build that
 * advertises the local output prefix may never fall back to the historical
 * archive reader: doing so would turn corrupt publication metadata into a
 * weaker download contract.
 */
export function resolveDashboardOwnedSnapshotDownloadBinding(input: {
  snapshot: SnapshotBindingFields;
  build: BuildBindingFields | null | undefined;
}): DashboardOwnedSnapshotDownloadBinding | null {
  const { snapshot, build } = input;
  if (!build || !isDashboardOwnedKnowledgePackageBuild(build)) return null;

  const archiveSha256 = normalizedSha256(build.packageArchiveSha256);
  const snapshotArchiveSha256 = normalizedSha256(snapshot.archiveHash);
  const sourceArtifactHash = normalizedSha256(snapshot.sourceArtifactHash);
  const expectedStorageKey = knowledgeBuildArtifactLocalPackageStorageKey({
    userId: build.userId,
    buildId: build.id,
    generation: build.generation,
    revision: build.revision,
  });
  const expectedOutputItemId = `dashboard-local:${build.id}:${build.revision}`;
  const expectedDescriptorHash = archiveSha256
    ? sha256(
        `dashboard-local:${build.id}:${build.generation}:${build.revision}:${archiveSha256}`,
      )
    : null;
  const writerTaskId = String(
    build.canonicalTaskId || build.upstreamTaskId || "",
  );

  if (
    snapshot.userId !== build.userId ||
    snapshot.sourceBuildId !== build.id ||
    snapshot.sourceConversationId !== build.conversationId ||
    build.status !== "published" ||
    build.publishedSnapshotId !== snapshot.id ||
    !Number.isSafeInteger(build.generation) ||
    build.generation < 1 ||
    !Number.isSafeInteger(build.revision) ||
    build.revision < 0 ||
    snapshot.sourceBuildRevision !== build.revision ||
    build.packageRevision !== build.revision ||
    build.packageStatus !== "ready" ||
    !writerTaskId ||
    build.packageTaskId !== writerTaskId ||
    snapshot.sourceTaskId !== build.packageTaskId ||
    build.packageOutputItemId !== expectedOutputItemId ||
    build.packageStorageKey !== expectedStorageKey ||
    !archiveSha256 ||
    snapshotArchiveSha256 !== archiveSha256 ||
    sourceArtifactHash !== archiveSha256 ||
    knowledgeBasePublicationBindingHash(build) !== archiveSha256 ||
    !expectedDescriptorHash ||
    normalizedSha256(build.packageDescriptorHash) !== expectedDescriptorHash ||
    !Number.isSafeInteger(build.packageSizeBytes) ||
    (build.packageSizeBytes ?? 0) <= 0 ||
    snapshot.totalBytes !== build.packageSizeBytes ||
    !String(build.packageFilename || "").trim() ||
    snapshot.sourceFileName !== build.packageFilename ||
    !String(build.companyName || "").trim()
  ) {
    throw new KnowledgeSnapshotDownloadBindingError();
  }

  return {
    buildId: build.id,
    archiveSha256,
    archiveBytes: build.packageSizeBytes!,
    expected: {
      buildId: build.id,
      generation: build.generation,
      revision: build.revision,
      companyName: build.companyName,
    },
  };
}

function assertBoundArchiveBytes(input: {
  buffer: Buffer;
  expectedSha256: string;
  expectedBytes: number;
}) {
  const actualSha256 = createHash("sha256").update(input.buffer).digest("hex");
  if (
    input.buffer.length !== input.expectedBytes ||
    actualSha256 !== input.expectedSha256
  ) {
    throw new KnowledgeSnapshotDownloadBindingError(
      "知识库本地归档字节与已发布版本不一致",
    );
  }
}

export async function validateDashboardOwnedSnapshotArchiveForDownload(input: {
  buffer: Buffer;
  validation: Extract<
    KnowledgeSnapshotDownloadValidation,
    { kind: "dashboard_owned" }
  >;
}) {
  assertBoundArchiveBytes({
    buffer: input.buffer,
    expectedSha256: input.validation.archiveSha256,
    expectedBytes: input.validation.archiveBytes,
  });
  try {
    await readDashboardOwnedKnowledgePackage({
      buffer: input.buffer,
      expected: input.validation.expected,
      nodes: input.validation.nodes,
    });
  } catch {
    throw new KnowledgeSnapshotDownloadBindingError(
      "知识库本地归档内容与已发布节点不一致",
    );
  }
  // Parsing must never substitute for the immutable byte receipt. Re-check it
  // after CRC, structure, manifest and accepted-node validation completes.
  assertBoundArchiveBytes({
    buffer: input.buffer,
    expectedSha256: input.validation.archiveSha256,
    expectedBytes: input.validation.archiveBytes,
  });
}

export async function loadKnowledgeSnapshotDownloadValidation(
  snapshot: SnapshotBindingFields,
): Promise<KnowledgeSnapshotDownloadValidation> {
  if (!snapshot.sourceBuildId) return { kind: "historical" };
  const db = await getDb();
  if (!db) {
    throw new KnowledgeSnapshotDownloadBindingError(
      "数据库暂不可用，无法复核知识库本地归档绑定",
    );
  }
  const builds = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.id, snapshot.sourceBuildId))
    .limit(1);
  const binding = resolveDashboardOwnedSnapshotDownloadBinding({
    snapshot,
    build: builds[0],
  });
  if (!binding) return { kind: "historical" };
  const nodes = await db
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, binding.buildId));
  return { kind: "dashboard_owned", ...binding, nodes };
}
