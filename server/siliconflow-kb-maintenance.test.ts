import { describe, expect, it } from "vitest";

import {
  assertSiliconFlowMaintenanceIdentity,
  SILICONFLOW_MAINTENANCE_BRAND,
} from "./siliconflow-kb-maintenance";

describe("SiliconFlow one-time knowledge-base maintenance guard", () => {
  it("accepts only one explicit user whose formal and build names match", () => {
    expect(() =>
      assertSiliconFlowMaintenanceIdentity({
        userId: 42,
        userMatches: 1,
        dashboardBrandNames: [SILICONFLOW_MAINTENANCE_BRAND],
        buildCompanyNames: [" 硅基流动 ", "硅基流动"],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      userMatches: 0,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 2,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 1,
      dashboardBrandNames: [],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 1,
      dashboardBrandNames: ["另一企业"],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 1,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: [],
    },
    {
      userMatches: 1,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: ["另一企业"],
    },
  ])("aborts on zero, multiple or mismatched targets", (input) => {
    expect(() =>
      assertSiliconFlowMaintenanceIdentity({
        userId: 42,
        ...input,
      }),
    ).toThrow();
  });
});
