import { describe, expect, it, vi } from "vitest";

import {
  GENERAL_CHAT_INCIDENT_REPAIR_ID,
  automaticGeneralChatIncidentRepairEnabled,
  deterministicIncidentUuid,
  generalChatIncidentStateHash,
  generalChatTurnOperationKey,
  parseGeneralChatIncidentRepairCommand,
  planGeneralChatIncidentMessageSequence,
  persistedIdForManagedUser,
  publicIdFromPersistedId,
  readGeneralChatIncidentProviderMessages,
  recoveredImageAttachmentPublicId,
  recoveredImageConversationPublicId,
  recoveredImageMessagePublicId,
  runStateBoundGeneralChatIncidentRepair,
} from "./general-chat-incident-repair-20260828-core";

describe("general-chat incident repair 2026-08-28 core", () => {
  it("accepts only preview or state-bound apply commands", () => {
    expect(parseGeneralChatIncidentRepairCommand(["--mode=preview"])).toEqual({
      mode: "preview",
    });
    const expectedStateHash = "a".repeat(64);
    expect(
      parseGeneralChatIncidentRepairCommand([
        "--mode=apply",
        `--expected-state-hash=${expectedStateHash}`,
      ]),
    ).toEqual({ mode: "apply", expectedStateHash });
    expect(() =>
      parseGeneralChatIncidentRepairCommand(["--mode=apply"]),
    ).toThrow("ARGUMENT_INVALID");
    expect(() =>
      parseGeneralChatIncidentRepairCommand([
        "--mode=preview",
        "--expected-state-hash=" + expectedStateHash,
      ]),
    ).toThrow("ARGUMENT_INVALID");
    expect(() =>
      parseGeneralChatIncidentRepairCommand(["--mode=preview", "--user-id=1"]),
    ).toThrow("ARGUMENT_UNKNOWN");
  });

  it("hashes canonical state independently of object insertion order", () => {
    expect(
      generalChatIncidentStateHash({ b: 2, nested: { z: 1, a: 2 }, a: 1 }),
    ).toBe(
      generalChatIncidentStateHash({ a: 1, nested: { a: 2, z: 1 }, b: 2 }),
    );
    expect(generalChatIncidentStateHash({ a: 1 })).not.toBe(
      generalChatIncidentStateHash({ a: 2 }),
    );
  });

  it("derives stable scoped identities without accepting another user scope", () => {
    const taskId = "11111111-2222-4333-8444-555555555555";
    expect(recoveredImageConversationPublicId(taskId)).toBe(
      recoveredImageConversationPublicId(taskId),
    );
    expect(recoveredImageMessagePublicId(taskId)).not.toBe(
      recoveredImageAttachmentPublicId(taskId),
    );
    const persisted = persistedIdForManagedUser({
      userId: 42,
      publicId: recoveredImageMessagePublicId(taskId),
    });
    expect(
      publicIdFromPersistedId({ userId: 42, persistedId: persisted }),
    ).toBe(recoveredImageMessagePublicId(taskId));
    expect(() =>
      publicIdFromPersistedId({ userId: 7, persistedId: persisted }),
    ).toThrow("SCOPE_MISMATCH");
  });

  it("uses deterministic RFC-shaped turn ids and account/conversation request keys", () => {
    const turnId = deterministicIncidentUuid("turn:operation-1");
    expect(turnId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(turnId).toBe(deterministicIncidentUuid("turn:operation-1"));
    expect(turnId).not.toBe(deterministicIncidentUuid("turn:operation-2"));
    const key = generalChatTurnOperationKey({
      userId: 42,
      conversationPublicId: "conversation-a",
      clientRequestId: "message-a",
    });
    expect(key).toMatch(/^chat-turn:[a-f0-9]{64}$/u);
    expect(key).not.toBe(
      generalChatTurnOperationKey({
        userId: 43,
        conversationPublicId: "conversation-a",
        clientRequestId: "message-a",
      }),
    );
    expect(GENERAL_CHAT_INCIDENT_REPAIR_ID).toBe(
      "frontmind.general-chat.sync-loss.2026-08-28",
    );
  });

  it("enables the automatic apply only for the exact canonical production URL", () => {
    expect(
      automaticGeneralChatIncidentRepairEnabled({
        nodeEnv: "production",
        compiledReleaseChannel: "production",
        publicUrl: "https://dashboard.frontmind.net",
      }),
    ).toBe(true);
    for (const candidate of [
      { nodeEnv: "development", publicUrl: "https://dashboard.frontmind.net" },
      {
        nodeEnv: "production",
        publicUrl: `https://${["dashboard", "dev"].join("-")}.frontmind.net`,
      },
      {
        nodeEnv: "production",
        publicUrl: "https://dashboard.frontmind.net.evil",
      },
      {
        nodeEnv: "production",
        publicUrl: "https://dashboard.frontmind.net/",
      },
    ]) {
      expect(
        automaticGeneralChatIncidentRepairEnabled({
          ...candidate,
          compiledReleaseChannel: "production",
        }),
      ).toBe(false);
    }
  });

  it("plans provider-ranked assistant projections before the later user turn", () => {
    expect(
      planGeneralChatIncidentMessageSequence([
        {
          id: "later-user",
          currentSequence: 1,
          effectiveTimeMs: 300,
          wireRank: 4,
        },
        {
          id: "first-user",
          currentSequence: 0,
          effectiveTimeMs: 100,
          wireRank: 0,
        },
        {
          id: "assistant-two",
          currentSequence: 3,
          effectiveTimeMs: 200,
          wireRank: 3,
        },
        {
          id: "assistant-one",
          currentSequence: 2,
          effectiveTimeMs: 200,
          wireRank: 1,
        },
      ]),
    ).toEqual(["first-user", "assistant-one", "assistant-two", "later-user"]);
  });

  it("uses the Provider read capability without touching create or send", async () => {
    const listAllMessages = vi.fn().mockResolvedValue([{ id: "event-1" }]);
    const createTask = vi.fn();
    const sendMessage = vi.fn();
    const result = await readGeneralChatIncidentProviderMessages(
      { listAllMessages, createTask, sendMessage } as never,
      { taskId: "provider-task", order: "asc" },
    );
    expect(result).toEqual([{ id: "event-1" }]);
    expect(listAllMessages).toHaveBeenCalledOnce();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("applies once, becomes a no-op on rerun, and rejects state drift", async () => {
    let state = { stateHash: "before", complete: false };
    const apply = vi.fn(async () => {
      state = { stateHash: "after", complete: true };
    });
    const operations = { inspect: vi.fn(async () => state), apply };
    const preview = await runStateBoundGeneralChatIncidentRepair(
      { mode: "preview" },
      operations,
    );
    expect(preview.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    const first = await runStateBoundGeneralChatIncidentRepair(
      { mode: "apply", expectedStateHash: "before" },
      operations,
    );
    expect(first.applied).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    const rerun = await runStateBoundGeneralChatIncidentRepair(
      { mode: "apply", expectedStateHash: "after" },
      operations,
    );
    expect(rerun.applied).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    await expect(
      runStateBoundGeneralChatIncidentRepair(
        { mode: "apply", expectedStateHash: "stale" },
        operations,
      ),
    ).rejects.toThrow("STATE_CHANGED");
  });
});
