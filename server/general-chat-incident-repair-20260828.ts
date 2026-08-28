import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import {
  agentEvents,
  agentOperations,
  agentTasks,
  artifacts,
  attachments,
  conversations,
  conversationTurns,
  localAssets,
  messages,
  providerFileLeases,
  users,
} from "../drizzle/schema";
import {
  parseFrontMindGeneralChatOperationContract,
  stripFrontMindGeneralChatOperationContract,
} from "../shared/frontmind-general-chat-contract";
import { sanitizeFrontMindPublicText } from "../shared/frontmind-public-brand";
import { getDecryptedCredentialForAccountById } from "./auth-service";
import { getDb } from "./db";
import {
  ManusV2Client,
  manusV2EventUserAttachmentFileIds,
  manusV2EventUserText,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import { readStoredPresalesFile } from "./presales-file-store";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  GENERAL_CHAT_INCIDENT_REPAIR_ID,
  GENERAL_CHAT_INCIDENT_WINDOWS,
  deterministicIncidentUuid,
  generalChatIncidentStateHash,
  generalChatTurnOperationKey,
  planGeneralChatIncidentMessageSequence,
  readGeneralChatIncidentProviderMessages,
  runStateBoundGeneralChatIncidentRepair,
  persistedIdForManagedUser,
  publicIdFromPersistedId,
  recoveredImageAttachmentPublicId,
  recoveredImageConversationPublicId,
  recoveredImageMessagePublicId,
  sha256,
  type GeneralChatIncidentRepairCommand,
  type GeneralChatIncidentRepairSummary,
  type GeneralChatIncidentSlot,
} from "./general-chat-incident-repair-20260828-core";

const CHAT_CONTRACT = "dashboard.general-chat";
const CHAT_CONTRACT_REVISION = 2;
const GENERAL_CHAT_TURN_TYPE = "general_chat_v2";
const EXPECTED_INPUT_IMAGE_BYTES = 3_989_574;
const EXPECTED_OUTPUT_IMAGE_BYTES = 3_738_494;
const EXPECTED_TEXT_PROMPT_SHA256 = sha256("你好");
const MINIMUM_INPUT_IMAGE_RETAIN_UNTIL = new Date("2026-09-27T00:00:00.000Z");

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Operation = typeof agentOperations.$inferSelect;
type Task = typeof agentTasks.$inferSelect;
type Conversation = typeof conversations.$inferSelect;
type Message = typeof messages.$inferSelect;
type CachedEvent = typeof agentEvents.$inferSelect;
type LocalAsset = typeof localAssets.$inferSelect;
type ProviderLease = typeof providerFileLeases.$inferSelect;
type Artifact = typeof artifacts.$inferSelect;

type OperationFact = {
  slot: GeneralChatIncidentSlot;
  operation: Operation;
  task: Task;
  providerEvents: ManusV2MessageEvent[];
  cachedEvents: CachedEvent[];
  createEvent: ManusV2MessageEvent;
  prompt: string;
  providerAttachmentFileIds: string[];
  expectedAssistantEventIds: string[];
};

type TextBinding = {
  slot: "text1020" | "text1027";
  fact: OperationFact;
  conversation: Conversation;
  message: Message;
  conversationPublicId: string;
  messagePublicId: string;
};

type ImageBinding = {
  slot: "image1022";
  fact: OperationFact;
  asset: LocalAsset;
  lease: ProviderLease;
  artifact: Artifact;
  conversationPublicId: string;
  messagePublicId: string;
  attachmentPublicId: string;
};

export type GeneralChatIncidentRepairFacts = {
  userId: number;
  text: [TextBinding, TextBinding];
  image: ImageBinding;
  state: Record<string, unknown>;
  stateHash: string;
  complete: boolean;
  counts: NonNullable<GeneralChatIncidentRepairSummary["counts"]>;
};

type Dependencies = {
  getDatabase?: typeof getDb;
  getCredential?: typeof getDecryptedCredentialForAccountById;
  readStoredFile?: typeof readStoredPresalesFile;
  createProviderClient?: (input: {
    apiKey: string;
    accountUserId: number;
  }) => Pick<ManusV2Client, "listAllMessages">;
  syncTask?: (input: {
    userId: number;
    localTaskId: string;
    recoveryTurnId: string;
    expectedProviderAssistantEventIds: readonly string[];
  }) => Promise<void>;
};

function fail(code: string): never {
  throw new Error(`GENERAL_CHAT_INCIDENT_${code}`);
}

function requestHash(value: unknown) {
  return sha256(JSON.stringify(value));
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function eventTime(event: ManusV2MessageEvent) {
  return new Date(
    event.timestamp < 1_000_000_000_000
      ? event.timestamp * 1_000
      : event.timestamp,
  );
}

function operationStatusToTurnStatus(status: Operation["status"]) {
  if (status === "succeeded") return "completed" as const;
  if (status === "cancelled") return "cancelled" as const;
  if (["failed", "attention_required"].includes(status)) {
    return "failed" as const;
  }
  if (status === "queued") return "queued" as const;
  return "running" as const;
}

function operationStatusToConversationStatus(status: Operation["status"]) {
  if (status === "succeeded") return "completed" as const;
  if (["failed", "cancelled", "attention_required"].includes(status)) {
    return "error" as const;
  }
  if (status === "queued") return "pending" as const;
  return "running" as const;
}

function requireExactlyOne<T>(values: readonly T[], code: string): T {
  if (values.length !== 1) fail(code);
  return values[0]!;
}

function createProviderClient(input: {
  apiKey: string;
  accountUserId: number;
}) {
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

async function loadOperationRow(db: Db, slot: GeneralChatIncidentSlot) {
  const window = GENERAL_CHAT_INCIDENT_WINDOWS[slot];
  const rows = await db
    .select({ operation: agentOperations, task: agentTasks })
    .from(agentOperations)
    .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        eq(agentOperations.scope, "managed_user"),
        eq(agentOperations.contractName, CHAT_CONTRACT),
        eq(agentOperations.contractRevision, CHAT_CONTRACT_REVISION),
        gte(agentOperations.createdAt, window.start),
        lt(agentOperations.createdAt, window.end),
      ),
    )
    .orderBy(agentOperations.createdAt, agentOperations.id);
  const row = requireExactlyOne(rows, `${slot.toUpperCase()}_NOT_UNIQUE`);
  if (
    row.operation.operationType !== CHAT_CONTRACT ||
    row.operation.status !== "succeeded" ||
    !row.operation.accountUserId ||
    row.operation.presalesProjectId !== null ||
    row.task.operationId !== row.operation.id ||
    row.task.providerTaskId === null ||
    row.task.providerState !== "stopped" ||
    row.task.title !== `FrontMind chat ${row.task.id}` ||
    row.task.createMarker !== `chat-create:${row.operation.id}`
  ) {
    fail(`${slot.toUpperCase()}_IDENTITY_MISMATCH`);
  }
  return row;
}

async function loadOperationFact(input: {
  db: Db;
  slot: GeneralChatIncidentSlot;
  operation: Operation;
  task: Task;
  dependencies: Dependencies;
}) {
  const credential = await (
    input.dependencies.getCredential ?? getDecryptedCredentialForAccountById
  )(input.operation.accountUserId!, input.operation.apiCredentialId);
  if (
    !credential ||
    credential.version !== input.operation.credentialVersion ||
    credential.id !== input.operation.apiCredentialId
  ) {
    fail(`${input.slot.toUpperCase()}_CREDENTIAL_UNAVAILABLE`);
  }
  const client = (
    input.dependencies.createProviderClient ?? createProviderClient
  )({
    apiKey: credential.apiKey,
    accountUserId: input.operation.accountUserId!,
  });
  const providerEvents = orderManusV2EventsByProviderRank(
    await readGeneralChatIncidentProviderMessages(client, {
      taskId: input.task.providerTaskId!,
      order: "asc",
    }),
    "oldest_first",
  );
  const expected = GENERAL_CHAT_INCIDENT_WINDOWS[input.slot];
  const userEvents = providerEvents.filter(
    (event) => event.type === "user_message",
  );
  const assistantEvents = providerEvents.filter(
    (event) => event.type === "assistant_message",
  );
  if (
    userEvents.length !== expected.providerUserMessages ||
    assistantEvents.length !== expected.providerAssistantMessages
  ) {
    fail(`${input.slot.toUpperCase()}_PROVIDER_EVENT_COUNT_MISMATCH`);
  }
  const createEvent = requireExactlyOne(
    userEvents.filter((event) => {
      const text = manusV2EventUserText(event);
      const contract = text
        ? parseFrontMindGeneralChatOperationContract(text)
        : null;
      return contract?.operationToken === input.task.createMarker;
    }),
    `${input.slot.toUpperCase()}_CREATE_EVENT_NOT_UNIQUE`,
  );
  const rawPrompt = manusV2EventUserText(createEvent);
  if (!rawPrompt) fail(`${input.slot.toUpperCase()}_PROMPT_MISSING`);
  const prompt = stripFrontMindGeneralChatOperationContract(rawPrompt).trim();
  if (!prompt || prompt.length > 2_000_000) {
    fail(`${input.slot.toUpperCase()}_PROMPT_INVALID`);
  }
  const providerAttachmentFileIds =
    manusV2EventUserAttachmentFileIds(createEvent);
  const cachedEvents = await input.db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.taskId, input.task.id))
    .orderBy(agentEvents.providerTimestampMs, agentEvents.id);
  const cachedProviderIds = new Set(
    cachedEvents
      .filter((event) => event.normalizedPayload?.kind === "provider_event")
      .map((event) => event.providerEventId),
  );
  if (
    ![...userEvents, ...assistantEvents].every((event) =>
      cachedProviderIds.has(event.id),
    )
  ) {
    fail(`${input.slot.toUpperCase()}_CACHED_EVENT_MISSING`);
  }
  return {
    slot: input.slot,
    operation: input.operation,
    task: input.task,
    providerEvents,
    cachedEvents,
    createEvent,
    prompt,
    providerAttachmentFileIds,
    expectedAssistantEventIds: assistantEvents.map((event) => event.id),
  } satisfies OperationFact;
}

async function loadTextBinding(input: {
  db: Db;
  fact: OperationFact;
  slot: "text1020" | "text1027";
}) {
  if (
    sha256(input.fact.prompt) !== EXPECTED_TEXT_PROMPT_SHA256 ||
    input.fact.providerAttachmentFileIds.length !== 0
  ) {
    fail(`${input.slot.toUpperCase()}_TEXT_PROMPT_MISMATCH`);
  }
  const window = GENERAL_CHAT_INCIDENT_WINDOWS[input.slot];
  const rows = await input.db
    .select({ conversation: conversations, message: messages })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.userId, input.fact.operation.accountUserId!),
        eq(messages.role, "user"),
        isNull(messages.deletedAt),
        isNull(conversations.deletedAt),
        isNull(conversations.projectAssignmentId),
        gte(messages.sentAt, window.start),
        lt(messages.sentAt, window.end),
      ),
    )
    .orderBy(messages.sentAt, messages.id);
  const candidates = rows.filter(({ conversation, message }) => {
    try {
      const conversationPublicId = publicIdFromPersistedId({
        userId: input.fact.operation.accountUserId!,
        persistedId: conversation.id,
      });
      const messagePublicId = publicIdFromPersistedId({
        userId: input.fact.operation.accountUserId!,
        persistedId: message.id,
      });
      const content = stripFrontMindGeneralChatOperationContract(
        message.content,
      ).trim();
      return (
        conversation.userId === input.fact.operation.accountUserId &&
        (conversation.apiCredentialId === null ||
          conversation.apiCredentialId ===
            input.fact.operation.apiCredentialId) &&
        sha256(`${input.fact.operation.accountUserId}\0${messagePublicId}`) ===
          input.fact.operation.idempotencyKeyHash &&
        content === input.fact.prompt &&
        requestHash({
          conversationId: conversationPublicId,
          prompt: content,
          localAssetIds: [],
          modelProfile: input.fact.operation.publicProfile,
        }) === input.fact.operation.requestHash
      );
    } catch {
      return false;
    }
  });
  const selected = requireExactlyOne(
    candidates,
    `${input.slot.toUpperCase()}_MESSAGE_NOT_UNIQUE`,
  );
  const attached = await input.db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.messageId, selected.message.id),
        isNull(attachments.deletedAt),
      ),
    );
  if (attached.length !== 0)
    fail(`${input.slot.toUpperCase()}_ATTACHMENT_PRESENT`);
  return {
    slot: input.slot,
    fact: input.fact,
    conversation: selected.conversation,
    message: selected.message,
    conversationPublicId: publicIdFromPersistedId({
      userId: input.fact.operation.accountUserId!,
      persistedId: selected.conversation.id,
    }),
    messagePublicId: publicIdFromPersistedId({
      userId: input.fact.operation.accountUserId!,
      persistedId: selected.message.id,
    }),
  } satisfies TextBinding;
}

async function loadImageBinding(input: {
  db: Db;
  fact: OperationFact;
  dependencies: Dependencies;
}) {
  if (input.fact.providerAttachmentFileIds.length !== 1) {
    fail("IMAGE1022_PROVIDER_ATTACHMENT_NOT_UNIQUE");
  }
  const window = GENERAL_CHAT_INCIDENT_WINDOWS.image1022;
  const candidates = await input.db
    .select({ asset: localAssets, lease: providerFileLeases })
    .from(localAssets)
    .innerJoin(
      providerFileLeases,
      eq(providerFileLeases.localAssetId, localAssets.id),
    )
    .where(
      and(
        eq(localAssets.scope, "managed_user"),
        eq(localAssets.accountUserId, input.fact.operation.accountUserId!),
        isNull(localAssets.presalesProjectId),
        eq(localAssets.mimeType, "image/png"),
        eq(localAssets.sizeBytes, EXPECTED_INPUT_IMAGE_BYTES),
        gte(localAssets.createdAt, window.start),
        lt(localAssets.createdAt, window.end),
        eq(
          providerFileLeases.apiCredentialId,
          input.fact.operation.apiCredentialId,
        ),
        eq(
          providerFileLeases.credentialVersion,
          input.fact.operation.credentialVersion,
        ),
        eq(providerFileLeases.uploadState, "uploaded"),
        eq(providerFileLeases.uploadedBytes, EXPECTED_INPUT_IMAGE_BYTES),
        inArray(
          providerFileLeases.providerFileId,
          input.fact.providerAttachmentFileIds,
        ),
      ),
    );
  const selected = requireExactlyOne(
    candidates,
    "IMAGE1022_LOCAL_ASSET_NOT_UNIQUE",
  );
  if (
    !selected.lease.providerFileId ||
    selected.asset.refCount < 1 ||
    !selected.asset.retainUntil ||
    selected.asset.retainUntil.getTime() <= Date.now() ||
    selected.asset.retainUntil < MINIMUM_INPUT_IMAGE_RETAIN_UNTIL
  ) {
    fail("IMAGE1022_LOCAL_ASSET_INVALID");
  }
  const readStored =
    input.dependencies.readStoredFile ?? readStoredPresalesFile;
  const inputStored = await readStored(selected.asset.id);
  if (
    !inputStored ||
    inputStored.sizeBytes !== selected.asset.sizeBytes ||
    inputStored.recordedSizeBytes !== selected.asset.sizeBytes ||
    inputStored.sha256 !== selected.asset.contentSha256
  ) {
    fail("IMAGE1022_LOCAL_ASSET_BYTES_INVALID");
  }
  const artifactRows = await input.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.operationId, input.fact.operation.id),
        eq(artifacts.taskId, input.fact.task.id),
        eq(artifacts.validationState, "valid"),
        eq(artifacts.mimeType, "image/png"),
        eq(artifacts.sizeBytes, EXPECTED_OUTPUT_IMAGE_BYTES),
      ),
    );
  const artifact = requireExactlyOne(
    artifactRows,
    "IMAGE1022_ARTIFACT_NOT_UNIQUE",
  );
  const outputStored = await readStored(artifact.id);
  if (
    !outputStored ||
    outputStored.sizeBytes !== artifact.sizeBytes ||
    outputStored.recordedSizeBytes !== artifact.sizeBytes ||
    outputStored.sha256 !== artifact.contentSha256
  ) {
    fail("IMAGE1022_ARTIFACT_BYTES_INVALID");
  }
  return {
    slot: "image1022",
    fact: input.fact,
    asset: selected.asset,
    lease: selected.lease,
    artifact,
    conversationPublicId: recoveredImageConversationPublicId(
      input.fact.task.id,
    ),
    messagePublicId: recoveredImageMessagePublicId(input.fact.task.id),
    attachmentPublicId: recoveredImageAttachmentPublicId(input.fact.task.id),
  } satisfies ImageBinding;
}

function projectionMessagePublicId(taskId: string, providerEventId: string) {
  return `msg-general-chat-${sha256(`${taskId}\0${providerEventId}`)}`;
}

function epochSecond(value: Date | null | undefined) {
  return value ? Math.floor(value.getTime() / 1_000) : null;
}

function sameJson(left: unknown, right: unknown) {
  return (
    generalChatIncidentStateHash(left) === generalChatIncidentStateHash(right)
  );
}

function assistantProjectionText(event: ManusV2MessageEvent) {
  if (event.type !== "assistant_message") return "";
  const message =
    event.assistant_message &&
    typeof event.assistant_message === "object" &&
    !Array.isArray(event.assistant_message)
      ? (event.assistant_message as Record<string, unknown>)
      : null;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((item) =>
              item && typeof item === "object" && !Array.isArray(item)
                ? [String((item as Record<string, unknown>).text ?? "")]
                : [],
            )
            .filter(Boolean)
            .join("\n")
        : "";
  return sanitizeFrontMindPublicText(
    stripFrontMindGeneralChatOperationContract(text),
  ).trim();
}

function expectedTurnForBinding(input: {
  userId: number;
  binding: TextBinding | ImageBinding;
}) {
  if (input.binding.slot === "image1022") {
    const conversationId = persistedIdForManagedUser({
      userId: input.userId,
      publicId: input.binding.conversationPublicId,
    });
    return turnInsert({
      userId: input.userId,
      conversationId,
      conversationPublicId: input.binding.conversationPublicId,
      clientRequestId: input.binding.messagePublicId,
      fact: input.binding.fact,
      localAssetIds: [input.binding.asset.id],
      sequenceFinalized: true,
    });
  }
  return turnInsert({
    userId: input.userId,
    conversationId: input.binding.conversation.id,
    conversationPublicId: input.binding.conversationPublicId,
    clientRequestId: input.binding.messagePublicId,
    fact: input.binding.fact,
    localAssetIds: [],
    sequenceFinalized: true,
  });
}

function turnMatchesExpected(
  actual: typeof conversationTurns.$inferSelect,
  expected: typeof conversationTurns.$inferInsert,
) {
  return (
    actual.id === expected.id &&
    actual.conversationId === expected.conversationId &&
    actual.userId === expected.userId &&
    actual.apiCredentialId === expected.apiCredentialId &&
    actual.clientRequestId === expected.clientRequestId &&
    actual.buildId === null &&
    actual.buildGeneration === null &&
    actual.operationKey === expected.operationKey &&
    actual.operationType === expected.operationType &&
    actual.expectedRevision === null &&
    actual.expectedLeafId === null &&
    actual.requestHash === expected.requestHash &&
    actual.upstreamIdempotencyKeyHash === expected.upstreamIdempotencyKeyHash &&
    sameJson(actual.attachmentFileIds, expected.attachmentFileIds) &&
    sameJson(actual.metadata, expected.metadata) &&
    actual.leaseExpiresAt === null &&
    actual.model === expected.model &&
    actual.status === expected.status &&
    actual.upstreamTaskId === expected.upstreamTaskId &&
    actual.errorCode === (expected.errorCode ?? null) &&
    actual.errorMessage === null &&
    epochSecond(actual.startedAt) === epochSecond(expected.startedAt) &&
    epochSecond(actual.completedAt) === epochSecond(expected.completedAt) &&
    epochSecond(actual.createdAt) === epochSecond(expected.createdAt) &&
    epochSecond(actual.updatedAt) === epochSecond(expected.updatedAt)
  );
}

function assistantExpectations(input: {
  userId: number;
  bindings: readonly (TextBinding | ImageBinding)[];
}) {
  return input.bindings.flatMap((binding) => {
    const turnId = deterministicIncidentUuid(
      `turn:${binding.fact.operation.id}`,
    );
    const conversationId =
      binding.slot === "image1022"
        ? persistedIdForManagedUser({
            userId: input.userId,
            publicId: binding.conversationPublicId,
          })
        : binding.conversation.id;
    return binding.fact.expectedAssistantEventIds.map((providerEventId) => {
      const event = requireExactlyOne(
        binding.fact.providerEvents.filter(
          (candidate) => candidate.id === providerEventId,
        ),
        `${binding.slot.toUpperCase()}_ASSISTANT_EVENT_NOT_UNIQUE`,
      );
      const cachedEvent = requireExactlyOne(
        binding.fact.cachedEvents.filter(
          (candidate) => candidate.providerEventId === providerEventId,
        ),
        `${binding.slot.toUpperCase()}_CACHED_ASSISTANT_NOT_UNIQUE`,
      );
      return {
        slot: binding.slot,
        taskId: binding.fact.task.id,
        turnId,
        conversationId,
        providerEventId,
        event,
        cachedEventId: cachedEvent.id,
        id: persistedIdForManagedUser({
          userId: input.userId,
          publicId: projectionMessagePublicId(
            binding.fact.task.id,
            providerEventId,
          ),
        }),
      };
    });
  });
}

function incidentWireRank(input: {
  text: readonly TextBinding[];
  image: ImageBinding;
}) {
  const bindings: readonly (TextBinding | ImageBinding)[] = [
    ...input.text,
    input.image,
  ];
  const ordered = bindings
    .flatMap((binding) =>
      binding.fact.providerEvents.map((event, providerIndex) => ({
        event,
        providerIndex,
        taskId: binding.fact.task.id,
      })),
    )
    .sort(
      (left, right) =>
        eventTime(left.event).getTime() - eventTime(right.event).getTime() ||
        left.providerIndex - right.providerIndex ||
        left.taskId.localeCompare(right.taskId) ||
        left.event.id.localeCompare(right.event.id),
    );
  return new Map(ordered.map((item, index) => [item.event.id, index]));
}

function planConversationSequence(input: {
  rows: readonly Message[];
  text: readonly TextBinding[];
  image: ImageBinding;
}) {
  const wireRank = incidentWireRank({ text: input.text, image: input.image });
  const assistantEvents = new Map(
    [...input.text.map((binding) => binding.fact), input.image.fact].flatMap(
      (fact) =>
        fact.providerEvents
          .filter((event) => event.type === "assistant_message")
          .map(
            (event) =>
              [
                persistedIdForManagedUser({
                  userId: fact.operation.accountUserId!,
                  publicId: projectionMessagePublicId(fact.task.id, event.id),
                }),
                event,
              ] as const,
          ),
    ),
  );
  const userEvents = new Map<string, ManusV2MessageEvent>();
  for (const binding of input.text) {
    userEvents.set(binding.message.id, binding.fact.createEvent);
  }
  userEvents.set(
    persistedIdForManagedUser({
      userId: input.image.fact.operation.accountUserId!,
      publicId: input.image.messagePublicId,
    }),
    input.image.fact.createEvent,
  );
  return planGeneralChatIncidentMessageSequence(
    input.rows.map((row) => {
      const assistantEvent = assistantEvents.get(row.id);
      const userEvent = userEvents.get(row.id);
      const event = assistantEvent ?? userEvent;
      return {
        id: row.id,
        currentSequence: row.sequence,
        // Browser user-message sentAt remains authoritative. Provider wire
        // time is used only for server-owned assistant projections.
        effectiveTimeMs: assistantEvent
          ? eventTime(assistantEvent).getTime()
          : row.sentAt.getTime(),
        wireRank: event ? (wireRank.get(event.id) ?? null) : null,
      };
    }),
  );
}

async function conversationSequenceIsCanonical(input: {
  db: Db;
  conversationId: string;
  text: readonly TextBinding[];
  image: ImageBinding;
}) {
  const rows = await input.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, input.conversationId))
    .orderBy(asc(messages.sequence), asc(messages.id));
  const plan = planConversationSequence({
    rows,
    text: input.text,
    image: input.image,
  });
  return (
    rows.length === plan.length &&
    rows.every((row, index) => row.sequence === index && row.id === plan[index])
  );
}

async function resequenceConversation(input: {
  executor: any;
  conversationId: string;
  text: readonly TextBinding[];
  image: ImageBinding;
}) {
  await input.executor
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1)
    .for("update");
  const rows = (await input.executor
    .select()
    .from(messages)
    .where(eq(messages.conversationId, input.conversationId))
    .orderBy(asc(messages.sequence), asc(messages.id))
    .for("update")) as Message[];
  if (rows.length === 0) fail("RESEQUENCE_EMPTY_CONVERSATION");
  const plan = planConversationSequence({
    rows,
    text: input.text,
    image: input.image,
  });
  const sequences = rows.map((row) => row.sequence);
  const minimum = Math.min(...sequences);
  const maximum = Math.max(...sequences);
  const offset = maximum - minimum + rows.length + 1_024;
  if (!Number.isSafeInteger(offset) || maximum + offset > 2_147_483_647) {
    fail("RESEQUENCE_RANGE_INVALID");
  }
  await input.executor
    .update(messages)
    .set({ sequence: sql`${messages.sequence} + ${offset}` })
    .where(eq(messages.conversationId, input.conversationId));
  for (const [sequence, id] of plan.entries()) {
    await input.executor
      .update(messages)
      .set({ sequence })
      .where(
        and(
          eq(messages.id, id),
          eq(messages.conversationId, input.conversationId),
        ),
      );
  }
}

async function resequenceIncidentConversations(
  db: Db,
  facts: GeneralChatIncidentRepairFacts,
) {
  const imageConversationId = persistedIdForManagedUser({
    userId: facts.userId,
    publicId: facts.image.conversationPublicId,
  });
  await db.transaction(async (tx) => {
    await resequenceConversation({
      executor: tx,
      conversationId: facts.text[0].conversation.id,
      text: facts.text,
      image: facts.image,
    });
    await resequenceConversation({
      executor: tx,
      conversationId: imageConversationId,
      text: facts.text,
      image: facts.image,
    });
    for (const binding of [...facts.text, facts.image]) {
      const expected = expectedTurnForBinding({
        userId: facts.userId,
        binding,
      });
      await tx
        .update(conversationTurns)
        .set({
          metadata: expected.metadata,
          updatedAt: expected.updatedAt,
        })
        .where(eq(conversationTurns.id, String(expected.id)));
    }
  });
}

function recoveredImageTitle(image: ImageBinding) {
  const titleSource = image.fact.prompt.replace(/\s+/gu, " ").trim();
  return `已恢复 · ${titleSource.slice(0, 20)}${titleSource.length > 20 ? "…" : ""}`;
}

async function inspectRecoveryPersistence(input: {
  db: Db;
  userId: number;
  text: readonly [TextBinding, TextBinding];
  image: ImageBinding;
}) {
  const bindings: readonly (TextBinding | ImageBinding)[] = [
    ...input.text,
    input.image,
  ];
  const expectedTurns = bindings.map((binding) =>
    expectedTurnForBinding({ userId: input.userId, binding }),
  );
  const expectedTurnsById = new Map(
    expectedTurns.map((turn) => [String(turn.id), turn]),
  );
  const taskIds = bindings.map((binding) => binding.fact.task.id);
  const turnRows = await input.db
    .select()
    .from(conversationTurns)
    .where(inArray(conversationTurns.upstreamTaskId, taskIds));
  for (const row of turnRows) {
    const expected = expectedTurnsById.get(row.id);
    const pendingExpected = expected
      ? {
          ...expected,
          metadata: {
            ...(expected.metadata ?? {}),
            sequenceFinalized: false,
          },
        }
      : null;
    if (
      !expected ||
      (!turnMatchesExpected(row, expected) &&
        (!pendingExpected || !turnMatchesExpected(row, pendingExpected)))
    ) {
      fail("EXISTING_TURN_CONFLICT");
    }
  }
  const exactTurns =
    turnRows.length === expectedTurns.length &&
    expectedTurns.every((expected) =>
      turnRows.some(
        (row) => row.id === expected.id && turnMatchesExpected(row, expected),
      ),
    );

  const textConversationId = input.text[0].conversation.id;
  const imageConversationId = persistedIdForManagedUser({
    userId: input.userId,
    publicId: input.image.conversationPublicId,
  });
  const latestText = [...input.text].sort(
    (left, right) =>
      right.fact.operation.createdAt.getTime() -
      left.fact.operation.createdAt.getTime(),
  )[0]!;
  const conversationRows = await input.db
    .select()
    .from(conversations)
    .where(
      inArray(conversations.id, [textConversationId, imageConversationId]),
    );
  const textConversation = conversationRows.find(
    (row) => row.id === textConversationId,
  );
  const imageConversation = conversationRows.find(
    (row) => row.id === imageConversationId,
  );
  if (!textConversation) fail("TEXT_CONVERSATION_MISSING");
  const textConversationExact =
    textConversation.userId === input.userId &&
    textConversation.projectAssignmentId === null &&
    textConversation.apiCredentialId ===
      latestText.fact.operation.apiCredentialId &&
    textConversation.upstreamTaskId === latestText.fact.task.id &&
    textConversation.previousResponseId === latestText.fact.task.id &&
    textConversation.status ===
      operationStatusToConversationStatus(latestText.fact.operation.status) &&
    textConversation.lastKnownOutputLength ===
      latestText.fact.expectedAssistantEventIds.length &&
    epochSecond(textConversation.completedAt) ===
      epochSecond(latestText.fact.operation.updatedAt) &&
    textConversation.deletedAt === null;
  let imageConversationExact = false;
  if (imageConversation) {
    if (
      imageConversation.userId !== input.userId ||
      imageConversation.projectAssignmentId !== null ||
      imageConversation.apiCredentialId !==
        input.image.fact.operation.apiCredentialId ||
      imageConversation.title !== recoveredImageTitle(input.image) ||
      imageConversation.status !==
        operationStatusToConversationStatus(
          input.image.fact.operation.status,
        ) ||
      imageConversation.upstreamTaskId !== input.image.fact.task.id ||
      imageConversation.previousResponseId !== input.image.fact.task.id ||
      imageConversation.taskUrl !== null ||
      imageConversation.lastKnownOutputLength !==
        input.image.fact.expectedAssistantEventIds.length ||
      !sameJson(imageConversation.deletedMessageIds, []) ||
      epochSecond(imageConversation.startedAt) !==
        epochSecond(input.image.fact.operation.createdAt) ||
      epochSecond(imageConversation.completedAt) !==
        epochSecond(input.image.fact.operation.updatedAt) ||
      epochSecond(imageConversation.createdAt) !==
        epochSecond(eventTime(input.image.fact.createEvent)) ||
      imageConversation.deletedAt !== null
    ) {
      fail("IMAGE_CONVERSATION_IDEMPOTENCY_CONFLICT");
    }
    imageConversationExact = true;
  }

  const imageMessageId = persistedIdForManagedUser({
    userId: input.userId,
    publicId: input.image.messagePublicId,
  });
  const userMessageIds = [
    ...input.text.map((binding) => binding.message.id),
    imageMessageId,
  ];
  const userRows = await input.db
    .select()
    .from(messages)
    .where(inArray(messages.id, userMessageIds));
  const linkedUserRows = await input.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        inArray(
          messages.turnId,
          expectedTurns.map((turn) => String(turn.id)),
        ),
        eq(messages.role, "user"),
      ),
    );
  let userMessagesExact = true;
  for (const binding of input.text) {
    const row = userRows.find(
      (candidate) => candidate.id === binding.message.id,
    );
    const expectedTurnId = deterministicIncidentUuid(
      `turn:${binding.fact.operation.id}`,
    );
    if (!row) fail(`${binding.slot.toUpperCase()}_MESSAGE_MISSING`);
    if (
      row.conversationId !== binding.conversation.id ||
      row.userId !== input.userId ||
      row.role !== "user" ||
      row.deletedAt !== null
    ) {
      fail(`${binding.slot.toUpperCase()}_MESSAGE_IDENTITY_CONFLICT`);
    }
    userMessagesExact &&=
      row.turnId === expectedTurnId &&
      row.content === binding.fact.prompt &&
      stripFrontMindGeneralChatOperationContract(row.content) === row.content;
  }
  const imageUserMessage = userRows.find((row) => row.id === imageMessageId);
  if (imageUserMessage) {
    const expectedMetadata = {
      modelName: input.image.fact.operation.publicProfile,
      incidentRecovery: GENERAL_CHAT_INCIDENT_REPAIR_ID,
    };
    if (
      imageUserMessage.conversationId !== imageConversationId ||
      imageUserMessage.userId !== input.userId ||
      imageUserMessage.role !== "user" ||
      imageUserMessage.content !== input.image.fact.prompt ||
      imageUserMessage.turnId !==
        deterministicIncidentUuid(`turn:${input.image.fact.operation.id}`) ||
      !sameJson(imageUserMessage.metadata, expectedMetadata) ||
      epochSecond(imageUserMessage.sentAt) !==
        epochSecond(eventTime(input.image.fact.createEvent)) ||
      imageUserMessage.deletedAt !== null ||
      stripFrontMindGeneralChatOperationContract(imageUserMessage.content) !==
        imageUserMessage.content
    ) {
      fail("IMAGE_MESSAGE_IDEMPOTENCY_CONFLICT");
    }
  } else {
    userMessagesExact = false;
  }
  if (
    linkedUserRows.some((row) => !userMessageIds.includes(row.id)) ||
    (exactTurns && linkedUserRows.length !== userMessageIds.length)
  ) {
    fail("USER_MESSAGE_TURN_MAPPING_CONFLICT");
  }

  const imageAttachmentId = persistedIdForManagedUser({
    userId: input.userId,
    publicId: input.image.attachmentPublicId,
  });
  const attachmentRows = await input.db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.messageId, imageMessageId),
        isNull(attachments.deletedAt),
      ),
    );
  if (
    attachmentRows.length > 1 ||
    (attachmentRows[0] && attachmentRows[0].id !== imageAttachmentId)
  ) {
    fail("IMAGE_ATTACHMENT_DUPLICATE");
  }
  let imageAttachmentExact = false;
  if (attachmentRows[0]) {
    const row = attachmentRows[0];
    if (
      row.userId !== input.userId ||
      row.conversationId !== imageConversationId ||
      row.messageId !== imageMessageId ||
      row.apiCredentialId !== input.image.fact.operation.apiCredentialId ||
      row.kind !== "image" ||
      row.fileName !== input.image.asset.filename ||
      row.mimeType !== input.image.asset.mimeType ||
      row.sizeBytes !== input.image.asset.sizeBytes ||
      row.upstreamFileId !== input.image.asset.id ||
      row.deletedAt !== null
    ) {
      fail("IMAGE_ATTACHMENT_IDEMPOTENCY_CONFLICT");
    }
    imageAttachmentExact = true;
  }

  const expectedAssistants = assistantExpectations({
    userId: input.userId,
    bindings,
  });
  const assistantRows = await input.db
    .select()
    .from(messages)
    .where(
      and(
        inArray(
          messages.turnId,
          expectedTurns.map((turn) => String(turn.id)),
        ),
        eq(messages.role, "assistant"),
      ),
    );
  const perSlot = { text1020: 0, image1022: 0, text1027: 0 };
  for (const row of assistantRows) {
    const expected = expectedAssistants.find((item) => item.id === row.id);
    if (!expected) fail("ASSISTANT_PROJECTION_UNEXPECTED");
    const metadata = row.metadata ?? {};
    const generalChat =
      metadata.generalChat &&
      typeof metadata.generalChat === "object" &&
      !Array.isArray(metadata.generalChat)
        ? (metadata.generalChat as Record<string, unknown>)
        : null;
    if (
      row.conversationId !== expected.conversationId ||
      row.turnId !== expected.turnId ||
      row.userId !== input.userId ||
      row.role !== "assistant" ||
      row.content !== assistantProjectionText(expected.event) ||
      stripFrontMindGeneralChatOperationContract(row.content) !== row.content ||
      metadata.upstreamOutputId !== expected.cachedEventId ||
      generalChat?.schemaVersion !== 1 ||
      generalChat.kind !== "assistant_projection" ||
      generalChat.turnId !== expected.turnId ||
      generalChat.agentTaskId !== expected.taskId ||
      generalChat.providerEventId !== expected.providerEventId ||
      generalChat.serverOwned !== true ||
      epochSecond(row.sentAt) !== epochSecond(eventTime(expected.event)) ||
      row.deletedAt !== null
    ) {
      fail("ASSISTANT_PROJECTION_CONFLICT");
    }
    perSlot[expected.slot] += 1;
  }
  const expectedArtifactUrl = `/api/frontmind/v2/artifacts/${encodeURIComponent(
    input.image.artifact.id,
  )}/content`;
  const artifactLinkCount = assistantRows.reduce((count, row) => {
    const inlineImages = Array.isArray(row.metadata?.inlineImages)
      ? row.metadata.inlineImages
      : [];
    const outputFiles = Array.isArray(row.metadata?.outputFiles)
      ? row.metadata.outputFiles
      : [];
    return (
      count +
      inlineImages.filter((item) => item?.src === expectedArtifactUrl).length +
      outputFiles.filter((item) => item?.fileUrl === expectedArtifactUrl).length
    );
  }, 0);
  const assistantMessagesExact =
    assistantRows.length === expectedAssistants.length &&
    perSlot.text1020 ===
      GENERAL_CHAT_INCIDENT_WINDOWS.text1020.providerAssistantMessages &&
    perSlot.image1022 ===
      GENERAL_CHAT_INCIDENT_WINDOWS.image1022.providerAssistantMessages &&
    perSlot.text1027 ===
      GENERAL_CHAT_INCIDENT_WINDOWS.text1027.providerAssistantMessages &&
    artifactLinkCount === 1;
  const textSequenceCanonical = await conversationSequenceIsCanonical({
    db: input.db,
    conversationId: textConversationId,
    text: input.text,
    image: input.image,
  });
  const imageSequenceCanonical = imageConversation
    ? await conversationSequenceIsCanonical({
        db: input.db,
        conversationId: imageConversationId,
        text: input.text,
        image: input.image,
      })
    : false;
  const complete =
    exactTurns &&
    textConversationExact &&
    imageConversationExact &&
    userMessagesExact &&
    imageAttachmentExact &&
    assistantMessagesExact &&
    textSequenceCanonical &&
    imageSequenceCanonical;
  return {
    complete,
    projectedAssistantMessages: assistantRows.length,
    existingTurnIds: turnRows.map((row) => row.id),
    recoveredImageConversationExists: Boolean(imageConversation),
    verification: {
      exactTurns,
      textConversationExact,
      imageConversationExact,
      userMessagesExact,
      imageAttachmentExact,
      assistantMessagesExact,
      assistantMessagesPerSlot: perSlot,
      artifactLinkCount,
      textSequenceCanonical,
      imageSequenceCanonical,
    },
  };
}

function incidentState(input: {
  userId: number;
  text: readonly TextBinding[];
  image: ImageBinding;
  projectedAssistantMessages: number;
  existingTurnIds: readonly string[];
  recoveredImageConversationExists: boolean;
  verification: Record<string, unknown>;
}) {
  const operationState = [
    ...input.text.map((binding) => binding.fact),
    input.image.fact,
  ]
    .map((fact) => ({
      slot: fact.slot,
      operationIdSha256: sha256(fact.operation.id),
      taskIdSha256: sha256(fact.task.id),
      providerTaskIdSha256: sha256(fact.task.providerTaskId!),
      idempotencyKeyHash: fact.operation.idempotencyKeyHash,
      requestHash: fact.operation.requestHash,
      createdAt: fact.operation.createdAt,
      promptSha256: sha256(fact.prompt),
      providerAttachmentFileIdsSha256:
        fact.providerAttachmentFileIds.map(sha256),
      providerEventIdsSha256: fact.providerEvents.map((event) =>
        sha256(event.id),
      ),
      cachedEventIdsSha256: fact.cachedEvents.map((event) =>
        sha256(event.providerEventId),
      ),
    }))
    .sort((left, right) => left.slot.localeCompare(right.slot));
  return {
    schemaVersion: 1,
    incident: GENERAL_CHAT_INCIDENT_REPAIR_ID,
    accountUserIdSha256: sha256(String(input.userId)),
    operations: operationState,
    textBindings: input.text.map((binding) => ({
      slot: binding.slot,
      conversationIdSha256: sha256(binding.conversation.id),
      messageIdSha256: sha256(binding.message.id),
      messageContentSha256: sha256(binding.message.content),
      currentTaskIdSha256: binding.conversation.upstreamTaskId
        ? sha256(binding.conversation.upstreamTaskId)
        : null,
      currentPreviousResponseIdSha256: binding.conversation.previousResponseId
        ? sha256(binding.conversation.previousResponseId)
        : null,
    })),
    image: {
      assetIdSha256: sha256(input.image.asset.id),
      assetContentSha256: input.image.asset.contentSha256,
      assetBytes: input.image.asset.sizeBytes,
      leaseIdSha256: sha256(input.image.lease.id),
      providerFileIdSha256: sha256(input.image.lease.providerFileId!),
      artifactIdSha256: sha256(input.image.artifact.id),
      artifactContentSha256: input.image.artifact.contentSha256,
      artifactBytes: input.image.artifact.sizeBytes,
      recoveredConversationIdSha256: sha256(input.image.conversationPublicId),
    },
    recovery: {
      existingTurnIdsSha256: [...input.existingTurnIds].sort().map(sha256),
      recoveredImageConversationExists: input.recoveredImageConversationExists,
      projectedAssistantMessages: input.projectedAssistantMessages,
      verification: input.verification,
    },
  };
}

/**
 * Cheap restart guard. It is deliberately conservative: only the complete,
 * deterministic local projection is accepted. Any absence or ambiguity falls
 * through to the state-bound Provider preview; no credential is decrypted and
 * no Provider request is made here.
 */
export async function isGeneralChatIncidentRepairLocallyComplete(
  dependencies: Pick<Dependencies, "getDatabase"> = {},
) {
  try {
    const db = await requireDb(dependencies);
    const slots = ["text1020", "image1022", "text1027"] as const;
    const operationRows = await Promise.all(
      slots.map((slot) => loadOperationRow(db, slot)),
    );
    const userId = operationRows[0]!.operation.accountUserId;
    if (
      !userId ||
      operationRows.some((row) => row.operation.accountUserId !== userId)
    ) {
      return false;
    }
    const taskIds = operationRows.map((row) => row.task.id);
    const incidentTurnIds = operationRows.map((row) =>
      deterministicIncidentUuid(`turn:${row.operation.id}`),
    );
    const turnRows = await db
      .select()
      .from(conversationTurns)
      .where(inArray(conversationTurns.id, incidentTurnIds));
    if (turnRows.length !== 3) return false;
    const turns = new Map<
      GeneralChatIncidentSlot,
      typeof conversationTurns.$inferSelect
    >();
    for (const [index, slot] of slots.entries()) {
      const row = operationRows[index]!;
      const turn = turnRows.find(
        (candidate) => candidate.id === incidentTurnIds[index],
      );
      const metadata = turn?.metadata ?? {};
      const watermark = Array.isArray(metadata.providerEventWatermark)
        ? metadata.providerEventWatermark.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      if (
        !turn ||
        turn.userId !== userId ||
        turn.apiCredentialId !== row.operation.apiCredentialId ||
        turn.operationType !== GENERAL_CHAT_TURN_TYPE ||
        turn.upstreamTaskId !== row.task.id ||
        turn.status !== "completed" ||
        turn.buildId !== null ||
        turn.buildGeneration !== null ||
        turn.expectedRevision !== null ||
        turn.expectedLeafId !== null ||
        turn.leaseExpiresAt !== null ||
        turn.errorMessage !== null ||
        metadata.incidentRecovery !== GENERAL_CHAT_INCIDENT_REPAIR_ID ||
        metadata.sequenceFinalized !== true ||
        metadata.agentTaskId !== row.task.id ||
        metadata.operationId !== row.operation.id ||
        metadata.userMessageId !== turn.clientRequestId ||
        new Set(watermark).size !== watermark.length ||
        watermark.length !==
          GENERAL_CHAT_INCIDENT_WINDOWS[slot].providerAssistantMessages
      ) {
        return false;
      }
      turns.set(slot, turn);
    }
    const text1020 = turns.get("text1020")!;
    const image1022 = turns.get("image1022")!;
    const text1027 = turns.get("text1027")!;
    const imageConversationPublicId = recoveredImageConversationPublicId(
      operationRows[1]!.task.id,
    );
    const imageConversationId = persistedIdForManagedUser({
      userId,
      publicId: imageConversationPublicId,
    });
    if (
      text1020.conversationId !== text1027.conversationId ||
      image1022.conversationId !== imageConversationId ||
      image1022.clientRequestId !==
        recoveredImageMessagePublicId(operationRows[1]!.task.id) ||
      text1020.conversationId === imageConversationId
    ) {
      return false;
    }
    const conversationRows = await db
      .select()
      .from(conversations)
      .where(
        inArray(conversations.id, [
          text1020.conversationId,
          imageConversationId,
        ]),
      );
    if (conversationRows.length !== 2) return false;
    const latestText = operationRows[2]!;
    const textConversation = conversationRows.find(
      (row) => row.id === text1020.conversationId,
    );
    const imageConversation = conversationRows.find(
      (row) => row.id === imageConversationId,
    );
    if (
      !textConversation ||
      !imageConversation ||
      textConversation.userId !== userId ||
      imageConversation.userId !== userId ||
      textConversation.projectAssignmentId !== null ||
      imageConversation.projectAssignmentId !== null ||
      textConversation.upstreamTaskId !== latestText.task.id ||
      textConversation.previousResponseId !== latestText.task.id ||
      imageConversation.upstreamTaskId !== operationRows[1]!.task.id ||
      imageConversation.previousResponseId !== operationRows[1]!.task.id ||
      textConversation.deletedAt !== null ||
      imageConversation.deletedAt !== null
    ) {
      return false;
    }
    const targetTurns = [text1020, image1022, text1027];
    const userMessageIds = targetTurns.map((turn) =>
      persistedIdForManagedUser({
        userId,
        publicId: turn.clientRequestId,
      }),
    );
    const userRows = await db
      .select()
      .from(messages)
      .where(inArray(messages.id, userMessageIds));
    if (userRows.length !== 3) return false;
    for (const [index, turn] of targetTurns.entries()) {
      const operation = operationRows[index]!.operation;
      const messageRow: Message | undefined = userRows.find(
        (candidate) =>
          candidate.id ===
          persistedIdForManagedUser({
            userId,
            publicId: turn.clientRequestId,
          }),
      );
      const conversationPublicId = publicIdFromPersistedId({
        userId,
        persistedId: turn.conversationId,
      });
      const localAssetIds = sortedUnique(turn.attachmentFileIds);
      if (
        !messageRow ||
        messageRow.turnId !== turn.id ||
        messageRow.conversationId !== turn.conversationId ||
        messageRow.userId !== userId ||
        messageRow.role !== "user" ||
        messageRow.deletedAt !== null ||
        stripFrontMindGeneralChatOperationContract(messageRow.content) !==
          messageRow.content ||
        sha256(messageRow.content) !== turn.metadata.promptSha256 ||
        sha256(`${userId}\0${turn.clientRequestId}`) !==
          operation.idempotencyKeyHash ||
        requestHash({
          conversationId: conversationPublicId,
          prompt: messageRow.content,
          localAssetIds,
          modelProfile: operation.publicProfile,
        }) !== operation.requestHash ||
        turn.operationKey !==
          generalChatTurnOperationKey({
            userId,
            conversationPublicId,
            clientRequestId: turn.clientRequestId,
          }) ||
        turn.upstreamIdempotencyKeyHash !== sha256(turn.operationKey!)
      ) {
        return false;
      }
    }
    if (
      text1020.attachmentFileIds.length !== 0 ||
      text1027.attachmentFileIds.length !== 0 ||
      image1022.attachmentFileIds.length !== 1
    ) {
      return false;
    }
    const localAsset = (
      await db
        .select()
        .from(localAssets)
        .where(eq(localAssets.id, image1022.attachmentFileIds[0]!))
        .limit(1)
    )[0];
    const providerFileIds = Array.isArray(
      image1022.metadata.providerAttachmentFileIds,
    )
      ? image1022.metadata.providerAttachmentFileIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const leaseRows = await db
      .select()
      .from(providerFileLeases)
      .where(
        eq(providerFileLeases.localAssetId, image1022.attachmentFileIds[0]!),
      );
    const lease = leaseRows.filter(
      (row) =>
        row.apiCredentialId === operationRows[1]!.operation.apiCredentialId &&
        row.credentialVersion ===
          operationRows[1]!.operation.credentialVersion &&
        row.providerFileId === providerFileIds[0],
    );
    if (
      !localAsset ||
      localAsset.scope !== "managed_user" ||
      localAsset.accountUserId !== userId ||
      localAsset.mimeType !== "image/png" ||
      localAsset.sizeBytes !== EXPECTED_INPUT_IMAGE_BYTES ||
      !localAsset.retainUntil ||
      localAsset.retainUntil.getTime() <= Date.now() ||
      localAsset.retainUntil < MINIMUM_INPUT_IMAGE_RETAIN_UNTIL ||
      providerFileIds.length !== 1 ||
      lease.length !== 1 ||
      lease[0]!.uploadState !== "uploaded"
    ) {
      return false;
    }
    const storedInput = await readStoredPresalesFile(localAsset.id);
    if (
      !storedInput ||
      storedInput.sizeBytes !== localAsset.sizeBytes ||
      storedInput.sha256 !== localAsset.contentSha256
    ) {
      return false;
    }
    const imageMessageId = userMessageIds[1]!;
    const imageAttachmentId = persistedIdForManagedUser({
      userId,
      publicId: recoveredImageAttachmentPublicId(operationRows[1]!.task.id),
    });
    const attachmentRows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, imageAttachmentId));
    if (
      attachmentRows.length !== 1 ||
      attachmentRows[0]!.userId !== userId ||
      attachmentRows[0]!.conversationId !== imageConversationId ||
      attachmentRows[0]!.messageId !== imageMessageId ||
      attachmentRows[0]!.kind !== "image" ||
      attachmentRows[0]!.upstreamFileId !== image1022.attachmentFileIds[0] ||
      attachmentRows[0]!.deletedAt !== null
    ) {
      return false;
    }
    const expectedAssistantRows = targetTurns.flatMap((turn, index) => {
      const taskId = operationRows[index]!.task.id;
      return (turn.metadata.providerEventWatermark as string[]).map(
        (providerEventId) => ({
          taskId,
          turn,
          providerEventId,
          id: persistedIdForManagedUser({
            userId,
            publicId: projectionMessagePublicId(taskId, providerEventId),
          }),
        }),
      );
    });
    const cachedAssistantEvents = await db
      .select()
      .from(agentEvents)
      .where(inArray(agentEvents.taskId, taskIds));
    const assistantRows = await db
      .select()
      .from(messages)
      .where(
        and(
          inArray(
            messages.turnId,
            targetTurns.map((turn) => turn.id),
          ),
          eq(messages.role, "assistant"),
        ),
      );
    if (assistantRows.length !== 5) return false;
    for (const expected of expectedAssistantRows) {
      const row = assistantRows.find(
        (candidate) => candidate.id === expected.id,
      );
      const cached = cachedAssistantEvents.filter(
        (candidate) =>
          candidate.taskId === expected.taskId &&
          candidate.providerEventId === expected.providerEventId &&
          candidate.eventType === "assistant_message" &&
          candidate.normalizedPayload?.kind === "provider_event",
      );
      const generalChat =
        row?.metadata?.generalChat &&
        typeof row.metadata.generalChat === "object" &&
        !Array.isArray(row.metadata.generalChat)
          ? (row.metadata.generalChat as Record<string, unknown>)
          : null;
      if (
        !row ||
        row.conversationId !== expected.turn.conversationId ||
        row.turnId !== expected.turn.id ||
        row.userId !== userId ||
        row.role !== "assistant" ||
        row.deletedAt !== null ||
        cached.length !== 1 ||
        row.metadata?.upstreamOutputId !== cached[0]!.id ||
        stripFrontMindGeneralChatOperationContract(row.content) !==
          row.content ||
        generalChat?.schemaVersion !== 1 ||
        generalChat.kind !== "assistant_projection" ||
        generalChat.turnId !== expected.turn.id ||
        generalChat.agentTaskId !== expected.taskId ||
        generalChat.providerEventId !== expected.providerEventId ||
        generalChat.serverOwned !== true
      ) {
        return false;
      }
    }
    const allConversationMessages = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        sequence: messages.sequence,
      })
      .from(messages)
      .where(
        inArray(messages.conversationId, [
          text1020.conversationId,
          imageConversationId,
        ]),
      )
      .orderBy(asc(messages.conversationId), asc(messages.sequence));
    for (const conversationId of [
      text1020.conversationId,
      imageConversationId,
    ]) {
      const rows = allConversationMessages.filter(
        (row) => row.conversationId === conversationId,
      );
      if (rows.some((row, index) => row.sequence !== index)) return false;
    }
    const artifactRows = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.operationId, operationRows[1]!.operation.id),
          eq(artifacts.taskId, operationRows[1]!.task.id),
          eq(artifacts.validationState, "valid"),
          eq(artifacts.mimeType, "image/png"),
          eq(artifacts.sizeBytes, EXPECTED_OUTPUT_IMAGE_BYTES),
        ),
      );
    if (artifactRows.length !== 1) return false;
    const storedOutput = await readStoredPresalesFile(artifactRows[0]!.id);
    if (
      !storedOutput ||
      storedOutput.sizeBytes !== artifactRows[0]!.sizeBytes ||
      storedOutput.sha256 !== artifactRows[0]!.contentSha256
    ) {
      return false;
    }
    const artifactUrl = `/api/frontmind/v2/artifacts/${encodeURIComponent(
      artifactRows[0]!.id,
    )}/content`;
    const artifactLinks = assistantRows.reduce((count, row) => {
      const inlineImages = Array.isArray(row.metadata?.inlineImages)
        ? row.metadata.inlineImages
        : [];
      return (
        count + inlineImages.filter((item) => item?.src === artifactUrl).length
      );
    }, 0);
    return artifactLinks === 1;
  } catch {
    return false;
  }
}

export async function inspectGeneralChatIncidentRepair(
  dependencies: Dependencies = {},
): Promise<GeneralChatIncidentRepairFacts> {
  const db = await requireDb(dependencies);
  const slots = ["text1020", "image1022", "text1027"] as const;
  const rows = await Promise.all(
    slots.map((slot) => loadOperationRow(db, slot)),
  );
  const userIds = new Set(rows.map(({ operation }) => operation.accountUserId));
  if (userIds.size !== 1) fail("ACCOUNT_NOT_UNIQUE");
  const userId = rows[0]!.operation.accountUserId!;
  const account = requireExactlyOne(
    await db
      .select({
        id: users.id,
        role: users.role,
        adminAccessLevel: users.adminAccessLevel,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, userId)),
    "ACCOUNT_NOT_FOUND",
  );
  if (
    account.role !== "admin" ||
    account.adminAccessLevel !== "delivery_admin" ||
    !account.isActive
  ) {
    fail("ACCOUNT_SCOPE_MISMATCH");
  }
  const facts = await Promise.all(
    rows.map(({ operation, task }, index) =>
      loadOperationFact({
        db,
        slot: slots[index]!,
        operation,
        task,
        dependencies,
      }),
    ),
  );
  const text1020 = await loadTextBinding({
    db,
    fact: facts[0]!,
    slot: "text1020",
  });
  const image1022 = await loadImageBinding({
    db,
    fact: facts[1]!,
    dependencies,
  });
  const text1027 = await loadTextBinding({
    db,
    fact: facts[2]!,
    slot: "text1027",
  });
  if (text1020.conversation.id !== text1027.conversation.id) {
    fail("TEXT_CONVERSATION_MISMATCH");
  }
  const persistence = await inspectRecoveryPersistence({
    db,
    userId,
    text: [text1020, text1027],
    image: image1022,
  });
  const expectedAssistantMessages = facts.reduce(
    (sum, fact) => sum + fact.expectedAssistantEventIds.length,
    0,
  );
  const state = incidentState({
    userId,
    text: [text1020, text1027],
    image: image1022,
    projectedAssistantMessages: persistence.projectedAssistantMessages,
    existingTurnIds: persistence.existingTurnIds,
    recoveredImageConversationExists:
      persistence.recoveredImageConversationExists,
    verification: persistence.verification,
  });
  return {
    userId,
    text: [text1020, text1027],
    image: image1022,
    state,
    stateHash: generalChatIncidentStateHash(state),
    complete: persistence.complete,
    counts: {
      operations: 3,
      tasks: 3,
      conversations: 2,
      turns: 3,
      userMessages: 3,
      assistantMessages: expectedAssistantMessages,
      inputAttachments: 1,
      outputArtifacts: 1,
    },
  };
}

function turnInsert(input: {
  userId: number;
  conversationId: string;
  conversationPublicId: string;
  clientRequestId: string;
  fact: OperationFact;
  localAssetIds: readonly string[];
  sequenceFinalized?: boolean;
}) {
  const localAssetIds = sortedUnique(input.localAssetIds);
  const operationKey = generalChatTurnOperationKey({
    userId: input.userId,
    conversationPublicId: input.conversationPublicId,
    clientRequestId: input.clientRequestId,
  });
  const turnId = deterministicIncidentUuid(`turn:${input.fact.operation.id}`);
  const status = operationStatusToTurnStatus(input.fact.operation.status);
  return {
    id: turnId,
    conversationId: input.conversationId,
    userId: input.userId,
    apiCredentialId: input.fact.operation.apiCredentialId,
    clientRequestId: input.clientRequestId,
    operationKey,
    operationType: GENERAL_CHAT_TURN_TYPE,
    requestHash: requestHash({
      prompt: input.fact.prompt,
      localAssetIds,
    }),
    upstreamIdempotencyKeyHash: sha256(operationKey),
    attachmentFileIds: localAssetIds,
    metadata: {
      schemaVersion: 1,
      agentTaskId: input.fact.task.id,
      operationId: input.fact.operation.id,
      userMessageId: input.clientRequestId,
      promptSha256: sha256(input.fact.prompt),
      attachmentManifestHash: requestHash(localAssetIds),
      providerAttachmentFileIds: input.fact.providerAttachmentFileIds,
      providerEventWatermark: input.fact.expectedAssistantEventIds,
      incidentRecovery: GENERAL_CHAT_INCIDENT_REPAIR_ID,
      sequenceFinalized: input.sequenceFinalized ?? false,
    },
    model: input.fact.operation.upstreamModel,
    status,
    upstreamTaskId: input.fact.task.id,
    errorCode: input.fact.operation.errorCode,
    startedAt: input.fact.operation.createdAt,
    completedAt: status === "completed" ? input.fact.operation.updatedAt : null,
    createdAt: input.fact.operation.createdAt,
    updatedAt: input.fact.operation.updatedAt,
  } satisfies typeof conversationTurns.$inferInsert;
}

async function insertOrVerifyTurn(
  executor: any,
  value: typeof conversationTurns.$inferInsert,
) {
  const existing = (
    await executor
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, value.id))
      .limit(1)
      .for("update")
  )[0] as typeof conversationTurns.$inferSelect | undefined;
  if (existing) {
    const finalizedValue = {
      ...value,
      metadata: {
        ...(value.metadata ?? {}),
        sequenceFinalized: true,
      },
    };
    if (
      !turnMatchesExpected(existing, value) &&
      !turnMatchesExpected(existing, finalizedValue)
    ) {
      fail("TURN_IDEMPOTENCY_CONFLICT");
    }
    return existing.id;
  }
  await executor.insert(conversationTurns).values(value);
  return value.id!;
}

async function applyBindings(db: Db, facts: GeneralChatIncidentRepairFacts) {
  await db.transaction(async (tx) => {
    const textConversationId = facts.text[0].conversation.id;
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, textConversationId))
      .limit(1)
      .for("update");
    for (const binding of facts.text) {
      const turn = turnInsert({
        userId: facts.userId,
        conversationId: binding.conversation.id,
        conversationPublicId: binding.conversationPublicId,
        clientRequestId: binding.messagePublicId,
        fact: binding.fact,
        localAssetIds: [],
      });
      const turnId = await insertOrVerifyTurn(tx, turn);
      await tx
        .update(messages)
        .set({ turnId, content: binding.fact.prompt })
        .where(
          and(
            eq(messages.id, binding.message.id),
            eq(messages.conversationId, binding.conversation.id),
            eq(messages.userId, facts.userId),
            eq(messages.role, "user"),
          ),
        );
    }
    const latestText = [...facts.text].sort(
      (left, right) =>
        right.fact.operation.createdAt.getTime() -
        left.fact.operation.createdAt.getTime(),
    )[0]!;
    await tx
      .update(conversations)
      .set({
        apiCredentialId: latestText.fact.operation.apiCredentialId,
        upstreamTaskId: latestText.fact.task.id,
        previousResponseId: latestText.fact.task.id,
        status: operationStatusToConversationStatus(
          latestText.fact.operation.status,
        ),
        lastKnownOutputLength: latestText.fact.expectedAssistantEventIds.length,
        completedAt: latestText.fact.operation.updatedAt,
        updatedAt: latestText.fact.operation.updatedAt,
        version: sql`${conversations.version} + 1`,
      })
      .where(eq(conversations.id, textConversationId));

    const image = facts.image;
    const imageConversationId = persistedIdForManagedUser({
      userId: facts.userId,
      publicId: image.conversationPublicId,
    });
    const imageMessageId = persistedIdForManagedUser({
      userId: facts.userId,
      publicId: image.messagePublicId,
    });
    const imageAttachmentId = persistedIdForManagedUser({
      userId: facts.userId,
      publicId: image.attachmentPublicId,
    });
    const existingConversation = (
      await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, imageConversationId))
        .limit(1)
        .for("update")
    )[0] as Conversation | undefined;
    const title = recoveredImageTitle(image);
    if (!existingConversation) {
      await tx.insert(conversations).values({
        id: imageConversationId,
        userId: facts.userId,
        apiCredentialId: image.fact.operation.apiCredentialId,
        projectAssignmentId: null,
        title,
        status: operationStatusToConversationStatus(
          image.fact.operation.status,
        ),
        upstreamTaskId: image.fact.task.id,
        previousResponseId: image.fact.task.id,
        lastKnownOutputLength: image.fact.expectedAssistantEventIds.length,
        version: 1,
        startedAt: image.fact.operation.createdAt,
        completedAt: image.fact.operation.updatedAt,
        createdAt: eventTime(image.fact.createEvent),
        updatedAt: image.fact.operation.updatedAt,
      });
    } else if (
      existingConversation.userId !== facts.userId ||
      existingConversation.projectAssignmentId !== null ||
      (existingConversation.upstreamTaskId !== null &&
        existingConversation.upstreamTaskId !== image.fact.task.id)
    ) {
      fail("IMAGE_CONVERSATION_IDEMPOTENCY_CONFLICT");
    }
    const existingMessage = (
      await tx
        .select()
        .from(messages)
        .where(eq(messages.id, imageMessageId))
        .limit(1)
        .for("update")
    )[0] as Message | undefined;
    if (!existingMessage) {
      await tx.insert(messages).values({
        id: imageMessageId,
        conversationId: imageConversationId,
        userId: facts.userId,
        role: "user",
        content: image.fact.prompt,
        sequence: 0,
        metadata: {
          modelName: image.fact.operation.publicProfile,
          incidentRecovery: GENERAL_CHAT_INCIDENT_REPAIR_ID,
        },
        sentAt: eventTime(image.fact.createEvent),
        createdAt: eventTime(image.fact.createEvent),
      });
    } else if (
      existingMessage.conversationId !== imageConversationId ||
      existingMessage.userId !== facts.userId ||
      existingMessage.role !== "user" ||
      existingMessage.content !== image.fact.prompt
    ) {
      fail("IMAGE_MESSAGE_IDEMPOTENCY_CONFLICT");
    }
    const existingAttachment = (
      await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, imageAttachmentId))
        .limit(1)
        .for("update")
    )[0] as typeof attachments.$inferSelect | undefined;
    if (!existingAttachment) {
      await tx.insert(attachments).values({
        id: imageAttachmentId,
        userId: facts.userId,
        conversationId: imageConversationId,
        messageId: imageMessageId,
        apiCredentialId: image.fact.operation.apiCredentialId,
        kind: "image",
        fileName: image.asset.filename,
        mimeType: image.asset.mimeType,
        sizeBytes: image.asset.sizeBytes,
        upstreamFileId: image.asset.id,
      });
    } else if (
      existingAttachment.messageId !== imageMessageId ||
      existingAttachment.upstreamFileId !== image.asset.id
    ) {
      fail("IMAGE_ATTACHMENT_IDEMPOTENCY_CONFLICT");
    }
    const imageTurn = turnInsert({
      userId: facts.userId,
      conversationId: imageConversationId,
      conversationPublicId: image.conversationPublicId,
      clientRequestId: image.messagePublicId,
      fact: image.fact,
      localAssetIds: [image.asset.id],
    });
    const imageTurnId = await insertOrVerifyTurn(tx, imageTurn);
    await tx
      .update(messages)
      .set({ turnId: imageTurnId })
      .where(eq(messages.id, imageMessageId));
    await tx
      .update(conversations)
      .set({
        apiCredentialId: image.fact.operation.apiCredentialId,
        upstreamTaskId: image.fact.task.id,
        previousResponseId: image.fact.task.id,
        status: operationStatusToConversationStatus(
          image.fact.operation.status,
        ),
        lastKnownOutputLength: image.fact.expectedAssistantEventIds.length,
        completedAt: image.fact.operation.updatedAt,
        updatedAt: image.fact.operation.updatedAt,
        version: sql`${conversations.version} + 1`,
      })
      .where(eq(conversations.id, imageConversationId));
  });
}

export async function executeGeneralChatIncidentRepair(
  command: GeneralChatIncidentRepairCommand,
  dependencies: Dependencies = {},
) {
  return runStateBoundGeneralChatIncidentRepair(command, {
    inspect: () => inspectGeneralChatIncidentRepair(dependencies),
    apply: async (before) => {
      const db = await requireDb(dependencies);
      await applyBindings(db, before);
      if (!dependencies.syncTask) fail("SYNC_TASK_DEPENDENCY_MISSING");
      for (const fact of [
        ...before.text.map((item) => item.fact),
        before.image.fact,
      ]) {
        await dependencies.syncTask({
          userId: before.userId,
          localTaskId: fact.task.id,
          recoveryTurnId: deterministicIncidentUuid(
            `turn:${fact.operation.id}`,
          ),
          expectedProviderAssistantEventIds: fact.expectedAssistantEventIds,
        });
      }
      await resequenceIncidentConversations(db, before);
    },
  });
}
