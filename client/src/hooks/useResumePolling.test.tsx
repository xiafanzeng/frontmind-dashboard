import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getResumePollDelay, useResumePolling } from "./useResumePolling";

const mocks = vi.hoisted(() => ({
  hydrated: false,
  retrieveTask: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  parseOutputMessages: vi.fn((..._args: any[]): any[] => []),
  sanitizeKnowledgeBaseOutputMessages: vi.fn((messages: any[]) => messages),
  fetchKnowledgeBaseProgress: vi.fn(),
  reconcileKnowledgeBaseProgress: vi.fn(),
  conversations: [] as any[],
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    hydrated: mocks.hydrated,
    state: { conversations: mocks.conversations },
    updateStatus: mocks.updateStatus,
    updateAssistantMessages: mocks.updateAssistantMessages,
  }),
  parseOutputMessages: mocks.parseOutputMessages,
  sanitizeKnowledgeBaseOutputMessages:
    mocks.sanitizeKnowledgeBaseOutputMessages,
}));

vi.mock("@/lib/frontmind-api", () => ({
  retrieveTask: mocks.retrieveTask,
  creditEventBus: { emit: vi.fn() },
}));

vi.mock("@/lib/knowledge-progress", () => ({
  fetchKnowledgeBaseProgress: mocks.fetchKnowledgeBaseProgress,
  reconcileKnowledgeBaseProgress: mocks.reconcileKnowledgeBaseProgress,
}));

describe("useResumePolling hydration gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.hydrated = false;
    mocks.conversations = [
      {
        id: "running",
        title: "Running",
        messages: [],
        status: "running",
        taskId: "task-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "running",
      output: [],
    });
    mocks.fetchKnowledgeBaseProgress.mockResolvedValue(null);
    mocks.reconcileKnowledgeBaseProgress.mockResolvedValue({
      progress: null,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: null,
    });
  });

  afterEach(() => vi.useRealTimers());

  it("backs off to 30 seconds and has no two-hour terminal delay", () => {
    expect(getResumePollDelay(0)).toBe(4_000);
    expect(getResumePollDelay(5 * 60 * 1000)).toBe(10_000);
    expect(getResumePollDelay(30 * 60 * 1000)).toBe(30_000);
    expect(getResumePollDelay(12 * 60 * 60 * 1000)).toBe(30_000);
  });

  it("does not resume a cloud task until conversations are hydrated", async () => {
    const { rerender, unmount } = renderHook(() => useResumePolling());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.retrieveTask).not.toHaveBeenCalled();

    mocks.hydrated = true;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.retrieveTask).toHaveBeenCalledWith("task-1");

    unmount();
  });

  it("stops resume polling when hydration is cleared on logout", async () => {
    mocks.hydrated = true;
    const { rerender, unmount } = renderHook(() => useResumePolling());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.retrieveTask).toHaveBeenCalledTimes(1);

    mocks.hydrated = false;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(mocks.retrieveTask).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("restores a shorter non-cumulative current-turn output after reload", async () => {
    mocks.hydrated = true;
    mocks.conversations = [
      {
        id: "running",
        title: "Running",
        messages: [
          { id: "user-old", role: "user", content: "old" },
          { id: "old-5", role: "assistant", content: "old answer" },
          { id: "user-current", role: "user", content: "continue" },
        ],
        status: "running",
        taskId: "task-1",
        createdAt: 1,
        updatedAt: 1,
        lastKnownOutputLength: 5,
      },
    ];
    const currentTurnOutput = [
      {
        id: "new-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "new answer" }],
      },
    ];
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "running",
      output: currentTurnOutput,
    });
    mocks.parseOutputMessages.mockReturnValue([
      {
        id: "new-1",
        role: "assistant",
        content: "new answer",
        timestamp: 2,
      },
    ]);

    const { unmount } = renderHook(() => useResumePolling());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mocks.parseOutputMessages).toHaveBeenCalledWith(
      currentTurnOutput,
      1,
      undefined,
    );
    expect(mocks.updateAssistantMessages).toHaveBeenCalledWith(
      "running",
      expect.arrayContaining([
        expect.objectContaining({ id: "new-1", content: "new answer" }),
      ]),
    );

    unmount();
  });

  it("continues checking a restored task after more than two hours", async () => {
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    mocks.hydrated = true;
    mocks.conversations[0].startedAt =
      Date.now() - 3 * 60 * 60 * 1000;
    const { unmount } = renderHook(() => useResumePolling());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.retrieveTask).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-07-29T03:00:00.000Z"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.retrieveTask).toHaveBeenCalledTimes(2);
    expect(mocks.updateStatus).not.toHaveBeenCalledWith(
      "running",
      "error",
      expect.anything(),
    );

    unmount();
  });

  it("self-heals an error task when terminal output reused its provider ID", async () => {
    mocks.hydrated = true;
    mocks.conversations = [
      {
        id: "kb-error",
        title: "Knowledge",
        messages: [
          { id: "user", role: "user", content: "确认", timestamp: 1 },
        ],
        status: "error",
        taskId: "task-kb",
        createdAt: 1,
        updatedAt: 1,
        lastKnownOutputLength: 1,
      },
    ];
    const terminalOutput = [
      {
        id: "reused-output",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "5.6 正文\n<!-- FRONTMIND_KB_PRESENTATION {\"revision\":46,\"leafId\":\"5.6\"} -->",
          },
        ],
      },
    ];
    mocks.retrieveTask.mockResolvedValue({
      id: "task-kb",
      status: "completed",
      output: terminalOutput,
    });
    mocks.fetchKnowledgeBaseProgress.mockResolvedValue({
      build: { id: "build", conversationId: "kb-error" },
    });
    mocks.reconcileKnowledgeBaseProgress.mockResolvedValue({
      progress: {
        build: { id: "build", conversationId: "kb-error" },
      },
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    });
    mocks.parseOutputMessages.mockReturnValue([
      {
        id: "reused-output",
        role: "assistant",
        content: "5.6 正文",
        timestamp: 2,
      },
    ]);

    const { unmount } = renderHook(() => useResumePolling());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.reconcileKnowledgeBaseProgress).toHaveBeenCalledWith({
      conversationId: "kb-error",
      taskId: "task-kb",
    });
    expect(mocks.updateAssistantMessages).toHaveBeenCalledWith(
      "kb-error",
      expect.arrayContaining([
        expect.objectContaining({ content: "5.6 正文" }),
      ]),
    );
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "kb-error",
      "awaiting_input",
      expect.objectContaining({ taskId: "task-kb" }),
    );

    unmount();
  });
});
