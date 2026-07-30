import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resetRefetch: vi.fn(),
  knowledgeRefetch: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { role: "user" } }),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    activeConversation: null,
    discardConversationLocally: vi.fn(),
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
            data: {
              revision: 0,
              hasKnowledge: false,
              locked: false,
              canRequest: false,
              unavailableReason: "当前没有可重置的知识库记录",
              pending: null,
            },
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

import EmbeddedKnowledgeBasePanel from "./EmbeddedKnowledgeBasePanel";

beforeEach(() => {
  mocks.resetRefetch.mockReset().mockResolvedValue(undefined);
  mocks.knowledgeRefetch.mockReset().mockResolvedValue(undefined);
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
});
