import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResumePolling } from "./useResumePolling";

const mocks = vi.hoisted(() => ({
  hydrated: false,
  retrieveTask: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    hydrated: mocks.hydrated,
    state: {
      conversations: [
        {
          id: "running",
          title: "Running",
          messages: [],
          status: "running",
          taskId: "task-1",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    updateStatus: mocks.updateStatus,
    updateAssistantMessages: mocks.updateAssistantMessages,
  }),
  parseOutputMessages: vi.fn(() => []),
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
});
