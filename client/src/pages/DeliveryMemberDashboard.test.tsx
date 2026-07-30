import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY } from "@/lib/frontmind-api";

const mocks = vi.hoisted(() => ({
  assignments: [] as Array<{
    projectAssignmentId: string;
    customerUserId: number;
    customerName: string;
    customerUsername: string;
    roleType:
      | "ai_operations_engineer"
      | "monitoring_optimization_engineer"
      | "content_distribution_engineer";
  }>,
  workbenchUseQuery: vi.fn(),
  refetchWorkbench: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    delivery: {
      mine: {
        assignments: {
          useQuery: () => ({
            data: mocks.assignments,
            isLoading: false,
          }),
        },
        workbench: {
          useQuery: (...args: unknown[]) => {
            mocks.workbenchUseQuery(...args);
            return {
              data: { customers: [], tickets: [] },
              refetch: mocks.refetchWorkbench,
            };
          },
        },
      },
    },
  },
}));

vi.mock("@/components/PortalShell", () => ({
  default: ({
    eyebrow,
    title,
    roleLabel,
    toolbar,
    children,
  }: {
    eyebrow?: string;
    title?: string;
    roleLabel?: string;
    toolbar?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <main>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      {roleLabel && <p data-testid="project-role-label">{roleLabel}</p>}
      {toolbar}
      {children}
    </main>
  ),
}));

vi.mock("@/pages/AdminDashboard", () => ({
  channelDistributionUrl: "/dashboard?section=channel-distribution",
  issueMonitorUrl: "/dashboard?section=issue-monitor",
}));

import DeliveryMemberDashboard from "./DeliveryMemberDashboard";

describe("DeliveryMemberDashboard project context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assignments = [];
    vi.mocked(sessionStorage.getItem).mockReturnValue(null);
  });

  it("shows the project-assignment empty state and clears a stale selection", async () => {
    vi.mocked(sessionStorage.getItem).mockReturnValue(
      "stale-project-assignment",
    );

    render(<DeliveryMemberDashboard />);

    expect(
      screen.getByText("尚未分配客户项目，请联系交付管理员"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/固定角色团队/)).toBeNull();
    await waitFor(() =>
      expect(sessionStorage.removeItem).toHaveBeenCalledWith(
        DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      ),
    );
  });

  it("selects a customer project and queries the workbench by project assignment", async () => {
    mocks.assignments = [
      {
        projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        customerUserId: 101,
        customerName: "示例客户",
        customerUsername: "example.customer",
        roleType: "ai_operations_engineer",
      },
    ];

    render(<DeliveryMemberDashboard />);

    const projectSelector = await screen.findByRole("combobox", {
      name: "当前客户项目",
    });
    expect(projectSelector).toHaveValue("1e9f33bc-40e2-4a8e-9bda-40d92a94b11f");
    expect(
      screen.getByRole("option", {
        name: "示例客户 · AI 运维工程师",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-role-label")).toHaveTextContent(
      "示例客户 · AI 运维工程师",
    );
    await waitFor(() =>
      expect(mocks.workbenchUseQuery).toHaveBeenLastCalledWith(
        {
          projectAssignmentId: "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
        },
        { enabled: true },
      ),
    );
    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      "1e9f33bc-40e2-4a8e-9bda-40d92a94b11f",
    );
  });
});
