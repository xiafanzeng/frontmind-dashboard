import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resetRefetch: vi.fn(),
  knowledgeRefetch: vi.fn(),
  deliveryTicketCreate: vi.fn(),
  progressRefetch: vi.fn(),
  setProgressData: vi.fn(),
  createConversation: vi.fn(),
  setActive: vi.fn(),
  discardConversationLocally: vi.fn(),
  activeConversation: null as any,
  resetIsError: false,
  progressIsError: false,
  progressData: { progress: null } as any,
  knowledgeData: { snapshot: null } as any,
  resetStatus: {
    revision: 0,
    hasKnowledge: false,
    locked: false,
    canRequest: false,
    unavailableReason: "当前没有可重置的知识库记录",
    pending: null,
  } as any,
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { role: "user" } }),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    state: {
      conversations: mocks.activeConversation ? [mocks.activeConversation] : [],
    },
    activeConversation: mocks.activeConversation,
    hydrated: true,
    createConversation: mocks.createConversation,
    setActive: mocks.setActive,
    discardConversationLocally: mocks.discardConversationLocally,
  }),
}));
vi.mock("@/components/KnowledgeBaseViewer", () => ({
  default: () => <div>knowledge viewer</div>,
}));
vi.mock("@/components/KnowledgeBaseProgressPanel", () => ({
  default: () => null,
}));
vi.mock("@/pages/Home", () => ({
  default: () => null,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        knowledgeProgress: { setData: mocks.setProgressData },
      },
    }),
    workspace: {
      knowledgeProgress: {
        useQuery: () => ({
          data: mocks.progressData,
          isLoading: false,
          isError: mocks.progressIsError,
          refetch: mocks.progressRefetch,
        }),
      },
      knowledge: {
        useQuery: () => ({
          data: mocks.knowledgeData,
          isLoading: false,
          refetch: mocks.knowledgeRefetch,
        }),
      },
      deliveryTickets: {
        create: {
          useMutation: () => ({
            mutateAsync: mocks.deliveryTicketCreate,
            isPending: false,
          }),
        },
      },
      knowledgeReset: {
        status: {
          useQuery: () => ({
            data: mocks.resetStatus,
            isError: mocks.resetIsError,
            refetch: mocks.resetRefetch,
          }),
        },
        submit: {
          useMutation: () => ({
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
      },
    },
  },
}));

import EmbeddedKnowledgeBasePanel, {
  isKnowledgeBaseProgressProjectionOlder,
  knowledgeResetButtonLabel,
  shouldDiscardConversationAfterKnowledgeReset,
} from "./EmbeddedKnowledgeBasePanel";

beforeEach(() => {
  mocks.resetRefetch.mockReset().mockResolvedValue(undefined);
  mocks.knowledgeRefetch.mockReset().mockResolvedValue(undefined);
  mocks.deliveryTicketCreate.mockReset().mockResolvedValue(undefined);
  mocks.progressRefetch.mockReset().mockResolvedValue(undefined);
  mocks.setProgressData.mockReset();
  mocks.createConversation
    .mockReset()
    .mockReturnValue("knowledge-conversation");
  mocks.setActive.mockReset();
  mocks.discardConversationLocally.mockReset();
  mocks.resetIsError = false;
  mocks.progressIsError = false;
  mocks.progressData = { progress: null };
  mocks.knowledgeData = { snapshot: null };
  mocks.activeConversation = null;
  mocks.resetStatus = {
    revision: 0,
    hasKnowledge: false,
    locked: false,
    canRequest: false,
    unavailableReason: "当前没有可重置的知识库记录",
    pending: null,
  };
});

describe("knowledge-base progress projection ordering", () => {
  const progress = (input: {
    id?: string;
    revision: number;
    updatedAt: number;
  }) =>
    ({
      build: {
        id: input.id || "build-1",
        revision: input.revision,
        updatedAt: input.updatedAt,
      },
    }) as any;

  it("rejects an older revision or older replacement build", () => {
    const current = progress({ revision: 3, updatedAt: 300 });
    expect(
      isKnowledgeBaseProgressProjectionOlder(
        progress({ revision: 2, updatedAt: 400 }),
        current,
      ),
    ).toBe(true);
    expect(
      isKnowledgeBaseProgressProjectionOlder(
        progress({ id: "build-2", revision: 0, updatedAt: 200 }),
        current,
      ),
    ).toBe(true);
    expect(
      isKnowledgeBaseProgressProjectionOlder(
        progress({ revision: 4, updatedAt: 250 }),
        current,
      ),
    ).toBe(false);
  });
});

describe("EmbeddedKnowledgeBasePanel reset action", () => {
  it("uses the exact disabled label while no engineer is assigned", () => {
    expect(knowledgeResetButtonLabel({ locked: false, engineer: null })).toBe(
      "请等待分配AI 运维工程师",
    );
    expect(
      knowledgeResetButtonLabel({
        locked: false,
        engineer: { id: 9, name: "运维" },
      }),
    ).toBe("申请重置知识库");
    expect(knowledgeResetButtonLabel({ locked: true, engineer: null })).toBe(
      "重置申请审批中",
    );
  });
  it("does not mount the build flow before reset status is known", () => {
    mocks.resetStatus = undefined;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("正在确认知识库重置状态…")).toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("fails closed when reset status cannot be read", () => {
    mocks.resetStatus = undefined;
    mocks.resetIsError = true;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("知识库状态读取失败")).toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("fails closed when the latest build conversation cannot be read", () => {
    mocks.progressData = undefined;
    mocks.progressIsError = true;

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText("构建会话读取失败")).toBeInTheDocument();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("keeps reset on the build page only and refreshes it when build progress starts", () => {
    mocks.progressIsError = true;
    const { rerender } = render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    const resetButton = screen.getByRole("button", {
      name: "申请重置知识库",
    });
    expect(resetButton).toBeDisabled();
    expect(resetButton).toHaveAttribute("title", "当前没有可重置的知识库记录");

    rerender(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "申请重置知识库" })).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:knowledge-progress-updated"),
      );
    });
    expect(mocks.resetRefetch).toHaveBeenCalledTimes(1);
  });

  it("shows only maintenance and ZIP actions on the published display page", () => {
    mocks.knowledgeData = {
      snapshot: {
        id: "snapshot-1",
        sourceFileName: "企业知识库.zip",
        archiveHash: "a".repeat(64),
        archiveAvailable: true,
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "提交维护需求" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载成品 ZIP" })).toHaveAttribute(
      "href",
      "/api/dashboard/knowledge/snapshots/snapshot-1/archive",
    );
    expect(screen.queryByRole("button", { name: "申请重置知识库" })).toBeNull();
  });

  it("does not replace a completed build action with a maintenance ticket", () => {
    mocks.activeConversation = {
      id: "knowledge-conversation",
      status: "completed",
    };
    mocks.knowledgeData = {
      snapshot: {
        id: "snapshot-1",
        sourceFileName: "企业知识库.zip",
        archiveHash: null,
        archiveAvailable: false,
      },
    };
    mocks.progressData = {
      progress: {
        packageAllowed: true,
        build: {
          status: "published",
          conversationId: "knowledge-conversation",
        },
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: "提交维护需求" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "申请重置知识库" }),
    ).toBeInTheDocument();
  });

  it("uses a complete progress event without refetching the same projection", async () => {
    const progress = {
      build: {
        id: "build-1",
        conversationId: "knowledge-conversation",
        companyName: "FrontMind",
        status: "executing",
        revision: 0,
        currentLeafId: null,
        protocolError: null,
        updatedAt: 1,
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
    mocks.activeConversation = {
      id: "knowledge-conversation",
      title: "企业知识库构建",
      messages: [],
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.progressData = { progress };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(mocks.setActive).toHaveBeenCalledWith("knowledge-conversation"),
    );
    const nextProgress = {
      ...progress,
      build: { ...progress.build, updatedAt: 2 },
    };
    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:knowledge-progress-updated", {
          detail: {
            progress: nextProgress,
            generation: 1,
            stateEpoch: 2,
          },
        }),
      );
    });

    expect(mocks.setProgressData).toHaveBeenCalledWith(
      { conversationId: "knowledge-conversation" },
      expect.any(Function),
    );
    expect(mocks.progressRefetch).not.toHaveBeenCalled();
  });

  it("selects the fresh conversation requested by a failed-build rebuild action", async () => {
    mocks.activeConversation = {
      id: "knowledge-conversation",
      title: "企业知识库构建",
      messages: [],
      status: "error",
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.progressData = {
      progress: {
        build: {
          id: "failed-build",
          conversationId: "knowledge-conversation",
          revision: 0,
          updatedAt: 1,
        },
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(mocks.setActive).toHaveBeenCalledWith("knowledge-conversation"),
    );
    mocks.setActive.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:new-knowledge-base-build", {
          detail: { conversationId: "fresh-knowledge-conversation" },
        }),
      );
    });

    expect(mocks.setActive).toHaveBeenCalledWith(
      "fresh-knowledge-conversation",
    );
  });

  it("keeps the 100 percent update notice on one line", () => {
    mocks.activeConversation = {
      id: "knowledge-conversation",
      status: "completed",
    };
    mocks.progressData = {
      progress: {
        packageAllowed: true,
        build: {
          status: "ready_to_publish",
          conversationId: "knowledge-conversation",
        },
      },
    };

    render(
      <EmbeddedKnowledgeBasePanel
        page="build"
        onPageChange={() => undefined}
      />,
    );

    expect(screen.getByText(/知识库已达到\s+100%/)).toHaveClass(
      "whitespace-nowrap",
    );
  });

  it("discards established local KB state when first mounted after a completed reset", () => {
    expect(
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: null,
        revision: 2,
        hasKnowledge: false,
        conversation: {
          id: "reset-conversation",
          title: "企业知识库构建",
          messages: [
            {
              id: "server-turn",
              role: "user",
              content: "开始构建企业知识库",
              timestamp: 1,
              knowledgeBase: {
                kind: "pending_user",
                serverOwned: true,
                clientRequestId: "request-1",
              },
            },
          ],
          status: "awaiting_input",
          createdAt: 1,
          updatedAt: 2,
          knowledgeBase: {
            initialized: true,
            generation: 1,
            stateEpoch: 2,
            activeTurnId: null,
            activeClientRequestId: null,
            presentationTurnId: "turn-1",
            interactionState: "awaiting_input",
            canReply: true,
            presentationKey: "presentation-1",
            revision: 1,
            leafId: "1.1",
            notice: null,
          },
        },
      }),
    ).toBe(true);
  });

  it("keeps an initial reset pending until the stale scoped conversation appears", () => {
    mocks.resetStatus = {
      ...mocks.resetStatus,
      revision: 2,
      hasKnowledge: false,
    };
    const { rerender } = render(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );
    expect(mocks.discardConversationLocally).not.toHaveBeenCalled();

    mocks.activeConversation = {
      id: "stale-after-reset",
      title: "企业知识库构建",
      messages: [
        {
          id: "old-start",
          role: "user",
          content: "开始构建企业知识库",
          timestamp: 1,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId: "old-request",
            serverOwned: true,
          },
        },
      ],
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    };
    rerender(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );

    expect(mocks.discardConversationLocally).toHaveBeenCalledWith(
      "stale-after-reset",
    );
  });

  it("keeps a current or newly created blank KB conversation", () => {
    const blankConversation = {
      id: "new-conversation",
      title: "企业知识库构建",
      messages: [],
      status: "idle" as const,
      createdAt: 1,
      updatedAt: 1,
      knowledgeBase: {
        initialized: false,
        generation: 0,
        stateEpoch: 0,
        activeTurnId: null,
        activeClientRequestId: null,
        presentationTurnId: null,
        interactionState: "queued" as const,
        canReply: false,
        presentationKey: null,
        revision: null,
        leafId: null,
        notice: null,
      },
    };
    expect(
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: null,
        revision: 2,
        hasKnowledge: true,
        conversation: blankConversation,
      }),
    ).toBe(false);
    expect(
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: 1,
        revision: 2,
        hasKnowledge: false,
        conversation: blankConversation,
      }),
    ).toBe(false);
  });
});
