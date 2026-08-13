import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const source = path.resolve(
  "deploy/production/controller/frontmind-knowledge-base-incident-repair",
);
const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);
const journalHash = "c".repeat(64);
const image = `ghcr.io/xiafanzeng/frontmind-dashboard@${digest}`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness({ writer = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-repair-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const compose = path.join(root, "compose");
  const config = path.join(root, "dashboard.env");
  const composeEnv = path.join(root, "compose.env");
  const imageEnv = path.join(root, "image.env");
  const state = path.join(root, "state.json");
  const commandLog = path.join(root, "commands.log");
  await Promise.all([mkdir(bin), mkdir(compose)]);
  await Promise.all([
    writeFile(path.join(compose, "compose.yaml"), "services: {}\n"),
    writeFile(composeEnv, "FRONTMIND_DASHBOARD_HOST_PORT=3001\n", {
      mode: 0o600,
    }),
    writeFile(
      imageEnv,
      `FRONTMIND_DASHBOARD_IMAGE=${image}\nFRONTMIND_IMAGE_DIGEST=${digest}\nFRONTMIND_SOURCE_SHA=${sourceSha}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      state,
      `${JSON.stringify({
        currentDigest: digest,
        previousDigest: `sha256:${"d".repeat(64)}`,
        sourceSha,
        journalHash,
        deployedAt: "2026-08-13T00:00:00Z",
        lastResult: { status: "success" },
      })}\n`,
      { mode: 0o600 },
    ),
  ]);
  await writeFile(
    config,
    [
      "IMAGE_REPOSITORY=ghcr.io/xiafanzeng/frontmind-dashboard",
      "COSIGN_IDENTITY=https://github.com/xiafanzeng/frontmind-dashboard/.github/workflows/dashboard-ci.yml@refs/heads/main",
      "COSIGN_ISSUER=https://token.actions.githubusercontent.com",
      `COMPOSE_DIR=${compose}`,
      `COMPOSE_FILE=${path.join(compose, "compose.yaml")}`,
      `COMPOSE_ENV_FILE=${composeEnv}`,
      `IMAGE_ENV_FILE=${imageEnv}`,
      "COMPOSE_SERVICE=dashboard",
      "IMAGE_ENV_KEY=FRONTMIND_DASHBOARD_IMAGE",
      "LOCAL_READY_URL=http://dashboard.invalid/readyz",
      "PUBLIC_READY_URL=https://dashboard.invalid/readyz",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  let wrapper = await readFile(source, "utf8");
  wrapper = wrapper
    .replace(
      'readonly CONFIG_FILE="/etc/frontmind-deploy/services/dashboard.env"',
      `readonly CONFIG_FILE="${config}"`,
    )
    .replace(
      'readonly STATE_FILE="/var/lib/frontmind-deploy/dashboard/state.json"',
      `readonly STATE_FILE="${state}"`,
    )
    .replace(
      'readonly STACK_LOCK_FILE="/run/lock/frontmind-production-stack.lock"',
      `readonly STACK_LOCK_FILE="${path.join(root, "stack.lock")}"`,
    )
    .replace(
      'readonly DASHBOARD_LOCK_FILE="/run/lock/frontmind-deploy-dashboard.lock"',
      `readonly DASHBOARD_LOCK_FILE="${path.join(root, "dashboard.lock")}"`,
    )
    .replace(
      '[[ $EUID -eq 0 ]] || die "KB_INCIDENT_REPAIR_REQUIRES_ROOT" 77',
      ": # root check replaced only in disposable test copy",
    )
    .replace(
      /root_only_file\(\) \{[\s\S]*?\n\}/u,
      "root_only_file() { [[ -f $1 && ! -L $1 ]];\n}",
    );
  const wrapperFile = path.join(root, "wrapper");
  await writeFile(wrapperFile, wrapper, { mode: 0o700 });

  const ready = JSON.stringify({
    status: "ok",
    build: { sha: sourceSha, imageDigest: digest },
    migration: {
      status: "exact",
      journalHash,
      schema: { status: "exact" },
    },
    configuration: {
      knowledgeBaseManusV2Writer: {
        enabled: writer,
        newBuildProviderProtocol: writer ? "manus_v2" : "legacy_v1",
      },
      knowledgeBaseManusV2ActiveMigration: { enabled: false },
    },
    knowledgeBase: {
      schema: { status: "ok" },
      writes: { status: "writable" },
    },
  });
  await writeFile(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(path.join(bin, "cosign"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(
    path.join(bin, "curl"),
    `#!/bin/sh\nprintf 'curl %s\\n' "$*" >>"$TEST_COMMAND_LOG"\nprintf '%s\\n' '${ready}'\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$TEST_COMMAND_LOG"
if [[ "$1 $2" == "compose version" ]]; then exit 0; fi
if [[ "$1 $2" == "image inspect" ]]; then printf '%s\\n' "$TEST_SOURCE_SHA"; exit 0; fi
if [[ "$1" == compose && "$*" == *" ps -q dashboard" ]]; then printf '%s\\n' dashboard-container; exit 0; fi
if [[ "$1" == inspect && "$*" == *State.Running* ]]; then printf '%s\\n' true; exit 0; fi
if [[ "$1" == inspect && "$*" == *Config.Image* ]]; then printf '%s\\n' "$TEST_IMAGE"; exit 0; fi
if [[ "$1" == exec && "$*" == *" test -s "* ]]; then exit 0; fi
if [[ "$1" == exec && "$*" == *" node /app/dist/knowledge-base-incident-repair-cli.js "* ]]; then
  printf '%s\\n' '{"schemaVersion":1,"mode":"'"$TEST_EXPECTED_MODE"'","success":true,"code":"KB_INCIDENT_REPAIR_CLI_PREVIEW_COMPLETE"}'
  exit 0
fi
exit 99
`,
    { mode: 0o755 },
  );

  const run = (args: string[]) =>
    spawnSync("bash", [wrapperFile, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_COMMAND_LOG: commandLog,
        TEST_SOURCE_SHA: sourceSha,
        TEST_IMAGE: image,
        TEST_EXPECTED_MODE: args[0],
      },
    });
  return { run, commandLog };
}

describe("root-only production knowledge-base incident repair wrapper", () => {
  it("runs preview in the exact current container as the image nonroot user", async () => {
    const test = await harness();
    const result = test.run([
      "preview",
      "--user-id=42",
      "--conversation-id=conversation-1",
      "--repair-kind=retained_upstream_create_3_start",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      mode: "preview",
      success: true,
    });
    const commands = await readFile(test.commandLog, "utf8");
    expect(commands).toContain("exec --user 10001:10001 dashboard-container");
    expect(commands).toContain("knowledge-base-incident-repair-cli.js preview");
  });

  it("fails closed before CLI execution when writer phase readiness is false", async () => {
    const test = await harness({ writer: false });
    const result = test.run([
      "preview",
      "--user-id=42",
      "--conversation-id=conversation-1",
      "--repair-kind=retained_upstream_create_3_start",
    ]);
    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      "KB_INCIDENT_REPAIR_LOCAL_READINESS_REJECTED",
    );
    const commands = await readFile(test.commandLog, "utf8");
    expect(commands).not.toContain(
      "knowledge-base-incident-repair-cli.js preview",
    );
  });

  it("rejects apply without the exact CAS hash and fixed reason code", async () => {
    const test = await harness();
    const result = test.run([
      "apply",
      "--user-id=42",
      "--conversation-id=conversation-1",
      "--repair-kind=legacy_skill_404_confirm",
      "--expected-state-sha256=wrong",
      "--reason-code=authorized_incident_recovery",
    ]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("KB_INCIDENT_REPAIR_STATE_REJECTED");
  });

  it("runs a CAS-bound apply and repeats exact readiness postflight", async () => {
    const test = await harness();
    const result = test.run([
      "apply",
      "--user-id=42",
      "--conversation-id=conversation-1",
      "--repair-kind=legacy_skill_404_confirm",
      `--expected-state-sha256=${"e".repeat(64)}`,
      "--reason-code=authorized_incident_recovery",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      mode: "apply",
      success: true,
    });
    const commands = await readFile(test.commandLog, "utf8");
    expect(commands).toContain("knowledge-base-incident-repair-cli.js apply");
    expect(commands.match(/^curl /gmu)).toHaveLength(4);
  });
});
