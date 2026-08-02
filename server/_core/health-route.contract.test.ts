import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("runtime health route contract", () => {
  it("keeps liveness lightweight and isolates database work in readiness", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const healthStart = source.indexOf('app.get("/healthz"');
    const readinessStart = source.indexOf('app.get("/readyz"', healthStart);

    expect(healthStart).toBeGreaterThan(-1);
    expect(readinessStart).toBeGreaterThan(healthStart);
    expect(source).toMatch(
      /runtimeIdentity\.buildSourceSha !== applicationBuildSha[\s\S]*FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_MISMATCH/u,
    );
    const healthRoute = source.slice(healthStart, readinessStart);
    expect(healthRoute).toContain("res.status(200).json");
    expect(healthRoute).not.toMatch(
      /\b(?:await|getDb|evaluateKnowledgeBaseReadiness|evaluateReleaseReadiness|verifyCurrentReleaseArtifact)\b/u,
    );
    expect(source.slice(readinessStart)).toMatch(
      /\bgetDb\(\)[\s\S]*\bevaluateReleaseReadiness\(/u,
    );
  });
});
