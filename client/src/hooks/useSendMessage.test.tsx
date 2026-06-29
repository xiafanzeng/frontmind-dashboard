import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSendMessage } from "../hooks/useSendMessage";

// Mock the dependencies
vi.mock("@/lib/frontmind-api", () => ({
  createTask: vi.fn().mockResolvedValue({
    id: "test-task-id",
    status: "running",
    output: [],
  }),
  retrieveTask: vi.fn().mockResolvedValue({
    id: "test-task-id",
    status: "completed",
    output: [],
  }),
  uploadFile: vi.fn().mockResolvedValue({
    fileId: "test-file-id",
    filename: "test.pdf",
  }),
  fileToBase64: vi.fn().mockResolvedValue("data:text/plain;base64,dGVzdA=="),
  isImageFile: vi.fn().mockReturnValue(false),
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    state: { conversations: [] },
    activeConversation: null,
    addMessage: vi.fn(),
    updateStatus: vi.fn(),
    updateAssistantMessages: vi.fn(),
    updateTitle: vi.fn(),
    createConversation: vi.fn().mockReturnValue("test-conv-id"),
  }),
  parseOutputMessages: vi.fn().mockReturnValue([]),
}));

describe("useSendMessage", () => {
  it("should return sendMessage function", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(typeof result.current.sendMessage).toBe("function");
  });

  it("should return stopPolling function", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(typeof result.current.stopPolling).toBe("function");
  });

  it("should return retry state", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryCount).toBe(0);
  });

  it("should return uploadProgress as null initially", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(result.current.uploadProgress).toBeNull();
  });
});
