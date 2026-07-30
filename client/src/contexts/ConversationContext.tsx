import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  ConversationSyncQueue,
  getErrorMessage,
} from "@/lib/conversation-sync";
import { trpc } from "@/lib/trpc";
import {
  sanitizeBrandText,
  type TaskResponse,
  type OutputMessage,
} from "@/lib/frontmind-api";

// Types for local conversation management
export interface Attachment {
  id: string;
  type: "file" | "image";
  name: string;
  fileId?: string; // from FrontMind Files API
  base64?: string; // for image/small file preview (data URL)
  blobUrl?: string; // in-memory blob URL for large files (not persisted to localStorage)
  file?: File;
}

/**
 * Represents a single intermediate step (e.g., search, browse, code execution)
 */
export interface IntermediateStep {
  id: string;
  type: string; // "web_search_call" | "computer_call" | "code_interpreter_call" | "function_call" | "reasoning" | etc.
  label: string; // Human-readable label for display
  description?: string; // Optional description/summary text
  details?: string; // Additional details (e.g., search query, URL, code)
}

/**
 * A group of intermediate steps under a common phase/title
 */
export interface StepGroup {
  id: string;
  title: string; // Group title (e.g., "搜集华为最新动态与数据")
  steps: IntermediateStep[];
  description?: string; // Optional description text between steps
}

export interface LocalMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  timestamp: number;
  outputFiles?: { fileUrl: string; fileName: string; mimeType: string }[];
  /** Inline base64 images embedded in assistant text (for display in MarkdownRenderer) */
  inlineImages?: { src: string; alt?: string }[];
  /** Per-response elapsed time in seconds (set when the response completes) */
  elapsedTime?: number;
  /** Timestamp when this response started being processed */
  responseStartedAt?: number;
  /** Intermediate steps (search, browse, code, reasoning) shown before this message */
  intermediateSteps?: IntermediateStep[];
  /** Grouped intermediate steps for display */
  stepGroups?: StepGroup[];
  /** Whether this is a steps-only placeholder (no text content yet) */
  isStepsPlaceholder?: boolean;
  /** The public model profile used for this message (e.g. "frontmind-lite") */
  modelName?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: LocalMessage[];
  taskId?: string; // Upstream task ID
  previousResponseId?: string;
  status:
    | "idle"
    | "running"
    | "pending"
    | "awaiting_input"
    | "completed"
    | "error"
    | "failed";
  taskUrl?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number; // Task start timestamp
  completedAt?: number; // Task completion timestamp
  /**
   * Bug 3 fix: Track the total number of output items from the API after each
   * turn completes. Since the FrontMind API returns the SAME response ID for
   * multi-turn conversations and accumulates output items, this lets us
   * slice only new items on the next turn: output.slice(lastKnownOutputLength).
   */
  lastKnownOutputLength?: number;
  /** IDs of messages that were manually deleted by the user (to prevent re-appearing from polling) */
  deletedMessageIds?: string[];
  /**
   * Fingerprint of the API key that created this conversation.
   * Used to prevent cross-key task continuation.
   * Format: "sk-a...b1c2" (first 4 + last 4 chars of the key).
   */
  apiKeyFingerprint?: string;
}

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
}

type Action =
  | { type: "NEW_CONVERSATION"; payload: Conversation }
  | { type: "SET_ACTIVE"; payload: string }
  | {
      type: "ADD_MESSAGE";
      payload: { conversationId: string; message: LocalMessage };
    }
  | {
      type: "UPDATE_STATUS";
      payload: {
        conversationId: string;
        status: Conversation["status"];
        taskId?: string;
        taskUrl?: string;
        previousResponseId?: string;
        startedAt?: number;
        completedAt?: number;
        lastKnownOutputLength?: number;
      };
    }
  | {
      type: "UPDATE_ASSISTANT_MESSAGES";
      payload: { conversationId: string; messages: LocalMessage[] };
    }
  | { type: "UPDATE_TITLE"; payload: { conversationId: string; title: string } }
  | { type: "DELETE_CONVERSATION"; payload: string }
  | {
      type: "DELETE_MESSAGE";
      payload: { conversationId: string; messageId: string };
    }
  | { type: "LOAD_STATE"; payload: ConversationState };

function conversationReducer(
  state: ConversationState,
  action: Action,
): ConversationState {
  switch (action.type) {
    case "NEW_CONVERSATION": {
      return {
        ...state,
        conversations: [action.payload, ...state.conversations],
        activeConversationId: action.payload.id,
      };
    }
    case "SET_ACTIVE": {
      return { ...state, activeConversationId: action.payload };
    }
    case "ADD_MESSAGE": {
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? {
                ...c,
                messages: [...c.messages, action.payload.message],
                updatedAt: Date.now(),
              }
            : c,
        ),
      };
    }
    case "UPDATE_STATUS": {
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? {
                ...c,
                status: action.payload.status,
                taskId: action.payload.taskId ?? c.taskId,
                taskUrl: action.payload.taskUrl ?? c.taskUrl,
                previousResponseId:
                  action.payload.previousResponseId ?? c.previousResponseId,
                startedAt: action.payload.startedAt ?? c.startedAt,
                completedAt:
                  action.payload.completedAt !== undefined
                    ? action.payload.completedAt
                    : (action.payload.status === "running" ||
                          action.payload.status === "pending") &&
                        action.payload.startedAt !== undefined
                      ? undefined
                      : c.completedAt,
                lastKnownOutputLength:
                  action.payload.lastKnownOutputLength ??
                  c.lastKnownOutputLength,
                updatedAt: Date.now(),
              }
            : c,
        ),
      };
    }
    case "UPDATE_ASSISTANT_MESSAGES": {
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== action.payload.conversationId) return c;

          // Find the index of the last user message.
          // All assistant messages after it belong to the current turn and will be
          // REPLACED by the incoming (authoritative) set from parseOutputMessages.
          const messages = [...c.messages];
          let lastUserIdx = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }

          // Keep everything up to and including the last user message
          const kept = messages.slice(0, lastUserIdx + 1);

          // Only filter out messages that were manually deleted by the user
          const deletedIds = new Set(c.deletedMessageIds || []);

          // Deduplicate incoming messages against HISTORICAL messages only
          // (messages from previous turns, i.e. before the last user message).
          // This prevents old turn messages from re-appearing in multi-turn.
          // We only check by ID — content dedup is removed because it was too
          // aggressive and caused legitimate new messages to be silently dropped.
          const historicalIds = new Set(kept.map((m) => m.id));

          const newMessages = action.payload.messages.filter((m) => {
            // Skip messages that were manually deleted
            if (m.id && deletedIds.has(m.id)) return false;
            // Steps placeholders always pass through (they get replaced each poll)
            if (m.isStepsPlaceholder) return true;
            // Skip if this exact ID already exists in historical messages
            if (m.id && historicalIds.has(m.id)) return false;
            return true;
          });

          // Replace trailing assistant messages with the new authoritative set
          return {
            ...c,
            messages: [...kept, ...newMessages],
            updatedAt: Date.now(),
          };
        }),
      };
    }
    case "UPDATE_TITLE": {
      // Safety net: always truncate title to 10 chars + ellipsis
      const rawTitle = action.payload.title || "新内容流程";
      const safeTitle =
        rawTitle.length > 10 ? rawTitle.slice(0, 10) + "..." : rawTitle;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? { ...c, title: safeTitle, updatedAt: Date.now() }
            : c,
        ),
      };
    }
    case "DELETE_MESSAGE": {
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? {
                ...c,
                messages: c.messages.filter(
                  (m) => m.id !== action.payload.messageId,
                ),
                deletedMessageIds: [
                  ...(c.deletedMessageIds || []),
                  action.payload.messageId,
                ],
                updatedAt: Date.now(),
              }
            : c,
        ),
      };
    }
    case "DELETE_CONVERSATION": {
      const remaining = state.conversations.filter(
        (c) => c.id !== action.payload,
      );
      return {
        ...state,
        conversations: remaining,
        activeConversationId:
          state.activeConversationId === action.payload
            ? (remaining[0]?.id ?? null)
            : state.activeConversationId,
      };
    }
    case "LOAD_STATE": {
      return action.payload;
    }
    default:
      return state;
  }
}

const EMPTY_STATE: ConversationState = {
  conversations: [],
  activeConversationId: null,
};

function getTrpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : undefined;
}

/**
 * Convert an optimistic browser conversation into the JSON snapshot accepted by
 * the server. Browser-only File/blob/base64 values and the legacy API-key
 * fingerprint are deliberately excluded from cloud persistence.
 */
export function prepareConversationForCloud(
  conversation: Conversation,
): Conversation {
  const { apiKeyFingerprint: _legacyFingerprint, ...cloudConversation } =
    conversation;

  return {
    ...cloudConversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => {
        const {
          file: _file,
          blobUrl: _blobUrl,
          base64: _base64,
          ...metadata
        } = attachment;
        return metadata;
      }),
      inlineImages: message.inlineImages?.filter(
        (image) =>
          !image.src.startsWith("data:") && !image.src.startsWith("blob:"),
      ),
    })),
  };
}

function normalizeConversation(conversation: Conversation): Conversation {
  const toTimestamp = (value: unknown, fallback: number) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = new Date(value as string | Date).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const now = Date.now();
  const createdAt = toTimestamp(conversation.createdAt, now);

  return {
    ...conversation,
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.map((message) => ({
          ...message,
          timestamp: toTimestamp(message.timestamp, createdAt),
        }))
      : [],
    createdAt,
    updatedAt: toTimestamp(conversation.updatedAt, createdAt),
    startedAt:
      conversation.startedAt === undefined
        ? undefined
        : toTimestamp(conversation.startedAt, createdAt),
    completedAt:
      conversation.completedAt === undefined
        ? undefined
        : toTimestamp(conversation.completedAt, createdAt),
  };
}

interface ConversationMutation<TInput, TOutput> {
  mutateAsync: (input: TInput) => Promise<TOutput>;
}

interface ConversationTrpcHooks {
  list: {
    useQuery: (
      input: undefined,
      options: {
        enabled: boolean;
        retry: boolean;
        refetchOnWindowFocus: boolean;
      },
    ) => {
      refetch: () => Promise<{
        data?: Conversation[];
        error?: unknown;
      }>;
    };
  };
  syncSnapshot: {
    useMutation: () => ConversationMutation<
      { conversation: Conversation },
      Conversation
    >;
  };
  delete: {
    useMutation: () => ConversationMutation<{ id: string }, { success: true }>;
  };
}

interface ConversationContextType {
  state: ConversationState;
  activeConversation: Conversation | null;
  loading: boolean;
  hydrated: boolean;
  syncError: string | null;
  createConversation: () => string;
  setActive: (id: string) => void;
  addMessage: (conversationId: string, message: LocalMessage) => void;
  updateStatus: (
    conversationId: string,
    status: Conversation["status"],
    extra?: {
      taskId?: string;
      taskUrl?: string;
      previousResponseId?: string;
      startedAt?: number;
      completedAt?: number;
      lastKnownOutputLength?: number;
    },
  ) => void;
  updateAssistantMessages: (
    conversationId: string,
    messages: LocalMessage[],
  ) => void;
  updateTitle: (conversationId: string, title: string) => void;
  deleteConversation: (id: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  refreshConversations: () => Promise<void>;
  clearSyncError: () => void;
}

const ConversationContext = createContext<ConversationContextType | null>(null);

export function ConversationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = useAuth();
  const authenticatedUser = auth.user as { id: number } | null;
  const userId = authenticatedUser?.id ?? null;
  const conversationApi = (
    trpc as unknown as { conversation: ConversationTrpcHooks }
  ).conversation;
  const listQuery = conversationApi.list.useQuery(undefined, {
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const syncSnapshotMutation = conversationApi.syncSnapshot.useMutation();
  const deleteMutation = conversationApi.delete.useMutation();

  const [state, dispatch] = useReducer(conversationReducer, EMPTY_STATE);
  const stateRef = useRef(state);
  const [hydrated, setHydrated] = useState(false);
  const [hydrationLoading, setHydrationLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const accountIdRef = useRef<number | null>(null);
  const hydrationGenerationRef = useRef(0);
  const canSyncRef = useRef(false);
  const listRefetchRef = useRef(listQuery.refetch);
  const syncSnapshotRef = useRef(syncSnapshotMutation.mutateAsync);
  const deleteRemoteRef = useRef(deleteMutation.mutateAsync);

  listRefetchRef.current = listQuery.refetch;
  syncSnapshotRef.current = syncSnapshotMutation.mutateAsync;
  deleteRemoteRef.current = deleteMutation.mutateAsync;

  const syncQueueRef = useRef<ConversationSyncQueue<Conversation> | null>(null);
  if (!syncQueueRef.current) {
    syncQueueRef.current = new ConversationSyncQueue<Conversation>({
      syncSnapshot: (conversation) => syncSnapshotRef.current({ conversation }),
      deleteConversation: (id) => deleteRemoteRef.current({ id }),
      onError: (error) => setSyncError(getErrorMessage(error)),
      onSuccess: () => setSyncError(null),
      shouldRetry: (error) => {
        const code = getTrpcErrorCode(error);
        return ![
          "BAD_REQUEST",
          "CONFLICT",
          "FORBIDDEN",
          "NOT_FOUND",
          "PRECONDITION_FAILED",
          "UNAUTHORIZED",
        ].includes(code ?? "");
      },
      onPermanentError: (error, operation) => {
        if (
          getTrpcErrorCode(error) === "NOT_FOUND" &&
          operation.kind === "snapshot"
        ) {
          const nextState = conversationReducer(stateRef.current, {
            type: "DELETE_CONVERSATION",
            payload: operation.conversation.id,
          });
          stateRef.current = nextState;
          dispatch({ type: "LOAD_STATE", payload: nextState });
          setSyncError(null);
        }
      },
      debounceMs: 50,
    });
  }

  const replaceState = useCallback((nextState: ConversationState) => {
    stateRef.current = nextState;
    dispatch({ type: "LOAD_STATE", payload: nextState });
  }, []);

  const commit = useCallback(
    (action: Action, conversationIdsToSync: string[] = []) => {
      const nextState = conversationReducer(stateRef.current, action);
      replaceState(nextState);

      if (!canSyncRef.current) return;
      for (const conversationId of conversationIdsToSync) {
        const conversation = nextState.conversations.find(
          (candidate) => candidate.id === conversationId,
        );
        if (conversation) {
          syncQueueRef.current!.enqueueSnapshot(
            prepareConversationForCloud(conversation),
          );
        }
      }
    },
    [replaceState],
  );

  const hydrateForUser = useCallback(
    async (expectedUserId: number, initial: boolean) => {
      const generation = ++hydrationGenerationRef.current;
      if (initial) {
        setHydrated(false);
        setHydrationLoading(true);
      }

      try {
        const result = await listRefetchRef.current();
        if (result.error) throw result.error;
        if (
          accountIdRef.current !== expectedUserId ||
          hydrationGenerationRef.current !== generation
        ) {
          return;
        }

        const remoteConversations = (result.data ?? []).map(
          normalizeConversation,
        );
        // The workspace is already visible while its first conversation query
        // is in flight. Preserve brand-new local conversations created during
        // that short window, then persist them once hydration succeeds.
        const remoteIds = new Set(
          remoteConversations.map((conversation) => conversation.id),
        );
        const optimisticConversations = initial
          ? stateRef.current.conversations.filter(
              (conversation) => !remoteIds.has(conversation.id),
            )
          : [];
        const conversations = [
          ...optimisticConversations,
          ...remoteConversations,
        ];
        const previousActiveId = stateRef.current.activeConversationId;
        const activeConversationId = conversations.some(
          (conversation) => conversation.id === previousActiveId,
        )
          ? previousActiveId
          : (conversations[0]?.id ?? null);
        replaceState({ conversations, activeConversationId });
        setSyncError(null);
        setHydrated(true);
        canSyncRef.current = true;
        for (const conversation of optimisticConversations) {
          syncQueueRef.current!.enqueueSnapshot(
            prepareConversationForCloud(conversation),
            true,
          );
        }
      } catch (error: unknown) {
        if (
          accountIdRef.current === expectedUserId &&
          hydrationGenerationRef.current === generation
        ) {
          setSyncError(getErrorMessage(error));
          if (initial) setHydrated(false);
        }
      } finally {
        if (
          accountIdRef.current === expectedUserId &&
          hydrationGenerationRef.current === generation
        ) {
          setHydrationLoading(false);
        }
      }
    },
    [replaceState],
  );

  useEffect(() => {
    if (auth.loading) return;

    hydrationGenerationRef.current += 1;
    syncQueueRef.current!.reset();
    canSyncRef.current = false;
    accountIdRef.current = userId;
    replaceState(EMPTY_STATE);
    setSyncError(null);

    if (userId === null) {
      setHydrated(false);
      setHydrationLoading(false);
      return;
    }

    setHydrationLoading(true);
    void hydrateForUser(userId, true);
  }, [auth.loading, hydrateForUser, replaceState, userId]);

  useEffect(() => {
    canSyncRef.current = hydrated && userId !== null;
  }, [hydrated, userId]);

  const createConversation = useCallback(() => {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conversation: Conversation = {
      id,
      title: "新内容流程",
      messages: [],
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const nextState = conversationReducer(stateRef.current, {
      type: "NEW_CONVERSATION",
      payload: conversation,
    });
    replaceState(nextState);
    if (canSyncRef.current) {
      syncQueueRef.current!.enqueueSnapshot(
        prepareConversationForCloud(conversation),
        true,
      );
    }
    return id;
  }, [replaceState]);

  const setActive = useCallback(
    (id: string) => {
      commit({ type: "SET_ACTIVE", payload: id });
    },
    [commit],
  );

  const addMessage = useCallback(
    (conversationId: string, message: LocalMessage) => {
      commit({ type: "ADD_MESSAGE", payload: { conversationId, message } }, [
        conversationId,
      ]);
    },
    [commit],
  );

  const updateStatus = useCallback(
    (
      conversationId: string,
      status: Conversation["status"],
      extra?: {
        taskId?: string;
        taskUrl?: string;
        previousResponseId?: string;
        startedAt?: number;
        completedAt?: number;
        lastKnownOutputLength?: number;
      },
    ) => {
      commit(
        {
          type: "UPDATE_STATUS",
          payload: { conversationId, status, ...extra },
        },
        [conversationId],
      );
    },
    [commit],
  );

  const updateAssistantMessages = useCallback(
    (conversationId: string, messages: LocalMessage[]) => {
      commit(
        {
          type: "UPDATE_ASSISTANT_MESSAGES",
          payload: { conversationId, messages },
        },
        [conversationId],
      );
    },
    [commit],
  );

  const updateTitle = useCallback(
    (conversationId: string, title: string) => {
      commit({ type: "UPDATE_TITLE", payload: { conversationId, title } }, [
        conversationId,
      ]);
    },
    [commit],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      commit({ type: "DELETE_CONVERSATION", payload: id });
      if (canSyncRef.current) syncQueueRef.current!.enqueueDelete(id);
    },
    [commit],
  );

  const deleteMessage = useCallback(
    (conversationId: string, messageId: string) => {
      commit(
        { type: "DELETE_MESSAGE", payload: { conversationId, messageId } },
        [conversationId],
      );
    },
    [commit],
  );

  const refreshConversations = useCallback(async () => {
    const expectedUserId = accountIdRef.current;
    if (expectedUserId === null) return;
    if (!hydrated) {
      await hydrateForUser(expectedUserId, true);
      return;
    }
    if (!canSyncRef.current) return;
    const flushed = await syncQueueRef.current!.flushAll();
    if (!flushed) return;
    await hydrateForUser(expectedUserId, false);
  }, [hydrateForUser, hydrated]);

  const clearSyncError = useCallback(() => setSyncError(null), []);

  const activeConversation =
    state.conversations.find((c) => c.id === state.activeConversationId) ??
    null;

  useEffect(() => {
    const handleFocus = () => void refreshConversations();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshConversations();
      } else {
        void syncQueueRef.current!.flushAll();
      }
    };
    const handlePageHide = () => {
      void syncQueueRef.current!.flushAll();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshConversations]);

  useEffect(
    () => () => {
      syncQueueRef.current?.reset();
    },
    [],
  );

  return (
    <ConversationContext.Provider
      value={{
        state,
        activeConversation,
        loading: auth.loading || hydrationLoading,
        hydrated,
        syncError,
        createConversation,
        setActive,
        addMessage,
        updateStatus,
        updateAssistantMessages,
        updateTitle,
        deleteConversation,
        deleteMessage,
        refreshConversations,
        clearSyncError,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation() {
  const ctx = useContext(ConversationContext);
  if (!ctx)
    throw new Error("useConversation must be used within ConversationProvider");
  return ctx;
}

/**
 * Get a human-readable label for an intermediate step type
 */
function getStepLabel(type: string, msg: OutputMessage): string {
  switch (type) {
    case "web_search_call": {
      // Try to extract the search query
      const query =
        msg.action?.query ||
        (msg as any).query ||
        (Array.isArray(msg.queries) && msg.queries[0]) ||
        "";
      return query ? `搜索 ${query}` : "网络搜索";
    }
    case "file_search_call":
      return "文件搜索";
    case "computer_call": {
      // Try to extract the URL or action
      const action = msg.action;
      if (action?.type === "navigate" || action?.type === "goto") {
        return `查看 ${action.url || "网页"}`;
      }
      if (action?.type === "click") return "点击操作";
      if (action?.type === "type" || action?.type === "input")
        return "输入操作";
      if (action?.type === "scroll") return "滚动页面";
      if (action?.type === "screenshot") return "截图";
      return "浏览器操作";
    }
    case "code_interpreter_call":
      return "执行代码";
    case "function_call": {
      const name = msg.name || "";
      if (name.includes("search")) return `搜索 ${name}`;
      if (name.includes("browse") || name.includes("navigate"))
        return `浏览 ${name}`;
      if (name.includes("write") || name.includes("create"))
        return `撰写 ${name}`;
      if (name.includes("read")) return `读取 ${name}`;
      return name ? `调用 ${name}` : "工具调用";
    }
    case "reasoning": {
      // Try to get summary text
      const summaryText = msg.summary?.[0]?.text || "";
      return summaryText ? summaryText.slice(0, 60) : "思考中...";
    }
    case "mcp_call": {
      const name = msg.name || "";
      return name ? `MCP 调用 ${name}` : "MCP 工具调用";
    }
    case "mcp_list_tools": {
      return "获取工具列表";
    }
    case "mcp_approval_request": {
      return "等待工具审批";
    }
    default: {
      // Try to extract a meaningful label from the type name
      const label = type.replace(/_/g, " ").replace(/call$/, "").trim();
      return label || type;
    }
  }
}

/**
 * Get description text for an intermediate step
 */
function getStepDescription(
  type: string,
  msg: OutputMessage,
): string | undefined {
  switch (type) {
    case "web_search_call": {
      const query =
        msg.action?.query ||
        (msg as any).query ||
        (Array.isArray(msg.queries) && msg.queries[0]) ||
        "";
      return query ? undefined : undefined;
    }
    case "reasoning": {
      const summaryText =
        msg.summary
          ?.map((s: any) => s.text)
          .filter(Boolean)
          .join("\n") || "";
      return summaryText || undefined;
    }
    case "computer_call": {
      const action = msg.action;
      if (action?.type === "navigate" || action?.type === "goto") {
        return action.url || undefined;
      }
      return undefined;
    }
    case "code_interpreter_call": {
      // Try to get the code
      const code = (msg as any).input || (msg as any).code || "";
      return code ? code.slice(0, 200) : undefined;
    }
    case "function_call": {
      // Try to show function arguments
      const args = msg.arguments;
      if (args) {
        try {
          const parsed = JSON.parse(args);
          // Show a brief summary of the arguments
          const keys = Object.keys(parsed);
          if (keys.length > 0) {
            return keys
              .map((k) => `${k}: ${String(parsed[k]).slice(0, 50)}`)
              .join(", ")
              .slice(0, 150);
          }
        } catch {
          return args.slice(0, 100);
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Determine the step icon type category
 */
export function getStepIconType(
  type: string,
): "search" | "browse" | "code" | "write" | "reasoning" | "tool" {
  switch (type) {
    case "web_search_call":
    case "file_search_call":
      return "search";
    case "computer_call":
      return "browse";
    case "code_interpreter_call":
      return "code";
    case "reasoning":
      return "reasoning";
    case "function_call":
    case "mcp_call":
    case "mcp_list_tools":
    case "mcp_approval_request":
      return "tool";
    default:
      // Try to infer from type name
      if (type.includes("search")) return "search";
      if (
        type.includes("browse") ||
        type.includes("computer") ||
        type.includes("navigate")
      )
        return "browse";
      if (type.includes("code") || type.includes("interpreter")) return "code";
      if (type.includes("reason") || type.includes("think")) return "reasoning";
      if (type.includes("write") || type.includes("create")) return "write";
      return "tool";
  }
}

/**
 * Try to infer a group title from a sequence of intermediate steps
 */
function inferGroupTitle(steps: IntermediateStep[]): string {
  if (steps.length === 0) return "处理中";

  const types = steps.map((s) => getStepIconType(s.type));
  const hasSearch = types.includes("search");
  const hasBrowse = types.includes("browse");
  const hasCode = types.includes("code");
  const hasWrite = types.includes("write");
  const hasReasoning = types.includes("reasoning");

  if (hasSearch && hasBrowse) return "搜集信息与数据";
  if (hasSearch) return "搜索相关信息";
  if (hasBrowse) return "浏览网页内容";
  if (hasCode) return "执行代码";
  if (hasWrite) return "整理分析并生成内容";
  if (hasReasoning) return "分析思考";
  return "处理任务";
}

/**
 * Build step groups from a flat list of intermediate steps.
 * Groups steps by their icon type category.
 */
function buildStepGroups(
  steps: IntermediateStep[],
  descriptions: string[],
): StepGroup[] {
  const stepGroups: StepGroup[] = [];
  if (steps.length === 0) return stepGroups;

  // Group steps by their icon type category
  let currentGroup: IntermediateStep[] = [];
  let lastCategory = "";

  for (const step of steps) {
    const category = getStepIconType(step.type);
    if (lastCategory && category !== lastCategory && currentGroup.length > 0) {
      // Start a new group
      stepGroups.push({
        id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: inferGroupTitle(currentGroup),
        steps: currentGroup,
        description:
          descriptions.length > 0 ? descriptions.join("\n") : undefined,
      });
      currentGroup = [];
      descriptions = [];
    }
    currentGroup.push(step);
    lastCategory = category;
  }

  // Push the last group
  if (currentGroup.length > 0) {
    stepGroups.push({
      id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: inferGroupTitle(currentGroup),
      steps: currentGroup,
      description:
        descriptions.length > 0 ? descriptions.join("\n") : undefined,
    });
  }

  return stepGroups;
}

/**
 * Check if an output item is an intermediate step (non-message type)
 */
function isIntermediateStepType(type: string): boolean {
  // "message" is a regular message, everything else is an intermediate step
  if (type === "message") return false;

  // Known intermediate step types
  const knownStepTypes = [
    "reasoning",
    "web_search_call",
    "file_search_call",
    "computer_call",
    "code_interpreter_call",
    "function_call",
    "function_call_output",
    "mcp_call",
    "mcp_list_tools",
    "mcp_approval_request",
  ];

  if (knownStepTypes.includes(type)) return true;

  // Heuristic: if the type contains "call", "search", "reason", "tool", it's likely a step
  if (
    type.includes("call") ||
    type.includes("search") ||
    type.includes("reason") ||
    type.includes("tool")
  ) {
    return true;
  }

  // Default: treat unknown non-message types as intermediate steps
  return true;
}

/**
 * Normalize file URLs from the API to route through our proxy.
 * The API may return:
 * - Absolute API URLs that point to /v1/files/xxx
 * - Relative paths like /v1/files/xxx
 * - Direct S3 URLs like https://vida-private.s3.us-east-1.amazonaws.com/...
 * - Other external URLs
 *
 * For API file URLs: route through /api/frontmind/v1/files/xxx for auth + S3 resolution.
 * For S3/external URLs: route through /api/frontmind/proxy-download?url=... to avoid CORS.
 * For data/blob URLs: pass through directly.
 */
function normalizeFileUrl(url: string): string {
  if (!url) return url;

  // Already a proxy URL
  if (url.startsWith("/api/frontmind/")) return url;

  // Data URLs and blob URLs - pass through directly
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  // Absolute API URL with /v1/files/xxx -> /api/frontmind/v1/files/xxx
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/v1/files/")) {
      return `/api/frontmind${parsed.pathname}`;
    }
    // External URL (S3, CDN, etc.) - proxy through our server to avoid CORS
    return `/api/frontmind/proxy-download?url=${encodeURIComponent(url)}`;
  } catch {
    // Not a valid absolute URL, try relative path matching
  }

  // Relative API path: /v1/files/xxx -> /api/frontmind/v1/files/xxx
  if (url.startsWith("/v1/files/")) {
    return `/api/frontmind${url}`;
  }

  // Unknown format - pass through
  return url;
}

/**
 * Parse FrontMind API output messages into local messages
 * Handles both OpenAI Responses API format and native FrontMind API format.
 * Now also extracts intermediate steps from non-message output items.
 *
 * INTERMEDIATE STEPS FIX: Enhanced to properly handle:
 * 1. Non-message output types (reasoning, web_search_call, computer_call, etc.)
 * 2. Steps-only polls (when no assistant message has arrived yet)
 * 3. Proper grouping and display of step sequences
 */
export function parseOutputMessages(
  output: OutputMessage[],
  responseStartedAt?: number,
  modelName?: string,
): LocalMessage[] {
  try {
    return _parseOutputMessagesInner(output, responseStartedAt, modelName);
  } catch (e) {
    console.error("[parseOutputMessages] Unexpected error:", e);
    // Return a safe fallback message so the UI doesn't crash
    return [
      {
        id: `msg-err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        responseStartedAt,
        modelName,
      },
    ];
  }
}

export function sanitizeKnowledgeBaseOutputMessages(
  messages: LocalMessage[],
): LocalMessage[] {
  return messages
    .map(
      ({
        intermediateSteps: _intermediateSteps,
        stepGroups: _stepGroups,
        isStepsPlaceholder: _isStepsPlaceholder,
        ...message
      }) => ({
        ...message,
        content: sanitizeKnowledgeBaseCustomerMarkdown(message.content),
        inlineImages: message.inlineImages?.filter((image) =>
          isManagedKnowledgeBaseImageSource(image.src),
        ),
      }),
    )
    .filter(
      (message) =>
        Boolean(message.content.trim()) ||
        Boolean(message.outputFiles?.length) ||
        Boolean(message.inlineImages?.length),
    );
}

const EXTERNAL_IMAGE_ASSET_URL =
  /https?:\/\/[^\s<>"')\]]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^\s<>"')\]]*)?/gi;

function isManagedKnowledgeBaseImageSource(src: string): boolean {
  const normalized = String(src || "").trim();
  return (
    /^data:image\/[a-z0-9.+-]+;base64,/i.test(normalized) ||
    normalized.startsWith("/api/frontmind/") ||
    normalized.startsWith("/api/dashboard/knowledge/assets/") ||
    normalized.startsWith("/api/knowledge-base/")
  );
}

/**
 * Knowledge-base drafts must not hotlink origin/CDN images. Such URLs can be
 * protected by Referer rules, expire, or be revoked after the crawl. The
 * customer-facing archive only renders validated bytes stored in the ZIP and
 * served by our authenticated asset route.
 */
export function sanitizeKnowledgeBaseCustomerMarkdown(text: string): string {
  if (!text) return "";

  return text
    .replace(
      /!\[([^\]\n]*)]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi,
      (_match, alt: string) => (alt.trim() ? `配图：${alt.trim()}` : ""),
    )
    .replace(
      /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi,
      "",
    )
    .replace(
      /\[([^\]\n]+)]\(\s*<?(https?:\/\/[^)\s>]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^)\s>]*)?)>?(?:\s+["'][^"']*["'])?\s*\)/gi,
      "$1",
    )
    .replace(EXTERNAL_IMAGE_ASSET_URL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function _parseOutputMessagesInner(
  output: OutputMessage[],
  responseStartedAt?: number,
  modelName?: string,
): LocalMessage[] {
  if (!output || !Array.isArray(output)) return [];

  const messages: LocalMessage[] = [];

  // Collect intermediate steps that appear before each assistant message
  let pendingSteps: IntermediateStep[] = [];
  // Also collect reasoning/description text between steps
  let pendingDescriptions: string[] = [];

  for (const msg of output) {
    const msgType = msg.type || "message";

    // Check if this is an intermediate step (non-message type)
    if (isIntermediateStepType(msgType)) {
      const step: IntermediateStep = {
        id:
          msg.id ||
          `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: msgType,
        label: getStepLabel(msgType, msg),
        description: getStepDescription(msgType, msg),
      };

      // For reasoning type, also extract the text as description
      if (msgType === "reasoning" && msg.summary) {
        const summaryTexts = msg.summary.map((s) => s.text).filter(Boolean);
        if (summaryTexts.length > 0) {
          pendingDescriptions.push(summaryTexts.join(" "));
        }
      }

      pendingSteps.push(step);
      continue;
    }

    // This is a regular message
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const files: { fileUrl: string; fileName: string; mimeType: string }[] =
        [];
      const inlineImages: { src: string; alt?: string }[] = [];
      const contentSteps: IntermediateStep[] = [];

      // Handle case where content is a plain string (some API versions)
      const rawContent = msg.content as unknown;
      if (typeof rawContent === "string") {
        if ((rawContent as string).trim()) {
          textParts.push(rawContent as string);
        }
      } else if (!rawContent || !Array.isArray(rawContent)) {
        // Try to extract text from the message object itself (fallback)
        const fallbackText =
          (msg as any).text || (msg as any).message || (msg as any).output;
        if (typeof fallbackText === "string" && fallbackText.trim()) {
          textParts.push(fallbackText);
        }
        // NOTE: Do NOT `continue` here. Even if there's no text content,
        // there may be pending intermediate steps that should be attached
        // to this message. The message will still be created below if
        // there are steps, files, or images.
      } else {
        // msg.content is an array
        for (const content of rawContent as any[]) {
          if (!content) continue;

          // Handle plain string content items
          if (typeof content === "string") {
            textParts.push(content);
            continue;
          }

          // Normalize field names: API may return snake_case or camelCase
          const c: any = content;
          const contentType = c.type || "";
          const fileId = c.fileId || c.file_id || "";
          const rawFileUrl = c.fileUrl || c.file_url || c.url || "";
          const fileUrl =
            rawFileUrl ||
            (typeof fileId === "string" && fileId.trim()
              ? `/api/frontmind/v1/files/${encodeURIComponent(fileId.trim())}`
              : "");
          const fileName = c.fileName || c.file_name || c.name || "file";
          const mimeType = c.mimeType || c.mime_type || c.content_type || "";
          const textValue = c.text ?? c.value ?? null;

          if (
            (contentType === "output_file" || contentType === "file") &&
            fileUrl
          ) {
            // Normalize file URL: route external API URLs through our proxy for auth
            const normalizedFileUrl = normalizeFileUrl(fileUrl);
            // Check if it's an image file
            if (mimeType.startsWith("image/")) {
              inlineImages.push({
                src: normalizedFileUrl,
                alt: fileName || "Generated image",
              });
            } else {
              files.push({
                fileUrl: normalizedFileUrl,
                fileName,
                mimeType: mimeType || "application/octet-stream",
              });
            }
          } else if (
            (contentType === "output_image" || contentType === "image") &&
            fileUrl
          ) {
            const normalizedFileUrl = normalizeFileUrl(fileUrl);
            inlineImages.push({
              src: normalizedFileUrl,
              alt: fileName || "Generated image",
            });
          } else if (
            contentType === "output_text" ||
            contentType === "text" ||
            contentType === "" ||
            contentType === "refusal"
          ) {
            if (textValue != null && String(textValue).trim()) {
              const textContent = String(textValue);
              const extractedImages = extractInlineImages(textContent);
              if (extractedImages.length > 0) {
                inlineImages.push(...extractedImages);
              }
              textParts.push(textContent);
            }
          } else {
            // Non-standard content type within a message - treat as intermediate step
            // But first check if it has text we should capture
            if (textValue != null && String(textValue).trim()) {
              textParts.push(String(textValue));
            } else {
              contentSteps.push({
                id: `cstep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: contentType,
                label: contentType.replace(/_/g, " "),
                description: textValue ? String(textValue) : undefined,
              });
            }
          }
        }
      }

      // Merge content-level steps with pending output-level steps
      const allSteps = [...pendingSteps, ...contentSteps];

      // Build step groups from the collected steps
      const stepGroups = buildStepGroups(allSteps, [...pendingDescriptions]);

      if (
        textParts.length > 0 ||
        files.length > 0 ||
        inlineImages.length > 0 ||
        allSteps.length > 0
      ) {
        messages.push({
          id:
            msg.id ||
            `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "assistant",
          content:
            textParts.length > 0
              ? sanitizeBrandText(textParts.join("\n\n"))
              : "",
          timestamp: Date.now(),
          outputFiles:
            files.length > 0
              ? files.map((f) => ({
                  ...f,
                  fileName: sanitizeBrandText(f.fileName),
                }))
              : undefined,
          inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
          responseStartedAt,
          intermediateSteps:
            allSteps.length > 0
              ? allSteps.map((s) => ({
                  ...s,
                  label: sanitizeBrandText(s.label),
                  description: s.description
                    ? sanitizeBrandText(s.description)
                    : undefined,
                }))
              : undefined,
          stepGroups:
            stepGroups.length > 0
              ? stepGroups.map((g) => ({
                  ...g,
                  title: sanitizeBrandText(g.title),
                  description: g.description
                    ? sanitizeBrandText(g.description)
                    : undefined,
                  steps: g.steps.map((s) => ({
                    ...s,
                    label: sanitizeBrandText(s.label),
                    description: s.description
                      ? sanitizeBrandText(s.description)
                      : undefined,
                  })),
                }))
              : undefined,
          modelName,
        });
      }

      // Reset pending steps after attaching to a message
      pendingSteps = [];
      pendingDescriptions = [];
    }
  }

  // If there are remaining pending steps with no following message,
  // create a placeholder message to display them.
  // This is critical for showing intermediate steps DURING task execution
  // before the final assistant message arrives.
  if (pendingSteps.length > 0) {
    const stepGroups = buildStepGroups(pendingSteps, [...pendingDescriptions]);

    messages.push({
      id: `msg-steps-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      responseStartedAt,
      intermediateSteps: pendingSteps.map((s) => ({
        ...s,
        label: sanitizeBrandText(s.label),
        description: s.description
          ? sanitizeBrandText(s.description)
          : undefined,
      })),
      stepGroups: stepGroups.map((g) => ({
        ...g,
        title: sanitizeBrandText(g.title),
        description: g.description
          ? sanitizeBrandText(g.description)
          : undefined,
        steps: g.steps.map((s) => ({
          ...s,
          label: sanitizeBrandText(s.label),
          description: s.description
            ? sanitizeBrandText(s.description)
            : undefined,
        })),
      })),
      isStepsPlaceholder: true,
      modelName,
    });
  }

  return messages;
}

/**
 * Extract inline base64 images from markdown text content.
 * FrontMind API sometimes returns images as base64 embedded in text.
 */
function extractInlineImages(text: string): { src: string; alt?: string }[] {
  if (!text || typeof text !== "string") return [];

  const images: { src: string; alt?: string }[] = [];

  try {
    // Skip extraction for very large strings (>500KB) to avoid regex performance issues
    if (text.length > 500_000) {
      console.warn(
        "[extractInlineImages] Skipping extraction for very large text:",
        text.length,
      );
      return images;
    }

    // Match markdown image syntax: ![alt](data:image/...;base64,...)
    const imageRegex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)/g;
    let match;
    while ((match = imageRegex.exec(text)) !== null) {
      images.push({ src: match[2], alt: match[1] || "Image" });
    }

    // Also match raw data URIs that might be image URLs in output
    // (some API versions return them differently)
    const dataUriRegex = /(data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,})/g;
    while ((match = dataUriRegex.exec(text)) !== null) {
      // Avoid duplicates from the first regex
      if (!images.some((img) => img.src === match![1])) {
        images.push({ src: match[1], alt: "Image" });
      }
    }
  } catch (e) {
    console.error("[extractInlineImages] Error:", e);
  }

  return images;
}
