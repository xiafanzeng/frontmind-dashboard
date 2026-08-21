import { describe, expect, it } from "vitest";
import {
  SITEOPS_UPSTREAM_SHA256,
  createSiteOpsRuntimeManifest,
  verifySiteOpsRuntimeWorkflow,
  verifyUpstreamSiteOpsWorkflow,
} from "./package-siteops-workflow.mjs";

describe("SiteOps runtime workflow package", () => {
  it("retains and verifies the exact read-only upstream 1.0.0 archive", async () => {
    await expect(verifyUpstreamSiteOpsWorkflow()).resolves.toEqual({
      archiveHash: SITEOPS_UPSTREAM_SHA256,
      files: 58,
    });
  });

  it("has a current deterministic FrontMind 1.1.0 manifest", async () => {
    const generated = await createSiteOpsRuntimeManifest();
    expect(generated).toMatchObject({
      version: "1.1.0",
      upstream: { archiveSha256: SITEOPS_UPSTREAM_SHA256 },
    });
    await expect(verifySiteOpsRuntimeWorkflow()).resolves.toEqual(generated);
  });
});
