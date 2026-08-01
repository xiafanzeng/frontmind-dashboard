import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSendMessage,
  classifyFailure,
  getTaskPollDelay,
  outputForKnowledgePresentation,
  sliceNewOutput,
} from "../hooks/useSendMessage";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createKnowledgeBaseTurnTask: vi.fn(),
  createResponseLogicTask: vi.fn(),
  retrieveTask: vi.fn(),
  reconcileKnowledgeBaseProgress: vi.fn(),
  uploadFile: vi.fn(),
  fileToBase64: vi.fn(),
  creditEmit: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  updateTitle: vi.fn(),
  createConversation: vi.fn(),
  parseOutputMessages: vi.fn(),
  sanitizeKnowledgeBaseOutputMessages: vi.fn((messages: any[]) => messages),
  useConversation: vi.fn(),
  prepareUploadFiles: vi.fn(),
  isImageUpload: vi.fn(),
}));

vi.mock("@/lib/frontmind-api", () => ({
  createTask: mocks.createTask,
  createKnowledgeBaseTurnTask: mocks.createKnowledgeBaseTurnTask,
  createResponseLogicTask: mocks.createResponseLogicTask,
  retrieveTask: mocks.retrieveTask,
  uploadFile: mocks.uploadFile,
  fileToBase64: mocks.fileToBase64,
  creditEventBus: {
    emit: mocks.creditEmit,
  },
  sanitizeBrandText: (value: string) => value.replace(/Manus/gi, "FrontMind"),
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
  sanitizeKnowledgeBaseOutputMessages:
    mocks.sanitizeKnowledgeBaseOutputMessages,
}));

vi.mock("@/lib/knowledge-progress", () => ({
  reconcileKnowledgeBaseProgress: mocks.reconcileKnowledgeBaseProgress,
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

describe("sliceNewOutput", () => {
  const output = (id: string) => ({
    id,
    type: "message",
    role: "assistant" as const,
    content: [{ type: "output_text", text: id }],
  });

  it("slices a cumulative 5 → 6 response by its stable historical prefix", () => {
    const historicalIds = ["old-1", "old-2", "old-3", "old-4", "old-5"];
    const result = sliceNewOutput(
      [...historicalIds.map(output), output("new-1")],
      5,
      historicalIds,
    );

    expect(result.map((item) => item.id)).toEqual(["new-1"]);
  });

  it("keeps a non-cumulative 5 → 1 current-turn response", () => {
    const historicalIds = ["old-1", "old-2", "old-3", "old-4", "old-5"];
    const result = sliceNewOutput([output("new-1")], 5, historicalIds);

    expect(result.map((item) => item.id)).toEqual(["new-1"]);
  });

  it("deduplicates repeated items by stable output ID", () => {
    const result = sliceNewOutput([output("new-1"), output("new-1")], 5, [
      "old-1",
    ]);

    expect(result.map((item) => item.id)).toEqual(["new-1"]);
  });
});

describe("outputForKnowledgePresentation", () => {
  it("recovers the latest protocol turn when stable output IDs are reused", () => {
    const old = {
      id: "reused-output",
      type: "message",
      role: "assistant" as const,
      content: [
        {
          type: "output_text",
          text: '节点 2.3\n<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":3,"leafId":"2.3"} -->',
        },
      ],
    };
    const current = {
      ...old,
      content: [
        {
          type: "output_text",
          text: '节点 2.4\n<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":4,"leafId":"2.4"} -->',
        },
      ],
    };
    const image = {
      id: "leaf-image",
      type: "output_image",
      image_url: "/v1/files/leaf-image",
    };

    expect(
      outputForKnowledgePresentation([old, current, image], [], {
        revision: 4,
        leafId: "2.4",
      }),
    ).toEqual([current, image]);
  });
});

describe("long-running task polling", () => {
  it("backs off to 30 seconds without a one-hour terminal cutoff", () => {
    expect(getTaskPollDelay(0)).toBe(3_000);
    expect(getTaskPollDelay(5 * 60 * 1000)).toBe(10_000);
    expect(getTaskPollDelay(30 * 60 * 1000)).toBe(30_000);
    expect(getTaskPollDelay(8 * 60 * 60 * 1000)).toBe(30_000);
  });
});

describe("useSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTask.mockResolvedValue({
      id: "test-task-id",
      status: "completed",
      output: [],
    });
    mocks.createKnowledgeBaseTurnTask.mockResolvedValue({
      id: "test-kb-task-id",
      status: "running",
      output: [],
      knowledgeInteraction: {
        interactionState: "executing",
        canReply: false,
        canPublish: false,
        lockReason: "任务仍在执行",
      },
    });
    mocks.retrieveTask.mockResolvedValue({
      id: "test-task-id",
      status: "completed",
      output: [],
    });
    mocks.reconcileKnowledgeBaseProgress.mockResolvedValue({
      progress: null,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: "任务仍在执行",
    });
    mocks.uploadFile.mockImplementation(async (file: File) => ({
      fileId: `file-${file.name}`,
      filename: file.name,
    }));
    mocks.fileToBase64.mockResolvedValue("data:text/plain;base64,dGVzdA==");
    mocks.isImageUpload.mockReturnValue(false);
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

  it("polls, reconciles, and renders the next knowledge node after an async confirmation", async () => {
    vi.useFakeTimers();
    mocks.createKnowledgeBaseTurnTask.mockResolvedValueOnce({
      id: "test-kb-task-id",
      status: "running",
      output: [],
      knowledgeInteraction: {
        interactionState: "executing",
        canReply: false,
        canPublish: false,
        lockReason: "任务仍在执行",
      },
    });
    const completedOutput = [
      {
        id: "kb-confirmed-output",
        type: "output_message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: [
              "1.1 已确认。",
              "",
              "## 1.2 使命、愿景与企业主张",
              "",
              "硅基流动以加速 AGI 普惠人类为使命。",
              "",
              '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed","reason":"用户明确确认"}} -->',
              '<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.2","imageState":"no_eligible_asset","assetIds":[],"imageCount":0} -->',
            ].join("\n"),
          },
        ],
      },
    ];
    mocks.retrieveTask.mockResolvedValueOnce({
      id: "test-kb-task-id",
      status: "completed",
      output: completedOutput,
    });
    mocks.reconcileKnowledgeBaseProgress.mockResolvedValueOnce({
      progress: {
        build: {
          revision: 1,
          currentLeafId: "1.2",
        },
      },
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    });
    mocks.parseOutputMessages.mockReturnValueOnce([
      {
        id: "kb-confirmed-output",
        upstreamOutputId: "kb-confirmed-output",
        role: "assistant",
        content:
          "1.1 已确认。\n\n## 1.2 使命、愿景与企业主张\n\n硅基流动以加速 AGI 普惠人类为使命。",
        timestamp: 2,
      },
    ]);

    const { result, unmount } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(mocks.retrieveTask).toHaveBeenCalledWith("test-kb-task-id");
    expect(mocks.reconcileKnowledgeBaseProgress).toHaveBeenCalledWith({
      conversationId: "test-conv-id",
      taskId: "test-kb-task-id",
    });
    expect(mocks.updateAssistantMessages).toHaveBeenCalledWith("test-conv-id", [
      {
        id: "kb-confirmed-output",
        upstreamOutputId: "kb-confirmed-output",
        role: "assistant",
        content:
          "1.1 已确认。\n\n## 1.2 使命、愿景与企业主张\n\n硅基流动以加速 AGI 普惠人类为使命。",
        timestamp: 2,
      },
    ]);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "awaiting_input",
      expect.objectContaining({
        taskId: "test-kb-task-id",
        previousResponseId: "test-kb-task-id",
        lastKnownOutputLength: 1,
      }),
    );

    unmount();
    vi.useRealTimers();
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

  it("requires a new conversation when rotated credentials cannot continue an attachment task", async () => {
    mocks.createTask.mockRejectedValueOnce(
      new Error("附件不属于当前账号或使用了不同的 API Key，请重新上传该附件"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("continue with attachment", []);
    });

    const assistantError = mocks.addMessage.mock.calls.find(
      ([, message]) => message.role === "assistant",
    )?.[1];
    expect(assistantError?.content).toContain("多个账号可以共享服务连接");
    expect(assistantError?.content).toContain("历史任务与附件仍绑定原服务凭证");
    expect(assistantError?.content).toContain("请新建对话");
    expect(assistantError?.content).not.toContain("当前账号重新上传");
    expect(assistantError?.content).not.toContain("请重新上传该附件");
    expect(assistantError?.content).not.toContain(
      "检查设置中的 API Key 是否正确",
    );
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
      expect.objectContaining({
        startedAt: expect.any(Number),
        completedAt: expect.any(Number),
      }),
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
    let firstSend!: Promise<boolean>;
    let secondSend!: Promise<boolean>;

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
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "input_file",
        file_id: "file-original.png",
        filename: "original.png",
        mime_type: "image/png",
      }),
    );
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
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "input_file",
        file_id: "file-frontmind-original-images-20260706.zip",
        filename: "frontmind-original-images-20260706.zip",
        mime_type: "application/zip",
      }),
    );
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
