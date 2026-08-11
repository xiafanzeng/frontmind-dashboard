import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseConversationTombstones,
  messages,
  upstreamResources,
  userUsageOwners,
  type ConversationTurn,
} from "../drizzle/schema";
import {
  KnowledgeBaseTurnReservationError,
  cancelUnpreparedKnowledgeBaseTurn,
  completeKnowledgeBaseGeneratedAttachment,
  createKnowledgeBaseGeneratedAttachmentIdempotencyKey,
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  evaluateKnowledgeBaseTurnReplay,
  failKnowledgeBaseTurnDeterministically,
  findReusableKnowledgeBaseSkillFileId,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseTurnForRecovery,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  inspectKnowledgeBaseDeferredAttachmentReplay,
  inspectKnowledgeBaseDeferredDispatchReplay,
  inspectKnowledgeBaseLegacyAttachmentTakeoverReplay,
  inspectKnowledgeBaseLegacyDeferredReservationReplay,
  inspectKnowledgeBaseTurnReplay,
  inspectKnowledgeBaseRetryAuthority,
  knowledgeBaseRetryRequiresFreshFinalDelivery,
  prepareKnowledgeBaseTurnDispatch,
  rejectAcknowledgedKnowledgeBaseManualLogoTurn,
  rejectUnacknowledgedKnowledgeBaseManualLogoTurn,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseRetryTurn,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  replaceKnowledgeBaseTurnAttachmentsAfterUserFix,
  resumeKnowledgeBaseTurnAfterUserFix,
  stageAndClaimKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseDeferredTurnAttachment,
  sanitizeKnowledgeBaseRecoveryMetadata,
} from "./knowledge-base-turn-service";
import {
  KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
} from "./knowledge-base-tree-policy-rollout";

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "u1:conversation-1",
    userId: 1,
    apiCredentialId: "credential-1",
    clientRequestId: "request-1",
    buildId: "00000000-0000-4000-8000-000000000002",
    buildGeneration: 3,
    operationKey: "operation-1",
    operationType: "confirm",
    expectedRevision: 7,
    expectedLeafId: "1.8",
    requestHash: "a".repeat(64),
    upstreamIdempotencyKeyHash: "b".repeat(64),
    attachmentFileIds: [],
    metadata: { attachmentsFrozen: true },
    leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z"),
    model: null,
    status: "queued",
    upstreamTaskId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const identity = {
  buildId: "00000000-0000-4000-8000-000000000002",
  buildGeneration: 3,
  operationKey: "operation-1",
  operationType: "confirm" as const,
  expectedRevision: 7,
  expectedLeafId: "1.8",
  requestHash: "a".repeat(64),
  apiCredentialId: "credential-1",
};

type TurnSelection =
  | ConversationTurn[]
  | ((store: TurnServiceStore) => ConversationTurn[]);

interface TurnServiceStore {
  build: any | null;
  conversation: any | null;
  turns: ConversationTurn[];
  messages: any[];
  credentials: any[];
  tombstones: any[];
  retainedTombstones: any[];
  resources: any[];
  usageOwnerId: number | null;
}

function createTurnServiceExecutor(input: {
  build?: any;
  conversation?: any;
  turns?: ConversationTurn[];
  credentials?: any[];
  tombstones?: any[];
  retainedTombstones?: any[];
  resources?: any[];
  usageOwnerId?: number | null;
  turnSelections: TurnSelection[][];
  failConversationInsertAtTransaction?: number;
}) {
  const store: TurnServiceStore = {
    build: input.build || null,
    conversation: input.conversation || null,
    turns: [...(input.turns || [])],
    messages: [],
    credentials: [
      ...(input.credentials || [
        {
          id: "credential-1",
          userId: 1,
          status: "active",
        },
      ]),
    ],
    tombstones: [...(input.tombstones || [])],
    retainedTombstones: [...(input.retainedTombstones || [])],
    resources: [...(input.resources || [])],
    usageOwnerId: input.usageOwnerId ?? null,
  };
  const events: string[] = [];
  let transactionIndex = 0;
  const executor = {
    transaction: async (run: (tx: any) => Promise<unknown>) => {
      const currentTransaction = transactionIndex++;
      const snapshot = structuredClone(store);
      let turnSelectionIndex = 0;
      let lastSelectedTurn: ConversationTurn | undefined;
      let messageSelectionIndex = 0;
      const turnSelections = input.turnSelections[currentTransaction] || [];
      const selected = (
        table: unknown,
        condition?: unknown,
        options: { peekTurn?: boolean } = {},
      ) => {
        if (table === knowledgeBaseBuilds) {
          return store.build ? [store.build] : [];
        }
        if (table === conversations) {
          return store.conversation ? [store.conversation] : [];
        }
        if (table === apiCredentials) {
          return store.credentials;
        }
        if (table === conversationTurns) {
          const selection =
            turnSelections[
              options.peekTurn ? turnSelectionIndex : turnSelectionIndex++
            ] || [];
          const rows =
            typeof selection === "function" ? selection(store) : selection;
          if (!options.peekTurn) lastSelectedTurn = rows[0];
          return rows;
        }
        if (table === knowledgeBaseConversationTombstones) {
          return store.tombstones;
        }
        if (table === knowledgeBaseConversationRetentionTombstones) {
          return store.retainedTombstones;
        }
        if (table === messages) {
          const isIdentityLookup = messageSelectionIndex++ % 2 === 0;
          if (!isIdentityLookup) return store.messages;
          const latestTurn = store.turns.at(-1);
          const expectedId = latestTurn
            ? `u${latestTurn.userId}:msg-kb-user-${latestTurn.id}`
            : "";
          return store.messages.filter((message) => message.id === expectedId);
        }
        if (table === upstreamResources) {
          return store.resources;
        }
        if (table === userUsageOwners) {
          return store.usageOwnerId == null
            ? []
            : [{ deliveryAdminId: store.usageOwnerId }];
        }
        return [];
      };
      const selectionBuilder = (
        table: unknown,
        condition?: unknown,
        options: { peekTurn?: boolean } = {},
      ) => ({
        limit: () => ({
          for: async () => {
            if (table === upstreamResources) {
              events.push("start-attachments:lock");
            }
            return selected(table, condition, options);
          },
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(selected(table, condition, options)).then(
              resolve,
              reject,
            ),
        }),
        orderBy: () => ({
          limit: async () =>
            [...selected(table)].sort(
              (left: any, right: any) => right.sequence - left.sequence,
            ),
        }),
      });
      const tx = {
        select: (projection?: unknown) => ({
          from: (table: unknown) => ({
            where: (condition: unknown) =>
              selectionBuilder(table, condition, {
                peekTurn:
                  table === conversationTurns && projection !== undefined,
              }),
          }),
        }),
        insert: (table: unknown) => ({
          values: (values: any) => {
            if (table === knowledgeBaseBuilds && !store.build) {
              store.build = {
                upstreamTaskId: null,
                activeTurnId: null,
                protocolErrorCode: null,
                protocolError: null,
                currentLeafId: null,
                ...values,
              };
            } else if (table === conversations && !store.conversation) {
              if (
                input.failConversationInsertAtTransaction === currentTransaction
              ) {
                throw new Error("simulated conversation insert failure");
              }
              store.conversation = {
                deletedAt: null,
                ...values,
              };
            } else if (table === conversationTurns) {
              store.turns.push(values as ConversationTurn);
              events.push("turn:insert");
            } else if (table === messages) {
              store.messages.push(values);
            } else if (table === upstreamResources) {
              store.resources.push(values);
            }
            return {
              onDuplicateKeyUpdate: async () => undefined,
            };
          },
        }),
        update: (table: unknown) => ({
          set: (values: any) => ({
            where: async () => {
              if (table === knowledgeBaseBuilds && store.build) {
                store.build = { ...store.build, ...values };
              } else if (table === conversations && store.conversation) {
                store.conversation = { ...store.conversation, ...values };
              } else if (table === conversationTurns && lastSelectedTurn) {
                const index = store.turns.findIndex(
                  (candidate) => candidate.id === lastSelectedTurn!.id,
                );
                if (index >= 0) {
                  store.turns[index] = {
                    ...store.turns[index],
                    ...values,
                  } as ConversationTurn;
                  lastSelectedTurn = store.turns[index];
                }
              } else if (table === upstreamResources) {
                store.resources = store.resources.map((resource) => ({
                  ...resource,
                  ...values,
                }));
                events.push("start-attachments:bind");
              }
            },
          }),
        }),
      };
      try {
        const result = await run(tx);
        events.push("transaction:commit");
        return result;
      } catch (error) {
        store.build = snapshot.build;
        store.conversation = snapshot.conversation;
        store.turns = snapshot.turns;
        store.messages = snapshot.messages;
        store.credentials = snapshot.credentials;
        store.tombstones = snapshot.tombstones;
        store.retainedTombstones = snapshot.retainedTombstones;
        store.resources = snapshot.resources;
        store.usageOwnerId = snapshot.usageOwnerId;
        throw error;
      }
    },
  };
  return { executor, store, events };
}

function retryableFailedTurn(overrides: Partial<ConversationTurn> = {}) {
  const operationKey = createKnowledgeBaseOperationKey({
    buildId: "00000000-0000-4000-8000-000000000002",
    buildGeneration: 3,
    operationType: "confirm",
    expectedRevision: 7,
    expectedLeafId: "1.8",
  });
  const recovery = {
    kind: "turn",
    conversationId: "conversation-1",
    parentTaskId: "successful-parent-task",
    userMessage: "确认",
    attachments: [{ file_id: "facts-file", filename: "facts.pdf" }],
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
  };
  const requestBody = {
    prompt: "failed prompt",
    agentProfile: "manus-1.6-max",
    taskMode: "agent" as const,
    taskId: "successful-parent-task",
    attachments: [
      { file_id: "skill-file", filename: "skill.zip" },
      { file_id: "facts-file", filename: "facts.pdf" },
    ],
  };
  const failed = turn({
    status: "failed",
    operationKey,
    requestHash: hashKnowledgeBaseTurnRequest({
      operationType: "confirm",
      generation: 3,
      revision: 7,
      leafId: "1.8",
      expectedAttachmentCount: 2,
      userAttachmentCount: 1,
      payload: {
        userMessage: recovery.userMessage,
        attachments: recovery.attachments,
        skillVersion: recovery.skillVersion,
        skillContentHash: recovery.skillContentHash,
      },
    }),
    upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    ),
    upstreamTaskId: "failed-task-must-not-be-reused",
    completedAt: new Date("2026-08-01T00:00:20.000Z"),
    leaseExpiresAt: null,
    attachmentFileIds: ["skill-file", "facts-file"],
    metadata: {
      attachmentsFrozen: true,
      expectedAttachmentCount: 2,
      userAttachmentCount: 1,
      recovery,
      preparedDispatch: {
        schemaVersion: 1,
        baseUrl: "https://api.example.test",
        requestBody,
        bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
        preparedAt: "2026-08-01T00:00:10.000Z",
      },
    },
    ...overrides,
  });
  return failed;
}

describe("knowledge-base turn identity", () => {
  it("canonicalizes object keys but preserves attachment order", () => {
    expect(hashKnowledgeBaseTurnRequest({ b: 2, a: 1 })).toBe(
      hashKnowledgeBaseTurnRequest({ a: 1, b: 2 }),
    );
    expect(hashKnowledgeBaseTurnRequest({ ids: ["a", "b"] })).not.toBe(
      hashKnowledgeBaseTurnRequest({ ids: ["b", "a"] }),
    );
  });

  it("rejects circular and non-JSON request bodies", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => hashKnowledgeBaseTurnRequest(value)).toThrow(
      KnowledgeBaseTurnReservationError,
    );
    expect(() => hashKnowledgeBaseTurnRequest({ n: Number.NaN })).toThrow(
      KnowledgeBaseTurnReservationError,
    );
  });

  it("maps racing actions in one generation/revision/leaf to one slot", () => {
    const base = {
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    expect(
      createKnowledgeBaseOperationKey({ ...base, operationType: "confirm" }),
    ).toBe(
      createKnowledgeBaseOperationKey({ ...base, operationType: "revise" }),
    );
    expect(
      createKnowledgeBaseOperationKey({ ...base, operationType: "start" }),
    ).not.toBe(
      createKnowledgeBaseOperationKey({ ...base, operationType: "confirm" }),
    );
    expect(
      createKnowledgeBaseOperationKey({
        ...base,
        operationType: "retry",
        retryOfTurnId: "00000000-0000-4000-8000-000000000010",
      }),
    ).not.toBe(
      createKnowledgeBaseOperationKey({ ...base, operationType: "confirm" }),
    );
    expect(
      createKnowledgeBaseOperationKey({
        ...base,
        operationType: "retry",
        retryOfTurnId: "00000000-0000-4000-8000-000000000010",
      }),
    ).not.toBe(
      createKnowledgeBaseOperationKey({
        ...base,
        operationType: "retry",
        retryOfTurnId: "00000000-0000-4000-8000-000000000011",
      }),
    );
  });

  it("derives one stable upstream key without embedding customer content", () => {
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      operationType: "confirm",
      expectedRevision: 7,
      expectedLeafId: "1.8",
    });
    expect(createKnowledgeBaseUpstreamIdempotencyKey(operationKey)).toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    );
    expect(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    ).not.toContain("FrontMind 超前智能");
  });

  it("allocates a distinct provider operation for each manual Logo request", () => {
    const base = {
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      operationType: "revise" as const,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    const first = createKnowledgeBaseOperationKey({
      ...base,
      operationInstanceId: "manual-logo-request-a",
    });
    const replay = createKnowledgeBaseOperationKey({
      ...base,
      operationInstanceId: "manual-logo-request-a",
    });
    const replacement = createKnowledgeBaseOperationKey({
      ...base,
      operationInstanceId: "manual-logo-request-b",
    });

    expect(replay).toBe(first);
    expect(replacement).not.toBe(first);
    expect(createKnowledgeBaseUpstreamIdempotencyKey(replacement)).not.toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(first),
    );
  });
});

describe("knowledge-base turn replay decisions", () => {
  const now = new Date("2026-08-01T00:00:30.000Z");

  it("returns pending for an identical in-flight retry", () => {
    expect(evaluateKnowledgeBaseTurnReplay(turn(), identity, now)).toEqual({
      state: "pending",
      retryAfterMs: 5_000,
    });
  });

  it("makes a changed body or action lose the first-writer race", () => {
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn(),
        { ...identity, requestHash: "c".repeat(64) },
        now,
      ),
    ).toEqual({ state: "conflict" });
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn(),
        { ...identity, operationType: "revise" },
        now,
      ),
    ).toEqual({ state: "conflict" });
  });

  it("never reacquires a row that is already bound or completed", () => {
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn({ status: "running", upstreamTaskId: "task-original" }),
        identity,
        now,
      ),
    ).toEqual({ state: "bound", upstreamTaskId: "task-original" });
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn({
          status: "completed",
          upstreamTaskId: "task-original",
          leaseExpiresAt: new Date("2026-07-31T00:00:00.000Z"),
        }),
        identity,
        now,
      ),
    ).toEqual({ state: "completed" });
  });

  it("allows recovery only after an unbound lease expires", () => {
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn({ leaseExpiresAt: new Date("2026-07-31T00:00:00.000Z") }),
        identity,
        now,
      ),
    ).toEqual({ state: "expired" });
  });
});

describe("knowledge-base HTTP replay receipts", () => {
  const intent = {
    schemaVersion: 1,
    flow: "direct",
    userMessage: "确认",
    expectedGeneration: 3,
    expectedRevision: 7,
    expectedLeafId: "1.8",
    expectedPresentationKey: "presentation-7",
  };

  function replayExecutor(selections: ConversationTurn[][]) {
    let selection = 0;
    return {
      transaction: async (run: (tx: any) => Promise<unknown>) =>
        run({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => selections[selection++] || [],
                orderBy: () => ({
                  limit: async () => selections[selection++] || [],
                }),
              }),
            }),
          }),
        }),
    };
  }

  function replayTurn(overrides: Partial<ConversationTurn> = {}) {
    return turn({
      metadata: {
        clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
        expectedPresentationKey: "presentation-7",
      },
      ...overrides,
    });
  }

  it("returns the original passive receipt before mutable build checks", async () => {
    await expect(
      inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: intent,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        replayExecutor([[replayTurn()]]),
      ),
    ).resolves.toMatchObject({ state: "pending", turn: { id: turn().id } });
  });

  it("rejects different content under the same request id with a stable code", async () => {
    await expect(
      inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: { ...intent, userMessage: "修改公司名称" },
        },
        replayExecutor([[replayTurn()]]),
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
    });
  });

  it("adopts the operation winner after a tab remounts with a new request id", async () => {
    const receipt = await inspectKnowledgeBaseTurnReplay(
      {
        userId: 1,
        conversationId: "conversation-1",
        clientRequestId: "request-from-remounted-tab",
        clientIntent: intent,
        expectedGeneration: 3,
        expectedRevision: 7,
        expectedLeafId: "1.8",
      },
      replayExecutor([[], [replayTurn()]]),
    );
    expect(receipt).toMatchObject({
      state: "pending",
      turn: { clientRequestId: "request-1" },
    });
  });

  it.each([
    "unpreparedCancellation",
    "acknowledgedManualLogoCancellation",
    "unacknowledgedManualLogoCancellation",
  ] as const)(
    "never lets coordinate fallback adopt a %s tombstone",
    async (tombstoneFlag) => {
      const receipt = await inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "replacement-request",
          clientIntent: intent,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
        },
        replayExecutor([
          [],
          [
            replayTurn({
              status: "cancelled",
              metadata: {
                clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
                [tombstoneFlag]: true,
              },
            }),
          ],
        ]),
      );
      expect(receipt).toBeNull();
    },
  );

  it("replays an already staged file without consulting current Logo state", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const staged = replayTurn({
      metadata: {
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredAttachmentReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: staged.id,
          clientRequestId: staged.clientRequestId,
          clientAttachmentManifest: manifest,
          index: 0,
          attachment: { file_id: "file-logo", filename: "logo.png" },
        },
        replayExecutor([[staged]]),
      ),
    ).resolves.toMatchObject({ state: "pending", turn: { id: staged.id } });
  });

  it("replays a claimed deferred dispatch before consulting the active build", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const claimed = replayTurn({
      metadata: {
        awaitingClientAttachments: false,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredDispatchReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: claimed.id,
          clientRequestId: claimed.clientRequestId,
          clientAttachmentManifest: manifest,
        },
        replayExecutor([[claimed]]),
      ),
    ).resolves.toMatchObject({ state: "pending", turn: { id: claimed.id } });
  });

  it("does not treat a still-awaiting deferred reservation as a dispatch replay", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const awaiting = replayTurn({
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredDispatchReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: awaiting.id,
          clientRequestId: awaiting.clientRequestId,
          clientAttachmentManifest: manifest,
        },
        replayExecutor([[awaiting]]),
      ),
    ).resolves.toBeNull();
  });

  it("replays a legacy deferred reservation from immutable coordinates and manifest", async () => {
    const manifest = [{ filename: "brief.txt", sha256: "b".repeat(64) }];
    const awaiting = replayTurn({
      operationType: "revise",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseLegacyDeferredReservationReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: awaiting.clientRequestId,
          clientAttachmentManifest: manifest,
          operationType: "revise",
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
        },
        replayExecutor([[awaiting]]),
      ),
    ).resolves.toMatchObject({
      state: "awaiting_attachments",
      turn: { id: awaiting.id },
    });
  });

  it("only replays a legacy upload-first request after its exact takeover ledger is durable", async () => {
    const manifest = [{ filename: "logo.png", sha256: "c".repeat(64) }];
    const attachments = [{ file_id: "file-logo", filename: "logo.png" }];
    const beforeTakeover = replayTurn({
      operationType: "revise",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        recovery: { attachmentManifest: manifest, attachments: [] },
      },
    });
    const input = {
      userId: 1,
      conversationId: "conversation-1",
      clientRequestId: beforeTakeover.clientRequestId,
      clientAttachmentManifest: manifest,
      attachments,
      operationType: "revise" as const,
      expectedGeneration: 3,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    await expect(
      inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
        input,
        replayExecutor([[beforeTakeover]]),
      ),
    ).resolves.toBeNull();

    const afterTakeover = replayTurn({
      operationType: "revise",
      metadata: {
        awaitingClientAttachments: false,
        legacyUploadFirstTakeover: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        userAttachmentCount: 1,
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          attachmentManifest: manifest,
          attachments,
        },
      },
    });
    await expect(
      inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
        input,
        replayExecutor([[afterTakeover]]),
      ),
    ).resolves.toMatchObject({
      state: "pending",
      turn: { id: afterTakeover.id },
    });
    await expect(
      inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
        { ...input, attachments: [{ ...attachments[0]!, file_id: "other" }] },
        replayExecutor([[afterTakeover]]),
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
    });
  });

  it("rejects a new reservation against a stale presentation key", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000099",
      userId: 1,
      conversationId: "conversation-stale-presentation",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      status: "confirming",
      generation: 3,
      stateEpoch: 8,
      revision: 7,
      currentLeafId: "1.8",
      currentPresentationKey: "presentation-current",
      activeTurnId: null,
      upstreamTaskId: "parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const { executor } = createTurnServiceExecutor({
      build,
      conversation: {
        id: "u1:conversation-stale-presentation",
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
      },
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        {
          userId: 1,
          buildId: build.id,
          clientRequestId: "stale-presentation-request",
          operationType: "confirm",
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          expectedPresentationKey: "presentation-stale",
          requestPayload: { userMessage: "确认" },
          clientIntent: intent,
          apiCredentialId: "credential-1",
          userText: "确认",
          expectedAttachmentCount: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "STALE_KNOWLEDGE_BASE_PRESENTATION" });
  });
});

describe("knowledge-base recovery metadata", () => {
  it("recursively removes credentials while retaining replay coordinates", () => {
    const metadata = sanitizeKnowledgeBaseRecoveryMetadata({
      prompt: "确认 1.1",
      apiKey: "must-not-persist",
      nested: {
        Authorization: "Bearer must-not-persist",
        fileName: "facts.pdf",
      },
    });
    expect(metadata).toEqual({
      prompt: "确认 1.1",
      nested: { fileName: "facts.pdf" },
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-persist");
  });

  it("persists one exact credential-free dispatch body after attachments freeze", async () => {
    let storedTurn = turn({
      attachmentFileIds: ["skill-file", "facts-file"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        leaseOwnerHash: createHash("sha256")
          .update("lease-token", "utf8")
          .digest("hex"),
      },
    });
    const build = {
      id: storedTurn.buildId,
      userId: storedTurn.userId,
      generation: storedTurn.buildGeneration,
      activeTurnId: storedTurn.id,
    };
    const lockTrace: string[] = [];
    const selected = (table: unknown, rows: unknown[]) => ({
      where: () => ({
        limit: () => ({
          for: async (mode: string) => {
            if (mode === "update") {
              lockTrace.push(
                table === knowledgeBaseBuilds
                  ? "build"
                  : table === conversationTurns
                    ? "turn"
                    : "other",
              );
            }
            return rows;
          },
          then: (
            resolve: (value: unknown[]) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        }),
      }),
    });
    const tx = {
      select: () => ({
        from: (table: unknown) =>
          selected(
            table,
            table === conversationTurns
              ? [storedTurn]
              : table === knowledgeBaseBuilds
                ? [build]
                : [],
          ),
      }),
      update: (table: unknown) => ({
        set: (values: Partial<ConversationTurn>) => ({
          where: async () => {
            if (table === conversationTurns) {
              storedTurn = { ...storedTurn, ...values };
            }
          },
        }),
      }),
    };
    const executor = {
      transaction: async (run: (value: typeof tx) => Promise<unknown>) =>
        run(tx),
    };

    const prepared = await prepareKnowledgeBaseTurnDispatch(
      {
        userId: 1,
        turnId: storedTurn.id,
        leaseToken: "lease-token",
        baseUrl: "https://api.example.test/",
        prompt: "exact prompt",
        agentProfile: "manus-1.6-max",
        attachments: [
          { file_id: "skill-file", filename: "skill.zip" },
          { file_id: "facts-file", filename: "facts.pdf" },
        ],
        parentTaskId: "parent-task",
      },
      executor,
    );

    expect(prepared).toMatchObject({
      schemaVersion: 1,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "exact prompt",
        taskMode: "agent",
        taskId: "parent-task",
        attachments: [
          { file_id: "skill-file", filename: "skill.zip" },
          { file_id: "facts-file", filename: "facts.pdf" },
        ],
      },
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(prepared)).not.toMatch(
      /API_KEY|Authorization|credential-value/,
    );
    expect((storedTurn.metadata as any).preparedDispatch).toEqual(prepared);
    expect(lockTrace).toEqual(["build", "turn"]);
  });

  it("resumes one pre-create user-fix failure on the same logical turn exactly once", async () => {
    const preparedDispatch = {
      schemaVersion: 1 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "exact prompt",
        agentProfile: "manus-1.6-max",
        taskMode: "agent" as const,
        attachments: [{ file_id: "skill-file", filename: "skill.zip" }],
      },
      bodySha256: "d".repeat(64),
      preparedAt: "2026-08-01T00:00:00.000Z",
    };
    const failed = turn({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_HTTP_402",
      errorMessage: "余额不足",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        preparedDispatch,
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          skillVersion: "4",
          skillContentHash: "a".repeat(64),
        },
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "top_up",
        canRegenerate: false,
      },
    });
    const build = {
      id: failed.buildId,
      userId: 1,
      conversationId: "conversation-1",
      generation: failed.buildGeneration,
      stateEpoch: 8,
      status: "protocol_error",
      activeTurnId: failed.id,
      protocolErrorCode: failed.errorCode,
      protocolError: failed.errorMessage,
    };
    const conversation = {
      id: failed.conversationId,
      userId: 1,
      version: 3,
      status: "failed",
      completedAt: failed.completedAt,
    };
    const currentFailed = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === failed.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [failed],
      credentials: [{ id: "credential-repaired", userId: 1, status: "active" }],
      turnSelections: [[currentFailed], [currentFailed]],
    });

    const first = await resumeKnowledgeBaseTurnAfterUserFix(
      {
        userId: 1,
        turnId: failed.id,
        apiCredentialId: "credential-repaired",
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );
    const replay = await resumeKnowledgeBaseTurnAfterUserFix(
      {
        userId: 1,
        turnId: failed.id,
        apiCredentialId: "credential-repaired",
        now: new Date("2026-08-01T00:01:01.000Z"),
      },
      executor,
    );

    expect(first).toMatchObject({
      turn: {
        id: failed.id,
        operationKey: failed.operationKey,
        status: "running",
        upstreamTaskId: null,
        apiCredentialId: "credential-repaired",
        dispatchState: "recovering",
        canRegenerate: false,
      },
      preparedDispatch,
    });
    expect(first?.upstreamIdempotencyKey).toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(failed.operationKey!),
    );
    expect(replay).toBeNull();
    expect(store.turns).toHaveLength(1);
    expect(store.build).toMatchObject({
      status: "confirming",
      activeTurnId: failed.id,
      protocolErrorCode: null,
      protocolError: null,
    });
    expect(store.conversation).toMatchObject({
      status: "running",
      version: 4,
      apiCredentialId: "credential-repaired",
    });
  });

  it("replaces a 413 attachment set on the same turn and grants only one new create claim", async () => {
    const failed = turn({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_HTTP_413",
      errorMessage: "附件过大",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: ["old-skill", "old-instructions", "old-large-file"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 3,
        userAttachmentCount: 1,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody: {
            prompt: "old prompt",
            agentProfile: "manus-1.6-max",
            taskMode: "agent",
            attachments: [
              { file_id: "old-skill", filename: "skill.zip" },
              { file_id: "old-instructions", filename: "instructions.md" },
              { file_id: "old-large-file", filename: "large.pdf" },
            ],
          },
          bodySha256: "d".repeat(64),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
        generatedAttachmentReservations: {
          "skill:0": { status: "completed" },
          "instructions:1": { status: "completed" },
        } as any,
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          parentTaskId: "parent-task",
          userMessage: "请结合附件修订",
          attachments: [{ file_id: "old-large-file", filename: "large.pdf" }],
          skillVersion: "4",
          skillContentHash: "a".repeat(64),
        },
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "fix_attachments",
        canRegenerate: false,
      },
    });
    const build = {
      id: failed.buildId,
      userId: 1,
      conversationId: "conversation-1",
      generation: failed.buildGeneration,
      stateEpoch: 8,
      status: "protocol_error",
      activeTurnId: failed.id,
      protocolErrorCode: failed.errorCode,
      protocolError: failed.errorMessage,
    };
    const conversation = {
      id: failed.conversationId,
      userId: 1,
      version: 3,
      status: "failed",
      completedAt: failed.completedAt,
    };
    const current = (state: TurnServiceStore) =>
      state.turns.filter((candidate) => candidate.id === failed.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [failed],
      credentials: [{ id: "credential-repaired", userId: 1, status: "active" }],
      turnSelections: [[current], [current]],
    });
    const repair = {
      userId: 1,
      turnId: failed.id,
      apiCredentialId: "credential-repaired",
      clientRequestId: "attachment-repair-1",
      attachments: [{ file_id: "smaller-file", filename: "smaller.pdf" }],
      attachmentManifest: [
        {
          filename: "smaller.pdf",
          sizeBytes: 100,
          mimeType: "application/pdf",
          lastModified: 1,
          sha256: "f".repeat(64),
        },
      ],
      now: new Date("2026-08-01T00:01:00.000Z"),
    };

    const first = await replaceKnowledgeBaseTurnAttachmentsAfterUserFix(
      repair,
      executor,
    );
    const replay = await replaceKnowledgeBaseTurnAttachmentsAfterUserFix(
      { ...repair, now: new Date("2026-08-01T00:01:01.000Z") },
      executor,
    );

    expect(first).toMatchObject({
      turn: {
        id: failed.id,
        operationKey: failed.operationKey,
        status: "running",
        upstreamTaskId: null,
        attachmentFileIds: [],
        dispatchState: "recovering",
        canRegenerate: false,
      },
      preparedDispatch: null,
      recoveryMetadata: {
        attachments: [{ file_id: "smaller-file", filename: "smaller.pdf" }],
      },
    });
    expect(replay).toBeNull();
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]?.metadata).toMatchObject({
      attachmentsFrozen: false,
      expectedAttachmentCount: 3,
      userAttachmentCount: 1,
      generatedAttachmentReservations: {},
      attachmentRepair: { clientRequestId: "attachment-repair-1" },
    });
  });
});

describe("knowledge-base generated attachment reservations", () => {
  it("reuses one provider file identity after response loss and binds cleanup ownership atomically", async () => {
    const leaseToken = "generated-attachment-lease";
    const active = turn({
      operationKey: "kbv2_generated-attachment-operation",
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: false,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const build = {
      id: active.buildId,
      userId: active.userId,
      generation: active.buildGeneration,
      activeTurnId: active.id,
    };
    const { executor, store } = createTurnServiceExecutor({
      build,
      turns: [active],
      turnSelections: Array.from({ length: 5 }, () => [
        (current: TurnServiceStore) => current.turns,
      ]),
    });
    const request = {
      userId: 1,
      turnId: active.id,
      leaseToken,
      role: "skill" as const,
      attachmentIndex: 0,
      filename: "socratic-kb-builder-v4.skill",
      mimeType: "application/zip",
      sizeBytes: 123,
      contentSha256: "c".repeat(64),
      now: new Date("2026-08-01T00:00:10.000Z"),
    };

    const first = await reserveKnowledgeBaseGeneratedAttachment(
      request,
      executor,
    );
    const replayAfterLostResponse =
      await reserveKnowledgeBaseGeneratedAttachment(request, executor);

    expect(replayAfterLostResponse).toEqual(first);
    expect(first).toEqual({
      state: "reserved",
      idempotencyKey: createKnowledgeBaseGeneratedAttachmentIdempotencyKey({
        operationKey: active.operationKey!,
        role: "skill",
        attachmentIndex: 0,
        requestHash: first.requestHash,
      }),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      upstreamFileId: null,
    });

    const completed = await completeKnowledgeBaseGeneratedAttachment(
      {
        userId: 1,
        turnId: active.id,
        leaseToken,
        role: "skill",
        attachmentIndex: 0,
        requestHash: first.requestHash,
        upstreamFileId: "provider-file-1",
        now: new Date("2026-08-01T00:00:11.000Z"),
      },
      executor,
    );
    expect(completed.attachmentFileIds).toEqual(["provider-file-1"]);
    expect(store.resources).toHaveLength(1);
    expect(store.resources[0]).toMatchObject({
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId: "provider-file-1",
      conversationId: active.conversationId,
    });

    const completedReplay = await reserveKnowledgeBaseGeneratedAttachment(
      request,
      executor,
    );
    expect(completedReplay).toMatchObject({
      state: "completed",
      idempotencyKey: first.idempotencyKey,
      upstreamFileId: "provider-file-1",
    });

    await expect(
      completeKnowledgeBaseGeneratedAttachment(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          role: "skill",
          attachmentIndex: 0,
          requestHash: first.requestHash,
          upstreamFileId: "provider-file-replacement",
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.resources).toHaveLength(1);
    expect(store.turns[0]!.attachmentFileIds).toEqual(["provider-file-1"]);
  });

  const reusableSkillSha256 = "d".repeat(64);

  function completedSkillTurn(
    overrides: Partial<ConversationTurn> = {},
  ): ConversationTurn {
    const fileId = "provider-skill-file";
    const requestBody = {
      prompt: "continue knowledge-base build",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      attachments: [
        {
          file_id: fileId,
          filename: "socratic-kb-builder-v4.skill",
        },
      ],
      taskId: "parent-task",
    };
    return turn({
      status: "completed",
      upstreamTaskId: "completed-provider-task",
      attachmentFileIds: [fileId],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        generatedAttachmentReservations: {
          "skill:0": {
            schemaVersion: 1,
            role: "skill",
            attachmentIndex: 0,
            requestHash: "e".repeat(64),
            idempotencyKeyHash: "f".repeat(64),
            filename: "socratic-kb-builder-v4.skill",
            mimeType: "application/zip",
            sizeBytes: 123,
            contentSha256: reusableSkillSha256,
            status: "completed",
            upstreamFileId: fileId,
            reservedAt: "2026-08-01T00:00:01.000Z",
            completedAt: "2026-08-01T00:00:02.000Z",
          },
        },
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:03.000Z",
        },
      },
      ...overrides,
    });
  }

  function reusableSkillLookupExecutor(input?: {
    sourceTurn?: ConversationTurn;
    resourceOverrides?: Record<string, unknown>;
  }) {
    const sourceTurn = input?.sourceTurn || completedSkillTurn();
    return createTurnServiceExecutor({
      build: {
        id: identity.buildId,
        userId: 1,
        generation: 3,
        activeTurnId: null,
      },
      turns: [sourceTurn],
      resources: [
        {
          id: "resource-skill-file",
          userId: 1,
          apiCredentialId: "credential-1",
          projectAssignmentId: null,
          kind: "file",
          upstreamId: "provider-skill-file",
          conversationId: sourceTurn.conversationId,
          createdAt: new Date("2026-08-01T00:00:02.000Z"),
          ...input?.resourceOverrides,
        },
      ],
      turnSelections: [[() => [sourceTurn]]],
    });
  }

  it("returns a completed Skill file only within the current user, build generation, and credential", async () => {
    const { executor } = reusableSkillLookupExecutor();

    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        executor,
      ),
    ).resolves.toBe("provider-skill-file");
  });

  it.each([
    ["another user", { userId: 2 }],
    ["another build", { buildId: "00000000-0000-4000-8000-000000000099" }],
    ["an older build generation", { buildGeneration: 2 }],
    ["another credential", { apiCredentialId: "credential-2" }],
    ["an unbound source turn", { upstreamTaskId: null }],
    ["a non-terminal source turn", { status: "queued" }],
  ] as const)("does not reuse a Skill from %s", async (_label, overrides) => {
    const { executor } = reusableSkillLookupExecutor({
      sourceTurn: completedSkillTurn(overrides as Partial<ConversationTurn>),
    });

    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        executor,
      ),
    ).resolves.toBeNull();
  });

  it("rejects a merely file-bound reservation and mismatched resource ownership", async () => {
    const halfUploaded = completedSkillTurn({
      status: "queued",
      upstreamTaskId: null,
      metadata: {
        attachmentsFrozen: false,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        generatedAttachmentReservations: (completedSkillTurn().metadata as any)
          .generatedAttachmentReservations,
      },
    });
    const halfUploadedExecutor = reusableSkillLookupExecutor({
      sourceTurn: halfUploaded,
    }).executor;
    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        halfUploadedExecutor,
      ),
    ).resolves.toBeNull();

    const foreignResourceExecutor = reusableSkillLookupExecutor({
      resourceOverrides: { userId: 2 },
    }).executor;
    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        foreignResourceExecutor,
      ),
    ).resolves.toBeNull();
  });

  it("does not reuse a completed Skill reservation with different bytes", async () => {
    const { executor } = reusableSkillLookupExecutor();
    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: "9".repeat(64),
        },
        executor,
      ),
    ).resolves.toBeNull();
  });
});

describe("knowledge-base atomic start reservation", () => {
  const startInput = {
    userId: 1,
    conversationId: "conversation-atomic",
    clientRequestId: "start-request-a",
    companyName: "FrontMind 超前智能",
    companyWebsite: "https://www.frontmind.net/",
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
    apiCredentialId: "credential-1",
    userText: "开始构建企业知识库",
    expectedAttachmentCount: 1,
    requestPayload: { attachments: [], operatorNotes: "" },
    recoveryMetadata: {
      kind: "start",
      conversationId: "conversation-atomic",
      attachments: [],
    },
    now: new Date("2026-08-01T00:00:00.000Z"),
  };
  const attachmentStartInput = {
    ...startInput,
    userAttachmentCount: 2,
    expectedAttachmentCount: 3,
    requestPayload: {
      attachments: [
        { file_id: "file-second", filename: "second.pdf" },
        { file_id: "file-first", filename: "first.pdf" },
      ],
      operatorNotes: "",
    },
    recoveryMetadata: {
      ...startInput.recoveryMetadata,
      attachments: [
        { file_id: "file-second", filename: "second.pdf" },
        { file_id: "file-first", filename: "first.pdf" },
      ],
    },
  };
  const attachmentResources = () => [
    {
      id: "resource-first",
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId: "file-first",
      conversationId: null,
      contentDeletedAt: null,
    },
    {
      id: "resource-second",
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId: "file-second",
      conversationId: null,
      contentDeletedAt: null,
    },
  ];

  it("rejects a tombstoned conversation before reserving a build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      tombstones: [
        {
          id: "00000000-0000-4000-8000-000000000099",
          userId: 1,
          publicConversationId: "conversation-atomic",
          resetRequestId: "00000000-0000-4000-8000-000000000098",
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(startInput, executor),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it("rejects a retained tombstone after the reset ticket has expired", async () => {
    const { executor, store } = createTurnServiceExecutor({
      retainedTombstones: [
        {
          id: "00000000-0000-4000-8000-000000000097",
          userId: 1,
          publicConversationId: "conversation-atomic",
          resetAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(startInput, executor),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it("commits one build and replays only the identical start request", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    const first = await reserveKnowledgeBaseStartBuild(startInput, executor);
    const second = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        now: new Date("2026-08-01T00:00:01.000Z"),
      },
      executor,
    );

    expect(first.createdBuild).toBe(true);
    expect(first.reservation.state).toBe("acquired");
    expect(second.createdBuild).toBe(false);
    expect(second.reservation.state).toBe("pending");
    expect(second.reservation.turn.id).toBe(first.reservation.turn.id);
    expect(store.build?.activeTurnId).toBe(first.reservation.turn.id);
    expect(store.build?.treePolicyVersion).toBe(2);
    expect(first.build.treePolicyVersion).toBe(2);
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: `u1:msg-kb-user-${first.reservation.turn.id}`,
      turnId: first.reservation.turn.id,
      role: "user",
      content: "开始构建企业知识库",
      metadata: {
        knowledgeBase: {
          serverOwned: true,
          kind: "pending_user",
          clientRequestId: "start-request-a",
          operationKey: first.reservation.turn.operationKey,
        },
      },
    });
    expect(store.conversation?.version).toBe(2);
  });

  it("locks exact upload ownership and binds it in the reservation transaction", async () => {
    const { executor, store, events } = createTurnServiceExecutor({
      resources: attachmentResources(),
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });

    const first = await reserveKnowledgeBaseStartBuild(
      attachmentStartInput,
      executor,
    );
    const replay = await reserveKnowledgeBaseStartBuild(
      {
        ...attachmentStartInput,
        now: new Date("2026-08-01T00:00:01.000Z"),
      },
      executor,
    );

    expect(first.reservation.turn.attachmentFileIds).toEqual([]);
    expect(
      (store.turns[0]!.metadata as any).recovery.attachments.map(
        (attachment: any) => attachment.file_id,
      ),
    ).toEqual(["file-second", "file-first"]);
    expect(store.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          upstreamId: "file-first",
          conversationId: "u1:conversation-atomic",
        }),
        expect.objectContaining({
          upstreamId: "file-second",
          conversationId: "u1:conversation-atomic",
        }),
      ]),
    );
    expect(replay.reservation.turn.id).toBe(first.reservation.turn.id);
    expect(store.turns).toHaveLength(1);
    expect(events.indexOf("start-attachments:lock")).toBeLessThan(
      events.indexOf("turn:insert"),
    );
    expect(events.indexOf("start-attachments:bind")).toBeLessThan(
      events.indexOf("transaction:commit"),
    );
  });

  it("fails atomically when discard wins and removes ownership before the row lock", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resources: [attachmentResources()[0]],
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(attachmentStartInput, executor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.resources[0]?.conversationId).toBeNull();
  });

  it.each([
    ["another user", { userId: 2 }],
    ["a delivery project", { projectAssignmentId: "project-1" }],
    ["another credential", { apiCredentialId: "credential-2" }],
    ["a task row", { kind: "task" }],
    ["deleted content", { contentDeletedAt: new Date("2026-08-01") }],
    ["another conversation", { conversationId: "u1:another-conversation" }],
  ])("rejects a start attachment owned by %s", async (_label, override) => {
    const resources = attachmentResources();
    resources[1] = { ...resources[1], ...override };
    const initialResources = structuredClone(resources);
    const { executor, store } = createTurnServiceExecutor({
      resources,
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(attachmentStartInput, executor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.build).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.resources).toEqual(initialResources);
  });

  it("rejects an attachment reorder under the same start request identity", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resources: attachmentResources(),
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    await reserveKnowledgeBaseStartBuild(attachmentStartInput, executor);
    const reversedAttachments = [
      { file_id: "file-first", filename: "first.pdf" },
      { file_id: "file-second", filename: "second.pdf" },
    ];

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...attachmentStartInput,
          requestPayload: {
            ...attachmentStartInput.requestPayload,
            attachments: reversedAttachments,
          },
          recoveryMetadata: {
            ...attachmentStartInput.recoveryMetadata,
            attachments: reversedAttachments,
          },
          now: new Date("2026-08-01T00:00:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
    });
    expect(store.turns).toHaveLength(1);
    expect(
      store.resources.every(
        (resource) => resource.conversationId === "u1:conversation-atomic",
      ),
    ).toBe(true);
  });

  it("can roll back only the new-build writer to legacy policy v1", async () => {
    const previous = process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
    process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = "false";
    try {
      const { executor, store } = createTurnServiceExecutor({
        turnSelections: [[[], []]],
      });
      const result = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
          treePolicyVersion: 1,
        },
        executor,
      );
      expect(result.createdBuild).toBe(true);
      expect(result.build.treePolicyVersion).toBe(1);
      expect(store.build?.treePolicyVersion).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
      } else {
        process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = previous;
      }
    }
  });

  it("rejects a policy/Skill mismatch before inserting any start state", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          treePolicyVersion: 1,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
  });

  it("rejects another client request id even when it targets the same start slot", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    await reserveKnowledgeBaseStartBuild(startInput, executor);

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          clientRequestId: "start-request-b",
          now: new Date("2026-08-01T00:00:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
  });

  it("replays the original start identity after its manifest advances the build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const first = await reserveKnowledgeBaseStartBuild(startInput, executor);
    const original = store.turns[0]!;
    original.status = "completed";
    original.upstreamTaskId = "task-start";
    original.completedAt = new Date("2026-08-01T00:00:30.000Z");
    store.build = {
      ...store.build,
      status: "confirming",
      revision: 1,
      currentLeafId: "1.2",
      activeTurnId: null,
      upstreamTaskId: "task-start",
    };

    const replay = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );

    expect(first.createdBuild).toBe(true);
    expect(replay.createdBuild).toBe(false);
    expect(replay.reservation).toMatchObject({
      state: "completed",
      upstreamTaskId: "task-start",
    });
    expect(store.turns).toHaveLength(1);
  });

  it("rolls the build back when the first reservation cannot commit", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resources: attachmentResources(),
      turnSelections: [[[], []]],
      failConversationInsertAtTransaction: 0,
    });
    await expect(
      reserveKnowledgeBaseStartBuild(attachmentStartInput, executor),
    ).rejects.toThrow("simulated conversation insert failure");
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    expect(store.resources.every((resource) => !resource.conversationId)).toBe(
      true,
    );
  });
});

describe("knowledge-base server-owned turn messages", () => {
  it("commits a normal customer turn, message and conversation version together", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000020",
      userId: 1,
      conversationId: "conversation-turn-message",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      activeTurnId: null,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const conversation = {
      id: "u1:conversation-turn-message",
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 8,
      status: "awaiting_input",
    };
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turnSelections: [[[], []]],
    });

    const reservation = await reserveKnowledgeBaseTurn(
      {
        userId: 1,
        buildId: build.id,
        clientRequestId: "confirm-request-1",
        operationType: "confirm",
        expectedGeneration: 2,
        expectedRevision: 3,
        expectedLeafId: "1.4",
        requestPayload: { userMessage: "确认", attachments: [] },
        apiCredentialId: "credential-1",
        userText: "确认",
        // The one frozen file is the generated Skill, not customer evidence.
        userAttachmentCount: 0,
        expectedAttachmentCount: 1,
        recoveryMetadata: {
          kind: "turn",
          conversationId: "conversation-turn-message",
          parentTaskId: "successful-parent-task",
          userMessage: "确认",
          attachments: [],
          skillVersion: "4",
        },
      },
      executor,
    );

    expect(reservation.state).toBe("acquired");
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: `u1:msg-kb-user-${reservation.turn.id}`,
      turnId: reservation.turn.id,
      role: "user",
      content: "确认",
      metadata: {
        knowledgeBase: {
          serverOwned: true,
          kind: "pending_user",
          clientRequestId: "confirm-request-1",
          generation: 2,
          revision: 3,
          leafId: "1.4",
        },
      },
    });
    expect(store.conversation).toMatchObject({
      version: 9,
      status: "running",
    });
    expect(store.build).toMatchObject({
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
    });
  });

  it("recovers with its retired pinned credential but fails closed after deletion", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000021",
      userId: 1,
      conversationId: "conversation-credential-recovery",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      activeTurnId: null,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const conversation = {
      id: "u1:conversation-credential-recovery",
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 8,
      status: "awaiting_input",
    };
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      credentials: [{ id: "credential-1", userId: 7, status: "active" }],
      usageOwnerId: 7,
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const input = {
      userId: 1,
      buildId: build.id,
      clientRequestId: "confirm-credential-recovery",
      operationType: "confirm" as const,
      expectedGeneration: 2,
      expectedRevision: 3,
      expectedLeafId: "1.4",
      requestPayload: { userMessage: "确认", attachments: [] },
      apiCredentialId: "credential-1",
      userText: "确认",
      userAttachmentCount: 0,
      expectedAttachmentCount: 1,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: "successful-parent-task",
        userMessage: "确认",
        attachments: [],
        skillVersion: "4",
      },
      now: new Date("2026-08-01T00:00:00.000Z"),
    };
    const first = await reserveKnowledgeBaseTurn(input, executor);
    expect(first.state).toBe("acquired");

    // The durable turn, not the mutable current-owner assignment, remains the
    // authority after owner A (7) is replaced by owner B (8).
    store.usageOwnerId = 8;
    store.turns[0]!.leaseExpiresAt = new Date("2026-07-31T00:00:00.000Z");
    store.credentials[0]!.status = "retired";
    const recovered = await reserveKnowledgeBaseTurn(
      { ...input, now: new Date("2026-08-01T00:01:00.000Z") },
      executor,
    );
    expect(recovered.state).toBe("acquired");
    expect(recovered.turn.id).toBe(first.turn.id);
    const duplicateAfterRestart = await reserveKnowledgeBaseTurn(
      { ...input, now: new Date("2026-08-01T00:01:01.000Z") },
      executor,
    );
    expect(duplicateAfterRestart.state).toBe("pending");
    expect(duplicateAfterRestart.turn.id).toBe(first.turn.id);
    expect(store.turns).toHaveLength(1);

    store.turns[0]!.leaseExpiresAt = new Date("2026-07-31T00:00:00.000Z");
    store.credentials[0]!.status = "deleted";
    await expect(
      reserveKnowledgeBaseTurn(
        { ...input, now: new Date("2026-08-01T00:02:00.000Z") },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects stale owner A for a new turn and accepts current owner B", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000022",
      userId: 1,
      conversationId: "conversation-current-owner",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      activeTurnId: null,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const conversation = {
      id: "u1:conversation-current-owner",
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 8,
      status: "awaiting_input",
    };
    const reservationInput = (apiCredentialId: string) => ({
      userId: 1,
      buildId: build.id,
      clientRequestId: `request-${apiCredentialId}`,
      operationType: "confirm" as const,
      expectedGeneration: 2,
      expectedRevision: 3,
      expectedLeafId: "1.4",
      requestPayload: { userMessage: "确认", attachments: [] },
      apiCredentialId,
      userText: "确认",
      userAttachmentCount: 0,
      expectedAttachmentCount: 1,
      recoveryMetadata: { kind: "turn" },
    });
    const stale = createTurnServiceExecutor({
      build: structuredClone(build),
      conversation: structuredClone(conversation),
      credentials: [{ id: "credential-a", userId: 7, status: "active" }],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        reservationInput("credential-a"),
        stale.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stale.store.turns).toHaveLength(0);

    const current = createTurnServiceExecutor({
      build: structuredClone(build),
      conversation: structuredClone(conversation),
      credentials: [{ id: "credential-b", userId: 8, status: "active" }],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        reservationInput("credential-b"),
        current.executor,
      ),
    ).resolves.toMatchObject({
      state: "acquired",
      turn: { apiCredentialId: "credential-b" },
    });
  });
});

describe("knowledge-base attachment-first turn reservation", () => {
  const manifest = [
    {
      filename: "facts.pdf",
      sizeBytes: 12,
      mimeType: "application/pdf",
      lastModified: 1,
      sha256: "a".repeat(64),
    },
    {
      filename: "logo-notes.txt",
      sizeBytes: 8,
      mimeType: "text/plain",
      lastModified: 2,
      sha256: "b".repeat(64),
    },
  ];
  const build = {
    id: "00000000-0000-4000-8000-000000000030",
    userId: 1,
    conversationId: "conversation-deferred-files",
    companyName: "FrontMind 超前智能",
    companyWebsite: "https://www.frontmind.net/",
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: "e".repeat(64),
    status: "confirming",
    generation: 4,
    stateEpoch: 2,
    revision: 6,
    currentLeafId: "2.1",
    activeTurnId: null,
    upstreamTaskId: "parent-task",
    protocolErrorCode: null,
    protocolError: null,
  };
  const conversation = {
    id: "u1:conversation-deferred-files",
    userId: 1,
    projectAssignmentId: null,
    deletedAt: null,
    deletedMessageIds: [],
    version: 3,
    status: "awaiting_input",
  };

  function reserveInput() {
    return {
      userId: 1,
      buildId: build.id,
      clientRequestId: "deferred-request-1",
      operationType: "revise" as const,
      expectedGeneration: 4,
      expectedRevision: 6,
      expectedLeafId: "2.1",
      requestPayload: {
        userMessage: "请结合附件修订",
        attachmentManifest: manifest,
        skillVersion: "4",
      },
      apiCredentialId: "credential-1",
      userText: "请结合附件修订",
      userAttachmentCount: 2,
      expectedAttachmentCount: 3,
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: manifest,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: "parent-task",
        userMessage: "请结合附件修订",
        attachments: [],
        attachmentManifest: manifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        skillVersion: "4",
      },
      now: new Date("2026-08-01T00:00:00.000Z"),
    };
  }

  function uploadFirstTakeoverInput(overrides: Record<string, unknown> = {}) {
    const attachments = [
      { file_id: "replacement-facts", filename: "facts.pdf" },
      {
        file_id: "replacement-logo-notes",
        filename: "logo-notes.txt",
      },
    ];
    return {
      userId: 1,
      buildId: build.id,
      clientRequestId: "deferred-request-1",
      operationType: "revise" as const,
      expectedGeneration: 4,
      expectedRevision: 6,
      expectedLeafId: "2.1",
      requestPayload: {
        userMessage: "请结合附件修订",
        attachments,
        skillVersion: "4",
      },
      apiCredentialId: "credential-1",
      userText: "请结合附件修订",
      userAttachmentCount: 2,
      expectedAttachmentCount: 3,
      clientAttachmentManifest: manifest,
      resumeLegacyAttachmentTakeover: true,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: "parent-task",
        userMessage: "请结合附件修订",
        attachments,
        attachmentManifest: manifest,
        skillVersion: "4",
      },
      now: new Date("2026-08-01T00:01:00.000Z"),
      ...overrides,
    };
  }

  it("does not create a competing turn while open-build recovery owns the lease", async () => {
    const { executor } = createTurnServiceExecutor({
      build: {
        ...build,
        recoveryLeaseOwnerHash: "a".repeat(64),
        recoveryLeaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      },
      conversation: { ...conversation },
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseTurn(reserveInput(), executor),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_PENDING",
      retryAfterMs: 5_000,
    });
  });

  it("persists each uploaded id monotonically and freezes dispatch only after N/N", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    expect(reserved).toMatchObject({ state: "awaiting_attachments" });
    expect(store.turns[0]).toMatchObject({
      attachmentFileIds: [],
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientStagedAttachments: [],
      },
    });

    const first = await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        index: 0,
        attachment: { file_id: "file-facts", filename: "facts.pdf" },
      },
      executor,
    );
    expect(first).toMatchObject({
      attachmentFileIds: ["file-facts"],
      stagedUserAttachmentCount: 1,
      awaitingClientAttachments: true,
    });
    expect((store.turns[0]!.metadata as any).recovery.attachments).toEqual([
      { file_id: "file-facts", filename: "facts.pdf" },
    ]);

    const resumed = await reserveKnowledgeBaseTurn(
      {
        ...reserveInput(),
        userText: "",
        requestPayload: {
          userMessage: "",
          attachmentManifest: manifest,
          skillVersion: "4",
        },
        resumeDeferredReservation: true,
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );
    expect(resumed).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        id: reserved.turn.id,
        clientRequestId: "deferred-request-1",
        stagedUserAttachmentCount: 1,
      },
    });
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    await expect(
      reserveKnowledgeBaseTurn(
        {
          ...reserveInput(),
          userText: "换成另一套修改意见",
          requestPayload: {
            userMessage: "换成另一套修改意见",
            attachmentManifest: manifest,
            skillVersion: "4",
          },
          resumeDeferredReservation: true,
          now: new Date("2026-08-01T00:01:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const replacementManifest = manifest.map((item, index) =>
      index === 0 ? { ...item, sha256: "c".repeat(64) } : item,
    );
    await expect(
      reserveKnowledgeBaseTurn(
        {
          ...reserveInput(),
          userText: "",
          requestPayload: {
            userMessage: "",
            attachmentManifest: replacementManifest,
            skillVersion: "4",
          },
          clientAttachmentManifest: replacementManifest,
          resumeDeferredReservation: true,
          now: new Date("2026-08-01T00:01:02.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      claimKnowledgeBaseDeferredTurnDispatch(
        {
          userId: 1,
          buildId: build.id,
          turnId: reserved.turn.id,
          clientRequestId: reserved.turn.clientRequestId,
          clientAttachmentManifest: manifest,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.turns[0]!.upstreamTaskId).toBeNull();

    // A lost staging response can safely replay the exact same index/file id.
    await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        index: 0,
        attachment: { file_id: "file-facts", filename: "facts.pdf" },
      },
      executor,
    );
    expect(store.turns[0]!.attachmentFileIds).toEqual(["file-facts"]);

    await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        index: 1,
        attachment: {
          file_id: "file-logo-notes",
          filename: "logo-notes.txt",
        },
      },
      executor,
    );
    expect(store.turns[0]!.attachmentFileIds).toEqual([
      "file-facts",
      "file-logo-notes",
    ]);

    const claimed = await claimKnowledgeBaseDeferredTurnDispatch(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
      },
      executor,
    );
    expect(claimed).toMatchObject({
      state: "acquired",
      turn: {
        attachmentFileIds: ["file-facts", "file-logo-notes"],
        awaitingClientAttachments: false,
      },
      recoveryMetadata: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-facts", filename: "facts.pdf" },
          { file_id: "file-logo-notes", filename: "logo-notes.txt" },
        ],
      },
    });
  });

  it("atomically claims the deferred turn when the final customer attachment is staged", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const firstStagedAt = new Date("2026-08-01T00:00:10.000Z");
    const first = await stageAndClaimKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        index: 0,
        attachment: { file_id: "file-facts", filename: "facts.pdf" },
        now: firstStagedAt,
        leaseMs: 60_000,
      },
      executor,
    );

    expect(first).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        attachmentFileIds: ["file-facts"],
        stagedUserAttachmentCount: 1,
        expectedUserAttachmentCount: 2,
        awaitingClientAttachments: true,
        leaseExpiresAt: null,
      },
    });
    expect(store.turns[0]).toMatchObject({
      attachmentFileIds: ["file-facts"],
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientStagedAttachments: [
          { index: 0, file_id: "file-facts", filename: "facts.pdf" },
        ],
      },
    });

    const finalStagedAt = new Date("2026-08-01T00:00:20.000Z");
    const claimed = await stageAndClaimKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        index: 1,
        attachment: {
          file_id: "file-logo-notes",
          filename: "logo-notes.txt",
        },
        now: finalStagedAt,
        leaseMs: 60_000,
      },
      executor,
    );

    expect(claimed).toMatchObject({
      state: "acquired",
      turn: {
        attachmentFileIds: ["file-facts", "file-logo-notes"],
        stagedUserAttachmentCount: 2,
        expectedUserAttachmentCount: 2,
        awaitingClientAttachments: false,
        leaseExpiresAt: new Date("2026-08-01T00:01:20.000Z"),
      },
      recoveryMetadata: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-facts", filename: "facts.pdf" },
          { file_id: "file-logo-notes", filename: "logo-notes.txt" },
        ],
      },
    });
    expect(claimed.state === "acquired" && claimed.leaseToken).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(store.turns[0]).toMatchObject({
      attachmentFileIds: ["file-facts", "file-logo-notes"],
      leaseExpiresAt: new Date("2026-08-01T00:01:20.000Z"),
      metadata: {
        awaitingClientAttachments: false,
        clientStagedAttachments: [
          { index: 0, file_id: "file-facts", filename: "facts.pdf" },
          {
            index: 1,
            file_id: "file-logo-notes",
            filename: "logo-notes.txt",
          },
        ],
      },
    });
    expect((store.turns[0]!.metadata as any).leaseOwnerHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("cancels a queued Logo upload before dispatch without moving the authoritative leaf", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const buildBeforeCancellation = { ...store.build };
    const cancelledAt = new Date("2026-08-01T00:00:30.000Z");

    expect(reserved).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        status: "queued",
        awaitingClientAttachments: true,
      },
    });
    expect(buildBeforeCancellation).toMatchObject({
      status: "confirming",
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      activeTurnId: reserved.turn.id,
    });

    const cancelled = await cancelUnpreparedKnowledgeBaseTurn(
      {
        userId: 1,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        code: "INVALID_OFFICIAL_LOGO_UPLOAD",
        message: "请上传有效的 Logo 图片后重试",
        now: cancelledAt,
      },
      executor,
    );

    expect(cancelled).toMatchObject({
      id: reserved.turn.id,
      status: "cancelled",
      completedAt: cancelledAt,
      leaseExpiresAt: null,
      awaitingClientAttachments: false,
    });
    expect(store.turns[0]).toMatchObject({
      id: reserved.turn.id,
      status: "cancelled",
      upstreamTaskId: null,
      errorCode: "INVALID_OFFICIAL_LOGO_UPLOAD",
      completedAt: cancelledAt,
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: false,
        recovery: { capturedClientAttachments: true },
      },
    });
    expect(store.build).toMatchObject({
      status: "confirming",
      stateEpoch: buildBeforeCancellation.stateEpoch + 1,
      revision: buildBeforeCancellation.revision,
      currentLeafId: buildBeforeCancellation.currentLeafId,
      activeTurnId: null,
      awaitingResponseSince: null,
      protocolErrorCode: null,
      protocolError: null,
    });
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: build.upstreamTaskId,
      previousResponseId: build.upstreamTaskId,
      version: conversation.version + 2,
    });
  });

  it("deduplicates the exact unprepared cancellation replay and rejects conflicting replay identities", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const cancellation = {
      userId: 1,
      turnId: reserved.turn.id,
      clientRequestId: reserved.turn.clientRequestId,
      code: "INVALID_OFFICIAL_LOGO_UPLOAD",
      message: "请上传有效的 Logo 图片后重试",
      now: new Date("2026-08-01T00:00:30.000Z"),
    };
    const first = await cancelUnpreparedKnowledgeBaseTurn(
      cancellation,
      executor,
    );
    const stateAfterFirstCancellation = structuredClone(store);

    const replay = await cancelUnpreparedKnowledgeBaseTurn(
      {
        ...cancellation,
        now: new Date("2026-08-01T00:00:31.000Z"),
      },
      executor,
    );
    expect(replay).toMatchObject({
      id: first.id,
      status: "cancelled",
      completedAt: cancellation.now,
      leaseExpiresAt: null,
    });
    expect(store).toEqual(stateAfterFirstCancellation);

    await expect(
      cancelUnpreparedKnowledgeBaseTurn(
        {
          ...cancellation,
          clientRequestId: "different-client-request",
          now: new Date("2026-08-01T00:00:32.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(stateAfterFirstCancellation);

    await expect(
      cancelUnpreparedKnowledgeBaseTurn(
        {
          ...cancellation,
          code: "DIFFERENT_CANCELLATION_CODE",
          now: new Date("2026-08-01T00:00:33.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(stateAfterFirstCancellation);
  });

  it("releases the canonical slot for a replacement upload while old-request replay stays terminal", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [[], []],
        [(current) => [current.turns[0]!], (current) => [current.turns[1]!]],
      ],
    });
    const originalInput = reserveInput();
    const original = await reserveKnowledgeBaseTurn(originalInput, executor);
    const canonicalOperationKey = original.turn.operationKey;

    await cancelUnpreparedKnowledgeBaseTurn(
      {
        userId: 1,
        turnId: original.turn.id,
        clientRequestId: original.turn.clientRequestId,
        code: "INVALID_OFFICIAL_LOGO_UPLOAD",
        message: "请上传有效的 Logo 图片后重试",
      },
      executor,
    );
    expect(store.turns[0]).toMatchObject({
      id: original.turn.id,
      status: "cancelled",
      metadata: {
        unpreparedCancellation: true,
        cancelledOperationKey: canonicalOperationKey,
      },
    });
    expect(store.turns[0]!.operationKey).not.toBe(canonicalOperationKey);

    const replacementManifest = manifest.map((entry, index) =>
      index === 1
        ? {
            ...entry,
            filename: "official-logo.png",
            mimeType: "image/png",
            sizeBytes: 24,
            lastModified: 3,
            sha256: "c".repeat(64),
          }
        : entry,
    );
    const replacementInput = {
      ...reserveInput(),
      clientRequestId: "deferred-request-2",
      requestPayload: {
        ...reserveInput().requestPayload,
        userMessage: "已补充官方 Logo，请继续",
        attachmentManifest: replacementManifest,
      },
      userText: "已补充官方 Logo，请继续",
      clientAttachmentManifest: replacementManifest,
      recoveryMetadata: {
        ...reserveInput().recoveryMetadata,
        userMessage: "已补充官方 Logo，请继续",
        attachmentManifest: replacementManifest,
      },
      now: new Date("2026-08-01T00:01:00.000Z"),
    };
    const replacement = await reserveKnowledgeBaseTurn(
      replacementInput,
      executor,
    );
    expect(replacement).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        clientRequestId: "deferred-request-2",
        operationKey: canonicalOperationKey,
        awaitingClientAttachments: true,
      },
    });
    expect(replacement.turn.id).not.toBe(original.turn.id);
    expect(store.build).toMatchObject({ activeTurnId: replacement.turn.id });
    expect(store.turns).toHaveLength(2);

    const activeBuildBeforeOldReplay = { ...store.build };
    const oldReplay = await reserveKnowledgeBaseTurn(
      {
        ...originalInput,
        now: new Date("2026-08-01T00:01:01.000Z"),
      },
      executor,
    );
    expect(oldReplay).toMatchObject({
      state: "terminal",
      turn: {
        id: original.turn.id,
        status: "cancelled",
      },
    });
    expect(store.build).toEqual(activeBuildBeforeOldReplay);
    expect(store.build).toMatchObject({ activeTurnId: replacement.turn.id });
    expect(store.turns).toHaveLength(2);
  });

  it.each(["preparedDispatch", "upstreamTaskId"] as const)(
    "refuses cancellation once %s proves dispatch has started",
    async (dispatchEvidence) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turnSelections: [[[], []], [(current) => current.turns]],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
      if (dispatchEvidence === "preparedDispatch") {
        store.turns[0] = {
          ...store.turns[0]!,
          metadata: {
            ...(store.turns[0]!.metadata as Record<string, unknown>),
            preparedDispatch: { schemaVersion: 1 },
          },
        };
      } else {
        store.turns[0] = {
          ...store.turns[0]!,
          upstreamTaskId: "already-created-task",
        };
      }
      const buildBeforeCancellation = { ...store.build };

      await expect(
        cancelUnpreparedKnowledgeBaseTurn(
          {
            userId: 1,
            turnId: reserved.turn.id,
            clientRequestId: reserved.turn.clientRequestId,
            code: "INVALID_OFFICIAL_LOGO_UPLOAD",
            message: "请上传有效的 Logo 图片后重试",
          },
          executor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        status: "queued",
      });
      expect(store.build).toEqual(buildBeforeCancellation);
    },
  );

  it.each(["clientRequestId", "leaseToken"] as const)(
    "refuses cancellation with the wrong %s",
    async (mismatchedIdentity) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turnSelections: [[[], []], [(current) => current.turns]],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
      const buildBeforeCancellation = { ...store.build };

      await expect(
        cancelUnpreparedKnowledgeBaseTurn(
          {
            userId: 1,
            turnId: reserved.turn.id,
            clientRequestId:
              mismatchedIdentity === "clientRequestId"
                ? "wrong-client-request"
                : reserved.turn.clientRequestId,
            ...(mismatchedIdentity === "leaseToken"
              ? { leaseToken: "wrong-lease-token" }
              : {}),
            code: "INVALID_OFFICIAL_LOGO_UPLOAD",
            message: "请上传有效的 Logo 图片后重试",
          },
          executor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        status: "queued",
        metadata: { awaitingClientAttachments: true },
      });
      expect(store.build).toEqual(buildBeforeCancellation);
    },
  );

  it("atomically takes over without local text and coalesces a lost-202 replay", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    expect(reserved.state).toBe("awaiting_attachments");
    const originalTurnId = reserved.turn.id;
    const originalOperationKey = reserved.turn.operationKey;
    const originalUpstreamIdempotencyKey =
      createKnowledgeBaseUpstreamIdempotencyKey(originalOperationKey);

    await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: originalTurnId,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        index: 0,
        attachment: { file_id: "old-staged-facts", filename: "facts.pdf" },
      },
      executor,
    );

    const missingLocalMessageInput = uploadFirstTakeoverInput();
    const takeoverWithoutLocalMessage = {
      ...missingLocalMessageInput,
      userText: "",
      requestPayload: {
        ...(missingLocalMessageInput.requestPayload as Record<string, unknown>),
        userMessage: "",
      },
      recoveryMetadata: {
        ...(missingLocalMessageInput.recoveryMetadata as Record<
          string,
          unknown
        >),
        userMessage: "",
      },
    };
    const takenOver = await reserveKnowledgeBaseTurn(
      takeoverWithoutLocalMessage,
      executor,
    );
    expect(takenOver).toMatchObject({
      state: "acquired",
      turn: {
        id: originalTurnId,
        clientRequestId: "deferred-request-1",
        operationKey: originalOperationKey,
        attachmentFileIds: [],
        awaitingClientAttachments: false,
      },
      upstreamIdempotencyKey: originalUpstreamIdempotencyKey,
    });
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({
      id: originalTurnId,
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: false,
        expectedAttachmentCount: 3,
        userAttachmentCount: 2,
        recovery: {
          userMessage: "请结合附件修订",
          attachments: [
            { file_id: "replacement-facts", filename: "facts.pdf" },
            {
              file_id: "replacement-logo-notes",
              filename: "logo-notes.txt",
            },
          ],
        },
      },
    });
    expect((store.turns[0]!.metadata as any).clientAttachmentManifestHash).toBe(
      hashKnowledgeBaseTurnRequest(manifest),
    );
    expect((store.turns[0]!.metadata as any).clientStagedAttachments).toBe(
      undefined,
    );
    expect(store.build).toMatchObject({
      activeTurnId: originalTurnId,
      stateEpoch: 4,
      lastTurnUserText: "请结合附件修订",
      lastTurnAttachmentCount: 2,
    });

    const replay = await reserveKnowledgeBaseTurn(
      {
        ...takeoverWithoutLocalMessage,
        now: new Date("2026-08-01T00:01:01.000Z"),
      },
      executor,
    );
    expect(replay).toMatchObject({
      state: "pending",
      turn: { id: originalTurnId, operationKey: originalOperationKey },
    });
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]!.upstreamTaskId).toBeNull();
  });

  it.each([
    [
      "client request identity",
      () => uploadFirstTakeoverInput({ clientRequestId: "another-request" }),
    ],
    [
      "knowledge coordinate",
      () => uploadFirstTakeoverInput({ expectedRevision: 7 }),
    ],
    [
      "pinned credential",
      () => uploadFirstTakeoverInput({ apiCredentialId: "credential-2" }),
    ],
    [
      "skill version",
      () => {
        const input = uploadFirstTakeoverInput();
        return {
          ...input,
          requestPayload: {
            ...(input.requestPayload as Record<string, unknown>),
            skillVersion: "5",
          },
          recoveryMetadata: {
            ...(input.recoveryMetadata as Record<string, unknown>),
            skillVersion: "5",
          },
        };
      },
    ],
    [
      "reserved filename",
      () => {
        const input = uploadFirstTakeoverInput();
        const attachments = [
          { file_id: "replacement-facts", filename: "other.pdf" },
          {
            file_id: "replacement-logo-notes",
            filename: "logo-notes.txt",
          },
        ];
        return {
          ...input,
          requestPayload: {
            ...(input.requestPayload as Record<string, unknown>),
            attachments,
          },
          recoveryMetadata: {
            ...(input.recoveryMetadata as Record<string, unknown>),
            attachments,
          },
        };
      },
    ],
  ])(
    "rejects upload-first takeover outside the original %s",
    async (_label, nextInput) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turns: [],
        credentials: [
          { id: "credential-1", userId: 1, status: "active" },
          { id: "credential-2", userId: 1, status: "active" },
        ],
        turnSelections: [
          [[], []],
          [(current) => current.turns, (current) => current.turns],
        ],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);

      await expect(
        reserveKnowledgeBaseTurn(nextInput() as any, executor),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns).toHaveLength(1);
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        upstreamTaskId: null,
        leaseExpiresAt: null,
        metadata: { awaitingClientAttachments: true },
      });
    },
  );

  it.each([
    ["sha256", { sha256: "f".repeat(64) }],
    ["sizeBytes", { sizeBytes: manifest[0]!.sizeBytes + 1 }],
    ["mimeType", { mimeType: "application/octet-stream" }],
    ["lastModified", { lastModified: manifest[0]!.lastModified + 1 }],
  ])(
    "rejects a same-name replacement whose %s differs from the durable manifest",
    async (_field, mutation) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turnSelections: [
          [[], []],
          [(current) => current.turns, (current) => current.turns],
        ],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
      const replacementManifest = manifest.map((entry, index) =>
        index === 0 ? { ...entry, ...mutation } : entry,
      );
      const input = uploadFirstTakeoverInput({
        clientAttachmentManifest: replacementManifest,
      });

      await expect(
        reserveKnowledgeBaseTurn(input as any, executor),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns).toHaveLength(1);
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        upstreamTaskId: null,
        metadata: { awaitingClientAttachments: true },
      });
    },
  );

  it("never lets the recovery worker claim a browser turn awaiting files", async () => {
    const waiting = turn({
      id: "00000000-0000-4000-8000-000000000031",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      attachmentFileIds: ["file-facts"],
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: true,
        userAttachmentCount: 2,
        clientStagedAttachments: [
          { index: 0, file_id: "file-facts", filename: "facts.pdf" },
        ],
        recovery: {
          attachments: [{ file_id: "file-facts", filename: "facts.pdf" }],
        },
      },
    });
    const { executor } = createTurnServiceExecutor({
      build: { ...build, activeTurnId: waiting.id },
      conversation: { ...conversation },
      turns: [waiting],
      turnSelections: [[[waiting]]],
    });
    await expect(
      claimKnowledgeBaseTurnForRecovery({ turnId: waiting.id }, executor),
    ).resolves.toBeNull();
  });
});

describe("acknowledged manual Logo rejection", () => {
  const leaseToken = "manual-logo-lease";
  const rejectedAt = new Date("2026-08-01T00:00:30.000Z");

  function fixture(overrides: { presentationKey?: string } = {}) {
    const buildId = "00000000-0000-4000-8000-000000000040";
    const clientRequestId = "manual-logo-request-invalid";
    const operationKey = createKnowledgeBaseOperationKey({
      buildId,
      buildGeneration: 2,
      operationType: "revise",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      operationInstanceId: clientRequestId,
    });
    const presentationKey = overrides.presentationKey ?? "presentation-first";
    const requestBody = {
      prompt: "replace official logo",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      taskId: "parent-task",
      attachments: [
        { file_id: "skill-file", filename: "skill.zip" },
        { file_id: "instructions-file", filename: "instructions.md" },
        { file_id: "invalid-logo-file", filename: "invalid-logo.png" },
      ],
    };
    const acknowledgedTurn = turn({
      id: "00000000-0000-4000-8000-000000000041",
      conversationId: "u1:conversation-manual-logo",
      clientRequestId,
      buildId,
      buildGeneration: 2,
      operationKey,
      operationType: "revise",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      attachmentFileIds: [
        "skill-file",
        "instructions-file",
        "invalid-logo-file",
      ],
      status: "running",
      upstreamTaskId: "child-logo-task",
      startedAt: new Date("2026-08-01T00:00:20.000Z"),
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      metadata: {
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        attachmentsFrozen: true,
        expectedAttachmentCount: 3,
        userAttachmentCount: 1,
        expectedPresentationKey: "presentation-first",
        recovery: {
          kind: "turn",
          conversationId: "conversation-manual-logo",
          parentTaskId: "parent-task",
          manualLogoSubmission: true,
          userMessage: "请使用新 Logo 重新呈现",
          attachments: [
            { file_id: "invalid-logo-file", filename: "invalid-logo.png" },
          ],
          officialLogoUpload: {
            index: 0,
            fileId: "invalid-logo-file",
            filename: "invalid-logo.png",
            mimeType: "image/png",
            sizeBytes: 32,
            sourceSha256: "a".repeat(64),
            verified: false,
          },
          skillVersion: "4",
          skillContentHash: "c".repeat(64),
        },
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const build = {
      id: buildId,
      userId: 1,
      conversationId: "conversation-manual-logo",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      status: "confirming",
      generation: 2,
      stateEpoch: 9,
      activeTurnId: acknowledgedTurn.id,
      upstreamTaskId: acknowledgedTurn.upstreamTaskId,
      lastAppliedOperationKey: "last-applied-operation",
      currentPresentationKey: presentationKey,
      revision: 0,
      currentLeafId: "1.1",
      totalNodeCount: 10,
      confirmedCount: 0,
      directPrefilledCount: 0,
      awaitingResponseSince: new Date("2026-08-01T00:00:20.000Z"),
      protocolErrorCode: null,
      protocolError: null,
      logoStorageKey: "logos/existing.png",
      logoSha256: "e".repeat(64),
      logoBytes: 256,
      logoFilename: "existing.png",
      logoMimeType: "image/png",
    };
    const conversation = {
      id: acknowledgedTurn.conversationId,
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 4,
      status: "running",
      upstreamTaskId: acknowledgedTurn.upstreamTaskId,
      previousResponseId: "parent-task",
      completedAt: null,
    };
    return { acknowledgedTurn, build, conversation };
  }

  it("restores the exact parent state, is idempotent, and lets new Logo bytes reserve a distinct provider operation", async () => {
    const { acknowledgedTurn, build, conversation } = fixture();
    const oldTurn = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === acknowledgedTurn.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [acknowledgedTurn],
      turnSelections: [[oldTurn], [oldTurn], [oldTurn], [[], []]],
    });
    const input = {
      userId: 1,
      buildId: build.id,
      buildGeneration: build.generation,
      turnId: acknowledgedTurn.id,
      clientRequestId: acknowledgedTurn.clientRequestId,
      leaseToken,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID" as const,
      message: "Logo 原始文件无法安全解码，请重新上传",
      now: rejectedAt,
    };

    const rejected = await rejectAcknowledgedKnowledgeBaseManualLogoTurn(
      input,
      executor,
    );
    expect(rejected).toMatchObject({
      id: acknowledgedTurn.id,
      status: "cancelled",
      upstreamTaskId: "child-logo-task",
      completedAt: rejectedAt,
      leaseExpiresAt: null,
    });
    expect(store.build).toMatchObject({
      upstreamTaskId: "parent-task",
      status: "confirming",
      stateEpoch: build.stateEpoch + 1,
      activeTurnId: null,
      awaitingResponseSince: null,
      protocolErrorCode: null,
      protocolError: null,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      currentPresentationKey: build.currentPresentationKey,
      lastAppliedOperationKey: build.lastAppliedOperationKey,
      logoStorageKey: build.logoStorageKey,
      logoSha256: build.logoSha256,
      logoBytes: build.logoBytes,
      logoFilename: build.logoFilename,
      logoMimeType: build.logoMimeType,
    });
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      upstreamTaskId: "child-logo-task",
      startedAt: acknowledgedTurn.startedAt,
      attachmentFileIds: acknowledgedTurn.attachmentFileIds,
      errorCode: input.code,
      completedAt: rejectedAt,
      leaseExpiresAt: null,
      metadata: {
        acknowledgedManualLogoCancellation: true,
        cancelledOperationKey: acknowledgedTurn.operationKey,
        attachmentsFrozen: true,
        recovery: {
          officialLogoUpload: {
            fileId: "invalid-logo-file",
            verified: false,
          },
        },
        preparedDispatch: { requestBody: { taskId: "parent-task" } },
      },
    });
    expect(store.turns[0]!.operationKey).not.toBe(
      acknowledgedTurn.operationKey,
    );
    expect((store.turns[0]!.metadata as any).leaseOwnerHash).toBeUndefined();
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: "parent-task",
      previousResponseId: "parent-task",
      version: conversation.version + 1,
      completedAt: null,
    });

    const settledState = structuredClone(store);
    await expect(
      rejectAcknowledgedKnowledgeBaseManualLogoTurn(
        { ...input, now: new Date("2026-08-01T00:00:31.000Z") },
        executor,
      ),
    ).resolves.toMatchObject({ status: "cancelled", completedAt: rejectedAt });
    expect(store).toEqual(settledState);

    await expect(
      rejectAcknowledgedKnowledgeBaseManualLogoTurn(
        { ...input, leaseToken: "wrong-manual-logo-lease" },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(settledState);

    const replacementRequestId = "manual-logo-request-replacement";
    const replacement = await reserveKnowledgeBaseTurn(
      {
        userId: 1,
        buildId: build.id,
        clientRequestId: replacementRequestId,
        operationInstanceId: replacementRequestId,
        operationType: "revise",
        expectedGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        expectedPresentationKey: build.currentPresentationKey,
        requestPayload: {
          submissionKind: "logo",
          attachments: [
            { file_id: "valid-logo-file", filename: "valid-logo.png" },
          ],
        },
        apiCredentialId: "credential-1",
        userText: "请使用新 Logo 重新呈现",
        userAttachmentCount: 1,
        expectedAttachmentCount: 3,
        recoveryMetadata: {
          kind: "turn",
          conversationId: build.conversationId,
          parentTaskId: "parent-task",
          manualLogoSubmission: true,
          attachments: [
            { file_id: "valid-logo-file", filename: "valid-logo.png" },
          ],
          officialLogoUpload: {
            index: 0,
            fileId: "valid-logo-file",
            filename: "valid-logo.png",
            mimeType: "image/png",
            sizeBytes: 64,
            sourceSha256: "f".repeat(64),
            verified: false,
          },
          skillVersion: "4",
          skillContentHash: "c".repeat(64),
        },
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );
    expect(replacement).toMatchObject({
      state: "acquired",
      turn: {
        clientRequestId: replacementRequestId,
        upstreamTaskId: null,
      },
    });
    expect(replacement.turn.operationKey).not.toBe(
      acknowledgedTurn.operationKey,
    );
    expect(store.turns[1]).toMatchObject({
      metadata: {
        recovery: {
          attachments: [
            { file_id: "valid-logo-file", filename: "valid-logo.png" },
          ],
          officialLogoUpload: { fileId: "valid-logo-file", verified: false },
        },
      },
    });
    expect(
      createKnowledgeBaseUpstreamIdempotencyKey(replacement.turn.operationKey),
    ).not.toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(acknowledgedTurn.operationKey),
    );
  });

  it("fails closed when the authoritative presentation changed", async () => {
    const { acknowledgedTurn, build, conversation } = fixture({
      presentationKey: "newer-presentation",
    });
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [acknowledgedTurn],
      turnSelections: [[(current) => current.turns]],
    });
    const before = structuredClone(store);

    await expect(
      rejectAcknowledgedKnowledgeBaseManualLogoTurn(
        {
          userId: 1,
          buildId: build.id,
          buildGeneration: build.generation,
          turnId: acknowledgedTurn.id,
          clientRequestId: acknowledgedTurn.clientRequestId,
          leaseToken,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          message: "当前知识节点已变化",
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(before);
  });

  it("releases a prepared Logo turn after a deterministic pre-ack rejection and accepts new bytes", async () => {
    const source = fixture();
    const unacknowledgedTurn = {
      ...source.acknowledgedTurn,
      upstreamTaskId: null,
    };
    const build = {
      ...source.build,
      upstreamTaskId: "parent-task",
    };
    const conversation = {
      ...source.conversation,
      upstreamTaskId: "parent-task",
      previousResponseId: "parent-task",
    };
    const oldTurn = (current: TurnServiceStore) =>
      current.turns.filter(
        (candidate) => candidate.id === unacknowledgedTurn.id,
      );
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [unacknowledgedTurn],
      turnSelections: [[oldTurn], [[], []]],
    });
    const input = {
      userId: 1,
      buildId: build.id,
      buildGeneration: build.generation,
      turnId: unacknowledgedTurn.id,
      clientRequestId: unacknowledgedTurn.clientRequestId,
      leaseToken,
      code: "UPSTREAM_CREATE_HTTP_422",
      message: "上游已明确拒绝创建本轮任务，请重新选择 Logo",
      now: rejectedAt,
    };

    await expect(
      rejectUnacknowledgedKnowledgeBaseManualLogoTurn(input, executor),
    ).resolves.toMatchObject({
      id: unacknowledgedTurn.id,
      status: "cancelled",
      upstreamTaskId: null,
      completedAt: rejectedAt,
    });
    expect(store.build).toMatchObject({
      upstreamTaskId: "parent-task",
      status: "confirming",
      activeTurnId: null,
      awaitingResponseSince: null,
      protocolErrorCode: null,
      protocolError: null,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      currentPresentationKey: build.currentPresentationKey,
    });
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      upstreamTaskId: null,
      errorCode: input.code,
      leaseExpiresAt: null,
      metadata: {
        unacknowledgedManualLogoCancellation: true,
        cancelledOperationKey: unacknowledgedTurn.operationKey,
        attachmentsFrozen: true,
        preparedDispatch: { requestBody: { taskId: "parent-task" } },
      },
    });
    expect((store.turns[0]!.metadata as any).leaseOwnerHash).toBeUndefined();
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: "parent-task",
      previousResponseId: "parent-task",
      completedAt: null,
    });

    const replacementRequestId = "manual-logo-after-create-rejection";
    const replacement = await reserveKnowledgeBaseTurn(
      {
        userId: 1,
        buildId: build.id,
        clientRequestId: replacementRequestId,
        operationInstanceId: replacementRequestId,
        operationType: "revise",
        expectedGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        expectedPresentationKey: build.currentPresentationKey,
        requestPayload: {
          submissionKind: "logo",
          attachments: [
            { file_id: "replacement-logo", filename: "replacement.png" },
          ],
        },
        apiCredentialId: "credential-1",
        userText: "请使用新 Logo 重新呈现",
        userAttachmentCount: 1,
        expectedAttachmentCount: 3,
        recoveryMetadata: {
          kind: "turn",
          conversationId: build.conversationId,
          parentTaskId: "parent-task",
          manualLogoSubmission: true,
          attachments: [
            { file_id: "replacement-logo", filename: "replacement.png" },
          ],
          officialLogoUpload: {
            index: 0,
            fileId: "replacement-logo",
            filename: "replacement.png",
            mimeType: "image/png",
            sizeBytes: 64,
            sourceSha256: "f".repeat(64),
            verified: false,
          },
          skillVersion: "4",
          skillContentHash: "c".repeat(64),
        },
      },
      executor,
    );
    expect(replacement).toMatchObject({
      state: "acquired",
      turn: {
        clientRequestId: replacementRequestId,
        upstreamTaskId: null,
      },
    });
    expect(replacement.turn.operationKey).not.toBe(
      unacknowledgedTurn.operationKey,
    );
  });
});

describe("knowledge-base deterministic dispatch failure", () => {
  it("settles the active turn once so it is retryable and cannot be recovered forever", async () => {
    const leaseToken = "deterministic-failure-lease";
    const active = retryableFailedTurn({
      status: "running",
      upstreamTaskId: null,
      completedAt: null,
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...(retryableFailedTurn().metadata as Record<string, unknown>),
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        outcomeUnknownAt: "2026-08-01T00:00:05.000Z",
        outcomeUnknownCode: "PREVIOUS_AMBIGUOUS_ATTEMPT",
      },
    });
    const build = {
      id: active.buildId,
      userId: active.userId,
      conversationId: "conversation-1",
      status: "confirming",
      generation: active.buildGeneration,
      stateEpoch: 12,
      revision: active.expectedRevision,
      currentLeafId: active.expectedLeafId,
      activeTurnId: active.id,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
      awaitingResponseSince: new Date("2026-08-01T00:00:00.000Z"),
    };
    const conversation = {
      id: active.conversationId,
      userId: active.userId,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 4,
      status: "running",
    };
    const dynamicActive = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === active.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [active],
      turnSelections: [[dynamicActive], [dynamicActive]],
    });
    const input = {
      userId: active.userId,
      turnId: active.id,
      leaseToken,
      code: "UPSTREAM_CREATE_HTTP_422",
      message: "上游已明确拒绝创建本轮任务，当前内容和附件均已保留；请重试本轮",
      now: new Date("2026-08-01T00:00:20.000Z"),
    };

    const first = await failKnowledgeBaseTurnDeterministically(input, executor);
    const duplicate = await failKnowledgeBaseTurnDeterministically(
      input,
      executor,
    );

    expect(first.deduplicated).toBe(false);
    expect(duplicate.deduplicated).toBe(true);
    expect(store.build).toMatchObject({
      status: "protocol_error",
      stateEpoch: 13,
      protocolErrorCode: "UPSTREAM_CREATE_HTTP_422",
      awaitingResponseSince: null,
      activeTurnId: active.id,
    });
    expect(store.turns[0]).toMatchObject({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_HTTP_422",
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file", "facts-file"],
    });
    expect(store.turns[0]!.metadata).not.toHaveProperty("outcomeUnknownAt");
    expect(store.turns[0]!.metadata).not.toHaveProperty("outcomeUnknownCode");
    expect(store.conversation).toMatchObject({ status: "failed", version: 5 });
  });
});

describe("knowledge-base safe retry reservation", () => {
  it("refreshes the Skill and finalization bundle only at the failed v4 last leaf", () => {
    expect(
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        skillVersion: "4",
        currentLeafId: "7.5",
        totalNodeCount: 50,
        confirmedCount: 49,
        directPrefilledCount: 0,
        operationType: "confirm",
      }),
    ).toBe(true);
    expect(
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        skillVersion: "4",
        currentLeafId: "7.4",
        totalNodeCount: 50,
        confirmedCount: 48,
        directPrefilledCount: 0,
        operationType: "confirm",
      }),
    ).toBe(false);
    expect(
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        skillVersion: "4",
        currentLeafId: "7.5",
        totalNodeCount: 50,
        confirmedCount: 49,
        directPrefilledCount: 0,
        operationType: "revise",
      }),
    ).toBe(false);
  });

  it("accepts a pinned final-delivery Skill upgrade across repeated retries", () => {
    const upgradedHash = "d".repeat(64);
    const source = retryableFailedTurn();
    const recovery = {
      kind: "turn",
      conversationId: "conversation-1",
      parentTaskId: "successful-parent-task",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      skillContentHash: upgradedHash,
      finalPackageRequired: true,
    };
    const requestBody = {
      prompt: "compact final retry prompt",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      taskId: "successful-parent-task",
      attachments: [
        { file_id: "skill-new", filename: "skill.zip" },
        { file_id: "finalization-input", filename: "finalization.zip" },
      ],
    };
    source.attachmentFileIds = ["skill-new", "finalization-input"];
    source.metadata = {
      attachmentsFrozen: true,
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      recovery,
      preparedDispatch: {
        schemaVersion: 1,
        baseUrl: "https://api.example.test",
        requestBody,
        bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
        preparedAt: "2026-08-01T00:00:10.000Z",
      },
    };
    source.requestHash = hashKnowledgeBaseTurnRequest({
      operationType: "confirm",
      generation: 3,
      revision: 7,
      leafId: "1.8",
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      payload: {
        userMessage: recovery.userMessage,
        attachments: recovery.attachments,
        skillVersion: recovery.skillVersion,
        skillContentHash: recovery.skillContentHash,
      },
    });
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      totalNodeCount: 8,
      confirmedCount: 7,
      directPrefilledCount: 0,
    } as any;

    expect(inspectKnowledgeBaseRetryAuthority(source, build)).not.toBeNull();
    (source.metadata as any).recovery.finalPackageRequired = false;
    expect(inspectKnowledgeBaseRetryAuthority(source, build)).toBeNull();
  });

  it("coalesces two tabs, clears the failed task and allocates a new slot per failed attempt", async () => {
    const source = retryableFailedTurn();
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      status: "protocol_error",
      generation: source.buildGeneration,
      stateEpoch: 9,
      revision: source.expectedRevision,
      currentLeafId: source.expectedLeafId,
      activeTurnId: source.id,
      upstreamTaskId: source.upstreamTaskId,
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
      protocolError: "invalid envelope",
    };
    const conversation = {
      id: source.conversationId,
      userId: source.userId,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 5,
      status: "running",
    };
    const dynamicRetry = (current: TurnServiceStore) =>
      current.turns.filter((item) => item.operationType === "retry");
    const dynamicSource = (current: TurnServiceStore) =>
      current.turns.filter((item) => item.id === source.id);
    const dynamicNewestRetry = (current: TurnServiceStore) =>
      current.turns.filter((item) => item.operationType === "retry").slice(-1);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [source],
      turnSelections: [
        [
          dynamicSource,
          dynamicSource,
          [],
          [],
          dynamicSource,
          dynamicNewestRetry,
        ],
        [
          dynamicNewestRetry,
          dynamicSource,
          dynamicNewestRetry,
          dynamicSource,
          [],
          dynamicNewestRetry,
          dynamicNewestRetry,
        ],
        [
          dynamicNewestRetry,
          dynamicNewestRetry,
          [],
          [],
          dynamicNewestRetry,
          dynamicNewestRetry,
        ],
      ],
    });
    const coordinates = {
      userId: 1,
      conversationId: "conversation-1",
      expectedGeneration: 3,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    const first = await reserveKnowledgeBaseRetryTurn(
      { ...coordinates, clientRequestId: "retry-request-a" },
      executor,
    );
    const second = await reserveKnowledgeBaseRetryTurn(
      { ...coordinates, clientRequestId: "retry-request-b" },
      executor,
    );

    expect(first.reservation.state).toBe("acquired");
    expect(first.reservation.turn.id).not.toBe(source.id);
    expect(first.reservation.turn.upstreamTaskId).toBeNull();
    expect(first.reservation.turn.attachmentFileIds).toEqual([]);
    expect(
      store.turns.find((item) => item.id === first.reservation.turn.id)
        ?.metadata,
    ).toMatchObject({ expectedAttachmentCount: 3, userAttachmentCount: 1 });
    expect(first.recoveryMetadata.retryAttachments).toEqual([]);
    expect(first.recoveryMetadata.instructionsAttachmentRequired).toBe(true);
    expect(second.reservation.state).toBe("pending");
    expect(second.reservation.turn.id).toBe(first.reservation.turn.id);
    expect(second.reservation.turn.operationKey).toBe(
      first.reservation.turn.operationKey,
    );
    expect(store.build?.upstreamTaskId).toBeNull();
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: `u1:msg-kb-user-${first.reservation.turn.id}`,
      turnId: first.reservation.turn.id,
      content: "重试本轮",
      metadata: {
        knowledgeBase: {
          serverOwned: true,
          kind: "pending_user",
          clientRequestId: "retry-request-a",
        },
      },
    });
    expect(store.conversation?.version).toBe(6);
    expect(store.turns.find((item) => item.id === source.id)).toMatchObject({
      status: "failed",
      upstreamTaskId: "failed-task-must-not-be-reused",
      errorCode: source.errorCode,
    });
    expect(first.recoveryMetadata).toMatchObject({
      retryOfTurnId: source.id,
      retryParentTaskId: "successful-parent-task",
    });
    expect(JSON.stringify(first.recoveryMetadata)).not.toContain(
      "failed-task-must-not-be-reused",
    );

    const failedRetry = store.turns.find(
      (item) => item.id === first.reservation.turn.id,
    )!;
    failedRetry.status = "failed";
    failedRetry.upstreamTaskId = "failed-retry-task-must-not-be-reused";
    failedRetry.completedAt = new Date("2026-08-01T00:01:00.000Z");
    failedRetry.leaseExpiresAt = null;
    const failedRetryRequestBody = {
      prompt: "retry prompt",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      taskId: "successful-parent-task",
      attachments: [
        {
          file_id: "skill-file",
          filename: "socratic-kb-builder.skill.zip",
        },
        {
          file_id: "instructions-file",
          filename: "frontmind-kb-server-instructions.txt",
        },
        { file_id: "facts-file", filename: "facts.pdf" },
      ],
    };
    failedRetry.attachmentFileIds = [
      "skill-file",
      "instructions-file",
      "facts-file",
    ];
    failedRetry.metadata = {
      ...(failedRetry.metadata || {}),
      attachmentsFrozen: true,
      preparedDispatch: {
        schemaVersion: 1,
        baseUrl: "https://api.example.test",
        requestBody: failedRetryRequestBody,
        bodySha256: hashKnowledgeBaseTurnRequest(failedRetryRequestBody),
        preparedAt: "2026-08-01T00:00:50.000Z",
      },
    };
    store.build = {
      ...store.build,
      status: "protocol_error",
      activeTurnId: failedRetry.id,
      upstreamTaskId: failedRetry.upstreamTaskId,
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
      protocolError: "invalid envelope again",
    };
    const third = await reserveKnowledgeBaseRetryTurn(
      { ...coordinates, clientRequestId: "retry-request-c" },
      executor,
    );
    expect(third.reservation.state).toBe("acquired");
    expect(third.reservation.turn.id).not.toBe(failedRetry.id);
    expect(third.reservation.turn.operationKey).not.toBe(
      failedRetry.operationKey,
    );
    expect(third.reservation.turn.upstreamTaskId).toBeNull();
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]).toMatchObject({
      id: `u1:msg-kb-user-${third.reservation.turn.id}`,
      turnId: third.reservation.turn.id,
      content: "重试本轮",
      metadata: {
        knowledgeBase: {
          clientRequestId: "retry-request-c",
        },
      },
    });
    expect(store.conversation?.version).toBe(7);
    expect(third.recoveryMetadata.retryParentTaskId).toBe(
      "successful-parent-task",
    );
    expect(JSON.stringify(third.recoveryMetadata)).not.toContain(
      "failed-retry-task-must-not-be-reused",
    );
  });
});
