import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSendMessage, classifyFailure } from "../hooks/useSendMessage";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  retrieveTask: vi.fn(),
  uploadFile: vi.fn(),
  fileToBase64: vi.fn(),
  isImageFile: vi.fn(),
  creditEmit: vi.fn(),
  getApiKeyFingerprint: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  updateTitle: vi.fn(),
  createConversation: vi.fn(),
  parseOutputMessages: vi.fn(),
  useConversation: vi.fn(),
}));

vi.mock("@/lib/frontmind-api", () => ({
  createTask: mocks.createTask,
  retrieveTask: mocks.retrieveTask,
  uploadFile: mocks.uploadFile,
  fileToBase64: mocks.fileToBase64,
  isImageFile: mocks.isImageFile,
  creditEventBus: {
    emit: mocks.creditEmit,
  },
  getApiKeyFingerprint: mocks.getApiKeyFingerprint,
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: mocks.useConversation,
  parseOutputMessages: mocks.parseOutputMessages,
}));

function mockConversationContext(overrides = {}) {
  return {
    state: { conversations: [] },
    activeConversation: null,
    addMessage: mocks.addMessage,
    updateStatus: mocks.updateStatus,
    updateAssistantMessages: mocks.updateAssistantMessages,
    updateTitle: mocks.updateTitle,
    createConversation: mocks.createConversation,
    ...overrides,
  };
}

describe("useSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTask.mockResolvedValue({
      id: "test-task-id",
      status: "completed",
      output: [],
    });
    mocks.retrieveTask.mockResolvedValue({
      id: "test-task-id",
      status: "completed",
      output: [],
    });
    mocks.uploadFile.mockResolvedValue({
      fileId: "test-file-id",
      filename: "test.png",
    });
    mocks.fileToBase64.mockResolvedValue("data:image/png;base64,dGVzdA==");
    mocks.isImageFile.mockReturnValue(false);
    mocks.getApiKeyFingerprint.mockReturnValue("");
    mocks.createConversation.mockReturnValue("test-conv-id");
    mocks.parseOutputMessages.mockReturnValue([]);
    mocks.useConversation.mockReturnValue(mockConversationContext());
  });

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

  it("does not retry createTask when upstream is overloaded", async () => {
    mocks.createTask.mockRejectedValueOnce(
      new Error("server is temporarily overloaded, please try again later"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("hello", []);
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveTask).not.toHaveBeenCalled();

    const assistantError = mocks.addMessage.mock.calls.find(
      ([, message]) => message.role === "assistant",
    )?.[1];
    expect(assistantError?.content).toContain("服务暂时繁忙");
    expect(assistantError?.content).not.toContain("API Key 是否正确");
  });

  it("does not retry createTask or start polling after timeout", async () => {
    mocks.createTask.mockRejectedValueOnce(
      new Error("请求超时 (300s)，API 服务器响应过慢。可尝试重新发送。"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("hello", []);
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenLastCalledWith(
      "test-conv-id",
      "error",
    );
  });

  it("guards concurrent sends so only one task is created", async () => {
    let resolveTask!: (value: {
      id: string;
      status: "completed";
      output: never[];
    }) => void;
    const pendingTask = new Promise<{
      id: string;
      status: "completed";
      output: never[];
    }>((resolve) => {
      resolveTask = resolve;
    });
    mocks.createTask.mockReturnValueOnce(pendingTask);

    const { result } = renderHook(() => useSendMessage());
    let firstSend!: Promise<void>;
    let secondSend!: Promise<void>;

    await act(async () => {
      firstSend = result.current.sendMessage("first", []);
      secondSend = result.current.sendMessage("second", []);
      await Promise.resolve();
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTask({ id: "test-task-id", status: "completed", output: [] });
      await firstSend;
      await secondSend;
    });

    const userMessages = mocks.addMessage.mock.calls.filter(
      ([, message]) => message.role === "user",
    );
    expect(userMessages).toHaveLength(1);
  });

  it("uploads image files without replacing or compressing the File object", async () => {
    mocks.isImageFile.mockImplementation((file: File) =>
      file.type.startsWith("image/"),
    );
    const originalImage = new File(["image-bytes"], "large.png", {
      type: "image/png",
    });

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [originalImage]);
    });

    expect(mocks.fileToBase64).toHaveBeenCalledWith(originalImage);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile.mock.calls[0][0]).toBe(originalImage);
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
  });

  it("classifies busy errors separately from API key errors", () => {
    expect(classifyFailure("server is temporarily overloaded")).toBe("busy");
    expect(classifyFailure("API Error 504")).toBe("busy");
    expect(classifyFailure("请求超时 (300s)")).toBe("busy");
    expect(classifyFailure("401 unauthorized")).toBe("auth");
  });
});
