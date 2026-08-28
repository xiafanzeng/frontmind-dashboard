import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { generalChatTerminalMessagePublicId } from "../shared/frontmind-general-chat-terminal";
import type { ManusV2MessageEvent } from "./manus-v2-client";
import {
  GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
  classifyGeneralChatTerminal1547Outcome,
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
      event("old-error", "error_message", { error_message: { error_type: "old" } }, 1),
      event("old-status", "status_update", { status_update: { agent_status: "error" } }, 2),
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
      event("current-output", "assistant_message", { assistant_message: { content: "done" } }, 4),
      event("current-stopped", "status_update", { status_update: { agent_status: "stopped" } }, 5),
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
      { incident: "legacy", applied: true },
      { incident: "terminal-1547", applied: true },
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
      { incident: "legacy", applied: false },
      { incident: "terminal-1547", applied: true },
    ]);
  });
});
