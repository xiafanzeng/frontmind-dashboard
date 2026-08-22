import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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

  it("has a current deterministic FrontMind 1.3.0 search-only manifest", async () => {
    const generated = await createSiteOpsRuntimeManifest();
    expect(generated).toMatchObject({
      version: "1.3.0",
      upstream: { archiveSha256: SITEOPS_UPSTREAM_SHA256 },
      host: {
        starterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        componentLibraryVersion: "1.0.0",
        materializerVersion: "1.0.0",
        materializerSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    await expect(verifySiteOpsRuntimeWorkflow()).resolves.toEqual(generated);
    const runtime = JSON.parse(
      await readFile(
        "private-workflows/astro-company-site-workflow-v1.3.0/runtime-contract.json",
        "utf8",
      ),
    );
    expect(runtime.visualProvider).toEqual({
      owner: "dashboard",
      name: "21st",
      requiredTools: ["search"],
      optionalTools: ["get_component"],
      promptRequired: false,
      providerCodeReuse: false,
    });
  });
});
