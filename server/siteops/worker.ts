import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, max, or } from "drizzle-orm";
import {
  localAssets,
  messages,
  siteBuilds,
  siteDeployments,
  siteDomainOperations,
  siteOperations,
  siteProjects,
  socialPackages,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../../drizzle/schema";
import { visualSearchOperationInputSchema } from "../../shared/siteops-workflow";
import {
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL,
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
} from "../../shared/siteops";
import { getDb } from "../db";
import { finalizePendingTwentyFirstCredentialRevocations } from "../twenty-first-service";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import {
  getSiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";
import { siteOpsQuotaStateForProviderResult } from "./quota-service";
import { publicSiteOpsProviderResult } from "./public-errors";
import {
  completeSiteOpsRebuildTicket,
  finalizeApprovedSiteOpsReset,
  parseApprovedResetUnpublishInput,
} from "./rebuild-ticket";

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const VISUAL_SEARCH_LEASE_MS = 5 * 60_000;
const VISUAL_SEARCH_TIMEOUT_MS = 4 * 60_000;
const BUILD_LEASE_MS = 12 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BATCH = 4;

type Claimed = typeof siteOperations.$inferSelect & { leaseOwner: string };

const BUILD_ARTIFACT_KINDS = [
  "contract",
  "source",
  "dist",
  "qa",
  "provenance",
] as const;

type BuildArtifactKind = (typeof BUILD_ARTIFACT_KINDS)[number];
type BuildArtifactBinding = {
  id: string;
  sha256: string;
  bytes: number;
  mimeType: "application/json" | "application/zip";
};
type BuildArtifactBindings = Record<BuildArtifactKind, BuildArtifactBinding>;

const BUILD_ARTIFACT_MIME: Record<
  BuildArtifactKind,
  BuildArtifactBinding["mimeType"]
> = {
  contract: "application/json",
  source: "application/zip",
  dist: "application/zip",
  qa: "application/zip",
  provenance: "application/json",
};

const BUILD_ARTIFACT_STORAGE_KIND: Record<BuildArtifactKind, string> = {
  contract: "site-contract",
  source: "site-source",
  dist: "site-dist",
  qa: "site-qa",
  provenance: "site-provenance",
};

function workerArtifactError(code: string) {
  return Object.assign(new Error(code), { code });
}

function affectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ??
      0,
  );
}

export function parseSiteOpsBuildArtifactBindings(
  value: unknown,
): BuildArtifactBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_MISSING");
  }
  const record = value as Record<string, unknown>;
  const result = {} as BuildArtifactBindings;
  const ids = new Set<string>();
  for (const kind of BUILD_ARTIFACT_KINDS) {
    const raw = record[kind];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    }
    const binding = raw as Record<string, unknown>;
    const id = typeof binding.id === "string" ? binding.id : "";
    const sha256 =
      typeof binding.sha256 === "string"
        ? binding.sha256.trim().toLowerCase()
        : "";
    const bytes = Number(binding.bytes);
    const mimeType = binding.mimeType;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        id,
      ) ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      mimeType !== BUILD_ARTIFACT_MIME[kind] ||
      ids.has(id)
    ) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    }
    ids.add(id);
    result[kind] = {
      id,
      sha256,
      bytes,
      mimeType: BUILD_ARTIFACT_MIME[kind],
    };
  }
  if (
    Object.keys(record).some(
      (key) => !BUILD_ARTIFACT_KINDS.includes(key as BuildArtifactKind),
    )
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
  }
  return result;
}

export function siteOpsBuildArtifactProjection(input: {
  bindings: BuildArtifactBindings;
  rows: Array<{
    id: string;
    scope: string;
    accountUserId: number | null;
    presalesProjectId: string | null;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
  }>;
  userId: number;
  projectId: string;
}) {
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  for (const kind of BUILD_ARTIFACT_KINDS) {
    const binding = input.bindings[kind];
    const row = rows.get(binding.id);
    if (
      !row ||
      row.scope !== "managed_user" ||
      row.accountUserId !== input.userId ||
      row.presalesProjectId !== null ||
      row.mimeType !== binding.mimeType ||
      row.sizeBytes !== binding.bytes ||
      row.contentSha256.toLowerCase() !== binding.sha256 ||
      row.storageKey !==
        `siteops:${input.projectId}:${BUILD_ARTIFACT_STORAGE_KIND[kind]}:${binding.id}`
    ) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_VERIFICATION_FAILED");
    }
  }
  return {
    contractLocalAssetId: input.bindings.contract.id,
    contractHash: input.bindings.contract.sha256,
    sourceLocalAssetId: input.bindings.source.id,
    sourceHash: input.bindings.source.sha256,
    distLocalAssetId: input.bindings.dist.id,
    distHash: input.bindings.dist.sha256,
    qaLocalAssetId: input.bindings.qa.id,
    provenanceLocalAssetId: input.bindings.provenance.id,
  } as const;
}

export function exclusiveSiteOpsLiveHeadProjection(
  target: "global_excluding_cn" | "mainland_cn",
  deploymentId: string,
) {
  return {
    globalLiveDeploymentId:
      target === "global_excluding_cn" ? deploymentId : null,
    mainlandLiveDeploymentId: target === "mainland_cn" ? deploymentId : null,
  } as const;
}

export function domainFinancialTerminalProjection(
  status: "succeeded" | "failed" | "attention_required",
  mutationAttempted = false,
) {
  return {
    status,
    ...(status === "succeeded" ||
    status === "failed" ||
    (status === "attention_required" && !mutationAttempted)
      ? { activeFinancialKey: null }
      : {}),
  } as const;
}

export function siteOpsWorkerMayClaimStatus(status: string) {
  return status === "queued" || status === "running";
}

export function siteOpsWorkerExecutionPolicy(kind: string) {
  const isBuild = kind === "site_build" || kind === "build_revision";
  const isVisualSearch = kind === "visual_search";
  return {
    leaseMs: isBuild
      ? BUILD_LEASE_MS
      : isVisualSearch
        ? VISUAL_SEARCH_LEASE_MS
        : DEFAULT_LEASE_MS,
    timeoutMs: isBuild
      ? BUILD_TIMEOUT_MS
      : isVisualSearch
        ? VISUAL_SEARCH_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS,
  } as const;
}

export function terminalSiteOpsOperationProjection(
  locked: Pick<Claimed, "result" | "providerOperationId" | "providerTaskId">,
  result: SiteOpsProviderResult,
) {
  return {
    result: result.result ?? locked.result,
    providerOperationId:
      result.providerOperationId ?? locked.providerOperationId,
    providerTaskId: result.providerTaskId ?? locked.providerTaskId,
  };
}

export function siteOpsVisualOperationCoordinates(input: {
  operationInput: unknown;
  completePublishedPages: number;
}) {
  const parsed = visualSearchOperationInputSchema.safeParse(
    input.operationInput,
  );
  if (parsed.success && "schemaVersion" in parsed.data) {
    return {
      mode: parsed.data.mode,
      page: parsed.data.page,
      admissionRevision: parsed.data.admissionRevision,
    } as const;
  }
  return {
    mode:
      input.completePublishedPages > 0
        ? ("supplemental" as const)
        : ("initial" as const),
    page: Math.max(
      1,
      Math.min(
        SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
        input.completePublishedPages + 1,
      ),
    ) as 1 | 2 | 3,
    admissionRevision: null,
  } as const;
}

export function siteOpsSupplementalVisualFailureMayRecover(input: {
  mode: "initial" | "supplemental";
  completePublishedPages: number;
  projectStatus: string;
  projectRevision: number;
  admissionRevision: number | null;
  hasActiveVisualOperation: boolean;
  hasActiveBuild: boolean;
  errorCode: string;
}) {
  return (
    input.mode === "supplemental" &&
    input.completePublishedPages > 0 &&
    [
      "awaiting_visual_selection",
      "visual_searching",
      "failed",
      "attention_required",
    ].includes(input.projectStatus) &&
    (input.admissionRevision === null ||
      input.projectRevision === input.admissionRevision) &&
    !input.hasActiveVisualOperation &&
    !input.hasActiveBuild &&
    input.errorCode !== "VISUAL_SEARCH_SUPERSEDED"
  );
}

export function siteOpsInitialVisualSupersededMayStaySilent(input: {
  mode: "initial" | "supplemental";
  projectStatus: string;
  projectRevision: number;
  admissionRevision: number | null;
}) {
  if (input.mode !== "initial") return false;
  return (
    input.projectStatus !== "visual_searching" ||
    (input.admissionRevision !== null &&
      input.projectRevision !== input.admissionRevision)
  );
}

export function unexpectedSiteOpsProviderFailure(): SiteOpsProviderResult {
  return failureResult(
    "attention_required",
    "PROVIDER_ERROR",
    "外部服务操作未能安全完成，请根据错误码和任务编号联系处理。",
  );
}

export function knownSiteOpsBuildFailure(
  error: unknown,
): SiteOpsProviderResult | null {
  if (!error || typeof error !== "object") return null;
  const code = String((error as { code?: unknown }).code ?? "").trim();
  if (!/^FRONTMIND_BUILD_[A-Z_]+$/u.test(code)) return null;
  const requestedStatus = String((error as { status?: unknown }).status ?? "");
  const status =
    requestedStatus === "attention_required" ||
    code === "FRONTMIND_BUILD_CONFIGURATION_ERROR"
      ? "attention_required"
      : "failed";
  return {
    status,
    code,
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : "本次没有生成可安全展示的版本；可申请重置，批准后请全新上传并从头生成。",
  };
}

type PublicBuildStage = "design_compiling" | "content_building" | "qa_running";

type ProviderBuildStatus =
  | "design_compiling"
  | "contract_ready"
  | "building"
  | "qa_running"
  | "preview_ready"
  | "approved";

function publicBuildStage(status: ProviderBuildStatus) {
  if (status === "design_compiling") return "design_compiling" as const;
  if (status === "contract_ready" || status === "building") {
    return "content_building" as const;
  }
  if (status === "qa_running") return "qa_running" as const;
  return null;
}

const PUBLIC_BUILD_STAGE_LABELS: Record<PublicBuildStage, string> = {
  design_compiling: "设计合同生成",
  content_building: "页面内容生成",
  qa_running: "质量校验",
};

export async function appendBuildTimelineEvent(
  tx: any,
  input: {
    operation: Claimed;
    buildStatus: ProviderBuildStatus;
    now: Date;
  },
) {
  if (!input.operation.buildId) return;
  const stage = publicBuildStage(input.buildStatus);
  if (!stage) return;
  const projectRows = await tx
    .select({
      conversationId: siteProjects.conversationId,
      revision: siteProjects.revision,
    })
    .from(siteProjects)
    .where(eq(siteProjects.id, input.operation.projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) return;
  const existingRows = await tx
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId))
    .orderBy(desc(messages.sequence))
    .limit(500);
  const duplicate = existingRows.some((row: { metadata: unknown }) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const siteOps = (metadata.siteOps ?? {}) as Record<string, unknown>;
    const payload = (siteOps.payload ?? {}) as Record<string, unknown>;
    return (
      siteOps.subjectId === input.operation.id &&
      (payload.visibility === "timeline" || payload.timelineOnly === true) &&
      payload.stage === stage &&
      payload.buildId === input.operation.buildId
    );
  });
  if (duplicate) return;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId));
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: project.conversationId,
    userId: input.operation.userId,
    role: "assistant",
    content: PUBLIC_BUILD_STAGE_LABELS[stage],
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "build_progress",
        subjectId: input.operation.id,
        revision: project.revision,
        status: "active",
        payload: {
          visibility: "timeline",
          timelineOnly: true,
          stage,
          buildId: input.operation.buildId,
          occurredAt: input.now.toISOString(),
        },
      },
    },
  });
}

async function claimOne(db: any): Promise<Claimed | null> {
  return db.transaction(async (tx: any) => {
    const now = new Date();
    const rows = await tx
      .select()
      .from(siteOperations)
      .where(
        or(
          eq(siteOperations.status, "queued"),
          and(
            eq(siteOperations.status, "running"),
            or(
              isNull(siteOperations.leaseExpiresAt),
              lt(siteOperations.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(siteOperations.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const operation = rows[0];
    if (!operation || !siteOpsWorkerMayClaimStatus(operation.status)) {
      return null;
    }
    const leaseOwner = randomUUID();
    const executionPolicy = siteOpsWorkerExecutionPolicy(operation.kind);
    const leaseExpiresAt = new Date(now.getTime() + executionPolicy.leaseMs);
    await tx
      .update(siteOperations)
      .set({
        status: "running",
        leaseOwner,
        leaseExpiresAt,
        attempt: operation.attempt + 1,
        startedAt: operation.startedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, operation.id),
          eq(siteOperations.status, operation.status),
        ),
      );
    return {
      ...operation,
      status: "running",
      leaseOwner,
      leaseExpiresAt,
    };
  });
}

function failureResult<
  TStatus extends "failed" | "attention_required" | "outcome_unknown",
>(
  status: TStatus,
  code: string,
  message: string,
): { status: TStatus; code: string; message: string } {
  return { status, code, message };
}

async function assertClaimLeaseActive(db: any, operation: Claimed) {
  const rows = await db
    .select({
      id: siteOperations.id,
      leaseExpiresAt: siteOperations.leaseExpiresAt,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.id, operation.id),
        eq(siteOperations.status, "running"),
        eq(siteOperations.leaseOwner, operation.leaseOwner),
      ),
    )
    .limit(1);
  if (!rows[0] || rows[0].leaseExpiresAt === null) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
  if (rows[0].leaseExpiresAt.getTime() <= Date.now()) {
    throw new Error("SITEOPS_OPERATION_LEASE_EXPIRED");
  }
}

async function invokeProvider(db: any, operation: Claimed) {
  if (siteOpsRemovedResumeOperation(operation.input)) {
    return failureResult(
      "failed",
      "FRONTMIND_BUILD_RESUME_REMOVED",
      "历史建站恢复任务已停用，请通过批准重置后创建全新任务。",
    );
  }
  const handler = getSiteOpsProviderHandler(operation.provider);
  if (!handler) {
    return failureResult(
      "attention_required",
      "PROVIDER_NOT_CONFIGURED",
      `${operation.provider ?? "SiteOps"} 适配器尚未配置；未伪造外部成功结果。`,
    );
  }
  const controller = new AbortController();
  const executionPolicy = siteOpsWorkerExecutionPolicy(operation.kind);
  const timeout = setTimeout(
    () => controller.abort(),
    executionPolicy.timeoutMs,
  );
  timeout.unref?.();
  try {
    await assertClaimLeaseActive(db, operation);
    return await handler({
      operation,
      signal: controller.signal,
      assertLeaseActive: () => assertClaimLeaseActive(db, operation),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      if (operation.kind === "visual_search") {
        return failureResult(
          "failed",
          "VISUAL_SEARCH_TIMEOUT",
          "视觉候选生成已超时，请稍后重试。",
        );
      }
      return failureResult(
        "outcome_unknown",
        "PROVIDER_TIMEOUT",
        "外部操作超时，结果未知；系统只会查询对账，不会盲目重发。",
      );
    }
    console.error("[SiteOpsWorker] provider_failed", {
      operationId: operation.id,
      projectId: operation.projectId,
      provider: operation.provider,
      error: runtimeErrorForLog(error),
    });
    return (
      knownSiteOpsBuildFailure(error) ?? unexpectedSiteOpsProviderFailure()
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function siteOpsRemovedResumeOperation(value: unknown) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).resumeMode ===
        "recover_design_output",
  );
}

async function verifiedBuildArtifactProjection(
  tx: any,
  operation: Claimed,
  result: Extract<SiteOpsProviderResult, { status: "succeeded" }>,
) {
  if (
    !operation.buildId ||
    !["site_build", "build_revision"].includes(operation.kind)
  ) {
    return null;
  }
  const buildRows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, operation.buildId),
        eq(siteBuilds.projectId, operation.projectId),
        eq(siteBuilds.userId, operation.userId),
      ),
    )
    .limit(1)
    .for("update");
  const build = buildRows[0];
  if (
    !build ||
    build.status !== "qa_running" ||
    build.contractLocalAssetId !== null ||
    build.sourceLocalAssetId !== null ||
    build.distLocalAssetId !== null ||
    build.qaLocalAssetId !== null ||
    build.provenanceLocalAssetId !== null
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
  }
  const bindings = parseSiteOpsBuildArtifactBindings(
    result.result?.artifactBindings,
  );
  const ids = BUILD_ARTIFACT_KINDS.map((kind) => bindings[kind].id);
  const rows = await tx
    .select({
      id: localAssets.id,
      scope: localAssets.scope,
      accountUserId: localAssets.accountUserId,
      presalesProjectId: localAssets.presalesProjectId,
      mimeType: localAssets.mimeType,
      sizeBytes: localAssets.sizeBytes,
      contentSha256: localAssets.contentSha256,
      storageKey: localAssets.storageKey,
    })
    .from(localAssets)
    .where(
      and(
        inArray(localAssets.id, ids),
        eq(localAssets.scope, "managed_user"),
        eq(localAssets.accountUserId, operation.userId),
      ),
    );
  return siteOpsBuildArtifactProjection({
    bindings,
    rows,
    userId: operation.userId,
    projectId: operation.projectId,
  });
}

async function finalize(
  db: any,
  operation: Claimed,
  providerResult: SiteOpsProviderResult,
) {
  return db.transaction(async (tx: any) => {
    const lockedRows = await tx
      .select()
      .from(siteOperations)
      .where(eq(siteOperations.id, operation.id))
      .limit(1)
      .for("update");
    const locked = lockedRows[0];
    if (
      !locked ||
      locked.status !== "running" ||
      locked.leaseOwner !== operation.leaseOwner
    ) {
      return providerResult.status;
    }
    const publicResult = publicSiteOpsProviderResult(
      locked.provider,
      providerResult,
    );
    let finalizedResult: SiteOpsProviderResult = publicResult;
    let buildArtifactProjection: ReturnType<
      typeof siteOpsBuildArtifactProjection
    > | null = null;
    if (
      finalizedResult.status === "succeeded" &&
      ["site_build", "build_revision"].includes(locked.kind)
    ) {
      try {
        buildArtifactProjection = await verifiedBuildArtifactProjection(
          tx,
          locked,
          finalizedResult,
        );
      } catch (error) {
        const internalCode =
          typeof (error as { code?: unknown })?.code === "string"
            ? String((error as { code: string }).code)
            : "SITEOPS_BUILD_ARTIFACT_VERIFICATION_FAILED";
        console.error("[SiteOpsWorker] build_artifact_binding_failed", {
          event: "siteops_build_artifact_binding_failed",
          operationId: locked.id,
          projectId: locked.projectId,
          buildId: locked.buildId,
          internalCode,
        });
        finalizedResult = {
          status: "failed",
          code: "BUILD_ARTIFACT_BINDING_FAILED",
          message:
            "本次没有生成可安全展示的版本；可申请重置，批准后请全新上传并从头生成。",
          providerTaskId:
            providerResult.providerTaskId ?? locked.providerTaskId ?? undefined,
          result: {
            schemaVersion: 1,
            stage: "artifact_binding_failed",
            internalCode,
          },
        };
      }
    }
    if (
      finalizedResult.status === "succeeded" &&
      buildArtifactProjection &&
      ["site_build", "build_revision"].includes(locked.kind)
    ) {
      finalizedResult = {
        ...finalizedResult,
        buildStatus: "approved",
        projectStatus: "approved",
        message: "官网已完成，可以打开预览。",
      };
    }
    const result = finalizedResult;
    const now = new Date();
    if (result.status === "pending") {
      const nextPollMs = Math.max(
        2_000,
        Math.min(result.nextPollMs ?? 10_000, 5 * 60_000),
      );
      await tx
        .update(siteOperations)
        .set({
          // A running row with a future lease is the existing operation's
          // durable poll schedule. It cannot be mistaken for a new side effect.
          status: "running",
          result: result.result,
          providerOperationId:
            result.providerOperationId ?? locked.providerOperationId,
          providerTaskId: result.providerTaskId ?? locked.providerTaskId,
          leaseOwner: null,
          leaseExpiresAt: new Date(now.getTime() + nextPollMs),
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      if (locked.buildId && result.buildStatus) {
        await appendBuildTimelineEvent(tx, {
          operation: locked as Claimed,
          buildStatus: result.buildStatus,
          now,
        });
        await tx
          .update(siteBuilds)
          .set({ status: result.buildStatus, updatedAt: now })
          .where(eq(siteBuilds.id, locked.buildId));
      }
      if (result.projectStatus) {
        await tx
          .update(siteProjects)
          .set({ status: result.projectStatus, updatedAt: now })
          .where(eq(siteProjects.id, locked.projectId));
      }
      return result.status;
    }
    if (result.status === "outcome_unknown") {
      // A timeout after a provider mutation is not a terminal failure. Keep
      // the original reservation and let the same provider handler enter its
      // read-only reconciliation branch on the next lease; never create a
      // replacement operation or repeat the side effect.
      await tx
        .update(siteOperations)
        .set({
          status: "running",
          result: result.result ?? locked.result,
          providerOperationId:
            result.providerOperationId ?? locked.providerOperationId,
          providerTaskId: result.providerTaskId ?? locked.providerTaskId,
          errorCode: result.code,
          errorMessage: result.message,
          leaseOwner: null,
          leaseExpiresAt: new Date(now.getTime() + 15_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      await tx
        .update(siteDomainOperations)
        .set({
          status: "outcome_unknown",
          providerTaskNo: result.providerTaskId ?? locked.providerTaskId,
          providerResult: result.result,
          errorCode: result.code,
          errorMessage: result.message,
          updatedAt: now,
        })
        .where(eq(siteDomainOperations.operationId, locked.id));
      return result.status;
    }
    const approvedReset = parseApprovedResetUnpublishInput(locked.input);
    if (approvedReset) {
      let resetResult: Exclude<SiteOpsProviderResult, { status: "pending" }> =
        result;
      if (result.status === "succeeded") {
        const resetFinalization = await finalizeApprovedSiteOpsReset(tx, {
          operation: locked,
          now,
        });
        if (resetFinalization.status !== "applied") {
          resetResult = failureResult(
            "failed",
            "SITEOPS_RESET_INVALIDATED",
            "官网重置坐标已变化，系统未清除当前流程。",
          );
        }
      }
      const resetTerminalUpdate = await tx
        .update(siteOperations)
        .set({
          status: resetResult.status,
          ...terminalSiteOpsOperationProjection(locked, resetResult),
          errorCode:
            resetResult.status === "succeeded" ? null : resetResult.code,
          errorMessage:
            resetResult.status === "succeeded" ? null : resetResult.message,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      if (affectedRows(resetTerminalUpdate) !== 1) {
        throw new Error("SITEOPS_RESET_OPERATION_CAS_CONFLICT");
      }
      // This operation has no site_deployments reservation. Its project and
      // ticket writes are owned exclusively by finalizeApprovedSiteOpsReset.
      return resetResult.status;
    }
    const terminalStatus = result.status;
    const preservedTerminalState = terminalSiteOpsOperationProjection(
      locked,
      result,
    );
    const terminalUpdate = await tx
      .update(siteOperations)
      .set({
        status: terminalStatus,
        ...preservedTerminalState,
        errorCode: result.status === "succeeded" ? null : result.code,
        errorMessage: result.status === "succeeded" ? null : result.message,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, locked.id),
          eq(siteOperations.leaseOwner, operation.leaseOwner),
        ),
      );
    void terminalUpdate;

    if (locked.kind === "visual_search") {
      const projectRows = await tx
        .select()
        .from(siteProjects)
        .where(eq(siteProjects.id, locked.projectId))
        .limit(1)
        .for("update");
      const project = projectRows[0];
      if (!project) return result.status;

      const publishedRows = await tx
        .select({ id: websiteStyleSampleBatches.id })
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.siteProjectId, locked.projectId),
            eq(websiteStyleSampleBatches.userId, locked.userId),
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            eq(websiteStyleSampleBatches.status, "published"),
          ),
        )
        .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES)
        .for("update");
      const publishedIds = publishedRows.map((row: { id: string }) => row.id);
      const sampleRows =
        publishedIds.length > 0
          ? await tx
              .select({ batchId: websiteStyleSamples.batchId })
              .from(websiteStyleSamples)
              .where(inArray(websiteStyleSamples.batchId, publishedIds))
              .limit(SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL)
          : [];
      const samplesPerBatch = new Map<string, number>();
      for (const row of sampleRows as Array<{ batchId: string }>) {
        samplesPerBatch.set(
          row.batchId,
          (samplesPerBatch.get(row.batchId) ?? 0) + 1,
        );
      }
      const completePublishedPages = publishedIds.filter(
        (id: string) =>
          samplesPerBatch.get(id) === SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
      ).length;
      const coordinates = siteOpsVisualOperationCoordinates({
        operationInput: locked.input,
        completePublishedPages,
      });

      if (result.status === "succeeded") {
        console.info("[SiteOpsWorker] visual_search_finalized", {
          event: "siteops_visual_search_finalized",
          operationId: locked.id,
          projectId: locked.projectId,
          mode: coordinates.mode,
          page: coordinates.page,
          operationStatus: result.status,
        });
        // The visual provider commits the complete board, success message and
        // project revision atomically. The worker owns only the terminal
        // operation row and must not repeat those writes.
        return result.status;
      }

      const activeVisualRows = await tx
        .select({ id: siteOperations.id })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.projectId, locked.projectId),
            eq(siteOperations.userId, locked.userId),
            eq(siteOperations.kind, "visual_search"),
            inArray(siteOperations.status, [
              "queued",
              "running",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      const activeBuildRows = await tx
        .select({ id: siteBuilds.id })
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.projectId, locked.projectId),
            eq(siteBuilds.userId, locked.userId),
            inArray(siteBuilds.status, [
              "preparing",
              "visual_searching",
              "awaiting_visual_selection",
              "design_compiling",
              "contract_ready",
              "building",
              "qa_running",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      const recoverable = siteOpsSupplementalVisualFailureMayRecover({
        mode: coordinates.mode,
        completePublishedPages,
        projectStatus: project.status,
        projectRevision: project.revision,
        admissionRevision: coordinates.admissionRevision,
        hasActiveVisualOperation: activeVisualRows.length > 0,
        hasActiveBuild: activeBuildRows.length > 0,
        errorCode: result.code,
      });
      console.warn("[SiteOpsWorker] visual_search_terminal", {
        event: "siteops_visual_search_terminal",
        operationId: locked.id,
        projectId: locked.projectId,
        mode: coordinates.mode,
        page: coordinates.page,
        operationStatus: result.status,
        errorCode: result.code,
        completePublishedPages,
        recoverable,
      });
      if (recoverable) {
        const sequenceRows = await tx
          .select({ sequence: max(messages.sequence) })
          .from(messages)
          .where(eq(messages.conversationId, project.conversationId));
        await tx.insert(messages).values({
          id: randomUUID(),
          conversationId: project.conversationId,
          userId: project.userId,
          role: "assistant",
          content: "本次未能生成完整的新一组，当前候选仍可选择，也可稍后重试。",
          sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
          metadata: {
            siteOps: {
              kind: "operation_recovery",
              subjectId: locked.id,
              revision: project.revision,
              status: "active",
              payload: {
                operationKind: "visual_search",
                operationStatus: result.status,
                errorCode: result.code,
                page: coordinates.page,
                retryable: true,
              },
            },
          },
        });
        await tx
          .update(siteProjects)
          .set({
            status: "awaiting_visual_selection",
            updatedAt: now,
          })
          .where(
            and(
              eq(siteProjects.id, project.id),
              eq(siteProjects.revision, project.revision),
            ),
          );
        return result.status;
      }
      const initialSupersededMayStaySilent =
        result.code === "VISUAL_SEARCH_SUPERSEDED" &&
        siteOpsInitialVisualSupersededMayStaySilent({
          mode: coordinates.mode,
          projectStatus: project.status,
          projectRevision: project.revision,
          admissionRevision: coordinates.admissionRevision,
        });
      if (
        coordinates.mode === "supplemental" ||
        initialSupersededMayStaySilent
      ) {
        // A stale or otherwise unrecoverable supplemental result may finalize
        // its own operation, but it must never regress a newer project state.
        // An initial superseded result is silent only after the project has
        // observably advanced; otherwise the generic failure path below must
        // release the project from visual_searching.
        return result.status;
      }
    }

    const unsuccessful = result.status !== "succeeded";
    if (locked.buildId) {
      await tx
        .update(siteBuilds)
        .set({
          status: unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : result.buildStatus,
          ...(!unsuccessful && buildArtifactProjection
            ? buildArtifactProjection
            : {}),
          errorCode: unsuccessful ? result.code : null,
          errorMessage: unsuccessful ? result.message : null,
          approvedAt:
            !unsuccessful && result.buildStatus === "approved" ? now : null,
          ...(["site_build", "build_revision"].includes(locked.kind)
            ? { quotaState: siteOpsQuotaStateForProviderResult(result.status) }
            : {}),
          updatedAt: now,
        })
        .where(eq(siteBuilds.id, locked.buildId));
    }
    if (!unsuccessful && locked.buildId && result.buildStatus === "approved") {
      const completedBuildRows = await tx
        .select({ parentBuildId: siteBuilds.parentBuildId })
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.id, locked.buildId),
            eq(siteBuilds.projectId, locked.projectId),
            eq(siteBuilds.userId, locked.userId),
          ),
        )
        .limit(1);
      await completeSiteOpsRebuildTicket(tx, {
        userId: locked.userId,
        projectId: locked.projectId,
        parentBuildId: completedBuildRows[0]?.parentBuildId ?? null,
        childBuildId: locked.buildId,
        now,
      });
    }
    await tx
      .update(socialPackages)
      .set({
        status: unsuccessful
          ? result.status === "failed"
            ? "failed"
            : "attention_required"
          : (result.socialPackageStatus ?? "ready"),
        errorCode: unsuccessful ? result.code : null,
        errorMessage: unsuccessful ? result.message : null,
        quotaState: siteOpsQuotaStateForProviderResult(result.status),
        updatedAt: now,
      })
      .where(eq(socialPackages.operationId, locked.id));
    if (unsuccessful || result.projectStatus !== "live") {
      await tx
        .update(siteDeployments)
        .set({
          status: unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : "verifying",
          errorCode: unsuccessful ? result.code : null,
          errorMessage: unsuccessful ? result.message : null,
          updatedAt: now,
        })
        .where(eq(siteDeployments.operationId, locked.id));
    }
    await tx
      .update(siteDomainOperations)
      .set({
        // Known terminal outcomes and pre-mutation rejections release the
        // financial intent. Once a provider mutation was attempted, manual
        // attention keeps the key so neither staff nor a retry can charge twice.
        ...domainFinancialTerminalProjection(
          result.status,
          Boolean(
            preservedTerminalState.providerTaskId ||
              (preservedTerminalState.result as Record<string, unknown> | null)
                ?.mutationAttempted === true,
          ),
        ),
        providerTaskNo: preservedTerminalState.providerTaskId,
        providerResult: preservedTerminalState.result,
        errorCode: unsuccessful ? result.code : null,
        errorMessage: unsuccessful ? result.message : null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(siteDomainOperations.operationId, locked.id));

    const projectRows = await tx
      .select()
      .from(siteProjects)
      .where(eq(siteProjects.id, locked.projectId))
      .limit(1)
      .for("update");
    const project = projectRows[0];
    if (!project) return result.status;
    let liveHeadConflict = false;
    if (!unsuccessful && result.projectStatus === "live") {
      const deploymentRows = await tx
        .select()
        .from(siteDeployments)
        .where(eq(siteDeployments.operationId, locked.id))
        .limit(1)
        .for("update");
      const deployment = deploymentRows[0];
      if (!deployment) {
        liveHeadConflict = true;
      } else {
        const currentHead =
          deployment.target === "mainland_cn"
            ? project.mainlandLiveDeploymentId
            : project.globalLiveDeploymentId;
        if ((deployment.expectedHeadDeploymentId ?? null) !== currentHead) {
          liveHeadConflict = true;
          await tx
            .update(siteOperations)
            .set({
              status: "attention_required",
              errorCode: "LIVE_HEAD_CONFLICT",
              errorMessage:
                "线上版本在发布期间发生变化；已部署版本未被切换为 FrontMind live head。",
              updatedAt: now,
            })
            .where(eq(siteOperations.id, locked.id));
          await tx
            .update(siteDeployments)
            .set({
              status: "attention_required",
              errorCode: "LIVE_HEAD_CONFLICT",
              errorMessage:
                "线上版本在发布期间发生变化；已部署版本未被切换为 FrontMind live head。",
              updatedAt: now,
            })
            .where(eq(siteDeployments.id, deployment.id));
        } else {
          const otherHead =
            deployment.target === "mainland_cn"
              ? project.globalLiveDeploymentId
              : project.mainlandLiveDeploymentId;
          if (currentHead) {
            await tx
              .update(siteDeployments)
              .set({ status: "superseded", updatedAt: now })
              .where(
                and(
                  eq(siteDeployments.id, currentHead),
                  eq(siteDeployments.projectId, project.id),
                  eq(siteDeployments.target, deployment.target),
                  eq(siteDeployments.status, "active"),
                ),
              );
          }
          if (otherHead && otherHead !== currentHead) {
            await tx
              .update(siteDeployments)
              .set({ status: "superseded", updatedAt: now })
              .where(
                and(
                  eq(siteDeployments.id, otherHead),
                  eq(siteDeployments.projectId, project.id),
                  eq(siteDeployments.status, "active"),
                ),
              );
          }
          await tx
            .update(siteDeployments)
            .set({
              status: "active",
              errorCode: null,
              errorMessage: null,
              activatedAt: now,
              updatedAt: now,
            })
            .where(eq(siteDeployments.id, deployment.id));
          await tx
            .update(siteProjects)
            .set({
              ...exclusiveSiteOpsLiveHeadProjection(
                deployment.target,
                deployment.id,
              ),
              currentBuildId: deployment.buildId,
              updatedAt: now,
            })
            .where(eq(siteProjects.id, project.id));
        }
      }
    }
    const messageText = liveHeadConflict
      ? "ESA 已返回验证结果，但线上 head 在发布期间发生变化；系统未覆盖较新的线上版本，请人工核对。"
      : result.status === "succeeded"
        ? result.message
        : result.message || "该操作需要人工处理。";
    if (messageText) {
      const sequenceRows = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, project.conversationId));
      await tx.insert(messages).values({
        id: randomUUID(),
        conversationId: project.conversationId,
        userId: project.userId,
        role: "assistant",
        content: messageText,
        sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
        metadata: {
          siteOps: {
            kind:
              unsuccessful || liveHeadConflict
                ? "operation_recovery"
                : locked.kind === "deploy" || locked.kind === "rollback"
                  ? "release_status"
                  : locked.kind === "social_package"
                    ? "social_package"
                    : locked.kind.startsWith("domain_") ||
                        locked.kind.startsWith("dns_")
                      ? "domain_status"
                      : "build_progress",
            subjectId: locked.id,
            revision: project.revision + 1,
            status: unsuccessful || liveHeadConflict ? "active" : "resolved",
            payload: {
              operationKind: locked.kind,
              operationStatus: liveHeadConflict
                ? "attention_required"
                : result.status,
              errorCode: liveHeadConflict
                ? "LIVE_HEAD_CONFLICT"
                : unsuccessful
                  ? result.code
                  : undefined,
            },
          },
        },
      });
    }
    await tx
      .update(siteProjects)
      .set({
        ...(!unsuccessful && result.buildStatus === "approved" && locked.buildId
          ? { currentBuildId: locked.buildId }
          : {}),
        status: liveHeadConflict
          ? "attention_required"
          : unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : result.projectStatus,
        revision: project.revision + 1,
        updatedAt: now,
      })
      .where(eq(siteProjects.id, project.id));
    return liveHeadConflict ? "attention_required" : result.status;
  });
}

export async function runSiteOpsWorkerSweep(options?: { max?: number }) {
  const db = await getDb();
  if (!db || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0") {
    return {
      claimed: 0,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    };
  }
  const limit = Math.max(1, Math.min(options?.max ?? DEFAULT_BATCH, 20));
  const summary = {
    claimed: 0,
    succeeded: 0,
    deferred: 0,
    attentionRequired: 0,
    failed: 0,
  };
  for (let index = 0; index < limit; index += 1) {
    const operation = await claimOne(db);
    if (!operation) break;
    summary.claimed += 1;
    const result = await invokeProvider(db, operation);
    const finalizedStatus = await finalize(db, operation, result);
    if (finalizedStatus === "pending") summary.deferred += 1;
    else if (finalizedStatus === "succeeded") summary.succeeded += 1;
    else if (finalizedStatus === "failed") summary.failed += 1;
    else summary.attentionRequired += 1;
  }
  await finalizePendingTwentyFirstCredentialRevocations().catch((error) => {
    console.error(
      "[SiteOpsWorker] twenty_first_revocation_finalize_failed",
      runtimeErrorForLog(error),
    );
  });
  return summary;
}

let scheduler: NodeJS.Timeout | null = null;
let sweep: Promise<unknown> | null = null;

export function startSiteOpsWorkerScheduler(options?: { intervalMs?: number }) {
  if (scheduler || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0")
    return;
  const run = () => {
    if (sweep) return;
    sweep = runSiteOpsWorkerSweep()
      .catch((error) => {
        console.error(
          "[SiteOpsWorker] sweep_failed",
          runtimeErrorForLog(error),
        );
      })
      .finally(() => {
        sweep = null;
      });
  };
  run();
  scheduler = setInterval(run, Math.max(10_000, options?.intervalMs ?? 30_000));
  scheduler.unref?.();
}

export async function stopSiteOpsWorkerScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  await sweep;
}
