import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resetRefetch: vi.fn(),
  knowledgeRefetch: vi.fn(),
  discardConversationLocally: vi.fn(),
  activeConversation: null as any,
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
    activeConversation: mocks.activeConversation,
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
    workspace: {
      knowledge: {
        useQuery: () => ({
          data: { snapshot: null },
          isLoading: false,
          refetch: mocks.knowledgeRefetch,
        }),
      },
      knowledgeReset: {
        status: {
          useQuery: () => ({
            data: mocks.resetStatus,
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
  shouldDiscardConversationAfterKnowledgeReset,
} from "./EmbeddedKnowledgeBasePanel";

beforeEach(() => {
  mocks.resetRefetch.mockReset().mockResolvedValue(undefined);
  mocks.knowledgeRefetch.mockReset().mockResolvedValue(undefined);
  mocks.discardConversationLocally.mockReset();
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

describe("EmbeddedKnowledgeBasePanel reset action", () => {
  it("keeps the reset action visible before completion and refreshes it when build progress starts", () => {
    render(
      <EmbeddedKnowledgeBasePanel
        page="display"
        onPageChange={() => undefined}
      />,
    );

    const resetButton = screen.getByRole("button", {
      name: "申请重置知识库",
    });
    expect(resetButton).toBeDisabled();
    expect(resetButton).toHaveAttribute("title", "当前没有可重置的知识库记录");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:knowledge-progress-updated"),
      );
    });
    expect(mocks.resetRefetch).toHaveBeenCalledTimes(1);
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
