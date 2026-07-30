import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationProvider,
  parseOutputMessages,
  prepareConversationForCloud,
  sanitizeKnowledgeBaseCustomerMarkdown,
  sanitizeKnowledgeBaseOutputMessages,
  useConversation,
  type Conversation,
} from "./ConversationContext";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: 1 },
    loading: false,
  } as { user: { id: number } | null; loading: boolean },
  listRefetch: vi.fn(),
  syncSnapshot: vi.fn(),
  deleteConversation: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => mocks.auth,
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
  },
}));

function conversation(id: string): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [],
    status: "idle",
    createdAt: 100,
    updatedAt: 200,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <ConversationProvider>{children}</ConversationProvider>;
}

describe("ConversationProvider cloud hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: 1 };
    mocks.auth.loading = false;
    mocks.listRefetch.mockResolvedValue({ data: [conversation("account-1")] });
    mocks.syncSnapshot.mockResolvedValue(conversation("synced"));
    mocks.deleteConversation.mockResolvedValue({ success: true });
  });

  it("hydrates conversations from the database", async () => {
    const { result } = renderHook(() => useConversation(), { wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([
      "account-1",
    ]);
  });

  it("clears conversations immediately when the user logs out", async () => {
    const { result, rerender } = renderHook(() => useConversation(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    mocks.auth.user = null;
    rerender();

    await waitFor(() => expect(result.current.hydrated).toBe(false));
    expect(result.current.state.conversations).toEqual([]);
    expect(result.current.activeConversation).toBeNull();
  });

  it("does not expose the previous account while a new account hydrates", async () => {
    const { result, rerender } = renderHook(() => useConversation(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    let resolveSecondAccount:
      | ((value: { data: Conversation[] }) => void)
      | undefined;
    mocks.listRefetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecondAccount = resolve;
      }),
    );
    mocks.auth.user = { id: 2 };
    rerender();

    await waitFor(() => expect(result.current.hydrated).toBe(false));
    expect(result.current.state.conversations).toEqual([]);

    resolveSecondAccount?.({ data: [conversation("account-2")] });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([
      "account-2",
    ]);
  });
});

describe("prepareConversationForCloud", () => {
  it("removes browser-only payloads and keeps file metadata", () => {
    const clean = prepareConversationForCloud({
      ...conversation("one"),
      apiKeyFingerprint: "fingerprint",
      messages: [
        {
          id: "message",
          role: "assistant",
          content: "result",
          timestamp: 1,
          attachments: [
            {
              id: "file",
              type: "file",
              name: "report.pdf",
              fileId: "upstream-file",
              base64: "secret",
              blobUrl: "blob:secret",
              file: new File(["secret"], "report.pdf"),
            },
          ],
          inlineImages: [
            { src: "data:image/png;base64,secret" },
            { src: "/api/frontmind/v1/files/image" },
          ],
        },
      ],
    });

    expect(clean.apiKeyFingerprint).toBeUndefined();
    expect(clean.messages[0].attachments).toEqual([
      {
        id: "file",
        type: "file",
        name: "report.pdf",
        fileId: "upstream-file",
      },
    ]);
    expect(clean.messages[0].inlineImages).toEqual([
      { src: "/api/frontmind/v1/files/image" },
    ]);
  });
});

describe("parseOutputMessages file IDs", () => {
  it("renders snake-case PDF and camel-case image IDs through protected URLs", () => {
    const messages = parseOutputMessages([
      {
        id: "assistant-files",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_file",
            file_id: "file/pdf 1",
            file_name: "report.pdf",
            mime_type: "application/pdf",
          },
          {
            type: "output_image",
            fileId: "image/图 1",
            fileName: "chart.png",
            mimeType: "image/png",
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].outputFiles).toEqual([
      {
        fileUrl: "/api/frontmind/v1/files/file%2Fpdf%201",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);
    expect(messages[0].inlineImages).toEqual([
      {
        src: "/api/frontmind/v1/files/image%2F%E5%9B%BE%201",
        alt: "chart.png",
      },
    ]);
  });
});

describe("knowledge-base image delivery boundary", () => {
  const blockedHotlink =
    "https://omo-oss-image.thefastimg.com/portal-saas/example/cms/image/example.jpg";

  it("replaces only the retired collection-status sentence", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        "FrontMind 正在按业务分支进行广度优先、深度受控的资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。\n\n正文保留广度与深度。",
      ),
    ).toBe(
      "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。\n\n正文保留广度与深度。",
    );
  });

  it("removes remote hotlinks from customer markdown while retaining the caption", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        `产品如下：\n\n![产品界面](${blockedHotlink})\n\n原图：${blockedHotlink}`,
      ),
    ).toBe("产品如下：\n\n配图：产品界面\n\n原图：");
  });

  it("keeps only controlled image sources in knowledge-base messages", () => {
    const [message] = sanitizeKnowledgeBaseOutputMessages([
      {
        id: "knowledge-images",
        role: "assistant",
        content: `![官网热链](${blockedHotlink})`,
        timestamp: 1,
        inlineImages: [
          { src: blockedHotlink, alt: "hotlink" },
          {
            src: "/api/frontmind/v1/files/image-id",
            alt: "managed output",
          },
          {
            src: "/api/dashboard/knowledge/assets/snapshot/logo.webp",
            alt: "packaged asset",
          },
        ],
      },
    ]);

    expect(message.content).toBe("配图：官网热链");
    expect(message.inlineImages).toEqual([
      {
        src: "/api/frontmind/v1/files/image-id",
        alt: "managed output",
      },
      {
        src: "/api/dashboard/knowledge/assets/snapshot/logo.webp",
        alt: "packaged asset",
      },
    ]);
  });
});
