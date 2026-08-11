import axios from "axios";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import {
  canonicalKnowledgeBaseSkillArchiveHash,
  legacyKnowledgeBaseSkillInstructionHash,
} from "../shared/knowledge-base-skill-archive-hash.js";

import {
  KnowledgeBaseEnterpriseIdentityError,
  KnowledgeBaseOpenRecoveryLeaseError,
  KnowledgeBaseUpstreamCreateError,
  KNOWLEDGE_BASE_AGENT_PROFILE,
  KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE,
  KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE,
  KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION,
  KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
  buildKnowledgeBasePrompt,
  buildKnowledgeBaseTurnPrompt,
  buildKnowledgeBasePrefillEvidenceArchive,
  buildKnowledgePrefillExcerpt,
  canonicalKnowledgeBaseUpstreamTask,
  assertKnowledgeBaseAttachmentManifestPresent,
  assertKnowledgeBaseExpectedGeneration,
  assertManualKnowledgeBaseLogoUploadCandidate,
  classifyKnowledgeBaseUpstreamCreateFailure,
  classifyKnowledgeBaseOpenRecoveryFailure,
  createFrontMindTask,
  deriveKnowledgeBaseInteraction,
  getKnowledgeBaseSkillDescriptor,
  knowledgeBasePinnedV4SkillSelection,
  isApprovedKnowledgeBaseAwaitingInputObservation,
  knowledgeBaseArtifactFailureNotice,
  knowledgeBaseManualLogoCreateFailureForPersistence,
  knowledgeBaseManualLogoUnclassifiedFailureResponse,
  knowledgeBaseNoticeAllowsSameTaskReconcile,
  knowledgeBaseManualLogoPendingResponse,
  knowledgeBaseManualLogoDeterministicCreateFailureStatus,
  knowledgeBaseManualLogoTerminalFailure,
  knowledgeBaseTurnReplayHttpStatus,
  knowledgeBaseTurnReservationErrorStatus,
  knowledgeBaseUpstreamReadFailureAuthority,
  knowledgeBaseRecoveryLogoPreparationError,
  knowledgeBaseReconcileFailureStatus,
  knowledgeBaseAcceptedReservationReceipt,
  knowledgeBaseReservationReceipt,
  loadKnowledgeBaseTurnAuthority,
  logKnowledgeBaseRuntimeFailure,
  normalizeRecoveredTaskOutput,
  normalizeKnowledgeBaseClientAttachmentManifest,
  persistKnowledgeBaseCreateFailure,
  readKnowledgeBaseSkillArchiveAttachment,
  recoverKnowledgeBaseTurnClaimTask,
  resolveKnowledgeBaseEnterpriseIdentity,
  selectUnreconciledKnowledgeOutput,
  shouldReplayStableKnowledgeOutput,
  shouldBindKnowledgeBaseInitialLogo,
  shouldReconcileKnowledgeOutput,
  uploadKnowledgeBaseSkillArchive,
  withKnowledgeBaseOpenRecoveryLeaseHeartbeat,
} from "./knowledge-base-api";
import { KnowledgeBaseLocalPreparationError } from "./knowledge-base-api-errors";
import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";
import { KnowledgeBaseArtifactBindingError } from "./knowledge-base-artifact-binding-service";
import { KnowledgeBaseBuildError } from "./knowledge-base-progress-service";
import { knowledgeBaseLogoRepairFileIsOwned } from "./knowledge-base-logo-provenance-api";
import { applyKnowledgeBaseFinalLogoProvenanceObservation } from "./knowledge-base-logo-provenance-repair";

function expectEnterpriseIdentityError(
  action: () => unknown,
  code: KnowledgeBaseEnterpriseIdentityError["code"],
) {
  try {
    action();
    throw new Error("Expected KnowledgeBaseEnterpriseIdentityError");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseEnterpriseIdentityError);
    expect((error as KnowledgeBaseEnterpriseIdentityError).code).toBe(code);
  }
}

describe("knowledge-base turn HTTP outcomes", () => {
  it("keeps all in-flight receipts on 202 and terminal receipts on 409", () => {
    expect(knowledgeBaseTurnReplayHttpStatus("pending")).toBe(202);
    expect(knowledgeBaseTurnReplayHttpStatus("bound")).toBe(202);
    expect(knowledgeBaseTurnReplayHttpStatus("awaiting_attachments")).toBe(200);
    expect(knowledgeBaseTurnReplayHttpStatus("completed")).toBe(200);
    expect(knowledgeBaseTurnReplayHttpStatus("terminal")).toBe(409);
  });

  it("returns one authoritative reservation receipt without inventing a task id", () => {
    const turn = {
      id: "turn-reserved",
      clientRequestId: "request-reserved",
      buildGeneration: 4,
      expectedRevision: 8,
      expectedLeafId: "1.4",
      upstreamTaskId: null,
      dispatchState: "reserved",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
      stagedUserAttachmentCount: 0,
      expectedUserAttachmentCount: 0,
    } as any;

    expect(
      knowledgeBaseReservationReceipt(
        {
          state: "pending",
          turn,
          retryAfterMs: 1_000,
        } as any,
        11,
      ),
    ).toMatchObject({
      state: "pending",
      dispatchState: "recovering",
      turnId: "turn-reserved",
      upstreamTaskId: null,
      stateEpoch: 11,
      canRegenerate: false,
    });
    expect(
      knowledgeBaseAcceptedReservationReceipt({ turn, stateEpoch: 11 }),
    ).toMatchObject({
      state: "pending",
      dispatchState: "recovering",
      turnId: "turn-reserved",
      upstreamTaskId: null,
      stateEpoch: 11,
      canRegenerate: false,
    });
    expect(
      knowledgeBaseAcceptedReservationReceipt({
        turn: {
          ...turn,
          id: "turn-bound",
          upstreamTaskId: "provider-task-bound",
          dispatchState: "reserved",
        },
      }),
    ).toMatchObject({
      dispatchState: "bound",
      turnId: "turn-bound",
      upstreamTaskId: "provider-task-bound",
    });
  });

  it("persists pre-create attachment rejection as a same-turn repair receipt", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const cancelUnprepared = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const common = {
      userId: 7,
      turnId: "turn-attachment-repair",
      leaseToken: "lease-attachment-repair",
      outcomeUnknownCode: "SHOULD_NOT_BE_USED",
    };

    await expect(
      persistKnowledgeBaseCreateFailure(
        {
          ...common,
          error: new KnowledgeBaseUpstreamCreateError(
            "deterministic",
            "UPSTREAM_CREATE_HTTP_413",
            413,
          ),
        },
        { failDeterministically, cancelUnprepared, markOutcomeUnknown },
      ),
    ).resolves.toBe("deterministic");
    expect(failDeterministically).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        failureClass: "requires_user_fix",
        recoveryAction: "fix_attachments",
        canRegenerate: false,
      }),
    );
    expect(cancelUnprepared).not.toHaveBeenCalled();
    expect(markOutcomeUnknown).not.toHaveBeenCalled();

    failDeterministically.mockClear();
    await persistKnowledgeBaseCreateFailure(
      {
        ...common,
        error: new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
          "受管附件完整性校验失败",
        ),
      },
      { failDeterministically, cancelUnprepared, markOutcomeUnknown },
    );
    expect(failDeterministically).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        failureClass: "requires_user_fix",
        recoveryAction: "fix_attachments",
        canRegenerate: false,
      }),
    );
  });

  it("keeps Logo re-upload separate and never labels server finalization as attachment repair", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const cancelUnprepared = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      failDeterministically,
      cancelUnprepared,
      markOutcomeUnknown: vi.fn().mockResolvedValue(undefined),
    };
    const common = {
      userId: 7,
      turnId: "turn-local-preparation",
      leaseToken: "lease-local-preparation",
      outcomeUnknownCode: "SHOULD_NOT_BE_USED",
    };

    await persistKnowledgeBaseCreateFailure(
      {
        ...common,
        error: new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          "Logo 字节不可解码",
        ),
      },
      dependencies,
    );
    expect(cancelUnprepared).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      }),
    );
    expect(failDeterministically).not.toHaveBeenCalled();

    cancelUnprepared.mockClear();
    await persistKnowledgeBaseCreateFailure(
      {
        ...common,
        error: new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_FINALIZATION_INPUT_INVALID",
          "最终交付输入损坏",
        ),
      },
      dependencies,
    );
    expect(failDeterministically).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      }),
    );
    expect(cancelUnprepared).not.toHaveBeenCalled();
  });

  it("exposes stable stale/replay/Logo status mappings", () => {
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "STALE_KNOWLEDGE_BASE_PRESENTATION",
          "stale",
        ),
      ),
    ).toBe(409);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
          "mismatch",
        ),
      ),
    ).toBe(409);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          "conflict",
        ),
      ),
    ).toBe(409);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          "invalid",
        ),
      ),
    ).toBe(422);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "IDEMPOTENCY_PENDING",
          "pending",
          1_000,
        ),
      ),
    ).toBe(425);
  });

  it("returns a branded 425 contract while a manual Logo reservation is recoverable", () => {
    const observation = { stateEpoch: 7 } as any;
    const response = knowledgeBaseManualLogoPendingResponse({
      observation,
      retryAfterMs: 1_250,
    });

    expect(response).toEqual({
      status: 425,
      retryAfterSeconds: "2",
      body: {
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "FrontMind 已接收 Logo，正在重新呈现当前知识节点",
        },
        observation,
      },
    });
    expect(response.body.error.message).toBe(
      KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE,
    );
    expect(JSON.stringify(response.body)).not.toMatch(/manus/iu);
  });

  it("keeps the upstream Logo instruction out of the customer-visible message", () => {
    expect(KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE).toBe(
      "已提交新的企业官方主 Logo，正在重新呈现当前知识节点。",
    );
    expect(KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE).not.toContain(
      "不得确认或推进节点",
    );
    expect(KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION).toContain(
      "不得确认或推进节点",
    );
  });

  it("keeps unclassified manual Logo failures recoverable without claiming a pre-reservation submit", () => {
    const observation = { generation: 4, stateEpoch: 9 } as any;
    expect(
      knowledgeBaseManualLogoUnclassifiedFailureResponse({
        reservationAcquired: true,
        observation,
        retryAfterMs: 1_250,
      }),
    ).toEqual({
      status: 425,
      retryAfterSeconds: "2",
      body: {
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "FrontMind 已接收 Logo，正在重新呈现当前知识节点",
        },
        observation,
      },
    });
    expect(
      knowledgeBaseManualLogoUnclassifiedFailureResponse({
        reservationAcquired: false,
        observation,
        retryAfterMs: 1_250,
      }),
    ).toEqual({
      status: 503,
      retryAfterSeconds: "2",
      body: {
        error: {
          code: "KNOWLEDGE_BASE_LOGO_SUBMISSION_UNCERTAIN",
          message: "Logo 提交结果暂未确认，系统将按同一请求自动重试",
        },
        observation,
      },
    });
  });

  it("keeps deterministic manual Logo validation and coordinate failures terminal", () => {
    expect(
      knowledgeBaseManualLogoTerminalFailure(
        new KnowledgeBaseArtifactBindingError(
          "LOGO_UPLOAD_INVALID",
          "Logo 原始字节无效",
        ),
      ),
    ).toEqual({
      status: 422,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "Logo 原始字节无效",
    });
    expect(
      knowledgeBaseManualLogoTerminalFailure(
        new KnowledgeBaseArtifactBindingError(
          "BUILD_CHANGED",
          "当前节点坐标已变化",
        ),
      ),
    ).toEqual({
      status: 409,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
      message: "当前节点坐标已变化",
    });
    expect(
      knowledgeBaseManualLogoTerminalFailure(
        new KnowledgeBaseArtifactBindingError(
          "ARTIFACT_DOWNLOAD_FAILED",
          "临时读取失败",
        ),
      ),
    ).toBeNull();
  });

  it.each([
    [400, 400],
    [401, 403],
    [403, 403],
    [404, 422],
    [409, 409],
    [413, 413],
    [422, 422],
    [502, 422],
  ])(
    "maps deterministic manual Logo provider status %i to public status %i",
    (providerStatus, publicStatus) => {
      expect(
        knowledgeBaseManualLogoDeterministicCreateFailureStatus(
          new KnowledgeBaseUpstreamCreateError(
            "deterministic",
            `UPSTREAM_CREATE_HTTP_${providerStatus}`,
            providerStatus,
          ),
        ),
      ).toBe(publicStatus);
    },
  );

  it.each([
    [425, "UPSTREAM_CREATE_HTTP_425"],
    [409, "UPSTREAM_CREATE_HTTP_409"],
    [503, "UPSTREAM_CREATE_HTTP_503"],
  ])(
    "does not map recoverable manual Logo provider status %i to a terminal response",
    (status, code) => {
      expect(
        knowledgeBaseManualLogoDeterministicCreateFailureStatus(
          new KnowledgeBaseUpstreamCreateError("retriable", code, status),
        ),
      ).toBeNull();
    },
  );

  it("keeps a successful create response without a task id pending for manual Logo reconciliation", () => {
    const missingTaskId = new KnowledgeBaseUpstreamCreateError(
      "deterministic",
      "UPSTREAM_TASK_ID_MISSING",
      502,
    );

    expect(
      knowledgeBaseManualLogoDeterministicCreateFailureStatus(missingTaskId),
    ).toBeNull();
    expect(
      knowledgeBaseManualLogoCreateFailureForPersistence(missingTaskId),
    ).toMatchObject({
      failureClass: "unknown",
      failureCode: "UPSTREAM_TASK_ID_MISSING",
      status: 502,
    });
  });

  it("validates a managed manual Logo before a turn can be reserved", async () => {
    const candidate = {
      index: 0,
      fileId: "managed-logo-file",
      filename: "official-logo.png",
      mimeType: "image/png",
      sizeBytes: 128,
      sourceSha256: "a".repeat(64),
    };
    const validateCapturedImage = vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
      aspectRatio: 1,
      pixels: Buffer.alloc(0),
    });

    await expect(
      assertManualKnowledgeBaseLogoUploadCandidate(
        candidate,
        validateCapturedImage,
      ),
    ).resolves.toBeUndefined();
    expect(validateCapturedImage).toHaveBeenCalledWith({
      fileId: candidate.fileId,
      filename: candidate.filename,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.sizeBytes,
      sourceSha256: candidate.sourceSha256,
    });

    validateCapturedImage.mockClear();
    await expect(
      assertManualKnowledgeBaseLogoUploadCandidate(
        { ...candidate, mimeType: "image/bmp" },
        validateCapturedImage,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });
    expect(validateCapturedImage).not.toHaveBeenCalled();

    validateCapturedImage.mockRejectedValueOnce(new Error("decode failed"));
    await expect(
      assertManualKnowledgeBaseLogoUploadCandidate(
        candidate,
        validateCapturedImage,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });
  });
});

describe("knowledge-base upstream read failure authority", () => {
  it.each([
    [
      { kind: "credential_unavailable" as const },
      "requires_user_fix",
      "update_credential",
      "UPSTREAM_CREDENTIAL_UNAVAILABLE",
    ],
    [
      { kind: "http" as const, status: 401 },
      "requires_user_fix",
      "update_credential",
      "UPSTREAM_CREDENTIAL_REJECTED",
    ],
    [
      { kind: "http" as const, status: 403 },
      "requires_user_fix",
      "update_credential",
      "UPSTREAM_CREDENTIAL_REJECTED",
    ],
    [
      { kind: "transport" as const },
      "recoverable_same_turn",
      "reconcile",
      "UPSTREAM_TASK_READ_FAILED",
    ],
    [
      { kind: "http" as const, status: 429 },
      "recoverable_same_turn",
      "reconcile",
      "UPSTREAM_TASK_READ_FAILED",
    ],
    [
      { kind: "http" as const, status: 503 },
      "recoverable_same_turn",
      "reconcile",
      "UPSTREAM_TASK_READ_FAILED",
    ],
  ])(
    "classifies $0 without granting regeneration",
    (input, failureClass, recoveryAction, code) => {
      expect(knowledgeBaseUpstreamReadFailureAuthority(input)).toEqual({
        code,
        failureClass,
        recoveryAction,
        canRegenerate: false,
      });
    },
  );

  it("reopens the exact bound task after credentials are updated", () => {
    expect(
      knowledgeBaseNoticeAllowsSameTaskReconcile({
        recoveryAction: "update_credential",
        canRegenerate: false,
      }),
    ).toBe(true);
    expect(
      knowledgeBaseNoticeAllowsSameTaskReconcile({
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
      }),
    ).toBe(false);
  });

  it("reserves 422 for semantic protocol failures and reports runtime/database failures as 503", () => {
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseBuildError("PROGRESS_PROTOCOL_INVALID", "invalid"),
      ),
    ).toBe(422);
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseBuildError("BUILD_NOT_FOUND", "missing"),
      ),
    ).toBe(404);
    expect(
      knowledgeBaseReconcileFailureStatus(
        Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" }),
      ),
    ).toBe(503);
    expect(
      knowledgeBaseReconcileFailureStatus(
        Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      ),
    ).toBe(503);
  });
});

describe("knowledge base execution contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("observes a rejected open-recovery renewal immediately and reports lease loss after the operation", async () => {
    vi.useFakeTimers();
    let finishOperation!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishOperation = () => resolve("completed-after-renewal-failure");
        }),
    );
    const renewLease = vi.fn().mockRejectedValue(new Error("database down"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const heartbeat = withKnowledgeBaseOpenRecoveryLeaseHeartbeat({
        claim: {
          build: {
            id: "build-open-recovery",
            generation: 2,
          } as any,
          kind: "reconcile",
          leaseToken: "lease-token",
          leaseExpiresAt: new Date("2026-08-01T00:00:01.000Z"),
        },
        leaseMs: 1_000,
        operation,
        renewLease: renewLease as any,
      });

      await vi.advanceTimersByTimeAsync(334);
      expect(renewLease).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      finishOperation();
      await expect(heartbeat).rejects.toMatchObject({
        name: "KnowledgeBaseOpenRecoveryLeaseError",
        code: "KNOWLEDGE_BASE_OPEN_RECOVERY_LEASE_LOST",
        cause: expect.any(Error),
      } satisfies Partial<KnowledgeBaseOpenRecoveryLeaseError>);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps dashboard knowledge-base builds on the Pro model", () => {
    expect(KNOWLEDGE_BASE_AGENT_PROFILE).toBe("frontmind-pro");
  });

  it("does not let optional Logo provenance replace the authoritative observation", () => {
    const progress = {
      build: {
        id: "build-final",
        conversationId: "conversation-final",
        companyName: "企业",
        skillVersion: "4",
        status: "protocol_error" as const,
        revision: 50,
        currentLeafId: "7.5",
        protocolError: "旧的最终 ZIP 错误",
        awaitingResponseSince: null,
        updatedAt: 123,
      },
      summary: {
        total: 50,
        handled: 49,
        confirmed: 49,
        directPrefilled: 0,
        pending: 0,
        current: 1,
        needsVerification: 0,
      },
      branches: [],
      packageAllowed: false,
    };
    const ordinary = deriveKnowledgeBaseInteraction(progress, "failed");
    const projected = applyKnowledgeBaseFinalLogoProvenanceObservation({
      state: "missing",
      progress,
      interaction: ordinary,
      observation: {
        generation: 3,
        activeTurn: null,
        notice: {
          key: "old",
          code: "FINAL_PACKAGE_INVALID",
          severity: "error",
          message: "旧错误",
          retryable: true,
          turnId: null,
          createdAt: 1,
        },
      },
    });
    expect(projected.notice).toEqual({
      key: "old",
      code: "FINAL_PACKAGE_INVALID",
      severity: "error",
      message: "旧错误",
      retryable: true,
      turnId: null,
      createdAt: 1,
    });
    expect(projected.interaction).toEqual(ordinary);
  });

  it("authorizes a newly owned repair upload without comparing its credential to the historical task", () => {
    expect(
      knowledgeBaseLogoRepairFileIsOwned({ id: "fresh-credential-version" }),
    ).toBe(true);
    expect(knowledgeBaseLogoRepairFileIsOwned(null)).toBe(false);
  });

  it("treats an exact approved awaiting-input projection as observation-only", () => {
    const observation = {
      stateEpoch: 7,
      generation: 2,
      authoritativeTaskId: "task-completed-1",
      activeTurn: null,
      approvedPresentation: {
        turnId: "turn-completed-1",
        clientRequestId: "request-1",
        presentationKey: "presentation-1",
        revision: 1,
        leafId: "1.2",
        visibleMarkdown: "## 1.2 企业主体\n\n已批准正文。",
        contentSha256: "a".repeat(64),
        imageState: "no_eligible_asset",
        resources: [],
      },
      package: null,
      notice: null,
      conversationVersion: 4,
      interaction: {
        interactionState: "awaiting_input",
        canReply: true,
        canPublish: false,
        lockReason: null,
        progress: {
          build: {
            id: "build-1",
            conversationId: "conversation-1",
            companyName: "FrontMind超前智能",
            status: "confirming",
            revision: 1,
            currentLeafId: "1.2",
            protocolError: null,
            awaitingResponseSince: null,
            updatedAt: 1,
          },
          summary: {} as any,
          branches: [],
          packageAllowed: false,
        },
      },
    } as const;

    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation(observation as any),
    ).toBe(true);
    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation({
        ...observation,
        approvedPresentation: {
          ...observation.approvedPresentation,
          revision: 0,
        },
      } as any),
    ).toBe(false);
    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation({
        ...observation,
        activeTurn: { id: "turn-active" },
      } as any),
    ).toBe(false);
  });

  it("normalizes a stable pre-upload attachment manifest and rejects partial entries", () => {
    expect(
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          name: "facts.pdf",
          size: 12,
          type: "application/pdf",
          lastModified: 10,
          sha256: "a".repeat(64),
        },
      ]),
    ).toEqual([
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ]);
    expect(
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          filename: "FrontMind_logo.svg",
          sizeBytes: 42,
          mimeType: "application/octet-stream",
          lastModified: 11,
          sha256: "b".repeat(64),
        },
      ])[0]?.mimeType,
    ).toBe("image/svg+xml");
    expect(() =>
      normalizeKnowledgeBaseClientAttachmentManifest([
        { filename: "facts.pdf", mimeType: "application/pdf" },
      ]),
    ).toThrow("manifest entry 1 is invalid");
    expect(() =>
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          filename: "facts.pdf",
          sizeBytes: 12,
          mimeType: "application/pdf",
          lastModified: 10,
        },
      ]),
    ).toThrow("manifest entry 1 is invalid");
  });

  it("requires the exact browser-byte manifest for every v4 attachment", () => {
    expect(() =>
      assertKnowledgeBaseAttachmentManifestPresent({
        skillVersion: "4",
        attachmentCount: 1,
        attachmentManifest: undefined,
      }),
    ).toThrow("必须完成浏览器原始字节校验");
    expect(() =>
      assertKnowledgeBaseAttachmentManifestPresent({
        skillVersion: "4",
        attachmentCount: 1,
        attachmentManifest: [
          {
            filename: "proof.jpg",
            sizeBytes: 12,
            mimeType: "image/jpeg",
            lastModified: 10,
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseAttachmentManifestPresent({
        skillVersion: "3",
        attachmentCount: 1,
        attachmentManifest: undefined,
      }),
    ).not.toThrow();
  });

  it("rejects a stale optional generation before reserving a turn", () => {
    expect(() =>
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration: 3,
        actualGeneration: 4,
      }),
    ).toThrow("已重置或进入新一代构建");
    expect(() =>
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration: 4,
        actualGeneration: 4,
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration: undefined,
        actualGeneration: 4,
      }),
    ).not.toThrow();
  });

  it("derives a turn build and parent task from one server-owned snapshot", async () => {
    let currentBuild = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      upstreamTaskId: "task-parent",
      revision: 3,
    };
    const loadBuild = vi.fn(async () => ({ ...currentBuild }) as any);

    const pendingAuthority = loadKnowledgeBaseTurnAuthority(
      { userId: 7, conversationId: "conversation-1" },
      loadBuild,
    );
    currentBuild = {
      ...currentBuild,
      upstreamTaskId: "task-newly-bound",
    };

    await expect(pendingAuthority).resolves.toMatchObject({
      build: {
        id: "build-1",
        userId: 7,
        conversationId: "conversation-1",
        upstreamTaskId: "task-parent",
        revision: 3,
      },
      taskId: "task-parent",
    });
    expect(loadBuild).toHaveBeenCalledOnce();
    expect(loadBuild).toHaveBeenCalledWith(7, "conversation-1");
  });

  it("routes only unrecoverable ready packages to explicit rebind", () => {
    expect(classifyKnowledgeBaseOpenRecoveryFailure("ready_to_publish")).toBe(
      "package_rebind_required",
    );
    expect(classifyKnowledgeBaseOpenRecoveryFailure("researching")).toBe(
      "fatal",
    );
    expect(classifyKnowledgeBaseOpenRecoveryFailure("confirming")).toBe(
      "fatal",
    );
    expect(
      classifyKnowledgeBaseOpenRecoveryFailure(
        "protocol_error",
        "PACKAGE_REBIND_REQUIRED",
      ),
    ).toBe("package_rebind_required");
    expect(
      classifyKnowledgeBaseOpenRecoveryFailure(
        "protocol_error",
        "PROGRESS_PROTOCOL_INVALID",
      ),
    ).toBe("fatal");
  });

  it("never writes upstream error detail, API keys or customer body to console", () => {
    const apiKey = "sk-sensitive-runtime-key-1234567890";
    const customerBody = "尚未公开的企业知识库正文-绝密";
    const error = Object.assign(
      new Error(`upstream detail ${apiKey} ${customerBody}`),
      {
        name: "AxiosError",
        code: "ERR_BAD_RESPONSE",
        response: {
          status: 502,
          data: { message: customerBody, API_KEY: apiKey },
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logKnowledgeBaseRuntimeFailure({
      level: "warn",
      event: "[KnowledgeBaseTest] upstream_failed",
      buildId: "build-1",
      turnId: "turn-1",
      taskId: "task-1",
      error,
      additionalSecrets: [apiKey],
    });

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).toContain("KNOWLEDGE_BASE_RUNTIME_ERROR");
    expect(serialized).not.toContain("ERR_BAD_RESPONSE");
    expect(serialized).toContain("build-1");
    expect(serialized).toContain("turn-1");
    expect(serialized).toContain("task-1");
    expect(serialized).toContain("502");
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(customerBody);
    expect(serialized).not.toContain("upstream detail");
    expect(serialized).not.toContain("response");
    expect(serialized).not.toContain("API_KEY");
  });

  it("normalizes every supported top-level provider text shape as an assistant output", () => {
    for (const task of [
      { output: "字符串正文" },
      { output: { value: "对象 value 正文" } },
      { output: { type: "output_text", text: "对象 text 正文" } },
      { output: ["数组字符串正文"] },
      { output: [{ value: "数组对象 value 正文" }] },
      { output_text: "顶层 output_text 正文" },
      { output_text: { value: "顶层 value 正文" } },
    ]) {
      expect(normalizeRecoveredTaskOutput(task)).toEqual([
        expect.objectContaining({ role: "assistant" }),
      ]);
    }
  });

  it("uses one canonical nested task for id, terminal status, and output", () => {
    const wrapped = {
      id: "stale-wrapper-id",
      status: "running",
      output: "stale wrapper output",
      task: {
        id: "authoritative-task-id",
        status: "finished",
        output: "authoritative nested output",
      },
    };

    expect(canonicalKnowledgeBaseUpstreamTask(wrapped)).toEqual(wrapped.task);
    expect(normalizeRecoveredTaskOutput(wrapped)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "output_text", text: "authoritative nested output" }],
      }),
    ]);
  });

  it("classifies only ambiguous create outcomes for idempotent recovery", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(classifyKnowledgeBaseUpstreamCreateFailure({ status })).toBe(
        "deterministic",
      );
    }
    for (const status of [408, 425, 429, 500, 502, 503]) {
      expect(classifyKnowledgeBaseUpstreamCreateFailure({ status })).toBe(
        "retriable",
      );
    }
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({
        status: 409,
        code: "idempotency_pending",
      }),
    ).toBe("retriable");
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({
        status: 422,
        code: "IDEMPOTENCY_PENDING",
      }),
    ).toBe("retriable");
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({ transportError: true }),
    ).toBe("unknown");
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({
        status: 200,
        missingTaskId: true,
      }),
    ).toBe("unknown");
  });

  it("keeps the Pro prompt compact while preserving depth and one-by-one traversal", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite:
        "https://company.example.invalid/\nhttps://evidence.example.invalid/",
      operatorNotes: "覆盖全部产品线",
      attachments: [{ file_id: "file-1", filename: "catalog.pdf" }],
      protocolOperation: {
        skillVersion: "4",
        operationId: "operation-1",
        turnId: "turn-1",
      },
      treePolicyVersion: 2,
    });

    expect(prompt).toContain(
      "不得开启、调用、切换或推荐 Wide Research / Deep Research",
    );
    expect(prompt).toContain(KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain("先解压 ZIP 并完整读取根目录 SKILL.md");
    expect(prompt).toContain(
      "用户已在 FrontMind Dashboard 发起并授权本轮企业知识库构建",
    );
    expect(prompt).toContain("不要求环境预装同名 Skill");
    expect(prompt).toContain(
      "只有 customerAttachments 中明确列出的文件属于客户事实资料",
    );
    expect(prompt).toContain("30-115");
    expect(prompt).toContain("普通企业目标 40-55");
    expect(prompt).toContain("references/knowledge-tree.md");
    expect(prompt).toContain("至少成功解析 12 个官网页面并执行 6 次公开查询");
    expect(prompt).toContain("120 个成功官网页、200 个访问链接");
    expect(prompt).toContain("不得为数量、字数或图片数填充内容");
    expect(prompt).toContain("一级分支数量不设固定值");
    expect(prompt).not.toContain("恰好 7 个一级分支");
    expect(prompt).not.toContain("7 universal top-level branches");
    expect(prompt).toContain("处理最后节点且本轮状态提交后将达到 100%");
    expect(prompt).toContain("每次被接受后加 1");
    expect(prompt).toContain("https://company.example.invalid/");
    expect(prompt).toContain("https://evidence.example.invalid/");
    expect(prompt).toContain("catalog.pdf");
    expect(prompt).toContain("FRONTMIND_KB_MANIFEST");
    expect(prompt).toContain("FRONTMIND_KB_PROGRESS");
    expect(prompt).toContain("FRONTMIND_KB_PRESENTATION");
    expect(prompt).toContain(
      "输出前先自行解析每个机器信封，并按给定 schema、operationId 与 turnId 范围完成校验",
    );
    expect(prompt).toContain("只输出一次唯一合法结构");
    expect(prompt).toContain("服务端严格校验仍为最终权威");
    expect(prompt).not.toContain("FRONTMIND_KB_REOPEN");
    expect(prompt).toContain("禁止输出 SOCRATIC_KB_STATE");
    expect(prompt).toContain("补充、修订、问题或上传资料");
    expect(prompt).toContain("to 必须为 needs_verification");
    expect(prompt).toContain("(confirmed + direct_prefilled) / total");
    expect(prompt).toContain("不得输出参考资料、参考来源");
    expect(prompt).toContain("可见正文结束后直接附机器信封");
    expect(prompt).toContain("有界全网搜索中寻找企业官方主 Logo");
    expect(prompt).toContain("不得采集或打包品牌主视觉、业务图");
    expect(prompt).toContain("取得合格 Logo 后立即停止所有网页图片发现");
    expect(prompt).toContain("仍没有合格真实 Logo");
    expect(prompt).toContain("完整 Manifest 和第一个叶子正文，但返回零张图片");
    expect(prompt).toContain("等待用户上传企业主 Logo");
    expect(prompt).toContain("sourceAssetUrl 可指向 SVG");
    expect(prompt).toContain("该 URL 只记录官方来源");
    expect(prompt).toContain("不要求源文件与返回栅格原字节相同");
    expect(prompt).toContain("Dashboard 将绑定该返回字节");
    expect(prompt).toContain("official_logo_upload 原样保留");
    expect(prompt).toContain("official_logo_upload");
    expect(prompt).toContain("资料采集状态只由 Dashboard 展示");
    expect(prompt).toContain("不得复述、输出或以“正在采集”“处理中”");
    expect(prompt).toContain("不得先发送或以“已收到”“好的”“开始处理”");
    expect(prompt).not.toContain(
      "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。",
    );
    expect(prompt).toContain("imageState=no_eligible_asset");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(20_000);
    expect(prompt).not.toContain("# Skill");
    expect(prompt).not.toContain("current Pro Agent");
    expect(prompt).not.toContain("# FILE: references/");
    expect(prompt).not.toContain("# FILE: scripts/validate_archive.py");
    expect(prompt).not.toContain("def validate_archive");
    expect(prompt).not.toContain("360–480");
    expect(prompt).not.toContain("300,000");
    for (const forbiddenPhrase of [
      "系统附件",
      "服务端系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复或旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(prompt).not.toContain(forbiddenPhrase);
    }

    const manifestMatch = prompt.match(
      /<!-- FRONTMIND_KB_MANIFEST\n([^\n]+)\n-->/u,
    );
    expect(manifestMatch).not.toBeNull();
    const manifestExample = JSON.parse(manifestMatch![1]!);
    expect(manifestExample.leaves).toHaveLength(40);
    expect(
      new Set(manifestExample.leaves.map((leaf: any) => leaf.branchId)).size,
    ).toBe(7);
    expect(manifestExample.researchCoverage).toMatchObject({
      officialPages: {
        discovered: 18,
        attempted: 16,
        succeeded: 14,
        failed: 2,
      },
      publicQueries: 6,
      officialDocuments: 4,
      uploadsRead: 1,
      stopReason: "coverage_complete",
    });
    expect(manifestExample.researchCoverage.dimensions).toHaveLength(7);

    const archive = await readKnowledgeBaseSkillArchiveAttachment();
    expect(archive.filename).toBe("socratic-kb-builder.skill.zip");
    expect(archive.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    const zip = await JSZip.loadAsync(archive.bytes);
    const skill = await zip.file("SKILL.md")?.async("string");
    const normalizedSkill = String(skill || "").replace(/\s+/gu, " ");
    for (const invariant of [
      "current Pro Agent",
      "120 successfully parsed official pages",
      "200 visited links",
      "30 useful official documents",
      "30 public queries",
      "30–115 leaf tree",
      "40–55 leaves",
      "researchCoverage",
      "3,000,000",
      "limited_evidence",
      "evidenceDocumentIds",
      "schemaVersion: 4",
      "1,500 ZIP files",
      "30 MiB",
      "00_package_manifest.json",
      "dashboard-enterprise-v1",
      "FRONTMIND_FORMAL_CONTENT_START",
      "assetType",
      "displayRole",
      "scannedSourcePages",
      "256×256",
      "Customer writing boundary",
      "Never create an interactive",
      "verification_gaps",
      "00_web_intelligence_report.md",
      "Conversational image delivery",
      "validated local Logo byte attachment",
      "references/output-format.md",
      "python3 scripts/validate_archive.py FINAL.zip",
      "VALID dashboard-enterprise-v1 archive",
      "README/TXT marker",
    ]) {
      expect(normalizedSkill).toContain(invariant);
    }
  });

  it("keeps historical v4 builds on the legacy tree contract", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "历史企业",
      companyWebsite: "",
      operatorNotes: "",
      attachments: [],
      protocolOperation: {
        skillVersion: "4",
        operationId: "operation-legacy",
        turnId: "turn-legacy",
      },
      treePolicyVersion: 1,
    });
    const manifestMatch = prompt.match(
      /<!-- FRONTMIND_KB_MANIFEST\n([^\n]+)\n-->/u,
    );
    expect(manifestMatch).not.toBeNull();
    const manifestExample = JSON.parse(manifestMatch![1]!);
    expect(manifestExample.leaves).toHaveLength(8);
    expect(manifestExample.researchCoverage).toBeUndefined();
    expect(prompt).toContain("8-115");
    expect(prompt).not.toContain("普通企业目标 40-55");
    expect(prompt).not.toContain("researchCoverage 必须记录真实研究账本");
  });

  it("keeps an uploaded official Logo on the first leaf with exact provenance", async () => {
    const sha256 = "a".repeat(64);
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "official-logo-supplement",
      userMessage: "",
      attachments: [
        { file_id: "file-official-logo", filename: "brand-logo.png" },
      ],
      attachmentManifest: [
        {
          filename: "brand-logo.png",
          mimeType: "image/png",
          sizeBytes: 4096,
          sha256,
        },
      ],
      officialLogoUpload: {
        verified: true,
        index: 0,
        fileId: "file-official-logo",
        filename: "brand-logo.png",
        mimeType: "image/png",
        sizeBytes: 4096,
        sourceSha256: sha256,
      },
      skillVersion: "4",
      protocolOperation: {
        operationId: "logo-operation",
        turnId: "logo-turn",
      },
      progressOverride: {
        build: { revision: 0, currentLeafId: "1.1" },
        branches: [
          {
            leaves: [
              {
                id: "1.1",
                title: "一句话定位",
                branchTitle: "企业身份",
                status: "current",
              },
              {
                id: "1.2",
                title: "企业名称",
                branchTitle: "企业身份",
                status: "pending",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain("首节点 Logo 补料轮");
    expect(prompt).toContain("保持当前首节点为 needs_verification");
    expect(prompt).toContain("不得确认或前进");
    expect(prompt).toContain("sourceKind=official_logo_upload");
    expect(prompt).toContain("imageSelection.method 必须为 customer_upload");
    expect(prompt).toContain(`"sourceUploadSha256":"${sha256}"`);
    expect(prompt).toContain('"sourceUploadFileId":"file-official-logo"');
    expect(prompt).toContain('"leafId":"1.1"');
    expect(prompt).toContain('"to":"needs_verification"');
    expect(prompt).not.toContain('"to":"confirmed"');
  });

  it("pins every confirmation to the exact canonical transition envelopes", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "turn-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "3",
      progressOverride: {
        build: { revision: 4, currentLeafId: "1.2" },
        branches: [
          {
            leaves: [
              {
                id: "1.2",
                title: "企业名称",
                branchTitle: "企业身份",
                status: "current",
              },
              {
                id: "1.3",
                title: "使命愿景",
                branchTitle: "企业身份",
                status: "pending",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain(
      '{"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":4,"transition":{"leafId":"1.2","from":"current","to":"confirmed","reason":"用户明确确认"}}',
    );
    expect(prompt).toContain(
      '{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":5,"leafId":"1.3","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}',
    );
    expect(prompt).toContain("不得把 action、leafId、status 放在顶层");
    expect(prompt).not.toContain('"action":"confirm"');
    expect(
      prompt
        .trim()
        .endsWith(
          '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":5,"leafId":"1.3","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}\n-->',
        ),
    ).toBe(true);
    expect(prompt).toContain("用户已授权继续完成 FrontMind Dashboard");
    expect(prompt).toContain("不要求环境预装同名 Skill");
    expect(prompt).toContain("# 本轮回复结尾要求");
    for (const forbiddenPhrase of [
      "系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复或旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(prompt).not.toContain(forbiddenPhrase);
    }
  });

  it("forces the last confirmation to attach one scoped ZIP before ending", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "final-package-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      protocolOperation: {
        operationId: "final-package-operation",
        turnId: "final-package-turn",
      },
      finalizationInput: {
        filename: "frontmind-kb-finalization-input-aaaaaaaaaaaaaaaa.zip",
        sha256: "a".repeat(64),
        assetCount: 2,
      },
      progressOverride: {
        build: { revision: 46, currentLeafId: "7.2" },
        branches: [
          {
            leaves: [
              {
                id: "7.2",
                title: "极长节点标题".repeat(2_000),
                branchTitle: "极长分支标题".repeat(2_000),
                status: "current",
              },
            ],
          },
        ],
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(3_000);
    expect(prompt).not.toContain("极长节点标题");
    expect(prompt).not.toContain("极长分支标题");
    expect(prompt).toContain("完成最终交付");
    expect(prompt).toContain("用户已授权继续完成 FrontMind Dashboard");
    expect(prompt).toContain("应用管理的工作流输入");
    expect(prompt).toContain("不属于 customerAttachments");
    expect(prompt).toContain("当前状态坐标记录的动作是 confirm");
    expect(prompt).toContain("application/zip");
    expect(prompt).toContain(
      "frontmind-kb-finalization-input-aaaaaaaaaaaaaaaa.zip",
    );
    expect(prompt).toContain(`SHA-256=${"a".repeat(64)}`);
    expect(prompt).toContain("2 个必须物理打包的图片素材");
    expect(prompt).toContain("references/output-format.md");
    expect(prompt).toContain("python3 scripts/validate_archive.py FINAL.zip");
    expect(prompt).toContain(
      "--finalization-input frontmind-kb-finalization-input-aaaaaaaaaaaaaaaa.zip",
    );
    expect(prompt).toContain(
      `--expected-finalization-sha256 ${"a".repeat(64)}`,
    );
    expect(prompt).toContain("--expected-operation-id final-package-operation");
    expect(prompt).toContain("--expected-turn-id final-package-turn");
    expect(prompt).toContain("requiredManifest 必须逐字段原样复制");
    expect(prompt).toContain("不得从任务历史生成 sourceUpload*");
    expect(prompt).toContain("Dashboard 已绑定的栅格字节");
    expect(prompt).toContain("未提供来源字段时保持省略");
    expect(prompt).toContain("不得猜测或补造");
    expect(prompt).toContain("official_logo_upload 必须与客户原始上传字节一致");
    expect(prompt).not.toContain("内部证据工作区");
    expect(prompt).toContain("VALID dashboard-enterprise-v1 archive");
    expect(prompt).toContain("README/TXT 素材占位");
    expect(prompt).toContain("唯一一个 type=output_file、MIME=application/zip");
    expect(prompt).toContain("operationId=final-package-operation");
    expect(prompt).toContain("turnId=final-package-turn");
    expect(prompt).toContain("成品 buildRevision=47");
    expect(prompt).toContain("资源进入 output 前不得结束");
    for (const forbiddenPhrase of [
      "系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复和旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(prompt).not.toContain(forbiddenPhrase);
    }
    expect(prompt.match(/<!-- FRONTMIND_KB_PROGRESS/gu)).toHaveLength(1);
    expect(prompt.match(/<!-- FRONTMIND_KB_PRESENTATION/gu)).toHaveLength(1);
    expect(prompt).not.toContain("# 本轮上传资料");
    expect(
      prompt
        .trim()
        .endsWith(
          '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":2,"operationId":"final-package-operation","turnId":"final-package-turn","revision":47,"leafId":null,"imageState":"not_applicable","assetIds":[],"imageCount":0}\n-->',
        ),
    ).toBe(true);
  });

  it("preserves the actionable v4 archive failure instead of hiding it", () => {
    expect(
      knowledgeBaseArtifactFailureNotice(
        new KnowledgeBaseArtifactBindingError(
          "PACKAGE_INVALID",
          "新版知识库 ZIP 包含不支持的文件类型：assets/official_logo_README.txt",
        ),
      ),
    ).toEqual({
      code: "FINAL_PACKAGE_INVALID",
      message:
        "最终知识库 ZIP 不符合 Dashboard v4 归档合同：新版知识库 ZIP 包含不支持的文件类型：assets/official_logo_README.txt。本轮未推进；请重试本轮，系统会重新提供权威正文与全部素材，并要求生成端通过同一校验器后再交付。",
    });
  });

  it("classifies every pre-upstream recovery Logo failure as deterministic local preparation", () => {
    const invalid = knowledgeBaseRecoveryLogoPreparationError(
      new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        "上传的 Logo 原始字节校验失败，请重新上传",
      ),
    );
    expect(invalid).toMatchObject({
      name: "KnowledgeBaseLocalPreparationError",
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "上传的 Logo 原始字节校验失败，请重新上传",
    });

    const stale = knowledgeBaseRecoveryLogoPreparationError(
      new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "当前首个知识节点状态已变化，请刷新后重新上传 Logo",
      ),
    );
    expect(stale).toMatchObject({
      name: "KnowledgeBaseLocalPreparationError",
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });

    const unreadable = knowledgeBaseRecoveryLogoPreparationError(
      new Error("sensitive storage detail"),
    );
    expect(unreadable).toMatchObject({
      name: "KnowledgeBaseLocalPreparationError",
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "企业官方主 Logo 无法从本轮受管上传恢复，请重新上传",
    });
    expect(unreadable.message).not.toContain("sensitive storage detail");
  });

  it("formats a retry with only the new operation and turn envelope identity", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "retry-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      protocolOperation: {
        operationId: "new-retry-operation",
        turnId: "new-retry-turn",
      },
      progressOverride: {
        build: { revision: 4, currentLeafId: "1.2" },
        branches: [
          {
            leaves: [
              {
                id: "1.2",
                title: "企业名称",
                branchTitle: "企业身份",
                status: "current",
              },
              {
                id: "1.3",
                title: "使命愿景",
                branchTitle: "企业身份",
                status: "pending",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain('"operationId":"new-retry-operation"');
    expect(prompt).toContain('"turnId":"new-retry-turn"');
    expect(prompt).not.toContain("failed-task-must-not-be-reused");
    expect(prompt).not.toContain("old-operation");
  });

  it("balances historical prefill across branches and caps it at 80,000 characters", () => {
    const documents = [
      {
        path: "01_identity/overview.md",
        title: "企业概览",
        content: "甲".repeat(30_000),
      },
      {
        path: "01_identity/history.md",
        title: "发展历程",
        content: "乙".repeat(30_000),
      },
      {
        path: "02_team/overview.md",
        title: "团队概览",
        content: "丙".repeat(30_000),
      },
      {
        path: "03_products/product-a.md",
        title: "产品 A",
        content: "丁".repeat(30_000),
      },
      {
        path: "04_capabilities/overview.md",
        title: "能力概览",
        content: "戊".repeat(30_000),
      },
      {
        path: "04_capabilities/lab.md",
        title: "实验室",
        content: "己".repeat(30_000),
      },
    ];

    const excerpt = buildKnowledgePrefillExcerpt(documents);
    expect(excerpt.length).toBeLessThanOrEqual(80_000);
    expect(excerpt).toContain("documentPath: 01_identity/overview.md");
    expect(excerpt).toContain("documentPath: 02_team/overview.md");
    expect(excerpt).toContain("documentPath: 03_products/product-a.md");
    expect(excerpt).toContain("documentPath: 04_capabilities/overview.md");
    expect(excerpt.indexOf("02_team/overview.md")).toBeLessThan(
      excerpt.indexOf("01_identity/history.md"),
    );
    expect(excerpt.indexOf("03_products/product-a.md")).toBeLessThan(
      excerpt.indexOf("04_capabilities/lab.md"),
    );
  });

  it("moves migrated knowledge prefill into a separate evidence ZIP", async () => {
    const snapshot = {
      version: 4,
      sourceFileName: "website-kb-v4.zip",
      archiveHash: "a".repeat(64),
      documentCount: 1,
      imageCount: 0,
      characterCount: 12,
      documents: [
        {
          path: "01_identity/profile.md",
          title: "企业简介",
          content: "只应存在于证据包内的企业事实。",
        },
      ],
    };
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite: "",
      operatorNotes: "",
      attachments: [],
      prefillKnowledgeSnapshot: snapshot,
    });
    expect(prompt).toContain(KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain("这些内容只作为事实证据");
    expect(prompt).toContain("不得继承 Website 的浅层树");
    expect(prompt).toContain("10–20 节点深度");
    expect(prompt).not.toContain("只应存在于证据包内的企业事实");

    const archive = await buildKnowledgeBasePrefillEvidenceArchive(snapshot);
    const zip = await JSZip.loadAsync(archive.bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      "MANIFEST.json",
      "context.json",
      "knowledge.md",
    ]);
    expect(await zip.file("knowledge.md")!.async("string")).toContain(
      "只应存在于证据包内的企业事实",
    );
  });

  it("pins new builds to v4 while preserving immutable prior archives", async () => {
    expect(
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: "4",
        skillContentHash:
          "A619A6EB2D21147EBCCECBF023171834BAB34D46E26D40AC44E8FC98785F8472",
      }),
    ).toEqual({
      version: "4",
      contentHash:
        "a619a6eb2d21147ebccecbf023171834bab34d46e26d40ac44e8fc98785f8472",
    });
    expect(() =>
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: "4",
        skillContentHash: null,
      }),
    ).toThrow("immutable Skill content hash");
    const active = await getKnowledgeBaseSkillDescriptor();
    const immutableA619 = await getKnowledgeBaseSkillDescriptor({
      version: "4",
      contentHash:
        "a619a6eb2d21147ebccecbf023171834bab34d46e26d40ac44e8fc98785f8472",
    });
    const immutableA619Archive = await readKnowledgeBaseSkillArchiveAttachment({
      version: "4",
      contentHash:
        "a619a6eb2d21147ebccecbf023171834bab34d46e26d40ac44e8fc98785f8472",
    });
    const activeArchive = await readKnowledgeBaseSkillArchiveAttachment();
    const legacyActiveHash = await legacyKnowledgeBaseSkillInstructionHash(
      activeArchive.bytes,
    );
    const recoveredLegacyActive = await getKnowledgeBaseSkillDescriptor({
      version: "4",
      contentHash: legacyActiveHash,
    });
    const recoveredHistoricalAlias = await getKnowledgeBaseSkillDescriptor({
      version: "4",
      contentHash:
        "08d30fed3d992e6e52d3a7fdaba1e7ffd09e0c6d48052f400b12ac680f460fb3",
    });
    const legacy = await getKnowledgeBaseSkillDescriptor({ version: "1" });
    const previous = await getKnowledgeBaseSkillDescriptor({ version: "2" });
    const priorV3Hash =
      "ee62269164a46a54b33dbf71ff492b1d08b3974ab314d11aaa97e885dff96f27";
    const priorV3 = await getKnowledgeBaseSkillDescriptor({
      version: "3",
      contentHash: priorV3Hash,
    });

    expect(active).toMatchObject({
      name: "socratic-kb-builder",
      version: "4",
      contentHash:
        "5e0487004c604c0b95feae0c19ee9544a7e82b10ca923ca6c779ed240f333f56",
    });
    expect(immutableA619.contentHash).toBe(
      "a619a6eb2d21147ebccecbf023171834bab34d46e26d40ac44e8fc98785f8472",
    );
    expect(
      await canonicalKnowledgeBaseSkillArchiveHash(immutableA619Archive.bytes),
    ).toBe("a619a6eb2d21147ebccecbf023171834bab34d46e26d40ac44e8fc98785f8472");
    expect(
      createHash("sha256").update(immutableA619Archive.bytes).digest("hex"),
    ).toBe("5d106aa5905c2db2dd3f0c81e74934fdc98fc171d1d264b68c168bb6f7f9d05a");
    expect(active.contentHash).toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(activeArchive.bytes),
    );
    expect(recoveredLegacyActive.contentHash).toBe(legacyActiveHash);
    expect(recoveredHistoricalAlias.contentHash).toBe(
      "08d30fed3d992e6e52d3a7fdaba1e7ffd09e0c6d48052f400b12ac680f460fb3",
    );
    expect(legacy).toMatchObject({
      name: "socratic-kb-builder",
      version: "1",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(previous).toMatchObject({
      name: "socratic-kb-builder",
      version: "2",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(active.contentHash).not.toBe(legacy.contentHash);
    expect(active.contentHash).not.toBe(previous.contentHash);
    expect(active.contentHash).not.toBe(priorV3Hash);
    expect(priorV3.contentHash).toBe(priorV3Hash);

    await expect(
      getKnowledgeBaseSkillDescriptor({
        version: "1",
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow("content hash does not match");
  });

  it("resolves every immutable v3/v4 filename pin shipped in the runtime", async () => {
    const skillRoot = path.resolve(process.cwd(), "private-workflows");
    const aliases = (await readdir(skillRoot))
      .map((name) =>
        name.match(/^socratic-kb-builder-v([34])-([a-f0-9]{64})\.skill$/u),
      )
      .filter((match): match is RegExpMatchArray => Boolean(match));
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      const version = alias[1] as "3" | "4";
      const contentHash = alias[2]!;
      await expect(
        getKnowledgeBaseSkillDescriptor({ version, contentHash }),
      ).resolves.toMatchObject({ version, contentHash });
    }
  });

  it("defers ambiguous v3 response images to the ZIP manifest without weakening v4", () => {
    expect(shouldBindKnowledgeBaseInitialLogo("3", 3)).toBe(false);
    expect(shouldBindKnowledgeBaseInitialLogo("3", 1)).toBe(false);
    expect(shouldBindKnowledgeBaseInitialLogo("4", 3)).toBe(true);
    expect(shouldBindKnowledgeBaseInitialLogo("4", 0)).toBe(false);
  });

  it("uploads the Skill ZIP through the exact signed URL without auth headers", async () => {
    const uploadUrl =
      "https://uploads.example.test/socratic.skill.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "skill-file-1",
        filename: "socratic-kb-builder.skill.zip",
        upload_url: uploadUrl,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 200,
      data: "",
    });

    const uploaded = await uploadKnowledgeBaseSkillArchive({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    });

    expect(uploaded.attachment).toEqual({
      file_id: "skill-file-1",
      filename: "socratic-kb-builder.skill.zip",
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(put.mock.calls[0]?.[2]).toMatchObject({
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/zip",
      },
    });
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("Authorization");
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("API_KEY");
  });

  it("replays the exact prepared task body with one stable idempotency key", async () => {
    const requestBody = {
      prompt: "固定的恢复提示词",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      attachments: [
        {
          file_id: "frozen-skill-file",
          filename: "socratic-kb-builder.skill.zip",
        },
        { file_id: "frozen-facts-file", filename: "facts.pdf" },
      ],
      taskId: "parent-task",
    };
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: { id: "original-task", status: "running", output: [] },
    });

    const result = await createFrontMindTask({
      baseUrl: "https://api.example.test",
      apiKey: "credential-value",
      requestBody,
      idempotencyKey: "frontmind-kb-v2:operation-one",
    });

    expect(result).toMatchObject({
      ok: true,
      task: { id: "original-task", status: "running" },
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toEqual(requestBody);
    expect(post.mock.calls[0]?.[2]).toMatchObject({
      timeout: KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
      headers: {
        "Idempotency-Key": "frontmind-kb-v2:operation-one",
      },
    });
  });

  it("accepts wrapped create responses and rejects a 2xx response without a task id deterministically", async () => {
    const post = vi
      .spyOn(axios, "post")
      .mockResolvedValueOnce({
        status: 201,
        data: {
          id: "stale-wrapper-id",
          status: "running",
          output: "stale wrapper output",
          task: {
            id: "wrapped-task-id",
            status: "done",
            output: "wrapped output",
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { task: { status: "succeeded", output: "missing id" } },
      });

    await expect(
      createFrontMindTask({
        baseUrl: "https://api.example.test",
        apiKey: "credential-value",
        prompt: "wrapped",
      }),
    ).resolves.toMatchObject({
      ok: true,
      task: {
        id: "wrapped-task-id",
        status: "done",
        output: [expect.objectContaining({ role: "assistant" })],
      },
    });
    await expect(
      createFrontMindTask({
        baseUrl: "https://api.example.test",
        apiKey: "credential-value",
        prompt: "missing id",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failureClass: "unknown",
      failureCode: "UPSTREAM_TASK_ID_MISSING",
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      status: 425,
      data: { error: { code: "IDEMPOTENCY_PENDING" } },
      expectedFailureClass: "retriable",
    },
    {
      status: 409,
      data: { error: { code: "IDEMPOTENCY_PENDING" } },
      expectedFailureClass: "retriable",
    },
    {
      status: 409,
      data: { error: { code: "TASK_STATE_CONFLICT" } },
      expectedFailureClass: "deterministic",
    },
    {
      status: 422,
      data: { error: { code: "IDEMPOTENCY_PENDING" } },
      expectedFailureClass: "retriable",
    },
    {
      status: 422,
      data: { error: { code: "INVALID_ATTACHMENT" } },
      expectedFailureClass: "deterministic",
    },
  ] as const)(
    "classifies upstream HTTP $status as $expectedFailureClass only from its explicit contract",
    async ({ status, data, expectedFailureClass }) => {
      vi.spyOn(axios, "post").mockResolvedValue({ status, data });

      await expect(
        createFrontMindTask({
          baseUrl: "https://api.example.test",
          apiKey: "credential-value",
          prompt: "manual Logo",
          idempotencyKey: "frontmind-kb-v2:manual-logo-operation",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status,
        failureClass: expectedFailureClass,
        failureCode: `UPSTREAM_CREATE_${data.error.code}`,
      });
    },
  );

  it("recovers a POST accepted before bind without creating a second logical task", async () => {
    const calls: string[] = [];
    const dispatch = {
      schemaVersion: 1 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "prepared",
        agentProfile: "manus-1.6-max",
        taskMode: "agent" as const,
        attachments: [],
      },
      bodySha256: "a".repeat(64),
      preparedAt: "2026-08-01T00:00:00.000Z",
    };
    const result = await recoverKnowledgeBaseTurnClaimTask({
      claim: {
        turn: { upstreamTaskId: null },
        upstreamIdempotencyKey: "frontmind-kb-v2:stable-operation",
      } as any,
      ensureDispatch: async () => {
        calls.push("prepare");
        return dispatch;
      },
      createTask: async (actualDispatch, key) => {
        calls.push(`create:${key}`);
        expect(actualDispatch).toBe(dispatch);
        return { taskId: "original-task" };
      },
      bindTask: async (taskId) => calls.push(`bind:${taskId}`),
      registerTask: async (taskId) => calls.push(`register:${taskId}`),
      reconcileTask: async (taskId) => {
        calls.push(`reconcile:${taskId}`);
        return true;
      },
    });

    expect(result).toEqual({
      taskId: "original-task",
      rebound: true,
      reconciled: true,
    });
    expect(calls).toEqual([
      "prepare",
      "create:frontmind-kb-v2:stable-operation",
      "bind:original-task",
      "register:original-task",
      "reconcile:original-task",
    ]);
  });

  it("retries an upstream 425 with the same manual Logo reservation and provider idempotency key", async () => {
    const dispatch = {
      schemaVersion: 1 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "manual Logo",
        agentProfile: "manus-1.6-max",
        taskMode: "agent" as const,
        attachments: [],
      },
      bodySha256: "c".repeat(64),
      preparedAt: "2026-08-10T03:00:00.000Z",
    };
    const claim = {
      turn: { upstreamTaskId: null },
      upstreamIdempotencyKey: "frontmind-kb-v2:manual-logo-stable-request",
    } as any;
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(
        new KnowledgeBaseUpstreamCreateError(
          "retriable",
          "UPSTREAM_CREATE_HTTP_425",
          425,
        ),
      )
      .mockResolvedValueOnce({ taskId: "manual-logo-task" });
    const bindTask = vi.fn().mockImplementation(async (taskId: string) => {
      claim.turn.upstreamTaskId = taskId;
    });
    const registerTask = vi.fn().mockResolvedValue(undefined);
    const reconcileTask = vi.fn().mockResolvedValue(false);
    const recover = () =>
      recoverKnowledgeBaseTurnClaimTask({
        claim,
        ensureDispatch: async () => dispatch,
        createTask,
        bindTask,
        registerTask,
        reconcileTask,
      });

    await expect(recover()).rejects.toMatchObject({
      failureClass: "retriable",
      failureCode: "UPSTREAM_CREATE_HTTP_425",
      status: 425,
    });
    await expect(recover()).resolves.toEqual({
      taskId: "manual-logo-task",
      rebound: true,
      reconciled: false,
    });
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls.map((call) => call[1])).toEqual([
      claim.upstreamIdempotencyKey,
      claim.upstreamIdempotencyKey,
    ]);
    expect(createTask.mock.calls[0]?.[0]).toBe(dispatch);
    expect(createTask.mock.calls[1]?.[0]).toBe(dispatch);
    expect(bindTask).toHaveBeenCalledOnce();
    expect(registerTask).toHaveBeenCalledWith("manual-logo-task");
  });

  it("runs manual Logo promotion only after the real task is created, bound, and registered", async () => {
    const calls: string[] = [];
    const result = await recoverKnowledgeBaseTurnClaimTask({
      claim: {
        turn: { upstreamTaskId: null },
        upstreamIdempotencyKey: "frontmind-kb-v2:manual-logo",
      } as any,
      ensureDispatch: async () => {
        calls.push("prepare");
        return {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody: {
            prompt: "manual Logo",
            agentProfile: "manus-1.6-max",
            taskMode: "agent",
            attachments: [],
          },
          bodySha256: "b".repeat(64),
          preparedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      createTask: async () => {
        calls.push("create:manus-task-logo");
        return { taskId: "manus-task-logo" };
      },
      bindTask: async (taskId) => calls.push(`bind:${taskId}`),
      registerTask: async (taskId) => calls.push(`register:${taskId}`),
      afterTaskAcknowledged: async (taskId) => calls.push(`promote:${taskId}`),
      reconcileTask: async (taskId) => {
        calls.push(`reconcile:${taskId}`);
        return false;
      },
    });

    expect(result.taskId).toBe("manus-task-logo");
    expect(calls).toEqual([
      "prepare",
      "create:manus-task-logo",
      "bind:manus-task-logo",
      "register:manus-task-logo",
      "promote:manus-task-logo",
      "reconcile:manus-task-logo",
    ]);
  });

  it("reuses an already-bound Manus task while retrying post-ack Logo promotion", async () => {
    const calls: string[] = [];
    const createTask = vi.fn();
    const result = await recoverKnowledgeBaseTurnClaimTask({
      claim: {
        turn: { upstreamTaskId: "manus-task-existing" },
        upstreamIdempotencyKey: "frontmind-kb-v2:manual-logo",
      } as any,
      ensureDispatch: vi.fn(),
      createTask,
      bindTask: vi.fn(),
      registerTask: async (taskId) => calls.push(`register:${taskId}`),
      afterTaskAcknowledged: async (taskId) => calls.push(`promote:${taskId}`),
      reconcileTask: async (taskId) => {
        calls.push(`reconcile:${taskId}`);
        return false;
      },
    });

    expect(result).toMatchObject({
      taskId: "manus-task-existing",
      rebound: false,
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "register:manus-task-existing",
      "promote:manus-task-existing",
      "reconcile:manus-task-existing",
    ]);
  });

  it("stops recovery before upstream create when Logo preparation is deterministically rejected", async () => {
    const createTask = vi.fn();
    const bindTask = vi.fn();
    const registerTask = vi.fn();
    const reconcileTask = vi.fn();
    const preparationError = knowledgeBaseRecoveryLogoPreparationError(
      new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        "上传的 Logo 原始文件已丢失，请重新上传",
      ),
    );

    await expect(
      recoverKnowledgeBaseTurnClaimTask({
        claim: {
          turn: { upstreamTaskId: null },
          upstreamIdempotencyKey: "frontmind-kb-v2:logo-recovery",
        } as any,
        ensureDispatch: vi.fn().mockRejectedValue(preparationError),
        createTask,
        bindTask,
        registerTask,
        reconcileTask,
      }),
    ).rejects.toBe(preparationError);
    expect(createTask).not.toHaveBeenCalled();
    expect(bindTask).not.toHaveBeenCalled();
    expect(registerTask).not.toHaveBeenCalled();
    expect(reconcileTask).not.toHaveBeenCalled();
  });

  it("repairs a missing task resource ledger after bind without POSTing again", async () => {
    const createTask = vi.fn();
    const bindTask = vi.fn();
    const registerTask = vi.fn().mockResolvedValue(undefined);
    const reconcileTask = vi.fn().mockResolvedValue(false);

    const result = await recoverKnowledgeBaseTurnClaimTask({
      claim: {
        turn: { upstreamTaskId: "already-bound-task" },
        upstreamIdempotencyKey: "frontmind-kb-v2:stable-operation",
      } as any,
      ensureDispatch: vi.fn(),
      createTask,
      bindTask,
      registerTask,
      reconcileTask,
    });

    expect(result).toEqual({
      taskId: "already-bound-task",
      rebound: false,
      reconciled: false,
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(bindTask).not.toHaveBeenCalled();
    expect(registerTask).toHaveBeenCalledWith("already-bound-task");
    expect(reconcileTask).toHaveBeenCalledWith("already-bound-task", undefined);
  });

  it("uses the configured workspace enterprise and rejects client identity changes", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "管理员结构化编辑",
        brandName: " 验收企业 ",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: null,
        brandName: "验收企业",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expectEnterpriseIdentityError(
      () =>
        resolveKnowledgeBaseEnterpriseIdentity({
          sourceName: "dashboard.json",
          brandName: "验收企业",
          requestedCompanyName: "另一家企业",
        }),
      "ENTERPRISE_IDENTITY_MISMATCH",
    );
  });

  it("allows a compatible client to omit the repeated company name", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "dashboard.csv",
        brandName: "验收企业",
      }),
    ).toBe("验收企业");
  });

  it("always reconciles the full snapshot regardless of cursor or reused IDs", () => {
    const cumulative = [
      { id: "out-1", role: "assistant", content: "first" },
      { id: "out-2", role: "assistant", content: "second" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: 1,
        lastOutputItemIds: ["out-1"],
      }),
    ).toEqual(cumulative);

    const currentTurn = [
      { id: "out-9", role: "assistant", content: "current only" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(currentTurn, {
        lastOutputLength: 8,
        lastOutputItemIds: ["out-1", "out-8"],
      }),
    ).toEqual(currentTurn);

    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: cumulative.length,
        lastOutputItemIds: ["out-1", "out-2"],
      }),
    ).toEqual(cumulative);

    const replacedTerminalTurn = [
      {
        id: "out-2",
        role: "assistant",
        content: "same provider ID, replaced terminal content",
      },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(
        replacedTerminalTurn,
        {
          lastOutputLength: 1,
          lastOutputItemIds: ["out-2"],
        },
        { replayStableOutput: true },
      ),
    ).toEqual(replacedTerminalTurn);
  });

  it("requires closed envelopes while active and validates partial settled output", () => {
    const partial = [
      {
        id: "partial",
        role: "assistant",
        content: '<!-- FRONTMIND_KB_MANIFEST\n{"kind":',
      },
    ];
    const closedInvalid = [
      {
        id: "closed",
        role: "assistant",
        content: "<!-- FRONTMIND_KB_UNKNOWN\n{} \n-->",
      },
    ];

    expect(shouldReconcileKnowledgeOutput(partial, "running")).toBe(false);
    expect(shouldReconcileKnowledgeOutput(partial, "awaiting_user")).toBe(true);
    expect(shouldReconcileKnowledgeOutput(closedInvalid, "running")).toBe(
      false,
    );
    expect(shouldReconcileKnowledgeOutput(partial, "completed")).toBe(true);
  });

  it("replays same-ID output when the provider is waiting for the next user turn", () => {
    expect(shouldReplayStableKnowledgeOutput("awaiting_user")).toBe(true);
    expect(shouldReplayStableKnowledgeOutput("input_required")).toBe(true);
    for (const status of [
      "completed",
      "complete",
      "succeeded",
      "success",
      "done",
      "finished",
      "failed",
      "error",
      "cancelled",
      "canceled",
    ]) {
      expect(shouldReplayStableKnowledgeOutput(status)).toBe(true);
    }
    expect(shouldReplayStableKnowledgeOutput("running")).toBe(false);

    const replacedOutput = [
      {
        id: "reused-output",
        role: "assistant",
        content: "new closed knowledge envelope",
      },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(
        replacedOutput,
        {
          lastOutputLength: 1,
          lastOutputItemIds: ["reused-output"],
        },
        {
          replayStableOutput:
            shouldReplayStableKnowledgeOutput("awaiting_user"),
        },
      ),
    ).toEqual(replacedOutput);
  });

  it("waits for both v3 transition and presentation envelopes", () => {
    const transitionOnly = [
      {
        id: "transition",
        role: "assistant",
        content:
          '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress"}\n-->',
      },
    ];
    const complete = [
      {
        id: "complete",
        role: "assistant",
        content:
          transitionOnly[0].content +
          '\n<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation"}\n-->',
      },
    ];

    expect(
      shouldReconcileKnowledgeOutput(transitionOnly, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(complete, "running", {
        requirePresentation: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileKnowledgeOutput(transitionOnly, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("routes a terminal acknowledgement-only response into protocol validation", () => {
    const acknowledgement = [
      {
        id: "ack-only",
        role: "assistant",
        type: "message",
        content: "已收到。",
      },
    ];
    expect(
      shouldReconcileKnowledgeOutput(acknowledgement, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(acknowledgement, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("accepts legacy bare JSON only after the task has settled", () => {
    const bareManifest = [
      {
        id: "raw-manifest",
        role: "assistant",
        type: "message",
        content: JSON.stringify({
          kind: "frontmind.knowledge-base.manifest",
          schemaVersion: 1,
          leaves: [],
        }),
      },
    ];
    const bareTransition = [
      {
        id: "raw-transition",
        role: "assistant",
        type: "message",
        content: [
          JSON.stringify({
            kind: "frontmind.knowledge-base.progress",
            schemaVersion: 1,
          }),
          JSON.stringify({
            kind: "frontmind.knowledge-base.presentation",
            schemaVersion: 1,
          }),
        ].join("\n"),
      },
    ];

    expect(
      shouldReconcileKnowledgeOutput(bareManifest, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(bareTransition, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(bareManifest, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileKnowledgeOutput(bareTransition, "awaiting_input", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("lets an authoritative confirming build override a still-running upstream task", () => {
    const progress = {
      build: {
        id: "build-1",
        conversationId: "conversation-1",
        companyName: "验收企业",
        status: "confirming",
        revision: 0,
        currentLeafId: "identity.name",
        protocolError: null,
        awaitingResponseSince: null,
        updatedAt: Date.now(),
      },
      summary: {
        total: 8,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 7,
        current: 1,
        needsVerification: 0,
        overallPercent: 0,
      },
      branches: [],
      packageAllowed: false,
    } as const;

    expect(deriveKnowledgeBaseInteraction(progress, "running")).toMatchObject({
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
    });

    expect(
      deriveKnowledgeBaseInteraction(
        {
          ...progress,
          build: {
            ...progress.build,
            status: "researching",
            awaitingResponseSince: Date.now(),
          },
        },
        "failed",
      ),
    ).toMatchObject({
      interactionState: "executing",
      canReply: false,
      lockReason: "正在确认上游失败并保留最后正确正文",
    });
  });
});
