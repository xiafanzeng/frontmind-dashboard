import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  login: vi.fn(),
  loginPending: false,
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => authMock,
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

import Login from "./Login";

describe("Login", () => {
  beforeEach(() => {
    authMock.login.mockReset();
    authMock.login.mockResolvedValue({
      user: {
        id: 1,
        username: "demo",
        displayName: "演示账号",
        role: "user",
        isActive: true,
      },
    });
    toastMock.error.mockReset();
    window.history.replaceState({}, "", "/login");
  });

  it("uses the FrontMind intelligent workflow positioning", () => {
    render(<Login />);

    expect(
      screen.getByRole("heading", { name: "FrontMind 智能体工作流" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("与FrontMind一起，探索当前最强 AI 工作流的能力边界。"),
    ).toBeInTheDocument();
  });

  it("submits the normalized username and password", async () => {
    render(<Login />);

    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "  demo  " },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "a-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() =>
      expect(authMock.login).toHaveBeenCalledWith("demo", "a-secure-password"),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("does not submit incomplete credentials", () => {
    render(<Login />);

    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(authMock.login).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("请输入用户名和密码");
  });
});
