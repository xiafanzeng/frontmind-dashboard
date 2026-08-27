import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("static application boot shell", () => {
  const html = readFileSync(
    resolve(process.cwd(), "client/index.html"),
    "utf8",
  );

  it("renders useful content before React starts", () => {
    expect(html).toContain('id="frontmind-boot-shell"');
    expect(html).toContain("正在打开 FrontMind 工作空间");
    expect(html).toContain('id="frontmind-boot-reload"');
  });

  it("surfaces stalled resources within ten seconds and can be cancelled by React", () => {
    expect(html).toContain("window.setTimeout(showFailure, 10_000)");
    expect(html).toContain('"frontmind:booted"');
    expect(html).toContain("页面资源未能正常启动");
    expect(html).toContain("window.location.reload()");
  });
});
