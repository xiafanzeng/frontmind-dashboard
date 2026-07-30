import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  apiCredentials,
  attachments,
  conversations,
  knowledgeBaseBuilds,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetRequests,
  messages,
  upstreamResources,
  userUsageOwners,
  users,
  type MessageMetadata,
} from "../drizzle/schema";
import {
  type AuthenticatedUser,
  credentialMayServeAccount,
  getEffectiveDecryptedCredentialForAccount,
  isUpstreamApiKeyShared,
} from "./auth-service";
import { assertDeliveryProjectContext } from "./delivery-role-service";
import { getDb } from "./db";
import { protectedProcedure, router } from "./_core/trpc";
import { getUpstreamBaseUrl } from "./upstream-config";

const attachmentSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["file", "image"]),
  name: z.string().min(1).max(512),
  fileId: z.string().min(1).max(255).optional(),
});

const outputFileSchema = z.object({
  fileUrl: z.string().max(4096),
  fileName: z.string().max(512),
  mimeType: z.string().max(255),
});

const inlineImageSchema = z.object({
  src: z.string().max(4096),
  alt: z.string().max(512).optional(),
});

const messageSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2_000_000),
  attachments: z.array(attachmentSchema).max(100).optional(),
  timestamp: z.number().finite().nonnegative(),
  outputFiles: z.array(outputFileSchema).max(200).optional(),
  inlineImages: z.array(inlineImageSchema).max(200).optional(),
  elapsedTime: z.number().finite().nonnegative().optional(),
  responseStartedAt: z.number().finite().nonnegative().optional(),
  intermediateSteps: z.array(z.unknown()).max(2_000).optional(),
  stepGroups: z.array(z.unknown()).max(500).optional(),
  isStepsPlaceholder: z.boolean().optional(),
  modelName: z.string().max(128).optional(),
});

export const conversationSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(255),
  messages: z.array(messageSchema).max(5_000),
  taskId: z.string().max(255).optional(),
  previousResponseId: z.string().max(255).optional(),
  status: z.enum([
    "idle",
    "running",
    "pending",
    "awaiting_input",
    "completed",
    "error",
    "failed",
  ]),
  taskUrl: z.string().max(4096).optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  startedAt: z.number().finite().nonnegative().optional(),
  completedAt: z.number().finite().nonnegative().optional(),
  lastKnownOutputLength: z.number().int().nonnegative().optional(),
  deletedMessageIds: z.array(z.string().max(128)).max(5_000).optional(),
});

export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

type UpstreamResourceRef = { kind: "task" | "file"; id: string };
const LEGACY_IMPORT_MAX_RESOURCES = 200;
const LEGACY_IMPORT_VALIDATION_CONCURRENCY = 4;
const LEGACY_IMPORT_VALIDATION_TIMEOUT_MS = 30_000;

function upstreamResourceKey(kind: "task" | "file", id: string) {
  return JSON.stringify([kind, id]);
}

function snapshotTaskIds(snapshot: ConversationSnapshot) {
  return Array.from(
    new Set(
      [snapshot.taskId, snapshot.previousResponseId].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );
}

export function collectSnapshotResourceRefs(
  snapshots: ConversationSnapshot[],
): UpstreamResourceRef[] {
  const resources = new Map<string, UpstreamResourceRef>();
  const add = (kind: "task" | "file", id: string | undefined) => {
    if (!id) return;
    resources.set(upstreamResourceKey(kind, id), { kind, id });
    if (resources.size > LEGACY_IMPORT_MAX_RESOURCES) {
      throw new TRPCError({
        code: "PAYLOAD_TOO_LARGE",
        message: `单次最多迁移 ${LEGACY_IMPORT_MAX_RESOURCES} 个历史任务或文件`,
      });
    }
  };

  for (const snapshot of snapshots) {
    for (const taskId of snapshotTaskIds(snapshot)) add("task", taskId);
    for (const message of snapshot.messages) {
      for (const attachment of message.attachments ?? []) {
        add("file", attachment.fileId);
      }
    }
  }
  return Array.from(resources.values());
}

function conversationStoragePrefix(
  userId: number,
  projectAssignmentId: string | null,
) {
  return projectAssignmentId ? `p${projectAssignmentId}:` : `u${userId}:`;
}

function storageId(
  userId: number,
  publicId: string,
  projectAssignmentId: string | null = null,
) {
  return `${conversationStoragePrefix(userId, projectAssignmentId)}${publicId}`;
}

function publicId(
  userId: number,
  persistedId: string,
  projectAssignmentId: string | null = null,
) {
  const prefix = conversationStoragePrefix(userId, projectAssignmentId);
  return persistedId.startsWith(prefix)
    ? persistedId.slice(prefix.length)
    : persistedId;
}

async function resolveConversationProjectAssignment(
  user: AuthenticatedUser,
  projectAssignmentId: string | undefined,
) {
  if (user.role !== "delivery_member") {
    if (projectAssignmentId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "当前账号不能使用工程师项目上下文",
      });
    }
    return null;
  }
  if (!projectAssignmentId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "请先选择当前客户项目",
    });
  }
  try {
    await assertDeliveryProjectContext({
      actor: user,
      projectAssignmentId,
    });
  } catch {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "当前客户项目岗位不存在或已停用",
    });
  }
  return projectAssignmentId;
}

function asDate(value: number | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requireDb(db: Awaited<ReturnType<typeof getDb>>) {
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "数据库暂不可用",
    });
  }
  return db;
}

/**
 * Permanently removes a conversation. Foreign keys cascade to its turns,
 * messages, and attachments. Upstream ownership ledger rows deliberately
 * remain and only lose their conversation link.
 */
export async function permanentlyDeleteConversation(
  executor: any,
  userId: number,
  persistedConversationId: string,
  projectAssignmentId: string | null = null,
) {
  await executor
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, persistedConversationId),
        projectAssignmentId
          ? eq(conversations.projectAssignmentId, projectAssignmentId)
          : and(
              eq(conversations.userId, userId),
              isNull(conversations.projectAssignmentId),
            ),
      ),
    );
}

async function getLatestActiveCredentialIdForUser(
  executor: any,
  userId: number,
) {
  const rows = await executor
    .select({ id: apiCredentials.id })
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.userId, userId),
        eq(apiCredentials.status, "active"),
        isNull(apiCredentials.deletedAt),
      ),
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  return rows[0]?.id as string | undefined;
}

/**
 * Mirrors runtime credential selection: the account's own active credential
 * wins, and only legacy customer accounts without one inherit their current
 * delivery owner's credential.
 */
export async function getActiveCredentialId(executor: any, userId: number) {
  const accountRows = await executor
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!accountRows[0]) return undefined;

  const directCredentialId = await getLatestActiveCredentialIdForUser(
    executor,
    userId,
  );
  if (directCredentialId || accountRows[0].role === "admin") {
    return directCredentialId;
  }

  const ownerRows = await executor
    .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
    .from(userUsageOwners)
    .where(eq(userUsageOwners.userId, userId))
    .limit(1);
  const ownerId = ownerRows[0]?.deliveryAdminId;
  return ownerId
    ? getLatestActiveCredentialIdForUser(executor, ownerId)
    : undefined;
}

async function assertResourceOwnership(
  executor: any,
  userId: number,
  projectAssignmentId: string | null,
  kind: "task" | "file",
  upstreamId: string,
) {
  const rows = await executor
    .select({
      userId: upstreamResources.userId,
      projectAssignmentId: upstreamResources.projectAssignmentId,
      apiCredentialId: upstreamResources.apiCredentialId,
    })
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, kind),
        eq(upstreamResources.upstreamId, upstreamId),
      ),
    )
    .limit(1);
  const owned = projectAssignmentId
    ? rows[0]?.projectAssignmentId === projectAssignmentId
    : rows[0]?.userId === userId && rows[0]?.projectAssignmentId == null;
  if (rows[0] && !owned) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "上游资源不属于当前账号",
    });
  }
  return rows[0] ?? null;
}

type SnapshotResourceBinding = {
  kind: "task" | "file";
  upstreamId: string;
  apiCredentialId: string;
  projectAssignmentId: string | null;
  createdAt?: Date;
};

async function loadSnapshotResourceBindings(
  executor: any,
  userId: number,
  projectAssignmentId: string | null,
  snapshot: ConversationSnapshot,
) {
  const bindings = new Map<string, SnapshotResourceBinding>();
  const taskIds = snapshotTaskIds(snapshot);
  const fileIds = Array.from(
    new Set(
      snapshot.messages.flatMap((message) =>
        (message.attachments ?? [])
          .map((attachment) => attachment.fileId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  );

  for (const [kind, ids] of [
    ["task", taskIds],
    ["file", fileIds],
  ] as const) {
    if (ids.length === 0) continue;
    const rows = await executor
      .select({
        userId: upstreamResources.userId,
        projectAssignmentId: upstreamResources.projectAssignmentId,
        kind: upstreamResources.kind,
        upstreamId: upstreamResources.upstreamId,
        apiCredentialId: upstreamResources.apiCredentialId,
        createdAt: upstreamResources.createdAt,
      })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, kind),
          inArray(upstreamResources.upstreamId, ids),
        ),
      );
    for (const row of rows) {
      const owned = projectAssignmentId
        ? row.projectAssignmentId === projectAssignmentId
        : row.userId === userId && row.projectAssignmentId == null;
      if (!owned) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "上游资源不属于当前账号",
        });
      }
      bindings.set(upstreamResourceKey(kind, row.upstreamId), {
        kind,
        upstreamId: row.upstreamId,
        apiCredentialId: row.apiCredentialId,
        projectAssignmentId: row.projectAssignmentId,
        createdAt: row.createdAt,
      });
    }
  }

  return bindings;
}

async function credentialIsAvailable(executor: any, credentialId: string) {
  const rows = await executor
    .select({ status: apiCredentials.status })
    .from(apiCredentials)
    .where(eq(apiCredentials.id, credentialId))
    .limit(1);
  return Boolean(rows[0] && rows[0].status !== "deleted");
}

/**
 * Existing upstream resources retain the credential version that created
 * them. This remains authoritative across key rotation or delivery-owner
 * reassignment, while brand-new conversations use the current runtime choice.
 */
export async function resolveSnapshotCredentialId(
  executor: any,
  userId: number,
  snapshot: ConversationSnapshot,
  options: {
    existingCredentialId?: string | null;
    importCredentialId?: string;
    projectAssignmentId?: string | null;
  } = {},
) {
  const projectAssignmentId = options.projectAssignmentId ?? null;
  const bindings = await loadSnapshotResourceBindings(
    executor,
    userId,
    projectAssignmentId,
    snapshot,
  );
  const primaryTaskId = snapshot.taskId ?? snapshot.previousResponseId;
  const taskBinding = primaryTaskId
    ? bindings.get(upstreamResourceKey("task", primaryTaskId))
    : undefined;
  const firstFileBinding = Array.from(bindings.values()).find(
    (binding) => binding.kind === "file",
  );
  const resourceCredentialId =
    taskBinding?.apiCredentialId ??
    (!primaryTaskId ? firstFileBinding?.apiCredentialId : undefined);
  const credentialId =
    resourceCredentialId ??
    options.existingCredentialId ??
    options.importCredentialId ??
    (await getActiveCredentialId(executor, userId));

  const hasUpstreamResources =
    snapshotTaskIds(snapshot).length > 0 ||
    snapshot.messages.some((message) =>
      message.attachments?.some((attachment) => Boolean(attachment.fileId)),
    );
  if (hasUpstreamResources && !credentialId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "请先迁移或配置该会话原来使用的 API Key，再导入历史会话",
    });
  }

  if (hasUpstreamResources && credentialId) {
    const isBoundToOwnedResource = Array.from(bindings.values()).some(
      (binding) => binding.apiCredentialId === credentialId,
    );
    const mayServe =
      (isBoundToOwnedResource &&
        (await credentialIsAvailable(executor, credentialId))) ||
      (await credentialMayServeAccount(executor, userId, credentialId));
    if (!mayServe) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "该会话原来使用的 API Key 已不可用",
      });
    }
  }

  return { credentialId, bindings };
}

type TaskPointerPair = {
  taskId?: string;
  previousResponseId?: string;
};

type TaskPointerMergeInput = {
  existing: TaskPointerPair;
  incoming: TaskPointerPair;
  persistedMessages: ConversationSnapshot["messages"];
  incomingMessages: ConversationSnapshot["messages"];
  resourceCreatedAt: ReadonlyMap<string, number>;
  existingUpdatedAt: number;
  incomingUpdatedAt: number;
};

function primaryTaskPointer(pair: TaskPointerPair) {
  return pair.taskId ?? pair.previousResponseId;
}

function normalizedTaskPointerPair(
  pair: TaskPointerPair,
  fallback: TaskPointerPair,
): TaskPointerPair {
  const primary = primaryTaskPointer(pair) ?? primaryTaskPointer(fallback);
  if (!primary) return {};
  return {
    taskId: pair.taskId ?? fallback.taskId ?? primary,
    previousResponseId:
      pair.previousResponseId ?? fallback.previousResponseId ?? primary,
  };
}

/**
 * Keeps the task pointer monotonic while leaving message merging independent.
 * Server-created task ledger timestamps are the strongest ordering signal.
 * When two resources share MySQL's one-second timestamp precision, user-turn
 * membership and the snapshot timestamps resolve the boundary.
 */
export function mergeConversationTaskPointers(
  input: TaskPointerMergeInput,
): TaskPointerPair {
  const existingPrimary = primaryTaskPointer(input.existing);
  const incomingPrimary = primaryTaskPointer(input.incoming);
  if (!incomingPrimary) return normalizedTaskPointerPair(input.existing, {});
  if (!existingPrimary) return normalizedTaskPointerPair(input.incoming, {});
  if (incomingPrimary === existingPrimary) {
    return normalizedTaskPointerPair(input.incoming, input.existing);
  }

  const existingCreatedAt = input.resourceCreatedAt.get(existingPrimary);
  const incomingCreatedAt = input.resourceCreatedAt.get(incomingPrimary);
  if (
    existingCreatedAt !== undefined &&
    incomingCreatedAt !== undefined &&
    incomingCreatedAt !== existingCreatedAt
  ) {
    return incomingCreatedAt > existingCreatedAt
      ? normalizedTaskPointerPair(input.incoming, input.existing)
      : normalizedTaskPointerPair(input.existing, {});
  }
  if (existingCreatedAt !== undefined && incomingCreatedAt === undefined) {
    return normalizedTaskPointerPair(input.existing, {});
  }

  const persistedUserIds = new Set(
    input.persistedMessages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  );
  const incomingUserIds = new Set(
    input.incomingMessages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  );
  const hasNewIncomingTurn = Array.from(incomingUserIds).some(
    (id) => !persistedUserIds.has(id),
  );
  if (hasNewIncomingTurn) {
    return normalizedTaskPointerPair(input.incoming, input.existing);
  }
  const isMissingPersistedTurn = Array.from(persistedUserIds).some(
    (id) => !incomingUserIds.has(id),
  );
  if (isMissingPersistedTurn) {
    return normalizedTaskPointerPair(input.existing, {});
  }

  return input.incomingUpdatedAt > input.existingUpdatedAt
    ? normalizedTaskPointerPair(input.incoming, input.existing)
    : normalizedTaskPointerPair(input.existing, {});
}

async function resolveTaskPointersForSnapshot(
  executor: any,
  userId: number,
  projectAssignmentId: string | null,
  existing: {
    upstreamTaskId: string | null;
    previousResponseId: string | null;
    updatedAt: Date;
  },
  persistedMessages: ConversationSnapshot["messages"],
  snapshot: ConversationSnapshot,
) {
  const taskIds = Array.from(
    new Set(
      [
        existing.upstreamTaskId,
        existing.previousResponseId,
        snapshot.taskId,
        snapshot.previousResponseId,
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const resourceCreatedAt = new Map<string, number>();
  if (taskIds.length > 0) {
    const rows = await executor
      .select({
        userId: upstreamResources.userId,
        projectAssignmentId: upstreamResources.projectAssignmentId,
        upstreamId: upstreamResources.upstreamId,
        createdAt: upstreamResources.createdAt,
      })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, "task"),
          inArray(upstreamResources.upstreamId, taskIds),
        ),
      );
    for (const row of rows) {
      const owned = projectAssignmentId
        ? row.projectAssignmentId === projectAssignmentId
        : row.userId === userId && row.projectAssignmentId == null;
      if (!owned) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "上游资源不属于当前账号",
        });
      }
      resourceCreatedAt.set(row.upstreamId, row.createdAt.getTime());
    }
  }

  return mergeConversationTaskPointers({
    existing: {
      taskId: existing.upstreamTaskId ?? undefined,
      previousResponseId: existing.previousResponseId ?? undefined,
    },
    incoming: {
      taskId: snapshot.taskId,
      previousResponseId: snapshot.previousResponseId,
    },
    persistedMessages,
    incomingMessages: snapshot.messages,
    resourceCreatedAt,
    existingUpdatedAt: existing.updatedAt.getTime(),
    incomingUpdatedAt: snapshot.updatedAt,
  });
}

/**
 * A client-supplied legacy ID is not ownership proof. Before writing a new
 * ledger row, verify that the credential selected for this conversation can
 * actually read the resource from the upstream API.
 */
export async function validateUpstreamResourceAccess(
  apiKey: string,
  kind: "task" | "file",
  upstreamId: string,
  request: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(15_000),
) {
  let response: Response;
  try {
    const collection = kind === "task" ? "tasks" : "files";
    response = await request(
      `${getUpstreamBaseUrl()}/v1/${collection}/${encodeURIComponent(upstreamId)}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal,
      },
    );
  } catch {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "上游服务暂时不可用，无法验证历史任务或文件归属",
    });
  }

  const { ok, status } = response;
  await response.body?.cancel().catch(() => undefined);
  if (status === 401 || status === 403 || status === 404) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "当前 API Key 无法访问该历史任务或文件",
    });
  }
  if (!ok) {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "上游服务暂时无法验证历史任务或文件归属",
    });
  }
}

async function persistResource(
  executor: any,
  input: {
    userId: number;
    apiCredentialId: string;
    projectAssignmentId: string | null;
    kind: "task" | "file";
    upstreamId: string;
    conversationId: string;
  },
  validatedResourceKeys?: ReadonlySet<string>,
) {
  const existing = await assertResourceOwnership(
    executor,
    input.userId,
    input.projectAssignmentId,
    input.kind,
    input.upstreamId,
  );
  if (existing) return;
  if (
    !validatedResourceKeys?.has(
      upstreamResourceKey(input.kind, input.upstreamId),
    )
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "历史任务或文件尚未验证，请通过本地记录迁移入口导入",
    });
  }
  await executor
    .insert(upstreamResources)
    .values({
      id: randomUUID(),
      userId: input.userId,
      apiCredentialId: input.apiCredentialId,
      projectAssignmentId: input.projectAssignmentId,
      kind: input.kind,
      upstreamId: input.upstreamId,
      conversationId: input.conversationId,
    })
    .onDuplicateKeyUpdate({
      // Never mutate an existing owner's row on a duplicate-key race.
      set: { upstreamId: input.upstreamId },
    });
  await assertResourceOwnership(
    executor,
    input.userId,
    input.projectAssignmentId,
    input.kind,
    input.upstreamId,
  );
}

function buildMessageMetadata(
  message: z.infer<typeof messageSchema>,
): MessageMetadata | null {
  const metadata: MessageMetadata = {};
  if (message.outputFiles) metadata.outputFiles = message.outputFiles;
  if (message.inlineImages) metadata.inlineImages = message.inlineImages;
  if (message.elapsedTime !== undefined)
    metadata.elapsedTime = message.elapsedTime;
  if (message.responseStartedAt !== undefined) {
    metadata.responseStartedAt = message.responseStartedAt;
  }
  if (message.intermediateSteps)
    metadata.intermediateSteps = message.intermediateSteps;
  if (message.stepGroups) metadata.stepGroups = message.stepGroups;
  if (message.isStepsPlaceholder !== undefined) {
    metadata.isStepsPlaceholder = message.isStepsPlaceholder;
  }
  if (message.modelName) metadata.modelName = message.modelName;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

async function loadPersistedMessages(
  executor: any,
  userId: number,
  conversationId: string,
  projectAssignmentId: string | null,
): Promise<ConversationSnapshot["messages"]> {
  const messageRows = await executor
    .select()
    .from(messages)
    .where(
      and(
        projectAssignmentId ? undefined : eq(messages.userId, userId),
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.sequence));
  const messageIds = messageRows.map((row: { id: string }) => row.id);
  const attachmentRows =
    messageIds.length === 0
      ? []
      : await executor
          .select()
          .from(attachments)
          .where(
            and(
              projectAssignmentId ? undefined : eq(attachments.userId, userId),
              inArray(attachments.messageId, messageIds),
              isNull(attachments.deletedAt),
            ),
          );
  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }

  return messageRows.map((message: typeof messages.$inferSelect) => {
    const metadata = (message.metadata ?? {}) as MessageMetadata;
    return {
      id: publicId(userId, message.id, projectAssignmentId),
      role:
        message.role === "assistant"
          ? ("assistant" as const)
          : ("user" as const),
      content: message.content,
      timestamp: message.sentAt.getTime(),
      attachments: (attachmentsByMessage.get(message.id) ?? []).map(
        (attachment: typeof attachments.$inferSelect) => ({
          id: publicId(userId, attachment.id, projectAssignmentId),
          type: attachment.kind,
          name: attachment.fileName,
          ...(attachment.upstreamFileId
            ? { fileId: attachment.upstreamFileId }
            : {}),
        }),
      ),
      ...(metadata.outputFiles ? { outputFiles: metadata.outputFiles } : {}),
      ...(metadata.inlineImages ? { inlineImages: metadata.inlineImages } : {}),
      ...(metadata.elapsedTime !== undefined
        ? { elapsedTime: metadata.elapsedTime }
        : {}),
      ...(metadata.responseStartedAt !== undefined
        ? { responseStartedAt: metadata.responseStartedAt }
        : {}),
      ...(metadata.intermediateSteps
        ? { intermediateSteps: metadata.intermediateSteps }
        : {}),
      ...(metadata.stepGroups ? { stepGroups: metadata.stepGroups } : {}),
      ...(metadata.isStepsPlaceholder !== undefined
        ? { isStepsPlaceholder: metadata.isStepsPlaceholder }
        : {}),
      ...(metadata.modelName ? { modelName: metadata.modelName } : {}),
    };
  });
}

type SnapshotMessage = ConversationSnapshot["messages"][number];
type MessageTurn = { user: SnapshotMessage; assistants: SnapshotMessage[] };

function splitMessageTurns(messagesToSplit: SnapshotMessage[]) {
  const prelude: SnapshotMessage[] = [];
  const turns: MessageTurn[] = [];
  let currentTurn: MessageTurn | null = null;
  for (const message of messagesToSplit) {
    if (message.role === "user") {
      currentTurn = { user: message, assistants: [] };
      turns.push(currentTurn);
    } else if (currentTurn) {
      currentTurn.assistants.push(message);
    } else {
      prelude.push(message);
    }
  }
  return { prelude, turns };
}

function assistantProjectionScore(projected: SnapshotMessage[]) {
  const hasConcreteResult = projected.some(
    (message) => !message.isStepsPlaceholder,
  );
  return projected.reduce(
    (score, message) => {
      if (message.isStepsPlaceholder) return score + 1;
      return (
        score +
        message.content.length +
        (message.outputFiles?.length ?? 0) * 10_000 +
        (message.inlineImages?.length ?? 0) * 10_000 +
        (message.stepGroups?.length ?? 0) * 1_000 +
        (message.intermediateSteps?.length ?? 0) * 100
      );
    },
    hasConcreteResult ? 1_000_000_000 : 0,
  );
}

/**
 * Merge by user turn rather than replacing an entire conversation snapshot.
 * The incoming assistant set is authoritative for a turn it knows about
 * (allowing polling placeholders to disappear), while turns created on
 * another device are retained. Explicit deletion tombstones win everywhere.
 */
export function mergeConversationMessages(
  persisted: SnapshotMessage[],
  incoming: SnapshotMessage[],
  deletedMessageIds: string[],
) {
  const deleted = new Set(deletedMessageIds);
  const persistedSplit = splitMessageTurns(persisted);
  const incomingSplit = splitMessageTurns(incoming);
  const prelude = new Map<string, SnapshotMessage>();
  for (const message of persistedSplit.prelude)
    prelude.set(message.id, message);
  for (const message of incomingSplit.prelude) prelude.set(message.id, message);

  const turns = new Map<string, MessageTurn>();
  for (const turn of persistedSplit.turns) turns.set(turn.user.id, turn);
  for (const turn of incomingSplit.turns) {
    const persistedTurn = turns.get(turn.user.id);
    if (!persistedTurn) {
      turns.set(turn.user.id, turn);
      continue;
    }
    // Polling projections only become richer (placeholder -> partial -> final).
    // A stale device changing an unrelated scalar must not regress a final
    // assistant result back to its older placeholder/partial projection.
    if (
      assistantProjectionScore(turn.assistants) >
      assistantProjectionScore(persistedTurn.assistants)
    ) {
      turns.set(turn.user.id, {
        user: persistedTurn.user,
        assistants: turn.assistants,
      });
    }
  }

  const mergedPrelude = Array.from(prelude.values())
    .filter((message) => !deleted.has(message.id))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.id.localeCompare(right.id),
    );
  const mergedTurns = Array.from(turns.values())
    .filter((turn) => !deleted.has(turn.user.id))
    .sort(
      (left, right) =>
        left.user.timestamp - right.user.timestamp ||
        left.user.id.localeCompare(right.user.id),
    );

  return [
    ...mergedPrelude,
    ...mergedTurns.flatMap((turn) => [
      turn.user,
      ...turn.assistants.filter((message) => !deleted.has(message.id)),
    ]),
  ];
}

async function persistSnapshot(
  executor: any,
  userId: number,
  snapshot: ConversationSnapshot,
  options: {
    skipExisting?: boolean;
    importCredentialId?: string;
    validatedResourceKeys?: ReadonlySet<string>;
    projectAssignmentId?: string | null;
  } = {},
): Promise<"imported" | "skipped" | "updated"> {
  const projectAssignmentId = options.projectAssignmentId ?? null;
  const lockedKnowledgeBuilds = await executor
    .select({ id: knowledgeBaseBuilds.id })
    .from(knowledgeBaseBuilds)
    .innerJoin(
      knowledgeBaseResetRequests,
      and(
        eq(knowledgeBaseResetRequests.userId, knowledgeBaseBuilds.userId),
        eq(knowledgeBaseResetRequests.status, "pending"),
      ),
    )
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, userId),
        eq(knowledgeBaseBuilds.conversationId, snapshot.id),
      ),
    )
    .limit(1)
    .for("update");
  if (lockedKnowledgeBuilds[0]) {
    if (options.skipExisting) return "skipped";
    throw new TRPCError({
      code: "CONFLICT",
      message: "知识库重置工单正在审批，当前会话已只读锁定",
    });
  }
  const tombstones = await executor
    .select({ id: knowledgeBaseConversationTombstones.id })
    .from(knowledgeBaseConversationTombstones)
    .where(
      and(
        eq(knowledgeBaseConversationTombstones.userId, userId),
        eq(
          knowledgeBaseConversationTombstones.publicConversationId,
          snapshot.id,
        ),
      ),
    )
    .limit(1)
    .for("update");
  if (tombstones[0]) {
    if (options.skipExisting) return "skipped";
    throw new TRPCError({
      code: "CONFLICT",
      message: "该知识库会话已被重置，不能从旧页面重新同步",
    });
  }
  const persistedConversationId = storageId(
    userId,
    snapshot.id,
    projectAssignmentId,
  );
  const existingRows = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.id, persistedConversationId))
    .limit(1)
    // Serialize whole-snapshot merges for this conversation. Without this
    // lock, two transactions can both merge from the same old message set and
    // the later delete/reinsert phase would erase the other device's new turn.
    .for("update");
  const existing = existingRows[0];

  const existingOwned = projectAssignmentId
    ? existing?.projectAssignmentId === projectAssignmentId
    : existing?.userId === userId && existing?.projectAssignmentId == null;
  if (existing && !existingOwned) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "会话 ID 已属于其他账号",
    });
  }
  if (existing?.deletedAt) {
    if (options.skipExisting) return "skipped";
    throw new TRPCError({ code: "NOT_FOUND", message: "会话已删除" });
  }
  if (existing && options.skipExisting) return "skipped";

  if (existing) {
    const deletedMessageIds = Array.from(
      new Set([
        ...existing.deletedMessageIds,
        ...(snapshot.deletedMessageIds ?? []),
      ]),
    );
    const persistedMessages = await loadPersistedMessages(
      executor,
      userId,
      persistedConversationId,
      projectAssignmentId,
    );
    const taskPointers = await resolveTaskPointersForSnapshot(
      executor,
      userId,
      projectAssignmentId,
      existing,
      persistedMessages,
      snapshot,
    );
    snapshot = {
      ...snapshot,
      messages: mergeConversationMessages(
        persistedMessages,
        snapshot.messages,
        deletedMessageIds,
      ),
      taskId: taskPointers.taskId,
      previousResponseId: taskPointers.previousResponseId,
      taskUrl: snapshot.taskUrl ?? existing.taskUrl ?? undefined,
      startedAt: snapshot.startedAt ?? existing.startedAt?.getTime(),
      completedAt: snapshot.completedAt ?? existing.completedAt?.getTime(),
      lastKnownOutputLength: Math.max(
        snapshot.lastKnownOutputLength ?? 0,
        existing.lastKnownOutputLength,
      ),
      deletedMessageIds,
      createdAt: existing.createdAt.getTime(),
      // Server arrival order determines scalar-field precedence; message turns
      // are merged above, so device clock skew cannot erase another turn.
      updatedAt: Date.now(),
    };
  }

  const { credentialId: resolvedCredentialId, bindings } =
    await resolveSnapshotCredentialId(executor, userId, snapshot, {
      existingCredentialId: existing?.apiCredentialId,
      importCredentialId: options.importCredentialId,
      projectAssignmentId,
    });
  const apiCredentialId = resolvedCredentialId ?? null;

  const conversationValues = {
    userId,
    apiCredentialId,
    projectAssignmentId,
    title: snapshot.title,
    status: snapshot.status,
    upstreamTaskId: snapshot.taskId ?? null,
    previousResponseId: snapshot.previousResponseId ?? null,
    taskUrl: snapshot.taskUrl ?? null,
    lastKnownOutputLength: snapshot.lastKnownOutputLength ?? 0,
    deletedMessageIds: snapshot.deletedMessageIds ?? [],
    startedAt: asDate(snapshot.startedAt),
    completedAt: asDate(snapshot.completedAt),
    createdAt: asDate(snapshot.createdAt) ?? new Date(),
    updatedAt: asDate(snapshot.updatedAt) ?? new Date(),
  };

  if (existing) {
    await executor
      .update(conversations)
      .set({ ...conversationValues, version: existing.version + 1 })
      .where(
        and(
          eq(conversations.id, persistedConversationId),
          projectAssignmentId
            ? eq(conversations.projectAssignmentId, projectAssignmentId)
            : and(
                eq(conversations.userId, userId),
                isNull(conversations.projectAssignmentId),
              ),
        ),
      );
  } else {
    await executor.insert(conversations).values({
      id: persistedConversationId,
      ...conversationValues,
      version: 1,
    });
  }

  const incomingMessageIds = snapshot.messages.map((message) =>
    storageId(userId, message.id, projectAssignmentId),
  );
  if (incomingMessageIds.length > 0) {
    const collisions = await executor
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        userId: messages.userId,
      })
      .from(messages)
      .where(inArray(messages.id, incomingMessageIds));
    if (
      collisions.some(
        (row: { conversationId: string; userId: number }) =>
          (!projectAssignmentId && row.userId !== userId) ||
          row.conversationId !== persistedConversationId,
      )
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "消息 ID 与其他会话冲突",
      });
    }
  }

  // A snapshot is authoritative for this conversation. Replacing children also
  // removes stale polling placeholders and preserves manual-delete tombstones on
  // the parent conversation.
  await executor
    .delete(messages)
    .where(eq(messages.conversationId, persistedConversationId));

  for (let sequence = 0; sequence < snapshot.messages.length; sequence += 1) {
    const message = snapshot.messages[sequence];
    const sentAt = asDate(message.timestamp) ?? new Date();
    await executor.insert(messages).values({
      id: storageId(userId, message.id, projectAssignmentId),
      conversationId: persistedConversationId,
      userId,
      role: message.role,
      content: message.content,
      sequence,
      metadata: buildMessageMetadata(message),
      sentAt,
      createdAt: sentAt,
    });

    for (const attachment of message.attachments ?? []) {
      const attachmentResourceKey = attachment.fileId
        ? upstreamResourceKey("file", attachment.fileId)
        : undefined;
      const attachmentCredentialId = attachmentResourceKey
        ? (bindings.get(attachmentResourceKey)?.apiCredentialId ??
          (options.validatedResourceKeys?.has(attachmentResourceKey)
            ? (options.importCredentialId ?? apiCredentialId)
            : apiCredentialId))
        : apiCredentialId;
      await executor.insert(attachments).values({
        id: storageId(userId, attachment.id, projectAssignmentId),
        userId,
        conversationId: persistedConversationId,
        messageId: storageId(userId, message.id, projectAssignmentId),
        apiCredentialId: attachmentCredentialId,
        kind: attachment.type,
        fileName: attachment.name,
        upstreamFileId: attachment.fileId ?? null,
      });
      if (attachment.fileId && attachmentCredentialId) {
        await persistResource(
          executor,
          {
            userId,
            apiCredentialId: attachmentCredentialId,
            projectAssignmentId,
            kind: "file",
            upstreamId: attachment.fileId,
            conversationId: persistedConversationId,
          },
          options.validatedResourceKeys,
        );
      }
    }
  }

  if (apiCredentialId) {
    for (const taskId of snapshotTaskIds(snapshot)) {
      const taskResourceKey = upstreamResourceKey("task", taskId);
      const taskCredentialId =
        bindings.get(taskResourceKey)?.apiCredentialId ??
        (options.validatedResourceKeys?.has(taskResourceKey)
          ? (options.importCredentialId ?? apiCredentialId)
          : apiCredentialId);
      await persistResource(
        executor,
        {
          userId,
          apiCredentialId: taskCredentialId,
          projectAssignmentId,
          kind: "task",
          upstreamId: taskId,
          conversationId: persistedConversationId,
        },
        options.validatedResourceKeys,
      );
    }
  }

  return existing ? "updated" : "imported";
}

async function validateWithBoundedConcurrency(
  resources: UpstreamResourceRef[],
  apiKey: string,
) {
  if (resources.length === 0) return;
  const abortController = new AbortController();
  const signal = AbortSignal.any([
    abortController.signal,
    AbortSignal.timeout(LEGACY_IMPORT_VALIDATION_TIMEOUT_MS),
  ]);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < resources.length) {
      const resource = resources[nextIndex];
      nextIndex += 1;
      await validateUpstreamResourceAccess(
        apiKey,
        resource.kind,
        resource.id,
        fetch,
        signal,
      );
    }
  };

  try {
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            LEGACY_IMPORT_VALIDATION_CONCURRENCY,
            resources.length,
          ),
        },
        () => worker(),
      ),
    );
  } catch (error) {
    abortController.abort();
    throw error;
  }
}

async function prepareLegacyImport(
  userId: number,
  projectAssignmentId: string | null,
  snapshots: ConversationSnapshot[],
) {
  const db = requireDb(await getDb());
  const persistedIds = snapshots.map((snapshot) =>
    storageId(userId, snapshot.id, projectAssignmentId),
  );
  const existingRows =
    persistedIds.length === 0
      ? []
      : await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(inArray(conversations.id, persistedIds));
  const existingIds = new Set(existingRows.map((row) => row.id));
  const newSnapshots = snapshots.filter(
    (snapshot) =>
      !existingIds.has(storageId(userId, snapshot.id, projectAssignmentId)),
  );
  const resources = collectSnapshotResourceRefs(newSnapshots);
  if (resources.length === 0) {
    return {
      credentialId: undefined,
      validatedResourceKeys: new Set<string>(),
    };
  }

  const taskIds = resources
    .filter((item) => item.kind === "task")
    .map((item) => item.id);
  const fileIds = resources
    .filter((item) => item.kind === "file")
    .map((item) => item.id);
  const [knownTasks, knownFiles] = await Promise.all([
    taskIds.length === 0
      ? []
      : db
          .select({
            kind: upstreamResources.kind,
            upstreamId: upstreamResources.upstreamId,
            userId: upstreamResources.userId,
            projectAssignmentId: upstreamResources.projectAssignmentId,
          })
          .from(upstreamResources)
          .where(
            and(
              eq(upstreamResources.kind, "task"),
              inArray(upstreamResources.upstreamId, taskIds),
            ),
          ),
    fileIds.length === 0
      ? []
      : db
          .select({
            kind: upstreamResources.kind,
            upstreamId: upstreamResources.upstreamId,
            userId: upstreamResources.userId,
            projectAssignmentId: upstreamResources.projectAssignmentId,
          })
          .from(upstreamResources)
          .where(
            and(
              eq(upstreamResources.kind, "file"),
              inArray(upstreamResources.upstreamId, fileIds),
            ),
          ),
  ]);
  const known = new Set<string>();
  for (const resource of [...knownTasks, ...knownFiles]) {
    const owned = projectAssignmentId
      ? resource.projectAssignmentId === projectAssignmentId
      : resource.userId === userId && resource.projectAssignmentId == null;
    if (!owned) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "历史任务或文件已属于其他账号",
      });
    }
    known.add(upstreamResourceKey(resource.kind, resource.upstreamId));
  }

  const unknown = resources.filter(
    (resource) => !known.has(upstreamResourceKey(resource.kind, resource.id)),
  );
  if (unknown.length === 0) {
    return {
      credentialId: undefined,
      validatedResourceKeys: new Set<string>(),
    };
  }
  const credential = await getEffectiveDecryptedCredentialForAccount(userId);
  if (!credential) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "请先迁移或配置该会话原来使用的 API Key，再导入历史会话",
    });
  }
  if (await isUpstreamApiKeyShared(userId, credential.fingerprint)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "共享 API Key 无法证明未知历史任务或文件的账号归属，请由系统管理员完成迁移",
    });
  }
  await validateWithBoundedConcurrency(unknown, credential.apiKey);
  return {
    credentialId: credential.id,
    validatedResourceKeys: new Set(
      unknown.map((resource) =>
        upstreamResourceKey(resource.kind, resource.id),
      ),
    ),
  };
}

async function listSnapshots(
  userId: number,
  projectAssignmentId: string | null = null,
): Promise<ConversationSnapshot[]> {
  const db = requireDb(await getDb());
  const conversationRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        projectAssignmentId
          ? eq(conversations.projectAssignmentId, projectAssignmentId)
          : and(
              eq(conversations.userId, userId),
              isNull(conversations.projectAssignmentId),
            ),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt));
  if (conversationRows.length === 0) return [];

  const ids = conversationRows.map((row) => row.id);
  const messageRows = await db
    .select()
    .from(messages)
    .where(
      and(
        projectAssignmentId ? undefined : eq(messages.userId, userId),
        inArray(messages.conversationId, ids),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.sequence));
  const messageIds = messageRows.map((row) => row.id);
  const attachmentRows =
    messageIds.length === 0
      ? []
      : await db
          .select()
          .from(attachments)
          .where(
            and(
              projectAssignmentId ? undefined : eq(attachments.userId, userId),
              inArray(attachments.messageId, messageIds),
              isNull(attachments.deletedAt),
            ),
          );

  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }

  const messagesByConversation = new Map<string, typeof messageRows>();
  for (const message of messageRows) {
    const current = messagesByConversation.get(message.conversationId) ?? [];
    current.push(message);
    messagesByConversation.set(message.conversationId, current);
  }

  return conversationRows.map((row) => ({
    id: publicId(userId, row.id, projectAssignmentId),
    title: row.title,
    messages: (messagesByConversation.get(row.id) ?? []).map((message) => {
      const metadata = (message.metadata ?? {}) as MessageMetadata;
      return {
        id: publicId(userId, message.id, projectAssignmentId),
        role:
          message.role === "assistant"
            ? ("assistant" as const)
            : ("user" as const),
        content: message.content,
        timestamp: message.sentAt.getTime(),
        attachments: (attachmentsByMessage.get(message.id) ?? []).map(
          (attachment) => ({
            id: publicId(userId, attachment.id, projectAssignmentId),
            type: attachment.kind,
            name: attachment.fileName,
            ...(attachment.upstreamFileId
              ? { fileId: attachment.upstreamFileId }
              : {}),
          }),
        ),
        ...(metadata.outputFiles ? { outputFiles: metadata.outputFiles } : {}),
        ...(metadata.inlineImages
          ? { inlineImages: metadata.inlineImages }
          : {}),
        ...(metadata.elapsedTime !== undefined
          ? { elapsedTime: metadata.elapsedTime }
          : {}),
        ...(metadata.responseStartedAt !== undefined
          ? { responseStartedAt: metadata.responseStartedAt }
          : {}),
        ...(metadata.intermediateSteps
          ? { intermediateSteps: metadata.intermediateSteps }
          : {}),
        ...(metadata.stepGroups ? { stepGroups: metadata.stepGroups } : {}),
        ...(metadata.isStepsPlaceholder !== undefined
          ? { isStepsPlaceholder: metadata.isStepsPlaceholder }
          : {}),
        ...(metadata.modelName ? { modelName: metadata.modelName } : {}),
      };
    }),
    ...(row.upstreamTaskId ? { taskId: row.upstreamTaskId } : {}),
    ...(row.previousResponseId
      ? { previousResponseId: row.previousResponseId }
      : {}),
    status: row.status === "archived" ? "completed" : row.status,
    ...(row.taskUrl ? { taskUrl: row.taskUrl } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.getTime() } : {}),
    lastKnownOutputLength: row.lastKnownOutputLength,
    deletedMessageIds: row.deletedMessageIds,
  }));
}

export const conversationRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ projectAssignmentId: z.string().uuid().optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const projectAssignmentId = await resolveConversationProjectAssignment(
        ctx.user,
        input?.projectAssignmentId,
      );
      return listSnapshots(ctx.user.id, projectAssignmentId);
    }),

  syncSnapshot: protectedProcedure
    .input(
      z.object({
        conversation: conversationSnapshotSchema,
        projectAssignmentId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const projectAssignmentId = await resolveConversationProjectAssignment(
        ctx.user,
        input.projectAssignmentId,
      );
      const db = requireDb(await getDb());
      await db.transaction(async (tx) => {
        await persistSnapshot(tx, ctx.user.id, input.conversation, {
          projectAssignmentId,
        });
      });
      const snapshots = await listSnapshots(ctx.user.id, projectAssignmentId);
      const persisted = snapshots.find(
        (item) => item.id === input.conversation.id,
      );
      if (!persisted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "会话保存失败",
        });
      }
      return persisted;
    }),

  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(128),
        projectAssignmentId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const projectAssignmentId = await resolveConversationProjectAssignment(
        ctx.user,
        input.projectAssignmentId,
      );
      const db = requireDb(await getDb());
      const persistedConversationId = storageId(
        ctx.user.id,
        input.id,
        projectAssignmentId,
      );
      const existing = await db
        .select({
          userId: conversations.userId,
          projectAssignmentId: conversations.projectAssignmentId,
        })
        .from(conversations)
        .where(eq(conversations.id, persistedConversationId))
        .limit(1);
      const owned = projectAssignmentId
        ? existing[0]?.projectAssignmentId === projectAssignmentId
        : existing[0]?.userId === ctx.user.id &&
          existing[0]?.projectAssignmentId == null;
      if (!existing[0] || !owned) {
        throw new TRPCError({ code: "NOT_FOUND", message: "会话不存在" });
      }
      await permanentlyDeleteConversation(
        db,
        ctx.user.id,
        persistedConversationId,
        projectAssignmentId,
      );
      return { success: true } as const;
    }),

  importLocal: protectedProcedure
    .input(
      z.object({
        conversations: z.array(conversationSnapshotSchema).max(200),
        projectAssignmentId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const projectAssignmentId = await resolveConversationProjectAssignment(
        ctx.user,
        input.projectAssignmentId,
      );
      const db = requireDb(await getDb());
      // Upstream ownership proof happens before any transaction or row lock.
      // Normal sync never creates ledger rows from client-supplied IDs.
      const prepared = await prepareLegacyImport(
        ctx.user.id,
        projectAssignmentId,
        input.conversations,
      );
      let imported = 0;
      let skipped = 0;
      for (const conversation of input.conversations) {
        const result = await db.transaction((tx) =>
          persistSnapshot(tx, ctx.user.id, conversation, {
            skipExisting: true,
            importCredentialId: prepared.credentialId,
            validatedResourceKeys: prepared.validatedResourceKeys,
            projectAssignmentId,
          }),
        );
        if (result === "imported") imported += 1;
        else skipped += 1;
      }
      return { imported, skipped };
    }),
});
