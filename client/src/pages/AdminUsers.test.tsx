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

const deliveryAdmins = [
  {
    id: 42,
    username: "delivery.owner",
    displayName: "交付负责人",
  },
];

describe("CreateUserDialog", () => {
  it("requires an initial password, plan and customer API Key for immediate activation", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        deliveryAdmins={deliveryAdmins}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByText("客户套餐")).toBeInTheDocument();
    expect(screen.getByText(/设置客户初始密码/)).toBeInTheDocument();
    expect(screen.queryByText("账号角色")).toBeNull();
    expect(screen.getByText("初始密码")).toBeInTheDocument();
    expect(screen.getByText("确认初始密码")).toBeInTheDocument();
    expect(screen.queryByText(/设置密码链接/)).toBeNull();
    expect(screen.getByLabelText("客户 API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByRole("button", { name: "创建客户账号" })).toBeDisabled();
    expect(screen.getByText(/账号立即可用/)).toBeInTheDocument();
  });

  it("offers all four production plans and a separate delivery owner selector", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        deliveryAdmins={deliveryAdmins}
        onOpenChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "客户主负责人" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("combobox", { name: "客户套餐" }));
    expect(screen.getByRole("option", { name: "普通版" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "知识库版" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "进阶版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "豪华版" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("keeps administrator creation available only in the system-admin variant", () => {
    render(<CreateUserDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText("账号角色")).toBeInTheDocument();
    expect(screen.getByText("客户套餐")).toBeInTheDocument();
  });
});
