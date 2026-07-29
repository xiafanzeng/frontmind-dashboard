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
  type Conversation,
} from "@/contexts/ConversationContext";
import { retrieveTask, creditEventBus } from "@/lib/frontmind-api";
import {
  fetchKnowledgeBaseProgress,
  reconcileKnowledgeBaseProgress,
} from "@/lib/knowledge-progress";
import {
  collectAssistantOutputIds,
  sliceNewOutput,
} from "@/hooks/useSendMessage";
import { toast } from "sonner";

const RESUME_POLL_INTERVAL = 4000; // 4 seconds between resume polls
const RESUME_POLL_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours max resume polling

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

    // Parse and update output messages
    const baselineOutputLength = conv.lastKnownOutputLength || 0;
    if (taskData.output && taskData.output.length > 0) {
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

      if (newOutput.length > 0) {
        try {
          const msgs = parseOutputMessages(
            newOutput,
            conv.startedAt || conv.createdAt,
            conv.messages?.[conv.messages.length - 1]?.modelName,
          );
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
  const recoveredCompletedTasksRef = useRef(new Set<string>());

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
      // Timeout check
      if (Date.now() - resumeStartedAtRef.current > RESUME_POLL_TIMEOUT) {
        console.warn("[ResumePolling] Resume polling timed out (2 hours)");
        // Mark remaining as error
        for (const convId of stillRunning) {
          updateStatusRef.current(convId, "error", {
            completedAt: Date.now(),
          });
        }
        toast.warning("轮询超时（2小时），请手动刷新查看结果");
        stopResumePolling();
        return;
      }

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
        resumeTimerRef.current = setTimeout(pollOnce, RESUME_POLL_INTERVAL);
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

  // A task may finish while its final progress reconciliation is interrupted.
  // Completed knowledge-base conversations are checked once after hydration so
  // the server-side output ledger can safely catch up after a refresh.
  useEffect(() => {
    if (!hydrated) {
      recoveredCompletedTasksRef.current.clear();
      return;
    }
    for (const conversation of state.conversations) {
      if (conversation.status !== "completed" || !conversation.taskId) continue;
      const key = `${conversation.id}:${conversation.taskId}`;
      if (recoveredCompletedTasksRef.current.has(key)) continue;
      recoveredCompletedTasksRef.current.add(key);
      void (async () => {
        try {
          const progress = await fetchKnowledgeBaseProgress(conversation.id);
          if (!progress) return;
          await reconcileKnowledgeBaseProgress({
            conversationId: conversation.id,
            taskId: conversation.taskId,
          });
        } catch {
          recoveredCompletedTasksRef.current.delete(key);
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
