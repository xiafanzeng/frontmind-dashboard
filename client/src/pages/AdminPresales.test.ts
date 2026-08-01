import { describe, expect, it } from "vitest";

import { presalesUsageDisplayState } from "./AdminPresales";

describe("presalesUsageDisplayState", () => {
  it("hides every aggregate and percentage when the scan is incomplete", () => {
    expect(
      presalesUsageDisplayState({
        complete: false,
        keyTotalUsed: 98_765,
        websiteUsed: 12_345,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "—",
      websiteUsedLabel: "—",
      percentageLabel: "—",
      progressPercentage: 0,
    });
  });

  it("shows exact values only after a complete scan", () => {
    const display = presalesUsageDisplayState({
      complete: true,
      keyTotalUsed: 115_000,
      websiteUsed: 12_345,
      limit: 230_000,
    });
    expect(display.keyTotalLabel).not.toBe("—");
    expect(display.websiteUsedLabel).not.toBe("—");
    expect(display.percentageLabel).toBe("50%");
    expect(display.progressPercentage).toBe(50);
  });
});
