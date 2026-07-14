import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCreditUsage: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  refetchStatus: vi.fn(),
  invalidateStatus: vi.fn(),
  setCredential: vi.fn(),
  replaceCredential: vi.fn(),
  deleteCredential: vi.fn(),
  resetSet: vi.fn(),
  resetReplace: vi.fn(),
  resetDelete: vi.fn(),
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
      delete: {
        useMutation: () => ({
          mutateAsync: mocks.deleteCredential,
          isPending: false,
          reset: mocks.resetDelete,
        }),
      },
    },
  },
}));

import SettingsDialog from "./SettingsDialog";

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("shows account credit usage without exposing a local migration flow", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(mocks.fetchCreditUsage).toHaveBeenCalledWith({
        force: false,
        fingerprint: "key-abcd",
      }),
    );
    expect(await screen.findByText("128 积分")).toBeInTheDocument();
    expect(screen.getByText("GEO 品牌洞察")).toBeInTheDocument();
    expect(screen.queryByText("检测到旧版本地数据")).not.toBeInTheDocument();
    expect(screen.queryByText("迁移到当前账号")).not.toBeInTheDocument();
  });
});
