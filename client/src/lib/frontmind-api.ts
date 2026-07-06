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

// Default configuration - can be overridden via settings
const DEFAULT_CONFIG = {
  baseUrl: "",
  apiKey: "",
  agentProfile: "frontmind-pro",
};

export const CREATE_TASK_TIMEOUT_MS = 300_000;

function normalizePublicAgentProfile(value: string | undefined): string {
  if (value === "frontmind-lite") return "frontmind-lite";
  if (value === "frontmind-base") return "frontmind-base";
  if (value === "frontmind-pro") return "frontmind-pro";
  return DEFAULT_CONFIG.agentProfile;
}

export function getConfig() {
  const stored = localStorage.getItem("frontmind-client-config");
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        baseUrl: parsed.baseUrl || "",
        agentProfile: normalizePublicAgentProfile(parsed.agentProfile),
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

/**
 * Generate a short fingerprint from an API key.
 * Used to bind conversations to the API key that created them.
 * Returns empty string if no key is set.
 */
export function getApiKeyFingerprint(apiKey?: string): string {
  const key = apiKey ?? getConfig().apiKey;
  if (!key || key.length < 8) return "";
  // Use first 4 + last 4 characters as a stable fingerprint
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ============================================================
// API Key Change Event Bus
// Fires when the user saves a different API key in settings.
// Subscribers (e.g. ConversationContext) can react by forcing
// a new workflow window.
// ============================================================
type ApiKeyChangeListener = (newFingerprint: string) => void;

class ApiKeyChangeEventBus {
  private listeners: Set<ApiKeyChangeListener> = new Set();

  subscribe(listener: ApiKeyChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(newFingerprint: string) {
    this.listeners.forEach((listener) => {
      try {
        listener(newFingerprint);
      } catch (e) {
        console.error("[ApiKeyChangeEventBus] Listener error:", e);
      }
    });
  }
}

export const apiKeyChangeEventBus = new ApiKeyChangeEventBus();

export function saveConfig(config: Partial<typeof DEFAULT_CONFIG>) {
  const oldConfig = getConfig();
  const merged = { ...oldConfig, ...config };
  merged.agentProfile = normalizePublicAgentProfile(merged.agentProfile);
  localStorage.setItem("frontmind-client-config", JSON.stringify(merged));

  // Detect API key change and emit event
  if (config.apiKey && config.apiKey !== oldConfig.apiKey) {
    const newFingerprint = getApiKeyFingerprint(config.apiKey);
    console.log(
      `[saveConfig] API Key changed. New fingerprint: ${newFingerprint}`,
    );
    apiKeyChangeEventBus.emit(newFingerprint);
  }

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
const CREDIT_USAGE_CACHE_KEY = "frontmind-credit-usage-cache-v2";
const CREDIT_USAGE_CACHE_TTL_MS = 60 * 1000;
const CREDIT_USAGE_LOOKBACK_DAYS = 30;
const CREDIT_USAGE_PAGE_LIMIT = 100;
const CREDIT_USAGE_MAX_PAGES = 20;

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
  fileName?: string;
  mimeType?: string;
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
  const config = getConfig();
  const url = `/api/frontmind${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-FrontMind-API-Key": config.apiKey,
    "X-FrontMind-Base-URL": config.baseUrl,
    ...(options.headers as Record<string, string>),
  };

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
      throw new Error(errorMsg);
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
function extractAttachments(input: Message[]): any[] {
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
          });
        }
        // If only image_url (base64), skip - these are fallback cases
        // and will be handled differently by the API
      } else if (item.type === "input_file" && item.file_id) {
        attachments.push({
          filename: item.filename || "file",
          file_id: item.file_id,
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
    console.warn(
      `[retrieveTask] /v1/tasks/ failed (${err.message}), trying /v1/responses/`,
    );
    try {
      const response = await apiRequest(`/v1/responses/${responseId}`);
      const data = await response.json();
      if (data.status === "failed") {
        data.status = "error";
      }
      return data;
    } catch (fallbackErr: any) {
      throw err;
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
): Promise<{ fileId: string; filename: string }> {
  if (onProgress) onProgress(0);
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
    await uploadFileToUrlViaProxy(fileRecord.upload_url, file, onProgress);
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
        reject(
          new Error(
            `Proxy upload failed (${xhr.status}): ${
              xhr.responseText?.slice(0, 200) || xhr.statusText
            }`,
          ),
        );
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
}

interface CreditUsageCacheData extends CreditUsageResult {
  fingerprint: string;
  fetchedAt: number;
}

function readCreditUsageCache(
  fingerprint: string,
  allowStale: boolean,
): CreditUsageCacheData | null {
  try {
    const stored = localStorage.getItem(CREDIT_USAGE_CACHE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as Partial<CreditUsageCacheData>;
    if (
      data.fingerprint !== fingerprint ||
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
      fetchedAt: Number(data.fetchedAt),
      totalUsed: Number(data.totalUsed || 0),
      recentTasks: Array.isArray(data.recentTasks) ? data.recentTasks : [],
      fromCache: true,
    };
  } catch {
    return null;
  }
}

function writeCreditUsageCache(fingerprint: string, result: CreditUsageResult) {
  try {
    const cacheData: CreditUsageCacheData = {
      fingerprint,
      fetchedAt: result.fetchedAt || Date.now(),
      totalUsed: result.totalUsed,
      recentTasks: result.recentTasks,
    };
    localStorage.setItem(CREDIT_USAGE_CACHE_KEY, JSON.stringify(cacheData));
  } catch {
    // ignore local storage errors
  }
}

function parseTaskCreatedAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getTaskCreditUsage(task: any): number {
  const usage = Number(task?.credit_usage || task?.metadata?.credit_usage || 0);
  return Number.isFinite(usage) && usage > 0 ? usage : 0;
}

/**
 * Fetch credit usage from recent tasks.
 * Uses a short local cache so opening Settings is instant while manual refresh
 * still forces a live request.
 * The displayed total equals the sum of all listed tasks from the last 30 days.
 */
export async function fetchCreditUsage(
  options: { force?: boolean } = {},
): Promise<CreditUsageResult> {
  const emptyResult: CreditUsageResult = { totalUsed: 0, recentTasks: [] };

  try {
    const config = getConfig();
    if (!config.apiKey) {
      return emptyResult;
    }

    const fingerprint = getApiKeyFingerprint(config.apiKey);
    if (!options.force) {
      const cached = readCreditUsageCache(fingerprint, false);
      if (cached) return cached;
    }

    const cutoffMs =
      Date.now() - CREDIT_USAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const seenTaskIds = new Set<string>();
    let totalUsed = 0;
    const recentTasks: CreditUsageTask[] = [];
    let after: string | undefined;
    let reachedCutoff = false;

    for (
      let page = 0;
      page < CREDIT_USAGE_MAX_PAGES && !reachedCutoff;
      page += 1
    ) {
      const searchParams = new URLSearchParams({
        limit: String(CREDIT_USAGE_PAGE_LIMIT),
        order: "desc",
      });
      if (after) searchParams.set("after", after);

      const response = await fetch(
        `/api/frontmind/v1/tasks?${searchParams.toString()}`,
        {
          headers: {
            "Content-Type": "application/json",
            "X-FrontMind-API-Key": config.apiKey,
            "X-FrontMind-Base-URL": config.baseUrl,
          },
          credentials: "include",
        },
      );

      if (!response.ok) {
        return readCreditUsageCache(fingerprint, true) || emptyResult;
      }

      const data = await response.json();
      const tasks = Array.isArray(data.data) ? data.data : [];
      if (tasks.length === 0) break;

      for (const task of tasks) {
        const taskId = String(task?.id || "");
        if (!taskId || seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);

        const createdAtMs = parseTaskCreatedAtMs(task?.created_at);
        if (createdAtMs !== null && createdAtMs < cutoffMs) {
          reachedCutoff = true;
          break;
        }

        const usage = getTaskCreditUsage(task);
        if (usage <= 0) continue;

        totalUsed += usage;
        recentTasks.push({
          id: taskId,
          title:
            task.metadata?.task_title ||
            task.instructions?.slice(0, 30) ||
            taskId.slice(0, 12),
          creditUsage: usage,
          createdAt:
            createdAtMs !== null
              ? new Date(createdAtMs).toLocaleDateString("zh-CN")
              : undefined,
        });
      }

      after = data.last_id || tasks[tasks.length - 1]?.id;
      if (!data.has_more || !after) break;
    }

    const result: CreditUsageResult = {
      totalUsed,
      recentTasks,
      fetchedAt: Date.now(),
      fromCache: false,
    };
    writeCreditUsageCache(fingerprint, result);
    return result;
  } catch {
    const fingerprint = getApiKeyFingerprint();
    return readCreditUsageCache(fingerprint, true) || emptyResult;
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
    const config = getConfig();
    if (!config.apiKey) {
      return { ok: false, message: "请先设置 API Key" };
    }

    const url = `/api/frontmind/v1/tasks?limit=1`;
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "X-FrontMind-API-Key": config.apiKey,
        "X-FrontMind-Base-URL": config.baseUrl,
      },
      credentials: "include",
    });

    if (response.ok) {
      const data = await response.json();
      const count = data.data?.length ?? 0;
      return {
        ok: true,
        message: `连接成功，已有 ${count} 个任务`,
        taskCount: count,
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
