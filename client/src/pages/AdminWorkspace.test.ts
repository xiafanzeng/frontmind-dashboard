import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_WORKSPACE_TAB_IDS,
  ADMIN_WORKSPACE_TABS,
  canCreateManagedCustomer,
} from "./AdminWorkspace";

describe("admin customer workspace", () => {
  it("allows both system and delivery administrators to create customers", () => {
    expect(canCreateManagedCustomer("system_admin")).toBe(true);
    expect(canCreateManagedCustomer("delivery_admin")).toBe(true);
    expect(canCreateManagedCustomer(null)).toBe(false);
    expect(canCreateManagedCustomer(undefined)).toBe(false);
  });

  it("places 工单与官网 between knowledge and delivery management", () => {
    expect(ADMIN_WORKSPACE_TAB_IDS).toEqual([
      "service",
      "knowledge",
      "tickets",
      "delivery",
      "credential",
      "activity",
    ]);
    expect(ADMIN_WORKSPACE_TABS.map((item) => item.label)).toEqual([
      "套餐与问题",
      "知识库流程",
      "工单与官网",
      "客户看板展示",
      "客户 Key 与积分",
      "操作记录",
    ]);
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
