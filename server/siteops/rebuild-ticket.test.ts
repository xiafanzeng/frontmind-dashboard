import { describe, expect, it } from "vitest";

import {
  siteOpsRebuildBuildId,
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
});
