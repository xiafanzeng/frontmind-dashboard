/**
 * useResumePolling Hook
 *
 * CRITICAL FIX: Resumes polling for conversations stuck in "running" state
 * after page reload, browser tab switch, or network reconnection.
 *
 * Problem: When the browser tab is backgrounded or the page is refreshed,
 * the polling interval is lost. The conversation state persisted in the cloud
 * still shows "running", but no polling is active to detect completion.
 *
 * Solution: This hook monitors for conversations in "running" state that have
 * a taskId but no active polling. It checks the task status via the API and
 * either resumes polling or updates the status to completed/error.
 *
 * Triggers:
 * - On mount (page load / refresh)
 * - On document visibilitychange (tab becomes visible again)
 * - On window focus
 * - On window online (network reconnection)
 */
import { useEffect, useRef, useCallback } from "react";
import {
  useConversation,
  parseOutputMessages,
  sanitizeKnowledgeBaseOutputMessages,
  type Conversation,
} from "@/contexts/ConversationContext";
import { retrieveTask, creditEventBus } from "@/lib/frontmind-api";
import {
  fetchKnowledgeBaseProgress,
  reconcileKnowledgeBaseProgress,
} from "@/lib/knowledge-progress";
import {
  collectAssistantOutputIds,
  outputForKnowledgePresentation,
  sliceNewOutput,
} from "@/hooks/useSendMessage";
import { toast } from "sonner";

export function getResumePollDelay(elapsedMs: number) {
  if (elapsedMs < 5 * 60 * 1000) return 4_000;
  if (elapsedMs < 30 * 60 * 1000) return 10_000;
  return 30_000;
}

/**
 * Check a single conversation's task status and update accordingly.
 * Returns true if the task is still running (needs continued polling).
 */
async function checkAndUpdateTask(
  conv: Conversation,
  updateStatus: ReturnType<typeof useConversation>["updateStatus"],
  updateAssistantMessages: ReturnType<
    typeof useConversation
  >["updateAssistantMessages"],
): Promise<boolean> {
  if (!conv.taskId) return false;

  try {
    const taskData = await retrieveTask(conv.taskId);
    const normalizedStatus =
      taskData.status === "failed" ? "error" : taskData.status;
    let existingProgress: Awaited<
      ReturnType<typeof fetchKnowledgeBaseProgress>
    > = null;
    try {
      existingProgress = await fetchKnowledgeBaseProgress(conv.id);
    } catch {
      // Non-knowledge conversations do not have a build row.
    }
    const isKnowledgeBaseConversation = Boolean(existingProgress);

    const applyRetrievedOutput = (knowledgeBase: boolean) => {
      if (!taskData.output || taskData.output.length === 0) return;
      const baselineOutputLength = conv.lastKnownOutputLength || 0;
      const lastUserIndex = conv.messages.reduce(
        (latest, message, index) => (message.role === "user" ? index : latest),
        -1,
      );
      const historicalMessages =
        lastUserIndex >= 0
          ? conv.messages.slice(0, lastUserIndex)
          : conv.messages;
      const historicalOutputIds = collectAssistantOutputIds(historicalMessages);
      const newOutput = sliceNewOutput(
        taskData.output,
        baselineOutputLength,
        historicalOutputIds,
      );
      const presentationOutput = knowledgeBase
        ? outputForKnowledgePresentation(taskData.output, newOutput)
        : newOutput;

      if (presentationOutput.length > 0) {
        try {
          const parsedMessages = parseOutputMessages(
            presentationOutput,
            conv.startedAt || conv.createdAt,
            conv.messages?.[conv.messages.length - 1]?.modelName,
          );
          const msgs = knowledgeBase
            ? sanitizeKnowledgeBaseOutputMessages(parsedMessages)
            : parsedMessages;
          if (msgs.length > 0) {
            // If completed, attach elapsed time to last message
            if (normalizedStatus === "completed") {
              const completedAt = Date.now();
              const elapsedSec =
                (completedAt - (conv.startedAt || conv.createdAt)) / 1000;
              msgs[msgs.length - 1].elapsedTime = elapsedSec;
            }
            updateAssistantMessages(conv.id, msgs);
          }
        } catch (parseErr) {
          console.error("[ResumePolling] Error parsing output:", parseErr);
        }
      }
    };

    // Ordinary conversations can render incremental output immediately.
    // Knowledge-base output is rendered only after the server accepts its
    // progress/presentation envelopes below.
    if (!isKnowledgeBaseConversation) {
      applyRetrievedOutput(false);
    }

    try {
      if (existingProgress) {
        const interaction = await reconcileKnowledgeBaseProgress({
          conversationId: conv.id,
          taskId: taskData.id,
        });
        if (interaction.interactionState === "awaiting_input") {
          applyRetrievedOutput(true);
          updateStatus(conv.id, "awaiting_input", {
            taskId: taskData.id,
            taskUrl: taskData.metadata?.task_url,
            previousResponseId: taskData.id,
            lastKnownOutputLength: taskData.output?.length || 0,
          });
          return false;
        }
        if (
          interaction.interactionState === "ready_to_publish" ||
          interaction.interactionState === "published"
        ) {
          applyRetrievedOutput(true);
          updateStatus(conv.id, "completed", {
            taskId: taskData.id,
            completedAt: Date.now(),
            lastKnownOutputLength: taskData.output?.length || 0,
          });
          return false;
        }
        if (interaction.interactionState === "failed") {
          updateStatus(conv.id, "error", {
            taskId: taskData.id,
            completedAt: Date.now(),
            lastKnownOutputLength: taskData.output?.length || 0,
          });
          return false;
        }
      }
    } catch {
      // A partial running response is allowed to remain unreconciled. The
      // next visibility/focus poll will retry with the completed envelope.
    }

    if (isKnowledgeBaseConversation && normalizedStatus === "completed") {
      updateStatus(conv.id, "error", {
        completedAt: Date.now(),
        lastKnownOutputLength: taskData.output?.length || 0,
      });
      toast.error("任务已结束，但未返回完整的知识节点状态");
      return false;
    }

    if (normalizedStatus === "completed") {
      const completedAt = Date.now();
      const totalOutputLength = taskData.output?.length || 0;
      try {
        await reconcileKnowledgeBaseProgress({
          conversationId: conv.id,
          taskId: taskData.id,
        });
      } catch {
        // Most conversations are not knowledge-base builds. The dedicated
        // endpoint validates the task/build binding before changing progress.
      }
      updateStatus(conv.id, "completed", {
        completedAt,
        lastKnownOutputLength: totalOutputLength,
      });
      const elapsedSec =
        (completedAt - (conv.startedAt || conv.createdAt)) / 1000;
      toast.success(`任务已完成 (耗时 ${elapsedSec.toFixed(1)}s)`);
      creditEventBus.emit();
      return false; // Done
    }

    if (normalizedStatus === "error") {
      const completedAt = Date.now();
      const totalOutputLength = taskData.output?.length || 0;
      updateStatus(conv.id, "error", {
        completedAt,
        lastKnownOutputLength: totalOutputLength,
      });
      const errorMsg = taskData.error?.message || "任务执行出错";
      toast.error(errorMsg);
      creditEventBus.emit();
      return false; // Done
    }

    // Still running - update intermediate output
    updateStatus(conv.id, normalizedStatus as any, {
      taskId: taskData.id,
      taskUrl: taskData.metadata?.task_url,
    });
    return true; // Still running
  } catch (err: any) {
    console.error("[ResumePolling] Error checking task:", err.message);
    // On 404, the task was deleted
    if (err.message?.includes("404")) {
      updateStatus(conv.id, "error", { completedAt: Date.now() });
      toast.error("任务不存在或已被删除");
      return false;
    }
    // On other errors, keep trying
    return true;
  }
}

export function useResumePolling() {
  const { state, hydrated, updateStatus, updateAssistantMessages } =
    useConversation();
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeStartedAtRef = useRef<number>(0);
  const isResumingRef = useRef(false);
  const hydratedRef = useRef(hydrated);
  hydratedRef.current = hydrated;

  // Use refs for latest state to avoid stale closures
  const stateRef = useRef(state);
  stateRef.current = state;
  const resumableTaskKey = state.conversations
    .filter(
      (conversation) =>
        (conversation.status === "running" ||
          conversation.status === "pending") &&
        conversation.taskId,
    )
    .map((conversation) => `${conversation.id}:${conversation.taskId}`)
    .sort()
    .join("|");
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const updateAssistantMessagesRef = useRef(updateAssistantMessages);
  updateAssistantMessagesRef.current = updateAssistantMessages;
  const recoveredTerminalTasksRef = useRef(new Set<string>());

  const stopResumePolling = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    isResumingRef.current = false;
  }, []);

  const startResumePolling = useCallback(() => {
    // The database is authoritative. Never inspect the initial empty state or
    // stale state from a previous account before cloud hydration completes.
    if (!hydratedRef.current) return;

    // Don't start if already running
    if (isResumingRef.current) return;

    // Find conversations that are stuck in "running" state
    const runningConvs = stateRef.current.conversations.filter(
      (c) => (c.status === "running" || c.status === "pending") && c.taskId,
    );

    if (runningConvs.length === 0) return;

    console.log(
      `[ResumePolling] Found ${runningConvs.length} running conversation(s), resuming polling...`,
    );
    toast.info("检测到进行中的任务，正在恢复状态...", { duration: 3000 });

    isResumingRef.current = true;
    resumeStartedAtRef.current = Date.now();

    // Track which conversations are still running
    const stillRunning = new Set(runningConvs.map((c) => c.id));

    const pollOnce = async () => {
      // Check each still-running conversation
      const toRemove: string[] = [];
      for (const convId of stillRunning) {
        const conv = stateRef.current.conversations.find(
          (c) => c.id === convId,
        );
        if (!conv || !conv.taskId) {
          toRemove.push(convId);
          continue;
        }

        const isStillRunning = await checkAndUpdateTask(
          conv,
          updateStatusRef.current,
          updateAssistantMessagesRef.current,
        );

        if (!isStillRunning) {
          toRemove.push(convId);
        }
      }

      // Remove completed conversations from tracking
      for (const id of toRemove) {
        stillRunning.delete(id);
      }

      // If all done, stop polling. Otherwise schedule the next check only
      // after every request in this pass has settled, avoiding overlaps.
      if (stillRunning.size === 0) {
        console.log(
          "[ResumePolling] All running tasks resolved, stopping resume polling",
        );
        stopResumePolling();
      } else if (isResumingRef.current) {
        const oldestStartedAt = Math.min(
          ...[...stillRunning].map((conversationId) => {
            const conversation = stateRef.current.conversations.find(
              (candidate) => candidate.id === conversationId,
            );
            return (
              conversation?.startedAt ||
              conversation?.createdAt ||
              resumeStartedAtRef.current
            );
          }),
        );
        resumeTimerRef.current = setTimeout(
          pollOnce,
          getResumePollDelay(Date.now() - oldestStartedAt),
        );
      }
    };

    // Do an immediate check
    void pollOnce();
  }, [stopResumePolling]);

  // Start only after this account's cloud conversations have hydrated. This
  // also handles a slow initial request where the old mount-only timer would
  // have fired too early and never tried again.
  useEffect(() => {
    if (!hydrated) {
      stopResumePolling();
      return;
    }

    // A task creation request can be interrupted before an upstream task ID is
    // persisted. Such a conversation cannot be resumed and must not keep the
    // customer input locked indefinitely.
    for (const conversation of stateRef.current.conversations) {
      if (
        (conversation.status === "running" ||
          conversation.status === "pending") &&
        !conversation.taskId
      ) {
        updateStatusRef.current(conversation.id, "error", {
          completedAt: Date.now(),
        });
      }
    }

    const timer = setTimeout(() => {
      startResumePolling();
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [hydrated, resumableTaskKey, startResumePolling, stopResumePolling]);

  useEffect(() => stopResumePolling, [stopResumePolling]);

  // A task may finish while its final progress reconciliation is interrupted,
  // or an older build may have been incorrectly marked as error when the
  // provider reused a stable output ID. Recheck terminal knowledge-base tasks
  // once after hydration and render their output only after server validation.
  useEffect(() => {
    if (!hydrated) {
      recoveredTerminalTasksRef.current.clear();
      return;
    }
    for (const conversation of state.conversations) {
      if (
        (conversation.status !== "completed" &&
          conversation.status !== "error") ||
        !conversation.taskId
      ) {
        continue;
      }
      const key = `${conversation.id}:${conversation.taskId}`;
      if (recoveredTerminalTasksRef.current.has(key)) continue;
      recoveredTerminalTasksRef.current.add(key);
      void (async () => {
        try {
          const progress = await fetchKnowledgeBaseProgress(conversation.id);
          if (!progress) return;
          await checkAndUpdateTask(
            conversation,
            updateStatusRef.current,
            updateAssistantMessagesRef.current,
          );
        } catch {
          recoveredTerminalTasksRef.current.delete(key);
        }
      })();
    }
  }, [hydrated, state.conversations]);

  // On visibility change: resume polling when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (!hydratedRef.current) return;
        // Re-check if any conversations are stuck
        const runningConvs = stateRef.current.conversations.filter(
          (c) => (c.status === "running" || c.status === "pending") && c.taskId,
        );
        if (runningConvs.length > 0 && !isResumingRef.current) {
          console.log(
            "[ResumePolling] Tab visible, resuming polling for stuck tasks",
          );
          startResumePolling();
        }
      }
    };

    const handleFocus = () => {
      if (!hydratedRef.current) return;
      const runningConvs = stateRef.current.conversations.filter(
        (c) => (c.status === "running" || c.status === "pending") && c.taskId,
      );
      if (runningConvs.length > 0 && !isResumingRef.current) {
        console.log(
          "[ResumePolling] Window focused, resuming polling for stuck tasks",
        );
        startResumePolling();
      }
    };

    const handleOnline = () => {
      if (!hydratedRef.current) return;
      const runningConvs = stateRef.current.conversations.filter(
        (c) => (c.status === "running" || c.status === "pending") && c.taskId,
      );
      if (runningConvs.length > 0 && !isResumingRef.current) {
        console.log(
          "[ResumePolling] Network reconnected, resuming polling for stuck tasks",
        );
        startResumePolling();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [startResumePolling]);

  return { startResumePolling, stopResumePolling };
}
