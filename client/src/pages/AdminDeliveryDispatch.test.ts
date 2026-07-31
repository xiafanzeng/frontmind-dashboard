import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  filterDispatchTickets,
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

  it("merges the all-status overview and completed history into dispatch", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDeliveryDispatch.tsx"),
      "utf8",
    );

    expect(source).toContain("<CardTitle>交付工单总览与筛选</CardTitle>");
    expect(source).toContain("<CardTitle>已结束工单</CardTitle>");
    expect(source).toContain("data?.completedTickets");
    expect(source).toContain("<CompletedDispatchRow");
    expect(source).toContain("保存优先级");
  });

  it("filters the merged queue by customer text, status, type, and role", () => {
    const tickets = [
      {
        id: "1",
        userId: 42,
        type: "knowledge_base",
        title: "知识库复核",
        status: "completed",
        workflowDomain: "ai_operations_engineer",
        assignedMemberId: 9,
        priority: "normal",
      },
      {
        id: "2",
        userId: 43,
        type: "content_asset",
        title: "FAQ 发布",
        status: "in_progress",
        workflowDomain: "content_distribution_engineer",
        assignedMemberId: 10,
        priority: "high",
      },
    ] as any;
    const projects = [
      {
        id: 42,
        username: "alpha",
        displayName: "甲公司",
        managerId: 7,
      },
      { id: 43, username: "beta", displayName: "乙公司", managerId: 8 },
    ];

    expect(
      filterDispatchTickets(tickets, projects, {
        query: "甲公司",
        type: "knowledge_base",
        status: "completed",
        role: "ai_operations_engineer",
        managerId: "7",
      }).map((ticket) => ticket.id),
    ).toEqual(["1"]);
  });
});
