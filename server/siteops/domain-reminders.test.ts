import { describe, expect, it } from "vitest";

import { siteOpsDomainReminderCandidates } from "./domain-reminders";

describe("SiteOps domain reminders", () => {
  it("uses the nearest expiry boundary and does not produce every older reminder", () => {
    const reminders = siteOpsDomainReminderCandidates(
      {
        domain: "Example.COM",
        domainRevision: 3,
        expiresAt: new Date("2026-09-20T00:00:00.000Z"),
        autoRenewDesired: false,
        autoRenewObserved: false,
        dnsStatus: "active",
        connectionStatus: "active",
        hasLiveDeployment: true,
      },
      new Date("2026-08-22T00:00:00.000Z"),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      key: expect.stringContaining(":30"),
      kind: "domain_status",
    });
  });

  it("reports renewal, permission and live DNS drift without changing live state", () => {
    const reminders = siteOpsDomainReminderCandidates({
      domain: "example.com",
      domainRevision: 4,
      expiresAt: null,
      autoRenewDesired: true,
      autoRenewObserved: false,
      dnsStatus: "conflict",
      connectionStatus: "invalid",
      hasLiveDeployment: true,
    });
    expect(reminders.map((item) => item.key)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("auto-renew-drift"),
        expect.stringContaining("aliyun-permission-drift"),
        expect.stringContaining("dns-drift"),
      ]),
    );
  });

  it("does not warn about pending DNS before a site is live", () => {
    expect(
      siteOpsDomainReminderCandidates({
        domain: "example.com",
        domainRevision: 1,
        expiresAt: null,
        autoRenewDesired: false,
        autoRenewObserved: null,
        dnsStatus: "pending",
        connectionStatus: "unverified",
        hasLiveDeployment: false,
      }),
    ).toEqual([]);
  });
});
