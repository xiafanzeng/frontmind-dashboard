import { describe, expect, it } from "vitest";

import { siteOpsClientRequestId } from "./ConnectedSiteOpsConversationPanel";

describe("connected SiteOps request identity", () => {
  it("uses the delivery-compatible UUID form without a namespace prefix", () => {
    const requestId = siteOpsClientRequestId();

    expect(requestId).toHaveLength(36);
    expect(requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(requestId).not.toContain("siteops-");
  });
});
