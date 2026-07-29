import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adminNav,
  canCreateCustomerFromDashboard,
  channelDistributionUrl,
  filterApiKeyUsageForAdmin,
  filterPreviewApiKeyUsageForAdmin,
  filterPreviewTicketsForAdmin,
  getAdminNav,
  getPreviewAdminNav,
  getPreviewAdminWorkspaceHref,
  issueMonitorUrl,
  normalizeApiKeyUsageAlerts,
  normalizeUsageHierarchy,
} from "./AdminDashboard";
import { previewAdminNav } from "@/lib/preview-navigation";

describe("administrator channel navigation", () => {
  it.each([
    ["real", adminNav],
    ["preview", previewAdminNav],
  ])(
    "keeps the unified administrator navigation order in %s",
    (_name, navigation) => {
      expect(navigation.map((item) => item.label)).toEqual([
        "交付总览",
        "客户交付工作台",
        "FrontMind Agent",
        "官网任务与积分",
        "账号与权限",
        "问题监控",
        "渠道分发",
      ]);
    },
  );

  it.each([
    ["real", adminNav],
    ["preview", previewAdminNav],
  ])(
    "places the channel distribution link after issue monitoring in %s navigation",
    (_name, navigation) => {
      const issueIndex = navigation.findIndex(
        (item) => item.href === issueMonitorUrl,
      );
      const distributionIndex = navigation.findIndex(
        (item) => item.href === channelDistributionUrl,
      );
      const issueMonitor = navigation[issueIndex];
      const distribution = navigation[distributionIndex];

      expect(issueIndex).toBeGreaterThanOrEqual(0);
      expect(distributionIndex).toBe(issueIndex + 1);
      expect(issueMonitor).toMatchObject({
        label: "问题监控",
        external: true,
        newWindow: true,
      });
      expect(distribution).toMatchObject({
        label: "渠道分发",
        external: true,
        newWindow: true,
      });
    },
  );

  it.each([
    ["real", adminNav, "/admin/agent"],
    ["preview", previewAdminNav, "/preview/admin/agent"],
  ])(
    "uses one FrontMind Agent entry and no fixed workflow entry in %s navigation",
    (_name, navigation, agentHref) => {
      expect(
        navigation.filter((item) => item.label === "FrontMind Agent"),
      ).toEqual([
        expect.objectContaining({
          href: agentHref,
        }),
      ]);
      expect(
        navigation.some(
          (item) =>
            item.label.includes("流程编排") || item.href.includes("workflow"),
        ),
      ).toBe(false);
    },
  );

  it("keeps FrontMind Agent available to delivery administrators", () => {
    const deliveryAdminNavigation = getAdminNav(false);

    expect(
      deliveryAdminNavigation.some((item) => item.href === "/admin/agent"),
    ).toBe(true);
    expect(
      deliveryAdminNavigation.some((item) => item.href === "/admin/users"),
    ).toBe(true);
    expect(
      deliveryAdminNavigation.find((item) => item.href === "/admin/users"),
    ).toMatchObject({
      label: "创建客户账号",
      group: "客户与服务",
    });
    expect(
      deliveryAdminNavigation.some((item) => item.href === "/admin/presales"),
    ).toBe(false);
  });

  it("keeps delivery and system acceptance pages permission-distinct", () => {
    const deliveryNavigation = getPreviewAdminNav(false);
    const systemNavigation = getPreviewAdminNav(true);

    expect(deliveryNavigation[0]?.href).toBe("/preview/admin/delivery");
    expect(deliveryNavigation[1]?.href).toBe(
      "/preview/admin/delivery/workspace",
    );
    expect(
      deliveryNavigation.some(
        (item) => item.href === "/preview/admin/delivery/agent",
      ),
    ).toBe(true);
    expect(
      deliveryNavigation.some(
        (item) =>
          item.href === "/preview/admin/accounts" ||
          item.href === "/preview/admin/presales",
      ),
    ).toBe(false);
    expect(systemNavigation[0]?.href).toBe("/preview/admin/system");
    expect(
      systemNavigation.some(
        (item) => item.href === "/preview/admin/system/accounts",
      ),
    ).toBe(true);
    expect(
      systemNavigation.some(
        (item) => item.href === "/preview/admin/system/workspace",
      ),
    ).toBe(true);
  });

  it("keeps workspace and ticket links in the current preview role", () => {
    expect(getPreviewAdminWorkspaceHref(false)).toBe(
      "/preview/admin/delivery/workspace",
    );
    expect(getPreviewAdminWorkspaceHref(false, "?tab=tickets")).toBe(
      "/preview/admin/delivery/workspace?tab=tickets",
    );
    expect(getPreviewAdminWorkspaceHref(true)).toBe(
      "/preview/admin/system/workspace",
    );
    expect(getPreviewAdminWorkspaceHref(true, "action=create")).toBe(
      "/preview/admin/system/workspace?action=create",
    );
  });

  it("allows only the system administrator to create customer accounts", () => {
    expect(canCreateCustomerFromDashboard(false)).toBe(false);
    expect(canCreateCustomerFromDashboard(true)).toBe(true);
  });

  it("uses a concise delivery overview with toolbar actions and no marketing banner", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDashboard.tsx"),
      "utf8",
    );
    expect(source).toContain('title="交付总览"');
    expect(source).toContain("打开客户交付工作台");
    expect(source).toContain("创建客户");
    expect(source).toContain("管理员自用 Agent 积分");
    expect(source).not.toContain("管理员通用 Agent");
    expect(source).not.toContain("从客户签约到交付验收的统一工作台");
    expect(source).not.toContain(
      "套餐权益、知识库流程、选题、应答逻辑、问题监控",
    );
  });

  it("normalizes API Key snapshots with independent default policies", () => {
    expect(
      normalizeApiKeyUsageAlerts({
        items: [
          {
            id: "website",
            scope: "website_frontend",
            used: 184000,
            limit: 230000,
            warningRatio: 0.8,
            windowDays: 30,
            syncStatus: "ok",
          },
          {
            id: "customer",
            scope: "managed_user",
            userId: 8,
            enterpriseName: "示例企业",
            used: 12,
            syncStatus: "error",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "website",
        scope: "website_frontend",
        used: 184000,
        limit: 230000,
      }),
      expect.objectContaining({
        id: "customer",
        scope: "managed_user",
        userId: 8,
        limit: 230000,
      }),
    ]);
  });

  it("never exposes the global website key to a delivery administrator", () => {
    const alerts = normalizeApiKeyUsageAlerts({
      items: [
        {
          id: "website",
          scope: "website_frontend",
          used: 184000,
          syncStatus: "ok",
        },
        {
          id: "customer",
          scope: "managed_user",
          userId: 8,
          used: 12000,
          syncStatus: "ok",
        },
      ],
    });

    expect(filterApiKeyUsageForAdmin(alerts, false)).toEqual([
      expect.objectContaining({ id: "customer", scope: "managed_user" }),
    ]);
    expect(filterApiKeyUsageForAdmin(alerts, true)).toHaveLength(2);
    expect(filterPreviewApiKeyUsageForAdmin(alerts, false, [9])).toEqual([]);
    expect(filterPreviewApiKeyUsageForAdmin(alerts, false, [8])).toEqual([
      expect.objectContaining({ id: "customer", userId: 8 }),
    ]);
    expect(filterPreviewApiKeyUsageForAdmin(alerts, true, [])).toHaveLength(2);
  });

  it("keeps delivery administrators separate even when they share one upstream Key", () => {
    const hierarchy = normalizeUsageHierarchy({
      period: { label: "2026 年 7 月" },
      managers: [
        {
          adminId: 11,
          displayName: "交付一组",
          keyPool: { fingerprint: "fp_shared", totalUsed: 1_000 },
          ownAgentMonthUsed: 120,
          attributedUsed: 420,
          otherOrUnattributedUsed: 580,
          users: [{ userId: 101, enterpriseName: "甲公司", monthUsed: 300 }],
        },
        {
          adminId: 12,
          displayName: "交付二组",
          keyPool: { fingerprint: "fp_shared", totalUsed: 1_000 },
          ownAgentMonthUsed: 80,
          attributedUsed: 280,
          otherOrUnattributedUsed: 720,
          users: [{ userId: 102, enterpriseName: "乙公司", monthUsed: 200 }],
        },
      ],
    });

    expect(hierarchy.managers).toHaveLength(2);
    expect(hierarchy.managers.map((manager) => manager.adminId)).toEqual([
      11, 12,
    ]);
    expect(hierarchy.managers[0]?.users[0]?.monthUsed).toBe(300);
    expect(hierarchy.managers[1]?.users[0]?.monthUsed).toBe(200);
    expect(
      hierarchy.managers.map((manager) => manager.keyPool.totalUsed),
    ).toEqual([1_000, 1_000]);
  });

  it("does not expose another manager's preview tickets to a delivery administrator", () => {
    const tickets = [
      {
        id: "own",
        assignedAdminId: 101,
        assignedAdminName: "当前管理员",
      },
      {
        id: "shared",
        assignedAdmins: [
          { id: 101, name: "当前管理员" },
          { id: 102, name: "协作管理员" },
        ],
      },
      {
        id: "other",
        assignedAdminId: 103,
        assignedAdminName: "其他管理员",
      },
    ];

    expect(
      filterPreviewTicketsForAdmin(tickets, false, "101").map(
        (ticket) => ticket.id,
      ),
    ).toEqual(["own", "shared"]);
    expect(filterPreviewTicketsForAdmin(tickets, true, "101")).toEqual(tickets);
  });
});
