import { describe, expect, it } from "vitest";

import {
  buildKnowledgeBaseManusV2FormatRepair,
  buildKnowledgeBaseManusV2AnchorErrorRecovery,
  classifyKnowledgeBaseManusV2ErrorRecoveryAttempt,
  classifyKnowledgeBaseManusV2FormatRepairAttempt,
  classifyKnowledgeBaseManusV2Lifecycle,
  classifyKnowledgeBaseManusV2WaitingAttempt,
  isRepairableKnowledgeBaseManusV2FormatCode,
  safeKnowledgeBaseConfirmationInput,
  knowledgeBaseManusV2ErrorRecoveryRejection,
  manusV2WaitingEventIsStrictSuccessor,
} from "./knowledge-base-manus-v2-lifecycle";

const contract = {
  operationToken: "op-1",
  turnId: "turn-1",
  generation: 1,
  baseRevision: 3,
  action: "confirm" as const,
  fromLeafId: "leaf-3",
  expectContentCompleted: false,
  requiresManifest: false,
};

function status(agent_status: string, status_detail?: unknown) {
  return {
    id: `status-${agent_status}`,
    type: "status_update",
    timestamp: 10,
    status_update: { agent_status, status_detail },
  };
}

const operationEvent = {
  id: "user-op",
  type: "user_message",
  timestamp: 1,
  user_message: {
    content: 'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"op-1"}',
  },
};

describe("Manus v2 knowledge-base lifecycle policy", () => {
  it("polls running and derives one coordinate-bound same-task error recovery", () => {
    expect(
      classifyKnowledgeBaseManusV2Lifecycle({
        events: [status("running")],
        contract,
      }),
    ).toEqual({
      kind: "poll",
      taskStatus: "running",
    });
    expect(
      classifyKnowledgeBaseManusV2Lifecycle({
        events: [operationEvent, status("error")],
        contract,
      }),
    ).toMatchObject({
      kind: "recover_error",
      taskStatus: "error",
      recoveryToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("does not recover a task error that predates the frozen operation", () => {
    expect(
      classifyKnowledgeBaseManusV2Lifecycle({
        events: [status("error"), { ...operationEvent, timestamp: 11 }],
        contract,
      }),
    ).toMatchObject({
      kind: "attention_required",
      code: "MANUS_V2_TASK_ERROR_NOT_ATTRIBUTED",
    });
  });

  it("adopts only the exact durable error-recovery token and never resends", () => {
    const decision = classifyKnowledgeBaseManusV2Lifecycle({
      events: [operationEvent, status("error")],
      contract,
    });
    expect(decision.kind).toBe("recover_error");
    if (decision.kind !== "recover_error") throw new Error("missing recovery");
    const recoveryEvent = {
      id: "user-recovery",
      type: "user_message",
      timestamp: 11,
      user_message: { content: decision.prompt },
    };
    expect(
      classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
        recoveryToken: decision.recoveryToken,
        events: [],
      }),
    ).toBe("send");
    for (const attemptState of ["sending", "outcome_unknown"] as const) {
      expect(
        classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
          attemptState,
          recoveryToken: decision.recoveryToken,
          events: [],
        }),
      ).toBe("wait");
      expect(
        classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
          attemptState,
          recoveryToken: decision.recoveryToken,
          events: [
            {
              ...recoveryEvent,
              user_message: {
                content: decision.prompt.replace(
                  decision.recoveryToken,
                  "another-token",
                ),
              },
            },
          ],
        }),
      ).toBe("wait");
      expect(
        classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
          attemptState,
          recoveryToken: decision.recoveryToken,
          events: [recoveryEvent],
        }),
      ).toBe("adopt");
    }
    expect(
      classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
        attemptState: "acknowledged",
        recoveryToken: decision.recoveryToken,
        events: [recoveryEvent],
      }),
    ).toBe("wait");
    expect(
      classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
        attemptState: "acknowledged",
        recoveryToken: decision.recoveryToken,
        events: [recoveryEvent, { ...status("error"), timestamp: 12 }],
      }),
    ).toBe("attention_required");
  });

  it("uses the exact anchor acknowledgement coordinates in same-task recovery", () => {
    const recovery = buildKnowledgeBaseManusV2AnchorErrorRecovery({
      operationToken: "anchor-op",
      turnId: "anchor-turn",
      generation: 4,
      baseRevision: 17,
    });
    expect(recovery.prompt).toContain("self-contained");
    expect(recovery.prompt).toContain('"handoffAccepted":true');
    expect(recovery.prompt).toContain('"operationToken":"anchor-op"');
    expect(recovery.recoveryToken).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("bounds explicit recovery rejections and honors Retry-After only when supplied", () => {
    const withHeader = knowledgeBaseManusV2ErrorRecoveryRejection({
      retryable: true,
      retryAfterMs: 7_000,
      recoveryToken: "recovery-token",
    });
    expect(withHeader).toEqual({ retry: true, attempt: 1, delayMs: 7_000 });

    const withoutHeader = knowledgeBaseManusV2ErrorRecoveryRejection({
      retryable: true,
      recoveryToken: "recovery-token",
    });
    expect(withoutHeader.retry).toBe(true);
    expect(withoutHeader.retry && withoutHeader.delayMs).toBeGreaterThanOrEqual(
      1_000,
    );
    expect(withoutHeader.retry && withoutHeader.delayMs).toBeLessThanOrEqual(
      1_200,
    );

    expect(
      knowledgeBaseManusV2ErrorRecoveryRejection({
        previousCount: 3,
        retryable: true,
        recoveryToken: "recovery-token",
      }),
    ).toEqual({ retry: false, attempt: 4 });
    expect(
      knowledgeBaseManusV2ErrorRecoveryRejection({
        retryable: false,
        recoveryToken: "recovery-token",
      }),
    ).toEqual({ retry: false, attempt: 1 });
  });

  it("retries the same frozen recovery only after its durable deadline", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    expect(
      classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
        attemptState: "retry_wait",
        recoveryToken: "recovery-token",
        events: [],
        nextRetryAt: "2026-08-13T00:00:01.000Z",
        now,
      }),
    ).toBe("wait");
    expect(
      classifyKnowledgeBaseManusV2ErrorRecoveryAttempt({
        attemptState: "retry_wait",
        recoveryToken: "recovery-token",
        events: [],
        nextRetryAt: "2026-08-12T23:59:59.000Z",
        now,
      }),
    ).toBe("send");
  });

  it("uses sendMessage only for messageAskUser", () => {
    const decision = classifyKnowledgeBaseManusV2Lifecycle({
      events: [
        operationEvent,
        status("waiting", {
          waiting_for_event_id: "evt-question",
          waiting_for_event_type: "messageAskUser",
        }),
      ],
      contract,
    });
    expect(decision).toMatchObject({
      kind: "ask_user_continue",
      eventId: "evt-question",
      eventType: "messageAskUser",
      statusEventId: "status-waiting",
      continuationToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    if (decision.kind !== "ask_user_continue") throw new Error("missing wait");
    expect(
      classifyKnowledgeBaseManusV2WaitingAttempt({
        attemptState: "outcome_unknown",
        action: decision.kind,
        eventId: decision.eventId,
        statusEventId: decision.statusEventId,
        continuationToken: decision.continuationToken,
        events: [],
      }),
    ).toBe("wait");
    expect(
      classifyKnowledgeBaseManusV2WaitingAttempt({
        attemptState: "sending",
        action: decision.kind,
        eventId: decision.eventId,
        statusEventId: decision.statusEventId,
        continuationToken: decision.continuationToken,
        events: [
          {
            id: "wait-continuation",
            type: "user_message",
            timestamp: 11,
            user_message: { content: decision.prompt },
          },
        ],
      }),
    ).toBe("adopt");
  });

  it("only confirms exact, internal accept-only schema", () => {
    const schema = {
      type: "object",
      properties: { accept: { type: "boolean" } },
      required: ["accept"],
    };
    expect(
      classifyKnowledgeBaseManusV2Lifecycle({
        events: [
          operationEvent,
          status("waiting", {
            waiting_for_event_id: "evt-safe",
            waiting_for_event_type: "mapreduceAction",
            confirm_input_schema: schema,
          }),
        ],
        contract,
      }),
    ).toMatchObject({
      kind: "confirm_safe",
      eventId: "evt-safe",
      confirmationInput: { accept: true },
    });
    expect(
      safeKnowledgeBaseConfirmationInput({
        eventType: "mapreduceAction",
        confirmInputSchema: schema,
      }),
    ).toEqual({ accept: true });
    for (const eventType of [
      "gmailSendAction",
      "deployAction",
      "terminalExecute",
      "googleCalendarCreate",
      "metaMarketingAction",
      "needConnectMyBrowser",
      "webdevRequestSecrets",
      "unknownNewAction",
    ]) {
      expect(
        safeKnowledgeBaseConfirmationInput({
          eventType,
          confirmInputSchema: schema,
        }),
      ).toBeNull();
    }
    expect(
      safeKnowledgeBaseConfirmationInput({
        eventType: "mapreduceAction",
        confirmInputSchema: {
          ...schema,
          properties: {
            accept: { type: "boolean" },
            destructiveMode: { type: "boolean" },
          },
        },
      }),
    ).toBeNull();
  });

  it("settles confirmAction only from a later status and recognizes a strict second wait", () => {
    const first = {
      id: "status-wait-1",
      type: "status_update",
      timestamp: 10,
      status_update: {
        agent_status: "waiting",
        status_detail: {
          waiting_for_event_id: "evt-1",
          waiting_for_event_type: "mapreduceAction",
        },
      },
    };
    const second = {
      id: "status-wait-2",
      type: "status_update",
      timestamp: 20,
      status_update: {
        agent_status: "waiting",
        status_detail: {
          waiting_for_event_id: "evt-2",
          waiting_for_event_type: "mapreduceAction",
        },
      },
    };
    expect(
      classifyKnowledgeBaseManusV2WaitingAttempt({
        attemptState: "sending",
        action: "confirm_safe",
        eventId: "evt-1",
        statusEventId: first.id,
        events: [first],
      }),
    ).toBe("attention_required");
    expect(
      classifyKnowledgeBaseManusV2WaitingAttempt({
        attemptState: "outcome_unknown",
        action: "confirm_safe",
        eventId: "evt-1",
        statusEventId: first.id,
        events: [first, second],
      }),
    ).toBe("adopt");
    expect(
      manusV2WaitingEventIsStrictSuccessor({
        events: [second, first],
        previousEventId: "evt-1",
        previousStatusEventId: first.id,
        nextEventId: "evt-2",
        nextStatusEventId: second.id,
      }),
    ).toBe(true);
  });

  it("builds one coordinate-bound, no-advance format repair", () => {
    const repair = buildKnowledgeBaseManusV2FormatRepair({
      contract,
      events: [operationEvent],
    });
    expect(repair?.prompt).toContain("Do not redo research, advance a node");
    expect(repair?.prompt).toContain('"operationToken":"op-1"');
    expect(repair?.repairToken).toMatch(/^[a-f0-9]{64}$/u);
    const omittedContractRepair = buildKnowledgeBaseManusV2FormatRepair({
      contract,
      events: [],
    });
    expect(omittedContractRepair).toEqual(repair);
    expect(
      classifyKnowledgeBaseManusV2FormatRepairAttempt({
        attemptState: "outcome_unknown",
        repairToken: repair!.repairToken,
        events: [],
      }),
    ).toBe("attention_required");
    expect(
      classifyKnowledgeBaseManusV2FormatRepairAttempt({
        attemptState: "sending",
        repairToken: repair!.repairToken,
        events: [
          {
            id: "format-repair",
            type: "user_message",
            timestamp: 12,
            user_message: { content: repair!.prompt },
          },
        ],
      }),
    ).toBe("adopt");
    expect(
      isRepairableKnowledgeBaseManusV2FormatCode("INVALID_GENERATION"),
    ).toBe(true);
    expect(
      isRepairableKnowledgeBaseManusV2FormatCode(
        "OPERATION_COORDINATE_CONFLICT",
      ),
    ).toBe(false);
    expect(
      isRepairableKnowledgeBaseManusV2FormatCode("NEXT_LEAF_CONFLICT"),
    ).toBe(false);
  });
});
