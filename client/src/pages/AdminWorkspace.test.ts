import { describe, expect, it } from "vitest";

import {
  ADMIN_WORKSPACE_TAB_IDS,
  ADMIN_WORKSPACE_TABS,
  canCreateManagedCustomer,
  isSecureSigningUrl,
  manualOrderPrimaryAction,
  validateManualOrderPdf,
  type ManualOrderStatus,
} from "./AdminWorkspace";

describe("manual service order workflow guards", () => {
  it("shows customer creation only to a system administrator", () => {
    expect(canCreateManagedCustomer(true)).toBe(true);
    expect(canCreateManagedCustomer(false)).toBe(false);
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
      "内容、监控与报告",
      "共享 Key 与积分",
      "操作记录",
    ]);
  });

  it.each([
    ["pending_admin", "prepare"],
    ["signature_required", "confirm_signed"],
    ["payment_required", "wait_payment"],
    ["account_setup_required", "wait_account"],
    ["activation_required", "activate"],
    ["active", null],
  ] satisfies Array<
    [ManualOrderStatus, ReturnType<typeof manualOrderPrimaryAction>]
  >)("exposes only the legal primary action for %s", (status, action) => {
    expect(manualOrderPrimaryAction(status)).toBe(action);
  });

  it("accepts only absolute HTTPS signing links", () => {
    expect(isSecureSigningUrl("https://sign.example.com/order/123")).toBe(true);
    expect(isSecureSigningUrl(" http://sign.example.com/order/123 ")).toBe(
      false,
    );
    expect(isSecureSigningUrl("javascript:alert(1)")).toBe(false);
    expect(isSecureSigningUrl("/relative/signing-path")).toBe(false);
    expect(isSecureSigningUrl("not a URL")).toBe(false);
  });

  it("accepts a non-empty PDF no larger than 20 MB", () => {
    const pdf = new File(["signed"], "signed-contract.pdf", {
      type: "application/pdf",
    });
    const exactLimitPdf = new File(["signed"], "signed-contract.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(exactLimitPdf, "size", {
      value: 20 * 1024 * 1024,
    });

    expect(validateManualOrderPdf(pdf)).toBe("");
    expect(validateManualOrderPdf(exactLimitPdf)).toBe("");
  });

  it("rejects a missing, empty, non-PDF, or oversized signing artifact", () => {
    const emptyPdf = new File([], "empty.pdf", { type: "application/pdf" });
    const wrongExtension = new File(["signed"], "signed.txt", {
      type: "application/pdf",
    });
    const wrongMime = new File(["signed"], "signed.pdf", {
      type: "text/plain",
    });
    const oversizedPdf = new File(["signed"], "signed.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(oversizedPdf, "size", {
      value: 20 * 1024 * 1024 + 1,
    });

    expect(validateManualOrderPdf(undefined)).toContain("请选择");
    expect(validateManualOrderPdf(emptyPdf)).toContain("为空");
    expect(validateManualOrderPdf(wrongExtension)).toContain("仅支持 PDF");
    expect(validateManualOrderPdf(wrongMime)).toContain("仅支持 PDF");
    expect(validateManualOrderPdf(oversizedPdf)).toContain("20 MB");
  });
});
