import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  EmptyConversationHint,
  fetchKnowledgeBaseStartRequest,
  KNOWLEDGE_BASE_FOUNDATION_COPY,
  KNOWLEDGE_BASE_START_TIMEOUT_MS,
  projectKnowledgeBaseStarterRequest,
  shouldRecoverKnowledgeBaseStartFailure,
  uploadKnowledgeBaseStarterFiles,
  type KnowledgeBaseStarterLifecycle,
  type KnowledgeBaseStarterStartOutcome,
} from "./ChatArea";
import * as frontmindApi from "@/lib/frontmind-api";

function sizedFile(name: string, size: number) {
  return new File([new Uint8Array(size)], name, {
    type: "application/pdf",
    lastModified: 1,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function addStarterFiles(files: File[]) {
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files },
  });
}

function starterLifecycle(
  overrides: Partial<KnowledgeBaseStarterLifecycle> = {},
): KnowledgeBaseStarterLifecycle {
  return {
    signal: new AbortController().signal,
    clientRequestId: "kb-start-test",
    startedAt: 1_000,
    uploadedReceipts: new Map(),
    fileRecordIds: new Map(),
    uploadHandles: new Map(),
    fileAttempts: new Map(),
    transferredBytes: new Map(),
    startPrepared: false,
    onStartPrepared: vi.fn(),
    onBatchPhase: vi.fn(),
    onFileUpdate: vi.fn(),
    ...overrides,
  };
}

describe("EmptyConversationHint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("centers the enterprise knowledge-base action without the generic content-workflow copy", () => {
    render(
      <EmptyConversationHint
        onStartKnowledgeBase={vi.fn()}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );

    expect(
      screen.queryByText("内容制作智能体编排工作流"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("以研究、分析与交付为核心的专业内容生产引擎"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(KNOWLEDGE_BASE_FOUNDATION_COPY),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "构建企业知识库" }),
    ).toBeInTheDocument();
    expect(screen.getByText("资料输入")).toBeInTheDocument();
    expect(screen.getByText("智能分析")).toBeInTheDocument();
    expect(screen.getByText("报告交付")).toBeInTheDocument();
  });

  it("uses the shared 100 MB limit in the knowledge-base starter", () => {
    render(
      <EmptyConversationHint
        onStartKnowledgeBase={vi.fn()}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    const oversized = new File(["x"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: 100 * 1024 * 1024 + 1,
    });

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [oversized] },
    });

    expect(screen.queryByText("oversized.pdf")).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("文件过大", {
      description: "文件“oversized.pdf”不能超过 100 MB",
    });
  });

  it("keeps three completed files when the fourth fails, then retries only the fourth and fifth in original order", async () => {
    const files = Array.from({ length: 5 }, (_, index) =>
      sizedFile(`资料-${index + 1}.pdf`, (index + 1) * 10),
    );
    const uploadCalls: Array<{
      file: File;
      existingFileId?: string;
      existingUploadHandle?: frontmindApi.ManagedUploadHandle;
    }> = [];
    let fourthAttempt = 0;
    const uploadImplementation = vi.fn(
      async (
        file: File,
        _onProgress?: (percent: number) => void,
        _retryConfig?: unknown,
        options?: any,
      ) => {
        const index = files.indexOf(file);
        const fileId = `file-${index + 1}`;
        uploadCalls.push({
          file,
          existingFileId: options?.existingFileId,
          existingUploadHandle: options?.existingUploadHandle,
        });
        const uploadHandle = {
          fileId,
          filename: file.name,
          ticket: `ticket-${index + 1}`,
          expiresAt: 4_000_000_000_000,
        };
        await options?.onFileRecord?.({
          fileId,
          filename: file.name,
          uploadHandle,
          reusedExistingFileId: Boolean(
            options?.existingFileId || options?.existingUploadHandle,
          ),
        });
        options?.onStage?.({
          stage: "uploading",
          fileId,
          loadedBytes: file.size,
          totalBytes: file.size,
        });
        if (file === files[3] && fourthAttempt++ === 0) {
          throw Object.assign(new Error("第4个文件上传失败"), {
            fileId,
            retryable: true,
          });
        }
        options?.onStage?.({
          stage: "server_processing",
          fileId,
          loadedBytes: file.size,
          totalBytes: file.size,
        });
        return {
          fileId,
          filename: file.name,
          uploadedAt: 10_000 + index,
          expiresAt: 20_000 + index,
        };
      },
    );
    const startRequests = vi.fn();
    const onStartKnowledgeBase = vi.fn(
      async (input, lifecycle): Promise<KnowledgeBaseStarterStartOutcome> => {
        const uploaded = await uploadKnowledgeBaseStarterFiles(
          input.files,
          lifecycle,
          lifecycle.startedAt,
          uploadImplementation as unknown as typeof frontmindApi.uploadFile,
        );
        startRequests(uploaded.uploadedAttachments);
        return { status: "accepted" };
      },
    );

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles(files);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试并继续" })).toBeEnabled();
    });
    expect(screen.getAllByText("上传完成")).toHaveLength(3);
    expect(screen.getAllByText("第4个文件上传失败")).toHaveLength(2);
    expect(screen.getByText("等待上传")).toBeInTheDocument();
    expect(screen.getByText("已传输100 B/150 B")).toBeInTheDocument();
    expect(screen.getByText("已确认60 B/150 B")).toBeInTheDocument();
    expect(startRequests).not.toHaveBeenCalled();
    expect(files.every((file) => screen.getByText(file.name))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "重试并继续" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "构建企业知识库" }),
      ).not.toBeInTheDocument();
    });
    expect(uploadCalls.map(({ file }) => file.name)).toEqual([
      "资料-1.pdf",
      "资料-2.pdf",
      "资料-3.pdf",
      "资料-4.pdf",
      "资料-4.pdf",
      "资料-5.pdf",
    ]);
    expect(uploadCalls[4].existingUploadHandle).toMatchObject({
      fileId: "file-4",
      ticket: "ticket-4",
    });
    expect(startRequests).toHaveBeenCalledTimes(1);
    expect(startRequests.mock.calls[0][0]).toEqual(
      files.map((file, index) => ({
        file_id: `file-${index + 1}`,
        filename: file.name,
      })),
    );
  });

  it("keeps an id from a ticketless create and checks recovery before any new record", async () => {
    const file = sizedFile("缺少凭证.pdf", 24);
    const requestOrder: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/frontmind/v1/files") {
        requestOrder.push("create");
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "file-ticketless",
            filename: file.name,
            upload_url: "https://uploads.example/legacy-only",
          }),
        };
      }
      if (url.endsWith("/file-ticketless/upload-recovery")) {
        requestOrder.push("recover");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fileId: "file-ticketless",
            state: "uploaded",
            recreateRequired: false,
            traceId: "trace-ticketless",
            receipt: {
              fileId: "file-ticketless",
              sizeBytes: file.size,
              uploadedAt: 10_000,
              expiresAt: 20_000,
              replayed: false,
              recovered: true,
            },
          }),
        };
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    let acceptedCount = 0;
    const onStartKnowledgeBase = vi.fn(
      async (input, lifecycle): Promise<KnowledgeBaseStarterStartOutcome> => {
        await uploadKnowledgeBaseStarterFiles(
          input.files,
          lifecycle,
          lifecycle.startedAt,
        );
        acceptedCount += 1;
        return { status: "accepted" };
      },
    );

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles([file]);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试并继续" })).toBeEnabled();
    });
    expect(requestOrder).toEqual(["create"]);
    expect(xhrCount).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "重试并继续" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "构建企业知识库" }),
      ).not.toBeInTheDocument();
    });

    expect(requestOrder).toEqual(["create", "recover"]);
    expect(xhrCount).toBe(0);
    expect(acceptedCount).toBe(1);
  });

  it("shows byte-weighted progress and aborts without losing the batch", async () => {
    const files = [sizedFile("小册.pdf", 100), sizedFile("目录.pdf", 300)];
    let lifecycle!: KnowledgeBaseStarterLifecycle;
    const pending = deferred<KnowledgeBaseStarterStartOutcome>();
    const onStartKnowledgeBase = vi.fn((_input, nextLifecycle) => {
      lifecycle = nextLifecycle;
      nextLifecycle.signal.addEventListener(
        "abort",
        () => {
          nextLifecycle.onFileUpdate(files[0], {
            stage: "cancelled",
            loadedBytes: 0,
            totalBytes: files[0].size,
            error: "上传已停止",
          });
          pending.reject(new DOMException("上传已停止", "AbortError"));
        },
        { once: true },
      );
      return pending.promise;
    });

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles(files);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    act(() => {
      lifecycle.onFileUpdate(files[0], {
        stage: "uploading",
        loadedBytes: 50,
        totalBytes: 100,
      });
    });
    expect(screen.getByText("13%")).toBeInTheDocument();
    expect(screen.getByText("已传输50 B/400 B")).toBeInTheDocument();
    expect(screen.getByText("已确认0 B/400 B")).toBeInTheDocument();
    expect(screen.getByText("正在上传 50%")).toBeInTheDocument();
    expect(
      screen.getByText("资料上传中，尚未启动知识库构建"),
    ).toBeInTheDocument();

    act(() => {
      lifecycle.onFileUpdate(files[0], {
        stage: "server_processing",
        loadedBytes: 100,
        totalBytes: 100,
      });
    });
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("已传输100 B/400 B")).toBeInTheDocument();
    expect(screen.getByText("已确认0 B/400 B")).toBeInTheDocument();
    expect(
      screen.getByText("文件已接收，正在云端校验并登记"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "停止上传" }));
    expect(lifecycle.signal.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试并继续" })).toBeEnabled();
    });
    expect(
      screen.getByRole("dialog", { name: "构建企业知识库" }),
    ).toBeVisible();
    expect(screen.getByText("小册.pdf")).toBeInTheDocument();
    expect(screen.getByText("目录.pdf")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("上传已停止");
  });

  it("includes managed recovery in the per-file elapsed time", async () => {
    const file = sizedFile("待恢复.pdf", 40);
    const pending = deferred<KnowledgeBaseStarterStartOutcome>();
    let lifecycle!: KnowledgeBaseStarterLifecycle;
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const onStartKnowledgeBase = vi.fn((_input, nextLifecycle) => {
      lifecycle = nextLifecycle;
      nextLifecycle.onFileUpdate(file, {
        stage: "recovering",
        fileId: "file-recovering",
        loadedBytes: file.size,
        totalBytes: file.size,
        attempt: 2,
      });
      return pending.promise;
    });

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles([file]);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => {
      expect(screen.getByText("正在确认云端上传状态")).toBeInTheDocument();
    });
    nowSpy.mockReturnValue(now + 5_000);
    await act(async () => {
      lifecycle.onFileUpdate(file, {
        stage: "failed",
        fileId: "file-recovering",
        loadedBytes: file.size,
        totalBytes: file.size,
        error: "恢复确认失败",
        retryable: true,
        recoveryAction: "check_status",
        attempt: 2,
      });
      pending.reject(new Error("恢复确认失败"));
    });

    expect(screen.getByText("本次耗时 5秒")).toBeInTheDocument();
    nowSpy.mockRestore();
  });

  it("preserves uploaded receipts after a known start failure and closes on recovering without re-uploading", async () => {
    const file = sizedFile("品牌手册.pdf", 64);
    const uploadImplementation = vi.fn(async () => ({
      fileId: "file-brand",
      filename: file.name,
      uploadedAt: 10_000,
      expiresAt: 20_000,
    }));
    const registerConversation = vi.fn();
    const addConversationMessage = vi.fn();
    const updateConversationTitle = vi.fn();
    const lifecycleIdentities: Array<{
      clientRequestId: string;
      startedAt: number;
    }> = [];
    let startAttempt = 0;
    const onStartKnowledgeBase = vi.fn(
      async (input, lifecycle): Promise<KnowledgeBaseStarterStartOutcome> => {
        lifecycleIdentities.push({
          clientRequestId: lifecycle.clientRequestId,
          startedAt: lifecycle.startedAt,
        });
        const uploaded = await uploadKnowledgeBaseStarterFiles(
          input.files,
          lifecycle,
          lifecycle.startedAt,
          uploadImplementation as unknown as typeof frontmindApi.uploadFile,
        );
        lifecycle.onBatchPhase("starting");
        projectKnowledgeBaseStarterRequest({
          lifecycle,
          conversationId: "conversation-retry",
          responseStartedAt: lifecycle.startedAt,
          messageAttachments: uploaded.messageAttachments,
          registerConversation,
          addConversationMessage,
          updateConversationTitle,
        });
        startAttempt += 1;
        if (startAttempt === 1) {
          throw Object.assign(new Error("构建入口明确拒绝"), {
            status: 409,
            reservationCreated: false,
          });
        }
        return { status: "recovering" };
      },
    );

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    fireEvent.change(screen.getByPlaceholderText(/填写一个或多个企业官网/), {
      target: { value: "https://example.test" },
    });
    addStarterFiles([file]);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试启动" })).toBeEnabled();
    });
    expect(screen.getByText("上传完成")).toBeInTheDocument();
    expect(screen.getByText("品牌手册.pdf")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "移除 品牌手册.pdf" }),
    ).toBeDisabled();
    expect(
      screen.getByDisplayValue("https://example.test"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("构建入口明确拒绝");

    fireEvent.click(screen.getByRole("button", { name: "重试启动" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "构建企业知识库" }),
      ).not.toBeInTheDocument();
    });
    expect(uploadImplementation).toHaveBeenCalledTimes(1);
    expect(startAttempt).toBe(2);
    expect(addConversationMessage).toHaveBeenCalledTimes(1);
    expect(registerConversation).toHaveBeenCalledTimes(1);
    expect(updateConversationTitle).toHaveBeenCalledTimes(1);
    expect(lifecycleIdentities).toHaveLength(2);
    expect(lifecycleIdentities[1]).toEqual(lifecycleIdentities[0]);
  });

  it("blocks a misleading retry when a file failure is deterministic", async () => {
    const file = sizedFile("身份冲突.pdf", 48);
    const onStartKnowledgeBase = vi.fn(async (_input, lifecycle) => {
      lifecycle.onFileUpdate(file, {
        stage: "failed",
        fileId: "file-conflict",
        loadedBytes: 0,
        totalBytes: file.size,
        error: "该文件记录已绑定其他内容",
        errorCode: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
        retryable: false,
        traceId: "trace-conflict",
        attempt: 1,
      });
      throw Object.assign(new Error("该文件记录已绑定其他内容"), {
        code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
        retryable: false,
      });
    });

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles([file]);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "请先移除失败文件" }),
      ).toBeDisabled();
    });
    expect(
      screen.getByText(
        "无法直接重试；请移除该文件后继续，或取消本批次重新选择。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试并继续" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("第 1 次尝试")).toBeInTheDocument();
    expect(
      screen.getByText("错误码：UPLOAD_PROVIDER_IDENTITY_MISMATCH"),
    ).toBeInTheDocument();
    expect(screen.getByText("排查编号：trace-conflict")).toBeInTheDocument();
  });

  it("allows an explicit recreate recovery and shows its attempt and trace", async () => {
    const file = sizedFile("凭证过期.pdf", 48);
    const onStartKnowledgeBase = vi.fn(async (_input, lifecycle) => {
      lifecycle.onFileUpdate(file, {
        stage: "failed",
        fileId: "file-expired",
        loadedBytes: file.size,
        totalBytes: file.size,
        error: "上传凭证已过期",
        errorCode: "UPLOAD_CAPABILITY_EXPIRED",
        retryable: false,
        recoveryAction: "discard_and_recreate",
        recreateRequired: true,
        traceId: "trace-expired",
        attempt: 1,
      });
      throw Object.assign(new Error("上传凭证已过期"), {
        fileId: "file-expired",
        code: "UPLOAD_CAPABILITY_EXPIRED",
        retryable: false,
        recoveryAction: "discard_and_recreate",
        recreateRequired: true,
        traceId: "trace-expired",
      });
    });

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles([file]);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试并继续" })).toBeEnabled();
    });
    expect(
      screen.getByText("重试时会先确认云端状态，再清理旧记录并创建新上传。"),
    ).toBeInTheDocument();
    expect(screen.getByText("第 1 次尝试")).toBeInTheDocument();
    expect(
      screen.getByText("错误码：UPLOAD_CAPABILITY_EXPIRED"),
    ).toBeInTheDocument();
    expect(screen.getByText("排查编号：trace-expired")).toBeInTheDocument();
    expect(screen.getByText("已传输48 B/48 B")).toBeInTheDocument();
    expect(screen.getByText("已确认0 B/48 B")).toBeInTheDocument();
  });

  it("discards an explicitly removed unbound file and keeps the modal open when cancellation cleanup is still in progress", async () => {
    const file = sizedFile("待重试.pdf", 32);
    const cleanupError = Object.assign(new Error("文件仍在处理"), {
      code: "UPLOAD_IN_PROGRESS",
      status: 409,
    });
    const discardSpy = vi
      .spyOn(frontmindApi, "discardUnboundUpload")
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    const onStartKnowledgeBase = vi.fn(async (_input, lifecycle) => {
      lifecycle.onFileUpdate(file, {
        stage: "failed",
        fileId: "file-pending",
        loadedBytes: 0,
        totalBytes: file.size,
        error: "上传失败",
      });
      throw new Error("上传失败");
    });

    render(
      <EmptyConversationHint
        onStartKnowledgeBase={onStartKnowledgeBase}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addStarterFiles([file]);
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试并继续" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith("仍有文件正在云端处理", {
        description: "请稍后再次点击取消；未清理的上传记录已保留。",
      });
    });
    expect(
      screen.getByRole("dialog", { name: "构建企业知识库" }),
    ).toBeVisible();
    expect(screen.getByText(file.name)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `移除 ${file.name}` }));
    await waitFor(() => {
      expect(screen.queryByText(file.name)).not.toBeInTheDocument();
    });
    expect(discardSpy).toHaveBeenCalledTimes(2);
    expect(discardSpy).toHaveBeenLastCalledWith("file-pending");
    discardSpy.mockRestore();
  });
});

describe("knowledge-base starter orchestration", () => {
  it("bounds a pending start request and aborts only the linked request signal", async () => {
    vi.useFakeTimers();
    const lifecycleController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal as AbortSignal;
          requestSignal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;

    const request = fetchKnowledgeBaseStartRequest(
      { method: "POST" },
      {
        signal: lifecycleController.signal,
        fetchImplementation,
      },
    );
    const settled = request.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(KNOWLEDGE_BASE_START_TIMEOUT_MS);
    const error = await settled;
    expect(error).toMatchObject({
      status: 408,
      code: "KNOWLEDGE_BASE_START_TIMEOUT",
    });
    expect(
      shouldRecoverKnowledgeBaseStartFailure(
        true,
        error as { status?: number; code?: string },
      ),
    ).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(lifecycleController.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("projects the optimistic start message only once for a prepared request", () => {
    const registerConversation = vi.fn();
    const addConversationMessage = vi.fn();
    const updateConversationTitle = vi.fn();
    const onStartPrepared = vi.fn();
    const base = starterLifecycle({ onStartPrepared });

    expect(
      projectKnowledgeBaseStarterRequest({
        lifecycle: base,
        conversationId: "conversation-1",
        responseStartedAt: 1_000,
        messageAttachments: [],
        registerConversation,
        addConversationMessage,
        updateConversationTitle,
      }),
    ).toBe(true);
    expect(onStartPrepared).toHaveBeenCalledWith(true);

    expect(
      projectKnowledgeBaseStarterRequest({
        lifecycle: { ...base, startPrepared: true },
        conversationId: "conversation-1",
        responseStartedAt: 1_000,
        messageAttachments: [],
        registerConversation,
        addConversationMessage,
        updateConversationTitle,
      }),
    ).toBe(false);
    expect(addConversationMessage).toHaveBeenCalledTimes(1);
    expect(registerConversation).toHaveBeenCalledTimes(1);
    expect(updateConversationTitle).toHaveBeenCalledTimes(1);
  });
});
