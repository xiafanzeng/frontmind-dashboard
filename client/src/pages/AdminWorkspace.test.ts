import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_WORKSPACE_TAB_IDS,
  ADMIN_WORKSPACE_TABS,
  adminWorkspaceTabsForAccess,
  canCreateManagedCustomer,
} from "./AdminWorkspace";

describe("admin customer workspace", () => {
  it("allows both system and delivery administrators to create customers", () => {
    expect(canCreateManagedCustomer("system_admin")).toBe(true);
    expect(canCreateManagedCustomer("delivery_admin")).toBe(true);
    expect(canCreateManagedCustomer(null)).toBe(false);
    expect(canCreateManagedCustomer(undefined)).toBe(false);
  });

  it("keeps customer management in four focused workflow tabs", () => {
    expect(ADMIN_WORKSPACE_TAB_IDS).toEqual([
      "service",
      "knowledge",
      "tickets",
      "credential",
    ]);
    expect(ADMIN_WORKSPACE_TABS.map((item) => item.label)).toEqual([
      "用户流程",
      "知识库流程",
      "工单",
      "客户 Key 与积分",
    ]);
  });

  it("keeps delivery-admin coordination routes reachable without exposing execution tabs", () => {
    expect(
      adminWorkspaceTabsForAccess({
        isSystemAdmin: false,
        canViewSelectedUserUsage: false,
      }).map((tab) => tab.value),
    ).toEqual(["service", "tickets"]);

    expect(
      adminWorkspaceTabsForAccess({
        isSystemAdmin: false,
        canViewSelectedUserUsage: true,
      }).map((tab) => tab.value),
    ).toEqual(["service", "tickets", "credential"]);

    expect(
      adminWorkspaceTabsForAccess({
        isSystemAdmin: true,
        canViewSelectedUserUsage: true,
      }).map((tab) => tab.value),
    ).toEqual(["service", "knowledge", "tickets", "credential"]);
  });

  it("folds delivery content into service and removes the workspace audit tab", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain('{tab === "service" &&');
    expect(source).toContain("<DashboardSkeletonEditor");
    expect(source).toContain("<CustomerDashboardMirror");
    expect(source).toContain('heading="客户实际页面"');
    expect(source).toContain(
      'description="这里与客户账号看到的完整看板一致。"',
    );
    expect(source).toContain("websiteWorkspace={websiteWorkspacePreview}");
    expect(source).toContain("knowledgePreview={{");
    expect(source).not.toContain('{tab === "delivery"');
    expect(source).not.toContain('{tab === "activity"');
    expect(source).not.toContain("客户工作区操作记录");
    expect(source).not.toContain("只读验收");
    expect(source).not.toContain("/preview");
  });

  it("does not request or render the removed manual-order queue", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain(".manualOrders");
    expect(source).not.toContain("人工签约与开通待办");
    expect(source).not.toContain("ManualOrderCard");
  });

  it("keeps question review with the monitoring engineer and system-admin fallback", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain("editable={isSystemAdmin}");
    expect(source).toContain("canConfirm={isSystemAdmin}");
    expect(source).toContain("等待监控工程师确认");
    expect(source).toContain("系统管理员异常接管");
    expect(source).not.toContain("等待管理员确认");
  });

  it("does not render or submit order and contract identifiers", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain("订单 / 付款编号");
    expect(source).not.toContain("合同编号");
    expect(source).not.toContain("serviceOrderReference");
    expect(source).not.toContain("serviceContractReference");
    expect(source).not.toContain("新增签署或收款核验依据");
    expect(source).not.toContain("serviceEvidenceNote");
  });

  it("does not offer the removed knowledge-only service plan", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain('<option value="knowledge">');
  });

  it("keeps customer identity readable beside the assignment editor", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain("lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]");
    expect(source).toContain(
      'className="mt-1 truncate text-2xl font-semibold text-[#171321]"',
    );
    expect(source).toContain(
      'className="mt-2 truncate text-sm text-[#716a80]"',
    );
  });
});
