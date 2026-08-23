import { describe, expect, it } from "vitest";

import {
  siteOpsRebuildBuildId,
  siteOpsRebuildDeliveryClientRequestId,
  siteOpsRebuildDedupeKey,
  siteOpsRebuildTargetPage,
} from "./rebuild-ticket";

describe("SiteOps rebuild ticket coordinates", () => {
  const buildId = "10000000-0000-4000-8000-000000000001";

  it("binds the ticket to one exact immutable source build", () => {
    expect(siteOpsRebuildDedupeKey(buildId)).toBe(`site-rebuild:${buildId}`);
    expect(siteOpsRebuildBuildId(siteOpsRebuildTargetPage(buildId))).toBe(
      buildId,
    );
  });

  it("rejects arbitrary pages and malformed build ids", () => {
    expect(siteOpsRebuildBuildId("https://example.com/siteops/builds/x")).toBe(
      null,
    );
    expect(siteOpsRebuildBuildId("/siteops/builds/not-a-uuid")).toBe(null);
  });

  it("maps every accepted SiteOps request id to one deterministic delivery UUID", () => {
    const shared = {
      userId: 27,
      projectId: "20000000-0000-4000-8000-000000000002",
    };
    const prefixedRequestId = "siteops-10000000-0000-4000-8000-000000000001";
    const longRequestId = "request-".padEnd(128, "x");
    const prefixed = siteOpsRebuildDeliveryClientRequestId({
      ...shared,
      clientRequestId: prefixedRequestId,
    });

    expect(prefixedRequestId).toHaveLength(44);
    expect(longRequestId).toHaveLength(128);
    expect(prefixed).toHaveLength(36);
    expect(prefixed).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        clientRequestId: prefixedRequestId,
      }),
    ).toBe(prefixed);
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        clientRequestId: longRequestId,
      }),
    ).not.toBe(prefixed);
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        projectId: "30000000-0000-4000-8000-000000000003",
        clientRequestId: prefixedRequestId,
      }),
    ).not.toBe(prefixed);
  });
});
