import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  invalidateUsers: vi.fn(),
  invalidateWorkspace: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      admin: {
        users: { list: { invalidate: mocks.invalidateUsers } },
        workspace: { list: { invalidate: mocks.invalidateWorkspace } },
      },
    }),
    admin: {
      users: {
        create: {
          useMutation: () => ({
            mutateAsync: mocks.mutateAsync,
            isPending: false,
            reset: vi.fn(),
          }),
        },
      },
    },
  },
}));

import { CreateUserDialog } from "./AdminUsers";

describe("CreateUserDialog", () => {
  it("gives the system administrator a customer-only form with a mandatory pending plan selector", () => {
    render(<CreateUserDialog open userOnly onOpenChange={() => undefined} />);

    expect(screen.getByText("客户套餐")).toBeInTheDocument();
    expect(screen.getByText(/创建客户时必须选择套餐/)).toBeInTheDocument();
    expect(screen.queryByText("账号角色")).toBeNull();
    expect(screen.queryByText("管理员初始密码")).toBeNull();
    expect(
      screen.getByRole("button", { name: "创建客户账号" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/不生成配额/)).toBeInTheDocument();
  });

  it("offers exactly the three production plans for a customer account", () => {
    render(<CreateUserDialog open userOnly onOpenChange={() => undefined} />);

    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "普通版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "进阶版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "豪华版" })).toBeInTheDocument();
  });

  it("keeps administrator creation available only in the system-admin variant", () => {
    render(<CreateUserDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText("账号角色")).toBeInTheDocument();
    expect(screen.getByText("客户套餐")).toBeInTheDocument();
  });
});
