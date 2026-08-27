import { describe, expect, it, vi } from "vitest";

import { ManusV2ApiError } from "../manus-v2-client";
import {
  MANUS_PROVIDER_READ_BACKOFF_MS,
  MANUS_PROVIDER_READ_RECONCILIATION_MS,
  NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
  NATIVE_SOURCE_VALIDATOR_VERSION,
  createNativeRejectedCandidateV1,
  manusProviderReadRetryDelayMs,
  nativeRejectedCandidateMatches,
  nativeSourceAttachmentIdentityConflicts,
  nativeSourceAttachmentRetryWindow,
  nativeSourceOutputAttachment,
  nativeFallbackPreviewBlueprint,
  nativeTrustedFallbackReason,
  nativeTrustedFallbackReconcileUntil,
  pollManusTaskEvents,
  providerResultSyncWindow,
  startProviderResultSyncWindow,
} from "./manus-provider";

const taskId = "manus-task-incident";
const operationToken = "siteops-native-repair:operation-1:1";

function providerState(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    stage: "native_repair_pending" as const,
    taskId,
    nativeRepairAttempt: 1,
    ...overrides,
  };
}

function detail(status = "running") {
  return {
    taskId,
    status,
    title: null,
    taskUrl: null,
    createdAt: null,
    updatedAt: null,
    requestId: null,
    raw: { id: taskId, status },
  };
}

function transientReadError(
  operation: "task.detail" | "task.listMessages",
  input: {
    status?: number | null;
    code?: string;
    retryAfterMs?: number | null;
    transport?: boolean;
  } = {},
) {
  return new ManusV2ApiError(
    operation,
    input.status === undefined ? 502 : input.status,
    input.code ?? "HTTP_502",
    true,
    false,
    null,
    input.retryAfterMs ?? null,
    null,
    null,
    input.transport ? "connection_reset" : null,
    input.transport ? "request" : null,
    1,
    25,
    0,
  );
}

function stoppedEvents() {
  return [
    {
      id: "operation-marker",
      type: "user_message",
      timestamp: 1,
      user_message: {
        content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
      },
    },
    {
      id: "repair-result",
      type: "structured_output_result",
      timestamp: 2,
      structured_output_result: {
        success: true,
        value: { operationToken, archiveSha256: "a".repeat(64) },
      },
    },
    {
      id: "repair-stopped",
      type: "status_update",
      timestamp: 3,
      status_update: { agent_status: "stopped" },
    },
  ];
}

function client(input: {
  taskDetail: ReturnType<typeof vi.fn>;
  listAllMessages: ReturnType<typeof vi.fn>;
}) {
  return {
    ...input,
    createTask: vi.fn(),
    sendMessage: vi.fn(),
  };
}

describe("Manus bound-task read reconciliation", () => {
  it("reuses an authenticated deterministic rejection for the exact frozen candidate only", () => {
    const coordinates = {
      taskId,
      repairAttempt: 2,
      operationToken,
      attachmentIdentity: "attachment-1:attachment:0",
      archiveSha256: "a".repeat(64),
      validatorVersion: NATIVE_SOURCE_VALIDATOR_VERSION,
    } as const;
    const verdict = createNativeRejectedCandidateV1({
      ...coordinates,
      errorCode: "NATIVE_SOURCE_PACKAGE_JSON_INVALID",
      rejectedAt: new Date("2026-08-27T14:00:00.000Z"),
    });

    for (let sweep = 0; sweep < 20; sweep += 1) {
      expect(nativeRejectedCandidateMatches(verdict, coordinates)).toBe(true);
    }
    expect(NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS).toBe(5 * 60_000);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        attachmentIdentity: "attachment-2:attachment:0",
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        archiveSha256: "b".repeat(64),
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        repairAttempt: 1,
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        validatorVersion: "native-react-source-v2",
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(
        { ...verdict, verdictSignature: "0".repeat(64) },
        coordinates,
      ),
    ).toBe(false);
  });

  it("opens trusted fallback only at the bounded root-build thresholds", () => {
    const providerReadFailureSince = new Date(1_000).toISOString();
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        providerReadFailureSince,
        now: 1_000 + 15 * 60_000 - 1,
      }),
    ).toBeNull();
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        providerReadFailureSince,
        now: 1_000 + 15 * 60_000,
      }),
    ).toBe("provider_read_delayed");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        nativeSourceReadFailureSince: providerReadFailureSince,
        now: 1_000 + 15 * 60_000,
      }),
    ).toBe("provider_read_delayed");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        stoppedGraceExpired: true,
      }),
    ).toBe("provider_stopped_without_result");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        repairBudgetExhausted: true,
      }),
    ).toBe("repair_budget_exhausted");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: false,
        hasPreview: false,
        repairBudgetExhausted: true,
      }),
    ).toBeNull();
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: true,
        repairBudgetExhausted: true,
      }),
    ).toBeNull();
  });

  it("projects frozen V6 tokens into a neutral host family without using the page label", () => {
    const legacy = nativeFallbackPreviewBlueprint();
    const styled = nativeFallbackPreviewBlueprint({
      schemaVersion: 1,
      derivation: "normalized-preview-bounded-source-v1",
      previewSha256: "a".repeat(64),
      sourceTreeSha256: "b".repeat(64),
      dominantHex: "#18324a",
      canvasTone: "dark",
      contrast: "high",
      typeSystem: "editorial_serif",
      density: "spacious",
    });
    expect(legacy.heroFamily).toBe("centered_dual_cta");
    expect(styled).toMatchObject({
      heroFamily: "centered_dual_cta",
      typeSystem: "editorial_serif",
      density: "spacious",
      typographyStyle: "editorial",
      backgroundStyle: "dark",
    });
    expect(styled.palette).not.toEqual(legacy.palette);
    expect(Object.values(styled.palette)).not.toContain("#18324a");
  });

  it("anchors the 24-hour fallback reconciliation window to the original read window", () => {
    const operationCreatedAt = new Date("2026-08-27T00:00:00.000Z");
    const originalReadAt = new Date("2026-08-27T00:10:00.000Z");
    const laterFallbackAt = new Date("2026-08-27T00:25:00.000Z");
    const deadline = nativeTrustedFallbackReconcileUntil({
      providerReadFailureSince: originalReadAt.toISOString(),
      providerSyncStartedAt: laterFallbackAt.toISOString(),
      operationStartedAt: new Date("2026-08-27T00:05:00.000Z"),
      operationCreatedAt,
    });
    expect(deadline.toISOString()).toBe("2026-08-28T00:10:00.000Z");
    expect(
      nativeTrustedFallbackReconcileUntil({
        providerReadFailureSince: originalReadAt.toISOString(),
        providerSyncStartedAt: laterFallbackAt.toISOString(),
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe(deadline.toISOString());
    expect(
      nativeTrustedFallbackReconcileUntil({
        providerReadFailureSince: "2026-08-27T23:50:00.000Z",
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe("2026-08-28T23:50:00.000Z");
    expect(
      nativeTrustedFallbackReconcileUntil({
        nativeSourceReadFailureSince: "2026-08-27T23:45:00.000Z",
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe("2026-08-28T23:45:00.000Z");
    expect(
      nativeTrustedFallbackReconcileUntil({
        fallbackTriggeredAt: "2026-08-27T23:55:00.000Z",
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe("2026-08-28T23:55:00.000Z");
  });

  it("uses the fixed bounded schedule and honors Retry-After", () => {
    expect(MANUS_PROVIDER_READ_BACKOFF_MS).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 300_000,
    ]);
    expect(
      MANUS_PROVIDER_READ_BACKOFF_MS.map((_, index) =>
        manusProviderReadRetryDelayMs({ failureCount: index + 1 }),
      ),
    ).toEqual(MANUS_PROVIDER_READ_BACKOFF_MS);
    expect(
      manusProviderReadRetryDelayMs({
        failureCount: 2,
        retryAfterMs: 75_000,
      }),
    ).toBe(75_000);
    expect(
      manusProviderReadRetryDelayMs({
        failureCount: 2,
        retryAfterMs: 900_000,
      }),
    ).toBe(300_000);
  });

  it("keeps listMessages output when detail has one transient failure", async () => {
    const bound = client({
      taskDetail: vi.fn().mockRejectedValue(transientReadError("task.detail")),
      listAllMessages: vi.fn().mockResolvedValue(stoppedEvents()),
    });
    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
      operationId: "operation-1",
      buildId: "build-1",
    });

    expect(result).toMatchObject({
      detailAvailable: false,
      messagesAvailable: true,
      deferred: false,
      nextPollMs: 10_000,
      providerState: {
        buildPhase: "provider_sync_delayed",
      },
    });
    expect(result.providerState.providerReadFailureCount).toBeUndefined();
    expect(result.events).toHaveLength(3);
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a valid result stream when detail is explicitly rejected", async () => {
    const bound = client({
      taskDetail: vi.fn().mockRejectedValue(
        transientReadError("task.detail", {
          status: 403,
          code: "HTTP_403",
        }),
      ),
      listAllMessages: vi.fn().mockResolvedValue(stoppedEvents()),
    });
    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });

    expect(result).toMatchObject({
      detailAvailable: false,
      messagesAvailable: true,
      deferred: false,
    });
    expect(result.events.some((event) => event.id === "repair-result")).toBe(
      true,
    );
  });

  it("requires attention when detail is rejected and messages contain no result candidate", async () => {
    const bound = client({
      taskDetail: vi.fn().mockRejectedValue(
        transientReadError("task.detail", {
          status: 403,
          code: "HTTP_403",
        }),
      ),
      listAllMessages: vi.fn().mockResolvedValue([stoppedEvents()[0]]),
    });

    await expect(
      pollManusTaskEvents({
        client: bound as never,
        taskId,
        operationToken,
        providerState: providerState(),
        now: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      status: "attention_required",
      result: { taskId },
    });
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps detail output and defers when listMessages is temporarily unavailable", async () => {
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("stopped")),
      listAllMessages: vi.fn().mockRejectedValue(
        transientReadError("task.listMessages", {
          status: 429,
          code: "HTTP_429",
          retryAfterMs: 75_000,
        }),
      ),
    });
    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });

    expect(result).toMatchObject({
      detailAvailable: true,
      messagesAvailable: false,
      deferred: true,
      nextPollMs: 75_000,
      detail: { taskId, status: "stopped" },
    });
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts the delayed result eleven seconds later and clears read failures", async () => {
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("stopped")),
      listAllMessages: vi
        .fn()
        .mockRejectedValueOnce(
          transientReadError("task.listMessages", {
            status: null,
            code: "TRANSPORT_UNKNOWN",
            transport: true,
          }),
        )
        .mockResolvedValueOnce(stoppedEvents()),
    });
    const first = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });
    const recovered = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: first.providerState,
      now: 12_000,
    });

    expect(recovered).toMatchObject({
      detailAvailable: true,
      messagesAvailable: true,
      deferred: false,
      state: { completed: true, failed: false },
      providerState: {
        buildPhase: "source_repairing",
        providerStoppedAt: new Date(1_000).toISOString(),
      },
    });
    expect(recovered.providerState.providerReadFailureCount).toBeUndefined();
    expect(recovered.providerState.providerNextPollAt).toBeUndefined();
    expect(recovered.events.some((event) => event.id === "repair-result")).toBe(
      true,
    );
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("limits a stopped task with an unavailable result stream to five minutes", async () => {
    const bound = client({
      taskDetail: vi
        .fn()
        .mockResolvedValueOnce(detail("stopped"))
        .mockRejectedValueOnce(transientReadError("task.detail")),
      listAllMessages: vi
        .fn()
        .mockRejectedValueOnce(transientReadError("task.listMessages"))
        .mockResolvedValueOnce([stoppedEvents()[0]]),
    });
    const first = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });
    expect(first.providerState).toMatchObject({
      providerStoppedAt: new Date(1_000).toISOString(),
      resultPendingSince: new Date(1_000).toISOString(),
    });
    await expect(
      pollManusTaskEvents({
        client: bound as never,
        taskId,
        operationToken,
        providerState: first.providerState,
        now: 1_000 + 5 * 60_000,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      status: "attention_required",
      result: { taskId },
    });
  });

  it("moves three not-found reads and a 24-hour transport outage to recoverable attention", async () => {
    const notFound = transientReadError("task.detail", {
      status: 404,
      code: "TASK_NOT_FOUND",
    });
    const notFoundClient = client({
      taskDetail: vi.fn().mockRejectedValue(notFound),
      listAllMessages: vi.fn().mockRejectedValue(notFound),
    });
    const first = await pollManusTaskEvents({
      client: notFoundClient as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });
    const second = await pollManusTaskEvents({
      client: notFoundClient as never,
      taskId,
      operationToken,
      providerState: first.providerState,
      now: 21_000,
    });
    await expect(
      pollManusTaskEvents({
        client: notFoundClient as never,
        taskId,
        operationToken,
        providerState: second.providerState,
        now: 61_000,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_PROVIDER_TASK_NOT_FOUND",
      status: "attention_required",
      result: { taskId },
    });

    const transportClient = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockRejectedValue(
        transientReadError("task.listMessages", {
          status: null,
          code: "TRANSPORT_UNKNOWN",
          transport: true,
        }),
      ),
    });
    await expect(
      pollManusTaskEvents({
        client: transportClient as never,
        taskId,
        operationToken,
        providerState: {
          ...providerState(),
          schemaVersion: 2,
          attempts: {
            extraction: 0,
            design: 0,
            content: 0,
            materialization: 0,
          },
          providerReadFailureCount: 5,
          providerReadFailureSince: new Date(1_000).toISOString(),
        } as never,
        now: 1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      status: "attention_required",
      result: { taskId },
    });
    expect(transportClient.createTask).not.toHaveBeenCalled();
    expect(transportClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not count a partial listMessages 404 as task-not-found when detail proves the task", async () => {
    const partial404 = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockRejectedValue(
        transientReadError("task.listMessages", {
          status: 404,
          code: "TASK_NOT_FOUND",
        }),
      ),
    });
    let state = providerState() as never;
    for (const now of [1_000, 11_000, 31_000]) {
      const result = await pollManusTaskEvents({
        client: partial404 as never,
        taskId,
        operationToken,
        providerState: state,
        now,
      });
      state = result.providerState as never;
      expect(result.providerState.providerTaskNotFoundCount).toBeUndefined();
    }
  });

  it("bounds send-unknown reconciliation at 24 hours", () => {
    const started = startProviderResultSyncWindow(providerState(), 1_000);
    expect(started.providerSyncStartedAt).toBe(new Date(1_000).toISOString());
    const first = providerResultSyncWindow(started, 1_000);
    expect(first.expired).toBe(false);
    expect(
      providerResultSyncWindow(
        first.state,
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS - 1,
      ).expired,
    ).toBe(false);
    expect(
      providerResultSyncWindow(
        first.state,
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
      ).expired,
    ).toBe(true);
    expect(
      providerResultSyncWindow(
        providerState(),
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
        1_000,
      ).expired,
    ).toBe(true);
  });

  it("persists bounded retries for transient existing-task attachment downloads", () => {
    const first = nativeSourceAttachmentRetryWindow(providerState(), 1_000);
    expect(first).toMatchObject({
      expired: false,
      nextPollMs: 10_000,
      state: {
        nativeSourceReadFailureCount: 1,
        nativeSourceReadFailureSince: new Date(1_000).toISOString(),
        nativeSourceNextPollAt: new Date(11_000).toISOString(),
      },
    });
    const second = nativeSourceAttachmentRetryWindow(first.state, 11_000);
    expect(second.nextPollMs).toBe(20_000);
    expect(
      nativeSourceAttachmentRetryWindow(
        second.state,
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
      ).expired,
    ).toBe(true);
  });

  it("keeps stable output file identity while accepting a refreshed signed URL", () => {
    const events = [
      stoppedEvents()[0],
      ...["old", "fresh"].map((suffix, index) => ({
        id: `attachment-${index}`,
        type: "assistant_message",
        timestamp: index + 2,
        assistant_message: {
          content: "",
          attachments: [
            {
              filename: "frontmind-site-source-v1.zip",
              content_type: "application/zip",
              file_id: "stable-output-file",
              url: `https://download.example/source.zip?signature=${suffix}`,
            },
          ],
        },
      })),
    ];
    expect(
      nativeSourceOutputAttachment(events as never, operationToken),
    ).toEqual({
      filename: "frontmind-site-source-v1.zip",
      contentType: "application/zip",
      fileId: "stable-output-file",
      eventId: "attachment-1",
      attachmentIdentity: "attachment-1:attachment:0",
      url: "https://download.example/source.zip?signature=fresh",
    });

    const conflict = events.map((event, index) =>
      index === 2
        ? {
            ...event,
            assistant_message: {
              ...(event as Record<string, any>).assistant_message,
              attachments: [
                {
                  filename: "frontmind-site-source-v1.zip",
                  content_type: "application/zip",
                  file_id: "different-output-file",
                  url: "https://download.example/source.zip?signature=other",
                },
              ],
            },
          }
        : event,
    );
    expect(() =>
      nativeSourceOutputAttachment(conflict as never, operationToken),
    ).toThrow("AI 建站返回了多个不同的完整源码包");
  });

  it("falls back to event and attachment index when a later GET omits file_id", () => {
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorFileId: "stable-output-file",
        priorAttachmentIdentity: "attachment-1:attachment:0",
        priorEventId: "attachment-1",
        attachment: {
          fileId: null,
          eventId: "attachment-1",
          attachmentIdentity: "attachment-1:attachment:0",
        },
      }),
    ).toBe(false);
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorFileId: "stable-output-file",
        priorAttachmentIdentity: "attachment-1:attachment:0",
        priorEventId: "attachment-1",
        attachment: {
          fileId: null,
          eventId: "attachment-1",
          attachmentIdentity: "attachment-1:attachment:1",
        },
      }),
    ).toBe(true);

    const duplicateZip = [
      stoppedEvents()[0],
      {
        id: "attachment-1",
        type: "assistant_message",
        timestamp: 2,
        assistant_message: {
          attachments: ["first", "second"].map((suffix) => ({
            filename: "frontmind-site-source-v1.zip",
            content_type: "application/zip",
            url: `https://download.example/source-${suffix}.zip`,
          })),
        },
      },
    ];
    expect(() =>
      nativeSourceOutputAttachment(duplicateZip as never, operationToken),
    ).toThrow("AI 建站返回了多个不同的完整源码包");
  });
});
