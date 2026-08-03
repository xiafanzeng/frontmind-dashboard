import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import ChatInput from "./ChatInput";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => true),
  activeConversation: {
    id: "kb-conversation",
    taskId: "kb-task",
    status: "awaiting_input",
    messages: [
      { id: "user", role: "user", content: "确认", timestamp: 1 },
      {
        id: "assistant",
        role: "assistant",
        content: "## 法定主体与成立时间\n正文",
        timestamp: 2,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-2",
          presentationKey: "presentation-2",
          revision: 2,
          leafId: "identity.legal",
        },
      },
    ],
    knowledgeBase: {
      generation: 1,
      stateEpoch: 2,
      activeTurnId: "turn-2",
      activeClientRequestId: "request-2",
      interactionState: "awaiting_input",
      canReply: true,
      presentationKey: "presentation-2",
      revision: 2,
      leafId: "identity.legal",
      notice: null,
    },
  } as any,
}));

vi.mock("@/hooks/useSendMessage", () => ({
  useSendMessage: () => ({
    sendMessage: mocks.sendMessage,
    uploadProgress: null,
  }),
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    activeConversation: mocks.activeConversation,
  }),
  currentKnowledgeBasePresentationReady: (
    conversation: any,
    revision: number,
    leafId: string,
  ) =>
    Boolean(
      conversation?.status === "awaiting_input" &&
        conversation?.knowledgeBase?.canReply &&
        conversation?.knowledgeBase?.revision === revision &&
        conversation?.knowledgeBase?.leafId === leafId &&
        conversation.messages.some(
          (message: any) =>
            message.knowledgeBase?.kind === "presentation" &&
            message.knowledgeBase?.turnId ===
              conversation.knowledgeBase.activeTurnId &&
            message.knowledgeBase?.presentationKey ===
              conversation.knowledgeBase.presentationKey,
        ),
    ),
}));

vi.mock("@/lib/frontmind-api", () => ({
  MODEL_OPTIONS: [
    {
      value: "frontmind-pro",
      label: "FrontMind Pro",
      description: "test",
    },
  ],
  getConfig: () => ({ agentProfile: "frontmind-pro" }),
  saveConfig: vi.fn(),
}));

const progress: KnowledgeBaseProgressDto = {
  build: {
    id: "build-1",
    conversationId: "kb-conversation",
    companyName: "硅基流动",
    status: "confirming",
    revision: 2,
    currentLeafId: "identity.legal",
    protocolError: null,
    awaitingResponseSince: null,
    updatedAt: Date.now(),
  },
  summary: {
    total: 2,
    handled: 1,
    confirmed: 1,
    directPrefilled: 0,
    pending: 0,
    current: 1,
    needsVerification: 0,
    overallPercent: 50,
  },
  branches: [
    {
      id: "identity",
      title: "企业身份",
      total: 2,
      handled: 1,
      confirmed: 1,
      directPrefilled: 0,
      pending: 0,
      current: 1,
      needsVerification: 0,
      leaves: [
        {
          id: "identity.role",
          title: "企业定位与核心角色",
          branchId: "identity",
          branchTitle: "企业身份",
          ordinal: 0,
          status: "confirmed",
        },
        {
          id: "identity.legal",
          title: "法定主体与成立时间",
          branchId: "identity",
          branchTitle: "企业身份",
          ordinal: 1,
          status: "current",
        },
      ],
    },
  ],
  packageAllowed: false,
};

describe("knowledge-base ChatInput actions", () => {
  beforeEach(() => {
    mocks.sendMessage.mockClear();
    mocks.sendMessage.mockResolvedValue(true);
    mocks.activeConversation.messages = [
      { id: "user", role: "user", content: "确认", timestamp: 1 },
      {
        id: "assistant",
        role: "assistant",
        content: "## 法定主体与成立时间\n正文",
        timestamp: 2,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-2",
          presentationKey: "presentation-2",
          revision: 2,
          leafId: "identity.legal",
        },
      },
    ];
    mocks.activeConversation.status = "awaiting_input";
    mocks.activeConversation.knowledgeBase.canReply = true;
    mocks.activeConversation.knowledgeBase.notice = null;
  });

  it("does not allow another confirmation until the current presentation renders", () => {
    mocks.activeConversation.messages = [
      { id: "user", role: "user", content: "确认", timestamp: 1 },
    ];

    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(
      screen.getByText("正在处理当前节点内容，显示完整后才可确认。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
  });

  it("shows the authoritative current node and sends strict quick actions", async () => {
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByText("当前待确认")).toBeInTheDocument();
    expect(screen.getByText(/法定主体与成立时间/)).toBeInTheDocument();
    expect(
      screen.getByText(/建议尽量上传与当前部分相关的补充图片/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /直接预填/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认当前内容" }));

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "确认",
        [],
        expect.objectContaining({
          syncKnowledgeBaseSnapshot: true,
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 2,
          knowledgeBaseExpectedLeafId: "identity.legal",
        }),
      ),
    );
  });

  it("locks the confirmation synchronously until the request settles", async () => {
    let finishSend!: (sent: boolean) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
    );
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const confirm = screen.getByRole("button", { name: "确认当前内容" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();

    finishSend(true);
    await waitFor(() => expect(confirm).not.toBeDisabled());
  });

  it("disables quick actions when revision text or files are present", () => {
    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: "成立日期改为 8 月 30 日" },
    });
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "" } });
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["12345"], "企业资料.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    expect(screen.getByText("企业资料.pdf")).toBeInTheDocument();
    expect(screen.getByText("5 B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
  });

  it("intercepts a standalone ambiguous continuation", async () => {
    render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "继续" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mocks.sendMessage).not.toHaveBeenCalled());
  });

  it("unlocks file selection only for an attachment-resume reservation", () => {
    mocks.activeConversation.status = "running";
    mocks.activeConversation.knowledgeBase.canReply = false;
    mocks.activeConversation.knowledgeBase.notice = {
      errorKey: "attachments-required",
      code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED",
      message: "请重新选择原文件",
      severity: "warning" as const,
      retryable: false,
      turnId: "turn-2",
    };
    const { container } = render(
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        knowledgeBaseProgress={progress}
      />,
    );

    expect(screen.getByRole("textbox")).not.toBeDisabled();
    const fileInput = container.querySelector('input[type="file"]')!;
    expect(fileInput).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "确认当前内容" })).toBeDisabled();
    expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
    expect(container.querySelector("svg.lucide-send")).toBeInTheDocument();

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["image"], "补充图片.jpg", { type: "image/jpeg" })],
      },
    });

    expect(screen.getByText("补充图片.jpg")).toBeInTheDocument();
    const sendIcon = container.querySelector("svg.lucide-send")!;
    expect(sendIcon).toBeInTheDocument();
    expect(sendIcon.closest("button")).not.toBeDisabled();
  });
});
