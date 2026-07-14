import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationProvider,
  LEGACY_CONVERSATION_STORAGE_KEY,
  prepareConversationForCloud,
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
  importLocal: vi.fn(),
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
      importLocal: {
        useMutation: () => ({ mutateAsync: mocks.importLocal }),
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
    mocks.importLocal.mockResolvedValue({ imported: 1, skipped: 0 });
    vi.mocked(localStorage.getItem).mockReturnValue(null);
  });

  it("hydrates from the database without rewriting the legacy local key", async () => {
    const { result } = renderHook(() => useConversation(), { wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([
      "account-1",
    ]);
    expect(localStorage.setItem).not.toHaveBeenCalled();
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

  it("imports legacy history only after an explicit call", async () => {
    const legacy = {
      conversations: [
        {
          ...conversation("legacy"),
          apiKeyFingerprint: "sk-secret-fingerprint",
          messages: [
            {
              id: "message",
              role: "user" as const,
              content: "hello",
              timestamp: 100,
              attachments: [
                {
                  id: "attachment",
                  type: "image" as const,
                  name: "image.png",
                  fileId: "file-1",
                  base64: "data:image/png;base64,secret",
                  blobUrl: "blob:secret",
                },
              ],
            },
          ],
        },
      ],
      activeConversationId: "legacy",
    };
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === LEGACY_CONVERSATION_STORAGE_KEY ? JSON.stringify(legacy) : null,
    );
    mocks.listRefetch
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [conversation("legacy")] });

    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.hasLegacyConversations).toBe(true);
    expect(mocks.importLocal).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.importLegacyConversations();
    });

    const uploaded = mocks.importLocal.mock.calls[0][0].conversations[0];
    expect(uploaded.apiKeyFingerprint).toBeUndefined();
    expect(uploaded.messages[0].attachments[0]).toEqual({
      id: "attachment",
      type: "image",
      name: "image.png",
      fileId: "file-1",
    });
    expect(localStorage.removeItem).toHaveBeenCalledWith(
      LEGACY_CONVERSATION_STORAGE_KEY,
    );
    expect(result.current.hasLegacyConversations).toBe(false);
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
