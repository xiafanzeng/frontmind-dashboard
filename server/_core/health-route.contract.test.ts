import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("runtime health route contract", () => {
  it("keeps liveness lightweight and isolates database work in readiness", async () => {
    const [source, releaseChannelAdapter] = await Promise.all([
      fs.readFile(path.resolve("server/_core/index.ts"), "utf8"),
      fs.readFile(
        path.resolve("server/_core/release-channel-adapter.ts"),
        "utf8",
      ),
    ]);
    const healthStart = source.indexOf('app.get("/healthz"');
    const readinessStart = source.indexOf('app.get("/readyz"', healthStart);

    expect(healthStart).toBeGreaterThan(-1);
    expect(readinessStart).toBeGreaterThan(healthStart);
    expect(source).toContain("validateReleaseRuntimeEnvironment");
    expect(releaseChannelAdapter).toMatch(
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

  it("runs and caches file-retention evidence before binding the listener", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const lifecycleBackfill = source.indexOf(
      "prepareFileContentRetentionForServing()",
    );
    const retentionPreflight = source.indexOf(
      "inspectFileRetentionPreflight()",
      lifecycleBackfill,
    );
    const listener = source.indexOf("server.listen(", retentionPreflight);
    const cleanupScheduler = source.indexOf(
      "startFileContentRetentionScheduler(",
      listener,
    );
    const readinessStart = source.indexOf('app.get("/readyz"');

    expect(lifecycleBackfill).toBeGreaterThan(-1);
    expect(retentionPreflight).toBeGreaterThan(lifecycleBackfill);
    expect(listener).toBeGreaterThan(retentionPreflight);
    expect(cleanupScheduler).toBeGreaterThan(listener);
    expect(source.slice(readinessStart, listener)).toContain(
      "fileRetentionPreflightEvidence.read()",
    );
    expect(source.slice(readinessStart, listener)).toContain("fileRetention,");
  });

  it("reports monitor authentication without making it a core readiness gate", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const readyStart = source.indexOf("const ready =", readinessStart);
    const statusStart = source.indexOf("const status =", readyStart);
    const responseStart = source.indexOf("const response =", statusStart);

    expect(readinessStart).toBeGreaterThan(-1);
    expect(readyStart).toBeGreaterThan(readinessStart);
    expect(statusStart).toBeGreaterThan(readyStart);
    expect(source.slice(readyStart, statusStart)).not.toContain(
      "monitorCredential",
    );
    expect(source.slice(responseStart)).toContain(
      "monitorCredentialAuthenticated: monitorCredential.authenticated",
    );
  });

  it("exposes the non-secret knowledge-base tree writer policy in readiness", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const listener = source.indexOf("server.listen(", readinessStart);

    expect(source).toContain("knowledgeBaseNewBuildPolicyBinding()");
    expect(source.slice(readinessStart, listener)).toContain(
      "knowledgeBaseTreePolicyWriter",
    );
    expect(source).toContain('"[KnowledgeBase] tree_policy_writer"');
  });
});
