import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  user: null as { id: number } | null,
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => authMock,
}));

vi.mock("@/pages/Login", () => ({
  default: () => <div>LOGIN_REQUIRED</div>,
}));

import { AuthBoundary } from "./App";

describe("AuthBoundary", () => {
  beforeEach(() => {
    authMock.user = null;
    authMock.loading = false;
    authMock.error = null;
    authMock.refresh.mockReset();
  });

  it("shows login on the first unauthenticated visit", () => {
    render(<AuthBoundary />);

    expect(screen.getByText("LOGIN_REQUIRED")).toBeInTheDocument();
  });

  it("does not render login or workspace before the session check finishes", () => {
    authMock.loading = true;
    render(<AuthBoundary />);

    expect(screen.getByText("正在打开工作空间")).toBeInTheDocument();
    expect(screen.queryByText("LOGIN_REQUIRED")).not.toBeInTheDocument();
  });
});
