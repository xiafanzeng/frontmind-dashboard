import { describe, expect, it, vi } from "vitest";

import { stripFrontMindGeneralChatOperationContract } from "../shared/frontmind-general-chat-contract";
import {
  GENERAL_CHAT_INCIDENT_REPAIR_ID,
  automaticGeneralChatIncidentRepairEnabled,
  countGeneralChatIncidentArtifactReferences,
  deterministicIncidentUuid,
  generalChatIncidentAssistantProjectionMatches,
  generalChatIncidentConversationNeedsSettlement,
  generalChatIncidentStateHash,
  generalChatTurnOperationKey,
  parseGeneralChatIncidentRepairCommand,
  planGeneralChatIncidentMessageSequence,
  planGeneralChatIncidentTextBinding,
  persistedIdForManagedUser,
  publicIdFromPersistedId,
  readGeneralChatIncidentProviderMessages,
  recoveredImageAttachmentPublicId,
  recoveredImageConversationPublicId,
  recoveredImageMessagePublicId,
  recoveredTextConversationPublicId,
  recoveredTextMessagePublicId,
  runStateBoundGeneralChatIncidentRepair,
  sha256,
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

  it("rejects damaged local assistant projections and duplicate artifact references", () => {
    const input = {
      actual: {
        content: "已完成",
        sentAt: new Date("2026-08-28T07:47:12.000Z"),
        deleted: false,
        conversationId: "conversation-recovered",
        turnId: "turn-recovered",
        userId: 42,
        role: "assistant",
        upstreamOutputId: "cached-event-row",
        generalChat: {
          schemaVersion: 1,
          kind: "assistant_projection",
          turnId: "turn-recovered",
          agentTaskId: "task-recovered",
          providerEventId: "provider-event",
          serverOwned: true,
        },
      },
      expected: {
        content: "已完成",
        sentAt: new Date("2026-08-28T07:47:12.000Z"),
        conversationId: "conversation-recovered",
        turnId: "turn-recovered",
        userId: 42,
        upstreamOutputId: "cached-event-row",
        taskId: "task-recovered",
        providerEventId: "provider-event",
      },
    };
    expect(generalChatIncidentAssistantProjectionMatches(input)).toBe(true);
    expect(
      generalChatIncidentAssistantProjectionMatches({
        ...input,
        actual: { ...input.actual, content: "损坏内容" },
      }),
    ).toBe(false);
    expect(
      generalChatIncidentAssistantProjectionMatches({
        ...input,
        actual: {
          ...input.actual,
          sentAt: new Date("2026-08-28T07:47:14.000Z"),
        },
      }),
    ).toBe(false);
    const artifactUrl = "/api/frontmind/v2/artifacts/artifact-1/content";
    expect(
      countGeneralChatIncidentArtifactReferences(
        [{ inlineImages: [{ src: artifactUrl }] }],
        artifactUrl,
      ),
    ).toBe(1);
    expect(
      countGeneralChatIncidentArtifactReferences(
        [
          {
            inlineImages: [{ src: artifactUrl }],
            outputFiles: [{ fileUrl: artifactUrl }],
          },
        ],
        artifactUrl,
      ),
    ).toBe(2);
  });

  it("does not advance conversation version on an identical sync retry", () => {
    const expected = {
      apiCredentialId: "credential-1",
      upstreamTaskId: "task-1",
      previousResponseId: "task-1",
      status: "completed",
      lastKnownOutputLength: 2,
      completedAt: new Date("2026-08-28T02:20:30.000Z"),
      updatedAt: new Date("2026-08-28T02:20:30.000Z"),
    };
    expect(
      generalChatIncidentConversationNeedsSettlement({
        actual: {
          ...expected,
          updatedAt: new Date("2026-08-28T02:20:30.900Z"),
        },
        expected,
      }),
    ).toBe(false);
    expect(
      generalChatIncidentConversationNeedsSettlement({
        actual: { ...expected, upstreamTaskId: "stale-task" },
        expected,
      }),
    ).toBe(true);
  });

  it("binds a missing text message only through one operation request-hash conversation", () => {
    const input = {
      userId: 42,
      apiCredentialId: "credential-1",
      operationId: "operation-1020",
      localTaskId: "task-1020",
      idempotencyKeyHash: sha256("42\0original-message"),
      publicProfile: "frontmind-pro",
      prompt: "你好",
    };
    const conversation = {
      id: "u42:conversation-a",
      publicId: "conversation-a",
      userId: 42,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      deleted: false,
    };
    const operationRequestHash = sha256(
      JSON.stringify({
        conversationId: conversation.publicId,
        prompt: input.prompt,
        localAssetIds: [],
        modelProfile: input.publicProfile,
      }),
    );
    const missing = planGeneralChatIncidentTextBinding({
      ...input,
      operationRequestHash,
      conversations: [],
      messages: [],
    });
    expect(missing).toMatchObject({
      kind: "selected",
      conversationPublicId: recoveredTextConversationPublicId({
        operationId: input.operationId,
        localTaskId: input.localTaskId,
      }),
      messageId: null,
      source: "recovered",
      conversationEvidence: "missing",
    });
    expect(
      planGeneralChatIncidentTextBinding({
        ...input,
        operationRequestHash,
        conversations: [conversation, { ...conversation, id: "duplicate" }],
        messages: [],
      }),
    ).toMatchObject({
      kind: "conversation_ambiguous",
      conversationCandidateCount: 2,
    });
    expect(
      planGeneralChatIncidentTextBinding({
        ...input,
        operationRequestHash,
        conversations: [conversation],
        messages: [],
      }),
    ).toEqual({
      kind: "selected",
      conversationId: `u42:${recoveredTextConversationPublicId({
        operationId: input.operationId,
        localTaskId: input.localTaskId,
      })}`,
      conversationPublicId: recoveredTextConversationPublicId({
        operationId: input.operationId,
        localTaskId: input.localTaskId,
      }),
      messageId: null,
      messagePublicId: recoveredTextMessagePublicId({
        operationId: input.operationId,
        localTaskId: input.localTaskId,
      }),
      source: "recovered",
      conversationEvidence: "matched",
    });
  });

  it("accepts an idempotently recovered text message after reorder and contract stripping", () => {
    const prompt = "你好";
    const operationId = "operation-1027";
    const localTaskId = "task-1027";
    const publicProfile = "frontmind-pro";
    const conversation = {
      id: "u42:conversation-a",
      publicId: "conversation-a",
      userId: 42,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      deleted: false,
    };
    const operationRequestHash = sha256(
      JSON.stringify({
        conversationId: conversation.publicId,
        prompt,
        localAssetIds: [],
        modelProfile: publicProfile,
      }),
    );
    const messagePublicId = recoveredTextMessagePublicId({
      operationId,
      localTaskId,
    });
    const recoveredConversationId = `u42:${recoveredTextConversationPublicId({
      operationId,
      localTaskId,
    })}`;
    const legacyWirePrompt = `${prompt}\n\n# FrontMind operation contract\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"chat-create:12345678","contract":"dashboard.general-chat","revision":2}`;
    const messages = [
      {
        id: "unrelated",
        publicId: "unrelated",
        conversationId: recoveredConversationId,
        userId: 42,
        role: "user",
        normalizedContent: "另一条消息",
        deleted: false,
        attachmentCount: 0,
        metadata: null,
      },
      {
        id: `u42:${messagePublicId}`,
        publicId: messagePublicId,
        conversationId: recoveredConversationId,
        userId: 42,
        role: "user",
        normalizedContent:
          stripFrontMindGeneralChatOperationContract(legacyWirePrompt),
        deleted: false,
        attachmentCount: 0,
        metadata: {
          incidentRecovery: GENERAL_CHAT_INCIDENT_REPAIR_ID,
          incidentRecoveryOperationIdSha256: sha256(operationId),
          incidentRecoveryTaskIdSha256: sha256(localTaskId),
          incidentRecoveryRequestHash: operationRequestHash,
          incidentRecoveryIdempotencyKeyHash: sha256(
            "42\0missing-original-message",
          ),
          incidentRecoveryPromptSha256: sha256(prompt),
        },
      },
    ];
    const plan = (candidateMessages: typeof messages) =>
      planGeneralChatIncidentTextBinding({
        userId: 42,
        apiCredentialId: "credential-1",
        operationId,
        localTaskId,
        operationRequestHash,
        idempotencyKeyHash: sha256("42\0missing-original-message"),
        publicProfile,
        prompt,
        conversations: [conversation],
        messages: candidateMessages,
      });
    expect(plan(messages)).toEqual(plan([...messages].reverse()));
    expect(plan(messages)).toMatchObject({
      kind: "selected",
      messageId: `u42:${messagePublicId}`,
      messagePublicId,
      source: "recovered",
    });
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
