import { describe, expect, it, vi } from "vitest";

import {
  classifyKnowledgeBaseCanonicalCredentialRebind,
  classifyKnowledgeBaseAnchorAcknowledgementSettlement,
  executeKnowledgeBaseAnchorHandoff,
  inspectKnowledgeBaseAnchorAcknowledgement,
  planKnowledgeBaseAnchorGeneration,
} from "./knowledge-base-active-v2-migration-core";

const deletedCanonicalCredential = {
  providerProtocol: "manus_v2",
  status: "confirming",
  activeTurnId: null,
  canonicalTaskId: "old-canonical-task",
  canonicalTaskGeneration: 7,
  canonicalCredentialId: "old-credential",
  canonicalTaskState: "active",
  protocolErrorCode: null,
  generation: 7,
  credentialStatus: "deleted",
  resourceTaskId: "old-canonical-task",
  resourceCredentialId: "old-credential",
  resourceUserId: 42,
  userId: 42,
  resourceProjectAssignmentId: null,
  conversationProjectAssignmentId: null,
};

function harness(input?: {
  attempt?: "not_sent" | "sending" | "outcome_unknown" | "output_pending";
  matches?: Array<{ id: string; taskUrl: string | null }>;
  canonicalTask?: { id: string; taskUrl: string | null } | null;
  createFailure?: Error;
  failureClass?:
    | "outcome_unknown"
    | "retryable_rejection"
    | "terminal_rejection"
    | "other";
  settlement?: "completed" | "output_pending" | "attention_required";
}) {
  const task = { id: "task-v2", taskUrl: "https://manus.example/task-v2" };
  const calls = {
    beginCreate: vi.fn().mockResolvedValue(undefined),
    createTask: input?.createFailure
      ? vi.fn().mockRejectedValue(input.createFailure)
      : vi.fn().mockResolvedValue(task),
    reconcileCreate: vi.fn().mockResolvedValue(input?.matches ?? []),
    bindTask: vi.fn().mockResolvedValue(undefined),
    settleAcknowledgement: vi
      .fn()
      .mockResolvedValue(input?.settlement ?? "output_pending"),
    markOutcomeUnknown: vi.fn().mockResolvedValue(undefined),
    markRetryableRejection: vi.fn().mockResolvedValue(undefined),
    markTerminalRejection: vi.fn().mockResolvedValue(undefined),
  };
  return {
    task,
    calls,
    run: () =>
      executeKnowledgeBaseAnchorHandoff({
        attempt: input?.attempt ?? "not_sent",
        canonicalTask: input?.canonicalTask,
        ...calls,
        classifyCreateFailure: () => input?.failureClass ?? "other",
      }),
  };
}

describe("anchor-only Manus v2 handoff kernel", () => {
  it("permits a new-generation anchor only for an idle deleted canonical credential", () => {
    expect(
      classifyKnowledgeBaseCanonicalCredentialRebind(
        deletedCanonicalCredential,
      ),
    ).toBe("rebind_anchor");
  });

  it("accepts account and project ownership only when the resource scope exactly matches the conversation", () => {
    expect(
      classifyKnowledgeBaseCanonicalCredentialRebind({
        ...deletedCanonicalCredential,
        resourceProjectAssignmentId: "project-1",
        conversationProjectAssignmentId: "project-1",
      }),
    ).toBe("rebind_anchor");
    expect(
      classifyKnowledgeBaseCanonicalCredentialRebind({
        ...deletedCanonicalCredential,
        resourceProjectAssignmentId: "project-other",
        conversationProjectAssignmentId: "project-1",
      }),
    ).toBe("excluded");
    expect(
      classifyKnowledgeBaseCanonicalCredentialRebind({
        ...deletedCanonicalCredential,
        resourceProjectAssignmentId: null,
        conversationProjectAssignmentId: "project-1",
      }),
    ).toBe("excluded");
  });

  it.each(["active", "retired"])(
    "does not rebind a canonical task whose credential remains %s",
    (credentialStatus) => {
      expect(
        classifyKnowledgeBaseCanonicalCredentialRebind({
          ...deletedCanonicalCredential,
          credentialStatus,
        }),
      ).toBe("credential_still_available");
    },
  );

  it.each(["queued-turn", "sending-turn", "unknown-turn"])(
    "does not cut generation while active operation %s owns the build",
    (activeTurnId) => {
      expect(
        classifyKnowledgeBaseCanonicalCredentialRebind({
          ...deletedCanonicalCredential,
          activeTurnId,
        }),
      ).toBe("active_operation");
    },
  );

  it.each([
    { resourceTaskId: "different-task" },
    { resourceCredentialId: "different-credential" },
    { canonicalTaskGeneration: 6 },
    { status: "researching" },
  ])("requires the complete old canonical ownership proof: %o", (patch) => {
    expect(
      classifyKnowledgeBaseCanonicalCredentialRebind({
        ...deletedCanonicalCredential,
        ...patch,
      }),
    ).toBe("excluded");
  });

  it.each(["legacy_task_owner", "current_unbound"] as const)(
    "keeps the accepted generation when credential mode is %s",
    (credentialMode) => {
      expect(
        planKnowledgeBaseAnchorGeneration({
          sourceGeneration: 7,
          credentialMode,
        }),
      ).toEqual({
        sourceGeneration: 7,
        targetGeneration: 7,
        receiptSourceGeneration: null,
      });
    },
  );

  it("creates one new generation when the old task credential is permanently unavailable", () => {
    expect(
      planKnowledgeBaseAnchorGeneration({
        sourceGeneration: 7,
        credentialMode: "current_rebind",
      }),
    ).toEqual({
      sourceGeneration: 7,
      targetGeneration: 8,
      receiptSourceGeneration: 7,
    });
  });

  it("creates exactly once only from not_sent and remains output-pending", async () => {
    const test = harness({ settlement: "output_pending" });
    await expect(test.run()).resolves.toMatchObject({
      state: "output_pending",
      source: "created",
      task: test.task,
    });
    expect(test.calls.beginCreate).toHaveBeenCalledOnce();
    expect(test.calls.createTask).toHaveBeenCalledOnce();
    expect(test.calls.reconcileCreate).not.toHaveBeenCalled();
    expect(test.calls.bindTask).toHaveBeenCalledWith(test.task);
    expect(test.calls.settleAcknowledgement).toHaveBeenCalledWith(test.task);
  });

  it("allows only one racing worker through the durable begin-create fence", async () => {
    let granted = false;
    const providerCreate = vi
      .fn()
      .mockResolvedValue({ id: "one-task", taskUrl: null });
    const runWorker = () =>
      executeKnowledgeBaseAnchorHandoff({
        attempt: "not_sent",
        beginCreate: async () => {
          if (granted) throw new Error("writer fence already held");
          granted = true;
        },
        createTask: providerCreate,
        reconcileCreate: vi.fn().mockResolvedValue([]),
        bindTask: vi.fn().mockResolvedValue(undefined),
        settleAcknowledgement: vi.fn().mockResolvedValue("output_pending"),
        classifyCreateFailure: () => "other",
        markOutcomeUnknown: vi.fn().mockResolvedValue(undefined),
        markRetryableRejection: vi.fn().mockResolvedValue(undefined),
        markTerminalRejection: vi.fn().mockResolvedValue(undefined),
      });

    const results = await Promise.allSettled([runWorker(), runWorker()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(providerCreate).toHaveBeenCalledOnce();
  });

  it.each(["sending", "outcome_unknown", "output_pending"] as const)(
    "never creates again from %s",
    async (attempt) => {
      const test = harness({ attempt, matches: [] });
      await expect(test.run()).resolves.toEqual({
        state: "reconciling",
        source: "provider_history",
        matchCount: 0,
      });
      expect(test.calls.beginCreate).not.toHaveBeenCalled();
      expect(test.calls.createTask).not.toHaveBeenCalled();
      expect(test.calls.reconcileCreate).toHaveBeenCalledOnce();
    },
  );

  it("adopts one exact title/token match", async () => {
    const match = { id: "task-adopt", taskUrl: null };
    const test = harness({
      attempt: "outcome_unknown",
      matches: [match],
      settlement: "output_pending",
    });
    await expect(test.run()).resolves.toMatchObject({
      state: "output_pending",
      source: "adopted",
      task: match,
    });
    expect(test.calls.createTask).not.toHaveBeenCalled();
    expect(test.calls.bindTask).toHaveBeenCalledWith(match);
    expect(test.calls.settleAcknowledgement).toHaveBeenCalledWith(match);
  });

  it("keeps an ambiguous create local and never binds either task", async () => {
    const test = harness({
      attempt: "outcome_unknown",
      matches: [
        { id: "task-a", taskUrl: null },
        { id: "task-b", taskUrl: null },
      ],
    });
    await expect(test.run()).resolves.toEqual({
      state: "reconciling",
      source: "provider_history",
      matchCount: 2,
    });
    expect(test.calls.createTask).not.toHaveBeenCalled();
    expect(test.calls.bindTask).not.toHaveBeenCalled();
    expect(test.calls.settleAcknowledgement).not.toHaveBeenCalled();
  });

  it("keeps a zero-match create local and never creates a replacement", async () => {
    const test = harness({ attempt: "outcome_unknown", matches: [] });
    await expect(test.run()).resolves.toEqual({
      state: "reconciling",
      source: "provider_history",
      matchCount: 0,
    });
    expect(test.calls.createTask).not.toHaveBeenCalled();
    expect(test.calls.bindTask).not.toHaveBeenCalled();
    expect(test.calls.settleAcknowledgement).not.toHaveBeenCalled();
  });

  it("rechecks acknowledgement after a crash following canonical bind", async () => {
    const canonicalTask = { id: "task-bound", taskUrl: null };
    const test = harness({
      attempt: "output_pending",
      canonicalTask,
      settlement: "completed",
    });
    await expect(test.run()).resolves.toMatchObject({
      state: "completed",
      source: "canonical",
    });
    expect(test.calls.beginCreate).not.toHaveBeenCalled();
    expect(test.calls.createTask).not.toHaveBeenCalled();
    expect(test.calls.reconcileCreate).not.toHaveBeenCalled();
    expect(test.calls.settleAcknowledgement).toHaveBeenCalledWith(
      canonicalTask,
    );
  });

  it("accepts only the exact anchor acknowledgement tuple", () => {
    const expected = {
      operationToken: "operation-1",
      turnId: "turn-1",
      generation: 3,
      baseRevision: 7,
    };
    expect(
      inspectKnowledgeBaseAnchorAcknowledgement({
        expected,
        events: [
          {
            id: "ack-1",
            type: "structured_output_result",
            timestamp: 5,
            structured_output_result: {
              success: true,
              value: { schemaVersion: 1, ...expected, handoffAccepted: true },
            },
          },
        ],
      }),
    ).toMatchObject({
      kind: "accepted",
      acknowledgement: { eventId: "ack-1", ...expected },
    });
  });

  it("classifies an attributed stale tuple as malformed", () => {
    expect(
      inspectKnowledgeBaseAnchorAcknowledgement({
        expected: {
          operationToken: "operation-1",
          turnId: "turn-1",
          generation: 3,
          baseRevision: 7,
        },
        events: [
          {
            id: "ack-stale",
            type: "structured_output_result",
            timestamp: 5,
            structured_output_result: {
              success: true,
              value: {
                schemaVersion: 1,
                operationToken: "operation-1",
                turnId: "turn-other",
                generation: 3,
                baseRevision: 7,
                handoffAccepted: true,
              },
            },
          },
        ],
      }),
    ).toEqual({
      kind: "malformed",
      code: "ANCHOR_ACK_COORDINATE_CONFLICT",
    });
  });

  it.each([
    ["running", "output_pending", undefined],
    ["error", "attention_required", "MANUS_V2_ANCHOR_TASK_ERROR"],
    ["stopped", "attention_required", "MANUS_V2_ANCHOR_ACK_MISSING"],
  ] as const)(
    "settles a missing acknowledgement in %s as %s",
    (taskStatus, state, code) => {
      expect(
        classifyKnowledgeBaseAnchorAcknowledgementSettlement({
          inspection: { kind: "missing" },
          taskStatus,
        }),
      ).toEqual(code ? { state, code } : { state });
    },
  );

  it("persists outcome-unknown and does not classify it as a retry", async () => {
    const failure = new Error("lost response");
    const test = harness({
      createFailure: failure,
      failureClass: "outcome_unknown",
    });
    await expect(test.run()).rejects.toBe(failure);
    expect(test.calls.markOutcomeUnknown).toHaveBeenCalledOnce();
    expect(test.calls.markRetryableRejection).not.toHaveBeenCalled();
    expect(test.calls.bindTask).not.toHaveBeenCalled();
  });
});
