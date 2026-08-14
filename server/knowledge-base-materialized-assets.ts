import { createHash } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import {
  knowledgeBaseWorkingSets,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import type { KnowledgeBaseApprovedResourceDto } from "../shared/knowledge-base-progress";
import {
  type KnowledgeBaseWorkingSetAsset,
  type ValidatedKnowledgeBaseWorkingSet,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";
import { readKnowledgeBaseLocalSource } from "./knowledge-base-local-source-store";

const SHA256_RE = /^[a-f0-9]{64}$/u;

export class KnowledgeBaseMaterializedAssetError extends Error {
  constructor(
    readonly code:
      | "WORKING_SET_NOT_FOUND"
      | "WORKING_SET_COORDINATES_INVALID"
      | "WORKING_SET_RESOURCE_NOT_FOUND"
      | "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseMaterializedAssetError";
  }
}

function resourceError(
  code: KnowledgeBaseMaterializedAssetError["code"],
  message: string,
): never {
  throw new KnowledgeBaseMaterializedAssetError(code, message);
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function filename(value: string, fallback: string) {
  const candidate = path.posix.basename(value).normalize("NFKC").trim();
  return candidate && candidate.length <= 512 ? candidate : fallback;
}

function encoded(value: string) {
  return encodeURIComponent(value);
}

export function knowledgeBaseWorkingSetAssetUrl(input: {
  buildId: string;
  asset: Pick<KnowledgeBaseWorkingSetAsset, "assetId" | "sha256">;
}) {
  return `/api/knowledge-base/artifacts/${encoded(input.buildId)}/working-set/assets/${encoded(input.asset.assetId)}/${input.asset.sha256}`;
}

export function knowledgeBaseWorkingSetEvidenceUrl(input: {
  buildId: string;
  leafId: string;
  path: string;
  sha256: string;
}) {
  return `/api/knowledge-base/artifacts/${encoded(input.buildId)}/working-set/evidence/${encoded(input.leafId)}/${sha256(input.path)}/${input.sha256}`;
}

export function projectKnowledgeBaseWorkingSetLeafResources(input: {
  buildId: string;
  leafId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
}): KnowledgeBaseApprovedResourceDto[] {
  const leaf = input.workingSet.manifest.leaves.find(
    (candidate) => candidate.leafId === input.leafId,
  );
  if (!leaf) {
    return resourceError(
      "WORKING_SET_RESOURCE_NOT_FOUND",
      "Active Working Set does not contain the requested leaf",
    );
  }
  const assetById = new Map(
    input.workingSet.manifest.assets.map((asset) => [asset.assetId, asset]),
  );
  const evidenceByPath = new Map(
    input.workingSet.manifest.evidenceLedger.map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const assetResources = leaf.assetIds.map((assetId) => {
    const asset = assetById.get(assetId);
    const bytes = asset ? input.workingSet.files.get(asset.path) : undefined;
    if (
      !asset ||
      !bytes ||
      bytes.length !== asset.bytes ||
      sha256(bytes) !== asset.sha256 ||
      !asset.documentIds.includes(leaf.leafId)
    ) {
      return resourceError(
        "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
        "Active Working Set asset does not match its manifest binding",
      );
    }
    return {
      kind: "working_set_asset" as const,
      outputItemId: null,
      fileId: null,
      sameOriginUrl: knowledgeBaseWorkingSetAssetUrl({
        buildId: input.buildId,
        asset,
      }),
      filename: filename(asset.path, `${asset.assetId}.img`),
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      sizeBytes: asset.bytes,
    };
  });
  const evidenceResources = leaf.evidencePaths.map((evidencePath) => {
    const evidence = evidenceByPath.get(evidencePath);
    const bytes = evidence
      ? input.workingSet.files.get(evidence.path)
      : undefined;
    if (
      !evidence ||
      evidence.leafId !== leaf.leafId ||
      !bytes ||
      sha256(bytes) !== evidence.sha256
    ) {
      return resourceError(
        "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
        "Active Working Set evidence does not match its manifest binding",
      );
    }
    return {
      kind: "working_set_evidence" as const,
      outputItemId: null,
      fileId: null,
      sameOriginUrl: knowledgeBaseWorkingSetEvidenceUrl({
        buildId: input.buildId,
        leafId: leaf.leafId,
        path: evidence.path,
        sha256: evidence.sha256,
      }),
      filename: filename(evidence.path, `${leaf.leafId}-evidence.txt`),
      mimeType: "text/plain; charset=utf-8",
      sha256: evidence.sha256,
      sizeBytes: bytes.length,
    };
  });
  return [...assetResources, ...evidenceResources];
}

export function knowledgeBaseWorkingSetLeafLocalUrls(input: {
  buildId: string;
  leafId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
}) {
  const resources = projectKnowledgeBaseWorkingSetLeafResources(input);
  return {
    imageUrls: resources
      .filter((resource) => resource.kind === "working_set_asset")
      .map((resource) => resource.sameOriginUrl),
    evidenceUrls: resources
      .filter((resource) => resource.kind === "working_set_evidence")
      .map((resource) => resource.sameOriginUrl),
  };
}

type ActiveWorkingSetBuild = Pick<
  KnowledgeBaseBuild,
  | "id"
  | "generation"
  | "contentVersion"
  | "activeWorkingSetId"
  | "skillContentHash"
  | "companyName"
  | "executionMode"
>;

/**
 * Read and revalidate the exact immutable ZIP selected by activeWorkingSetId.
 * The JSON database projection is never sufficient authority for serving a
 * resource: every byte is checked against the ZIP manifest and stored digest.
 */
export async function readValidatedActiveKnowledgeBaseWorkingSet(input: {
  db: any;
  build: ActiveWorkingSetBuild;
}) {
  const contentVersion = input.build.contentVersion;
  if (
    input.build.executionMode !== "materialized_bundle_v1" ||
    !input.build.activeWorkingSetId ||
    contentVersion === null ||
    contentVersion < 1
  ) {
    return resourceError(
      "WORKING_SET_COORDINATES_INVALID",
      "Build has no active materialized Working Set",
    );
  }
  const row = (
    await input.db
      .select()
      .from(knowledgeBaseWorkingSets)
      .where(
        and(
          eq(knowledgeBaseWorkingSets.id, input.build.activeWorkingSetId),
          eq(knowledgeBaseWorkingSets.buildId, input.build.id),
          eq(knowledgeBaseWorkingSets.generation, input.build.generation),
          eq(knowledgeBaseWorkingSets.contentVersion, contentVersion),
          eq(knowledgeBaseWorkingSets.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!row) {
    return resourceError(
      "WORKING_SET_NOT_FOUND",
      "Active Working Set row is unavailable",
    );
  }
  if (
    !SHA256_RE.test(row.packageSha256) ||
    !SHA256_RE.test(row.manifestSha256)
  ) {
    return resourceError(
      "WORKING_SET_COORDINATES_INVALID",
      "Active Working Set digest coordinates are invalid",
    );
  }
  let bytes: Buffer;
  let validated: ValidatedKnowledgeBaseWorkingSet;
  try {
    bytes = await readKnowledgeBaseLocalSource({
      storageKey: row.storageKey,
      contentSha256: row.packageSha256,
      sizeBytes: row.sizeBytes,
    });
    validated = await validateKnowledgeBaseWorkingSetArchive(bytes, {
      buildId: input.build.id,
      generation: input.build.generation,
      contentVersion,
      skillContentHash: input.build.skillContentHash || undefined,
      companyName: input.build.companyName,
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseMaterializedAssetError) throw error;
    return resourceError(
      "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
      "Active Working Set bytes failed their immutable manifest proof",
    );
  }
  if (
    validated.packageSha256 !== row.packageSha256 ||
    validated.manifestSha256 !== row.manifestSha256
  ) {
    return resourceError(
      "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
      "Active Working Set bytes do not match the selected row",
    );
  }
  return { row, bytes, validated };
}

export function resolveKnowledgeBaseWorkingSetResource(input: {
  buildId: string;
  workingSet: ValidatedKnowledgeBaseWorkingSet;
  kind: "asset" | "evidence";
  assetId?: string;
  leafId?: string;
  pathSha256?: string;
  expectedSha256: string;
}) {
  if (!SHA256_RE.test(input.expectedSha256)) {
    return resourceError(
      "WORKING_SET_RESOURCE_NOT_FOUND",
      "Working Set resource digest is invalid",
    );
  }
  if (input.kind === "asset") {
    const asset = input.workingSet.manifest.assets.find(
      (candidate) => candidate.assetId === input.assetId,
    );
    if (!asset || asset.sha256 !== input.expectedSha256) {
      return resourceError(
        "WORKING_SET_RESOURCE_NOT_FOUND",
        "Working Set asset is not registered",
      );
    }
    const bytes = input.workingSet.files.get(asset.path);
    if (
      !bytes ||
      bytes.length !== asset.bytes ||
      sha256(bytes) !== asset.sha256
    ) {
      return resourceError(
        "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
        "Working Set asset bytes failed their manifest proof",
      );
    }
    return {
      bytes,
      filename: filename(asset.path, `${asset.assetId}.img`),
      mimeType: asset.mimeType,
      disposition: "inline" as const,
    };
  }
  const leaf = input.workingSet.manifest.leaves.find(
    (candidate) => candidate.leafId === input.leafId,
  );
  const evidence = leaf?.evidencePaths
    .map((evidencePath) =>
      input.workingSet.manifest.evidenceLedger.find(
        (candidate) => candidate.path === evidencePath,
      ),
    )
    .find(
      (candidate) =>
        candidate &&
        candidate.leafId === leaf?.leafId &&
        candidate.sha256 === input.expectedSha256 &&
        sha256(candidate.path) === input.pathSha256,
    );
  if (!leaf || !evidence) {
    return resourceError(
      "WORKING_SET_RESOURCE_NOT_FOUND",
      "Working Set evidence is not registered for this leaf",
    );
  }
  const bytes = input.workingSet.files.get(evidence.path);
  if (!bytes || sha256(bytes) !== evidence.sha256) {
    return resourceError(
      "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH",
      "Working Set evidence bytes failed their manifest proof",
    );
  }
  return {
    bytes,
    filename: filename(evidence.path, `${leaf.leafId}-evidence.txt`),
    mimeType: "text/plain; charset=utf-8",
    disposition: "attachment" as const,
  };
}
