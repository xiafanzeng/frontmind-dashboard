import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import axios from "axios";
import { Router, json, type Response } from "express";
import { z } from "zod";

import { projectOrderProjectIdSchema } from "../shared/project-order-registry";
import { managedAgentProfileModel } from "../shared/manus-agent-profile";
import {
  assertActiveWebsiteProject,
  bindWebsiteLocalAssetToProject,
  ensureWebsiteAgentOperation,
  ensureWebsiteAgentRepairOperation,
  expireWebsiteProviderFileLease,
  persistWebsiteAgentTaskState,
  persistWebsiteArtifact,
  persistWebsiteLocalAsset,
  persistWebsiteProviderFileLease,
  releaseWebsiteArtifactReference,
  releaseWebsiteLocalAssetReference,
} from "./agent-operation-service";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { FILE_CONTENT_RETENTION_MS } from "./file-content-retention";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  type ManusV2CreatedFile,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  PRESALES_V2_CAPABILITIES,
  PRESALES_V2_CONTRACT_HASHES,
  PRESALES_V2_CONTRACT_VERSION,
  PresalesV2ContractError,
  presalesV2ContractSchema,
  presalesV2StructuredPrompt,
  resolvePresalesV2Contract,
  type PresalesV2Contract,
} from "./presales-v2-contracts";
import {
  acquirePresalesV2Asset,
  acquirePresalesV2Task,
  bindPresalesV2AssetProject,
  hashPresalesV2IdempotencyKey,
  hashPresalesV2Request,
  markPresalesV2ArtifactDeleted,
  readPresalesV2Artifact,
  readPresalesV2Asset,
  readPresalesV2Task,
  readPresalesV2ProjectResourceSnapshot,
  recordPresalesV2Artifact,
  updatePresalesV2Asset,
  updatePresalesV2Task as updatePresalesV2TaskStore,
  type PresalesV2Artifact,
  type PresalesV2AssetRecord,
  type PresalesV2TaskRecord,
} from "./presales-v2-store";
import {
  removeStoredPresalesFile,
  readStoredPresalesFile,
  recordPresalesFileDescriptor,
  stagePresalesFileContent,
} from "./presales-file-store";
import {
  presalesMonitorRouter,
  getDedicatedMonitorCredentialReadiness,
} from "./presales-monitor";
import {
  getActivePresalesCredential,
  getPresalesCredentialById,
} from "./presales-service";
import { isFrontMindPublicUrlConfigured } from "./public-url";
import { requirePresalesServiceToken } from "./presales-service-auth";
import { assertPresalesV2ZipSafe } from "./presales-v2-zip-safety";
import { getUpstreamBaseUrl } from "./upstream-config";
import { WebsiteProjectInactiveError } from "./website-project-lifecycle";

const router = Router();
const jsonParser = json({ limit: "4mb" });
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_TASK_ASSET_BYTES = 100 * 1024 * 1024;
const RESULT_GRACE_MS = 120_000;
const REPAIR_RECONCILE_MS = 5 * 60_000;

export function presalesV2PreparationFailureState(error: unknown): {
  status: "failed" | "attention_required";
  errorCode: string;
} {
  if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
    return {
      status: "attention_required",
      errorCode: "FILE_UPLOAD_OUTCOME_UNKNOWN",
    };
  }
  return { status: "failed", errorCode: "TASK_PREPARATION_FAILED" };
}

async function updatePresalesV2Task(
  localTaskId: string,
  update: (current: PresalesV2TaskRecord) => PresalesV2TaskRecord,
  providerEvents: ReadonlyArray<ManusV2MessageEvent> = [],
) {
  const record = await updatePresalesV2TaskStore(localTaskId, update);
  if (record) await persistWebsiteAgentTaskState(record, providerEvents);
  return record;
}

const assetCreateSchema = z
  .object({
    projectId: projectOrderProjectIdSchema.optional(),
    idempotencyKey: z.string().trim().min(16).max(512),
    filename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(255).optional(),
    sizeBytes: z.number().int().nonnegative().max(MAX_ASSET_BYTES).optional(),
  })
  .strict();

const taskCreateSchema = z
  .object({
    projectId: projectOrderProjectIdSchema,
    prompt: z.string().trim().min(1).max(2_000_000),
    localAssetIds: z
      .array(
        z
          .object({
            localAssetId: z.string().uuid(),
            filename: z.string().trim().min(1).max(512),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    idempotencyKey: z.string().trim().min(16).max(512),
    contract: presalesV2ContractSchema,
  })
  .strict();

const taskRepairSchema = z
  .object({
    idempotencyKey: z.string().trim().min(16).max(512),
  })
  .strict();

export function parsePresalesV2TaskCreate(value: unknown) {
  return taskCreateSchema.parse(value);
}

export function parsePresalesV2TaskRepair(value: unknown) {
  return taskRepairSchema.parse(value);
}

export async function bindPresalesV2TaskAssetProject(
  input: {
    asset: PresalesV2AssetRecord;
    projectId: string;
  },
  dependencies: {
    bindLocalRecord: typeof bindPresalesV2AssetProject;
    bindDurableRecord: typeof bindWebsiteLocalAssetToProject;
  } = {
    bindLocalRecord: bindPresalesV2AssetProject,
    bindDurableRecord: bindWebsiteLocalAssetToProject,
  },
) {
  if (
    input.asset.projectId !== null &&
    input.asset.projectId !== input.projectId
  ) {
    throw new PresalesV2HttpError("ASSET_PROJECT_CONFLICT", 409);
  }
  const asset =
    input.asset.projectId === null
      ? await dependencies.bindLocalRecord(
          input.asset.localAssetId,
          input.projectId,
        )
      : input.asset;
  if (!asset || asset.projectId !== input.projectId) {
    throw new PresalesV2HttpError("ASSET_PROJECT_CONFLICT", 409);
  }
  // The filesystem index and SQL ledger are two durable authorities. Always
  // replay the idempotent SQL bind even when the filesystem side was already
  // committed, so a crash between those writes cannot strand an unowned row.
  await dependencies.bindDurableRecord({
    localAssetId: asset.localAssetId,
    projectId: input.projectId,
  });
  return asset;
}

const artifactCreateSchema = z
  .object({
    projectId: projectOrderProjectIdSchema,
    idempotencyKey: z.string().trim().min(16).max(512),
    sourceLocalAssetId: z.string().uuid(),
    filename: z.string().trim().min(1).max(512),
    mimeType: z.literal("application/zip"),
    bytes: z.number().int().positive().max(MAX_ASSET_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.literal("website-final-knowledge-base"),
  })
  .strict();

class PresalesV2HttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly operationId?: string,
  ) {
    super(code);
    this.name = "PresalesV2HttpError";
  }
}

function sendError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: { code: "INVALID_REQUEST", status: 400, retryable: false },
    });
    return;
  }
  if (error instanceof PresalesV2ContractError) {
    res.status(error.status).json({
      error: { code: error.code, status: error.status, retryable: false },
    });
    return;
  }
  if (error instanceof WebsiteProjectInactiveError) {
    res.status(410).json({
      error: { code: "PROJECT_DELETED", status: 410, retryable: false },
    });
    return;
  }
  if (error instanceof PresalesV2HttpError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        status: error.status,
        retryable: error.retryable,
        ...(error.operationId ? { operationId: error.operationId } : {}),
      },
    });
    return;
  }
  if (error instanceof ManusV2ApiError) {
    const status = error.status === 401 || error.status === 403 ? 428 : 502;
    res.status(status).json({
      error: {
        code:
          error.status === 401 || error.status === 403
            ? "INVALID_CREDENTIAL"
            : error.code,
        status,
        retryable: error.retryable,
      },
    });
    return;
  }
  console.error("[Presales v2] request failed", {
    diagnosticCode: "PRESALES_V2_INTERNAL_ERROR",
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", status: 500, retryable: false },
  });
}

export function presalesV2PublicTask(record: PresalesV2TaskRecord) {
  return {
    localTaskId: record.localTaskId,
    operationId: record.operationId,
    status: record.status,
    safeEvents: presalesV2SafeEvents(record.localTaskId, record.safeEvents),
    ...(record.status === "succeeded"
      ? {
          result: {
            ...(record.structuredResult !== null
              ? { structuredResult: record.structuredResult }
              : {}),
            artifacts: record.artifacts,
          },
        }
      : {}),
    ...(record.errorCode
      ? { error: { code: record.errorCode, retryable: false } }
      : {}),
  };
}

async function requireActiveCredential() {
  const credential = await getActivePresalesCredential();
  if (!credential) {
    throw new PresalesV2HttpError("INVALID_CREDENTIAL", 428);
  }
  return credential;
}

async function clientForTask(record: PresalesV2TaskRecord) {
  const credential = await getPresalesCredentialById(record.credentialId);
  if (!credential || credential.version !== record.credentialVersion) {
    throw new PresalesV2HttpError(
      "TASK_CREDENTIAL_UNAVAILABLE",
      410,
      false,
      record.operationId,
    );
  }
  return new ManusV2Client({
    apiKey: credential.apiKey,
    baseUrl: getUpstreamBaseUrl(),
    rateLimitScope: "website-managed-provider",
  });
}

async function readStoredBytes(localAssetId: string) {
  const stored = await readStoredPresalesFile(localAssetId);
  if (!stored) throw new PresalesV2HttpError("ASSET_CONTENT_MISSING", 409);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stored.createReadStream()) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_TASK_ASSET_BYTES) {
      throw new PresalesV2HttpError("ASSET_SET_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks);
  if (stored.sha256) {
    const observed = createHash("sha256").update(value).digest("hex");
    if (observed !== stored.sha256) {
      throw new PresalesV2HttpError("ASSET_HASH_MISMATCH", 409);
    }
  }
  return { stored, bytes: value };
}

async function updatePresalesV2TaskCleanup(
  localTaskId: string,
  update: (current: PresalesV2TaskRecord) => PresalesV2TaskRecord,
) {
  const record = await updatePresalesV2TaskStore(localTaskId, update);
  if (record) {
    // Local tombstoning is authoritative for project deletion. The SQL audit
    // projection is replayable and must not keep local refs alive indefinitely
    // during a credential or database outage.
    await persistWebsiteAgentTaskState(record, []).catch(() => undefined);
  }
  return record;
}

export function presalesV2RemoteCleanupFailure(error: unknown): {
  disposition: "terminal_unavailable" | "outcome_unknown";
  errorCode: string;
} {
  const terminalUnavailable =
    (error instanceof PresalesV2HttpError &&
      error.code === "TASK_CREDENTIAL_UNAVAILABLE") ||
    (error instanceof ManusV2ApiError &&
      ([401, 403, 404, 410].includes(error.status ?? 0) ||
        /(?:EXPIRED|NOT_FOUND|DELETED)/i.test(error.code)));
  return {
    disposition: terminalUnavailable
      ? "terminal_unavailable"
      : "outcome_unknown",
    errorCode:
      error instanceof PresalesV2HttpError || error instanceof ManusV2ApiError
        ? error.code
        : "REMOTE_CLEANUP_OUTCOME_UNKNOWN",
  };
}

async function deletePresalesV2TaskResources(
  task: PresalesV2TaskRecord,
  options: { projectCleanup: boolean },
) {
  let current = task;
  let deletedFiles = 0;
  if (current.providerDeleteAt) {
    if (options.projectCleanup && !current.projectCleanupAt) {
      await updatePresalesV2TaskCleanup(current.localTaskId, (record) => ({
        ...record,
        projectCleanupAt: new Date().toISOString(),
      }));
    }
    return { deletedFiles };
  }
  let cleanupDisposition: NonNullable<
    PresalesV2TaskRecord["providerCleanupDisposition"]
  > = "completed";
  let cleanupErrorCode: string | null = null;
  const observeCleanupError = (error: unknown) => {
    const failure = presalesV2RemoteCleanupFailure(error);
    if (failure.disposition === "terminal_unavailable") {
      if (cleanupDisposition !== "outcome_unknown") {
        cleanupDisposition = "terminal_unavailable";
      }
    } else {
      cleanupDisposition = "outcome_unknown";
    }
    cleanupErrorCode ??= failure.errorCode;
  };

  let client: ManusV2Client | null = null;
  if (current.providerTaskId || current.providerFileLeases.length > 0) {
    try {
      client = await clientForTask(current);
    } catch (error) {
      observeCleanupError(error);
    }
  } else if (!["succeeded", "failed", "cancelled"].includes(current.status)) {
    // A provider-less queued record can be left behind by an interrupted
    // create. Project/task deletion tombstones it locally once; it must not
    // hold project cleanup open forever or cause a blind create/delete retry.
    cleanupDisposition = "outcome_unknown";
    cleanupErrorCode = "PROVIDER_TASK_ID_UNAVAILABLE";
  }

  let providerTaskMayBeDeleted = Boolean(client && current.providerTaskId);
  if (
    client &&
    current.providerTaskId &&
    !["succeeded", "failed", "cancelled"].includes(current.status)
  ) {
    try {
      await client.stopTask(current.providerTaskId);
      current =
        (await updatePresalesV2TaskCleanup(current.localTaskId, (record) => ({
          ...record,
          status: "cancelled",
          errorCode: null,
        }))) ?? current;
    } catch (error) {
      observeCleanupError(error);
      // A stop response may have been lost. Do not issue a second side-effect
      // against the same task during this cleanup attempt.
      providerTaskMayBeDeleted = false;
    }
  }

  for (const lease of [...current.providerFileLeases]) {
    if (client) {
      try {
        await client.deleteFile(lease.providerFileId);
      } catch (error) {
        observeCleanupError(error);
      }
    }
    await expireWebsiteProviderFileLease(lease.providerFileId).catch(
      () => undefined,
    );
    current =
      (await updatePresalesV2TaskCleanup(current.localTaskId, (record) => ({
        ...record,
        providerFileLeases: record.providerFileLeases.filter(
          (candidate) => candidate.providerFileId !== lease.providerFileId,
        ),
      }))) ?? current;
    deletedFiles += 1;
  }

  if (client && current.providerTaskId && providerTaskMayBeDeleted) {
    try {
      await client.deleteTask(current.providerTaskId);
    } catch (error) {
      observeCleanupError(error);
    }
  }
  const cleanedAt = new Date().toISOString();
  await updatePresalesV2TaskCleanup(current.localTaskId, (record) => ({
    ...record,
    status: "cancelled",
    errorCode: null,
    providerDeleteAt: cleanedAt,
    providerCleanupDisposition: cleanupDisposition,
    providerCleanupErrorCode: cleanupErrorCode,
    ...(options.projectCleanup ? { projectCleanupAt: cleanedAt } : {}),
  }));
  return { deletedFiles };
}

function localSafeEventId(localTaskId: string, providerEventId: string) {
  return `safeevt_${createHash("sha256")
    .update(`${localTaskId}\0${providerEventId}`, "utf8")
    .digest("hex")}`;
}

export function presalesV2SafeEvents(
  localTaskId: string,
  events: ReadonlyArray<Pick<ManusV2MessageEvent, "id" | "type" | "timestamp">>,
) {
  return events.map((event) => ({
    id: /^safeevt_[a-f0-9]{64}$/u.test(event.id)
      ? event.id
      : localSafeEventId(localTaskId, event.id),
    type: event.type,
    timestamp: event.timestamp,
  }));
}

function withRepairStatus(
  record: PresalesV2TaskRecord,
  status: PresalesV2TaskRecord["status"],
) {
  if (!record.repair) return record;
  return {
    ...record,
    repair: {
      ...record.repair,
      status,
      updatedAt: new Date().toISOString(),
    },
  };
}

function repairEvents(
  record: PresalesV2TaskRecord,
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  if (!record.repair) return [...events];
  const baseline = new Set(record.repair.baselineEventIds);
  return events.filter((event) => !baseline.has(event.id));
}

function repairMarkerObserved(
  repair: NonNullable<PresalesV2TaskRecord["repair"]>,
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  return events.some((event) => {
    try {
      return JSON.stringify(event).includes(repair.operationMarker);
    } catch {
      return false;
    }
  });
}

function presalesV2RepairPrompt(
  contract: PresalesV2Contract,
  operationMarker: string,
) {
  return [
    operationMarker,
    presalesV2StructuredPrompt(contract),
    "The previous structured result failed FrontMind's strict local business validation.",
    "Return one corrected, complete object for the same business request.",
    "Do not add commentary, Markdown, code fences, attachments, or a second object.",
  ].join("\n\n");
}

export function acceptedPresalesV2StructuredResult(
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  const ordered = [...events].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.id.localeCompare(left.id),
  );
  for (const event of ordered) {
    if (event.type !== "structured_output_result") continue;
    const classified = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (classified.kind !== "accepted") continue;
    const value =
      classified.value &&
      typeof classified.value === "object" &&
      !Array.isArray(classified.value)
        ? (classified.value as Record<string, unknown>)
        : null;
    if (value) return value;
  }
  return null;
}

type AssistantAttachment = {
  eventId: string;
  attachmentIndex: number;
  filename: string;
  contentType: string;
  url: string;
};

export function presalesV2AssistantAttachments(
  events: ReadonlyArray<ManusV2MessageEvent>,
): AssistantAttachment[] {
  const result: AssistantAttachment[] = [];
  for (const event of events) {
    if (event.type !== "assistant_message") continue;
    const message =
      event.assistant_message &&
      typeof event.assistant_message === "object" &&
      !Array.isArray(event.assistant_message)
        ? (event.assistant_message as Record<string, unknown>)
        : null;
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments
      : [];
    attachments.forEach((raw, attachmentIndex) => {
      const item =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      if (
        !item ||
        typeof item.filename !== "string" ||
        typeof item.url !== "string" ||
        typeof item.content_type !== "string"
      ) {
        return;
      }
      result.push({
        eventId: event.id,
        attachmentIndex,
        filename: item.filename.slice(0, 512),
        contentType: item.content_type.slice(0, 255),
        url: item.url,
      });
    });
  }
  return result;
}

function artifactIdFor(input: {
  providerTaskId: string;
  eventId: string;
  attachmentIndex: number;
}) {
  return `artifact_${createHash("sha256")
    .update(
      `${input.providerTaskId}\0${input.eventId}\0${input.attachmentIndex}`,
      "utf8",
    )
    .digest("hex")}`;
}

async function firstBytes(stream: Readable, count: number) {
  for await (const raw of stream) {
    return (Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).subarray(0, count);
  }
  return Buffer.alloc(0);
}

async function readStreamBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new PresalesV2HttpError("ARTIFACT_BYTES_EXCEEDED", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function presalesV2ArtifactBeforeRedirect(
  options: Record<string, unknown>,
) {
  try {
    safeExternalRequestOptions.beforeRedirect(options);
  } catch {
    throw new PresalesV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
  if (String(options.protocol ?? "") !== "https:") {
    throw new PresalesV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
}

async function localizeArtifact(input: {
  record: PresalesV2TaskRecord;
  attachment: AssistantAttachment;
}) {
  const providerTaskId = input.record.providerTaskId;
  if (!providerTaskId) throw new Error("PRESALES_V2_PROVIDER_TASK_MISSING");
  const artifactId = artifactIdFor({
    providerTaskId,
    eventId: input.attachment.eventId,
    attachmentIndex: input.attachment.attachmentIndex,
  });
  const existing = await readPresalesV2Artifact(artifactId);
  if (existing && (await readStoredPresalesFile(artifactId))) {
    await persistWebsiteArtifact(existing);
    return existing;
  }

  const normalizedUrl = assertSafeExternalUrl(input.attachment.url);
  if (new URL(normalizedUrl).protocol !== "https:") {
    throw new PresalesV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
  const response = await axios.get<Readable>(normalizedUrl, {
    ...safeExternalRequestOptions,
    // The generic egress helper permits both protocols for unrelated callers.
    // Provider artifacts are HTTPS-only, including every redirect hop.
    beforeRedirect: presalesV2ArtifactBeforeRedirect,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_ASSET_BYTES,
    maxBodyLength: MAX_ASSET_BYTES,
    validateStatus: () => true,
  });
  if (response.status !== 200) {
    response.data.destroy();
    throw new PresalesV2HttpError("ARTIFACT_DOWNLOAD_FAILED", 502, true);
  }
  const responseType = String(
    response.headers["content-type"] ?? input.attachment.contentType,
  )
    .split(";", 1)[0]!
    .trim()
    .toLowerCase()
    .slice(0, 255);
  if (
    input.record.contract.name === "website.knowledge-base-candidate" &&
    responseType !== "application/zip" &&
    responseType !== "application/octet-stream"
  ) {
    response.data.destroy();
    throw new PresalesV2HttpError("ARTIFACT_MIME_INVALID", 422);
  }
  await recordPresalesFileDescriptor({
    fileId: artifactId,
    filename: input.attachment.filename,
    mimeType: responseType,
  });
  const staged = await stagePresalesFileContent({
    fileId: artifactId,
    stream: response.data,
    maxBytes: MAX_ASSET_BYTES,
  });
  try {
    if (input.record.contract.name === "website.knowledge-base-candidate") {
      const magic = await firstBytes(staged.createReadStream(), 4);
      if (
        magic.length < 4 ||
        magic[0] !== 0x50 ||
        magic[1] !== 0x4b ||
        ![0x03, 0x05, 0x07].includes(magic[2]!) ||
        ![0x04, 0x06, 0x08].includes(magic[3]!)
      ) {
        throw new PresalesV2HttpError("ARTIFACT_MAGIC_INVALID", 422);
      }
      try {
        await assertPresalesV2ZipSafe(
          await readStreamBuffer(staged.createReadStream(), MAX_ASSET_BYTES),
        );
      } catch (error) {
        if (error instanceof PresalesV2HttpError) throw error;
        throw new PresalesV2HttpError("ARTIFACT_ZIP_UNSAFE", 422);
      }
    }
    const now = Date.now();
    await staged.commit({
      filename: input.attachment.filename,
      mimeType: responseType,
      uploadedAt: now,
      contentExpiresAt: now + FILE_CONTENT_RETENTION_MS,
    });
  } catch (error) {
    await staged.discard().catch(() => undefined);
    throw error;
  }
  const artifact = await recordPresalesV2Artifact({
    schemaVersion: 2,
    localTaskId: input.record.localTaskId,
    operationId: input.record.operationId,
    projectId: input.record.projectId,
    sourceEventId: input.attachment.eventId,
    attachmentIndex: input.attachment.attachmentIndex,
    artifactId,
    filename: input.attachment.filename,
    mimeType: responseType,
    bytes: staged.sizeBytes,
    sha256: staged.sha256,
    createdAt: new Date().toISOString(),
  });
  await persistWebsiteArtifact(artifact);
  return artifact;
}

async function reconcileUnknownCreate(record: PresalesV2TaskRecord) {
  if (record.providerTaskId || record.status !== "queued") return record;
  const client = await clientForTask(record);
  const match = await client.findCreatedTask({
    title: record.providerTitle,
    operationToken: record.operationToken,
    createdAfterSeconds: Math.floor(Date.parse(record.createdAt) / 1_000) - 60,
    createdBeforeSeconds: Math.floor(Date.now() / 1_000) + 60,
  });
  if (match.matches.length > 1) {
    return (
      (await updatePresalesV2Task(record.localTaskId, (current) => ({
        ...current,
        status: "attention_required",
        errorCode: "CREATE_RECONCILE_CONFLICT",
      }))) ?? record
    );
  }
  if (match.unique) {
    return (
      (await updatePresalesV2Task(record.localTaskId, (current) => ({
        ...current,
        providerTaskId: match.unique!.id,
        status: "running",
      }))) ?? record
    );
  }
  if (Date.now() >= Date.parse(record.createSearchUntil)) {
    return (
      (await updatePresalesV2Task(record.localTaskId, (current) => ({
        ...current,
        status: "attention_required",
        errorCode: "CREATE_OUTCOME_UNKNOWN",
      }))) ?? record
    );
  }
  return record;
}

async function reconcileTask(localTaskId: string) {
  let record = await readPresalesV2Task(localTaskId);
  if (!record) throw new PresalesV2HttpError("TASK_NOT_FOUND", 404);
  if (
    ["succeeded", "failed", "cancelled", "attention_required"].includes(
      record.status,
    )
  ) {
    return record;
  }
  if (record.repair?.status === "queued" && !record.repair.sendAttemptedAt) {
    return record;
  }
  record = await reconcileUnknownCreate(record);
  if (!record.providerTaskId || record.status === "attention_required")
    return record;

  const client = await clientForTask(record);
  const events = await client.listAllMessages({
    taskId: record.providerTaskId,
    order: "desc",
  });
  const eventSummary = presalesV2SafeEvents(localTaskId, events);
  if (
    record.repair?.status === "result_pending" &&
    !repairMarkerObserved(record.repair, events)
  ) {
    const exhausted = Date.now() >= Date.parse(record.repair.reconcileUntil);
    return (
      (await updatePresalesV2Task(
        localTaskId,
        (current) =>
          withRepairStatus(
            {
              ...current,
              status: exhausted ? "attention_required" : "result_pending",
              errorCode: exhausted ? "REPAIR_OUTCOME_UNKNOWN" : null,
              safeEvents: eventSummary,
            },
            exhausted ? "attention_required" : "result_pending",
          ),
        events,
      )) ?? record
    );
  }
  const relevantEvents = repairEvents(record, events);
  const state = latestManusV2TaskState(relevantEvents);
  if (state === "waiting") {
    return (
      (await updatePresalesV2Task(
        localTaskId,
        (current) =>
          withRepairStatus(
            {
              ...current,
              status: "attention_required",
              errorCode: "PROVIDER_ACTION_REQUIRED",
              safeEvents: eventSummary,
            },
            "attention_required",
          ),
        events,
      )) ?? record
    );
  }
  if (state === "error") {
    return (
      (await updatePresalesV2Task(
        localTaskId,
        (current) =>
          withRepairStatus(
            {
              ...current,
              status: "failed",
              errorCode: "PROVIDER_TASK_FAILED",
              safeEvents: eventSummary,
            },
            "failed",
          ),
        events,
      )) ?? record
    );
  }
  if (record.contract.name === "website.knowledge-base-candidate") {
    const candidates = presalesV2AssistantAttachments(events).filter(
      (item) =>
        item.filename.toLowerCase().endsWith(".zip") ||
        item.contentType.toLowerCase() === "application/zip",
    );
    if (state === "stopped" && candidates.length === 1) {
      const artifact = await localizeArtifact({
        record,
        attachment: candidates[0]!,
      });
      return (
        (await updatePresalesV2Task(
          localTaskId,
          (current) => ({
            ...current,
            status: "succeeded",
            safeEvents: eventSummary,
            artifacts: [
              {
                artifactId: artifact.artifactId,
                filename: artifact.filename,
                mimeType: artifact.mimeType,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
              },
            ],
          }),
          events,
        )) ?? record
      );
    }
    if (state === "stopped" && candidates.length > 1) {
      return (
        (await updatePresalesV2Task(
          localTaskId,
          (current) => ({
            ...current,
            status: "failed",
            errorCode: "ARTIFACT_CARDINALITY_INVALID",
            safeEvents: eventSummary,
          }),
          events,
        )) ?? record
      );
    }
  } else {
    const structuredResult = acceptedPresalesV2StructuredResult(relevantEvents);
    if (state === "stopped" && structuredResult !== null) {
      return (
        (await updatePresalesV2Task(
          localTaskId,
          (current) =>
            withRepairStatus(
              {
                ...current,
                status: "succeeded",
                errorCode: null,
                safeEvents: eventSummary,
                structuredResult,
              },
              "succeeded",
            ),
          events,
        )) ?? record
      );
    }
  }
  if (state === "stopped") {
    const resultDeadlineAt = record.resultDeadlineAt
      ? Date.parse(record.resultDeadlineAt)
      : Date.now() + RESULT_GRACE_MS;
    return (
      (await updatePresalesV2Task(
        localTaskId,
        (current) => {
          const status =
            Date.now() >= resultDeadlineAt ? "failed" : "result_pending";
          return withRepairStatus(
            {
              ...current,
              status,
              errorCode:
                status === "failed" ? "RESULT_INVALID_OR_MISSING" : null,
              resultDeadlineAt: new Date(resultDeadlineAt).toISOString(),
              safeEvents: eventSummary,
            },
            status,
          );
        },
        events,
      )) ?? record
    );
  }
  return (
    (await updatePresalesV2Task(
      localTaskId,
      (current) =>
        withRepairStatus(
          {
            ...current,
            status: "running",
            errorCode: null,
            safeEvents: eventSummary,
          },
          "running",
        ),
      events,
    )) ?? record
  );
}

async function dispatchPresalesV2Repair(
  record: PresalesV2TaskRecord,
  contract: PresalesV2Contract,
) {
  if (!record.providerTaskId || !record.repair) {
    throw new PresalesV2HttpError("TASK_REPAIR_NOT_AVAILABLE", 409);
  }
  let claimed = false;
  const attemptedAt = new Date().toISOString();
  let current =
    (await updatePresalesV2Task(record.localTaskId, (candidate) => {
      if (!candidate.repair || candidate.repair.sendAttemptedAt)
        return candidate;
      claimed = true;
      return {
        ...candidate,
        status: "result_pending",
        structuredResult: null,
        errorCode: null,
        resultDeadlineAt: null,
        repair: {
          ...candidate.repair,
          status: "result_pending",
          sendAttemptedAt: attemptedAt,
          updatedAt: attemptedAt,
        },
      };
    })) ?? record;
  if (!claimed) return reconcileTask(record.localTaskId);

  const client = await clientForTask(current);
  try {
    const sent = await client.sendMessage({
      taskId: current.providerTaskId!,
      prompt: presalesV2RepairPrompt(contract, current.repair!.operationMarker),
      structuredOutputSchema: contract.structuredOutputSchema!,
    });
    current =
      (await updatePresalesV2Task(current.localTaskId, (candidate) => ({
        ...candidate,
        status: "running",
        structuredResult: null,
        errorCode: null,
        repair: {
          ...candidate.repair!,
          status: "running",
          providerRequestId: sent.requestId,
          updatedAt: new Date().toISOString(),
        },
      }))) ?? current;
  } catch (error) {
    const outcomeUnknown =
      error instanceof ManusV2ApiError && error.outcomeUnknown;
    current =
      (await updatePresalesV2Task(current.localTaskId, (candidate) => ({
        ...candidate,
        status: outcomeUnknown ? "result_pending" : "failed",
        structuredResult: null,
        errorCode: outcomeUnknown ? null : "TASK_REPAIR_FAILED",
        repair: {
          ...candidate.repair!,
          status: outcomeUnknown ? "result_pending" : "failed",
          updatedAt: new Date().toISOString(),
        },
      }))) ?? current;
  }
  return current;
}

router.use(requirePresalesServiceToken);
router.use("/monitor-runs", presalesMonitorRouter);

router.get("/status", async (req, res) => {
  try {
    const [credential, monitor] = await Promise.all([
      getActivePresalesCredential(),
      getDedicatedMonitorCredentialReadiness(process.env, {
        forceRefresh: req.query.monitorCredentialProbe === "fresh",
      }),
    ]);
    res.json({
      ok: Boolean(credential) && monitor.authenticated,
      credentialConfigured: Boolean(credential),
      monitorCredentialConfigured: monitor.configured,
      monitorCredentialAuthenticated: monitor.authenticated,
      publicUrlConfigured: isFrontMindPublicUrlConfigured(),
      presalesContractVersion: PRESALES_V2_CONTRACT_VERSION,
      capabilities: PRESALES_V2_CAPABILITIES,
      contractHashes: PRESALES_V2_CONTRACT_HASHES,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/assets", jsonParser, async (req, res) => {
  try {
    const input = assetCreateSchema.parse(req.body ?? {});
    const requestHash = hashPresalesV2Request({
      projectId: input.projectId ?? null,
      filename: input.filename,
      mimeType: input.mimeType ?? "application/octet-stream",
      sizeBytes: input.sizeBytes ?? null,
    });
    const acquired = await acquirePresalesV2Asset({
      idempotencyKey: input.idempotencyKey,
      requestHash,
      projectId: input.projectId ?? null,
      filename: input.filename,
      mimeType: input.mimeType ?? "application/octet-stream",
      expectedBytes: input.sizeBytes ?? null,
    });
    if (acquired.state === "conflict") {
      throw new PresalesV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    await recordPresalesFileDescriptor({
      fileId: acquired.record.localAssetId,
      filename: acquired.record.filename,
      mimeType: acquired.record.mimeType,
      ...(acquired.record.expectedBytes !== null
        ? { sizeBytes: acquired.record.expectedBytes }
        : {}),
    });
    res.status(acquired.state === "acquired" ? 201 : 200).json({
      localAssetId: acquired.record.localAssetId,
      filename: acquired.record.filename,
      status: acquired.record.status,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/assets/:localAssetId/content", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    if (!asset || asset.status === "deleted") {
      throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    }
    if (asset.status === "uploaded") {
      res.status(200).json({
        localAssetId: asset.localAssetId,
        status: asset.status,
        bytes: asset.bytes,
        sha256: asset.sha256,
      });
      return;
    }
    const staged = await stagePresalesFileContent({
      fileId: asset.localAssetId,
      stream: req,
      maxBytes: MAX_ASSET_BYTES,
    });
    if (
      asset.expectedBytes !== null &&
      staged.sizeBytes !== asset.expectedBytes
    ) {
      await staged.discard();
      throw new PresalesV2HttpError("ASSET_SIZE_MISMATCH", 409);
    }
    const now = Date.now();
    await staged.commit({
      filename: asset.filename,
      mimeType: asset.mimeType,
      uploadedAt: now,
      contentExpiresAt: now + FILE_CONTENT_RETENTION_MS,
    });
    const updated = await updatePresalesV2Asset(
      asset.localAssetId,
      (current) => ({
        ...current,
        status: "uploaded",
        bytes: staged.sizeBytes,
        sha256: staged.sha256,
      }),
    );
    await persistWebsiteLocalAsset(updated!);
    res.status(200).json({
      localAssetId: updated!.localAssetId,
      status: updated!.status,
      bytes: updated!.bytes,
      sha256: updated!.sha256,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/assets/:localAssetId", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    if (!asset || asset.status === "deleted") {
      throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    }
    res.json({
      localAssetId: asset.localAssetId,
      filename: asset.filename,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      sha256: asset.sha256,
      status: asset.status,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/assets/:localAssetId/content", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    const stored = await readStoredPresalesFile(req.params.localAssetId);
    if (!asset || asset.status !== "uploaded" || !stored) {
      throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    }
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader("Content-Length", String(stored.sizeBytes));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    await pipeline(stored.createReadStream(), res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
  }
});

router.delete("/assets/:localAssetId", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    if (!asset) throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    await releaseWebsiteLocalAssetReference(asset.localAssetId);
    await removeStoredPresalesFile(asset.localAssetId);
    await updatePresalesV2Asset(asset.localAssetId, (current) => ({
      ...current,
      status: "deleted",
      bytes: null,
      sha256: null,
    }));
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/tasks", jsonParser, async (req, res) => {
  let reserved: PresalesV2TaskRecord | null = null;
  try {
    const input = parsePresalesV2TaskCreate(req.body ?? {});
    const contract = resolvePresalesV2Contract(input.contract);
    await assertActiveWebsiteProject(input.projectId);
    const assets = await Promise.all(
      input.localAssetIds.map(async (item) => {
        let asset = await readPresalesV2Asset(item.localAssetId);
        if (
          !asset ||
          asset.status !== "uploaded" ||
          asset.filename !== item.filename
        ) {
          throw new PresalesV2HttpError("ASSET_NOT_AVAILABLE", 409);
        }
        asset = await bindPresalesV2TaskAssetProject({
          asset,
          projectId: input.projectId,
        });
        return asset;
      }),
    );
    const totalBytes = assets.reduce(
      (sum, asset) => sum + (asset.bytes ?? 0),
      0,
    );
    if (totalBytes > MAX_TASK_ASSET_BYTES) {
      throw new PresalesV2HttpError("ASSET_SET_TOO_LARGE", 413);
    }
    const credential = await requireActiveCredential();
    const requestHash = hashPresalesV2Request({
      projectId: input.projectId ?? null,
      prompt: input.prompt,
      localAssetIds: input.localAssetIds,
      contract: input.contract,
    });
    const acquired = await acquirePresalesV2Task({
      idempotencyKey: input.idempotencyKey,
      requestHash,
      projectId: input.projectId ?? null,
      contract: input.contract,
      profile: contract.profile,
      upstreamModel: managedAgentProfileModel(contract.profile),
      credentialId: credential.id,
      credentialVersion: credential.version,
    });
    if (acquired.state === "conflict") {
      throw new PresalesV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    reserved = acquired.record;
    await ensureWebsiteAgentOperation(reserved);
    if (acquired.state === "existing") {
      res
        .status(200)
        .json(presalesV2PublicTask(await reconcileTask(reserved.localTaskId)));
      return;
    }
    const client = new ManusV2Client({
      apiKey: credential.apiKey,
      baseUrl: getUpstreamBaseUrl(),
      rateLimitScope: "website-managed-provider",
    });
    const attachments = [];
    for (const asset of assets) {
      const local = await readStoredBytes(asset.localAssetId);
      const rememberLease = async (
        candidate: ManusV2CreatedFile,
        uploadState: PresalesV2TaskRecord["providerFileLeases"][number]["uploadState"],
        expiresAt = candidate.uploadExpiresAt,
      ) => {
        reserved =
          (await updatePresalesV2Task(reserved!.localTaskId, (current) => ({
            ...current,
            providerFileLeases: [
              ...current.providerFileLeases.filter(
                (lease) => lease.localAssetId !== asset.localAssetId,
              ),
              {
                localAssetId: asset.localAssetId,
                providerFileId: candidate.fileId,
                filename: candidate.filename,
                expiresAt,
                providerRequestId: candidate.requestId,
                uploadState,
              },
            ],
          }))) ?? reserved;
        const lease = reserved!.providerFileLeases.find(
          (item) => item.localAssetId === asset.localAssetId,
        );
        if (!lease) {
          throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
        }
        await persistWebsiteProviderFileLease({ record: reserved!, lease });
      };
      const uploaded = await client.uploadFile({
        filename: asset.filename,
        bytes: local.bytes,
        contentType: asset.mimeType,
        observer: {
          onCandidateCreated: (candidate) =>
            rememberLease(candidate, "reserved"),
          onPutStarted: (candidate) => rememberLease(candidate, "uploading"),
          onPutAccepted: (candidate) => rememberLease(candidate, "uploading"),
          onPutRejected: (candidate) => rememberLease(candidate, "failed"),
          onPutOutcomeUnknown: (candidate) =>
            rememberLease(candidate, "outcome_unknown"),
        },
      });
      attachments.push({
        file_id: uploaded.fileId,
        filename: uploaded.filename,
      });
      await rememberLease(uploaded, "uploaded", uploaded.detail.expiresAt);
    }
    const outputInstruction =
      contract.output === "structured"
        ? presalesV2StructuredPrompt(contract)
        : "Return exactly one complete candidate ZIP as the only assistant attachment. Do not return a Provider file id in text.";
    const prompt = [
      reserved.operationMarker,
      outputInstruction,
      input.prompt,
    ].join("\n\n");
    try {
      const created = await client.createTask({
        prompt,
        attachments,
        title: reserved.providerTitle,
        agentProfile: reserved.upstreamModel,
        locale: "zh-CN",
        hideInTaskList: true,
        ...(contract.output === "structured"
          ? { structuredOutputSchema: contract.structuredOutputSchema! }
          : {}),
      });
      reserved =
        (await updatePresalesV2Task(reserved.localTaskId, (current) => ({
          ...current,
          providerTaskId: created.taskId,
          providerRequestId: created.requestId,
          status: "running",
        }))) ?? reserved;
    } catch (error) {
      if (!(error instanceof ManusV2ApiError) || !error.outcomeUnknown) {
        reserved =
          (await updatePresalesV2Task(reserved.localTaskId, (current) => ({
            ...current,
            status: "failed",
            errorCode:
              error instanceof ManusV2ApiError
                ? error.code
                : "TASK_CREATE_FAILED",
          }))) ?? reserved;
      }
    }
    res.status(202).json(presalesV2PublicTask(reserved));
  } catch (error) {
    if (reserved && reserved.status === "queued") {
      const failure = presalesV2PreparationFailureState(error);
      reserved =
        (await updatePresalesV2Task(reserved.localTaskId, (current) => ({
          ...current,
          ...failure,
        })).catch(() => undefined)) ?? reserved;
      if (failure.status === "attention_required") {
        res.status(202).json(presalesV2PublicTask(reserved));
        return;
      }
    }
    sendError(res, error);
  }
});

router.post("/tasks/:localTaskId/repair", jsonParser, async (req, res) => {
  try {
    const input = parsePresalesV2TaskRepair(req.body ?? {});
    const initial = await readPresalesV2Task(req.params.localTaskId);
    if (!initial) throw new PresalesV2HttpError("TASK_NOT_FOUND", 404);
    const contract = resolvePresalesV2Contract(initial.contract);
    if (
      contract.output !== "structured" ||
      contract.structuredOutputSchema === null ||
      contract.profile !== initial.profile ||
      managedAgentProfileModel(contract.profile) !== initial.upstreamModel ||
      !initial.providerTaskId ||
      !initial.projectId
    ) {
      throw new PresalesV2HttpError("TASK_REPAIR_NOT_AVAILABLE", 409);
    }
    await assertActiveWebsiteProject(initial.projectId);
    const idempotencyHash = hashPresalesV2IdempotencyKey(input.idempotencyKey);
    const requestHash = hashPresalesV2Request({
      kind: "structured_output_repair_v1",
      localTaskId: initial.localTaskId,
      contract: initial.contract,
    });

    let baselineEventIds: string[] = [];
    if (!initial.repair) {
      const client = await clientForTask(initial);
      baselineEventIds = Array.from(
        new Set(
          (
            await client.listAllMessages({
              taskId: initial.providerTaskId,
              order: "desc",
            })
          ).map((event) => event.id),
        ),
      ).sort();
    }

    const now = new Date();
    let acquired = false;
    const reserved = await updatePresalesV2Task(
      initial.localTaskId,
      (current) => {
        if (current.repair) {
          if (
            current.repair.idempotencyHash !== idempotencyHash ||
            current.repair.requestHash !== requestHash ||
            ["succeeded", "failed", "cancelled", "attention_required"].includes(
              current.repair.status,
            )
          ) {
            throw new PresalesV2HttpError("TASK_REPAIR_EXHAUSTED", 409);
          }
          return current;
        }
        if (current.status !== "succeeded") {
          throw new PresalesV2HttpError("TASK_REPAIR_NOT_AVAILABLE", 409);
        }
        acquired = true;
        const createdAt = now.toISOString();
        return {
          ...current,
          status: "result_pending",
          structuredResult: null,
          errorCode: null,
          resultDeadlineAt: null,
          repair: {
            operationId: randomUUID(),
            idempotencyHash,
            requestHash,
            operationMarker: randomUUID(),
            baselineEventIds,
            status: "queued",
            providerRequestId: null,
            sendAttemptedAt: null,
            reconcileUntil: new Date(
              now.getTime() + REPAIR_RECONCILE_MS,
            ).toISOString(),
            createdAt,
            updatedAt: createdAt,
          },
        };
      },
    );
    if (!reserved?.repair) {
      throw new PresalesV2HttpError("TASK_REPAIR_RESERVATION_FAILED", 500);
    }
    await ensureWebsiteAgentRepairOperation(reserved);
    const repaired =
      acquired ||
      (reserved.repair.status === "queued" && !reserved.repair.sendAttemptedAt)
        ? await dispatchPresalesV2Repair(reserved, contract)
        : await reconcileTask(reserved.localTaskId);
    res
      .status(repaired.status === "succeeded" ? 200 : 202)
      .json(presalesV2PublicTask(repaired));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks/:localTaskId", async (req, res) => {
  try {
    res.json(presalesV2PublicTask(await reconcileTask(req.params.localTaskId)));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks/:localTaskId/result", async (req, res) => {
  try {
    const task = await reconcileTask(req.params.localTaskId);
    const status = task.status === "succeeded" ? 200 : 202;
    res.status(status).json(presalesV2PublicTask(task));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/tasks/:localTaskId", async (req, res) => {
  try {
    const task = await readPresalesV2Task(req.params.localTaskId);
    if (!task) throw new PresalesV2HttpError("TASK_NOT_FOUND", 404);
    await deletePresalesV2TaskResources(task, { projectCleanup: false });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/projects/:projectId/tasks", async (req, res) => {
  try {
    const projectId = projectOrderProjectIdSchema.parse(req.params.projectId);
    const snapshot = await readPresalesV2ProjectResourceSnapshot(projectId);
    let deletedTasks = 0;
    let deletedFiles = 0;

    for (const task of snapshot.tasks) {
      try {
        const result = await deletePresalesV2TaskResources(task, {
          projectCleanup: true,
        });
        deletedTasks += 1;
        deletedFiles += result.deletedFiles;
      } catch {
        // The project-level contract is retryable. A fresh durable snapshot
        // below determines the exact remaining work without exposing Provider
        // errors or credentials to Website.
      }
    }

    for (const asset of snapshot.assets) {
      try {
        await releaseWebsiteLocalAssetReference(asset.localAssetId);
        await removeStoredPresalesFile(asset.localAssetId);
        await updatePresalesV2Asset(asset.localAssetId, (current) => ({
          ...current,
          status: "deleted",
          bytes: null,
          sha256: null,
        }));
        deletedFiles += 1;
      } catch {
        // Retried from the local durable index on the next project DELETE.
      }
    }

    for (const artifact of snapshot.artifacts) {
      try {
        await releaseWebsiteArtifactReference(artifact.artifactId);
        await removeStoredPresalesFile(artifact.artifactId);
        await markPresalesV2ArtifactDeleted(artifact.artifactId);
        deletedFiles += 1;
      } catch {
        // Retried from the local durable index on the next project DELETE.
      }
    }

    const remaining = await readPresalesV2ProjectResourceSnapshot(projectId);
    const pendingReservations =
      remaining.assets.length +
      remaining.artifacts.length +
      remaining.tasks.filter(
        (task) =>
          !task.providerTaskId &&
          !["succeeded", "failed", "cancelled"].includes(task.status),
      ).length;
    if (
      remaining.tasks.length > 0 ||
      remaining.assets.length > 0 ||
      remaining.artifacts.length > 0
    ) {
      res.setHeader("Retry-After", "2");
      res.status(202).json({
        schemaVersion: 1,
        projectId,
        status: "deleting",
        deletedTasks,
        deletedFiles,
        pendingReservations,
        remainingTasks: remaining.tasks.length,
        retryAfterMs: 2_000,
      });
      return;
    }
    res.json({
      schemaVersion: 1,
      projectId,
      status: "deleted",
      deletedTasks,
      deletedFiles,
      pendingReservations: 0,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/artifacts", jsonParser, async (req, res) => {
  try {
    const input = artifactCreateSchema.parse(req.body ?? {});
    await assertActiveWebsiteProject(input.projectId);
    const asset = await readPresalesV2Asset(input.sourceLocalAssetId);
    const stored = await readStoredPresalesFile(input.sourceLocalAssetId);
    if (
      !asset ||
      asset.status !== "uploaded" ||
      asset.projectId !== input.projectId ||
      asset.bytes !== input.bytes ||
      asset.sha256 !== input.sha256 ||
      !stored
    ) {
      throw new PresalesV2HttpError("FINAL_ARTIFACT_SOURCE_INVALID", 409);
    }
    const artifactId = `artifact_${createHash("sha256")
      .update(`${input.projectId}\0${input.kind}\0${input.sha256}`, "utf8")
      .digest("hex")}`;
    const existing = await readPresalesV2Artifact(artifactId);
    if (existing && (await readStoredPresalesFile(artifactId))) {
      await persistWebsiteArtifact(existing);
      res.status(200).json({
        artifactId: existing.artifactId,
        filename: existing.filename,
        mimeType: existing.mimeType,
        bytes: existing.bytes,
        sha256: existing.sha256,
      });
      return;
    }
    await recordPresalesFileDescriptor({
      fileId: artifactId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes,
    });
    const staged = await stagePresalesFileContent({
      fileId: artifactId,
      stream: stored.createReadStream(),
      maxBytes: MAX_ASSET_BYTES,
    });
    try {
      const magic = await firstBytes(staged.createReadStream(), 4);
      if (
        magic.length < 4 ||
        magic[0] !== 0x50 ||
        magic[1] !== 0x4b ||
        ![0x03, 0x05, 0x07].includes(magic[2]!) ||
        ![0x04, 0x06, 0x08].includes(magic[3]!) ||
        staged.sizeBytes !== input.bytes ||
        staged.sha256 !== input.sha256
      ) {
        throw new PresalesV2HttpError("FINAL_ARTIFACT_BYTES_INVALID", 422);
      }
      try {
        await assertPresalesV2ZipSafe(
          await readStreamBuffer(staged.createReadStream(), MAX_ASSET_BYTES),
        );
      } catch (error) {
        if (error instanceof PresalesV2HttpError) throw error;
        throw new PresalesV2HttpError("FINAL_ARTIFACT_ZIP_UNSAFE", 422);
      }
      const now = Date.now();
      await staged.commit({
        filename: input.filename,
        mimeType: input.mimeType,
        uploadedAt: now,
        contentExpiresAt: now + FILE_CONTENT_RETENTION_MS,
      });
    } catch (error) {
      await staged.discard().catch(() => undefined);
      throw error;
    }
    const artifact = await recordPresalesV2Artifact({
      schemaVersion: 2,
      localTaskId: null,
      operationId: null,
      projectId: input.projectId,
      sourceEventId: `local:${input.sourceLocalAssetId}`,
      attachmentIndex: 0,
      artifactId,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: staged.sizeBytes,
      sha256: staged.sha256,
      createdAt: new Date().toISOString(),
    });
    await persistWebsiteArtifact(artifact);
    res.status(201).json({
      artifactId: artifact.artifactId,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/artifacts/:artifactId/content", async (req, res) => {
  try {
    const artifact = await readPresalesV2Artifact(req.params.artifactId);
    const stored = await readStoredPresalesFile(req.params.artifactId);
    if (!artifact || !stored) {
      throw new PresalesV2HttpError("ARTIFACT_NOT_FOUND", 404);
    }
    res.setHeader("Content-Type", artifact.mimeType);
    res.setHeader("Content-Length", String(artifact.bytes));
    res.setHeader("ETag", `\"sha256:${artifact.sha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    );
    await pipeline(stored.createReadStream(), res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
  }
});

router.use((_req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", status: 404, retryable: false },
  });
});

export default router;
