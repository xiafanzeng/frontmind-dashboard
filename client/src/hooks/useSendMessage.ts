/**
 * Enhanced useSendMessage Hook with retry mechanism and streaming support
 * Features: Automatic retry, exponential backoff, streaming responses,
 *           upload progress tracking, race-condition-free sequential polling,
 *           output-length-based deduplication for multi-turn conversations,
 *           per-message model override (agentProfile parameter),
 *           credit event bus emission on task completion for real-time refresh.
 */
import { useCallback, useRef, useState } from "react";
import {
  createTask,
  retrieveTask,
  uploadFile,
  fileToBase64,
  isImageFile,
  creditEventBus,
  getApiKeyFingerprint,
  type ContentItem,
  type Message,
  type OutputMessage,
} from "@/lib/frontmind-api";
import {
  useConversation,
  parseOutputMessages,
  type Attachment,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import { toast } from "sonner";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 10000; // 10 seconds
const POLL_INTERVAL = 3000; // 3 seconds between polls

interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
}

const defaultRetryConfig: RetryConfig = {
  maxRetries: MAX_RETRIES,
  initialDelay: INITIAL_RETRY_DELAY,
  maxDelay: MAX_RETRY_DELAY,
};

// Exponential backoff with jitter
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.initialDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

// Retry wrapper for API calls
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = defaultRetryConfig
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry on certain errors
      if (
        error.message?.includes("401") ||
        error.message?.includes("403") ||
        error.message?.includes("404") ||
        error.message?.includes("authentication") ||
        error.message?.includes("not found")
      ) {
        throw error;
      }

      if (attempt < config.maxRetries) {
        const delay = calculateBackoff(attempt, config);
        console.log(`Retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${config.maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Max retries exceeded");
}

/**
 * Slice only new output items from the cumulative API output array.
 */
function sliceNewOutput(output: OutputMessage[], baseline: number): OutputMessage[] {
  if (baseline <= 0) {
    return output;
  }
  if (baseline >= output.length) {
    return [];
  }
  return output.slice(baseline);
}

function getFailureAdvice(errorMsg: string) {
  if (/quota|credit|balance|insufficient|积分|额度|余额|点数/i.test(errorMsg)) {
    return "当前 Key 的额度可能不足，请更换 API Key 或联系管理员处理。";
  }
  return "请检查设置中的 API Key 是否正确。";
}

/** Upload progress info exposed to UI */
export interface UploadProgress {
  /** Index of the file currently being uploaded (0-based) */
  currentFileIndex: number;
  /** Total number of files to upload */
  totalFiles: number;
  /** Name of the file currently being uploaded */
  currentFileName: string;
  /** Upload percent of the current file (0-100) */
  currentFilePercent: number;
  /** Overall percent across all files (0-100) */
  overallPercent: number;
  /** The conversation ID this upload belongs to */
  conversationId?: string;
}

export function useSendMessage() {
  const {
    state,
    activeConversation,
    addMessage,
    updateStatus,
    updateAssistantMessages,
    updateTitle,
    createConversation,
  } = useConversation();

  // Use a ref to track whether polling should continue.
  const pollingActiveRef = useRef(false);
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeConvRef = useRef(activeConversation);
  activeConvRef.current = activeConversation;

  // Store context functions in refs so polling closures always use the latest versions
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const updateAssistantMessagesRef = useRef(updateAssistantMessages);
  updateAssistantMessagesRef.current = updateAssistantMessages;
  const addMessageRef = useRef(addMessage);
  addMessageRef.current = addMessage;

  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  const stopPolling = useCallback(() => {
    pollingActiveRef.current = false;
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  /**
   * Sequential polling: waits for each request to finish before scheduling the next.
   */
  const startPolling = useCallback(
    (
      taskId: string,
      convId: string,
      responseStartedAt: number,
      retryConfig: RetryConfig,
      baselineOutputLength: number,
      modelName?: string
    ) => {
      // Stop any existing polling first
      stopPolling();
      pollingActiveRef.current = true;

      let pollCount = 0;
      let lastNewOutputLen = 0;
      let completionHandled = false;
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 10;

      const pollOnce = async () => {
        if (!pollingActiveRef.current || completionHandled) return;

        try {
          pollCount++;

          const updated = await withRetry(
            () => retrieveTask(taskId),
            { ...retryConfig, maxRetries: 2 }
          );

          if (!pollingActiveRef.current || completionHandled) return;

          // Slice only NEW output items
          if (updated.output && updated.output.length > 0) {
            const newOutput = sliceNewOutput(updated.output, baselineOutputLength);

            if (newOutput.length > 0) {
              try {
                const assistantMsgs = parseOutputMessages(newOutput, responseStartedAt, modelName);
                if (assistantMsgs.length > 0) {
                  updateAssistantMessagesRef.current(convId, assistantMsgs);
                }
              } catch (parseErr) {
                console.error("[Polling] Error parsing output messages:", parseErr);
              }
              if (newOutput.length !== lastNewOutputLen) {
                console.log(
                  `[Polling] New output items: ${newOutput.length}, ` +
                  `total output: ${updated.output.length}, baseline: ${baselineOutputLength}`
                );
                lastNewOutputLen = newOutput.length;
              }
            }
          }

          // Normalize status
          const normalizedStatus = updated.status === "failed" ? "error" : updated.status;

          updateStatusRef.current(convId, normalizedStatus as any, {
            taskId: updated.id,
            taskUrl: updated.metadata?.task_url,
          });

          if (normalizedStatus === "completed" && !completionHandled) {
            completionHandled = true;
            stopPolling();
            const completedAt = Date.now();
            const elapsedSec = (completedAt - responseStartedAt) / 1000;

            const totalOutputLength = updated.output?.length || 0;

            updateStatusRef.current(convId, "completed", {
              completedAt,
              lastKnownOutputLength: totalOutputLength,
            });

            // Final parse of output — this is the authoritative final set.
            // The regular polling section above already parsed the same output,
            // but we do it once more here to ensure we have the complete set
            // and to attach elapsedTime to the last message.
            if (updated.output && updated.output.length > 0) {
              const newOutput = sliceNewOutput(updated.output, baselineOutputLength);

              if (newOutput.length > 0) {
                try {
                  const finalMsgs = parseOutputMessages(newOutput, responseStartedAt, modelName);
                  if (finalMsgs.length > 0) {
                    finalMsgs[finalMsgs.length - 1].elapsedTime = elapsedSec;
                    updateAssistantMessagesRef.current(convId, finalMsgs);
                  }
                } catch (parseErr) {
                  console.error("[Polling] Error parsing final output messages:", parseErr);
                }
              }
            }

            toast.success("任务已完成", {
              description: `本次处理耗时 ${elapsedSec.toFixed(1)}s，结果已同步到当前内容流程。`,
              duration: 3200,
            });

            // Emit credit refresh event on task completion
            creditEventBus.emit();
            return;
          }

          if (normalizedStatus === "error" && !completionHandled) {
            completionHandled = true;
            stopPolling();
            const completedAt = Date.now();

            const totalOutputLength = updated.output?.length || 0;

            updateStatusRef.current(convId, "error", {
              completedAt,
              lastKnownOutputLength: totalOutputLength,
            });
            const errorMsg = updated.error?.message || "任务执行出错";
            toast.error(errorMsg);
            addMessageRef.current(convId, {
              id: `msg-err-${Date.now()}`,
              role: "assistant",
              content: `❌ 错误: ${errorMsg}`,
              timestamp: Date.now(),
            });

            // Emit credit refresh event even on error (credits may have been consumed)
            creditEventBus.emit();
            return;
          }

          // Safety: stop after 60 minutes of polling
          if (pollCount > 1200) {
            stopPolling();
            const completedAt = Date.now();
            updateStatusRef.current(convId, "error", { completedAt });
            toast.warning("轮询超时（60分钟），请手动刷新查看结果");
            creditEventBus.emit();
            return;
          }

          consecutiveErrors = 0;
        } catch (err: any) {
          console.error("Polling error:", err);
          consecutiveErrors++;

          if (!pollingActiveRef.current || completionHandled) return;

          if (pollCount > 3 && err.message?.includes("404")) {
            stopPolling();
            toast.error("任务不存在或已被删除");
            return;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            stopPolling();
            const completedAt = Date.now();
            updateStatusRef.current(convId, "error", { completedAt });
            toast.error("连续多次请求失败，已停止轮询");
            return;
          }
        }

        if (pollingActiveRef.current && !completionHandled) {
          pollingTimeoutRef.current = setTimeout(pollOnce, POLL_INTERVAL);
        }
      };

      pollingTimeoutRef.current = setTimeout(pollOnce, POLL_INTERVAL);
    },
    [stopPolling]
  );

  /**
   * Send a message with optional per-message model override.
   */
  const sendMessage = useCallback(
    async (text: string, files: File[], options?: { retryConfig?: RetryConfig; agentProfile?: string }) => {
      const retryConfig = options?.retryConfig || defaultRetryConfig;
      const agentProfile = options?.agentProfile;

      // Ensure we have an active conversation
      let convId = activeConvRef.current?.id;
      let conv = activeConvRef.current;

      if (!convId) {
        convId = createConversation();
        conv = null;
      }

      // ── API Key / Workflow ownership check ──
      // If the current conversation was created with a different API key,
      // block the send and force the user to use a new workflow.
      const currentFingerprint = getApiKeyFingerprint();
      if (conv && conv.apiKeyFingerprint && currentFingerprint && conv.apiKeyFingerprint !== currentFingerprint) {
        toast.error("API Key 已更换，无法在旧内容流程中继续", {
          description: "请点击左侧「新内容流程」按钮创建新的内容流程后再发送消息",
          duration: 6000,
        });
        return;
      }

      const baselineOutputLength = conv?.lastKnownOutputLength || 0;
      const isMultiTurn = !!conv?.previousResponseId;

      if (isMultiTurn) {
        console.log(
          `[Multi-turn] Starting turn with baselineOutputLength=${baselineOutputLength}, ` +
          `previousResponseId=${conv?.previousResponseId?.slice(0, 12)}`
        );
      }

      // Build content items
      const contentItems: ContentItem[] = [];
      const attachments: Attachment[] = [];

      // Add text
      if (text.trim()) {
        contentItems.push({ type: "input_text", text: text.trim() });
      }

      // Process files with progress tracking
      const totalFiles = files.length;
      if (totalFiles > 0) {
        setUploadProgress({
          currentFileIndex: 0,
          totalFiles,
          currentFileName: files[0].name,
          currentFilePercent: 0,
          overallPercent: 0,
          conversationId: convId,
        });
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          setUploadProgress({
            currentFileIndex: i,
            totalFiles,
            currentFileName: file.name,
            currentFilePercent: 0,
            overallPercent: Math.round((i / totalFiles) * 100),
            conversationId: convId,
          });

          if (isImageFile(file)) {
            // Always generate base64 for local preview (API file download may not work for user uploads)
            const imageBase64 = await fileToBase64(file);
            try {
              const result = await withRetry(
                () =>
                  uploadFile(file, (percent) => {
                    setUploadProgress({
                      currentFileIndex: i,
                      totalFiles,
                      currentFileName: file.name,
                      currentFilePercent: percent,
                      overallPercent: Math.round(((i + percent / 100) / totalFiles) * 100),
                      conversationId: convId,
                    });
                  }),
                retryConfig
              );
              contentItems.push({ type: "input_image", file_id: result.fileId, filename: result.filename });
              attachments.push({
                id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: "image",
                name: file.name,
                fileId: result.fileId,
                base64: imageBase64,
                file,
              });
            } catch (uploadErr: any) {
              console.warn(`Image upload failed for "${file.name}", falling back to base64:`, uploadErr.message);
              contentItems.push({ type: "input_image", image_url: imageBase64, filename: file.name });
              attachments.push({
                id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: "image",
                name: file.name,
                base64: imageBase64,
                file,
              });
            }

            setUploadProgress({
              currentFileIndex: i,
              totalFiles,
              currentFileName: file.name,
              currentFilePercent: 100,
              overallPercent: Math.round(((i + 1) / totalFiles) * 100),
              conversationId: convId,
            });
          } else {
            // For files: use blob URL for large files (>1MB) to avoid localStorage overflow,
            // and base64 for small files that can be persisted.
            const FILE_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1MB
            const isLargeFile = file.size > FILE_SIZE_THRESHOLD;
            let fileBase64: string | undefined;
            let fileBlobUrl: string | undefined;

            if (isLargeFile) {
              // Large file: create blob URL (in-memory only, not persisted)
              fileBlobUrl = URL.createObjectURL(file);
            } else {
              // Small file: generate base64 (can be persisted to localStorage)
              fileBase64 = await fileToBase64(file);
            }

            try {
              const result = await withRetry(
                () =>
                  uploadFile(file, (percent) => {
                    setUploadProgress({
                      currentFileIndex: i,
                      totalFiles,
                      currentFileName: file.name,
                      currentFilePercent: percent,
                      overallPercent: Math.round(((i + percent / 100) / totalFiles) * 100),
                      conversationId: convId,
                    });
                  }),
                retryConfig
              );
              contentItems.push({ type: "input_file", file_id: result.fileId, filename: result.filename });
              attachments.push({
                id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: "file",
                name: file.name,
                fileId: result.fileId,
                base64: fileBase64,
                blobUrl: fileBlobUrl,
                file,
              });
            } catch (uploadErr: any) {
              console.warn(`File upload failed for "${file.name}", falling back to base64:`, uploadErr.message);
              // If we don't have base64 yet (large file), generate it now as fallback
              if (!fileBase64) {
                fileBase64 = await fileToBase64(file);
              }
              contentItems.push({
                type: "input_file",
                file_id: fileBase64,
                filename: file.name,
              });
              attachments.push({
                id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: "file",
                name: file.name,
                base64: fileBase64,
                blobUrl: fileBlobUrl,
                file,
              });
            }

            setUploadProgress({
              currentFileIndex: i,
              totalFiles,
              currentFileName: file.name,
              currentFilePercent: 100,
              overallPercent: Math.round(((i + 1) / totalFiles) * 100),
              conversationId: convId,
            });
          }
        } catch (err: any) {
          toast.error(`文件 "${file.name}" 处理失败: ${err.message}`);
        }
      }

      // Clear upload progress
      setUploadProgress(null);

      if (contentItems.length === 0) return;

      // Add user message to conversation
      const userMessage: LocalMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        content: text.trim(),
        attachments: attachments.length > 0 ? attachments : undefined,
        timestamp: Date.now(),
      };

      addMessage(convId, userMessage);

      // Update title if this is the first message
      if (!conv || conv.messages.length === 0) {
        const raw = text.trim();
        const title =
          (raw ? (raw.slice(0, 10) + (raw.length > 10 ? "..." : "")) : null) ||
          (files.length > 0 ? `文件: ${files[0].name.slice(0, 6)}` : "新内容流程");
        updateTitle(convId, title);
      }

      // Send to API with retry
      updateStatus(convId, "running");

      const responseStartedAt = Date.now();

      try {
        const input: Message[] = [
          {
            role: "user",
            content: contentItems,
          },
        ];

        const taskOptions: {
          previousResponseId?: string;
          taskId?: string;
          agentProfile?: string;
        } = {};

        if (conv?.previousResponseId) {
          taskOptions.previousResponseId = conv.previousResponseId;
        }

        // Pass per-message model override
        if (agentProfile) {
          taskOptions.agentProfile = agentProfile;
        }

        // Create task with retry
        const response = await withRetry(
          () => createTask(input, taskOptions),
          retryConfig
        );

        setRetryCount(0);
        setIsRetrying(false);

        updateStatus(convId, response.status as any, {
          taskId: response.id,
          taskUrl: response.metadata?.task_url,
          previousResponseId: response.id,
          startedAt: responseStartedAt,
        });

        toast.success("任务已创建", {
          description: "FrontMind 已开始处理，结果会自动出现在当前内容流程中。",
          duration: 3200,
        });

        // Parse initial output if available — only new items
        if (response.output && response.output.length > 0) {
          const newOutput = sliceNewOutput(response.output, baselineOutputLength);

          console.log(
            `[SendMessage] Initial response: total output=${response.output.length}, ` +
            `baseline=${baselineOutputLength}, new=${newOutput.length}, status=${response.status}`
          );

          if (newOutput.length > 0) {
            try {
              const assistantMsgs = parseOutputMessages(newOutput, responseStartedAt, agentProfile);
              if (assistantMsgs.length > 0) {
                updateAssistantMessages(convId, assistantMsgs);
              }
            } catch (parseErr) {
              console.error("[SendMessage] Error parsing initial output:", parseErr);
            }
          }
        } else if (isMultiTurn && response.status === "completed") {
          updateStatus(convId, "completed", {
            lastKnownOutputLength: baselineOutputLength, 
          });
        }

        // Start sequential polling if task is running or pending
        if (response.status === "running" || response.status === "pending") {
          startPolling(
            response.id,
            convId,
            responseStartedAt,
            retryConfig,
            baselineOutputLength,
            agentProfile
          );
        }

        if (response.status === "completed") {
          const completedAt = Date.now();
          const elapsedSec = (completedAt - responseStartedAt) / 1000;

          const totalOutputLength = response.output?.length || 0;

          updateStatus(convId, "completed", {
            completedAt,
            startedAt: responseStartedAt,
            lastKnownOutputLength: totalOutputLength,
          });

          if (response.output && response.output.length > 0) {
            const newOutput = sliceNewOutput(response.output, baselineOutputLength);

            if (newOutput.length > 0) {
              try {
                const finalMsgs = parseOutputMessages(newOutput, responseStartedAt, agentProfile);
                if (finalMsgs.length > 0) {
                  finalMsgs[finalMsgs.length - 1].elapsedTime = elapsedSec;
                  updateAssistantMessages(convId, finalMsgs);
                }
              } catch (parseErr) {
                console.error("[SendMessage] Error parsing completed output:", parseErr);
              }
            }
          }

          toast.success("任务已完成", {
            description: "结果已同步到当前内容流程。",
            duration: 3200,
          });

          // Emit credit refresh event on immediate completion
          creditEventBus.emit();
        }
      } catch (err: any) {
        updateStatus(convId, "error");
        const errorMsg = err.message || "请求失败，请检查 API 配置";
        const failureAdvice = getFailureAdvice(errorMsg);
        toast.error("发送失败", { description: errorMsg });
        addMessage(convId, {
          id: `msg-err-${Date.now()}`,
          role: "assistant",
          content: `❌ 错误: ${errorMsg}\n\n${failureAdvice}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      addMessage,
      updateStatus,
      updateAssistantMessages,
      updateTitle,
      createConversation,
      stopPolling,
      startPolling,
    ]
  );

  // Retry last message
  const retryLastMessage = useCallback(async () => {
    const conv = activeConvRef.current;
    if (!conv || conv.messages.length === 0) return;

    setIsRetrying(true);
    setRetryCount((c) => c + 1);

    const lastUserMsg = [...conv.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    const files = lastUserMsg.attachments?.map((a) => a.file).filter(Boolean) as File[] || [];

    toast.info("正在重试上次请求...");

    try {
      await sendMessage(lastUserMsg.content, files);
    } finally {
      setIsRetrying(false);
    }
  }, [sendMessage]);

  return {
    sendMessage,
    stopPolling,
    isRetrying,
    retryCount,
    retryLastMessage,
    uploadProgress,
  };
}
