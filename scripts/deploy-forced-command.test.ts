import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const wrapper = path.resolve(
  "deploy/production/controller/frontmind-deploy-forced-command",
);
const digest = `ghcr.io/xiafanzeng/frontmind-dashboard@sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);

describe("fixed-service deploy SSH command", () => {
  let binDir: string;

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), "frontmind-deploy-command-"));
    await writeFile(
      path.join(binDir, "sudo"),
      "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\"\n",
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  function run(fixedService: string, command: string) {
    return spawnSync("bash", [wrapper, fixedService], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SSH_ORIGINAL_COMMAND: command,
      },
    });
  }

  it("injects Dashboard from authorized_keys rather than accepting a service token", () => {
    const result = run("dashboard", `${digest} ${sourceSha}`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `-n /usr/local/sbin/frontmind-deploy-controller dashboard ${digest} ${sourceSha}`,
    );
  });

  it("rejects attempts to choose or add another service", () => {
    for (const command of [
      `website ${digest} ${sourceSha}`,
      `deploy dashboard ${digest} ${sourceSha}`,
      `${digest} ${sourceSha} extra`,
    ]) {
      const result = run("dashboard", command);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("DEPLOY_COMMAND_REJECTED");
    }
  });

  it("rejects mutable tags and malformed source identities", () => {
    expect(
      run("website", `ghcr.io/x/frontmind-website:latest ${sourceSha}`).status,
    ).toBe(64);
    expect(run("website", `${digest} not-a-sha`).status).toBe(64);
  });
});
