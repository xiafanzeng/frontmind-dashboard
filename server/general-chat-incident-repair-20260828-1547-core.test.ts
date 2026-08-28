import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { generalChatTerminalMessagePublicId } from "../shared/frontmind-general-chat-terminal";
import type { ManusV2MessageEvent } from "./manus-v2-client";
import {
  GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
  assertGeneralChatTerminal1547MutationFence,
  bindGeneralChatTerminal1547LegacyOutputs,
  classifyGeneralChatTerminal1547Outcome,
  generalChatTerminal1547ProjectionMetadata,
  generalChatTerminalMessagePersistedId,
  generalChatTerminalPublicIdFromPersisted,
  isGeneralChatTerminal1547Command,
  parseGeneralChatTerminal1547RepairCommand,
  readGeneralChatTerminal1547ProviderEvidence,
  runOrderedGeneralChatIncidentRepairSteps,
  runStateBoundGeneralChatTerminal1547Repair,
  selectGeneralChatTerminal1547TurnEvents,
} from "./general-chat-incident-repair-20260828-1547-core";

function event(
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
  rank = 0,
): ManusV2MessageEvent {
  return {
    id,
    type,
    timestamp: 1_777_000_000,
    providerOriginalRank: rank,
    ...payload,
  };
}

describe("general-chat 15:47 terminal incident repair core", () => {
  it("parses only the explicit state-bound terminal-1547 command", () => {
    expect(
      isGeneralChatTerminal1547Command([
        "--mode=preview",
        "--incident=terminal-1547",
      ]),
    ).toBe(true);
    expect(
      parseGeneralChatTerminal1547RepairCommand([
        "--incident=terminal-1547",
        "--mode=preview",
      ]),
    ).toEqual({ incident: "terminal-1547", mode: "preview" });
    expect(
      parseGeneralChatTerminal1547RepairCommand([
        "--mode=apply",
        `--expected-state-hash=${"a".repeat(64)}`,
        "--incident=terminal-1547",
      ]),
    ).toEqual({
      incident: "terminal-1547",
      mode: "apply",
      expectedStateHash: "a".repeat(64),
    });
    expect(() =>
      parseGeneralChatTerminal1547RepairCommand([
        "--incident=terminal-1547",
        "--mode=apply",
      ]),
    ).toThrow("ARGUMENT_INVALID");
  });

  it("derives byte-identical deterministic notice ids in personal and project scopes", () => {
    const conversationId = "conversation-1547";
    const taskId = "task-1547";
    const digest = createHash("sha256")
      .update(
        `${conversationId}\0${taskId}\0${GENERAL_CHAT_TERMINAL_1547_ERROR_CODE}`,
      )
      .digest("hex")
      .slice(0, 32);
    const publicId = `msg-general-chat-terminal-${digest}`;
    expect(
      generalChatTerminalMessagePublicId({
        conversationId,
        taskId,
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
      }),
    ).toBe(publicId);
    expect(
      generalChatTerminalMessagePersistedId({
        userId: 42,
        projectAssignmentId: null,
        persistedConversationId: `u42:${conversationId}`,
        localTaskId: taskId,
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
      }),
    ).toBe(`u42:${publicId}`);
    expect(
      generalChatTerminalMessagePersistedId({
        userId: 42,
        projectAssignmentId: "assignment-7",
        persistedConversationId: `passignment-7:${conversationId}`,
        localTaskId: taskId,
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
      }),
    ).toBe(`passignment-7:${publicId}`);
    expect(() =>
      generalChatTerminalMessagePersistedId({
        userId: 42,
        projectAssignmentId: "assignment-8",
        persistedConversationId: `passignment-7:${conversationId}`,
        localTaskId: taskId,
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
      }),
    ).toThrow("CONVERSATION_SCOPE_MISMATCH");
    expect(
      generalChatTerminalPublicIdFromPersisted({
        userId: 42,
        projectAssignmentId: "assignment-7",
        persistedConversationId: `passignment-7:${conversationId}`,
        persistedResourceId: `passignment-7:${publicId}`,
      }),
    ).toBe(publicId);
  });

  it("uses watermark plus prompt and attachment identity to isolate the current turn", () => {
    const prompt = "修改名片";
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const events = [
      event(
        "old-user",
        "user_message",
        { user_message: { content: "旧轮" } },
        0,
      ),
      event(
        "old-error",
        "error_message",
        { error_message: { error_type: "old" } },
        1,
      ),
      event(
        "old-status",
        "status_update",
        { status_update: { agent_status: "error" } },
        2,
      ),
      event(
        "current-user",
        "user_message",
        {
          user_message: {
            content: [
              { type: "text", text: prompt },
              { type: "file", file_id: "provider-file-1" },
            ],
          },
        },
        3,
      ),
      event(
        "current-output",
        "assistant_message",
        { assistant_message: { content: "done" } },
        4,
      ),
      event(
        "current-stopped",
        "status_update",
        { status_update: { agent_status: "stopped" } },
        5,
      ),
    ];
    const selected = selectGeneralChatTerminal1547TurnEvents({
      events: [...events].reverse(),
      promptSha256,
      providerAttachmentFileIds: ["provider-file-1"],
      providerEventWatermark: ["old-user", "old-error", "old-status"],
    });
    expect(selected.userEventId).toBe("current-user");
    expect(selected.events.map((item) => item.id)).toEqual([
      "current-user",
      "current-output",
      "current-stopped",
    ]);
    expect(
      classifyGeneralChatTerminal1547Outcome({
        detailStatus: "stopped",
        currentTurnEvents: selected.events,
      }),
    ).toMatchObject({
      kind: "completed",
      eventStatus: "stopped",
      outputEventIds: ["current-output"],
      userStop: false,
    });
  });

  it("binds the real legacy snapshot shape through upstreamOutputId and upgrades it idempotently", () => {
    const messages = [
      {
        id: "legacy-output-text",
        metadata: { upstreamOutputId: "local-event-text" },
      },
      {
        id: "legacy-output-image",
        metadata: {
          upstreamOutputId: "local-event-image",
          inlineImages: [{ src: "/api/frontmind/v2/artifacts/image/content" }],
        },
      },
    ];
    const agentEvents = [
      {
        id: "local-event-text",
        taskId: "local-task",
        providerEventId: "provider-event-text",
        eventType: "assistant_message",
        normalizedPayload: { kind: "provider_event", text: "done" },
      },
      {
        id: "local-event-image",
        taskId: "local-task",
        providerEventId: "provider-event-image",
        eventType: "assistant_message",
        normalizedPayload: { kind: "provider_event", artifacts: [{}] },
      },
    ];
    expect(
      bindGeneralChatTerminal1547LegacyOutputs({
        messages,
        agentEvents,
        localTaskId: "local-task",
        currentTurnOutputEventIds: [
          "provider-event-text",
          "provider-event-image",
        ],
      }),
    ).toEqual([
      {
        messageId: "legacy-output-text",
        localEventId: "local-event-text",
        providerEventId: "provider-event-text",
      },
      {
        messageId: "legacy-output-image",
        localEventId: "local-event-image",
        providerEventId: "provider-event-image",
      },
    ]);

    const first = generalChatTerminal1547ProjectionMetadata({
      metadata: messages[1]!.metadata,
      turnId: "latest-failed-turn",
      localTaskId: "local-task",
      localEventId: "local-event-image",
      providerEventId: "provider-event-image",
    });
    const rerun = generalChatTerminal1547ProjectionMetadata({
      metadata: first,
      turnId: "latest-failed-turn",
      localTaskId: "local-task",
      localEventId: "local-event-image",
      providerEventId: "provider-event-image",
    });
    expect(rerun).toEqual(first);
    expect(rerun.inlineImages).toEqual(messages[1]!.metadata.inlineImages);
    expect(rerun.generalChat).toEqual({
      schemaVersion: 1,
      kind: "assistant_projection",
      turnId: "latest-failed-turn",
      agentTaskId: "local-task",
      providerEventId: "provider-event-image",
      serverOwned: true,
    });
  });

  it("rejects legacy output rows that do not bijectively match current-turn Provider evidence", () => {
    const base = {
      messages: [
        {
          id: "legacy-output",
          metadata: { upstreamOutputId: "local-event" },
        },
      ],
      agentEvents: [
        {
          id: "local-event",
          taskId: "local-task",
          providerEventId: "provider-event",
          eventType: "assistant_message",
          normalizedPayload: { kind: "provider_event" },
        },
      ],
      localTaskId: "local-task",
    };
    expect(() =>
      bindGeneralChatTerminal1547LegacyOutputs({
        ...base,
        currentTurnOutputEventIds: ["other-turn-output"],
      }),
    ).toThrow("OUTPUT_EVENT_MISMATCH");
    expect(() =>
      bindGeneralChatTerminal1547LegacyOutputs({
        ...base,
        agentEvents: [{ ...base.agentEvents[0]!, taskId: "other-task" }],
        currentTurnOutputEventIds: ["provider-event"],
      }),
    ).toThrow("OUTPUT_EVENT_MISMATCH");
  });

  it("rejects preview-to-lock drift in critical rows, latest turn, and dependent evidence", () => {
    const preview = {
      operation: {
        id: "operation",
        status: "failed",
        errorCode: "RESULT_MISSING",
      },
      task: { id: "task", providerState: "stopped" },
      conversation: { id: "conversation", status: "error", version: 4 },
      turn: { id: "latest-turn", status: "failed" },
      latestTurnId: "latest-turn",
      outputs: [{ id: "output", turnId: null }],
      attachments: [{ id: "attachment", kind: "file" }],
      events: [{ id: "event", providerEventId: "provider-output" }],
    };
    expect(() =>
      assertGeneralChatTerminal1547MutationFence(preview, {
        ...preview,
        conversation: { ...preview.conversation, version: 5 },
      }),
    ).toThrow("LOCAL_STATE_CHANGED");
    expect(() =>
      assertGeneralChatTerminal1547MutationFence(preview, {
        ...preview,
        latestTurnId: "concurrent-turn",
      }),
    ).toThrow("LOCAL_STATE_CHANGED");
    expect(() =>
      assertGeneralChatTerminal1547MutationFence(preview, {
        ...preview,
        outputs: [{ id: "output", turnId: "concurrent-turn" }],
      }),
    ).toThrow("LOCAL_STATE_CHANGED");
    expect(() =>
      assertGeneralChatTerminal1547MutationFence(preview, preview),
    ).not.toThrow();
  });

  it("keeps true error output as partial and distinguishes failure and user stop", () => {
    const output = event("output", "assistant_message", {}, 0);
    const error = event(
      "error",
      "error_message",
      { error_message: { error_type: "provider_failure", content: "private" } },
      1,
    );
    expect(
      classifyGeneralChatTerminal1547Outcome({
        detailStatus: "error",
        currentTurnEvents: [output, error],
      }),
    ).toMatchObject({
      kind: "partial",
      errorType: "provider_failure",
      outputEventIds: ["output"],
    });
    expect(
      classifyGeneralChatTerminal1547Outcome({
        detailStatus: "error",
        currentTurnEvents: [error],
      }).kind,
    ).toBe("failed");
    expect(
      classifyGeneralChatTerminal1547Outcome({
        detailStatus: "stopped",
        currentTurnEvents: [output, event("stop", "user_stop", {}, 2)],
      }).kind,
    ).toBe("cancelled");
  });

  it("reads only task.detail and task.listMessages, never Provider writes", async () => {
    const taskDetail = vi.fn().mockResolvedValue({ status: "stopped" });
    const listAllMessages = vi.fn().mockResolvedValue([]);
    const createTask = vi.fn();
    const sendMessage = vi.fn();
    const stopTask = vi.fn();
    const result = await readGeneralChatTerminal1547ProviderEvidence(
      {
        taskDetail,
        listAllMessages,
        createTask,
        sendMessage,
        stopTask,
      } as never,
      "provider-task-1547",
    );
    expect(result).toEqual({ detail: { status: "stopped" }, events: [] });
    expect(taskDetail).toHaveBeenCalledWith("provider-task-1547");
    expect(listAllMessages).toHaveBeenCalledWith({
      taskId: "provider-task-1547",
      order: "asc",
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("applies exactly once and a completed rerun makes no further mutation", async () => {
    let state = { stateHash: "before", complete: false };
    const apply = vi.fn(async () => {
      state = { stateHash: "after", complete: true };
    });
    const operations = { inspect: vi.fn(async () => state), apply };
    const first = await runStateBoundGeneralChatTerminal1547Repair(
      {
        incident: "terminal-1547",
        mode: "apply",
        expectedStateHash: "before",
      },
      operations,
    );
    expect(first.applied).toBe(true);
    const rerun = await runStateBoundGeneralChatTerminal1547Repair(
      {
        incident: "terminal-1547",
        mode: "apply",
        expectedStateHash: "after",
      },
      operations,
    );
    expect(rerun.applied).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("runs legacy recovery before terminal-1547 under the shared automatic sequence", async () => {
    const order: string[] = [];
    const legacyApply = vi.fn(async () => {
      order.push("legacy-apply");
      return { applied: true };
    });
    const terminalApply = vi.fn(async () => {
      order.push("terminal-apply");
      return { applied: true };
    });
    const results = await runOrderedGeneralChatIncidentRepairSteps([
      {
        incident: "legacy",
        isLocallyComplete: async () => {
          order.push("legacy-local");
          return false;
        },
        preview: async () => {
          order.push("legacy-preview");
          return { complete: false, stateHash: "legacy-hash" };
        },
        apply: legacyApply,
      },
      {
        incident: "terminal-1547",
        isLocallyComplete: async () => {
          order.push("terminal-local");
          return false;
        },
        preview: async () => {
          order.push("terminal-preview");
          return { complete: false, stateHash: "terminal-hash" };
        },
        apply: terminalApply,
      },
    ]);
    expect(order).toEqual([
      "legacy-local",
      "legacy-preview",
      "legacy-apply",
      "terminal-local",
      "terminal-preview",
      "terminal-apply",
    ]);
    expect(legacyApply).toHaveBeenCalledWith("legacy-hash");
    expect(terminalApply).toHaveBeenCalledWith("terminal-hash");
    expect(results).toEqual([
      { incident: "legacy", applied: true, errorCode: null },
      { incident: "terminal-1547", applied: true, errorCode: null },
    ]);
  });

  it("continues to terminal-1547 when the earlier incident is already complete", async () => {
    const legacyPreview = vi.fn();
    const terminalApply = vi.fn(async () => ({ applied: true }));
    const results = await runOrderedGeneralChatIncidentRepairSteps([
      {
        incident: "legacy",
        isLocallyComplete: async () => true,
        preview: legacyPreview,
        apply: vi.fn(),
      },
      {
        incident: "terminal-1547",
        isLocallyComplete: async () => false,
        preview: async () => ({ complete: false, stateHash: "terminal-hash" }),
        apply: terminalApply,
      },
    ]);
    expect(legacyPreview).not.toHaveBeenCalled();
    expect(terminalApply).toHaveBeenCalledWith("terminal-hash");
    expect(results).toEqual([
      { incident: "legacy", applied: false, errorCode: null },
      { incident: "terminal-1547", applied: true, errorCode: null },
    ]);
  });

  it("isolates a failed incident step, continues terminal repair, and reports a safe error code", async () => {
    const terminalApply = vi.fn(async () => ({ applied: true }));
    const results = await runOrderedGeneralChatIncidentRepairSteps([
      {
        incident: "legacy-sync-loss",
        isLocallyComplete: async () => false,
        preview: async () => {
          throw new Error("GENERAL_CHAT_INCIDENT_LEGACY_CANDIDATE_AMBIGUOUS");
        },
        apply: vi.fn(),
      },
      {
        incident: "terminal-1547",
        isLocallyComplete: async () => false,
        preview: async () => ({ complete: false, stateHash: "terminal-hash" }),
        apply: terminalApply,
      },
    ]);
    expect(terminalApply).toHaveBeenCalledWith("terminal-hash");
    expect(results).toEqual([
      {
        incident: "legacy-sync-loss",
        applied: false,
        errorCode: "LEGACY_CANDIDATE_AMBIGUOUS",
      },
      {
        incident: "terminal-1547",
        applied: true,
        errorCode: null,
      },
    ]);
  });

  it("does not expose arbitrary incident-step exception text", async () => {
    const results = await runOrderedGeneralChatIncidentRepairSteps([
      {
        incident: "legacy-sync-loss",
        isLocallyComplete: async () => {
          throw new Error("database detail with private values");
        },
        preview: vi.fn(),
        apply: vi.fn(),
      },
    ]);
    expect(results).toEqual([
      {
        incident: "legacy-sync-loss",
        applied: false,
        errorCode: "UNKNOWN",
      },
    ]);
  });
});
