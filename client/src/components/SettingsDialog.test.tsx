import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authUser: {
    id: 2,
    username: "regular-user",
    displayName: "普通用户",
    role: "user" as "user" | "admin",
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

    expect(screen.getByText("API Key 使用教程")).toBeInTheDocument();
    expect(screen.queryByText("近 30 天积分使用")).not.toBeInTheDocument();
    expect(screen.queryByText("最近任务明细")).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "测试连接" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("云端凭据状态")).not.toBeInTheDocument();
    expect(screen.queryByText("Key 指纹")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "删除 Key" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("检测到旧版本地数据")).not.toBeInTheDocument();
    expect(screen.queryByText("迁移到当前账号")).not.toBeInTheDocument();
  });

  it("hides usage records for an administrator other than the built-in admin", () => {
    mocks.authUser = {
      id: 3,
      username: "operations-admin",
      displayName: "运营管理员",
      role: "admin",
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByText("近 30 天积分使用")).not.toBeInTheDocument();
    expect(screen.queryByText("最近任务明细")).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
  });

  it("shows credit usage and recent tasks only for the built-in admin account", async () => {
    mocks.authUser = {
      id: 1,
      username: "admin",
      displayName: "系统管理员",
      role: "admin",
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(mocks.fetchCreditUsage).toHaveBeenCalledWith({
        force: false,
        fingerprint: "key-abcd",
      }),
    );
    expect(await screen.findByText("128 积分")).toBeInTheDocument();
    expect(screen.getByText("最近任务明细")).toBeInTheDocument();
    expect(screen.getByText("GEO 品牌洞察")).toBeInTheDocument();
  });

  it("tests the saved credential when the replacement field is empty", async () => {
    mocks.testCredential.mockResolvedValue({ ok: true });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(mocks.testCredential).toHaveBeenCalledWith({ apiKey: undefined }),
    );
    expect(await screen.findByText(/连接正常/)).toBeInTheDocument();
  });
});
