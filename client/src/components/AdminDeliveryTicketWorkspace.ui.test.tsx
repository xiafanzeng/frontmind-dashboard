import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/workspace", vi.fn()],
}));

vi.mock("@/lib/frontmind-api", () => ({
  uploadFile: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    admin: {
      deliveryTickets: {
        list: {
          useInfiniteQuery: () => ({
            data: {
              pages: [{ tickets: [], quotas: {}, nextCursor: null }],
            },
            refetch: vi.fn(),
            fetchNextPage: vi.fn(),
            hasNextPage: false,
            isFetchingNextPage: false,
            isFetching: false,
            isLoading: false,
            error: null,
          }),
        },
        detail: {
          useQuery: () => ({
            data: null,
            refetch: vi.fn(),
            isLoading: false,
            error: null,
          }),
        },
        adjustQuota: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        update: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        addMessage: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        recordDelivery: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

import AdminDeliveryTicketWorkspace from "./AdminDeliveryTicketWorkspace";

const executionPreviewFixtures = {
  tickets: [
    {
      id: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
      userId: 42,
      type: "website_operation" as const,
      category: "company_facts",
      title: "发布企业事实页面",
      status: "in_progress" as const,
      revision: 2,
      createdAt: "2026-07-30T22:43:00+08:00",
      updatedAt: "2026-07-30T22:43:00+08:00",
    },
  ],
  events: [],
  periodId: "2026-q3",
  revision: 1,
  contentAssetQuota: {
    used: 0,
    reserved: 0,
    consumed: 0,
    limit: 10,
  },
  websiteContentQuota: {
    used: 0,
    reserved: 0,
    consumed: 0,
    limit: 10,
  },
};

describe("AdminDeliveryTicketWorkspace streamlined UI", () => {
  it("shows only the ticket workspace without standalone website tools", () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
      />,
    );

    expect(screen.getByText("测试企业工单记录")).toBeInTheDocument();
    expect(screen.getAllByText("客户工单")).toHaveLength(2);
    expect(screen.queryByText("客户官网内容进度")).not.toBeInTheDocument();
    expect(
      screen.queryByText("批量更新官网内容（高级工具）"),
    ).not.toBeInTheDocument();
  });

  it("keeps a knowledge reset ticket focused on the customer and reset result", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        previewFixtures={{
          tickets: [
            {
              id: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
              userId: 42,
              type: "knowledge_base",
              category: "knowledge_reset",
              title: "知识库重置申请",
              status: "completed",
              publicSummary: "知识库已清空，可以重新开始首次构建。",
              revision: 2,
              createdAt: "2026-07-30T22:43:00+08:00",
              updatedAt: "2026-07-30T22:43:00+08:00",
            },
          ],
          events: [
            {
              id: "submitted",
              visibility: "customer",
              actorLabel: "用户",
              statusTo: "submitted",
              message: "客户提交知识库重置申请。",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
            {
              id: "completed",
              visibility: "customer",
              actorLabel: "交付成员",
              statusTo: "completed",
              message: "知识库重置已批准并完成清理。",
              createdAt: "2026-07-30T22:43:00+08:00",
            },
          ],
          periodId: "2026-q3",
          revision: 1,
          contentAssetQuota: {
            used: 0,
            reserved: 0,
            consumed: 0,
            limit: 0,
          },
          websiteContentQuota: {
            used: 0,
            reserved: 0,
            consumed: 0,
            limit: 0,
          },
        }}
      />,
    );

    expect(await screen.findByText("@test-user")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("客户未填写重置原因。")).toBeInTheDocument();
    expect(screen.getByText("处理记录")).toBeInTheDocument();
    expect(screen.getByText("重置处理结果")).toBeInTheDocument();
    expect(
      screen.getByText("知识库已清空，可以重新开始首次构建。"),
    ).toBeInTheDocument();

    expect(screen.queryByText("管理员内部记录")).not.toBeInTheDocument();
    expect(screen.queryByText("回复客户与回传成果")).not.toBeInTheDocument();
    expect(screen.queryByText("结构化交付记录")).not.toBeInTheDocument();
    expect(
      screen.queryByText("完成工单并发布内容总结"),
    ).not.toBeInTheDocument();
  });

  it("keeps delivery administrators in coordination mode for an active ticket", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        previewFixtures={executionPreviewFixtures}
      />,
    );

    expect(await screen.findByText(/当前为交付协调模式/)).toBeInTheDocument();
    expect(
      screen.queryByText("完成工单并发布内容总结"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("保存交付记录")).not.toBeInTheDocument();
  });

  it("shows fallback execution controls only when explicitly authorized", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        canExecuteDelivery
        previewFixtures={executionPreviewFixtures}
      />,
    );

    expect(
      await screen.findByText("完成工单并发布内容总结"),
    ).toBeInTheDocument();
    expect(screen.getByText("完成工单")).toBeInTheDocument();
    expect(screen.queryByText(/当前为交付协调模式/)).not.toBeInTheDocument();
  });

  it("does not let a system administrator execute a role-owned ticket", async () => {
    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
        customerUsername="test-user"
        preview
        canExecuteDelivery
        previewFixtures={{
          ...executionPreviewFixtures,
          tickets: executionPreviewFixtures.tickets.map((ticket) => ({
            ...ticket,
            workflowDomain: "ai_operations_engineer" as const,
            operation: "company_facts" as const,
            assignedMemberId: 19,
            assignedMemberName: "AI 运维工程师",
          })),
        }}
      />,
    );

    expect(
      await screen.findByText(/该工单由AI 运维工程师执行/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("完成工单并发布内容总结"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("保存交付记录")).not.toBeInTheDocument();
  });
});
