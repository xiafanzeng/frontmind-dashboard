import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import {
  agentOperations,
  agentTasks,
  artifacts,
  attachments,
  conversations,
  conversationTurns,
  deliveryProjectAssignments,
  messages,
} from "../drizzle/schema";
import { getDecryptedCredentialForAccountById } from "./auth-service";
import { getDb } from "./db";
import { ManusV2Client, type ManusV2MessageEvent } from "./manus-v2-client";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
  GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS,
  GENERAL_CHAT_TERMINAL_1547_PARTIAL_MESSAGE,
  GENERAL_CHAT_TERMINAL_1547_REPAIR_ID,
  GENERAL_CHAT_TERMINAL_1547_WINDOW,
  classifyGeneralChatTerminal1547Outcome,
  generalChatTerminal1547StateHash,
  generalChatTerminalMessagePersistedId,
  generalChatTerminalPublicIdFromPersisted,
  readGeneralChatTerminal1547ProviderEvidence,
  runStateBoundGeneralChatTerminal1547Repair,
  selectGeneralChatTerminal1547TurnEvents,
  type GeneralChatTerminal1547Outcome,
  type GeneralChatTerminal1547RepairCommand,
  type GeneralChatTerminal1547RepairSummary,
} from "./general-chat-incident-repair-20260828-1547-core";
import { sha256 } from "./general-chat-incident-repair-20260828-core";

const GENERAL_CHAT_CONTRACT = "dashboard.general-chat";
const GENERAL_CHAT_CONTRACT_REVISION = 2;
const GENERAL_CHAT_TURN_TYPE = "general_chat_v2";
const TERMINAL_NOTICE_KIND = "terminal_notice";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Operation = typeof agentOperations.$inferSelect;
type Task = typeof agentTasks.$inferSelect;
type Conversation = typeof conversations.$inferSelect;
type Turn = typeof conversationTurns.$inferSelect;
type Message = typeof messages.$inferSelect;
type Attachment = typeof attachments.$inferSelect;
type Artifact = typeof artifacts.$inferSelect;

type ProviderClient = Pick<ManusV2Client, "taskDetail" | "listAllMessages">;

type Dependencies = {
  getDatabase?: typeof getDb;
  getCredential?: typeof getDecryptedCredentialForAccountById;
  createProviderClient?: (input: {
    apiKey: string;
    accountUserId: number;
  }) => ProviderClient;
  now?: () => Date;
};

type ProjectionIdentity = {
  turnId: string;
  agentTaskId: string;
  providerEventId: string;
};

export type GeneralChatTerminal1547RepairFacts = {
  userId: number;
  operation: Operation;
  task: Task;
  conversation: Conversation;
  turn: Turn;
  userMessage: Message;
  outputMessages: Message[];
  inputAttachments: Attachment[];
  outputArtifacts: Artifact[];
  legacyErrors: Message[];
  terminalNotice: Message | null;
  providerDetail: Awaited<ReturnType<ManusV2Client["taskDetail"]>>;
  providerEvents: ManusV2MessageEvent[];
  currentTurnEventIds: string[];
  outcome: GeneralChatTerminal1547Outcome;
  chosenOutcome: "completed" | "partial";
  state: Record<string, unknown>;
  stateHash: string;
  complete: boolean;
  counts: NonNullable<GeneralChatTerminal1547RepairSummary["counts"]>;
};

function fail(code: string): never {
  throw new Error(`GENERAL_CHAT_TERMINAL_1547_${code}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function projectionIdentity(message: Message): ProjectionIdentity | null {
  const generalChat = record(message.metadata?.generalChat);
  const turnId = generalChat?.turnId;
  const agentTaskId = generalChat?.agentTaskId;
  const providerEventId = generalChat?.providerEventId;
  return generalChat?.schemaVersion === 1 &&
    generalChat.kind === "assistant_projection" &&
    generalChat.serverOwned === true &&
    typeof turnId === "string" &&
    typeof agentTaskId === "string" &&
    typeof providerEventId === "string"
    ? { turnId, agentTaskId, providerEventId }
    : null;
}

function metadataHasInlineImage(message: Message) {
  return (
    Array.isArray(message.metadata?.inlineImages) &&
    message.metadata.inlineImages.some(
      (item) => record(item) && typeof record(item)!.src === "string",
    )
  );
}

function artifactIdsFromMessage(message: Message) {
  const urls = [
    ...(Array.isArray(message.metadata?.inlineImages)
      ? message.metadata.inlineImages.flatMap((item) => {
          const src = record(item)?.src;
          return typeof src === "string" ? [src] : [];
        })
      : []),
    ...(Array.isArray(message.metadata?.outputFiles)
      ? message.metadata.outputFiles.flatMap((item) => {
          const fileUrl = record(item)?.fileUrl;
          return typeof fileUrl === "string" ? [fileUrl] : [];
        })
      : []),
  ];
  return urls.flatMap((url) => {
    const match = /^\/api\/frontmind\/v2\/artifacts\/([^/?#]+)\/content$/u.exec(
      url,
    );
    if (!match) return [];
    try {
      return [decodeURIComponent(match[1]!)];
    } catch {
      fail("ARTIFACT_URL_INVALID");
    }
  });
}

function isTerminalNotice(input: {
  message: Message | undefined;
  conversationId: string;
  turnId: string;
  userId: number;
}) {
  const metadata = input.message?.metadata ?? {};
  return Boolean(
    input.message &&
      input.message.conversationId === input.conversationId &&
      input.message.turnId === input.turnId &&
      input.message.userId === input.userId &&
      input.message.role === "assistant" &&
      input.message.content === GENERAL_CHAT_TERMINAL_1547_PARTIAL_MESSAGE &&
      input.message.deletedAt === null &&
      metadata.errorCode === GENERAL_CHAT_TERMINAL_1547_ERROR_CODE &&
      metadata.partialResult === true &&
      metadata.incidentRecovery === GENERAL_CHAT_TERMINAL_1547_REPAIR_ID,
  );
}

function createProviderClient(input: {
  apiKey: string;
  accountUserId: number;
}): ProviderClient {
  return new ManusV2Client({
    baseUrl: getUpstreamBaseUrl(),
    apiKey: input.apiKey,
    rateLimitScope: `managed-user:${input.accountUserId}`,
  });
}

async function requireDb(dependencies: Dependencies) {
  const db = await (dependencies.getDatabase ?? getDb)();
  if (!db) fail("DATABASE_UNAVAILABLE");
  return db;
}

function requiredExactlyOne<T>(values: readonly T[], code: string): T {
  if (values.length !== 1) fail(code);
  return values[0]!;
}

async function locateIncidentCandidate(db: Db) {
  const incidentMessages = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.role, "assistant"),
        gte(messages.sentAt, GENERAL_CHAT_TERMINAL_1547_WINDOW.start),
        lt(messages.sentAt, GENERAL_CHAT_TERMINAL_1547_WINDOW.end),
      ),
    )
    .orderBy(messages.sentAt, messages.id);

  const errorConversations = new Set<string>();
  for (const conversationId of new Set(
    incidentMessages
      .filter((message) =>
        GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.includes(message.content as never),
      )
      .map((message) => message.conversationId),
  )) {
    const rows = incidentMessages.filter(
      (message) =>
        message.conversationId === conversationId &&
        GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.includes(message.content as never),
    );
    if (
      GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.every(
        (content) => rows.filter((message) => message.content === content).length === 1,
      ) &&
      rows.length === GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.length
    ) {
      errorConversations.add(conversationId);
    }
  }

  const identities = incidentMessages.flatMap((message) => {
    const identity = projectionIdentity(message);
    return identity &&
      message.deletedAt === null &&
      errorConversations.has(message.conversationId) &&
      metadataHasInlineImage(message)
      ? [{ ...identity, conversationId: message.conversationId }]
      : [];
  });
  const identityKeys = sortedUnique(
    identities.map(
      (identity) =>
        `${identity.conversationId}\0${identity.agentTaskId}\0${identity.turnId}`,
    ),
  );
  const key = requiredExactlyOne(identityKeys, "CANDIDATE_NOT_UNIQUE");
  const [conversationId, localTaskId, turnId] = key.split("\0");
  if (!conversationId || !localTaskId || !turnId) fail("CANDIDATE_INVALID");
  return { conversationId, localTaskId, turnId, incidentMessages };
}

async function loadLocalFacts(db: Db) {
  const candidate = await locateIncidentCandidate(db);
  const joined = requiredExactlyOne(
    await db
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentTasks)
      .innerJoin(
        agentOperations,
        eq(agentOperations.id, agentTasks.operationId),
      )
      .where(eq(agentTasks.id, candidate.localTaskId)),
    "TASK_NOT_FOUND",
  );
  const conversation = requiredExactlyOne(
    await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, candidate.conversationId)),
    "CONVERSATION_NOT_FOUND",
  );
  const turn = requiredExactlyOne(
    await db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, candidate.turnId)),
    "TURN_NOT_FOUND",
  );
  const metadata = turn.metadata ?? {};
  if (
    joined.operation.scope !== "managed_user" ||
    !joined.operation.accountUserId ||
    joined.operation.presalesProjectId !== null ||
    joined.operation.operationType !== GENERAL_CHAT_CONTRACT ||
    joined.operation.contractName !== GENERAL_CHAT_CONTRACT ||
    joined.operation.contractRevision !== GENERAL_CHAT_CONTRACT_REVISION ||
    joined.task.operationId !== joined.operation.id ||
    !joined.task.providerTaskId ||
    conversation.userId !== joined.operation.accountUserId ||
    conversation.upstreamTaskId !== joined.task.id ||
    conversation.previousResponseId !== joined.task.id ||
    conversation.deletedAt !== null ||
    turn.conversationId !== conversation.id ||
    turn.userId !== joined.operation.accountUserId ||
    turn.apiCredentialId !== joined.operation.apiCredentialId ||
    turn.operationType !== GENERAL_CHAT_TURN_TYPE ||
    turn.upstreamTaskId !== joined.task.id ||
    metadata.agentTaskId !== joined.task.id ||
    metadata.operationId !== joined.operation.id ||
    typeof metadata.promptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(metadata.promptSha256)
  ) {
    fail("IDENTITY_MISMATCH");
  }
  if (conversation.projectAssignmentId) {
    const assignment = await db
      .select({ id: deliveryProjectAssignments.id })
      .from(deliveryProjectAssignments)
      .where(
        and(
          eq(deliveryProjectAssignments.id, conversation.projectAssignmentId),
          eq(
            deliveryProjectAssignments.engineerUserId,
            joined.operation.accountUserId,
          ),
        ),
      )
      .limit(1);
    if (assignment.length !== 1) fail("PROJECT_SCOPE_MISMATCH");
  }
  const userMessage = requiredExactlyOne(
    await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.turnId, turn.id),
          eq(messages.userId, joined.operation.accountUserId),
          eq(messages.role, "user"),
        ),
      ),
    "USER_MESSAGE_NOT_UNIQUE",
  );
  if (userMessage.deletedAt !== null) fail("USER_MESSAGE_DELETED");
  const outputMessages = (
    await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.turnId, turn.id),
          eq(messages.userId, joined.operation.accountUserId),
          eq(messages.role, "assistant"),
        ),
      )
      .orderBy(messages.sequence, messages.id)
  ).filter((message) => {
    const identity = projectionIdentity(message);
    return (
      message.deletedAt === null &&
      identity?.agentTaskId === joined.task.id &&
      identity.turnId === turn.id
    );
  });
  if (outputMessages.length === 0 || !outputMessages.some(metadataHasInlineImage)) {
    fail("OUTPUT_MISSING");
  }
  const inputAttachments = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.conversationId, conversation.id),
        eq(attachments.messageId, userMessage.id),
        eq(attachments.userId, joined.operation.accountUserId),
      ),
    );
  const persistedLocalAssetIds = inputAttachments.flatMap((attachment) =>
    attachment.upstreamFileId ? [attachment.upstreamFileId] : [],
  );
  if (
    inputAttachments.length === 0 ||
    inputAttachments.some(
      (attachment) =>
        attachment.deletedAt !== null || attachment.kind !== "image",
    ) ||
    !sameStrings(persistedLocalAssetIds, turn.attachmentFileIds)
  ) {
    fail("INPUT_ATTACHMENT_MISMATCH");
  }
  const artifactIds = sortedUnique(outputMessages.flatMap(artifactIdsFromMessage));
  if (artifactIds.length === 0) fail("OUTPUT_ARTIFACT_MISSING");
  const outputArtifacts = await db
    .select()
    .from(artifacts)
    .where(inArray(artifacts.id, artifactIds));
  if (
    outputArtifacts.length !== artifactIds.length ||
    outputArtifacts.some(
      (artifact) =>
        artifact.operationId !== joined.operation.id ||
        artifact.taskId !== joined.task.id ||
        artifact.validationState !== "valid",
    )
  ) {
    fail("OUTPUT_ARTIFACT_MISMATCH");
  }
  const legacyErrors = candidate.incidentMessages.filter(
    (message) =>
      message.conversationId === conversation.id &&
      GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.includes(message.content as never),
  );
  if (
    legacyErrors.length !== GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.length ||
    GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.some(
      (content) =>
        legacyErrors.filter((message) => message.content === content).length !== 1,
    )
  ) {
    fail("LEGACY_ERROR_MISMATCH");
  }
  const terminalNoticeId = generalChatTerminalMessagePersistedId({
    userId: joined.operation.accountUserId,
    projectAssignmentId: conversation.projectAssignmentId,
    persistedConversationId: conversation.id,
    localTaskId: joined.task.id,
    errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
  });
  const terminalNotice = (
    await db
      .select()
      .from(messages)
      .where(eq(messages.id, terminalNoticeId))
      .limit(1)
  )[0] as Message | undefined;
  return {
    operation: joined.operation,
    task: joined.task,
    conversation,
    turn,
    userMessage,
    outputMessages,
    inputAttachments,
    outputArtifacts,
    legacyErrors,
    terminalNotice: terminalNotice ?? null,
  };
}

export async function inspectGeneralChatTerminal1547Repair(
  dependencies: Dependencies = {},
): Promise<GeneralChatTerminal1547RepairFacts> {
  const db = await requireDb(dependencies);
  const local = await loadLocalFacts(db);
  const credential = await (
    dependencies.getCredential ?? getDecryptedCredentialForAccountById
  )(local.operation.accountUserId!, local.operation.apiCredentialId);
  if (
    !credential ||
    credential.id !== local.operation.apiCredentialId ||
    credential.version !== local.operation.credentialVersion
  ) {
    fail("CREDENTIAL_UNAVAILABLE");
  }
  const client = (
    dependencies.createProviderClient ?? createProviderClient
  )({
    apiKey: credential.apiKey,
    accountUserId: local.operation.accountUserId!,
  });
  const provider = await readGeneralChatTerminal1547ProviderEvidence(
    client,
    local.task.providerTaskId!,
  );
  const metadata = local.turn.metadata ?? {};
  const selection = selectGeneralChatTerminal1547TurnEvents({
    events: provider.events,
    promptSha256: String(metadata.promptSha256),
    providerAttachmentFileIds: stringArray(metadata.providerAttachmentFileIds),
    providerEventWatermark: stringArray(metadata.providerEventWatermark),
  });
  const outcome = classifyGeneralChatTerminal1547Outcome({
    detailStatus: provider.detail.status,
    currentTurnEvents: selection.events,
  });
  const persistedProviderEventIds = local.outputMessages.map(
    (message) => projectionIdentity(message)!.providerEventId,
  );
  if (!sameStrings(outcome.outputEventIds, persistedProviderEventIds)) {
    fail("OUTPUT_EVENT_MISMATCH");
  }
  const chosenOutcome =
    local.operation.status === "succeeded" &&
    !outcome.userStop &&
    outcome.outputEventIds.length > 0
      ? "completed"
      : outcome.kind === "completed" || outcome.kind === "partial"
        ? outcome.kind
        : fail(`PROVIDER_OUTCOME_${outcome.kind.toUpperCase()}`);
  const activeLegacyErrors = local.legacyErrors.filter(
    (message) => message.deletedAt === null,
  );
  const scopedPublicId = (persistedResourceId: string) =>
    generalChatTerminalPublicIdFromPersisted({
      userId: local.operation.accountUserId!,
      projectAssignmentId: local.conversation.projectAssignmentId,
      persistedConversationId: local.conversation.id,
      persistedResourceId,
    });
  const legacyErrorPublicIds = local.legacyErrors.map((message) =>
    scopedPublicId(message.id),
  );
  const terminalNoticePublicId = scopedPublicId(
    generalChatTerminalMessagePersistedId({
      userId: local.operation.accountUserId!,
      projectAssignmentId: local.conversation.projectAssignmentId,
      persistedConversationId: local.conversation.id,
      localTaskId: local.task.id,
      errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
    }),
  );
  const tombstones = new Set(local.conversation.deletedMessageIds);
  const legacyErrorsTombstoned = legacyErrorPublicIds.every((id) =>
    tombstones.has(id),
  );
  const validNotice = isTerminalNotice({
    message: local.terminalNotice ?? undefined,
    conversationId: local.conversation.id,
    turnId: local.turn.id,
    userId: local.operation.accountUserId!,
  });
  const completedState =
    local.operation.status === "succeeded" &&
    local.operation.errorCode === null &&
    local.task.providerState === "stopped" &&
    local.task.resultDeadlineAt === null &&
    local.turn.status === "completed" &&
    local.turn.errorCode === null &&
    local.turn.errorMessage === null &&
    local.conversation.status === "completed" &&
    local.conversation.upstreamTaskId === local.task.id &&
    local.conversation.previousResponseId === local.task.id &&
    activeLegacyErrors.length === 0 &&
    legacyErrorsTombstoned &&
    tombstones.has(terminalNoticePublicId) &&
    !validNotice;
  const partialState =
    local.operation.status === "failed" &&
    local.operation.errorCode === GENERAL_CHAT_TERMINAL_1547_ERROR_CODE &&
    local.task.providerState === "error" &&
    local.task.resultDeadlineAt === null &&
    local.turn.status === "failed" &&
    local.turn.errorCode === GENERAL_CHAT_TERMINAL_1547_ERROR_CODE &&
    local.conversation.status === "error" &&
    local.conversation.upstreamTaskId === local.task.id &&
    local.conversation.previousResponseId === local.task.id &&
    activeLegacyErrors.length === 0 &&
    legacyErrorsTombstoned &&
    !tombstones.has(terminalNoticePublicId) &&
    validNotice;
  const complete =
    chosenOutcome === "completed" ? completedState : partialState;
  const state = {
    schemaVersion: 1,
    incident: GENERAL_CHAT_TERMINAL_1547_REPAIR_ID,
    identity: {
      userIdSha256: sha256(String(local.operation.accountUserId)),
      operationIdSha256: sha256(local.operation.id),
      taskIdSha256: sha256(local.task.id),
      providerTaskIdSha256: sha256(local.task.providerTaskId!),
      conversationIdSha256: sha256(local.conversation.id),
      turnIdSha256: sha256(local.turn.id),
      userMessageIdSha256: sha256(local.userMessage.id),
    },
    provider: {
      detailStatus: outcome.detailStatus,
      eventStatus: outcome.eventStatus,
      errorType: outcome.errorType,
      userStop: outcome.userStop,
      currentTurnEventIdsSha256: selection.events.map((event) => sha256(event.id)),
      outputEventIdsSha256: outcome.outputEventIds.map(sha256),
      chosenOutcome,
    },
    local: {
      operationStatus: local.operation.status,
      operationErrorCode: local.operation.errorCode,
      taskProviderState: local.task.providerState,
      turnStatus: local.turn.status,
      turnErrorCode: local.turn.errorCode,
      conversationStatus: local.conversation.status,
      legacyErrors: local.legacyErrors.map((message) => ({
        idSha256: sha256(message.id),
        deleted: message.deletedAt !== null,
      })),
      legacyErrorsTombstoned,
      terminalNoticeTombstoned: tombstones.has(terminalNoticePublicId),
      terminalNotice: local.terminalNotice
        ? {
            idSha256: sha256(local.terminalNotice.id),
            valid: validNotice,
            deleted: local.terminalNotice.deletedAt !== null,
          }
        : null,
      outputMessageIdsSha256: local.outputMessages.map((message) => sha256(message.id)),
      inputAttachmentIdsSha256: local.inputAttachments.map((item) => sha256(item.id)),
      outputArtifactIdsSha256: local.outputArtifacts.map((item) => sha256(item.id)),
    },
    complete,
  };
  console.info("[GeneralChatTerminal1547Repair] settlement", {
    incident: GENERAL_CHAT_TERMINAL_1547_REPAIR_ID,
    taskId: local.task.id,
    turnId: local.turn.id,
    conversationId: local.conversation.id,
    detailStatus: outcome.detailStatus,
    eventStatus: outcome.eventStatus,
    outputCount: outcome.outputEventIds.length,
    chosenOutcome,
    errorType: outcome.errorType,
  });
  return {
    userId: local.operation.accountUserId!,
    ...local,
    providerDetail: provider.detail,
    providerEvents: provider.events,
    currentTurnEventIds: selection.events.map((event) => event.id),
    outcome,
    chosenOutcome,
    state,
    stateHash: generalChatTerminal1547StateHash(state),
    complete,
    counts: {
      outputMessages: local.outputMessages.length,
      inputAttachments: local.inputAttachments.length,
      outputArtifacts: local.outputArtifacts.length,
      legacyErrors: local.legacyErrors.length,
      activeTerminalNotices: validNotice ? 1 : 0,
    },
  };
}

/**
 * Production restart guard for the automatic path. It performs no credential
 * lookup and no Provider request. Any ambiguity returns false so the same
 * state-bound GET-only preview used by the explicit command remains the sole
 * repair authority.
 */
export async function isGeneralChatTerminal1547RepairLocallyComplete(
  dependencies: Pick<Dependencies, "getDatabase"> = {},
) {
  try {
    const db = await requireDb(dependencies);
    const local = await loadLocalFacts(db);
    const activeLegacyErrors = local.legacyErrors.filter(
      (message) => message.deletedAt === null,
    );
    if (activeLegacyErrors.length > 0) return false;
    const scopedPublicId = (persistedResourceId: string) =>
      generalChatTerminalPublicIdFromPersisted({
        userId: local.operation.accountUserId!,
        projectAssignmentId: local.conversation.projectAssignmentId,
        persistedConversationId: local.conversation.id,
        persistedResourceId,
      });
    const legacyErrorsTombstoned = local.legacyErrors.every((message) =>
      local.conversation.deletedMessageIds.includes(scopedPublicId(message.id)),
    );
    if (!legacyErrorsTombstoned) return false;
    const terminalNoticePublicId = scopedPublicId(
      generalChatTerminalMessagePersistedId({
        userId: local.operation.accountUserId!,
        projectAssignmentId: local.conversation.projectAssignmentId,
        persistedConversationId: local.conversation.id,
        localTaskId: local.task.id,
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
      }),
    );
    const validNotice = isTerminalNotice({
      message: local.terminalNotice ?? undefined,
      conversationId: local.conversation.id,
      turnId: local.turn.id,
      userId: local.operation.accountUserId!,
    });
    const completed =
      local.operation.status === "succeeded" &&
      local.operation.errorCode === null &&
      local.task.providerState === "stopped" &&
      local.task.resultDeadlineAt === null &&
      local.turn.status === "completed" &&
      local.turn.errorCode === null &&
      local.turn.errorMessage === null &&
      local.conversation.status === "completed" &&
      local.conversation.upstreamTaskId === local.task.id &&
      local.conversation.previousResponseId === local.task.id &&
      local.conversation.deletedMessageIds.includes(terminalNoticePublicId) &&
      !validNotice;
    const partial =
      local.operation.status === "failed" &&
      local.operation.errorCode === GENERAL_CHAT_TERMINAL_1547_ERROR_CODE &&
      local.task.providerState === "error" &&
      local.task.resultDeadlineAt === null &&
      local.turn.status === "failed" &&
      local.turn.errorCode === GENERAL_CHAT_TERMINAL_1547_ERROR_CODE &&
      local.conversation.status === "error" &&
      local.conversation.upstreamTaskId === local.task.id &&
      local.conversation.previousResponseId === local.task.id &&
      !local.conversation.deletedMessageIds.includes(terminalNoticePublicId) &&
      validNotice;
    return completed || partial;
  } catch {
    return false;
  }
}

async function applyGeneralChatTerminal1547Repair(
  db: Db,
  facts: GeneralChatTerminal1547RepairFacts,
  now: Date,
) {
  await db.transaction(async (tx) => {
    const lockedConversation = requiredExactlyOne(
      await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, facts.conversation.id))
        .limit(1)
        .for("update"),
      "APPLY_CONVERSATION_MISSING",
    );
    const lockedTurn = requiredExactlyOne(
      await tx
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.id, facts.turn.id))
        .limit(1)
        .for("update"),
      "APPLY_TURN_MISSING",
    );
    const lockedTask = requiredExactlyOne(
      await tx
        .select()
        .from(agentTasks)
        .where(eq(agentTasks.id, facts.task.id))
        .limit(1)
        .for("update"),
      "APPLY_TASK_MISSING",
    );
    const lockedOperation = requiredExactlyOne(
      await tx
        .select()
        .from(agentOperations)
        .where(eq(agentOperations.id, facts.operation.id))
        .limit(1)
        .for("update"),
      "APPLY_OPERATION_MISSING",
    );
    if (
      lockedConversation.userId !== facts.userId ||
      lockedConversation.upstreamTaskId !== facts.task.id ||
      lockedTurn.conversationId !== facts.conversation.id ||
      lockedTurn.upstreamTaskId !== facts.task.id ||
      lockedTask.operationId !== facts.operation.id ||
      lockedOperation.accountUserId !== facts.userId
    ) {
      fail("APPLY_IDENTITY_CHANGED");
    }
    const lockedErrors = await tx
      .select()
      .from(messages)
      .where(inArray(messages.id, facts.legacyErrors.map((message) => message.id)))
      .for("update");
    if (
      lockedErrors.length !== GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.length ||
      lockedErrors.some(
        (message) =>
          message.conversationId !== facts.conversation.id ||
          message.userId !== facts.userId ||
          message.role !== "assistant" ||
          !GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS.includes(message.content as never),
      )
    ) {
      fail("APPLY_LEGACY_ERROR_CHANGED");
    }
    await tx
      .update(messages)
      .set({ deletedAt: now })
      .where(inArray(messages.id, lockedErrors.map((message) => message.id)));

    const terminalNoticeId = generalChatTerminalMessagePersistedId({
      userId: facts.userId,
      projectAssignmentId: facts.conversation.projectAssignmentId,
      persistedConversationId: facts.conversation.id,
      localTaskId: facts.task.id,
      errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
    });
    const scopedPublicId = (persistedResourceId: string) =>
      generalChatTerminalPublicIdFromPersisted({
        userId: facts.userId,
        projectAssignmentId: facts.conversation.projectAssignmentId,
        persistedConversationId: facts.conversation.id,
        persistedResourceId,
      });
    const legacyErrorPublicIds = lockedErrors.map((message) =>
      scopedPublicId(message.id),
    );
    const terminalNoticePublicId = scopedPublicId(terminalNoticeId);
    const baseTombstones = sortedUnique([
      ...lockedConversation.deletedMessageIds,
      ...legacyErrorPublicIds,
    ]);
    if (facts.chosenOutcome === "completed") {
      await tx
        .update(agentOperations)
        .set({ status: "succeeded", errorCode: null, updatedAt: now })
        .where(eq(agentOperations.id, facts.operation.id));
      await tx
        .update(agentTasks)
        .set({ providerState: "stopped", resultDeadlineAt: null, updatedAt: now })
        .where(eq(agentTasks.id, facts.task.id));
      await tx
        .update(conversationTurns)
        .set({
          status: "completed",
          errorCode: null,
          errorMessage: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(conversationTurns.id, facts.turn.id));
      await tx
        .update(conversations)
        .set({
          status: "completed",
          upstreamTaskId: facts.task.id,
          previousResponseId: facts.task.id,
          lastKnownOutputLength: facts.outputMessages.length,
          deletedMessageIds: sortedUnique([
            ...baseTombstones,
            terminalNoticePublicId,
          ]),
          completedAt: now,
          updatedAt: now,
          version: sql`${conversations.version} + 1`,
        })
        .where(eq(conversations.id, facts.conversation.id));
      await tx
        .update(messages)
        .set({ deletedAt: now })
        .where(eq(messages.id, terminalNoticeId));
      return;
    }

    await tx
      .update(agentOperations)
      .set({
        status: "failed",
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
        updatedAt: now,
      })
      .where(eq(agentOperations.id, facts.operation.id));
    await tx
      .update(agentTasks)
      .set({ providerState: "error", resultDeadlineAt: null, updatedAt: now })
      .where(eq(agentTasks.id, facts.task.id));
    await tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
        errorMessage: GENERAL_CHAT_TERMINAL_1547_PARTIAL_MESSAGE,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, facts.turn.id));
    await tx
      .update(conversations)
      .set({
        status: "error",
        upstreamTaskId: facts.task.id,
        previousResponseId: facts.task.id,
        lastKnownOutputLength: facts.outputMessages.length,
        deletedMessageIds: baseTombstones.filter(
          (messageId) => messageId !== terminalNoticePublicId,
        ),
        completedAt: now,
        updatedAt: now,
        version: sql`${conversations.version} + 1`,
      })
      .where(eq(conversations.id, facts.conversation.id));
    const existingNotice = (
      await tx
        .select()
        .from(messages)
        .where(eq(messages.id, terminalNoticeId))
        .limit(1)
        .for("update")
    )[0] as Message | undefined;
    const terminalMetadata = {
      errorCode: GENERAL_CHAT_TERMINAL_1547_ERROR_CODE,
      partialResult: true,
      terminalNoticeKind: TERMINAL_NOTICE_KIND,
      incidentRecovery: GENERAL_CHAT_TERMINAL_1547_REPAIR_ID,
    };
    if (existingNotice) {
      if (
        existingNotice.conversationId !== facts.conversation.id ||
        existingNotice.userId !== facts.userId ||
        existingNotice.role !== "assistant"
      ) {
        fail("TERMINAL_NOTICE_IDEMPOTENCY_CONFLICT");
      }
      await tx
        .update(messages)
        .set({
          turnId: facts.turn.id,
          content: GENERAL_CHAT_TERMINAL_1547_PARTIAL_MESSAGE,
          metadata: terminalMetadata,
          sentAt: now,
          deletedAt: null,
        })
        .where(eq(messages.id, terminalNoticeId));
    } else {
      const latest = (
        await tx
          .select({ sequence: messages.sequence })
          .from(messages)
          .where(eq(messages.conversationId, facts.conversation.id))
          .orderBy(desc(messages.sequence))
          .limit(1)
      )[0];
      await tx.insert(messages).values({
        id: terminalNoticeId,
        conversationId: facts.conversation.id,
        turnId: facts.turn.id,
        userId: facts.userId,
        role: "assistant",
        content: GENERAL_CHAT_TERMINAL_1547_PARTIAL_MESSAGE,
        sequence: (latest?.sequence ?? -1) + 1,
        metadata: terminalMetadata,
        sentAt: now,
        createdAt: now,
      });
    }
  });
}

export async function executeGeneralChatTerminal1547Repair(
  command: GeneralChatTerminal1547RepairCommand,
  dependencies: Dependencies = {},
) {
  return runStateBoundGeneralChatTerminal1547Repair(command, {
    inspect: () => inspectGeneralChatTerminal1547Repair(dependencies),
    apply: async (before) => {
      const db = await requireDb(dependencies);
      const now = (dependencies.now ?? (() => new Date()))();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        fail("CLOCK_INVALID");
      }
      await applyGeneralChatTerminal1547Repair(db, before, now);
    },
  });
}
