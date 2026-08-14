import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import JSZip from "jszip";

import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseExecutions,
  knowledgeBaseResetStates,
  knowledgeBaseWorkingSets,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { getDb } from "./db";
import { knowledgeBasePresentationKey } from "./knowledge-base-authoritative-message";
import {
  persistKnowledgeBaseCompletionInTransaction,
  persistKnowledgeBasePresentationInTransaction,
  persistKnowledgeBaseUserMessageInTransaction,
} from "./knowledge-base-conversation-messages";
import {
  type KnowledgeBaseNodePatchManifest,
  type KnowledgeBaseWorkingSetManifest,
  validateKnowledgeBaseNodePatchArchive,
  validateKnowledgeBaseWorkingSetArchive,
} from "./knowledge-base-materialized-contract";
import { knowledgeBaseWorkingSetLeafLocalUrls } from "./knowledge-base-materialized-assets";
import {
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import {
  knowledgeBuildArtifactCandidateStorageKey,
  persistKnowledgeBuildArtifact,
  readKnowledgeBuildArtifact,
  removeKnowledgeBuildArtifact,
  removeStagedKnowledgeBuildArtifact,
} from "./knowledge-build-artifact-store";
import {
  persistKnowledgeBaseBuildSource,
  readKnowledgeBaseLocalSource,
} from "./knowledge-base-local-source-store";
import { knowledgeBaseObservationConversationStorageId } from "./knowledge-base-progress-service";

export const MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE =
  "materialized_bundle_v1" as const;

type MaterializedErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "RESET_REQUIRED"
  | "BUILD_NOT_FOUND"
  | "STALE_COORDINATES"
  | "INVALID_BUILD_STATE"
  | "LOGO_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "PATCH_CONFLICT";

export class KnowledgeBaseMaterializedError extends Error {
  constructor(
    readonly code: MaterializedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseMaterializedError";
  }
}

function fail(code: MaterializedErrorCode, message: string): never {
  throw new KnowledgeBaseMaterializedError(code, message);
}

async function requireDb() {
  const db = await getDb();
  if (!db) fail("DATABASE_UNAVAILABLE", "Database is not configured");
  return db;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

type MaterializedStagedOfficialLogo = {
  storageKey: string;
  sha256: string;
  bytes: number;
  filename: string;
  mimeType: string;
  operationKey: string;
  expectedRevision: number;
  expectedLeafId: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads the server-authored staging ledger for a manual v5 Logo revision.
 * A manual Logo turn may never activate a PATCH without this exact tuple.
 */
export function materializedStagedOfficialLogoFromTurnMetadata(input: {
  metadata: unknown;
  operationKey: string;
  expectedRevision: number;
  expectedLeafId: string;
}): MaterializedStagedOfficialLogo | null {
  const metadata = record(input.metadata);
  const recovery = record(metadata?.recovery);
  if (recovery?.manualLogoSubmission !== true) return null;
  const staged = record(recovery.stagedOfficialLogo);
  const verifiedUpload = record(recovery.officialLogoUpload);
  const storageKey = String(staged?.storageKey || "");
  const digest = String(staged?.sha256 || "").toLowerCase();
  const bytes = Number(staged?.bytes);
  const filename = String(staged?.filename || "");
  const mimeType = String(staged?.mimeType || "").toLowerCase();
  const operationKey = String(staged?.operationKey || "");
  const expectedRevision = Number(staged?.expectedRevision);
  const expectedLeafId = String(staged?.expectedLeafId || "");
  if (
    staged?.schemaVersion !== 1 ||
    staged.kind !== "materialized_official_logo" ||
    !storageKey ||
    storageKey.length > 2048 ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    !filename ||
    filename.length > 512 ||
    !["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(
      mimeType,
    ) ||
    operationKey !== input.operationKey ||
    expectedRevision !== input.expectedRevision ||
    expectedLeafId !== input.expectedLeafId ||
    verifiedUpload?.verified !== true ||
    String(verifiedUpload.sourceSha256 || "").toLowerCase() !== digest ||
    Number(verifiedUpload.sizeBytes) !== bytes ||
    String(verifiedUpload.filename || "").slice(0, 512) !== filename ||
    String(verifiedUpload.mimeType || "").toLowerCase() !== mimeType
  ) {
    fail(
      "PATCH_CONFLICT",
      "Logo revision staging ledger does not match the active PATCH",
    );
  }
  return {
    storageKey,
    sha256: digest,
    bytes,
    filename,
    mimeType,
    operationKey,
    expectedRevision,
    expectedLeafId,
  };
}

export function materializedOfficialLogoActivationPlan(input: {
  current: {
    storageKey: string | null;
    sha256: string | null;
    bytes: number | null;
    mimeType: string | null;
  };
  staged: MaterializedStagedOfficialLogo | null;
}) {
  if (!input.staged) {
    return {
      logoUpdate: null,
      oldStorageKey: null,
      removeStaged: false,
    } as const;
  }
  const sameLogo =
    input.current.sha256 === input.staged.sha256 &&
    input.current.bytes === input.staged.bytes &&
    input.current.mimeType === input.staged.mimeType;
  if (sameLogo) {
    return {
      logoUpdate: null,
      oldStorageKey: null,
      removeStaged: input.current.storageKey !== input.staged.storageKey,
    } as const;
  }
  return {
    logoUpdate: {
      logoStorageKey: input.staged.storageKey,
      logoSha256: input.staged.sha256,
      logoBytes: input.staged.bytes,
      logoFilename: input.staged.filename,
      logoMimeType: input.staged.mimeType,
    },
    oldStorageKey: input.current.storageKey,
    removeStaged: false,
  } as const;
}

function operationKey(kind: string, requestHash: string) {
  return `kb:${kind}:${requestHash}`.slice(0, 128);
}

function materializedBuild(
  build: KnowledgeBaseBuild,
): asserts build is KnowledgeBaseBuild & {
  executionMode: "materialized_bundle_v1";
  skillVersion: "5";
  providerProtocol: "manus_v2";
  contentVersion: number;
} {
  if (
    build.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2" ||
    build.contentVersion === null
  ) {
    fail(
      "RESET_REQUIRED",
      "此知识库不是完整物化的 v5 构建；请批准重置、重新上传并创建全新 v2 任务",
    );
  }
}

function nodeMarkdown(
  manifest: KnowledgeBaseWorkingSetManifest,
  leafId: string,
  files: ReadonlyMap<string, Buffer>,
) {
  const leaf = manifest.leaves.find((item) => item.leafId === leafId);
  if (!leaf) fail("INVALID_BUILD_STATE", `Working Set 缺少节点 ${leafId}`);
  return canonicalKnowledgeBaseMarkdown(
    files.get(leaf.contentPath)!.toString("utf8"),
  );
}

/**
 * Atomically activates a complete provider bundle. The provider task becomes
 * immutable audit provenance only; all subsequent reads and confirmations use
 * Dashboard-owned rows and bytes.
 */
export async function activateInitialKnowledgeBaseWorkingSet(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  executionId?: string;
  providerTaskId: string;
  archiveBytes: Buffer;
  expectedSkillContentHash: string;
  receivedAt?: Date;
}) {
  const db = await requireDb();
  const receivedAt = input.receivedAt ?? new Date();
  const validated = await validateKnowledgeBaseWorkingSetArchive(
    input.archiveBytes,
    {
      operationId: input.operationKey,
      buildId: input.buildId,
      generation: input.generation,
      contentVersion: 1,
      skillContentHash: input.expectedSkillContentHash,
    },
  );
  const retained = await persistKnowledgeBaseBuildSource({
    userId: input.userId,
    buildId: input.buildId,
    generation: input.generation,
    bytes: input.archiveBytes,
  });
  const logoAsset =
    validated.manifest.logo.status === "available"
      ? validated.manifest.assets.find(
          (asset) => asset.assetId === validated.manifest.logo.assetId,
        )
      : undefined;
  const logoBytes = logoAsset ? validated.files.get(logoAsset.path) : undefined;
  const logo =
    logoAsset && logoBytes
      ? await persistKnowledgeBuildArtifact({
          userId: input.userId,
          buildId: input.buildId,
          generation: input.generation,
          kind: "logo",
          buffer: logoBytes,
          expectedSha256: logoAsset.sha256,
          storageKey: knowledgeBuildArtifactCandidateStorageKey({
            userId: input.userId,
            buildId: input.buildId,
            generation: input.generation,
            turnId: input.turnId,
            operationKey: input.operationKey,
            descriptorHash: sha256(
              `${logoAsset.assetId}:${logoAsset.path}:${logoAsset.sha256}`,
            ),
            artifactSha256: logoAsset.sha256,
            kind: "logo",
          }),
        })
      : null;

  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, input.buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
    materializedBuild(build);
    if (
      build.generation !== input.generation ||
      build.activeTurnId !== input.turnId ||
      build.contentVersion !== 0 ||
      build.activeWorkingSetId ||
      build.skillVersion !== "5" ||
      build.skillContentHash !== input.expectedSkillContentHash
    ) {
      fail("STALE_COORDINATES", "初始 Working Set 已过期或构建坐标不一致");
    }
    const turn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, build.id),
            eq(conversationTurns.buildGeneration, build.generation),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      !turn ||
      turn.operationKey !== input.operationKey ||
      turn.upstreamTaskId !== input.providerTaskId ||
      !["queued", "running"].includes(turn.status)
    ) {
      fail("STALE_COORDINATES", "初始执行已失去当前构建所有权");
    }
    const existingNodes = await tx
      .select({ id: knowledgeBaseBuildNodes.id })
      .from(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
      .limit(1)
      .for("update");
    if (existingNodes.length)
      fail("INVALID_BUILD_STATE", "新构建已存在节点数据");

    const workingSetId = randomUUID();
    await tx.insert(knowledgeBaseWorkingSets).values({
      id: workingSetId,
      buildId: build.id,
      generation: build.generation,
      contentVersion: 1,
      sourceExecutionId: input.executionId ?? null,
      storageKey: retained.storageKey,
      sizeBytes: retained.sizeBytes,
      packageSha256: validated.packageSha256,
      manifestSha256: validated.manifestSha256,
      manifest: validated.manifest,
      status: "active",
      activatedAt: receivedAt,
      createdAt: receivedAt,
    });
    const rows = validated.manifest.leaves.map((leaf, index) => {
      const markdown = nodeMarkdown(
        validated.manifest,
        leaf.leafId,
        validated.files,
      );
      const localUrls = knowledgeBaseWorkingSetLeafLocalUrls({
        buildId: build.id,
        leafId: leaf.leafId,
        workingSet: validated,
      });
      const sourceUrls = [
        ...localUrls.evidenceUrls,
        ...validated.manifest.evidenceLedger
          .filter((entry) => entry.leafId === leaf.leafId && entry.sourceUrl)
          .map((entry) => entry.sourceUrl!),
      ].filter((url, position, all) => all.indexOf(url) === position);
      return {
        id: randomUUID(),
        buildId: build.id,
        leafId: leaf.leafId,
        branchId: leaf.branchId,
        branchTitle: leaf.branchTitle,
        title: leaf.title,
        ordinal: index,
        status: index === 0 ? ("current" as const) : ("pending" as const),
        transitionReason:
          index === 0
            ? "materialized_initial_current"
            : "materialized_initial_pending",
        contentMarkdown: markdown,
        sourceUrls,
        imageUrls: localUrls.imageUrls,
        lastTaskId: input.providerTaskId,
        sourceTurnId: input.turnId,
        contentSha256: knowledgeBaseMarkdownSha256(markdown),
        contentVersion: 1,
        assetRefs: leaf.assetIds,
        lastResponseAt: receivedAt,
        createdAt: receivedAt,
        updatedAt: receivedAt,
      };
    });
    await tx.insert(knowledgeBaseBuildNodes).values(rows);
    const current = rows[0]!;
    const presentationKey = knowledgeBasePresentationKey({
      buildId: build.id,
      generation: build.generation,
      revision: build.revision,
      leafId: current.leafId,
      content: current.contentMarkdown,
    });
    await tx
      .update(knowledgeBaseBuildNodes)
      .set({ presentationKey })
      .where(eq(knowledgeBaseBuildNodes.id, current.id));
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        executionMode: MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE,
        providerProtocol: "manus_v2",
        activeWorkingSetId: workingSetId,
        contentVersion: 1,
        upstreamTaskId: null,
        canonicalTaskId: null,
        canonicalTaskGeneration: null,
        canonicalCredentialId: null,
        canonicalTaskState: "unbound",
        status: "confirming",
        activeTurnId: null,
        currentLeafId: current.leafId,
        currentPresentationKey: presentationKey,
        totalNodeCount: rows.length,
        confirmedCount: 0,
        directPrefilledCount: 0,
        needsVerificationCount: 0,
        stateEpoch: build.stateEpoch + 1,
        lastAppliedOperationKey: input.operationKey,
        awaitingResponseSince: null,
        protocolErrorCode: null,
        protocolError: null,
        logoStorageKey: logo?.storageKey ?? null,
        logoSha256: logo?.sha256 ?? null,
        logoBytes: logo?.bytes ?? null,
        logoFilename: logoAsset?.path.split("/").at(-1) ?? null,
        logoMimeType: logoAsset?.mimeType ?? null,
        updatedAt: receivedAt,
      })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    await tx
      .update(conversationTurns)
      .set({
        status: "completed",
        completedAt: receivedAt,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        metadata: {
          ...(turn.metadata || {}),
          execution: "materialized_bundle",
          dispatchState: "completed",
          contentVersion: 1,
          workingSetId,
        },
        updatedAt: receivedAt,
      })
      .where(eq(conversationTurns.id, turn.id));
    if (input.executionId) {
      await tx
        .update(knowledgeBaseExecutions)
        .set({
          providerTaskId: input.providerTaskId,
          status: "succeeded",
          completedAt: receivedAt,
          updatedAt: receivedAt,
        })
        .where(
          and(
            eq(knowledgeBaseExecutions.id, input.executionId),
            eq(knowledgeBaseExecutions.buildId, build.id),
          ),
        );
    }
    await persistKnowledgeBasePresentationInTransaction({
      tx,
      userId: input.userId,
      conversationId: knowledgeBaseObservationConversationStorageId(
        input.userId,
        build.conversationId,
      ),
      turnId: turn.id,
      buildId: build.id,
      generation: build.generation,
      operationKey: input.operationKey,
      presentationKey,
      revision: build.revision,
      leafId: current.leafId,
      content: current.contentMarkdown,
      authoritativeTaskId: null,
      sentAt: receivedAt,
    });
    return {
      buildId: build.id,
      workingSetId,
      contentVersion: 1,
      currentLeafId: current.leafId,
      totalNodeCount: rows.length,
    };
  });
}

export type ConfirmMaterializedKnowledgeBaseInput = {
  userId: number;
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedResetRevision?: number;
  expectedStateEpoch: number;
  expectedRevision: number;
  expectedLeafId: string;
  expectedPresentationKey: string;
  expectedContentVersion: number;
  confirmedAt?: Date;
};

/** Pure local confirmation. This module has no provider client dependency. */
export async function confirmMaterializedKnowledgeBaseNode(
  input: ConfirmMaterializedKnowledgeBaseInput,
) {
  const db = await requireDb();
  const confirmedAt = input.confirmedAt ?? new Date();
  const storedConversationId = knowledgeBaseObservationConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const requestHash = sha256(
    stableJson({
      conversationId: input.conversationId,
      expectedGeneration: input.expectedGeneration,
      expectedResetRevision: input.expectedResetRevision,
      expectedStateEpoch: input.expectedStateEpoch,
      expectedRevision: input.expectedRevision,
      expectedLeafId: input.expectedLeafId,
      expectedPresentationKey: input.expectedPresentationKey,
      expectedContentVersion: input.expectedContentVersion,
    }),
  );
  return db.transaction(async (tx: any) => {
    const existing = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.conversationId, storedConversationId),
            eq(conversationTurns.clientRequestId, input.clientRequestId),
            eq(conversationTurns.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (existing) {
      if (
        existing.operationType !== "local_confirm" ||
        existing.requestHash !== requestHash
      ) {
        fail("IDEMPOTENCY_CONFLICT", "clientRequestId 已被其他操作使用");
      }
      if (existing.status !== "completed") {
        fail("INVALID_BUILD_STATE", "相同确认操作仍在处理");
      }
      return {
        accepted: true as const,
        execution: "local" as const,
        disposition: "idempotent" as const,
        buildId: existing.buildId!,
      };
    }

    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.conversationId, input.conversationId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
    materializedBuild(build);
    const resetState = (
      await tx
        .select()
        .from(knowledgeBaseResetStates)
        .where(eq(knowledgeBaseResetStates.userId, input.userId))
        .limit(1)
        .for("update")
    )[0];
    const resetRevision = resetState?.revision ?? 0;
    if (
      build.generation !== input.expectedGeneration ||
      (input.expectedResetRevision !== undefined &&
        resetRevision !== input.expectedResetRevision) ||
      build.stateEpoch !== input.expectedStateEpoch ||
      build.revision !== input.expectedRevision ||
      build.currentLeafId !== input.expectedLeafId ||
      build.currentPresentationKey !== input.expectedPresentationKey ||
      build.contentVersion !== input.expectedContentVersion
    ) {
      fail("STALE_COORDINATES", "知识库状态已更新，请刷新后确认当前节点");
    }
    if (
      build.status !== "confirming" ||
      build.activeTurnId ||
      !build.activeWorkingSetId ||
      build.contentVersion < 1
    ) {
      fail("INVALID_BUILD_STATE", "当前构建不可执行本地确认");
    }
    const current = (
      await tx
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(
          and(
            eq(knowledgeBaseBuildNodes.buildId, build.id),
            eq(knowledgeBaseBuildNodes.leafId, input.expectedLeafId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuildNode | undefined;
    if (
      !current ||
      (current.status !== "current" &&
        current.status !== "needs_verification") ||
      current.presentationKey !== input.expectedPresentationKey ||
      current.contentVersion !== build.contentVersion ||
      !canonicalKnowledgeBaseMarkdown(current.contentMarkdown || "")
    ) {
      fail("STALE_COORDINATES", "当前节点与展示内容不一致");
    }
    if (build.confirmedCount === 0 && !build.logoStorageKey) {
      fail("LOGO_REQUIRED", "确认第一节点前请上传企业官方 Logo");
    }

    const next = (
      await tx
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(
          and(
            eq(knowledgeBaseBuildNodes.buildId, build.id),
            eq(knowledgeBaseBuildNodes.ordinal, current.ordinal + 1),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuildNode | undefined;
    if (next && next.status !== "pending") {
      fail("INVALID_BUILD_STATE", "下一节点状态异常");
    }
    const turnId = randomUUID();
    const localOperationKey = operationKey("confirm", requestHash);
    await tx.insert(conversationTurns).values({
      id: turnId,
      conversationId: storedConversationId,
      userId: input.userId,
      apiCredentialId: null,
      clientRequestId: input.clientRequestId,
      buildId: build.id,
      buildGeneration: build.generation,
      operationKey: localOperationKey,
      operationType: "local_confirm",
      expectedRevision: build.revision,
      expectedLeafId: current.leafId,
      requestHash,
      attachmentFileIds: [],
      metadata: {
        execution: "local",
        providerRequestCount: 0,
        expectedContentVersion: build.contentVersion,
      },
      model: null,
      status: "running",
      upstreamTaskId: null,
      startedAt: confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
    });
    await persistKnowledgeBaseUserMessageInTransaction({
      tx,
      userId: input.userId,
      conversationId: storedConversationId,
      turnId,
      buildId: build.id,
      generation: build.generation,
      operationKey: localOperationKey,
      clientRequestId: input.clientRequestId,
      revision: build.revision,
      leafId: current.leafId,
      content: "确认",
      sentAt: confirmedAt,
    });
    await tx
      .update(knowledgeBaseBuildNodes)
      .set({
        status: "confirmed",
        transitionReason: "local_materialized_confirm",
        confirmedAt,
        updatedAt: confirmedAt,
      })
      .where(eq(knowledgeBaseBuildNodes.id, current.id));

    const nextRevision = build.revision + 1;
    let nextPresentationKey: string | null = null;
    if (next) {
      const nextContent = canonicalKnowledgeBaseMarkdown(
        next.contentMarkdown || "",
      );
      if (!nextContent || next.contentVersion !== build.contentVersion) {
        fail("INVALID_BUILD_STATE", "下一节点尚未完整物化");
      }
      nextPresentationKey = knowledgeBasePresentationKey({
        buildId: build.id,
        generation: build.generation,
        revision: nextRevision,
        leafId: next.leafId,
        content: nextContent,
      });
      await tx
        .update(knowledgeBaseBuildNodes)
        .set({
          status: "current",
          transitionReason: "local_materialized_advance",
          presentationKey: nextPresentationKey,
          updatedAt: confirmedAt,
        })
        .where(eq(knowledgeBaseBuildNodes.id, next.id));
      await persistKnowledgeBasePresentationInTransaction({
        tx,
        userId: input.userId,
        conversationId: storedConversationId,
        turnId,
        buildId: build.id,
        generation: build.generation,
        operationKey: localOperationKey,
        presentationKey: nextPresentationKey,
        revision: nextRevision,
        leafId: next.leafId,
        content: nextContent,
        authoritativeTaskId: null,
        sentAt: confirmedAt,
      });
    } else {
      await persistKnowledgeBaseCompletionInTransaction({
        tx,
        userId: input.userId,
        conversationId: storedConversationId,
        turnId,
        buildId: build.id,
        generation: build.generation,
        operationKey: localOperationKey,
        revision: nextRevision,
        authoritativeTaskId: null,
        sentAt: confirmedAt,
      });
    }
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: next ? "confirming" : "ready_to_publish",
        revision: nextRevision,
        stateEpoch: build.stateEpoch + 1,
        currentLeafId: next?.leafId ?? null,
        currentPresentationKey: nextPresentationKey,
        confirmedCount: build.confirmedCount + 1,
        needsVerificationCount:
          current.status === "needs_verification"
            ? Math.max(0, build.needsVerificationCount - 1)
            : build.needsVerificationCount,
        lastAppliedOperationKey: localOperationKey,
        contentCompletedAt: next ? build.contentCompletedAt : confirmedAt,
        packageStatus: next ? build.packageStatus : "preparing",
        packageNextRetryAt: next ? build.packageNextRetryAt : confirmedAt,
        updatedAt: confirmedAt,
      })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    await tx
      .update(conversationTurns)
      .set({
        status: "completed",
        completedAt: confirmedAt,
        metadata: {
          execution: "local",
          providerRequestCount: 0,
          disposition: next ? "advanced" : "completed",
          contentVersion: build.contentVersion,
        },
        updatedAt: confirmedAt,
      })
      .where(eq(conversationTurns.id, turnId));
    return {
      accepted: true as const,
      execution: "local" as const,
      disposition: next ? ("advanced" as const) : ("completed" as const),
      buildId: build.id,
      revision: nextRevision,
      stateEpoch: build.stateEpoch + 1,
      currentLeafId: next?.leafId ?? null,
      currentPresentationKey: nextPresentationKey,
      contentVersion: build.contentVersion,
    };
  });
}

function updatedEvidenceLedger(input: {
  manifest: KnowledgeBaseWorkingSetManifest;
  patch: KnowledgeBaseNodePatchManifest;
}) {
  const remove = new Set(input.patch.evidence.remove);
  return [
    ...input.manifest.evidenceLedger.filter((entry) => !remove.has(entry.path)),
    ...input.patch.evidence.add.map((entry) => ({
      ...entry,
      leafId: input.patch.targetLeafId,
      sourceUrl: null,
      retrievedAt: null,
    })),
  ];
}

const MATERIALIZED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1));

export async function composeKnowledgeBaseWorkingSetRevision(input: {
  base: Awaited<ReturnType<typeof validateKnowledgeBaseWorkingSetArchive>>;
  patch: Awaited<ReturnType<typeof validateKnowledgeBaseNodePatchArchive>>;
}) {
  const targetLeafId = input.patch.manifest.targetLeafId;
  const previousLeaf = input.base.manifest.leaves.find(
    (leaf) => leaf.leafId === targetLeafId,
  );
  if (!previousLeaf) fail("PATCH_CONFLICT", "Patch 目标节点不存在");
  const removedEvidence = new Set(input.patch.manifest.evidence.remove);
  const removedAssets = new Set(input.patch.manifest.assets.remove);
  const evidenceLedger = updatedEvidenceLedger({
    manifest: input.base.manifest,
    patch: input.patch.manifest,
  });
  const assets = [
    ...input.base.manifest.assets.filter(
      (asset) => !removedAssets.has(asset.assetId),
    ),
    ...input.patch.manifest.assets.add,
  ];
  if (
    new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
    new Set(assets.map((asset) => asset.path)).size !== assets.length
  ) {
    fail("PATCH_CONFLICT", "Patch 资产 ID 或路径与 Working Set 冲突");
  }
  const contentBytes = input.patch.files.get(input.patch.manifest.contentPath)!;
  const contentSha256 = sha256(contentBytes);
  const addedEvidencePaths = input.patch.manifest.evidence.add.map(
    (entry) => entry.path,
  );
  const addedAssetIds = input.patch.manifest.assets.add.map(
    (asset) => asset.assetId,
  );
  const leaves = input.base.manifest.leaves.map((leaf) => {
    if (leaf.leafId !== targetLeafId) return leaf;
    return {
      ...leaf,
      contentSha256,
      evidencePaths: [
        ...leaf.evidencePaths.filter((path) => !removedEvidence.has(path)),
        ...addedEvidencePaths,
      ],
      assetIds: [
        ...leaf.assetIds.filter((assetId) => !removedAssets.has(assetId)),
        ...addedAssetIds,
      ],
    };
  });
  const nextContentVersion = input.base.manifest.contentVersion + 1;
  const logo =
    input.base.manifest.logo.status === "available" &&
    removedAssets.has(input.base.manifest.logo.assetId)
      ? ({ status: "missing", assetId: null } as const)
      : input.base.manifest.logo;
  const manifest: KnowledgeBaseWorkingSetManifest = {
    ...input.base.manifest,
    operationId: input.patch.manifest.operationId,
    contentVersion: nextContentVersion,
    evidenceLedger,
    leaves,
    assets,
    logo,
    counts: {
      leaves: leaves.length,
      evidenceFiles: evidenceLedger.length,
      assets: assets.length,
    },
  };
  const outputFiles = new Map(input.base.files);
  outputFiles.delete("BUNDLE.json");
  outputFiles.set(previousLeaf.contentPath, contentBytes);
  for (const path of removedEvidence) outputFiles.delete(path);
  for (const asset of input.base.manifest.assets) {
    if (removedAssets.has(asset.assetId)) outputFiles.delete(asset.path);
  }
  for (const entry of input.patch.manifest.evidence.add) {
    outputFiles.set(entry.path, input.patch.files.get(entry.path)!);
  }
  for (const asset of input.patch.manifest.assets.add) {
    outputFiles.set(asset.path, input.patch.files.get(asset.path)!);
  }
  const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`, "utf8");
  outputFiles.set("BUNDLE.json", manifestBytes);
  const zip = new JSZip();
  for (const [path, bytes] of [...outputFiles].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    zip.file(path, bytes, {
      binary: true,
      date: MATERIALIZED_ZIP_DATE,
      createFolders: false,
      unixPermissions: 0o100644,
    });
  }
  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  const validated = await validateKnowledgeBaseWorkingSetArchive(archiveBytes, {
    operationId: input.patch.manifest.operationId,
    buildId: manifest.buildId,
    generation: manifest.generation,
    contentVersion: nextContentVersion,
    skillContentHash: manifest.skill.contentHash,
    companyName: manifest.company.name,
  });
  return { archiveBytes, validated };
}

/**
 * Validate a revision against the active immutable base. Composition and CAS
 * activation are deliberately separate so no partial patch can replace the
 * last good Working Set.
 */
export async function validateKnowledgeBaseRevisionAgainstActiveWorkingSet(input: {
  userId: number;
  buildId: string;
  generation: number;
  targetLeafId: string;
  operationId: string;
  archiveBytes: Buffer;
}) {
  const db = await requireDb();
  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.userId, input.userId),
        ),
      )
      .limit(1)
  )[0] as KnowledgeBaseBuild | undefined;
  if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
  materializedBuild(build);
  if (
    build.generation !== input.generation ||
    !build.activeWorkingSetId ||
    build.contentVersion < 1 ||
    build.currentLeafId !== input.targetLeafId
  ) {
    fail("PATCH_CONFLICT", "Revision 已不再基于当前 Working Set");
  }
  const base = (
    await db
      .select()
      .from(knowledgeBaseWorkingSets)
      .where(
        and(
          eq(knowledgeBaseWorkingSets.id, build.activeWorkingSetId),
          eq(knowledgeBaseWorkingSets.buildId, build.id),
          eq(knowledgeBaseWorkingSets.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!base) fail("INVALID_BUILD_STATE", "当前 Working Set 不存在");
  const baseBytes = await readKnowledgeBaseLocalSource({
    storageKey: base.storageKey,
    contentSha256: base.packageSha256,
    sizeBytes: base.sizeBytes,
  });
  const baseValidated = await validateKnowledgeBaseWorkingSetArchive(
    baseBytes,
    {
      buildId: build.id,
      generation: build.generation,
      contentVersion: build.contentVersion,
      skillContentHash: build.skillContentHash || undefined,
      companyName: build.companyName,
    },
  );
  const patch = await validateKnowledgeBaseNodePatchArchive(
    input.archiveBytes,
    {
      operationId: input.operationId,
      buildId: build.id,
      generation: build.generation,
      baseContentVersion: build.contentVersion,
      baseWorkingSetSha256: base.packageSha256,
      targetLeafId: input.targetLeafId,
    },
  );
  const leaf = baseValidated.manifest.leaves.find(
    (item) => item.leafId === input.targetLeafId,
  )!;
  if (
    patch.manifest.evidence.remove.some(
      (path) => !leaf.evidencePaths.includes(path),
    ) ||
    patch.manifest.assets.remove.some(
      (assetId) => !leaf.assetIds.includes(assetId),
    ) ||
    patch.manifest.assets.remove.some((assetId) => {
      const asset = baseValidated.manifest.assets.find(
        (candidate) => candidate.assetId === assetId,
      );
      return (
        !asset ||
        asset.documentIds.length !== 1 ||
        asset.documentIds[0] !== input.targetLeafId
      );
    })
  ) {
    fail("PATCH_CONFLICT", "Patch 试图删除不属于目标节点的证据或资产");
  }
  return {
    build,
    base,
    baseValidated,
    patch,
    nextEvidenceLedger: updatedEvidenceLedger({
      manifest: baseValidated.manifest,
      patch: patch.manifest,
    }),
  };
}

export async function applyKnowledgeBaseRevisionWorkingSet(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationId: string;
  providerTaskId: string;
  targetLeafId: string;
  archiveBytes: Buffer;
  executionId?: string;
  receivedAt?: Date;
}) {
  const db = await requireDb();
  const receivedAt = input.receivedAt ?? new Date();
  const prepared =
    await validateKnowledgeBaseRevisionAgainstActiveWorkingSet(input);
  const stagedTurn = (
    await db
      .select({ metadata: conversationTurns.metadata })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.id, input.turnId),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, input.buildId),
          eq(conversationTurns.buildGeneration, input.generation),
        ),
      )
      .limit(1)
  )[0];
  if (!stagedTurn) fail("PATCH_CONFLICT", "Revision turn no longer exists");
  const stagedLogo = materializedStagedOfficialLogoFromTurnMetadata({
    metadata: stagedTurn.metadata,
    operationKey: input.operationId,
    expectedRevision: prepared.build.revision,
    expectedLeafId: input.targetLeafId,
  });
  if (stagedLogo) {
    // Validate the exact staged bytes before entering the short DB CAS. The
    // same tuple is re-read from the locked turn below so metadata cannot be
    // swapped between validation and activation.
    await readKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      kind: "logo",
      storageKey: stagedLogo.storageKey,
      expectedSha256: stagedLogo.sha256,
      expectedBytes: stagedLogo.bytes,
    });
  }
  const composed = await composeKnowledgeBaseWorkingSetRevision({
    base: prepared.baseValidated,
    patch: prepared.patch,
  });
  const retained = await persistKnowledgeBaseBuildSource({
    userId: input.userId,
    buildId: input.buildId,
    generation: input.generation,
    bytes: composed.archiveBytes,
  });
  let oldLogoStorageKey: string | null = null;
  let removeDuplicateStagedLogo = false;
  const activated = await db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, input.buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
    materializedBuild(build);
    if (
      build.generation !== input.generation ||
      build.activeWorkingSetId !== prepared.base.id ||
      build.contentVersion !== prepared.base.contentVersion ||
      build.currentLeafId !== input.targetLeafId ||
      build.activeTurnId !== input.turnId
    ) {
      fail("PATCH_CONFLICT", "Revision 完成时 Working Set 已被其他操作更新");
    }
    const base = (
      await tx
        .select()
        .from(knowledgeBaseWorkingSets)
        .where(eq(knowledgeBaseWorkingSets.id, prepared.base.id))
        .limit(1)
        .for("update")
    )[0];
    const turn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, build.id),
            eq(conversationTurns.buildGeneration, build.generation),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const current = (
      await tx
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(
          and(
            eq(knowledgeBaseBuildNodes.buildId, build.id),
            eq(knowledgeBaseBuildNodes.leafId, input.targetLeafId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuildNode | undefined;
    if (
      !base ||
      base.status !== "active" ||
      !turn ||
      turn.operationKey !== input.operationId ||
      turn.upstreamTaskId !== input.providerTaskId ||
      !["queued", "running"].includes(turn.status) ||
      !current ||
      !["current", "needs_verification"].includes(current.status)
    ) {
      fail("PATCH_CONFLICT", "Revision 已失去当前节点或执行所有权");
    }
    const lockedStagedLogo = materializedStagedOfficialLogoFromTurnMetadata({
      metadata: turn.metadata,
      operationKey: input.operationId,
      expectedRevision: build.revision,
      expectedLeafId: input.targetLeafId,
    });
    if (
      Boolean(lockedStagedLogo) !== Boolean(stagedLogo) ||
      (lockedStagedLogo &&
        stagedLogo &&
        (lockedStagedLogo.storageKey !== stagedLogo.storageKey ||
          lockedStagedLogo.sha256 !== stagedLogo.sha256 ||
          lockedStagedLogo.bytes !== stagedLogo.bytes ||
          lockedStagedLogo.filename !== stagedLogo.filename ||
          lockedStagedLogo.mimeType !== stagedLogo.mimeType))
    ) {
      fail("PATCH_CONFLICT", "Logo staging ledger changed before PATCH activation");
    }
    const logoActivation = materializedOfficialLogoActivationPlan({
      current: {
        storageKey: build.logoStorageKey,
        sha256: build.logoSha256,
        bytes: build.logoBytes,
        mimeType: build.logoMimeType,
      },
      staged: lockedStagedLogo,
    });
    oldLogoStorageKey = logoActivation.oldStorageKey;
    removeDuplicateStagedLogo = logoActivation.removeStaged;
    const nextVersion = build.contentVersion + 1;
    const nextWorkingSetId = randomUUID();
    await tx.insert(knowledgeBaseWorkingSets).values({
      id: nextWorkingSetId,
      buildId: build.id,
      generation: build.generation,
      contentVersion: nextVersion,
      sourceExecutionId: input.executionId ?? null,
      storageKey: retained.storageKey,
      sizeBytes: retained.sizeBytes,
      packageSha256: composed.validated.packageSha256,
      manifestSha256: composed.validated.manifestSha256,
      manifest: composed.validated.manifest,
      status: "active",
      activatedAt: receivedAt,
      createdAt: receivedAt,
    });
    await tx
      .update(knowledgeBaseWorkingSets)
      .set({ status: "superseded" })
      .where(eq(knowledgeBaseWorkingSets.id, base.id));
    await tx
      .update(knowledgeBaseBuildNodes)
      .set({ contentVersion: nextVersion, updatedAt: receivedAt })
      .where(eq(knowledgeBaseBuildNodes.buildId, build.id));
    const nextLeaf = composed.validated.manifest.leaves.find(
      (leaf) => leaf.leafId === current.leafId,
    )!;
    const markdown = nodeMarkdown(
      composed.validated.manifest,
      current.leafId,
      composed.validated.files,
    );
    const nextRevision = build.revision + 1;
    const presentationKey = knowledgeBasePresentationKey({
      buildId: build.id,
      generation: build.generation,
      revision: nextRevision,
      leafId: current.leafId,
      content: markdown,
    });
    const sourceUrls = composed.validated.manifest.evidenceLedger
      .filter((entry) => entry.leafId === current.leafId && entry.sourceUrl)
      .map((entry) => entry.sourceUrl!);
    const localUrls = knowledgeBaseWorkingSetLeafLocalUrls({
      buildId: build.id,
      leafId: current.leafId,
      workingSet: composed.validated,
    });
    const projectedSourceUrls = [
      ...localUrls.evidenceUrls,
      ...sourceUrls,
    ].filter((url, index, all) => all.indexOf(url) === index);
    await tx
      .update(knowledgeBaseBuildNodes)
      .set({
        status: "needs_verification",
        transitionReason: "materialized_leaf_revision",
        contentMarkdown: markdown,
        sourceUrls: projectedSourceUrls,
        imageUrls: localUrls.imageUrls,
        lastTaskId: input.providerTaskId,
        sourceTurnId: input.turnId,
        presentationKey,
        contentSha256: knowledgeBaseMarkdownSha256(markdown),
        contentVersion: nextVersion,
        assetRefs: nextLeaf.assetIds,
        lastResponseAt: receivedAt,
        confirmedAt: null,
        updatedAt: receivedAt,
      })
      .where(eq(knowledgeBaseBuildNodes.id, current.id));
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        activeWorkingSetId: nextWorkingSetId,
        contentVersion: nextVersion,
        revision: nextRevision,
        stateEpoch: build.stateEpoch + 1,
        activeTurnId: null,
        upstreamTaskId: null,
        currentPresentationKey: presentationKey,
        needsVerificationCount:
          current.status === "needs_verification"
            ? build.needsVerificationCount
            : build.needsVerificationCount + 1,
        lastAppliedOperationKey: input.operationId,
        awaitingResponseSince: null,
        protocolErrorCode: null,
        protocolError: null,
        ...(logoActivation.logoUpdate ?? {}),
        updatedAt: receivedAt,
      })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    await tx
      .update(conversationTurns)
      .set({
        status: "completed",
        completedAt: receivedAt,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        metadata: {
          ...(turn.metadata || {}),
          execution: "materialized_patch",
          dispatchState: "completed",
          contentVersion: nextVersion,
          workingSetId: nextWorkingSetId,
        },
        updatedAt: receivedAt,
      })
      .where(eq(conversationTurns.id, turn.id));
    if (input.executionId) {
      await tx
        .update(knowledgeBaseExecutions)
        .set({
          providerTaskId: input.providerTaskId,
          status: "succeeded",
          completedAt: receivedAt,
          updatedAt: receivedAt,
        })
        .where(eq(knowledgeBaseExecutions.id, input.executionId));
    }
    await persistKnowledgeBasePresentationInTransaction({
      tx,
      userId: input.userId,
      conversationId: knowledgeBaseObservationConversationStorageId(
        input.userId,
        build.conversationId,
      ),
      turnId: turn.id,
      buildId: build.id,
      generation: build.generation,
      operationKey: input.operationId,
      presentationKey,
      revision: nextRevision,
      leafId: current.leafId,
      content: markdown,
      authoritativeTaskId: null,
      sentAt: receivedAt,
    });
    return {
      buildId: build.id,
      workingSetId: nextWorkingSetId,
      contentVersion: nextVersion,
      revision: nextRevision,
      currentLeafId: current.leafId,
    };
  });
  // Filesystem deletion is intentionally post-commit. A cleanup failure can
  // leave an unreachable duplicate, but can never roll the build back to a
  // missing Logo or destroy the previously authoritative bytes before CAS.
  if (stagedLogo && removeDuplicateStagedLogo) {
    await removeStagedKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      kind: "logo",
      storageKey: stagedLogo.storageKey,
    }).catch(() => undefined);
  }
  if (
    stagedLogo &&
    oldLogoStorageKey &&
    oldLogoStorageKey !== stagedLogo.storageKey
  ) {
    await removeKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      kind: "logo",
      storageKey: oldLogoStorageKey,
    }).catch(() => undefined);
  }
  return activated;
}

export async function readActiveKnowledgeBaseWorkingSet(input: {
  userId: number;
  buildId: string;
  generation: number;
}) {
  const db = await requireDb();
  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.userId, input.userId),
        ),
      )
      .limit(1)
  )[0] as KnowledgeBaseBuild | undefined;
  if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
  materializedBuild(build);
  if (
    build.generation !== input.generation ||
    !build.activeWorkingSetId ||
    build.contentVersion < 1
  ) {
    fail("INVALID_BUILD_STATE", "当前 Working Set 坐标无效");
  }
  const workingSet = (
    await db
      .select()
      .from(knowledgeBaseWorkingSets)
      .where(
        and(
          eq(knowledgeBaseWorkingSets.id, build.activeWorkingSetId),
          eq(knowledgeBaseWorkingSets.buildId, build.id),
          eq(knowledgeBaseWorkingSets.generation, build.generation),
          eq(knowledgeBaseWorkingSets.contentVersion, build.contentVersion),
          eq(knowledgeBaseWorkingSets.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!workingSet) fail("INVALID_BUILD_STATE", "当前 Working Set 不存在");
  const bytes = await readKnowledgeBaseLocalSource({
    storageKey: workingSet.storageKey,
    contentSha256: workingSet.packageSha256,
    sizeBytes: workingSet.sizeBytes,
  });
  await validateKnowledgeBaseWorkingSetArchive(bytes, {
    buildId: build.id,
    generation: build.generation,
    contentVersion: build.contentVersion,
    skillContentHash: build.skillContentHash || undefined,
    companyName: build.companyName,
  });
  return { build, workingSet, bytes };
}

export async function listMaterializedKnowledgeBaseNodes(input: {
  buildId: string;
}) {
  const db = await requireDb();
  return db
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, input.buildId))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
}
