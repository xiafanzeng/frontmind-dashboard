import { describe, expect, it, vi } from "vitest";

import {
  conversationTurns,
  conversations,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  messages,
} from "../drizzle/schema";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  customerUploadResources: vi.fn().mockResolvedValue([]),
  officialLogoUploadFromTurn: vi.fn(
    (turn: { expectedLeafId?: string; metadata?: Record<string, any> }) =>
      turn.metadata?.recovery?.officialLogoUpload?.verified === true
        ? { leafId: turn.expectedLeafId }
        : null,
  ),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./knowledge-base-customer-upload", () => ({
  knowledgeBaseCustomerUploadResources: dependencies.customerUploadResources,
  knowledgeBaseOfficialLogoUploadFromTurn:
    dependencies.officialLogoUploadFromTurn,
}));

import { getKnowledgeBaseObservationProjection } from "./knowledge-base-progress-service";

function query(values: Record<string, unknown>[]) {
  let selected = [...values];
  const chain = {
    where() {
      return chain;
    },
    orderBy() {
      selected.sort(
        (left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0),
      );
      return chain;
    },
    limit(size: number) {
      selected = selected.slice(0, size);
      return chain;
    },
    async for() {
      return selected;
    },
    then<TResult1 = Record<string, unknown>[], TResult2 = never>(
      resolve?:
        | ((
            value: Record<string, unknown>[],
          ) => TResult1 | PromiseLike<TResult1>)
        | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(selected).then(resolve, reject);
    },
  };
  return chain;
}

function snapshotExecutor(snapshot: {
  build: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  conversation: Record<string, unknown>;
  turns?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
}) {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === knowledgeBaseBuilds) return query([snapshot.build]);
          if (table === knowledgeBaseBuildNodes) return query(snapshot.nodes);
          if (table === conversations) return query([snapshot.conversation]);
          if (table === conversationTurns) return query(snapshot.turns || []);
          if (table === messages) return query(snapshot.messages || []);
          return query([]);
        },
      };
    },
  };
}

function build(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "build-snapshot",
    userId: 7,
    conversationId: "conversation-snapshot",
    companyName: "FrontMind超前智能",
    companyWebsite: null,
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: "a".repeat(64),
    treePolicyVersion: 1,
    initialResearchCoverage: null,
    status: "confirming",
    generation: 1,
    stateEpoch: 1,
    activeTurnId: null,
    upstreamTaskId: "task-old",
    lastAppliedOperationKey: "operation-old",
    currentPresentationKey: "presentation-old",
    revision: 1,
    currentLeafId: "1.1",
    totalNodeCount: 1,
    confirmedCount: 0,
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
    completedAt: null,
    publishedAt: null,
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function node(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "node-old",
    buildId: "build-snapshot",
    leafId: "1.1",
    title: "一句话定位",
    branchId: "identity",
    branchTitle: "企业身份",
    ordinal: 0,
    status: "current",
    transitionReason: null,
    contentMarkdown: "## 1.1 一句话定位\n\n旧快照正文",
    contentSha256: "b".repeat(64),
    lastUserInput: null,
    sourceUrls: [],
    imageUrls: [],
    lastTaskId: "task-old",
    sourceTurnId: null,
    presentationKey: "presentation-old",
    lastResponseAt: now,
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("knowledge-base observation consistency", () => {
  it("projects attachment readiness processing as a same-turn recovery notice", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-attachments-processing",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-attachments-processing",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-attachments-processing",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        createAttemptState: "not_sent",
        traceId: "4b8be659-2b38-43f5-b89d-1697e3e77655",
      },
      status: "queued",
      errorCode: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
      errorMessage: "generated attachment is still pending",
      upstreamTaskId: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "running",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.notice).toMatchObject({
      code: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
      severity: "info",
      retryable: true,
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      traceId: "4b8be659-2b38-43f5-b89d-1697e3e77655",
      attachmentCount: 7,
      turnId: activeTurn.id,
    });
  });

  it("projects an unknown create outcome as contact-support and never as retry", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-create-outcome-unknown",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-create-outcome-unknown",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-create-outcome-unknown",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        createAttemptState: "unknown",
        traceId: "e948069c-b6e1-4c8f-b829-a3ee6a3495b4",
      },
      status: "running",
      errorCode: "KNOWLEDGE_BASE_CREATE_OUTCOME_UNKNOWN",
      errorMessage: "provider task create outcome unknown",
      upstreamTaskId: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "running",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.notice).toMatchObject({
      code: "KNOWLEDGE_BASE_CREATE_OUTCOME_UNKNOWN",
      severity: "warning",
      retryable: false,
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      traceId: "e948069c-b6e1-4c8f-b829-a3ee6a3495b4",
      attachmentCount: 7,
      turnId: activeTurn.id,
    });
  });

  it("projects safe trace and attachment count for an UPSTREAM_CREATE_3 failure", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-upstream-create-3",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-upstream-create-3",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-upstream-create-3",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        createAttemptState: "rejected",
        traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
      status: "failed",
      upstreamTaskId: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "protocol_error",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
              protocolErrorCode: "UPSTREAM_CREATE_3",
              protocolError: "上游已明确拒绝创建本轮任务",
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation.notice).toMatchObject({
      code: "UPSTREAM_CREATE_3",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      attachmentCount: 7,
      turnId: activeTurn.id,
    });
  });

  it("keeps a legacy UPSTREAM_CREATE_3 code and attachment count without inventing a trace", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-legacy-upstream-create-3",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-legacy-upstream-create-3",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-legacy-upstream-create-3",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
      status: "failed",
      upstreamTaskId: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "protocol_error",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
              protocolErrorCode: "UPSTREAM_CREATE_3",
              protocolError: "上游已明确拒绝创建本轮任务",
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.notice).toMatchObject({
      code: "UPSTREAM_CREATE_3",
      attachmentCount: 7,
      turnId: activeTurn.id,
    });
    expect(observation?.notice?.traceId).toBeNull();
  });

  it("shows the official logo only on the initial revision-zero first node", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const initialTurn = {
      id: "turn-initial",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-initial",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-initial",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      attachmentFileIds: [],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-initial",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockClear();
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              revision: 0,
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [node({ sourceTurnId: initialTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [initialTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(dependencies.customerUploadResources).not.toHaveBeenCalled();
    expect(observation?.approvedPresentation).toMatchObject({
      revision: 0,
      leafId: "1.1",
      imageState: "attached",
      resources: [
        {
          kind: "logo",
          filename: "official-logo.png",
        },
      ],
    });
  });

  it("shows the exact official Logo on the revised first node that bound its upload", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const logoTurn = {
      id: "turn-official-logo",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-official-logo",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-official-logo",
      operationType: "revise",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-official-logo"],
      metadata: {
        recovery: {
          officialLogoUpload: { verified: true },
        },
      },
      status: "completed",
      upstreamTaskId: "task-official-logo",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockResolvedValueOnce([]);
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              revision: 1,
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [node({ sourceTurnId: logoTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [logoTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      revision: 1,
      leafId: "1.1",
      imageState: "attached",
      resources: [
        {
          kind: "logo",
          filename: "official-logo.png",
        },
      ],
    });
  });

  it("shows a revised first node's verified customer upload without repeating the logo", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-customer-image",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-customer-image",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-customer-image",
      operationType: "revise",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-customer-image",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockResolvedValueOnce([
      {
        kind: "customer_upload",
        outputItemId: null,
        fileId: null,
        sameOriginUrl:
          "/api/knowledge-base/artifacts/build-snapshot/customer-uploads/turn-customer-image/0/" +
          "c".repeat(64),
        filename: "customer.jpg",
        mimeType: "image/jpeg",
        sha256: "c".repeat(64),
        sizeBytes: 1234,
      },
    ]);
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [
              node({
                sourceTurnId: presentationTurn.id,
                imageUrls: ["https://crawler.invalid/never-display.jpg"],
              }),
            ],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      imageState: "attached",
      resources: [
        {
          kind: "customer_upload",
          filename: "customer.jpg",
        },
      ],
    });
    expect(
      observation?.approvedPresentation?.resources.some((resource) =>
        resource.sameOriginUrl.startsWith("https://"),
      ),
    ).toBe(false);
  });

  it("never carries a customer upload onto a different leaf", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-prior-leaf",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-prior-leaf",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-prior-leaf",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-prior-leaf",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({ currentLeafId: "1.2" }),
            nodes: [
              node({
                leafId: "1.2",
                ordinal: 1,
                sourceTurnId: presentationTurn.id,
                imageUrls: ["https://crawler.invalid/never-display.jpg"],
              }),
            ],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });
    dependencies.customerUploadResources.mockClear();

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(dependencies.customerUploadResources).not.toHaveBeenCalled();
    expect(observation?.approvedPresentation).toMatchObject({
      leafId: "1.2",
      imageState: "no_eligible_asset",
      resources: [],
    });
  });

  it("shows a later leaf's customer upload without repeating the official logo", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-later-customer-image",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-later-customer-image",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-later-customer-image",
      operationType: "revise",
      expectedRevision: 1,
      expectedLeafId: "1.2",
      attachmentFileIds: ["file-later-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-later-customer-image",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockResolvedValueOnce([
      {
        kind: "customer_upload",
        outputItemId: null,
        fileId: null,
        sameOriginUrl:
          "/api/knowledge-base/artifacts/build-snapshot/customer-uploads/turn-later-customer-image/0/" +
          "d".repeat(64),
        filename: "later-customer.png",
        mimeType: "image/png",
        sha256: "d".repeat(64),
        sizeBytes: 222,
      },
    ]);
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              currentLeafId: "1.2",
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [
              node({
                leafId: "1.2",
                ordinal: 1,
                sourceTurnId: presentationTurn.id,
                imageUrls: ["https://crawler.invalid/never-display.jpg"],
              }),
            ],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      leafId: "1.2",
      imageState: "attached",
      resources: [
        {
          kind: "customer_upload",
          filename: "later-customer.png",
        },
      ],
    });
    expect(
      observation?.approvedPresentation?.resources.some(
        (resource) => resource.kind === "logo",
      ),
    ).toBe(false);
  });

  it("does not expose the completed parent task while an accepted turn is unbound", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const acceptedTurn = {
      id: "turn-accepted",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-accepted",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-accepted",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "queued",
      upstreamTaskId: null,
      metadata: {},
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({ activeTurnId: acceptedTurn.id }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [acceptedTurn],
            messages: [{ turnId: acceptedTurn.id, role: "user", sequence: 4 }],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation).toMatchObject({
      authoritativeTaskId: null,
      activeTurn: {
        id: "turn-accepted",
        status: "queued",
        messageSequence: 4,
      },
    });
  });

  it("projects canonical request and presentation message sequences", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-presentation",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-presentation",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-presentation",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: "task-old",
      metadata: {},
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build(),
            nodes: [node({ sourceTurnId: presentationTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
            messages: [
              { turnId: presentationTurn.id, role: "user", sequence: 2 },
              {
                turnId: presentationTurn.id,
                role: "assistant",
                sequence: 3,
              },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      turnId: presentationTurn.id,
      requestMessageSequence: 2,
      messageSequence: 3,
    });
    expect(observation?.completedTurn).toEqual({
      turnId: presentationTurn.id,
      clientRequestId: presentationTurn.clientRequestId,
      messageSequence: 2,
    });
  });

  it("projects the terminal completed turn after a fast finalizer releases the active turn", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const staleSameSecondTurn = {
      id: "turn-stale-same-second",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-stale",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-stale",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: "task-old",
      metadata: {},
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const terminalTurn = {
      id: "turn-final",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-final",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-final",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: null,
      metadata: {},
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "ready_to_publish",
              currentLeafId: null,
              activeTurnId: null,
              lastAppliedOperationKey: terminalTurn.operationKey,
            }),
            nodes: [node({ status: "confirmed" })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 13,
            },
            // Deliberately put the stale row first with identical timestamps;
            // query adapters and database ordering must not choose it.
            turns: [staleSameSecondTurn, terminalTurn],
            messages: [
              {
                turnId: staleSameSecondTurn.id,
                role: "user",
                sequence: 6,
              },
              { turnId: terminalTurn.id, role: "user", sequence: 8 },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.activeTurn).toBeNull();
    expect(observation?.approvedPresentation).toBeNull();
    expect(observation?.completedTurn).toEqual({
      turnId: terminalTurn.id,
      clientRequestId: terminalTurn.clientRequestId,
      messageSequence: 8,
    });
  });

  it("returns one transactional snapshot while a newer build commits concurrently", async () => {
    const live = {
      build: build(),
      nodes: [node()],
      conversation: { id: "u7:conversation-snapshot", userId: 7, version: 11 },
    };
    let transactionCount = 0;
    let transactionConfig: Record<string, unknown> | undefined;
    const db = {
      select: vi.fn(() => {
        throw new Error("observation attempted an autocommit read");
      }),
      async transaction<T>(
        operation: (tx: any) => Promise<T>,
        config?: Record<string, unknown>,
      ) {
        transactionCount += 1;
        transactionConfig = config;
        const snapshot = {
          build: { ...live.build },
          nodes: live.nodes.map((row) => ({ ...row })),
          conversation: { ...live.conversation },
        };
        const result = operation(snapshotExecutor(snapshot));
        live.build = build({
          stateEpoch: 2,
          revision: 2,
          currentLeafId: "1.2",
          upstreamTaskId: "task-new",
          currentPresentationKey: "presentation-new",
        });
        live.nodes = [
          node({
            id: "node-new",
            leafId: "1.2",
            title: "企业主体",
            contentMarkdown: "## 1.2 企业主体\n\n新快照正文",
            contentSha256: "c".repeat(64),
            presentationKey: "presentation-new",
            lastTaskId: "task-new",
          }),
        ];
        live.conversation = { ...live.conversation, version: 12 };
        return result;
      },
    };
    dependencies.getDb.mockResolvedValue(db);

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(transactionCount).toBe(1);
    expect(transactionConfig).toEqual({ isolationLevel: "repeatable read" });
    expect(db.select).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      stateEpoch: 1,
      generation: 1,
      authoritativeTaskId: "task-old",
      conversationVersion: 11,
      progress: {
        build: { revision: 1, currentLeafId: "1.1" },
      },
      approvedPresentation: {
        revision: 1,
        leafId: "1.1",
        visibleMarkdown: "## 1.1 一句话定位\n\n旧快照正文",
      },
    });
  });

  it("rejects a mixed stateEpoch read and retries from the new authority", async () => {
    const oldSnapshot = {
      build: build(),
      nodes: [node()],
      conversation: {
        id: "u7:conversation-snapshot",
        userId: 7,
        version: 11,
      },
    };
    const newSnapshot = {
      build: build({
        stateEpoch: 2,
        revision: 2,
        currentLeafId: "1.2",
        upstreamTaskId: "task-new",
        currentPresentationKey: "presentation-new",
      }),
      nodes: [
        node({
          id: "node-new",
          leafId: "1.2",
          title: "企业主体",
          contentMarkdown: "## 1.2 企业主体\n\n新快照正文",
          contentSha256: "c".repeat(64),
          presentationKey: "presentation-new",
          lastTaskId: "task-new",
        }),
      ],
      conversation: {
        id: "u7:conversation-snapshot",
        userId: 7,
        version: 12,
      },
    };
    let transactionCount = 0;
    const db = {
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        transactionCount += 1;
        if (transactionCount > 1) {
          return operation(snapshotExecutor(newSnapshot));
        }
        let buildReads = 0;
        const mixedExecutor = {
          select() {
            return {
              from(table: unknown) {
                if (table === knowledgeBaseBuilds) {
                  buildReads += 1;
                  return query([
                    buildReads === 1 ? oldSnapshot.build : newSnapshot.build,
                  ]);
                }
                if (table === knowledgeBaseBuildNodes) {
                  return query(oldSnapshot.nodes);
                }
                if (table === conversations) {
                  return query([newSnapshot.conversation]);
                }
                if (table === conversationTurns) return query([]);
                return query([]);
              },
            };
          },
        };
        return operation(mixedExecutor);
      },
    };
    dependencies.getDb.mockResolvedValue(db);

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(transactionCount).toBe(2);
    expect(observation).toMatchObject({
      stateEpoch: 2,
      authoritativeTaskId: "task-new",
      conversationVersion: 12,
      progress: {
        build: { revision: 2, currentLeafId: "1.2" },
      },
      approvedPresentation: {
        revision: 2,
        leafId: "1.2",
        visibleMarkdown: "## 1.2 企业主体\n\n新快照正文",
      },
    });
  });
});
