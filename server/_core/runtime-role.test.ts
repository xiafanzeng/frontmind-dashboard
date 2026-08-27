import { describe, expect, it } from "vitest";
import {
  resolveFrontMindRuntimeRole,
  runtimeRoleRunsSiteOps,
  runtimeRoleServesWeb,
} from "./runtime-role";

describe("FrontMind runtime role", () => {
  it("keeps legacy installations combined when the role is absent", () => {
    expect(resolveFrontMindRuntimeRole(undefined)).toBe("combined");
  });

  it("isolates the public web and SiteOps worker responsibilities", () => {
    expect(runtimeRoleServesWeb(resolveFrontMindRuntimeRole("web"))).toBe(true);
    expect(runtimeRoleRunsSiteOps(resolveFrontMindRuntimeRole("web"))).toBe(false);
    expect(
      runtimeRoleServesWeb(resolveFrontMindRuntimeRole("siteops-worker")),
    ).toBe(false);
    expect(
      runtimeRoleRunsSiteOps(resolveFrontMindRuntimeRole("siteops-worker")),
    ).toBe(true);
  });

  it("fails closed for misspelled roles", () => {
    expect(() => resolveFrontMindRuntimeRole("worker")).toThrow(
      "FRONTMIND_RUNTIME_ROLE_INVALID",
    );
  });
});
