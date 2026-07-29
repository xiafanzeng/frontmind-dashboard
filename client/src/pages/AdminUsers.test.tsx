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

  it("removes the retired knowledge plan and requires a market edition", () => {
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
    expect(screen.getByRole("combobox", { name: "客户版本" })).toBeEnabled();
    fireEvent.click(screen.getByRole("combobox", { name: "客户套餐" }));
    expect(screen.getByRole("option", { name: "普通版" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "知识库版" })).toBeNull();
    expect(screen.getByRole("option", { name: "进阶版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "豪华版" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.click(screen.getByRole("option", { name: "普通版" }));
    fireEvent.click(screen.getByRole("combobox", { name: "客户版本" }));
    expect(screen.getByRole("option", { name: "海内版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "海外版" })).toBeInTheDocument();
  });

  it("keeps administrator creation available only in the system-admin variant", () => {
    render(<CreateUserDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText("账号角色")).toBeInTheDocument();
    expect(screen.getByText("客户套餐")).toBeInTheDocument();
  });

  it("automatically fixes a delivery administrator as the new customer's owner", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        fixedDeliveryAdmin={deliveryAdmins[0]}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "客户主负责人" })).toBeNull();
    expect(screen.getByText(/交付负责人/)).toBeInTheDocument();
    expect(screen.getByText(/自动归属当前账号/)).toBeInTheDocument();
    expect(screen.getByText(/自动归属当前交付管理员/)).toBeInTheDocument();
  });
});
