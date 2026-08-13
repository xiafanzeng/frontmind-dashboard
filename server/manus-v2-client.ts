import { createHash } from "node:crypto";

import axios, { type AxiosInstance, type AxiosResponse } from "axios";

import {
  upstreamAliasedIdentity,
  upstreamTaskRecord,
} from "./upstream-task-adapter";
import { classifyManusV2StructuredResultEnvelope } from "./manus-v2-structured-result";

export {
  classifyManusV2StructuredResultEnvelope,
  type ManusV2StructuredResultEnvelope,
} from "./manus-v2-structured-result";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;

export type ManusV2Attachment =
  | {
      file_id: string;
      filename: string;
      file_data?: never;
      mime_type?: never;
    }
  | {
      /** Official Manus v2 inline-file data URL (decoded payload <= 20 MiB). */
      file_data: string;
      filename: string;
      mime_type: string;
      file_id?: never;
    };

export type ManusV2CreatedFile = {
  fileId: string;
  filename: string;
  uploadUrl: string;
  uploadExpiresAt: number;
  requestId: string | null;
};

/**
 * Durable callers use these awaited boundaries to journal the provider file
 * before any signed-URL PUT can begin. Observer failures deliberately abort
 * the upload: the caller's earlier `creating` fence then prevents a second
 * file.create after a database outage or process crash.
 */
export type ManusV2FileUploadObserver = {
  onCandidateCreated?: (file: ManusV2CreatedFile) => Promise<void>;
  onPutStarted?: (file: ManusV2CreatedFile) => Promise<void>;
  onPutAccepted?: (file: ManusV2CreatedFile) => Promise<void>;
  onPutRejected?: (
    file: ManusV2CreatedFile,
    rejection: { status: number; code: string },
  ) => Promise<void>;
  onPutRetryWait?: (
    file: ManusV2CreatedFile,
    rejection: {
      status: number;
      code: string;
      retryAfterMs: number | null;
      rejectionCount: number;
      nextRetryAt: string;
    },
  ) => Promise<void>;
  onPutOutcomeUnknown?: (file: ManusV2CreatedFile) => Promise<void>;
};

export type ManusV2StructuredOutputSchema = Record<string, unknown>;

export const MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION = 1;

export type ManusV2KnowledgeBaseAction =
  | "start"
  | "confirm"
  | "direct_prefill"
  | "revise"
  | "retry"
  | "legacy_reconcile";

export type ManusV2KnowledgeBaseOperationContract = {
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
  action: ManusV2KnowledgeBaseAction;
  fromLeafId: string | null;
  expectContentCompleted: boolean;
  requiresManifest: boolean;
};

export type ManusV2KnowledgeBaseStructuredResult = {
  schemaVersion: typeof MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION;
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
  action: ManusV2KnowledgeBaseAction;
  fromLeafId: string | null;
  nextLeafId: string | null;
  visibleMarkdown: string;
  contentCompleted: boolean;
  /** Required only for an uninitialized build; null on every later turn. */
  manifestJson: string | null;
};

export type ManusV2MessageEvent = Record<string, unknown> & {
  id: string;
  type: string;
  timestamp: number;
};

export type ManusV2TaskSummary = {
  id: string;
  title: string;
  taskUrl: string | null;
  createdAt: number | null;
  status: string | null;
};

export type ManusV2WaitingDetail = {
  eventId: string;
  eventType: string;
  description: string | null;
  confirmInputSchema: Record<string, unknown> | null;
  statusEventId: string;
};

export class ManusV2ApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number | null,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
    public readonly providerRequestId: string | null = null,
    /**
     * Only populated when Manus actually supplied a parseable Retry-After
     * header for an explicit rejection.  It is deliberately absent for
     * response-loss/ambiguous responses: those requests must be reconciled,
     * never resent.
     */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`Manus v2 ${operation} failed (${code})`);
    this.name = "ManusV2ApiError";
  }
}

function requiredString(value: unknown, label: string, maxLength = 2_048) {
  if (typeof value !== "string") {
    throw new ManusV2ApiError(label, 502, "INVALID_RESPONSE", false, false);
  }
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > maxLength) {
    throw new ManusV2ApiError(label, 502, "INVALID_RESPONSE", false, false);
  }
  return normalized;
}

function requiredInteger(value: unknown, label: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new ManusV2ApiError(label, 502, "INVALID_RESPONSE", false, false);
  }
  return Number(value);
}

function optionalString(value: unknown, maxLength = 2_048) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, "response", maxLength);
}

function providerRequestId(record: Record<string, unknown>) {
  try {
    return optionalString(record.request_id, 512);
  } catch {
    // Provider request ids are diagnostic only. A malformed optional field
    // must never discard an otherwise usable task/file acknowledgement.
    return null;
  }
}

function acknowledgedSideEffectTaskId(
  operation: string,
  record: Record<string, unknown>,
) {
  try {
    const taskId = upstreamAliasedIdentity({
      record,
      aliases: ["task_id", "id"],
      label: "Manus v2 task id",
      maxLength: 255,
      required: true,
    });
    if (!taskId) throw new Error("missing task id");
    return taskId;
  } catch {
    throw new ManusV2ApiError(
      operation,
      200,
      "INVALID_RESPONSE",
      false,
      true,
      providerRequestId(record),
    );
  }
}

function providerErrorCode(record: Record<string, unknown>, status: number) {
  const error = upstreamTaskRecord(record.error);
  const value = optionalString(error?.code ?? record.code, 128);
  return value || `HTTP_${status}`;
}

function retryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: AxiosResponse) {
  // Retry-After is advisory only for explicit rejections. Axios exposes
  // headers differently across its node/browser adapters, so tolerate both
  // shapes without ever inventing a provider instruction.
  const headers = response.headers as
    | { get?: (name: string) => unknown; [key: string]: unknown }
    | undefined;
  const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 128) return null;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60 * 60 * 1000, Math.round(seconds * 1_000));
  }
  const at = Date.parse(normalized);
  if (!Number.isFinite(at)) return null;
  return Math.min(60 * 60 * 1000, Math.max(0, at - Date.now()));
}

function explicitFilePutRetryDelayMs(input: {
  rejectionCount: number;
  retryAfterMs: number | null;
  fileId: string;
}) {
  if (input.retryAfterMs !== null) return input.retryAfterMs;
  const base = Math.min(
    30_000,
    500 * 2 ** Math.min(input.rejectionCount - 1, 5),
  );
  const seed =
    createHash("sha256")
      .update(`${input.fileId}:${input.rejectionCount}`, "utf8")
      .digest()[0] ?? 0;
  return base + Math.floor((base * (seed % 21)) / 100);
}

function assertOk(
  operation: string,
  response: AxiosResponse,
  sideEffect: boolean,
): Record<string, unknown> {
  const record = upstreamTaskRecord(response.data);
  if (response.status < 200 || response.status >= 300) {
    const explicitRejection = record?.ok === false;
    throw new ManusV2ApiError(
      operation,
      response.status,
      record
        ? providerErrorCode(record, response.status)
        : `HTTP_${response.status}`,
      explicitRejection && retryableStatus(response.status),
      sideEffect && !explicitRejection,
      record ? providerRequestId(record) : null,
      explicitRejection ? retryAfterMs(response) : null,
    );
  }
  // Once a side-effect endpoint returned 2xx, an empty/non-object body or a
  // body that does not explicitly acknowledge `ok: true` cannot prove that
  // the request was not accepted. Reconcile it; never classify it as a safe
  // rejection and never POST the business operation again.
  if (!record || record.ok !== true) {
    throw new ManusV2ApiError(
      operation,
      response.status,
      "INVALID_RESPONSE",
      false,
      sideEffect,
      record ? providerRequestId(record) : null,
    );
  }
  return record;
}

function normalizeBaseUrl(baseUrl: string) {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Unsafe Manus v2 base URL");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function safeAttachment(attachment: ManusV2Attachment) {
  const filename = requiredString(
    attachment.filename.replace(/[\\/\0]/gu, "_"),
    "filename",
    512,
  );
  if ("file_id" in attachment && attachment.file_id) {
    return {
      type: "file" as const,
      file_id: requiredString(attachment.file_id, "file_id", 512),
      filename,
    };
  }
  if (!("file_data" in attachment) || !attachment.file_data) {
    throw new Error("Manus v2 attachment requires exactly one file source");
  }
  const mimeType = requiredString(attachment.mime_type, "mime_type", 255);
  const prefix = `data:${mimeType};base64,`;
  if (!attachment.file_data.startsWith(prefix)) {
    throw new Error("Manus v2 inline attachment data URL is invalid");
  }
  const encoded = attachment.file_data.slice(prefix.length);
  if (
    !encoded ||
    encoded.length > Math.ceil((20 * 1024 * 1024 * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new Error("Manus v2 inline attachment exceeds its safe limit");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length < 1 ||
    decoded.length > 20 * 1024 * 1024 ||
    decoded.toString("base64") !== encoded
  ) {
    throw new Error("Manus v2 inline attachment base64 is invalid");
  }
  return {
    type: "file" as const,
    file_data: attachment.file_data,
    filename,
    mime_type: mimeType,
  };
}

export function buildManusV2MessageContent(
  prompt: string,
  attachments: ReadonlyArray<ManusV2Attachment>,
) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "file"; file_id: string; filename: string }
    | {
        type: "file";
        file_data: string;
        filename: string;
        mime_type: string;
      }
  > = [{ type: "text", text: requiredString(prompt, "prompt", 2_000_000) }];
  for (const attachment of attachments.map(safeAttachment)) {
    content.push(attachment);
  }
  return content;
}

function normalizeEvent(value: unknown): ManusV2MessageEvent | null {
  const record = upstreamTaskRecord(value);
  if (!record) return null;
  try {
    const id = requiredString(record.id, "message.id", 512);
    const type = requiredString(record.type, "message.type", 64);
    const timestamp = Number(record.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
    return { ...record, id, type, timestamp };
  } catch {
    return null;
  }
}

export function manusV2EventUserText(event: ManusV2MessageEvent) {
  if (event.type !== "user_message") return null;
  const message = upstreamTaskRecord(event.user_message);
  return typeof message?.content === "string" ? message.content : null;
}

export function manusV2EventsContainOperationToken(
  events: ReadonlyArray<ManusV2MessageEvent>,
  operationToken: string,
) {
  const token = requiredString(operationToken, "operationToken", 256);
  return events.some((event) => manusV2EventOperationToken(event) === token);
}

const MANUS_V2_OPERATION_CONTRACT_LINE =
  /^FRONTMIND_MANUS_V2_OPERATION_CONTRACT=(\{[^\r\n]+\})\s*$/mu;

export function manusV2EventOperationToken(event: ManusV2MessageEvent) {
  const text = manusV2EventUserText(event);
  if (!text) return null;
  const candidate = MANUS_V2_OPERATION_CONTRACT_LINE.exec(text)?.[1];
  if (!candidate) return null;
  try {
    const record = upstreamTaskRecord(JSON.parse(candidate));
    return typeof record?.operationToken === "string"
      ? record.operationToken
      : null;
  } catch {
    return null;
  }
}

export function latestManusV2TaskState(
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  const ordered = [...events].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.id.localeCompare(left.id),
  );
  for (const event of ordered) {
    if (event.type !== "status_update") continue;
    const update = upstreamTaskRecord(event.status_update);
    const state = optionalString(update?.agent_status, 64);
    if (state) return state;
  }
  return null;
}

/** Return only the newest pending waiting event; historical waits are inert. */
export function latestManusV2WaitingDetail(
  events: ReadonlyArray<ManusV2MessageEvent>,
): ManusV2WaitingDetail | null {
  const ordered = [...events].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.id.localeCompare(left.id),
  );
  for (const event of ordered) {
    if (event.type !== "status_update") continue;
    const update = upstreamTaskRecord(event.status_update);
    if (optionalString(update?.agent_status, 64) !== "waiting") return null;
    const detail = upstreamTaskRecord(update?.status_detail);
    if (!detail) return null;
    try {
      const schema = upstreamTaskRecord(detail.confirm_input_schema);
      return {
        eventId: requiredString(
          detail.waiting_for_event_id,
          "waiting_for_event_id",
          512,
        ),
        eventType: requiredString(
          detail.waiting_for_event_type,
          "waiting_for_event_type",
          128,
        ),
        description: optionalString(detail.waiting_description, 4_096),
        confirmInputSchema: schema ? { ...schema } : null,
        statusEventId: event.id,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function normalizedContractString(value: unknown, label: string, max: number) {
  return requiredString(value, label, max);
}

function normalizeNullableContractString(
  value: unknown,
  label: string,
  max: number,
) {
  if (value === null) return null;
  return normalizedContractString(value, label, max);
}

function exactSafeInteger(value: unknown, label: string) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      `INVALID_${label.toUpperCase()}`,
      false,
      false,
    );
  }
  return normalized;
}

/**
 * The schema is deliberately small. Dashboard remains authoritative for the
 * tree, counters and assets; Manus only returns transition coordinates and
 * the visible body. The one exception is the initial tree manifest. Singleton enums
 * make the frozen operation coordinates part of each create/send request.
 */
export function buildManusV2KnowledgeBaseStructuredOutputSchema(
  input: ManusV2KnowledgeBaseOperationContract,
): ManusV2StructuredOutputSchema {
  const operationToken = normalizedContractString(
    input.operationToken,
    "operationToken",
    128,
  );
  const turnId = normalizedContractString(input.turnId, "turnId", 36);
  const generation = exactSafeInteger(input.generation, "generation");
  const baseRevision = exactSafeInteger(input.baseRevision, "baseRevision");
  const fromLeafId = input.fromLeafId
    ? normalizedContractString(input.fromLeafId, "fromLeafId", 191)
    : null;
  return {
    type: "object",
    properties: {
      schemaVersion: {
        type: "integer",
        enum: [MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION],
      },
      operationToken: { type: "string", enum: [operationToken] },
      turnId: { type: "string", enum: [turnId] },
      generation: { type: "integer", enum: [generation] },
      baseRevision: { type: "integer", enum: [baseRevision] },
      action: { type: "string", enum: [input.action] },
      fromLeafId:
        fromLeafId === null
          ? { type: ["string", "null"], enum: [null] }
          : { type: ["string", "null"], enum: [fromLeafId] },
      nextLeafId: { type: ["string", "null"] },
      visibleMarkdown: { type: "string" },
      contentCompleted: {
        type: "boolean",
        enum: [input.expectContentCompleted],
      },
      ...(input.requiresManifest ? { manifestJson: { type: "string" } } : {}),
    },
    required: [
      "schemaVersion",
      "operationToken",
      "turnId",
      "generation",
      "baseRevision",
      "action",
      "fromLeafId",
      "nextLeafId",
      "visibleMarkdown",
      "contentCompleted",
      ...(input.requiresManifest ? ["manifestJson"] : []),
    ],
    additionalProperties: false,
  };
}

/** Repeats the operation contract in-band for response-loss reconciliation. */
export function appendManusV2KnowledgeBaseOperationContract(
  prompt: string,
  input: ManusV2KnowledgeBaseOperationContract,
) {
  const contract = {
    schemaVersion: MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION,
    operationToken: normalizedContractString(
      input.operationToken,
      "operationToken",
      128,
    ),
    turnId: normalizedContractString(input.turnId, "turnId", 36),
    generation: exactSafeInteger(input.generation, "generation"),
    baseRevision: exactSafeInteger(input.baseRevision, "baseRevision"),
    action: input.action,
    fromLeafId: input.fromLeafId,
    contentCompleted: input.expectContentCompleted,
    requiresManifest: input.requiresManifest,
  };
  return [
    requiredString(prompt, "prompt", 2_000_000),
    "",
    "# FrontMind Manus v2 operation contract",
    `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify(contract)}`,
    input.requiresManifest
      ? "Put only the customer-facing first-node body in visibleMarkdown. Put the initial manifest object (leaves and researchCoverage, plus optional officialLogo) as JSON text in manifestJson. Dashboard owns and synthesizes all machine envelopes. nextLeafId must be the first manifest leaf id."
      : "Put only the customer-facing node body in visibleMarkdown. Dashboard owns and synthesizes all machine envelopes. nextLeafId is the leaf displayed after this transition, or null when content is complete.",
  ].join("\n");
}

function normalizeKnowledgeBaseStructuredResult(
  value: unknown,
  expected?: ManusV2KnowledgeBaseOperationContract,
): ManusV2KnowledgeBaseStructuredResult {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      decoded = null;
    }
  }
  const record = upstreamTaskRecord(decoded);
  if (!record) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_CORE_SCHEMA",
      false,
      false,
    );
  }
  const schemaVersion = exactSafeInteger(record.schemaVersion, "schemaVersion");
  const operationToken = normalizedContractString(
    record.operationToken,
    "operationToken",
    128,
  );
  const turnId = normalizedContractString(record.turnId, "turnId", 36);
  const generation = exactSafeInteger(record.generation, "generation");
  const baseRevision = exactSafeInteger(record.baseRevision, "baseRevision");
  const action = normalizedContractString(record.action, "action", 32);
  if (
    ![
      "start",
      "confirm",
      "direct_prefill",
      "revise",
      "retry",
      "legacy_reconcile",
    ].includes(action)
  ) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_ACTION",
      false,
      false,
    );
  }
  const fromLeafId = normalizeNullableContractString(
    record.fromLeafId,
    "fromLeafId",
    191,
  );
  const nextLeafId = normalizeNullableContractString(
    record.nextLeafId,
    "nextLeafId",
    191,
  );
  if (typeof record.visibleMarkdown !== "string") {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_VISIBLE_MARKDOWN",
      false,
      false,
    );
  }
  const visibleMarkdown = record.visibleMarkdown.trim();
  if (typeof record.contentCompleted !== "boolean") {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_COMPLETION_FLAG",
      false,
      false,
    );
  }
  const manifestJson = normalizeNullableContractString(
    record.manifestJson === undefined ? null : record.manifestJson,
    "manifestJson",
    2_000_000,
  );
  if (schemaVersion !== MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "UNSUPPORTED_CORE_SCHEMA",
      false,
      false,
    );
  }
  if (!record.contentCompleted && !visibleMarkdown) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "EMPTY_CORE_CONTENT",
      false,
      false,
    );
  }
  if (
    expected &&
    (operationToken !== expected.operationToken ||
      turnId !== expected.turnId ||
      generation !== expected.generation ||
      baseRevision !== expected.baseRevision ||
      action !== expected.action ||
      fromLeafId !== expected.fromLeafId ||
      record.contentCompleted !== expected.expectContentCompleted ||
      (expected.requiresManifest ? !manifestJson : manifestJson !== null))
  ) {
    throw new ManusV2ApiError(
      "structured_output",
      409,
      "OPERATION_COORDINATE_CONFLICT",
      false,
      false,
    );
  }
  return {
    schemaVersion: MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION,
    operationToken,
    turnId,
    generation,
    baseRevision,
    action: action as ManusV2KnowledgeBaseAction,
    fromLeafId,
    nextLeafId,
    visibleMarkdown,
    contentCompleted: record.contentCompleted,
    manifestJson,
  };
}

export function manusV2KnowledgeBaseStructuredResultForOperation(
  events: ReadonlyArray<ManusV2MessageEvent>,
  expected: ManusV2KnowledgeBaseOperationContract,
) {
  const candidates = [...events]
    .filter((event) => event.type === "structured_output_result")
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.id.localeCompare(left.id),
    );
  for (const event of candidates) {
    const result = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (result.kind !== "accepted") continue;
    let decoded = result.value;
    if (typeof decoded === "string") {
      try {
        decoded = JSON.parse(decoded);
      } catch {
        decoded = null;
      }
    }
    const value = upstreamTaskRecord(decoded);
    if (!value || value.operationToken !== expected.operationToken) continue;
    return {
      event,
      value: normalizeKnowledgeBaseStructuredResult(value, expected),
    };
  }
  return null;
}

export function normalizeManusV2KnowledgeBaseCoreOutput(
  events: ReadonlyArray<ManusV2MessageEvent>,
  expected: ManusV2KnowledgeBaseOperationContract,
) {
  return normalizeManusV2Output(events, expected);
}

export function normalizeManusV2Output(
  events: ReadonlyArray<ManusV2MessageEvent>,
  expected?: ManusV2KnowledgeBaseOperationContract,
) {
  type NormalizedOutput = {
    id: string;
    role: "assistant";
    text: string;
    content: string;
    timestamp: number;
    files?: unknown[];
    structuredOutput?: true;
  };
  if (expected) {
    const exact = manusV2KnowledgeBaseStructuredResultForOperation(
      events,
      expected,
    );
    if (!exact) return [];
    const text = exact.value.visibleMarkdown;
    return [
      {
        id: exact.event.id,
        role: "assistant" as const,
        text,
        content: text,
        timestamp: exact.event.timestamp,
        // Provider assets are deliberately not part of the core acceptance
        // record. Dashboard-owned source/package workers reconcile them
        // separately so an optional Logo/ZIP cannot reject valid正文.
        files: [],
        structuredOutput: true as const,
      },
    ];
  }
  return [...events]
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.id.localeCompare(right.id),
    )
    .flatMap<NormalizedOutput>((event) => {
      if (event.type === "structured_output_result") {
        const result = classifyManusV2StructuredResultEnvelope(
          event.structured_output_result,
        );
        if (result.kind !== "accepted") return [];
        let value: ManusV2KnowledgeBaseStructuredResult;
        try {
          value = normalizeKnowledgeBaseStructuredResult(result.value);
        } catch {
          return [];
        }
        const text = value.visibleMarkdown;
        return [
          {
            id: event.id,
            role: "assistant",
            text,
            content: text,
            timestamp: event.timestamp,
            structuredOutput: true,
          },
        ];
      }
      if (event.type !== "assistant_message") return [];
      const message = upstreamTaskRecord(event.assistant_message);
      const text = typeof message?.content === "string" ? message.content : "";
      if (!text) return [];
      const attachments = Array.isArray(message?.attachments)
        ? message.attachments
        : [];
      return [
        {
          id: event.id,
          role: "assistant",
          text,
          content: text,
          files: attachments,
          timestamp: event.timestamp,
        },
      ];
    });
}

export class ManusV2Client {
  private readonly baseUrl: string;
  private readonly api: AxiosInstance;

  constructor(input: {
    baseUrl: string;
    apiKey: string;
    axiosInstance?: AxiosInstance;
  }) {
    this.baseUrl = normalizeBaseUrl(input.baseUrl);
    const apiKey = requiredString(input.apiKey, "apiKey", 8_192);
    this.api =
      input.axiosInstance ??
      axios.create({
        headers: { "x-manus-api-key": apiKey },
        timeout: DEFAULT_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        validateStatus: () => true,
      });
  }

  private async request(
    operation: string,
    request: () => Promise<AxiosResponse>,
    sideEffect: boolean,
  ) {
    try {
      const response = await request();
      return assertOk(operation, response, sideEffect);
    } catch (error) {
      if (error instanceof ManusV2ApiError) throw error;
      throw new ManusV2ApiError(
        operation,
        null,
        "TRANSPORT_UNKNOWN",
        false,
        sideEffect,
      );
    }
  }

  async createTask(input: {
    prompt: string;
    attachments?: ReadonlyArray<ManusV2Attachment>;
    title: string;
    agentProfile?: string;
    structuredOutputSchema?: ManusV2StructuredOutputSchema;
    taskReferences?: string[];
    hideInTaskList?: boolean;
  }) {
    const body = {
      message: {
        content: buildManusV2MessageContent(
          input.prompt,
          input.attachments ?? [],
        ),
        ...(input.taskReferences?.length
          ? { task_references: input.taskReferences }
          : {}),
      },
      title: requiredString(input.title, "title", 255),
      interactive_mode: false,
      hide_in_task_list: input.hideInTaskList ?? true,
      share_visibility: "private",
      ...(input.agentProfile
        ? {
            agent_profile: requiredString(
              input.agentProfile,
              "agentProfile",
              64,
            ),
          }
        : {}),
      ...(input.structuredOutputSchema
        ? { structured_output_schema: input.structuredOutputSchema }
        : {}),
    };
    const result = await this.request(
      "task.create",
      () =>
        this.api.post(`${this.baseUrl}/v2/task.create`, body, {
          headers: { "Content-Type": "application/json" },
        }),
      true,
    );
    const taskId = acknowledgedSideEffectTaskId("task.create", result);
    return {
      taskId,
      taskUrl: optionalString(result.task_url, 2_048),
      taskTitle: optionalString(result.task_title, 255),
      requestId: providerRequestId(result),
      raw: result,
    };
  }

  async sendMessage(input: {
    taskId: string;
    prompt: string;
    attachments?: ReadonlyArray<ManusV2Attachment>;
    structuredOutputSchema?: ManusV2StructuredOutputSchema;
  }) {
    const taskId = requiredString(input.taskId, "taskId", 255);
    const body = {
      task_id: taskId,
      message: {
        content: buildManusV2MessageContent(
          input.prompt,
          input.attachments ?? [],
        ),
      },
      ...(input.structuredOutputSchema
        ? { structured_output_schema: input.structuredOutputSchema }
        : {}),
    };
    const result = await this.request(
      "task.sendMessage",
      () =>
        this.api.post(`${this.baseUrl}/v2/task.sendMessage`, body, {
          headers: { "Content-Type": "application/json" },
        }),
      true,
    );
    const returnedTaskId = acknowledgedSideEffectTaskId(
      "task.sendMessage",
      result,
    );
    if (returnedTaskId !== taskId) {
      throw new ManusV2ApiError(
        "task.sendMessage",
        502,
        "TASK_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    return { taskId, requestId: providerRequestId(result), raw: result };
  }

  async confirmAction(input: {
    taskId: string;
    eventId: string;
    confirmationInput?: Record<string, unknown>;
  }) {
    const taskId = requiredString(input.taskId, "taskId", 255);
    const eventId = requiredString(input.eventId, "eventId", 512);
    const result = await this.request(
      "task.confirmAction",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/task.confirmAction`,
          {
            task_id: taskId,
            event_id: eventId,
            ...(input.confirmationInput
              ? { input: { ...input.confirmationInput } }
              : {}),
          },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
    // A 2xx response proves only that the side-effect request reached Manus.
    // Missing/malformed acknowledgement fields cannot prove that the action
    // was rejected, so classify every such response as outcome-unknown. This
    // keeps the durable lifecycle ledger on its read/reconcile-only path and
    // prevents a second confirmation POST.
    const returnedTaskId = acknowledgedSideEffectTaskId(
      "task.confirmAction",
      result,
    );
    if (returnedTaskId !== taskId) {
      throw new ManusV2ApiError(
        "task.confirmAction",
        502,
        "TASK_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (result.confirmed !== true) {
      throw new ManusV2ApiError(
        "task.confirmAction",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    return { taskId, eventId, requestId: providerRequestId(result) };
  }

  async listMessagesPage(input: {
    taskId: string;
    cursor?: string | null;
    order?: "asc" | "desc";
    limit?: number;
  }) {
    const taskId = requiredString(input.taskId, "taskId", 255);
    const result = await this.request(
      "task.listMessages",
      () =>
        this.api.get(`${this.baseUrl}/v2/task.listMessages`, {
          params: {
            task_id: taskId,
            limit: Math.min(200, Math.max(1, input.limit ?? 200)),
            order: input.order ?? "asc",
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
        }),
      false,
    );
    const responseTaskId = requiredString(result.task_id, "task_id", 255);
    if (responseTaskId !== taskId) {
      throw new ManusV2ApiError(
        "task.listMessages",
        502,
        "TASK_ID_CONFLICT",
        false,
        false,
        providerRequestId(result),
      );
    }
    return {
      taskId,
      messages: Array.isArray(result.messages)
        ? result.messages.flatMap((event) => {
            const normalized = normalizeEvent(event);
            return normalized ? [normalized] : [];
          })
        : [],
      hasMore: result.has_more === true,
      nextCursor: optionalString(result.next_cursor, 2_048),
      requestId: providerRequestId(result),
    };
  }

  async listAllMessages(input: {
    taskId: string;
    order?: "asc" | "desc";
    stopAfterOperationToken?: string;
  }) {
    const events = new Map<string, ManusV2MessageEvent>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.listMessagesPage({
        taskId: input.taskId,
        order: input.order ?? "asc",
        cursor,
      });
      for (const event of result.messages) events.set(event.id, event);
      if (
        input.stopAfterOperationToken &&
        manusV2EventsContainOperationToken(
          [...events.values()],
          input.stopAfterOperationToken,
        )
      ) {
        break;
      }
      if (!result.hasMore) break;
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) {
        throw new ManusV2ApiError(
          "task.listMessages",
          502,
          "INVALID_PAGINATION",
          false,
          false,
        );
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return [...events.values()].sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.id.localeCompare(right.id),
    );
  }

  async listTasks(
    input: {
      apiKeyId?: string;
      order?: "asc" | "desc";
    } = {},
  ) {
    const tasks = new Map<string, ManusV2TaskSummary>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.request(
        "task.list",
        () =>
          this.api.get(`${this.baseUrl}/v2/task.list`, {
            params: {
              limit: 100,
              order: input.order ?? "desc",
              scope: "standard",
              ...(input.apiKeyId ? { api_key_id: input.apiKeyId } : {}),
              ...(cursor ? { cursor } : {}),
            },
          }),
        false,
      );
      for (const value of Array.isArray(result.data) ? result.data : []) {
        const record = upstreamTaskRecord(value);
        if (!record) continue;
        try {
          const id = requiredString(record.id, "task.id", 255);
          tasks.set(id, {
            id,
            title: requiredString(record.title, "task.title", 255),
            taskUrl: optionalString(record.task_url, 2_048),
            createdAt: Number.isSafeInteger(Number(record.created_at))
              ? Number(record.created_at)
              : null,
            status: optionalString(record.status, 64),
          });
        } catch {
          continue;
        }
      }
      if (result.has_more !== true) break;
      const nextCursor = optionalString(result.next_cursor, 2_048);
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new ManusV2ApiError(
          "task.list",
          502,
          "INVALID_PAGINATION",
          false,
          false,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return [...tasks.values()];
  }

  async findCreatedTask(input: {
    title: string;
    operationToken: string;
    createdAfterSeconds?: number;
    createdBeforeSeconds?: number;
    apiKeyId?: string;
  }) {
    const title = requiredString(input.title, "title", 255);
    const candidates = (
      await this.listTasks({ apiKeyId: input.apiKeyId })
    ).filter(
      (task) =>
        task.title === title &&
        (input.createdAfterSeconds === undefined ||
          task.createdAt === null ||
          task.createdAt >= input.createdAfterSeconds) &&
        (input.createdBeforeSeconds === undefined ||
          task.createdAt === null ||
          task.createdAt <= input.createdBeforeSeconds),
    );
    const matches: ManusV2TaskSummary[] = [];
    for (const candidate of candidates) {
      const events = await this.listAllMessages({
        taskId: candidate.id,
        order: "asc",
        stopAfterOperationToken: input.operationToken,
      });
      if (manusV2EventsContainOperationToken(events, input.operationToken)) {
        matches.push(candidate);
      }
    }
    return {
      candidates,
      matches,
      unique: matches.length === 1 ? matches[0] : null,
    };
  }

  async updateTaskVisibility(taskId: string, visible: boolean) {
    const normalizedTaskId = requiredString(taskId, "taskId", 255);
    await this.request(
      "task.update",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/task.update`,
          {
            task_id: normalizedTaskId,
            enable_visible_in_task_list: visible,
          },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
  }

  async createFile(filename: string) {
    const normalizedFilename = requiredString(
      filename.replace(/[\\/\0]/gu, "_"),
      "filename",
      512,
    );
    const result = await this.request(
      "file.upload",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/file.upload`,
          { filename: normalizedFilename },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
    const file = upstreamTaskRecord(result.file);
    if (!file) {
      throw new ManusV2ApiError(
        "file.upload",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    const uploadExpiresAt = Number(result.upload_expires_at);
    if (!Number.isSafeInteger(uploadExpiresAt) || uploadExpiresAt <= 0) {
      throw new ManusV2ApiError(
        "file.upload",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    try {
      return {
        fileId: requiredString(file.id, "file.id", 512),
        filename: requiredString(file.filename, "file.filename", 512),
        uploadUrl: requiredString(result.upload_url, "upload_url", 8_192),
        uploadExpiresAt,
        requestId: providerRequestId(result),
      };
    } catch (error) {
      if (error instanceof ManusV2ApiError) {
        throw new ManusV2ApiError(
          "file.upload",
          200,
          "INVALID_RESPONSE",
          false,
          true,
          providerRequestId(result),
        );
      }
      throw error;
    }
  }

  async uploadFile(input: {
    filename: string;
    bytes: Buffer;
    contentType: string;
    minimumUsableSeconds?: number;
    sleep?: (ms: number) => Promise<void>;
    observer?: ManusV2FileUploadObserver;
    /** Resume a durable provider id after a crash/response-loss boundary. */
    existingCandidate?: {
      fileId: string;
      filename: string;
      /** Resume a durably known no-PUT candidate (0) or rejected PUT (1..3). */
      uploadUrl?: string;
      uploadExpiresAt?: number;
      resumePutRejectionCount?: number;
    };
  }) {
    if (input.existingCandidate && !input.existingCandidate.uploadUrl) {
      const expectedFileId = requiredString(
        input.existingCandidate.fileId,
        "fileId",
        512,
      );
      const expectedFilename = requiredString(
        input.existingCandidate.filename.replace(/[\\/\0]/gu, "_"),
        "filename",
        512,
      );
      const sleep =
        input.sleep ??
        ((ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const readinessDeadline = Date.now() + 5 * 60_000;
      for (let attempt = 0; ; attempt += 1) {
        const detail = await this.fileDetail(expectedFileId);
        if (detail.filename !== expectedFilename) {
          throw new ManusV2ApiError(
            "file.detail",
            502,
            "FILE_IDENTITY_CONFLICT",
            false,
            false,
          );
        }
        if (detail.status === "uploaded") {
          if (detail.bytes !== input.bytes.length) {
            throw new ManusV2ApiError(
              "file.detail",
              502,
              "FILE_BYTES_CONFLICT",
              false,
              false,
            );
          }
          const minimumUsableSeconds = input.minimumUsableSeconds ?? 15 * 60;
          if (
            detail.expiresAt - Math.floor(Date.now() / 1_000) <
            minimumUsableSeconds
          ) {
            throw new ManusV2ApiError(
              "file.detail",
              409,
              "FILE_EXPIRING",
              false,
              false,
            );
          }
          return {
            fileId: expectedFileId,
            filename: expectedFilename,
            uploadUrl: "",
            uploadExpiresAt: 0,
            requestId: detail.requestId,
            detail,
          };
        }
        if (detail.status === "deleted" || detail.status === "error") {
          throw new ManusV2ApiError(
            "file.detail",
            409,
            "FILE_UNUSABLE",
            false,
            false,
          );
        }
        if (Date.now() >= readinessDeadline) {
          throw new ManusV2ApiError(
            "file.detail",
            null,
            "FILE_PENDING",
            true,
            false,
          );
        }
        await sleep(Math.min(3_000, 500 * 2 ** Math.min(attempt, 3)));
      }
    }
    const resumedUpload = Boolean(input.existingCandidate?.uploadUrl);
    const created = resumedUpload
      ? {
          fileId: requiredString(
            input.existingCandidate!.fileId,
            "fileId",
            512,
          ),
          filename: requiredString(
            input.existingCandidate!.filename.replace(/[\\/\0]/gu, "_"),
            "filename",
            512,
          ),
          uploadUrl: requiredString(
            input.existingCandidate!.uploadUrl,
            "uploadUrl",
            8_192,
          ),
          uploadExpiresAt: requiredInteger(
            input.existingCandidate!.uploadExpiresAt,
            "uploadExpiresAt",
            1,
          ),
          requestId: null,
        }
      : await this.createFile(input.filename);
    if (!resumedUpload) {
      await input.observer?.onCandidateCreated?.(created);
    }
    const uploadTarget = new URL(created.uploadUrl);
    if (
      uploadTarget.protocol !== "https:" ||
      uploadTarget.username ||
      uploadTarget.password
    ) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "UNSAFE_UPLOAD_URL",
        false,
        false,
      );
    }
    const deadlineMs = created.uploadExpiresAt * 1_000 - 5_000;
    if (Date.now() >= deadlineMs) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "UPLOAD_URL_EXPIRED",
        false,
        false,
      );
    }
    const sleep =
      input.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let response: AxiosResponse;
    const resumedRejectionCount = resumedUpload
      ? requiredInteger(
          input.existingCandidate!.resumePutRejectionCount,
          "resumePutRejectionCount",
          0,
        )
      : 0;
    if (resumedRejectionCount > 3) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "PUT_RETRY_LIMIT_EXCEEDED",
        false,
        false,
      );
    }
    for (let putAttempt = resumedRejectionCount; ; putAttempt += 1) {
      await input.observer?.onPutStarted?.(created);
      try {
        response = await axios.put(created.uploadUrl, input.bytes, {
          headers: {
            "Content-Type": requiredString(
              input.contentType,
              "contentType",
              255,
            ),
            "Content-Length": String(input.bytes.length),
          },
          timeout: Math.max(1, deadlineMs - Date.now()),
          maxRedirects: 0,
          maxBodyLength: input.bytes.length,
          maxContentLength: 1024 * 1024,
          validateStatus: () => true,
        });
      } catch {
        await input.observer?.onPutOutcomeUnknown?.(created);
        throw new ManusV2ApiError(
          "file.upload.content",
          null,
          "TRANSPORT_UNKNOWN",
          false,
          true,
        );
      }
      if (response.status >= 200 && response.status < 300) break;
      const rejectionCount = putAttempt + 1;
      const providerRetryAfterMs = retryAfterMs(response);
      const mayRetry = retryableStatus(response.status) && rejectionCount <= 3;
      if (!mayRetry) {
        await input.observer?.onPutRejected?.(created, {
          status: response.status,
          code: `HTTP_${response.status}`,
        });
        throw new ManusV2ApiError(
          "file.upload.content",
          response.status,
          `HTTP_${response.status}`,
          retryableStatus(response.status),
          false,
          null,
          providerRetryAfterMs,
        );
      }
      const delayMs = explicitFilePutRetryDelayMs({
        rejectionCount,
        retryAfterMs: providerRetryAfterMs,
        fileId: created.fileId,
      });
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      await input.observer?.onPutRetryWait?.(created, {
        status: response.status,
        code: `HTTP_${response.status}`,
        retryAfterMs: providerRetryAfterMs,
        rejectionCount,
        nextRetryAt,
      });
      await sleep(delayMs);
      if (Date.now() >= deadlineMs) {
        await input.observer?.onPutRejected?.(created, {
          status: 408,
          code: "UPLOAD_URL_EXPIRED",
        });
        throw new ManusV2ApiError(
          "file.upload.content",
          408,
          "UPLOAD_URL_EXPIRED",
          false,
          false,
        );
      }
    }
    await input.observer?.onPutAccepted?.(created);
    const readinessDeadline = Date.now() + 5 * 60_000;
    for (let attempt = 0; ; attempt += 1) {
      const detail = await this.fileDetail(created.fileId);
      if (detail.filename !== created.filename) {
        throw new ManusV2ApiError(
          "file.detail",
          502,
          "FILE_IDENTITY_CONFLICT",
          false,
          false,
        );
      }
      if (detail.status === "uploaded") {
        if (detail.bytes !== input.bytes.length) {
          throw new ManusV2ApiError(
            "file.detail",
            502,
            "FILE_BYTES_CONFLICT",
            false,
            false,
          );
        }
        const minimumUsableSeconds = input.minimumUsableSeconds ?? 15 * 60;
        if (
          detail.expiresAt - Math.floor(Date.now() / 1_000) <
          minimumUsableSeconds
        ) {
          throw new ManusV2ApiError(
            "file.detail",
            409,
            "FILE_EXPIRING",
            false,
            false,
          );
        }
        return { ...created, detail };
      }
      if (detail.status === "deleted" || detail.status === "error") {
        throw new ManusV2ApiError(
          "file.detail",
          409,
          "FILE_UNUSABLE",
          false,
          false,
        );
      }
      if (Date.now() >= readinessDeadline) {
        throw new ManusV2ApiError(
          "file.detail",
          null,
          "FILE_PENDING",
          true,
          false,
        );
      }
      await sleep(Math.min(3_000, 500 * 2 ** Math.min(attempt, 3)));
    }
  }

  async fileDetail(fileId: string) {
    const expectedFileId = requiredString(fileId, "fileId", 512);
    const result = await this.request(
      "file.detail",
      () =>
        this.api.get(`${this.baseUrl}/v2/file.detail`, {
          params: { file_id: expectedFileId },
        }),
      false,
    );
    const file = upstreamTaskRecord(result.file);
    if (!file) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    let actualFileId: string;
    let status: string;
    let filename: string;
    let bytes: number | null;
    let expiresAt: number;
    let contentType: string | null;
    try {
      actualFileId = requiredString(file.id, "file.id", 512);
      status = requiredString(file.status, "file.status", 32);
      filename = requiredString(file.filename, "file.filename", 512);
      bytes = file.bytes === null ? null : Number(file.bytes);
      expiresAt = Number(file.expires_at);
      contentType = optionalString(file.content_type, 255);
    } catch (error) {
      if (error instanceof ManusV2ApiError) {
        throw new ManusV2ApiError(
          "file.detail",
          502,
          "INVALID_RESPONSE",
          false,
          true,
          providerRequestId(result),
        );
      }
      throw error;
    }
    if (actualFileId !== expectedFileId) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "FILE_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (!["pending", "uploaded", "deleted", "error"].includes(status)) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 ||
      (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
    ) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    return {
      fileId: actualFileId,
      filename,
      status: status as "pending" | "uploaded" | "deleted" | "error",
      bytes,
      expiresAt,
      contentType,
      requestId: providerRequestId(result),
    };
  }
}
