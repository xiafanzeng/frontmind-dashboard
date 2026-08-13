import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  ConversationTurn,
  KnowledgeBaseBuild,
  KnowledgeBaseBuildNode,
  UpstreamResource,
} from "../drizzle/schema";
import { conversationTurns, workspaceAuditEvents } from "../drizzle/schema";
import {
  applyKnowledgeBaseIncidentRepair,
  assertKnowledgeBaseIncidentRepairRolloutAuthorized,
  executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance,
  hashKnowledgeBaseIncidentRepairState,
  knowledgeBaseIncidentAuditTarget,
  previewKnowledgeBaseIncidentRepair,
  previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance,
  previewKnowledgeBaseIncidentRepairFacts,
  type KnowledgeBaseIncidentRepairFacts,
} from "./knowledge-base-incident-repair";

const BUILD_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "20000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "30000000-0000-4000-8000-000000000001";
const STORED_CONVERSATION_ID = "u7:conversation-incident";
const NOW = new Date("2026-08-12T12:00:00.000Z");
const ACTIVE_MIGRATION_ENV = {
  FRONTMIND_KB_MANUS_V2_WRITER: "false",
  FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "true",
};

function build(
  overrides: Partial<KnowledgeBaseBuild> = {},
): KnowledgeBaseBuild {
  return {
    id: BUILD_ID,
    userId: 7,
    conversationId: "conversation-incident",
    companyName: "Example Inc.",
    companyWebsite: "https://example.test",
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
    skillContentHash: "a".repeat(64),
    treePolicyVersion: 2,
    initialResearchCoverage: null,
    status: "protocol_error",
    generation: 3,
    stateEpoch: 17,
    activeTurnId: TURN_ID,
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    lastAppliedOperationKey: "previous-operation",
    currentPresentationKey: "presentation-8.5",
    revision: 40,
    currentLeafId: "8.5",
    totalNodeCount: 40,
    confirmedCount: 39,
    directPrefilledCount: 0,
    needsVerificationCount: 0,
    lastReconciledHash: "b".repeat(64),
    lastOutputLength: 2048,
    lastOutputItemIds: ["accepted-output"],
    lastTurnUserText: "确认",
    lastTurnAttachmentCount: 0,
    awaitingResponseSince: null,
    packageRevision: null,
    packageTaskId: null,
    packageOutputItemId: null,
    packageFileId: null,
    packageFilename: null,
    packageDescriptorHash: null,
    skillArchiveSha256: "c".repeat(64),
    skillArchiveBytes: 4096,
    skillArchiveStorageKey: "knowledge-base/skills/pinned.zip",
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
    protocolErrorCode: "SKILL_FILE_404",
    protocolError: "safe historical failure",
    publishedSnapshotId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-12T11:00:00.000Z"),
    completedAt: null,
    publishedAt: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: STORED_CONVERSATION_ID,
    userId: 7,
    apiCredentialId: CREDENTIAL_ID,
    projectAssignmentId: null,
    title: "知识库 · Example Inc.",
    status: "failed",
    upstreamTaskId: "legacy-main-task",
    previousResponseId: "legacy-main-task",
    taskUrl: null,
    lastKnownOutputLength: 2048,
    deletedMessageIds: [],
    version: 9,
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    completedAt: new Date("2026-08-12T11:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-12T11:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: TURN_ID,
    conversationId: STORED_CONVERSATION_ID,
    userId: 7,
    apiCredentialId: CREDENTIAL_ID,
    clientRequestId: "historical-confirm",
    buildId: BUILD_ID,
    buildGeneration: 3,
    operationKey: "historical-confirm-operation",
    operationType: "confirm",
    expectedRevision: 40,
    expectedLeafId: "8.5",
    requestHash: "d".repeat(64),
    upstreamIdempotencyKeyHash: "e".repeat(64),
    attachmentFileIds: [],
    metadata: {
      attachmentsFrozen: false,
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      createAttemptState: "not_sent",
      providerProtocol: "legacy_v1",
      providerAttemptState: "not_sent",
      operationToken: "historical-confirm-operation",
      dispatchState: "failed",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      recovery: {
        kind: "turn",
        conversationId: "conversation-incident",
        parentTaskId: "legacy-main-task",
        userMessage: "确认",
        attachments: [],
        attachmentManifest: [],
        skillVersion: "4",
        skillContentHash: "a".repeat(64),
      },
    },
    leaseExpiresAt: null,
    model: null,
    status: "failed",
    upstreamTaskId: null,
    errorCode: "SKILL_FILE_404",
    errorMessage: "safe historical failure",
    startedAt: null,
    completedAt: new Date("2026-08-12T11:00:00.000Z"),
    createdAt: new Date("2026-08-12T10:59:00.000Z"),
    updatedAt: new Date("2026-08-12T11:00:00.000Z"),
    ...overrides,
  };
}

function nodes(count = 40): KnowledgeBaseBuildNode[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    id: `node-${String(ordinal).padStart(3, "0")}`,
    buildId: BUILD_ID,
    leafId: ordinal === count - 1 ? "8.5" : `leaf-${ordinal}`,
    branchId: `branch-${Math.floor(ordinal / 5)}`,
    branchTitle: `Branch ${Math.floor(ordinal / 5)}`,
    title: `Leaf ${ordinal}`,
    ordinal,
    status: ordinal === count - 1 ? "current" : "confirmed",
    transitionReason: null,
    contentMarkdown: `accepted markdown ${ordinal}`,
    lastUserInput: null,
    sourceUrls: [],
    imageUrls: [],
    lastTaskId: "legacy-main-task",
    sourceTurnId: ordinal === count - 1 ? "accepted-turn" : null,
    presentationKey: ordinal === count - 1 ? "presentation-8.5" : null,
    contentSha256: null,
    lastResponseAt: NOW,
    confirmedAt: ordinal === count - 1 ? null : NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

function fileResource(fileId: string): UpstreamResource {
  return {
    id: `resource-${fileId}`,
    userId: 7,
    apiCredentialId: CREDENTIAL_ID,
    projectAssignmentId: null,
    kind: "file",
    upstreamId: fileId,
    conversationId: STORED_CONVERSATION_ID,
    createdAt: NOW,
    uploadedAt: NOW,
    contentExpiresAt: new Date("2026-09-12T00:00:00.000Z"),
    contentDeletedAt: null,
  };
}

function facts(
  input: {
    build?: KnowledgeBaseBuild;
    turn?: ConversationTurn;
    nodes?: KnowledgeBaseBuildNode[];
    resources?: UpstreamResource[];
  } = {},
): KnowledgeBaseIncidentRepairFacts {
  return {
    build: input.build ?? build(),
    activeTurn: input.turn ?? turn(),
    nodes: input.nodes ?? nodes(),
    conversation: conversation(),
    credential: { id: CREDENTIAL_ID, userId: 7, status: "retired" },
    attachmentResources: input.resources ?? [],
  };
}

function startFacts() {
  const sources = Array.from({ length: 8 }, (_, index) => {
    const ordinal = index + 1;
    const bytes = Buffer.from(`retained customer file ${ordinal}`);
    const filename = `source-${ordinal}.pdf`;
    return {
      bytes,
      filename,
      attachment: { file_id: `retained-file-${ordinal}`, filename },
      manifest: {
        filename,
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
        lastModified: ordinal,
        sha256: createSha(bytes),
      },
    };
  });
  const attachments = sources.map((source) => source.attachment);
  const manifest = sources.map((source) => source.manifest);
  return {
    bytes: sources.map((source) => source.bytes),
    filenames: sources.map((source) => source.filename),
    facts: facts({
      build: build({
        upstreamTaskId: null,
        revision: 0,
        currentLeafId: null,
        currentPresentationKey: null,
        totalNodeCount: 0,
        confirmedCount: 0,
        lastAppliedOperationKey: null,
        protocolErrorCode: "UPSTREAM_CREATE_3",
      }),
      turn: turn({
        operationType: "start",
        expectedRevision: 0,
        expectedLeafId: null,
        errorCode: "UPSTREAM_CREATE_3",
        attachmentFileIds: attachments.map((item) => item.file_id),
        metadata: {
          attachmentsFrozen: true,
          expectedAttachmentCount: 10,
          userAttachmentCount: 8,
          createAttemptState: "rejected",
          providerProtocol: "legacy_v1",
          providerAttemptState: "rejected",
          operationToken: "historical-start-operation",
          dispatchState: "failed",
          recovery: {
            kind: "start",
            conversationId: "conversation-incident",
            companyName: "Example Inc.",
            companyWebsite: "https://example.test",
            attachments,
            attachmentManifest: manifest,
            skillVersion: "4",
            skillContentHash: "a".repeat(64),
            includePrefill: false,
          },
        },
      }),
      nodes: [],
      resources: attachments.map((item) => fileResource(item.file_id)),
    }),
  };
}

function createSha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function query(value: unknown) {
  const promise = Promise.resolve(value);
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    for: () => chain,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
  return chain;
}

function serviceDb(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  failAuditInsert?: boolean;
  mutateFactsBeforeTransaction?: (
    value: KnowledgeBaseIncidentRepairFacts,
  ) => KnowledgeBaseIncidentRepairFacts;
}) {
  const selections = (value: KnowledgeBaseIncidentRepairFacts) => [
    [value.build],
    value.activeTurn ? [value.activeTurn] : [],
    value.nodes,
    value.conversation ? [value.conversation] : [],
    value.credential ? [value.credential] : [],
    value.attachmentResources,
  ];
  const insertedTurns: Record<string, unknown>[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const transaction = vi.fn(async (callback: (executor: any) => unknown) => {
    const insertedTurnsLength = insertedTurns.length;
    const auditEventsLength = auditEvents.length;
    const updatesLength = updates.length;
    const lockedFacts = input.mutateFactsBeforeTransaction
      ? input.mutateFactsBeforeTransaction(input.facts)
      : input.facts;
    const pending = selections(lockedFacts);
    const tx = {
      select: vi.fn(() => query(pending.shift() || [])),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (value: Record<string, unknown>) => {
          if (table === conversationTurns) insertedTurns.push(value);
          if (table === workspaceAuditEvents) {
            if (input.failAuditInsert) throw new Error("audit insert failed");
            auditEvents.push(value);
          }
          return [{ affectedRows: 1 }];
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: Record<string, unknown>) => {
          updates.push(value);
          return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
        }),
      })),
    };
    try {
      return await callback(tx);
    } catch (error) {
      insertedTurns.length = insertedTurnsLength;
      auditEvents.length = auditEventsLength;
      updates.length = updatesLength;
      throw error;
    }
  });
  return {
    db: { transaction },
    insertedTurns,
    auditEvents,
    updates,
  };
}

function stored(bytes: Buffer, filename: string) {
  return {
    filename,
    mimeType: "application/pdf",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256: createSha(bytes),
    uploadedAt: NOW,
    contentExpiresAt: new Date("2026-09-12T00:00:00.000Z"),
    contentStoredAt: NOW,
    manifestUpdatedAt: NOW,
    createReadStream: () => Readable.from(bytes),
  };
}

describe("knowledge-base incident CAS repair", () => {
  it("requires one explicit v2 rollout authority for the retained-start preview and execute path", () => {
    expect(() =>
      assertKnowledgeBaseIncidentRepairRolloutAuthorized(
        "retained_upstream_create_3_start",
        {
          FRONTMIND_KB_MANUS_V2_WRITER: "false",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
        },
      ),
    ).toThrow("requires an explicit Manus v2 writer");
    expect(() =>
      assertKnowledgeBaseIncidentRepairRolloutAuthorized(
        "retained_upstream_create_3_start",
        {
          FRONTMIND_KB_MANUS_V2_WRITER: "true",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseIncidentRepairRolloutAuthorized(
        "retained_upstream_create_3_start",
        {
          FRONTMIND_KB_MANUS_V2_WRITER: "false",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "true",
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseIncidentRepairRolloutAuthorized(
        "legacy_skill_404_confirm",
        {
          FRONTMIND_KB_MANUS_V2_WRITER: "false",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
        },
      ),
    ).toThrow("requires an explicit Manus v2 writer");
    expect(() =>
      assertKnowledgeBaseIncidentRepairRolloutAuthorized(
        "legacy_skill_404_confirm",
        {
          FRONTMIND_KB_MANUS_V2_WRITER: "true",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
        },
      ),
    ).toThrow("requires an explicit Manus v2 writer");
    expect(() =>
      assertKnowledgeBaseIncidentRepairRolloutAuthorized(
        "legacy_skill_404_confirm",
        {
          FRONTMIND_KB_MANUS_V2_WRITER: "false",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "true",
        },
      ),
    ).not.toThrow();
  });

  it("rejects retained-start preview and execute before opening the database when rollout is disabled", async () => {
    const getDatabase = vi.fn();
    const environment = {
      FRONTMIND_KB_MANUS_V2_WRITER: "false",
      FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
    };
    await expect(
      previewKnowledgeBaseIncidentRepair(
        {
          userId: 7,
          conversationId: "conversation-incident",
          repairKind: "retained_upstream_create_3_start",
        },
        { getDatabase: getDatabase as any, environment },
      ),
    ).rejects.toThrow("requires an explicit Manus v2 writer");
    await expect(
      applyKnowledgeBaseIncidentRepair(
        {
          userId: 7,
          conversationId: "conversation-incident",
          repairKind: "retained_upstream_create_3_start",
          expectedStateHash: "a".repeat(64),
          now: NOW,
        },
        { getDatabase: getDatabase as any, environment },
      ),
    ).rejects.toThrow("requires an explicit Manus v2 writer");
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("keeps the writer-only maintenance authority inside signed-image wrappers", async () => {
    const current = facts();
    const store = serviceDb({ facts: current });
    const previewSelections = [
      [current.build],
      current.activeTurn ? [current.activeTurn] : [],
      current.nodes,
      current.conversation ? [current.conversation] : [],
      current.credential ? [current.credential] : [],
      current.attachmentResources,
    ];
    const previewDb = {
      select: vi.fn(() => query(previewSelections.shift() || [])),
    };
    const environment = {
      FRONTMIND_KB_MANUS_V2_WRITER: "true",
      FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
    };

    await expect(
      previewKnowledgeBaseIncidentRepair(
        {
          userId: 7,
          conversationId: "conversation-incident",
          repairKind: "legacy_skill_404_confirm",
        },
        { getDatabase: async () => previewDb as any, environment },
      ),
    ).rejects.toThrow("requires an explicit Manus v2 writer");

    const preview =
      await previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance(
        {
          userId: 7,
          conversationId: "conversation-incident",
          repairKind: "legacy_skill_404_confirm",
        },
        { getDatabase: async () => previewDb as any, environment },
      );
    expect(preview).toMatchObject({ applicable: true, nodeCount: 40 });

    const result =
      await executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance(
        {
          userId: 7,
          conversationId: "conversation-incident",
          repairKind: "legacy_skill_404_confirm",
          expectedStateHash: preview!.stateHash,
          reasonCode: "authorized_incident_recovery",
          now: NOW,
        },
        { getDatabase: async () => store.db as any, environment },
      );
    expect(result).toMatchObject({ applied: true, generation: 3 });
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({
      actorUserId: null,
      actorUsername: "signed-image-maintenance",
      actorAccessLevel: null,
      action: "knowledge_base.incident_repair_applied",
      workspaceUserId: 7,
      reason: "authorized_incident_recovery",
    });
  });

  it("rolls back the repair when its required maintenance audit cannot commit", async () => {
    const current = facts();
    const stateHash = hashKnowledgeBaseIncidentRepairState(current);
    const store = serviceDb({ facts: current, failAuditInsert: true });

    await expect(
      executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance(
        {
          userId: 7,
          conversationId: "conversation-incident",
          repairKind: "legacy_skill_404_confirm",
          expectedStateHash: stateHash,
          reasonCode: "authorized_incident_recovery",
          now: NOW,
        },
        {
          getDatabase: async () => store.db as any,
          environment: {
            FRONTMIND_KB_MANUS_V2_WRITER: "true",
            FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
          },
        },
      ),
    ).rejects.toThrow("audit insert failed");
    expect(store.insertedTurns).toEqual([]);
    expect(store.auditEvents).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("hashes build/turn coordinates and the actual accepted node content deterministically", () => {
    const current = facts();
    const sameDifferentOrder = facts({ nodes: [...current.nodes].reverse() });
    expect(hashKnowledgeBaseIncidentRepairState(current)).toBe(
      hashKnowledgeBaseIncidentRepairState(sameDifferentOrder),
    );

    const changedContent = facts({
      nodes: current.nodes.map((node, index) =>
        index === 39
          ? { ...node, contentMarkdown: "tampered accepted markdown" }
          : node,
      ),
    });
    expect(hashKnowledgeBaseIncidentRepairState(changedContent)).not.toBe(
      hashKnowledgeBaseIncidentRepairState(current),
    );
  });

  it("previews the exact 15:52 no-task confirmation without requiring any customer action", () => {
    const preview = previewKnowledgeBaseIncidentRepairFacts({
      facts: facts(),
      repairKind: "legacy_skill_404_confirm",
      environment: ACTIVE_MIGRATION_ENV,
    });
    expect(preview).toMatchObject({
      applicable: true,
      blockers: [],
      requiresReselection: [],
      nodeCount: 40,
      userAttachmentCount: 0,
      buildGeneration: 3,
      buildRevision: 40,
    });
    expect(preview.plannedActions).toContain(
      "reserve_hidden_confirmation_without_user_message_or_charge",
    );
  });

  it("refuses a confirmation that already has a frozen dispatch or consumed create", () => {
    const source = turn({
      metadata: {
        ...turn().metadata,
        createAttemptState: "sending",
        preparedDispatch: {
          schemaVersion: 2,
          bodySha256: "f".repeat(64),
          preparedAt: NOW.toISOString(),
        },
      },
    });
    const preview = previewKnowledgeBaseIncidentRepairFacts({
      facts: facts({ turn: source }),
      repairKind: "legacy_skill_404_confirm",
      environment: ACTIVE_MIGRATION_ENV,
    });
    expect(preview.applicable).toBe(false);
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        "provider_attempt_not_not_sent",
        "prepared_dispatch_exists",
      ]),
    );
  });

  it("applies 15:52 as one hidden replacement while preserving all nodes and creating no message", async () => {
    const current = facts();
    const stateHash = hashKnowledgeBaseIncidentRepairState(current);
    const store = serviceDb({ facts: current });
    const inspection = vi.fn();
    const result = await applyKnowledgeBaseIncidentRepair(
      {
        userId: 7,
        conversationId: "conversation-incident",
        repairKind: "legacy_skill_404_confirm",
        expectedStateHash: stateHash,
        now: NOW,
        onBeforeCommit: async (committed) => inspection(committed),
      },
      {
        getDatabase: async () => store.db as any,
        environment: ACTIVE_MIGRATION_ENV,
      },
    );

    expect(result).toMatchObject({
      applied: true,
      noopReason: null,
      previousGeneration: 3,
      generation: 3,
      nodeCount: 40,
      userAttachmentCount: 0,
    });
    expect(store.insertedTurns).toHaveLength(1);
    expect(store.insertedTurns[0]).toMatchObject({
      operationType: "confirm",
      buildGeneration: 3,
      expectedRevision: 40,
      expectedLeafId: "8.5",
      status: "queued",
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: false,
        providerProtocol: "legacy_v1",
        providerAttemptState: "not_sent",
        repairKind: "legacy_skill_404_confirm",
        supersedesTurnId: TURN_ID,
        hiddenReplacement: true,
        chargeDisposition: "reuse_original_no_charge",
      },
    });
    expect(store.insertedTurns[0]?.operationKey).not.toBe(
      current.activeTurn?.operationKey,
    );
    expect(store.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "cancelled",
          metadata: expect.objectContaining({
            supersededByTurnId: result.replacementTurnId,
          }),
        }),
        expect.objectContaining({
          status: "confirming",
          activeTurnId: result.replacementTurnId,
          stateEpoch: 18,
        }),
      ]),
    );
    expect(inspection).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: expect.objectContaining({ nodes: current.nodes }),
        replacementTurn: store.insertedTurns[0],
      }),
    );
    // Only one INSERT occurs and it is conversation_turns: no user message,
    // provider task, file or charge ledger is written by the repair service.
    expect(store.insertedTurns).toHaveLength(1);
  });

  it("returns a safe no-op before writes when the locked state differs from preview", async () => {
    const current = facts();
    const stateHash = hashKnowledgeBaseIncidentRepairState(current);
    const store = serviceDb({
      facts: current,
      mutateFactsBeforeTransaction: (value) => ({
        ...value,
        build: { ...value.build, stateEpoch: value.build.stateEpoch + 1 },
      }),
    });
    const result = await applyKnowledgeBaseIncidentRepair(
      {
        userId: 7,
        conversationId: "conversation-incident",
        repairKind: "legacy_skill_404_confirm",
        expectedStateHash: stateHash,
        now: NOW,
      },
      {
        getDatabase: async () => store.db as any,
        environment: ACTIVE_MIGRATION_ENV,
      },
    );
    expect(result).toMatchObject({
      applied: false,
      noopReason: "state_changed",
      replacementTurnId: null,
    });
    expect(store.insertedTurns).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("previews 11:01 with only the missing retained ordinal requiring reselection", () => {
    const starter = startFacts();
    const preview = previewKnowledgeBaseIncidentRepairFacts({
      facts: {
        ...starter.facts,
        retainedSourceProofs: [{ ordinal: 2, code: "missing" }],
      },
      repairKind: "retained_upstream_create_3_start",
      environment: {
        FRONTMIND_KB_MANUS_V2_WRITER: "false",
        FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "true",
      },
    });
    expect(preview).toMatchObject({
      applicable: false,
      blockers: [],
      userAttachmentCount: 8,
    });
    expect(preview.requiresReselection).toEqual([
      { ordinal: 2, code: "missing" },
    ]);
  });

  it("does not apply 11:01 when any retained body fails its streamed SHA proof", async () => {
    const starter = startFacts();
    const stateHash = hashKnowledgeBaseIncidentRepairState(starter.facts);
    const store = serviceDb({ facts: starter.facts });
    const readStoredFile = vi.fn(async (fileId: string) => {
      const ordinal = Number(fileId.replace("retained-file-", ""));
      const index = ordinal - 1;
      if (ordinal === 2) {
        const wrongBytes = Buffer.from(starter.bytes[index]!);
        wrongBytes[0] = wrongBytes[0]! ^ 0xff;
        return stored(wrongBytes, starter.filenames[index]!);
      }
      return stored(starter.bytes[index]!, starter.filenames[index]!);
    });
    const result = await applyKnowledgeBaseIncidentRepair(
      {
        userId: 7,
        conversationId: "conversation-incident",
        repairKind: "retained_upstream_create_3_start",
        expectedStateHash: stateHash,
        now: NOW,
      },
      {
        getDatabase: async () => store.db as any,
        readStoredFile: readStoredFile as any,
        environment: {
          FRONTMIND_KB_MANUS_V2_WRITER: "true",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
        },
      },
    );
    expect(result).toMatchObject({
      applied: false,
      noopReason: "requires_reselection",
    });
    expect(result.requiresReselection).toEqual([
      { ordinal: 2, code: "sha256_mismatch" },
    ]);
    expect(store.insertedTurns).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("applies 11:01 to a new generation and a single unbound v2 start", async () => {
    const starter = startFacts();
    const stateHash = hashKnowledgeBaseIncidentRepairState(starter.facts);
    const store = serviceDb({ facts: starter.facts });
    const readStoredFile = vi.fn(async (fileId: string) => {
      const ordinal = Number(fileId.replace("retained-file-", ""));
      const index = ordinal - 1;
      return stored(starter.bytes[index]!, starter.filenames[index]!);
    });
    const result = await applyKnowledgeBaseIncidentRepair(
      {
        userId: 7,
        conversationId: "conversation-incident",
        repairKind: "retained_upstream_create_3_start",
        expectedStateHash: stateHash,
        now: NOW,
      },
      {
        getDatabase: async () => store.db as any,
        readStoredFile: readStoredFile as any,
        environment: {
          FRONTMIND_KB_MANUS_V2_WRITER: "false",
          FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "true",
        },
      },
    );
    expect(result).toMatchObject({
      applied: true,
      previousGeneration: 3,
      generation: 4,
      userAttachmentCount: 8,
    });
    expect(readStoredFile).toHaveBeenCalledTimes(8);
    expect(store.insertedTurns[0]).toMatchObject({
      operationType: "start",
      buildGeneration: 4,
      expectedRevision: 0,
      expectedLeafId: null,
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        expectedAttachmentCount: 10,
        userAttachmentCount: 8,
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
        hiddenReplacement: true,
        chargeDisposition: "reuse_original_no_charge",
      },
    });
    expect(store.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generation: 4,
          providerProtocol: "manus_v2",
          canonicalTaskId: null,
          canonicalTaskState: "unbound",
          upstreamTaskId: null,
          stateEpoch: 18,
        }),
      ]),
    );
  });

  it("produces an audit target that cannot disclose a raw build/provider id", () => {
    const target = knowledgeBaseIncidentAuditTarget(BUILD_ID);
    expect(target).toMatch(/^kb-repair:[a-f0-9]{32}$/u);
    expect(target).not.toContain(BUILD_ID);
  });
});
