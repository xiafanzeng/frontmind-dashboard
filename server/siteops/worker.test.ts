import { describe, expect, it } from "vitest";

import {
  domainFinancialTerminalProjection,
  exclusiveSiteOpsLiveHeadProjection,
} from "./worker";

describe("SiteOps mutually exclusive live heads", () => {
  it.each([
    [
      "global_excluding_cn",
      {
        globalLiveDeploymentId:
          "10000000-0000-4000-8000-000000000001",
        mainlandLiveDeploymentId: null,
      },
    ],
    [
      "mainland_cn",
      {
        globalLiveDeploymentId: null,
        mainlandLiveDeploymentId:
          "10000000-0000-4000-8000-000000000001",
      },
    ],
  ] as const)("activates only the %s mode", (target, expected) => {
    expect(
      exclusiveSiteOpsLiveHeadProjection(
        target,
        "10000000-0000-4000-8000-000000000001",
      ),
    ).toEqual(expected);
  });
});

describe("SiteOps financial terminal state", () => {
  it("releases known success/failure and retains manual reconciliation", () => {
    expect(domainFinancialTerminalProjection("succeeded")).toEqual({
      status: "succeeded",
      activeFinancialKey: null,
    });
    expect(domainFinancialTerminalProjection("failed")).toEqual({
      status: "failed",
      activeFinancialKey: null,
    });
    expect(domainFinancialTerminalProjection("attention_required")).toEqual({
      status: "attention_required",
    });
  });
});
