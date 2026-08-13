import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRefetch: vi.fn(),
  syncSnapshot: vi.fn(),
  deleteConversation: vi.fn(),
  uploadFile: vi.fn(),
  startRequests: [] as Array<{ body: Record<string, unknown> }>,
  reserveRequests: [] as Array<{ body: Record<string, unknown> }>,
  stageRequests: [] as Array<{ body: Record<string, unknown> }>,
  firstStartResolve: null as null | ((response: Response) => void),
  secondStartResolve: null as null | ((response: Response) => void),
  reconcileCalls: 0,
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 7 }, loading: false }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    conversation: {
      list: {
        useQuery: () => ({ refetch: mocks.listRefetch }),
      },
      syncSnapshot: {
        useMutation: () => ({ mutateAsync: mocks.syncSnapshot }),
      },
      delete: {
        useMutation: () => ({ mutateAsync: mocks.deleteConversation }),
      },
    },
    workspace: {
      dashboard: {
        useQuery: () => ({
          data: { enterpriseName: "验收企业" },
          isLoading: false,
        }),
      },
    },
  },
}));

vi.mock("@/lib/frontmind-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmind-api")>();
  return { ...actual, uploadFile: mocks.uploadFile };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("./ChatInput", () => ({ default: () => null }));
vi.mock("./TypingIndicator", () => ({
  default: () => null,
  PulsingDot: () => null,
}));

import ChatArea from "./ChatArea";
import {
  ConversationProvider,
  useConversation,
} from "@/contexts/ConversationContext";

function deferredResponse(which: "first" | "second") {
  return new Promise<Response>((resolve) => {
    if (which === "first") mocks.firstStartResolve = resolve;
    else mocks.secondStartResolve = resolve;
  });
}

function acceptedObservation(clientRequestId: string) {
  return {
    stateEpoch: 1,
    generation: 1,
    authoritativeTaskId: null,
    activeTurn: {
      id: "turn-start-1",
      clientRequestId,
      operationKey: "operation-start-1",
      operationType: "start",
      status: "queued",
      buildGeneration: 1,
      expectedRevision: null,
      expectedLeafId: null,
      startedAt: null,
      completedAt: null,
      updatedAt: 1,
      messageSequence: 1,
    },
    completedTurn: null,
    interaction: {
      progress: null,
      interactionState: "queued",
      canReply: false,
      canPublish: false,
      lockReason: "任务正在排队",
    },
    approvedPresentation: null,
    package: null,
    notice: null,
    conversationVersion: 1,
  };
}

function terminalProgress(updatedAt: number) {
  return {
    build: {
      id: "build-terminal",
      conversationId: "knowledge-conversation",
      companyName: "验收企业",
      status: "protocol_error",
      revision: 0,
      currentLeafId: null,
      protocolError: "UPSTREAM_CREATE_3",
      updatedAt,
    },
    summary: {
      total: 0,
      handled: 0,
      confirmed: 0,
      directPrefilled: 0,
      pending: 0,
      current: 0,
      needsVerification: 0,
      overallPercent: 0,
    },
    branches: [],
    packageAllowed: false,
  };
}

function terminalObservation(stateEpoch: number) {
  const progress = terminalProgress(stateEpoch);
  return {
    stateEpoch,
    generation: 1,
    authoritativeTaskId: null,
    activeTurn: null,
    completedTurn: null,
    interaction: {
      progress,
      interactionState: "failed",
      canReply: false,
      canPublish: false,
      lockReason: "任务未创建",
    },
    approvedPresentation: null,
    package: null,
    notice: {
      key: "build:turn:upstream-create-3",
      code: "UPSTREAM_CREATE_3",
      severity: "error",
      message: "上游已明确拒绝创建任务，当前附件均已保留。",
      retryable: false,
      failureClass: "requires_user_fix",
      recoveryAction: "contact_support",
      canRegenerate: false,
      traceId: "a0c7502e-4c1f-4d06-8ab6-407e8a82c138",
      attachmentCount: 7,
      turnId: "turn-failed",
      createdAt: stateEpoch,
      providerMessage: "sk-secret provider raw filename.pdf",
    },
    conversationVersion: stateEpoch,
    progress,
  };
}

function ConversationProbe() {
  const { activeConversation, state } = useConversation();
  return (
    <output data-testid="conversation-probe">
      {JSON.stringify({
        activeId: activeConversation?.id ?? null,
        conversationCount: state.conversations.length,
        messageCount: activeConversation?.messages.length ?? 0,
        requestIds:
          activeConversation?.messages
            .map((message) => message.knowledgeBase?.clientRequestId)
            .filter(Boolean) ?? [],
        serverOwned:
          activeConversation?.messages.filter(
            (message) => message.knowledgeBase?.serverOwned === true,
          ).length ?? 0,
      })}
    </output>
  );
}

function renderIntegratedChat() {
  return render(
    <ConversationProvider>
      <ConversationProbe />
      <ChatArea syncKnowledgeBaseSnapshot />
    </ConversationProvider>,
  );
}

function ProgressEventChat() {
  const [progress, setProgress] = React.useState(terminalProgress(1));
  React.useEffect(() => {
    const update = (event: Event) => {
      const next = (
        event as CustomEvent<{ progress?: ReturnType<typeof terminalProgress> }>
      ).detail?.progress;
      if (next) setProgress({ ...next });
    };
    window.addEventListener("frontmind:knowledge-progress-updated", update);
    return () =>
      window.removeEventListener(
        "frontmind:knowledge-progress-updated",
        update,
      );
  }, []);
  return (
    <ChatArea
      syncKnowledgeBaseSnapshot
      knowledgeBaseProgress={progress as any}
    />
  );
}

function addFiveFiles() {
  const files = Array.from(
    { length: 5 },
    (_, index) =>
      new File([`file-${index + 1}`], `资料-${index + 1}.pdf`, {
        type: "application/pdf",
        lastModified: index + 1,
      }),
  );
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files },
  });
  return files;
}

describe("ChatArea + ConversationProvider knowledge-base start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.startRequests = [];
    mocks.reserveRequests = [];
    mocks.stageRequests = [];
    mocks.firstStartResolve = null;
    mocks.secondStartResolve = null;
    mocks.reconcileCalls = 0;
    mocks.listRefetch.mockResolvedValue({
      data: [
        {
          id: "knowledge-conversation",
          title: "企业知识库构建",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    mocks.syncSnapshot.mockImplementation(async ({ conversation }) =>
      Promise.resolve(conversation),
    );
    mocks.deleteConversation.mockResolvedValue({ success: true });
    mocks.uploadFile.mockImplementation(
      async (file: File, _progress: unknown, _retry: unknown, options: any) => {
        const ordinal = Number(options.batchOrdinal);
        const fileId = `file-${ordinal}`;
        const uploadHandle = {
          fileId,
          filename: file.name,
          ticket: `ticket-${ordinal}`,
          expiresAt: 4_000_000_000_000,
        };
        await options.onFileRecord?.({
          fileId,
          filename: file.name,
          uploadHandle,
          reusedExistingFileId: false,
        });
        options.onStage?.({
          stage: "uploading",
          fileId,
          loadedBytes: file.size,
          totalBytes: file.size,
        });
        options.onStage?.({
          stage: "uploaded",
          fileId,
          loadedBytes: file.size,
          totalBytes: file.size,
        });
        return {
          fileId,
          filename: file.name,
          sizeBytes: file.size,
          uploadedAt: 10_000 + ordinal,
          providerReadyAt: 11_000 + ordinal,
          expiresAt: 20_000 + ordinal,
          replayed: false,
          recovered: false,
        };
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/knowledge-base/start/reserve") {
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          mocks.reserveRequests.push({ body });
          const clientRequestId = String(body.clientRequestId);
          return new Response(
            JSON.stringify({
              reservation: {
                state: "awaiting_attachments",
                turnId: "turn-start-1",
                clientRequestId,
                generation: 1,
                revision: 0,
                leafId: null,
                stagedAttachmentCount: 0,
                expectedAttachmentCount: 5,
                requiresUpload: true,
              },
              observation: acceptedObservation(clientRequestId),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/knowledge-base/turn/attachments/stage") {
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          mocks.stageRequests.push({ body });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "/api/knowledge-base/turn/dispatch") {
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          mocks.startRequests.push({ body });
          return deferredResponse(
            mocks.startRequests.length === 1 ? "first" : "second",
          );
        }
        if (url === "/api/knowledge-base/progress/reconcile") {
          mocks.reconcileCalls += 1;
          const requestId = String(
            mocks.startRequests.at(-1)?.body.clientRequestId,
          );
          return new Response(
            JSON.stringify({ observation: acceptedObservation(requestId) }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reserves before upload, scopes and stages N/N files, then dispatches one user request", async () => {
    renderIntegratedChat();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "构建企业知识库" }),
      ).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addFiveFiles();
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => expect(mocks.startRequests).toHaveLength(1));
    expect(
      screen.getByRole("dialog", { name: "构建企业知识库" }),
    ).toBeVisible();
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"messageCount":0',
    );
    expect(mocks.reserveRequests).toHaveLength(1);
    expect(mocks.stageRequests).toHaveLength(5);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(5);
    const clientRequestId = String(
      mocks.startRequests[0]?.body.clientRequestId,
    );
    const manifest = mocks.reserveRequests[0]!.body.attachmentManifest as Array<
      Record<string, unknown>
    >;
    expect(manifest).toHaveLength(5);
    expect(manifest.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(manifest.every((item) => item.total === 5)).toBe(true);
    for (const call of mocks.uploadFile.mock.calls) {
      expect(call[3]?.resumeScope).toEqual({
        kind: "knowledge_base",
        conversationId: "knowledge-conversation",
        turnId: "turn-start-1",
        clientRequestId,
      });
    }
    expect(mocks.stageRequests.map(({ body }) => body.index)).toEqual([
      0, 1, 2, 3, 4,
    ]);

    mocks.firstStartResolve?.(
      new Response(
        JSON.stringify({
          observation: acceptedObservation(clientRequestId),
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "构建企业知识库" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.startRequests).toHaveLength(1);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"messageCount":1',
    );
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"serverOwned":1',
    );
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      clientRequestId,
    );
  });

  it("accepts a durable reservation before a provider task id exists", async () => {
    let startCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/knowledge-base/start/reserve") {
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          const clientRequestId = String(body.clientRequestId);
          return new Response(
            JSON.stringify({
              reservation: {
                state: "awaiting_attachments",
                turnId: "turn-start-1",
                clientRequestId,
              },
              observation: acceptedObservation(clientRequestId),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/knowledge-base/turn/attachments/stage") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "/api/knowledge-base/turn/dispatch") {
          startCalls += 1;
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          mocks.startRequests.push({ body });
          return new Response(
            JSON.stringify({
              reservationCreated: true,
              observation: null,
              task: null,
            }),
            { status: 202, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/knowledge-base/progress/reconcile") {
          mocks.reconcileCalls += 1;
          const requestId = String(
            mocks.startRequests.at(-1)?.body.clientRequestId,
          );
          return new Response(
            JSON.stringify({ observation: acceptedObservation(requestId) }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    renderIntegratedChat();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "构建企业知识库" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addFiveFiles();
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "构建企业知识库" }),
      ).not.toBeInTheDocument(),
    );
    expect(startCalls).toBe(1);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"messageCount":1',
    );
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"serverOwned":1',
    );
  });

  it("accepts a bare dispatch task because the request was already reserved", async () => {
    renderIntegratedChat();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "构建企业知识库" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    addFiveFiles();
    fireEvent.click(screen.getByRole("button", { name: "开始构建" }));

    await waitFor(() => expect(mocks.startRequests).toHaveLength(1));
    mocks.firstStartResolve?.(
      new Response(
        JSON.stringify({
          task: { id: "unrelated-task", status: "running" },
          observation: null,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "构建企业知识库" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.uploadFile).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"messageCount":1',
    );
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"serverOwned":1',
    );
  });

  it("does not feed a terminal progress event back into reconcile", async () => {
    mocks.listRefetch.mockResolvedValue({
      data: [
        {
          id: "knowledge-conversation",
          title: "企业知识库构建",
          messages: [],
          status: "error",
          createdAt: 1,
          updatedAt: 1,
          knowledgeBase: {
            initialized: true,
            generation: 1,
            stateEpoch: 1,
            activeTurnId: null,
            activeClientRequestId: null,
            presentationTurnId: null,
            interactionState: "failed",
            canReply: false,
            presentationKey: null,
            revision: 0,
            leafId: null,
            notice: {
              errorKey: "build:turn:upstream-create-3",
              code: "UPSTREAM_CREATE_3",
              message: "上游已明确拒绝创建任务，当前附件均已保留。",
              severity: "error",
              retryable: false,
              failureClass: "requires_user_fix",
              recoveryAction: "contact_support",
              canRegenerate: false,
              traceId: "a0c7502e-4c1f-4d06-8ab6-407e8a82c138",
              attachmentCount: 7,
              turnId: "turn-failed",
            },
          },
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url !== "/api/knowledge-base/progress/reconcile") {
          throw new Error(`unexpected fetch ${url}`);
        }
        mocks.reconcileCalls += 1;
        return new Response(
          JSON.stringify({ observation: terminalObservation(2) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(
      <ConversationProvider>
        <ProgressEventChat />
      </ConversationProvider>,
    );

    await waitFor(() => expect(mocks.reconcileCalls).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mocks.reconcileCalls).toBe(1);
    expect(
      screen.getByTestId("knowledge-base-attachment-retention"),
    ).toHaveTextContent("7/7 个附件已保留，知识库任务未创建");
    expect(
      screen.getByTestId("knowledge-base-safe-diagnostic"),
    ).toHaveTextContent(
      "错误码：UPSTREAM_CREATE_3 · 排查编号：a0c7502e-4c1f-4d06-8ab6-407e8a82c138",
    );
    expect(
      screen.queryByText(/sk-secret|provider raw|filename\.pdf/i),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "新建知识库构建" }),
    ).toBeEnabled();
  });

  it("starts a fresh conversation without mutating the failed build", async () => {
    mocks.listRefetch.mockResolvedValue({
      data: [
        {
          id: "knowledge-conversation",
          title: "企业知识库构建",
          messages: [],
          status: "error",
          createdAt: 1,
          updatedAt: 1,
          knowledgeBase: {
            initialized: true,
            generation: 1,
            stateEpoch: 2,
            activeTurnId: null,
            activeClientRequestId: null,
            presentationTurnId: null,
            interactionState: "failed",
            canReply: false,
            presentationKey: null,
            revision: 0,
            leafId: null,
            notice: {
              errorKey: "build:turn:upstream-create-3",
              code: "UPSTREAM_CREATE_3",
              message: "上游已明确拒绝创建任务，当前附件均已保留。",
              severity: "error",
              retryable: false,
              failureClass: "requires_user_fix",
              recoveryAction: "contact_support",
              canRegenerate: false,
              traceId: "a0c7502e-4c1f-4d06-8ab6-407e8a82c138",
              attachmentCount: 7,
              turnId: "turn-failed",
            },
          },
        },
      ],
    });

    renderIntegratedChat();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "新建知识库构建" }),
      ).toBeEnabled(),
    );
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"activeId":"knowledge-conversation"',
    );
    expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
      '"conversationCount":1',
    );

    fireEvent.click(screen.getByRole("button", { name: "新建知识库构建" }));

    await waitFor(() =>
      expect(screen.getByTestId("conversation-probe")).toHaveTextContent(
        '"conversationCount":2',
      ),
    );
    expect(screen.getByTestId("conversation-probe")).not.toHaveTextContent(
      '"activeId":"knowledge-conversation"',
    );
    expect(
      screen.getByRole("button", { name: "构建企业知识库" }),
    ).toBeEnabled();
  });
});
