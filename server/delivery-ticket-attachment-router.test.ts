import { describe, expect, it } from "vitest";

import { canCustomerDownloadTicketAttachment } from "./delivery-ticket-attachment-router";

describe("delivery ticket attachment authorization", () => {
  it("requires both ticket ownership and a customer-visible event", () => {
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 7,
        ticketUserId: 7,
        eventVisibility: "customer",
      }),
    ).toBe(true);
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 7,
        ticketUserId: 7,
        eventVisibility: "internal",
      }),
    ).toBe(false);
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 7,
        ticketUserId: 7,
        eventVisibility: null,
      }),
    ).toBe(false);
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 8,
        ticketUserId: 7,
        eventVisibility: "customer",
      }),
    ).toBe(false);
  });
});
