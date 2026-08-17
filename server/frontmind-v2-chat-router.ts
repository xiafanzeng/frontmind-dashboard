import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import axios from "axios";
import { and, desc, eq, gt } from "drizzle-orm";
import { Router, type Response } from "express";
import { z } from "zod";

import {
  agentEvents,
  agentOperations,
  agentTasks,
  artifacts,
  localAssets,
  providerFileLeases,
} from "../drizzle/schema";
import { getDecryptedCredentialForAccountById } from "./auth-service";
import { getDb } from "./db";
import {
  latestManusV2TaskState,
  latestManusV2WaitingDetail,
  manusV2EventsContainOperationToken,
  ManusV2ApiError,
  ManusV2Client,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  readStoredPresalesFile,
  recordPresalesFileDescriptor,
  removeStoredPresalesFile,
  stagePresalesFileContent,
  withStoredPresalesFileMutationLock,
} from "./presales-file-store";
import { sealLocalAssetStorageIdentity } from "./local-asset-storage-key";
import {
  KnowledgeBaseLocalAssetCoordinateError,
  knowledgeBaseLocalAssetIdentity,
  knowledgeBaseLocalAssetReplayMatches,
  parseKnowledgeBaseLocalUploadCoordinate,
} from "./knowledge-base-local-asset-upload";
import {
  assertKnowledgeBaseLocalUploadCoordinate,
  KnowledgeBaseTurnReservationError,
} from "./knowledge-base-turn-service";
import {
  OwnedFileContentError,
  ownedFileContentResolver,
} from "./owned-file-content-resolver";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { sanitizeFrontMindPublicText } from "../shared/frontmind-public-brand";
import {
  generalAgentModelProfileModel,
  generalAgentModelProfileSchema,
} from "../shared/manus-agent-profile";
import { getUpstreamBaseUrl } from "./upstream-config";

const router = Router();

const CHAT_CONTRACT = "dashboard.general-chat";
const CHAT_CONTRACT_REVISION = 2;
const CHAT_SCHEMA_HASH = createHash("sha256")
  .update("dashboard.general-chat:v2:local-task-local-message-local-artifact")
  .digest("hex");
const MAX_LOCAL_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const LOCAL_CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RESULT_GRACE_MS = 120_000;
const CREATE_RECONCILE_MS = 5 * 60_000;

const taskCreateSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(1).max(2_000_000),
    modelProfile: generalAgentModelProfileSchema.default("frontmind-pro"),
    localAssetIds: z
      .array(z.string().trim().min(1).max(36))
      .max(32)
      .default([]),
  })
  .strict();

const taskMessageSchema = taskCreateSchema
  .omit({ conversationId: true, modelProfile: true })
  .extend({ conversationId: z.string().trim().min(1).max(191) })
  .strict();

const actionSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    confirmationInput: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AgentOperation = typeof agentOperations.$inferSelect;
type AgentTask = typeof agentTasks.$inferSelect;

class ChatV2HttpError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "ChatV2HttpError";
  }
}

function assertGeneralAgentActor(user: Express.Request["frontmindUser"]) {
  const allowed =
    user?.role === "delivery_member" ||
    (user?.role === "admin" && user.adminAccessLevel === "delivery_admin");
  if (!allowed) throw new ChatV2HttpError("GENERAL_AGENT_ROLE_FORBIDDEN", 403);
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestHash(value: unknown) {
  return hash(JSON.stringify(value));
}

function localAssetId() {
  return `asset_${randomUUID().replaceAll("-", "").slice(0, 30)}`;
}

function cleanFilename(value: unknown) {
  const decoded = (() => {
    try {
      return decodeURIComponent(String(value ?? ""));
    } catch {
      return String(value ?? "");
    }
  })();
  const cleaned = decoded.replace(/[\\/\0\r\n]/gu, "_").trim();
  return (cleaned || "attachment.bin").slice(0, 512);
}

function cleanMimeType(value: unknown) {
  const normalized = String(value ?? "application/octet-stream")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
    normalized,
  )
    ? normalized.slice(0, 255)
    : "application/octet-stream";
}

function knowledgeBaseUploadReservationError(error: unknown) {
  if (!(error instanceof KnowledgeBaseTurnReservationError)) return error;
  if (error.code === "INVALID_REQUEST") {
    return new ChatV2HttpError("KNOWLEDGE_BASE_UPLOAD_COORDINATE_INVALID", 400);
  }
  if (error.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED") {
    return new ChatV2HttpError(error.code, 409);
  }
  return new ChatV2HttpError("UPLOAD_OPERATION_CONFLICT", 409);
}

async function storedLocalAssetContentMatches(input: {
  id: string;
  sizeBytes: number;
  contentSha256: string;
}) {
  const stored = await readStoredPresalesFile(input.id);
  if (
    !stored ||
    stored.sizeBytes !== input.sizeBytes ||
    (stored.recordedSizeBytes !== null &&
      stored.recordedSizeBytes !== input.sizeBytes) ||
    stored.sha256 !== input.contentSha256
  ) {
    return false;
  }
  const digest = createHash("sha256");
  let total = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > input.sizeBytes || total > MAX_LOCAL_ASSET_BYTES) return false;
    digest.update(bytes);
  }
  return (
    total === input.sizeBytes && digest.digest("hex") === input.contentSha256
  );
}

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new ChatV2HttpError("DATABASE_UNAVAILABLE", 503, true);
  return db;
}

function clientFor(apiKey: string, accountUserId: number) {
  return new ManusV2Client({
    baseUrl: getUpstreamBaseUrl(),
    apiKey,
    rateLimitScope: `managed-user:${accountUserId}`,
  });
}

function operationMarker(operationToken: string) {
  return `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({
    operationToken,
    contract: CHAT_CONTRACT,
    revision: CHAT_CONTRACT_REVISION,
  })}`;
}

function promptWithMarker(prompt: string, operationToken: string) {
  return `${prompt}\n\n# FrontMind operation contract\n${operationMarker(operationToken)}`;
}

async function findOwnedTask(input: { userId: number; localTaskId: string }) {
  const db = await requireDb();
  const rows = await db
    .select({ operation: agentOperations, task: agentTasks })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        eq(agentTasks.id, input.localTaskId),
        eq(agentOperations.scope, "managed_user"),
        eq(agentOperations.accountUserId, input.userId),
        eq(agentOperations.contractName, CHAT_CONTRACT),
        eq(agentOperations.contractRevision, CHAT_CONTRACT_REVISION),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new ChatV2HttpError("TASK_NOT_FOUND", 404);
  return rows[0];
}

async function readOwnedLocalAssets(input: {
  userId: number;
  localAssetIds: readonly string[];
}) {
  const db = await requireDb();
  const assets = [];
  for (const id of [...new Set(input.localAssetIds)]) {
    const row = (
      await db
        .select()
        .from(localAssets)
        .where(
          and(
            eq(localAssets.id, id),
            eq(localAssets.scope, "managed_user"),
            eq(localAssets.accountUserId, input.userId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new ChatV2HttpError("LOCAL_ASSET_NOT_FOUND", 404);
    const stored = await readStoredPresalesFile(id);
    if (
      !stored ||
      stored.sizeBytes !== row.sizeBytes ||
      stored.sha256 !== row.contentSha256
    ) {
      throw new ChatV2HttpError("LOCAL_ASSET_CONTENT_INVALID", 409);
    }
    assets.push({ row, stored });
  }
  return assets;
}

async function streamToBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      stream.destroy();
      throw new ChatV2HttpError("LOCAL_ASSET_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function ensureProviderAttachments(input: {
  operation: AgentOperation;
  credential: NonNullable<
    Awaited<ReturnType<typeof getDecryptedCredentialForAccountById>>
  >;
  localAssetIds: readonly string[];
}) {
  const db = await requireDb();
  const assets = await readOwnedLocalAssets({
    userId: input.operation.accountUserId!,
    localAssetIds: input.localAssetIds,
  });
  const client = clientFor(
    input.credential.apiKey,
    input.operation.accountUserId!,
  );
  const attachments = [];
  for (const asset of assets) {
    const reusable = (
      await db
        .select()
        .from(providerFileLeases)
        .where(
          and(
            eq(providerFileLeases.localAssetId, asset.row.id),
            eq(providerFileLeases.apiCredentialId, input.credential.id),
            eq(providerFileLeases.credentialVersion, input.credential.version),
            eq(providerFileLeases.uploadState, "uploaded"),
            gt(
              providerFileLeases.expiresAt,
              new Date(Date.now() + 15 * 60_000),
            ),
          ),
        )
        .orderBy(desc(providerFileLeases.expiresAt))
        .limit(1)
    )[0];
    if (reusable?.providerFileId) {
      try {
        const detail = await client.fileDetail(reusable.providerFileId);
        const usableUntil = Math.floor(Date.now() / 1_000) + 15 * 60;
        if (
          detail.status === "uploaded" &&
          detail.filename === asset.row.filename &&
          detail.bytes === asset.row.sizeBytes &&
          detail.expiresAt > usableUntil
        ) {
          attachments.push({
            file_id: reusable.providerFileId,
            filename: asset.row.filename,
          });
          continue;
        }
        await db
          .update(providerFileLeases)
          .set({ uploadState: "expired" })
          .where(eq(providerFileLeases.id, reusable.id));
      } catch (error) {
        // A Provider-confirmed missing/deleted lease can always be regenerated
        // from Dashboard's immutable local bytes. Authentication, transport,
        // and malformed-response errors must remain visible rather than being
        // disguised as a fresh upload attempt under the same broken boundary.
        if (
          !(error instanceof ManusV2ApiError) ||
          !(
            error.status === 404 ||
            ["FILE_NOT_FOUND", "NOT_FOUND"].includes(error.code.toUpperCase())
          )
        ) {
          throw error;
        }
        await db
          .update(providerFileLeases)
          .set({ uploadState: "expired" })
          .where(eq(providerFileLeases.id, reusable.id));
      }
    }

    const bytes = await streamToBuffer(
      asset.stored.createReadStream(),
      MAX_LOCAL_ASSET_BYTES,
    );
    const uploaded = await client.uploadFile({
      filename: asset.row.filename,
      contentType: asset.row.mimeType,
      bytes,
    });
    await db.insert(providerFileLeases).values({
      id: randomUUID(),
      localAssetId: asset.row.id,
      apiCredentialId: input.credential.id,
      credentialVersion: input.credential.version,
      providerFileId: uploaded.fileId,
      providerRequestId: uploaded.requestId,
      uploadState: "uploaded",
      uploadedBytes: bytes.length,
      expiresAt: new Date(uploaded.detail.expiresAt * 1_000),
    });
    attachments.push({
      file_id: uploaded.fileId,
      filename: uploaded.filename,
    });
  }
  return attachments;
}

type AssistantAttachment = {
  eventId: string;
  attachmentIndex: number;
  url: string;
  filename: string;
  mimeType: string;
};

function assistantAttachments(event: ManusV2MessageEvent) {
  if (event.type !== "assistant_message") return [];
  const rawMessage =
    event.assistant_message &&
    typeof event.assistant_message === "object" &&
    !Array.isArray(event.assistant_message)
      ? (event.assistant_message as Record<string, unknown>)
      : null;
  const rawAttachments = Array.isArray(rawMessage?.attachments)
    ? rawMessage.attachments
    : [];
  return rawAttachments.flatMap<AssistantAttachment>((raw, attachmentIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const attachment = raw as Record<string, unknown>;
    const url = String(
      attachment.url ?? attachment.file_url ?? attachment.download_url ?? "",
    ).trim();
    if (!url) return [];
    return [
      {
        eventId: event.id,
        attachmentIndex,
        url,
        filename: cleanFilename(
          attachment.filename ?? attachment.file_name ?? attachment.name,
        ),
        mimeType: cleanMimeType(
          attachment.mime_type ?? attachment.content_type,
        ),
      },
    ];
  });
}

function artifactIdFor(input: {
  providerTaskId: string;
  eventId: string;
  attachmentIndex: number;
}) {
  return `artifact_${hash(
    `${input.providerTaskId}\0${input.eventId}\0${input.attachmentIndex}`,
  )}`;
}

async function localizeArtifact(input: {
  operation: AgentOperation;
  task: AgentTask;
  attachment: AssistantAttachment;
}) {
  if (!input.task.providerTaskId) return null;
  const db = await requireDb();
  const artifactId = artifactIdFor({
    providerTaskId: input.task.providerTaskId,
    eventId: input.attachment.eventId,
    attachmentIndex: input.attachment.attachmentIndex,
  });
  const existing = (
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)
  )[0];
  if (existing && (await readStoredPresalesFile(artifactId))) return existing;

  const url = assertSafeExternalUrl(input.attachment.url);
  if (new URL(url).protocol !== "https:") {
    throw new ChatV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
  const response = await axios.get<Readable>(url, {
    ...safeExternalRequestOptions,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_ARTIFACT_BYTES,
    maxBodyLength: MAX_ARTIFACT_BYTES,
    validateStatus: () => true,
  });
  if (response.status !== 200) {
    response.data.destroy();
    throw new ChatV2HttpError("ARTIFACT_DOWNLOAD_FAILED", 502, true);
  }
  const mimeType = cleanMimeType(
    response.headers["content-type"] ?? input.attachment.mimeType,
  );
  await recordPresalesFileDescriptor({
    fileId: artifactId,
    filename: input.attachment.filename,
    mimeType,
  });
  const staged = await stagePresalesFileContent({
    fileId: artifactId,
    stream: response.data,
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  try {
    const now = Date.now();
    await staged.commit({
      filename: input.attachment.filename,
      mimeType,
      uploadedAt: now,
      contentExpiresAt: now + LOCAL_CONTENT_RETENTION_MS,
    });
  } catch (error) {
    await staged.discard().catch(() => undefined);
    throw error;
  }
  await db
    .insert(artifacts)
    .values({
      id: artifactId,
      operationId: input.operation.id,
      taskId: input.task.id,
      sourceEventId: input.attachment.eventId,
      attachmentIndex: input.attachment.attachmentIndex,
      filename: input.attachment.filename,
      mimeType,
      sizeBytes: staged.sizeBytes,
      contentSha256: staged.sha256,
      storageKey: `frontmind-v2:${artifactId}`,
      validationState: "valid",
      refCount: 1,
    })
    .onDuplicateKeyUpdate({
      set: {
        filename: input.attachment.filename,
        mimeType,
        sizeBytes: staged.sizeBytes,
        contentSha256: staged.sha256,
        validationState: "valid",
      },
    });
  return (
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)
  )[0]!;
}

function assistantText(event: ManusV2MessageEvent) {
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
  return sanitizeFrontMindPublicText(text).trim();
}

async function persistProviderEvents(input: {
  operation: AgentOperation;
  task: AgentTask;
  events: readonly ManusV2MessageEvent[];
}) {
  const db = await requireDb();
  const waiting = latestManusV2WaitingDetail(input.events);
  for (const event of input.events) {
    const localized = [];
    for (const attachment of assistantAttachments(event)) {
      try {
        const artifact = await localizeArtifact({
          operation: input.operation,
          task: input.task,
          attachment,
        });
        if (artifact) {
          localized.push({
            artifactId: artifact.id,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            bytes: artifact.sizeBytes,
            sha256: artifact.contentSha256,
          });
        }
      } catch (error) {
        console.warn("[FrontMindV2] artifact localization deferred", {
          code:
            error instanceof ChatV2HttpError
              ? error.code
              : "ARTIFACT_LOCALIZATION_FAILED",
          localTaskId: input.task.id,
        });
      }
    }
    const normalizedPayload: Record<string, unknown> = {
      kind: "provider_event",
      type: event.type,
      text: assistantText(event),
      artifacts: localized,
      ...(waiting?.statusEventId === event.id
        ? {
            action: {
              eventId: waiting.eventId,
              eventType: waiting.eventType,
              description: waiting.description,
              inputSchema: waiting.confirmInputSchema,
            },
          }
        : {}),
    };
    await db
      .insert(agentEvents)
      .values({
        id: randomUUID(),
        taskId: input.task.id,
        providerEventId: event.id,
        eventType: event.type,
        providerTimestampMs: event.timestamp,
        normalizedPayload,
      })
      .onDuplicateKeyUpdate({
        set: {
          eventType: event.type,
          providerTimestampMs: event.timestamp,
          normalizedPayload,
        },
      });
  }
}

async function cachedOutput(taskId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.taskId, taskId))
    .orderBy(agentEvents.providerTimestampMs, agentEvents.id);
  return rows.flatMap((row) => {
    const payload = row.normalizedPayload ?? {};
    if (payload.kind !== "provider_event") return [];
    const output = [];
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text) {
      output.push({
        id: row.id,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }
    const resources = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    resources.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const resource = raw as Record<string, unknown>;
      const artifactId = String(resource.artifactId ?? "");
      if (!artifactId.startsWith("artifact_")) return;
      const mimeType = cleanMimeType(resource.mimeType);
      output.push({
        id: `${row.id}:artifact:${index}`,
        type: mimeType.startsWith("image/") ? "output_image" : "output_file",
        file_url: `/api/frontmind/v2/artifacts/${encodeURIComponent(artifactId)}/content`,
        file_name: cleanFilename(resource.filename),
        mime_type: mimeType,
      });
    });
    return output;
  });
}

function publicStatus(status: AgentOperation["status"]) {
  if (status === "succeeded") return "completed" as const;
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "attention_required"
  ) {
    return "error" as const;
  }
  if (status === "queued") return "pending" as const;
  return "running" as const;
}

async function taskDto(operation: AgentOperation, task: AgentTask) {
  return {
    id: task.id,
    object: "frontmind.local_task",
    status: publicStatus(operation.status),
    model: operation.publicProfile,
    metadata: { task_title: "FrontMind 内容流程" },
    output: await cachedOutput(task.id),
    ...(operation.errorCode
      ? { error: { message: "任务未能完成", code: operation.errorCode } }
      : {}),
  };
}

async function updateTaskState(input: {
  operationId: string;
  localTaskId: string;
  status: AgentOperation["status"];
  providerState: string;
  errorCode?: string | null;
  providerTaskId?: string;
  providerRequestId?: string | null;
  resultDeadlineAt?: Date | null;
}) {
  const db = await requireDb();
  await db.transaction(async (tx) => {
    await tx
      .update(agentOperations)
      .set({ status: input.status, errorCode: input.errorCode ?? null })
      .where(eq(agentOperations.id, input.operationId));
    await tx
      .update(agentTasks)
      .set({
        providerState: input.providerState,
        ...(input.providerTaskId
          ? { providerTaskId: input.providerTaskId }
          : {}),
        ...(input.providerRequestId !== undefined
          ? { providerRequestId: input.providerRequestId }
          : {}),
        ...(input.resultDeadlineAt !== undefined
          ? { resultDeadlineAt: input.resultDeadlineAt }
          : {}),
        lastMessageSyncAt: new Date(),
      })
      .where(eq(agentTasks.id, input.localTaskId));
  });
}

async function reconcileUnknownCreate(input: {
  operation: AgentOperation;
  task: AgentTask;
  credential: NonNullable<
    Awaited<ReturnType<typeof getDecryptedCredentialForAccountById>>
  >;
}) {
  if (input.task.providerTaskId || input.operation.status !== "queued") {
    return input;
  }
  const result = await clientFor(
    input.credential.apiKey,
    input.operation.accountUserId!,
  ).findCreatedTask({
    title: input.task.title,
    operationToken: input.task.createMarker,
    createdAfterSeconds:
      Math.floor(input.operation.createdAt.getTime() / 1_000) - 60,
    createdBeforeSeconds: Math.floor(Date.now() / 1_000) + 60,
  });
  if (result.matches.length > 1) {
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "CREATE_RECONCILE_CONFLICT",
    });
  } else if (result.unique) {
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "running",
      providerState: result.unique.status ?? "running",
      providerTaskId: result.unique.id,
      errorCode: null,
    });
  } else if (
    Date.now() - input.operation.createdAt.getTime() >=
    CREATE_RECONCILE_MS
  ) {
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "CREATE_OUTCOME_UNKNOWN",
    });
  }
  return findOwnedTask({
    userId: input.operation.accountUserId!,
    localTaskId: input.task.id,
  });
}

async function syncTask(input: { userId: number; localTaskId: string }) {
  let owned = await findOwnedTask(input);
  if (
    ["succeeded", "failed", "cancelled", "attention_required"].includes(
      owned.operation.status,
    )
  ) {
    return owned;
  }
  const credential = await getDecryptedCredentialForAccountById(
    input.userId,
    owned.operation.apiCredentialId,
  );
  if (!credential || credential.version !== owned.operation.credentialVersion) {
    return owned;
  }
  if (!owned.task.providerTaskId && owned.operation.status === "queued") {
    owned = await reconcileUnknownCreate({ ...owned, credential });
  }
  if (!owned.task.providerTaskId) return owned;

  try {
    const client = clientFor(credential.apiKey, input.userId);
    const [events, detail] = await Promise.all([
      client.listAllMessages({
        taskId: owned.task.providerTaskId,
        order: "desc",
      }),
      client.taskDetail(owned.task.providerTaskId),
    ]);
    await persistProviderEvents({ ...owned, events });
    const state = latestManusV2TaskState(events) ?? detail.status ?? "running";
    const output = await cachedOutput(owned.task.id);
    let status: AgentOperation["status"] = "running";
    let errorCode: string | null = null;
    let resultDeadlineAt = owned.task.resultDeadlineAt;
    if (["error", "failed", "cancelled"].includes(state)) {
      status = state === "cancelled" ? "cancelled" : "failed";
      errorCode = "PROVIDER_TASK_FAILED";
    } else if (
      ["completed", "succeeded", "success", "finished", "done"].includes(state)
    ) {
      status = "succeeded";
    } else if (state === "stopped") {
      if (output.length > 0) {
        status = "succeeded";
      } else {
        resultDeadlineAt ??= new Date(Date.now() + RESULT_GRACE_MS);
        status =
          Date.now() >= resultDeadlineAt.getTime()
            ? "failed"
            : "result_pending";
        errorCode = status === "failed" ? "RESULT_MISSING" : null;
      }
    } else if (state === "waiting") {
      status = "running";
    }
    await updateTaskState({
      operationId: owned.operation.id,
      localTaskId: owned.task.id,
      status,
      providerState: state,
      errorCode,
      resultDeadlineAt,
    });
    owned = await findOwnedTask(input);
  } catch (error) {
    // Cached local messages and artifacts remain authoritative when a retired
    // or revoked credential can no longer read the provider task.
    console.warn("[FrontMindV2] task reconcile deferred", {
      code: error instanceof ManusV2ApiError ? error.code : "TASK_SYNC_FAILED",
      localTaskId: input.localTaskId,
    });
  }
  return owned;
}

async function reserveCreate(input: {
  userId: number;
  credential: NonNullable<Express.Request["frontmindCredential"]>;
  value: z.infer<typeof taskCreateSchema>;
}) {
  const db = await requireDb();
  const idempotencyKeyHash = hash(
    `${input.userId}\0${input.value.clientRequestId}`,
  );
  const frozenRequestHash = requestHash({
    conversationId: input.value.conversationId,
    prompt: input.value.prompt,
    localAssetIds: input.value.localAssetIds,
    modelProfile: input.value.modelProfile,
  });
  const existing = (
    await db
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentOperations)
      .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
      .where(
        and(
          eq(agentOperations.scope, "managed_user"),
          eq(agentOperations.idempotencyKeyHash, idempotencyKeyHash),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    if (
      existing.operation.accountUserId !== input.userId ||
      existing.operation.requestHash !== frozenRequestHash
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    return { ...existing, acquired: false as const };
  }

  const operationId = randomUUID();
  const localTaskId = randomUUID();
  const createMarker = `chat-create:${operationId}`;
  const title = `FrontMind chat ${localTaskId}`;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(agentOperations).values({
        id: operationId,
        scope: "managed_user",
        accountUserId: input.userId,
        presalesProjectId: null,
        operationType: CHAT_CONTRACT,
        idempotencyKeyHash,
        requestHash: frozenRequestHash,
        contractName: CHAT_CONTRACT,
        contractRevision: CHAT_CONTRACT_REVISION,
        schemaHash: CHAT_SCHEMA_HASH,
        apiCredentialId: input.credential.id,
        credentialVersion: input.credential.version,
        publicProfile: input.value.modelProfile,
        upstreamModel: generalAgentModelProfileModel(input.value.modelProfile),
        status: "queued",
      });
      await tx.insert(agentTasks).values({
        id: localTaskId,
        operationId,
        providerTaskId: null,
        providerRequestId: null,
        createMarker,
        title,
        providerState: "queued",
      });
    });
  } catch (error) {
    const raced = (
      await db
        .select({ operation: agentOperations, task: agentTasks })
        .from(agentOperations)
        .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
        .where(
          and(
            eq(agentOperations.scope, "managed_user"),
            eq(agentOperations.idempotencyKeyHash, idempotencyKeyHash),
          ),
        )
        .limit(1)
    )[0];
    if (!raced) throw error;
    if (
      raced.operation.accountUserId !== input.userId ||
      raced.operation.requestHash !== frozenRequestHash
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    return { ...raced, acquired: false as const };
  }
  const created = await findOwnedTask({ userId: input.userId, localTaskId });
  return { ...created, acquired: true as const };
}

async function sendProviderMessage(input: {
  operation: AgentOperation;
  task: AgentTask;
  credential: NonNullable<
    Awaited<ReturnType<typeof getDecryptedCredentialForAccountById>>
  >;
  clientRequestId: string;
  prompt: string;
  localAssetIds: readonly string[];
}) {
  if (!input.task.providerTaskId) {
    throw new ChatV2HttpError("TASK_NOT_READY", 409, true);
  }
  const db = await requireDb();
  const markerHash = hash(
    `${input.operation.accountUserId}\0${input.task.id}\0${input.clientRequestId}`,
  );
  const providerEventId = `local-send:${markerHash}`;
  const operationToken = `chat-send:${markerHash.slice(0, 48)}`;
  const frozenRequestHash = requestHash({
    prompt: input.prompt,
    localAssetIds: input.localAssetIds,
  });
  const eventId = randomUUID();
  await db
    .insert(agentEvents)
    .values({
      id: eventId,
      taskId: input.task.id,
      providerEventId,
      eventType: "local_send_reservation",
      providerTimestampMs: Date.now(),
      normalizedPayload: {
        kind: "local_send_reservation",
        requestHash: frozenRequestHash,
        operationToken,
        status: "reserved",
      },
    })
    .onDuplicateKeyUpdate({ set: { providerEventId } });
  const reservation = (
    await db
      .select()
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.taskId, input.task.id),
          eq(agentEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1)
  )[0]!;
  const payload = reservation.normalizedPayload ?? {};
  if (payload.requestHash !== frozenRequestHash) {
    throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
  }
  const acquired = reservation.id === eventId;
  if (!acquired) {
    if (payload.status === "acknowledged") return;
    const events = await clientFor(
      input.credential.apiKey,
      input.operation.accountUserId!,
    ).listAllMessages({
      taskId: input.task.providerTaskId,
      order: "desc",
      stopAfterOperationToken: operationToken,
    });
    if (manusV2EventsContainOperationToken(events, operationToken)) {
      await db
        .update(agentEvents)
        .set({ normalizedPayload: { ...payload, status: "acknowledged" } })
        .where(eq(agentEvents.id, reservation.id));
      return;
    }
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "SEND_OUTCOME_UNKNOWN",
    });
    return;
  }

  try {
    const attachments = await ensureProviderAttachments({
      operation: input.operation,
      credential: input.credential,
      localAssetIds: input.localAssetIds,
    });
    await clientFor(
      input.credential.apiKey,
      input.operation.accountUserId!,
    ).sendMessage({
      taskId: input.task.providerTaskId,
      prompt: promptWithMarker(input.prompt, operationToken),
      attachments,
    });
    await db
      .update(agentEvents)
      .set({ normalizedPayload: { ...payload, status: "acknowledged" } })
      .where(eq(agentEvents.id, reservation.id));
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "running",
      providerState: "running",
      errorCode: null,
      resultDeadlineAt: null,
    });
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
      const events = await clientFor(
        input.credential.apiKey,
        input.operation.accountUserId!,
      ).listAllMessages({
        taskId: input.task.providerTaskId,
        order: "desc",
        stopAfterOperationToken: operationToken,
      });
      if (manusV2EventsContainOperationToken(events, operationToken)) {
        await db
          .update(agentEvents)
          .set({ normalizedPayload: { ...payload, status: "acknowledged" } })
          .where(eq(agentEvents.id, reservation.id));
        return;
      }
      await db
        .update(agentEvents)
        .set({ normalizedPayload: { ...payload, status: "outcome_unknown" } })
        .where(eq(agentEvents.id, reservation.id));
      await updateTaskState({
        operationId: input.operation.id,
        localTaskId: input.task.id,
        status: "attention_required",
        providerState: "attention_required",
        errorCode: "SEND_OUTCOME_UNKNOWN",
      });
      return;
    }
    await db
      .update(agentEvents)
      .set({ normalizedPayload: { ...payload, status: "rejected" } })
      .where(eq(agentEvents.id, reservation.id));
    throw error;
  }
}

function sendError(res: Response, error: unknown) {
  if (error instanceof OwnedFileContentError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        recoveryAction: error.recoveryAction,
        ...(error.expiresAt !== undefined
          ? { expiresAt: error.expiresAt }
          : {}),
      },
    });
    return;
  }
  if (error instanceof ChatV2HttpError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.code,
        retryable: error.retryable,
      },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: "请求参数无效",
        retryable: false,
      },
    });
    return;
  }
  if (error instanceof ManusV2ApiError) {
    res
      .status(
        error.status && error.status >= 400 && error.status < 500
          ? error.status
          : 502,
      )
      .json({
        error: {
          code: error.code,
          message: "FrontMind 服务暂不可用",
          retryable: error.retryable,
        },
      });
    return;
  }
  console.error("[FrontMindV2] request failed", {
    code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
  });
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "请求未能完成",
      retryable: false,
    },
  });
}

router.post("/assets", async (req, res) => {
  const traceId = randomUUID();
  const startedAt = Date.now();
  let declaredBytes: number | undefined;
  let receivedBytes = 0;
  let temporaryDiscarded = false;
  let assetCommitted = false;
  const uploadAttempt = Math.max(
    1,
    Math.min(3, Number(req.headers["x-frontmind-upload-attempt"]) || 1),
  );
  let knowledgeCoordinate: ReturnType<
    typeof parseKnowledgeBaseLocalUploadCoordinate
  > = null;
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    const ownerUserId = req.frontmindUser.id;
    const filename = cleanFilename(req.headers["x-frontmind-filename"]);
    const mimeType = cleanMimeType(
      req.headers["x-frontmind-mime"] ?? req.headers["content-type"],
    );
    declaredBytes = Number(
      req.headers["x-frontmind-size"] ?? req.headers["content-length"],
    );
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes <= 0 ||
      declaredBytes > MAX_LOCAL_ASSET_BYTES
    ) {
      throw new ChatV2HttpError("LOCAL_ASSET_SIZE_INVALID", 413);
    }
    try {
      knowledgeCoordinate = parseKnowledgeBaseLocalUploadCoordinate(
        req.headers,
      );
    } catch (error) {
      if (error instanceof KnowledgeBaseLocalAssetCoordinateError) {
        throw new ChatV2HttpError(error.code, 400);
      }
      throw error;
    }
    const knowledgeIdentity = knowledgeCoordinate
      ? knowledgeBaseLocalAssetIdentity({
          userId: ownerUserId,
          projectAssignmentId:
            req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
          coordinate: knowledgeCoordinate,
          sizeBytes: declaredBytes,
        })
      : null;
    const assertKnowledgeCoordinate = async (
      authoritativeContentSha256?: string,
    ) => {
      if (!knowledgeCoordinate) return;
      try {
        await assertKnowledgeBaseLocalUploadCoordinate({
          userId: ownerUserId,
          projectAssignmentId:
            req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
          conversationId: knowledgeCoordinate.conversationId,
          turnId: knowledgeCoordinate.turnId,
          clientRequestId: knowledgeCoordinate.clientRequestId,
          itemId: knowledgeCoordinate.itemId,
          expectedResetRevision: knowledgeCoordinate.expectedResetRevision,
          ordinal: knowledgeCoordinate.ordinal,
          filename,
          mimeType,
          sizeBytes: declaredBytes!,
          contentSha256: knowledgeCoordinate.contentSha256,
          authoritativeContentSha256,
        });
      } catch (error) {
        throw knowledgeBaseUploadReservationError(error);
      }
    };
    // Reject forged, reset or already-dispatched coordinates before consuming
    // a potentially 100 MiB request body.
    await assertKnowledgeCoordinate();
    console.info("[FrontMindV2Asset] upload_start", {
      traceId,
      declaredBytes,
      uploadAttempt,
      ...(knowledgeCoordinate
        ? {
            conversationId: knowledgeCoordinate.conversationId,
            turnId: knowledgeCoordinate.turnId,
            itemId: knowledgeCoordinate.itemId,
            ordinal: knowledgeCoordinate.ordinal,
            expectedResetRevision: knowledgeCoordinate.expectedResetRevision,
          }
        : {}),
    });
    const persistUpload = async () => {
      const db = await requireDb();
      const id = knowledgeIdentity?.localAssetId || localAssetId();
      const loadExisting = async () =>
        knowledgeIdentity
          ? (
              await db
                .select()
                .from(localAssets)
                .where(
                  and(
                    eq(localAssets.id, knowledgeIdentity.localAssetId),
                    eq(localAssets.scope, "managed_user"),
                    eq(localAssets.accountUserId, ownerUserId),
                  ),
                )
                .limit(1)
            )[0]
          : undefined;
      const progressThresholds = [25, 50, 75] as const;
      let nextProgressThreshold = 0;
      const staged = await stagePresalesFileContent({
        fileId: id,
        stream: req,
        maxBytes: MAX_LOCAL_ASSET_BYTES,
        onProgress: (nextReceivedBytes) => {
          receivedBytes = nextReceivedBytes;
          while (
            nextProgressThreshold < progressThresholds.length &&
            nextReceivedBytes * 100 >=
              declaredBytes! * progressThresholds[nextProgressThreshold]
          ) {
            const percent = progressThresholds[nextProgressThreshold];
            console.info("[FrontMindV2Asset] upload_progress", {
              traceId,
              declaredBytes,
              receivedBytes: nextReceivedBytes,
              percent,
              durationMs: Date.now() - startedAt,
              ...(knowledgeCoordinate
                ? {
                    conversationId: knowledgeCoordinate.conversationId,
                    turnId: knowledgeCoordinate.turnId,
                    itemId: knowledgeCoordinate.itemId,
                    ordinal: knowledgeCoordinate.ordinal,
                  }
                : {}),
            });
            nextProgressThreshold += 1;
          }
        },
      }).catch((error) => {
        // stagePresalesFileContent guarantees removal of its partial temp.
        temporaryDiscarded = true;
        throw error;
      });
      try {
        if (staged.sizeBytes !== declaredBytes) {
          throw new ChatV2HttpError("LOCAL_ASSET_SIZE_MISMATCH", 400);
        }
        if (
          knowledgeCoordinate?.contentSha256 &&
          staged.sha256 !== knowledgeCoordinate.contentSha256
        ) {
          throw new ChatV2HttpError("LOCAL_ASSET_SHA256_MISMATCH", 400);
        }
        const authoritativeKnowledgeIdentity = knowledgeCoordinate
          ? knowledgeBaseLocalAssetIdentity({
              userId: ownerUserId,
              projectAssignmentId:
                req.frontmindDeliveryProjectContext?.projectAssignmentId ??
                null,
              coordinate: knowledgeCoordinate,
              sizeBytes: declaredBytes!,
              authoritativeContentSha256: staged.sha256,
            })
          : null;
        const finalizeUpload = async () => {
          // Reset/dispatch can advance while the body is in flight. Re-prove
          // the reservation immediately before the short durable commit.
          await assertKnowledgeCoordinate(staged.sha256);
          const replayPayload = async (
            existing: typeof localAssets.$inferSelect,
          ) => {
            const matches =
              knowledgeIdentity &&
              knowledgeBaseLocalAssetReplayMatches(existing, {
                filename,
                mimeType,
                sizeBytes: staged.sizeBytes,
                contentSha256: staged.sha256,
                storageKey: authoritativeKnowledgeIdentity!.storageKey!,
              });
            const bytesMatch =
              matches &&
              (await storedLocalAssetContentMatches({
                id: existing.id,
                sizeBytes: existing.sizeBytes,
                contentSha256: existing.contentSha256,
              }));
            if (!matches || !bytesMatch) {
              throw new ChatV2HttpError("UPLOAD_OPERATION_CONFLICT", 409);
            }
            const expiresAt = existing.retainUntil?.getTime() ?? 0;
            if (expiresAt <= Date.now()) {
              throw new ChatV2HttpError("LOCAL_ASSET_EXPIRED", 409);
            }
            await staged.discard();
            temporaryDiscarded = true;
            assetCommitted = true;
            return {
              status: 200,
              payload: {
                localAssetId: existing.id,
                filename: existing.filename,
                mimeType: existing.mimeType,
                bytes: existing.sizeBytes,
                sha256: existing.contentSha256,
                expiresAt,
                traceId,
                replayed: true,
              },
            };
          };

          const existing = await loadExisting();
          if (existing && knowledgeIdentity) return replayPayload(existing);

          const now = Date.now();
          const storageKey =
            authoritativeKnowledgeIdentity?.storageKey ?? `frontmind-v2:${id}`;
          await staged.commit({
            filename,
            mimeType,
            uploadedAt: now,
            contentExpiresAt: now + LOCAL_CONTENT_RETENTION_MS,
          });
          try {
            await db.insert(localAssets).values(
              sealLocalAssetStorageIdentity({
                id,
                scope: "managed_user" as const,
                accountUserId: ownerUserId,
                presalesProjectId: null,
                filename,
                mimeType,
                sizeBytes: staged.sizeBytes,
                contentSha256: staged.sha256,
                storageKey,
                refCount: 1,
                retainUntil: new Date(now + LOCAL_CONTENT_RETENTION_MS),
              }),
            );
            assetCommitted = true;
          } catch (insertError) {
            // The insert can commit while its response is lost. Re-read under
            // the same cross-process lock; an exact row is the winner and its
            // final file must never be deleted. If the re-read itself fails,
            // retain the possible winner for reconciliation/retention cleanup.
            let winner: typeof localAssets.$inferSelect | undefined;
            try {
              winner = await loadExisting();
            } catch {
              throw insertError;
            }
            if (winner && knowledgeIdentity) return replayPayload(winner);
            await removeStoredPresalesFile(id).catch(() => undefined);
            temporaryDiscarded = true;
            throw insertError;
          }
          return {
            status: 201,
            payload: {
              localAssetId: id,
              filename,
              mimeType,
              bytes: staged.sizeBytes,
              sha256: staged.sha256,
              expiresAt: now + LOCAL_CONTENT_RETENTION_MS,
              traceId,
              replayed: false,
            },
          };
        };
        return knowledgeIdentity
          ? withStoredPresalesFileMutationLock(id, finalizeUpload)
          : finalizeUpload();
      } catch (error) {
        await staged.discard().catch(() => undefined);
        temporaryDiscarded = true;
        throw error;
      }
    };
    const completed = await persistUpload();
    res.status(completed.status).json(completed.payload);
    console.info("[FrontMindV2Asset] upload_complete", {
      traceId,
      declaredBytes,
      receivedBytes: completed.payload.bytes,
      durationMs: Date.now() - startedAt,
      status: completed.status,
      requestAborted: req.aborted,
      requestComplete: req.complete,
      requestDestroyed: req.destroyed,
      temporaryDiscarded,
      assetCommitted,
      replayed: completed.payload.replayed,
      ...(knowledgeCoordinate
        ? {
            conversationId: knowledgeCoordinate.conversationId,
            turnId: knowledgeCoordinate.turnId,
            itemId: knowledgeCoordinate.itemId,
            ordinal: knowledgeCoordinate.ordinal,
          }
        : {}),
    });
  } catch (error) {
    console.warn("[FrontMindV2Asset] upload_failed", {
      traceId,
      declaredBytes,
      receivedBytes,
      durationMs: Date.now() - startedAt,
      requestAborted: req.aborted,
      requestComplete: req.complete,
      requestDestroyed: req.destroyed,
      socketDestroyed: req.socket.destroyed,
      uploadAttempt,
      temporaryDiscarded,
      assetCommitted,
      ...(knowledgeCoordinate
        ? {
            conversationId: knowledgeCoordinate.conversationId,
            turnId: knowledgeCoordinate.turnId,
            itemId: knowledgeCoordinate.itemId,
            ordinal: knowledgeCoordinate.ordinal,
          }
        : {}),
      code:
        error instanceof ChatV2HttpError
          ? error.code
          : error instanceof Error
            ? error.name
            : "UNKNOWN_ERROR",
      streamErrorCode:
        typeof (error as NodeJS.ErrnoException | null)?.code === "string"
          ? (error as NodeJS.ErrnoException).code
          : null,
    });
    sendError(res, error);
  }
});

router.get("/assets/:localAssetId/content", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    const asset = await ownedFileContentResolver.resolve({
      ownerUserId: req.frontmindUser.id,
      fileId: req.params.localAssetId,
      projectAssignmentId:
        req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
      expectedSourceKind: "managed_local_asset",
      expectedSourceAuthorityId: req.params.localAssetId,
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", asset.mimeType);
    if (asset.sizeBytes !== undefined) {
      res.setHeader("Content-Length", String(asset.sizeBytes));
    }
    if (asset.sha256) res.setHeader("ETag", `\"sha256:${asset.sha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    asset.stream.pipe(res);
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/tasks", async (req, res) => {
  try {
    if (!req.frontmindUser) {
      throw new ChatV2HttpError("UNAUTHORIZED", 401);
    }
    assertGeneralAgentActor(req.frontmindUser);
    if (!req.frontmindCredential) {
      throw new ChatV2HttpError("API_CREDENTIAL_REQUIRED", 428);
    }
    const value = taskCreateSchema.parse(req.body ?? {});
    const reserved = await reserveCreate({
      userId: req.frontmindUser.id,
      credential: req.frontmindCredential,
      value,
    });
    if (reserved.acquired) {
      try {
        const attachments = await ensureProviderAttachments({
          operation: reserved.operation,
          credential: req.frontmindCredential,
          localAssetIds: value.localAssetIds,
        });
        const created = await clientFor(
          req.frontmindCredential.apiKey,
          req.frontmindUser.id,
        ).createTask({
          prompt: promptWithMarker(value.prompt, reserved.task.createMarker),
          attachments,
          title: reserved.task.title,
          agentProfile: reserved.operation.upstreamModel,
          interactiveMode: true,
          locale: "zh-CN",
        });
        await updateTaskState({
          operationId: reserved.operation.id,
          localTaskId: reserved.task.id,
          status: "running",
          providerState: "running",
          providerTaskId: created.taskId,
          providerRequestId: created.requestId,
          errorCode: null,
        });
      } catch (error) {
        if (
          error instanceof ManusV2ApiError &&
          error.operation === "task.create" &&
          error.outcomeUnknown
        ) {
          const reconciled = await reconcileUnknownCreate({
            operation: reserved.operation,
            task: reserved.task,
            credential: req.frontmindCredential,
          }).catch(() => reserved);
          res
            .status(202)
            .json(await taskDto(reconciled.operation, reconciled.task));
          return;
        }
        await updateTaskState({
          operationId: reserved.operation.id,
          localTaskId: reserved.task.id,
          status:
            error instanceof ManusV2ApiError && error.outcomeUnknown
              ? "attention_required"
              : "failed",
          providerState:
            error instanceof ManusV2ApiError && error.outcomeUnknown
              ? "attention_required"
              : "failed",
          errorCode:
            error instanceof ManusV2ApiError
              ? error.code
              : "TASK_CREATE_FAILED",
        });
      }
    }
    const synced = await syncTask({
      userId: req.frontmindUser.id,
      localTaskId: reserved.task.id,
    });
    res
      .status(reserved.acquired ? 201 : 200)
      .json(await taskDto(synced.operation, synced.task));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/tasks/:localTaskId/messages", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const value = taskMessageSchema.parse(req.body ?? {});
    let owned = await syncTask({
      userId: req.frontmindUser.id,
      localTaskId: req.params.localTaskId,
    });
    const credential = await getDecryptedCredentialForAccountById(
      req.frontmindUser.id,
      owned.operation.apiCredentialId,
    );
    if (
      !credential ||
      credential.version !== owned.operation.credentialVersion
    ) {
      throw new ChatV2HttpError("TASK_CREDENTIAL_UNAVAILABLE", 409);
    }
    await sendProviderMessage({
      ...owned,
      credential,
      clientRequestId: value.clientRequestId,
      prompt: value.prompt,
      localAssetIds: value.localAssetIds,
    });
    owned = await syncTask({
      userId: req.frontmindUser.id,
      localTaskId: req.params.localTaskId,
    });
    res.json(await taskDto(owned.operation, owned.task));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks/:localTaskId", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const owned = await syncTask({
      userId: req.frontmindUser.id,
      localTaskId: req.params.localTaskId,
    });
    res.json(await taskDto(owned.operation, owned.task));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const rows = await (
      await requireDb()
    )
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentOperations)
      .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
      .where(
        and(
          eq(agentOperations.scope, "managed_user"),
          eq(agentOperations.accountUserId, req.frontmindUser.id),
          eq(agentOperations.contractName, CHAT_CONTRACT),
        ),
      )
      .orderBy(desc(agentOperations.createdAt))
      .limit(Math.min(100, Math.max(1, Number(req.query.limit) || 20)));
    res.json({
      data: await Promise.all(
        rows.map(({ operation, task }) => taskDto(operation, task)),
      ),
      first_id: rows[0]?.task.id ?? "",
      last_id: rows.at(-1)?.task.id ?? "",
      has_more: false,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  "/tasks/:localTaskId/actions/:localMessageId/confirm",
  async (req, res) => {
    try {
      if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
      assertGeneralAgentActor(req.frontmindUser);
      const value = actionSchema.parse(req.body ?? {});
      const owned = await findOwnedTask({
        userId: req.frontmindUser.id,
        localTaskId: req.params.localTaskId,
      });
      if (!owned.task.providerTaskId) {
        throw new ChatV2HttpError("TASK_NOT_READY", 409, true);
      }
      const localEvent = (
        await (
          await requireDb()
        )
          .select()
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.id, req.params.localMessageId),
              eq(agentEvents.taskId, owned.task.id),
            ),
          )
          .limit(1)
      )[0];
      const action =
        localEvent?.normalizedPayload?.action &&
        typeof localEvent.normalizedPayload.action === "object" &&
        !Array.isArray(localEvent.normalizedPayload.action)
          ? (localEvent.normalizedPayload.action as Record<string, unknown>)
          : null;
      const providerEventId = String(action?.eventId ?? "");
      if (!providerEventId) throw new ChatV2HttpError("ACTION_NOT_FOUND", 404);
      const credential = await getDecryptedCredentialForAccountById(
        req.frontmindUser.id,
        owned.operation.apiCredentialId,
      );
      if (
        !credential ||
        credential.version !== owned.operation.credentialVersion
      ) {
        throw new ChatV2HttpError("TASK_CREDENTIAL_UNAVAILABLE", 409);
      }
      const idempotencyId = `local-action:${hash(
        `${owned.task.id}\0${providerEventId}\0${value.clientRequestId}`,
      )}`;
      const db = await requireDb();
      const markerId = randomUUID();
      await db
        .insert(agentEvents)
        .values({
          id: markerId,
          taskId: owned.task.id,
          providerEventId: idempotencyId,
          eventType: "local_action_reservation",
          providerTimestampMs: Date.now(),
          normalizedPayload: {
            kind: "local_action_reservation",
            requestHash: requestHash(value.confirmationInput ?? {}),
            status: "reserved",
          },
        })
        .onDuplicateKeyUpdate({ set: { providerEventId: idempotencyId } });
      const marker = (
        await db
          .select()
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.taskId, owned.task.id),
              eq(agentEvents.providerEventId, idempotencyId),
            ),
          )
          .limit(1)
      )[0]!;
      if (
        marker.normalizedPayload.requestHash !==
        requestHash(value.confirmationInput ?? {})
      ) {
        throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
      }
      if (marker.id === markerId) {
        try {
          await clientFor(
            credential.apiKey,
            req.frontmindUser.id,
          ).confirmAction({
            taskId: owned.task.providerTaskId,
            eventId: providerEventId,
            confirmationInput: value.confirmationInput,
          });
          await db
            .update(agentEvents)
            .set({
              normalizedPayload: {
                ...marker.normalizedPayload,
                status: "acknowledged",
              },
            })
            .where(eq(agentEvents.id, marker.id));
        } catch (error) {
          if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
            await db
              .update(agentEvents)
              .set({
                normalizedPayload: {
                  ...marker.normalizedPayload,
                  status: "outcome_unknown",
                },
              })
              .where(eq(agentEvents.id, marker.id));
            await updateTaskState({
              operationId: owned.operation.id,
              localTaskId: owned.task.id,
              status: "attention_required",
              providerState: "attention_required",
              errorCode: "ACTION_OUTCOME_UNKNOWN",
            });
          } else {
            throw error;
          }
        }
      }
      const synced = await syncTask({
        userId: req.frontmindUser.id,
        localTaskId: owned.task.id,
      });
      res.json(await taskDto(synced.operation, synced.task));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get("/artifacts/:artifactId/content", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    const row = (
      await (
        await requireDb()
      )
        .select({ artifact: artifacts })
        .from(artifacts)
        .innerJoin(
          agentOperations,
          eq(artifacts.operationId, agentOperations.id),
        )
        .where(
          and(
            eq(artifacts.id, req.params.artifactId),
            eq(agentOperations.scope, "managed_user"),
            eq(agentOperations.accountUserId, req.frontmindUser.id),
          ),
        )
        .limit(1)
    )[0]?.artifact;
    const stored = row ? await readStoredPresalesFile(row.id) : null;
    if (!row || !stored) throw new ChatV2HttpError("ARTIFACT_NOT_FOUND", 404);
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Length", String(row.sizeBytes));
    res.setHeader("ETag", `\"sha256:${row.contentSha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    );
    stored.createReadStream().pipe(res);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
