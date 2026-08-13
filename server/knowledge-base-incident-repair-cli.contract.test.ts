import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("signed-image incident repair CLI integration boundary", () => {
  it("keeps one advisory lock, silences dependency output, and imports no provider client", () => {
    const entrypoint = read("server/knowledge-base-incident-repair-cli.ts");
    expect(
      entrypoint.match(/SELECT GET_LOCK\(\?, 0\) AS acquired/gu),
    ).toHaveLength(1);
    expect(
      entrypoint.match(/SELECT RELEASE_LOCK\(\?\) AS released/gu),
    ).toHaveLength(1);
    expect(entrypoint).toContain("installOutputSilencer");
    expect(entrypoint).toContain("process.stdout.write = (() => true)");
    expect(entrypoint).toContain(
      "serializeKnowledgeBaseIncidentRepairCliResult",
    );
    expect(entrypoint).toContain("reset-pollution-preview");
    expect(entrypoint).toContain("reset-pollution-apply");
    expect(entrypoint).toContain("previewResetPollutionCleanup");
    expect(entrypoint).toContain("executeResetPollutionCleanup");
    expect(entrypoint).toContain(
      "FRONTMIND_RESET_POLLUTION_OFFLINE_MAINTENANCE",
    );
    expect(entrypoint.match(/closeDbForOneShotMaintenance\(\)/gu)).toHaveLength(
      3,
    );
    expect(entrypoint).not.toMatch(
      /from ["'][^"']*(?:manus|upstream)[^"']*["']/u,
    );
    expect(entrypoint).not.toContain("MANUS_API_KEY");
    expect(entrypoint).not.toContain("createSession");
  });

  it("exposes no raw capability apply and keeps the administrator router unchanged", () => {
    const service = read("server/knowledge-base-incident-repair.ts");
    const adminRouter = read("server/admin-router.ts");
    expect(service).toContain(
      "const SIGNED_IMAGE_MAINTENANCE_AUTHORITY = Symbol(",
    );
    expect(service).toContain(
      "function applyKnowledgeBaseIncidentRepairWithSignedImageAuthority(",
    );
    expect(service).not.toContain(
      "export function applyKnowledgeBaseIncidentRepairWithSignedImageAuthority",
    );
    expect(service).toContain(
      "export function executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance(",
    );
    expect(adminRouter).not.toContain(
      "executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance",
    );
    expect(adminRouter).not.toContain("SIGNED_IMAGE_MAINTENANCE_AUTHORITY");
  });

  it("bundles to one silent JSON-producing executable", () => {
    const bundleRoot = mkdtempSync(
      resolve(process.cwd(), ".kb-repair-cli-bundle-"),
    );
    const outfile = join(bundleRoot, "knowledge-base-incident-repair-cli.js");
    try {
      const bundled = spawnSync(
        "pnpm",
        [
          "exec",
          "esbuild",
          "server/knowledge-base-incident-repair-cli.ts",
          "--platform=node",
          "--packages=external",
          "--bundle",
          "--format=esm",
          `--outfile=${outfile}`,
          '--define:process.env.NODE_ENV="production"',
          '--define:process.env.FRONTMIND_RELEASE_CHANNEL="production"',
          `--define:__FRONTMIND_BUILD_SHA__="${"a".repeat(40)}"`,
          '--define:__FRONTMIND_RELEASE_CHANNEL__="production"',
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(bundled.status, bundled.stderr).toBe(0);
      const bundle = readFileSync(outfile, "utf8");
      expect(bundle).not.toContain("RUNTIME_ENV_OK");
      expect(bundle).not.toContain("RELEASE_CHANNEL_COMMAND_REQUIRED");

      const result = spawnSync(process.execPath, [outfile], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  });
});
