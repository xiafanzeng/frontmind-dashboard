import { describe, expect, it } from "vitest";

import {
  buildAdminTicketListInput,
  buildWebsiteContentOverview,
  deliveryTicketPublicStatus,
  flattenAdminTicketPages,
  formatAdminTicketDate,
  isCustomerVisibleEvent,
  mergeAdminTicketPages,
  normalizeAdminTicketList,
  normalizeTicketDetail,
  safeAdminDeliveryUrl,
  websiteContentTemplatePreflightUsable,
} from "./AdminDeliveryTicketWorkspace";

describe("administrator delivery ticket workspace contract", () => {
  it("builds only canonical server-side list filters", () => {
    expect(
      buildAdminTicketListInput({
        userId: 42,
        assignedAdminId: "7",
        query: "  验收企业  ",
        type: "website_operation",
        publicStatus: "pending",
        limit: 20,
      }),
    ).toEqual({
      userId: 42,
      assignedAdminId: 7,
      query: "验收企业",
      type: "website_operation",
      publicStatus: "pending",
      limit: 20,
    });

    expect(
      buildAdminTicketListInput({
        assignedAdminId: "all",
        type: "all",
        status: "all",
      }),
    ).toEqual({ limit: 20 });
  });

  it("maps legacy workflow statuses to the two public states", () => {
    expect(
      deliveryTicketPublicStatus({
        status: "needs_information",
        publicStatus: null,
      }),
    ).toBe("pending");
    expect(
      deliveryTicketPublicStatus({
        status: "rejected",
        publicStatus: null,
      }),
    ).toBe("completed");
    expect(
      deliveryTicketPublicStatus({
        status: "in_progress",
        publicStatus: "completed",
      }),
    ).toBe("completed");
  });

  it("builds the five customer website rows from the latest ticket in each category", () => {
    const overview = buildWebsiteContentOverview([
      {
        id: "company-old",
        type: "website_operation",
        category: "company_facts",
        status: "completed",
        revision: 1,
        updatedAt: "2026-07-01T00:00:00Z",
      },
      {
        id: "company-current",
        type: "website_operation",
        category: "company_facts",
        status: "in_progress",
        revision: 2,
        updatedAt: "2026-07-02T00:00:00Z",
      },
      {
        id: "faq-completed",
        type: "website_operation",
        category: "faq_content",
        status: "completed",
        revision: 1,
        publicSummary: "FAQ 页面已发布。",
        updatedAt: "2026-07-03T00:00:00Z",
      },
    ]);

    expect(overview).toHaveLength(5);
    expect(overview.find((item) => item.category === "company_facts")).toEqual(
      expect.objectContaining({
        status: "in_progress",
        ticket: expect.objectContaining({ id: "company-current" }),
      }),
    );
    expect(overview.find((item) => item.category === "faq_content")).toEqual(
      expect.objectContaining({
        status: "completed",
        ticket: expect.objectContaining({ publicSummary: "FAQ 页面已发布。" }),
      }),
    );
    expect(overview.find((item) => item.category === "industry_news")).toEqual(
      expect.objectContaining({ status: "not_started", ticket: null }),
    );
  });

  it("flattens cursor pages while retaining first-page workspace metadata", () => {
    const pages = [
      {
        tickets: [
          {
            id: "ticket-1",
            type: "content_asset",
            status: "submitted",
            revision: 1,
          },
        ],
        nextCursor: "opaque-cursor",
        quotas: { contentAssetPublish: { limit: 5 } },
        siteProfile: { domain: "example.com" },
      },
      {
        tickets: [
          {
            id: "ticket-1",
            type: "content_asset",
            status: "submitted",
            revision: 1,
          },
          {
            id: "ticket-2",
            type: "website_operation",
            status: "scheduled",
            revision: 2,
          },
        ],
        nextCursor: null,
      },
    ];

    expect(flattenAdminTicketPages(pages).map((ticket) => ticket.id)).toEqual([
      "ticket-1",
      "ticket-2",
    ]);
    expect(mergeAdminTicketPages(pages)).toMatchObject({
      tickets: [
        expect.objectContaining({ id: "ticket-1" }),
        expect.objectContaining({ id: "ticket-2" }),
      ],
      quotas: { contentAssetPublish: { limit: 5 } },
      siteProfile: { domain: "example.com" },
    });
  });

  it("normalizes either tickets or items without inventing customer data", () => {
    expect(
      normalizeAdminTicketList({
        tickets: [
          {
            id: "ticket-1",
            type: "website_operation",
            status: "scheduled",
            revision: 4,
            enterpriseName: "验收企业",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "ticket-1",
        type: "website_operation",
        status: "scheduled",
        revision: 4,
        enterpriseName: "验收企业",
      }),
    ]);

    expect(normalizeAdminTicketList({ tickets: [] })).toEqual([]);
  });

  it("keeps public customer events strictly separate from internal notes", () => {
    const detail = normalizeTicketDetail({
      ticket: {
        id: "ticket-1",
        type: "content_asset",
        status: "needs_information",
        revision: 2,
      },
      events: [
        {
          id: "public-1",
          visibility: "customer",
          message: "请补充图片授权。",
        },
        {
          id: "internal-1",
          visibility: "internal",
          message: "先核验授权主体。",
        },
      ],
    });

    expect(detail?.events.filter(isCustomerVisibleEvent)).toHaveLength(1);
    expect(
      detail?.events.filter((event) => event.visibility === "internal"),
    ).toHaveLength(1);
  });

  it("preserves structured delivery records from either supported response key", () => {
    const detail = normalizeTicketDetail({
      ticket: {
        id: "ticket-2",
        type: "website_operation",
        status: "completed",
        revision: 5,
      },
      deliveries: [
        {
          id: "delivery-1",
          platform: "百度站长平台",
          resultStatus: "pending_confirmation",
        },
      ],
    });

    expect(detail?.deliveryRecords).toEqual([
      expect.objectContaining({
        id: "delivery-1",
        platform: "百度站长平台",
        resultStatus: "pending_confirmation",
      }),
    ]);

    const eventBackedDetail = normalizeTicketDetail({
      ticket: {
        id: "ticket-3",
        type: "website_operation",
        status: "in_progress",
        revision: 3,
      },
      events: [
        {
          id: "event-operation-1",
          visibility: "customer",
          createdAt: "2026-07-27T10:00:00+08:00",
          operationResult: {
            platform: "必应站长平台",
            targetUrl: "https://example.com/news/1",
            resultStatus: "success",
          },
        },
      ],
    });

    expect(eventBackedDetail?.deliveryRecords).toEqual([
      expect.objectContaining({
        id: "event-operation-1",
        platform: "必应站长平台",
        resultStatus: "success",
      }),
    ]);
  });

  it("formats administrator timestamps in Beijing time", () => {
    expect(formatAdminTicketDate("2026-07-27T02:00:00Z")).toContain(
      "2026/07/27",
    );
    expect(formatAdminTicketDate("not-a-date")).toBe("时间未记录");
  });

  it("only turns http(s) and same-origin attachment paths into links", () => {
    expect(
      safeAdminDeliveryUrl(
        "/api/delivery-ticket-attachments/opaque-id/content",
        "https://dashboard.frontmind.net",
      ),
    ).toBe("/api/delivery-ticket-attachments/opaque-id/content");
    expect(
      safeAdminDeliveryUrl(
        "https://example.com/result",
        "https://dashboard.frontmind.net",
      ),
    ).toBe("https://example.com/result");
    expect(
      safeAdminDeliveryUrl(
        "javascript:alert(1)",
        "https://dashboard.frontmind.net",
      ),
    ).toBeNull();
  });

  it("only accepts an unexpired website-content preflight credential", () => {
    const now = Date.parse("2026-07-28T00:00:00.000Z");
    expect(
      websiteContentTemplatePreflightUsable(
        {
          preflightToken: "signed-token",
          preflightExpiresAt: "2026-07-28T00:01:00.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      websiteContentTemplatePreflightUsable(
        {
          preflightToken: "signed-token",
          preflightExpiresAt: "2026-07-28T00:00:04.000Z",
        },
        now,
      ),
    ).toBe(false);
    expect(
      websiteContentTemplatePreflightUsable(
        { preflightExpiresAt: "2026-07-28T00:01:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
});
