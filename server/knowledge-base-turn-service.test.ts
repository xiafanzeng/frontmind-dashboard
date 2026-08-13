import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetStates,
  messages,
  upstreamResources,
  userUsageOwners,
  type ConversationTurn,
} from "../drizzle/schema";
import {
  activateKnowledgeBaseManusV2Handoff,
  KnowledgeBaseTurnReservationError,
  beginKnowledgeBaseManusV2Dispatch,
  bindKnowledgeBaseManusV2Submission,
  cancelIncompleteKnowledgeBaseStart,
  cancelUnpreparedKnowledgeBaseTurn,
  completeKnowledgeBaseGeneratedAttachment,
  completeKnowledgeBaseManusV2AnchorHandoff,
  claimKnowledgeBaseTerminalAnchorHandoffRecovery,
  createKnowledgeBaseGeneratedAttachmentIdempotencyKey,
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  evaluateKnowledgeBaseTurnReplay,
  failKnowledgeBaseTurnDeterministically,
  finalizeKnowledgeBaseManusV2AttachmentMappings,
  findReusableKnowledgeBaseSkillFileId,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseTurnForRecovery,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  inspectKnowledgeBaseDeferredAttachmentReplay,
  inspectKnowledgeBaseDeferredDispatchReplay,
  inspectKnowledgeBaseLegacyAttachmentTakeoverReplay,
  inspectKnowledgeBaseLegacyDeferredReservationReplay,
  inspectKnowledgeBaseLegacyStartReplay,
  inspectKnowledgeBaseTurnReplay,
  inspectKnowledgeBaseLocalRehydrateRequirement,
  inspectKnowledgeBasePreproviderLocalRehydrateAuthority,
  loadKnowledgeBasePreproviderLocalRehydrateAuthority,
  loadKnowledgeBaseLocalRehydrateSnapshot,
  inspectKnowledgeBaseRetryAuthority,
  inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority,
  knowledgeBaseRetryRequiresFreshFinalDelivery,
  markKnowledgeBaseTurnOutcomeUnknown,
  markKnowledgeBaseManusV2OutcomeUnknown,
  markKnowledgeBaseManusV2AttentionRequired,
  markKnowledgeBaseManusV2CredentialRebindAttention,
  markLegacyKnowledgeBaseCreateAttentionRequired,
  mutateKnowledgeBaseManusV2Lifecycle,
  observeAndLocallySettleKnowledgeBaseTerminalAnchor,
  persistKnowledgeBaseManusV2AttachmentAttempt,
  persistKnowledgeBaseManusV2AttachmentOutcomeUnknown,
  persistKnowledgeBaseManusV2AttachmentMapping,
  prepareKnowledgeBaseTurnDispatch,
  promoteKnowledgeBaseGeneratedAttachmentReady,
  rejectAcknowledgedKnowledgeBaseManualLogoTurn,
  rejectUnacknowledgedKnowledgeBaseManualLogoTurn,
  releaseGeneratedAttachmentInvalidPreproviderTurn,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseNewCanonicalFromSnapshot,
  reserveKnowledgeBaseFailedNotSentLegacyHandoff,
  reserveKnowledgeBaseRetryTurn,
  reserveKnowledgeBaseManusV2AnchorHandoff,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  replaceKnowledgeBaseTurnAttachmentsAfterUserFix,
  resumeKnowledgeBaseTurnAfterUserFix,
  stageAndClaimKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseDeferredTurnAttachment,
  sanitizeKnowledgeBaseRecoveryMetadata,
  settleKnowledgeBaseManusV2ExplicitRejection,
  knowledgeBaseManusV2TerminalRejectionAuthority,
} from "./knowledge-base-turn-service";
import { buildKnowledgeBaseManusV2AnchorErrorRecovery } from "./knowledge-base-manus-v2-lifecycle";
import {
  KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
} from "./knowledge-base-tree-policy-rollout";
import { KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV } from "./knowledge-base-manus-v2-rollout";

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
  nodes: any[];
  usageOwnerId: number | null;
  resetRevision: number;
}

function createTurnServiceExecutor(input: {
  build?: any;
  conversation?: any;
  turns?: ConversationTurn[];
  messages?: any[];
  credentials?: any[];
  tombstones?: any[];
  retainedTombstones?: any[];
  resources?: any[];
  nodes?: any[];
  usageOwnerId?: number | null;
  resetRevision?: number;
  selectAllMessages?: boolean;
  turnSelections: TurnSelection[][];
  failConversationInsertAtTransaction?: number;
}) {
  const store: TurnServiceStore = {
    build: input.build || null,
    conversation: input.conversation || null,
    turns: [...(input.turns || [])],
    messages: structuredClone(input.messages || []),
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
    nodes: structuredClone(input.nodes || []),
    usageOwnerId: input.usageOwnerId ?? null,
    resetRevision: input.resetRevision ?? 0,
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
        if (table === knowledgeBaseResetStates) {
          return [{ userId: 1, revision: store.resetRevision }];
        }
        if (table === messages) {
          if (input.selectAllMessages) return store.messages;
          const isIdentityLookup = messageSelectionIndex++ % 2 === 0;
          if (!isIdentityLookup) return store.messages;
          const latestTurn = store.turns.at(-1);
          const expectedId = latestTurn
            ? `u${latestTurn.userId}:msg-kb-user-${latestTurn.id}`
            : "";
          return store.messages.filter((message) => message.id === expectedId);
        }
        if (table === knowledgeBaseBuildNodes) {
          return store.nodes;
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
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(selected(table, condition, options)).then(
            resolve,
            reject,
          ),
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
        orderBy: () => {
          const ordered = () =>
            [...selected(table)].sort((left: any, right: any) => {
              if (typeof left.ordinal === "number") {
                return left.ordinal - right.ordinal;
              }
              return right.sequence - left.sequence;
            });
          return {
            limit: async () => ordered(),
            then: (
              resolve: (value: unknown) => unknown,
              reject: (reason: unknown) => unknown,
            ) => Promise.resolve(ordered()).then(resolve, reject),
          };
        },
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
            } else if (table === knowledgeBaseResetStates) {
              store.resetRevision = Number(values.revision ?? 0);
            } else if (table === knowledgeBaseConversationRetentionTombstones) {
              store.retainedTombstones.push(values);
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
              return [{ affectedRows: 1 }];
            },
          }),
        }),
        delete: (table: unknown) => ({
          where: async () => {
            if (table === knowledgeBaseBuilds) {
              store.build = null;
              store.nodes = [];
              store.turns = store.turns.map((candidate) => ({
                ...candidate,
                buildId: null,
              }));
            } else if (table === conversations) {
              store.conversation = null;
              store.messages = [];
              store.turns = [];
            }
            return [{ affectedRows: 1 }];
          },
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
        store.nodes = snapshot.nodes;
        store.usageOwnerId = snapshot.usageOwnerId;
        store.resetRevision = snapshot.resetRevision;
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
      failureClass: "terminal_requires_regeneration",
      recoveryAction: "regenerate_turn",
      canRegenerate: true,
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

function failedNotSentLegacyHandoffTurn(
  overrides: Partial<ConversationTurn> = {},
) {
  const operationKey = createKnowledgeBaseOperationKey({
    buildId: identity.buildId,
    buildGeneration: 3,
    operationType: "confirm",
    expectedRevision: 7,
    expectedLeafId: "1.8",
  });
  const recovery = {
    kind: "turn",
    conversationId: "conversation-1",
    parentTaskId: "legacy-main-task",
    userMessage: "确认",
    attachments: [] as Array<{ file_id: string; filename: string }>,
    attachmentManifest: [] as unknown[],
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
  };
  const requestBody = {
    prompt: "historical prompt that was never sent",
    agentProfile: "frontmind-pro",
    taskMode: "agent" as const,
    taskId: "legacy-main-task",
    attachments: [
      { file_id: "stale-skill-file", filename: "skill.zip" },
      {
        file_id: "stale-instructions-file",
        filename: "instructions.txt",
      },
    ],
  };
  return turn({
    operationKey,
    requestHash: hashKnowledgeBaseTurnRequest({
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
    }),
    upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    ),
    status: "failed",
    upstreamTaskId: null,
    leaseExpiresAt: null,
    completedAt: new Date("2026-08-01T00:00:20.000Z"),
    attachmentFileIds: requestBody.attachments.map((item) => item.file_id),
    metadata: {
      attachmentsFrozen: true,
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      createAttemptState: "not_sent",
      providerProtocol: "legacy_v1",
      providerAttemptState: "not_sent",
      dispatchState: "failed",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      canRegenerate: false,
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
}

describe("failed not-sent legacy business handoff", () => {
  function legacyBuild(source: ConversationTurn) {
    return {
      id: identity.buildId,
      userId: 1,
      conversationId: "conversation-1",
      companyName: "Example",
      companyWebsite: null,
      upstreamTaskId: "legacy-main-task",
      providerProtocol: "legacy_v1",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "unbound",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      handoffProvenance: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      skillArchiveSha256: null,
      skillArchiveBytes: null,
      skillArchiveStorageKey: null,
      treePolicyVersion: 2,
      status: "protocol_error",
      generation: 3,
      stateEpoch: 7,
      revision: 7,
      currentLeafId: "1.8",
      activeTurnId: source.id,
      protocolErrorCode: "SKILL_FILE_404",
      protocolError: "historical local failure",
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      totalNodeCount: 40,
      confirmedCount: 7,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:20.000Z"),
      completedAt: null,
      publishedAt: null,
    } as any;
  }

  const localProof = async () => [];

  it("proves only exact never-sent history and rejects sending/unknown state", () => {
    const source = failedNotSentLegacyHandoffTurn();
    const build = legacyBuild(source);
    expect(
      inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(source, build),
    ).not.toBeNull();
    for (const metadataPatch of [
      { createAttemptState: "sending", providerAttemptState: "sending" },
      {
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        outcomeUnknownAt: "2026-08-01T00:00:10.000Z",
      },
      {
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
      },
    ]) {
      const candidate = {
        ...source,
        metadata: { ...(source.metadata as object), ...metadataPatch },
      } as ConversationTurn;
      expect(
        inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(
          candidate,
          build,
        ),
      ).toBeNull();
    }
  });

  it("creates one hidden replacement with no second customer message or charge", async () => {
    const source = failedNotSentLegacyHandoffTurn();
    const build = legacyBuild(source);
    const conversation = {
      id: source.conversationId,
      userId: source.userId,
      apiCredentialId: source.apiCredentialId,
      projectAssignmentId: null,
      status: "failed",
      version: 9,
      deletedAt: null,
      deletedMessageIds: [],
    };
    const sourceSelection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === source.id);
    const harness = createTurnServiceExecutor({
      build,
      conversation,
      turns: [source],
      turnSelections: [[sourceSelection, sourceSelection]],
    });
    const serviceDb = {
      ...harness.executor,
      select: (...args: any[]) => {
        const projection = args[0];
        return {
          from: (table: unknown) => ({
            where: () => ({
              limit: async () =>
                table === knowledgeBaseBuilds
                  ? [harness.store.build]
                  : projection === undefined
                    ? [harness.store.turns[0]]
                    : [],
            }),
          }),
        };
      },
    };
    const result = await reserveKnowledgeBaseFailedNotSentLegacyHandoff(
      {
        userId: 1,
        buildId: build.id,
        sourceTurnId: source.id,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      serviceDb,
      { proveLocalSources: localProof as any },
    );

    expect(result.state).toBe("reserved");
    expect(harness.store.turns).toHaveLength(2);
    expect(harness.store.messages).toEqual([]);
    expect(harness.store.turns[0]).toMatchObject({
      status: "cancelled",
      metadata: { supersededReason: "legacy_failed_not_sent_handoff" },
    });
    expect(harness.store.turns[1]).toMatchObject({
      operationType: "confirm",
      status: "queued",
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        repairKind: "legacy_failed_not_sent_handoff",
        hiddenReplacement: true,
        chargeDisposition: "reuse_original_no_charge",
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
      },
    });
    expect(harness.store.build).toMatchObject({
      activeTurnId: result.replacementTurnId,
      providerProtocol: "legacy_v1",
      status: "confirming",
    });

    const replay = await reserveKnowledgeBaseFailedNotSentLegacyHandoff(
      {
        userId: 1,
        buildId: build.id,
        sourceTurnId: source.id,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
      },
      serviceDb,
      {
        proveLocalSources: async () => {
          throw new Error("a duplicate worker must not repeat local proof");
        },
      },
    );
    expect(replay).toEqual({
      state: "already_reserved",
      sourceTurnId: source.id,
      replacementTurnId: result.replacementTurnId,
      buildId: build.id,
    });
    expect(harness.store.turns).toHaveLength(2);
    expect(harness.store.messages).toEqual([]);
  });

  it("uses one current credential and generation+1 when the never-sent pinned credential was deleted", async () => {
    const source = failedNotSentLegacyHandoffTurn();
    const build = legacyBuild(source);
    const sourceSelection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === source.id);
    const harness = createTurnServiceExecutor({
      build,
      conversation: {
        id: source.conversationId,
        userId: source.userId,
        apiCredentialId: source.apiCredentialId,
        projectAssignmentId: null,
        status: "failed",
        version: 9,
        deletedAt: null,
        deletedMessageIds: [],
      },
      turns: [source],
      credentials: [
        { id: "credential-1", userId: 1, status: "deleted" },
        { id: "credential-current", userId: 1, status: "active" },
      ],
      turnSelections: [[sourceSelection, sourceSelection]],
    });
    const serviceDb = {
      ...harness.executor,
      select: (...args: any[]) => {
        const projection = args[0];
        return {
          from: (table: unknown) => ({
            where: () => ({
              limit: async () =>
                table === knowledgeBaseBuilds
                  ? [harness.store.build]
                  : projection === undefined
                    ? [harness.store.turns[0]]
                    : [],
            }),
          }),
        };
      },
    };

    const result = await reserveKnowledgeBaseFailedNotSentLegacyHandoff(
      {
        userId: 1,
        buildId: build.id,
        sourceTurnId: source.id,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        replacementCredentialId: "credential-current",
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      serviceDb,
      { proveLocalSources: localProof as any },
    );

    expect(result.state).toBe("reserved");
    expect(harness.store.turns[0]).toMatchObject({
      status: "cancelled",
      buildGeneration: 3,
    });
    expect(harness.store.turns[1]).toMatchObject({
      apiCredentialId: "credential-current",
      buildGeneration: 4,
      upstreamTaskId: null,
      metadata: {
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        receiptSourceGeneration: 3,
        credentialRebound: true,
      },
    });
    expect(harness.store.build).toMatchObject({
      generation: 4,
      activeTurnId: result.replacementTurnId,
      providerProtocol: "legacy_v1",
      handoffProvenance: {
        sourceGeneration: 3,
        targetGeneration: 4,
        receiptSourceGeneration: 3,
      },
    });
    expect(harness.store.conversation).toMatchObject({
      apiCredentialId: "credential-current",
      status: "running",
    });
  });
});

describe("generated attachment invalid pre-provider release", () => {
  function fixture(metadataPatch: Record<string, unknown> = {}) {
    const source = turn({
      status: "failed",
      errorCode: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
      completedAt: new Date("2026-08-01T00:00:20.000Z"),
      leaseExpiresAt: null,
      upstreamTaskId: null,
      attachmentFileIds: ["stale-skill", "stale-instructions"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        createAttemptState: "not_sent",
        providerProtocol: "legacy_v1",
        providerAttemptState: "not_sent",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          userMessage: "确认",
          attachments: [],
        },
        generatedAttachmentReservations: {
          "skill:0": { status: "ready" },
        },
        ...metadataPatch,
      },
    });
    const content = "## 1.8 当前节点\n\n正文保持不变";
    const contentSha256 = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const presentationKey = createHash("sha256")
      .update(
        [
          source.buildId,
          source.buildGeneration,
          source.expectedRevision,
          source.expectedLeafId,
          contentSha256,
        ].join(":"),
      )
      .digest("hex");
    const build = {
      id: source.buildId,
      userId: 1,
      conversationId: "conversation-1",
      upstreamTaskId: "legacy-main-task",
      providerProtocol: "legacy_v1",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "unbound",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      handoffProvenance: null,
      status: "protocol_error",
      generation: source.buildGeneration,
      stateEpoch: 9,
      revision: source.expectedRevision,
      currentLeafId: source.expectedLeafId,
      currentPresentationKey: presentationKey,
      activeTurnId: source.id,
      protocolErrorCode: source.errorCode,
      protocolError: "generated attachment invalid",
      awaitingResponseSince: null,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      totalNodeCount: 1,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
    } as any;
    const node = {
      id: "node-1",
      buildId: source.buildId,
      leafId: source.expectedLeafId,
      status: "current",
      contentMarkdown: content,
      contentSha256,
      presentationKey,
      sourceTurnId: "prior-completed-turn",
    };
    const conversation = {
      id: source.conversationId,
      userId: source.userId,
      projectAssignmentId: null,
      deletedAt: null,
      status: "failed",
      version: 3,
      deletedMessageIds: [],
    };
    const selection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === source.id);
    return { source, build, node, conversation, selection };
  }

  it("locally settles the exact not-sent failure without changing accepted state", async () => {
    const value = fixture();
    const { executor, store } = createTurnServiceExecutor({
      build: value.build,
      conversation: value.conversation,
      turns: [value.source],
      nodes: [value.node],
      turnSelections: [[value.selection, value.selection]],
    });
    const before = {
      revision: store.build.revision,
      leaf: store.build.currentLeafId,
      presentation: store.build.currentPresentationKey,
      counts: [
        store.build.totalNodeCount,
        store.build.confirmedCount,
        store.build.directPrefilledCount,
        store.build.needsVerificationCount,
      ],
      nodes: structuredClone(store.nodes),
    };
    await expect(
      releaseGeneratedAttachmentInvalidPreproviderTurn(
        { turnId: value.source.id },
        executor,
      ),
    ).resolves.toBe(true);
    expect(store.build).toMatchObject({
      status: "confirming",
      upstreamTaskId: null,
      providerProtocol: "manus_v2",
      canonicalTaskState: "unbound",
      activeTurnId: null,
      protocolErrorCode: null,
      revision: before.revision,
      currentLeafId: before.leaf,
      currentPresentationKey: before.presentation,
      handoffProvenance: {
        legacyTaskIdSha256: createHash("sha256")
          .update("legacy-main-task")
          .digest("hex"),
      },
    });
    expect([
      store.build.totalNodeCount,
      store.build.confirmedCount,
      store.build.directPrefilledCount,
      store.build.needsVerificationCount,
    ]).toEqual(before.counts);
    expect(store.nodes).toEqual(before.nodes);
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        localPreproviderRelease: true,
        generatedAttachmentReservations: {},
        localRehydrateRequired: {
          sourceTurnId: value.source.id,
          presentationKey: before.presentation,
        },
      },
    });
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      version: 4,
    });

    expect(
      inspectKnowledgeBasePreproviderLocalRehydrateAuthority(
        store.build,
        store.turns[0]!,
      ),
    ).toEqual({
      kind: "failed_confirm_preprovider_release",
      sourceTurnId: value.source.id,
      generation: value.source.buildGeneration,
      revision: before.revision,
      leafId: before.leaf,
      presentationKey: before.presentation,
    });
  });

  it("reproves the released source before ordinary confirm may create a new canonical task", async () => {
    const value = fixture();
    const harness = createTurnServiceExecutor({
      build: value.build,
      conversation: value.conversation,
      turns: [value.source],
      nodes: [value.node],
      turnSelections: [[value.selection, value.selection]],
    });
    await releaseGeneratedAttachmentInvalidPreproviderTurn(
      { turnId: value.source.id },
      harness.executor,
    );
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [harness.store.turns[0]] }),
        }),
      }),
    };
    await expect(
      loadKnowledgeBasePreproviderLocalRehydrateAuthority(
        { userId: 1, build: harness.store.build },
        db,
      ),
    ).resolves.toMatchObject({
      kind: "failed_confirm_preprovider_release",
      sourceTurnId: value.source.id,
    });

    harness.store.build.currentPresentationKey = "presentation-drifted";
    await expect(
      loadKnowledgeBasePreproviderLocalRehydrateAuthority(
        { userId: 1, build: harness.store.build },
        db,
      ),
    ).resolves.toBeNull();
  });

  it("reserves one current-credential v2 create from the released coordinate without a second charge", async () => {
    const value = fixture();
    const sourceSelection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === value.source.id);
    const noExistingTurn = () => [];
    const harness = createTurnServiceExecutor({
      build: value.build,
      conversation: value.conversation,
      turns: [value.source],
      nodes: [value.node],
      credentials: [{ id: "credential-current", userId: 1, status: "active" }],
      turnSelections: [
        [sourceSelection, sourceSelection],
        [noExistingTurn, noExistingTurn, noExistingTurn, sourceSelection],
      ],
    });
    await releaseGeneratedAttachmentInvalidPreproviderTurn(
      { turnId: value.source.id },
      harness.executor,
    );
    const result = await reserveKnowledgeBaseTurn(
      {
        userId: 1,
        buildId: value.build.id,
        clientRequestId: "ordinary-confirm-after-release",
        operationType: "confirm",
        expectedGeneration: value.build.generation,
        expectedRevision: value.build.revision,
        expectedLeafId: value.build.currentLeafId,
        expectedPresentationKey: value.build.currentPresentationKey,
        requestPayload: { userMessage: "确认", attachments: [] },
        apiCredentialId: "credential-current",
        userText: "确认",
        userAttachmentCount: 0,
        expectedAttachmentCount: 2,
        recoveryMetadata: {
          kind: "turn",
          conversationId: value.build.conversationId,
          parentTaskId: null,
          localRehydrateAuthority: "local_rehydrate_unbound",
          chargeDisposition: "reuse_original_no_charge",
          userMessage: "确认",
          attachments: [],
          skillVersion: "4",
          skillContentHash: "c".repeat(64),
        },
      },
      harness.executor,
    );

    expect(result.state).toBe("acquired");
    expect(harness.store.turns).toHaveLength(2);
    expect(harness.store.turns[0]).toMatchObject({ status: "cancelled" });
    expect(harness.store.turns[1]).toMatchObject({
      apiCredentialId: "credential-current",
      upstreamTaskId: null,
      status: "queued",
      metadata: {
        providerProtocol: "manus_v2",
        createAttemptState: "not_sent",
        recovery: {
          parentTaskId: null,
          localRehydrateAuthority: "local_rehydrate_unbound",
          chargeDisposition: "reuse_original_no_charge",
        },
      },
    });
    expect(harness.store.build).toMatchObject({
      providerProtocol: "manus_v2",
      canonicalTaskId: null,
      canonicalTaskState: "unbound",
      activeTurnId: harness.store.turns[1]!.id,
    });
  });

  it("grants task.create only once for the reserved unbound continuation", async () => {
    const leaseToken = "local-rehydrate-create-lease";
    const active = turn({
      status: "queued",
      upstreamTaskId: null,
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 0,
        userAttachmentCount: 0,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "not_sent",
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
        operationToken: "operation-after-release",
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          parentTaskId: null,
          localRehydrateAuthority: "local_rehydrate_unbound",
        },
      },
    });
    const releasedMarker = {
      schemaVersion: 1,
      reason: "generated_attachment_invalid_preprovider",
      buildId: active.buildId,
      generation: active.buildGeneration,
      revision: active.expectedRevision,
      leafId: active.expectedLeafId,
      presentationKey: "presentation-7",
      sourceTurnId: "released-source-turn",
      releasedAt: "2026-08-01T00:01:00.000Z",
    };
    const harness = createTurnServiceExecutor({
      build: {
        ...fixture().build,
        id: active.buildId,
        activeTurnId: active.id,
        providerProtocol: "manus_v2",
        canonicalTaskState: "unbound",
        handoffProvenance: { localRehydrateRequired: releasedMarker },
      },
      conversation: {
        id: active.conversationId,
        userId: active.userId,
        projectAssignmentId: null,
      },
      turns: [active],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });

    await expect(
      beginKnowledgeBaseManusV2Dispatch(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          frozenProviderRequestHash: "a".repeat(64),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ method: "task.create", canonicalTaskId: null });
    expect(harness.store.build).toMatchObject({
      canonicalTaskState: "creating",
      canonicalTaskGeneration: active.buildGeneration,
      canonicalCredentialId: active.apiCredentialId,
    });

    await expect(
      beginKnowledgeBaseManusV2Dispatch(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          frozenProviderRequestHash: "a".repeat(64),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PENDING" });
  });

  it("settles a historical explicit not-sent row whose provider projection was absent", async () => {
    const value = fixture();
    delete (value.source.metadata as Record<string, unknown>)
      .providerAttemptState;
    const { executor, store } = createTurnServiceExecutor({
      build: value.build,
      conversation: value.conversation,
      turns: [value.source],
      nodes: [value.node],
      turnSelections: [[value.selection, value.selection]],
    });
    await expect(
      releaseGeneratedAttachmentInvalidPreproviderTurn(
        { turnId: value.source.id },
        executor,
      ),
    ).resolves.toBe(true);
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      metadata: {
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        localPreproviderRelease: true,
      },
    });
  });

  it("refuses local release when the scoped message ledger already has a completion receipt", async () => {
    const value = fixture();
    const { executor, store } = createTurnServiceExecutor({
      build: value.build,
      conversation: value.conversation,
      turns: [value.source],
      nodes: [value.node],
      messages: [
        {
          id: "completion-message",
          userId: value.source.userId,
          conversationId: `u${value.source.userId}:${value.build.conversationId}`,
          turnId: value.source.id,
          role: "assistant",
          deletedAt: null,
          metadata: {
            knowledgeBase: { serverOwned: true, kind: "completion" },
          },
        },
      ],
      selectAllMessages: true,
      turnSelections: [[value.selection, value.selection]],
    });

    await expect(
      releaseGeneratedAttachmentInvalidPreproviderTurn(
        { turnId: value.source.id },
        executor,
      ),
    ).resolves.toBe(false);
    expect(store.build.activeTurnId).toBe(value.source.id);
    expect(store.turns[0]?.status).toBe("failed");
  });

  it.each([
    ["wrong code", {}, { errorCode: "UPSTREAM_CREATE_3" }],
    [
      "sending",
      {
        createAttemptState: "sending",
        providerAttemptState: "sending",
        dispatchingAt: "2026-08-01T00:00:10.000Z",
      },
      {},
    ],
    [
      "unknown",
      {
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        outcomeUnknownAt: "2026-08-01T00:00:10.000Z",
      },
      {},
    ],
    [
      "acknowledged",
      {
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
      },
      {},
    ],
    ["prepared request", { preparedDispatch: { schemaVersion: 1 } }, {}],
  ])(
    "rejects %s without mutating it",
    async (_label, metadataPatch, turnPatch) => {
      const value = fixture(metadataPatch);
      Object.assign(value.source, turnPatch);
      const { executor, store } = createTurnServiceExecutor({
        build: value.build,
        conversation: value.conversation,
        turns: [value.source],
        nodes: [value.node],
        turnSelections: [[value.selection, value.selection]],
      });
      const before = structuredClone(store);
      await expect(
        releaseGeneratedAttachmentInvalidPreproviderTurn(
          { turnId: value.source.id },
          executor,
        ),
      ).resolves.toBe(false);
      expect(store).toEqual(before);
    },
  );
});

describe("Manus v2 canonical task writer fence", () => {
  it("classifies durable credential and generic provider rejections as terminal", () => {
    expect(
      knowledgeBaseManusV2TerminalRejectionAuthority({
        providerCode: "permission_denied",
        providerStatus: 403,
      }),
    ).toMatchObject({
      failureClass: "requires_user_fix",
      recoveryAction: "update_credential",
    });
    expect(
      knowledgeBaseManusV2TerminalRejectionAuthority({
        attachmentAttempts: {
          skill: { code: "MANUS_V2_FILE_CREATE_PERMISSION_DENIED" },
        },
      }),
    ).toMatchObject({
      failureClass: "requires_user_fix",
      recoveryAction: "update_credential",
    });
    expect(
      knowledgeBaseManusV2TerminalRejectionAuthority({
        providerCode: "invalid_request",
        providerStatus: 422,
      }),
    ).toMatchObject({
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
    });
  });
  const build = (overrides: Record<string, unknown> = {}) => ({
    id: identity.buildId,
    userId: 1,
    conversationId: "conversation-1",
    companyName: "Example",
    companyWebsite: null,
    upstreamTaskId: null,
    providerProtocol: "manus_v2",
    canonicalTaskId: null,
    canonicalTaskGeneration: null,
    canonicalCredentialId: null,
    canonicalTaskState: "unbound",
    canonicalTaskUrl: null,
    canonicalTaskCreatedAt: null,
    handoffProvenance: null,
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
    treePolicyVersion: 2,
    initialResearchCoverage: null,
    status: "confirming",
    generation: 3,
    stateEpoch: 7,
    activeTurnId: "00000000-0000-4000-8000-000000000001",
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    lastAppliedOperationKey: null,
    currentPresentationKey: "presentation-7",
    revision: 7,
    currentLeafId: "1.8",
    totalNodeCount: 30,
    confirmedCount: 7,
    directPrefilledCount: 0,
    needsVerificationCount: 0,
    lastReconciledHash: null,
    lastOutputLength: 0,
    lastOutputItemIds: [],
    lastTurnUserText: null,
    lastTurnAttachmentCount: 0,
    awaitingResponseSince: null,
    packageRevision: null,
    packageTaskId: null,
    packageOutputItemId: null,
    packageFileId: null,
    packageFilename: null,
    packageDescriptorHash: null,
    skillArchiveSha256: null,
    skillArchiveBytes: null,
    skillArchiveStorageKey: null,
    contentCompletedAt: null,
    packageStatus: "not_started",
    packageAttemptCount: 0,
    packageNextRetryAt: null,
    packageLastErrorCode: null,
    logoStorageKey: null,
    logoSha256: null,
    logoBytes: null,
    logoFilename: null,
    logoMimeType: null,
    packageStorageKey: null,
    packageArchiveSha256: null,
    packageSizeBytes: null,
    protocolErrorCode: null,
    protocolError: null,
    publishedSnapshotId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    completedAt: null,
    publishedAt: null,
    ...overrides,
  });

  it("does not retry a rejected local rehydrate and exposes only the customer-authorized new-task action", async () => {
    const leaseToken = "local-rehydrate-rejection-lease";
    const active = turn({
      status: "running",
      upstreamTaskId: "canonical-task",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256").update(leaseToken).digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "sending",
        createAttemptState: "acknowledged",
        frozenProviderRequestHash: "f".repeat(64),
        operationToken: "operation-1",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
        handoffProvenance: {
          localRehydrateRequired: {
            schemaVersion: 1,
            sourceTurnId: "00000000-0000-4000-8000-000000000003",
            snapshotSha256: "c".repeat(64),
            taskIdSha256: createHash("sha256")
              .update("canonical-task")
              .digest("hex"),
            generation: 3,
            revision: 7,
            leafId: "1.8",
          },
        },
      }),
      conversation: {
        id: active.conversationId,
        userId: active.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turns: [active],
      turnSelections: [[(store) => store.turns, (store) => store.turns]],
    });

    await expect(
      settleKnowledgeBaseManusV2ExplicitRejection(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          code: "MANUS_V2_SEND_REJECTED",
          retryable: true,
          now: new Date("2026-08-13T00:02:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ retryScheduled: false, attempt: 1 });
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      metadata: {
        providerAttemptState: "rejected",
        failureClass: "requires_user_fix",
        recoveryAction: "create_new_canonical_from_snapshot",
      },
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
      activeTurnId: active.id,
    });
  });

  it("reserves an idle legacy anchor without changing accepted nodes or messages", async () => {
    const acceptedNodes = [
      {
        leafId: "1.8",
        branchId: "1",
        branchTitle: "Facts",
        title: "Accepted fact",
        ordinal: 8,
        status: "confirmed",
        contentMarkdown: "durable accepted content",
        contentSha256: "d".repeat(64),
        lastUserInput: "确认",
        sourceUrls: ["https://example.test/source"],
        imageUrls: [],
      },
    ];
    const harness = createTurnServiceExecutor({
      build: build({
        providerProtocol: "legacy_v1",
        upstreamTaskId: "legacy-task",
        activeTurnId: null,
      }),
      conversation: {
        id: "u1:conversation-1",
        userId: 1,
        apiCredentialId: "credential-1",
        projectAssignmentId: null,
        status: "awaiting_input",
        version: 4,
        deletedAt: null,
      },
      credentials: [{ id: "credential-1", userId: 1, status: "retired" }],
      resources: [
        {
          id: "resource-legacy",
          userId: 1,
          projectAssignmentId: null,
          kind: "task",
          upstreamId: "legacy-task",
          apiCredentialId: "credential-1",
        },
      ],
      nodes: acceptedNodes,
      turnSelections: [[]],
    });
    const beforeNodes = structuredClone(harness.store.nodes);
    const beforeMessages = structuredClone(harness.store.messages);

    const reservation = await reserveKnowledgeBaseManusV2AnchorHandoff(
      {
        userId: 1,
        buildId: identity.buildId,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        expectedLegacyTaskId: "legacy-task",
        apiCredentialId: "credential-1",
        credentialMode: "legacy_task_owner",
        baseUrl: "https://api.example.test",
        agentProfile: "frontmind-pro",
        now: new Date("2026-08-01T00:00:30.000Z"),
        leaseMs: 300_000,
      },
      harness.executor,
    );

    expect(reservation.recoveryMetadata).toMatchObject({
      kind: "legacy_anchor_handoff",
      sourceGeneration: 3,
      targetGeneration: 3,
      credentialMode: "legacy_task_owner",
    });
    expect(reservation.turn).toMatchObject({
      providerProtocol: "manus_v2",
      providerAttemptState: "not_sent",
    });
    expect(reservation.turn.attachmentFileIds).toEqual([]);
    expect(reservation.snapshot.nodes).toEqual(acceptedNodes);
    expect(reservation.snapshot.acceptedReceipts).toEqual([]);
    expect(harness.store.nodes).toEqual(beforeNodes);
    expect(harness.store.messages).toEqual(beforeMessages);
    expect(harness.store.turns).toHaveLength(1);
    expect(harness.store.build).toMatchObject({
      providerProtocol: "manus_v2",
      activeTurnId: reservation.turn.id,
      canonicalTaskId: null,
      canonicalTaskState: "unbound",
      revision: 7,
      currentLeafId: "1.8",
      totalNodeCount: 30,
      confirmedCount: 7,
    });
  });

  it.each([null, "project-1"])(
    "rebinds one idle v2 build from a deleted canonical credential in project scope %s",
    async (projectAssignmentId) => {
      const oldTaskId = "old-canonical-task";
      const oldCredentialId = "old-credential";
      const replacementCredentialId = "replacement-credential";
      const sourceTurn = turn({
        id: "00000000-0000-4000-8000-000000000099",
        apiCredentialId: oldCredentialId,
        clientRequestId: "accepted-request",
        buildGeneration: 3,
        operationKey: "accepted-operation",
        expectedRevision: 7,
        expectedLeafId: "1.8",
        status: "completed",
        upstreamTaskId: oldTaskId,
        completedAt: new Date("2026-08-01T00:00:10.000Z"),
      });
      const content = "## 1.8 Accepted fact\n\nDurable accepted content.";
      const contentSha256 = createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
      const presentationKey = createHash("sha256")
        .update(
          [identity.buildId, 3, 7, "1.8", contentSha256].join(":"),
          "utf8",
        )
        .digest("hex");
      const acceptedMessage = {
        id: `u1:msg-kb-presentation-${presentationKey}`,
        conversationId: "u1:conversation-1",
        userId: 1,
        turnId: sourceTurn.id,
        role: "assistant",
        content,
        sequence: 18,
        deletedAt: null,
        metadata: {
          knowledgeBase: {
            schemaVersion: 1,
            kind: "presentation",
            buildId: identity.buildId,
            operationKey: sourceTurn.operationKey,
            turnId: sourceTurn.id,
            presentationKey,
            contentSha256,
            generation: 3,
            revision: 7,
            leafId: "1.8",
            serverOwned: true,
          },
        },
      };
      const acceptedNodes = [
        {
          leafId: "1.8",
          branchId: "1",
          branchTitle: "Facts",
          title: "Accepted fact",
          ordinal: 8,
          status: "confirmed",
          contentMarkdown: content,
          contentSha256,
          lastUserInput: "确认",
          sourceUrls: [],
          imageUrls: [],
        },
      ];
      const harness = createTurnServiceExecutor({
        build: build({
          upstreamTaskId: oldTaskId,
          canonicalTaskId: oldTaskId,
          canonicalTaskGeneration: 3,
          canonicalCredentialId: oldCredentialId,
          canonicalTaskState: "active",
          canonicalTaskUrl: `https://manus.example/${oldTaskId}`,
          activeTurnId: null,
        }),
        conversation: {
          id: "u1:conversation-1",
          userId: 1,
          apiCredentialId: oldCredentialId,
          projectAssignmentId,
          status: "awaiting_input",
          version: 4,
          deletedAt: null,
        },
        turns: [sourceTurn],
        messages: [acceptedMessage],
        selectAllMessages: true,
        credentials: [
          { id: oldCredentialId, userId: 1, status: "deleted" },
          { id: replacementCredentialId, userId: 1, status: "active" },
        ],
        resources: [
          {
            id: "old-task-resource",
            userId: 1,
            projectAssignmentId,
            kind: "task",
            upstreamId: oldTaskId,
            apiCredentialId: oldCredentialId,
          },
        ],
        nodes: acceptedNodes,
        turnSelections: [[() => [sourceTurn]]],
      });
      const beforeMessage = structuredClone(acceptedMessage);
      const beforeNode = structuredClone(acceptedNodes[0]);

      const reservation = await reserveKnowledgeBaseManusV2AnchorHandoff(
        {
          userId: 1,
          buildId: identity.buildId,
          expectedGeneration: 3,
          expectedStateEpoch: 7,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          expectedLegacyTaskId: null,
          sourceProtocol: "manus_v2",
          expectedCanonicalTaskId: oldTaskId,
          expectedCanonicalCredentialId: oldCredentialId,
          apiCredentialId: replacementCredentialId,
          credentialMode: "current_rebind",
          baseUrl: "https://api.example.test",
          agentProfile: "frontmind-pro",
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        harness.executor,
      );

      expect(reservation).toMatchObject({
        sourceGeneration: 3,
        targetGeneration: 4,
        turn: {
          buildGeneration: 4,
          providerProtocol: "manus_v2",
          providerAttemptState: "not_sent",
        },
        recoveryMetadata: {
          kind: "canonical_credential_rebind",
          sourceProtocol: "manus_v2",
          sourceGeneration: 3,
          targetGeneration: 4,
          credentialMode: "current_rebind",
        },
        snapshot: {
          purpose: "manus_v2_credential_rebind_anchor_handoff",
          source: {
            providerProtocol: "manus_v2",
            generation: 3,
            targetGeneration: 4,
          },
          acceptedReceipts: [
            expect.objectContaining({
              sequence: 18,
              turnId: sourceTurn.id,
              content,
            }),
          ],
        },
      });
      expect(harness.store.build).toMatchObject({
        providerProtocol: "manus_v2",
        generation: 4,
        activeTurnId: reservation.turn.id,
        canonicalTaskId: null,
        canonicalTaskGeneration: null,
        canonicalCredentialId: null,
        canonicalTaskState: "unbound",
        upstreamTaskId: oldTaskId,
        handoffProvenance: {
          sourceProtocol: "manus_v2",
          sourceGeneration: 3,
          targetGeneration: 4,
          receiptSourceGeneration: 3,
        },
      });
      expect(harness.store.resources).toEqual([
        expect.objectContaining({
          upstreamId: oldTaskId,
          apiCredentialId: oldCredentialId,
        }),
      ]);
      expect(harness.store.messages).toEqual([beforeMessage]);
      expect(harness.store.nodes).toEqual([beforeNode]);
    },
  );

  it("rejects a v2 credential rebind when the task resource belongs to another project", async () => {
    const oldTaskId = "old-canonical-task";
    const oldCredentialId = "old-credential";
    const harness = createTurnServiceExecutor({
      build: build({
        upstreamTaskId: oldTaskId,
        canonicalTaskId: oldTaskId,
        canonicalTaskGeneration: 3,
        canonicalCredentialId: oldCredentialId,
        canonicalTaskState: "active",
        activeTurnId: null,
      }),
      conversation: {
        id: "u1:conversation-1",
        userId: 1,
        projectAssignmentId: "project-1",
        status: "awaiting_input",
        deletedAt: null,
      },
      credentials: [
        { id: oldCredentialId, userId: 1, status: "deleted" },
        { id: "replacement-credential", userId: 1, status: "active" },
      ],
      resources: [
        {
          id: "old-task-resource",
          userId: 1,
          projectAssignmentId: "project-other",
          kind: "task",
          upstreamId: oldTaskId,
          apiCredentialId: oldCredentialId,
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      reserveKnowledgeBaseManusV2AnchorHandoff(
        {
          userId: 1,
          buildId: identity.buildId,
          expectedGeneration: 3,
          expectedStateEpoch: 7,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          expectedLegacyTaskId: null,
          sourceProtocol: "manus_v2",
          expectedCanonicalTaskId: oldTaskId,
          expectedCanonicalCredentialId: oldCredentialId,
          apiCredentialId: "replacement-credential",
          credentialMode: "current_rebind",
          baseUrl: "https://api.example.test",
          agentProfile: "frontmind-pro",
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.build).toMatchObject({
      generation: 3,
      canonicalTaskId: oldTaskId,
      activeTurnId: null,
    });
    expect(harness.store.turns).toEqual([]);
  });

  it.each(["active", "retired"])(
    "does not rebind an otherwise idle v2 anchor while its credential is %s",
    async (status) => {
      const oldTaskId = "old-canonical-task";
      const oldCredentialId = "old-credential";
      const harness = createTurnServiceExecutor({
        build: build({
          upstreamTaskId: oldTaskId,
          canonicalTaskId: oldTaskId,
          canonicalTaskGeneration: 3,
          canonicalCredentialId: oldCredentialId,
          canonicalTaskState: "active",
          activeTurnId: null,
        }),
        conversation: {
          id: "u1:conversation-1",
          userId: 1,
          projectAssignmentId: null,
          status: "awaiting_input",
          deletedAt: null,
        },
        credentials: [
          { id: oldCredentialId, userId: 1, status },
          { id: "replacement-credential", userId: 1, status: "active" },
        ],
        resources: [
          {
            id: "old-task-resource",
            userId: 1,
            projectAssignmentId: null,
            kind: "task",
            upstreamId: oldTaskId,
            apiCredentialId: oldCredentialId,
          },
        ],
        turnSelections: [[]],
      });

      await expect(
        reserveKnowledgeBaseManusV2AnchorHandoff(
          {
            userId: 1,
            buildId: identity.buildId,
            expectedGeneration: 3,
            expectedStateEpoch: 7,
            expectedRevision: 7,
            expectedLeafId: "1.8",
            expectedLegacyTaskId: null,
            sourceProtocol: "manus_v2",
            expectedCanonicalTaskId: oldTaskId,
            expectedCanonicalCredentialId: oldCredentialId,
            apiCredentialId: "replacement-credential",
            credentialMode: "current_rebind",
            baseUrl: "https://api.example.test",
            agentProfile: "frontmind-pro",
          },
          harness.executor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(harness.store.build).toMatchObject({
        generation: 3,
        canonicalTaskId: oldTaskId,
        activeTurnId: null,
      });
      expect(harness.store.turns).toEqual([]);
    },
  );

  it("marks only the build local when no replacement credential exists", async () => {
    const oldTaskId = "old-canonical-task";
    const oldCredentialId = "old-credential";
    const acceptedMessage = { id: "accepted-receipt", content: "accepted" };
    const harness = createTurnServiceExecutor({
      build: build({
        upstreamTaskId: oldTaskId,
        canonicalTaskId: oldTaskId,
        canonicalTaskGeneration: 3,
        canonicalCredentialId: oldCredentialId,
        canonicalTaskState: "active",
        activeTurnId: null,
      }),
      conversation: {
        id: "u1:conversation-1",
        userId: 1,
        projectAssignmentId: null,
        status: "awaiting_input",
        deletedAt: null,
      },
      messages: [acceptedMessage],
      credentials: [{ id: oldCredentialId, userId: 1, status: "deleted" }],
      resources: [
        {
          id: "old-task-resource",
          userId: 1,
          projectAssignmentId: null,
          kind: "task",
          upstreamId: oldTaskId,
          apiCredentialId: oldCredentialId,
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      markKnowledgeBaseManusV2CredentialRebindAttention(
        {
          userId: 1,
          buildId: identity.buildId,
          expectedGeneration: 3,
          expectedStateEpoch: 7,
          expectedCanonicalTaskId: oldTaskId,
          expectedCanonicalCredentialId: oldCredentialId,
        },
        harness.executor,
      ),
    ).resolves.toBe(true);
    expect(harness.store.build).toMatchObject({
      generation: 3,
      activeTurnId: null,
      canonicalTaskId: oldTaskId,
      canonicalCredentialId: oldCredentialId,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_CANONICAL_CREDENTIAL_UNAVAILABLE",
    });
    expect(harness.store.turns).toEqual([]);
    expect(harness.store.messages).toEqual([acceptedMessage]);
  });

  it("keeps source ids frozen until every ready v2 mapping commits atomically", async () => {
    const leaseToken = "v2-attachment-ledger-lease";
    const sourceAttachments = [
      { file_id: "source-skill", filename: "skill.zip" },
      { file_id: "source-facts", filename: "facts.pdf" },
    ];
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: sourceAttachments,
    };
    const activeTurn = turn({
      attachmentFileIds: sourceAttachments.map((item) => item.file_id),
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 40 }, () => [
        (store) => store.turns,
      ]),
    });
    const expiresAt = Math.floor(Date.parse("2026-08-01T01:00:00Z") / 1_000);
    const mapping = (
      attachmentIndex: number,
      sourceFileId: string,
      filename: string,
      upstreamFileId: string,
    ) => ({
      schemaVersion: 1 as const,
      providerProtocol: "manus_v2" as const,
      mappingKey: `g3:${attachmentIndex}:${"d".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex,
      sourceFileId,
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"d".repeat(64)}.bin`,
      contentSha256: "d".repeat(64),
      sizeBytes: 123,
      filename,
      mimeType: "application/octet-stream",
      upstreamFileId,
      status: "ready" as const,
      expiresAt,
      providerGeneration: 1,
      verifiedAt: "2026-08-01T00:00:20.000Z",
    });
    const first = mapping(0, "source-skill", "skill.zip", "v2-skill");
    const second = mapping(1, "source-facts", "facts.pdf", "v2-facts");
    const persistAcceptedAttempt = async (target: typeof first) => {
      const base = {
        schemaVersion: 1 as const,
        mappingKey: target.mappingKey,
        buildGeneration: target.buildGeneration,
        attachmentIndex: target.attachmentIndex,
        sourceFileId: target.sourceFileId,
        localStorageKey: target.localStorageKey,
        contentSha256: target.contentSha256,
        sizeBytes: target.sizeBytes,
        filename: target.filename,
        mimeType: target.mimeType,
        providerGeneration: target.providerGeneration,
        code: null,
        recordedAt: "2026-08-01T00:00:15.000Z",
      };
      const persist = (attempt: any) =>
        persistKnowledgeBaseManusV2AttachmentAttempt(
          { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
          harness.executor,
        );
      await persist({
        ...base,
        state: "creating",
        upstreamFileId: null,
        uploadExpiresAt: null,
      });
      await persist({
        ...base,
        state: "candidate_created",
        upstreamFileId: target.upstreamFileId,
        uploadExpiresAt: expiresAt,
      });
      await persist({
        ...base,
        state: "put_sending",
        upstreamFileId: target.upstreamFileId,
        uploadExpiresAt: expiresAt,
      });
      await persist({
        ...base,
        state: "put_accepted",
        upstreamFileId: target.upstreamFileId,
        uploadExpiresAt: expiresAt,
      });
    };

    await persistAcceptedAttempt(first);
    await persistKnowledgeBaseManusV2AttachmentMapping(
      { userId: 1, turnId: activeTurn.id, leaseToken, mapping: first },
      harness.executor,
    );
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual([
      "source-skill",
      "source-facts",
    ]);
    await expect(
      finalizeKnowledgeBaseManusV2AttachmentMappings(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          mappings: [first],
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual([
      "source-skill",
      "source-facts",
    ]);

    await persistAcceptedAttempt(second);
    await persistKnowledgeBaseManusV2AttachmentMapping(
      { userId: 1, turnId: activeTurn.id, leaseToken, mapping: second },
      harness.executor,
    );
    await finalizeKnowledgeBaseManusV2AttachmentMappings(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        mappings: [first, second],
        now: new Date("2026-08-01T00:00:30.000Z"),
      },
      harness.executor,
    );
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual([
      "v2-skill",
      "v2-facts",
    ]);
    expect(
      (harness.store.turns[0]!.metadata as any).manusV2AttachmentMappings,
    ).toMatchObject({
      [first.mappingKey]: first,
      [second.mappingKey]: second,
    });
  });

  it("freezes an ambiguous v2 file side effect without promoting or retrying its slot", async () => {
    const leaseToken = "v2-file-outcome-unknown-lease";
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: [{ file_id: "source-facts", filename: "facts.pdf" }],
    };
    const activeTurn = turn({
      attachmentFileIds: ["source-facts"],
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [[(store) => store.turns]],
    });
    const attempt = {
      schemaVersion: 1 as const,
      mappingKey: `g3:0:${"e".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex: 0,
      sourceFileId: "source-facts",
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"e".repeat(64)}.bin`,
      contentSha256: "e".repeat(64),
      sizeBytes: 123,
      filename: "facts.pdf",
      mimeType: "application/pdf",
      providerGeneration: 1,
      state: "outcome_unknown" as const,
      code: "KNOWLEDGE_BASE_MANUS_V2_FILE_OUTCOME_UNKNOWN",
      recordedAt: "2026-08-01T00:00:20.000Z",
    };

    await expect(
      persistKnowledgeBaseManusV2AttachmentOutcomeUnknown(
        { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
        harness.executor,
      ),
    ).resolves.toEqual(attempt);
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual(["source-facts"]);
    expect(harness.store.turns[0]!.metadata).toMatchObject({
      manusV2AttachmentUnknownAttempts: {
        [attempt.mappingKey]: attempt,
      },
      dispatchState: "recovering",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskState: "attention_required",
      protocolErrorCode: "KNOWLEDGE_BASE_MANUS_V2_FILE_OUTCOME_UNKNOWN",
    });
  });

  it("fences a v2 file before create, pins its id before PUT, and caps replacement at two generations", async () => {
    const leaseToken = "v2-file-candidate-lease";
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: [{ file_id: "source-facts", filename: "facts.pdf" }],
    };
    const activeTurn = turn({
      attachmentFileIds: ["source-facts"],
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 16 }, () => [
        (store) => store.turns,
      ]),
    });
    const base = {
      schemaVersion: 1 as const,
      mappingKey: `g3:0:${"f".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex: 0,
      sourceFileId: "source-facts",
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"f".repeat(64)}.bin`,
      contentSha256: "f".repeat(64),
      sizeBytes: 123,
      filename: "facts.pdf",
      mimeType: "application/pdf",
      code: null,
      recordedAt: "2026-08-01T00:00:20.000Z",
    };
    const persist = (attempt: any) =>
      persistKnowledgeBaseManusV2AttachmentAttempt(
        { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
        harness.executor,
      );
    await persist({
      ...base,
      providerGeneration: 1,
      state: "creating",
      upstreamFileId: null,
      uploadExpiresAt: null,
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 1,
        state: "candidate_created",
        upstreamFileId: "candidate-one",
        uploadExpiresAt: 2_000_000_000,
      }),
    ).resolves.toMatchObject({ upstreamFileId: "candidate-one" });
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual(["source-facts"]);
    expect(harness.store.resources).toEqual([
      expect.objectContaining({
        kind: "file",
        upstreamId: "candidate-one",
        apiCredentialId: "credential-1",
      }),
    ]);
    await expect(
      persist({
        ...base,
        providerGeneration: 1,
        state: "candidate_created",
        upstreamFileId: "different-candidate",
        uploadExpiresAt: 2_000_000_000,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await persist({
      ...base,
      providerGeneration: 1,
      state: "unusable",
      upstreamFileId: "candidate-one",
      uploadExpiresAt: 2_000_000_000,
      code: "MANUS_V2_FILE_NOT_FOUND",
    });
    await persist({
      ...base,
      providerGeneration: 2,
      state: "creating",
      upstreamFileId: null,
      uploadExpiresAt: null,
    });
    await persist({
      ...base,
      providerGeneration: 2,
      state: "create_rejected",
      upstreamFileId: null,
      uploadExpiresAt: null,
      code: "MANUS_V2_FILE_CREATE_HTTP_429",
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 3,
        state: "creating",
        upstreamFileId: null,
        uploadExpiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("allows exactly one replacement after file.create outcome loss", async () => {
    const leaseToken = "v2-file-create-loss-lease";
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: [{ file_id: "source-facts", filename: "facts.pdf" }],
    };
    const activeTurn = turn({
      attachmentFileIds: ["source-facts"],
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 12 }, () => [
        (store) => store.turns,
      ]),
    });
    const base = {
      schemaVersion: 1 as const,
      mappingKey: `g3:0:${"9".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex: 0,
      sourceFileId: "source-facts",
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"9".repeat(64)}.bin`,
      contentSha256: "9".repeat(64),
      sizeBytes: 123,
      filename: "facts.pdf",
      mimeType: "application/pdf",
      upstreamFileId: null,
      uploadExpiresAt: null,
      recordedAt: "2026-08-01T00:00:20.000Z",
    };
    const persist = (attempt: any) =>
      persistKnowledgeBaseManusV2AttachmentAttempt(
        { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
        harness.executor,
      );
    await persist({
      ...base,
      providerGeneration: 1,
      state: "creating",
      code: null,
    });
    await persist({
      ...base,
      providerGeneration: 1,
      state: "create_outcome_unknown",
      code: "MANUS_V2_FILE_CREATE_TRANSPORT_UNKNOWN",
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 2,
        state: "creating",
        code: null,
      }),
    ).resolves.toMatchObject({ providerGeneration: 2, state: "creating" });
    await persist({
      ...base,
      providerGeneration: 2,
      state: "create_outcome_unknown",
      code: "MANUS_V2_FILE_CREATE_TRANSPORT_UNKNOWN",
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 3,
        state: "creating",
        code: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("grants create once, binds it, then grants sendMessage for the same task", async () => {
    const activeTurn = turn({
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update("lease-one", "utf8")
          .digest("hex"),
        createAttemptState: "not_sent",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
      },
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });
    const first = await beginKnowledgeBaseManusV2Dispatch(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken: "lease-one",
        frozenProviderRequestHash: "d".repeat(64),
      },
      harness.executor,
    );
    expect(first).toMatchObject({
      method: "task.create",
      canonicalTaskId: null,
      operationToken: "operation-1",
    });
    const storedFirstTurn = harness.store.turns[0]!;
    await bindKnowledgeBaseManusV2Submission(
      {
        userId: 1,
        turnId: storedFirstTurn.id,
        leaseToken: "lease-one",
        method: "task.create",
        taskId: "canonical-task",
        taskUrl: "https://manus.im/app/canonical-task",
      },
      harness.executor,
    );
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "active",
      upstreamTaskId: "canonical-task",
    });
    expect(harness.store.resources).toEqual([
      expect.objectContaining({
        userId: 1,
        apiCredentialId: "credential-1",
        projectAssignmentId: null,
        kind: "task",
        upstreamId: "canonical-task",
        conversationId: activeTurn.conversationId,
      }),
    ]);

    const nextTurn = turn({
      id: "00000000-0000-4000-8000-000000000003",
      operationKey: "operation-2",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update("lease-two", "utf8")
          .digest("hex"),
        createAttemptState: "not_sent",
      },
    });
    harness.store.turns.push(nextTurn);
    harness.store.build.activeTurnId = nextTurn.id;
    const secondHarness = createTurnServiceExecutor({
      build: harness.store.build,
      turns: [nextTurn],
      turnSelections: [[(store) => store.turns]],
    });
    const second = await beginKnowledgeBaseManusV2Dispatch(
      {
        userId: 1,
        turnId: nextTurn.id,
        leaseToken: "lease-two",
        frozenProviderRequestHash: "e".repeat(64),
      },
      secondHarness.executor,
    );
    expect(second).toMatchObject({
      method: "task.sendMessage",
      canonicalTaskId: "canonical-task",
      operationToken: "operation-2",
    });
  });

  it("reclaims a post-2xx bind failure only for v2 reconciliation and never grants another POST", async () => {
    const leaseToken = "post-ack-bind-failure-lease";
    const activeTurn = turn({
      status: "running",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "sending",
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "sending",
        operationToken: "operation-1",
        frozenProviderRequestHash: "d".repeat(64),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskState: "creating",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
      }),
      turns: [activeTurn],
      turnSelections: [
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
      ],
    });
    const markedAt = new Date("2026-08-01T00:00:30.000Z");
    const providerPost = async () => "provider-accepted-task";
    let providerPostCount = 0;
    const postOnce = async () => {
      providerPostCount += 1;
      return providerPost();
    };
    await expect(postOnce()).resolves.toBe("provider-accepted-task");

    await markKnowledgeBaseManusV2OutcomeUnknown(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        code: "MANUS_V2_BIND_PERSISTENCE_UNKNOWN",
        recoveryDelayMs: 1_000,
        now: markedAt,
      },
      harness.executor,
    );
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "unknown",
      providerAttemptState: "outcome_unknown",
      operationToken: "operation-1",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: null,
      canonicalTaskState: "reconciling",
    });

    const recovered = await claimKnowledgeBaseTurnForRecovery(
      {
        turnId: activeTurn.id,
        now: new Date("2026-08-01T00:00:31.001Z"),
      },
      harness.executor,
    );
    expect(recovered?.turn).toMatchObject({
      createAttemptState: "acknowledged",
      providerProtocol: "manus_v2",
      providerMethod: "task.create",
      providerAttemptState: "output_pending",
      operationToken: "operation-1",
    });

    await expect(
      beginKnowledgeBaseManusV2Dispatch(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken: recovered!.leaseToken,
          frozenProviderRequestHash: "d".repeat(64),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PENDING" });
    expect(providerPostCount).toBe(1);
  });

  it("keeps an anchor-only create reconciling until its exact acknowledgement commits", async () => {
    const leaseToken = "anchor-ack-lease";
    const activeTurn = turn({
      operationType: "legacy_reconcile",
      upstreamTaskId: null,
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "not_sent",
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
        operationToken: "operation-1",
        repairKind: "legacy_anchor_handoff",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalCredentialId: "credential-1",
        canonicalTaskGeneration: 3,
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
      },
      turns: [activeTurn],
      turnSelections: [
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
      ],
    });
    await beginKnowledgeBaseManusV2Dispatch(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        frozenProviderRequestHash: "a".repeat(64),
      },
      harness.executor,
    );
    await bindKnowledgeBaseManusV2Submission(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        method: "task.create",
        taskId: "anchor-task",
      },
      harness.executor,
    );
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "anchor-task",
      canonicalTaskState: "reconciling",
      activeTurnId: activeTurn.id,
    });
    expect(harness.store.turns[0]).toMatchObject({
      status: "running",
      upstreamTaskId: "anchor-task",
      metadata: { providerAttemptState: "output_pending" },
    });

    await completeKnowledgeBaseManusV2AnchorHandoff(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        taskId: "anchor-task",
        acknowledgement: {
          eventId: "ack-1",
          schemaVersion: 1,
          operationToken: "operation-1",
          turnId: activeTurn.id,
          generation: 3,
          baseRevision: 7,
          handoffAccepted: true,
        },
      },
      harness.executor,
    );
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "anchor-task",
      canonicalTaskState: "active",
      activeTurnId: null,
    });
    expect(harness.store.turns[0]).toMatchObject({
      status: "completed",
      metadata: {
        providerAttemptState: "accepted",
        anchorAcknowledgement: { eventId: "ack-1" },
      },
    });
  });

  it("restores a migrated no-active protocol error to an actionable confirming build after the exact anchor acknowledgement", async () => {
    const leaseToken = "protocol-error-anchor-lease";
    const activeTurn = turn({
      operationType: "legacy_reconcile",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "acknowledged",
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        repairKind: "legacy_anchor_handoff",
      },
      status: "running",
      upstreamTaskId: "anchor-task",
    });
    const harness = createTurnServiceExecutor({
      build: build({
        status: "protocol_error",
        canonicalTaskId: "anchor-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "reconciling",
        handoffProvenance: {
          schemaVersion: 1,
          sourceStatus: "protocol_error",
        },
        protocolErrorCode: "LEGACY_PROTOCOL_ERROR",
        protocolError: "historical failure",
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
      },
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns]],
    });

    await completeKnowledgeBaseManusV2AnchorHandoff(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        taskId: "anchor-task",
        acknowledgement: {
          eventId: "protocol-error-ack",
          schemaVersion: 1,
          operationToken: "operation-1",
          turnId: activeTurn.id,
          generation: 3,
          baseRevision: 7,
          handoffAccepted: true,
        },
      },
      harness.executor,
    );

    expect(harness.store.build).toMatchObject({
      providerProtocol: "manus_v2",
      status: "confirming",
      currentLeafId: "1.8",
      canonicalTaskId: "anchor-task",
      canonicalTaskState: "active",
      activeTurnId: null,
      protocolErrorCode: null,
      protocolError: null,
    });
    expect(harness.store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: "anchor-task",
    });
  });

  it("claims only the expired stopped ACK-missing anchor on its exact canonical task", async () => {
    const expiredAt = new Date("2026-08-13T00:00:00.000Z");
    const activeTurn = turn({
      operationType: "legacy_reconcile",
      status: "running",
      upstreamTaskId: "canonical-task",
      errorCode: "MANUS_V2_ANCHOR_ACK_MISSING",
      leaseExpiresAt: expiredAt,
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "rejected",
        providerProtocol: "manus_v2",
        providerAttemptState: "rejected",
        operationToken: "operation-1",
        repairKind: "legacy_anchor_handoff",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        status: "confirming",
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "attention_required",
        protocolErrorCode: "MANUS_V2_ANCHOR_ACK_MISSING",
      }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns, (store) => store.turns]],
    });

    const claim = await claimKnowledgeBaseTerminalAnchorHandoffRecovery(
      {
        turnId: activeTurn.id,
        now: new Date(expiredAt.getTime() + 1),
      },
      harness.executor,
    );
    expect(claim).toMatchObject({
      turn: {
        id: activeTurn.id,
        upstreamTaskId: "canonical-task",
        providerAttemptState: "rejected",
      },
    });
    expect(harness.store.build).toMatchObject({
      activeTurnId: activeTurn.id,
      canonicalTaskId: "canonical-task",
    });
  });

  it("accepts local rehydrate only for the exact canonical generation, revision and task", () => {
    const exactBuild = build({
      providerProtocol: "manus_v2",
      canonicalTaskId: "canonical-task",
      canonicalTaskGeneration: 3,
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      handoffProvenance: {
        localRehydrateRequired: {
          schemaVersion: 1,
          sourceTurnId: "00000000-0000-4000-8000-000000000001",
          snapshotSha256: "c".repeat(64),
          taskIdSha256: createHash("sha256")
            .update("canonical-task")
            .digest("hex"),
          generation: 3,
          revision: 7,
          leafId: "1.8",
        },
      },
    });
    expect(inspectKnowledgeBaseLocalRehydrateRequirement(exactBuild)).toEqual({
      sourceTurnId: "00000000-0000-4000-8000-000000000001",
      snapshotSha256: "c".repeat(64),
    });
    for (const patch of [
      { canonicalTaskId: "different-task" },
      { generation: 4 },
      { revision: 8 },
      { currentLeafId: "1.9" },
    ]) {
      expect(() =>
        inspectKnowledgeBaseLocalRehydrateRequirement({
          ...exactBuild,
          ...patch,
        }),
      ).toThrowError(KnowledgeBaseTurnReservationError);
    }
  });

  it("accepts the exact unbound replacement marker and reloads its frozen accepted snapshot", async () => {
    const sourceTurnId = "00000000-0000-4000-8000-000000000003";
    const snapshot = {
      schemaVersion: 1,
      purpose: "legacy_to_manus_v2_anchor_handoff",
      source: { buildId: identity.buildId },
      nodes: [{ leafId: "1.8", contentMarkdown: "accepted body" }],
      acceptedReceipts: [],
      pendingOperation: { kind: "anchor_only" },
    };
    const json = JSON.stringify(snapshot);
    const snapshotSha256 = createHash("sha256").update(json).digest("hex");
    const source = turn({
      id: sourceTurnId,
      status: "completed",
      completedAt: new Date("2026-08-13T00:00:00.000Z"),
      leaseExpiresAt: null,
      metadata: {
        localSettlement: { snapshotSha256 },
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: {
            prompt: `# frozen\n\`\`\`json\n${json}\n\`\`\`\n`,
            agentProfile: "frontmind-pro",
            attachments: [],
          },
          bodySha256: "b".repeat(64),
          preparedAt: "2026-08-13T00:00:00.000Z",
        },
      },
    });
    const replacementBuild = build({
      generation: 4,
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      handoffProvenance: {
        localRehydrateRequired: {
          schemaVersion: 1,
          sourceTurnId,
          snapshotSha256,
          taskIdSha256: null,
          sourceGeneration: 3,
          generation: 4,
          targetGeneration: 4,
          revision: 7,
          leafId: "1.8",
        },
        createNewCanonicalFromSnapshot: {
          schemaVersion: 1,
          sourceTurnId,
          snapshotSha256,
          sourceGeneration: 3,
          receiptSourceGeneration: 3,
          targetGeneration: 4,
        },
      },
    });
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [source] }),
        }),
      }),
    };

    expect(
      inspectKnowledgeBaseLocalRehydrateRequirement(replacementBuild),
    ).toEqual({ sourceTurnId, snapshotSha256 });
    await expect(
      loadKnowledgeBaseLocalRehydrateSnapshot(
        { userId: 1, build: replacementBuild },
        db,
      ),
    ).resolves.toEqual({ snapshot, json, sha256: snapshotSha256 });
  });

  it("observes one stopped event for 30 seconds then locally releases the exact anchor without changing accepted state", async () => {
    const leaseToken = "terminal-local-settlement-lease";
    const activeTurnId = "00000000-0000-4000-8000-000000000001";
    const sourceTurnId = "00000000-0000-4000-8000-000000000003";
    const content = "## 1.8 Current\n\nAccepted body";
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const presentationKey = createHash("sha256")
      .update(`${identity.buildId}:3:7:1.8:${contentSha256}`)
      .digest("hex");
    const snapshot = {
      schemaVersion: 1,
      purpose: "legacy_to_manus_v2_anchor_handoff",
      source: {
        providerProtocol: "legacy_v1",
        buildId: identity.buildId,
        generation: 3,
        targetGeneration: 3,
        revision: 7,
        currentLeafId: "1.8",
        status: "confirming",
        skill: {
          name: "socratic-kb-builder",
          version: "4",
          contentHash: "c".repeat(64),
          archiveSha256: null,
          archiveBytes: null,
          archiveStorageKey: null,
        },
        treePolicyVersion: 2,
      },
      nodes: [
        {
          leafId: "1.8",
          branchId: "1",
          branchTitle: "Branch",
          title: "Current",
          ordinal: 0,
          status: "current",
          contentMarkdown: content,
          contentSha256,
          lastUserInput: null,
          sourceUrls: [],
          imageUrls: [],
        },
      ],
      acceptedReceipts: [],
      pendingOperation: {
        kind: "anchor_only",
        turnId: activeTurnId,
        operationToken: "operation-1",
        baseRevision: 7,
        fromLeafId: "1.8",
      },
    } as const;
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotSha256 = createHash("sha256")
      .update(snapshotJson)
      .digest("hex");
    const requestBody = {
      prompt: `# frozen\n\`\`\`json\n${snapshotJson}\n\`\`\`\n`,
      agentProfile: "frontmind-pro",
      attachments: [],
    };
    const recovery = buildKnowledgeBaseManusV2AnchorErrorRecovery({
      operationToken: "operation-1",
      turnId: activeTurnId,
      generation: 3,
      baseRevision: 7,
    });
    const activeTurn = turn({
      id: activeTurnId,
      operationType: "legacy_reconcile",
      status: "running",
      upstreamTaskId: "canonical-task",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256").update(leaseToken).digest("hex"),
        createAttemptState: "rejected",
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        repairKind: "legacy_anchor_handoff",
        recovery: { snapshotSha256 },
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-13T00:00:00.000Z",
        },
        manusV2Lifecycle: {
          errorRecoveryAttempt: 1,
          errorRecoveryToken: recovery.recoveryToken,
          errorRecoveryRequestHash: recovery.requestHash,
          errorRecoveryAttemptState: "acknowledged",
          errorRecoveryRequestId: "recovery-request-1",
          errorRecoveryAcknowledgedAt: "2026-08-13T00:00:00.000Z",
        },
      },
    });
    const sourceTurn = turn({
      id: sourceTurnId,
      status: "completed",
      completedAt: new Date("2026-08-12T23:59:00.000Z"),
      leaseExpiresAt: null,
    });
    const node = {
      id: "node-1",
      buildId: identity.buildId,
      leafId: "1.8",
      branchId: "1",
      branchTitle: "Branch",
      title: "Current",
      ordinal: 0,
      status: "current",
      contentMarkdown: content,
      contentSha256,
      sourceTurnId,
      presentationKey,
    };
    const initialBuild = build({
      upstreamTaskId: "canonical-task",
      canonicalTaskId: "canonical-task",
      canonicalTaskGeneration: 3,
      canonicalCredentialId: "credential-1",
      canonicalTaskState: "reconciling",
      currentPresentationKey: presentationKey,
      handoffProvenance: { snapshotSha256, pendingTurnId: activeTurnId },
      confirmedCount: 6,
      directPrefilledCount: 1,
    });
    const selectTurns = [
      (store: TurnServiceStore) =>
        store.turns.filter((candidate) => candidate.id === activeTurnId),
      (store: TurnServiceStore) =>
        store.turns.filter((candidate) => candidate.id === sourceTurnId),
      (store: TurnServiceStore) =>
        store.turns.filter((candidate) => candidate.id === activeTurnId),
    ];
    const harness = createTurnServiceExecutor({
      build: initialBuild,
      conversation: {
        id: activeTurn.conversationId,
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        version: 2,
      },
      turns: [activeTurn, sourceTurn],
      nodes: [node],
      turnSelections: [selectTurns, selectTurns],
    });

    await expect(
      observeAndLocallySettleKnowledgeBaseTerminalAnchor(
        {
          userId: 1,
          turnId: activeTurnId,
          leaseToken,
          taskId: "canonical-task",
          terminalEventHash: "e".repeat(64),
          now: new Date("2026-08-13T00:00:20.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ state: "observed" });
    expect(harness.store.build.activeTurnId).toBe(activeTurnId);

    await expect(
      observeAndLocallySettleKnowledgeBaseTerminalAnchor(
        {
          userId: 1,
          turnId: activeTurnId,
          leaseToken,
          taskId: "canonical-task",
          terminalEventHash: "e".repeat(64),
          now: new Date("2026-08-13T00:00:50.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ state: "settled" });
    expect(harness.store.build).toMatchObject({
      activeTurnId: null,
      status: "confirming",
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "active",
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      currentPresentationKey: presentationKey,
      confirmedCount: 6,
      directPrefilledCount: 1,
      handoffProvenance: {
        localRehydrateRequired: {
          snapshotSha256,
          generation: 3,
          revision: 7,
          leafId: "1.8",
        },
      },
    });
    expect(harness.store.turns[0]).toMatchObject({
      status: "completed",
      leaseExpiresAt: null,
      metadata: {
        localSettlement: {
          kind: "terminal_anchor_without_ack",
          snapshotSha256,
          presentationKey,
        },
      },
    });
    expect(harness.store.nodes).toEqual([node]);
    expect(harness.store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: "canonical-task",
    });
  });

  it("writer-fences an unprovable failed legacy attempt into read-only quarantine", async () => {
    const activeTurn = turn({
      status: "failed",
      leaseExpiresAt: null,
      completedAt: new Date("2026-08-01T00:00:30.000Z"),
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "unknown",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        providerProtocol: "legacy_v1",
        status: "protocol_error",
        canonicalTaskState: "unbound",
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
      },
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns]],
    });

    await expect(
      markLegacyKnowledgeBaseCreateAttentionRequired(
        {
          userId: 1,
          turnId: activeTurn.id,
          expectedGeneration: 3,
        },
        harness.executor,
      ),
    ).resolves.toBe(true);
    expect(harness.store.build).toMatchObject({
      providerProtocol: "legacy_v1",
      status: "failed",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "LEGACY_CREATE_OUTCOME_UNKNOWN",
    });
    expect(harness.store.conversation).toMatchObject({ status: "failed" });
  });

  it("rolls canonical binding back when the provider task id is already owned", async () => {
    const activeTurn = turn({
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update("lease-conflict", "utf8")
          .digest("hex"),
        createAttemptState: "not_sent",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
      },
      turns: [activeTurn],
      resources: [
        {
          id: "existing-task-owner",
          userId: 2,
          apiCredentialId: "other-credential",
          projectAssignmentId: null,
          kind: "task",
          upstreamId: "duplicate-provider-task",
          conversationId: "u2:other-conversation",
        },
      ],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });
    await beginKnowledgeBaseManusV2Dispatch(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken: "lease-conflict",
        frozenProviderRequestHash: "a".repeat(64),
      },
      harness.executor,
    );

    await expect(
      bindKnowledgeBaseManusV2Submission(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken: "lease-conflict",
          method: "task.create",
          taskId: "duplicate-provider-task",
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: null,
      canonicalTaskState: "creating",
    });
    expect(harness.store.resources).toHaveLength(1);
  });

  it("commits one crash-safe legacy handoff digest and resumes it idempotently", async () => {
    const leaseToken = "handoff-lease";
    const snapshotSha256 = "f".repeat(64);
    const activeTurn = turn({
      metadata: {
        attachmentsFrozen: true,
        providerProtocol: "legacy_v1",
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({ providerProtocol: "legacy_v1" }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });

    await expect(
      activateKnowledgeBaseManusV2Handoff(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          snapshotSha256,
          legacyTaskIdSha256: "e".repeat(64),
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ migrated: true, snapshotSha256 });
    expect(harness.store.build).toMatchObject({
      providerProtocol: "manus_v2",
      canonicalTaskState: "unbound",
      canonicalTaskId: null,
      handoffProvenance: {
        schemaVersion: 1,
        sourceProtocol: "legacy_v1",
        snapshotSha256,
        pendingTurnId: activeTurn.id,
      },
    });
    expect(harness.store.turns[0]!.metadata).toMatchObject({
      providerProtocol: "manus_v2",
      providerAttemptState: "not_sent",
      operationToken: activeTurn.operationKey,
      repairKind: "legacy_handoff",
    });

    await expect(
      activateKnowledgeBaseManusV2Handoff(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          snapshotSha256,
        },
        harness.executor,
      ),
    ).resolves.toEqual({ migrated: false, snapshotSha256 });
  });

  it("persists one lifecycle side effect and never grants a resend", async () => {
    const leaseToken = "lifecycle-lease";
    const activeTurn = turn({
      upstreamTaskId: "canonical-task",
      metadata: {
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });
    const mutation = {
      kind: "format_repair" as const,
      repairToken: "repair-token",
      requestHash: "f".repeat(64),
      state: "sending" as const,
    };
    await expect(
      mutateKnowledgeBaseManusV2Lifecycle(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          mutation,
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      formatRepairAttempt: 1,
      formatRepairAttemptState: "sending",
      formatRepairStartedAt: expect.any(String),
      formatRepairDeadlineAt: expect.any(String),
    });
    const persistedLifecycle = (harness.store.turns[0]!.metadata as any)
      .manusV2Lifecycle;
    expect(
      Date.parse(persistedLifecycle.formatRepairDeadlineAt) -
        Date.parse(persistedLifecycle.formatRepairStartedAt),
    ).toBe(120_000);
    expect(harness.store.turns[0]!.leaseExpiresAt?.toISOString()).toBe(
      persistedLifecycle.formatRepairDeadlineAt,
    );
    await expect(
      mutateKnowledgeBaseManusV2Lifecycle(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          mutation,
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PENDING" });
  });

  it("retries the identical task-error recovery only after durable explicit-rejection backoff", async () => {
    const leaseToken = "error-recovery-retry-lease";
    const now = new Date("2026-08-13T00:00:00.000Z");
    const activeTurn = turn({
      upstreamTaskId: "canonical-task",
      metadata: {
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 4 }, () => [
        (store: any) => store.turns,
      ]),
    });
    const frozen = {
      kind: "error_recovery" as const,
      recoveryToken: "recovery-token",
      requestHash: "e".repeat(64),
    };
    await mutateKnowledgeBaseManusV2Lifecycle(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        now,
        mutation: { ...frozen, state: "sending" },
      },
      harness.executor,
    );
    await mutateKnowledgeBaseManusV2Lifecycle(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        now,
        mutation: { ...frozen, state: "retry_wait", retryAfterMs: 7_000 },
      },
      harness.executor,
    );
    await expect(
      mutateKnowledgeBaseManusV2Lifecycle(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          now: new Date(now.getTime() + 6_999),
          mutation: { ...frozen, state: "sending" },
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PENDING" });
    await expect(
      mutateKnowledgeBaseManusV2Lifecycle(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          now: new Date(now.getTime() + 7_000),
          mutation: { ...frozen, state: "sending" },
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      errorRecoveryToken: "recovery-token",
      errorRecoveryRequestHash: "e".repeat(64),
      errorRecoveryAttemptState: "sending",
      errorRecoveryRejectionCount: 1,
    });
  });

  it("never replaces an outcome-unknown waiting side effect with a newer event", async () => {
    const leaseToken = "waiting-outcome-unknown-lease";
    const activeTurn = turn({
      upstreamTaskId: "canonical-task",
      metadata: {
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      turnSelections: [
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
      ],
    });
    const frozen = {
      kind: "waiting" as const,
      eventId: "evt-A",
      eventType: "messageAskUser",
      statusEventId: "status-A",
      action: "ask_user_continue" as const,
      requestHash: "a".repeat(64),
      continuationToken: "continue-A",
      state: "sending" as const,
    };
    await mutateKnowledgeBaseManusV2Lifecycle(
      { userId: 1, turnId: activeTurn.id, leaseToken, mutation: frozen },
      harness.executor,
    );
    await mutateKnowledgeBaseManusV2Lifecycle(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        mutation: { ...frozen, state: "outcome_unknown" },
      },
      harness.executor,
    );

    await expect(
      mutateKnowledgeBaseManusV2Lifecycle(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          mutation: {
            ...frozen,
            eventId: "evt-B",
            requestHash: "b".repeat(64),
          },
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (harness.store.turns[0]!.metadata as any).manusV2Lifecycle,
    ).toMatchObject({
      waitingEventId: "evt-A",
      waitingRequestHash: "a".repeat(64),
      waitingAttemptState: "outcome_unknown",
    });
  });

  it("allows only a strictly superseding waiting event after the old one is acknowledged", async () => {
    const leaseToken = "waiting-successor-lease";
    const activeTurn = turn({
      upstreamTaskId: "canonical-task",
      metadata: {
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 3 }, () => [
        (store: any) => store.turns,
      ]),
    });
    const oldWaiting = {
      kind: "waiting" as const,
      eventId: "evt-A",
      eventType: "messageAskUser",
      statusEventId: "status-A",
      action: "ask_user_continue" as const,
      requestHash: "a".repeat(64),
      continuationToken: "continue-A",
    };
    await mutateKnowledgeBaseManusV2Lifecycle(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        mutation: { ...oldWaiting, state: "sending" },
      },
      harness.executor,
    );
    await mutateKnowledgeBaseManusV2Lifecycle(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        mutation: { ...oldWaiting, state: "acknowledged" },
      },
      harness.executor,
    );
    await expect(
      mutateKnowledgeBaseManusV2Lifecycle(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          mutation: {
            ...oldWaiting,
            eventId: "evt-B",
            statusEventId: "status-B",
            requestHash: "b".repeat(64),
            continuationToken: "continue-B",
            supersedesEventId: "evt-A",
            state: "sending",
          },
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      waitingEventId: "evt-B",
      waitingStatusEventId: "status-B",
      waitingAttemptState: "sending",
    });
  });

  it("marks unsafe waiting build-local without changing its canonical anchor", async () => {
    const leaseToken = "attention-lease";
    const activeTurn = turn({
      upstreamTaskId: "canonical-task",
      metadata: {
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns]],
    });
    await markKnowledgeBaseManusV2AttentionRequired(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        code: "MANUS_V2_EXTERNAL_CONFIRMATION_REQUIRED",
        waitingEventId: "evt-deploy",
        waitingEventType: "deployAction",
      },
      harness.executor,
    );
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_EXTERNAL_CONFIRMATION_REQUIRED",
    });
    expect(harness.store.turns[0]?.status).toBe("running");
    expect(harness.store.turns[0]?.leaseExpiresAt).toBeNull();
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      recoveryAction: "contact_support",
      manusV2Lifecycle: {
        attentionCode: "MANUS_V2_EXTERNAL_CONFIRMATION_REQUIRED",
      },
    });
    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: activeTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
  });

  it("retries only an explicit v2 rejection against the same frozen create request", async () => {
    const leaseToken = "explicit-create-rejection";
    const activeTurn = turn({
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "sending",
        createAttemptState: "sending",
        operationToken: "operation-1",
        frozenProviderRequestHash: "f".repeat(64),
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskState: "creating",
        canonicalCredentialId: "credential-1",
        canonicalTaskGeneration: 3,
      }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns]],
    });
    await expect(
      settleKnowledgeBaseManusV2ExplicitRejection(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          code: "MANUS_V2_CREATE_REJECTED",
          retryable: true,
          // This mirrors a real, provider-supplied Retry-After value.
          recoveryDelayMs: 7_000,
          now: new Date("2026-08-01T00:00:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      retryScheduled: true,
      attempt: 1,
      delayMs: 7_000,
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "not_sent",
      providerAttemptState: "not_sent",
      providerRejectionCount: 1,
      frozenProviderRequestHash: "f".repeat(64),
      operationToken: "operation-1",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: null,
      canonicalTaskState: "unbound",
    });
  });

  it("puts an exhausted v2 rejection in local attention without revoking the anchor", async () => {
    const leaseToken = "explicit-send-rejection";
    const activeTurn = turn({
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "sending",
        createAttemptState: "sending",
        operationToken: "operation-1",
        frozenProviderRequestHash: "f".repeat(64),
        providerRejectionCount: 3,
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [[(store) => store.turns]],
    });
    await expect(
      settleKnowledgeBaseManusV2ExplicitRejection(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          code: "MANUS_V2_SEND_REJECTED",
          retryable: true,
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ retryScheduled: false, attempt: 4 });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_SEND_REJECTED",
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "rejected",
      providerAttemptState: "rejected",
      providerRejectionCount: 4,
    });
    harness.store.turns[0]!.leaseExpiresAt = new Date(
      "2026-08-01T00:00:00.000Z",
    );
    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: activeTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_SEND_REJECTED",
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "rejected",
      providerAttemptState: "rejected",
    });
  });

  it("never reclaims a nonretryable rejected v2 create after its lease expires", async () => {
    const rejectedTurn = turn({
      status: "running",
      leaseExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "rejected",
        createAttemptState: "rejected",
        operationToken: "operation-1",
        frozenProviderRequestHash: "f".repeat(64),
        providerRejectionCount: 1,
        attachmentsFrozen: true,
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: null,
        canonicalTaskState: "attention_required",
        canonicalCredentialId: "credential-1",
        canonicalTaskGeneration: 3,
        protocolErrorCode: "MANUS_V2_CREATE_REJECTED",
      }),
      turns: [rejectedTurn],
      conversation: {
        id: rejectedTurn.conversationId,
        userId: rejectedTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [[(store) => store.turns]],
    });
    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: rejectedTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      providerAttemptState: "rejected",
      createAttemptState: "rejected",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_CREATE_REJECTED",
    });
  });

  it("terminalizes a historical bound local-rehydrate rejection as new-canonical authority", async () => {
    const rejectedTurn = turn({
      status: "running",
      upstreamTaskId: "canonical-task",
      leaseExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
      errorCode: "MANUS_V2_SEND_REJECTED",
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "rejected",
        createAttemptState: "rejected",
        operationToken: "a".repeat(64),
        frozenProviderRequestHash: "f".repeat(64),
        providerReasonCategory: "permission_denied",
        providerRejectionStatus: 403,
        attachmentsFrozen: true,
        recoveryAction: "wait",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        upstreamTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "attention_required",
        handoffProvenance: {
          localRehydrateRequired: {
            schemaVersion: 1,
            sourceTurnId: "00000000-0000-4000-8000-000000000003",
            snapshotSha256: "c".repeat(64),
            taskIdSha256: createHash("sha256")
              .update("canonical-task")
              .digest("hex"),
            generation: 3,
            revision: 7,
            leafId: "1.8",
          },
        },
      }),
      turns: [rejectedTurn],
      conversation: {
        id: rejectedTurn.conversationId,
        userId: rejectedTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [
        [(store) => store.turns, (store) => store.turns],
      ],
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: rejectedTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      leaseExpiresAt: null,
      metadata: {
        failureClass: "requires_user_fix",
        recoveryAction: "create_new_canonical_from_snapshot",
      },
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
    });
  });
});

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

  it.each([
    {
      label: "native values",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: 3,
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 3,
    },
    {
      label: "array coercion",
      traceId: ["b150314c-3c10-4073-8ebc-241e16f53600"],
      userAttachmentCount: [3],
      expectedTraceId: null,
      expectedUserAttachmentCount: 0,
    },
    {
      label: "object trace coercion",
      traceId: {
        toString: () => "b150314c-3c10-4073-8ebc-241e16f53600",
      },
      userAttachmentCount: 3,
      expectedTraceId: null,
      expectedUserAttachmentCount: 3,
    },
    {
      label: "string count coercion",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: "3",
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 0,
    },
    {
      label: "NaN count",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: Number.NaN,
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 0,
    },
    {
      label: "negative count",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: -1,
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 0,
    },
  ])(
    "projects strict replay receipt metadata for $label",
    async ({
      traceId,
      userAttachmentCount,
      expectedTraceId,
      expectedUserAttachmentCount,
    }) => {
      const receipt = await inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: intent,
        },
        replayExecutor([
          [
            replayTurn({
              metadata: {
                clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
                expectedPresentationKey: "presentation-7",
                traceId,
                userAttachmentCount,
              },
            }),
          ],
        ]),
      );

      expect(receipt?.turn).toMatchObject({
        traceId: expectedTraceId,
        expectedUserAttachmentCount,
      });
    },
  );

  it("replays an old protocol-terminal incident without exposing mutation authority", async () => {
    const incident = replayTurn({
      status: "failed",
      upstreamTaskId: "provider-task-legacy-protocol",
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      metadata: {
        clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
        expectedPresentationKey: "presentation-7",
        attachmentsFrozen: true,
        expectedAttachmentCount: 0,
        userAttachmentCount: 0,
        dispatchingAt: "2026-07-31T23:59:59.000Z",
      },
    });

    await expect(
      inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: intent,
        },
        replayExecutor([[incident]]),
      ),
    ).resolves.toMatchObject({
      state: "terminal",
      turn: {
        id: incident.id,
        upstreamTaskId: "provider-task-legacy-protocol",
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });
  });

  it("replays only an exact fully verified legacy start browser intent", async () => {
    const completedAt = new Date("2026-08-01T00:00:10.000Z");
    const attachment = {
      file_id: "customer-file-legacy-start",
      filename: "company-profile.pdf",
    };
    const build = {
      id: turn().buildId,
      userId: 1,
      conversationId: "conversation-1",
      companyName: "FrontMind",
      companyWebsite: "https://www.frontmind.net/",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 3,
      status: "protocol_error",
      activeTurnId: turn().id,
      upstreamTaskId: "provider-task-legacy-start",
      currentLeafId: "1.8",
      revision: 7,
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
    };
    const recovery = {
      kind: "start",
      conversationId: "conversation-1",
      companyName: build.companyName,
      companyWebsite: build.companyWebsite,
      operatorNotes: "",
      attachments: [attachment],
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      includePrefill: false,
      prefillSnapshotId: null,
      protocolFailureObservation: {
        observationKeyHash: "d".repeat(64),
        count: 3,
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        lastObservedAt: completedAt.toISOString(),
      },
    };
    const requestBody = {
      prompt: "Pinned legacy start prompt",
      agentProfile: "frontmind-pro",
      taskMode: "agent" as const,
      attachments: [
        { file_id: "skill-file-legacy-start", filename: "skill.zip" },
        attachment,
      ],
    };
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: build.generation,
      operationType: "start",
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
    });
    const incident = turn({
      operationKey,
      operationType: "start",
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: build.generation,
        revision: build.revision,
        leafId: build.currentLeafId,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        payload: {
          companyName: recovery.companyName,
          companyWebsite: recovery.companyWebsite,
          operatorNotes: recovery.operatorNotes,
          attachments: recovery.attachments,
          skillVersion: recovery.skillVersion,
          skillContentHash: recovery.skillContentHash,
          prefillSnapshotId: recovery.prefillSnapshotId,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      status: "failed",
      upstreamTaskId: build.upstreamTaskId,
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      completedAt,
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file-legacy-start", attachment.file_id],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        dispatchingAt: "2026-07-31T23:59:59.000Z",
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    const exactInput = {
      userId: 1,
      conversationId: "conversation-1",
      clientRequestId: incident.clientRequestId,
      companyName: build.companyName,
      companyWebsite: ` ${build.companyWebsite} `,
      operatorNotes: "  ",
      attachments: [attachment],
    };

    await expect(
      inspectKnowledgeBaseLegacyStartReplay(
        exactInput,
        replayExecutor([[incident], [build as any]]),
      ),
    ).resolves.toMatchObject({
      state: "terminal",
      turn: {
        id: incident.id,
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });

    for (const changed of [
      { companyName: "Other Brand" },
      { companyWebsite: "https://other.example/" },
      { operatorNotes: "changed" },
      { attachments: [{ ...attachment, filename: "other.pdf" }] },
      { attachments: [] },
    ]) {
      await expect(
        inspectKnowledgeBaseLegacyStartReplay(
          { ...exactInput, ...changed },
          replayExecutor([[incident], [build as any]]),
        ),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
      });
    }

    await expect(
      inspectKnowledgeBaseLegacyStartReplay(
        exactInput,
        replayExecutor([
          [
            {
              ...incident,
              metadata: {
                ...(incident.metadata as Record<string, unknown>),
                recovery: {
                  ...recovery,
                  protocolFailureObservation: {
                    ...recovery.protocolFailureObservation,
                    count: "3",
                  },
                },
              },
            },
          ],
          [build as any],
        ]),
      ),
    ).resolves.toBeNull();
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
      schemaVersion: 2,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "exact prompt",
        attachments: [
          { file_id: "skill-file", filename: "skill.zip" },
          { file_id: "facts-file", filename: "facts.pdf" },
        ],
      },
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(prepared.requestBody).not.toHaveProperty("taskMode");
    expect(prepared.requestBody).not.toHaveProperty("taskId");
    expect(JSON.stringify(prepared)).not.toMatch(
      /API_KEY|Authorization|credential-value/,
    );
    expect((storedTurn.metadata as any).preparedDispatch).toEqual(prepared);
    expect(lockTrace).toEqual(["build", "turn"]);
  });

  it("resumes one not-sent pre-create credential failure on the same logical turn exactly once", async () => {
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
      errorCode: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
      errorMessage: "凭证暂不可用",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file"],
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "not_sent",
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
        createAttemptState: "not_sent",
      },
      preparedDispatch,
    });
    expect(first?.upstreamIdempotencyKey).toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(failed.operationKey!),
    );
    expect(replay).toBeNull();
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "not_sent",
    });
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

  it.each(
    [
      ["rejected", "top_up", "legacy_v1", undefined],
      ["rejected", "update_credential", "legacy_v1", undefined],
      ["sending", "update_credential"],
      ["unknown", "top_up"],
      ["acknowledged", "update_credential"],
    ].map(
      ([state, action, protocol = "legacy_v1", method]) =>
        [state, action, protocol, method] as const,
    ),
  )(
    "never resets provider create state %s through %s recovery",
    async (
      createAttemptState,
      recoveryAction,
      providerProtocol,
      providerMethod,
    ) => {
      const failed = turn({
        status: "failed",
        upstreamTaskId: null,
        errorCode: "UPSTREAM_CREATE_HTTP_402",
        errorMessage: "上游任务创建已越过发送边界",
        completedAt: new Date("2026-08-01T00:00:10.000Z"),
        leaseExpiresAt: null,
        attachmentFileIds: ["skill-file"],
        metadata: {
          attachmentsFrozen: true,
          createAttemptState,
          providerProtocol,
          ...(providerMethod ? { providerMethod } : {}),
          expectedAttachmentCount: 1,
          userAttachmentCount: 0,
          preparedDispatch: {
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "exact prompt",
              agentProfile: "manus-1.6-max",
              attachments: [{ file_id: "skill-file", filename: "skill.zip" }],
            },
            bodySha256: "d".repeat(64),
            preparedAt: "2026-08-01T00:00:00.000Z",
          },
          recovery: {
            kind: "turn",
            conversationId: "conversation-1",
            skillVersion: "4",
            skillContentHash: "a".repeat(64),
          },
          dispatchState: "failed",
          failureClass: "requires_user_fix",
          recoveryAction,
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
        credentials: [
          { id: "credential-repaired", userId: 1, status: "active" },
        ],
        turnSelections: [[current]],
      });
      const before = structuredClone(store);

      await expect(
        resumeKnowledgeBaseTurnAfterUserFix(
          {
            userId: 1,
            turnId: failed.id,
            apiCredentialId: "credential-repaired",
            now: new Date("2026-08-01T00:01:00.000Z"),
          },
          executor,
        ),
      ).resolves.toBeNull();
      expect(store).toStrictEqual(before);
    },
  );

  it("rearms an explicitly rejected credential create on the same operation with a replacement credential", async () => {
    const failed = turn({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "MANUS_V2_CREATE_REJECTED",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: true,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "rejected",
        createAttemptState: "rejected",
        providerReasonCategory: "permission_denied",
        providerRejectionStatus: 403,
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: { prompt: "frozen", attachments: [] },
          bodySha256: "d".repeat(64),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
        recovery: { kind: "turn", conversationId: "conversation-1" },
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
        canRegenerate: false,
      },
    });
    const current = (state: TurnServiceStore) =>
      state.turns.filter((candidate) => candidate.id === failed.id);
    const { executor, store } = createTurnServiceExecutor({
      build: {
        id: failed.buildId,
        userId: 1,
        conversationId: "conversation-1",
        generation: failed.buildGeneration,
        stateEpoch: 8,
        status: "protocol_error",
        activeTurnId: failed.id,
        canonicalTaskId: null,
      },
      conversation: { id: failed.conversationId, userId: 1, version: 3 },
      turns: [failed],
      credentials: [{ id: "credential-repaired", userId: 1, status: "active" }],
      turnSelections: [[current]],
    });
    const claim = await resumeKnowledgeBaseTurnAfterUserFix(
      {
        userId: 1,
        turnId: failed.id,
        apiCredentialId: "credential-repaired",
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );
    expect(claim?.turn).toMatchObject({
      id: failed.id,
      operationKey: failed.operationKey,
      apiCredentialId: "credential-repaired",
      createAttemptState: "not_sent",
      providerAttemptState: "not_sent",
    });
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]?.metadata).toMatchObject({
      credentialRejectionHistory: [
        expect.objectContaining({ providerStatus: 403 }),
      ],
    });
  });

  it("replaces a not-sent pre-create attachment failure on the same turn exactly once", async () => {
    const failed = turn({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
      errorMessage: "附件完整性校验失败",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: ["old-skill", "old-instructions", "old-large-file"],
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "not_sent",
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

  it("keeps a rejected task-create turn and its seven frozen attachments immutable", async () => {
    const frozenAttachments = [
      { file_id: "skill-file", filename: "skill.zip" },
      { file_id: "instructions-file", filename: "instructions.txt" },
      ...Array.from({ length: 5 }, (_, index) => ({
        file_id: `user-file-${index + 1}`,
        filename: `user-${index + 1}.pdf`,
      })),
    ];
    const preparedDispatch = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "exact prompt",
        agentProfile: "manus-1.6-max",
        attachments: frozenAttachments,
      },
      bodySha256: "d".repeat(64),
      preparedAt: "2026-08-01T00:00:00.000Z",
    };
    const rejected = turn({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_3",
      errorMessage: "上游已明确拒绝创建本轮任务",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: frozenAttachments.map(
        (attachment) => attachment.file_id,
      ),
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "rejected",
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        preparedDispatch,
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          attachments: frozenAttachments.slice(2),
          skillVersion: "4",
          skillContentHash: "a".repeat(64),
        },
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "fix_attachments",
        canRegenerate: false,
      },
    });
    const current = (state: TurnServiceStore) =>
      state.turns.filter((candidate) => candidate.id === rejected.id);
    const { executor, store } = createTurnServiceExecutor({
      build: {
        id: rejected.buildId,
        userId: 1,
        conversationId: "conversation-1",
        generation: rejected.buildGeneration,
        stateEpoch: 8,
        status: "protocol_error",
        activeTurnId: rejected.id,
        protocolErrorCode: rejected.errorCode,
        protocolError: rejected.errorMessage,
      },
      conversation: {
        id: rejected.conversationId,
        userId: 1,
        version: 3,
        status: "failed",
        completedAt: rejected.completedAt,
      },
      turns: [rejected],
      credentials: [{ id: "credential-repaired", userId: 1, status: "active" }],
      turnSelections: [[current]],
    });
    const before = structuredClone(store);

    await expect(
      replaceKnowledgeBaseTurnAttachmentsAfterUserFix(
        {
          userId: 1,
          turnId: rejected.id,
          apiCredentialId: "credential-repaired",
          clientRequestId: "rejected-attachment-repair",
          attachments: [
            { file_id: "replacement-file", filename: "replacement.pdf" },
          ],
          attachmentManifest: [
            {
              filename: "replacement.pdf",
              sizeBytes: 100,
              mimeType: "application/pdf",
              lastModified: 1,
              sha256: "f".repeat(64),
            },
          ],
          now: new Date("2026-08-01T00:01:00.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toStrictEqual(before);
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
    // A provider identity is only a candidate until readiness/content proof.
    expect(completed.attachmentFileIds).toEqual([]);
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
      state: "candidate_created",
      idempotencyKey: first.idempotencyKey,
      upstreamFileId: "provider-file-1",
    });

    const ready = await promoteKnowledgeBaseGeneratedAttachmentReady(
      {
        userId: 1,
        turnId: active.id,
        leaseToken,
        role: "skill",
        attachmentIndex: 0,
        requestHash: first.requestHash,
        upstreamFileId: "provider-file-1",
      },
      executor,
    );
    expect(ready.attachmentFileIds).toEqual(["provider-file-1"]);

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
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:CONFLICT|RESERVATION_NOT_FOUND)$/u),
    });
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
    expectedResetRevision: 0,
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

  it("rejects a stale browser reset revision before creating a build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 2,
      turnSelections: [[]],
    });
    await expect(
      reserveKnowledgeBaseStartBuild(
        { ...startInput, expectedResetRevision: 1 },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
    });
    expect(store.build).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

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
    expect(store.build?.skillArchiveStorageKey).toMatch(
      /^knowledge-base\/skill-archives\/[a-f0-9]{64}\.skill\.zip$/u,
    );
    expect(store.build?.skillArchiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.build?.skillArchiveBytes).toBeGreaterThan(0);
    expect((store.turns[0]!.metadata as any).recovery).toMatchObject({
      skillArchiveSha256: store.build?.skillArchiveSha256,
      skillArchiveBytes: store.build?.skillArchiveBytes,
      skillArchiveStorageKey: store.build?.skillArchiveStorageKey,
    });
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

  it("commits a start-before-upload build and turn without granting a provider lease", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "true";
    const attachmentManifest = [
      {
        itemId: "starter-item-1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1,
        sha256: "a".repeat(64),
      },
    ];
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });
    try {
      const result = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 1,
          expectedAttachmentCount: 3,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: attachmentManifest,
          requestPayload: {
            ...startInput.requestPayload,
            attachments: [],
            attachmentManifest,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            attachments: [],
            attachmentManifest,
            deferredClientAttachments: true,
          },
        },
        executor,
      );

      expect(result).toMatchObject({
        createdBuild: true,
        reservation: {
          state: "awaiting_attachments",
          turn: {
            attachmentFileIds: [],
            awaitingClientAttachments: true,
            providerProtocol: "manus_v2",
            providerAttemptState: "not_sent",
            expectedUserAttachmentCount: 1,
            stagedUserAttachmentCount: 0,
            upstreamTaskId: null,
            leaseExpiresAt: null,
          },
        },
      });
      expect(store.build).toMatchObject({
        providerProtocol: "manus_v2",
        canonicalTaskState: "unbound",
        upstreamTaskId: null,
        activeTurnId: result.reservation.turn.id,
      });
      expect(store.turns).toHaveLength(1);
      expect(store.messages).toHaveLength(1);
      expect(store.resources).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("cancels an incomplete start reservation only at its exact reset revision", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "true";
    const attachmentManifest = [
      {
        itemId: "starter-item-1",
        ordinal: 1,
        total: 2,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1,
        sha256: "a".repeat(64),
      },
      {
        itemId: "starter-item-2",
        ordinal: 2,
        total: 2,
        filename: "profile.docx",
        sizeBytes: 24,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        lastModified: 2,
        sha256: "b".repeat(64),
      },
    ];
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 0,
      resources: [
        {
          id: "resource-file-facts",
          userId: 1,
          apiCredentialId: "credential-1",
          projectAssignmentId: null,
          kind: "file",
          upstreamId: "file-facts",
          conversationId: null,
          contentDeletedAt: null,
        },
      ],
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    try {
      const started = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 2,
          expectedAttachmentCount: 4,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: attachmentManifest,
          requestPayload: {
            ...startInput.requestPayload,
            attachments: [],
            attachmentManifest,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            attachments: [],
            attachmentManifest,
            deferredClientAttachments: true,
          },
        },
        executor,
      );
      const originalOperationKey = started.reservation.turn.operationKey;

      await stageKnowledgeBaseDeferredTurnAttachment(
        {
          userId: 1,
          buildId: started.build.id,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          clientAttachmentManifest: attachmentManifest,
          expectedResetRevision: 0,
          index: 0,
          attachment: { file_id: "file-facts", filename: "facts.pdf" },
        },
        executor,
      );
      expect(store.turns[0]).toMatchObject({
        status: "queued",
        upstreamTaskId: null,
        leaseExpiresAt: null,
        attachmentFileIds: ["file-facts"],
        metadata: {
          awaitingClientAttachments: true,
          createAttemptState: "not_sent",
          providerAttemptState: "not_sent",
        },
      });

      const cancelledAt = new Date("2026-08-01T00:00:30.000Z");
      const cancelled = await cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: startInput.conversationId,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          expectedResetRevision: 0,
          now: cancelledAt,
        },
        executor,
      );

      expect(cancelled).toMatchObject({
        id: started.reservation.turn.id,
        status: "cancelled",
        upstreamTaskId: null,
        completedAt: cancelledAt,
        leaseExpiresAt: null,
        awaitingClientAttachments: false,
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
      });
      expect(cancelled.operationKey).not.toBe(originalOperationKey);
      expect(store.resources[0]).toMatchObject({
        upstreamId: "file-facts",
        conversationId: null,
      });
      expect(store.retainedTombstones).toEqual([
        expect.objectContaining({
          userId: 1,
          publicConversationId: startInput.conversationId,
          resetAt: cancelledAt,
        }),
      ]);
      expect(store).toMatchObject({
        build: null,
        conversation: null,
        turns: [],
        messages: [],
      });

      const freshConversationId = "conversation-after-cancel";
      const freshExecutor = createTurnServiceExecutor({
        resetRevision: 0,
        resources: store.resources,
        turnSelections: [[[], []]],
      });
      const restarted = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          conversationId: freshConversationId,
          clientRequestId: "start-request-after-cancel",
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            conversationId: freshConversationId,
          },
        },
        freshExecutor.executor,
      );
      expect(restarted).toMatchObject({
        createdBuild: true,
        reservation: {
          state: "acquired",
          turn: {
            operationType: "start",
            upstreamTaskId: null,
          },
        },
      });
      expect(freshExecutor.store.build?.conversationId).toBe(
        freshConversationId,
      );
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("rejects incomplete start cancellation after the reset revision advances", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "true";
    const attachmentManifest = [
      {
        itemId: "starter-item-stale",
        ordinal: 1,
        total: 1,
        filename: "stale.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1,
        sha256: "c".repeat(64),
      },
    ];
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 0,
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    try {
      const started = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 1,
          expectedAttachmentCount: 3,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: attachmentManifest,
          requestPayload: {
            ...startInput.requestPayload,
            attachments: [],
            attachmentManifest,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            attachments: [],
            attachmentManifest,
            deferredClientAttachments: true,
          },
        },
        executor,
      );
      store.resetRevision = 1;
      const beforeCancellation = structuredClone(store);

      await expect(
        cancelIncompleteKnowledgeBaseStart(
          {
            userId: 1,
            conversationId: startInput.conversationId,
            turnId: started.reservation.turn.id,
            clientRequestId: started.reservation.turn.clientRequestId,
            expectedResetRevision: 0,
          },
          executor,
        ),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
      });
      expect(store).toEqual(beforeCancellation);
      expect(store.turns[0]).toMatchObject({
        status: "queued",
        upstreamTaskId: null,
        metadata: {
          awaitingClientAttachments: true,
          sourceResetRevision: 0,
        },
      });
      expect(store.build?.activeTurnId).toBe(started.reservation.turn.id);
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("rejects start cancellation when the staged and recovery ledgers diverge", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 0,
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const started = await reserveKnowledgeBaseStartBuild(startInput, executor);
    store.turns[0].attachmentFileIds = ["unknown-extra-file"];
    const before = structuredClone(store);

    await expect(
      cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: startInput.conversationId,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          expectedResetRevision: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(before);
  });

  it("rejects confirm attachment turns through the customer start-cancel authority", async () => {
    const build = {
      id: identity.buildId,
      userId: 1,
      conversationId: "conversation-1",
      generation: identity.buildGeneration,
      stateEpoch: 2,
      revision: identity.expectedRevision,
      currentLeafId: identity.expectedLeafId,
      status: "confirming",
      activeTurnId: turn().id,
      upstreamTaskId: "parent-task",
    };
    const confirmTurn = turn({
      status: "queued",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
      },
    });
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation: {
        id: "u1:conversation-1",
        userId: 1,
        version: 1,
        status: "running",
      },
      turns: [confirmTurn],
      turnSelections: [[(current) => current.turns]],
    });
    const before = structuredClone(store);

    await expect(
      cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: confirmTurn.id,
          clientRequestId: confirmTurn.clientRequestId,
          expectedResetRevision: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(before);
  });

  it("pins a new build and its first turn to legacy only while the Manus v2 writer is explicitly disabled", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "false";
    try {
      const { executor, store } = createTurnServiceExecutor({
        turnSelections: [[[], []]],
      });
      const result = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          conversationId: "conversation-legacy-writer",
          clientRequestId: "start-request-legacy-writer",
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            conversationId: "conversation-legacy-writer",
          },
        },
        executor,
      );

      expect(result.build.providerProtocol).toBe("legacy_v1");
      expect(result.reservation.turn.providerProtocol).toBe("legacy_v1");
      expect(store.build?.providerProtocol).toBe("legacy_v1");
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("starts a new conversation without mutating a rejected historical build turn", async () => {
    const rejectedHistoricalTurn = turn({
      id: "00000000-0000-4000-8000-000000000091",
      conversationId: "u1:conversation-failed-historical",
      buildId: "00000000-0000-4000-8000-000000000092",
      buildGeneration: 1,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_3",
      errorMessage: "上游已明确拒绝创建本轮任务",
      completedAt: new Date("2026-07-31T23:00:00.000Z"),
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "rejected",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });
    const historicalSnapshot = structuredClone(rejectedHistoricalTurn);
    const { executor, store } = createTurnServiceExecutor({
      turns: [rejectedHistoricalTurn],
      turnSelections: [[[], []]],
    });

    const started = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        conversationId: "conversation-new-after-rejection",
        clientRequestId: "start-request-new-after-rejection",
        recoveryMetadata: {
          ...startInput.recoveryMetadata,
          conversationId: "conversation-new-after-rejection",
        },
      },
      executor,
    );

    expect(started.createdBuild).toBe(true);
    expect(started.reservation.state).toBe("acquired");
    expect(started.reservation.turn.id).not.toBe(rejectedHistoricalTurn.id);
    expect(
      store.turns.find(
        (candidate) => candidate.id === rejectedHistoricalTurn.id,
      ),
    ).toEqual(historicalSnapshot);
    expect(store.turns).toHaveLength(2);
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

  it.each([
    ["confirm", false],
    ["revise", true],
  ] as const)(
    "continues an existing v2 canonical %s turn with its retired pinned credential",
    async (operationType, deferred) => {
      const canonicalBuild = {
        id: "00000000-0000-4000-8000-000000000023",
        userId: 1,
        conversationId: "conversation-retired-v2-canonical",
        companyName: "FrontMind 超前智能",
        companyWebsite: "https://www.frontmind.net/",
        skillName: "socratic-kb-builder",
        skillVersion: "4",
        skillContentHash: "a".repeat(64),
        providerProtocol: "manus_v2",
        canonicalTaskId: "canonical-task-a",
        canonicalTaskGeneration: 2,
        canonicalCredentialId: "credential-a",
        canonicalTaskState: "active",
        status: "confirming",
        generation: 2,
        stateEpoch: 5,
        revision: 3,
        currentLeafId: "1.4",
        currentPresentationKey: null,
        activeTurnId: null,
        upstreamTaskId: "canonical-task-a",
        recoveryLeaseExpiresAt: null,
        protocolErrorCode: null,
        protocolError: null,
      };
      const frozenManifest = deferred
        ? [
            {
              itemId: "batch-retired:1",
              ordinal: 1,
              total: 1,
              filename: "facts.pdf",
              mimeType: "application/pdf",
              sizeBytes: 12,
              sha256: "f".repeat(64),
              lastModified: 1,
            },
          ]
        : undefined;
      const harness = createTurnServiceExecutor({
        build: canonicalBuild,
        conversation: {
          id: "u1:conversation-retired-v2-canonical",
          userId: 1,
          apiCredentialId: "credential-a",
          projectAssignmentId: null,
          deletedAt: null,
          deletedMessageIds: [],
          version: 1,
          status: "awaiting_input",
        },
        credentials: [
          { id: "credential-a", userId: 7, status: "retired" },
          { id: "credential-b", userId: 8, status: "active" },
        ],
        usageOwnerId: 8,
        turnSelections: [[[], []]],
      });
      await expect(
        reserveKnowledgeBaseTurn(
          {
            userId: 1,
            buildId: canonicalBuild.id,
            clientRequestId: `retired-canonical-${operationType}`,
            operationType,
            expectedGeneration: 2,
            expectedRevision: 3,
            expectedLeafId: "1.4",
            requestPayload: { userMessage: "确认", frozenManifest },
            apiCredentialId: "credential-a",
            userText: "确认",
            userAttachmentCount: deferred ? 1 : 0,
            expectedAttachmentCount: deferred ? 1 : 0,
            deferDispatchUntilAttachments: deferred,
            clientAttachmentManifest: frozenManifest,
            recoveryMetadata: {
              kind: "turn",
              conversationId: canonicalBuild.conversationId,
              parentTaskId: canonicalBuild.canonicalTaskId,
              attachments: [],
              ...(frozenManifest ? { attachmentManifest: frozenManifest } : {}),
            },
          },
          harness.executor,
        ),
      ).resolves.toMatchObject({
        state: deferred ? "awaiting_attachments" : "acquired",
        turn: { apiCredentialId: "credential-a" },
      });
      expect(harness.store.turns).toHaveLength(1);
    },
  );

  it("rejects a deleted v2 canonical credential instead of silently using the replacement key", async () => {
    const canonicalBuild = {
      id: "00000000-0000-4000-8000-000000000024",
      userId: 1,
      conversationId: "conversation-deleted-v2-canonical",
      companyName: "FrontMind 超前智能",
      companyWebsite: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      providerProtocol: "manus_v2",
      canonicalTaskId: "canonical-task-deleted",
      canonicalTaskGeneration: 2,
      canonicalCredentialId: "credential-deleted",
      canonicalTaskState: "active",
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      currentPresentationKey: null,
      activeTurnId: null,
      upstreamTaskId: "canonical-task-deleted",
      recoveryLeaseExpiresAt: null,
      protocolErrorCode: null,
      protocolError: null,
    };
    const harness = createTurnServiceExecutor({
      build: canonicalBuild,
      conversation: {
        id: "u1:conversation-deleted-v2-canonical",
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
      },
      credentials: [
        { id: "credential-deleted", userId: 7, status: "deleted" },
        { id: "credential-current", userId: 8, status: "active" },
      ],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        {
          userId: 1,
          buildId: canonicalBuild.id,
          clientRequestId: "deleted-canonical-confirm",
          operationType: "confirm",
          expectedGeneration: 2,
          expectedRevision: 3,
          expectedLeafId: "1.4",
          requestPayload: { userMessage: "确认" },
          apiCredentialId: "credential-deleted",
          userText: "确认",
          expectedAttachmentCount: 0,
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.turns).toHaveLength(0);
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
  const deferredUploadResources = () =>
    [
      "file-facts",
      "file-logo-notes",
      "old-staged-facts",
      "replacement-facts",
      "replacement-logo-notes",
    ].map((upstreamId) => ({
      id: `resource-${upstreamId}`,
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId,
      conversationId: null,
      contentDeletedAt: null,
    }));

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
      resources: deferredUploadResources(),
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

  it("keeps a start turn lease-free after N/N stage until explicit dispatch", async () => {
    const startBuild = {
      ...build,
      status: "researching",
      generation: 1,
      revision: 0,
      currentLeafId: null,
      upstreamTaskId: null,
    };
    const startConversation = {
      ...conversation,
      status: "running",
    };
    const { executor, store } = createTurnServiceExecutor({
      build: startBuild,
      conversation: startConversation,
      resources: deferredUploadResources(),
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(
      {
        ...reserveInput(),
        buildId: startBuild.id,
        operationType: "start",
        sourceResetRevision: 0,
        expectedGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        requestPayload: {
          companyName: startBuild.companyName,
          attachments: [],
          attachmentManifest: manifest,
          skillVersion: "4",
        },
        userText: "开始构建企业知识库",
        recoveryMetadata: {
          ...reserveInput().recoveryMetadata,
          kind: "start",
          attachments: [],
        },
      },
      executor,
    );
    store.build!.activeTurnId = reserved.turn.id;

    for (const [index, attachment] of [
      { file_id: "file-facts", filename: "facts.pdf" },
      { file_id: "file-logo-notes", filename: "logo-notes.txt" },
    ].entries()) {
      await stageKnowledgeBaseDeferredTurnAttachment(
        {
          userId: 1,
          buildId: startBuild.id,
          turnId: reserved.turn.id,
          clientRequestId: reserved.turn.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
          index,
          attachment,
        },
        executor,
      );
    }
    expect(store.turns[0]).toMatchObject({
      status: "queued",
      leaseExpiresAt: null,
      upstreamTaskId: null,
      metadata: { awaitingClientAttachments: true },
    });

    const dispatched = await claimKnowledgeBaseDeferredTurnDispatch(
      {
        userId: 1,
        buildId: startBuild.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
      },
      executor,
    );
    expect(dispatched).toMatchObject({
      state: "acquired",
      turn: { awaitingClientAttachments: false, upstreamTaskId: null },
    });
    expect(store.messages).toHaveLength(1);
  });

  it("atomically claims the deferred turn when the final customer attachment is staged", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      resources: deferredUploadResources(),
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
      resources: deferredUploadResources(),
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

  it("keeps the exact 15:52 replacement inert until migration grants recovery", async () => {
    const replacement = turn({
      id: "00000000-0000-4000-8000-000000000035",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      status: "queued",
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: false,
        createAttemptState: "not_sent",
        providerProtocol: "legacy_v1",
        providerAttemptState: "not_sent",
        repairKind: "legacy_skill_404_confirm",
        recovery: { kind: "turn" },
      },
    });
    const selection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === replacement.id);
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build, activeTurnId: replacement.id },
      conversation: { ...conversation },
      turns: [replacement],
      turnSelections: [[selection], [selection]],
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery({ turnId: replacement.id }, executor),
    ).resolves.toBeNull();
    expect(store.turns[0]?.leaseExpiresAt).toBeNull();

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: replacement.id,
          allowLegacySkill404IncidentRepair: true,
        },
        executor,
      ),
    ).resolves.toMatchObject({
      turn: { id: replacement.id, createAttemptState: "not_sent" },
    });
  });

  it("claims stale sending once for unknown projection but never reclaims unknown", async () => {
    for (const createAttemptState of ["sending", "unknown"] as const) {
      const unresolved = turn({
        id:
          createAttemptState === "sending"
            ? "00000000-0000-4000-8000-000000000032"
            : "00000000-0000-4000-8000-000000000033",
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        status: "running",
        leaseExpiresAt: new Date("2026-07-31T23:59:00.000Z"),
        metadata: {
          attachmentsFrozen: true,
          createAttemptState,
          recovery: { kind: "turn" },
        },
      });
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build, activeTurnId: unresolved.id },
        conversation: { ...conversation },
        turns: [unresolved],
        turnSelections: [[[unresolved]]],
      });
      const claimed = await claimKnowledgeBaseTurnForRecovery(
        {
          turnId: unresolved.id,
          now: new Date("2026-08-01T00:00:00.000Z"),
        },
        executor,
      );
      if (createAttemptState === "sending") {
        expect(claimed).toMatchObject({
          turn: { createAttemptState: "sending" },
        });
      } else {
        expect(claimed).toBeNull();
      }
      expect(store.turns[0]?.metadata).toMatchObject({ createAttemptState });
    }
  });

  it("keeps a generic pre-create failure not_sent and recoverable", async () => {
    const leaseToken = "pre-create-generic-lease";
    const unresolved = turn({
      id: "00000000-0000-4000-8000-000000000034",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      status: "running",
      leaseExpiresAt: new Date("2026-08-01T00:00:30.000Z"),
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        recovery: { kind: "turn" },
      },
    });
    const dynamicActive = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === unresolved.id);
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build, activeTurnId: unresolved.id },
      conversation: { ...conversation },
      turns: [unresolved],
      turnSelections: [[dynamicActive], [dynamicActive]],
    });

    const persisted = await markKnowledgeBaseTurnOutcomeUnknown(
      {
        userId: unresolved.userId,
        turnId: unresolved.id,
        leaseToken,
        code: "PRECREATE_GENERIC_FAILURE",
        now: new Date("2026-08-01T00:00:00.000Z"),
        recoveryDelayMs: 1_000,
      },
      executor,
    );
    expect(persisted).toMatchObject({
      createAttemptState: "not_sent",
      status: "running",
    });
    expect(store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "not_sent",
      outcomeUnknownCode: "PRECREATE_GENERIC_FAILURE",
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: unresolved.id,
          now: new Date("2026-08-01T00:00:02.000Z"),
        },
        executor,
      ),
    ).resolves.toMatchObject({
      turn: { createAttemptState: "not_sent" },
    });
  });

  it("automatically reclaims the exact failed system-file create rejection without changing operation or charge authority", async () => {
    const rejected = turn({
      id: "00000000-0000-4000-8000-000000000036",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      operationKey: "kbv2_exact_inline_recovery",
      status: "failed",
      errorCode: "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE",
      errorMessage: "system Skill file.create rejected",
      completedAt: new Date("2026-08-01T00:00:01.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: ["kb-local-skill", "kb-local-instructions"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        createAttemptState: "not_sent",
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
        chargeDisposition: "reuse_original_no_charge",
        recovery: { kind: "turn", conversationId: build.conversationId },
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: {
            prompt: "full frozen business prompt",
            agentProfile: "manus-1.6-max",
            attachments: [
              {
                file_id: "kb-local-skill",
                filename: "socratic-kb-builder.skill.zip",
              },
              {
                file_id: "kb-local-instructions",
                filename: "frontmind-kb-server-instructions.txt",
              },
            ],
          },
          bodySha256: "f".repeat(64),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
        manusV2AttachmentAttempts: {
          rejectedSkill: {
            schemaVersion: 1,
            mappingKey: "rejectedSkill",
            buildGeneration: build.generation,
            attachmentIndex: 0,
            sourceFileId: "kb-local-skill",
            localStorageKey: "knowledge-base/build-sources/skill.bin",
            contentSha256: "a".repeat(64),
            sizeBytes: 48_000,
            filename: "socratic-kb-builder.skill.zip",
            mimeType: "application/zip",
            providerGeneration: 1,
            state: "create_rejected",
            upstreamFileId: null,
            uploadExpiresAt: null,
            code: "MANUS_V2_FILE_CREATE_any_provider_code",
            recordedAt: "2026-08-01T00:00:01.000Z",
          },
        },
        generatedAttachmentReservations: {
          "skill:0": {
            schemaVersion: 1,
            role: "skill",
            attachmentIndex: 0,
            requestHash: "c".repeat(64),
            idempotencyKeyHash: "d".repeat(64),
            filename: "socratic-kb-builder.skill.zip",
            mimeType: "application/zip",
            sizeBytes: 48_000,
            contentSha256: "a".repeat(64),
            localStorageKey: "knowledge-base/build-sources/skill.bin",
            status: "reserved",
            reservedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      },
    });
    const selection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === rejected.id);
    const { executor, store } = createTurnServiceExecutor({
      build: {
        ...build,
        activeTurnId: rejected.id,
        status: "protocol_error",
        protocolErrorCode: rejected.errorCode,
        protocolError: rejected.errorMessage,
      },
      conversation: { ...conversation, status: "failed" },
      turns: [rejected],
      turnSelections: [[selection]],
    });

    const claimed = await claimKnowledgeBaseTurnForRecovery(
      {
        turnId: rejected.id,
        now: new Date("2026-08-01T00:00:02.000Z"),
      },
      executor,
    );

    expect(claimed).toMatchObject({
      turn: {
        id: rejected.id,
        operationKey: rejected.operationKey,
        status: "running",
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
      },
    });
    expect(claimed?.recoveryMetadata).toMatchObject({ kind: "turn" });
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]?.metadata).toMatchObject({
      chargeDisposition: "reuse_original_no_charge",
      manusV2AttachmentAttempts: {
        rejectedSkill: { state: "create_rejected", upstreamFileId: null },
      },
    });
    expect(store.build).toMatchObject({
      status: "confirming",
      protocolErrorCode: null,
      activeTurnId: rejected.id,
    });
  });

  it.each([
    ["customer attachment", null],
    ["prefill", "prefill"],
    ["finalization", "finalization"],
    ["hash mismatch", "skill-mismatched"],
  ])(
    "does not reclaim rejected %s as an inline system file",
    async (_label, role) => {
      const rejected = turn({
        id: "00000000-0000-4000-8000-000000000037",
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        status: "failed",
        errorCode: "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE",
        completedAt: new Date("2026-08-01T00:00:01.000Z"),
        leaseExpiresAt: null,
        attachmentFileIds: ["source-file"],
        metadata: {
          attachmentsFrozen: true,
          expectedAttachmentCount: 1,
          createAttemptState: "not_sent",
          providerProtocol: "manus_v2",
          providerAttemptState: "not_sent",
          recovery: { kind: "turn" },
          preparedDispatch: {
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "frozen prompt",
              agentProfile: "manus-1.6-max",
              attachments: [{ file_id: "source-file", filename: "source.bin" }],
            },
            bodySha256: "f".repeat(64),
            preparedAt: "2026-08-01T00:00:00.000Z",
          },
          ...(role
            ? {
                generatedAttachmentReservations: {
                  [`${role}:0`]: {
                    schemaVersion: 1,
                    role: role === "skill-mismatched" ? "skill" : role,
                    attachmentIndex: 0,
                    requestHash: "a".repeat(64),
                    idempotencyKeyHash: "b".repeat(64),
                    filename: "source.bin",
                    mimeType: "application/octet-stream",
                    sizeBytes: 10,
                    contentSha256:
                      role === "skill-mismatched"
                        ? "e".repeat(64)
                        : "c".repeat(64),
                    status: "reserved",
                    reservedAt: "2026-08-01T00:00:00.000Z",
                  },
                },
              }
            : {}),
          manusV2AttachmentAttempts: {
            rejected: {
              schemaVersion: 1,
              mappingKey: "rejected",
              buildGeneration: build.generation,
              attachmentIndex: 0,
              sourceFileId: "source-file",
              localStorageKey: "knowledge-base/build-sources/source.bin",
              contentSha256: "c".repeat(64),
              sizeBytes: 10,
              filename: "source.bin",
              mimeType: "application/octet-stream",
              providerGeneration: 1,
              state: "create_rejected",
              upstreamFileId: null,
              uploadExpiresAt: null,
              code: "permission_denied",
              recordedAt: "2026-08-01T00:00:01.000Z",
            },
          },
        },
      });
      const selection = (store: TurnServiceStore) =>
        store.turns.filter((candidate) => candidate.id === rejected.id);
      const { executor } = createTurnServiceExecutor({
        build: {
          ...build,
          activeTurnId: rejected.id,
          status: "protocol_error",
        },
        conversation: { ...conversation },
        turns: [rejected],
        turnSelections: [[selection]],
      });
      await expect(
        claimKnowledgeBaseTurnForRecovery({ turnId: rejected.id }, executor),
      ).resolves.toBeNull();
    },
  );
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
        dispatchingAt: "2026-08-01T00:00:05.000Z",
        createAttemptState: "sending",
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
      createAttemptRejected: true,
      reasonCategory: "ATTACHMENT_INVALID",
      providerRequestRef: "sha256:1234567890abcdef12345678",
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
    expect(store.turns[0]!.metadata).toMatchObject({
      createAttemptState: "rejected",
      providerReasonCategory: "ATTACHMENT_INVALID",
      providerRequestRef: "sha256:1234567890abcdef12345678",
    });
    expect(store.conversation).toMatchObject({ status: "failed", version: 5 });
  });
});

describe("knowledge-base safe retry reservation", () => {
  it("requires explicit regeneration metadata and rejects a forged rejected start", () => {
    const source = retryableFailedTurn();
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
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
    for (const metadataPatch of [
      { failureClass: "requires_user_fix" },
      { recoveryAction: "contact_support" },
      { canRegenerate: false },
    ]) {
      const candidate = {
        ...source,
        metadata: { ...(source.metadata as object), ...metadataPatch },
      } as ConversationTurn;
      expect(inspectKnowledgeBaseRetryAuthority(candidate, build)).toBeNull();
    }

    const startRecovery = {
      kind: "start",
      conversationId: "conversation-1",
      companyName: build.companyName,
      companyWebsite: build.companyWebsite,
      operatorNotes: "",
      attachments: [] as Array<{ file_id: string; filename: string }>,
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      prefillSnapshotId: null,
    };
    const startBody = {
      prompt: "documented rejected start prompt",
      agentProfile: "manus-1.6-max",
      attachments: [
        { file_id: "start-skill", filename: "skill.zip" },
        { file_id: "start-instructions", filename: "instructions.txt" },
      ],
    };
    const startOperationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: build.generation,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
    });
    const rejectedStart = turn({
      status: "failed",
      operationType: "start",
      operationKey: startOperationKey,
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: build.generation,
        revision: 0,
        leafId: null,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        payload: {
          companyName: startRecovery.companyName,
          companyWebsite: startRecovery.companyWebsite,
          operatorNotes: startRecovery.operatorNotes,
          attachments: startRecovery.attachments,
          skillVersion: startRecovery.skillVersion,
          skillContentHash: startRecovery.skillContentHash,
          prefillSnapshotId: startRecovery.prefillSnapshotId,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(startOperationKey),
      ),
      upstreamTaskId: null,
      attachmentFileIds: startBody.attachments.map(
        (attachment) => attachment.file_id,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        failureClass: "terminal_requires_regeneration",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
        createAttemptState: "rejected",
        recovery: startRecovery,
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: startBody,
          bodySha256: hashKnowledgeBaseTurnRequest(startBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
      completedAt: new Date("2026-08-01T00:00:20.000Z"),
      leaseExpiresAt: null,
    });
    const startBuild = {
      ...build,
      revision: 0,
      currentLeafId: null,
    };
    expect(
      inspectKnowledgeBaseRetryAuthority(rejectedStart, startBuild),
    ).toBeNull();
  });

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
      failureClass: "terminal_requires_regeneration",
      recoveryAction: "regenerate_turn",
      canRegenerate: true,
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
      failureClass: "terminal_requires_regeneration",
      recoveryAction: "regenerate_turn",
      canRegenerate: true,
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
