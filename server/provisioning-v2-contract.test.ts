import { describe, expect, it } from "vitest";

import { websitePurchaseRequestV2Schema } from "../shared/provisioning-v2";

describe("website purchase provisioning v2 contract", () => {
  it("accepts a 30-day basic purchase without a password or userId", () => {
    const value = websitePurchaseRequestV2Schema.parse({
      schemaVersion: 2,
      project: {
        id: "project-basic-001",
        companyName: "示例企业",
      },
      order: {
        id: "order-basic-001",
        tradeNo: "trade-basic-001",
        status: "paid",
        amountFen: 150000,
        paidAt: "2026-07-26T00:00:00.000Z",
      },
      service: {
        planCode: "basic",
        serviceDays: 30,
        startsAt: "2026-07-26T00:00:00.000Z",
        endsAt: "2026-08-25T00:00:00.000Z",
        purchasedQuestion: {
          id: "question-basic-001",
          category: "product_scenario",
          question: "如何选择适合当前生产场景的解决方案？",
        },
      },
      contract: {
        id: "contract-basic-001",
        status: "pending_admin_confirmation",
        projectId: "project-basic-001",
        orderId: "order-basic-001",
        questionId: "question-basic-001",
        templateVersion: "geo-basic-v2",
        evidence: {
          type: "system_admin_confirmation",
          artifact: {
            taskId: null,
            fileId: null,
            outputDescriptor: null,
            sha256: null,
          },
        },
      },
      account: {
        mode: "create",
        username: "example.customer",
        displayName: "示例企业",
      },
    });
    expect(value.account).not.toHaveProperty("password");
    expect(value).not.toHaveProperty("userId");
  });
});
