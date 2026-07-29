import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResumePolling } from "./useResumePolling";

const mocks = vi.hoisted(() => ({
  hydrated: false,
  retrieveTask: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  parseOutputMessages: vi.fn((..._args: any[]): any[] => []),
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
}));

vi.mock("@/lib/frontmind-api", () => ({
  retrieveTask: mocks.retrieveTask,
  creditEventBus: { emit: vi.fn() },
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
  });

  afterEach(() => vi.useRealTimers());

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
});
