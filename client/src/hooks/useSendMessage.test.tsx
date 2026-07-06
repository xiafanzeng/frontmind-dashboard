import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSendMessage, classifyFailure } from "../hooks/useSendMessage";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  retrieveTask: vi.fn(),
  uploadFile: vi.fn(),
  fileToBase64: vi.fn(),
  creditEmit: vi.fn(),
  getApiKeyFingerprint: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  updateTitle: vi.fn(),
  createConversation: vi.fn(),
  parseOutputMessages: vi.fn(),
  useConversation: vi.fn(),
  prepareUploadFiles: vi.fn(),
  isImageUpload: vi.fn(),
}));

vi.mock("@/lib/frontmind-api", () => ({
  createTask: mocks.createTask,
  retrieveTask: mocks.retrieveTask,
  uploadFile: mocks.uploadFile,
  fileToBase64: mocks.fileToBase64,
  creditEventBus: {
    emit: mocks.creditEmit,
  },
  getApiKeyFingerprint: mocks.getApiKeyFingerprint,
}));

vi.mock("@/lib/attachment-files", () => ({
  prepareUploadFiles: mocks.prepareUploadFiles,
  isImageUpload: mocks.isImageUpload,
  ZIP_REFERENCE_PROMPT:
    "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。",
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

function mockPreparedFiles(files: File[], didZipLargeImages = false) {
  mocks.prepareUploadFiles.mockResolvedValue({
    files: files.map((file) => ({ file })),
    didZipLargeImages,
    zippedImages: didZipLargeImages
      ? [
          {
            name: "large.png",
            width: 12000,
            height: 3000,
            pixels: 36_000_000,
            size: 1024,
          },
        ]
      : [],
  });
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
    mocks.uploadFile.mockImplementation(async (file: File) => ({
      fileId: `file-${file.name}`,
      filename: file.name,
    }));
    mocks.fileToBase64.mockResolvedValue("data:text/plain;base64,dGVzdA==");
    mocks.isImageUpload.mockReturnValue(false);
    mocks.getApiKeyFingerprint.mockReturnValue("");
    mocks.createConversation.mockReturnValue("test-conv-id");
    mocks.parseOutputMessages.mockReturnValue([]);
    mocks.useConversation.mockReturnValue(mockConversationContext());
    mocks.prepareUploadFiles.mockImplementation(async (files: File[]) => ({
      files: files.map((file) => ({ file })),
      didZipLargeImages: false,
      zippedImages: [],
    }));
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

  it("uploads image files as input_file without base64 or input_image", async () => {
    const originalImage = new File(["image-bytes"], "original.png", {
      type: "image/png",
    });
    mockPreparedFiles([originalImage]);
    mocks.isImageUpload.mockReturnValue(true);

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [originalImage]);
    });

    expect(mocks.fileToBase64).not.toHaveBeenCalled();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile.mock.calls[0][0]).toBe(originalImage);

    const input = mocks.createTask.mock.calls[0][0][0].content;
    expect(input).toContainEqual({
      type: "input_file",
      file_id: "file-original.png",
      filename: "original.png",
    });
    expect(input.some((item: any) => item.type === "input_image")).toBe(false);
  });

  it("adds the ZIP reference prompt when oversized images were packed", async () => {
    const zipFile = new File(
      ["zip-bytes"],
      "frontmind-original-images-20260706.zip",
      {
        type: "application/zip",
      },
    );
    mocks.prepareUploadFiles.mockResolvedValueOnce({
      files: [{ file: zipFile, generatedFromImages: [{ name: "large.png" }] }],
      didZipLargeImages: true,
      zippedImages: [
        {
          name: "large.png",
          width: 12000,
          height: 3000,
          pixels: 36_000_000,
          size: 1024,
        },
      ],
    });

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with zip", [
        new File(["x"], "large.png", { type: "image/png" }),
      ]);
    });

    expect(mocks.uploadFile.mock.calls[0][0]).toBe(zipFile);
    const input = mocks.createTask.mock.calls[0][0][0].content;
    expect(input).toContainEqual({
      type: "input_text",
      text: "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。",
    });
    expect(input).toContainEqual({
      type: "input_file",
      file_id: "file-frontmind-original-images-20260706.zip",
      filename: "frontmind-original-images-20260706.zip",
    });
  });

  it("does not create a task when file upload fails", async () => {
    const file = new File(["image-bytes"], "original.png", {
      type: "image/png",
    });
    mockPreparedFiles([file]);
    mocks.isImageUpload.mockReturnValue(true);
    mocks.uploadFile.mockRejectedValue(new Error("upload failed"));

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [file], {
        retryConfig: { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
      });
    });

    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.fileToBase64).not.toHaveBeenCalled();
  });

  it("does not create a task when ZIP preparation fails", async () => {
    mocks.prepareUploadFiles.mockRejectedValueOnce(new Error("zip failed"));

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [
        new File(["x"], "large.png", { type: "image/png" }),
      ]);
    });

    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("classifies busy errors separately from API key errors", () => {
    expect(classifyFailure("server is temporarily overloaded")).toBe("busy");
    expect(classifyFailure("API Error 504")).toBe("busy");
    expect(classifyFailure("请求超时 (300s)")).toBe("busy");
    expect(classifyFailure("401 unauthorized")).toBe("auth");
  });
});
