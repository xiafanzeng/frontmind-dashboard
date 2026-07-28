import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: null,
    logout: vi.fn(),
  }),
}));

import AdminAgent from "./AdminAgent";

describe("AdminAgent preview", () => {
  it("uses the shared administrator shell with an isolated read-only Agent adapter", () => {
    render(<AdminAgent preview />);

    expect(
      screen.getByRole("heading", { name: "FrontMind Agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "FrontMind Agent 工作区" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("只读预览不会创建任务或写入会话"),
    ).toBeInTheDocument();
    expect(screen.getByText("只读预览")).toBeInTheDocument();
    expect(screen.queryByText("READ-ONLY PREVIEW")).toBeNull();
    expect(screen.queryByText("选择智能体")).not.toBeInTheDocument();
    expect(screen.queryByText("知识库维护")).not.toBeInTheDocument();
  });

  it("opens administrator monitoring in a separate browser tab", () => {
    render(<AdminAgent preview />);

    expect(screen.getByRole("link", { name: "问题监控" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: "问题监控" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });
});
