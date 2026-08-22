import { describe, expect, it } from "vitest";

import {
  domainFinancialTerminalProjection,
  exclusiveSiteOpsLiveHeadProjection,
  siteOpsWorkerMayClaimStatus,
  unexpectedSiteOpsProviderFailure,
} from "./worker";

describe("SiteOps mutually exclusive live heads", () => {
  it.each([
    [
      "global_excluding_cn",
      {
        globalLiveDeploymentId: "10000000-0000-4000-8000-000000000001",
        mainlandLiveDeploymentId: null,
      },
    ],
    [
      "mainland_cn",
      {
        globalLiveDeploymentId: null,
        mainlandLiveDeploymentId: "10000000-0000-4000-8000-000000000001",
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

describe("SiteOps worker claim boundary", () => {
  it("never reclaims a visual operation atomically cancelled by reset", () => {
    expect(siteOpsWorkerMayClaimStatus("queued")).toBe(true);
    expect(siteOpsWorkerMayClaimStatus("running")).toBe(true);
    expect(siteOpsWorkerMayClaimStatus("cancelled")).toBe(false);
    expect(siteOpsWorkerMayClaimStatus("failed")).toBe(false);
  });

  it("never persists or reflects an unexpected provider exception", () => {
    const secret = "21st_sk_must-never-reach-a-customer";
    const result = unexpectedSiteOpsProviderFailure();

    expect(result).toMatchObject({
      status: "attention_required",
      code: "PROVIDER_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.message).not.toContain("error.message");
  });
});
