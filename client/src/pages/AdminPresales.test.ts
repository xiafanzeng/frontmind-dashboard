import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { presalesUsageDisplayState } from "./AdminPresales";

describe("presalesUsageDisplayState", () => {
  it("does not contain the retired attribution or emergency-replacement gates", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).not.toContain("attributionComplete");
    expect(source).not.toContain("allowIncompleteHistory");
    expect(source).not.toContain("历史任务未能全部归因到官网");
  });
  it("keeps the locally recorded Website total visible without a Key pool snapshot", () => {
    expect(
      presalesUsageDisplayState({
        keyPoolTotalUsed: null,
        rollingWebsiteUsed: 12_345,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "—",
      websiteUsedLabel: "12,345",
      percentageLabel: "—",
      progressPercentage: 0,
    });
  });

  it("shows the latest Key pool snapshot independently from the rolling Website total", () => {
    const display = presalesUsageDisplayState({
      keyPoolTotalUsed: 115_000,
      rollingWebsiteUsed: 12_345,
      limit: 230_000,
    });
    expect(display.keyTotalLabel).not.toBe("—");
    expect(display.websiteUsedLabel).not.toBe("—");
    expect(display.percentageLabel).toBe("50%");
    expect(display.progressPercentage).toBe(50);
  });

  it("never gates the rolling Website total on account attribution", () => {
    expect(
      presalesUsageDisplayState({
        keyPoolTotalUsed: 216_314,
        rollingWebsiteUsed: 144_360,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "216,314",
      websiteUsedLabel: "144,360",
      percentageLabel: "94%",
      progressPercentage: 94,
    });
  });
});
