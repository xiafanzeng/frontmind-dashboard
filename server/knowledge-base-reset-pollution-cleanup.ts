import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  attachments,
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetRequests,
  knowledgeBaseResetStates,
  messages,
  upstreamResources,
  type Conversation,
  type ConversationTurn,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  inspectResetPollutionUploadIntents,
  removeResetPollutionRetainedSources,
  retireResetPollutionUploadIntents,
  type ResetPollutionUploadProof,
} from "./knowledge-base-reset-pollution-upload-cleanup";

const STATE_HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_SIDE_METADATA = [
  "dispatchingAt",
  "outcomeUnknownAt",
  "manusRequestId",
  "providerRequestRef",
  "preparedDispatch",
  "frozenProviderRequestHash",
  "baselineEventId",
  "lastSeenEventIds",
  "providerRejectionCount",
  "generatedAttachmentReservations",
  "manusV2AttachmentAttempts",
  "manusV2AttachmentMappings",
  "manusV2AttachmentUnknownAttempts",
  "anchorAcknowledgement",
  "terminalAnchorObservation",
] as const;

type JsonRecord = Record<string, unknown>;

export type ResetPollutionCleanupInput = {
  userId: number;
  conversationId: string;
  buildId: string;
  resetRequestId: string;
  expectedResetRevision: number;
  expectedStateSha256?: string;
};

export type ResetPollutionCleanupFacts = {
  resetRevision: number;
  resetRequest: {
    id: string;
    userId: number;
    status: string;
    decidedAt: Date | null;
  };
  build: KnowledgeBaseBuild;
  conversation: Conversation;
  turn: ConversationTurn;
  nodeCount: number;
  acceptedReceiptCount: number;
  pendingUserMessageCount: number;
  messageCount: number;
  attachmentCount: number;
  upstreamResourceCount: number;
  messageStateSha256: string;
  attachmentStateSha256: string;
  providerGenerationZero: boolean;
  uploadProof: ResetPollutionUploadProof;
};

export type ResetPollutionCleanupPreview = {
  status: "eligible";
  stateSha256: string;
  counts: {
    builds: 1;
    conversations: 1;
    turns: 1;
    nodes: number;
    messages: number;
    attachments: number;
    acceptedReceipts: number;
    uploadIntents: number;
    upstreamResources: number;
  };
};

export type ResetPollutionCleanupResult = {
  status: "cleaned";
  resetRevisionIncremented: true;
  counts: ResetPollutionCleanupPreview["counts"];
};

export type ResetPollutionCleanupTransactionPlan = {
  tombstone: true;
  deleteAttachments: number;
  deleteMessages: number;
  deleteTurns: 1;
  deleteConversation: 1;
  deleteBuild: 1;
  nextResetRevision: number;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function integer(value: unknown, minimum = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function strictLocalStagedLedger(metadata: JsonRecord) {
  const recovery = record(metadata.recovery);
  const manifest = Array.isArray(recovery.attachmentManifest)
    ? recovery.attachmentManifest.map(record)
    : [];
  const staged = Array.isArray(metadata.clientStagedAttachments)
    ? metadata.clientStagedAttachments.map(record)
    : [];
  const attachments = Array.isArray(recovery.attachments)
    ? recovery.attachments.map(record)
    : [];
  const proofs = Array.isArray(recovery.attachmentSourceProofs)
    ? recovery.attachmentSourceProofs.map(record)
    : [];
  const userAttachmentCount = integer(metadata.userAttachmentCount);
  const expectedAttachmentCount = integer(metadata.expectedAttachmentCount);
  if (
    userAttachmentCount !== 8 ||
    expectedAttachmentCount !== 10 ||
    manifest.length !== userAttachmentCount ||
    staged.length !== 1 ||
    attachments.length !== staged.length ||
    proofs.length !== staged.length ||
    recovery.kind !== "start" ||
    recovery.deferredClientAttachments !== true ||
    recovery.includePrefill === true
  ) {
    return null;
  }
  const seenFileIds = new Set<string>();
  const seenIntentIds = new Set<string>();
  for (let index = 0; index < staged.length; index += 1) {
    const item = staged[index]!;
    const attachment = attachments[index]!;
    const proof = proofs[index]!;
    const descriptor = manifest[index]!;
    const fileId = text(item.file_id);
    const filename = text(item.filename);
    const intentId = text(item.managedIntentId);
    const itemId = text(item.itemId);
    const mimeType = text(item.mimeType);
    const contentSha256 = text(item.contentSha256).toLowerCase();
    const localStorageKey = text(item.localStorageKey);
    const sizeBytes = integer(item.sizeBytes, 1);
    if (
      item.index !== index ||
      !fileId ||
      !filename ||
      !intentId ||
      !itemId ||
      !mimeType ||
      sizeBytes === null ||
      !/^[a-f0-9]{64}$/u.test(contentSha256) ||
      !localStorageKey ||
      localStorageKey.startsWith("/") ||
      localStorageKey.includes("\\") ||
      localStorageKey
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      seenFileIds.has(fileId) ||
      seenIntentIds.has(intentId) ||
      text(attachment.file_id) !== fileId ||
      text(attachment.filename) !== filename ||
      proof.index !== index ||
      text(proof.fileId) !== fileId ||
      text(proof.filename) !== filename ||
      text(proof.managedIntentId) !== intentId ||
      text(proof.itemId) !== itemId ||
      text(proof.mimeType) !== mimeType ||
      integer(proof.sizeBytes, 1) !== sizeBytes ||
      text(proof.contentSha256).toLowerCase() !== contentSha256 ||
      text(proof.localStorageKey) !== localStorageKey ||
      text(descriptor.filename) !== filename ||
      text(descriptor.mimeType) !== mimeType ||
      integer(descriptor.sizeBytes, 1) !== sizeBytes ||
      text(descriptor.sha256).toLowerCase() !== contentSha256
    ) {
      return null;
    }
    seenFileIds.add(fileId);
    seenIntentIds.add(intentId);
  }
  return {
    userAttachmentCount,
    expectedAttachmentCount,
    staged,
    manifest,
    sources: staged.map((item) => ({
      localStorageKey: text(item.localStorageKey),
      contentSha256: text(item.contentSha256).toLowerCase(),
      sizeBytes: integer(item.sizeBytes, 1)!,
    })),
  };
}

function uploadProofMatchesLocalLedger(
  proof: ResetPollutionUploadProof,
  ledger: NonNullable<ReturnType<typeof strictLocalStagedLedger>>,
) {
  if (
    proof.intentCount !== proof.localOnlyItems.length ||
    proof.intentCount < ledger.staged.length
  ) {
    return false;
  }
  const ordinals = new Set<number>();
  for (const item of proof.localOnlyItems) {
    if (
      !Number.isSafeInteger(item.ordinal) ||
      item.ordinal < 1 ||
      item.ordinal > ledger.userAttachmentCount ||
      item.total !== ledger.userAttachmentCount ||
      ordinals.has(item.ordinal) ||
      createHash("sha256")
        .update(text(ledger.manifest[item.ordinal - 1]?.itemId), "utf8")
        .digest("hex") !== item.operationIdSha256
    ) {
      return false;
    }
    ordinals.add(item.ordinal);
    if (item.state === "sealed") {
      const descriptor = ledger.manifest[item.ordinal - 1]!;
      if (
        item.sizeBytes !== integer(descriptor.sizeBytes, 1) ||
        item.sha256 !== text(descriptor.sha256).toLowerCase()
      ) {
        return false;
      }
    } else if (item.sizeBytes !== null || item.sha256 !== null) {
      return false;
    }
  }
  return ledger.staged.every((staged) =>
    proof.localOnlyItems.some(
      (intent) =>
        intent.intentIdSha256 ===
          createHash("sha256")
            .update(text(staged.managedIntentId), "utf8")
            .digest("hex") &&
        intent.operationIdSha256 ===
          createHash("sha256")
            .update(text(staged.itemId), "utf8")
            .digest("hex") &&
        intent.ordinal === Number(staged.index) + 1 &&
        intent.state === "sealed" &&
        intent.sizeBytes === integer(staged.sizeBytes, 1) &&
        intent.sha256 === text(staged.contentSha256).toLowerCase(),
    ),
  );
}

function timestamp(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function safeBuildState(build: KnowledgeBaseBuild) {
  return {
    id: build.id,
    userId: build.userId,
    conversationId: build.conversationId,
    upstreamTaskId: build.upstreamTaskId,
    providerProtocol: build.providerProtocol,
    canonicalTaskId: build.canonicalTaskId,
    canonicalTaskGeneration: build.canonicalTaskGeneration,
    canonicalCredentialId: build.canonicalCredentialId,
    canonicalTaskState: build.canonicalTaskState,
    canonicalTaskUrl: build.canonicalTaskUrl,
    canonicalTaskCreatedAt: timestamp(build.canonicalTaskCreatedAt),
    handoffProvenance: build.handoffProvenance,
    status: build.status,
    generation: build.generation,
    stateEpoch: build.stateEpoch,
    activeTurnId: build.activeTurnId,
    recoveryLeaseOwnerHash: build.recoveryLeaseOwnerHash,
    recoveryLeaseExpiresAt: timestamp(build.recoveryLeaseExpiresAt),
    lastAppliedOperationKey: build.lastAppliedOperationKey,
    currentPresentationKey: build.currentPresentationKey,
    revision: build.revision,
    currentLeafId: build.currentLeafId,
    totalNodeCount: build.totalNodeCount,
    confirmedCount: build.confirmedCount,
    directPrefilledCount: build.directPrefilledCount,
    needsVerificationCount: build.needsVerificationCount,
    lastReconciledHash: build.lastReconciledHash,
    lastOutputLength: build.lastOutputLength,
    lastOutputItemIds: build.lastOutputItemIds,
    lastTurnAttachmentCount: build.lastTurnAttachmentCount,
    awaitingResponseSince: timestamp(build.awaitingResponseSince),
    packageRevision: build.packageRevision,
    packageTaskId: build.packageTaskId,
    packageOutputItemId: build.packageOutputItemId,
    packageFileId: build.packageFileId,
    packageDescriptorHash: build.packageDescriptorHash,
    contentCompletedAt: timestamp(build.contentCompletedAt),
    packageStatus: build.packageStatus,
    packageAttemptCount: build.packageAttemptCount,
    packageNextRetryAt: timestamp(build.packageNextRetryAt),
    packageLastErrorCode: build.packageLastErrorCode,
    logoStorageKey: build.logoStorageKey,
    logoSha256: build.logoSha256,
    logoBytes: build.logoBytes,
    packageStorageKey: build.packageStorageKey,
    packageArchiveSha256: build.packageArchiveSha256,
    packageSizeBytes: build.packageSizeBytes,
    protocolErrorCode: build.protocolErrorCode,
    publishedSnapshotId: build.publishedSnapshotId,
    createdAt: timestamp(build.createdAt),
    updatedAt: timestamp(build.updatedAt),
    completedAt: timestamp(build.completedAt),
    publishedAt: timestamp(build.publishedAt),
  };
}

function safeTurnState(turn: ConversationTurn) {
  const metadata = record(turn.metadata);
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    userId: turn.userId,
    apiCredentialId: turn.apiCredentialId,
    clientRequestId: turn.clientRequestId,
    buildId: turn.buildId,
    buildGeneration: turn.buildGeneration,
    operationKey: turn.operationKey,
    operationType: turn.operationType,
    expectedRevision: turn.expectedRevision,
    expectedLeafId: turn.expectedLeafId,
    requestHash: turn.requestHash,
    upstreamIdempotencyKeyHash: turn.upstreamIdempotencyKeyHash,
    attachmentFileIds: turn.attachmentFileIds,
    metadataSha256: createHash("sha256")
      .update(JSON.stringify(metadata), "utf8")
      .digest("hex"),
    leaseExpiresAt: timestamp(turn.leaseExpiresAt),
    status: turn.status,
    upstreamTaskId: turn.upstreamTaskId,
    errorCode: turn.errorCode,
    startedAt: timestamp(turn.startedAt),
    completedAt: timestamp(turn.completedAt),
    createdAt: timestamp(turn.createdAt),
    updatedAt: timestamp(turn.updatedAt),
  };
}

export function resetPollutionStateSha256(facts: ResetPollutionCleanupFacts) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        resetRevision: facts.resetRevision,
        resetRequest: {
          id: facts.resetRequest.id,
          userId: facts.resetRequest.userId,
          status: facts.resetRequest.status,
          decidedAt: timestamp(facts.resetRequest.decidedAt),
        },
        build: safeBuildState(facts.build),
        conversation: {
          id: facts.conversation.id,
          userId: facts.conversation.userId,
          projectAssignmentId: facts.conversation.projectAssignmentId,
          status: facts.conversation.status,
          upstreamTaskId: facts.conversation.upstreamTaskId,
          previousResponseId: facts.conversation.previousResponseId,
          taskUrl: facts.conversation.taskUrl,
          lastKnownOutputLength: facts.conversation.lastKnownOutputLength,
          version: facts.conversation.version,
          startedAt: timestamp(facts.conversation.startedAt),
          completedAt: timestamp(facts.conversation.completedAt),
          createdAt: timestamp(facts.conversation.createdAt),
          updatedAt: timestamp(facts.conversation.updatedAt),
          deletedAt: timestamp(facts.conversation.deletedAt),
        },
        turn: safeTurnState(facts.turn),
        nodeCount: facts.nodeCount,
        acceptedReceiptCount: facts.acceptedReceiptCount,
        pendingUserMessageCount: facts.pendingUserMessageCount,
        messageCount: facts.messageCount,
        attachmentCount: facts.attachmentCount,
        upstreamResourceCount: facts.upstreamResourceCount,
        messageStateSha256: facts.messageStateSha256,
        attachmentStateSha256: facts.attachmentStateSha256,
        providerGenerationZero: facts.providerGenerationZero,
        uploadIntentCount: facts.uploadProof.intentCount,
        uploadIntentStateSha256: facts.uploadProof.stateSha256,
      }),
      "utf8",
    )
    .digest("hex");
}

function validateFacts(
  input: ResetPollutionCleanupInput,
  facts: ResetPollutionCleanupFacts,
) {
  const metadata = record(facts.turn.metadata);
  const localLedger = strictLocalStagedLedger(metadata);
  const operationToken = text(metadata.operationToken);
  const persistedConversationId = `u${input.userId}:${input.conversationId}`;
  if (
    facts.resetRevision !== input.expectedResetRevision ||
    facts.resetRequest.id !== input.resetRequestId ||
    facts.resetRequest.userId !== input.userId ||
    facts.resetRequest.status !== "approved" ||
    !facts.resetRequest.decidedAt ||
    facts.build.id !== input.buildId ||
    facts.build.userId !== input.userId ||
    facts.build.conversationId !== input.conversationId ||
    facts.build.createdAt.getTime() < facts.resetRequest.decidedAt.getTime() ||
    facts.build.providerProtocol !== "manus_v2" ||
    facts.build.canonicalTaskState !== "unbound" ||
    facts.build.upstreamTaskId !== null ||
    facts.build.canonicalTaskId !== null ||
    facts.build.canonicalTaskGeneration !== null ||
    facts.build.canonicalCredentialId !== null ||
    facts.build.canonicalTaskUrl !== null ||
    facts.build.canonicalTaskCreatedAt !== null ||
    facts.build.handoffProvenance !== null ||
    facts.build.status !== "researching" ||
    facts.build.generation !== 1 ||
    facts.build.revision !== 0 ||
    facts.build.currentLeafId !== null ||
    facts.build.currentPresentationKey !== null ||
    facts.build.totalNodeCount !== 0 ||
    facts.build.confirmedCount !== 0 ||
    facts.build.directPrefilledCount !== 0 ||
    facts.build.needsVerificationCount !== 0 ||
    facts.build.lastAppliedOperationKey !== null ||
    facts.build.lastOutputLength !== 0 ||
    facts.build.lastOutputItemIds.length !== 0 ||
    !localLedger ||
    !uploadProofMatchesLocalLedger(facts.uploadProof, localLedger) ||
    facts.build.lastTurnAttachmentCount !== localLedger.userAttachmentCount ||
    facts.build.packageTaskId !== null ||
    facts.build.packageOutputItemId !== null ||
    facts.build.packageFileId !== null ||
    facts.build.packageDescriptorHash !== null ||
    facts.build.packageRevision !== null ||
    facts.build.packageStatus !== "not_started" ||
    facts.build.packageAttemptCount !== 0 ||
    facts.build.packageNextRetryAt !== null ||
    facts.build.packageLastErrorCode !== null ||
    facts.build.logoStorageKey !== null ||
    facts.build.packageStorageKey !== null ||
    facts.build.protocolErrorCode !== null ||
    facts.build.contentCompletedAt !== null ||
    facts.build.completedAt !== null ||
    facts.build.publishedAt !== null ||
    facts.build.publishedSnapshotId !== null ||
    facts.build.activeTurnId !== facts.turn.id ||
    facts.nodeCount !== 0 ||
    facts.acceptedReceiptCount !== 0 ||
    facts.pendingUserMessageCount !== 1 ||
    facts.messageCount !== 1 ||
    facts.providerGenerationZero !== true ||
    facts.attachmentCount !== localLedger.staged.length ||
    facts.upstreamResourceCount !== 0 ||
    facts.conversation.id !== persistedConversationId ||
    facts.conversation.userId !== input.userId ||
    facts.conversation.projectAssignmentId !== null ||
    facts.conversation.upstreamTaskId !== null ||
    facts.conversation.previousResponseId !== null ||
    facts.conversation.taskUrl !== null ||
    facts.conversation.lastKnownOutputLength !== 0 ||
    facts.conversation.deletedAt !== null ||
    facts.turn.userId !== input.userId ||
    facts.turn.conversationId !== persistedConversationId ||
    facts.turn.buildId !== input.buildId ||
    facts.turn.buildGeneration !== 1 ||
    facts.turn.operationType !== "start" ||
    facts.turn.expectedRevision !== 0 ||
    facts.turn.expectedLeafId !== null ||
    facts.turn.status !== "queued" ||
    facts.turn.upstreamTaskId !== null ||
    !facts.turn.operationKey ||
    !facts.turn.requestHash ||
    !facts.turn.upstreamIdempotencyKeyHash ||
    JSON.stringify(facts.turn.attachmentFileIds) !==
      JSON.stringify(localLedger.staged.map((item) => text(item.file_id))) ||
    facts.turn.leaseExpiresAt !== null ||
    facts.turn.startedAt !== null ||
    facts.turn.completedAt !== null ||
    metadata.awaitingClientAttachments !== true ||
    metadata.attachmentsFrozen !== false ||
    metadata.createAttemptState !== "not_sent" ||
    metadata.providerAttemptState !== "not_sent" ||
    metadata.providerProtocol !== "manus_v2" ||
    operationToken !== facts.turn.operationKey ||
    metadata.dispatchState !== "reserved" ||
    metadata.recoveryAction !== "wait" ||
    metadata.canRegenerate !== false ||
    PROVIDER_SIDE_METADATA.some((key) => metadata[key] !== undefined)
  ) {
    throw new Error("KB_RESET_POLLUTION_PREDICATE_NOT_MET");
  }
}

function counts(
  facts: ResetPollutionCleanupFacts,
): ResetPollutionCleanupPreview["counts"] {
  return {
    builds: 1,
    conversations: 1,
    turns: 1,
    nodes: facts.nodeCount,
    messages: facts.messageCount,
    attachments: facts.attachmentCount,
    acceptedReceipts: facts.acceptedReceiptCount,
    uploadIntents: facts.uploadProof.intentCount,
    upstreamResources: facts.upstreamResourceCount,
  };
}

async function loadFacts(
  tx: any,
  input: ResetPollutionCleanupInput,
  uploadProof: ResetPollutionUploadProof,
) {
  const resetState = (
    await tx
      .select()
      .from(knowledgeBaseResetStates)
      .where(eq(knowledgeBaseResetStates.userId, input.userId))
      .limit(1)
      .for("update")
  )[0];
  const resetRequest = (
    await tx
      .select({
        id: knowledgeBaseResetRequests.id,
        userId: knowledgeBaseResetRequests.userId,
        status: knowledgeBaseResetRequests.status,
        decidedAt: knowledgeBaseResetRequests.decidedAt,
      })
      .from(knowledgeBaseResetRequests)
      .where(eq(knowledgeBaseResetRequests.id, input.resetRequestId))
      .limit(1)
      .for("update")
  )[0];
  const build = (
    await tx
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.conversationId, input.conversationId),
        ),
      )
      .limit(1)
      .for("update")
  )[0] as KnowledgeBaseBuild | undefined;
  const persistedId = `u${input.userId}:${input.conversationId}`;
  const conversation = (
    await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, persistedId),
          eq(conversations.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update")
  )[0] as Conversation | undefined;
  const turns = (await tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.conversationId, persistedId),
      ),
    )
    .for("update")) as ConversationTurn[];
  if (
    !resetState ||
    !resetRequest ||
    !build ||
    !conversation ||
    turns.length !== 1
  ) {
    throw new Error("KB_RESET_POLLUTION_COORDINATE_NOT_FOUND");
  }
  const [nodeRows, messageRows, attachmentRows, resourceRows] =
    await Promise.all([
      tx
        .select({ id: knowledgeBaseBuildNodes.id })
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, input.buildId))
        .for("update"),
      tx
        .select({
          id: messages.id,
          turnId: messages.turnId,
          role: messages.role,
          sequence: messages.sequence,
          content: messages.content,
          metadata: messages.metadata,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.userId, input.userId),
            eq(messages.conversationId, persistedId),
          ),
        )
        .for("update"),
      tx
        .select({
          id: attachments.id,
          messageId: attachments.messageId,
          kind: attachments.kind,
          fileName: attachments.fileName,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
          upstreamFileId: attachments.upstreamFileId,
          deletedAt: attachments.deletedAt,
        })
        .from(attachments)
        .where(
          and(
            eq(attachments.userId, input.userId),
            eq(attachments.conversationId, persistedId),
          ),
        )
        .for("update"),
      tx
        .select({
          id: upstreamResources.id,
          kind: upstreamResources.kind,
          upstreamId: upstreamResources.upstreamId,
        })
        .from(upstreamResources)
        .where(
          and(
            eq(upstreamResources.userId, input.userId),
            eq(upstreamResources.conversationId, persistedId),
          ),
        )
        .for("update"),
    ]);
  const acceptedReceiptCount = messageRows.filter((message: any) => {
    const knowledgeBase = record(record(message.metadata).knowledgeBase);
    return (
      message.role === "assistant" &&
      knowledgeBase.serverOwned === true &&
      (knowledgeBase.kind === "presentation" ||
        knowledgeBase.kind === "completion")
    );
  }).length;
  const providerGenerationZero =
    uploadProof.localOnlyItems.length === uploadProof.intentCount &&
    uploadProof.localOnlyItems.every((item) =>
      ["awaiting_browser", "receiving", "sealed"].includes(item.state),
    );
  const pendingUserMessageCount = messageRows.filter((message: any) => {
    const knowledgeBase = record(record(message.metadata).knowledgeBase);
    return (
      message.role === "user" &&
      knowledgeBase.schemaVersion === 1 &&
      knowledgeBase.serverOwned === true &&
      knowledgeBase.kind === "pending_user" &&
      knowledgeBase.buildId === input.buildId &&
      knowledgeBase.generation === 1 &&
      knowledgeBase.turnId === turns[0]!.id &&
      knowledgeBase.operationKey === turns[0]!.operationKey &&
      knowledgeBase.clientRequestId === turns[0]!.clientRequestId &&
      knowledgeBase.revision === 0 &&
      knowledgeBase.leafId === null
    );
  }).length;
  const conversationTurnIds = new Set(
    messageRows
      .map((message: any) => message.turnId)
      .filter((turnId: unknown): turnId is string =>
        Boolean(typeof turnId === "string" && turnId),
      ),
  );
  if (
    conversationTurnIds.size !== 1 ||
    !conversationTurnIds.has(turns[0]!.id)
  ) {
    throw new Error("KB_RESET_POLLUTION_PREDICATE_NOT_MET");
  }
  if (
    attachmentRows.some(
      (attachment: any) =>
        typeof attachment.upstreamFileId === "string" &&
        attachment.upstreamFileId.length > 0,
    )
  ) {
    throw new Error("KB_RESET_POLLUTION_PREDICATE_NOT_MET");
  }
  return {
    resetRevision: Number(resetState.revision),
    resetRequest,
    build,
    conversation,
    turn: turns[0]!,
    nodeCount: nodeRows.length,
    acceptedReceiptCount,
    pendingUserMessageCount,
    messageCount: messageRows.length,
    attachmentCount: attachmentRows.length,
    upstreamResourceCount: resourceRows.length,
    messageStateSha256: createHash("sha256")
      .update(
        JSON.stringify(
          messageRows.map((message: any) => ({
            id: message.id,
            turnId: message.turnId,
            role: message.role,
            sequence: message.sequence,
            contentSha256: createHash("sha256")
              .update(String(message.content), "utf8")
              .digest("hex"),
            metadataSha256: createHash("sha256")
              .update(JSON.stringify(message.metadata ?? null), "utf8")
              .digest("hex"),
            deletedAt: timestamp(message.deletedAt),
          })),
        ),
        "utf8",
      )
      .digest("hex"),
    attachmentStateSha256: createHash("sha256")
      .update(
        JSON.stringify(
          attachmentRows.map((attachment: any) => ({
            id: attachment.id,
            messageId: attachment.messageId,
            kind: attachment.kind,
            filenameSha256: createHash("sha256")
              .update(String(attachment.fileName), "utf8")
              .digest("hex"),
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            upstreamFileId: attachment.upstreamFileId,
            deletedAt: timestamp(attachment.deletedAt),
          })),
        ),
        "utf8",
      )
      .digest("hex"),
    providerGenerationZero,
    uploadProof,
  } satisfies ResetPollutionCleanupFacts;
}

export function inspectResetPollutionCleanupFacts(
  input: ResetPollutionCleanupInput,
  facts: ResetPollutionCleanupFacts,
): ResetPollutionCleanupPreview {
  validateFacts(input, facts);
  return {
    status: "eligible",
    stateSha256: resetPollutionStateSha256(facts),
    counts: counts(facts),
  };
}

export function planResetPollutionCleanupTransaction(
  input: ResetPollutionCleanupInput,
  facts: ResetPollutionCleanupFacts,
): ResetPollutionCleanupTransactionPlan {
  validateFacts(input, facts);
  return {
    tombstone: true,
    deleteAttachments: facts.attachmentCount,
    deleteMessages: facts.messageCount,
    deleteTurns: 1,
    deleteConversation: 1,
    deleteBuild: 1,
    nextResetRevision: input.expectedResetRevision + 1,
  };
}

async function database() {
  const db = await getDb();
  if (!db) throw new Error("KB_RESET_POLLUTION_DATABASE_UNAVAILABLE");
  return db;
}

export async function previewResetPollutionCleanup(
  input: ResetPollutionCleanupInput,
): Promise<ResetPollutionCleanupPreview> {
  const db = await database();
  const seedTurn = await db
    .select({
      id: conversationTurns.id,
      clientRequestId: conversationTurns.clientRequestId,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, input.buildId),
      ),
    );
  if (seedTurn.length !== 1) {
    throw new Error("KB_RESET_POLLUTION_COORDINATE_NOT_FOUND");
  }
  const uploadProof = await inspectResetPollutionUploadIntents({
    userId: input.userId,
    projectAssignmentId: null,
    conversationId: input.conversationId,
    turnId: seedTurn[0]!.id,
    clientRequestId: seedTurn[0]!.clientRequestId,
  });
  return db.transaction(async (tx: any) => {
    const facts = await loadFacts(tx, input, uploadProof);
    return inspectResetPollutionCleanupFacts(input, facts);
  });
}

export async function executeResetPollutionCleanup(
  input: ResetPollutionCleanupInput & { expectedStateSha256: string },
): Promise<ResetPollutionCleanupResult> {
  if (!STATE_HASH.test(input.expectedStateSha256)) {
    throw new Error("KB_RESET_POLLUTION_STATE_HASH_INVALID");
  }
  const preview = await previewResetPollutionCleanup(input);
  if (preview.stateSha256 !== input.expectedStateSha256) {
    throw new Error("KB_RESET_POLLUTION_STATE_CHANGED");
  }
  const db = await database();
  const turn = await db
    .select({
      id: conversationTurns.id,
      clientRequestId: conversationTurns.clientRequestId,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, input.buildId),
      ),
    );
  if (turn.length !== 1) {
    throw new Error("KB_RESET_POLLUTION_COORDINATE_NOT_FOUND");
  }
  const uploadCoordinate = {
    userId: input.userId,
    projectAssignmentId: null,
    conversationId: input.conversationId,
    turnId: turn[0]!.id,
    clientRequestId: turn[0]!.clientRequestId,
  };
  const uploadProof =
    await inspectResetPollutionUploadIntents(uploadCoordinate);
  await retireResetPollutionUploadIntents({
    ...uploadCoordinate,
    expectedStateSha256: uploadProof.stateSha256,
  });
  const retainedSources = await db.transaction(async (tx: any) => {
    const retiredUploadProof =
      await inspectResetPollutionUploadIntents(uploadCoordinate);
    const facts = await loadFacts(tx, input, retiredUploadProof);
    validateFacts(input, facts);
    if (
      retiredUploadProof.stateSha256 !== uploadProof.stateSha256 ||
      resetPollutionStateSha256(facts) !== input.expectedStateSha256
    ) {
      throw new Error("KB_RESET_POLLUTION_STATE_CHANGED");
    }
    return strictLocalStagedLedger(record(facts.turn.metadata))!.sources;
  });
  // Filesystem bytes cannot share the SQL transaction. Remove them first;
  // if SQL later fails, the retired local-only reservation remains safe and
  // this exact cleanup is idempotently retryable without any Provider call.
  await removeResetPollutionRetainedSources({
    userId: input.userId,
    buildId: input.buildId,
    generation: 1,
    sources: retainedSources,
  });
  const applied = await db.transaction(async (tx: any) => {
    const retiredUploadProof =
      await inspectResetPollutionUploadIntents(uploadCoordinate);
    const facts = await loadFacts(tx, input, retiredUploadProof);
    validateFacts(input, facts);
    if (
      retiredUploadProof.stateSha256 !== uploadProof.stateSha256 ||
      resetPollutionStateSha256(facts) !== input.expectedStateSha256
    ) {
      throw new Error("KB_RESET_POLLUTION_STATE_CHANGED");
    }
    const plan = planResetPollutionCleanupTransaction(input, facts);
    await tx
      .insert(knowledgeBaseConversationTombstones)
      .values({
        id: randomUUID(),
        userId: input.userId,
        publicConversationId: input.conversationId,
        resetRequestId: input.resetRequestId,
        createdAt: new Date(),
      })
      .onDuplicateKeyUpdate({ set: { resetRequestId: input.resetRequestId } });
    await tx
      .delete(attachments)
      .where(
        and(
          eq(attachments.userId, input.userId),
          eq(attachments.conversationId, facts.conversation.id),
        ),
      );
    await tx
      .delete(messages)
      .where(
        and(
          eq(messages.userId, input.userId),
          eq(messages.conversationId, facts.conversation.id),
        ),
      );
    await tx
      .delete(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, input.buildId),
        ),
      );
    await tx
      .delete(conversations)
      .where(
        and(
          eq(conversations.id, facts.conversation.id),
          eq(conversations.userId, input.userId),
        ),
      );
    await tx
      .delete(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.userId, input.userId),
        ),
      );
    const revised = await tx
      .update(knowledgeBaseResetStates)
      .set({
        revision: plan.nextResetRevision,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeBaseResetStates.userId, input.userId),
          eq(knowledgeBaseResetStates.revision, input.expectedResetRevision),
        ),
      );
    if (revised[0]?.affectedRows !== 1) {
      throw new Error("KB_RESET_POLLUTION_RESET_REVISION_CHANGED");
    }
    return {
      counts: counts(facts),
    };
  });
  return {
    status: "cleaned",
    resetRevisionIncremented: true,
    counts: applied.counts,
  };
}
