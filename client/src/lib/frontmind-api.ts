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
  return found ? found.label : modelValue;
}

// Non-sensitive, device-local display preference. API credentials are stored
// only by the server; browser-local credentials and conversations are not
// imported into an account.
const DEFAULT_CONFIG = {
  agentProfile: "frontmind-pro",
};
const DEVICE_PREFERENCES_STORAGE_KEY = "frontmind-client-preferences";

export const CREATE_TASK_TIMEOUT_MS = 300_000;
export const DELIVERY_ROLE_STORAGE_KEY = "frontmind.delivery.roleAssignmentId";

function deliveryRoleHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const roleAssignmentId = localStorage
    .getItem(DELIVERY_ROLE_STORAGE_KEY)
    ?.trim();
  return {
    ...headers,
    ...(roleAssignmentId
      ? { "x-delivery-role-assignment-id": roleAssignmentId }
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
    const source = ["ma", "nus"].join("");
    return text
      .replace(
        /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN)\b[\s\S]*?-->/gi,
        "",
      )
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
      .replace(new RegExp(`\\b${source.toUpperCase()}\\b`, "g"), "FrontMind")
      .replace(
        new RegExp(`\\b${source[0].toUpperCase()}${source.slice(1)}\\b`, "g"),
        "FrontMind",
      )
      .replace(new RegExp(`\\b${source}\\b`, "g"), "frontmind");
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
  fileUrl?: string;
  file_url?: string;
  fileId?: string;
  file_id?: string;
  fileName?: string;
  file_name?: string;
  mimeType?: string;
  mime_type?: string;
  annotations?: unknown;
  logprobs?: unknown;
}

export interface FileRecord {
  id: string;
  object: string;
  filename: string;
  status: string;
  upload_url: string;
  upload_expires_at: string;
  created_at: string;
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

  const headers = deliveryRoleHeaders({
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  });

  const isPost =
    options.method?.toUpperCase() === "POST" ||
    options.method?.toUpperCase() === "PUT";
  const timeout = timeoutMs ?? (isPost ? 120_000 : 30_000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

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
      const requestError = new Error(errorMsg) as Error & {
        status?: number;
      };
      requestError.status = response.status;
      throw requestError;
    }

    return response;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(
        `请求超时 (${Math.round(timeout / 1000)}s)，API 服务器响应过慢。可尝试重新发送。`,
      );
    }
    throw err;
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
      throw new Error(message);
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
      knowledgeInteraction: payload?.interaction,
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
export async function createKnowledgeBaseTurnTask(
  input: Message[],
  context: { conversationId: string; taskId: string },
): Promise<TaskResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    CREATE_TASK_TIMEOUT_MS,
  );
  try {
    const response = await fetch("/api/knowledge-base/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({
        ...context,
        userMessage: buildPromptText(input),
        attachments: extractAttachments(input),
      }),
    });
    if (!response.ok) {
      let message = `API Error ${response.status}`;
      try {
        const payload = await response.json();
        message = payload?.error?.message || payload?.message || message;
      } catch {
        // Keep the status-derived message.
      }
      throw new Error(message);
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
        task_url: data.taskUrl || data.task_url || data.metadata?.task_url,
        task_title: data.title || data.task_title || data.metadata?.task_title,
      },
      output: data.output || [],
    };
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
 * Delete a task
 */
export async function deleteTask(responseId: string): Promise<void> {
  try {
    await apiRequest(`/v1/responses/${responseId}`, { method: "DELETE" });
  } catch {
    await apiRequest(`/v1/tasks/${responseId}`, { method: "DELETE" });
  }
}

/**
 * Upload a file - Step 1: Create file record
 */
export async function createFileRecord(filename: string): Promise<FileRecord> {
  const response = await apiRequest("/v1/files", {
    method: "POST",
    body: JSON.stringify({ filename }),
  });
  return response.json();
}

/**
 * Upload a file - Step 2: Upload to presigned URL with progress tracking
 */
export async function uploadFileToUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );

    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent);
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const detail = xhr.responseText
          ? xhr.responseText.slice(0, 200)
          : xhr.statusText || `HTTP ${xhr.status}`;
        reject(new Error(`Upload failed (${xhr.status}): ${detail}`));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Upload network error - S3 可能存在 CORS 限制"));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload aborted"));
    });

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
): Promise<{ fileId: string; filename: string }> {
  if (onProgress) onProgress(0);
  // File-record creation is intentionally outside the retry loop. Repeating
  // POST /v1/files would orphan records and could bind retries to different
  // credential versions.
  const fileRecord = await createFileRecord(file.name);

  if (!fileRecord || !fileRecord.upload_url) {
    throw new Error(`创建文件记录失败：未获取到上传地址`);
  }

  if (!fileRecord.id) {
    throw new Error(`创建文件记录失败：未获取到文件 ID`);
  }

  try {
    await uploadFileToUrl(fileRecord.upload_url, file, onProgress);
  } catch (directErr: any) {
    console.warn(
      `Direct S3 upload failed (${directErr.message}), trying server proxy...`,
    );
    if (onProgress) onProgress(10);

    let lastProxyError: unknown = directErr;
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt += 1) {
      try {
        await uploadFileToUrlViaProxy(fileRecord.upload_url, file, onProgress);
        lastProxyError = undefined;
        break;
      } catch (proxyError) {
        lastProxyError = proxyError;
        const proxyStatus = Number(
          (proxyError as { status?: unknown } | null)?.status,
        );
        if (proxyStatus >= 400 && proxyStatus < 500) break;
        if (attempt >= retryConfig.maxRetries) break;
        const exponentialDelay =
          retryConfig.initialDelay * Math.pow(2, attempt);
        const delay = Math.min(exponentialDelay, retryConfig.maxDelay);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (lastProxyError) {
      throw lastProxyError;
    }
  }

  return {
    fileId: fileRecord.id,
    filename: file.name,
  };
}

/**
 * Fallback: upload file through server proxy when direct S3 CORS fails.
 */
async function uploadFileToUrlViaProxy(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const proxyUrl = `/api/frontmind/proxy-upload?target=${encodeURIComponent(uploadUrl)}`;
    xhr.open("PUT", proxyUrl, true);
    // IMPORTANT: Always use application/octet-stream for proxy uploads.
    // If we send the real MIME type (e.g. application/json for .json files),
    // the server-side express.json() middleware will consume the raw body
    // stream before our proxy-upload handler can read it, resulting in an
    // empty upload to S3.  We pass the real content-type in a custom header
    // so the proxy can forward it to S3.
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader(
      "X-Original-Content-Type",
      file.type || "application/octet-stream",
    );

    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent);
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const upstreamMessage = (() => {
          try {
            const payload = JSON.parse(xhr.responseText || "{}") as {
              error?: { message?: unknown };
            };
            return typeof payload.error?.message === "string"
              ? payload.error.message
              : "";
          } catch {
            return "";
          }
        })();
        const error = new Error(
          upstreamMessage ||
            (xhr.status >= 400 && xhr.status < 500
              ? "上传地址无效或已失效，请重新选择文件后重试"
              : "文件上传失败，请稍后重试"),
        ) as Error & { status?: number };
        error.status = xhr.status;
        reject(error);
      }
    });

    xhr.addEventListener("error", () =>
      reject(new Error("Proxy upload network error")),
    );
    xhr.addEventListener("abort", () =>
      reject(new Error("Proxy upload aborted")),
    );

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
      headers: deliveryRoleHeaders({ "Content-Type": "application/json" }),
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
      headers: deliveryRoleHeaders({ "Content-Type": "application/json" }),
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

    return { ok: false, message: errorDetail };
  } catch (err: any) {
    return { ok: false, message: err.message || "连接失败" };
  }
}
