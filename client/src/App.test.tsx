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

import { AuthBoundary, canAccessAdminRoutes } from "./App";

describe("administrator route access", () => {
  it("allows both system and delivery administrators into shared admin routes", () => {
    expect(
      canAccessAdminRoutes({
        role: "admin",
        adminAccessLevel: "system_admin",
      }),
    ).toBe(true);
    expect(
      canAccessAdminRoutes({
        role: "admin",
        adminAccessLevel: "delivery_admin",
      }),
    ).toBe(true);
    expect(
      canAccessAdminRoutes({
        role: "admin",
        adminAccessLevel: null,
      }),
    ).toBe(false);
    expect(canAccessAdminRoutes({ role: "user" })).toBe(false);
  });
});

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
