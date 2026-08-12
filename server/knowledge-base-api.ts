import axios from "axios";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  getFrontMindCredentials,
  getUpstreamBaseUrl,
  toUpstreamAgentProfile,
} from "./upstream-config";
import {
  credentialsUseSameUpstreamApiKey,
  getDecryptedCredentialForKnowledgeBaseReservation,
  getCredentialForUpstreamResource,
  recordUpstreamResource,
} from "./auth-service";
import {
  KnowledgeBaseBuildError,
  assertKnowledgeBaseCustomerOutput,
  assertKnowledgeBaseTaskBinding,
  classifyKnowledgeBaseUserAction,
  extractFinalKnowledgeBaseAssistantText,
  getKnowledgeBaseProgress,
  getKnowledgeBaseObservationProjection,
  hasClosedKnowledgeBasePresentationEnvelope,
  hasClosedKnowledgeBaseStateEnvelope,
  isAmbiguousKnowledgeBaseAdvance,
  isIdempotentKnowledgeBaseReconcileError,
  isKnowledgeBaseAcknowledgementOnlyOutput,
  knowledgeBaseProtocolErrorAllowsSameTaskRecovery,
  observeKnowledgeBaseOperationalFailure,
  observeKnowledgeBaseProtocolFailure,
  reconcileKnowledgeBaseProgress,
  resumeKnowledgeBaseFinalPackageMissing,
} from "./knowledge-base-progress-service";
import {
  getDashboardWorkspace,
  getKnowledgeSnapshotById,
  getLatestKnowledgeSnapshot,
} from "./dashboard-service";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";
import type {
  KnowledgeBaseInteractionDto,
  KnowledgeBaseObservationDto,
  KnowledgeBaseProgressDto,
} from "../shared/knowledge-base-progress";
import { normalizeKnowledgeBaseAttachmentMimeType } from "../shared/knowledge-base-attachment";
import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  uploadUpstreamTaskAttachment,
  UpstreamTaskAttachmentContentProofError,
  UpstreamTaskAttachmentPendingError,
} from "./upstream-task-attachment";
import { recordKnowledgeBaseOutputFiles } from "./knowledge-base-output-resource-service";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import { extractKnowledgeBaseProtocolObjects } from "../shared/knowledge-base-output";
import {
  classifyKnowledgeBaseUpstreamTaskStatus,
  formatKnowledgeBaseManifestEnvelope,
  KNOWLEDGE_BASE_MANIFEST_KIND,
} from "./knowledge-base-progress";
import { knowledgeBaseInteractionTelemetryEvents } from "./knowledge-base-interaction-telemetry";
import { logKnowledgeBaseOperationTelemetry } from "./knowledge-base-operation-telemetry";
import {
  bindKnowledgeBaseFinalPackage,
  bindKnowledgeBaseInitialLogo,
  bindKnowledgeBaseOfficialLogoUpload,
  bindKnowledgeBaseReadyPackage,
  assertKnowledgeBaseOfficialLogoUploadCandidate,
  cleanupKnowledgeBaseStagedArtifactCandidate,
  collectKnowledgeBaseLogoDescriptors,
  KnowledgeBaseArtifactBindingError,
  recoverKnowledgeBaseInitialLogoFromCompletedTurn,
  type KnowledgeBaseInitialLogoDisposition,
  type KnowledgeBaseOfficialLogoUpload,
  type KnowledgeBaseStagedArtifactCandidate,
} from "./knowledge-base-artifact-binding-service";
import { collectKnowledgeArchiveDescriptors } from "./knowledge-base-artifact";
import {
  bindKnowledgeBaseTurnUpstreamTask,
  cancelUnpreparedKnowledgeBaseTurn,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseTurnForRecovery,
  completeKnowledgeBaseGeneratedAttachment,
  deferKnowledgeBaseTurnBeforeCreate,
  findRecoverableKnowledgeBaseTurnIds,
  failKnowledgeBaseTurnDeterministically,
  findReusableKnowledgeBaseSkillFileId,
  freezeKnowledgeBaseTurnAttachments,
  inspectKnowledgeBaseDeferredAttachmentReplay,
  inspectKnowledgeBaseDeferredDispatchReplay,
  inspectKnowledgeBaseLegacyAttachmentTakeoverReplay,
  inspectKnowledgeBaseLegacyDeferredReservationReplay,
  inspectKnowledgeBaseLegacyStartReplay,
  inspectKnowledgeBaseTurnReplay,
  markKnowledgeBaseTurnDispatching,
  markKnowledgeBaseTurnOutcomeUnknown,
  prepareKnowledgeBaseTurnDispatch,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseRetryTurn,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  replaceKnowledgeBaseTurnAttachmentsAfterUserFix,
  resumeKnowledgeBaseTurnAfterUserFix,
  rejectAcknowledgedKnowledgeBaseManualLogoTurn,
  rejectUnacknowledgedKnowledgeBaseManualLogoTurn,
  renewKnowledgeBaseTurnLease,
  stageAndClaimKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseTurnAttachments,
  KnowledgeBaseTurnReservationError,
  type KnowledgeBaseCreateAttemptState,
  type KnowledgeBasePreparedDispatch,
  type KnowledgeBaseRecoveryClaim,
  type KnowledgeBaseDeferredDispatchClaim,
  type KnowledgeBaseTurnReservation,
} from "./knowledge-base-turn-service";
import {
  claimKnowledgeBaseOpenRecoveryBuild,
  releaseKnowledgeBaseOpenRecoveryLease,
  renewKnowledgeBaseOpenRecoveryLease,
  type KnowledgeBaseOpenRecoveryClaim,
} from "./knowledge-base-open-recovery-lease";
import { assertCapturedKnowledgeBaseCustomerImage } from "./knowledge-base-customer-upload";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  assertKnowledgeBaseAttachmentManifestPresent,
  normalizeKnowledgeBaseClientAttachmentManifest,
  normalizeKnowledgeBaseUserAttachments,
  type KnowledgeBaseAttachment,
  type KnowledgeBaseClientAttachmentManifestItem,
} from "./knowledge-base-client-attachment-manifest";
import { assertKnowledgeBaseExpectedGeneration } from "./knowledge-base-turn-coordinates";
import { logKnowledgeBaseRuntimeFailure } from "./knowledge-base-runtime-log";
import {
  getKnowledgeBaseSkillDescriptor,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  knowledgeBasePinnedV4SkillSelection,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";
import { knowledgeBaseNewBuildPolicyBinding } from "./knowledge-base-tree-policy-rollout";
import {
  buildKnowledgeBasePrefillEvidenceArchive,
  buildKnowledgeBasePrompt,
  KnowledgeBaseEnterpriseIdentityError,
  KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
  resolveKnowledgeBaseEnterpriseIdentity,
} from "./knowledge-base-prompt-contract";
import {
  buildKnowledgeBaseInstructionDelivery,
  KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
} from "./knowledge-base-prompt-delivery";
import { buildKnowledgeBaseTurnPrompt } from "./knowledge-base-turn-prompt";
import {
  assertKnowledgeBaseCustomerUploadCapacity,
  assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo,
  buildFinalizationInputForTurn,
  knowledgeBaseBuildRequiresOfficialLogo,
  knowledgeBaseManifestRepeatsOfficialLogo,
  knowledgeBaseTurnRequiresFinalPackage,
  loadKnowledgeBaseBuildRecord,
  loadKnowledgeBaseBuildRecordById,
  shouldBindKnowledgeBaseInitialLogo,
} from "./knowledge-base-final-turn-service";
import {
  applyKnowledgeBaseFinalLogoProvenanceObservation,
  assertKnowledgeBaseFinalLogoProvenanceForBuild,
  inspectKnowledgeBaseFinalLogoProvenance,
} from "./knowledge-base-logo-provenance-repair";
import {
  createKnowledgeBaseLogoProvenanceErrorResponder,
  createKnowledgeBaseLogoProvenanceRouter,
} from "./knowledge-base-logo-provenance-api";
import {
  assertUpstreamPromptBudget,
  UpstreamPromptBudgetError,
} from "./upstream-prompt-budget";
import {
  classifyKnowledgeBaseOpenRecoveryFailure,
  classifyKnowledgeBaseUpstreamCreateFailure,
  knowledgeBaseArtifactFailureNotice,
  KNOWLEDGE_BASE_AGENT_PROFILE,
  KnowledgeBaseAttachmentsProcessingError,
  KnowledgeBaseLocalPreparationError,
  KnowledgeBaseOpenRecoveryLeaseError,
  KnowledgeBaseUpstreamCreateError,
  KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
  type KnowledgeBaseUpstreamCreateFailureClass,
  type KnowledgeBaseProviderReasonCategory,
} from "./knowledge-base-api-errors";
import {
  checkUpstreamFilesReadiness,
  waitForUpstreamFilesReady,
  UpstreamFileReadinessError,
  type UpstreamFilesReadiness,
} from "./upstream-file-readiness";
import {
  assertExpectedUpstreamTaskId,
  canonicalUpstreamTask,
  upstreamTaskId,
} from "./upstream-task-adapter";

export * from "./knowledge-base-api-errors";

export * from "./knowledge-base-client-attachment-manifest";
export * from "./knowledge-base-turn-coordinates";
export * from "./knowledge-base-runtime-log";
export * from "./knowledge-base-prompt-contract";
export {
  getKnowledgeBaseSkillDescriptor,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  knowledgeBasePinnedV4SkillSelection,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";
export {
  knowledgeBaseTurnRequiresFinalPackage,
  shouldBindKnowledgeBaseInitialLogo,
} from "./knowledge-base-final-turn-service";
export { buildKnowledgeBaseTurnPrompt } from "./knowledge-base-turn-prompt";

const router = Router();

async function requireKnowledgeBuildCapability(
  userId: number,
  res: import("express").Response,
) {
  try {
    await assertServiceCapability(userId, "knowledgeBuild");
    return true;
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return false;
    }
    throw error;
  }
}

interface KnowledgeBaseStartRequest {
  conversationId?: string;
  clientRequestId?: string;
  companyName?: string;
  companyWebsite?: string;
  operatorNotes?: string;
  attachments?: KnowledgeBaseAttachment[];
}

function reservationRetryAfterMs(reservation: KnowledgeBaseTurnReservation) {
  return reservation.state === "pending" ? reservation.retryAfterMs : 1_000;
}

export function knowledgeBaseReservationReceipt(
  reservation: Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>,
  stateEpoch?: number | null,
) {
  const dispatchState =
    reservation.state === "bound"
      ? "bound"
      : reservation.state === "pending"
        ? "recovering"
        : reservation.turn.dispatchState;
  return {
    state: reservation.state,
    dispatchState,
    turnId: reservation.turn.id,
    clientRequestId: reservation.turn.clientRequestId,
    generation: reservation.turn.buildGeneration,
    stateEpoch: stateEpoch ?? null,
    revision: reservation.turn.expectedRevision,
    leafId: reservation.turn.expectedLeafId,
    upstreamTaskId: reservation.turn.upstreamTaskId,
    failureClass: reservation.turn.failureClass,
    recoveryAction: reservation.turn.recoveryAction,
    canRegenerate: reservation.turn.canRegenerate,
    createAttemptState: reservation.turn.createAttemptState,
    traceId: reservation.turn.traceId,
    stagedAttachmentCount: reservation.turn.stagedUserAttachmentCount,
    expectedAttachmentCount: reservation.turn.expectedUserAttachmentCount,
    requiresUpload: reservation.state === "awaiting_attachments",
  };
}

export function knowledgeBaseAcceptedReservationReceipt(input: {
  turn: KnowledgeBaseRecoveryClaim["turn"];
  stateEpoch?: number | null;
}) {
  return {
    state: "pending" as const,
    // `reserved` is an internal outbox state. Once the HTTP request has been
    // accepted, the only truthful public states are "recovering" (the durable
    // claim is being dispatched/reconciled) or "bound" (a real provider task
    // id is already persisted). Never expose the turn id as a provider id.
    dispatchState: input.turn.upstreamTaskId ? "bound" : "recovering",
    turnId: input.turn.id,
    clientRequestId: input.turn.clientRequestId,
    generation: input.turn.buildGeneration,
    stateEpoch: input.stateEpoch ?? null,
    revision: input.turn.expectedRevision,
    leafId: input.turn.expectedLeafId,
    upstreamTaskId: input.turn.upstreamTaskId,
    failureClass: input.turn.failureClass,
    recoveryAction: input.turn.recoveryAction,
    canRegenerate: input.turn.canRegenerate,
    createAttemptState: input.turn.createAttemptState,
    traceId: input.turn.traceId,
    stagedAttachmentCount: input.turn.stagedUserAttachmentCount,
    expectedAttachmentCount: input.turn.expectedUserAttachmentCount,
    requiresUpload: false,
  };
}

export const KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE =
  "FrontMind 已接收 Logo，正在重新呈现当前知识节点";
export const KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION =
  "用户已明确提交一张企业官方主 Logo。请只更新并重新展示当前首节点，不得确认或推进节点。";
export const KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE =
  "已提交新的企业官方主 Logo，正在重新呈现当前知识节点。";

export function knowledgeBaseManualLogoPendingResponse(input: {
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
}) {
  return {
    status: 425 as const,
    retryAfterSeconds: String(
      Math.max(1, Math.ceil((input.retryAfterMs ?? 1_000) / 1_000)),
    ),
    body: {
      error: {
        code: "IDEMPOTENCY_PENDING" as const,
        message: KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE,
      },
      ...(input.observation ? { observation: input.observation } : {}),
    },
  };
}

export function knowledgeBaseManualLogoUnclassifiedFailureResponse(input: {
  reservationAcquired: boolean;
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
}) {
  if (input.reservationAcquired) {
    return knowledgeBaseManualLogoPendingResponse(input);
  }
  return {
    status: 503 as const,
    retryAfterSeconds: String(
      Math.max(1, Math.ceil((input.retryAfterMs ?? 1_000) / 1_000)),
    ),
    body: {
      error: {
        code: "KNOWLEDGE_BASE_LOGO_SUBMISSION_UNCERTAIN" as const,
        message: "Logo 提交结果暂未确认，系统将按同一请求自动重试",
      },
      ...(input.observation ? { observation: input.observation } : {}),
    },
  };
}

export function knowledgeBaseManualLogoTerminalFailure(error: unknown) {
  if (!(error instanceof KnowledgeBaseArtifactBindingError)) return null;
  if (error.code === "LOGO_UPLOAD_INVALID") {
    return {
      status: 422 as const,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID" as const,
      message: error.message,
    };
  }
  if (error.code === "BUILD_CHANGED") {
    return {
      status: 409 as const,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT" as const,
      message: error.message,
    };
  }
  return null;
}

export async function assertManualKnowledgeBaseLogoUploadCandidate(
  upload: Omit<KnowledgeBaseOfficialLogoUpload, "verified">,
  validateCapturedImage: typeof assertCapturedKnowledgeBaseCustomerImage = assertCapturedKnowledgeBaseCustomerImage,
) {
  try {
    assertKnowledgeBaseOfficialLogoUploadCandidate(upload);
    await validateCapturedImage({
      fileId: upload.fileId,
      filename: upload.filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      sourceSha256: upload.sourceSha256,
    });
  } catch (error) {
    throw new KnowledgeBaseTurnReservationError(
      "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      error instanceof KnowledgeBaseArtifactBindingError
        ? error.message
        : "上传的 Logo 原始文件无法安全解码或完整性校验失败，请重新选择原文件",
    );
  }
}

export function knowledgeBaseManualLogoDeterministicCreateFailureStatus(
  error: unknown,
) {
  if (
    !(error instanceof KnowledgeBaseUpstreamCreateError) ||
    error.failureClass !== "deterministic"
  ) {
    return null;
  }
  // A successful provider response without a task id does not prove that the
  // provider rejected the create. Manual Logo submission must reconcile the
  // same reservation instead of reporting a terminal validation failure.
  if (error.failureCode === "UPSTREAM_TASK_ID_MISSING") return null;
  if (error.status === 400) return 400 as const;
  if (error.status === 401 || error.status === 403) return 403 as const;
  if (error.status === 409) return 409 as const;
  if (error.status === 413) return 413 as const;
  if (error.status === 422) return 422 as const;
  return 422 as const;
}

export function knowledgeBaseManualLogoCreateFailureForPersistence(
  error: unknown,
) {
  if (
    error instanceof KnowledgeBaseUpstreamCreateError &&
    error.failureCode === "UPSTREAM_TASK_ID_MISSING"
  ) {
    return new KnowledgeBaseUpstreamCreateError(
      "unknown",
      error.failureCode,
      error.status,
    );
  }
  return error;
}

function respondKnowledgeBaseManualLogoPending(input: {
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
  res: import("express").Response;
}) {
  const response = knowledgeBaseManualLogoPendingResponse(input);
  input.res.setHeader("Retry-After", response.retryAfterSeconds);
  input.res.status(response.status).json(response.body);
}

function respondKnowledgeBaseManualLogoUnclassifiedFailure(input: {
  reservationAcquired: boolean;
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
  res: import("express").Response;
}) {
  const response = knowledgeBaseManualLogoUnclassifiedFailureResponse(input);
  input.res.setHeader("Retry-After", response.retryAfterSeconds);
  input.res.status(response.status).json(response.body);
}

export function knowledgeBaseTurnReservationErrorStatus(
  error: KnowledgeBaseTurnReservationError,
) {
  if (error.code === "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH") {
    logKnowledgeBaseOperationTelemetry({
      event: "turn_replay_mismatch",
      reasonCode: error.code,
    });
  } else if (error.code === "STALE_KNOWLEDGE_BASE_PRESENTATION") {
    logKnowledgeBaseOperationTelemetry({
      event: "stale_presentation_submission",
      reasonCode: error.code,
    });
  }
  if (
    error.code === "BUILD_NOT_FOUND" ||
    error.code === "RESERVATION_NOT_FOUND"
  ) {
    return 404;
  }
  if (error.code === "INVALID_REQUEST") return 400;
  if (error.code === "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID") return 422;
  if (error.code === "IDEMPOTENCY_PENDING") return 425;
  // Stale presentation, immutable replay mismatch and Logo binding conflict
  // are all durable coordinate conflicts, not malformed requests.
  return 409;
}

export function knowledgeBaseTurnReplayHttpStatus(
  state: Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>["state"],
  terminalStatus = 409,
) {
  if (state === "pending" || state === "bound") return 202;
  if (state === "terminal") return terminalStatus;
  return 200;
}

async function respondKnowledgeBaseTurnReplayReceipt(input: {
  userId: number;
  conversationId: string;
  requestedClientRequestId: string;
  receipt: Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>;
  replayHit?: boolean;
  requireUpstreamTaskId?: boolean;
  terminalStatus?: number;
  suppressTerminalError?: boolean;
  resumed?: boolean;
  res: import("express").Response;
}) {
  const { receipt, res } = input;
  if (input.replayHit === true) {
    logKnowledgeBaseOperationTelemetry({
      event: "turn_replay_hit",
      buildId: receipt.turn.buildId,
      turnId: receipt.turn.id,
      reasonCode:
        receipt.turn.clientRequestId === input.requestedClientRequestId
          ? "exact_request"
          : "operation_winner",
      adoptedWinner:
        receipt.turn.clientRequestId !== input.requestedClientRequestId,
    });
  }
  const observation = await getKnowledgeBaseObservation({
    userId: input.userId,
    conversationId: input.conversationId,
    upstreamStatus: receipt.state === "completed" ? "completed" : "running",
  }).catch(() => null);
  if (input.requireUpstreamTaskId && receipt.state === "pending") {
    respondKnowledgeBaseManualLogoPending({
      observation,
      retryAfterMs: reservationRetryAfterMs(receipt),
      res,
    });
    return;
  }
  const inFlight = receipt.state === "pending" || receipt.state === "bound";
  if (inFlight) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(reservationRetryAfterMs(receipt) / 1_000)),
    );
  }
  const taskId =
    receipt.state === "bound" || receipt.state === "completed"
      ? receipt.upstreamTaskId
      : null;
  res
    .status(
      knowledgeBaseTurnReplayHttpStatus(receipt.state, input.terminalStatus),
    )
    .json({
      ...(receipt.state === "terminal" && input.suppressTerminalError !== true
        ? {
            error: {
              code: "KNOWLEDGE_BASE_TURN_TERMINAL",
              message: "本轮提交已结束，请按当前知识库状态重试",
            },
          }
        : {}),
      reservation: knowledgeBaseReservationReceipt(
        receipt,
        observation?.stateEpoch,
      ),
      ...(receipt.turn.clientRequestId !== input.requestedClientRequestId
        ? { adoptedClientRequestId: receipt.turn.clientRequestId }
        : {}),
      ...(taskId
        ? {
            task: {
              id: taskId,
              status: receipt.state === "completed" ? "completed" : "running",
            },
          }
        : {}),
      observation,
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      idempotent: true,
      ...(input.resumed === true ? { resumed: true } : {}),
      startedAt: receipt.turn.startedAt?.getTime() || Date.now(),
    });
}

async function respondIfKnowledgeBaseTurnReplay(input: {
  userId: number;
  conversationId: string;
  requestedClientRequestId: string;
  inspect: () => Promise<Exclude<
    KnowledgeBaseTurnReservation,
    { state: "acquired" }
  > | null>;
  requireUpstreamTaskId?: boolean;
  res: import("express").Response;
}) {
  const receipt = await input.inspect();
  if (!receipt) return false;
  await respondKnowledgeBaseTurnReplayReceipt({
    userId: input.userId,
    conversationId: input.conversationId,
    requestedClientRequestId: input.requestedClientRequestId,
    receipt,
    replayHit: true,
    requireUpstreamTaskId: input.requireUpstreamTaskId,
    res: input.res,
  });
  return true;
}

type KnowledgeBaseBuildRecord = Awaited<
  ReturnType<typeof loadKnowledgeBaseBuildRecord>
>;

/**
 * Resolve the server-owned build and its parent task from one database
 * snapshot. Accepted dispatch can replace upstreamTaskId without advancing
 * the build revision, so rereading only to compare the derived task ID creates
 * a false conflict for an otherwise valid lost-response replay.
 */
export async function loadKnowledgeBaseTurnAuthority(
  input: { userId: number; conversationId: string },
  loadBuild: typeof loadKnowledgeBaseBuildRecord = loadKnowledgeBaseBuildRecord,
): Promise<{
  build: NonNullable<KnowledgeBaseBuildRecord>;
  taskId: string;
} | null> {
  const build = await loadBuild(input.userId, input.conversationId);
  const taskId = String(build?.upstreamTaskId || "");
  return build && taskId ? { build, taskId } : null;
}

function outputItemIds(output: unknown[]) {
  return output
    .map((item) =>
      item && typeof item === "object" && "id" in item
        ? String((item as { id?: unknown }).id || "")
        : "",
    )
    .filter(Boolean);
}

export function selectUnreconciledKnowledgeOutput(
  output: unknown[],
  _ledger: { lastOutputLength: number; lastOutputItemIds: string[] },
  _options: { replayStableOutput?: boolean } = {},
) {
  // Correctness never depends on a provider's cumulative-array length or item
  // IDs. Both can be reused/reordered/replaced between polls. The service
  // selects one semantic state candidate from the complete snapshot and makes
  // its application idempotent; the ledger remains telemetry only.
  return output;
}

const COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE =
  /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT =
  /<!--\s*FRONTMIND_KB_[A-Z_]+\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_MANIFEST =
  /<!--\s*FRONTMIND_KB_MANIFEST\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_TRANSITION =
  /<!--\s*FRONTMIND_KB_(?:PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_PRESENTATION =
  /<!--\s*FRONTMIND_KB_PRESENTATION\b[\s\S]*?-->/i;

function normalizedUpstreamTaskStatus(status: unknown) {
  return classifyKnowledgeBaseUpstreamTaskStatus(status).normalized;
}

const knowledgeInteractionAlertAt = new Map<string, number>();

function observeKnowledgeInteraction(
  progress: KnowledgeBaseProgressDto | null,
  upstreamStatus: unknown,
) {
  const normalized = normalizedUpstreamTaskStatus(upstreamStatus);
  const now = Date.now();
  const alert = (
    kind: string,
    dedupeKey: string,
    metadata: Record<string, unknown>,
  ) => {
    const key = `${progress?.build.id || "unbound"}:${kind}:${dedupeKey}`;
    const lastAlertAt = knowledgeInteractionAlertAt.get(key);
    if (
      lastAlertAt !== undefined &&
      (kind === "active_turn_age_bucket" || lastAlertAt > now - 10 * 60_000)
    ) {
      return;
    }
    knowledgeInteractionAlertAt.set(key, now);
    console.warn(
      `[KnowledgeBaseInteraction] ${kind}`,
      JSON.stringify(metadata),
    );
  };
  for (const event of knowledgeBaseInteractionTelemetryEvents({
    buildId: progress?.build.id,
    awaitingResponseSince: progress?.build.awaitingResponseSince,
    upstreamStatus: normalized,
    now,
  })) {
    alert(event.kind, event.dedupeKey, event.metadata);
  }
  if (knowledgeInteractionAlertAt.size > 1_000) {
    const expiry = now - 24 * 60 * 60_000;
    knowledgeInteractionAlertAt.forEach((lastSeen, key) => {
      if (lastSeen < expiry) knowledgeInteractionAlertAt.delete(key);
    });
  }
}

function upstreamTaskFailed(status: unknown) {
  return classifyKnowledgeBaseUpstreamTaskStatus(status).failed;
}

/**
 * Some providers stop at an interaction-ready status instead of `completed`.
 * At that point a same-ID output replacement is stable and must be replayed,
 * but an incomplete envelope must still remain non-terminal for validation.
 */
export function shouldReplayStableKnowledgeOutput(status: unknown) {
  return classifyKnowledgeBaseUpstreamTaskStatus(status).settled;
}

export function shouldReconcileKnowledgeOutput(
  output: unknown[],
  status: unknown,
  options: { requirePresentation?: boolean } = {},
) {
  const text = extractFinalKnowledgeBaseAssistantText(output);
  const taskStatus = classifyKnowledgeBaseUpstreamTaskStatus(status);
  if (!text) return taskStatus.settled;
  const closedState = hasClosedKnowledgeBaseStateEnvelope(text);
  const closedPresentation = hasClosedKnowledgeBasePresentationEnvelope(text);

  // A running stream may contain parseable JSON before the HTML comment and
  // companion resources are complete. Bare JSON is a legacy terminal-only
  // compatibility path and must never advance a running build.
  if (!taskStatus.settled) {
    if (!closedState) return false;
    if (!options.requirePresentation) return true;
    return COMPLETE_KNOWLEDGE_MANIFEST.test(text) || closedPresentation;
  }
  const rawKinds = new Set(
    extractKnowledgeBaseProtocolObjects(text).map((value) => value.kind),
  );
  if (options.requirePresentation) {
    if (
      COMPLETE_KNOWLEDGE_MANIFEST.test(text) ||
      rawKinds.has("frontmind.knowledge-base.manifest")
    ) {
      return true;
    }
    if (
      (COMPLETE_KNOWLEDGE_TRANSITION.test(text) ||
        rawKinds.has("frontmind.knowledge-base.progress") ||
        rawKinds.has("frontmind.knowledge-base.reopen")) &&
      (COMPLETE_KNOWLEDGE_PRESENTATION.test(text) ||
        rawKinds.has("frontmind.knowledge-base.presentation"))
    ) {
      return true;
    }
    return true;
  }
  if (
    COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE.test(text) ||
    COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT.test(text) ||
    rawKinds.has("frontmind.knowledge-base.manifest") ||
    rawKinds.has("frontmind.knowledge-base.progress") ||
    rawKinds.has("frontmind.knowledge-base.reopen")
  ) {
    return true;
  }
  // A terminal provider response without a complete protocol envelope is a
  // protocol failure. Waiting/running output may still be a partial stream, so
  // it must never poison the build or unlock input until a closed envelope is
  // present.
  return true;
}

export function deriveKnowledgeBaseInteraction(
  progress: KnowledgeBaseProgressDto | null,
  upstreamStatus: unknown,
): KnowledgeBaseInteractionDto {
  observeKnowledgeInteraction(progress, upstreamStatus);
  if (progress?.build.status === "published") {
    return {
      progress,
      interactionState: "published",
      canReply: false,
      canPublish: false,
      lockReason: "知识库已发布；后续修改请提交维护需求",
    };
  }
  if (
    progress?.packageAllowed &&
    progress.build.status === "ready_to_publish"
  ) {
    return {
      progress,
      interactionState: "ready_to_publish",
      canReply: false,
      canPublish: true,
      lockReason: "知识库已完成，请执行唯一一次直接更新",
    };
  }
  if (
    progress?.build.status === "protocol_error" ||
    progress?.build.status === "failed"
  ) {
    return {
      progress,
      interactionState: "failed",
      canReply: false,
      canPublish: false,
      lockReason:
        progress?.build.protocolError || "知识库任务执行失败，请重新同步状态",
    };
  }
  if (
    progress?.build.status === "confirming" &&
    progress.build.currentLeafId &&
    progress.build.awaitingResponseSince === null
  ) {
    return {
      progress,
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    };
  }
  const interactionState =
    normalizedUpstreamTaskStatus(upstreamStatus) === "pending"
      ? "queued"
      : "executing";
  return {
    progress,
    interactionState,
    canReply: false,
    canPublish: false,
    lockReason: upstreamTaskFailed(upstreamStatus)
      ? "正在确认上游失败并保留最后正确正文"
      : "FrontMind 正在整理当前知识节点",
  };
}

/**
 * A fully approved node waiting for the customer's next decision is already a
 * terminal observation of the previous upstream operation. Focus/online
 * wakes may still call reconcile, but they must not reread that completed task
 * or turn a later credential/task outage into a failure of the approved node.
 */
export function isApprovedKnowledgeBaseAwaitingInputObservation(
  observation: KnowledgeBaseObservationDto | null,
) {
  const progress = observation?.interaction.progress;
  const presentation = observation?.approvedPresentation;
  return Boolean(
    observation &&
      observation.activeTurn === null &&
      observation.interaction.interactionState === "awaiting_input" &&
      observation.interaction.canReply === true &&
      progress?.build.status === "confirming" &&
      progress.build.awaitingResponseSince === null &&
      progress.build.currentLeafId &&
      presentation &&
      presentation.visibleMarkdown.trim() &&
      presentation.revision === progress.build.revision &&
      presentation.leafId === progress.build.currentLeafId,
  );
}

export async function getKnowledgeBaseObservation(input: {
  userId: number;
  conversationId: string;
  upstreamStatus: unknown;
}): Promise<KnowledgeBaseObservationDto | null> {
  const projection = await getKnowledgeBaseObservationProjection(input);
  if (!projection) return null;
  const { progress, ...observation } = projection;
  let interaction = deriveKnowledgeBaseInteraction(
    progress,
    input.upstreamStatus,
  );
  if (
    interaction.interactionState === "awaiting_input" &&
    (!observation.approvedPresentation ||
      observation.approvedPresentation.revision !== progress.build.revision ||
      observation.approvedPresentation.leafId !==
        progress.build.currentLeafId ||
      (progress.build.skillVersion === "4" &&
        progress.build.revision === 0 &&
        progress.summary.handled === 0 &&
        progress.build.logoRequired !== true &&
        (observation.approvedPresentation.imageState !== "attached" ||
          observation.approvedPresentation.resources.filter(
            (resource) => resource.kind === "logo",
          ).length !== 1)))
  ) {
    interaction = {
      progress,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: "当前知识节点正在完成服务端展示校验",
    };
  }
  const finalLogoProvenance = await inspectKnowledgeBaseFinalLogoProvenance({
    userId: input.userId,
    buildId: progress.build.id,
    generation: observation.generation,
  });
  const provenanceObservation =
    applyKnowledgeBaseFinalLogoProvenanceObservation({
      state: finalLogoProvenance,
      progress,
      observation,
      interaction,
    });
  interaction = provenanceObservation.interaction;
  observation.notice = provenanceObservation.notice;
  return {
    ...observation,
    interaction,
  };
}

const respondKnowledgeBaseLogoProvenanceError =
  createKnowledgeBaseLogoProvenanceErrorResponder(getKnowledgeBaseObservation);

router.use(
  createKnowledgeBaseLogoProvenanceRouter({
    requireKnowledgeBuildCapability,
    getKnowledgeBaseObservation,
  }),
);

export function knowledgeBaseUpstreamReadFailureAuthority(input: {
  kind: "credential_unavailable" | "transport" | "http";
  status?: number;
}) {
  const credentialFailure =
    input.kind === "credential_unavailable" ||
    (input.kind === "http" && [401, 403].includes(Number(input.status)));
  return credentialFailure
    ? ({
        code:
          input.kind === "credential_unavailable"
            ? "UPSTREAM_CREDENTIAL_UNAVAILABLE"
            : "UPSTREAM_CREDENTIAL_REJECTED",
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
        canRegenerate: false,
      } as const)
    : ({
        code: "UPSTREAM_TASK_READ_FAILED",
        failureClass: "recoverable_same_turn",
        recoveryAction: "reconcile",
        canRegenerate: false,
      } as const);
}

export function knowledgeBaseNoticeAllowsSameTaskReconcile(
  notice:
    | Pick<
        NonNullable<KnowledgeBaseObservationDto["notice"]>,
        "canRegenerate" | "recoveryAction"
      >
    | null
    | undefined,
) {
  return (
    notice?.canRegenerate !== true &&
    (notice?.recoveryAction === "reconcile" ||
      notice?.recoveryAction === "update_credential" ||
      notice?.recoveryAction === "top_up")
  );
}

export function knowledgeBaseReconcileFailureStatus(error: unknown) {
  return error instanceof KnowledgeBaseBuildError
    ? error.code === "BUILD_NOT_FOUND"
      ? 404
      : 422
    : 503;
}

async function observeKnowledgeBaseUpstreamFailure(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  code: string;
  message: string;
  failureClass: "recoverable_same_turn" | "requires_user_fix";
  recoveryAction: "reconcile" | "update_credential";
}) {
  await observeKnowledgeBaseOperationalFailure(input);
  const observation = await getKnowledgeBaseObservation({
    userId: input.userId,
    conversationId: input.conversationId,
    upstreamStatus:
      input.failureClass === "requires_user_fix" ? "failed" : "running",
  });
  return {
    observation,
    durable:
      input.failureClass === "requires_user_fix" &&
      (observation?.interaction.progress?.build.status === "protocol_error" ||
        observation?.interaction.progress?.build.status === "failed"),
  };
}

/**
 * Historical v3 could attach three visuals. Never guess which response
 * attachment was the Logo; its final ZIP manifest identifies the unique
 * brand_identity/badge and binds those bytes instead.
 */

async function cleanupUnpromotedKnowledgeBaseArtifactCandidates(
  userId: number,
  conversationId: string,
  candidates: readonly KnowledgeBaseStagedArtifactCandidate[],
) {
  if (candidates.length === 0) return;
  let build;
  try {
    build = await loadKnowledgeBaseBuildRecord(userId, conversationId);
  } catch {
    // A later GC sweep handles candidates left by database/process outages.
    return;
  }
  await Promise.all(
    candidates.map(async (candidate) => {
      const promotedStorageKey =
        candidate.kind === "logo"
          ? build?.logoStorageKey
          : build?.packageStorageKey;
      if (promotedStorageKey === candidate.storageKey) return;
      await cleanupKnowledgeBaseStagedArtifactCandidate(candidate).catch(
        () => undefined,
      );
    }),
  );
}

async function reconcileAvailableKnowledgeOutput(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  output: unknown[];
  upstreamStatus: unknown;
  ledger: { lastOutputLength: number; lastOutputItemIds: string[] };
  artifactAccess?: { apiKey: string; baseUrl: string };
}) {
  const stagedCandidates: KnowledgeBaseStagedArtifactCandidate[] = [];
  const stagedArtifacts: {
    logo?: KnowledgeBaseInitialLogoDisposition;
    package?: KnowledgeBaseStagedArtifactCandidate;
  } = {};
  try {
    let progress = await getKnowledgeBaseProgress({
      userId: input.userId,
      conversationId: input.conversationId,
    });
    const unreconciled = selectUnreconciledKnowledgeOutput(
      input.output,
      input.ledger,
      {
        replayStableOutput: shouldReplayStableKnowledgeOutput(
          input.upstreamStatus,
        ),
      },
    );
    const upstreamPhase = classifyKnowledgeBaseUpstreamTaskStatus(
      input.upstreamStatus,
    );
    if (
      shouldReconcileKnowledgeOutput(unreconciled, input.upstreamStatus, {
        requirePresentation:
          progress?.build.skillVersion === "3" ||
          progress?.build.skillVersion === "4",
      })
    ) {
      if (
        input.artifactAccess &&
        !isKnowledgeBaseAcknowledgementOnlyOutput(unreconciled)
      ) {
        const artifactAccess = input.artifactAccess;
        let boundBuild;
        try {
          boundBuild = await assertKnowledgeBaseTaskBinding({
            userId: input.userId,
            conversationId: input.conversationId,
            taskId: input.taskId,
          });
        } catch (error) {
          if (
            error instanceof KnowledgeBaseBuildError &&
            error.code === "PROGRESS_PROTOCOL_INVALID"
          ) {
            // A delayed resource snapshot from an older task/generation is an
            // expected at-least-once delivery. It must never poison the current
            // authoritative build.
            return progress;
          }
          throw error;
        }
        const finalPackageMissing =
          boundBuild.status === "protocol_error" &&
          boundBuild.protocolErrorCode === "FINAL_PACKAGE_MISSING";
        const archiveDescriptorCount =
          collectKnowledgeArchiveDescriptors(unreconciled).length;
        if (finalPackageMissing && archiveDescriptorCount === 0) {
          // A provider may publish the typed file after the terminal text
          // snapshot. Keep the exact failed turn recoverable and re-read this
          // same task; never replay the final Progress transition by itself.
          return progress;
        }
        if (finalPackageMissing) {
          const resumed = await resumeKnowledgeBaseFinalPackageMissing({
            userId: input.userId,
            conversationId: input.conversationId,
            taskId: input.taskId,
            output: unreconciled,
          });
          if (!resumed) return progress;
          boundBuild = await assertKnowledgeBaseTaskBinding({
            userId: input.userId,
            conversationId: input.conversationId,
            taskId: input.taskId,
          });
        }
        const packageRebindRequired =
          boundBuild.status === "protocol_error" &&
          boundBuild.protocolErrorCode === "PACKAGE_REBIND_REQUIRED";
        if (packageRebindRequired && archiveDescriptorCount === 0) {
          // The historical task remains the sole authority. A partial provider
          // snapshot must keep the rebind notice intact instead of replaying the
          // already-applied final Progress transition or creating a new turn.
          return progress;
        }
        try {
          const bindInitialLogo =
            boundBuild.skillVersion === "4"
              ? boundBuild.totalNodeCount === 0
              : shouldBindKnowledgeBaseInitialLogo(
                  boundBuild.skillVersion,
                  collectKnowledgeBaseLogoDescriptors(unreconciled).length,
                );
          if (bindInitialLogo) {
            const logoBinding = await bindKnowledgeBaseInitialLogo({
              userId: input.userId,
              buildId: boundBuild.id,
              generation: boundBuild.generation,
              taskId: input.taskId,
              output: unreconciled,
              apiKey: artifactAccess.apiKey,
              baseUrl: artifactAccess.baseUrl,
            });
            if ("staged" in logoBinding && logoBinding.staged === true) {
              stagedArtifacts.logo = logoBinding;
              stagedCandidates.push(logoBinding);
            } else if (
              "rejected" in logoBinding &&
              logoBinding.rejected === true
            ) {
              if (!upstreamPhase.settled) return progress;
              stagedArtifacts.logo = logoBinding;
            }
          }
          if (
            (boundBuild.skillVersion === "4" ||
              !boundBuild.packageStorageKey ||
              packageRebindRequired) &&
            collectKnowledgeArchiveDescriptors(unreconciled).length > 0
          ) {
            const bindPackage =
              boundBuild.status === "ready_to_publish" || packageRebindRequired
                ? bindKnowledgeBaseReadyPackage
                : bindKnowledgeBaseFinalPackage;
            const packageBinding = await serializeKnowledgeBasePackageBinding(
              () =>
                bindPackage({
                  userId: input.userId,
                  buildId: boundBuild.id,
                  generation: boundBuild.generation,
                  taskId: input.taskId,
                  output: unreconciled,
                  apiKey: artifactAccess.apiKey,
                  baseUrl: artifactAccess.baseUrl,
                }),
            );
            if ("staged" in packageBinding && packageBinding.staged === true) {
              stagedArtifacts.package = packageBinding;
              stagedCandidates.push(packageBinding);
            }
          }
        } catch (error) {
          if (packageRebindRequired) {
            // Rebinding is a recovery of the same settled task, not a new model
            // turn. Any incomplete/invalid artifact observation leaves the
            // stable PACKAGE_REBIND_REQUIRED notice in place for another
            // reconcile of that same authority.
            return (
              (await getKnowledgeBaseProgress({
                userId: input.userId,
                conversationId: input.conversationId,
              })) || progress
            );
          }
          if (isIdempotentKnowledgeBaseReconcileError(error)) {
            return progress;
          }
          if (
            error instanceof KnowledgeBaseArtifactBindingError &&
            !upstreamPhase.settled
          ) {
            // A resource can appear before its bytes or companion protocol have
            // settled. Keep the authoritative turn locked and retry the same
            // complete snapshot; never advance the accepted cursor.
            return progress;
          }
          if (
            error instanceof KnowledgeBaseArtifactBindingError &&
            error.code === "BUILD_CHANGED"
          ) {
            return progress;
          }
          if (upstreamPhase.settled) {
            const serializedOutput = (() => {
              try {
                return JSON.stringify(unreconciled);
              } catch {
                return "[unserializable-upstream-output]";
              }
            })();
            const errorCode =
              error && typeof error === "object" && "code" in error
                ? String(error.code || "")
                : error instanceof Error
                  ? error.name
                  : "UNKNOWN";
            const observationKey = createHash("sha256")
              .update(
                JSON.stringify({
                  taskId: input.taskId,
                  phase: upstreamPhase.phase,
                  outputSha256: createHash("sha256")
                    .update(serializedOutput, "utf8")
                    .digest("hex"),
                  errorCode,
                }),
                "utf8",
              )
              .digest("hex");
            const failureNotice = knowledgeBaseArtifactFailureNotice(error);
            await observeKnowledgeBaseProtocolFailure({
              userId: input.userId,
              conversationId: input.conversationId,
              taskId: input.taskId,
              observationKey,
              message: failureNotice.message,
              code: upstreamPhase.failed
                ? "UPSTREAM_TASK_FAILED"
                : failureNotice.code,
              status: upstreamPhase.failed ? "failed" : "protocol_error",
              definitive: upstreamPhase.failed,
            });
            return (
              (await getKnowledgeBaseProgress({
                userId: input.userId,
                conversationId: input.conversationId,
              })) || progress
            );
          }
          throw error;
        }
      }
      progress = await reconcileKnowledgeBaseProgress({
        userId: input.userId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        output: unreconciled,
        upstreamStatus: input.upstreamStatus,
        outputState: {
          totalLength: input.output.length,
          itemIds: outputItemIds(input.output),
        },
        stagedArtifacts,
      });
      if (progress && stagedArtifacts.logo) {
        if ("staged" in stagedArtifacts.logo) {
          logKnowledgeBaseOperationTelemetry({
            event: "initial_logo_accepted",
            buildId: stagedArtifacts.logo.buildId,
            turnId: stagedArtifacts.logo.turnId,
          });
        } else if (
          "rejected" in stagedArtifacts.logo &&
          progress.build.logoRequired === true
        ) {
          logKnowledgeBaseOperationTelemetry({
            event: "initial_logo_degraded_to_upload",
            buildId: stagedArtifacts.logo.buildId,
            turnId: stagedArtifacts.logo.turnId,
            reasonCode: stagedArtifacts.logo.rejectionCode,
          });
        }
      }
    }
    return progress;
  } finally {
    await cleanupUnpromotedKnowledgeBaseArtifactCandidates(
      input.userId,
      input.conversationId,
      stagedCandidates,
    );
  }
}

let knowledgeBasePackageBindingTail: Promise<void> = Promise.resolve();

async function serializeKnowledgeBasePackageBinding<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = knowledgeBasePackageBindingTail;
  let release!: () => void;
  knowledgeBasePackageBindingTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function withKnowledgeBaseOpenRecoveryLeaseHeartbeat<T>(input: {
  claim: KnowledgeBaseOpenRecoveryClaim;
  leaseMs: number;
  operation: () => Promise<T>;
  /** Test seam; production always uses the database-backed renewer. */
  renewLease?: typeof renewKnowledgeBaseOpenRecoveryLease;
}) {
  const renewLease = input.renewLease ?? renewKnowledgeBaseOpenRecoveryLease;
  let renewalTail: Promise<void> = Promise.resolve();
  let leaseFailure: KnowledgeBaseOpenRecoveryLeaseError | null = null;
  const recordLeaseFailure = (error: unknown) => {
    if (leaseFailure) return;
    leaseFailure =
      error instanceof KnowledgeBaseOpenRecoveryLeaseError
        ? error
        : new KnowledgeBaseOpenRecoveryLeaseError(
            "Knowledge-base open recovery lease renewal failed",
            { cause: error },
          );
  };
  const renew = () => {
    if (leaseFailure) return;
    // Attach the rejection handler in the same turn in which the renewal is
    // scheduled. A database/network rejection must never sit unobserved while
    // a long artifact operation is still running.
    renewalTail = renewalTail
      .then(async () => {
        if (leaseFailure) return;
        const renewed = await renewLease({
          buildId: input.claim.build.id,
          generation: input.claim.build.generation,
          leaseToken: input.claim.leaseToken,
          leaseMs: input.leaseMs,
        });
        if (!renewed) {
          throw new KnowledgeBaseOpenRecoveryLeaseError();
        }
      })
      .catch(recordLeaseFailure);
  };
  const timer = setInterval(
    renew,
    Math.max(250, Math.min(60_000, Math.trunc(input.leaseMs / 3))),
  );
  timer.unref();
  let result!: T;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    result = await input.operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  } finally {
    clearInterval(timer);
    // The tail is rejection-safe by construction. Awaiting it also closes the
    // final tick that may already have been queued when the timer was cleared.
    await renewalTail;
  }
  if (leaseFailure) {
    throw leaseFailure;
  }
  if (operationFailed) throw operationFailure;
  return result;
}

export async function recoverOpenKnowledgeBaseTasks(options?: {
  limit?: number;
  concurrency?: number;
  afterBuildId?: string;
  leaseMs?: number;
}) {
  const db = await getDb();
  if (!db) {
    return {
      scanned: 0,
      claimed: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
      packageRebindRequired: 0,
      nextCursor: null,
      hasMore: false,
    };
  }
  const limit = Math.min(500, Math.max(1, Math.trunc(options?.limit ?? 100)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const scanNow = new Date();
  const builds = await db
    .select({
      id: knowledgeBaseBuilds.id,
      userId: knowledgeBaseBuilds.userId,
      conversationId: knowledgeBaseBuilds.conversationId,
      status: knowledgeBaseBuilds.status,
      generation: knowledgeBaseBuilds.generation,
      stateEpoch: knowledgeBaseBuilds.stateEpoch,
      protocolErrorCode: knowledgeBaseBuilds.protocolErrorCode,
      upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
      lastOutputLength: knowledgeBaseBuilds.lastOutputLength,
      lastOutputItemIds: knowledgeBaseBuilds.lastOutputItemIds,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        isNotNull(knowledgeBaseBuilds.upstreamTaskId),
        isNull(knowledgeBaseBuilds.activeTurnId),
        or(
          isNull(knowledgeBaseBuilds.recoveryLeaseExpiresAt),
          lte(knowledgeBaseBuilds.recoveryLeaseExpiresAt, scanNow),
        ),
        or(
          and(
            inArray(knowledgeBaseBuilds.status, ["researching", "confirming"]),
            or(
              eq(knowledgeBaseBuilds.status, "researching"),
              isNotNull(knowledgeBaseBuilds.awaitingResponseSince),
            ),
          ),
          and(
            eq(knowledgeBaseBuilds.status, "ready_to_publish"),
            isNull(knowledgeBaseBuilds.packageStorageKey),
          ),
          and(
            eq(knowledgeBaseBuilds.status, "protocol_error"),
            eq(
              knowledgeBaseBuilds.protocolErrorCode,
              "PACKAGE_REBIND_REQUIRED",
            ),
            isNull(knowledgeBaseBuilds.packageStorageKey),
          ),
        ),
        options?.afterBuildId
          ? gt(knowledgeBaseBuilds.id, options.afterBuildId)
          : undefined,
      ),
    )
    .orderBy(asc(knowledgeBaseBuilds.id))
    .limit(limit);

  const result = {
    scanned: builds.length,
    claimed: 0,
    reconciled: 0,
    skipped: 0,
    failed: 0,
    packageRebindRequired: 0,
    nextCursor: builds.length ? builds[builds.length - 1]!.id : null,
    hasMore: builds.length === limit,
  };
  let cursor = 0;
  const baseUrl = getUpstreamBaseUrl();
  const worker = async () => {
    while (cursor < builds.length) {
      const candidate = builds[cursor++];
      let claim: KnowledgeBaseOpenRecoveryClaim | null = null;
      let taskId = String(candidate.upstreamTaskId || "");
      let deferToPackageRebind = false;
      let recoveryApiKey: string | undefined;
      try {
        claim = await claimKnowledgeBaseOpenRecoveryBuild({
          buildId: candidate.id,
          expectedGeneration: candidate.generation,
          expectedStateEpoch: candidate.stateEpoch,
          expectedTaskId: taskId,
          leaseMs: options?.leaseMs,
        });
        if (!claim) {
          result.skipped += 1;
          continue;
        }
        result.claimed += 1;
        const build = claim.build;
        taskId = String(build.upstreamTaskId || "");
        deferToPackageRebind = claim.kind === "package_rebind";
        await withKnowledgeBaseOpenRecoveryLeaseHeartbeat({
          claim,
          leaseMs: options?.leaseMs ?? 300_000,
          operation: async () => {
            await assertKnowledgeBaseWritable(build.userId);
            const credential = await getCredentialForUpstreamResource(
              build.userId,
              "task",
              taskId,
            );
            if (!credential) {
              if (deferToPackageRebind) result.packageRebindRequired += 1;
              else result.skipped += 1;
              logKnowledgeBaseRuntimeFailure({
                level: "warn",
                event: deferToPackageRebind
                  ? "[KnowledgeBaseRecovery] package_rebind_credential_unavailable"
                  : "[KnowledgeBaseRecovery] credential_unavailable",
                buildId: build.id,
                taskId,
                error: null,
              });
              return;
            }
            recoveryApiKey = credential.apiKey;
            const taskResponse = await axios.get(
              `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
              {
                headers: {
                  API_KEY: credential.apiKey,
                  Authorization: `Bearer ${credential.apiKey}`,
                },
                timeout: 120000,
                validateStatus: () => true,
              },
            );
            if (taskResponse.status < 200 || taskResponse.status >= 300) {
              if (deferToPackageRebind) result.packageRebindRequired += 1;
              else result.failed += 1;
              logKnowledgeBaseRuntimeFailure({
                level: "warn",
                event: deferToPackageRebind
                  ? "[KnowledgeBaseRecovery] package_rebind_task_unavailable"
                  : "[KnowledgeBaseRecovery] task_read_failed",
                buildId: build.id,
                taskId,
                error: { status: taskResponse.status },
                additionalSecrets: [credential.apiKey],
              });
              return;
            }
            const taskData = assertExpectedUpstreamTaskId(
              taskResponse.data,
              taskId,
            );
            const output = normalizeRecoveredTaskOutput(taskData);
            await recordKnowledgeBaseOutputFiles({
              userId: build.userId,
              apiCredentialId: credential.id,
              output,
            });
            const taskStatus = normalizedUpstreamTaskStatus(taskData.status);
            if (!shouldReconcileKnowledgeOutput(output, taskStatus)) {
              observeKnowledgeInteraction(
                await getKnowledgeBaseProgress({
                  userId: build.userId,
                  conversationId: build.conversationId,
                }),
                taskStatus,
              );
              if (deferToPackageRebind) result.packageRebindRequired += 1;
              else result.skipped += 1;
              return;
            }
            await reconcileAvailableKnowledgeOutput({
              userId: build.userId,
              conversationId: build.conversationId,
              taskId,
              output,
              upstreamStatus: taskStatus,
              ledger: {
                lastOutputLength: build.lastOutputLength,
                lastOutputItemIds: build.lastOutputItemIds,
              },
              artifactAccess: { apiKey: credential.apiKey, baseUrl },
            });
            result.reconciled += 1;
          },
        });
      } catch (error) {
        if (deferToPackageRebind) result.packageRebindRequired += 1;
        else result.failed += 1;
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: deferToPackageRebind
            ? "[KnowledgeBaseRecovery] package_rebind_reconcile_failed"
            : "[KnowledgeBaseRecovery] reconcile_failed",
          buildId: candidate.id,
          taskId,
          error,
          additionalSecrets: [recoveryApiKey],
        });
      } finally {
        if (claim) {
          await releaseKnowledgeBaseOpenRecoveryLease({
            buildId: claim.build.id,
            generation: claim.build.generation,
            leaseToken: claim.leaseToken,
          }).catch((error) => {
            logKnowledgeBaseRuntimeFailure({
              level: "warn",
              event: "[KnowledgeBaseRecovery] lease_release_failed",
              buildId: claim!.build.id,
              taskId,
              error,
            });
          });
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, builds.length) }, worker),
  );
  return result;
}

function recoveryString(
  metadata: Record<string, unknown>,
  key: string,
  fallback = "",
) {
  const value = metadata[key];
  return typeof value === "string" ? value : fallback;
}

function recoveryOfficialLogoUpload(
  metadata: Record<string, unknown>,
): KnowledgeBaseOfficialLogoUpload | undefined {
  const value = metadata.officialLogoUpload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const upload = value as Record<string, unknown>;
  const index = Number(upload.index);
  const fileId = String(upload.fileId || "");
  const filename = String(upload.filename || "");
  const mimeType = String(upload.mimeType || "");
  const sizeBytes = Number(upload.sizeBytes);
  const sourceSha256 = String(upload.sourceSha256 || "").toLowerCase();
  return upload.verified === true &&
    index === 0 &&
    fileId &&
    filename &&
    mimeType.startsWith("image/") &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes > 0 &&
    /^[a-f0-9]{64}$/u.test(sourceSha256)
    ? {
        verified: true,
        index,
        fileId,
        filename,
        mimeType,
        sizeBytes,
        sourceSha256,
      }
    : undefined;
}

type PendingKnowledgeBaseOfficialLogoUpload = Omit<
  KnowledgeBaseOfficialLogoUpload,
  "verified"
> & { verified: false };

function recoveryPendingOfficialLogoUpload(
  metadata: Record<string, unknown>,
): PendingKnowledgeBaseOfficialLogoUpload | undefined {
  const value = metadata.officialLogoUpload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const upload = value as Record<string, unknown>;
  const index = Number(upload.index);
  const fileId = String(upload.fileId || "");
  const filename = String(upload.filename || "");
  const mimeType = String(upload.mimeType || "");
  const sizeBytes = Number(upload.sizeBytes);
  const sourceSha256 = String(upload.sourceSha256 || "").toLowerCase();
  return upload.verified === false &&
    index === 0 &&
    fileId &&
    filename &&
    mimeType &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes > 0 &&
    /^[a-f0-9]{64}$/u.test(sourceSha256)
    ? {
        verified: false,
        index,
        fileId,
        filename,
        mimeType,
        sizeBytes,
        sourceSha256,
      }
    : undefined;
}

async function serverOwnedKnowledgeBaseAttachmentManifest(
  attachments: Array<{ file_id: string; filename: string }>,
) {
  const manifest = [];
  for (const attachment of attachments) {
    const stored = await readStoredPresalesFile(attachment.file_id);
    if (
      !stored ||
      !stored.sha256 ||
      stored.sizeBytes < 1 ||
      stored.filename !== attachment.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        `附件“${attachment.filename}”的受管上传记录尚未就绪，请重新选择文件后提交`,
      );
    }
    manifest.push({
      filename: stored.filename,
      sizeBytes: stored.sizeBytes,
      mimeType: normalizeKnowledgeBaseAttachmentMimeType(
        stored.filename,
        stored.mimeType,
      ),
      lastModified: 0,
      sha256: stored.sha256.toLowerCase(),
    });
  }
  return manifest;
}

export function knowledgeBaseRecoveryLogoPreparationError(error: unknown) {
  return new KnowledgeBaseLocalPreparationError(
    "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    error instanceof KnowledgeBaseArtifactBindingError
      ? error.message
      : "企业官方主 Logo 无法从本轮受管上传恢复，请重新上传",
    { cause: error },
  );
}

function recoveredAssistantOutput(value: unknown): unknown[] {
  if (typeof value === "string") {
    return [
      {
        type: "output_message",
        role: "assistant",
        content: [{ type: "output_text", text: value }],
      },
    ];
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.role) return [record];
  const type = String(record.type || "").toLowerCase();
  const hasAssistantText =
    ["message", "output_message", "output_text", "text", ""].includes(type) &&
    (typeof record.text === "string" ||
      typeof record.output_text === "string" ||
      typeof record.value === "string" ||
      typeof record.content === "string" ||
      Array.isArray(record.content));
  return hasAssistantText
    ? [
        {
          ...record,
          role: "assistant",
          ...(typeof record.value === "string" &&
          record.text === undefined &&
          record.output_text === undefined &&
          record.content === undefined
            ? { text: record.value }
            : {}),
        },
      ]
    : [record];
}

function knowledgeBaseUpstreamRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The provider has returned both direct task objects and `{ task: ... }`
 * wrappers. Treat the nested task as authoritative when present so id,
 * status, and output can never be read from different response levels.
 */
export function canonicalKnowledgeBaseUpstreamTask(
  value: unknown,
): Record<string, unknown> {
  const task = canonicalUpstreamTask(value);
  // Even callers which only inspect output must reject conflicting or
  // overlong identity claims before those values can reach durable storage.
  upstreamTaskId(task, false);
  return task;
}

function knowledgeBaseUpstreamString(value: unknown, maxLength: number) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function normalizeRecoveredTaskOutput(taskData: unknown): unknown[] {
  const record = canonicalKnowledgeBaseUpstreamTask(taskData);
  if (Array.isArray(record.output)) {
    return record.output.flatMap((item) => recoveredAssistantOutput(item));
  }
  if (record.output !== undefined && record.output !== null) {
    return recoveredAssistantOutput(record.output);
  }
  if (record.output_text !== undefined && record.output_text !== null) {
    const outputText =
      typeof record.output_text === "object" && record.output_text !== null
        ? ((record.output_text as Record<string, unknown>).value ??
          (record.output_text as Record<string, unknown>).text)
        : record.output_text;
    return recoveredAssistantOutput(String(outputText ?? ""));
  }
  return [];
}

type RecoveryCredential = NonNullable<
  Awaited<ReturnType<typeof getDecryptedCredentialForKnowledgeBaseReservation>>
>;

const KNOWLEDGE_BASE_READINESS_WAIT_MS = 5_000;
const knowledgeBaseClaimReadinessTimings = new WeakMap<
  KnowledgeBaseRecoveryClaim,
  { startedAt: number; maxDelayMs: number }
>();

function beginKnowledgeBaseClaimReadinessTiming(
  claim: KnowledgeBaseRecoveryClaim,
) {
  const existing = knowledgeBaseClaimReadinessTimings.get(claim);
  if (existing) return existing;
  const timing = { startedAt: Date.now(), maxDelayMs: 0 };
  knowledgeBaseClaimReadinessTimings.set(claim, timing);
  return timing;
}

function knowledgeBaseClaimReadinessDelayMs(claim: KnowledgeBaseRecoveryClaim) {
  const timing = beginKnowledgeBaseClaimReadinessTiming(claim);
  timing.maxDelayMs = Math.max(
    timing.maxDelayMs,
    Math.max(0, Date.now() - timing.startedAt),
  );
  return timing.maxDelayMs;
}

export function knowledgeBaseClaimTraceId(claim: KnowledgeBaseRecoveryClaim) {
  const value = String(
    claim.turn.traceId || claim.recoveryMetadata?.traceId || "",
  ).trim();
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    value,
  )
    ? value
    : undefined;
}

function knowledgeBaseUserAttachmentIds(claim: KnowledgeBaseRecoveryClaim) {
  const attachments = Array.isArray(claim.recoveryMetadata.attachments)
    ? (claim.recoveryMetadata.attachments as unknown[])
    : [];
  return new Set(
    attachments.flatMap((value) => {
      const record = knowledgeBaseUpstreamRecord(value);
      const fileId = String(record?.file_id || "").trim();
      return fileId ? [fileId] : [];
    }),
  );
}

function knowledgeBaseReadinessFailure(
  error: unknown,
  input: {
    attachmentKind: "generated" | "user";
    traceId?: string;
    attachmentCount: number;
  },
) {
  if (error instanceof UpstreamFileReadinessError && error.retryable) {
    return new KnowledgeBaseAttachmentsProcessingError(
      0,
      input.attachmentCount,
      5_000,
      input.traceId,
      { cause: error },
    );
  }
  if (error instanceof UpstreamFileReadinessError) {
    return new KnowledgeBaseLocalPreparationError(
      input.attachmentKind === "user"
        ? "KNOWLEDGE_BASE_USER_ATTACHMENT_INVALID"
        : "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
      input.attachmentKind === "user"
        ? "用户附件尚未通过上游可用性校验"
        : "系统生成附件尚未通过上游可用性校验",
      { cause: error },
    );
  }
  return error;
}

function assertKnowledgeBaseReadinessComplete(
  result: UpstreamFilesReadiness,
  traceId?: string,
) {
  if (result.pending.length > 0) {
    throw new KnowledgeBaseAttachmentsProcessingError(
      result.ready.length,
      result.pending.length,
      5_000,
      traceId,
    );
  }
  return result.files.map((file) => ({
    file_id: file.fileId,
    filename: file.filename,
  }));
}

async function waitForKnowledgeBaseAttachmentGroup(input: {
  baseUrl: string;
  apiKey: string;
  attachments: Array<{ file_id: string; filename: string }>;
  attachmentKind: "generated" | "user";
  filenamePolicy?: "exact" | "provider_authoritative";
  traceId?: string;
  deadlineMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  if (input.attachments.length === 0) return [];
  try {
    const result = await waitForUpstreamFilesReady({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      files: input.attachments.map((attachment) => ({
        fileId: attachment.file_id,
        filename: attachment.filename,
      })),
      filenamePolicy: input.filenamePolicy,
      deadlineMs: input.deadlineMs ?? KNOWLEDGE_BASE_READINESS_WAIT_MS,
      sleep: input.sleep,
    });
    return assertKnowledgeBaseReadinessComplete(result, input.traceId);
  } catch (error) {
    throw knowledgeBaseReadinessFailure(error, {
      attachmentKind: input.attachmentKind,
      traceId: input.traceId,
      attachmentCount: input.attachments.length,
    });
  }
}

async function checkKnowledgeBaseAttachmentGroup(input: {
  baseUrl: string;
  apiKey: string;
  attachments: Array<{ file_id: string; filename: string }>;
  attachmentKind: "generated" | "user";
  traceId?: string;
}) {
  if (input.attachments.length === 0) return [];
  try {
    const result = await checkUpstreamFilesReadiness({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      files: input.attachments.map((attachment) => ({
        fileId: attachment.file_id,
        filename: attachment.filename,
      })),
      filenamePolicy: "exact",
    });
    return assertKnowledgeBaseReadinessComplete(result, input.traceId);
  } catch (error) {
    throw knowledgeBaseReadinessFailure(error, {
      attachmentKind: input.attachmentKind,
      traceId: input.traceId,
      attachmentCount: input.attachments.length,
    });
  }
}

export async function waitForKnowledgeBaseDispatchAttachments(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  baseUrl: string;
  attachments: Array<{ file_id: string; filename: string }>;
  readinessDeadlineMs?: number;
  readinessSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  beginKnowledgeBaseClaimReadinessTiming(input.claim);
  const userIds = knowledgeBaseUserAttachmentIds(input.claim);
  const generated = input.attachments.filter(
    (attachment) => !userIds.has(attachment.file_id),
  );
  const user = input.attachments.filter((attachment) =>
    userIds.has(attachment.file_id),
  );
  const traceId = knowledgeBaseClaimTraceId(input.claim);
  const [readyGenerated, readyUser] = await Promise.all([
    waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.credential.apiKey,
      attachments: generated,
      attachmentKind: "generated",
      filenamePolicy: "exact",
      traceId,
      deadlineMs: input.readinessDeadlineMs,
      sleep: input.readinessSleep,
    }),
    waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.credential.apiKey,
      attachments: user,
      attachmentKind: "user",
      filenamePolicy: "provider_authoritative",
      traceId,
      deadlineMs: input.readinessDeadlineMs,
      sleep: input.readinessSleep,
    }),
  ]);
  knowledgeBaseClaimReadinessDelayMs(input.claim);
  const canonicalById = new Map(
    [...readyGenerated, ...readyUser].map((attachment) => [
      attachment.file_id,
      attachment,
    ]),
  );
  return input.attachments.map(
    (attachment) => canonicalById.get(attachment.file_id) || attachment,
  );
}

export async function checkKnowledgeBasePreparedAttachments(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  dispatch: KnowledgeBasePreparedDispatch;
}) {
  beginKnowledgeBaseClaimReadinessTiming(input.claim);
  const userIds = knowledgeBaseUserAttachmentIds(input.claim);
  const generated = input.dispatch.requestBody.attachments.filter(
    (attachment) => !userIds.has(attachment.file_id),
  );
  const user = input.dispatch.requestBody.attachments.filter((attachment) =>
    userIds.has(attachment.file_id),
  );
  const traceId = knowledgeBaseClaimTraceId(input.claim);
  await checkKnowledgeBaseAttachmentGroup({
    baseUrl: input.dispatch.baseUrl,
    apiKey: input.credential.apiKey,
    attachments: generated,
    attachmentKind: "generated",
    traceId,
  });
  await checkKnowledgeBaseAttachmentGroup({
    baseUrl: input.dispatch.baseUrl,
    apiKey: input.credential.apiKey,
    attachments: user,
    attachmentKind: "user",
    traceId,
  });
  knowledgeBaseClaimReadinessDelayMs(input.claim);
}

async function uploadRecoverySkill(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  baseUrl: string;
  skillVersion: string;
  skillContentHash: string | null;
  stagedPrefix?: string[];
  boundUpstreamFileId?: string;
}) {
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  const skillArchive = await readKnowledgeBaseSkillArchiveAttachment({
    version: input.skillVersion,
    contentHash: input.skillContentHash,
  });
  const reusableUpstreamFileId = input.boundUpstreamFileId
    ? null
    : await findReusableKnowledgeBaseSkillFileId({
        userId: input.claim.turn.userId,
        buildId: input.claim.turn.buildId!,
        apiCredentialId: input.credential.id,
        contentSha256: createHash("sha256")
          .update(skillArchive.bytes)
          .digest("hex"),
      }).catch(() => null);
  const uploaded = await uploadKnowledgeBaseSkillArchive({
    baseUrl: input.baseUrl,
    apiKey: input.credential.apiKey,
    skillVersion: input.skillVersion,
    skillContentHash: input.skillContentHash,
    reusableUpstreamFileId,
    durable: {
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      attachmentIndex: input.stagedPrefix?.length ?? 0,
    },
  });
  if (
    input.boundUpstreamFileId &&
    uploaded.fileId !== input.boundUpstreamFileId
  ) {
    throw new Error("Recovered Skill file id changed during byte upload");
  }
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  await stageKnowledgeBaseTurnAttachments({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    attachmentFileIds: [...(input.stagedPrefix || []), uploaded.fileId],
  });
  await recordUpstreamResource({
    userId: input.claim.turn.userId,
    apiCredentialId: input.credential.id,
    kind: "file",
    upstreamId: uploaded.fileId,
  });
  return uploaded;
}

/**
 * Handles the small pre-prepare crash window. Every value needed to recreate
 * the request is pinned in recovery metadata, and every already staged file id
 * is reused. Once prepared, all later retries read the stored exact body.
 */
async function ensureKnowledgeBaseRecoveryDispatch(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
}) {
  if (input.claim.preparedDispatch) return input.claim.preparedDispatch;
  const { claim, credential } = input;
  const recovery = claim.recoveryMetadata;
  const kind = recoveryString(recovery, "kind");
  const conversationId = recoveryString(recovery, "conversationId");
  const skillVersion = recoveryString(recovery, "skillVersion", "4");
  const skillContentHash = recoveryString(recovery, "skillContentHash") || null;
  const finalPackageRequired = recovery.finalPackageRequired === true;
  const userAttachments = normalizeKnowledgeBaseUserAttachments(
    Array.isArray(recovery.attachments)
      ? (recovery.attachments as KnowledgeBaseAttachment[])
      : [],
  );
  const baseUrl =
    recoveryString(recovery, "retryBaseUrl") || getUpstreamBaseUrl();
  const agentProfile =
    recoveryString(recovery, "retryAgentProfile") ||
    toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE);
  const stagedIds = [...claim.turn.attachmentFileIds];
  if (!claim.turn.buildId) {
    throw new Error("Recovery turn is not bound to a knowledge-base build");
  }
  const pinnedBuild = await loadKnowledgeBaseBuildRecordById(
    claim.turn.userId,
    claim.turn.buildId,
  );
  if (!pinnedBuild || pinnedBuild.generation !== claim.turn.buildGeneration) {
    throw new Error("Recovery build identity changed");
  }

  if (kind === "turn") {
    const parentTaskId =
      recoveryString(recovery, "retryParentTaskId") ||
      recoveryString(recovery, "parentTaskId");
    const userMessage = recoveryString(recovery, "userMessage");
    const attachmentManifest = Array.isArray(recovery.attachmentManifest)
      ? normalizeKnowledgeBaseClientAttachmentManifest(
          recovery.attachmentManifest,
        )
      : undefined;
    let officialLogoUpload = recoveryOfficialLogoUpload(recovery);
    const pendingManualLogoUpload =
      recovery.manualLogoSubmission === true
        ? recoveryPendingOfficialLogoUpload(recovery)
        : undefined;
    if (!conversationId || !parentTaskId) {
      throw new Error("Turn recovery metadata is incomplete");
    }
    if (!officialLogoUpload && !pendingManualLogoUpload) {
      if (
        pinnedBuild.id === claim.turn.buildId &&
        knowledgeBaseBuildRequiresOfficialLogo(pinnedBuild)
      ) {
        const manifestItem = attachmentManifest?.[0];
        const attachment = userAttachments[0];
        if (
          attachmentManifest?.length !== 1 ||
          userAttachments.length !== 1 ||
          !manifestItem ||
          !attachment ||
          !claim.turn.expectedLeafId
        ) {
          throw new KnowledgeBaseArtifactBindingError(
            "LOGO_UPLOAD_INVALID",
            "企业官方主 Logo 恢复账本不完整，请重新上传",
          );
        }
        try {
          officialLogoUpload = await bindKnowledgeBaseOfficialLogoUpload({
            userId: claim.turn.userId,
            buildId: claim.turn.buildId,
            generation: claim.turn.buildGeneration,
            turnId: claim.turn.id,
            operationKey: claim.turn.operationKey,
            expectedRevision: claim.turn.expectedRevision,
            expectedLeafId: claim.turn.expectedLeafId,
            upload: {
              index: 0,
              fileId: attachment.file_id,
              filename: manifestItem.filename,
              mimeType: manifestItem.mimeType,
              sizeBytes: manifestItem.sizeBytes,
              sourceSha256: manifestItem.sha256,
            },
          });
          logKnowledgeBaseOperationTelemetry({
            event: "logo_upload_candidate_recovered",
            buildId: claim.turn.buildId,
            turnId: claim.turn.id,
          });
        } catch (error) {
          logKnowledgeBaseOperationTelemetry({
            event: "logo_upload_candidate_rejected",
            buildId: claim.turn.buildId,
            turnId: claim.turn.id,
            reasonCode:
              error instanceof KnowledgeBaseArtifactBindingError
                ? error.code
                : "LOCAL_PREPARATION_FAILED",
          });
          // This binding runs before request preparation or upstream create.
          // Any failure is therefore known-local and must release the turn,
          // never leave it in outcome_unknown recovery.
          throw knowledgeBaseRecoveryLogoPreparationError(error);
        }
        claim.recoveryMetadata = {
          ...claim.recoveryMetadata,
          officialLogoUpload,
        };
      }
    }
    // A manual Logo turn is intentionally prepared from the server-owned copy
    // before that copy is promoted into the build. The real upstream task must
    // be acknowledged first; promotion happens from the dispatch callback.
    const officialLogoUploadForPrompt =
      officialLogoUpload ||
      (pendingManualLogoUpload
        ? { ...pendingManualLogoUpload, verified: true as const }
        : undefined);
    const deferredClientAttachments =
      recovery.deferredClientAttachments === true;
    const stagedUserIds = userAttachments.map(
      (attachment) => attachment.file_id,
    );
    if (
      deferredClientAttachments &&
      (stagedIds.length < stagedUserIds.length ||
        stagedUserIds.some((fileId, index) => stagedIds[index] !== fileId) ||
        stagedIds.length > stagedUserIds.length + 2)
    ) {
      throw new Error("Deferred turn attachment ledger is inconsistent");
    }
    const boundSkillId = deferredClientAttachments
      ? stagedIds[stagedUserIds.length]
      : stagedIds[0];
    const recoveredSkill = await uploadRecoverySkill({
      claim,
      credential,
      baseUrl,
      skillVersion,
      skillContentHash,
      stagedPrefix: deferredClientAttachments ? stagedUserIds : [],
      ...(boundSkillId ? { boundUpstreamFileId: boundSkillId } : {}),
    });
    const skillId = recoveredSkill.fileId;
    const generatedAttachments: Array<{
      file_id: string;
      filename: string;
    }> = [
      {
        file_id: skillId,
        filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
      },
    ];
    let finalizationInput:
      | {
          filename: string;
          sha256: string;
          assetCount: number;
        }
      | undefined;
    if (finalPackageRequired) {
      if (skillVersion !== "4" || deferredClientAttachments) {
        throw new Error(
          "Finalization input is only valid for a complete v4 turn",
        );
      }
      const action = classifyKnowledgeBaseUserAction(
        userMessage,
        userAttachments.length,
      );
      if (action !== "confirm" && action !== "direct_prefill") {
        throw new Error("Finalization input requires a final confirmation");
      }
      if (
        !Number.isSafeInteger(claim.turn.expectedRevision) ||
        Number(claim.turn.expectedRevision) < 0 ||
        !Number.isSafeInteger(claim.turn.buildGeneration) ||
        Number(claim.turn.buildGeneration) < 1
      ) {
        throw new Error("Finalization input coordinates are incomplete");
      }
      let archive: Awaited<ReturnType<typeof buildFinalizationInputForTurn>>;
      try {
        archive = await buildFinalizationInputForTurn({
          userId: claim.turn.userId,
          buildId: claim.turn.buildId!,
          generation: Number(claim.turn.buildGeneration),
          operationId: claim.turn.operationKey,
          turnId: claim.turn.id,
          buildRevision: Number(claim.turn.expectedRevision) + 1,
          transitionTarget:
            action === "confirm" ? "confirmed" : "direct_prefilled",
        });
      } catch (error) {
        throw new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_FINALIZATION_INPUT_INVALID",
          `最终交付输入无法通过本地完整性校验：${error instanceof Error ? error.message : "未知错误"}`,
          { cause: error },
        );
      }
      const uploaded = await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey: credential.apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
        durable: {
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          attachmentIndex: 1,
          role: "finalization",
        },
      });
      await renewKnowledgeBaseTurnLease({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentFileIds: [skillId, uploaded.fileId],
      });
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: uploaded.fileId,
      });
      generatedAttachments.push({
        file_id: uploaded.fileId,
        filename: archive.filename,
      });
      finalizationInput = {
        filename: archive.filename,
        sha256: archive.sha256,
        assetCount: archive.assetCount,
      };
    }
    let prompt: string;
    if (finalPackageRequired) {
      prompt = await buildKnowledgeBaseTurnPrompt({
        userId: claim.turn.userId,
        conversationId,
        userMessage,
        attachments: userAttachments,
        attachmentManifest,
        skillVersion,
        skillContentHash,
        officialLogoUpload: officialLogoUploadForPrompt,
        finalizationInput,
        protocolOperation: {
          operationId: claim.turn.operationKey,
          turnId: claim.turn.id,
        },
      });
    } else {
      const fullInstructions = await buildKnowledgeBaseTurnPrompt({
        userId: claim.turn.userId,
        conversationId,
        userMessage,
        attachments: userAttachments,
        attachmentManifest,
        skillVersion,
        skillContentHash,
        officialLogoUpload: officialLogoUploadForPrompt,
        protocolOperation: {
          operationId: claim.turn.operationKey,
          turnId: claim.turn.id,
        },
      });
      const instructionDelivery = buildKnowledgeBaseInstructionDelivery({
        instructions: fullInstructions,
        skillVersion,
        treePolicyVersion: pinnedBuild.treePolicyVersion,
        operationId: claim.turn.operationKey,
        turnId: claim.turn.id,
      });
      const instructionIndex = deferredClientAttachments
        ? stagedUserIds.length + 1
        : 1;
      const boundInstructionFileId = stagedIds[instructionIndex];
      const uploadedInstruction =
        await uploadDurableKnowledgeBaseGeneratedAttachment({
          baseUrl,
          apiKey: credential.apiKey,
          filename: instructionDelivery.filename,
          bytes: instructionDelivery.bytes,
          mimeType: instructionDelivery.mimeType,
          durable: {
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            attachmentIndex: instructionIndex,
            role: "instructions",
          },
        });
      const instructionFileId = uploadedInstruction.fileId;
      if (
        boundInstructionFileId &&
        instructionFileId !== boundInstructionFileId
      ) {
        throw new Error(
          "Recovered instructions file id changed during byte upload",
        );
      }
      await renewKnowledgeBaseTurnLease({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentFileIds: deferredClientAttachments
          ? [...stagedUserIds, skillId, instructionFileId]
          : [skillId, instructionFileId],
      });
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: instructionFileId,
      });
      generatedAttachments.push({
        file_id: instructionFileId,
        filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
      });
      prompt = instructionDelivery.prompt;
    }
    const attachments = finalPackageRequired
      ? [...generatedAttachments, ...userAttachments]
      : deferredClientAttachments
        ? [...userAttachments, ...generatedAttachments]
        : [...generatedAttachments, ...userAttachments];
    const readyAttachments = await waitForKnowledgeBaseDispatchAttachments({
      claim,
      credential,
      baseUrl,
      attachments,
    });
    await freezeKnowledgeBaseTurnAttachments({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      attachmentFileIds: readyAttachments.map(
        (attachment) => attachment.file_id,
      ),
    });
    const prepared = await prepareKnowledgeBaseTurnDispatch({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      baseUrl,
      prompt,
      agentProfile,
      attachments: readyAttachments,
      parentTaskId,
    });
    // Short accepted-path retries must reuse the exact prepared POST instead
    // of rebuilding attachments from the stale in-memory claim.
    claim.preparedDispatch = prepared;
    return prepared;
  }

  if (kind !== "start" || !conversationId) {
    throw new Error("Start recovery metadata is incomplete");
  }
  const companyName = recoveryString(recovery, "companyName");
  const companyWebsite = recoveryString(recovery, "companyWebsite");
  const operatorNotes = recoveryString(recovery, "operatorNotes");
  const prefillSnapshotId = recoveryString(recovery, "prefillSnapshotId");
  const includePrefill = Boolean(recovery.includePrefill);
  const prefillKnowledgeSnapshot = prefillSnapshotId
    ? await getKnowledgeSnapshotById({
        userId: claim.turn.userId,
        snapshotId: prefillSnapshotId,
      })
    : null;
  if (includePrefill && !prefillKnowledgeSnapshot) {
    throw new Error("Pinned knowledge-base prefill snapshot is unavailable");
  }

  const recoveredSkill = await uploadRecoverySkill({
    claim,
    credential,
    baseUrl,
    skillVersion,
    skillContentHash,
    ...(stagedIds[0] ? { boundUpstreamFileId: stagedIds[0] } : {}),
  });
  const skillId = recoveredSkill.fileId;
  const generatedAttachments = [
    { file_id: skillId, filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME },
  ];
  if (includePrefill) {
    await renewKnowledgeBaseTurnLease({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
    });
    const archive = await buildKnowledgeBasePrefillEvidenceArchive(
      prefillKnowledgeSnapshot!,
    );
    const uploaded = await uploadDurableKnowledgeBaseGeneratedAttachment({
      baseUrl,
      apiKey: credential.apiKey,
      filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
      bytes: archive.bytes,
      durable: {
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentIndex: 1,
        role: "prefill",
      },
    });
    const prefillFileId = uploaded.fileId;
    if (stagedIds[1] && prefillFileId !== stagedIds[1]) {
      throw new Error("Recovered prefill file id changed during byte upload");
    }
    await renewKnowledgeBaseTurnLease({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
    });
    await stageKnowledgeBaseTurnAttachments({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      attachmentFileIds: [skillId, prefillFileId],
    });
    await recordUpstreamResource({
      userId: claim.turn.userId,
      apiCredentialId: credential.id,
      kind: "file",
      upstreamId: prefillFileId,
    });
    generatedAttachments.push({
      file_id: prefillFileId,
      filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
    });
  }
  const fullInstructions = await buildKnowledgeBasePrompt({
    conversationId,
    companyName,
    companyWebsite,
    operatorNotes,
    attachments: userAttachments,
    prefillKnowledgeSnapshot,
    treePolicyVersion: pinnedBuild.treePolicyVersion,
    protocolOperation: {
      skillVersion,
      operationId: claim.turn.operationKey,
      turnId: claim.turn.id,
    },
  });
  const instructionDelivery = buildKnowledgeBaseInstructionDelivery({
    instructions: fullInstructions,
    skillVersion,
    treePolicyVersion: pinnedBuild.treePolicyVersion,
    operationId: claim.turn.operationKey,
    turnId: claim.turn.id,
  });
  const instructionIndex = includePrefill ? 2 : 1;
  const uploadedInstruction =
    await uploadDurableKnowledgeBaseGeneratedAttachment({
      baseUrl,
      apiKey: credential.apiKey,
      filename: instructionDelivery.filename,
      bytes: instructionDelivery.bytes,
      mimeType: instructionDelivery.mimeType,
      durable: {
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentIndex: instructionIndex,
        role: "instructions",
      },
    });
  const instructionFileId = uploadedInstruction.fileId;
  if (
    stagedIds[instructionIndex] &&
    instructionFileId !== stagedIds[instructionIndex]
  ) {
    throw new Error(
      "Recovered instructions file id changed during byte upload",
    );
  }
  await renewKnowledgeBaseTurnLease({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
  });
  await stageKnowledgeBaseTurnAttachments({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    attachmentFileIds: [
      ...generatedAttachments.map((attachment) => attachment.file_id),
      instructionFileId,
    ],
  });
  await recordUpstreamResource({
    userId: claim.turn.userId,
    apiCredentialId: credential.id,
    kind: "file",
    upstreamId: instructionFileId,
  });
  generatedAttachments.push({
    file_id: instructionFileId,
    filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
  });
  const attachments = [...generatedAttachments, ...userAttachments];
  const readyAttachments = await waitForKnowledgeBaseDispatchAttachments({
    claim,
    credential,
    baseUrl,
    attachments,
  });
  await freezeKnowledgeBaseTurnAttachments({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    attachmentFileIds: readyAttachments.map((attachment) => attachment.file_id),
  });
  const prepared = await prepareKnowledgeBaseTurnDispatch({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    baseUrl,
    prompt: instructionDelivery.prompt,
    agentProfile,
    attachments: readyAttachments,
  });
  claim.preparedDispatch = prepared;
  return prepared;
}

async function reconcileRecoveredKnowledgeBaseTask(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  taskId: string;
  taskData?: Record<string, unknown>;
}) {
  const { claim, credential, taskId } = input;
  await recordUpstreamResource({
    userId: claim.turn.userId,
    apiCredentialId: credential.id,
    kind: "task",
    upstreamId: taskId,
  });
  const baseUrl = claim.preparedDispatch?.baseUrl || getUpstreamBaseUrl();
  let taskData = input.taskData;
  if (!taskData) {
    const response = await axios.get(
      `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Recovered task read failed (${response.status})`);
    }
    taskData = assertExpectedUpstreamTaskId(response.data, taskId);
  } else {
    taskData = assertExpectedUpstreamTaskId(taskData, taskId);
  }
  const build = await loadKnowledgeBaseBuildRecordById(
    claim.turn.userId,
    claim.turn.buildId,
  );
  if (!build || build.generation !== claim.turn.buildGeneration) return false;
  const output = normalizeRecoveredTaskOutput(taskData);
  await recordKnowledgeBaseOutputFiles({
    userId: claim.turn.userId,
    apiCredentialId: credential.id,
    output,
  });
  const status = normalizedUpstreamTaskStatus(taskData.status);
  if (!shouldReconcileKnowledgeOutput(output, status)) return false;
  await reconcileAvailableKnowledgeOutput({
    userId: claim.turn.userId,
    conversationId: build.conversationId,
    taskId,
    output,
    upstreamStatus: status,
    ledger: {
      lastOutputLength: build.lastOutputLength,
      lastOutputItemIds: build.lastOutputItemIds,
    },
    artifactAccess: { apiKey: credential.apiKey, baseUrl },
  });
  return true;
}

export async function recoverKnowledgeBaseTurnClaimTask(input: {
  claim: KnowledgeBaseRecoveryClaim;
  ensureDispatch: () => Promise<KnowledgeBasePreparedDispatch>;
  createTask: (
    dispatch: KnowledgeBasePreparedDispatch,
    idempotencyKey: string,
  ) => Promise<{ taskId: string; taskData?: Record<string, unknown> }>;
  bindTask: (taskId: string) => Promise<void>;
  registerTask: (taskId: string) => Promise<void>;
  afterTaskAcknowledged?: (taskId: string) => Promise<void>;
  reconcileTask: (
    taskId: string,
    taskData?: Record<string, unknown>,
  ) => Promise<boolean>;
}) {
  let taskId = input.claim.turn.upstreamTaskId;
  let taskData: Record<string, unknown> | undefined;
  let rebound = false;
  if (!taskId) {
    const createAttemptState = input.claim.turn.createAttemptState;
    if (createAttemptState && createAttemptState !== "not_sent") {
      throw new KnowledgeBaseUpstreamCreateError(
        "unknown",
        "UPSTREAM_CREATE_ATTEMPT_ALREADY_CONSUMED",
        undefined,
        "TRANSPORT_UNKNOWN",
        undefined,
        knowledgeBaseClaimTraceId(input.claim),
      );
    }
    const dispatch = await input.ensureDispatch();
    const created = await input.createTask(
      dispatch,
      input.claim.upstreamIdempotencyKey,
    );
    taskId = created.taskId;
    taskData = created.taskData;
    await input.bindTask(taskId);
    rebound = true;
  }
  // This intentionally runs for both newly-bound and already-bound turns. A
  // crash between bind and ownership registration is repaired here without a
  // second upstream create.
  await input.registerTask(taskId);
  await input.afterTaskAcknowledged?.(taskId);
  const reconciled = await input.reconcileTask(taskId, taskData);
  return { taskId, rebound, reconciled };
}

async function promoteManualKnowledgeBaseLogoAfterTaskAcknowledged(
  claim: KnowledgeBaseRecoveryClaim,
) {
  if (claim.recoveryMetadata.manualLogoSubmission !== true) return;
  if (recoveryOfficialLogoUpload(claim.recoveryMetadata)) return;
  const pending = recoveryPendingOfficialLogoUpload(claim.recoveryMetadata);
  if (!pending || !claim.turn.expectedLeafId) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      "企业官方主 Logo 的受管上传记录不完整，请重新上传",
    );
  }
  const verified = await bindKnowledgeBaseOfficialLogoUpload({
    userId: claim.turn.userId,
    buildId: claim.turn.buildId,
    generation: claim.turn.buildGeneration,
    turnId: claim.turn.id,
    operationKey: claim.turn.operationKey,
    expectedRevision: claim.turn.expectedRevision,
    expectedLeafId: claim.turn.expectedLeafId,
    upload: pending,
    allowFirstLeafReplacement: true,
  });
  claim.recoveryMetadata = {
    ...claim.recoveryMetadata,
    officialLogoUpload: verified,
  };
  logKnowledgeBaseOperationTelemetry({
    event: "logo_upload_candidate_promoted",
    buildId: claim.turn.buildId,
    turnId: claim.turn.id,
    reasonCode: "upstream_task_acknowledged",
  });
}

async function dispatchKnowledgeBaseRecoveryClaim(
  claim: KnowledgeBaseRecoveryClaim,
  credential: RecoveryCredential,
) {
  beginKnowledgeBaseClaimReadinessTiming(claim);
  return recoverKnowledgeBaseTurnClaimTask({
    claim,
    ensureDispatch: () =>
      ensureKnowledgeBaseRecoveryDispatch({ claim, credential }),
    createTask: async (prepared, idempotencyKey) => {
      // Final, zero-wait barrier: the exact frozen names and ids must still be
      // task-usable immediately before consuming the one create permission.
      await checkKnowledgeBasePreparedAttachments({
        claim,
        credential,
        dispatch: prepared,
      });
      await markKnowledgeBaseTurnDispatching({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        leaseMs: 300_000,
      });
      claim.turn.createAttemptState = "sending";
      const created = await createFrontMindTask({
        baseUrl: prepared.baseUrl,
        apiKey: credential.apiKey,
        requestBody: prepared.requestBody,
        idempotencyKey,
        traceId: knowledgeBaseClaimTraceId(claim),
      });
      logKnowledgeBaseTaskCreateDiagnostic({
        claim,
        dispatch: prepared,
        result: created,
      });
      if (!created.ok) {
        const createError = knowledgeBaseUpstreamCreateError(created);
        if (created.failureClass === "deterministic") {
          claim.turn.createAttemptState = "rejected";
        } else {
          claim.turn.createAttemptState = "unknown";
        }
        throw createError;
      }
      return {
        taskId: String(created.task.id),
        taskData: created.task as unknown as Record<string, unknown>,
      };
    },
    bindTask: async (taskId) => {
      await bindKnowledgeBaseTurnUpstreamTask({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        upstreamTaskId: taskId,
      });
      claim.turn.createAttemptState = "acknowledged";
      claim.turn.upstreamTaskId = taskId;
    },
    registerTask: async (taskId) => {
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "task",
        upstreamId: taskId,
      });
    },
    // Manual Logo bytes become the build Logo only after the provider returned
    // and the exact upstream task id is durably bound to this turn.
    afterTaskAcknowledged: () =>
      promoteManualKnowledgeBaseLogoAfterTaskAcknowledged(claim),
    reconcileTask: (taskId, taskData) =>
      reconcileRecoveredKnowledgeBaseTask({
        claim,
        credential,
        taskId,
        taskData,
      }),
  });
}

async function withKnowledgeBaseRecoveryLeaseHeartbeat<T>(input: {
  claim: KnowledgeBaseRecoveryClaim;
  operation: () => Promise<T>;
}) {
  const leaseMs = 300_000;
  let renewal: Promise<void> = Promise.resolve();
  let leaseError: unknown;
  const renew = () => {
    renewal = renewal.then(async () => {
      if (leaseError) return;
      try {
        await renewKnowledgeBaseTurnLease({
          userId: input.claim.turn.userId,
          turnId: input.claim.turn.id,
          leaseToken: input.claim.leaseToken,
          leaseMs,
        });
      } catch (error) {
        leaseError = error;
      }
    });
  };
  const timer = setInterval(renew, 60_000);
  timer.unref();
  try {
    const result = await input.operation();
    await renewal;
    if (leaseError) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base recovery lease was lost",
      );
    }
    return result;
  } finally {
    clearInterval(timer);
    await renewal.catch(() => undefined);
  }
}

export async function recoverExpiredKnowledgeBaseTurns(options?: {
  limit?: number;
  concurrency?: number;
  includeClaimedTurnIds?: boolean;
}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(options?.limit ?? 50)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const candidates = await findRecoverableKnowledgeBaseTurnIds({ limit });
  const result = {
    scanned: candidates.length,
    claimed: 0,
    claimedTurnIds: [] as string[],
    rebound: 0,
    reconciled: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      let claim: KnowledgeBaseRecoveryClaim | null = null;
      let recoveryApiKey: string | undefined;
      try {
        claim = await claimKnowledgeBaseTurnForRecovery({
          turnId: candidate.turnId,
          leaseMs: 300_000,
        });
        if (!claim) {
          result.skipped += 1;
          continue;
        }
        const ownedClaim = claim;
        result.claimed += 1;
        if (options?.includeClaimedTurnIds) {
          result.claimedTurnIds.push(ownedClaim.turn.id);
        }
        await assertKnowledgeBaseWritable(ownedClaim.turn.userId);
        if (!ownedClaim.turn.apiCredentialId) {
          throw new Error("Turn reservation has no credential binding");
        }
        const credential =
          await getDecryptedCredentialForKnowledgeBaseReservation({
            userId: ownedClaim.turn.userId,
            turnId: ownedClaim.turn.id,
            buildId: ownedClaim.turn.buildId!,
            buildGeneration: ownedClaim.turn.buildGeneration!,
            apiCredentialId: ownedClaim.turn.apiCredentialId,
          });
        if (!credential) {
          throw new Error("Reserved credential version is unavailable");
        }
        recoveryApiKey = credential.apiKey;
        const recovered = await withKnowledgeBaseRecoveryLeaseHeartbeat({
          claim: ownedClaim,
          operation: () =>
            dispatchKnowledgeBaseRecoveryClaim(ownedClaim, credential),
        });
        if (recovered.rebound) result.rebound += 1;
        if (recovered.reconciled) result.reconciled += 1;
      } catch (error) {
        result.failed += 1;
        let manualLogoFailureSettled = false;
        let failureToPersist = error;
        if (claim) {
          const terminalLogoFailure =
            claim.recoveryMetadata.manualLogoSubmission === true
              ? knowledgeBaseManualLogoTerminalFailure(error)
              : null;
          if (terminalLogoFailure) {
            try {
              await rejectAcknowledgedKnowledgeBaseManualLogoTurn({
                userId: claim.turn.userId,
                buildId: claim.turn.buildId,
                buildGeneration: claim.turn.buildGeneration,
                turnId: claim.turn.id,
                clientRequestId: claim.turn.clientRequestId,
                leaseToken: claim.leaseToken,
                code: terminalLogoFailure.code,
                message: terminalLogoFailure.message,
              });
              manualLogoFailureSettled = true;
            } catch (persistenceError) {
              // The child task may already exist. Never fall through to the
              // generic invalid-upload cancellation, which only accepts an
              // unbound turn and would leave this recovery poisoned forever.
              manualLogoFailureSettled = true;
              await markKnowledgeBaseTurnOutcomeUnknown({
                userId: claim.turn.userId,
                turnId: claim.turn.id,
                leaseToken: claim.leaseToken,
                code: "MANUAL_LOGO_REJECTION_DEFERRED",
                recoveryDelayMs: 1_000,
              }).catch(() => undefined);
              logKnowledgeBaseRuntimeFailure({
                level: "warn",
                event:
                  "[KnowledgeBaseTurnRecovery] manual_logo_rejection_persistence_deferred",
                userId: claim.turn.userId,
                buildId: claim.turn.buildId,
                turnId: claim.turn.id,
                error: persistenceError,
                additionalSecrets: [recoveryApiKey],
              });
            }
          } else if (claim.recoveryMetadata.manualLogoSubmission === true) {
            const deterministicCreateStatus =
              knowledgeBaseManualLogoDeterministicCreateFailureStatus(error);
            if (
              deterministicCreateStatus &&
              error instanceof KnowledgeBaseUpstreamCreateError
            ) {
              try {
                await rejectUnacknowledgedKnowledgeBaseManualLogoTurn({
                  userId: claim.turn.userId,
                  buildId: claim.turn.buildId,
                  buildGeneration: claim.turn.buildGeneration,
                  turnId: claim.turn.id,
                  clientRequestId: claim.turn.clientRequestId,
                  leaseToken: claim.leaseToken,
                  code: error.failureCode,
                  message:
                    deterministicKnowledgeBaseCreateFailureMessage(error),
                });
                manualLogoFailureSettled = true;
              } catch (persistenceError) {
                manualLogoFailureSettled = true;
                await markKnowledgeBaseTurnOutcomeUnknown({
                  userId: claim.turn.userId,
                  turnId: claim.turn.id,
                  leaseToken: claim.leaseToken,
                  code: "MANUAL_LOGO_REJECTION_DEFERRED",
                  recoveryDelayMs: 1_000,
                }).catch(() => undefined);
                logKnowledgeBaseRuntimeFailure({
                  level: "warn",
                  event:
                    "[KnowledgeBaseTurnRecovery] manual_logo_create_rejection_persistence_deferred",
                  userId: claim.turn.userId,
                  buildId: claim.turn.buildId,
                  turnId: claim.turn.id,
                  error: persistenceError,
                  additionalSecrets: [recoveryApiKey],
                });
              }
            } else {
              failureToPersist =
                knowledgeBaseManualLogoCreateFailureForPersistence(error);
            }
          }
          if (!manualLogoFailureSettled) {
            await persistKnowledgeBaseCreateFailure({
              userId: claim.turn.userId,
              turnId: claim.turn.id,
              leaseToken: claim.leaseToken,
              error: failureToPersist,
              outcomeUnknownCode: "RECOVERY_DEFERRED",
            }).catch(() => undefined);
          }
        }
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: "[KnowledgeBaseTurnRecovery] deferred",
          turnId: candidate.turnId,
          buildId: candidate.buildId,
          error,
          additionalSecrets: [recoveryApiKey],
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );
  return result;
}

type DurableKnowledgeBaseGeneratedAttachment = {
  userId: number;
  turnId: string;
  leaseToken: string;
  attachmentIndex: number;
  role: "skill" | "prefill" | "instructions" | "finalization";
};

export function knowledgeBaseGeneratedAttachmentFailureForPersistence(
  error: unknown,
) {
  if (
    error instanceof UpstreamTaskAttachmentPendingError ||
    (error instanceof UpstreamFileReadinessError && error.retryable) ||
    (error instanceof UpstreamTaskAttachmentContentProofError &&
      error.retryable)
  ) {
    return new KnowledgeBaseAttachmentsProcessingError(0, 1, 5_000, undefined, {
      cause: error,
    });
  }
  if (
    error instanceof UpstreamFileReadinessError ||
    error instanceof UpstreamTaskAttachmentContentProofError
  ) {
    return new KnowledgeBaseLocalPreparationError(
      "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
      "系统生成附件无法通过上游内容完整性校验，请联系支持处理",
      { cause: error },
    );
  }
  return error;
}

async function uploadDurableKnowledgeBaseGeneratedAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  reusableUpstreamFileId?: string | null;
  durable: DurableKnowledgeBaseGeneratedAttachment;
}) {
  const mimeType = input.mimeType || "application/zip";
  const reservation = await reserveKnowledgeBaseGeneratedAttachment({
    userId: input.durable.userId,
    turnId: input.durable.turnId,
    leaseToken: input.durable.leaseToken,
    role: input.durable.role,
    attachmentIndex: input.durable.attachmentIndex,
    filename: input.filename,
    mimeType,
    sizeBytes: input.bytes.length,
    contentSha256: createHash("sha256").update(input.bytes).digest("hex"),
  });
  const reusableUpstreamFileId = String(
    input.reusableUpstreamFileId || "",
  ).trim();
  if (
    reusableUpstreamFileId &&
    (!reservation.upstreamFileId ||
      reservation.upstreamFileId === reusableUpstreamFileId)
  ) {
    if (!reservation.upstreamFileId) {
      await completeKnowledgeBaseGeneratedAttachment({
        userId: input.durable.userId,
        turnId: input.durable.turnId,
        leaseToken: input.durable.leaseToken,
        role: input.durable.role,
        attachmentIndex: input.durable.attachmentIndex,
        requestHash: reservation.requestHash,
        upstreamFileId: reusableUpstreamFileId,
      });
    }
    await waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      attachments: [
        { file_id: reusableUpstreamFileId, filename: input.filename },
      ],
      attachmentKind: "generated",
      filenamePolicy: "exact",
    });
    return {
      attachment: {
        file_id: reusableUpstreamFileId,
        filename: input.filename,
      },
      fileId: reusableUpstreamFileId,
      // The file belongs to an already completed turn and may be shared by
      // later turns in this build. A failed continuation must never delete it.
      removeOrphan: async () => undefined,
    };
  }
  try {
    return await uploadUpstreamTaskAttachment({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      filename: input.filename,
      bytes: input.bytes,
      mimeType,
      idempotencyKey: reservation.idempotencyKey,
      readinessDeadlineMs: KNOWLEDGE_BASE_READINESS_WAIT_MS,
      ...(reservation.upstreamFileId
        ? { existingFileId: reservation.upstreamFileId }
        : {}),
      onFileResolved: async (upstreamFileId) => {
        await completeKnowledgeBaseGeneratedAttachment({
          userId: input.durable.userId,
          turnId: input.durable.turnId,
          leaseToken: input.durable.leaseToken,
          role: input.durable.role,
          attachmentIndex: input.durable.attachmentIndex,
          requestHash: reservation.requestHash,
          upstreamFileId,
        });
      },
    });
  } catch (error) {
    throw knowledgeBaseGeneratedAttachmentFailureForPersistence(error);
  }
}

export async function uploadKnowledgeBaseSkillArchive({
  baseUrl,
  apiKey,
  skillVersion = "4",
  skillContentHash,
  reusableUpstreamFileId,
  durable,
}: {
  baseUrl: string;
  apiKey: string;
  skillVersion?: string;
  skillContentHash?: string | null;
  reusableUpstreamFileId?: string | null;
  durable?: Omit<DurableKnowledgeBaseGeneratedAttachment, "role">;
}) {
  const archive = await readKnowledgeBaseSkillArchiveAttachment({
    version: skillVersion,
    contentHash: skillContentHash,
  });
  const uploaded = durable
    ? await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
        reusableUpstreamFileId,
        durable: { ...durable, role: "skill" },
      })
    : await uploadUpstreamTaskAttachment({
        baseUrl,
        apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
      });
  return { ...uploaded, contentHash: archive.contentHash };
}

export async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  attachments,
  taskId: existingTaskId,
  idempotencyKey,
  requestBody,
  traceId,
}: {
  baseUrl: string;
  apiKey: string;
  prompt?: string;
  attachments?: Array<{ file_id: string; filename: string }>;
  taskId?: string;
  idempotencyKey?: string;
  /** Exact credential-free body persisted before the first POST. */
  requestBody?: KnowledgeBasePreparedDispatch["requestBody"];
  traceId?: string;
}) {
  const body =
    requestBody ||
    ({
      prompt: String(prompt || ""),
      agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
      attachments: attachments || [],
    } satisfies KnowledgeBasePreparedDispatch["requestBody"]);
  void existingTaskId;
  assertUpstreamPromptBudget(body.prompt);
  // Kept as an accepted argument for old callers and frozen operations only.
  // Manus v1 does not document Idempotency-Key for task.create, so it must not
  // be sent or used as permission to repeat a POST.
  void idempotencyKey;
  let taskResponse;
  try {
    taskResponse = await axios.post(`${baseUrl}/v1/tasks`, body, {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
      },
      timeout: KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch {
    return {
      ok: false as const,
      status: 503,
      detail: "Upstream task creation result is unknown",
      failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
        transportError: true,
      }),
      failureCode: "UPSTREAM_CREATE_TRANSPORT_UNKNOWN" as const,
      reasonCategory: "TRANSPORT_UNKNOWN" as const,
      traceId,
    };
  }

  const rawProviderRequestRef =
    taskResponse.headers?.["x-request-id"] ??
    taskResponse.headers?.["request-id"] ??
    taskResponse.headers?.["x-amzn-requestid"] ??
    taskResponse.data?.request_id ??
    taskResponse.data?.error?.request_id;
  const normalizedProviderRequestRef = String(rawProviderRequestRef || "")
    .trim()
    .slice(0, 512);
  const providerRequestRef = normalizedProviderRequestRef
    ? `sha256:${createHash("sha256")
        .update(normalizedProviderRequestRef)
        .digest("hex")
        .slice(0, 24)}`
    : undefined;

  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const upstreamErrorCode =
      taskResponse.data?.error?.code || taskResponse.data?.code;
    const providerCodeCandidate = knowledgeBaseUpstreamString(
      upstreamErrorCode,
      7,
    );
    const safeNumericProviderCode =
      providerCodeCandidate && /^[0-9]{1,6}$/u.test(providerCodeCandidate)
        ? providerCodeCandidate
        : undefined;
    const providerText = String(
      taskResponse.data?.error?.message || taskResponse.data?.message || "",
    ).toUpperCase();
    const providerCode = String(upstreamErrorCode || "").toUpperCase();
    const reasonCategory: KnowledgeBaseProviderReasonCategory =
      taskResponse.status === 401 || taskResponse.status === 403
        ? "CREDENTIAL_REJECTED"
        : taskResponse.status === 402 ||
            /(?:QUOTA|CREDIT|BALANCE)/u.test(providerCode + providerText)
          ? "QUOTA_REJECTED"
          : /(?:ATTACHMENT|FILE)/u.test(providerCode + providerText)
            ? "ATTACHMENT_INVALID"
            : /(?:PROFILE|AGENT_PROFILE)/u.test(providerCode + providerText)
              ? "PROFILE_INVALID"
              : taskResponse.status === 400 || taskResponse.status === 422
                ? providerCode === "3" ||
                  /(?:INVALID_ARGUMENT)/u.test(providerCode + providerText)
                  ? "UNKNOWN_INVALID_ARGUMENT"
                  : "PAYLOAD_INVALID"
                : taskResponse.status >= 500
                  ? "UPSTREAM_UNAVAILABLE"
                  : "UNKNOWN_PROVIDER_REJECTION";
    return {
      ok: false as const,
      status: taskResponse.status,
      detail: "Upstream task creation was rejected",
      failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
        status: taskResponse.status,
        code: upstreamErrorCode,
      }),
      failureCode: safeNumericProviderCode
        ? `UPSTREAM_CREATE_${safeNumericProviderCode}`
        : `UPSTREAM_CREATE_HTTP_${taskResponse.status}`,
      reasonCategory,
      providerRequestRef,
      traceId,
    };
  }

  let taskData: Record<string, unknown>;
  let taskId: string | null;
  try {
    taskData = canonicalKnowledgeBaseUpstreamTask(taskResponse.data);
    taskId = upstreamTaskId(taskData, false);
  } catch {
    taskData = {};
    taskId = null;
  }
  if (!taskId) {
    return {
      ok: false as const,
      status: 502,
      detail: "Upstream task creation result is missing its task id",
      failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
        missingTaskId: true,
      }),
      failureCode: "UPSTREAM_TASK_ID_MISSING" as const,
      reasonCategory: "TASK_ID_MISSING" as const,
      providerRequestRef,
      traceId,
    };
  }

  const taskMetadata = knowledgeBaseUpstreamRecord(taskData.metadata) || {};
  const rawStatus = knowledgeBaseUpstreamString(taskData.status, 64);
  return {
    ok: true as const,
    status: taskResponse.status,
    task: {
      id: taskId,
      status: rawStatus === "failed" ? "error" : rawStatus || "running",
      taskUrl: knowledgeBaseUpstreamString(
        taskData.task_url ?? taskMetadata.task_url,
        2_048,
      ),
      title: knowledgeBaseUpstreamString(
        taskData.task_title ?? taskMetadata.task_title,
        255,
      ),
      output: normalizeRecoveredTaskOutput(taskData),
    },
    providerRequestRef,
    traceId,
  };
}

function logKnowledgeBaseTaskCreateDiagnostic(input: {
  claim: KnowledgeBaseRecoveryClaim;
  dispatch: KnowledgeBasePreparedDispatch;
  result: Awaited<ReturnType<typeof createFrontMindTask>>;
}) {
  const safeIdentifier = (value: unknown) => {
    const normalized = String(value || "");
    return normalized.length <= 255 && /^[A-Za-z0-9._:-]+$/u.test(normalized)
      ? normalized
      : undefined;
  };
  const traceId = safeIdentifier(knowledgeBaseClaimTraceId(input.claim));
  const reasonCategory = safeIdentifier(
    input.result.ok ? "ACKNOWLEDGED" : input.result.reasonCategory,
  );
  const failureCode = input.result.ok
    ? undefined
    : safeIdentifier(input.result.failureCode);
  const providerRequestRef = safeIdentifier(input.result.providerRequestRef);
  console[input.result.ok ? "info" : "warn"](
    "[KnowledgeBaseTaskCreate] result",
    JSON.stringify({
      buildId: safeIdentifier(input.claim.turn.buildId),
      turnId: safeIdentifier(input.claim.turn.id),
      ...(traceId ? { traceId } : {}),
      schemaVersion: input.dispatch.schemaVersion,
      bodySha256: input.dispatch.bodySha256,
      attachmentCount: input.dispatch.requestBody.attachments.length,
      readyCount: input.dispatch.requestBody.attachments.length,
      pendingCount: 0,
      errorCount: 0,
      maxReadinessDelayMs: knowledgeBaseClaimReadinessDelayMs(input.claim),
      status: input.result.status,
      ...(reasonCategory ? { reasonCategory } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(providerRequestRef ? { providerRequestRef } : {}),
    }),
  );
}

function knowledgeBaseUpstreamCreateError(
  failure: Extract<
    Awaited<ReturnType<typeof createFrontMindTask>>,
    { ok: false }
  >,
) {
  return new KnowledgeBaseUpstreamCreateError(
    failure.failureClass,
    failure.failureCode,
    failure.status,
    failure.reasonCategory,
    failure.providerRequestRef,
    failure.traceId,
  );
}

function deterministicKnowledgeBaseCreateFailureMessage(
  error: KnowledgeBaseUpstreamCreateError,
) {
  if (error.failureCode === "UPSTREAM_TASK_ID_MISSING") {
    return "上游任务编号暂不可读，系统正在使用同一请求标识核对本轮结果";
  }
  if (error.status === 401 || error.status === 403) {
    return "上游已明确拒绝使用当前 API 凭证创建任务；本轮不会再次提交，请更新凭证后新建知识库构建";
  }
  if (error.status === 413) {
    return "上游已明确拒绝本轮附件合同；本轮不会再次提交，请调整资料后新建知识库构建";
  }
  return "上游已明确拒绝创建本轮任务，当前内容和附件均已保留；本轮不会再次提交，请新建知识库构建";
}

function knowledgeBaseCreateUserRecoveryAction() {
  // A deterministic provider rejection has already consumed the one allowed
  // Task Create attempt. Same-turn actions are reserved for failures that
  // occurred while createAttemptState was still exactly `not_sent`.
  return "contact_support" as const;
}

export async function persistKnowledgeBaseCreateFailure(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    error: unknown;
    outcomeUnknownCode: string;
    recoveryDelayMs?: number;
    traceId?: string;
  },
  dependencies: {
    cancelUnprepared?: typeof cancelUnpreparedKnowledgeBaseTurn;
    failDeterministically?: typeof failKnowledgeBaseTurnDeterministically;
    markOutcomeUnknown?: typeof markKnowledgeBaseTurnOutcomeUnknown;
    deferBeforeCreate?: typeof deferKnowledgeBaseTurnBeforeCreate;
  } = {},
) {
  const cancelUnprepared =
    dependencies.cancelUnprepared ?? cancelUnpreparedKnowledgeBaseTurn;
  const failDeterministically =
    dependencies.failDeterministically ??
    failKnowledgeBaseTurnDeterministically;
  const markOutcomeUnknown =
    dependencies.markOutcomeUnknown ?? markKnowledgeBaseTurnOutcomeUnknown;
  const deferBeforeCreate =
    dependencies.deferBeforeCreate ?? deferKnowledgeBaseTurnBeforeCreate;
  if (input.error instanceof KnowledgeBaseAttachmentsProcessingError) {
    await deferBeforeCreate({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: input.error.code,
      recoveryDelayMs: input.error.retryAfterMs,
      traceId: input.error.traceId || input.traceId,
    });
    return "retriable" as const;
  }
  if (input.error instanceof KnowledgeBaseLocalPreparationError) {
    if (input.error.code === "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID") {
      // Logo has its own first-node re-upload flow. Releasing this unbound
      // child is intentional so a new Logo byte identity gets a new provider
      // operation key without poisoning the parent presentation.
      await cancelUnprepared({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: `${input.error.message}。未向上游创建任务，请重新上传 Logo 原图`,
      });
    } else {
      const attachmentRepair = /(?:CLIENT|USER)_ATTACHMENT/u.test(
        input.error.code,
      );
      // All other local preparation failures retain the exact logical turn
      // and its recovery receipt. User-attachment failures enter the dedicated
      // replacement path; server-generated finalization failures remain a
      // non-regenerating support incident instead of inviting duplicate POSTs.
      await failDeterministically({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: `${input.error.message}。未向上游创建任务`,
        failureClass: attachmentRepair
          ? "requires_user_fix"
          : "terminal_nonregenerable",
        recoveryAction: attachmentRepair
          ? "fix_attachments"
          : "contact_support",
        canRegenerate: false,
      });
    }
    return "deterministic" as const;
  }
  if (input.error instanceof UpstreamPromptBudgetError) {
    await failDeterministically({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: "KNOWLEDGE_BASE_PROMPT_BUDGET_EXCEEDED",
      message:
        "知识库系统输入超过安全预算，未向上游创建任务；请联系支持处理后继续本轮",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      canRegenerate: false,
    });
    return "deterministic" as const;
  }
  if (input.error instanceof KnowledgeBaseArtifactBindingError) {
    if (input.error.code === "LOGO_UPLOAD_INVALID") {
      await cancelUnprepared({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
        message: input.error.message,
      });
      return "deterministic" as const;
    }
    await markOutcomeUnknown({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: input.error.code,
      recoveryDelayMs: input.recoveryDelayMs ?? 30_000,
    });
    return "retriable" as const;
  }
  const createError =
    input.error instanceof KnowledgeBaseUpstreamCreateError
      ? input.error
      : new KnowledgeBaseUpstreamCreateError(
          classifyKnowledgeBaseUpstreamCreateFailure({ transportError: true }),
          input.outcomeUnknownCode,
        );
  if (createError.failureClass === "deterministic") {
    await failDeterministically({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: createError.failureCode,
      message: deterministicKnowledgeBaseCreateFailureMessage(createError),
      failureClass: "terminal_nonregenerable",
      recoveryAction: knowledgeBaseCreateUserRecoveryAction(),
      canRegenerate: false,
      createAttemptRejected: true,
      reasonCategory: createError.reasonCategory,
      providerRequestRef: createError.providerRequestRef,
    });
    return "deterministic" as const;
  }
  await markOutcomeUnknown({
    userId: input.userId,
    turnId: input.turnId,
    leaseToken: input.leaseToken,
    code:
      createError.failureClass === "retriable"
        ? createError.failureCode
        : input.outcomeUnknownCode,
    traceId: createError.traceId || input.traceId,
    reasonCategory: createError.reasonCategory,
    providerRequestRef: createError.providerRequestRef,
    ...(input.recoveryDelayMs
      ? { recoveryDelayMs: input.recoveryDelayMs }
      : {}),
  });
  return createError.failureClass;
}

const KNOWLEDGE_BASE_ACCEPTED_DISPATCH_RETRY_DELAYS_MS = [
  500, 1_500, 3_000,
] as const;

function knowledgeBaseDispatchRetryable(error: unknown) {
  if (
    error instanceof KnowledgeBaseTurnReservationError ||
    error instanceof KnowledgeBaseBuildError ||
    error instanceof KnowledgeBaseArtifactBindingError
  ) {
    return false;
  }
  if (error instanceof KnowledgeBaseUpstreamCreateError) {
    // Once task.create begins, no automatic retry is safe: the provider does
    // not document Idempotency-Key for this endpoint.
    return false;
  }
  if (error instanceof KnowledgeBaseAttachmentsProcessingError) return false;
  if (axios.isAxiosError(error)) return true;
  return (
    error instanceof Error &&
    /^Task attachment (?:creation|upload|upload URL lookup) failed:/u.test(
      error.message,
    )
  );
}

/**
 * The browser request only commits the durable turn. External file/task calls
 * continue after the 202 response, with the same lease and idempotency keys.
 * Short transient failures are retried here so the normal path never depends
 * on the 30-second disaster-recovery sweep.
 */
async function dispatchAcceptedKnowledgeBaseClaim(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
}) {
  return withKnowledgeBaseRecoveryLeaseHeartbeat({
    claim: input.claim,
    operation: async () => {
      let lastError: unknown;
      for (
        let attempt = 0;
        attempt <= KNOWLEDGE_BASE_ACCEPTED_DISPATCH_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        try {
          return await dispatchKnowledgeBaseRecoveryClaim(
            input.claim,
            input.credential,
          );
        } catch (error) {
          lastError = error;
          const delayMs =
            KNOWLEDGE_BASE_ACCEPTED_DISPATCH_RETRY_DELAYS_MS[attempt];
          if (!knowledgeBaseDispatchRetryable(error) || delayMs === undefined) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      throw lastError;
    },
  });
}

function launchAcceptedKnowledgeBaseClaim(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  outcomeUnknownCode: string;
}) {
  void dispatchAcceptedKnowledgeBaseClaim(input).catch(async (error) => {
    const persisted = await persistKnowledgeBaseCreateFailure({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      error,
      outcomeUnknownCode: input.outcomeUnknownCode,
      recoveryDelayMs: 1_000,
      traceId: knowledgeBaseClaimTraceId(input.claim),
    }).catch(() => undefined);
    if (
      persisted === "retriable" &&
      error instanceof KnowledgeBaseAttachmentsProcessingError
    ) {
      console.info(
        "[KnowledgeBaseAttachmentReadiness] deferred",
        JSON.stringify({
          buildId: input.claim.turn.buildId,
          turnId: input.claim.turn.id,
          ...(knowledgeBaseClaimTraceId(input.claim)
            ? { traceId: knowledgeBaseClaimTraceId(input.claim) }
            : {}),
          readyCount: error.readyCount,
          pendingCount: error.pendingCount,
          errorCount: 0,
          maxReadinessDelayMs: knowledgeBaseClaimReadinessDelayMs(input.claim),
          retryAfterMs: error.retryAfterMs,
          createAttemptState: "not_sent",
        }),
      );
      const timer = setTimeout(() => {
        void claimKnowledgeBaseTurnForRecovery({
          turnId: input.claim.turn.id,
          leaseMs: 300_000,
        })
          .then((claim) => {
            if (!claim) return;
            launchAcceptedKnowledgeBaseClaim({
              claim,
              credential: input.credential,
              outcomeUnknownCode: input.outcomeUnknownCode,
            });
          })
          .catch(() => undefined);
      }, error.retryAfterMs + 50);
      timer.unref();
    }
    logKnowledgeBaseRuntimeFailure({
      level: "warn",
      event: "[KnowledgeBaseAcceptedDispatch] deferred",
      userId: input.claim.turn.userId,
      buildId: input.claim.turn.buildId,
      turnId: input.claim.turn.id,
      error,
      additionalSecrets: [input.credential.apiKey],
    });
  });
}

router.post("/start", async (req, res) => {
  const body = (req.body || {}) as KnowledgeBaseStartRequest;
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const requestedCompanyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();

  if (
    !conversationId ||
    conversationId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128
  ) {
    res.status(400).json({ error: "知识库对话标识缺失或无效" });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (!req.frontmindUser || !req.frontmindCredential) {
    res.status(401).json({ error: "请先登录并配置 API Key" });
    return;
  }

  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "当前账号尚未配置可用的 API Key" });
    return;
  }
  const requestTraceId = randomUUID();

  let reservationCreated = false;
  try {
    const workspace = await getDashboardWorkspace(req.frontmindUser.id);
    const companyName = resolveKnowledgeBaseEnterpriseIdentity({
      sourceName: workspace.sourceName,
      brandName: workspace.payload.brandName,
      requestedCompanyName,
    });
    const userAttachments = normalizeKnowledgeBaseUserAttachments(
      body.attachments,
    );
    const legacyStartReceipt = await inspectKnowledgeBaseLegacyStartReplay({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      companyName,
      companyWebsite,
      operatorNotes,
      attachments: userAttachments,
    });
    if (legacyStartReceipt) {
      await respondKnowledgeBaseTurnReplayReceipt({
        userId: req.frontmindUser.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        receipt: legacyStartReceipt,
        replayHit: true,
        terminalStatus: 200,
        suppressTerminalError: true,
        resumed: true,
        res,
      });
      return;
    }
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const existingBuild = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (existingBuild?.build.status === "published") {
      res.status(409).json({
        traceId: requestTraceId,
        error: {
          code: "KNOWLEDGE_BASE_LOCKED",
          message: "知识库已发布；后续修改请提交维护需求",
          traceId: requestTraceId,
        },
        reservationCreated: false,
      });
      return;
    }
    for (const attachment of userAttachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(
          fileCredential,
          req.frontmindCredential,
        )
      ) {
        res.status(403).json({
          traceId: requestTraceId,
          error: {
            code: "KNOWLEDGE_BASE_ATTACHMENT_OWNERSHIP_MISMATCH",
            message: "上传资料与当前账号不匹配，请重新上传",
            traceId: requestTraceId,
          },
          reservationCreated: false,
        });
        return;
      }
    }
    const newBuildPolicy = knowledgeBaseNewBuildPolicyBinding();
    const [prefillKnowledgeSnapshot, latestSkillDescriptor] = await Promise.all(
      [
        getLatestKnowledgeSnapshot(req.frontmindUser.id),
        getKnowledgeBaseSkillDescriptor({
          version: newBuildPolicy.skillVersion,
          contentHash: newBuildPolicy.skillContentHash,
        }),
      ],
    );
    const startReservation = await reserveKnowledgeBaseStartBuild({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      companyName,
      companyWebsite,
      skillName: latestSkillDescriptor.name,
      skillVersion: latestSkillDescriptor.version,
      skillContentHash: latestSkillDescriptor.contentHash,
      treePolicyVersion: newBuildPolicy.treePolicyVersion,
      requestPayload: {
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
      },
      apiCredentialId: req.frontmindCredential.id,
      userText: "开始构建企业知识库",
      userAttachmentCount: userAttachments.length,
      expectedAttachmentCount:
        2 + userAttachments.length + (prefillKnowledgeSnapshot ? 1 : 0),
      recoveryMetadata: {
        traceId: requestTraceId,
        kind: "start",
        conversationId,
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        includePrefill: Boolean(prefillKnowledgeSnapshot),
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
        instructionsAttachmentRequired: true,
      },
    });
    reservationCreated = true;
    const { build, reservation } = startReservation;
    // The build and first turn commit together; legacy builds keep their pinned Skill contract.
    const skillDescriptor = {
      name: build.skillName,
      version: build.skillVersion,
      contentHash: build.skillContentHash,
    };
    let progress = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (!progress) throw new Error("知识库构建 reservation 创建失败");
    if (reservation.state !== "acquired") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus:
          reservation.state === "completed" ? "completed" : "running",
      });
      res
        .status(reservation.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(reservation) / 1_000)),
        )
        .json({
          traceId: reservation.turn.traceId || requestTraceId,
          reservation: knowledgeBaseReservationReceipt(
            reservation,
            observation?.stateEpoch,
          ),
          ...(observation?.authoritativeTaskId
            ? {
                task: {
                  id: observation.authoritativeTaskId,
                  status:
                    reservation.state === "completed" ? "completed" : "running",
                },
              }
            : {}),
          progress: observation?.interaction.progress || progress,
          interaction:
            observation?.interaction ||
            deriveKnowledgeBaseInteraction(progress, "running"),
          observation,
          idempotent: true,
          resumed: true,
          startedAt: reservation.turn.startedAt?.getTime() || Date.now(),
        });
      return;
    }
    {
      const acceptedStartClaim: KnowledgeBaseRecoveryClaim = {
        turn: reservation.turn,
        leaseToken: reservation.leaseToken,
        leaseExpiresAt: reservation.leaseExpiresAt,
        upstreamIdempotencyKey: reservation.upstreamIdempotencyKey,
        recoveryMetadata:
          reservation.recoveryMetadata ||
          ({
            traceId: requestTraceId,
            kind: "start",
            conversationId,
            companyName: build.companyName,
            companyWebsite: build.companyWebsite || "",
            operatorNotes,
            attachments: userAttachments,
            skillVersion: build.skillVersion,
            skillContentHash: build.skillContentHash,
            includePrefill: Boolean(prefillKnowledgeSnapshot),
            prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
            instructionsAttachmentRequired: true,
          } satisfies Record<string, unknown>),
        preparedDispatch: null,
      };
      const acceptedObservation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(202).json({
        traceId: acceptedStartClaim.turn.traceId || requestTraceId,
        visibleMessage: "开始构建企业知识库",
        reservation: knowledgeBaseAcceptedReservationReceipt({
          turn: acceptedStartClaim.turn,
          stateEpoch: acceptedObservation?.stateEpoch,
        }),
        observation: acceptedObservation,
        progress: acceptedObservation?.interaction.progress || progress || null,
        interaction:
          acceptedObservation?.interaction ||
          deriveKnowledgeBaseInteraction(progress, "running"),
        accepted: true,
        reservationCreated: true,
        startedAt: reservation.turn.createdAt.getTime(),
      });
      launchAcceptedKnowledgeBaseClaim({
        claim: acceptedStartClaim,
        credential: req.frontmindCredential,
        outcomeUnknownCode: "START_DISPATCH_OUTCOME_UNKNOWN",
      });
      return;
    }
  } catch (error: any) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const status =
        error.code === "BUILD_NOT_FOUND"
          ? 404
          : error.code === "INVALID_REQUEST"
            ? 400
            : 409;
      const observation =
        status === 409 && req.frontmindUser
          ? await getKnowledgeBaseObservation({
              userId: req.frontmindUser.id,
              conversationId,
              upstreamStatus: "running",
            }).catch(() => null)
          : null;
      res.status(status).json({
        traceId: requestTraceId,
        error: { code: error.code, message: error.message },
        reservationCreated: false,
        ...(observation
          ? {
              observation,
              progress: observation.interaction.progress,
              interaction: observation.interaction,
            }
          : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseEnterpriseIdentityError) {
      res.status(error.code === "ENTERPRISE_NOT_CONFIGURED" ? 422 : 409).json({
        traceId: requestTraceId,
        error: error.message,
        code: error.code,
        reservationCreated,
      });
      return;
    }
    if (error instanceof KnowledgeBaseBuildError) {
      res.status(422).json({
        traceId: requestTraceId,
        error: {
          code: error.code,
          message: error.message,
          traceId: requestTraceId,
        },
        reservationCreated,
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseStart] failed",
      error,
      additionalSecrets: [apiKey, req.frontmindCredential?.apiKey],
    });
    res.status(503).json({
      traceId: requestTraceId,
      error: {
        code: "KNOWLEDGE_BASE_START_FAILED",
        message: "启动企业知识库任务失败，请稍后重试",
        traceId: requestTraceId,
      },
      reservationCreated,
    });
  }
});

router.post("/turn/reserve", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    userMessage?: string;
    attachmentManifest?: unknown;
    resumeExisting?: boolean;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string;
    expectedPresentationKey?: string;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  const expectedPresentationKey =
    body.expectedPresentationKey === undefined
      ? undefined
      : String(body.expectedPresentationKey || "").trim();
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    Number(expectedGeneration) < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 0 ||
    !expectedLeafId ||
    (expectedPresentationKey !== undefined &&
      (!expectedPresentationKey || expectedPresentationKey.length > 191)) ||
    (body.resumeExisting === true && Boolean(userMessage.trim()))
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN_RESERVATION",
        message: "当前知识节点或附件预约参数无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    const clientIntent = {
      schemaVersion: 1,
      flow: "deferred",
      conversationId,
      userMessage,
      attachmentManifest,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedLeafId,
      expectedPresentationKey: expectedPresentationKey ?? null,
    };
    const action = classifyKnowledgeBaseUserAction(
      userMessage,
      attachmentManifest.length,
    );
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () =>
          body.resumeExisting === true
            ? inspectKnowledgeBaseLegacyDeferredReservationReplay({
                userId: req.frontmindUser!.id,
                conversationId,
                clientRequestId,
                clientAttachmentManifest: attachmentManifest,
                operationType: action === "initial" ? "revise" : action,
                expectedGeneration: Number(expectedGeneration),
                expectedRevision: Number(expectedRevision),
                expectedLeafId,
                expectedPresentationKey,
              })
            : inspectKnowledgeBaseTurnReplay({
                userId: req.frontmindUser!.id,
                conversationId,
                clientRequestId,
                clientIntent,
                expectedGeneration: Number(expectedGeneration),
                expectedRevision: Number(expectedRevision),
                expectedLeafId,
              }),
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const authority = await loadKnowledgeBaseTurnAuthority({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (!authority) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    const { build: boundBuild, taskId: parentTaskId } = authority;
    assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
      boundBuild,
      attachmentManifest,
    );
    await assertKnowledgeBaseCustomerUploadCapacity({
      userId: req.frontmindUser.id,
      buildId: boundBuild.id,
      generation: boundBuild.generation,
      officialLogoSha256: boundBuild.logoSha256,
      officialLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(boundBuild),
      attachmentManifest,
    });
    if (
      knowledgeBaseBuildRequiresOfficialLogo(boundBuild) &&
      (attachmentManifest.length !== 1 ||
        ![
          "image/avif",
          "image/gif",
          "image/jpeg",
          "image/png",
          "image/webp",
        ].includes(attachmentManifest[0]!.mimeType))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "当前知识库正在等待企业主 Logo。请只上传一张 PNG、JPEG、WebP、AVIF 或 GIF 原图",
      );
    }
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "task",
      parentTaskId,
    );
    if (!taskCredential) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const finalPackageRequired = knowledgeBaseTurnRequiresFinalPackage({
      skillVersion: boundBuild.skillVersion,
      currentLeafId: boundBuild.currentLeafId,
      totalNodeCount: boundBuild.totalNodeCount,
      confirmedCount: boundBuild.confirmedCount,
      directPrefilledCount: boundBuild.directPrefilledCount,
      action,
    });
    if (finalPackageRequired) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser.id,
        boundBuild,
      );
    }
    const skillDescriptor = finalPackageRequired
      ? await getKnowledgeBaseSkillDescriptor(
          knowledgeBasePinnedV4SkillSelection({
            skillVersion: boundBuild.skillVersion,
            skillContentHash: boundBuild.skillContentHash,
          }),
        )
      : {
          version: boundBuild.skillVersion,
          contentHash: boundBuild.skillContentHash,
        };
    const skillVersion = skillDescriptor.version;
    const skillContentHash = skillDescriptor.contentHash;
    const reservation = await reserveKnowledgeBaseTurn({
      userId: req.frontmindUser.id,
      buildId: boundBuild.id,
      clientRequestId,
      operationType: action === "initial" ? "revise" : action,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedLeafId,
      expectedPresentationKey,
      requestPayload: {
        userMessage,
        attachmentManifest,
        expectedPresentationKey: expectedPresentationKey ?? null,
        skillVersion,
        skillContentHash,
      },
      clientIntent: body.resumeExisting === true ? undefined : clientIntent,
      apiCredentialId: taskCredential.id,
      userText: userMessage,
      userAttachmentCount: attachmentManifest.length,
      expectedAttachmentCount: attachmentManifest.length + 2,
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: attachmentManifest,
      resumeDeferredReservation: body.resumeExisting === true,
      recoveryMetadata: {
        kind: "turn",
        conversationId,
        parentTaskId,
        userMessage,
        attachments: [],
        attachmentManifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        skillVersion,
        skillContentHash,
        ...(finalPackageRequired
          ? { finalPackageRequired: true }
          : { instructionsAttachmentRequired: true }),
      },
    });
    if (reservation.state === "acquired") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Deferred attachment reservation unexpectedly acquired a worker lease",
      );
    }
    await respondKnowledgeBaseTurnReplayReceipt({
      userId: req.frontmindUser.id,
      conversationId,
      requestedClientRequestId: clientRequestId,
      receipt: reservation,
      res,
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_RESERVATION_FAILED",
        message: "当前知识节点预约遇到服务端并发冲突，系统将继续恢复本轮",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn/attachments/stage", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    attachmentManifest?: unknown;
    index?: number;
    attachment?: KnowledgeBaseAttachment;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  if (
    !conversationId ||
    !turnId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(body.index) ||
    Number(body.index) < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_ATTACHMENT_STAGE",
        message: "附件提交参数无效，请重新提交本轮",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  let dispatchClaimAcquiredByThisRequest = false;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const manifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    const index = Number(body.index);
    const attachment = normalizeKnowledgeBaseUserAttachments(
      body.attachment ? [body.attachment] : [],
    )[0];
    const manifestItem = manifest[index];
    if (
      !attachment ||
      !manifestItem ||
      attachment.filename !== manifestItem.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "上传文件与本轮附件清单不一致",
      );
    }
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () =>
          inspectKnowledgeBaseDeferredAttachmentReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            turnId,
            clientRequestId,
            clientAttachmentManifest: manifest,
            index,
            attachment,
          }),
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const build = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    const parentTaskId = String(build?.upstreamTaskId || "");
    if (!build || !parentTaskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    // Historical deferred reservations may predate the provenance gate. Check
    // the immutable build before staging can claim a lease or launch upstream.
    await assertKnowledgeBaseFinalLogoProvenanceForBuild(
      req.frontmindUser.id,
      build,
    );
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "task",
      parentTaskId,
    );
    const fileCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "file",
      attachment.file_id,
    );
    if (
      !taskCredential ||
      !fileCredential ||
      !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential)
    ) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "KNOWLEDGE_BASE_FILE_FORBIDDEN",
          message: "上传资料与当前知识库任务不匹配，请重新上传",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const deferredOfficialLogoRequired =
      knowledgeBaseBuildRequiresOfficialLogo(build);
    if (knowledgeBaseManifestRepeatsOfficialLogo(build, manifest)) {
      if (await replayAfterMutableFailure()) return;
      const message =
        "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId,
        clientRequestId,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        message,
      });
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        message,
      );
    }
    if (deferredOfficialLogoRequired) {
      const rejectDeferredLogo = async (message: string) => {
        if (await replayAfterMutableFailure!()) return true;
        await cancelUnpreparedKnowledgeBaseTurn({
          userId: req.frontmindUser!.id,
          turnId,
          clientRequestId,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message,
        });
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message,
        );
      };
      if (
        manifest.length !== 1 ||
        index !== 0 ||
        ![
          "image/avif",
          "image/gif",
          "image/jpeg",
          "image/png",
          "image/webp",
        ].includes(manifestItem.mimeType)
      ) {
        if (
          await rejectDeferredLogo(
            "当前知识库正在等待企业主 Logo，请只上传一张受支持的图片原文件",
          )
        )
          return;
      }
      try {
        await assertCapturedKnowledgeBaseCustomerImage({
          fileId: attachment.file_id,
          filename: manifestItem.filename,
          mimeType: manifestItem.mimeType,
          sizeBytes: manifestItem.sizeBytes,
          sourceSha256: manifestItem.sha256,
        });
      } catch {
        if (
          await rejectDeferredLogo(
            "上传文件不是可安全解码的企业主 Logo 图片，请重新选择原文件",
          )
        )
          return;
        return;
      }
    }
    // uploadFile only calls this route after the signed PUT has completed.
    // Bind that already-owned file id immediately, as the OEM client does.
    // Re-downloading the entire object here made submission time depend on
    // object-store read-after-write visibility and incorrectly rejected slow
    // or large uploads after an arbitrary verification window.
    const dispatchClaim =
      await stageAndClaimKnowledgeBaseDeferredTurnAttachment({
        userId: req.frontmindUser.id,
        buildId: build.id,
        turnId,
        clientRequestId,
        clientAttachmentManifest: manifest,
        index,
        attachment,
      });
    dispatchClaimAcquiredByThisRequest = dispatchClaim.state === "acquired";
    const turn = dispatchClaim.turn;
    if (dispatchClaim.state !== "awaiting_attachments") {
      if (dispatchClaim.state === "acquired") {
        let acceptedClaim: KnowledgeBaseRecoveryClaim = dispatchClaim;
        if (deferredOfficialLogoRequired) {
          let verifiedLogo: KnowledgeBaseOfficialLogoUpload;
          try {
            verifiedLogo = await bindKnowledgeBaseOfficialLogoUpload({
              userId: req.frontmindUser.id,
              buildId: build.id,
              generation: dispatchClaim.turn.buildGeneration,
              turnId: dispatchClaim.turn.id,
              operationKey: dispatchClaim.turn.operationKey,
              expectedRevision: dispatchClaim.turn.expectedRevision,
              expectedLeafId: dispatchClaim.turn.expectedLeafId!,
              upload: {
                index: 0,
                fileId: attachment.file_id,
                filename: manifestItem.filename,
                mimeType: manifestItem.mimeType,
                sizeBytes: manifestItem.sizeBytes,
                sourceSha256: manifestItem.sha256,
              },
            });
            logKnowledgeBaseOperationTelemetry({
              event: "logo_upload_candidate_promoted",
              buildId: build.id,
              turnId: dispatchClaim.turn.id,
            });
          } catch (error) {
            logKnowledgeBaseOperationTelemetry({
              event: "logo_upload_candidate_rejected",
              buildId: build.id,
              turnId: dispatchClaim.turn.id,
              reasonCode:
                error instanceof KnowledgeBaseArtifactBindingError
                  ? error.code
                  : "LOCAL_PREPARATION_FAILED",
            });
            const message =
              error instanceof Error
                ? error.message
                : "企业官方主 Logo 校验失败，请重新上传";
            if (error instanceof KnowledgeBaseArtifactBindingError) {
              await cancelUnpreparedKnowledgeBaseTurn({
                userId: req.frontmindUser.id,
                turnId: dispatchClaim.turn.id,
                clientRequestId,
                leaseToken: dispatchClaim.leaseToken,
                code:
                  error.code === "LOGO_UPLOAD_INVALID"
                    ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
                    : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
                message,
              });
            }
            throw new KnowledgeBaseTurnReservationError(
              error instanceof KnowledgeBaseArtifactBindingError &&
              error.code === "LOGO_UPLOAD_INVALID"
                ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
                : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
              message,
            );
          }
          acceptedClaim = {
            ...dispatchClaim,
            recoveryMetadata: {
              ...dispatchClaim.recoveryMetadata,
              officialLogoUpload: verifiedLogo,
            },
          };
        }
        const observation = await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null);
        res.status(202).json({
          reservation: knowledgeBaseAcceptedReservationReceipt({
            turn: acceptedClaim.turn,
            stateEpoch: observation?.stateEpoch,
          }),
          observation,
          accepted: true,
        });
        launchAcceptedKnowledgeBaseClaim({
          claim: acceptedClaim,
          credential: taskCredential,
          outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
        });
        return;
      }
      await respondKnowledgeBaseTurnReplayReceipt({
        userId: req.frontmindUser.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        receipt: dispatchClaim,
        res,
      });
      return;
    }
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.json({
      reservation: {
        state: "awaiting_attachments",
        turnId: turn.id,
        clientRequestId: turn.clientRequestId,
        stagedAttachmentCount: turn.stagedUserAttachmentCount,
        expectedAttachmentCount: turn.expectedUserAttachmentCount,
        requiresUpload:
          turn.stagedUserAttachmentCount < turn.expectedUserAttachmentCount,
      },
      observation,
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure && !dispatchClaimAcquiredByThisRequest) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      if (error.retryAfterMs) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
        );
      }
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_ATTACHMENT_STAGE_FAILED",
        message: "附件提交失败，请重新提交本轮",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn/dispatch", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    attachmentManifest?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  if (
    !conversationId ||
    !turnId ||
    !clientRequestId ||
    clientRequestId.length > 128
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN_DISPATCH",
        message: "附件提交参数无效，请重新提交本轮",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let acquiredClaim: KnowledgeBaseDeferredDispatchClaim | null = null;
  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () =>
          inspectKnowledgeBaseDeferredDispatchReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            turnId,
            clientRequestId,
            clientAttachmentManifest: attachmentManifest,
          }),
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const build = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    const parentTaskId = String(build?.upstreamTaskId || "");
    if (!build || !parentTaskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    // Run before claimKnowledgeBaseDeferredTurnDispatch mutates the lease. The
    // assertion is a no-op outside the final v4 coordinate.
    await assertKnowledgeBaseFinalLogoProvenanceForBuild(
      req.frontmindUser.id,
      build,
    );
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "task",
      parentTaskId,
    );
    if (!taskCredential) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    acquiredClaim = await claimKnowledgeBaseDeferredTurnDispatch({
      userId: req.frontmindUser.id,
      buildId: build.id,
      turnId,
      clientRequestId,
      clientAttachmentManifest: attachmentManifest,
    });
    if (acquiredClaim.state !== "acquired") {
      await respondKnowledgeBaseTurnReplayReceipt({
        userId: req.frontmindUser.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        receipt: acquiredClaim,
        res,
      });
      return;
    }

    const officialLogoRequired = knowledgeBaseBuildRequiresOfficialLogo(build);
    if (
      !officialLogoRequired &&
      knowledgeBaseManifestRepeatsOfficialLogo(build, attachmentManifest)
    ) {
      const message =
        "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId: acquiredClaim.turn.id,
        clientRequestId,
        leaseToken: acquiredClaim.leaseToken,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        message,
      });
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        message,
      );
    }

    let acceptedClaim: KnowledgeBaseRecoveryClaim = acquiredClaim;
    if (officialLogoRequired) {
      const stagedAttachments = normalizeKnowledgeBaseUserAttachments(
        Array.isArray(acquiredClaim.recoveryMetadata.attachments)
          ? (acquiredClaim.recoveryMetadata
              .attachments as KnowledgeBaseAttachment[])
          : [],
      );
      const manifestItem = attachmentManifest[0];
      const attachment = stagedAttachments[0];
      if (
        attachmentManifest.length !== 1 ||
        stagedAttachments.length !== 1 ||
        !manifestItem ||
        !attachment
      ) {
        await cancelUnpreparedKnowledgeBaseTurn({
          userId: req.frontmindUser.id,
          turnId: acquiredClaim.turn.id,
          clientRequestId,
          leaseToken: acquiredClaim.leaseToken,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message: "企业官方主 Logo 上传账本不完整，请重新上传",
        });
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          "企业官方主 Logo 上传账本不完整，请重新上传",
        );
      }
      try {
        const verifiedLogo = await bindKnowledgeBaseOfficialLogoUpload({
          userId: req.frontmindUser.id,
          buildId: build.id,
          generation: acquiredClaim.turn.buildGeneration,
          turnId: acquiredClaim.turn.id,
          operationKey: acquiredClaim.turn.operationKey,
          expectedRevision: acquiredClaim.turn.expectedRevision,
          expectedLeafId: acquiredClaim.turn.expectedLeafId!,
          upload: {
            index: 0,
            fileId: attachment.file_id,
            filename: manifestItem.filename,
            mimeType: manifestItem.mimeType,
            sizeBytes: manifestItem.sizeBytes,
            sourceSha256: manifestItem.sha256,
          },
        });
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_promoted",
          buildId: build.id,
          turnId: acquiredClaim.turn.id,
        });
        acceptedClaim = {
          ...acquiredClaim,
          recoveryMetadata: {
            ...acquiredClaim.recoveryMetadata,
            officialLogoUpload: verifiedLogo,
          },
        };
      } catch (error) {
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_rejected",
          buildId: build.id,
          turnId: acquiredClaim.turn.id,
          reasonCode:
            error instanceof KnowledgeBaseArtifactBindingError
              ? error.code
              : "LOCAL_PREPARATION_FAILED",
        });
        const message =
          error instanceof Error
            ? error.message
            : "企业官方主 Logo 校验失败，请重新上传";
        if (error instanceof KnowledgeBaseArtifactBindingError) {
          await cancelUnpreparedKnowledgeBaseTurn({
            userId: req.frontmindUser.id,
            turnId: acquiredClaim.turn.id,
            clientRequestId,
            leaseToken: acquiredClaim.leaseToken,
            code:
              error.code === "LOGO_UPLOAD_INVALID"
                ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
                : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
            message,
          });
        }
        throw new KnowledgeBaseTurnReservationError(
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
            ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
            : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          message,
        );
      }
    }

    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(202).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: acceptedClaim.turn,
        stateEpoch: observation?.stateEpoch,
      }),
      observation,
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      accepted: true,
      startedAt: acquiredClaim.turn.createdAt.getTime(),
    });
    launchAcceptedKnowledgeBaseClaim({
      claim: acceptedClaim,
      credential: taskCredential,
      outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure && !acquiredClaim) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_DISPATCH_FAILED",
        message: "本轮提交失败，请稍后重试",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    userMessage?: string;
    attachments?: KnowledgeBaseAttachment[];
    resumeLegacyAttachments?: boolean;
    attachmentManifest?: unknown;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string;
    expectedPresentationKey?: string;
    submissionKind?: "message" | "logo";
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  const expectedPresentationKey =
    body.expectedPresentationKey === undefined
      ? undefined
      : String(body.expectedPresentationKey || "").trim();
  const submissionKind = String(body.submissionKind || "message").trim();
  const manualLogoSubmission = submissionKind === "logo";
  const turnUserMessage = manualLogoSubmission
    ? KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION
    : userMessage;
  const turnDisplayMessage = manualLogoSubmission
    ? KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE
    : turnUserMessage;
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    (!userMessage.trim() && !body.attachments?.length)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN",
        message: "请输入当前节点的确认、修订或补充资料",
      },
    });
    return;
  }
  if (submissionKind !== "message" && submissionKind !== "logo") {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_SUBMISSION_KIND",
        message: "本轮提交类型无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    expectedGeneration !== undefined &&
    (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_GENERATION",
        message: "当前知识库代次无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_REVISION",
        message: "当前知识节点版本无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    expectedPresentationKey !== undefined &&
    (!expectedPresentationKey || expectedPresentationKey.length > 191)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_PRESENTATION",
        message: "当前知识节点展示版本无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (
    !body.attachments?.length &&
    isAmbiguousKnowledgeBaseAdvance(userMessage)
  ) {
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(422).json({
      error: {
        code: "AMBIGUOUS_KNOWLEDGE_BASE_ACTION",
        message:
          "“继续/下一步”不会推进知识节点。请点击“确认当前内容”；如需修改，请直接输入意见或上传资料。",
      },
      ...(observation ? { observation } : {}),
    });
    return;
  }

  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  let reservationAcquiredByThisRequest = false;
  let acquiredManualLogoClaim: KnowledgeBaseRecoveryClaim | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser!.id);
    const attachments = normalizeKnowledgeBaseUserAttachments(body.attachments);
    const resumeLegacyAttachments = body.resumeLegacyAttachments === true;
    const attachmentManifest = attachments.length
      ? manualLogoSubmission
        ? await serverOwnedKnowledgeBaseAttachmentManifest(attachments)
        : body.attachmentManifest === undefined
          ? undefined
          : normalizeKnowledgeBaseClientAttachmentManifest(
              body.attachmentManifest,
            )
      : undefined;
    if (
      manualLogoSubmission &&
      (attachments.length !== 1 ||
        attachmentManifest?.length !== 1 ||
        !attachmentManifest[0]!.mimeType.startsWith("image/"))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "企业主 Logo 本轮只接受一张图片原文件，请重新选择后提交",
      );
    }
    if (
      attachmentManifest &&
      (attachmentManifest.length !== attachments.length ||
        attachmentManifest.some(
          (entry, index) => entry.filename !== attachments[index]?.filename,
        ))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Attachment manifest does not match the uploaded file order",
      );
    }
    const clientIntent = {
      schemaVersion: 1,
      flow: "direct",
      ...(manualLogoSubmission ? { submissionKind: "logo" } : {}),
      conversationId,
      userMessage: turnUserMessage,
      attachments,
      attachmentManifest: attachmentManifest ?? null,
      resumeLegacyAttachments,
      expectedGeneration: expectedGeneration ?? null,
      expectedRevision: expectedRevision ?? null,
      expectedLeafId: expectedLeafId || null,
      expectedPresentationKey: expectedPresentationKey ?? null,
    };
    const action = classifyKnowledgeBaseUserAction(
      turnUserMessage,
      attachments.length,
    );
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () => {
          if (!resumeLegacyAttachments) {
            return inspectKnowledgeBaseTurnReplay({
              userId: req.frontmindUser!.id,
              conversationId,
              clientRequestId,
              clientIntent,
              expectedGeneration,
              expectedRevision,
              expectedLeafId: expectedLeafId || undefined,
            });
          }
          if (
            !Number.isSafeInteger(expectedGeneration) ||
            !Number.isSafeInteger(expectedRevision) ||
            !expectedLeafId ||
            !attachmentManifest
          ) {
            return Promise.resolve(null);
          }
          return inspectKnowledgeBaseLegacyAttachmentTakeoverReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            clientRequestId,
            clientAttachmentManifest: attachmentManifest,
            attachments,
            operationType: action === "initial" ? "revise" : action,
            expectedGeneration: Number(expectedGeneration),
            expectedRevision: Number(expectedRevision),
            expectedLeafId,
            expectedPresentationKey,
          });
        },
        requireUpstreamTaskId: manualLogoSubmission,
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const authority = await loadKnowledgeBaseTurnAuthority({
      userId: req.frontmindUser!.id,
      conversationId,
    });
    if (!authority) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_TASK_NOT_BOUND",
          message: "当前知识库尚未绑定可恢复任务，请先同步状态",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const { build: boundBuild, taskId } = authority;
    assertKnowledgeBaseExpectedGeneration({
      expectedGeneration,
      actualGeneration: boundBuild.generation,
    });
    if (
      manualLogoSubmission &&
      (boundBuild.skillVersion !== "4" ||
        boundBuild.status !== "confirming" ||
        !boundBuild.currentLeafId ||
        boundBuild.confirmedCount !== 0 ||
        boundBuild.directPrefilledCount !== 0)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        "仅可在第一个知识节点待确认时提交或更换企业主 Logo，请刷新当前节点后重试",
      );
    }
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser!.id,
      "task",
      taskId,
    );
    if (!taskCredential) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    assertKnowledgeBaseAttachmentManifestPresent({
      skillVersion: boundBuild.skillVersion,
      attachmentCount: attachments.length,
      attachmentManifest,
    });
    for (const attachment of attachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser!.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential)
      ) {
        if (await replayAfterMutableFailure()) return;
        const observation = await getKnowledgeBaseObservation({
          userId: req.frontmindUser!.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null);
        res.status(403).json({
          error: {
            code: "KNOWLEDGE_BASE_FILE_FORBIDDEN",
            message: "上传资料与当前知识库任务不匹配，请重新上传",
          },
          ...(observation ? { observation } : {}),
        });
        return;
      }
    }
    if (attachmentManifest && !manualLogoSubmission) {
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index]!;
        const expected = attachmentManifest[index]!;
        const stored = await readStoredPresalesFile(attachment.file_id);
        if (
          !stored ||
          stored.filename !== expected.filename ||
          stored.sizeBytes !== expected.sizeBytes ||
          stored.sha256?.toLowerCase() !== expected.sha256
        ) {
          throw new KnowledgeBaseTurnReservationError(
            "INVALID_REQUEST",
            `附件“${expected.filename}”的本地完整性记录不匹配，请重新上传`,
          );
        }
        if (expected.mimeType.startsWith("image/")) {
          try {
            await assertCapturedKnowledgeBaseCustomerImage({
              fileId: attachment.file_id,
              filename: expected.filename,
              mimeType: expected.mimeType,
              sizeBytes: expected.sizeBytes,
              sourceSha256: expected.sha256,
            });
          } catch {
            throw new KnowledgeBaseTurnReservationError(
              "INVALID_REQUEST",
              `附件“${expected.filename}”不是可安全保留的图片，请重新选择原文件`,
            );
          }
        }
      }

      const officialLogoRequired =
        knowledgeBaseBuildRequiresOfficialLogo(boundBuild);
      if (
        officialLogoRequired &&
        (attachments.length !== 1 ||
          attachmentManifest.length !== 1 ||
          ![
            "image/avif",
            "image/gif",
            "image/jpeg",
            "image/png",
            "image/webp",
          ].includes(attachmentManifest[0]!.mimeType))
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "INVALID_REQUEST",
          "当前知识库正在等待企业主 Logo。请只上传一张 PNG、JPEG、WebP、AVIF 或 GIF 原图",
        );
      }
      assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
        boundBuild,
        attachmentManifest,
      );
      await assertKnowledgeBaseCustomerUploadCapacity({
        userId: req.frontmindUser!.id,
        buildId: boundBuild.id,
        generation: boundBuild.generation,
        officialLogoSha256: boundBuild.logoSha256,
        officialLogoRequired,
        attachmentManifest,
      });
    }

    const officialLogoUploadCandidate:
      | Omit<KnowledgeBaseOfficialLogoUpload, "verified">
      | undefined =
      manualLogoSubmission && attachmentManifest?.[0] && attachments[0]
        ? {
            index: 0,
            fileId: attachments[0].file_id,
            filename: attachmentManifest[0].filename,
            mimeType: attachmentManifest[0].mimeType,
            sizeBytes: attachmentManifest[0].sizeBytes,
            sourceSha256: attachmentManifest[0].sha256,
          }
        : knowledgeBaseBuildRequiresOfficialLogo(boundBuild) &&
            attachmentManifest?.length === 1 &&
            attachments.length === 1
          ? {
              index: 0,
              fileId: attachments[0]!.file_id,
              filename: attachmentManifest[0]!.filename,
              mimeType: attachmentManifest[0]!.mimeType,
              sizeBytes: attachmentManifest[0]!.sizeBytes,
              sourceSha256: attachmentManifest[0]!.sha256,
            }
          : undefined;
    if (
      knowledgeBaseBuildRequiresOfficialLogo(boundBuild) &&
      !officialLogoUploadCandidate
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "请先上传一张合格的企业官方主 Logo，再继续确认第一个知识节点",
      );
    }
    if (manualLogoSubmission && officialLogoUploadCandidate) {
      await assertManualKnowledgeBaseLogoUploadCandidate(
        officialLogoUploadCandidate,
      );
    }

    const finalPackageRequired = knowledgeBaseTurnRequiresFinalPackage({
      skillVersion: boundBuild.skillVersion,
      currentLeafId: boundBuild.currentLeafId,
      totalNodeCount: boundBuild.totalNodeCount,
      confirmedCount: boundBuild.confirmedCount,
      directPrefilledCount: boundBuild.directPrefilledCount,
      action,
    });
    // Keep the direct path aligned with deferred reserve/stage/dispatch: a
    // final-coordinate build with missing provenance is repair-only.
    await assertKnowledgeBaseFinalLogoProvenanceForBuild(
      req.frontmindUser!.id,
      boundBuild,
    );
    const currentSkillDescriptor = finalPackageRequired
      ? await getKnowledgeBaseSkillDescriptor(
          knowledgeBasePinnedV4SkillSelection({
            skillVersion: boundBuild.skillVersion,
            skillContentHash: boundBuild.skillContentHash,
          }),
        )
      : {
          version: boundBuild.skillVersion,
          contentHash: boundBuild.skillContentHash,
        };
    const recoveryMetadata = {
      kind: "turn",
      conversationId,
      parentTaskId: taskId,
      userMessage: turnUserMessage,
      attachments,
      ...(manualLogoSubmission ? { manualLogoSubmission: true } : {}),
      skillVersion: currentSkillDescriptor.version,
      skillContentHash: currentSkillDescriptor.contentHash,
      ...(finalPackageRequired
        ? { finalPackageRequired: true }
        : { instructionsAttachmentRequired: true }),
      ...(attachmentManifest
        ? {
            attachmentManifest,
            capturedClientAttachments: true,
            ...(officialLogoUploadCandidate
              ? {
                  officialLogoUpload: {
                    ...officialLogoUploadCandidate,
                    verified: false,
                  },
                }
              : {}),
            ...(resumeLegacyAttachments
              ? { legacyUploadFirstTakeover: true }
              : {}),
          }
        : {}),
    };
    const reservation = await reserveKnowledgeBaseTurn({
      userId: req.frontmindUser!.id,
      buildId: boundBuild.id,
      clientRequestId,
      operationType: action === "initial" ? "revise" : action,
      expectedGeneration: expectedGeneration ?? boundBuild.generation,
      expectedRevision: expectedRevision ?? boundBuild.revision,
      expectedLeafId: expectedLeafId || boundBuild.currentLeafId,
      expectedPresentationKey,
      requestPayload: {
        submissionKind: manualLogoSubmission ? "logo" : "message",
        userMessage: turnUserMessage,
        attachments,
        ...(attachmentManifest ? { attachmentManifest } : {}),
        expectedPresentationKey: expectedPresentationKey ?? null,
        skillVersion: currentSkillDescriptor.version,
        skillContentHash: currentSkillDescriptor.contentHash,
      },
      clientIntent: resumeLegacyAttachments ? undefined : clientIntent,
      operationInstanceId: manualLogoSubmission ? clientRequestId : undefined,
      apiCredentialId: taskCredential.id,
      userText: turnDisplayMessage,
      userAttachmentCount: attachments.length,
      expectedAttachmentCount: attachments.length + 2,
      clientAttachmentManifest: attachmentManifest,
      resumeLegacyAttachmentTakeover: resumeLegacyAttachments,
      recoveryMetadata,
    });
    reservationAcquiredByThisRequest = reservation.state === "acquired";
    if (reservation.state !== "acquired") {
      await respondKnowledgeBaseTurnReplayReceipt({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        receipt: reservation,
        requireUpstreamTaskId: manualLogoSubmission,
        res,
      });
      return;
    }
    let verifiedOfficialLogoUpload: KnowledgeBaseOfficialLogoUpload | undefined;
    if (officialLogoUploadCandidate && !manualLogoSubmission) {
      try {
        verifiedOfficialLogoUpload = await bindKnowledgeBaseOfficialLogoUpload({
          userId: req.frontmindUser!.id,
          buildId: boundBuild.id,
          generation: reservation.turn.buildGeneration,
          turnId: reservation.turn.id,
          operationKey: reservation.turn.operationKey,
          expectedRevision: reservation.turn.expectedRevision,
          expectedLeafId: reservation.turn.expectedLeafId!,
          upload: officialLogoUploadCandidate,
        });
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_promoted",
          buildId: boundBuild.id,
          turnId: reservation.turn.id,
        });
      } catch (error) {
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_rejected",
          buildId: boundBuild.id,
          turnId: reservation.turn.id,
          reasonCode:
            error instanceof KnowledgeBaseArtifactBindingError
              ? error.code
              : "LOCAL_PREPARATION_FAILED",
        });
        const message =
          error instanceof Error
            ? error.message
            : "企业官方主 Logo 校验失败，请重新上传";
        if (error instanceof KnowledgeBaseArtifactBindingError) {
          await cancelUnpreparedKnowledgeBaseTurn({
            userId: req.frontmindUser!.id,
            turnId: reservation.turn.id,
            clientRequestId,
            leaseToken: reservation.leaseToken,
            code:
              error.code === "LOGO_UPLOAD_INVALID"
                ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
                : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
            message,
          });
        }
        if (
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
        ) {
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null);
          res.status(422).json({
            error: {
              code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
              message,
            },
            ...(observation ? { observation } : {}),
          });
          return;
        }
        if (error instanceof KnowledgeBaseArtifactBindingError) {
          throw new KnowledgeBaseTurnReservationError(
            "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
            message,
          );
        }
        throw error;
      }
    }
    const acceptedClaim: KnowledgeBaseRecoveryClaim = {
      turn: reservation.turn,
      leaseToken: reservation.leaseToken,
      leaseExpiresAt: reservation.leaseExpiresAt,
      upstreamIdempotencyKey: reservation.upstreamIdempotencyKey,
      recoveryMetadata: verifiedOfficialLogoUpload
        ? {
            ...(reservation.recoveryMetadata ?? recoveryMetadata),
            officialLogoUpload: verifiedOfficialLogoUpload,
          }
        : (reservation.recoveryMetadata ?? recoveryMetadata),
      preparedDispatch: null,
    };
    if (manualLogoSubmission) {
      acquiredManualLogoClaim = acceptedClaim;
      let dispatched: Awaited<
        ReturnType<typeof dispatchAcceptedKnowledgeBaseClaim>
      >;
      try {
        dispatched = await dispatchAcceptedKnowledgeBaseClaim({
          claim: acceptedClaim,
          credential: taskCredential,
        });
      } catch (error) {
        const terminalLogoFailure =
          knowledgeBaseManualLogoTerminalFailure(error);
        if (terminalLogoFailure) {
          let rejectionPersisted = false;
          try {
            await rejectAcknowledgedKnowledgeBaseManualLogoTurn({
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              buildGeneration: acceptedClaim.turn.buildGeneration,
              turnId: acceptedClaim.turn.id,
              clientRequestId,
              leaseToken: acceptedClaim.leaseToken,
              code: terminalLogoFailure.code,
              message: terminalLogoFailure.message,
            });
            rejectionPersisted = true;
          } catch (persistenceError) {
            logKnowledgeBaseRuntimeFailure({
              level: "warn",
              event: "[KnowledgeBaseManualLogo] rejection_persistence_deferred",
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              turnId: acceptedClaim.turn.id,
              error: persistenceError,
              additionalSecrets: [taskCredential.apiKey],
            });
            await markKnowledgeBaseTurnOutcomeUnknown({
              userId: acceptedClaim.turn.userId,
              turnId: acceptedClaim.turn.id,
              leaseToken: acceptedClaim.leaseToken,
              code: "MANUAL_LOGO_REJECTION_DEFERRED",
              recoveryDelayMs: 1_000,
            }).catch(() => undefined);
          }
          if (!rejectionPersisted) {
            const observation = await getKnowledgeBaseObservation({
              userId: req.frontmindUser!.id,
              conversationId,
              upstreamStatus: "running",
            }).catch(() => null);
            respondKnowledgeBaseManualLogoPending({
              observation,
              retryAfterMs: 1_000,
              res,
            });
            return;
          }
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null);
          res.status(terminalLogoFailure.status).json({
            error: {
              code: terminalLogoFailure.code,
              message: terminalLogoFailure.message,
            },
            ...(observation ? { observation } : {}),
          });
          return;
        }
        // If the provider acknowledged the task but post-ack Logo promotion was
        // interrupted, that real task remains the winner. Return it instead of
        // inviting a second logical submission.
        const receipt = await inspectKnowledgeBaseTurnReplay({
          userId: req.frontmindUser!.id,
          conversationId,
          clientRequestId,
          clientIntent,
          expectedGeneration,
          expectedRevision,
          expectedLeafId: expectedLeafId || undefined,
        }).catch(() => null);
        if (receipt?.state === "bound") {
          await respondKnowledgeBaseTurnReplayReceipt({
            userId: req.frontmindUser!.id,
            conversationId,
            requestedClientRequestId: clientRequestId,
            receipt,
            requireUpstreamTaskId: true,
            res,
          });
          return;
        }
        const deterministicCreateStatus =
          knowledgeBaseManualLogoDeterministicCreateFailureStatus(error);
        if (
          deterministicCreateStatus &&
          error instanceof KnowledgeBaseUpstreamCreateError
        ) {
          let rejectionPersisted = false;
          try {
            await rejectUnacknowledgedKnowledgeBaseManualLogoTurn({
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              buildGeneration: acceptedClaim.turn.buildGeneration,
              turnId: acceptedClaim.turn.id,
              clientRequestId,
              leaseToken: acceptedClaim.leaseToken,
              code: error.failureCode,
              message: deterministicKnowledgeBaseCreateFailureMessage(error),
            });
            rejectionPersisted = true;
          } catch (persistenceError) {
            logKnowledgeBaseRuntimeFailure({
              level: "warn",
              event:
                "[KnowledgeBaseManualLogo] create_rejection_persistence_deferred",
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              turnId: acceptedClaim.turn.id,
              error: persistenceError,
              additionalSecrets: [taskCredential.apiKey],
            });
            await markKnowledgeBaseTurnOutcomeUnknown({
              userId: acceptedClaim.turn.userId,
              turnId: acceptedClaim.turn.id,
              leaseToken: acceptedClaim.leaseToken,
              code: "MANUAL_LOGO_REJECTION_DEFERRED",
              recoveryDelayMs: 1_000,
            }).catch(() => undefined);
          }
          if (!rejectionPersisted) {
            const observation = await getKnowledgeBaseObservation({
              userId: req.frontmindUser!.id,
              conversationId,
              upstreamStatus: "running",
            }).catch(() => null);
            respondKnowledgeBaseManualLogoPending({
              observation,
              retryAfterMs: 1_000,
              res,
            });
            return;
          }
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null);
          res.status(deterministicCreateStatus).json({
            error: {
              code: error.failureCode,
              message: deterministicKnowledgeBaseCreateFailureMessage(error),
            },
            reservationCreated: true,
            ...(observation ? { observation } : {}),
          });
          return;
        }
        let failureClass: KnowledgeBaseUpstreamCreateFailureClass = "unknown";
        const failureToPersist =
          knowledgeBaseManualLogoCreateFailureForPersistence(error);
        try {
          failureClass = await persistKnowledgeBaseCreateFailure({
            userId: acceptedClaim.turn.userId,
            turnId: acceptedClaim.turn.id,
            leaseToken: acceptedClaim.leaseToken,
            error: failureToPersist,
            outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
            recoveryDelayMs: 1_000,
          });
        } catch (persistenceError) {
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event: "[KnowledgeBaseManualLogo] failure_persistence_deferred",
            userId: acceptedClaim.turn.userId,
            buildId: acceptedClaim.turn.buildId,
            turnId: acceptedClaim.turn.id,
            error: persistenceError,
            additionalSecrets: [taskCredential.apiKey],
          });
        }
        const persistedDeterministicCreateStatus =
          failureClass === "deterministic"
            ? knowledgeBaseManualLogoDeterministicCreateFailureStatus(error)
            : null;
        if (
          persistedDeterministicCreateStatus &&
          error instanceof KnowledgeBaseUpstreamCreateError
        ) {
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "failed",
          }).catch(() => null);
          res.status(persistedDeterministicCreateStatus).json({
            error: {
              code: error.failureCode,
              message: deterministicKnowledgeBaseCreateFailureMessage(error),
            },
            reservationCreated: true,
            ...(observation ? { observation } : {}),
          });
          return;
        }
        if (failureClass !== "deterministic") {
          const pendingReceipt = await inspectKnowledgeBaseTurnReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            clientRequestId,
            clientIntent,
            expectedGeneration,
            expectedRevision,
            expectedLeafId: expectedLeafId || undefined,
          }).catch(() => null);
          if (pendingReceipt) {
            await respondKnowledgeBaseTurnReplayReceipt({
              userId: req.frontmindUser!.id,
              conversationId,
              requestedClientRequestId: clientRequestId,
              receipt: pendingReceipt,
              requireUpstreamTaskId: true,
              res,
            });
            return;
          }
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null);
          respondKnowledgeBaseManualLogoPending({
            observation,
            retryAfterMs: 1_000,
            res,
          });
          return;
        }
        throw error;
      }
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(202).json({
        task: { id: dispatched.taskId, status: "running" },
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "running"),
        observation,
        accepted: true,
        startedAt: reservation.turn.createdAt.getTime(),
      });
      return;
    }
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(202).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: acceptedClaim.turn,
        stateEpoch: observation?.stateEpoch,
      }),
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
      accepted: true,
      startedAt: reservation.turn.createdAt.getTime(),
    });
    launchAcceptedKnowledgeBaseClaim({
      claim: acceptedClaim,
      credential: taskCredential,
      outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure && !reservationAcquiredByThisRequest) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      if (error.retryAfterMs) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
        );
      }
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const terminalManualLogoFailure = manualLogoSubmission
      ? knowledgeBaseManualLogoTerminalFailure(error)
      : null;
    if (terminalManualLogoFailure) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null)
        : null;
      res.status(terminalManualLogoFailure.status).json({
        error: {
          code: terminalManualLogoFailure.code,
          message: terminalManualLogoFailure.message,
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseBuildError) {
      const status = error.code === "BUILD_NOT_FOUND" ? 404 : 422;
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(status).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (manualLogoSubmission) {
      logKnowledgeBaseRuntimeFailure({
        level: "warn",
        event: reservationAcquiredByThisRequest
          ? "[KnowledgeBaseManualLogo] post_reservation_unclassified_failure"
          : "[KnowledgeBaseManualLogo] pre_reservation_unclassified_failure",
        userId: req.frontmindUser?.id,
        error,
      });
      if (reservationAcquiredByThisRequest && acquiredManualLogoClaim) {
        try {
          await markKnowledgeBaseTurnOutcomeUnknown({
            userId: acquiredManualLogoClaim.turn.userId,
            turnId: acquiredManualLogoClaim.turn.id,
            leaseToken: acquiredManualLogoClaim.leaseToken,
            code: "MANUAL_LOGO_UNCLASSIFIED_FAILURE",
            recoveryDelayMs: 1_000,
          });
        } catch (persistenceError) {
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event:
              "[KnowledgeBaseManualLogo] unclassified_failure_persistence_deferred",
            userId: req.frontmindUser?.id,
            turnId: acquiredManualLogoClaim.turn.id,
            error: persistenceError,
          });
        }
      }
      if (reservationAcquiredByThisRequest && replayAfterMutableFailure) {
        try {
          if (await replayAfterMutableFailure()) return;
        } catch (replayError) {
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event: "[KnowledgeBaseManualLogo] post_reservation_replay_deferred",
            userId: req.frontmindUser?.id,
            error: replayError,
          });
        }
      }
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      respondKnowledgeBaseManualLogoUnclassifiedFailure({
        reservationAcquired: reservationAcquiredByThisRequest,
        observation,
        retryAfterMs: 1_000,
        res,
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_FAILED",
        message: "当前知识节点提交遇到服务端异常，系统将继续核对同一轮次",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

const KNOWLEDGE_BASE_PRECREATE_ATTACHMENT_REPAIR_CODES = new Set([
  "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
  "KNOWLEDGE_BASE_USER_ATTACHMENT_INVALID",
]);

export function knowledgeBaseAttachmentRepairObservationAllowsReplacement(input: {
  observation: KnowledgeBaseObservationDto | null;
  conversationId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
}) {
  const observation = input.observation;
  const progress = observation?.interaction.progress;
  const activeTurn = observation?.activeTurn;
  const notice = observation?.notice;
  return Boolean(
    observation &&
      progress &&
      activeTurn &&
      notice &&
      progress.build.conversationId === input.conversationId &&
      observation.generation === input.expectedGeneration &&
      progress.build.revision === input.expectedRevision &&
      (progress.build.currentLeafId ?? null) === input.expectedLeafId &&
      notice.turnId === activeTurn.id &&
      activeTurn.status === "failed" &&
      activeTurn.buildGeneration === input.expectedGeneration &&
      activeTurn.expectedRevision === input.expectedRevision &&
      (activeTurn.expectedLeafId ?? null) === input.expectedLeafId &&
      activeTurn.failureClass === "requires_user_fix" &&
      activeTurn.recoveryAction === "fix_attachments" &&
      activeTurn.canRegenerate === false &&
      activeTurn.createAttemptState === "not_sent" &&
      notice.failureClass === "requires_user_fix" &&
      notice.recoveryAction === "fix_attachments" &&
      notice.canRegenerate === false &&
      KNOWLEDGE_BASE_PRECREATE_ATTACHMENT_REPAIR_CODES.has(notice.code),
  );
}

router.post("/turn/replace-attachments", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string | null;
    attachments?: KnowledgeBaseAttachment[];
    attachmentManifest?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedLeafId =
    body.expectedLeafId === null
      ? null
      : String(body.expectedLeafId || "").trim() || null;
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(body.expectedGeneration) ||
    Number(body.expectedGeneration) < 1 ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0 ||
    !Object.prototype.hasOwnProperty.call(body, "expectedLeafId")
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_ATTACHMENT_REPAIR",
        message: "附件替换坐标无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (!req.frontmindCredential) {
    res.status(409).json({
      error: {
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "请先配置可用 API 凭证后替换附件",
      },
    });
    return;
  }
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "failed",
    });
    if (
      !knowledgeBaseAttachmentRepairObservationAllowsReplacement({
        observation,
        conversationId,
        expectedGeneration: Number(body.expectedGeneration),
        expectedRevision: Number(body.expectedRevision),
        expectedLeafId,
      })
    ) {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_CONFLICT",
          message: "当前轮次不再等待替换附件，请刷新权威状态",
        },
        observation,
      });
      return;
    }
    const attachments = normalizeKnowledgeBaseUserAttachments(body.attachments);
    const attachmentManifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    if (
      attachments.length === 0 ||
      attachments.length !== attachmentManifest.length
    ) {
      res.status(422).json({
        error: {
          code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_INVALID",
          message: "请至少选择一份替换资料，并确保文件清单完整",
        },
      });
      return;
    }
    for (let index = 0; index < attachments.length; index += 1) {
      if (
        attachments[index]!.filename !== attachmentManifest[index]!.filename
      ) {
        res.status(422).json({
          error: {
            code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_INVALID",
            message: "替换附件名称与完整性清单不一致",
          },
        });
        return;
      }
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser.id,
        "file",
        attachments[index]!.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(
          fileCredential,
          req.frontmindCredential,
        )
      ) {
        res.status(403).json({
          error: {
            code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_FORBIDDEN",
            message: "替换附件与当前账号或凭证不匹配",
          },
        });
        return;
      }
    }
    const claim = await replaceKnowledgeBaseTurnAttachmentsAfterUserFix({
      userId: req.frontmindUser.id,
      turnId: observation!.notice!.turnId!,
      apiCredentialId: req.frontmindCredential.id,
      clientRequestId,
      attachments,
      attachmentManifest,
    });
    const acceptedObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    if (!claim) {
      res.status(202).json({
        observation: acceptedObservation,
        progress: acceptedObservation?.interaction.progress || null,
        interaction:
          acceptedObservation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "running"),
        idempotent: true,
        accepted: true,
        reservationCreated: false,
      });
      return;
    }
    res.status(202).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: claim.turn,
        stateEpoch: acceptedObservation?.stateEpoch,
      }),
      observation: acceptedObservation,
      progress: acceptedObservation?.interaction.progress || null,
      interaction:
        acceptedObservation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      accepted: true,
      resumed: true,
      reservationCreated: false,
    });
    launchAcceptedKnowledgeBaseClaim({
      claim,
      credential: req.frontmindCredential,
      outcomeUnknownCode: "ATTACHMENT_REPAIR_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseAttachmentRepair] runtime_failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_UNAVAILABLE",
        message: "附件替换暂时不可用，原轮次和资料仍已保留",
      },
      observation,
    });
  }
});

export function knowledgeBaseRetryObservationAllowsRegeneration(input: {
  observation: KnowledgeBaseObservationDto | null;
  buildId: string;
  activeTurnId: string | null;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
}) {
  const observation = input.observation;
  const progress = observation?.interaction.progress;
  const activeTurn = observation?.activeTurn;
  const notice = observation?.notice;
  return Boolean(
    observation &&
      progress &&
      activeTurn &&
      notice &&
      progress.build.id === input.buildId &&
      observation.generation === input.expectedGeneration &&
      progress.build.revision === input.expectedRevision &&
      (progress.build.currentLeafId ?? null) === input.expectedLeafId &&
      input.activeTurnId === activeTurn.id &&
      notice.turnId === activeTurn.id &&
      activeTurn.status === "failed" &&
      activeTurn.buildGeneration === input.expectedGeneration &&
      activeTurn.expectedRevision === input.expectedRevision &&
      (activeTurn.expectedLeafId ?? null) === input.expectedLeafId &&
      activeTurn.failureClass === "terminal_requires_regeneration" &&
      activeTurn.recoveryAction === "regenerate_turn" &&
      activeTurn.canRegenerate === true &&
      activeTurn.createAttemptState !== "rejected" &&
      notice.failureClass === "terminal_requires_regeneration" &&
      notice.recoveryAction === "regenerate_turn" &&
      notice.canRegenerate === true,
  );
}

router.post("/retry", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string | null;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const hasExpectedLeaf = Object.prototype.hasOwnProperty.call(
    body,
    "expectedLeafId",
  );
  const expectedLeafId =
    body.expectedLeafId === null
      ? null
      : String(body.expectedLeafId || "").trim() || null;
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    Number(expectedGeneration) < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 0 ||
    !hasExpectedLeaf
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_RETRY",
        message: "重试坐标无效，请刷新知识库状态后再试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let acceptedRetryTurn: KnowledgeBaseRecoveryClaim["turn"] | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const retryBuild = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    if (
      retryBuild &&
      retryBuild.generation === Number(expectedGeneration) &&
      retryBuild.revision === Number(expectedRevision) &&
      (retryBuild.currentLeafId ?? null) === expectedLeafId
    ) {
      const retryObservation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      if (
        !knowledgeBaseRetryObservationAllowsRegeneration({
          observation: retryObservation,
          buildId: retryBuild.id,
          activeTurnId: retryBuild.activeTurnId,
          expectedGeneration: Number(expectedGeneration),
          expectedRevision: Number(expectedRevision),
          expectedLeafId,
        })
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "当前失败轮次没有服务端授权的重新生成操作",
        );
      }
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser.id,
        retryBuild,
      );
    }
    const retry = await reserveKnowledgeBaseRetryTurn({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedLeafId,
    });
    const { reservation } = retry;
    if (reservation.state !== "acquired") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus:
          reservation.state === "completed" ? "completed" : "running",
      });
      res
        .status(reservation.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(reservation) / 1_000)),
        )
        .json({
          reservation: knowledgeBaseReservationReceipt(
            reservation,
            observation?.stateEpoch,
          ),
          ...(observation?.authoritativeTaskId
            ? {
                task: {
                  id: observation.authoritativeTaskId,
                  status:
                    reservation.state === "completed" ? "completed" : "running",
                },
              }
            : {}),
          progress: observation?.interaction.progress || null,
          interaction:
            observation?.interaction ||
            deriveKnowledgeBaseInteraction(null, "running"),
          observation,
          idempotent: true,
          startedAt: reservation.turn.startedAt?.getTime() || Date.now(),
        });
      return;
    }
    acceptedRetryTurn = reservation.turn;
    if (!reservation.turn.apiCredentialId) {
      const paused = await failKnowledgeBaseTurnDeterministically({
        userId: req.frontmindUser.id,
        turnId: reservation.turn.id,
        leaseToken: reservation.leaseToken,
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "本轮凭证绑定已失效，请更新 API 凭证后继续同一轮次",
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
        canRegenerate: false,
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      res.status(202).json({
        reservation: knowledgeBaseAcceptedReservationReceipt({
          turn: paused.turn,
          stateEpoch: observation?.stateEpoch,
        }),
        observation,
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "failed"),
        accepted: true,
        paused: true,
        reservationCreated: true,
      });
      return;
    }
    const credential = await getDecryptedCredentialForKnowledgeBaseReservation({
      userId: req.frontmindUser.id,
      turnId: reservation.turn.id,
      buildId: reservation.turn.buildId!,
      buildGeneration: reservation.turn.buildGeneration!,
      apiCredentialId: reservation.turn.apiCredentialId,
    });
    if (!credential) {
      const paused = await failKnowledgeBaseTurnDeterministically({
        userId: req.frontmindUser.id,
        turnId: reservation.turn.id,
        leaseToken: reservation.leaseToken,
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "失败任务使用的 API 凭证已不可用，请更新后继续同一轮次",
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
        canRegenerate: false,
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      res.status(202).json({
        reservation: knowledgeBaseAcceptedReservationReceipt({
          turn: paused.turn,
          stateEpoch: observation?.stateEpoch,
        }),
        observation,
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "failed"),
        accepted: true,
        paused: true,
        reservationCreated: true,
      });
      return;
    }
    const claim: KnowledgeBaseRecoveryClaim = {
      turn: reservation.turn,
      leaseToken: reservation.leaseToken,
      leaseExpiresAt: reservation.leaseExpiresAt,
      upstreamIdempotencyKey: reservation.upstreamIdempotencyKey,
      recoveryMetadata: retry.recoveryMetadata,
      preparedDispatch: retry.preparedDispatch,
    };
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.status(202).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: claim.turn,
        stateEpoch: observation?.stateEpoch,
      }),
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
      retried: true,
      accepted: true,
      reservationCreated: true,
      startedAt: reservation.turn.createdAt.getTime(),
    });
    launchAcceptedKnowledgeBaseClaim({
      claim,
      credential,
      outcomeUnknownCode: "RETRY_DISPATCH_OUTCOME_UNKNOWN",
    });
    return;
  } catch (error) {
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (acceptedRetryTurn) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(202).json({
        reservation: knowledgeBaseAcceptedReservationReceipt({
          turn: acceptedRetryTurn,
          stateEpoch: observation?.stateEpoch,
        }),
        observation,
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "running"),
        accepted: true,
        recovering: true,
        reservationCreated: true,
      });
      return;
    }
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res
        .status(
          error.code === "BUILD_NOT_FOUND"
            ? 404
            : error.code === "INVALID_REQUEST"
              ? 400
              : 409,
        )
        .json({
          error: { code: error.code, message: error.message },
          ...(observation
            ? {
                observation,
                progress: observation.interaction.progress,
                interaction: observation.interaction,
              }
            : {}),
        });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseRetry] runtime_failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_RETRY_FAILED",
        message: "当前知识节点重试暂时不可用，系统将保留并复核本轮状态",
      },
      ...(observation
        ? {
            observation,
            progress: observation.interaction.progress,
            interaction: observation.interaction,
          }
        : {}),
    });
  }
});

router.get("/progress/:conversationId", async (req, res) => {
  try {
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId: req.params.conversationId,
      upstreamStatus: "running",
    });
    res.json({
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
    });
  } catch (error) {
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseProgress] read_failed",
      error,
    });
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_PROGRESS_UNAVAILABLE",
        message: "读取知识库进度失败，请稍后重试",
      },
    });
  }
});

router.post("/progress/reconcile", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    taskId?: string;
  };
  try {
    const conversationId = String(body.conversationId || "");
    const requestedTaskId = String(body.taskId || "");
    if (
      !req.frontmindUser ||
      !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
    ) {
      return;
    }
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const currentObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    const immutableStatus =
      currentObservation?.interaction.progress?.build.status;
    const logoRecoveryRequired =
      currentObservation?.interaction.progress?.build.logoRequired === true;
    const recoverableArtifactNotice =
      knowledgeBaseProtocolErrorAllowsSameTaskRecovery(
        currentObservation?.notice?.code,
      );
    const recoverableOperationalNotice =
      knowledgeBaseNoticeAllowsSameTaskReconcile(currentObservation?.notice);
    const immutableProjection =
      immutableStatus === "ready_to_publish" ||
      immutableStatus === "published" ||
      (!recoverableArtifactNotice &&
        !recoverableOperationalNotice &&
        (immutableStatus === "protocol_error" || immutableStatus === "failed"));
    const preserveRecoverableArtifactObservation = () => {
      if (!recoverableArtifactNotice || !currentObservation) return false;
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return true;
    };
    if (currentObservation && immutableProjection) {
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return;
    }
    if (
      isApprovedKnowledgeBaseAwaitingInputObservation(currentObservation) &&
      !logoRecoveryRequired
    ) {
      // The previous operation has already committed its presentation and
      // released activeTurnId. Reconcile wakes are now observation-only until
      // the customer creates the next server reservation.
      res.json({
        progress: currentObservation!.interaction.progress,
        interaction: currentObservation!.interaction,
        observation: currentObservation,
      });
      return;
    }
    const taskId = currentObservation?.authoritativeTaskId || requestedTaskId;
    if (!taskId) {
      const activeTurn = currentObservation?.activeTurn;
      const notice = currentObservation?.notice;
      const canResumePreCreateFailure =
        Boolean(activeTurn) &&
        Boolean(notice) &&
        notice!.turnId === activeTurn!.id &&
        activeTurn!.status === "failed" &&
        activeTurn!.failureClass === "requires_user_fix" &&
        activeTurn!.canRegenerate === false &&
        activeTurn!.createAttemptState === "not_sent" &&
        notice!.failureClass === "requires_user_fix" &&
        notice!.canRegenerate === false &&
        notice!.recoveryAction === activeTurn!.recoveryAction &&
        (notice!.recoveryAction === "top_up" ||
          notice!.recoveryAction === "update_credential") &&
        Boolean(req.frontmindCredential);
      if (canResumePreCreateFailure) {
        const claim = await resumeKnowledgeBaseTurnAfterUserFix({
          userId: req.frontmindUser.id,
          turnId: activeTurn!.id,
          apiCredentialId: req.frontmindCredential!.id,
        });
        if (claim) {
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          });
          res.status(202).json({
            reservation: knowledgeBaseAcceptedReservationReceipt({
              turn: claim.turn,
              stateEpoch: observation?.stateEpoch,
            }),
            progress: observation?.interaction.progress || null,
            interaction:
              observation?.interaction ||
              deriveKnowledgeBaseInteraction(null, "running"),
            observation,
            accepted: true,
            resumed: true,
            reservationCreated: false,
          });
          launchAcceptedKnowledgeBaseClaim({
            claim,
            credential: req.frontmindCredential!,
            outcomeUnknownCode: "USER_FIX_DISPATCH_OUTCOME_UNKNOWN",
          });
          return;
        }
      }
      if (currentObservation) {
        res.json({
          progress: currentObservation.interaction.progress,
          interaction: currentObservation.interaction,
          observation: currentObservation,
        });
        return;
      }
      res.status(404).json({
        error: {
          code: "KNOWLEDGE_BASE_NOT_FOUND",
          message: "当前对话没有知识库构建记录",
        },
      });
      return;
    }
    if (
      requestedTaskId &&
      currentObservation?.authoritativeTaskId &&
      requestedTaskId !== currentObservation.authoritativeTaskId
    ) {
      // A delayed poll from an older build generation is expected under tab
      // restore and network retry. Return the current authority as a no-op;
      // never turn it into a protocol error bubble.
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return;
    }
    const boundBuild = await assertKnowledgeBaseTaskBinding({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
    });
    if (boundBuild.status === "published") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "completed",
      });
      res.json({
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "completed"),
        observation,
      });
      return;
    }
    const credential = await getCredentialForUpstreamResource(
      req.frontmindUser!.id,
      "task",
      taskId,
    );
    if (!credential) {
      if (preserveRecoverableArtifactObservation()) return;
      const authority = knowledgeBaseUpstreamReadFailureAuthority({
        kind: "credential_unavailable",
      });
      const failure = await observeKnowledgeBaseUpstreamFailure({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        code: authority.code,
        message: "知识库任务凭证已失效，请重新配置凭证后联系管理员恢复本轮",
        failureClass: authority.failureClass,
        recoveryAction: authority.recoveryAction,
      });
      if (failure.durable && failure.observation) {
        res.json({
          progress: failure.observation.interaction.progress,
          interaction: failure.observation.interaction,
          observation: failure.observation,
        });
      } else {
        res.status(503).json({
          error: {
            code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
            message: "知识库任务凭证暂不可用，正在保留并复核当前状态",
          },
          observation: failure.observation,
          progress: failure.observation?.interaction.progress || null,
          interaction: failure.observation?.interaction || null,
        });
      }
      return;
    }
    let taskResponse;
    try {
      taskResponse = await axios.get(
        `${getUpstreamBaseUrl(req)}/v1/tasks/${encodeURIComponent(taskId)}`,
        {
          headers: {
            API_KEY: credential.apiKey,
            Authorization: `Bearer ${credential.apiKey}`,
          },
          timeout: 120000,
          validateStatus: () => true,
        },
      );
    } catch {
      taskResponse = null;
    }
    if (!taskResponse) {
      if (preserveRecoverableArtifactObservation()) return;
      const authority = knowledgeBaseUpstreamReadFailureAuthority({
        kind: "transport",
      });
      const failure = await observeKnowledgeBaseUpstreamFailure({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        code: authority.code,
        message: "读取知识库任务结果持续失败，本轮状态和最后正确正文已保留",
        failureClass: authority.failureClass,
        recoveryAction: authority.recoveryAction,
      });
      if (failure.durable && failure.observation) {
        res.json({
          progress: failure.observation.interaction.progress,
          interaction: failure.observation.interaction,
          observation: failure.observation,
        });
      } else {
        res.status(503).json({
          error: {
            code: "UPSTREAM_TASK_READ_FAILED",
            message: "读取知识库任务结果失败，正在自动重试",
          },
          observation: failure.observation,
          progress: failure.observation?.interaction.progress || null,
          interaction: failure.observation?.interaction || null,
        });
      }
      return;
    }
    if (taskResponse.status < 200 || taskResponse.status >= 300) {
      if (preserveRecoverableArtifactObservation()) return;
      const authority = knowledgeBaseUpstreamReadFailureAuthority({
        kind: "http",
        status: taskResponse.status,
      });
      const credentialFailure = authority.failureClass === "requires_user_fix";
      const failure = await observeKnowledgeBaseUpstreamFailure({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        code: authority.code,
        message: credentialFailure
          ? "上游已拒绝当前知识库任务凭证，请重新配置后联系管理员恢复"
          : "读取知识库任务结果持续失败，本轮状态和最后正确正文已保留",
        failureClass: authority.failureClass,
        recoveryAction: authority.recoveryAction,
      });
      if (failure.durable && failure.observation) {
        res.json({
          progress: failure.observation.interaction.progress,
          interaction: failure.observation.interaction,
          observation: failure.observation,
        });
      } else {
        res.status(503).json({
          error: {
            code: credentialFailure
              ? "UPSTREAM_CREDENTIAL_REJECTED"
              : "UPSTREAM_TASK_READ_FAILED",
            message: "读取知识库任务结果失败，正在自动重试",
          },
          observation: failure.observation,
          progress: failure.observation?.interaction.progress || null,
          interaction: failure.observation?.interaction || null,
        });
      }
      return;
    }
    const taskData = assertExpectedUpstreamTaskId(taskResponse.data, taskId);
    const taskStatus = normalizedUpstreamTaskStatus(taskData.status);
    const fullOutput = normalizeRecoveredTaskOutput(taskData);
    await recordKnowledgeBaseOutputFiles({
      userId: req.frontmindUser!.id,
      apiCredentialId: credential.id,
      output: fullOutput,
    });
    if (logoRecoveryRequired) {
      await recoverKnowledgeBaseInitialLogoFromCompletedTurn({
        userId: req.frontmindUser!.id,
        buildId: boundBuild.id,
        generation: boundBuild.generation,
        taskId,
        output: fullOutput,
        apiKey: credential.apiKey,
        baseUrl: getUpstreamBaseUrl(req),
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: taskStatus,
      });
      res.json({
        progress:
          observation?.interaction.progress ||
          currentObservation?.interaction.progress ||
          null,
        interaction:
          observation?.interaction ||
          currentObservation?.interaction ||
          deriveKnowledgeBaseInteraction(null, taskStatus),
        observation,
      });
      return;
    }
    const progress = await reconcileAvailableKnowledgeOutput({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
      output: fullOutput,
      upstreamStatus: taskStatus,
      ledger: {
        lastOutputLength: boundBuild.lastOutputLength,
        lastOutputItemIds: boundBuild.lastOutputItemIds,
      },
      artifactAccess: {
        apiKey: credential.apiKey,
        baseUrl: getUpstreamBaseUrl(req),
      },
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: taskStatus,
    });
    res.json({
      progress: observation?.interaction.progress || progress,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(progress, taskStatus),
      observation,
    });
  } catch (error) {
    const semanticError = error instanceof KnowledgeBaseBuildError;
    const status = knowledgeBaseReconcileFailureStatus(error);
    const observation =
      req.frontmindUser && String(body.conversationId || "").trim()
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId: String(body.conversationId || "").trim(),
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
    if (!semanticError) {
      logKnowledgeBaseRuntimeFailure({
        level: "error",
        event: "[KnowledgeBaseReconcile] runtime_failed",
        error,
        additionalSecrets: [req.frontmindCredential?.apiKey],
      });
    }
    res.status(status).json({
      error: {
        code: semanticError
          ? error.code
          : "KNOWLEDGE_BASE_RECONCILE_UNAVAILABLE",
        message: semanticError
          ? error.message
          : "知识库状态同步暂时不可用，系统将继续恢复本轮",
      },
      observation,
      progress: observation?.interaction.progress || null,
      interaction: observation?.interaction || null,
    });
  }
});

export default router;
