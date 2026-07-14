import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MarkdownRenderer from "./MarkdownRenderer";

describe("MarkdownRenderer security", () => {
  it("does not turn persisted raw HTML into executable DOM", () => {
    const { container } = render(
      <MarkdownRenderer
        content={'安全文本\n<img src="x" onerror="alert(1)"><script>alert(2)</script>'}
      />,
    );

    expect(screen.getByText(/安全文本/)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });
});
