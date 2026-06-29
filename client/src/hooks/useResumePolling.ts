/**
 * useResumePolling Hook
 *
 * CRITICAL FIX: Resumes polling for conversations stuck in "running" state
 * after page reload, browser tab switch, or network reconnection.
 *
 * Problem: When the browser tab is backgrounded or the page is refreshed,
 * the polling interval is lost. The conversation state persisted in localStorage
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
  updateAssistantMessages: ReturnType<typeof useConversation>["updateAssistantMessages"]
): Promise<boolean> {
  if (!conv.taskId) return false;

  try {
    const taskData = await retrieveTask(conv.taskId);
    const normalizedStatus =
      taskData.status === "failed" ? "error" : taskData.status;

    // Parse and update output messages
    const baselineOutputLength = conv.lastKnownOutputLength || 0;
    if (taskData.output && taskData.output.length > 0) {
      const newOutput =
        baselineOutputLength > 0 && baselineOutputLength < taskData.output.length
          ? taskData.output.slice(baselineOutputLength)
          : taskData.output;

      if (newOutput.length > 0) {
        try {
          const msgs = parseOutputMessages(
            newOutput,
            conv.startedAt || conv.createdAt,
            conv.messages?.[conv.messages.length - 1]?.modelName
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
  const { state, updateStatus, updateAssistantMessages } = useConversation();
  const resumeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resumeStartedAtRef = useRef<number>(0);
  const isResumingRef = useRef(false);

  // Use refs for latest state to avoid stale closures
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const updateAssistantMessagesRef = useRef(updateAssistantMessages);
  updateAssistantMessagesRef.current = updateAssistantMessages;

  const stopResumePolling = useCallback(() => {
    if (resumeTimerRef.current) {
      clearInterval(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    isResumingRef.current = false;
  }, []);

  const startResumePolling = useCallback(() => {
    // Don't start if already running
    if (isResumingRef.current) return;

    // Find conversations that are stuck in "running" state
    const runningConvs = stateRef.current.conversations.filter(
      (c) => (c.status === "running" || c.status === "pending") && c.taskId
    );

    if (runningConvs.length === 0) return;

    console.log(
      `[ResumePolling] Found ${runningConvs.length} running conversation(s), resuming polling...`
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
          (c) => c.id === convId
        );
        if (!conv || !conv.taskId) {
          toRemove.push(convId);
          continue;
        }

        const isStillRunning = await checkAndUpdateTask(
          conv,
          updateStatusRef.current,
          updateAssistantMessagesRef.current
        );

        if (!isStillRunning) {
          toRemove.push(convId);
        }
      }

      // Remove completed conversations from tracking
      for (const id of toRemove) {
        stillRunning.delete(id);
      }

      // If all done, stop polling
      if (stillRunning.size === 0) {
        console.log("[ResumePolling] All running tasks resolved, stopping resume polling");
        stopResumePolling();
      }
    };

    // Do an immediate check
    pollOnce();

    // Then set up interval
    resumeTimerRef.current = setInterval(pollOnce, RESUME_POLL_INTERVAL);
  }, [stopResumePolling]);

  // On mount: check for stuck conversations
  useEffect(() => {
    // Small delay to let the app fully initialize
    const timer = setTimeout(() => {
      startResumePolling();
    }, 1000);
    return () => {
      clearTimeout(timer);
      stopResumePolling();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On visibility change: resume polling when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Re-check if any conversations are stuck
        const runningConvs = stateRef.current.conversations.filter(
          (c) => (c.status === "running" || c.status === "pending") && c.taskId
        );
        if (runningConvs.length > 0 && !isResumingRef.current) {
          console.log("[ResumePolling] Tab visible, resuming polling for stuck tasks");
          startResumePolling();
        }
      }
    };

    const handleFocus = () => {
      const runningConvs = stateRef.current.conversations.filter(
        (c) => (c.status === "running" || c.status === "pending") && c.taskId
      );
      if (runningConvs.length > 0 && !isResumingRef.current) {
        console.log("[ResumePolling] Window focused, resuming polling for stuck tasks");
        startResumePolling();
      }
    };

    const handleOnline = () => {
      const runningConvs = stateRef.current.conversations.filter(
        (c) => (c.status === "running" || c.status === "pending") && c.taskId
      );
      if (runningConvs.length > 0 && !isResumingRef.current) {
        console.log("[ResumePolling] Network reconnected, resuming polling for stuck tasks");
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
