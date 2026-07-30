import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  projectTeamConfigurationHref,
  ticketNeedsProjectEngineer,
} from "./AdminDeliveryDispatch";

describe("project-based delivery dispatch", () => {
  it("links an unassigned ticket to the matching project role", () => {
    expect(
      projectTeamConfigurationHref(42, "monitoring_optimization_engineer"),
    ).toBe(
      "/admin/delivery-roles?customer=42&role=monitoring_optimization_engineer",
    );
  });

  it("treats only domain tickets without an assigned engineer as pending", () => {
    expect(
      ticketNeedsProjectEngineer({
        workflowDomain: "ai_operations_engineer",
        assignedMemberId: null,
      }),
    ).toBe(true);
    expect(
      ticketNeedsProjectEngineer({
        workflowDomain: "ai_operations_engineer",
        assignedMemberId: 12,
      }),
    ).toBe(false);
    expect(
      ticketNeedsProjectEngineer({
        workflowDomain: null,
        assignedMemberId: null,
      }),
    ).toBe(false);
  });

  it("removes direct team and member assignment controls", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDeliveryDispatch.tsx"),
      "utf8",
    );

    expect(source).not.toContain("选择团队");
    expect(source).not.toContain("选择负责人");
    expect(source).toContain("配置项目岗位");
    expect(source).toContain("保存优先级");
  });
});
