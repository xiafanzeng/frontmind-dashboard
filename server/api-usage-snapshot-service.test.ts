import { describe, expect, it } from "vitest";

import { apiUsageSeverity } from "./api-usage-snapshot-service";

describe("apiUsageSeverity", () => {
  it("warns exactly at 184,000 of the default 230,000 limit", () => {
    expect(
      apiUsageSeverity({
        used: 183_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("normal");
    expect(
      apiUsageSeverity({
        used: 184_000,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("warning");
  });

  it("becomes critical exactly at the configured limit", () => {
    expect(
      apiUsageSeverity({
        used: 229_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("warning");
    expect(
      apiUsageSeverity({
        used: 230_000,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("critical");
  });

  it("does not turn a failed or unconfigured sync into a usage alert", () => {
    expect(
      apiUsageSeverity({
        used: 999_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "error",
      }),
    ).toBe("unavailable");
  });
});
