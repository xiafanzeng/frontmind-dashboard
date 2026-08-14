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
  sql,
} from "drizzle-orm";
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";
import {
  getFrontMindCredentials,
  getUpstreamBaseUrl,
  toUpstreamAgentProfile,
} from "./upstream-config";
import {
  AuthServiceError,
  credentialsUseSameUpstreamApiKey,
  getDecryptedCredentialForKnowledgeBaseReservation,
  getDecryptedCredentialForKnowledgeBaseUploadReservation,
  getEffectiveDecryptedCredentialForAccount,
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
  apiCredentials,
  conversationTurns,
  conversations,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  messages,
  upstreamResources,
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
import { parseExactJson } from "../shared/model-output-repair";
import {
  classifyKnowledgeBaseUpstreamTaskStatus,
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
  KNOWLEDGE_BASE_MANIFEST_KIND,
  KNOWLEDGE_BASE_PRESENTATION_KIND,
  KNOWLEDGE_BASE_PROGRESS_KIND,
  KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBaseManifestEnvelope,
  validateKnowledgeBaseManifestForTreePolicy,
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
  activateKnowledgeBaseManusV2Handoff,
  bindKnowledgeBaseTurnUpstreamTask,
  beginKnowledgeBaseManusV2Dispatch,
  bindKnowledgeBaseManusV2Submission,
  cancelUnpreparedKnowledgeBaseTurn,
  cancelIncompleteKnowledgeBaseStart,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseManusV2AnchorHandoff,
  claimKnowledgeBaseTerminalAnchorHandoffRecovery,
  claimKnowledgeBaseTurnForRecovery,
  completeKnowledgeBaseGeneratedAttachment,
  completeKnowledgeBaseManusV2AnchorHandoff,
  deferKnowledgeBaseManusV2AnchorHandoffOutputPending,
  deferKnowledgeBaseManusV2AnchorHandoffAfterRejection,
  settleKnowledgeBaseManusV2ExplicitRejection,
  stopKnowledgeBaseCompatibleCreateOutcomeUnknown,
  deferKnowledgeBaseTurnBeforeCreate,
  ensureKnowledgeBaseBuildSkillArchivePin,
  findRecoverableKnowledgeBaseTurnIds,
  findRecoverableKnowledgeBaseAnchorHandoffTurnIds,
  findRecoverableKnowledgeBaseTerminalAnchorHandoffTurnIds,
  failKnowledgeBaseTurnDeterministically,
  freezeKnowledgeBaseTurnAttachments,
  hashKnowledgeBaseTurnRequest,
  inspectKnowledgeBaseDeferredAttachmentReplay,
  inspectKnowledgeBaseDeferredDispatchReplay,
  inspectKnowledgeBaseLegacyAttachmentTakeoverReplay,
  inspectKnowledgeBaseLegacyDeferredReservationReplay,
  inspectKnowledgeBaseLegacyStartReplay,
  inspectKnowledgeBaseTurnReplay,
  inspectKnowledgeBaseExplicitRecovery,
  findKnowledgeBaseExplicitRecoveryReplay,
  loadKnowledgeBasePreproviderLocalRehydrateAuthority,
  loadKnowledgeBaseLocalRehydrateSnapshot,
  clearKnowledgeBaseLocalRehydrateRequirement,
  markKnowledgeBaseTurnDispatching,
  markLegacyKnowledgeBaseCreateAttentionRequired,
  markKnowledgeBaseTurnOutcomeUnknown,
  markKnowledgeBaseManusV2OutcomeUnknown,
  markKnowledgeBaseManusV2AttentionRequired,
  markKnowledgeBaseManusV2AnchorHandoffAttentionRequired,
  observeAndLocallySettleKnowledgeBaseTerminalAnchor,
  markKnowledgeBaseManusV2CredentialRebindAttention,
  mutateKnowledgeBaseManusV2Lifecycle,
  pauseKnowledgeBasePreCreateCredentialUnavailable,
  prepareKnowledgeBaseTurnDispatch,
  promoteKnowledgeBaseGeneratedAttachmentReady,
  replaceUnusableKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseFailedNotSentLegacyHandoff,
  reserveKnowledgeBaseRetryTurn,
  reserveKnowledgeBaseManusV2AnchorHandoff,
  reserveKnowledgeBaseNewCanonicalFromSnapshot,
  reserveKnowledgeBaseCompatibleCreateRecovery,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  replaceKnowledgeBaseTurnAttachmentsAfterUserFix,
  rejectAcknowledgedKnowledgeBaseManualLogoTurn,
  rejectUnacknowledgedKnowledgeBaseManualLogoTurn,
  renewKnowledgeBaseTurnLease,
  releaseGeneratedAttachmentInvalidPreproviderTurns,
  reclassifyHistoricalPreproviderAuthoritySelfTerminal,
  normalizeKnowledgeBaseTerminalRejection,
  stageAndClaimKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseTurnAttachments,
  KnowledgeBaseTurnReservationError,
  type KnowledgeBaseCreateAttemptState,
  type KnowledgeBasePreparedDispatch,
  type KnowledgeBaseRecoveryClaim,
  type KnowledgeBaseAnchorHandoffCredentialMode,
  type KnowledgeBaseDeferredDispatchClaim,
  type KnowledgeBaseTurnReservation,
} from "./knowledge-base-turn-service";

export { releaseGeneratedAttachmentInvalidPreproviderTurns };
import {
  appendManusV2KnowledgeBaseOperationContract,
  buildManusV2CreateTaskBody,
  buildManusV2KnowledgeBaseStructuredOutputSchema,
  buildManusV2SendMessageBody,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventsContainOperationToken,
  manusV2KnowledgeBaseStructuredResultForOperation,
  normalizeManusV2Output,
  type ManusV2KnowledgeBaseOperationContract,
} from "./manus-v2-client";
import {
  buildKnowledgeBaseManusV2FormatRepair,
  buildKnowledgeBaseManusV2ErrorRecovery,
  buildKnowledgeBaseManusV2AnchorErrorRecovery,
  classifyKnowledgeBaseManusV2ErrorRecoveryAttempt,
  classifyKnowledgeBaseManusV2FormatRepairAttempt,
  classifyKnowledgeBaseManusV2Lifecycle,
  classifyKnowledgeBaseManusV2WaitingAttempt,
  isRepairableKnowledgeBaseManusV2FormatCode,
  knowledgeBaseManusV2ErrorRecoveryRejection,
  manusV2WaitingEventIsStrictSuccessor,
} from "./knowledge-base-manus-v2-lifecycle";
import {
  knowledgeBaseManusV2ActiveMigrationEnabled,
  knowledgeBaseManusV2RecoveryAuthority,
} from "./knowledge-base-manus-v2-rollout";
import {
  classifyKnowledgeBaseAnchorAcknowledgementSettlement,
  classifyKnowledgeBaseCanonicalCredentialRebind,
  executeKnowledgeBaseAnchorHandoff,
  inspectKnowledgeBaseAnchorAcknowledgement,
} from "./knowledge-base-active-v2-migration-core";
import {
  ensureKnowledgeBaseManusV2Attachments,
  isKnowledgeBaseManusV2GeneratedFileCreateRejected,
} from "./knowledge-base-manus-v2-attachments";
import {
  claimKnowledgeBaseOpenRecoveryBuild,
  releaseKnowledgeBaseOpenRecoveryLease,
  renewKnowledgeBaseOpenRecoveryLease,
  type KnowledgeBaseOpenRecoveryClaim,
} from "./knowledge-base-open-recovery-lease";
import { assertCapturedKnowledgeBaseCustomerImage } from "./knowledge-base-customer-upload";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  persistKnowledgeBaseBuildSource,
  persistKnowledgeBaseGeneratedSource,
} from "./knowledge-base-local-source-store";
import {
  ManagedUploadIntentError,
  proveKnowledgeBaseManagedUploadForStage,
} from "./managed-upload-intent";
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
  matchesAuthoritativeKnowledgeBaseMessageTuple,
  parsedKnowledgeBaseMessageMetadata,
} from "./knowledge-base-authoritative-message";
import {
  getKnowledgeBaseSkillDescriptor,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  knowledgeBasePinnedV4SkillSelection,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";
import { knowledgeBaseNewBuildPolicyBinding } from "./knowledge-base-tree-policy-rollout";
import {
  executeKnowledgeBaseRetainedStartRecoveryFromCustomer,
  findKnowledgeBaseRetainedStartRecoveryReplay,
  previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance,
} from "./knowledge-base-incident-repair";
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
  KnowledgeBaseManusV2RolloutDeferredError,
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

// No authenticated knowledge-base response bypasses the customer-safe
// projection, including legacy error branches that predate observation DTOs.
router.use((_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) =>
    sendJson(toKnowledgeBasePublicPayload(body))) as typeof res.json;
  next();
});

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
  expectedResetRevision?: number;
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
    requiresUpload:
      reservation.state === "awaiting_attachments" &&
      reservation.turn.stagedUserAttachmentCount <
        reservation.turn.expectedUserAttachmentCount,
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

/**
 * Logo is a legacy-v1 correctness contract and a Manus-v2 optional resource.
 * The only v2 operation allowed to validate or bind Logo bytes is an explicit
 * manual Logo submission. Ordinary images must remain ordinary attachments.
 */
export function knowledgeBaseTurnLogoPolicy(input: {
  providerProtocol?: string | null;
  manualLogoSubmission?: boolean;
  legacyLogoRequired?: boolean;
}) {
  const manusV2 = input.providerProtocol === "manus_v2";
  const manualLogoSubmission = input.manualLogoSubmission === true;
  const requiresOfficialLogo = !manusV2 && input.legacyLogoRequired === true;
  return {
    requiresOfficialLogo,
    inferOrdinaryAttachmentAsLogo:
      requiresOfficialLogo && !manualLogoSubmission,
    validateManualLogoSubmission: manualLogoSubmission,
    readPersistedLogoSubmission: !manusV2 || manualLogoSubmission,
    acceptProviderDiscoveredLogo: !manusV2,
    assertFinalLogoProvenance: !manusV2,
    // A byte-identical copy of an already-bound Logo is always a duplicate,
    // even though v2 never requires the customer to provide Logo bytes.
    rejectRepeatedOfficialLogo: true,
  } as const;
}

export function knowledgeBasePresentationRequiresBoundLogo(input: {
  skillVersion?: string;
  revision: number;
  handled: number;
  logoRequired?: boolean;
  logoAvailable?: boolean;
}) {
  return (
    input.logoAvailable === true &&
    input.skillVersion === "4" &&
    input.revision === 0 &&
    input.handled === 0 &&
    input.logoRequired !== true
  );
}

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
  if (error.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED") return 409;
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
  loadUnboundAuthority: typeof loadKnowledgeBasePreproviderLocalRehydrateAuthority = loadKnowledgeBasePreproviderLocalRehydrateAuthority,
): Promise<{
  build: NonNullable<KnowledgeBaseBuildRecord>;
  taskId: string | null;
  kind: "bound" | "local_rehydrate_unbound";
} | null> {
  const build = await loadBuild(input.userId, input.conversationId);
  const taskId = String(build?.canonicalTaskId || build?.upstreamTaskId || "");
  if (!build) return null;
  if (taskId) return { build, taskId, kind: "bound" };
  const unboundAuthority = await loadUnboundAuthority({
    userId: input.userId,
    build,
  });
  return unboundAuthority
    ? { build, taskId: null, kind: "local_rehydrate_unbound" }
    : null;
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
  if (progress?.build.status === "ready_to_publish") {
    return {
      progress,
      interactionState: "ready_to_publish",
      canReply: false,
      canPublish: progress.packageAllowed,
      lockReason: progress.packageAllowed
        ? "知识库内容与下载包已完成，请执行唯一一次直接更新"
        : "知识库内容已完成，下载包正在后台准备；已完成正文不受影响",
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
      presentation.generation === observation.generation &&
      presentation.revision === progress.build.revision &&
      presentation.leafId === progress.build.currentLeafId,
  );
}

/**
 * Keep an immutable accepted presentation independent from optional Logo and
 * current-node resource projections. Those projections may be repaired
 * locally, but they are not writer authority and must never relock a turn that
 * the build has already made replyable.
 */
export function applyKnowledgeBasePresentationProjectionGuard(input: {
  progress: KnowledgeBaseProgressDto;
  observation: Pick<
    KnowledgeBaseObservationDto,
    | "generation"
    | "activeTurn"
    | "approvedPresentation"
    | "localRestrictions"
    | "notice"
  >;
  interaction: KnowledgeBaseInteractionDto;
}) {
  if (input.interaction.interactionState !== "awaiting_input") {
    return {
      interaction: input.interaction,
      localRestrictions: input.observation.localRestrictions,
      notice: input.observation.notice,
    };
  }

  const presentation = input.observation.approvedPresentation;
  const hasDisplayableAcceptedPresentation = Boolean(
    presentation?.visibleMarkdown.trim() && presentation.leafId.trim(),
  );
  const hasCurrentReplyAuthority = Boolean(
    hasDisplayableAcceptedPresentation &&
      input.observation.activeTurn === null &&
      presentation!.generation === input.observation.generation &&
      presentation!.revision === input.progress.build.revision &&
      presentation!.leafId === input.progress.build.currentLeafId,
  );
  if (!hasCurrentReplyAuthority) {
    return {
      interaction: {
        progress: input.progress,
        interactionState: "executing" as const,
        canReply: false,
        canPublish: false,
        lockReason: input.observation.activeTurn
          ? "FrontMind 正在完成当前操作"
          : "当前知识节点正在完成服务端展示校验",
      },
      localRestrictions: input.observation.localRestrictions,
      notice: input.observation.notice,
    };
  }

  const logoProjectionIncomplete =
    knowledgeBasePresentationRequiresBoundLogo({
      skillVersion: input.progress.build.skillVersion,
      revision: input.progress.build.revision,
      handled: input.progress.summary.handled,
      logoRequired: input.progress.build.logoRequired,
      logoAvailable: input.progress.build.logoAvailable,
    }) &&
    (presentation!.imageState !== "attached" ||
      presentation!.resources.filter((resource) => resource.kind === "logo")
        .length !== 1);
  if (!logoProjectionIncomplete) {
    return {
      interaction: input.interaction,
      localRestrictions: input.observation.localRestrictions,
      notice: input.observation.notice,
    };
  }

  return {
    interaction: input.interaction,
    localRestrictions: Array.from(
      new Set([
        ...(input.observation.localRestrictions || []),
        "logo_projection_repairing",
      ]),
    ),
    // The observation DTO has one notice slot. Never displace an existing
    // operational notice with this optional-resource projection warning.
    notice:
      input.observation.notice ||
      ({
        key: `${input.progress.build.id}:${input.progress.build.revision}:logo-projection-repairing`,
        code: "KNOWLEDGE_BASE_LOGO_PROJECTION_REPAIRING",
        severity: "warning" as const,
        message:
          "企业 Logo 展示资源正在局部恢复；已完成正文与本轮确认不受影响。",
        retryable: false,
        turnId: null,
        createdAt: input.progress.build.updatedAt,
      } satisfies NonNullable<KnowledgeBaseObservationDto["notice"]>),
  };
}

export function knowledgeBaseRetainedStartMayReplaceNotice(
  notice: KnowledgeBaseObservationDto["notice"],
) {
  if (!notice) return true;
  if (
    notice.recoveryAction === "stopped" ||
    notice.code === "FRONTMIND_KB_STOPPED"
  ) {
    return false;
  }
  return !(
    (notice.recoveryAction === "retry_request" ||
      notice.recoveryAction === "start_new_generation") &&
    typeof notice.recoveryToken === "string" &&
    /^[a-f0-9]{64}$/u.test(notice.recoveryToken)
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
    projection.activeTurn === null &&
    progress.build.revision === 0 &&
    progress.build.currentLeafId === null &&
    (progress.build.status === "failed" ||
      progress.build.status === "protocol_error") &&
    knowledgeBaseRetainedStartMayReplaceNotice(observation.notice)
  ) {
    const preview =
      await previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance({
        userId: input.userId,
        conversationId: input.conversationId,
        repairKind: "retained_upstream_create_3_start",
      }).catch(() => null);
    if (preview && preview.blockers.length === 0) {
      const requiresReselection = preview.requiresReselection.length > 0;
      observation.notice = {
        key: `${progress.build.id}:${projection.generation}:${projection.stateEpoch}:retained-start-recovery`,
        code: requiresReselection
          ? "KNOWLEDGE_BASE_START_SOURCES_RESELECTION_REQUIRED"
          : "KNOWLEDGE_BASE_START_RETAINED_SOURCES_READY",
        severity: "warning",
        message: requiresReselection
          ? "原资料已缺失或损坏，请重新上传资料后重新开始。上传完成前不会创建上游任务。"
          : "首轮任务创建结果未完成。原资料仍完整，可由你确认后建立一个新任务继续。",
        retryable: true,
        failureClass: "requires_user_fix",
        recoveryAction: requiresReselection
          ? "reselect_start_sources"
          : "resume_start_from_retained_sources",
        canRegenerate: false,
        attachmentCount: preview.userAttachmentCount,
        turnId: null,
        createdAt: progress.build.updatedAt,
      };
      observation.localRestrictions = [
        ...(observation.localRestrictions || []),
        `start_recovery_state_hash:${preview.stateHash}`,
      ];
    }
  }
  const presentationProjection = applyKnowledgeBasePresentationProjectionGuard({
    progress,
    observation,
    interaction,
  });
  interaction = presentationProjection.interaction;
  observation.localRestrictions = presentationProjection.localRestrictions;
  observation.notice = presentationProjection.notice;
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

export function knowledgeBasePreCreateUserFixObservationAllowsResume(input: {
  activeTurn: KnowledgeBaseObservationDto["activeTurn"];
  notice: KnowledgeBaseObservationDto["notice"];
  hasCredential: boolean;
}) {
  const { activeTurn, notice } = input;
  const resumableCreateBoundary =
    activeTurn?.createAttemptState === "not_sent" ||
    (activeTurn?.createAttemptState === "rejected" &&
      activeTurn.recoveryAction === "update_credential");
  return Boolean(
    activeTurn &&
      notice &&
      notice.turnId === activeTurn.id &&
      activeTurn.status === "failed" &&
      !activeTurn.upstreamTaskId &&
      activeTurn.failureClass === "requires_user_fix" &&
      activeTurn.canRegenerate === false &&
      resumableCreateBoundary &&
      notice.failureClass === "requires_user_fix" &&
      notice.canRegenerate === false &&
      notice.recoveryAction === activeTurn.recoveryAction &&
      (notice.recoveryAction === "top_up" ||
        notice.recoveryAction === "update_credential") &&
      input.hasCredential,
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
            knowledgeBaseTurnLogoPolicy({
              providerProtocol: boundBuild.providerProtocol,
            }).acceptProviderDiscoveredLogo &&
            (boundBuild.skillVersion === "4"
              ? boundBuild.totalNodeCount === 0
              : shouldBindKnowledgeBaseInitialLogo(
                  boundBuild.skillVersion,
                  collectKnowledgeBaseLogoDescriptors(unreconciled).length,
                ));
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
      providerProtocol: knowledgeBaseBuilds.providerProtocol,
      canonicalTaskId: knowledgeBaseBuilds.canonicalTaskId,
      lastOutputLength: knowledgeBaseBuilds.lastOutputLength,
      lastOutputItemIds: knowledgeBaseBuilds.lastOutputItemIds,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        or(
          isNotNull(knowledgeBaseBuilds.canonicalTaskId),
          isNotNull(knowledgeBaseBuilds.upstreamTaskId),
        ),
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
      let taskId = String(
        candidate.canonicalTaskId || candidate.upstreamTaskId || "",
      );
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
        taskId = String(build.canonicalTaskId || build.upstreamTaskId || "");
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
            if (build.providerProtocol === "manus_v2") {
              const client = new ManusV2Client({
                baseUrl,
                apiKey: credential.apiKey,
              });
              const events = await client.listAllMessages({
                taskId,
                order: "asc",
              });
              const output = normalizeManusV2Output(events);
              const taskStatus = latestManusV2TaskState(events) || "running";
              if (!shouldReconcileKnowledgeOutput(output, taskStatus)) {
                observeKnowledgeInteraction(
                  await getKnowledgeBaseProgress({
                    userId: build.userId,
                    conversationId: build.conversationId,
                  }),
                  taskStatus,
                );
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
              return;
            }
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
  skillArchive: Awaited<
    ReturnType<typeof ensureKnowledgeBaseBuildSkillArchivePin>
  >;
  stagedPrefix?: string[];
  boundUpstreamFileId?: string;
}) {
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  // Provider file ids are short-lived capabilities, not a durable Skill pin.
  // A fresh operation must upload from the locally pinned bytes. The only
  // reusable id is a candidate already reserved by this exact turn/slot.
  const reusableUpstreamFileId = null;
  const uploaded = await uploadKnowledgeBaseSkillArchive({
    baseUrl: input.baseUrl,
    apiKey: input.credential.apiKey,
    skillVersion: input.skillVersion,
    skillContentHash: input.skillContentHash,
    archive: input.skillArchive,
    reusableUpstreamFileId,
    providerProtocol: input.claim.turn.providerProtocol,
    durable: {
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      attachmentIndex: input.stagedPrefix?.length ?? 0,
    },
  });
  if (
    input.boundUpstreamFileId &&
    uploaded.fileId !== input.boundUpstreamFileId &&
    input.claim.turn.providerProtocol !== "manus_v2"
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
  if (input.claim.turn.providerProtocol !== "manus_v2") {
    await recordUpstreamResource({
      userId: input.claim.turn.userId,
      apiCredentialId: input.credential.id,
      kind: "file",
      upstreamId: uploaded.fileId,
    });
  }
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
  const { claim, credential } = input;
  const buildId = claim.turn.buildId;
  if (!buildId) {
    throw new Error("Recovery turn is not bound to a knowledge-base build");
  }
  const skillArchive = await ensureKnowledgeBaseBuildSkillArchivePin({
    userId: claim.turn.userId,
    buildId,
    generation: claim.turn.buildGeneration,
  });
  const pinnedBuild = await loadKnowledgeBaseBuildRecordById(
    claim.turn.userId,
    buildId,
  );
  if (!pinnedBuild || pinnedBuild.generation !== claim.turn.buildGeneration) {
    throw new Error("Recovery build identity changed");
  }
  const recordedSkillVersion = recoveryString(
    claim.recoveryMetadata,
    "skillVersion",
    pinnedBuild.skillVersion,
  );
  const recordedSkillContentHash =
    recoveryString(
      claim.recoveryMetadata,
      "skillContentHash",
      pinnedBuild.skillContentHash || "",
    ) || null;
  if (
    recordedSkillVersion !== pinnedBuild.skillVersion ||
    recordedSkillContentHash !== (pinnedBuild.skillContentHash || null) ||
    skillArchive.contentHash !== (pinnedBuild.skillContentHash || "")
  ) {
    throw new Error("Recovery Skill logical pin does not match the build");
  }
  claim.recoveryMetadata = {
    ...claim.recoveryMetadata,
    skillVersion: pinnedBuild.skillVersion,
    skillContentHash: pinnedBuild.skillContentHash,
    skillArchiveSha256: skillArchive.physicalSha256,
    skillArchiveBytes: skillArchive.archiveBytes,
    skillArchiveStorageKey: skillArchive.storageKey,
  };
  if (claim.preparedDispatch) return claim.preparedDispatch;
  const recovery = claim.recoveryMetadata;
  const kind = recoveryString(recovery, "kind");
  const conversationId = recoveryString(recovery, "conversationId");
  const skillVersion = pinnedBuild.skillVersion;
  const skillContentHash = pinnedBuild.skillContentHash || null;
  const finalPackageRequired = recovery.finalPackageRequired === true;
  const providerPackageRequired =
    finalPackageRequired && claim.turn.providerProtocol !== "manus_v2";
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
  if (kind === "turn") {
    const parentTaskId =
      recoveryString(recovery, "retryParentTaskId") ||
      recoveryString(recovery, "parentTaskId");
    const localRehydrateRequired = Boolean(
      claim.turn.providerProtocol === "manus_v2" &&
        !pinnedBuild.canonicalTaskId &&
        pinnedBuild.handoffProvenance &&
        typeof pinnedBuild.handoffProvenance === "object" &&
        !Array.isArray(pinnedBuild.handoffProvenance) &&
        pinnedBuild.handoffProvenance.localRehydrateRequired,
    );
    const userMessage = recoveryString(recovery, "userMessage");
    const attachmentManifest = Array.isArray(recovery.attachmentManifest)
      ? normalizeKnowledgeBaseClientAttachmentManifest(
          recovery.attachmentManifest,
        )
      : undefined;
    const recoveryLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: claim.turn.providerProtocol,
      manualLogoSubmission: recovery.manualLogoSubmission === true,
      legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(pinnedBuild),
    });
    let officialLogoUpload = recoveryLogoPolicy.readPersistedLogoSubmission
      ? recoveryOfficialLogoUpload(recovery)
      : undefined;
    const pendingManualLogoUpload =
      recovery.manualLogoSubmission === true
        ? recoveryPendingOfficialLogoUpload(recovery)
        : undefined;
    if (!conversationId || (!parentTaskId && !localRehydrateRequired)) {
      throw new Error("Turn recovery metadata is incomplete");
    }
    if (!officialLogoUpload && !pendingManualLogoUpload) {
      if (
        pinnedBuild.id === claim.turn.buildId &&
        recoveryLogoPolicy.inferOrdinaryAttachmentAsLogo
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
      skillArchive,
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
    if (providerPackageRequired) {
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
        providerProtocol: claim.turn.providerProtocol,
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
      if (claim.turn.providerProtocol !== "manus_v2") {
        await recordUpstreamResource({
          userId: claim.turn.userId,
          apiCredentialId: credential.id,
          kind: "file",
          upstreamId: uploaded.fileId,
        });
      }
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
    if (providerPackageRequired) {
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
        contentCompletionOnly:
          finalPackageRequired && claim.turn.providerProtocol === "manus_v2",
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
          providerProtocol: claim.turn.providerProtocol,
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
        instructionFileId !== boundInstructionFileId &&
        claim.turn.providerProtocol !== "manus_v2"
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
      if (claim.turn.providerProtocol !== "manus_v2") {
        await recordUpstreamResource({
          userId: claim.turn.userId,
          apiCredentialId: credential.id,
          kind: "file",
          upstreamId: instructionFileId,
        });
      }
      generatedAttachments.push({
        file_id: instructionFileId,
        filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
      });
      prompt = instructionDelivery.prompt;
    }
    const attachments = providerPackageRequired
      ? [...generatedAttachments, ...userAttachments]
      : deferredClientAttachments
        ? [...userAttachments, ...generatedAttachments]
        : [...generatedAttachments, ...userAttachments];
    // A v2 operation freezes this ordered source ledger, then the v2
    // attachment mapper uploads exclusively from Dashboard-retained bytes.
    // Historical v1 ids may be 404 and are not a v2 correctness dependency.
    const readyAttachments =
      claim.turn.providerProtocol === "manus_v2"
        ? attachments
        : await waitForKnowledgeBaseDispatchAttachments({
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
    skillArchive,
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
      providerProtocol: claim.turn.providerProtocol,
      durable: {
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentIndex: 1,
        role: "prefill",
      },
    });
    const prefillFileId = uploaded.fileId;
    if (
      stagedIds[1] &&
      prefillFileId !== stagedIds[1] &&
      claim.turn.providerProtocol !== "manus_v2"
    ) {
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
    if (claim.turn.providerProtocol !== "manus_v2") {
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: prefillFileId,
      });
    }
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
      providerProtocol: claim.turn.providerProtocol,
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
    instructionFileId !== stagedIds[instructionIndex] &&
    claim.turn.providerProtocol !== "manus_v2"
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
  if (claim.turn.providerProtocol !== "manus_v2") {
    await recordUpstreamResource({
      userId: claim.turn.userId,
      apiCredentialId: credential.id,
      kind: "file",
      upstreamId: instructionFileId,
    });
  }
  generatedAttachments.push({
    file_id: instructionFileId,
    filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
  });
  const attachments = [...generatedAttachments, ...userAttachments];
  const readyAttachments =
    claim.turn.providerProtocol === "manus_v2"
      ? attachments
      : await waitForKnowledgeBaseDispatchAttachments({
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
  if (claim.turn.providerProtocol === "manus_v2") {
    const client = new ManusV2Client({
      baseUrl,
      apiKey: credential.apiKey,
    });
    const events = await client.listAllMessages({ taskId, order: "asc" });
    const status = latestManusV2TaskState(events) || "running";
    const build = await loadKnowledgeBaseBuildRecordById(
      claim.turn.userId,
      claim.turn.buildId,
    );
    if (!build || build.generation !== claim.turn.buildGeneration) return false;
    const contract = manusV2ContractForTurn({ claim, build });
    const lifecycle = await reconcileKnowledgeBaseManusV2Lifecycle({
      claim,
      build,
      client,
      taskId,
      events,
      contract,
    });
    if (lifecycle.kind !== "stopped") return false;
    let output: Awaited<
      ReturnType<typeof normalizeManusV2KnowledgeBaseOperationOutput>
    >;
    try {
      output = await normalizeManusV2KnowledgeBaseOperationOutput({
        events,
        contract,
        taskStatus: status,
        allowAssistantProtocolFallback:
          manusV2ClaimProvesFrozenDispatchAttribution({ claim, taskId }),
        build,
        expectedUploadsRead: build.lastTurnAttachmentCount,
      });
    } catch (error) {
      if (
        !(
          error instanceof ManusV2ApiError &&
          isRepairableKnowledgeBaseManusV2FormatCode(error.code)
        )
      ) {
        throw error;
      }
      await repairStoppedManusV2KnowledgeBaseFormat({
        claim,
        client,
        taskId,
        events,
        contract,
      });
      return false;
    }
    // A stopped v2 task without the exact structured result is not a valid
    // business result. Keep polling/repairing this build locally instead of
    // handing an empty terminal payload to the legacy protocol-error path.
    if (
      output.length === 0 ||
      !shouldReconcileKnowledgeOutput(output, status)
    ) {
      await repairStoppedManusV2KnowledgeBaseFormat({
        claim,
        client,
        taskId,
        events,
        contract,
      });
      return false;
    }
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

function manusV2ContractForTurn(input: {
  claim: KnowledgeBaseRecoveryClaim;
  build: NonNullable<
    Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecordById>>
  >;
}): ManusV2KnowledgeBaseOperationContract {
  const { claim, build } = input;
  const action = claim.turn.operationType;
  const expectContentCompleted =
    claim.recoveryMetadata.finalPackageRequired === true ||
    knowledgeBaseTurnRequiresFinalPackage({
      skillVersion: build.skillVersion,
      currentLeafId: build.currentLeafId,
      totalNodeCount: build.totalNodeCount,
      confirmedCount: build.confirmedCount,
      directPrefilledCount: build.directPrefilledCount,
      action:
        action === "start" ||
        action === "retry" ||
        action === "legacy_reconcile"
          ? "initial"
          : action,
    });
  return {
    operationToken: claim.turn.operationToken,
    turnId: claim.turn.id,
    generation: claim.turn.buildGeneration,
    baseRevision: claim.turn.expectedRevision,
    action,
    fromLeafId: claim.turn.expectedLeafId,
    expectContentCompleted,
    requiresManifest: build.totalNodeCount === 0,
  };
}

function manusV2ClaimProvesFrozenDispatchAttribution(input: {
  claim: KnowledgeBaseRecoveryClaim;
  taskId: string;
}) {
  const { claim } = input;
  const prepared = claim.preparedDispatch;
  const method = claim.turn.providerMethod;
  const providerState = claim.turn.providerAttemptState;
  return Boolean(
    claim.turn.providerProtocol === "manus_v2" &&
      claim.turn.attachmentsFrozen &&
      prepared &&
      prepared.schemaVersion === 2 &&
      prepared.bodySha256 ===
        hashKnowledgeBaseTurnRequest(prepared.requestBody) &&
      typeof claim.turn.operationToken === "string" &&
      claim.turn.operationToken.length > 0 &&
      method === "task.sendMessage" &&
      claim.turn.upstreamTaskId === input.taskId &&
      ["sending", "outcome_unknown", "output_pending"].includes(
        providerState || "",
      ),
  );
}

function manusV2TurnProvesAcknowledgedAttribution(input: {
  turn: {
    providerProtocol: string;
    providerMethod: string | null;
    providerAttemptState: string | null;
    upstreamTaskId: string | null;
    attachmentsFrozen: boolean;
  };
  taskId: string;
}) {
  return Boolean(
    input.turn.providerProtocol === "manus_v2" &&
      input.turn.providerMethod === "task.sendMessage" &&
      input.turn.providerAttemptState === "output_pending" &&
      input.turn.upstreamTaskId === input.taskId &&
      input.turn.attachmentsFrozen,
  );
}

async function reconcileKnowledgeBaseManusV2Lifecycle(input: {
  claim: KnowledgeBaseRecoveryClaim;
  build: NonNullable<
    Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecordById>>
  >;
  client: ManusV2Client;
  taskId: string;
  events: Parameters<typeof classifyKnowledgeBaseManusV2Lifecycle>[0]["events"];
  contract: ManusV2KnowledgeBaseOperationContract;
  dependencies?: {
    mutateLifecycle?: typeof mutateKnowledgeBaseManusV2Lifecycle;
    markAttention?: typeof markKnowledgeBaseManusV2AttentionRequired;
  };
}) {
  const mutateLifecycle =
    input.dependencies?.mutateLifecycle ?? mutateKnowledgeBaseManusV2Lifecycle;
  const markAttention =
    input.dependencies?.markAttention ??
    markKnowledgeBaseManusV2AttentionRequired;
  let lifecycleLedger = input.claim.turn.manusV2Lifecycle;
  if (
    (lifecycleLedger.waitingAttemptState === "sending" ||
      lifecycleLedger.waitingAttemptState === "outcome_unknown") &&
    lifecycleLedger.waitingEventId &&
    lifecycleLedger.waitingEventType &&
    lifecycleLedger.waitingRequestHash &&
    (lifecycleLedger.waitingAction === "ask_user_continue" ||
      lifecycleLedger.waitingAction === "confirm_safe")
  ) {
    const priorAttempt = classifyKnowledgeBaseManusV2WaitingAttempt({
      attemptState: lifecycleLedger.waitingAttemptState,
      action: lifecycleLedger.waitingAction,
      eventId: lifecycleLedger.waitingEventId,
      statusEventId: lifecycleLedger.waitingStatusEventId,
      continuationToken: lifecycleLedger.waitingContinuationToken,
      events: input.events,
    });
    if (priorAttempt === "adopt") {
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "waiting",
          eventId: lifecycleLedger.waitingEventId,
          eventType: lifecycleLedger.waitingEventType,
          statusEventId: lifecycleLedger.waitingStatusEventId,
          action: lifecycleLedger.waitingAction,
          requestHash: lifecycleLedger.waitingRequestHash,
          continuationToken: lifecycleLedger.waitingContinuationToken,
          state: "acknowledged",
        },
      });
      lifecycleLedger = {
        ...lifecycleLedger,
        waitingAttemptState: "acknowledged",
      };
    } else if (priorAttempt === "attention_required") {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_WAITING_RESPONSE_UNPROVEN",
        waitingEventId: lifecycleLedger.waitingEventId,
        waitingEventType: lifecycleLedger.waitingEventType,
      });
      return {
        kind: "attention_required" as const,
        taskStatus: "waiting" as const,
        code: "MANUS_V2_WAITING_RESPONSE_UNPROVEN",
        eventId: lifecycleLedger.waitingEventId,
        eventType: lifecycleLedger.waitingEventType,
      };
    }
  }
  const decision = classifyKnowledgeBaseManusV2Lifecycle({
    events: input.events,
    contract: input.contract,
  });
  if (decision.kind === "poll" || decision.kind === "stopped") {
    return decision;
  }
  if (decision.kind === "attention_required") {
    if (
      input.claim.turn.manusV2Lifecycle.attentionCode === decision.code &&
      (!decision.eventId ||
        input.claim.turn.manusV2Lifecycle.waitingEventId === decision.eventId)
    ) {
      return decision;
    }
    await markAttention({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: decision.code,
      waitingEventId: decision.eventId,
      waitingEventType: decision.eventType,
    });
    return decision;
  }
  if (decision.kind === "recover_error") {
    const existing = input.claim.turn.manusV2Lifecycle;
    if (
      existing.errorRecoveryToken &&
      (existing.errorRecoveryToken !== decision.recoveryToken ||
        existing.errorRecoveryRequestHash !== decision.requestHash)
    ) {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_ERROR_RECOVERY_CONFLICT",
      });
      return {
        kind: "attention_required" as const,
        taskStatus: "error" as const,
        code: "MANUS_V2_ERROR_RECOVERY_CONFLICT",
      };
    }
    const attempt = classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
      attemptState: existing.errorRecoveryAttemptState,
      recoveryToken: decision.recoveryToken,
      events: input.events,
      nextRetryAt: existing.errorRecoveryNextRetryAt,
    });
    if (attempt === "adopt") {
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "error_recovery",
          recoveryToken: decision.recoveryToken,
          requestHash: decision.requestHash,
          state: "acknowledged",
        },
      });
      return decision;
    }
    if (attempt === "wait") return decision;
    if (attempt === "attention_required") {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_ERROR_RECOVERY_REJECTED",
      });
      return {
        kind: "attention_required" as const,
        taskStatus: "error" as const,
        code: "MANUS_V2_ERROR_RECOVERY_REJECTED",
      };
    }
    await mutateLifecycle({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      mutation: {
        kind: "error_recovery",
        recoveryToken: decision.recoveryToken,
        requestHash: decision.requestHash,
        state: "sending",
      },
    });
    try {
      const sent = await input.client.sendMessage({
        taskId: input.taskId,
        prompt: decision.prompt,
        structuredOutputSchema: buildManusV2KnowledgeBaseStructuredOutputSchema(
          input.contract,
        ),
      });
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "error_recovery",
          recoveryToken: decision.recoveryToken,
          requestHash: decision.requestHash,
          state: "acknowledged",
          requestId: sent.requestId,
        },
      });
      return decision;
    } catch (error) {
      if (error instanceof ManusV2ApiError) {
        const rejection = error.outcomeUnknown
          ? null
          : knowledgeBaseManusV2ErrorRecoveryRejection({
              previousCount: existing.errorRecoveryRejectionCount,
              retryable: error.retryable,
              retryAfterMs: error.retryAfterMs,
              recoveryToken: decision.recoveryToken,
            });
        const state = error.outcomeUnknown
          ? "outcome_unknown"
          : rejection?.retry
            ? "retry_wait"
            : "rejected";
        await mutateLifecycle({
          userId: input.claim.turn.userId,
          turnId: input.claim.turn.id,
          leaseToken: input.claim.leaseToken,
          mutation: {
            kind: "error_recovery",
            recoveryToken: decision.recoveryToken,
            requestHash: decision.requestHash,
            state,
            requestId: error.providerRequestId,
            ...(rejection?.retry ? { retryAfterMs: rejection.delayMs } : {}),
          },
        });
        if (rejection?.retry) return decision;
        if (!error.outcomeUnknown) {
          await markAttention({
            userId: input.claim.turn.userId,
            turnId: input.claim.turn.id,
            leaseToken: input.claim.leaseToken,
            code: "MANUS_V2_ERROR_RECOVERY_REJECTED",
          });
          return {
            kind: "attention_required" as const,
            taskStatus: "error" as const,
            code: "MANUS_V2_ERROR_RECOVERY_REJECTED",
          };
        }
        // The POST may have succeeded. Keep this operation read-only until
        // task history exposes the exact recovery token; never route the lost
        // response through the ordinary business-send retry path.
        return decision;
      }
      throw error;
    }
  }
  const existing = lifecycleLedger;
  const sameWaitingEvent = existing.waitingEventId === decision.eventId;
  if (existing.waitingEventId && !sameWaitingEvent) {
    if (
      existing.waitingAttemptState !== "acknowledged" ||
      !manusV2WaitingEventIsStrictSuccessor({
        events: input.events,
        previousEventId: existing.waitingEventId,
        previousStatusEventId: existing.waitingStatusEventId,
        nextEventId: decision.eventId,
        nextStatusEventId: decision.statusEventId,
      })
    ) {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_WAITING_EVENT_CONFLICT",
        waitingEventId: decision.eventId,
        waitingEventType: decision.eventType,
      });
      return {
        kind: "attention_required" as const,
        taskStatus: "waiting" as const,
        code: "MANUS_V2_WAITING_EVENT_CONFLICT",
        eventId: decision.eventId,
        eventType: decision.eventType,
      };
    }
  }
  if (sameWaitingEvent) {
    const attempt = classifyKnowledgeBaseManusV2WaitingAttempt({
      attemptState: existing.waitingAttemptState,
      action: decision.kind,
      eventId: decision.eventId,
      statusEventId: existing.waitingStatusEventId || decision.statusEventId,
      continuationToken:
        existing.waitingContinuationToken ||
        (decision.kind === "ask_user_continue"
          ? decision.continuationToken
          : undefined),
      events: input.events,
    });
    if (attempt === "settled") return decision;
    if (attempt === "adopt") {
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "waiting",
          eventId: decision.eventId,
          eventType: decision.eventType,
          statusEventId: decision.statusEventId,
          action: decision.kind,
          requestHash: decision.requestHash,
          continuationToken:
            decision.kind === "ask_user_continue"
              ? decision.continuationToken
              : undefined,
          state: "acknowledged",
        },
      });
      return decision;
    }
    if (attempt === "wait") return decision;
    await markAttention({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: "MANUS_V2_WAITING_RESPONSE_UNPROVEN",
      waitingEventId: decision.eventId,
      waitingEventType: decision.eventType,
    });
    return {
      kind: "attention_required" as const,
      taskStatus: "waiting" as const,
      code: "MANUS_V2_WAITING_RESPONSE_UNPROVEN",
      eventId: decision.eventId,
      eventType: decision.eventType,
    };
  }
  await mutateLifecycle({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    mutation: {
      kind: "waiting",
      eventId: decision.eventId,
      eventType: decision.eventType,
      statusEventId: decision.statusEventId,
      action: decision.kind,
      requestHash: decision.requestHash,
      continuationToken:
        decision.kind === "ask_user_continue"
          ? decision.continuationToken
          : undefined,
      supersedesEventId:
        existing.waitingAttemptState === "acknowledged"
          ? existing.waitingEventId
          : undefined,
      state: "sending",
    },
  });
  try {
    const result =
      decision.kind === "ask_user_continue"
        ? await input.client.sendMessage({
            taskId: input.taskId,
            prompt: decision.prompt,
            structuredOutputSchema:
              buildManusV2KnowledgeBaseStructuredOutputSchema(input.contract),
          })
        : await input.client.confirmAction({
            taskId: input.taskId,
            eventId: decision.eventId,
            confirmationInput: decision.confirmationInput,
          });
    await mutateLifecycle({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      mutation: {
        kind: "waiting",
        eventId: decision.eventId,
        eventType: decision.eventType,
        statusEventId: decision.statusEventId,
        action: decision.kind,
        requestHash: decision.requestHash,
        continuationToken:
          decision.kind === "ask_user_continue"
            ? decision.continuationToken
            : undefined,
        state: "acknowledged",
        requestId: result.requestId,
      },
    });
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "waiting",
          eventId: decision.eventId,
          eventType: decision.eventType,
          statusEventId: decision.statusEventId,
          action: decision.kind,
          requestHash: decision.requestHash,
          continuationToken:
            decision.kind === "ask_user_continue"
              ? decision.continuationToken
              : undefined,
          state: "outcome_unknown",
        },
      });
    }
    throw error;
  }
  return decision;
}

async function repairStoppedManusV2KnowledgeBaseFormat(input: {
  claim: KnowledgeBaseRecoveryClaim;
  client: ManusV2Client;
  taskId: string;
  events: Parameters<typeof buildKnowledgeBaseManusV2FormatRepair>[0]["events"];
  contract: ManusV2KnowledgeBaseOperationContract;
  dependencies?: {
    mutateLifecycle?: typeof mutateKnowledgeBaseManusV2Lifecycle;
    markAttention?: typeof markKnowledgeBaseManusV2AttentionRequired;
  };
}) {
  const mutateLifecycle =
    input.dependencies?.mutateLifecycle ?? mutateKnowledgeBaseManusV2Lifecycle;
  const markAttention =
    input.dependencies?.markAttention ??
    markKnowledgeBaseManusV2AttentionRequired;
  const existing = input.claim.turn.manusV2Lifecycle;
  if (existing.formatRepairAttemptState) {
    const deadlineAt = Date.parse(existing.formatRepairDeadlineAt || "");
    if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_FORMAT_REPAIR_EXPIRED",
      });
      return false;
    }
    const repair = buildKnowledgeBaseManusV2FormatRepair({
      contract: input.contract,
      events: input.events,
    });
    if (
      !repair ||
      existing.formatRepairToken !== repair.repairToken ||
      existing.formatRepairRequestHash !== repair.requestHash
    ) {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_FORMAT_REPAIR_CONFLICT",
      });
      return false;
    }
    const attempt = classifyKnowledgeBaseManusV2FormatRepairAttempt({
      attemptState: existing.formatRepairAttemptState,
      repairToken: repair.repairToken,
      events: input.events,
    });
    if (attempt === "adopt") {
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "format_repair",
          repairToken: repair.repairToken,
          requestHash: repair.requestHash,
          state: "acknowledged",
        },
      });
    }
    if (attempt === "attention_required") {
      await markAttention({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: "MANUS_V2_FORMAT_REPAIR_UNPROVEN",
      });
      return false;
    }
    // This helper is reached only after the currently visible structured
    // result was rejected. Once the exact repair message is acknowledged (or
    // adopted from history), another invalid result exhausts the one repair.
    await markAttention({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: "MANUS_V2_FORMAT_REPAIR_EXHAUSTED",
    });
    return false;
  }
  const repair = buildKnowledgeBaseManusV2FormatRepair({
    contract: input.contract,
    events: input.events,
  });
  await mutateLifecycle({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    mutation: {
      kind: "format_repair",
      repairToken: repair.repairToken,
      requestHash: repair.requestHash,
      state: "sending",
    },
  });
  try {
    const sent = await input.client.sendMessage({
      taskId: input.taskId,
      prompt: repair.prompt,
      structuredOutputSchema: buildManusV2KnowledgeBaseStructuredOutputSchema(
        input.contract,
      ),
    });
    await mutateLifecycle({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      mutation: {
        kind: "format_repair",
        repairToken: repair.repairToken,
        requestHash: repair.requestHash,
        state: "acknowledged",
        requestId: sent.requestId,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
      await mutateLifecycle({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        mutation: {
          kind: "format_repair",
          repairToken: repair.repairToken,
          requestHash: repair.requestHash,
          state: "outcome_unknown",
        },
      });
    }
    throw error;
  }
}

export const knowledgeBaseManusV2LifecycleTestHooks = {
  reconcile: reconcileKnowledgeBaseManusV2Lifecycle,
  repairFormat: repairStoppedManusV2KnowledgeBaseFormat,
};

type ManusV2AssistantProtocolFallback = {
  event: Parameters<typeof normalizeManusV2Output>[0][number];
  text: string;
};

/**
 * Structured extraction can fail after Manus has already emitted the exact
 * closed Dashboard protocol response in an assistant message. Accept that
 * message only for a non-initial stopped operation and only when one unique
 * assistant event proves every frozen coordinate. The ordinary progress
 * transaction remains the final CAS and content validator.
 */
export function manusV2KnowledgeBaseAssistantProtocolFallback(input: {
  events: Parameters<typeof normalizeManusV2Output>[0];
  contract: ManusV2KnowledgeBaseOperationContract;
  taskStatus: string;
}): ManusV2AssistantProtocolFallback | null {
  if (
    input.taskStatus !== "stopped" ||
    input.contract.requiresManifest ||
    input.contract.expectContentCompleted
  ) {
    return null;
  }
  const expectedTransition =
    input.contract.action === "confirm"
      ? "confirmed"
      : input.contract.action === "direct_prefill"
        ? "direct_prefilled"
        : input.contract.action === "revise"
          ? "needs_verification"
          : null;
  if (!expectedTransition || !input.contract.fromLeafId) return null;

  const candidates = input.events.flatMap((event) => {
    if (event.type !== "assistant_message") return [];
    const message =
      event.assistant_message &&
      typeof event.assistant_message === "object" &&
      !Array.isArray(event.assistant_message)
        ? (event.assistant_message as Record<string, unknown>)
        : null;
    const text =
      typeof message?.content === "string" ? message.content.trim() : "";
    if (!text || text.length > 4_000_000) return [];
    try {
      const progressMarkers = text.match(
        /<!--\s*FRONTMIND_KB_PROGRESS\b[\s\S]*?-->/giu,
      );
      const presentationMarkers = text.match(
        /<!--\s*FRONTMIND_KB_PRESENTATION\b[\s\S]*?-->/giu,
      );
      const protocolMarkers = text.match(
        /<!--\s*FRONTMIND_KB_[A-Z_]+\b[\s\S]*?-->/giu,
      );
      if (
        progressMarkers?.length !== 1 ||
        presentationMarkers?.length !== 1 ||
        protocolMarkers?.length !== 2
      ) {
        return [];
      }
      const progress = parseKnowledgeBaseProgressEnvelope(text);
      const presentation = parseKnowledgeBasePresentationEnvelope(text);
      if (
        progress.schemaVersion !== KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION ||
        presentation.schemaVersion !==
          KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION ||
        progress.operationId !== input.contract.operationToken ||
        presentation.operationId !== input.contract.operationToken ||
        progress.turnId !== input.contract.turnId ||
        presentation.turnId !== input.contract.turnId ||
        progress.revision !== input.contract.baseRevision ||
        presentation.revision !== input.contract.baseRevision + 1 ||
        progress.transition.leafId !== input.contract.fromLeafId ||
        progress.transition.to !== expectedTransition ||
        !presentation.leafId ||
        presentation.leafId === input.contract.fromLeafId ||
        presentation.imageState !== "no_eligible_asset" ||
        presentation.imageCount !== 0 ||
        presentation.assetIds?.length !== 0
      ) {
        return [];
      }
      const visibleMarkdown = text
        .replace(
          /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN|PRESENTATION)\b[\s\S]*?-->/giu,
          "",
        )
        .trim();
      if (!visibleMarkdown) return [];
      return [{ event, text }];
    } catch {
      return [];
    }
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export async function normalizeManusV2KnowledgeBaseOperationOutput(input: {
  events: Parameters<typeof normalizeManusV2Output>[0];
  contract: ManusV2KnowledgeBaseOperationContract;
  taskStatus?: string;
  allowAssistantProtocolFallback?: boolean;
  build: NonNullable<
    Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecordById>>
  >;
  expectedUploadsRead: number;
}) {
  const structuredResult = manusV2KnowledgeBaseStructuredResultForOperation(
    input.events,
    input.contract,
  );
  const fallback = structuredResult
    ? null
    : input.allowAssistantProtocolFallback === false
      ? null
      : manusV2KnowledgeBaseAssistantProtocolFallback({
          events: input.events,
          contract: input.contract,
          taskStatus: input.taskStatus || "running",
        });
  if (!structuredResult && !fallback) return [];
  if (fallback) {
    return [
      {
        id: fallback.event.id,
        role: "assistant" as const,
        text: fallback.text,
        content: fallback.text,
        timestamp: fallback.event.timestamp,
        files: [],
      },
    ];
  }
  const result = structuredResult!;
  if (
    !input.contract.requiresManifest &&
    !input.contract.expectContentCompleted
  ) {
    const visibleMarkdown = result.value.visibleMarkdown.trim();
    if (!visibleMarkdown) {
      throw new ManusV2ApiError(
        "structured_output",
        502,
        "EMPTY_CORE_CONTENT",
        false,
        false,
      );
    }
  }
  const coreOutput = normalizeManusV2Output(input.events, input.contract);
  const value = result.value;
  let machinePayload: string;
  if (input.contract.requiresManifest) {
    let manifestValue: unknown;
    try {
      manifestValue = parseExactJson(value.manifestJson!);
    } catch {
      throw new ManusV2ApiError(
        "structured_output",
        502,
        "INVALID_MANIFEST_JSON",
        false,
        false,
      );
    }
    const raw =
      manifestValue &&
      typeof manifestValue === "object" &&
      !Array.isArray(manifestValue)
        ? (manifestValue as Record<string, unknown>)
        : {};
    const manifest = validateKnowledgeBaseManifestForTreePolicy(
      parseKnowledgeBaseManifestEnvelope({
        kind: KNOWLEDGE_BASE_MANIFEST_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        leaves: raw.leaves,
        ...(raw.officialLogo === undefined
          ? {}
          : { officialLogo: raw.officialLogo }),
        ...(raw.researchCoverage === undefined
          ? {}
          : { researchCoverage: raw.researchCoverage }),
      }),
      input.build.treePolicyVersion,
      { expectedUploadsRead: input.expectedUploadsRead },
    );
    if (value.nextLeafId !== manifest.leaves[0]?.id) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "NEXT_LEAF_CONFLICT",
        false,
        false,
      );
    }
    machinePayload = [
      formatKnowledgeBaseManifestEnvelope(manifest),
      formatKnowledgeBasePresentationEnvelope({
        kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        revision: 0,
        leafId: value.nextLeafId,
        imageState: "no_eligible_asset",
        assetIds: [],
        imageCount: 0,
      }),
    ].join("\n\n");
  } else {
    const db = await getDb();
    if (!db) throw new Error("Database is unavailable for Manus v2 reconcile");
    const nodes = await db
      .select({
        leafId: knowledgeBaseBuildNodes.leafId,
        ordinal: knowledgeBaseBuildNodes.ordinal,
        status: knowledgeBaseBuildNodes.status,
      })
      .from(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, input.build.id))
      .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
    const currentIndex = nodes.findIndex(
      (node) => node.leafId === input.contract.fromLeafId,
    );
    const currentNode = currentIndex >= 0 ? nodes[currentIndex] : null;
    if (!currentNode) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "FROM_LEAF_CONFLICT",
        false,
        false,
      );
    }
    const transitionTarget =
      input.contract.action === "confirm"
        ? "confirmed"
        : input.contract.action === "direct_prefill"
          ? "direct_prefilled"
          : "needs_verification";
    const serverNextLeafId =
      transitionTarget === "needs_verification"
        ? currentNode.leafId
        : nodes
            .slice(currentIndex + 1)
            .find((node) => node.status === "pending")?.leafId || null;
    if (value.nextLeafId !== serverNextLeafId) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "NEXT_LEAF_CONFLICT",
        false,
        false,
      );
    }
    if (input.contract.expectContentCompleted !== (serverNextLeafId === null)) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "COMPLETION_COORDINATE_CONFLICT",
        false,
        false,
      );
    }
    machinePayload = [
      formatKnowledgeBaseProgressEnvelope({
        kind: KNOWLEDGE_BASE_PROGRESS_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        revision: input.contract.baseRevision,
        transition: {
          leafId: input.contract.fromLeafId!,
          from:
            currentNode.status === "needs_verification"
              ? "needs_verification"
              : "current",
          to: transitionTarget,
          reason: "Dashboard accepted core Manus v2 result",
        },
      }),
      formatKnowledgeBasePresentationEnvelope({
        kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        revision: input.contract.baseRevision + 1,
        leafId: serverNextLeafId,
        imageState:
          serverNextLeafId === null ? "not_applicable" : "no_eligible_asset",
        assetIds: [],
        imageCount: 0,
      }),
    ].join("\n\n");
  }
  return coreOutput.map((entry) => {
    const record = entry as Record<string, unknown>;
    const text = [value.visibleMarkdown, machinePayload]
      .filter(Boolean)
      .join("\n\n");
    return { ...record, text, content: text };
  });
}

async function reconcilePolledManusV2KnowledgeBaseTask(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  apiKey: string;
  baseUrl: string;
  build: NonNullable<
    Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecordById>>
  >;
}) {
  const client = new ManusV2Client({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
  const events = await client.listAllMessages({
    taskId: input.taskId,
    order: "asc",
  });
  const taskStatus = latestManusV2TaskState(events) || "running";
  if (!input.build.activeTurnId) {
    return { taskStatus, progress: null };
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable for Manus v2 reconcile");
  const activeTurn = (
    await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.id, input.build.activeTurnId),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, input.build.id),
          eq(conversationTurns.buildGeneration, input.build.generation),
        ),
      )
      .limit(1)
  )[0];
  if (
    !activeTurn?.operationKey ||
    !activeTurn.operationType ||
    activeTurn.buildGeneration === null ||
    activeTurn.expectedRevision === null
  ) {
    return { taskStatus, progress: null };
  }
  const allowedActions = new Set<
    ManusV2KnowledgeBaseOperationContract["action"]
  >([
    "start",
    "confirm",
    "direct_prefill",
    "revise",
    "retry",
    "legacy_reconcile",
  ]);
  const action = activeTurn.operationType as
    | ManusV2KnowledgeBaseOperationContract["action"]
    | undefined;
  if (!action || !allowedActions.has(action)) {
    return { taskStatus, progress: null };
  }
  const metadata =
    activeTurn.metadata &&
    typeof activeTurn.metadata === "object" &&
    !Array.isArray(activeTurn.metadata)
      ? (activeTurn.metadata as Record<string, unknown>)
      : {};
  if (metadata.repairKind === "legacy_anchor_handoff") {
    // The migration reservation owns only task anchoring. Provider output from
    // it is never a business transition and must not enter progress reconcile.
    return { taskStatus, progress: null };
  }
  const recovery =
    metadata.recovery &&
    typeof metadata.recovery === "object" &&
    !Array.isArray(metadata.recovery)
      ? (metadata.recovery as Record<string, unknown>)
      : {};
  const operationToken =
    typeof metadata.operationToken === "string" && metadata.operationToken
      ? metadata.operationToken
      : activeTurn.operationKey;
  const contract: ManusV2KnowledgeBaseOperationContract = {
    operationToken,
    turnId: activeTurn.id,
    generation: activeTurn.buildGeneration,
    baseRevision: activeTurn.expectedRevision,
    action,
    fromLeafId: activeTurn.expectedLeafId,
    expectContentCompleted:
      recovery.finalPackageRequired === true ||
      knowledgeBaseTurnRequiresFinalPackage({
        skillVersion: input.build.skillVersion,
        currentLeafId: input.build.currentLeafId,
        totalNodeCount: input.build.totalNodeCount,
        confirmedCount: input.build.confirmedCount,
        directPrefilledCount: input.build.directPrefilledCount,
        action:
          action === "start" ||
          action === "retry" ||
          action === "legacy_reconcile"
            ? "initial"
            : action,
      }),
    requiresManifest: input.build.totalNodeCount === 0,
  };
  const claim = await claimKnowledgeBaseTurnForRecovery({
    turnId: activeTurn.id,
    allowLegacySkill404IncidentRepair:
      knowledgeBaseManusV2ActiveMigrationEnabled(),
  });
  if (claim) {
    const lifecycle = await reconcileKnowledgeBaseManusV2Lifecycle({
      claim,
      build: input.build,
      client,
      taskId: input.taskId,
      events,
      contract,
    });
    if (lifecycle.kind !== "stopped") {
      return { taskStatus, progress: null };
    }
  } else if (taskStatus !== "stopped") {
    return { taskStatus, progress: null };
  }
  let output: Awaited<
    ReturnType<typeof normalizeManusV2KnowledgeBaseOperationOutput>
  >;
  try {
    output = await normalizeManusV2KnowledgeBaseOperationOutput({
      events,
      contract,
      taskStatus,
      allowAssistantProtocolFallback:
        claim !== null
          ? manusV2ClaimProvesFrozenDispatchAttribution({
              claim,
              taskId: input.taskId,
            })
          : manusV2TurnProvesAcknowledgedAttribution({
              turn: {
                providerProtocol:
                  metadata.providerProtocol === "manus_v2"
                    ? "manus_v2"
                    : "legacy_v1",
                providerMethod:
                  metadata.providerMethod === "task.sendMessage" ||
                  metadata.providerMethod === "task.create"
                    ? metadata.providerMethod
                    : null,
                providerAttemptState:
                  typeof metadata.providerAttemptState === "string"
                    ? metadata.providerAttemptState
                    : null,
                upstreamTaskId: activeTurn.upstreamTaskId,
                attachmentsFrozen: metadata.attachmentsFrozen === true,
              },
              taskId: input.taskId,
            }),
      build: input.build,
      expectedUploadsRead: input.build.lastTurnAttachmentCount,
    });
  } catch (error) {
    if (
      !(
        claim &&
        taskStatus === "stopped" &&
        error instanceof ManusV2ApiError &&
        isRepairableKnowledgeBaseManusV2FormatCode(error.code)
      )
    ) {
      throw error;
    }
    await repairStoppedManusV2KnowledgeBaseFormat({
      claim,
      client,
      taskId: input.taskId,
      events,
      contract,
    });
    return { taskStatus, progress: null };
  }
  if (
    output.length === 0 ||
    !shouldReconcileKnowledgeOutput(output, taskStatus)
  ) {
    if (claim && taskStatus === "stopped") {
      await repairStoppedManusV2KnowledgeBaseFormat({
        claim,
        client,
        taskId: input.taskId,
        events,
        contract,
      });
    }
    return { taskStatus, progress: null };
  }
  const progress = await reconcileAvailableKnowledgeOutput({
    userId: input.userId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    output,
    upstreamStatus: taskStatus,
    ledger: {
      lastOutputLength: input.build.lastOutputLength,
      lastOutputItemIds: input.build.lastOutputItemIds,
    },
    artifactAccess: { apiKey: input.apiKey, baseUrl: input.baseUrl },
  });
  return { taskStatus, progress };
}

type KnowledgeBaseManusV2HandoffSnapshot = {
  schemaVersion: 1;
  purpose: "legacy_to_manus_v2_handoff";
  build: {
    id: string;
    generation: number;
    revision: number;
    currentLeafId: string | null;
    skillName: string;
    skillVersion: string;
    skillContentHash: string | null;
    skillArchiveSha256: string | null;
    treePolicyVersion: number;
  };
  nodes: Array<{
    leafId: string;
    branchId: string;
    branchTitle: string;
    title: string;
    ordinal: number;
    status: string;
    contentMarkdown: string | null;
    contentSha256: string | null;
    lastUserInput: string | null;
  }>;
  acceptedReceipts: Array<{
    sequence: number;
    turnId: string | null;
    kind: string;
    generation: number;
    revision: number | null;
    leafId: string | null;
    content: string;
    contentSha256: string;
  }>;
  pendingOperation: {
    turnId: string;
    operationToken: string;
    action: string;
    baseRevision: number;
    fromLeafId: string | null;
    userInput: string;
    attachmentManifest: unknown[];
  };
};

async function buildKnowledgeBaseManusV2HandoffSnapshot(input: {
  claim: KnowledgeBaseRecoveryClaim;
  build: NonNullable<
    Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecordById>>
  >;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable for Manus v2 handoff");
  const persistedConversationId = input.claim.turn.conversationId;
  const nodes = await db
    .select({
      leafId: knowledgeBaseBuildNodes.leafId,
      branchId: knowledgeBaseBuildNodes.branchId,
      branchTitle: knowledgeBaseBuildNodes.branchTitle,
      title: knowledgeBaseBuildNodes.title,
      ordinal: knowledgeBaseBuildNodes.ordinal,
      status: knowledgeBaseBuildNodes.status,
      contentMarkdown: knowledgeBaseBuildNodes.contentMarkdown,
      contentSha256: knowledgeBaseBuildNodes.contentSha256,
      lastUserInput: knowledgeBaseBuildNodes.lastUserInput,
    })
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, input.build.id))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
  const acceptedReceipts = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      userId: messages.userId,
      role: messages.role,
      sequence: messages.sequence,
      turnId: messages.turnId,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(
      and(
        eq(messages.userId, input.claim.turn.userId),
        eq(messages.conversationId, persistedConversationId),
        eq(messages.role, "assistant"),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.sequence));
  const receiptTurnIds = [
    ...new Set(
      acceptedReceipts.flatMap((message) =>
        message.turnId ? [message.turnId] : [],
      ),
    ),
  ];
  const receiptTurns =
    receiptTurnIds.length > 0
      ? await db
          .select({
            id: conversationTurns.id,
            conversationId: conversationTurns.conversationId,
            userId: conversationTurns.userId,
            clientRequestId: conversationTurns.clientRequestId,
            buildId: conversationTurns.buildId,
            buildGeneration: conversationTurns.buildGeneration,
            operationKey: conversationTurns.operationKey,
            expectedRevision: conversationTurns.expectedRevision,
            expectedLeafId: conversationTurns.expectedLeafId,
            status: conversationTurns.status,
          })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.userId, input.claim.turn.userId),
              eq(conversationTurns.buildId, input.build.id),
              inArray(conversationTurns.id, receiptTurnIds),
            ),
          )
      : [];
  const receiptTurnsById = new Map(receiptTurns.map((turn) => [turn.id, turn]));
  const snapshot: KnowledgeBaseManusV2HandoffSnapshot = {
    schemaVersion: 1,
    purpose: "legacy_to_manus_v2_handoff",
    build: {
      id: input.build.id,
      generation: input.build.generation,
      revision: input.build.revision,
      currentLeafId: input.build.currentLeafId,
      skillName: input.build.skillName,
      skillVersion: input.build.skillVersion,
      skillContentHash: input.build.skillContentHash,
      skillArchiveSha256: input.build.skillArchiveSha256,
      treePolicyVersion: input.build.treePolicyVersion,
    },
    nodes: nodes.map((node) => ({ ...node })),
    acceptedReceipts: acceptedReceipts.flatMap((message) => {
      const metadata = parsedKnowledgeBaseMessageMetadata(message.metadata);
      if (
        !metadata ||
        metadata.buildId !== input.build.id ||
        typeof metadata.generation !== "number" ||
        metadata.generation > input.build.generation ||
        (metadata.kind !== "presentation" && metadata.kind !== "completion") ||
        !message.turnId ||
        !matchesAuthoritativeKnowledgeBaseMessageTuple({
          message,
          knowledgeBase: metadata,
          turn: receiptTurnsById.get(message.turnId),
          build: input.build,
          publicConversationId: input.build.conversationId,
        })
      ) {
        return [];
      }
      const content = String(message.content || "").trim();
      return [
        {
          sequence: message.sequence,
          turnId: message.turnId,
          kind: String(metadata.kind),
          generation: metadata.generation,
          revision:
            typeof metadata.revision === "number" ? metadata.revision : null,
          leafId: typeof metadata.leafId === "string" ? metadata.leafId : null,
          content,
          contentSha256: createHash("sha256").update(content).digest("hex"),
        },
      ];
    }),
    pendingOperation: {
      turnId: input.claim.turn.id,
      operationToken: input.claim.turn.operationToken,
      action: input.claim.turn.operationType,
      baseRevision: input.claim.turn.expectedRevision,
      fromLeafId: input.claim.turn.expectedLeafId,
      userInput: String(input.build.lastTurnUserText || ""),
      attachmentManifest: Array.isArray(
        input.claim.recoveryMetadata.attachmentManifest,
      )
        ? input.claim.recoveryMetadata.attachmentManifest
        : [],
    },
  };
  const json = JSON.stringify(snapshot);
  return {
    snapshot,
    json,
    sha256: createHash("sha256").update(json).digest("hex"),
  };
}

function appendKnowledgeBaseManusV2HandoffSnapshot(
  prompt: string,
  handoff: Awaited<ReturnType<typeof buildKnowledgeBaseManusV2HandoffSnapshot>>,
) {
  return [
    "# FrontMind legacy build handoff",
    "This is the only self-contained authority for the prior build. Continue the pending operation in this same task; do not require access to or repeat content from an old task.",
    `snapshotSha256=${handoff.sha256}`,
    "```json",
    handoff.json,
    "```",
    "",
    prompt,
  ].join("\n");
}

async function dispatchKnowledgeBaseRecoveryClaim(
  claim: KnowledgeBaseRecoveryClaim,
  credential: RecoveryCredential,
  dependencies: {
    loadBuild?: typeof loadKnowledgeBaseBuildRecordById;
    loadPreproviderAuthority?: typeof loadKnowledgeBasePreproviderLocalRehydrateAuthority;
    buildHandoffSnapshot?: typeof buildKnowledgeBaseManusV2HandoffSnapshot;
    ensureDispatch?: typeof ensureKnowledgeBaseRecoveryDispatch;
    ensureManusV2Attachments?: typeof ensureKnowledgeBaseManusV2Attachments;
    beginDispatch?: typeof beginKnowledgeBaseManusV2Dispatch;
    markManusV2OutcomeUnknown?: typeof markKnowledgeBaseManusV2OutcomeUnknown;
    createClient?: (input: {
      baseUrl: string;
      apiKey: string;
    }) => Pick<
      ManusV2Client,
      | "createTask"
      | "sendMessage"
      | "updateTaskVisibility"
      | "findCreatedTask"
      | "listAllMessages"
    >;
    bindSubmission?: typeof bindKnowledgeBaseManusV2Submission;
    reconcileTask?: typeof reconcileRecoveredKnowledgeBaseTask;
  } = {},
) {
  beginKnowledgeBaseClaimReadinessTiming(claim);
  const loadBuild = dependencies.loadBuild ?? loadKnowledgeBaseBuildRecordById;
  const loadPreproviderAuthority =
    dependencies.loadPreproviderAuthority ??
    loadKnowledgeBasePreproviderLocalRehydrateAuthority;
  const buildHandoffSnapshot =
    dependencies.buildHandoffSnapshot ??
    buildKnowledgeBaseManusV2HandoffSnapshot;
  const ensureDispatch =
    dependencies.ensureDispatch ?? ensureKnowledgeBaseRecoveryDispatch;
  const ensureManusV2Attachments =
    dependencies.ensureManusV2Attachments ??
    ensureKnowledgeBaseManusV2Attachments;
  const beginDispatch =
    dependencies.beginDispatch ?? beginKnowledgeBaseManusV2Dispatch;
  const markManusV2OutcomeUnknownForDispatch =
    dependencies.markManusV2OutcomeUnknown ??
    markKnowledgeBaseManusV2OutcomeUnknown;
  const createClient =
    dependencies.createClient ?? ((input) => new ManusV2Client(input));
  const bindSubmission =
    dependencies.bindSubmission ?? bindKnowledgeBaseManusV2Submission;
  const reconcileTask =
    dependencies.reconcileTask ?? reconcileRecoveredKnowledgeBaseTask;
  let existingBuild = await loadBuild(claim.turn.userId, claim.turn.buildId);
  let handoff: Awaited<
    ReturnType<typeof buildKnowledgeBaseManusV2HandoffSnapshot>
  > | null = null;
  let localCanonicalSnapshot: Awaited<
    ReturnType<typeof loadKnowledgeBaseLocalRehydrateSnapshot>
  > = null;
  if (
    knowledgeBaseManusV2ActiveMigrationEnabled() &&
    existingBuild?.providerProtocol === "legacy_v1" &&
    claim.turn.createAttemptState === "not_sent" &&
    !claim.turn.upstreamTaskId &&
    ["researching", "confirming", "protocol_error"].includes(
      existingBuild.status,
    )
  ) {
    handoff = await buildKnowledgeBaseManusV2HandoffSnapshot({
      claim,
      build: existingBuild,
    });
    await activateKnowledgeBaseManusV2Handoff({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      expectedGeneration: claim.turn.buildGeneration,
      expectedRevision: claim.turn.expectedRevision,
      expectedLeafId: claim.turn.expectedLeafId,
      snapshotSha256: handoff.sha256,
      legacyTaskIdSha256: existingBuild.upstreamTaskId
        ? createHash("sha256")
            .update(existingBuild.upstreamTaskId)
            .digest("hex")
        : null,
    });
    claim.turn.providerProtocol = "manus_v2";
    claim.turn.providerAttemptState = "not_sent";
    existingBuild = await loadBuild(claim.turn.userId, claim.turn.buildId);
  }
  const minimalCompatibleCreate =
    claim.recoveryMetadata.compatibilityMode === "minimal_v2_create";
  if (minimalCompatibleCreate && existingBuild?.canonicalTaskId) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The compatible create authority changed before dispatch",
    );
  }
  if (
    existingBuild?.providerProtocol === "manus_v2" &&
    !existingBuild.canonicalTaskId &&
    claim.turn.createAttemptState === "not_sent" &&
    claim.turn.providerAttemptState === "not_sent" &&
    claim.recoveryMetadata.compatibilityMode !== "minimal_v2_create" &&
    existingBuild.handoffProvenance &&
    typeof existingBuild.handoffProvenance === "object" &&
    !Array.isArray(existingBuild.handoffProvenance)
  ) {
    const localRehydrateValue =
      existingBuild.handoffProvenance.localRehydrateRequired;
    const localRehydrateMarker =
      localRehydrateValue &&
      typeof localRehydrateValue === "object" &&
      !Array.isArray(localRehydrateValue)
        ? (localRehydrateValue as Record<string, unknown>)
        : null;
    const localRehydrateRequired = Boolean(localRehydrateMarker);
    const preproviderMarker =
      localRehydrateMarker &&
      localRehydrateMarker.reason ===
        "generated_attachment_invalid_preprovider";
    const preproviderLocalRehydrate = localRehydrateRequired
      ? await loadPreproviderAuthority({
          userId: claim.turn.userId,
          build: existingBuild,
          expectedActiveTurnId: claim.turn.id,
        })
      : null;
    if (preproviderLocalRehydrate) {
      // The failed legacy confirm had no prepared Provider request, so its
      // release deliberately has no frozen provider snapshot. Rebuild the
      // complete Dashboard-owned nodes/receipts plus this new operation from
      // durable state, after reproving the exact release source.
      handoff = await buildHandoffSnapshot({
        claim,
        build: existingBuild,
      });
    } else if (preproviderMarker) {
      // This marker can only be consumed with its released source tombstone
      // and the exact active continuation proof. Do not fall through to the
      // older local-settlement snapshot protocol: a stale/corrupt coordinate
      // would otherwise return to the generic recovery scan forever.
      throw new KnowledgeBaseLocalPreparationError(
        "KNOWLEDGE_BASE_LOCAL_REHYDRATE_AUTHORITY_INVALID",
        "知识库本地恢复坐标已发生变化，请联系支持处理",
      );
    } else if (localRehydrateRequired) {
      localCanonicalSnapshot = await loadKnowledgeBaseLocalRehydrateSnapshot({
        userId: claim.turn.userId,
        build: existingBuild,
      });
    } else {
      // Only the legacy cutover protocol owns a top-level snapshot digest.
      // A local rehydrate marker is a different authority and must never be
      // compared to this digest (historically undefined !== rebuilt caused a
      // permanent pre-create recovery loop).
      const committedSnapshotSha256 =
        existingBuild.handoffProvenance.snapshotSha256;
      if (
        typeof committedSnapshotSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(committedSnapshotSha256)
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The durable Manus v2 handoff snapshot authority is missing",
        );
      }
      const rebuilt = await buildHandoffSnapshot({
        claim,
        build: existingBuild,
      });
      if (committedSnapshotSha256 !== rebuilt.sha256) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The durable Manus v2 handoff snapshot changed before task creation",
        );
      }
      handoff = rebuilt;
    }
  }
  if (existingBuild?.providerProtocol === "manus_v2") {
    const recoveryAuthority = knowledgeBaseManusV2RecoveryAuthority({
      canonicalTaskId: existingBuild.canonicalTaskId,
      createAttemptState: claim.turn.createAttemptState,
      providerAttemptState: claim.turn.providerAttemptState,
    });
    if (recoveryAuthority === "deferred_disabled") {
      throw new KnowledgeBaseManusV2RolloutDeferredError();
    }
    if (recoveryAuthority === "reconcile_only") {
      const client = createClient({
        baseUrl: claim.preparedDispatch?.baseUrl || getUpstreamBaseUrl(),
        apiKey: credential.apiKey,
      });
      let taskId = existingBuild.canonicalTaskId;
      if (!taskId && claim.turn.providerMethod === "task.create") {
        const preparedAtSeconds = claim.preparedDispatch?.preparedAt
          ? Math.floor(Date.parse(claim.preparedDispatch.preparedAt) / 1_000)
          : undefined;
        const reconciled = await client.findCreatedTask({
          title: `FrontMind KB ${existingBuild.id} g${existingBuild.generation}`,
          operationToken: claim.turn.operationToken,
          ...(preparedAtSeconds
            ? {
                createdAfterSeconds: preparedAtSeconds - 300,
                createdBeforeSeconds: preparedAtSeconds + 3_600,
              }
            : {}),
        });
        if (!reconciled.unique) {
          throw new ManusV2ApiError(
            "task.create.reconcile",
            null,
            reconciled.matches.length > 1
              ? "AMBIGUOUS_CREATE"
              : "CREATE_NOT_OBSERVED",
            true,
            true,
          );
        }
        taskId = reconciled.unique.id;
        await bindSubmission({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          method: "task.create",
          taskId,
          taskUrl: reconciled.unique.taskUrl,
        });
        claim.turn.upstreamTaskId = taskId;
      }
      if (!taskId) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The Manus v2 operation has no canonical task to reconcile",
        );
      }
      const events = await client.listAllMessages({
        taskId,
        order: "asc",
      });
      const contract = manusV2ContractForTurn({
        claim,
        build: existingBuild,
      });
      const taskStatus = latestManusV2TaskState(events) || "running";
      // Never pre-parse a stopped result here. The single lifecycle reconciler
      // owns all stopped parsing so malformed structured output reaches its
      // one repair/deadline/attention terminal path instead of being thrown
      // back into the generic outcome-unknown lease loop.
      if (taskStatus === "stopped") {
        if (
          claim.turn.providerMethod === "task.sendMessage" &&
          !claim.turn.upstreamTaskId
        ) {
          await bindSubmission({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            method: "task.sendMessage",
            taskId,
          });
          claim.turn.upstreamTaskId = taskId;
        }
        const reconciled = await reconcileTask({
          claim,
          credential,
          taskId,
        });
        return { taskId, rebound: false, reconciled };
      }
      const exactStructuredResult =
        manusV2KnowledgeBaseStructuredResultForOperation(events, contract);
      const exactAssistantResult = manusV2ClaimProvesFrozenDispatchAttribution({
        claim,
        taskId,
      })
        ? manusV2KnowledgeBaseAssistantProtocolFallback({
            events,
            contract,
            taskStatus,
          })
        : null;
      if (
        !manusV2EventsContainOperationToken(
          events,
          claim.turn.operationToken,
        ) &&
        !exactStructuredResult &&
        !exactAssistantResult
      ) {
        throw new ManusV2ApiError(
          "task.sendMessage.reconcile",
          null,
          "OPERATION_NOT_OBSERVED",
          true,
          true,
        );
      }
      if (
        claim.turn.providerMethod === "task.sendMessage" &&
        !claim.turn.upstreamTaskId
      ) {
        await bindSubmission({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          method: "task.sendMessage",
          taskId,
        });
        claim.turn.upstreamTaskId = taskId;
      }
      const output = await normalizeManusV2KnowledgeBaseOperationOutput({
        events,
        contract,
        taskStatus,
        allowAssistantProtocolFallback:
          manusV2ClaimProvesFrozenDispatchAttribution({ claim, taskId }),
        build: existingBuild,
        expectedUploadsRead: existingBuild.lastTurnAttachmentCount,
      });
      const reconciled =
        output.length > 0 && shouldReconcileKnowledgeOutput(output, taskStatus)
          ? await reconcileTask({
              claim,
              credential,
              taskId,
            })
          : false;
      return { taskId, rebound: false, reconciled };
    }
    const prepared = await ensureDispatch({
      claim,
      credential,
    });
    const v2Attachments = await ensureManusV2Attachments({
      claim,
      credential,
      baseUrl: prepared.baseUrl,
    });
    if (
      v2Attachments.length !== prepared.requestBody.attachments.length ||
      v2Attachments.some(
        (attachment, index) =>
          attachment.filename !==
            prepared.requestBody.attachments[index]?.filename ||
          ((!("file_id" in attachment) || !attachment.file_id) &&
            (!("file_data" in attachment) || !attachment.file_data)),
      )
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The complete Manus v2 ready attachment ledger is required",
      );
    }
    const contract = manusV2ContractForTurn({ claim, build: existingBuild });
    const structuredOutputSchema =
      buildManusV2KnowledgeBaseStructuredOutputSchema(contract);
    const businessPrompt = localCanonicalSnapshot
      ? [
          "# FrontMind local canonical rehydrate",
          "Restore the exact Dashboard-owned accepted state before applying this business operation in this newly created canonical task.",
          `snapshotSha256=${localCanonicalSnapshot.sha256}`,
          "```json",
          localCanonicalSnapshot.json,
          "```",
          "",
          prepared.requestBody.prompt,
        ].join("\n")
      : handoff
        ? appendKnowledgeBaseManusV2HandoffSnapshot(
            prepared.requestBody.prompt,
            handoff,
          )
        : existingBuild
          ? await (async () => {
              const local = await loadKnowledgeBaseLocalRehydrateSnapshot({
                userId: claim.turn.userId,
                build: existingBuild,
              });
              return local
                ? [
                    "# FrontMind local canonical rehydrate",
                    "Restore the exact Dashboard-owned accepted state before applying this business operation on the same canonical task.",
                    `snapshotSha256=${local.sha256}`,
                    "```json",
                    local.json,
                    "```",
                    "",
                    prepared.requestBody.prompt,
                  ].join("\n")
                : prepared.requestBody.prompt;
            })()
          : prepared.requestBody.prompt;
    const v2Prompt = appendManusV2KnowledgeBaseOperationContract(
      businessPrompt,
      contract,
    );
    const providerAttachments = v2Attachments;
    const expectedProviderMethod = existingBuild.canonicalTaskId
      ? ("task.sendMessage" as const)
      : ("task.create" as const);
    const structuredOutputSchemaJson = JSON.stringify(structuredOutputSchema);
    const frozenProviderRequestBody =
      expectedProviderMethod === "task.create"
        ? buildManusV2CreateTaskBody({
            prompt: v2Prompt,
            attachments: providerAttachments,
            title: `FrontMind KB ${existingBuild.id} g${existingBuild.generation}`,
            ...(minimalCompatibleCreate
              ? {}
              : { agentProfile: prepared.requestBody.agentProfile }),
            ...(minimalCompatibleCreate ? {} : { structuredOutputSchema }),
            hideInTaskList: true,
          })
        : buildManusV2SendMessageBody({
            taskId: existingBuild.canonicalTaskId!,
            prompt: v2Prompt,
            attachments: providerAttachments,
            structuredOutputSchema,
          });
    const v2BodyHash = createHash("sha256")
      .update(JSON.stringify(frozenProviderRequestBody))
      .digest("hex");
    const authority = await beginDispatch({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      frozenProviderRequestHash: v2BodyHash,
      leaseMs: 300_000,
      expectedMethod: expectedProviderMethod,
    });
    if (
      authority.method !== expectedProviderMethod ||
      (expectedProviderMethod === "task.create" && authority.canonicalTaskId) ||
      (expectedProviderMethod === "task.sendMessage" &&
        authority.canonicalTaskId !== existingBuild.canonicalTaskId)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The knowledge-base dispatch authority changed before dispatch",
      );
    }
    claim.turn.providerProtocol = "manus_v2";
    claim.turn.providerMethod = authority.method;
    claim.turn.providerAttemptState = "sending";
    claim.turn.operationToken = authority.operationToken;
    const client = createClient({
      baseUrl: prepared.baseUrl,
      apiKey: credential.apiKey,
    });
    let taskId = authority.canonicalTaskId;
    let taskUrl: string | null = existingBuild.canonicalTaskUrl;
    let requestId: string | null = null;
    try {
      if (authority.method === "task.create") {
        const created = await client.createTask({
          prompt: v2Prompt,
          attachments: providerAttachments,
          // The title is part of the stable core create envelope. Only the
          // optional profile/schema are omitted by the one compatibility
          // variant after a proven 400 rejection.
          title: authority.title,
          ...(minimalCompatibleCreate
            ? {}
            : { agentProfile: prepared.requestBody.agentProfile }),
          ...(minimalCompatibleCreate ? {} : { structuredOutputSchema }),
          hideInTaskList: true,
        });
        taskId = created.taskId;
        taskUrl = created.taskUrl;
        requestId = created.requestId;
      } else {
        if (!taskId) {
          throw new KnowledgeBaseTurnReservationError(
            "CONFLICT",
            "The canonical Manus task is missing",
          );
        }
        const sent = await client.sendMessage({
          taskId,
          prompt: v2Prompt,
          attachments: providerAttachments,
          structuredOutputSchema,
        });
        requestId = sent.requestId;
      }
    } catch (error) {
      if (error instanceof ManusV2ApiError) {
        Object.assign(error, {
          frontmindRequestShape: {
            promptUtf8Bytes: Buffer.byteLength(v2Prompt, "utf8"),
            titleUtf8Bytes:
              authority.method === "task.create"
                ? Buffer.byteLength(authority.title, "utf8")
                : 0,
            attachmentCount: providerAttachments.length,
            agentProfile:
              authority.method === "task.create" && !minimalCompatibleCreate
                ? prepared.requestBody.agentProfile
                : null,
            hasAgentProfile:
              authority.method === "task.create" && !minimalCompatibleCreate,
            hasStructuredOutputSchema: !minimalCompatibleCreate,
            structuredOutputSchemaUtf8Bytes: minimalCompatibleCreate
              ? 0
              : Buffer.byteLength(structuredOutputSchemaJson, "utf8"),
            structuredOutputSchemaSha256: minimalCompatibleCreate
              ? null
              : createHash("sha256")
                  .update(structuredOutputSchemaJson, "utf8")
                  .digest("hex"),
            compatibilityMode: minimalCompatibleCreate
              ? "minimal_v2_create"
              : "standard",
          },
        });
      }
      if (
        error instanceof ManusV2ApiError &&
        error.outcomeUnknown &&
        !minimalCompatibleCreate
      ) {
        await markManusV2OutcomeUnknownForDispatch({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          code:
            authority.method === "task.create"
              ? "MANUS_V2_CREATE_OUTCOME_UNKNOWN"
              : "MANUS_V2_SEND_OUTCOME_UNKNOWN",
        });
      }
      throw error;
    }
    // The provider has acknowledged the side effect, but its local binding is
    // still fallible. Reflect that boundary on the in-memory claim so an error
    // from the following transaction is persisted as outcome-unknown and can
    // only be reconciled; it must never be treated as a pre-POST failure.
    claim.turn.providerAttemptState = "output_pending";
    if (!taskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 task acknowledgement is missing its task id",
      );
    }
    await bindSubmission({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      method: authority.method,
      taskId,
      taskUrl,
      manusRequestId: requestId,
    });
    claim.turn.createAttemptState = "acknowledged";
    claim.turn.providerAttemptState = "output_pending";
    claim.turn.upstreamTaskId = taskId;
    // task.create ownership is committed atomically with the canonical anchor
    // by bindKnowledgeBaseManusV2Submission. A second best-effort registration
    // here would reintroduce the bind/ownership crash window and, for project
    // scoped historical rows, could attempt to rewrite the exact scope.
    await promoteManualKnowledgeBaseLogoAfterTaskAcknowledged(claim);
    // task.create/sendMessage are asynchronous. The first read frequently has
    // only running status; the normal recovery worker will keep polling the
    // same canonical task until an accepted output appears.
    const reconciled = await reconcileTask({
      claim,
      credential,
      taskId,
    });
    if (reconciled && existingBuild) {
      const after = await loadBuild(claim.turn.userId, claim.turn.buildId);
      if (
        after &&
        after.generation === existingBuild.generation &&
        after.revision === existingBuild.revision + 1 &&
        after.canonicalTaskId === taskId
      ) {
        await clearKnowledgeBaseLocalRehydrateRequirement({
          userId: claim.turn.userId,
          buildId: after.id,
          generation: after.generation,
          expectedRevision: after.revision,
          taskId,
        });
      }
    }
    void client.updateTaskVisibility(taskId, true).catch(() => undefined);
    return { taskId, rebound: authority.method === "task.create", reconciled };
  }
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

type KnowledgeBaseActiveLegacyMigrationCandidate = {
  id: string;
  userId: number;
  generation: number;
  stateEpoch: number;
  revision: number;
  currentLeafId: string | null;
  status: string;
  activeTurnId: string | null;
  activeTurnStatus: string | null;
  upstreamTaskId: string | null;
  createAttemptState: string | null;
};

export type KnowledgeBaseActiveLegacyMigrationDisposition =
  | "migrate_anchor"
  | "existing_not_sent_turn"
  | "legacy_outcome_unknown"
  | "excluded";

/** Pure policy used by both the sweep and its fault-matrix tests. */
export function classifyKnowledgeBaseActiveLegacyMigration(
  candidate: Pick<
    KnowledgeBaseActiveLegacyMigrationCandidate,
    "status" | "activeTurnId" | "createAttemptState"
  >,
): KnowledgeBaseActiveLegacyMigrationDisposition {
  if (!candidate.status) {
    return "excluded";
  }
  if (!candidate.activeTurnId) {
    // `confirming` with no active turn is the durable awaiting-input state.
    // `researching` still represents an unsettled legacy provider operation;
    // the open-recovery worker must first accept or definitively reconcile its
    // output. Creating an anchor here could race that output and would let the
    // generic recovery path misinterpret the handoff acknowledgement.
    if (candidate.status === "confirming") return "migrate_anchor";
    if (candidate.status === "researching") return "legacy_outcome_unknown";
    // A build-local protocol error with no active writer still has a complete
    // self-contained Dashboard state. Migrate that state to one v2 anchor;
    // keeping it as an eternally "active legacy" row would make rollout
    // convergence impossible without improving customer recovery.
    if (candidate.status === "protocol_error") return "migrate_anchor";
    return "excluded";
  }
  // A failed pre-dispatch confirmation repair is still a provably not-sent
  // operation. In particular, protocol_error must not strand the 15:52-style
  // replacement turn merely because the build-local status was downgraded.
  if (
    !["researching", "confirming", "protocol_error"].includes(candidate.status)
  ) {
    return "excluded";
  }
  if ((candidate.createAttemptState || "not_sent") === "not_sent") {
    return "existing_not_sent_turn";
  }
  return ["sending", "unknown", "acknowledged"].includes(
    String(candidate.createAttemptState),
  )
    ? "legacy_outcome_unknown"
    : "excluded";
}

type KnowledgeBaseCanonicalCredentialRebindCandidate = {
  id: string;
  userId: number;
  generation: number;
  stateEpoch: number;
  revision: number;
  currentLeafId: string | null;
  status: string;
  activeTurnId: string | null;
  canonicalTaskId: string | null;
  canonicalTaskGeneration: number | null;
  canonicalCredentialId: string | null;
  canonicalTaskState: string;
  protocolErrorCode: string | null;
  credentialStatus: string | null;
  resourceTaskId: string | null;
  resourceCredentialId: string | null;
  resourceUserId: number | null;
  resourceProjectAssignmentId: string | null;
  conversationUserId: number | null;
  conversationProjectAssignmentId: string | null;
  conversationStatus: string | null;
  conversationDeletedAt: Date | null;
};

export function classifyKnowledgeBaseManusV2CredentialRebind(
  candidate: KnowledgeBaseCanonicalCredentialRebindCandidate,
) {
  if (
    candidate.conversationUserId !== candidate.userId ||
    candidate.conversationStatus !== "awaiting_input" ||
    candidate.conversationDeletedAt !== null
  ) {
    return "excluded";
  }
  return classifyKnowledgeBaseCanonicalCredentialRebind({
    providerProtocol: "manus_v2",
    status: candidate.status,
    activeTurnId: candidate.activeTurnId,
    canonicalTaskId: candidate.canonicalTaskId,
    canonicalTaskGeneration: candidate.canonicalTaskGeneration,
    canonicalCredentialId: candidate.canonicalCredentialId,
    canonicalTaskState: candidate.canonicalTaskState,
    protocolErrorCode: candidate.protocolErrorCode,
    generation: candidate.generation,
    credentialStatus: candidate.credentialStatus,
    resourceTaskId: candidate.resourceTaskId,
    resourceCredentialId: candidate.resourceCredentialId,
    resourceUserId: candidate.resourceUserId,
    userId: candidate.userId,
    resourceProjectAssignmentId: candidate.resourceProjectAssignmentId,
    conversationProjectAssignmentId: candidate.conversationProjectAssignmentId,
  });
}

function anchorHandoffStructuredOutputSchema(input: {
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
}) {
  return {
    type: "object",
    properties: {
      schemaVersion: { type: "integer", enum: [1] },
      operationToken: { type: "string", enum: [input.operationToken] },
      turnId: { type: "string", enum: [input.turnId] },
      generation: { type: "integer", enum: [input.generation] },
      baseRevision: { type: "integer", enum: [input.baseRevision] },
      handoffAccepted: { type: "boolean", enum: [true] },
    },
    required: [
      "schemaVersion",
      "operationToken",
      "turnId",
      "generation",
      "baseRevision",
      "handoffAccepted",
    ],
    additionalProperties: false,
  };
}

async function dispatchKnowledgeBaseAnchorHandoffClaim(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: NonNullable<
    Awaited<ReturnType<typeof getEffectiveDecryptedCredentialForAccount>>
  >;
  dependencies?: {
    client?: Pick<
      ManusV2Client,
      | "createTask"
      | "findCreatedTask"
      | "listAllMessages"
      | "sendMessage"
      | "updateTaskVisibility"
    >;
    loadBuild?: typeof loadKnowledgeBaseBuildRecordById;
    ensureSkillArchivePin?: typeof ensureKnowledgeBaseBuildSkillArchivePin;
    mutateLifecycle?: typeof mutateKnowledgeBaseManusV2Lifecycle;
    deferOutputPending?: typeof deferKnowledgeBaseManusV2AnchorHandoffOutputPending;
    markAttention?: typeof markKnowledgeBaseManusV2AnchorHandoffAttentionRequired;
    completeHandoff?: typeof completeKnowledgeBaseManusV2AnchorHandoff;
    locallySettle?: typeof observeAndLocallySettleKnowledgeBaseTerminalAnchor;
  };
}) {
  const { claim, credential } = input;
  const loadBuild =
    input.dependencies?.loadBuild ?? loadKnowledgeBaseBuildRecordById;
  const ensureSkillArchivePin =
    input.dependencies?.ensureSkillArchivePin ??
    ensureKnowledgeBaseBuildSkillArchivePin;
  const mutateLifecycle =
    input.dependencies?.mutateLifecycle ?? mutateKnowledgeBaseManusV2Lifecycle;
  const deferOutputPending =
    input.dependencies?.deferOutputPending ??
    deferKnowledgeBaseManusV2AnchorHandoffOutputPending;
  const markAttention =
    input.dependencies?.markAttention ??
    markKnowledgeBaseManusV2AnchorHandoffAttentionRequired;
  const completeHandoff =
    input.dependencies?.completeHandoff ??
    completeKnowledgeBaseManusV2AnchorHandoff;
  const locallySettle =
    input.dependencies?.locallySettle ??
    observeAndLocallySettleKnowledgeBaseTerminalAnchor;
  const prepared = claim.preparedDispatch;
  if (!prepared || prepared.requestBody.attachments.length !== 0) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The hidden anchor handoff does not have its frozen request",
    );
  }
  let build = await loadBuild(claim.turn.userId, claim.turn.buildId);
  if (
    !build ||
    build.generation !== claim.turn.buildGeneration ||
    build.providerProtocol !== "manus_v2" ||
    build.activeTurnId !== claim.turn.id
  ) {
    return { bound: false, reconciled: false };
  }
  // The handoff snapshot is self-contained, but the build must still prove
  // its exact physical Skill archive before continuing its canonical writer.
  // Historical rows are durably backfilled here before any same-task repair
  // side effect.
  await ensureSkillArchivePin({
    userId: claim.turn.userId,
    buildId: build.id,
    generation: build.generation,
  });
  build = await loadBuild(claim.turn.userId, claim.turn.buildId);
  if (
    !build ||
    build.generation !== claim.turn.buildGeneration ||
    build.providerProtocol !== "manus_v2" ||
    build.activeTurnId !== claim.turn.id
  ) {
    return { bound: false, reconciled: false };
  }
  const client =
    input.dependencies?.client ??
    new ManusV2Client({
      baseUrl: prepared.baseUrl,
      apiKey: credential.apiKey,
    });
  const title = `FrontMind KB ${build.id} g${build.generation}`;
  const structuredOutputSchema = anchorHandoffStructuredOutputSchema({
    operationToken: claim.turn.operationToken,
    turnId: claim.turn.id,
    generation: claim.turn.buildGeneration,
    baseRevision: claim.turn.expectedRevision,
  });
  const attempt = (claim.turn.providerAttemptState || "not_sent") as
    | "not_sent"
    | "sending"
    | "outcome_unknown"
    | "output_pending";
  let authorityTitle = title;
  let reconciledMatchCount = 0;
  let locallySettled = false;
  const settled = await executeKnowledgeBaseAnchorHandoff({
    attempt,
    canonicalTask: build.canonicalTaskId
      ? {
          id: build.canonicalTaskId,
          taskUrl: build.canonicalTaskUrl,
        }
      : null,
    beginCreate: async () => {
      const bodyHash = createHash("sha256")
        .update(
          JSON.stringify({
            prompt: prepared.requestBody.prompt,
            attachments: [],
            agentProfile: prepared.requestBody.agentProfile,
            operationToken: claim.turn.operationToken,
            structuredOutputSchema,
          }),
        )
        .digest("hex");
      const authority = await beginKnowledgeBaseManusV2Dispatch({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        frozenProviderRequestHash: bodyHash,
        leaseMs: 300_000,
      });
      if (authority.method !== "task.create" || authority.canonicalTaskId) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The anchor handoff unexpectedly selected a continuation",
        );
      }
      authorityTitle = authority.title;
    },
    createTask: async () => {
      const created = await client.createTask({
        prompt: prepared.requestBody.prompt,
        attachments: [],
        title: authorityTitle,
        agentProfile: prepared.requestBody.agentProfile,
        structuredOutputSchema,
        hideInTaskList: true,
      });
      return {
        id: created.taskId,
        taskUrl: created.taskUrl,
        requestId: created.requestId,
      };
    },
    reconcileCreate: async () => {
      // `sending`, `outcome_unknown` and `output_pending` all mean the POST
      // may have crossed the boundary. This callback is read-only.
      const preparedAtSeconds = Math.floor(
        Date.parse(prepared.preparedAt) / 1_000,
      );
      const matched = await client.findCreatedTask({
        title,
        operationToken: claim.turn.operationToken,
        createdAfterSeconds: preparedAtSeconds - 300,
        createdBeforeSeconds: preparedAtSeconds + 3_600,
      });
      reconciledMatchCount = matched.matches.length;
      return matched.matches;
    },
    bindTask: (task) =>
      bindKnowledgeBaseManusV2Submission({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        method: "task.create",
        taskId: task.id,
        taskUrl: task.taskUrl,
        manusRequestId: task.requestId,
      }).then(() => undefined),
    settleAcknowledgement: async (task) => {
      // Binding proves only one canonical writer. Never release this hidden
      // turn until task.listMessages proves the exact asynchronous handoff
      // acknowledgement for its immutable operation coordinates.
      const events = await client.listAllMessages({
        taskId: task.id,
        order: "asc",
      });
      const expected = {
        operationToken: claim.turn.operationToken,
        turnId: claim.turn.id,
        generation: claim.turn.buildGeneration,
        baseRevision: claim.turn.expectedRevision,
      };
      const acknowledgement = inspectKnowledgeBaseAnchorAcknowledgement({
        events,
        expected,
      });
      const status = latestManusV2TaskState(events) || "running";
      if (
        acknowledgement.kind === "missing" &&
        (status === "error" || status === "stopped")
      ) {
        const recoveryCoordinates = {
          operationToken: claim.turn.operationToken,
          turnId: claim.turn.id,
          generation: claim.turn.buildGeneration,
          baseRevision: claim.turn.expectedRevision,
        };
        const recovery =
          buildKnowledgeBaseManusV2AnchorErrorRecovery(recoveryCoordinates);
        const existing = claim.turn.manusV2Lifecycle;
        if (
          existing.errorRecoveryToken &&
          (existing.errorRecoveryToken !== recovery.recoveryToken ||
            existing.errorRecoveryRequestHash !== recovery.requestHash)
        ) {
          await markAttention({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            code: "MANUS_V2_ANCHOR_ERROR_RECOVERY_CONFLICT",
          });
          return "attention_required";
        }
        const recoveryAttempt =
          classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
            attemptState: existing.errorRecoveryAttemptState,
            recoveryToken: recovery.recoveryToken,
            events,
            nextRetryAt: existing.errorRecoveryNextRetryAt,
          });
        if (
          status === "stopped" &&
          existing.errorRecoveryAttempt === 1 &&
          existing.errorRecoveryAttemptState === "acknowledged" &&
          existing.errorRecoveryToken === recovery.recoveryToken &&
          existing.errorRecoveryRequestHash === recovery.requestHash &&
          existing.errorRecoveryRequestId
        ) {
          const terminalEvent = [...events]
            .filter(
              (event) =>
                event.type === "status_update" &&
                latestManusV2TaskState([event]) === "stopped",
            )
            .sort(
              (left, right) =>
                right.timestamp - left.timestamp ||
                right.id.localeCompare(left.id),
            )[0];
          if (!terminalEvent) {
            throw new KnowledgeBaseTurnReservationError(
              "CONFLICT",
              "The stopped anchor event disappeared during local settlement",
            );
          }
          const terminalEventHash = createHash("sha256")
            .update(
              JSON.stringify({
                id: terminalEvent.id,
                type: terminalEvent.type,
                timestamp: terminalEvent.timestamp,
                status: latestManusV2TaskState([terminalEvent]),
                taskId: task.id,
              }),
            )
            .digest("hex");
          const local = await locallySettle({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            taskId: task.id,
            terminalEventHash,
          });
          locallySettled = local.state === "settled";
          return local.state === "settled" ? "completed" : "output_pending";
        }
        if (recoveryAttempt === "adopt") {
          await mutateLifecycle({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            mutation: {
              kind: "error_recovery",
              recoveryToken: recovery.recoveryToken,
              requestHash: recovery.requestHash,
              state: "acknowledged",
            },
          });
          await deferOutputPending({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            taskId: task.id,
          });
          return "output_pending";
        }
        if (recoveryAttempt === "wait") {
          if (claim.turn.providerAttemptState === "output_pending") {
            await deferOutputPending({
              userId: claim.turn.userId,
              turnId: claim.turn.id,
              leaseToken: claim.leaseToken,
              taskId: task.id,
            });
          }
          return "output_pending";
        }
        if (recoveryAttempt === "attention_required") {
          await markAttention({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            code: "MANUS_V2_ANCHOR_ERROR_RECOVERY_REJECTED",
          });
          return "attention_required";
        }
        await mutateLifecycle({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          mutation: {
            kind: "error_recovery",
            recoveryToken: recovery.recoveryToken,
            requestHash: recovery.requestHash,
            state: "sending",
          },
        });
        let sentOutcomeUnknown = false;
        let sentRetryWait = false;
        try {
          const sent = await client.sendMessage({
            taskId: task.id,
            prompt: recovery.prompt,
            structuredOutputSchema,
          });
          await mutateLifecycle({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            mutation: {
              kind: "error_recovery",
              recoveryToken: recovery.recoveryToken,
              requestHash: recovery.requestHash,
              state: "acknowledged",
              requestId: sent.requestId,
            },
          });
        } catch (error) {
          if (!(error instanceof ManusV2ApiError)) throw error;
          const rejection = error.outcomeUnknown
            ? null
            : knowledgeBaseManusV2ErrorRecoveryRejection({
                previousCount: existing.errorRecoveryRejectionCount,
                // A stopped handoff gets one same-task repair attempt. An
                // explicit rejection is final here; unlike an errored task,
                // it never authorizes another send.
                retryable: status === "error" && error.retryable,
                retryAfterMs: error.retryAfterMs,
                recoveryToken: recovery.recoveryToken,
              });
          await mutateLifecycle({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            mutation: {
              kind: "error_recovery",
              recoveryToken: recovery.recoveryToken,
              requestHash: recovery.requestHash,
              state: error.outcomeUnknown
                ? "outcome_unknown"
                : rejection?.retry
                  ? "retry_wait"
                  : "rejected",
              requestId: error.providerRequestId,
              ...(rejection?.retry ? { retryAfterMs: rejection.delayMs } : {}),
            },
          });
          sentOutcomeUnknown = error.outcomeUnknown;
          sentRetryWait = Boolean(rejection?.retry);
          if (!error.outcomeUnknown && !rejection?.retry) {
            await markAttention({
              userId: claim.turn.userId,
              turnId: claim.turn.id,
              leaseToken: claim.leaseToken,
              code: "MANUS_V2_ANCHOR_ERROR_RECOVERY_REJECTED",
            });
            return "attention_required";
          }
        }
        if (!sentOutcomeUnknown && !sentRetryWait) {
          await deferOutputPending({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            taskId: task.id,
          });
        }
        return "output_pending";
      }
      if (acknowledgement.kind === "accepted") {
        if (
          !manusV2EventsContainOperationToken(events, claim.turn.operationToken)
        ) {
          await markAttention({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            code: "MANUS_V2_ANCHOR_ACK_NOT_ATTRIBUTED",
          });
          return "attention_required";
        }
        await completeHandoff({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          taskId: task.id,
          acknowledgement: acknowledgement.acknowledgement,
        });
        void client.updateTaskVisibility(task.id, true).catch(() => undefined);
        return "completed";
      }
      const settlement = classifyKnowledgeBaseAnchorAcknowledgementSettlement({
        inspection: acknowledgement,
        taskStatus: status,
      });
      if (settlement.state === "attention_required") {
        await markAttention({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          code: settlement.code,
        });
        return "attention_required";
      }
      if (settlement.state === "output_pending") {
        await deferOutputPending({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          taskId: task.id,
        });
        return "output_pending";
      }
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The anchor acknowledgement settlement was inconsistent",
      );
    },
    classifyCreateFailure: (error) => {
      if (!(error instanceof ManusV2ApiError)) return "other";
      if (error.outcomeUnknown) return "outcome_unknown";
      return error.retryable ? "retryable_rejection" : "terminal_rejection";
    },
    markOutcomeUnknown: () =>
      markKnowledgeBaseManusV2OutcomeUnknown({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        code: "MANUS_V2_CREATE_OUTCOME_UNKNOWN",
      }),
    markRetryableRejection: (error?: unknown) =>
      deferKnowledgeBaseManusV2AnchorHandoffAfterRejection({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        code: "MANUS_V2_ANCHOR_CREATE_RETRYABLE",
        ...(error instanceof ManusV2ApiError && error.retryAfterMs !== null
          ? { recoveryDelayMs: error.retryAfterMs }
          : {}),
      }),
    markTerminalRejection: () =>
      markKnowledgeBaseManusV2AnchorHandoffAttentionRequired({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        code: "MANUS_V2_ANCHOR_CREATE_REJECTED",
      }),
  });
  return settled.state === "completed"
    ? {
        bound: true,
        reconciled: settled.source === "adopted",
        taskId: settled.task.id,
        locallySettled,
      }
    : settled.state === "output_pending" ||
        settled.state === "attention_required"
      ? {
          bound: true,
          reconciled: settled.source === "adopted",
          taskId: settled.task.id,
          settlement: settled.state,
        }
      : {
          bound: false,
          reconciled: true,
          matchCount: reconciledMatchCount,
        };
}

export const knowledgeBaseTerminalAnchorRecoveryTestHooks = {
  dispatchKnowledgeBaseAnchorHandoffClaim,
  dispatchKnowledgeBaseRecoveryClaim,
};

/**
 * Migrates active legacy builds one-by-one. Attempted operations settle first;
 * idle builds receive an anchor-only handoff, while a failed operation may
 * receive one hidden business replacement only after a full not-sent proof.
 */
export async function migrateActiveLegacyKnowledgeBaseBuilds(options?: {
  limit?: number;
  concurrency?: number;
  afterBuildId?: string;
  afterRebindBuildId?: string;
  leaseMs?: number;
}) {
  if (!knowledgeBaseManusV2ActiveMigrationEnabled()) {
    return {
      enabled: false,
      scanned: 0,
      reserved: 0,
      bound: 0,
      reconciled: 0,
      credentialRebindReserved: 0,
      credentialRebindSkipped: 0,
      existingNotSent: 0,
      awaitingLegacySettlement: 0,
      attentionRequired: 0,
      skipped: 0,
      failed: 0,
      nextCursor: null,
      hasMore: false,
      rebindNextCursor: null,
      rebindHasMore: false,
    };
  }
  const db = await getDb();
  if (!db) {
    return {
      enabled: true,
      scanned: 0,
      reserved: 0,
      bound: 0,
      reconciled: 0,
      credentialRebindReserved: 0,
      credentialRebindSkipped: 0,
      existingNotSent: 0,
      awaitingLegacySettlement: 0,
      attentionRequired: 0,
      skipped: 0,
      failed: 0,
      nextCursor: null,
      hasMore: false,
      rebindNextCursor: null,
      rebindHasMore: false,
    };
  }
  const limit = Math.min(200, Math.max(1, Math.trunc(options?.limit ?? 50)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const candidates = (await db
    .select({
      id: knowledgeBaseBuilds.id,
      userId: knowledgeBaseBuilds.userId,
      generation: knowledgeBaseBuilds.generation,
      stateEpoch: knowledgeBaseBuilds.stateEpoch,
      revision: knowledgeBaseBuilds.revision,
      currentLeafId: knowledgeBaseBuilds.currentLeafId,
      status: knowledgeBaseBuilds.status,
      activeTurnId: knowledgeBaseBuilds.activeTurnId,
      activeTurnStatus: conversationTurns.status,
      upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
      createAttemptState: sql<string | null>`COALESCE(
        JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.createAttemptState')),
        CASE
          WHEN ${conversationTurns.upstreamTaskId} IS NOT NULL THEN 'acknowledged'
          WHEN JSON_EXTRACT(${conversationTurns.metadata}, '$.outcomeUnknownAt') IS NOT NULL
            OR JSON_EXTRACT(${conversationTurns.metadata}, '$.dispatchingAt') IS NOT NULL
          THEN 'unknown'
          ELSE 'not_sent'
        END
      )`,
    })
    .from(knowledgeBaseBuilds)
    .leftJoin(
      conversationTurns,
      eq(conversationTurns.id, knowledgeBaseBuilds.activeTurnId),
    )
    .where(
      and(
        eq(knowledgeBaseBuilds.providerProtocol, "legacy_v1"),
        isNull(knowledgeBaseBuilds.canonicalTaskId),
        inArray(knowledgeBaseBuilds.status, [
          "researching",
          "confirming",
          "protocol_error",
        ]),
        options?.afterBuildId
          ? gt(knowledgeBaseBuilds.id, options.afterBuildId)
          : undefined,
      ),
    )
    .orderBy(asc(knowledgeBaseBuilds.id))
    .limit(limit)) as KnowledgeBaseActiveLegacyMigrationCandidate[];
  const result = {
    enabled: true,
    scanned: candidates.length,
    reserved: 0,
    bound: 0,
    reconciled: 0,
    credentialRebindReserved: 0,
    credentialRebindSkipped: 0,
    existingNotSent: 0,
    awaitingLegacySettlement: 0,
    attentionRequired: 0,
    skipped: 0,
    failed: 0,
    nextCursor: candidates.length
      ? candidates[candidates.length - 1]!.id
      : null,
    hasMore: candidates.length === limit,
    rebindNextCursor: null as string | null,
    rebindHasMore: false,
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!;
      const disposition = classifyKnowledgeBaseActiveLegacyMigration(candidate);
      try {
        if (disposition === "existing_not_sent_turn") {
          result.existingNotSent += 1;
          // Queued/running work is already owned by ordinary recovery, whose
          // lazy cutover is independently fenced by active-migration. A
          // failed operation needs a new hidden ledger only after the service
          // proves its provider boundary was never crossed and all immutable
          // local source bytes remain available.
          if (candidate.activeTurnStatus !== "failed") continue;
          await assertKnowledgeBaseWritable(candidate.userId);
          const replacementCredential =
            await getEffectiveDecryptedCredentialForAccount(candidate.userId);
          const replacement =
            await reserveKnowledgeBaseFailedNotSentLegacyHandoff({
              userId: candidate.userId,
              buildId: candidate.id,
              sourceTurnId: candidate.activeTurnId!,
              expectedGeneration: candidate.generation,
              expectedStateEpoch: candidate.stateEpoch,
              expectedRevision: candidate.revision,
              expectedLeafId: candidate.currentLeafId,
              replacementCredentialId: replacementCredential?.id ?? null,
            });
          if (replacement.state === "attention_required") {
            result.attentionRequired += 1;
            continue;
          }
          if (replacement.state !== "reserved") {
            result.skipped += 1;
            continue;
          }
          result.reserved += 1;
          const claim = await claimKnowledgeBaseTurnForRecovery({
            turnId: replacement.replacementTurnId,
            leaseMs: options?.leaseMs ?? 300_000,
            allowLegacySkill404IncidentRepair: true,
          });
          if (!claim) {
            // Another recovery worker may have claimed the just-installed
            // replacement. Its lease is authoritative; this sweep must not
            // report a false customer-attention condition or compete with it.
            result.skipped += 1;
            continue;
          }
          if (!claim.turn.apiCredentialId) {
            result.attentionRequired += 1;
            continue;
          }
          const credential =
            await getDecryptedCredentialForKnowledgeBaseReservation({
              userId: claim.turn.userId,
              turnId: claim.turn.id,
              buildId: claim.turn.buildId,
              buildGeneration: claim.turn.buildGeneration,
              apiCredentialId: claim.turn.apiCredentialId,
            });
          if (!credential) {
            result.attentionRequired += 1;
            continue;
          }
          let dispatched: Awaited<
            ReturnType<typeof dispatchKnowledgeBaseRecoveryClaim>
          >;
          try {
            dispatched = await withKnowledgeBaseRecoveryLeaseHeartbeat({
              claim,
              operation: () =>
                dispatchKnowledgeBaseRecoveryClaim(claim, credential),
            });
          } catch (error) {
            await persistKnowledgeBaseDispatchFailure({
              claim,
              error,
              outcomeUnknownCode: "LEGACY_FAILED_NOT_SENT_HANDOFF_DEFERRED",
            }).catch(() => undefined);
            throw error;
          }
          if (dispatched.rebound) result.bound += 1;
          if (dispatched.reconciled) result.reconciled += 1;
          continue;
        }
        if (disposition === "legacy_outcome_unknown") {
          // The legacy reconciliation path owns settlement of an already
          // attempted v1 create/send. This sweep must neither resend it nor
          // manufacture a v2 anchor. Failed turns are outside ordinary
          // recovery, so isolate them explicitly instead of leaving the
          // active legacy build permanently undiscoverable.
          if (candidate.activeTurnStatus === "failed") {
            await markLegacyKnowledgeBaseCreateAttentionRequired({
              userId: candidate.userId,
              turnId: candidate.activeTurnId!,
              expectedGeneration: candidate.generation,
            });
            result.attentionRequired += 1;
          } else {
            result.awaitingLegacySettlement += 1;
          }
          continue;
        }
        if (disposition !== "migrate_anchor") {
          result.skipped += 1;
          continue;
        }
        await assertKnowledgeBaseWritable(candidate.userId);
        let credential: Awaited<
          ReturnType<typeof getEffectiveDecryptedCredentialForAccount>
        > = candidate.upstreamTaskId
          ? await getCredentialForUpstreamResource(
              candidate.userId,
              "task",
              candidate.upstreamTaskId,
            )
          : null;
        let credentialMode: KnowledgeBaseAnchorHandoffCredentialMode =
          candidate.upstreamTaskId ? "legacy_task_owner" : "current_unbound";
        if (!credential) {
          credential = await getEffectiveDecryptedCredentialForAccount(
            candidate.userId,
          );
          credentialMode = candidate.upstreamTaskId
            ? "current_rebind"
            : "current_unbound";
        }
        if (!credential) {
          result.attentionRequired += 1;
          continue;
        }
        const reservation = await reserveKnowledgeBaseManusV2AnchorHandoff({
          userId: candidate.userId,
          buildId: candidate.id,
          expectedGeneration: candidate.generation,
          expectedStateEpoch: candidate.stateEpoch,
          expectedRevision: candidate.revision,
          expectedLeafId: candidate.currentLeafId,
          expectedLegacyTaskId: candidate.upstreamTaskId,
          apiCredentialId: credential.id,
          credentialMode,
          baseUrl: getUpstreamBaseUrl(),
          agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
          leaseMs: options?.leaseMs,
        });
        result.reserved += 1;
        const dispatched = await dispatchKnowledgeBaseAnchorHandoffClaim({
          claim: reservation,
          credential,
        });
        if (dispatched.bound) result.bound += 1;
        if (dispatched.reconciled) result.reconciled += 1;
      } catch (error) {
        if (
          error instanceof KnowledgeBaseTurnReservationError &&
          ["CONFLICT", "IDEMPOTENCY_PENDING", "LEASE_LOST"].includes(error.code)
        ) {
          result.skipped += 1;
        } else {
          result.failed += 1;
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event: "[KnowledgeBaseMigration] anchor_handoff_deferred",
            userId: candidate.userId,
            buildId: candidate.id,
            turnId: candidate.activeTurnId || undefined,
            error,
          });
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );

  // A deleted canonical credential is different from ordinary key rotation:
  // the old task is permanently unreadable. Only an idle, fully owned v2
  // anchor is eligible for a single self-contained generation+1 handoff.
  const rebindCandidates = (await db
    .select({
      id: knowledgeBaseBuilds.id,
      userId: knowledgeBaseBuilds.userId,
      generation: knowledgeBaseBuilds.generation,
      stateEpoch: knowledgeBaseBuilds.stateEpoch,
      revision: knowledgeBaseBuilds.revision,
      currentLeafId: knowledgeBaseBuilds.currentLeafId,
      status: knowledgeBaseBuilds.status,
      activeTurnId: knowledgeBaseBuilds.activeTurnId,
      canonicalTaskId: knowledgeBaseBuilds.canonicalTaskId,
      canonicalTaskGeneration: knowledgeBaseBuilds.canonicalTaskGeneration,
      canonicalCredentialId: knowledgeBaseBuilds.canonicalCredentialId,
      canonicalTaskState: knowledgeBaseBuilds.canonicalTaskState,
      protocolErrorCode: knowledgeBaseBuilds.protocolErrorCode,
      credentialStatus: apiCredentials.status,
      resourceTaskId: upstreamResources.upstreamId,
      resourceCredentialId: upstreamResources.apiCredentialId,
      resourceUserId: upstreamResources.userId,
      resourceProjectAssignmentId: upstreamResources.projectAssignmentId,
      conversationUserId: conversations.userId,
      conversationProjectAssignmentId: conversations.projectAssignmentId,
      conversationStatus: conversations.status,
      conversationDeletedAt: conversations.deletedAt,
    })
    .from(knowledgeBaseBuilds)
    .leftJoin(
      apiCredentials,
      eq(apiCredentials.id, knowledgeBaseBuilds.canonicalCredentialId),
    )
    .leftJoin(
      upstreamResources,
      and(
        eq(upstreamResources.kind, "task"),
        eq(upstreamResources.upstreamId, knowledgeBaseBuilds.canonicalTaskId),
        eq(
          upstreamResources.apiCredentialId,
          knowledgeBaseBuilds.canonicalCredentialId,
        ),
      ),
    )
    .leftJoin(
      conversations,
      and(
        eq(
          conversations.id,
          sql`CONCAT('u', ${knowledgeBaseBuilds.userId}, ':', ${knowledgeBaseBuilds.conversationId})`,
        ),
        eq(conversations.userId, knowledgeBaseBuilds.userId),
      ),
    )
    .where(
      and(
        eq(knowledgeBaseBuilds.providerProtocol, "manus_v2"),
        eq(knowledgeBaseBuilds.status, "confirming"),
        isNotNull(knowledgeBaseBuilds.canonicalTaskId),
        isNotNull(knowledgeBaseBuilds.canonicalCredentialId),
        // Filter before LIMIT. Otherwise ordinary active/retired credentials
        // can fill every page and permanently starve a deleted canonical
        // credential that needs the generation+1 handoff below. This scan is
        // intentionally independent from the legacy migration cursor: a v2
        // build is never ordered in the legacy candidate result set that
        // advances `afterBuildId`.
        eq(apiCredentials.status, "deleted"),
        options?.afterRebindBuildId
          ? gt(knowledgeBaseBuilds.id, options.afterRebindBuildId)
          : undefined,
      ),
    )
    .orderBy(asc(knowledgeBaseBuilds.id))
    .limit(limit)) as KnowledgeBaseCanonicalCredentialRebindCandidate[];

  result.rebindNextCursor = rebindCandidates.length
    ? rebindCandidates[rebindCandidates.length - 1]!.id
    : null;
  result.rebindHasMore = rebindCandidates.length === limit;

  for (const candidate of rebindCandidates) {
    if (
      classifyKnowledgeBaseManusV2CredentialRebind(candidate) !==
      "rebind_anchor"
    ) {
      result.credentialRebindSkipped += 1;
      continue;
    }
    try {
      const credential = await getEffectiveDecryptedCredentialForAccount(
        candidate.userId,
      );
      if (
        !credential ||
        !candidate.canonicalCredentialId ||
        credential.id === candidate.canonicalCredentialId
      ) {
        if (candidate.canonicalTaskId && candidate.canonicalCredentialId) {
          await markKnowledgeBaseManusV2CredentialRebindAttention({
            userId: candidate.userId,
            buildId: candidate.id,
            expectedGeneration: candidate.generation,
            expectedStateEpoch: candidate.stateEpoch,
            expectedCanonicalTaskId: candidate.canonicalTaskId,
            expectedCanonicalCredentialId: candidate.canonicalCredentialId,
          });
        }
        result.attentionRequired += 1;
        result.credentialRebindSkipped += 1;
        continue;
      }
      await assertKnowledgeBaseWritable(candidate.userId);
      const reservation = await reserveKnowledgeBaseManusV2AnchorHandoff({
        userId: candidate.userId,
        buildId: candidate.id,
        expectedGeneration: candidate.generation,
        expectedStateEpoch: candidate.stateEpoch,
        expectedRevision: candidate.revision,
        expectedLeafId: candidate.currentLeafId,
        expectedLegacyTaskId: null,
        sourceProtocol: "manus_v2",
        expectedCanonicalTaskId: candidate.canonicalTaskId,
        expectedCanonicalCredentialId: candidate.canonicalCredentialId,
        apiCredentialId: credential.id,
        credentialMode: "current_rebind",
        baseUrl: getUpstreamBaseUrl(),
        agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
        leaseMs: options?.leaseMs,
      });
      result.reserved += 1;
      result.credentialRebindReserved += 1;
      const dispatched = await dispatchKnowledgeBaseAnchorHandoffClaim({
        claim: reservation,
        credential,
      });
      if (dispatched.bound) result.bound += 1;
      if (dispatched.reconciled) result.reconciled += 1;
    } catch (error) {
      if (
        error instanceof KnowledgeBaseTurnReservationError &&
        ["CONFLICT", "IDEMPOTENCY_PENDING", "LEASE_LOST"].includes(error.code)
      ) {
        result.credentialRebindSkipped += 1;
      } else {
        result.failed += 1;
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event:
            "[KnowledgeBaseMigration] canonical_credential_rebind_deferred",
          userId: candidate.userId,
          buildId: candidate.id,
          error,
        });
      }
    }
  }

  // Complete crash-recovered reservations even when the legacy scan page no
  // longer contains them because the reservation already flipped protocol.
  const pending = await findRecoverableKnowledgeBaseAnchorHandoffTurnIds({
    limit,
  });
  for (const candidate of pending) {
    let claim: KnowledgeBaseRecoveryClaim | null = null;
    try {
      claim = await claimKnowledgeBaseManusV2AnchorHandoff({
        turnId: candidate.turnId,
        leaseMs: options?.leaseMs,
      });
      if (!claim?.turn.apiCredentialId) continue;
      const credential =
        await getDecryptedCredentialForKnowledgeBaseReservation({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          buildId: claim.turn.buildId,
          buildGeneration: claim.turn.buildGeneration,
          apiCredentialId: claim.turn.apiCredentialId,
        });
      if (!credential) {
        result.attentionRequired += 1;
        continue;
      }
      const dispatched = await dispatchKnowledgeBaseAnchorHandoffClaim({
        claim,
        credential,
      });
      if (dispatched.bound) result.bound += 1;
      if (dispatched.reconciled) result.reconciled += 1;
    } catch (error) {
      result.failed += 1;
      logKnowledgeBaseRuntimeFailure({
        level: "warn",
        event: "[KnowledgeBaseMigration] reserved_anchor_deferred",
        userId: candidate.userId,
        buildId: candidate.buildId,
        turnId: candidate.turnId,
        error,
      });
    }
  }
  return result;
}

/**
 * Finishes only already-created canonical anchor tasks that were quarantined
 * after a stopped task omitted its exact ACK. This is ordinary recovery, not
 * migration: it never reserves a build generation or calls task.create.
 */
export async function recoverTerminalKnowledgeBaseAnchorHandoffs(options?: {
  limit?: number;
  concurrency?: number;
  includeClaimedTurnIds?: boolean;
}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(options?.limit ?? 50)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const candidates =
    await findRecoverableKnowledgeBaseTerminalAnchorHandoffTurnIds({ limit });
  const result = {
    scanned: candidates.length,
    claimed: 0,
    claimedTurnIds: [] as string[],
    completed: 0,
    locallySettled: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      let recoveryApiKey: string | undefined;
      try {
        const claim = await claimKnowledgeBaseTerminalAnchorHandoffRecovery({
          turnId: candidate.turnId,
          leaseMs: 300_000,
        });
        if (!claim) {
          result.skipped += 1;
          continue;
        }
        result.claimed += 1;
        if (options?.includeClaimedTurnIds) {
          result.claimedTurnIds.push(claim.turn.id);
        }
        if (!claim.turn.apiCredentialId) {
          throw new Error(
            "Terminal anchor reservation has no credential binding",
          );
        }
        await assertKnowledgeBaseWritable(claim.turn.userId);
        const credential =
          await getDecryptedCredentialForKnowledgeBaseReservation({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            buildId: claim.turn.buildId,
            buildGeneration: claim.turn.buildGeneration,
            apiCredentialId: claim.turn.apiCredentialId,
          });
        if (!credential) {
          throw new Error("Terminal anchor credential version is unavailable");
        }
        recoveryApiKey = credential.apiKey;
        const recovered = await withKnowledgeBaseRecoveryLeaseHeartbeat({
          claim,
          operation: () =>
            dispatchKnowledgeBaseAnchorHandoffClaim({ claim, credential }),
        });
        if (recovered.settlement === "output_pending") {
          result.pending += 1;
        } else if (recovered.settlement === "attention_required") {
          result.skipped += 1;
        } else if (recovered.bound) {
          result.completed += 1;
          if (recovered.locallySettled === true) result.locallySettled += 1;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        result.failed += 1;
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: "[KnowledgeBaseAnchorRecovery] terminal_ack_deferred",
          userId: candidate.userId,
          buildId: candidate.buildId,
          turnId: candidate.turnId,
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

export async function persistKnowledgeBaseDispatchFailure(
  input: {
    claim: KnowledgeBaseRecoveryClaim;
    error: unknown;
    outcomeUnknownCode: string;
    recoveryDelayMs?: number;
    traceId?: string;
  },
  dependencies: {
    markManusV2OutcomeUnknown?: typeof markKnowledgeBaseManusV2OutcomeUnknown;
    persistCreateFailure?: typeof persistKnowledgeBaseCreateFailure;
    stopCompatibleCreateOutcomeUnknown?: typeof stopKnowledgeBaseCompatibleCreateOutcomeUnknown;
  } = {},
) {
  const markManusV2OutcomeUnknown =
    dependencies.markManusV2OutcomeUnknown ??
    markKnowledgeBaseManusV2OutcomeUnknown;
  const persistCreateFailure =
    dependencies.persistCreateFailure ?? persistKnowledgeBaseCreateFailure;
  const stopCompatibleCreateOutcomeUnknown =
    dependencies.stopCompatibleCreateOutcomeUnknown ??
    stopKnowledgeBaseCompatibleCreateOutcomeUnknown;
  if (input.error instanceof KnowledgeBaseManusV2RolloutDeferredError) {
    await deferKnowledgeBaseTurnBeforeCreate({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: input.error.code,
      recoveryDelayMs: input.recoveryDelayMs ?? 30_000,
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });
    return "retriable" as const;
  }
  const v2Error = input.error instanceof ManusV2ApiError ? input.error : null;
  const isCurrentExplicitV2Rejection =
    input.claim.turn.providerProtocol === "manus_v2" &&
    v2Error !== null &&
    !v2Error.outcomeUnknown &&
    (v2Error.operation === "task.create" ||
      v2Error.operation === "task.sendMessage") &&
    input.claim.turn.providerAttemptState === "sending";
  if (isCurrentExplicitV2Rejection && v2Error) {
    const requestShape = (
      v2Error as ManusV2ApiError & {
        frontmindRequestShape?: {
          promptUtf8Bytes: number;
          titleUtf8Bytes: number;
          attachmentCount: number;
          agentProfile: string | null;
          hasAgentProfile: boolean;
          hasStructuredOutputSchema: boolean;
          structuredOutputSchemaUtf8Bytes: number;
          structuredOutputSchemaSha256: string | null;
          compatibilityMode: "standard" | "minimal_v2_create";
        };
      }
    ).frontmindRequestShape;
    const settled = await settleKnowledgeBaseManusV2ExplicitRejection({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code:
        v2Error.operation === "task.create"
          ? "MANUS_V2_CREATE_REJECTED"
          : "MANUS_V2_SEND_REJECTED",
      retryable: v2Error.retryable,
      providerCode: v2Error.code,
      providerStatus: v2Error.status,
      providerRequestRef: v2Error.providerRequestId,
      providerField: v2Error.providerField,
      providerPath: v2Error.providerPath,
      ...(requestShape ? { providerRequestShape: requestShape } : {}),
      ...(v2Error.retryAfterMs !== null
        ? { recoveryDelayMs: v2Error.retryAfterMs }
        : {}),
    });
    return settled.retryScheduled
      ? ("retriable" as const)
      : ("deterministic" as const);
  }
  if (
    input.claim.turn.providerProtocol === "manus_v2" &&
    input.error instanceof ManusV2ApiError &&
    input.error.outcomeUnknown
  ) {
    if (
      input.claim.recoveryMetadata.compatibilityMode ===
      "minimal_v2_create"
    ) {
      await stopCompatibleCreateOutcomeUnknown({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        code: input.outcomeUnknownCode,
      });
      return "deterministic" as const;
    }
    await markManusV2OutcomeUnknown({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: input.outcomeUnknownCode,
      ...(input.recoveryDelayMs
        ? { recoveryDelayMs: input.recoveryDelayMs }
        : {}),
    });
    return "retriable" as const;
  }
  if (
    input.claim.turn.providerProtocol === "manus_v2" &&
    (input.claim.turn.providerAttemptState === "output_pending" ||
      input.claim.turn.providerAttemptState === "outcome_unknown")
  ) {
    // The provider POST may already have returned 2xx before a local binding,
    // ownership, or follow-up persistence transaction failed. Once the v2
    // in-memory ledger has crossed to `output_pending`, every non-explicit
    // failure is ambiguous:
    // using the legacy marker would persist createAttemptState=unknown while
    // leaving providerAttemptState=sending, a combination excluded from the
    // recovery scan. Keep it on the v2 read/reconcile-only path instead; task
    // create is adopted by title+operation token and sendMessage by the exact
    // token on the existing canonical anchor, with no second provider POST.
    await markManusV2OutcomeUnknown({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: input.outcomeUnknownCode,
      ...(input.recoveryDelayMs
        ? { recoveryDelayMs: input.recoveryDelayMs }
        : {}),
    });
    return "retriable" as const;
  }
  return persistCreateFailure({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    error: input.error,
    outcomeUnknownCode: input.outcomeUnknownCode,
    ...(input.recoveryDelayMs
      ? { recoveryDelayMs: input.recoveryDelayMs }
      : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
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
  const allowLegacySkill404IncidentRepair =
    knowledgeBaseManusV2ActiveMigrationEnabled();
  const candidates = await findRecoverableKnowledgeBaseTurnIds({
    limit,
    allowLegacySkill404IncidentRepair,
  });
  const result = {
    scanned: candidates.length,
    claimed: 0,
    claimedTurnIds: [] as string[],
    rebound: 0,
    reconciled: 0,
    credentialPaused: 0,
    localRehydrateSelfTerminalReclassified: 0,
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
        if (
          await reclassifyHistoricalPreproviderAuthoritySelfTerminal({
            turnId: candidate.turnId,
          })
        ) {
          result.localRehydrateSelfTerminalReclassified += 1;
          result.skipped += 1;
          continue;
        }
        claim = await claimKnowledgeBaseTurnForRecovery({
          turnId: candidate.turnId,
          leaseMs: 300_000,
          allowLegacySkill404IncidentRepair,
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
        let credential: Awaited<
          ReturnType<typeof getDecryptedCredentialForKnowledgeBaseReservation>
        > = null;
        let credentialUnavailable = !ownedClaim.turn.apiCredentialId;
        if (!credentialUnavailable) {
          try {
            credential =
              await getDecryptedCredentialForKnowledgeBaseReservation({
                userId: ownedClaim.turn.userId,
                turnId: ownedClaim.turn.id,
                buildId: ownedClaim.turn.buildId!,
                buildGeneration: ownedClaim.turn.buildGeneration!,
                apiCredentialId: ownedClaim.turn.apiCredentialId!,
              });
            credentialUnavailable = credential === null;
          } catch (error) {
            credentialUnavailable =
              error instanceof AuthServiceError &&
              error.code === "INVALID_CREDENTIAL";
            if (!credentialUnavailable) throw error;
          }
        }
        if (credentialUnavailable) {
          const paused = await pauseKnowledgeBasePreCreateCredentialUnavailable(
            {
              userId: ownedClaim.turn.userId,
              turnId: ownedClaim.turn.id,
              leaseToken: ownedClaim.leaseToken,
            },
          );
          if (paused) {
            result.credentialPaused += 1;
            continue;
          }
          throw new Error("Reserved credential version is unavailable");
        }
        if (!credential) {
          throw new Error("Reserved credential resolution was inconclusive");
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
            const localAuthoritySettled =
              await knowledgeBaseLocalRehydrateAuthorityFailureForPersistence({
                userId: claim.turn.userId,
                turnId: claim.turn.id,
                leaseToken: claim.leaseToken,
                error: failureToPersist,
              }).catch(() => false);
            if (!localAuthoritySettled) {
              await persistKnowledgeBaseDispatchFailure({
                claim,
                error: failureToPersist,
                outcomeUnknownCode: "RECOVERY_DEFERRED",
              }).catch(() => undefined);
            }
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

export async function knowledgeBaseLocalRehydrateAuthorityFailureForPersistence(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    error: unknown;
  },
  dependencies: {
    failDeterministically?: typeof failKnowledgeBaseTurnDeterministically;
  } = {},
) {
  if (
    !(input.error instanceof KnowledgeBaseLocalPreparationError) ||
    input.error.code !== "KNOWLEDGE_BASE_LOCAL_REHYDRATE_AUTHORITY_INVALID"
  ) {
    return false;
  }
  await (
    dependencies.failDeterministically ?? failKnowledgeBaseTurnDeterministically
  )({
    userId: input.userId,
    turnId: input.turnId,
    leaseToken: input.leaseToken,
    code: input.error.code,
    message: `${input.error.message}。未向上游创建任务`,
    failureClass: "terminal_nonregenerable",
    recoveryAction: "contact_support",
    canRegenerate: false,
  });
  return true;
}

async function uploadDurableKnowledgeBaseGeneratedAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  reusableUpstreamFileId?: string | null;
  durable: DurableKnowledgeBaseGeneratedAttachment;
  providerProtocol?: "legacy_v1" | "manus_v2";
  replacementAttempted?: boolean;
}) {
  const mimeType = input.mimeType || "application/zip";
  // Install the exact generated bytes before the first provider file POST.
  // Provider file ids can expire; this immutable source is the recovery fact.
  const localSource = await persistKnowledgeBaseGeneratedSource(input.bytes);
  const reservation = await reserveKnowledgeBaseGeneratedAttachment({
    userId: input.durable.userId,
    turnId: input.durable.turnId,
    leaseToken: input.durable.leaseToken,
    role: input.durable.role,
    attachmentIndex: input.durable.attachmentIndex,
    filename: input.filename,
    mimeType,
    sizeBytes: input.bytes.length,
    contentSha256: localSource.contentSha256,
    localStorageKey: localSource.storageKey,
  });
  if (input.providerProtocol === "manus_v2") {
    // v2 task files must originate in /v2. This source id is only an ordered
    // Dashboard ledger coordinate and is never sent to Manus. If a legacy
    // migration already staged a v1 id in this exact slot, retain it solely
    // as the frozen source coordinate so recovery does not rewrite history.
    const localSourceId =
      reservation.upstreamFileId ||
      `kb-local-${reservation.requestHash.slice(0, 48)}`;
    return {
      attachment: { file_id: localSourceId, filename: input.filename },
      fileId: localSourceId,
      removeOrphan: async () => undefined,
    };
  }
  const reusableUpstreamFileId = String(
    input.reusableUpstreamFileId || "",
  ).trim();
  if (
    reusableUpstreamFileId &&
    reservation.upstreamFileId === reusableUpstreamFileId
  ) {
    await waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      attachments: [
        { file_id: reusableUpstreamFileId, filename: input.filename },
      ],
      attachmentKind: "generated",
      filenamePolicy: "exact",
    });
    await promoteKnowledgeBaseGeneratedAttachmentReady({
      userId: input.durable.userId,
      turnId: input.durable.turnId,
      leaseToken: input.durable.leaseToken,
      role: input.durable.role,
      attachmentIndex: input.durable.attachmentIndex,
      requestHash: reservation.requestHash,
      upstreamFileId: reusableUpstreamFileId,
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
    // `uploadUpstreamTaskAttachment` resolves only after readiness (and, for
    // recovered candidates, byte-for-byte content proof). Promote after it
    // returns so a candidate can never leak into a task body prematurely.
    const uploaded = await uploadUpstreamTaskAttachment({
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
    await promoteKnowledgeBaseGeneratedAttachmentReady({
      userId: input.durable.userId,
      turnId: input.durable.turnId,
      leaseToken: input.durable.leaseToken,
      role: input.durable.role,
      attachmentIndex: input.durable.attachmentIndex,
      requestHash: reservation.requestHash,
      upstreamFileId: uploaded.fileId,
    });
    return uploaded;
  } catch (error) {
    const definitelyUnusableCandidate =
      reservation.upstreamFileId &&
      ((error instanceof UpstreamFileReadinessError &&
        !error.retryable &&
        error.code === "UPSTREAM_FILE_UNUSABLE") ||
        (error instanceof UpstreamTaskAttachmentContentProofError &&
          !error.retryable &&
          error.httpStatus === 404));
    if (definitelyUnusableCandidate && !input.replacementAttempted) {
      await replaceUnusableKnowledgeBaseGeneratedAttachment({
        userId: input.durable.userId,
        turnId: input.durable.turnId,
        leaseToken: input.durable.leaseToken,
        role: input.durable.role,
        attachmentIndex: input.durable.attachmentIndex,
        requestHash: reservation.requestHash,
        upstreamFileId: reservation.upstreamFileId!,
      });
      return uploadDurableKnowledgeBaseGeneratedAttachment({
        ...input,
        reusableUpstreamFileId: null,
        replacementAttempted: true,
      });
    }
    throw knowledgeBaseGeneratedAttachmentFailureForPersistence(error);
  }
}

export async function uploadKnowledgeBaseSkillArchive({
  baseUrl,
  apiKey,
  skillVersion = "4",
  skillContentHash,
  archive: pinnedArchive,
  reusableUpstreamFileId,
  durable,
  providerProtocol,
}: {
  baseUrl: string;
  apiKey: string;
  skillVersion?: string;
  skillContentHash?: string | null;
  archive?: Awaited<ReturnType<typeof ensureKnowledgeBaseBuildSkillArchivePin>>;
  reusableUpstreamFileId?: string | null;
  durable?: Omit<DurableKnowledgeBaseGeneratedAttachment, "role">;
  providerProtocol?: "legacy_v1" | "manus_v2";
}) {
  const archive =
    pinnedArchive ||
    (await readKnowledgeBaseSkillArchiveAttachment({
      version: skillVersion,
      contentHash: skillContentHash,
    }));
  if (
    pinnedArchive &&
    String(skillContentHash || "") !== pinnedArchive.contentHash
  ) {
    throw new Error(
      "Pinned Skill archive does not match the logical build pin",
    );
  }
  const uploaded = durable
    ? await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
        reusableUpstreamFileId,
        providerProtocol,
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
    if (isKnowledgeBaseManusV2GeneratedFileCreateRejected(input.error)) {
      // file.upload explicitly rejected this server-generated source before
      // task.create/sendMessage. The durable create_rejected row is the
      // at-most-once proof used by the next claim to switch only that small
      // Skill/instructions slot to official Manus v2 inline file_data.
      await deferBeforeCreate({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: "KNOWLEDGE_BASE_MANUS_V2_INLINE_SYSTEM_ATTACHMENT",
        recoveryDelayMs: 1_000,
        traceId: input.traceId,
      });
      return "retriable" as const;
    }
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
    const persisted = await persistKnowledgeBaseDispatchFailure({
      claim: input.claim,
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
          allowLegacySkill404IncidentRepair:
            knowledgeBaseManusV2ActiveMigrationEnabled(),
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

/**
 * Commits the Dashboard build and logical start turn before the browser sends
 * file bytes. This endpoint deliberately performs no provider file/task call;
 * `/turn/dispatch` is the only route that may acquire a worker lease.
 */
router.post("/start/reserve", async (req, res) => {
  const body = (req.body || {}) as KnowledgeBaseStartRequest & {
    attachmentManifest?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const requestedCompanyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_START_RESERVATION",
        message: "知识库启动预约参数无效",
      },
      reservationCreated: false,
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
    res.status(401).json({
      error: {
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "请先配置 API Key",
      },
      reservationCreated: false,
    });
    return;
  }

  const requestTraceId = randomUUID();
  let reservationCreated = false;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest =
      Array.isArray(body.attachmentManifest) &&
      body.attachmentManifest.length === 0
        ? []
        : normalizeKnowledgeBaseClientAttachmentManifest(
            body.attachmentManifest,
          );
    const workspace = await getDashboardWorkspace(req.frontmindUser.id);
    const companyName = resolveKnowledgeBaseEnterpriseIdentity({
      sourceName: workspace.sourceName,
      brandName: workspace.payload.brandName,
      requestedCompanyName,
    });
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
        },
        reservationCreated: false,
      });
      return;
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
    const start = await reserveKnowledgeBaseStartBuild({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      companyName,
      companyWebsite,
      skillName: latestSkillDescriptor.name,
      skillVersion: latestSkillDescriptor.version,
      skillContentHash: latestSkillDescriptor.contentHash,
      skillArchiveSha256: latestSkillDescriptor.physicalSha256,
      skillArchiveBytes: latestSkillDescriptor.archiveBytes,
      skillArchiveStorageKey: latestSkillDescriptor.storageKey,
      treePolicyVersion: newBuildPolicy.treePolicyVersion,
      apiCredentialId: req.frontmindCredential.id,
      userText: "开始构建企业知识库",
      userAttachmentCount: attachmentManifest.length,
      expectedAttachmentCount:
        attachmentManifest.length + 2 + (prefillKnowledgeSnapshot ? 1 : 0),
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: attachmentManifest,
      expectedResetRevision,
      requestPayload: {
        companyName,
        companyWebsite,
        operatorNotes,
        sourceResetRevision: expectedResetRevision,
        attachments: [],
        attachmentManifest,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
      },
      recoveryMetadata: {
        traceId: requestTraceId,
        kind: "start",
        conversationId,
        sourceResetRevision: expectedResetRevision,
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: [],
        attachmentManifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        skillArchiveSha256: latestSkillDescriptor.physicalSha256,
        skillArchiveBytes: latestSkillDescriptor.archiveBytes,
        skillArchiveStorageKey: latestSkillDescriptor.storageKey,
        includePrefill: Boolean(prefillKnowledgeSnapshot),
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
        instructionsAttachmentRequired: true,
      },
    });
    reservationCreated = true;
    const progress = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.status(start.createdBuild ? 201 : 200).json({
      traceId: start.reservation.turn.traceId || requestTraceId,
      reservation: knowledgeBaseReservationReceipt(
        start.reservation as Exclude<
          KnowledgeBaseTurnReservation,
          { state: "acquired" }
        >,
        observation?.stateEpoch,
      ),
      observation,
      progress: observation?.interaction.progress || progress,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(progress, "running"),
      accepted: true,
      reservationCreated: true,
      idempotent: !start.createdBuild,
      startedAt: start.reservation.turn.createdAt.getTime(),
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        traceId: requestTraceId,
        error: { code: error.code, message: error.message },
        reservationCreated,
      });
      return;
    }
    if (error instanceof KnowledgeBaseEnterpriseIdentityError) {
      res.status(error.code === "ENTERPRISE_NOT_CONFIGURED" ? 422 : 409).json({
        traceId: requestTraceId,
        error: { code: error.code, message: error.message },
        reservationCreated,
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseStartReserve] failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    res.status(503).json({
      traceId: requestTraceId,
      error: {
        code: "KNOWLEDGE_BASE_START_RESERVATION_FAILED",
        message: "启动预约失败，请稍后重试同一请求",
      },
      reservationCreated: false,
    });
  }
});

/**
 * Customer-requested release of an incomplete browser upload batch. This
 * route performs no Provider work; the service repeats every no-dispatch and
 * reset-epoch proof under locks before releasing the start operation slot.
 */
router.post("/start/cancel", async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !turnId ||
    turnId.length > 36 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_START_CANCELLATION",
        message: "知识库资料批次取消参数无效",
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
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const cancelled = await cancelIncompleteKnowledgeBaseStart({
      userId: req.frontmindUser.id,
      conversationId,
      turnId,
      clientRequestId,
      expectedResetRevision,
    });
    res.status(200).json({
      cancelled: true,
      resetRevision: cancelled.resetRevision,
      idempotent: cancelled.idempotent,
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }
});

router.post("/start/recover", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: unknown;
    expectedGeneration?: unknown;
    expectedStateEpoch?: unknown;
    clientRequestId?: unknown;
    mode?: unknown;
    attachments?: unknown;
    attachmentManifest?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedGeneration = Number(body.expectedGeneration);
  const expectedStateEpoch = Number(body.expectedStateEpoch);
  const mode = String(body.mode || "");
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 1 ||
    !Number.isSafeInteger(expectedStateEpoch) ||
    expectedStateEpoch < 0 ||
    (mode !== "resume_start_from_retained_sources" &&
      mode !== "reselect_start_sources")
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_START_RECOVERY",
        message: "知识库启动恢复参数无效",
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
    res.status(401).json({
      error: {
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "请先配置 API Key",
      },
    });
    return;
  }
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const replay = await findKnowledgeBaseRetainedStartRecoveryReplay({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
    });
    if (replay) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      });
      res.status(200).json({
        applied: true,
        idempotent: true,
        mode: replay.mode,
        reservation: {
          turnId: replay.turnId,
          clientRequestId: replay.clientRequestId,
          generation: replay.generation,
          chargeDisposition: "reuse_original_no_charge",
        },
        observation,
      });
      return;
    }
    const preview =
      await previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance({
        userId: req.frontmindUser.id,
        conversationId,
        repairKind: "retained_upstream_create_3_start",
      });
    if (!preview) {
      res.status(404).json({
        error: { code: "BUILD_NOT_FOUND", message: "知识库构建不存在" },
      });
      return;
    }
    if (
      preview.buildGeneration !== expectedGeneration ||
      preview.stateEpoch !== expectedStateEpoch
    ) {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_START_RECOVERY_STALE",
          message: "知识库状态已变化，请刷新后再试",
        },
      });
      return;
    }
    if (
      preview.requiresReselection.length > 0 &&
      mode !== "reselect_start_sources"
    ) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      res.status(409).json({
        mode: "reselect_start_sources",
        requiresReselection: preview.requiresReselection,
        observation,
      });
      return;
    }
    if (
      preview.requiresReselection.length === 0 &&
      mode !== "resume_start_from_retained_sources"
    ) {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_RETAINED_SOURCES_AVAILABLE",
          message: "原资料仍完整，请使用原资料重新开始",
        },
      });
      return;
    }
    const applied = await executeKnowledgeBaseRetainedStartRecoveryFromCustomer(
      {
        userId: req.frontmindUser.id,
        conversationId,
        expectedStateHash: preview.stateHash,
        clientRequestId,
        replacementCredentialId: req.frontmindCredential.id,
        ...(mode === "reselect_start_sources"
          ? {
              replacementSources: {
                attachments: normalizeKnowledgeBaseUserAttachments(
                  Array.isArray(body.attachments)
                    ? (body.attachments as KnowledgeBaseAttachment[])
                    : undefined,
                ),
                attachmentManifest:
                  normalizeKnowledgeBaseClientAttachmentManifest(
                    body.attachmentManifest,
                  ),
              },
            }
          : {}),
      },
    );
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    if (!applied.applied) {
      const concurrentReplay =
        applied.noopReason === "state_changed"
          ? await findKnowledgeBaseRetainedStartRecoveryReplay({
              userId: req.frontmindUser.id,
              conversationId,
              clientRequestId,
            })
          : null;
      if (concurrentReplay) {
        res.status(200).json({
          applied: true,
          idempotent: true,
          mode: concurrentReplay.mode,
          reservation: {
            turnId: concurrentReplay.turnId,
            clientRequestId: concurrentReplay.clientRequestId,
            generation: concurrentReplay.generation,
            chargeDisposition: "reuse_original_no_charge",
          },
          observation,
        });
        return;
      }
      res
        .status(applied.noopReason === "requires_reselection" ? 409 : 200)
        .json({
          applied: false,
          idempotent: applied.noopReason === "state_changed",
          mode:
            applied.noopReason === "requires_reselection"
              ? "reselect_start_sources"
              : "resume_start_from_retained_sources",
          requiresReselection: applied.requiresReselection,
          observation,
        });
      return;
    }
    res.status(202).json({
      applied: true,
      mode,
      reservation: {
        turnId: applied.replacementTurnId,
        clientRequestId,
        generation: applied.generation,
        chargeDisposition: "reuse_original_no_charge",
      },
      observation,
    });
  } catch (error) {
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseStartRecovery] failed",
      error,
    });
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_START_RECOVERY_FAILED",
        message: "启动恢复失败，请使用同一请求稍后重试",
      },
    });
  }
});

router.post("/recovery/execute", async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const conversationId = String(body.conversationId || "").trim();
  const recoveryToken = String(body.recoveryToken || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !/^[a-f0-9]{64}$/u.test(recoveryToken) ||
    !clientRequestId ||
    clientRequestId.length > 128
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_RECOVERY",
        message: "知识库恢复参数无效",
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
    res.status(401).json({
      error: {
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "请先配置 API Key",
      },
    });
    return;
  }
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const replay = await findKnowledgeBaseExplicitRecoveryReplay({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      recoveryToken,
    });
    if (replay) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      });
      res.status(200).json({
        disposition: "already_applied",
        recoveryId: replay.id,
        accepted: true,
        resumed: false,
        observation,
      });
      return;
    }
    await normalizeKnowledgeBaseTerminalRejection({
      userId: req.frontmindUser.id,
      conversationId,
    });
    const decision = await inspectKnowledgeBaseExplicitRecovery({
      userId: req.frontmindUser.id,
      conversationId,
      recoveryToken,
    });
    if (!decision) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      res.status(409).json({
        disposition: "state_changed",
        accepted: false,
        resumed: false,
        observation,
      });
      return;
    }
    if (decision.recovery.action === "stopped") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      });
      res.status(200).json({
        disposition: "stopped",
        accepted: false,
        resumed: false,
        observation,
      });
      return;
    }
    if (decision.recovery.action === "retry_compatible_create") {
      const reservation = await reserveKnowledgeBaseCompatibleCreateRecovery({
        userId: req.frontmindUser.id,
        conversationId,
        clientRequestId,
        recoveryToken,
        apiCredentialId: req.frontmindCredential.id,
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      });
      res.status(reservation.state === "reserved" ? 202 : 200).json({
        disposition:
          reservation.state === "reserved" ? "accepted" : "already_applied",
        recoveryId: reservation.claim.turn.id,
        accepted: true,
        resumed: reservation.state === "reserved",
        observation,
      });
      if (reservation.state === "reserved") {
        launchAcceptedKnowledgeBaseClaim({
          claim: reservation.claim,
          credential: req.frontmindCredential,
          outcomeUnknownCode:
            "KNOWLEDGE_BASE_COMPATIBLE_CREATE_OUTCOME_UNKNOWN",
        });
      }
      return;
    }
    const build = decision.build;
    const handoffProvenance =
      build.handoffProvenance &&
      typeof build.handoffProvenance === "object" &&
      !Array.isArray(build.handoffProvenance)
        ? build.handoffProvenance
        : null;
    if (handoffProvenance?.localRehydrateRequired) {
      if (!build.currentLeafId || !build.currentPresentationKey) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The accepted presentation coordinate is unavailable",
        );
      }
      const reservation = await reserveKnowledgeBaseNewCanonicalFromSnapshot({
        userId: req.frontmindUser.id,
        conversationId,
        clientRequestId,
        expectedGeneration: build.generation,
        expectedStateEpoch: build.stateEpoch,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        expectedPresentationKey: build.currentPresentationKey,
        apiCredentialId: req.frontmindCredential.id,
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      });
      res.status(reservation.state === "reserved" ? 202 : 200).json({
        disposition:
          reservation.state === "reserved" ? "accepted" : "already_applied",
        recoveryId: reservation.claim.turn.id,
        accepted: true,
        resumed: reservation.state === "reserved",
        observation,
      });
      if (reservation.state === "reserved") {
        launchAcceptedKnowledgeBaseClaim({
          claim: reservation.claim,
          credential: req.frontmindCredential,
          outcomeUnknownCode: "LOCAL_REHYDRATE_NEW_CANONICAL_OUTCOME_UNKNOWN",
        });
      }
      return;
    }
    if (!build.canonicalTaskId || !build.canonicalCredentialId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The rejected canonical source is unavailable",
      );
    }
    const reservation = await reserveKnowledgeBaseManusV2AnchorHandoff({
      userId: req.frontmindUser.id,
      buildId: build.id,
      expectedGeneration: build.generation,
      expectedStateEpoch: build.stateEpoch,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      expectedLegacyTaskId: null,
      sourceProtocol: "manus_v2",
      expectedCanonicalTaskId: build.canonicalTaskId,
      expectedCanonicalCredentialId: build.canonicalCredentialId,
      apiCredentialId: req.frontmindCredential.id,
      credentialMode: "current_rebind",
      baseUrl: getUpstreamBaseUrl(req),
      agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
      clientRequestId,
      recoverySourceTurnId: decision.recovery.sourceTurnId,
      recoveryToken,
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.status(202).json({
      disposition: "accepted",
      recoveryId: reservation.turn.id,
      accepted: true,
      resumed: true,
      observation,
    });
    void dispatchKnowledgeBaseAnchorHandoffClaim({
      claim: reservation,
      credential: req.frontmindCredential,
    }).catch((error) =>
      logKnowledgeBaseRuntimeFailure({
        level: "warn",
        event: "[KnowledgeBaseExplicitRecovery] anchor_dispatch_deferred",
        userId: req.frontmindUser!.id,
        buildId: build.id,
        turnId: reservation.turn.id,
        error,
        additionalSecrets: [req.frontmindCredential?.apiKey],
      }),
    );
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const concurrentReplay = await findKnowledgeBaseExplicitRecoveryReplay({
        userId: req.frontmindUser.id,
        conversationId,
        clientRequestId,
        recoveryToken,
      }).catch(() => null);
      if (concurrentReplay) {
        const observation = await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        });
        res.status(200).json({
          disposition: "already_applied",
          recoveryId: concurrentReplay.id,
          accepted: true,
          resumed: false,
          observation,
        });
        return;
      }
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
      }).catch(() => null);
      res.status(error.code === "INVALID_REQUEST" ? 400 : 409).json({
        disposition: "state_changed",
        accepted: false,
        resumed: false,
        error: { code: error.code, message: error.message },
        observation,
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseExplicitRecovery] failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_RECOVERY_UNAVAILABLE",
        message: "当前恢复暂时不可用，请使用同一请求稍后重试",
      },
    });
  }
});

router.post("/canonical/recover-from-snapshot", async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedGeneration = Number(body.expectedGeneration);
  const expectedStateEpoch = Number(body.expectedStateEpoch);
  const expectedRevision = Number(body.expectedRevision);
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  const expectedPresentationKey = String(
    body.expectedPresentationKey || "",
  ).trim();
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 1 ||
    !Number.isSafeInteger(expectedStateEpoch) ||
    expectedStateEpoch < 0 ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !expectedLeafId ||
    !expectedPresentationKey
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_CANONICAL_RECOVERY",
        message: "新任务恢复坐标无效，请刷新后重试",
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
    res.status(401).json({
      error: {
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "请先配置 API Key",
      },
    });
    return;
  }
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const reservation = await reserveKnowledgeBaseNewCanonicalFromSnapshot({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      expectedGeneration,
      expectedStateEpoch,
      expectedRevision,
      expectedLeafId,
      expectedPresentationKey,
      apiCredentialId: req.frontmindCredential.id,
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.status(reservation.state === "reserved" ? 202 : 200).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: reservation.claim.turn,
        stateEpoch: observation?.stateEpoch,
      }),
      observation,
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      accepted: true,
      idempotent: reservation.state === "replay",
      chargeDisposition: "reuse_original_no_charge",
    });
    if (reservation.state === "reserved") {
      launchAcceptedKnowledgeBaseClaim({
        claim: reservation.claim,
        credential: req.frontmindCredential,
        outcomeUnknownCode: "LOCAL_REHYDRATE_NEW_CANONICAL_OUTCOME_UNKNOWN",
      });
    }
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "failed",
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
          ...(observation ? { observation } : {}),
        });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseCanonicalSnapshotRecovery] failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_CANONICAL_RECOVERY_FAILED",
        message: "创建新任务恢复暂时失败，请使用同一请求重试",
      },
    });
  }
});

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
  if (!req.frontmindUser) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  const requestTraceId = randomUUID();
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
    // Compatibility is intentionally read-only: exact requests which were
    // already reserved by an older Dashboard build can still recover their
    // receipt. Every new start must establish Dashboard ownership before any
    // browser byte or provider file/task call.
    res.status(410).json({
      traceId: requestTraceId,
      error: {
        code: "KNOWLEDGE_BASE_START_RESERVATION_REQUIRED",
        message: "客户端版本已更新，请刷新页面后重新开始上传",
        traceId: requestTraceId,
      },
      reservationCreated: false,
    });
  } catch (error: any) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        traceId: requestTraceId,
        error: { code: error.code, message: error.message },
        reservationCreated: false,
      });
      return;
    }
    if (error instanceof KnowledgeBaseEnterpriseIdentityError) {
      res.status(error.code === "ENTERPRISE_NOT_CONFIGURED" ? 422 : 409).json({
        traceId: requestTraceId,
        error: error.message,
        code: error.code,
        reservationCreated: false,
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseLegacyStartReplay] failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    res.status(503).json({
      traceId: requestTraceId,
      error: {
        code: "KNOWLEDGE_BASE_START_REPLAY_FAILED",
        message: "正在核对旧版启动请求，请稍后重试",
        traceId: requestTraceId,
      },
      reservationCreated: false,
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
    const deferredLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: boundBuild.providerProtocol,
      legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(boundBuild),
    });
    if (deferredLogoPolicy.rejectRepeatedOfficialLogo) {
      assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
        boundBuild,
        attachmentManifest,
      );
    }
    await assertKnowledgeBaseCustomerUploadCapacity({
      userId: req.frontmindUser.id,
      buildId: boundBuild.id,
      generation: boundBuild.generation,
      officialLogoSha256: boundBuild.logoSha256,
      officialLogoRequired: deferredLogoPolicy.requiresOfficialLogo,
      attachmentManifest,
    });
    if (
      deferredLogoPolicy.requiresOfficialLogo &&
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
    const taskCredential = parentTaskId
      ? await getCredentialForUpstreamResource(
          req.frontmindUser.id,
          "task",
          parentTaskId,
        )
      : req.frontmindCredential;
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
    if (finalPackageRequired && deferredLogoPolicy.assertFinalLogoProvenance) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser.id,
        boundBuild,
      );
    }
    if (finalPackageRequired) {
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: boundBuild.skillVersion,
        skillContentHash: boundBuild.skillContentHash,
      });
    }
    const skillDescriptor = {
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
        ...(authority.kind === "local_rehydrate_unbound"
          ? {
              localRehydrateAuthority: authority.kind,
              chargeDisposition: "reuse_original_no_charge",
            }
          : {}),
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
    expectedResetRevision?: number;
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
      !manifestItem.itemId ||
      manifestItem.ordinal !== index + 1 ||
      manifestItem.total !== manifest.length ||
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
    const isStartReservation = Boolean(
      build &&
        build.activeTurnId === turnId &&
        build.revision === 0 &&
        build.currentLeafId === null,
    );
    const expectedResetRevision = isStartReservation
      ? Number(body.expectedResetRevision)
      : undefined;
    const parentTaskId = String(
      build?.canonicalTaskId || build?.upstreamTaskId || "",
    );
    const localRehydrateRequired = Boolean(
      build?.providerProtocol === "manus_v2" &&
        !build.canonicalTaskId &&
        build.handoffProvenance &&
        typeof build.handoffProvenance === "object" &&
        !Array.isArray(build.handoffProvenance) &&
        build.handoffProvenance.localRehydrateRequired,
    );
    if (
      !build ||
      (!isStartReservation && !parentTaskId && !localRehydrateRequired)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    // A first start reservation has no provider task by design. Its exact
    // credential was frozen on the durable turn before any browser bytes.
    const projectAssignmentId =
      req.frontmindDeliveryProjectContext?.projectAssignmentId;
    const taskCredential = isStartReservation
      ? await getDecryptedCredentialForKnowledgeBaseUploadReservation({
          userId: req.frontmindUser.id,
          conversationId,
          turnId,
          projectAssignmentId: projectAssignmentId ?? null,
        })
      : parentTaskId
        ? await getCredentialForUpstreamResource(
            req.frontmindUser.id,
            "task",
            parentTaskId,
            projectAssignmentId,
          )
        : req.frontmindCredential;
    const fileCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "file",
      attachment.file_id,
      projectAssignmentId,
    );
    if (
      !fileCredential ||
      (isStartReservation
        ? !taskCredential || fileCredential.id !== taskCredential.id
        : !taskCredential ||
          !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential))
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
    // A provider file id is never sufficient authority for staging. Resolve
    // the exact server-owned managed intent by the frozen itemId, prove its
    // receipt/provider generation, then read the Dashboard retained stream to
    // EOF and re-hash it before any turn metadata is mutated.
    const managedUploadProof = await proveKnowledgeBaseManagedUploadForStage({
      userId: req.frontmindUser.id,
      projectAssignmentId: projectAssignmentId ?? null,
      conversationId,
      turnId,
      clientRequestId,
      credential: {
        id: fileCredential.id,
        userId: fileCredential.userId,
        version: fileCredential.version,
      },
      manifestItem: {
        itemId: manifestItem.itemId,
        filename: manifestItem.filename,
        mimeType: manifestItem.mimeType,
        sizeBytes: manifestItem.sizeBytes,
        sha256: manifestItem.sha256,
        ordinal: manifestItem.ordinal,
        total: manifestItem.total,
      },
      index,
      total: manifest.length,
      fileId: attachment.file_id,
    });
    // Install immutable build-owned bytes before the DB stage. A crash here
    // can leave only a content-addressed duplicate; it cannot authorize the
    // turn. Once the DB write succeeds, active-build recovery no longer
    // depends on the generic 30-day retained-file lifetime.
    const buildOwnedSource = await persistKnowledgeBaseBuildSource({
      userId: req.frontmindUser.id,
      buildId: build.id,
      generation: build.generation,
      bytes: managedUploadProof.bytes,
    });
    if (
      buildOwnedSource.contentSha256 !== managedUploadProof.sha256 ||
      buildOwnedSource.sizeBytes !== managedUploadProof.sizeBytes
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Dashboard 知识库固定副本与上传证明不一致",
      );
    }
    const deferredLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: build.providerProtocol,
      legacyLogoRequired:
        !isStartReservation && knowledgeBaseBuildRequiresOfficialLogo(build),
    });
    const deferredOfficialLogoRequired =
      deferredLogoPolicy.requiresOfficialLogo;
    if (
      deferredLogoPolicy.rejectRepeatedOfficialLogo &&
      knowledgeBaseManifestRepeatsOfficialLogo(build, manifest)
    ) {
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
    const dispatchClaim = isStartReservation
      ? {
          state: "awaiting_attachments" as const,
          turn: await stageKnowledgeBaseDeferredTurnAttachment({
            userId: req.frontmindUser.id,
            buildId: build.id,
            turnId,
            clientRequestId,
            clientAttachmentManifest: manifest,
            expectedResetRevision,
            index,
            attachment,
            managedUploadProof: {
              intentId: managedUploadProof.intentId,
              itemId: managedUploadProof.operationId,
              mimeType: managedUploadProof.mimeType,
              sizeBytes: managedUploadProof.sizeBytes,
              contentSha256: managedUploadProof.sha256,
              localStorageKey: buildOwnedSource.storageKey,
            },
            projectAssignmentId: projectAssignmentId ?? null,
          }),
        }
      : await stageAndClaimKnowledgeBaseDeferredTurnAttachment({
          userId: req.frontmindUser.id,
          buildId: build.id,
          turnId,
          clientRequestId,
          clientAttachmentManifest: manifest,
          index,
          attachment,
          managedUploadProof: {
            intentId: managedUploadProof.intentId,
            itemId: managedUploadProof.operationId,
            mimeType: managedUploadProof.mimeType,
            sizeBytes: managedUploadProof.sizeBytes,
            contentSha256: managedUploadProof.sha256,
            localStorageKey: buildOwnedSource.storageKey,
          },
          projectAssignmentId: projectAssignmentId ?? null,
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
          credential: taskCredential!,
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
    if (error instanceof ManagedUploadIntentError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
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
    expectedResetRevision?: number;
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
    const attachmentManifest =
      Array.isArray(body.attachmentManifest) &&
      body.attachmentManifest.length === 0
        ? []
        : normalizeKnowledgeBaseClientAttachmentManifest(
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
    const isStartReservation = Boolean(
      build &&
        build.activeTurnId === turnId &&
        build.revision === 0 &&
        build.currentLeafId === null,
    );
    const expectedResetRevision = isStartReservation
      ? Number(body.expectedResetRevision)
      : undefined;
    const parentTaskId = String(
      build?.canonicalTaskId || build?.upstreamTaskId || "",
    );
    const localRehydrateRequired = Boolean(
      build?.providerProtocol === "manus_v2" &&
        !build.canonicalTaskId &&
        build.handoffProvenance &&
        typeof build.handoffProvenance === "object" &&
        !Array.isArray(build.handoffProvenance) &&
        build.handoffProvenance.localRehydrateRequired,
    );
    if (
      !build ||
      (!isStartReservation && !parentTaskId && !localRehydrateRequired)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    // Run before claimKnowledgeBaseDeferredTurnDispatch mutates the lease. The
    // assertion is a no-op outside the final v4 coordinate.
    const dispatchLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: build.providerProtocol,
      legacyLogoRequired:
        !isStartReservation && knowledgeBaseBuildRequiresOfficialLogo(build),
    });
    if (!isStartReservation && dispatchLogoPolicy.assertFinalLogoProvenance) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser.id,
        build,
      );
    }
    const projectAssignmentId =
      req.frontmindDeliveryProjectContext?.projectAssignmentId;
    const taskCredential = isStartReservation
      ? await getDecryptedCredentialForKnowledgeBaseUploadReservation({
          userId: req.frontmindUser.id,
          conversationId,
          turnId,
          projectAssignmentId: projectAssignmentId ?? null,
        })
      : parentTaskId
        ? await getCredentialForUpstreamResource(
            req.frontmindUser.id,
            "task",
            parentTaskId,
            projectAssignmentId,
          )
        : req.frontmindCredential;
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
      expectedResetRevision,
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

    const officialLogoRequired = dispatchLogoPolicy.requiresOfficialLogo;
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
      credential: taskCredential!,
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
    const directLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: boundBuild.providerProtocol,
      manualLogoSubmission,
      legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(boundBuild),
    });
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
    const taskCredential = taskId
      ? await getCredentialForUpstreamResource(
          req.frontmindUser!.id,
          "task",
          taskId,
        )
      : authority.kind === "local_rehydrate_unbound"
        ? req.frontmindCredential
        : null;
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

      const officialLogoRequired = directLogoPolicy.requiresOfficialLogo;
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
      directLogoPolicy.validateManualLogoSubmission &&
      attachmentManifest?.[0] &&
      attachments[0]
        ? {
            index: 0,
            fileId: attachments[0].file_id,
            filename: attachmentManifest[0].filename,
            mimeType: attachmentManifest[0].mimeType,
            sizeBytes: attachmentManifest[0].sizeBytes,
            sourceSha256: attachmentManifest[0].sha256,
          }
        : directLogoPolicy.inferOrdinaryAttachmentAsLogo &&
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
    if (directLogoPolicy.requiresOfficialLogo && !officialLogoUploadCandidate) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "请先上传一张合格的企业官方主 Logo，再继续确认第一个知识节点",
      );
    }
    if (
      directLogoPolicy.validateManualLogoSubmission &&
      officialLogoUploadCandidate
    ) {
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
    if (finalPackageRequired && directLogoPolicy.assertFinalLogoProvenance) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser!.id,
        boundBuild,
      );
    }
    if (finalPackageRequired) {
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: boundBuild.skillVersion,
        skillContentHash: boundBuild.skillContentHash,
      });
    }
    const currentSkillDescriptor = {
      version: boundBuild.skillVersion,
      contentHash: boundBuild.skillContentHash,
    };
    const recoveryMetadata = {
      kind: "turn",
      conversationId,
      parentTaskId: taskId,
      ...(authority.kind === "local_rehydrate_unbound"
        ? {
            localRehydrateAuthority: authority.kind,
            chargeDisposition: "reuse_original_no_charge",
          }
        : {}),
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
          failureClass = await persistKnowledgeBaseDispatchFailure({
            claim: acceptedClaim,
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
      const retryLogoPolicy = knowledgeBaseTurnLogoPolicy({
        providerProtocol: retryBuild.providerProtocol,
        legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(retryBuild),
      });
      if (retryLogoPolicy.assertFinalLogoProvenance) {
        await assertKnowledgeBaseFinalLogoProvenanceForBuild(
          req.frontmindUser.id,
          retryBuild,
        );
      }
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
    // Local-only compatibility repair: release historical failed writer
    // fences before projecting state. It never creates files/tasks or binds a
    // credential; provider writes require /recovery/execute.
    await normalizeKnowledgeBaseTerminalRejection({
      userId: req.frontmindUser.id,
      conversationId,
    });
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
            code: "FRONTMIND_KB_RETRY_AVAILABLE",
            message: "知识库任务凭证暂不可用，正在保留并复核当前状态",
          },
          observation: failure.observation,
          progress: failure.observation?.interaction.progress || null,
          interaction: failure.observation?.interaction || null,
        });
      }
      return;
    }
    if (boundBuild.providerProtocol === "manus_v2") {
      const reconciled = await reconcilePolledManusV2KnowledgeBaseTask({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        apiKey: credential.apiKey,
        baseUrl: getUpstreamBaseUrl(req),
        build: boundBuild,
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: reconciled.taskStatus,
      });
      res.json({
        progress:
          observation?.interaction.progress ||
          reconciled.progress ||
          currentObservation?.interaction.progress ||
          null,
        interaction:
          observation?.interaction ||
          currentObservation?.interaction ||
          deriveKnowledgeBaseInteraction(
            reconciled.progress,
            reconciled.taskStatus,
          ),
        observation,
      });
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
            code: "FRONTMIND_KB_RETRY_AVAILABLE",
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
            code: "FRONTMIND_KB_RETRY_AVAILABLE",
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
