/**
 * FrontMind API Service Layer
 * Handles all communication with the API via the backend proxy.
 * Requests go through /api/frontmind/* which proxies to the actual API,
 * avoiding CORS issues entirely.
 *
 * KEY CHANGES:
 * - Switched from /v1/responses to /v1/tasks endpoint for correct model selection
 * - agentProfile is now a top-level parameter (not buried in extra_body)
 * - Uses prompt (text) + attachments format instead of input (messages array)
 * - Multi-turn uses taskId instead of previous_response_id
 * - Added credit event bus for real-time refresh
 * - Updated system prompt to keep upstream identity private
 */

import type { ResponseLogicDraft } from "@shared/response-logic";
import type { KnowledgeBaseInteractionDto } from "@shared/knowledge-base-progress";
import { stripKnowledgeBaseProtocolPayloads } from "@shared/knowledge-base-output";
import { userFacingErrorMessage } from "@/lib/user-facing-error";
import { assertChatAttachmentSizes } from "@/lib/attachment-files";
import {
  dispatchKnowledgeBaseProgressUpdated,
  knowledgeBaseObservationFromPayload,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";

/**
 * Model display mapping: public model id -> display name.
 * Upstream model ids are translated on the server and never shipped in the browser bundle.
 */
export const MODEL_OPTIONS = [
  { value: "frontmind-lite", label: "FrontMind-Lite", description: "简单任务" },
  { value: "frontmind-base", label: "FrontMind-Base", description: "通用任务" },
  { value: "frontmind-pro", label: "FrontMind-Pro", description: "复杂分析" },
] as const;

/**
 * Get the display label for a model value.
 */
export function getModelDisplayName(modelValue: string | undefined): string {
  if (!modelValue) return "FrontMind-Base";
  const found = MODEL_OPTIONS.find((m) => m.value === modelValue);
  return found ? found.label : sanitizeBrandText(modelValue);
}

// Non-sensitive, device-local display preference. API credentials are stored
// only by the server; browser-local credentials and conversations are not
// imported into an account.
const DEFAULT_CONFIG = {
  agentProfile: "frontmind-pro",
};
const DEVICE_PREFERENCES_STORAGE_KEY = "frontmind-client-preferences";

export const CREATE_TASK_TIMEOUT_MS = 300_000;
export const DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY =
  "frontmind.delivery.projectAssignmentId";

export function deliveryProjectHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const projectAssignmentId = sessionStorage
    .getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY)
    ?.trim();
  return {
    ...headers,
    ...(projectAssignmentId
      ? { "x-delivery-project-assignment-id": projectAssignmentId }
      : {}),
  };
}

function normalizePublicAgentProfile(value: string | undefined): string {
  if (value === "frontmind-lite") return "frontmind-lite";
  if (value === "frontmind-base") return "frontmind-base";
  if (value === "frontmind-pro") return "frontmind-pro";
  return DEFAULT_CONFIG.agentProfile;
}

export function getConfig() {
  const stored = localStorage.getItem(DEVICE_PREFERENCES_STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      return {
        ...DEFAULT_CONFIG,
        agentProfile: normalizePublicAgentProfile(parsed.agentProfile),
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: Partial<typeof DEFAULT_CONFIG>) {
  const merged = {
    ...getConfig(),
    agentProfile: normalizePublicAgentProfile(config.agentProfile),
  };
  localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Sanitize text by replacing source-brand strings with FrontMind equivalents.
 * This is applied to all API response text before rendering to the user.
 *
 */
export function sanitizeBrandText(text: string): string {
  if (!text) return "";
  // Defensive: ensure we only process strings
  if (typeof text !== "string") {
    try {
      return String(text);
    } catch {
      return "";
    }
  }

  try {
    const sourceBrands = [["ma", "nus"].join(""), ["jeno", "va"].join("")];
    return sourceBrands.reduce((visibleText, source) => {
      return visibleText
        .replace(
          new RegExp(`https?:\\/\\/api\\.${source}\\.`, "gi"),
          "https://api.frontmind.",
        )
        .replace(
          new RegExp(`https?:\\/\\/www\\.${source}\\.`, "gi"),
          "https://www.frontmind.",
        )
        .replace(
          new RegExp(`https?:\\/\\/${source}\\.`, "gi"),
          "https://frontmind.",
        )
        .replace(new RegExp(`\\b${source}\\b`, "gi"), "FrontMind");
    }, stripKnowledgeBaseProtocolPayloads(text));
  } catch (e) {
    console.error("[sanitizeBrandText] Error:", e);
    return text;
  }
}

// ============================================================
// Credit Usage Helpers
// ============================================================
const CREDIT_USAGE_CACHE_KEY = "frontmind-credit-usage-cache-v3";
const CREDIT_USAGE_CACHE_TTL_MS = 60 * 1000;

// ============================================================
// Credit Event Bus - for real-time refresh across components
// ============================================================
type CreditListener = () => void;

class CreditEventBus {
  private listeners: Set<CreditListener> = new Set();

  subscribe(listener: CreditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit() {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (e) {
        console.error("[CreditEventBus] Listener error:", e);
      }
    });
  }
}

export const creditEventBus = new CreditEventBus();

// Types
export interface ContentItem {
  type: "input_text" | "input_image" | "input_file";
  text?: string;
  image_url?: string;
  file_id?: string;
  filename?: string;
  /** Browser-observed MIME type; only the dedicated response-logic route stores it. */
  mime_type?: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: ContentItem[] | string;
}

export interface TaskResponse {
  id: string;
  object?: string;
  status: "running" | "pending" | "completed" | "error" | "failed";
  model?: string;
  created_at?: string;
  metadata?: {
    credit_usage?: string;
    task_url?: string;
    share_url?: string;
    task_title?: string;
    [key: string]: unknown;
  };
  output?: OutputMessage[];
  error?: {
    message?: string;
    code?: string;
  };
  knowledgeInteraction?: KnowledgeBaseInteractionDto;
  knowledgeObservation?: KnowledgeBaseObservationDto;
  /** Existing operation adopted after a tab remounted with a new request id. */
  adoptedClientRequestId?: string;
}

export interface ResponseLogicTaskContext {
  questionId: string;
  groupId: string;
  groupTitle: string;
  question: string;
  intent: string;
  summary: string;
  draft: ResponseLogicDraft;
}

/**
 * Output message from the API.
 */
export interface OutputMessage {
  id?: string;
  type?: string;
  role?: "user" | "assistant";
  status?: string;
  content?: OutputContent[];
  name?: string;
  action?: any;
  call_id?: string;
  arguments?: string;
  summary?: OutputSummary[];
  queries?: string[];
  [key: string]: unknown;
}

export interface OutputSummary {
  type?: string;
  text?: string;
}

export interface OutputContent {
  type?: string;
  text?: string | null;
  url?: string;
  fileUrl?: string;
  file_url?: string;
  imageUrl?: string;
  image_url?: string;
  fileId?: string;
  file_id?: string;
  fileName?: string;
  file_name?: string;
  filename?: string;
  name?: string;
  mimeType?: string;
  mime_type?: string;
  annotations?: unknown;
  logprobs?: unknown;
}

export interface FileRecord {
  id: string;
  object?: string;
  filename: string;
  status?: string;
  upload_url?: string;
  upload_expires_at?: string;
  proxy_upload_ticket?: string;
  proxy_upload_expires_at?: string;
  created_at?: string;
}

/**
 * Ephemeral capability for one managed upload record. It lives only in the
 * open starter dialog; the signed provider URL never enters the proxy query.
 */
export type ManagedUploadHandle = {
  fileId: string;
  filename: string;
  ticket: string;
  expiresAt: number;
};

export type UploadRecoveryAction =
  | "check_status"
  | "retry_same_file"
  | "discard_and_recreate"
  | "refresh_page"
  | "contact_admin";

export type FileUploadStage =
  | "creating_record"
  | "recovering"
  | "uploading"
  | "server_processing"
  | "uploaded";

export type UploadRetentionReceipt = {
  fileId: string;
  sizeBytes: number;
  uploadedAt: number;
  expiresAt: number;
  replayed: boolean;
  recovered: boolean;
  traceId?: string;
};

export type ManagedUploadRecovery =
  | {
      fileId: string;
      state: "ready" | "restage_required";
      recreateRequired: false;
      traceId?: string;
    }
  | {
      fileId: string;
      state: "uploaded";
      recreateRequired: false;
      receipt: UploadRetentionReceipt;
      traceId?: string;
    };

export type FileUploadStageEvent = {
  stage: FileUploadStage;
  fileId?: string;
  loadedBytes?: number;
  totalBytes?: number;
  receipt?: UploadRetentionReceipt;
  traceId?: string;
};

export type FileUploadRecordEvent = {
  fileId: string;
  filename: string;
  uploadHandle?: ManagedUploadHandle;
  reusedExistingFileId: boolean;
};

export type UploadFileOptions = {
  captureLocalCopy?: boolean;
  captureFilename?: string;
  /** Ephemeral batch correlation id; sent only to the authenticated proxy. */
  batchId?: string;
  /** One-based ephemeral batch position for safe server-side correlation. */
  batchOrdinal?: number;
  batchTotal?: number;
  signal?: AbortSignal;
  /** Reuses an already-created provider file after an unknown client outcome. */
  existingFileId?: string;
  /**
   * Reconciles this managed record before deciding whether another browser
   * body is needed. This is intentionally ephemeral and dialog-scoped.
   */
  existingUploadHandle?: ManagedUploadHandle;
  onStage?: (event: FileUploadStageEvent) => void;
  /** Runs before any file bytes are sent, so callers can retain the retry id. */
  onFileRecord?: (event: FileUploadRecordEvent) => void | Promise<void>;
  /** Runs after recovery-authorized discard and before replacement creation. */
  onFileRecordDiscarded?: (fileId: string) => void | Promise<void>;
};

export type FileUploadErrorCode =
  | "UPLOAD_CANCELLED"
  | "UPLOAD_TIMEOUT"
  | "UPLOAD_NETWORK_ERROR"
  | "UPLOAD_REJECTED"
  | "UPLOAD_RECEIPT_INVALID"
  | "UPLOAD_RECEIPT_FILE_MISMATCH"
  | "UPLOAD_ALREADY_BOUND"
  | "UPLOAD_DISCARD_FORBIDDEN"
  | "UPLOAD_DISCARD_FAILED"
  | "FILE_RECORD_INVALID"
  | "FILE_RECORD_CREATE_FAILED"
  | "FILE_RECORD_CALLBACK_FAILED"
  | "INVALID_UPLOAD_OPTIONS";

export class FileUploadError extends Error {
  readonly code: FileUploadErrorCode | string;
  readonly status?: number;
  readonly fileId?: string;
  readonly retryable: boolean;
  readonly cancelled: boolean;
  readonly traceId?: string;
  readonly recoveryAction?: UploadRecoveryAction;
  readonly recreateRequired: boolean;

  constructor(
    message: string,
    input: {
      code: FileUploadErrorCode | string;
      status?: number;
      fileId?: string;
      retryable?: boolean;
      cancelled?: boolean;
      traceId?: string;
      recoveryAction?: UploadRecoveryAction;
      recreateRequired?: boolean;
      cause?: unknown;
    },
  ) {
    super(
      message,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "FileUploadError";
    this.code = input.code;
    this.status = input.status;
    this.fileId = input.fileId;
    this.retryable = input.retryable ?? false;
    this.cancelled = input.cancelled ?? false;
    this.traceId = input.traceId;
    this.recoveryAction = input.recoveryAction;
    this.recreateRequired = input.recreateRequired ?? false;
  }
}

/**
 * Make API requests through the backend proxy to avoid CORS issues.
 */
async function apiRequest(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  const url = `/api/frontmind${endpoint}`;

  const headers = deliveryProjectHeaders({
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  });

  const isPost =
    options.method?.toUpperCase() === "POST" ||
    options.method?.toUpperCase() === "PUT";
  const timeout = timeoutMs ?? (isPost ? 120_000 : 30_000);
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else
    externalSignal?.addEventListener("abort", abortFromCaller, {
      once: true,
    });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "include",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMsg = `API Error ${response.status}`;
      try {
        const errorData = await response.json();
        errorMsg = errorData.error?.message || errorData.message || errorMsg;
      } catch {
        try {
          const errorText = await response.text();
          if (errorText) errorMsg += `: ${errorText.slice(0, 200)}`;
        } catch {
          errorMsg += `: ${response.statusText}`;
        }
      }
      const requestError = new Error(
        userFacingErrorMessage(
          Object.assign(new Error(errorMsg), { status: response.status }),
          `接口请求失败（${response.status}）`,
        ),
      ) as Error & {
        status?: number;
      };
      requestError.status = response.status;
      throw requestError;
    }

    return response;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      if (externalSignal?.aborted && !timedOut) {
        throw new DOMException("请求已取消", "AbortError");
      }
      throw new Error(
        `请求超时 (${Math.round(timeout / 1000)}s)，API 服务器响应过慢。可尝试重新发送。`,
      );
    }
    throw err;
  } finally {
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Build the prompt text from user input content items.
 * Extracts text from ContentItem arrays.
 */
function buildPromptText(input: Message[]): string {
  const parts: string[] = [];

  // Extract text from user messages
  for (const msg of input) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === "input_text" && item.text) {
          parts.push(item.text);
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * Extract attachments (images and files) from user input content items.
 * Returns an array suitable for the /v1/tasks attachments field.
 *
 * Per FrontMind API docs: attachments must use { filename: "xxx", file_id: "file-xxx" } format.
 */
function extractAttachments(
  input: Message[],
  includeResponseLogicMetadata = false,
): any[] {
  const attachments: any[] = [];

  for (const msg of input) {
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const item of msg.content) {
      // Images: use file_id + filename format (API requires HTTP/HTTPS URLs, not base64)
      if (item.type === "input_image") {
        if (item.file_id) {
          // Successfully uploaded image
          attachments.push({
            filename: item.filename || "image.png",
            file_id: item.file_id,
            ...(includeResponseLogicMetadata && item.mime_type
              ? { mime_type: item.mime_type }
              : {}),
          });
        }
        // If only image_url (base64), skip - these are fallback cases
        // and will be handled differently by the API
      } else if (item.type === "input_file" && item.file_id) {
        attachments.push({
          filename: item.filename || "file",
          file_id: item.file_id,
          ...(includeResponseLogicMetadata && item.mime_type
            ? { mime_type: item.mime_type }
            : {}),
        });
      }
    }
  }

  return attachments;
}

/**
 * Create a new task using the native /v1/tasks endpoint.
 *
 * KEY FIX: Uses /v1/tasks with agentProfile as a top-level parameter
 * so the API correctly routes to the selected model (lite/base/max).
 *
 * For multi-turn conversations, uses taskId to continue an existing task.
 */
export async function createTask(
  input: Message[],
  options?: {
    previousResponseId?: string;
    taskId?: string;
    projectId?: string;
    agentProfile?: string;
  },
): Promise<TaskResponse> {
  const config = getConfig();

  // Use per-message model override if provided, otherwise fall back to config
  const modelToUse = options?.agentProfile || config.agentProfile;

  const isMultiTurn = !!options?.previousResponseId;

  // Build prompt text from input messages
  const prompt = buildPromptText(input);

  // Extract attachments (images, files)
  const attachments = extractAttachments(input);

  // Build the request body for /v1/tasks
  const body: Record<string, unknown> = {
    prompt,
    agentProfile: modelToUse,
    taskMode: "agent",
  };

  // Add attachments if any
  if (attachments.length > 0) {
    body.attachments = attachments;
  }

  // Multi-turn: use taskId to continue existing task
  if (options?.previousResponseId) {
    body.taskId = options.previousResponseId;
  }

  if (options?.projectId) {
    body.projectId = options.projectId;
  }

  // No 404 retry logic needed: API key changes now force a new workflow,
  // so taskId will always belong to the current key.
  const response = await apiRequest(
    "/v1/tasks",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    CREATE_TASK_TIMEOUT_MS,
  );
  const data = await response.json();

  // Normalize the response format
  // The native /v1/tasks API may return different field names
  const taskId = data.id || data.task_id;
  const taskStatus = data.status || "running";

  // If the response has task_id but no id, normalize it
  if (!data.id && data.task_id) {
    return {
      id: data.task_id,
      status: taskStatus === "failed" ? "error" : taskStatus,
      model: data.model,
      metadata: {
        credit_usage: data.credit_usage || data.metadata?.credit_usage,
        task_url: data.task_url || data.metadata?.task_url,
        task_title: data.task_title || data.metadata?.task_title,
        share_url: data.share_url || data.metadata?.share_url,
      },
      output: data.output || [],
    } as TaskResponse;
  }

  // Normalize status
  if (data.status === "failed") {
    data.status = "error";
  }

  return data;
}

/**
 * Starts a new per-question response-logic task. The private Skill and the
 * latest published knowledge base are injected on the server, never shipped
 * to or trusted from the browser.
 */
export async function createResponseLogicTask(
  input: Message[],
  context: ResponseLogicTaskContext & {
    conversationId: string;
    taskId?: string;
  },
): Promise<TaskResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    CREATE_TASK_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      context.taskId ? "/api/response-logic/turn" : "/api/response-logic/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          ...context,
          userMessage: buildPromptText(input),
          attachments: extractAttachments(input, true),
        }),
      },
    );
    if (!response.ok) {
      let message = `API Error ${response.status}`;
      try {
        const payload = await response.json();
        message = payload?.error?.message || payload?.message || message;
      } catch {
        // Keep the status-derived message.
      }
      throw new Error(
        userFacingErrorMessage(
          Object.assign(new Error(message), { status: response.status }),
          `任务创建失败（${response.status}）`,
        ),
      );
    }
    const payload = await response.json();
    const data = payload?.task || payload;
    const taskId = data?.id || data?.task_id;
    if (!taskId) throw new Error("任务创建失败：未返回任务 ID");
    return {
      ...data,
      id: taskId,
      status: data.status === "failed" ? "error" : data.status || "running",
      metadata: {
        ...(data.metadata || {}),
        task_url: data.task_url || data.metadata?.task_url,
        task_title: data.task_title || data.metadata?.task_title,
      },
      output: data.output || [],
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * Continues a knowledge-base build through its dedicated server-side Skill
 * route. The server owns the model, current node, revision, and progress
 * contract; the browser supplies only the visible turn and uploaded file IDs.
 */
export interface KnowledgeBaseAttachmentManifestItem {
  filename: string;
  sizeBytes: number;
  mimeType: string;
  lastModified: number;
  sha256: string;
}

export interface KnowledgeBaseAttachmentTurnReservation {
  state:
    | "awaiting_attachments"
    | "pending"
    | "bound"
    | "completed"
    | "terminal";
  turnId: string;
  clientRequestId: string;
  generation: number;
  revision: number;
  leafId: string | null;
  stagedAttachmentCount: number;
  expectedAttachmentCount: number;
  requiresUpload: boolean;
}

export type KnowledgeBaseRequestError = Error & {
  status?: number;
  code?: string;
  retryAfter?: string;
  retryAfterMs?: number;
  knowledgeObservation?: KnowledgeBaseObservationDto;
};

const KNOWLEDGE_BASE_TURN_REQUEST_MAX_ATTEMPTS = 4;
const KNOWLEDGE_BASE_REQUEST_MAX_RETRY_DELAY_MS = 10_000;

function isTransientKnowledgeBaseRequestError(error: unknown) {
  const status = Number((error as { status?: unknown })?.status || 0);
  const code = String((error as { code?: unknown })?.code || "");
  return (
    !status ||
    code === "IDEMPOTENCY_PENDING" ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function knowledgeBaseRequestRetryDelay(error: unknown, attempt: number) {
  const serverDelay = Number(
    (error as { retryAfterMs?: unknown })?.retryAfterMs,
  );
  const backoffDelay = 500 * 2 ** attempt;
  return Math.min(
    KNOWLEDGE_BASE_REQUEST_MAX_RETRY_DELAY_MS,
    Math.max(
      backoffDelay,
      Number.isFinite(serverDelay) && serverDelay >= 0 ? serverDelay : 0,
    ),
  );
}

async function waitForKnowledgeBaseRequestRetry(
  error: unknown,
  attempt: number,
) {
  await new Promise((resolve) =>
    setTimeout(resolve, knowledgeBaseRequestRetryDelay(error, attempt)),
  );
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  const normalized = String(value || "").trim();
  if (!normalized) return undefined;

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

async function knowledgeBaseRequestError(
  response: Response,
  fallback: string,
): Promise<KnowledgeBaseRequestError> {
  let message = `API Error ${response.status}`;
  let payload: any = null;
  try {
    payload = await response.json();
    message = payload?.error?.message || payload?.message || message;
  } catch {
    // Keep the status-derived message.
  }
  const retryAfter =
    response.headers?.get?.("Retry-After")?.trim() || undefined;
  const error = new Error(
    sanitizeBrandText(
      userFacingErrorMessage(
        Object.assign(new Error(message), { status: response.status }),
        fallback,
      ),
    ),
  ) as KnowledgeBaseRequestError;
  error.status = response.status;
  error.code =
    String(payload?.error?.code || payload?.code || "").trim() || undefined;
  error.retryAfter = retryAfter;
  error.retryAfterMs = retryAfterMilliseconds(retryAfter || null);
  if (payload?.observation) {
    error.knowledgeObservation = knowledgeBaseObservationFromPayload(payload);
  }
  return error;
}

export async function reserveKnowledgeBaseTurnWithAttachments(
  input: Message[],
  context: {
    conversationId: string;
    clientRequestId: string;
    expectedGeneration: number;
    expectedRevision: number;
    expectedLeafId: string;
    expectedPresentationKey?: string;
    attachmentManifest: KnowledgeBaseAttachmentManifestItem[];
    resumeExisting?: boolean;
  },
): Promise<{
  reservation: KnowledgeBaseAttachmentTurnReservation;
  knowledgeObservation?: KnowledgeBaseObservationDto;
}> {
  const response = await fetch("/api/knowledge-base/turn/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: context.conversationId,
      clientRequestId: context.clientRequestId,
      expectedGeneration: context.expectedGeneration,
      expectedRevision: context.expectedRevision,
      expectedLeafId: context.expectedLeafId,
      expectedPresentationKey: context.expectedPresentationKey,
      userMessage: buildPromptText(input),
      attachmentManifest: context.attachmentManifest,
      resumeExisting: context.resumeExisting === true,
    }),
  });
  if (!response.ok) {
    throw await knowledgeBaseRequestError(
      response,
      `本轮预约失败（${response.status}）`,
    );
  }
  const payload = await response.json();
  if (!payload?.reservation?.turnId || !payload.reservation.clientRequestId) {
    throw new Error("本轮预约失败：服务端未返回逻辑轮次");
  }
  return {
    reservation: payload.reservation,
    knowledgeObservation: payload?.observation
      ? knowledgeBaseObservationFromPayload(payload)
      : undefined,
  };
}

export async function stageKnowledgeBaseTurnAttachment(input: {
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  attachmentManifest: KnowledgeBaseAttachmentManifestItem[];
  index: number;
  attachment: { file_id: string; filename: string };
}) {
  // Staging is a replay-safe database append. Retry the same file id so a lost
  // response cannot force a second upload or a replacement at this index.
  const maxAttempts = 4;
  const maxRetryDelayMs = 10_000;
  const requestBody = JSON.stringify(input);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(
        "/api/knowledge-base/turn/attachments/stage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: requestBody,
        },
      );
      if (!response.ok) {
        throw await knowledgeBaseRequestError(
          response,
          `附件暂存失败（${response.status}）`,
        );
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const status = Number((error as { status?: unknown })?.status || 0);
      const code = String((error as { code?: unknown })?.code || "");
      const retryable =
        !status ||
        code === "IDEMPOTENCY_PENDING" ||
        status === 425 ||
        status === 429 ||
        status >= 500;
      if (!retryable || attempt === maxAttempts - 1) throw error;

      const serverDelay = Number(
        (error as { retryAfterMs?: unknown })?.retryAfterMs,
      );
      const backoffDelay = 500 * 2 ** attempt;
      const retryDelay = Math.min(
        maxRetryDelayMs,
        Math.max(
          backoffDelay,
          Number.isFinite(serverDelay) && serverDelay >= 0 ? serverDelay : 0,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw lastError;
}

export async function createKnowledgeBaseTurnTask(
  input: Message[],
  context: {
    conversationId: string;
    clientRequestId: string;
    submissionKind?: "message" | "logo";
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string;
    expectedPresentationKey?: string;
    /** Exact browser bytes for upload-first knowledge-base attachments. */
    attachmentManifest?: KnowledgeBaseAttachmentManifestItem[];
    attachmentReservation?: {
      turnId: string;
      attachmentManifest: KnowledgeBaseAttachmentManifestItem[];
    };
    /**
     * Rollout-only bridge for a durable browser reservation created by the
     * former reserve-before-upload client. The ordered manifest identifies
     * the original browser bytes; it is not an upload-completion probe.
     */
    legacyAttachmentTakeover?: {
      attachmentManifest: KnowledgeBaseAttachmentManifestItem[];
    };
  },
): Promise<TaskResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    CREATE_TASK_TIMEOUT_MS,
  );
  try {
    const endpoint = context.attachmentReservation
      ? "/api/knowledge-base/turn/dispatch"
      : "/api/knowledge-base/turn";
    // The server reserves this logical turn by clientRequestId before external
    // dispatch. Serialize once and replay these exact bytes so a disconnected
    // response can never become a second logical confirmation.
    const requestBody = JSON.stringify({
      conversationId: context.conversationId,
      clientRequestId: context.clientRequestId,
      ...(context.attachmentReservation
        ? {
            turnId: context.attachmentReservation.turnId,
            attachmentManifest:
              context.attachmentReservation.attachmentManifest,
          }
        : {
            expectedGeneration: context.expectedGeneration,
            expectedRevision: context.expectedRevision,
            expectedLeafId: context.expectedLeafId,
            expectedPresentationKey: context.expectedPresentationKey,
            submissionKind: context.submissionKind ?? "message",
            userMessage: buildPromptText(input),
            attachments: extractAttachments(input),
            ...(context.attachmentManifest
              ? { attachmentManifest: context.attachmentManifest }
              : {}),
            ...(context.legacyAttachmentTakeover
              ? {
                  resumeLegacyAttachments: true,
                  attachmentManifest:
                    context.legacyAttachmentTakeover.attachmentManifest,
                }
              : {}),
          }),
    });
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt < KNOWLEDGE_BASE_TURN_REQUEST_MAX_ATTEMPTS;
      attempt += 1
    ) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal: controller.signal,
          body: requestBody,
        });
      } catch (error) {
        lastError = error;
        if (
          controller.signal.aborted ||
          attempt === KNOWLEDGE_BASE_TURN_REQUEST_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }
        await waitForKnowledgeBaseRequestRetry(error, attempt);
        continue;
      }

      if (!response.ok) {
        const error = await knowledgeBaseRequestError(
          response,
          `任务创建失败（${response.status}）`,
        );
        lastError = error;
        if (
          !isTransientKnowledgeBaseRequestError(error) ||
          attempt === KNOWLEDGE_BASE_TURN_REQUEST_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }
        await waitForKnowledgeBaseRequestRetry(error, attempt);
        continue;
      }

      const payload = await response.json();
      const data = payload?.task || payload;
      const observation = payload?.observation
        ? knowledgeBaseObservationFromPayload(payload)
        : undefined;
      const returnedTaskId = data?.id || data?.task_id || "";
      const taskId = returnedTaskId || observation?.authoritativeTaskId || "";
      if (!observation && !data?.id && !data?.task_id) {
        throw new Error("任务创建失败：未返回权威任务状态");
      }
      if (observation) dispatchKnowledgeBaseProgressUpdated(observation);
      return {
        ...data,
        id: taskId,
        status: data.status === "failed" ? "error" : data.status || "running",
        metadata: {
          ...(data.metadata || {}),
          task_url: data.taskUrl || data.task_url || data.metadata?.task_url,
          task_title:
            data.title || data.task_title || data.metadata?.task_title,
        },
        output: data.output || [],
        knowledgeInteraction:
          payload?.observation?.interaction ?? payload?.interaction,
        knowledgeObservation: observation,
        adoptedClientRequestId:
          String(payload?.adoptedClientRequestId || "").trim() || undefined,
      };
    }

    throw lastError || new Error("任务创建失败：已达到重试上限");
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * Retrieve task status and results.
 *
 * Try /v1/tasks/ first for richer intermediate step data,
 * falls back to /v1/responses/ if /v1/tasks/ fails.
 */
export async function retrieveTask(responseId: string): Promise<TaskResponse> {
  // Try native tasks API first for richer intermediate step data
  try {
    const response = await apiRequest(`/v1/tasks/${responseId}`);
    const data = await response.json();
    if (data.status === "failed") {
      data.status = "error";
    }
    return data;
  } catch (err: any) {
    if (err?.status !== 404 && err?.status !== 405) {
      throw err;
    }
    console.warn(
      `[retrieveTask] /v1/tasks/ is unavailable (${err.status}), trying /v1/responses/`,
    );
    try {
      const response = await apiRequest(`/v1/responses/${responseId}`);
      const data = await response.json();
      if (data.status === "failed") {
        data.status = "error";
      }
      return data;
    } catch (fallbackErr: any) {
      throw fallbackErr;
    }
  }
}

/**
 * List all tasks
 */
export async function listTasks(params?: {
  limit?: number;
  status?: string[];
  order?: "asc" | "desc";
  after?: string;
}): Promise<{
  data: TaskResponse[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.order) searchParams.set("order", params.order);
  if (params?.after) searchParams.set("after", params.after);
  if (params?.status) {
    params.status.forEach((s) => searchParams.append("status", s));
  }

  const query = searchParams.toString();
  const response = await apiRequest(`/v1/tasks${query ? `?${query}` : ""}`);
  return response.json();
}

/**
 * Upload a file - Step 1: Create file record
 */
export async function createFileRecord(
  filename: string,
  signal?: AbortSignal,
): Promise<FileRecord> {
  const response = await apiRequest("/v1/files", {
    method: "POST",
    body: JSON.stringify({ filename }),
    signal,
  });
  return response.json();
}

function managedUploadHandleFromRecord(
  record: FileRecord,
  requestedFilename: string,
): ManagedUploadHandle | undefined {
  const fileId = typeof record.id === "string" ? record.id : "";
  const responseFilename =
    typeof record.filename === "string" ? record.filename : "";
  const filename =
    typeof requestedFilename === "string" ? requestedFilename : "";
  const ticket =
    typeof record.proxy_upload_ticket === "string"
      ? record.proxy_upload_ticket
      : "";
  const expiresAt = Date.parse(String(record.proxy_upload_expires_at || ""));
  if (
    !fileId.trim() ||
    !responseFilename.trim() ||
    !filename.trim() ||
    !ticket ||
    ticket !== ticket.trim() ||
    !Number.isFinite(expiresAt)
  ) {
    return undefined;
  }
  return { fileId, filename, ticket, expiresAt };
}

function uploadRecoveryAction(
  value: unknown,
): UploadRecoveryAction | undefined {
  return [
    "check_status",
    "retry_same_file",
    "discard_and_recreate",
    "refresh_page",
    "contact_admin",
  ].includes(String(value))
    ? (String(value) as UploadRecoveryAction)
    : undefined;
}

function normalizedManagedRecoveryDirective(
  recoveryAction: UploadRecoveryAction | undefined,
  recreateRequired: boolean,
) {
  // Deletion requires the server's explicit action, not a lone boolean. Treat
  // contradictory metadata as an unknown result so the client can only check
  // status and can never discard a potentially successful upload.
  if (recreateRequired && recoveryAction !== "discard_and_recreate") {
    return {
      recoveryAction: "check_status" as const,
      recreateRequired: false,
    };
  }
  return { recoveryAction, recreateRequired };
}

async function managedUploadResponseError(
  response: Response,
  fallback: string,
  fallbackFileId?: string,
): Promise<FileUploadError> {
  let message = "";
  let code = "UPLOAD_REJECTED";
  let retryable: boolean | undefined;
  let traceId: string | undefined;
  let recoveryAction: UploadRecoveryAction | undefined;
  let recreateRequired = false;
  let fileId = fallbackFileId;
  let fileIdMismatch = false;
  try {
    const payload = (await response.json()) as {
      error?: {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
        traceId?: unknown;
        recoveryAction?: unknown;
        recreateRequired?: unknown;
        fileId?: unknown;
      };
    };
    const error = payload.error;
    if (typeof error?.message === "string") message = error.message;
    if (typeof error?.code === "string" && error.code.trim()) {
      code = error.code.trim();
    }
    if (typeof error?.retryable === "boolean") retryable = error.retryable;
    if (typeof error?.traceId === "string" && error.traceId.trim()) {
      traceId = error.traceId.trim();
    }
    const directive = normalizedManagedRecoveryDirective(
      uploadRecoveryAction(error?.recoveryAction),
      error?.recreateRequired === true,
    );
    recoveryAction = directive.recoveryAction;
    recreateRequired = directive.recreateRequired;
    if (typeof error?.fileId === "string" && error.fileId.trim()) {
      if (fileId !== undefined && error.fileId !== fileId) {
        fileIdMismatch = true;
      } else {
        fileId = error.fileId;
      }
    }
  } catch {
    // Never expose provider XML or an unstructured response body.
  }
  if (fileIdMismatch) {
    message = "服务端文件身份与当前上传不匹配，请稍后确认状态";
    code = "UPLOAD_RECOVERY_INVALID";
    retryable = true;
    recoveryAction = "check_status";
    recreateRequired = false;
  }
  return new FileUploadError(
    userFacingErrorMessage(
      Object.assign(new Error(message), { status: response.status }),
      fallback,
    ),
    {
      code,
      status: response.status,
      fileId,
      retryable: retryable ?? isRetryableUploadStatus(response.status),
      traceId,
      recoveryAction,
      recreateRequired,
    },
  );
}

/**
 * Reconciles an earlier managed attempt without sending its browser body.
 * Callers must finish this request before discarding or creating a replacement
 * record, otherwise an unknown successful upload could be deleted or orphaned.
 */
export async function recoverManagedUpload(
  handle: Pick<ManagedUploadHandle, "fileId" | "ticket"> & {
    filename?: string;
  },
  file: File,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedUploadRecovery> {
  const fileId = typeof handle.fileId === "string" ? handle.fileId : "";
  const ticket = typeof handle.ticket === "string" ? handle.ticket : "";
  const filename =
    typeof handle.filename === "string" ? handle.filename : file.name;
  if (
    !fileId.trim() ||
    !filename.trim() ||
    (ticket.length > 0 && ticket !== ticket.trim())
  ) {
    throw new FileUploadError("待恢复的文件身份或上传凭证无效", {
      code: "INVALID_UPLOAD_OPTIONS",
      retryable: false,
    });
  }
  if (options.signal?.aborted) throw cancelledFileUploadError(fileId);

  const headers = deliveryProjectHeaders({
    "Content-Type": "application/json",
    ...(ticket ? { "X-FrontMind-Upload-Ticket": ticket } : {}),
  });
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MANAGED_UPLOAD_RECOVERY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `/api/frontmind/v1/files/${encodeURIComponent(fileId)}/upload-recovery`,
      {
        method: "POST",
        headers,
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          filename,
          sizeBytes: file.size,
          mimeType: file.type || "application/octet-stream",
        }),
      },
    );
  } catch (error) {
    if (options.signal?.aborted && !timedOut) {
      throw cancelledFileUploadError(fileId, error);
    }
    throw new FileUploadError(
      timedOut
        ? "确认文件上传状态超时，请稍后重试"
        : "暂时无法确认文件上传状态，请稍后重试",
      {
        code: "UPLOAD_RECOVERY_UNAVAILABLE",
        fileId,
        retryable: true,
        recoveryAction: "check_status",
        cause: error,
      },
    );
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  if (!response.ok) {
    throw await managedUploadResponseError(
      response,
      "暂时无法确认文件上传状态，请稍后重试",
      fileId,
    );
  }

  let value: Record<string, unknown>;
  try {
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid recovery response");
    }
    value = parsed as Record<string, unknown>;
  } catch (error) {
    throw new FileUploadError("文件恢复响应无效，请稍后重试", {
      code: "UPLOAD_RECOVERY_INVALID",
      fileId,
      retryable: true,
      recoveryAction: "check_status",
      cause: error,
    });
  }
  const traceId =
    typeof value.traceId === "string" && value.traceId.trim()
      ? value.traceId.trim()
      : undefined;
  if (
    value.fileId !== fileId ||
    value.recreateRequired !== false ||
    !["ready", "restage_required", "uploaded"].includes(String(value.state))
  ) {
    throw new FileUploadError("文件恢复响应与当前文件不匹配，请稍后重试", {
      code: "UPLOAD_RECOVERY_INVALID",
      fileId,
      retryable: true,
      traceId,
      recoveryAction: "check_status",
    });
  }
  if (value.state === "uploaded") {
    const receipt = parseUploadRetentionReceiptValue(
      value.receipt,
      fileId,
      file.size,
      traceId,
    );
    return {
      fileId,
      state: "uploaded",
      recreateRequired: false,
      receipt,
      traceId,
    };
  }
  return {
    fileId,
    state: value.state as "ready" | "restage_required",
    recreateRequired: false,
    traceId,
  };
}

/**
 * Removes a file record that the user deliberately removed before it became
 * attached to a task. Ordinary upload failures keep the record for same-id
 * recovery and must not call this helper automatically.
 */
export async function discardUnboundUpload(
  fileId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!fileId.trim()) {
    throw new FileUploadError("缺少待清理的文件 ID", {
      code: "INVALID_UPLOAD_OPTIONS",
      retryable: false,
    });
  }
  if (options.signal?.aborted) {
    throw cancelledFileUploadError(fileId);
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30_000);
  let response: Response;
  try {
    response = await fetch(
      `/api/frontmind/v1/files/${encodeURIComponent(fileId)}/discard`,
      {
        method: "DELETE",
        headers: deliveryProjectHeaders(),
        credentials: "include",
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (options.signal?.aborted && !timedOut) {
      throw cancelledFileUploadError(fileId, error);
    }
    if (timedOut || (error as { name?: unknown })?.name === "AbortError") {
      throw new FileUploadError("文件清理请求超时，请稍后重试", {
        code: "UPLOAD_DISCARD_FAILED",
        fileId,
        retryable: true,
        cause: error,
      });
    }
    throw new FileUploadError("文件清理请求失败，请稍后重试", {
      code: "UPLOAD_DISCARD_FAILED",
      fileId,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  if (response.status === 204) return;

  let code = "UPLOAD_DISCARD_FAILED";
  let message = "";
  try {
    const payload = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof payload.error?.code === "string") code = payload.error.code;
    if (typeof payload.error?.message === "string") {
      message = payload.error.message;
    }
  } catch {
    // Never expose raw upstream cleanup responses.
  }
  throw new FileUploadError(
    userFacingErrorMessage(
      Object.assign(new Error(message), { status: response.status }),
      response.status === 409
        ? "文件已经绑定到任务，不能移除"
        : response.status === 403
          ? "当前账号无权移除该文件"
          : "文件暂时无法清理，请稍后重试",
    ),
    {
      code,
      status: response.status,
      fileId,
      retryable: code === "UPLOAD_IN_PROGRESS" || response.status >= 500,
    },
  );
}

export const FILE_UPLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1000;
export const FILE_UPLOAD_SERVER_COMPLETION_TIMEOUT_MS = 6 * 60 * 1000;
export const MANAGED_UPLOAD_RECOVERY_TIMEOUT_MS = 30_000;
const MANAGED_UPLOAD_TICKET_MIN_REMAINING_MS = 15_000;

function installFileUploadWatchdog(
  xhr: XMLHttpRequest,
  onProgress?: (percent: number) => void,
  input: {
    totalBytes: number;
    onTransfer?: (loadedBytes: number, totalBytes: number) => void;
    onUploadComplete?: () => void;
  } = { totalBytes: 0 },
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let uploadComplete = false;
  const arm = (waitMs: number) => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timedOut = true;
      xhr.abort();
    }, waitMs);
  };
  const markUploadComplete = () => {
    if (uploadComplete) return;
    uploadComplete = true;
    arm(FILE_UPLOAD_SERVER_COMPLETION_TIMEOUT_MS);
    if (onProgress) onProgress(100);
    input.onTransfer?.(input.totalBytes, input.totalBytes);
    input.onUploadComplete?.();
  };
  xhr.upload.addEventListener("progress", (event) => {
    const transferComplete =
      event.lengthComputable && event.loaded >= event.total;
    arm(
      transferComplete
        ? FILE_UPLOAD_SERVER_COMPLETION_TIMEOUT_MS
        : FILE_UPLOAD_STALL_TIMEOUT_MS,
    );
    if (event.lengthComputable) {
      if (onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
      input.onTransfer?.(event.loaded, event.total);
    }
    if (transferComplete) markUploadComplete();
  });
  xhr.upload.addEventListener("load", markUploadComplete);
  return {
    start: () => arm(FILE_UPLOAD_STALL_TIMEOUT_MS),
    markUploadComplete,
    clear: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = undefined;
    },
    timedOut: () => timedOut,
  };
}

/**
 * Upload a file - Step 2: Upload to presigned URL with progress tracking
 */
export async function uploadFileToUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledFileUploadError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const abortFromCaller = () => xhr.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );

    const watchdog = installFileUploadWatchdog(xhr, onProgress, {
      totalBytes: file.size,
    });
    const cleanup = () => {
      watchdog.clear();
      signal?.removeEventListener("abort", abortFromCaller);
    };

    xhr.addEventListener("load", () => {
      // A provider can reject from headers before the browser finishes sending
      // the body. Only a successful response may synthesize completion; the
      // upload progress/load listeners remain authoritative for failed calls.
      if (xhr.status >= 200 && xhr.status < 300) {
        watchdog.markUploadComplete();
      }
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new FileUploadError(`文件上传失败（${xhr.status}）`, {
            code: "UPLOAD_REJECTED",
            status: xhr.status,
            retryable: isRetryableUploadStatus(xhr.status),
          }),
        );
      }
    });

    xhr.addEventListener("error", () => {
      cleanup();
      reject(
        new FileUploadError("文件上传网络异常，存储服务可能未允许当前来源", {
          code: "UPLOAD_NETWORK_ERROR",
          retryable: true,
        }),
      );
    });

    xhr.addEventListener("abort", () => {
      const timedOut = watchdog.timedOut();
      cleanup();
      reject(timedOut ? timedOutFileUploadError() : cancelledFileUploadError());
    });

    watchdog.start();
    xhr.send(file);
  });
}

/**
 * Full file upload flow with progress tracking.
 */
export async function uploadFile(
  file: File,
  onProgress?: (percent: number) => void,
  retryConfig: {
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
  } = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
  },
  options: UploadFileOptions = {},
): Promise<{
  fileId: string;
  filename: string;
  sizeBytes?: number;
  uploadedAt?: number;
  expiresAt?: number;
  replayed?: boolean;
  recovered?: boolean;
  traceId?: string;
}> {
  // This is the single browser upload boundary, including non-chat product
  // surfaces. Reject before creating the upstream record so an oversized
  // selection cannot leave an upstream-only orphan.
  assertChatAttachmentSizes([file]);
  const captureLocalCopy = options.captureLocalCopy ?? true;
  if (options.signal?.aborted) throw cancelledFileUploadError();
  const handleFileId = options.existingUploadHandle?.fileId;
  const optionFileId = options.existingFileId;
  if (
    (handleFileId !== undefined && !handleFileId.trim()) ||
    (optionFileId !== undefined && !optionFileId.trim()) ||
    (options.existingUploadHandle !== undefined &&
      (!options.existingUploadHandle.filename.trim() ||
        !options.existingUploadHandle.ticket ||
        options.existingUploadHandle.ticket !==
          options.existingUploadHandle.ticket.trim()))
  ) {
    throw new FileUploadError("待恢复的安全上传凭证无效", {
      code: "INVALID_UPLOAD_OPTIONS",
      retryable: false,
    });
  }
  if (handleFileId && optionFileId && handleFileId !== optionFileId) {
    throw new FileUploadError("待恢复的文件记录不一致", {
      code: "INVALID_UPLOAD_OPTIONS",
      retryable: false,
    });
  }
  const existingFileId = handleFileId || optionFileId;
  if (existingFileId && !captureLocalCopy) {
    throw new FileUploadError("只有服务端留存上传才能复用已有文件 ID", {
      code: "INVALID_UPLOAD_OPTIONS",
      retryable: false,
    });
  }
  if (onProgress) onProgress(0);
  options.onStage?.({
    stage: "creating_record",
    ...(existingFileId ? { fileId: existingFileId } : {}),
    loadedBytes: 0,
    totalBytes: file.size,
  });
  let fileRecord: FileRecord | undefined;
  let uploadHandle = options.existingUploadHandle;
  let retentionReceipt: UploadRetentionReceipt | undefined;
  let reusedExistingFileId = Boolean(existingFileId);

  if (existingFileId) {
    options.onStage?.({
      stage: "recovering",
      fileId: existingFileId,
      loadedBytes: 0,
      totalBytes: file.size,
    });
    try {
      const recovery = await recoverManagedUpload(
        {
          fileId: existingFileId,
          ticket: uploadHandle?.ticket || "",
          filename: uploadHandle ? uploadHandle.filename : file.name,
        },
        file,
        { signal: options.signal },
      );
      if (recovery.state === "uploaded") {
        retentionReceipt = recovery.receipt;
      } else if (recovery.state === "restage_required") {
        throw new FileUploadError(
          "服务端尚未提供可验证的上传回执，请稍后确认状态",
          {
            code: "UPLOAD_RECOVERY_UNVERIFIED",
            fileId: existingFileId,
            retryable: true,
            traceId: recovery.traceId,
            recoveryAction: "check_status",
          },
        );
      } else if (
        !uploadHandle?.ticket ||
        !Number.isFinite(uploadHandle.expiresAt) ||
        uploadHandle.expiresAt - Date.now() <
          MANAGED_UPLOAD_TICKET_MIN_REMAINING_MS
      ) {
        throw new FileUploadError("安全上传凭证已失效，请重新确认文件状态", {
          code:
            uploadHandle && Number.isFinite(uploadHandle.expiresAt)
              ? "UPLOAD_CAPABILITY_EXPIRED"
              : "UPLOAD_CAPABILITY_REQUIRED",
          fileId: existingFileId,
          retryable: true,
          traceId: recovery.traceId,
          recoveryAction: "check_status",
        });
      }
      fileRecord = { id: existingFileId, filename: file.name };
    } catch (error) {
      if (options.signal?.aborted) {
        throw cancelledFileUploadError(existingFileId, error);
      }
      const structured = error as {
        recoveryAction?: unknown;
        recreateRequired?: unknown;
      };
      if (structured.recoveryAction !== "discard_and_recreate") {
        throw error;
      }

      // The order is safety-critical: first reconcile, then successfully
      // discard the known-unbound old record, and only then create a new one.
      await discardUnboundUpload(existingFileId, { signal: options.signal });
      await options.onFileRecordDiscarded?.(existingFileId);
      fileRecord = undefined;
      uploadHandle = undefined;
      reusedExistingFileId = false;
    }
  }

  if (!fileRecord) {
    try {
      // Record creation is never in a generic retry loop. The sole replacement
      // above is explicitly authorized by a recovery response and follows a
      // successful discard, preventing duplicate provider records.
      fileRecord = await createFileRecord(file.name, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        throw cancelledFileUploadError(existingFileId, error);
      }
      const status = uploadErrorStatus(error);
      throw new FileUploadError(
        userFacingErrorMessage(error, "创建文件记录失败，请稍后重试"),
        {
          code: "FILE_RECORD_CREATE_FAILED",
          status,
          retryable: status === undefined || isRetryableUploadStatus(status),
          cause: error,
        },
      );
    }
    uploadHandle = managedUploadHandleFromRecord(fileRecord, file.name);
  }

  const fileId = typeof fileRecord.id === "string" ? fileRecord.id : "";
  if (!fileId.trim()) {
    throw new FileUploadError("创建文件记录失败：未获取到文件 ID", {
      code: "FILE_RECORD_INVALID",
      retryable: true,
    });
  }
  if (
    captureLocalCopy &&
    !retentionReceipt &&
    !uploadHandle &&
    !reusedExistingFileId
  ) {
    throw new FileUploadError("创建文件记录失败：未获取到安全上传凭证", {
      code: "FILE_RECORD_INVALID",
      fileId,
      retryable: true,
      recoveryAction: "retry_same_file",
    });
  }
  try {
    await options.onFileRecord?.({
      fileId,
      filename: fileRecord.filename || file.name,
      ...(uploadHandle ? { uploadHandle } : {}),
      reusedExistingFileId,
    });
  } catch (error) {
    throw new FileUploadError("文件记录保存失败，请重试", {
      code: "FILE_RECORD_CALLBACK_FAILED",
      fileId,
      retryable: true,
      cause: error,
    });
  }

  if (captureLocalCopy && !retentionReceipt) {
    // A managed call sends exactly one browser body. Explicit retries first
    // reconcile above; there is no client-side XHR retry loop.
    retentionReceipt = await uploadFileToUrlViaProxy({
      file,
      onProgress,
      captureFileId: fileId,
      uploadTicket: uploadHandle?.ticket,
      captureFilename: options.captureFilename,
      batchId: options.batchId,
      batchOrdinal: options.batchOrdinal,
      batchTotal: options.batchTotal,
      signal: options.signal,
      onStage: options.onStage,
    });
  } else if (captureLocalCopy && retentionReceipt) {
    if (onProgress) onProgress(100);
    options.onStage?.({
      stage: "uploaded",
      fileId,
      loadedBytes: file.size,
      totalBytes: file.size,
      receipt: retentionReceipt,
      traceId: retentionReceipt.traceId,
    });
  } else {
    const uploadUrl = fileRecord.upload_url;
    if (!uploadUrl) {
      throw new FileUploadError("创建文件记录失败：未获取到上传地址", {
        code: "FILE_RECORD_INVALID",
        fileId,
        retryable: true,
      });
    }
    try {
      options.onStage?.({
        stage: "uploading",
        fileId,
        loadedBytes: 0,
        totalBytes: file.size,
      });
      await uploadFileToUrl(uploadUrl, file, onProgress, options.signal);
    } catch (directError) {
      if (directError instanceof FileUploadError && directError.cancelled) {
        throw directError;
      }
      console.warn(
        `Direct S3 upload failed (${String((directError as Error)?.message || directError)}), trying server proxy...`,
      );
      if (onProgress) onProgress(10);
      let lastProxyError: unknown = directError;
      for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt += 1) {
        if (options.signal?.aborted) {
          throw cancelledFileUploadError(fileId, lastProxyError);
        }
        try {
          await uploadFileToUrlViaProxy({
            uploadUrl,
            file,
            onProgress,
            signal: options.signal,
            onStage: options.onStage,
            stageFileId: fileId,
          });
          lastProxyError = undefined;
          break;
        } catch (proxyError) {
          lastProxyError = proxyError;
          if (proxyError instanceof FileUploadError && proxyError.cancelled) {
            throw proxyError;
          }
          const status = uploadErrorStatus(proxyError);
          if (status !== undefined && !isRetryableUploadStatus(status)) break;
          if (attempt >= retryConfig.maxRetries) break;
          const delay = Math.min(
            retryConfig.initialDelay * 2 ** attempt,
            retryConfig.maxDelay,
          );
          if (delay > 0) {
            await waitForUploadRetry(delay, options.signal, fileId);
          }
        }
      }
      if (lastProxyError) throw lastProxyError;
    }
    options.onStage?.({
      stage: "uploaded",
      fileId,
      loadedBytes: file.size,
      totalBytes: file.size,
    });
  }

  return {
    fileId,
    filename: file.name,
    ...(retentionReceipt
      ? {
          sizeBytes: retentionReceipt.sizeBytes,
          uploadedAt: retentionReceipt.uploadedAt,
          expiresAt: retentionReceipt.expiresAt,
          replayed: retentionReceipt.replayed,
          recovered: retentionReceipt.recovered,
          traceId: retentionReceipt.traceId,
        }
      : {}),
  };
}

function uploadErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) ? status : undefined;
}

function isRetryableUploadStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function cancelledFileUploadError(fileId?: string, cause?: unknown) {
  return new FileUploadError("文件上传已取消", {
    code: "UPLOAD_CANCELLED",
    fileId,
    retryable: false,
    cancelled: true,
    cause,
  });
}

function timedOutFileUploadError(fileId?: string) {
  return new FileUploadError("文件上传长时间没有进度，请检查网络后重试", {
    code: "UPLOAD_TIMEOUT",
    fileId,
    retryable: true,
  });
}

function waitForUploadRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
  fileId: string,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledFileUploadError(fileId));
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      reject(cancelledFileUploadError(fileId));
    };
    timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function proxyUploadFallback(status: number) {
  if (status === 400 || status === 422) return "上传请求无效，请检查文件后重试";
  if (status === 401) return "登录状态无效，请重新登录";
  if (status === 403) return "当前账号无权上传该文件";
  if (status === 404) return "上传文件记录不存在，请重新选择文件";
  if (status === 409) return "文件上传状态已变化，请刷新后重试";
  if (status === 410) return "文件记录已失效，请重新选择文件";
  if (status === 413) return "文件过大，请缩减后重试";
  if (status === 429) return "上传请求过于频繁，请稍后重试";
  if (status === 408 || status === 504) return "文件上传超时，请稍后重试";
  if (status >= 500) return "文件上传服务暂时不可用，请稍后重试";
  return `文件上传失败（${status}）`;
}

function proxyUploadError(xhr: XMLHttpRequest, fileId: string | undefined) {
  let upstreamMessage = "";
  let serverCode = "";
  let serverRetryable: boolean | undefined;
  let traceId: string | undefined;
  let recoveryAction: UploadRecoveryAction | undefined;
  let recreateRequired = false;
  let fileIdMismatch = false;
  try {
    const payload = JSON.parse(xhr.responseText || "{}") as {
      error?: {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
        traceId?: unknown;
        recoveryAction?: unknown;
        recreateRequired?: unknown;
        fileId?: unknown;
      };
    };
    upstreamMessage =
      typeof payload.error?.message === "string" ? payload.error.message : "";
    serverCode =
      typeof payload.error?.code === "string" ? payload.error.code : "";
    if (typeof payload.error?.retryable === "boolean") {
      serverRetryable = payload.error.retryable;
    }
    if (
      typeof payload.error?.traceId === "string" &&
      payload.error.traceId.trim()
    ) {
      traceId = payload.error.traceId.trim();
    }
    const directive = normalizedManagedRecoveryDirective(
      uploadRecoveryAction(payload.error?.recoveryAction),
      payload.error?.recreateRequired === true,
    );
    recoveryAction = directive.recoveryAction;
    recreateRequired = directive.recreateRequired;
    if (
      typeof payload.error?.fileId === "string" &&
      payload.error.fileId.trim()
    ) {
      if (fileId !== undefined && payload.error.fileId !== fileId) {
        fileIdMismatch = true;
      } else {
        fileId = payload.error.fileId;
      }
    }
  } catch {
    // Never surface provider XML or other raw storage responses.
  }
  if (fileIdMismatch) {
    upstreamMessage = "服务端文件身份与当前上传不匹配，请稍后确认状态";
    serverCode = "UPLOAD_RECOVERY_INVALID";
    serverRetryable = true;
    recoveryAction = "check_status";
    recreateRequired = false;
  }
  return new FileUploadError(
    userFacingErrorMessage(
      Object.assign(new Error(upstreamMessage), { status: xhr.status }),
      proxyUploadFallback(xhr.status),
    ),
    {
      code: serverCode || "UPLOAD_REJECTED",
      status: xhr.status,
      fileId,
      retryable: serverRetryable ?? isRetryableUploadStatus(xhr.status),
      traceId,
      recoveryAction,
      recreateRequired,
    },
  );
}

function parseUploadRetentionReceipt(
  responseText: string,
  expectedFileId: string,
  expectedSizeBytes: number,
): UploadRetentionReceipt {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(responseText || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid receipt");
    }
    value = parsed as Record<string, unknown>;
  } catch (error) {
    throw new FileUploadError("文件上传确认响应无效，请重试", {
      code: "UPLOAD_RECEIPT_INVALID",
      fileId: expectedFileId,
      retryable: true,
      cause: error,
    });
  }
  return parseUploadRetentionReceiptValue(
    value,
    expectedFileId,
    expectedSizeBytes,
  );
}

function parseUploadRetentionReceiptValue(
  input: unknown,
  expectedFileId: string,
  expectedSizeBytes: number,
  fallbackTraceId?: string,
): UploadRetentionReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FileUploadError("文件上传确认响应无效，请重试", {
      code: "UPLOAD_RECEIPT_INVALID",
      fileId: expectedFileId,
      retryable: true,
      traceId: fallbackTraceId,
    });
  }
  const value = input as Record<string, unknown>;
  const traceId =
    typeof value.traceId === "string" && value.traceId.trim()
      ? value.traceId.trim()
      : fallbackTraceId;
  if (value.fileId !== expectedFileId) {
    throw new FileUploadError("文件上传确认与当前文件不匹配，请重试", {
      code: "UPLOAD_RECEIPT_FILE_MISMATCH",
      fileId: expectedFileId,
      retryable: true,
      traceId,
    });
  }
  if (
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes !== expectedSizeBytes ||
    typeof value.uploadedAt !== "number" ||
    !Number.isFinite(value.uploadedAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= value.uploadedAt ||
    typeof value.replayed !== "boolean" ||
    typeof value.recovered !== "boolean"
  ) {
    throw new FileUploadError("文件上传确认响应无效，请重试", {
      code: "UPLOAD_RECEIPT_INVALID",
      fileId: expectedFileId,
      retryable: true,
      traceId,
    });
  }
  return {
    fileId: expectedFileId,
    sizeBytes: value.sizeBytes,
    uploadedAt: value.uploadedAt,
    expiresAt: value.expiresAt,
    replayed: value.replayed,
    recovered: value.recovered,
    ...(traceId ? { traceId } : {}),
  };
}

type ProxyUploadInput = {
  uploadUrl?: string;
  file: File;
  onProgress?: (percent: number) => void;
  captureFileId?: string;
  uploadTicket?: string;
  captureFilename?: string;
  batchId?: string;
  batchOrdinal?: number;
  batchTotal?: number;
  signal?: AbortSignal;
  onStage?: (event: FileUploadStageEvent) => void;
  stageFileId?: string;
};

/** Uploads one browser body. Captured uploads are retried only by the server. */
async function uploadFileToUrlViaProxy(
  input: ProxyUploadInput,
): Promise<UploadRetentionReceipt | undefined> {
  const {
    uploadUrl,
    file,
    onProgress,
    captureFileId,
    uploadTicket,
    captureFilename,
    batchId,
    batchOrdinal,
    batchTotal,
    signal,
    onStage,
  } = input;
  const stageFileId = captureFileId ?? input.stageFileId;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledFileUploadError(stageFileId));
      return;
    }
    if (!captureFileId && !uploadUrl) {
      reject(
        new FileUploadError("缺少代理上传地址", {
          code: "INVALID_UPLOAD_OPTIONS",
          fileId: stageFileId,
          retryable: false,
        }),
      );
      return;
    }
    const xhr = new XMLHttpRequest();
    const params = captureFileId
      ? new URLSearchParams({ capture_file_id: captureFileId })
      : new URLSearchParams({ target: uploadUrl! });
    const proxyUrl = `/api/frontmind/proxy-upload?${params.toString()}`;
    const abortFromCaller = () => xhr.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    xhr.open("PUT", proxyUrl, true);
    // Keep the raw stream out of express.json(); exact MIME and both provider
    // and local display filenames travel in ASCII-safe metadata headers.
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader(
      "X-Original-Content-Type",
      file.type || "application/octet-stream",
    );
    if (captureFileId) {
      if (uploadTicket) {
        xhr.setRequestHeader("X-FrontMind-Upload-Ticket", uploadTicket);
      }
      const normalizedBatchId = String(batchId || "").trim();
      if (/^[A-Za-z0-9._:-]{1,128}$/u.test(normalizedBatchId)) {
        xhr.setRequestHeader("X-FrontMind-Upload-Batch-Id", normalizedBatchId);
      }
      if (
        Number.isSafeInteger(batchOrdinal) &&
        Number.isSafeInteger(batchTotal) &&
        batchOrdinal! >= 1 &&
        batchTotal! >= batchOrdinal! &&
        batchTotal! <= 1_000
      ) {
        xhr.setRequestHeader(
          "X-FrontMind-Upload-Ordinal",
          String(batchOrdinal),
        );
        xhr.setRequestHeader("X-FrontMind-Upload-Total", String(batchTotal));
      }
      xhr.setRequestHeader(
        "X-FrontMind-Provider-Filename-UTF8",
        encodeURIComponent(file.name),
      );
      xhr.setRequestHeader(
        "X-FrontMind-Capture-Filename-UTF8",
        encodeURIComponent(captureFilename || file.name),
      );
    }
    const projectAssignmentId = sessionStorage
      .getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY)
      ?.trim();
    if (projectAssignmentId) {
      xhr.setRequestHeader(
        "x-delivery-project-assignment-id",
        projectAssignmentId,
      );
    }

    let serverProcessingEmitted = false;
    const emitServerProcessing = () => {
      if (serverProcessingEmitted) return;
      serverProcessingEmitted = true;
      onStage?.({
        stage: "server_processing",
        ...(stageFileId ? { fileId: stageFileId } : {}),
        loadedBytes: file.size,
        totalBytes: file.size,
      });
    };
    onStage?.({
      stage: "uploading",
      ...(stageFileId ? { fileId: stageFileId } : {}),
      loadedBytes: 0,
      totalBytes: file.size,
    });
    const watchdog = installFileUploadWatchdog(xhr, onProgress, {
      totalBytes: file.size,
      onTransfer: (loadedBytes, totalBytes) =>
        onStage?.({
          stage: "uploading",
          ...(stageFileId ? { fileId: stageFileId } : {}),
          loadedBytes,
          totalBytes,
        }),
      onUploadComplete: emitServerProcessing,
    });
    const cleanup = () => {
      watchdog.clear();
      signal?.removeEventListener("abort", abortFromCaller);
    };

    xhr.addEventListener("load", () => {
      // Do not turn an early 4xx/5xx response into a fictitious full transfer.
      // The upload-side load/progress events already mark genuine completion.
      if (xhr.status >= 200 && xhr.status < 300) {
        watchdog.markUploadComplete();
      }
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!captureFileId) {
          resolve(undefined);
          return;
        }
        try {
          const receipt = parseUploadRetentionReceipt(
            xhr.responseText,
            captureFileId,
            file.size,
          );
          onStage?.({
            stage: "uploaded",
            fileId: captureFileId,
            loadedBytes: file.size,
            totalBytes: file.size,
            receipt,
            traceId: receipt.traceId,
          });
          resolve(receipt);
        } catch (error) {
          reject(error);
        }
      } else {
        reject(proxyUploadError(xhr, stageFileId));
      }
    });

    xhr.addEventListener("error", () => {
      cleanup();
      reject(
        new FileUploadError("文件代理上传网络异常", {
          code: "UPLOAD_NETWORK_ERROR",
          fileId: stageFileId,
          retryable: true,
        }),
      );
    });
    xhr.addEventListener("abort", () => {
      const timedOut = watchdog.timedOut();
      cleanup();
      reject(
        timedOut
          ? timedOutFileUploadError(stageFileId)
          : cancelledFileUploadError(stageFileId),
      );
    });

    watchdog.start();
    xhr.send(file);
  });
}

/**
 * Convert a file to base64 data URL
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Check if a file is an image
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export interface CreditUsageTask {
  id: string;
  title?: string;
  creditUsage: number;
  createdAt?: string;
}

export interface CreditUsageResult {
  totalUsed: number;
  recentTasks: CreditUsageTask[];
  fetchedAt?: number;
  fromCache?: boolean;
  complete?: boolean;
}

interface CreditUsageCacheData extends CreditUsageResult {
  fingerprint: string;
  accountId: string;
  fetchedAt: number;
}

function readCreditUsageCache(
  fingerprint: string,
  accountId: string,
  allowStale: boolean,
): CreditUsageCacheData | null {
  try {
    const stored = localStorage.getItem(CREDIT_USAGE_CACHE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as Partial<CreditUsageCacheData>;
    if (
      data.fingerprint !== fingerprint ||
      data.accountId !== accountId ||
      !Number.isFinite(Number(data.fetchedAt))
    ) {
      return null;
    }
    if (
      !allowStale &&
      Date.now() - Number(data.fetchedAt) > CREDIT_USAGE_CACHE_TTL_MS
    ) {
      return null;
    }
    return {
      fingerprint,
      accountId,
      fetchedAt: Number(data.fetchedAt),
      totalUsed: Number(data.totalUsed || 0),
      recentTasks: Array.isArray(data.recentTasks) ? data.recentTasks : [],
      complete: data.complete !== false,
      fromCache: true,
    };
  } catch {
    return null;
  }
}

function writeCreditUsageCache(
  fingerprint: string,
  accountId: string,
  result: CreditUsageResult,
) {
  try {
    const cacheData: CreditUsageCacheData = {
      fingerprint,
      accountId,
      fetchedAt: result.fetchedAt || Date.now(),
      totalUsed: result.totalUsed,
      recentTasks: result.recentTasks,
      complete: result.complete !== false,
    };
    localStorage.setItem(CREDIT_USAGE_CACHE_KEY, JSON.stringify(cacheData));
  } catch {
    // ignore local storage errors
  }
}

/**
 * Fetch credit usage from recent tasks.
 * Uses a short local cache so opening Settings is instant while manual refresh
 * still forces a live request. The total reflects the shared API Key pool,
 * while recent task details remain scoped to the current FrontMind account.
 */
export async function fetchCreditUsage(
  options: {
    force?: boolean;
    fingerprint?: string;
    accountId?: string | number;
  } = {},
): Promise<CreditUsageResult> {
  const emptyResult: CreditUsageResult = { totalUsed: 0, recentTasks: [] };
  const fingerprint = options.fingerprint?.trim() || "account-credential";
  const accountId = String(options.accountId ?? "current-account");

  try {
    if (!options.force) {
      const cached = readCreditUsageCache(fingerprint, accountId, false);
      if (cached) return cached;
    }

    const response = await fetch("/api/frontmind/account-credit-usage", {
      headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
    });
    if (!response.ok) {
      return readCreditUsageCache(fingerprint, accountId, true) || emptyResult;
    }
    const data = await response.json();

    const result: CreditUsageResult = {
      totalUsed: Math.max(0, Number(data?.totalUsed ?? 0) || 0),
      complete: data?.complete !== false,
      recentTasks: Array.isArray(data?.recentTasks)
        ? data.recentTasks
            .map((task: any) => ({
              id: String(task?.id ?? ""),
              title: String(task?.title ?? "").trim() || undefined,
              creditUsage: Math.max(0, Number(task?.creditUsage ?? 0) || 0),
              createdAt:
                typeof task?.createdAt === "string"
                  ? task.createdAt
                  : undefined,
            }))
            .filter((task: CreditUsageTask) => Boolean(task.id))
        : [],
      fetchedAt: Number(data?.fetchedAt ?? Date.now()),
      fromCache: false,
    };
    writeCreditUsageCache(fingerprint, accountId, result);
    return result;
  } catch {
    return readCreditUsageCache(fingerprint, accountId, true) || emptyResult;
  }
}

/**
 * Test API connection through the proxy
 */
export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
  taskCount?: number;
}> {
  try {
    const url = `/api/frontmind/credential-check`;
    const response = await fetch(url, {
      headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
    });

    if (response.ok) {
      return {
        ok: true,
        message: "连接成功",
      };
    }

    let errorDetail = `HTTP ${response.status}`;
    try {
      const errData = await response.json();
      errorDetail = errData.error?.message || errData.message || errorDetail;
    } catch {}

    return {
      ok: false,
      message: userFacingErrorMessage(
        Object.assign(new Error(errorDetail), { status: response.status }),
        `连接失败（${response.status}）`,
      ),
    };
  } catch (err: any) {
    return { ok: false, message: userFacingErrorMessage(err, "连接失败") };
  }
}
