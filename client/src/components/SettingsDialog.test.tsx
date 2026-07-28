import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authUser: {
    id: 2,
    username: "regular-user",
    displayName: "普通用户",
    role: "user" as "user" | "admin",
    adminAccessLevel: null as "system_admin" | "delivery_admin" | null,
    isActive: true,
  },
  fetchCreditUsage: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  refetchStatus: vi.fn(),
  invalidateStatus: vi.fn(),
  setCredential: vi.fn(),
  replaceCredential: vi.fn(),
  testCredential: vi.fn(),
  resetSet: vi.fn(),
  resetReplace: vi.fn(),
  resetTest: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: mocks.authUser }),
}));

vi.mock("@/lib/frontmind-api", () => ({
  creditEventBus: { subscribe: mocks.subscribe },
  fetchCreditUsage: mocks.fetchCreditUsage,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      credential: { status: { invalidate: mocks.invalidateStatus } },
    }),
    credential: {
      status: {
        useQuery: () => ({
          data: {
            configured: true,
            fingerprint: "key-abcd",
            status: "active",
            verifiedAt: "2026-07-14T06:00:00.000Z",
          },
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: mocks.refetchStatus,
        }),
      },
      set: {
        useMutation: () => ({
          mutateAsync: mocks.setCredential,
          isPending: false,
          reset: mocks.resetSet,
        }),
      },
      replace: {
        useMutation: () => ({
          mutateAsync: mocks.replaceCredential,
          isPending: false,
          reset: mocks.resetReplace,
        }),
      },
      test: {
        useMutation: () => ({
          mutateAsync: mocks.testCredential,
          isPending: false,
          reset: mocks.resetTest,
        }),
      },
    },
  },
}));

import SettingsDialog from "./SettingsDialog";

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = {
      id: 2,
      username: "regular-user",
      displayName: "普通用户",
      role: "user",
      adminAccessLevel: null,
      isActive: true,
    };
    mocks.fetchCreditUsage.mockResolvedValue({
      totalUsed: 128,
      recentTasks: [
        {
          id: "task-1",
          title: "GEO 品牌洞察",
          creditUsage: 128,
          createdAt: "2026/07/14",
        },
      ],
    });
  });

  it("hides usage records for a regular user", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("智能服务设置")).toBeInTheDocument();
    expect(
      screen.getByText(/智能服务由负责管理员统一维护/),
    ).toBeInTheDocument();
    expect(screen.queryByText("API Key 使用教程")).not.toBeInTheDocument();
    expect(screen.queryByText("当前 Key 本月总积分")).not.toBeInTheDocument();
    expect(screen.queryByText("最近任务明细")).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "测试连接" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/积分/)).not.toBeInTheDocument();
    expect(screen.queryByText("云端凭据状态")).not.toBeInTheDocument();
    expect(screen.queryByText("Key 指纹")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "删除 Key" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("检测到旧版本地数据")).not.toBeInTheDocument();
    expect(screen.queryByText("迁移到当前账号")).not.toBeInTheDocument();
  });

  it("shows usage records for an explicit delivery administrator regardless of username", async () => {
    mocks.authUser = {
      id: 3,
      username: "admin",
      displayName: "运营管理员",
      role: "admin",
      adminAccessLevel: "delivery_admin",
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(mocks.fetchCreditUsage).toHaveBeenCalledWith({
        force: false,
        fingerprint: "key-abcd",
        accountId: 3,
      }),
    );
    expect(screen.getByText("当前 Key 本月总积分")).toBeInTheDocument();
    expect(await screen.findByText("128 积分")).toBeInTheDocument();
    expect(screen.getByText("最近任务明细")).toBeInTheDocument();
    expect(screen.getByLabelText("输入新的 API Key")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "验证并更换" }),
    ).toBeInTheDocument();
  });

  it("shows credit usage and recent tasks for an explicit system administrator", async () => {
    mocks.authUser = {
      id: 1,
      username: "security-owner",
      displayName: "系统管理员",
      role: "admin",
      adminAccessLevel: "system_admin",
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(mocks.fetchCreditUsage).toHaveBeenCalledWith({
        force: false,
        fingerprint: "key-abcd",
        accountId: 1,
      }),
    );
    expect(await screen.findByText("128 积分")).toBeInTheDocument();
    expect(screen.getByText("当前 Key 本月总积分")).toBeInTheDocument();
    expect(
      screen.getByText(/同一 API Key 可供多个账号共享/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/总积分反映整个 Key 池的消耗/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/最近任务明细仅显示当前账号创建的任务/),
    ).toBeInTheDocument();
    expect(screen.getByText("最近任务明细")).toBeInTheDocument();
    expect(screen.getByText("GEO 品牌洞察")).toBeInTheDocument();
  });

  it("tests the saved credential when the replacement field is empty", async () => {
    mocks.authUser = {
      id: 3,
      username: "admin",
      displayName: "运营管理员",
      role: "admin",
      adminAccessLevel: "delivery_admin",
      isActive: true,
    };
    mocks.testCredential.mockResolvedValue({ ok: true });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(mocks.testCredential).toHaveBeenCalledWith({ apiKey: undefined }),
    );
    expect(await screen.findByText(/连接正常/)).toBeInTheDocument();
  });
});
