import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeBaseUserMessagePublicId } from "@shared/knowledge-base-message";
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
  listInput: vi.fn(),
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
        useQuery: (input: unknown) => {
          mocks.listInput(input);
          return { refetch: mocks.listRefetch };
        },
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

  it("collapses an optimistic request and its canonical server turn on first hydration", async () => {
    const canonicalId = knowledgeBaseUserMessagePublicId("turn-1");
    mocks.listRefetch.mockResolvedValueOnce({
      data: [
        {
          ...conversation("knowledge-base"),
          messages: [
            {
              id: "optimistic-request",
              role: "user",
              content: "确认",
              timestamp: 90,
              knowledgeBase: {
                kind: "pending_user",
                clientRequestId: "request-1",
                serverOwned: false,
              },
            },
            {
              id: canonicalId,
              role: "user",
              content: "确认",
              timestamp: 100,
              knowledgeBase: {
                kind: "pending_user",
                clientRequestId: "request-1",
                turnId: "turn-1",
                serverOwned: true,
              },
            },
          ],
        },
      ],
    });

    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.state.conversations[0]?.messages).toHaveLength(1);
    expect(result.current.state.conversations[0]?.messages[0]?.id).toBe(
      canonicalId,
    );
    expect(
      result.current.state.conversations[0]?.messages[0]?.knowledgeBase
        ?.serverOwned,
    ).toBe(true);
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

  it("scopes engineer conversation reads and writes to the project assignment", async () => {
    const projectWrapper = ({ children }: { children: React.ReactNode }) => (
      <ConversationProvider projectAssignmentId="project-assignment-1">
        {children}
      </ConversationProvider>
    );
    const { result } = renderHook(() => useConversation(), {
      wrapper: projectWrapper,
    });

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(mocks.listInput).toHaveBeenCalledWith({
      projectAssignmentId: "project-assignment-1",
    });

    act(() => {
      result.current.createConversation();
    });
    await waitFor(() =>
      expect(mocks.syncSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectAssignmentId: "project-assignment-1",
          conversation: expect.any(Object),
        }),
      ),
    );
  });

  it("does not delete or overwrite a hydrated server-owned KB turn", async () => {
    const protectedConversation: Conversation = {
      ...conversation("knowledge-base"),
      status: "awaiting_input",
      messages: [
        {
          id: "turn-1",
          role: "user",
          content: "确认",
          timestamp: 100,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId: "request-1",
            turnId: "turn-1",
            serverOwned: true,
          },
        },
        {
          id: "presentation-1",
          role: "assistant",
          content: "## 1.2\n已批准正文",
          timestamp: 110,
          knowledgeBase: {
            kind: "presentation",
            turnId: "turn-1",
            presentationKey: "presentation-1",
            generation: 1,
            revision: 1,
            leafId: "1.2",
            serverOwned: true,
          },
        },
      ],
    };
    mocks.listRefetch.mockResolvedValueOnce({
      data: [protectedConversation],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.deleteMessage("knowledge-base", "presentation-1");
      result.current.updateAssistantMessages("knowledge-base", [
        {
          id: "stale-raw-output",
          role: "assistant",
          content: "旧上游投影",
          timestamp: 120,
        },
      ]);
      result.current.deleteConversation("knowledge-base");
    });

    const current = result.current.state.conversations.find(
      (item) => item.id === "knowledge-base",
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      "turn-1",
      "presentation-1",
    ]);
    expect(current?.deletedMessageIds ?? []).not.toContain("presentation-1");
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
  });
});

describe("prepareConversationForCloud", () => {
  it("self-heals reused assistant and attachment IDs before cloud sync", () => {
    const clean = prepareConversationForCloud({
      ...conversation("duplicate-output"),
      messages: [
        {
          id: "confirm-1",
          role: "user",
          content: "确认",
          timestamp: 1,
        },
        {
          id: "provider-output",
          upstreamOutputId: "provider-output",
          role: "assistant",
          content: "节点 2.3",
          timestamp: 2,
          attachments: [
            { id: "asset", type: "image", name: "one.webp", fileId: "one" },
          ],
        },
        {
          id: "confirm-2",
          role: "user",
          content: "确认",
          timestamp: 3,
        },
        {
          id: "provider-output",
          upstreamOutputId: "provider-output",
          role: "assistant",
          content: "节点 2.4",
          timestamp: 4,
          attachments: [
            { id: "asset", type: "image", name: "two.webp", fileId: "two" },
          ],
        },
      ],
    });

    expect(clean.messages.map((item) => item.id)).toEqual([
      "confirm-1",
      "provider-output",
      "confirm-2",
      "provider-output~2",
    ]);
    expect(
      clean.messages
        .flatMap((item) => item.attachments ?? [])
        .map((item) => item.id),
    ).toEqual(["asset", "asset~2"]);
  });

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

  it("keeps KB provenance and removes tombstones targeting server-owned messages", () => {
    const clean = prepareConversationForCloud({
      ...conversation("knowledge-base-metadata"),
      deletedMessageIds: ["presentation-1", "ordinary-deleted"],
      messages: [
        {
          id: "presentation-1",
          role: "assistant",
          content: "## 1.2\n已批准正文",
          timestamp: 10,
          knowledgeBase: {
            kind: "presentation",
            turnId: "turn-1",
            presentationKey: "presentation-1",
            generation: 1,
            revision: 1,
            leafId: "1.2",
            serverOwned: true,
          },
        },
      ],
    });

    expect(clean.messages[0]?.knowledgeBase).toMatchObject({
      presentationKey: "presentation-1",
      serverOwned: true,
    });
    expect(clean.deletedMessageIds).toEqual(["ordinary-deleted"]);
  });
});

describe("parseOutputMessages file IDs", () => {
  it.each([
    {
      type: "output_message",
      content: [{ type: "output_text", text: "output_message 正文" }],
      expected: "output_message 正文",
    },
    {
      type: "output_text",
      text: "top-level text 正文",
      expected: "top-level text 正文",
    },
    {
      type: "text",
      output_text: { value: "top-level output_text 正文" },
      expected: "top-level output_text 正文",
    },
    {
      type: "output_message",
      content: [
        {
          type: "output_text",
          output_text: { value: "nested output_text 正文" },
        },
      ],
      expected: "nested output_text 正文",
    },
  ])("renders typed assistant $type records as messages", (record) => {
    const messages = parseOutputMessages([
      {
        id: `assistant-${record.type}`,
        role: "assistant",
        ...record,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      upstreamOutputId: `assistant-${record.type}`,
      role: "assistant",
      content: record.expected,
    });
  });

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

  it("renders image_url content and top-level output images without MIME metadata", () => {
    const messages = parseOutputMessages([
      {
        id: "assistant-image-url",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_image",
            image_url: "https://files.example.test/leaf-hero.webp",
            filename: "leaf-hero.webp",
          },
        ],
      },
      {
        id: "standalone-image",
        type: "output_image",
        imageUrl: "/v1/files/asset%202",
        name: "asset-2.png",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      upstreamOutputId: "assistant-image-url",
      inlineImages: [
        {
          src: expect.stringContaining("/api/frontmind/proxy-download?url="),
          alt: "leaf-hero.webp",
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      upstreamOutputId: "standalone-image",
      inlineImages: [
        {
          src: "/api/frontmind/v1/files/asset%202",
          alt: "asset-2.png",
        },
      ],
    });
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

  it("shows only the node body when the model appends references and protocol data", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        [
          "## 中文名称、英文品牌与视觉识别",
          "",
          "硅基流动的英文品牌名称为 SiliconFlow。",
          "",
          "**参考资料**",
          "[1] https://siliconflow.cn/",
          '<!-- FRONTMIND_KB_PROGRESS {"revision":0} -->',
        ].join("\n"),
      ),
    ).toBe(
      [
        "## 中文名称、英文品牌与视觉识别",
        "",
        "硅基流动的英文品牌名称为 SiliconFlow。",
      ].join("\n"),
    );
  });

  it("removes bare knowledge-base protocol objects from customer markdown", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        [
          "## 企业定位",
          "",
          "硅基流动是 AI 基础设施平台。",
          "",
          JSON.stringify({
            kind: "frontmind.knowledge-base.presentation",
            revision: 1,
            leafId: "1.1",
          }),
          JSON.stringify({
            kind: "frontmind.workflow-state",
            currentLeafId: "1.1",
          }),
        ].join("\n"),
      ),
    ).toBe("## 企业定位\n\n硅基流动是 AI 基础设施平台。");
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
