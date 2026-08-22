import { describe, expect, it } from "vitest";

import {
  domainFinancialTerminalProjection,
  exclusiveSiteOpsLiveHeadProjection,
  knownSiteOpsBuildFailure,
  siteOpsWorkerMayClaimStatus,
  siteOpsWorkerExecutionPolicy,
  terminalSiteOpsOperationProjection,
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
  it("gives Astro build and QA operations a lease longer than their handler timeout", () => {
    expect(siteOpsWorkerExecutionPolicy("site_build")).toEqual({
      timeoutMs: 10 * 60_000,
      leaseMs: 12 * 60_000,
    });
    expect(siteOpsWorkerExecutionPolicy("build_revision")).toEqual({
      timeoutMs: 10 * 60_000,
      leaseMs: 12 * 60_000,
    });
    expect(siteOpsWorkerExecutionPolicy("visual_search")).toEqual({
      timeoutMs: 90_000,
      leaseMs: 2 * 60_000,
    });
  });

  it("preserves an already-bound provider task and safe progress at terminal finalize", () => {
    expect(
      terminalSiteOpsOperationProjection(
        {
          providerOperationId: "provider-operation",
          providerTaskId: "provider-task",
          result: { stage: "repair_pending", repairAttempt: 3 },
        } as never,
        {
          status: "failed",
          code: "FRONTMIND_BUILD_OUTPUT_INVALID",
          message: "FrontMind AI 建站输出无效。",
        },
      ),
    ).toEqual({
      providerOperationId: "provider-operation",
      providerTaskId: "provider-task",
      result: { stage: "repair_pending", repairAttempt: 3 },
    });
  });

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

  it("retains a stable known build failure instead of relabeling it as unknown provider work", () => {
    const error = Object.assign(
      new Error("同一 FrontMind AI 建站任务修复后仍未通过结构校验。"),
      { code: "FRONTMIND_BUILD_OUTPUT_INVALID", status: "failed" },
    );
    expect(knownSiteOpsBuildFailure(error)).toEqual({
      status: "failed",
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: "同一 FrontMind AI 建站任务修复后仍未通过结构校验。",
    });
    expect(
      knownSiteOpsBuildFailure(
        Object.assign(new Error("配置不可用"), {
          code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
        }),
      ),
    ).toMatchObject({ status: "attention_required" });
  });
});
