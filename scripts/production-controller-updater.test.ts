import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const updaterSource = path.resolve(
  "deploy/production/update-release-controllers.sh",
);
const controllerSource = path.resolve(
  "deploy/production/controller/frontmind-deploy-controller",
);
const forcedSource = path.resolve(
  "deploy/production/controller/frontmind-deploy-forced-command",
);
const incidentSource = path.resolve(
  "deploy/production/controller/frontmind-knowledge-base-incident-repair",
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness({
  failForcedInstall = false,
  failControllerInstall = false,
}: {
  failForcedInstall?: boolean;
  failControllerInstall?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "frontmind-prod-updater-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const templates = path.join(root, "deploy/production");
  const controllerDir = path.join(templates, "controller");
  const targets = path.join(root, "targets");
  const recoveryRoot = path.join(root, "controller-update-recovery");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(controllerDir, { recursive: true }),
    mkdir(targets, { recursive: true }),
  ]);
  const controllerTemplate = path.join(
    controllerDir,
    "frontmind-deploy-controller",
  );
  const forcedTemplate = path.join(
    controllerDir,
    "frontmind-deploy-forced-command",
  );
  const incidentTemplate = path.join(
    controllerDir,
    "frontmind-knowledge-base-incident-repair",
  );
  await Promise.all([
    writeFile(controllerTemplate, await readFile(controllerSource), {
      mode: 0o755,
    }),
    writeFile(forcedTemplate, await readFile(forcedSource), { mode: 0o755 }),
    writeFile(incidentTemplate, await readFile(incidentSource), {
      mode: 0o700,
    }),
  ]);
  const controllerTarget = path.join(targets, "frontmind-deploy-controller");
  const forcedTarget = path.join(targets, "frontmind-deploy-forced-command");
  const incidentTarget = path.join(
    targets,
    "frontmind-knowledge-base-incident-repair",
  );
  await Promise.all([
    writeFile(controllerTarget, "old-controller\n", { mode: 0o755 }),
    writeFile(forcedTarget, "old-forced\n", { mode: 0o755 }),
  ]);

  let updater = await readFile(updaterSource, "utf8");
  updater = updater
    .replace(
      'readonly CONTROLLER_TARGET="/usr/local/sbin/frontmind-deploy-controller"',
      `readonly CONTROLLER_TARGET="${controllerTarget}"`,
    )
    .replace(
      'readonly FORCED_TARGET="/usr/local/sbin/frontmind-deploy-forced-command"',
      `readonly FORCED_TARGET="${forcedTarget}"`,
    )
    .replace(
      'readonly INCIDENT_TARGET="/usr/local/sbin/frontmind-knowledge-base-incident-repair"',
      `readonly INCIDENT_TARGET="${incidentTarget}"`,
    )
    .replace(
      'readonly UPDATE_LOCK="/run/lock/frontmind-production-controller-update.lock"',
      `readonly UPDATE_LOCK="${path.join(root, "update.lock")}"`,
    )
    .replace(
      'readonly STACK_LOCK="/run/lock/frontmind-production-stack.lock"',
      `readonly STACK_LOCK="${path.join(root, "stack.lock")}"`,
    )
    .replace(
      'readonly DASHBOARD_LOCK="/run/lock/frontmind-deploy-dashboard.lock"',
      `readonly DASHBOARD_LOCK="${path.join(root, "dashboard.lock")}"`,
    )
    .replace(
      'readonly WEBSITE_LOCK="/run/lock/frontmind-deploy-website.lock"',
      `readonly WEBSITE_LOCK="${path.join(root, "website.lock")}"`,
    )
    .replace(
      'readonly RECOVERY_ROOT="/var/lib/frontmind-deploy/controller-update"',
      `readonly RECOVERY_ROOT="${recoveryRoot}"`,
    )
    .replace(
      '[[ $EUID -eq 0 ]] || die "PRODUCTION_CONTROLLER_UPDATE_REQUIRES_ROOT" 77',
      ": # root check replaced in disposable updater contract",
    )
    .replace(
      '[[ -f $target && ! -L $target && $(stat -c \'%u:%g:%a\' "$target") == "0:0:755" ]]',
      '[[ -f $target && ! -L $target && $(stat -c \'%a\' "$target") == "755" ]]',
    )
    .replace(
      '[[ -f $target && ! -L $target && $(stat -c \'%u:%g:%a\' "$target") == "0:0:700" ]]',
      '[[ -f $target && ! -L $target && $(stat -c \'%a\' "$target") == "700" ]]',
    )
    .replace(
      '[[ -d $RECOVERY_ROOT && ! -L $RECOVERY_ROOT \\\n  && $(stat -c \'%u:%g:%a\' "$RECOVERY_ROOT") == "0:0:700" ]]',
      "[[ -d $RECOVERY_ROOT && ! -L $RECOVERY_ROOT ]]",
    );
  const updaterFile = path.join(templates, "update-release-controllers.sh");
  await writeFile(updaterFile, updater, { mode: 0o755 });
  await writeFile(
    path.join(bin, "install"),
    `#!/usr/bin/env bash
set -e
args=("$@")
source="\${args[\${#args[@]}-2]}"
target="\${args[\${#args[@]}-1]}"
if [[ "${failForcedInstall ? "1" : "0"}" == 1 && "$target" == *frontmind-deploy-forced-command.tmp.* && ! -e "${path.join(root, "failed-once")}" ]]; then touch "${path.join(root, "failed-once")}"; exit 88; fi
if [[ "${failControllerInstall ? "1" : "0"}" == 1 && "$target" == *frontmind-deploy-controller.tmp.* && ! -e "${path.join(root, "failed-once")}" ]]; then touch "${path.join(root, "failed-once")}"; exit 88; fi
cp "$source" "$target"
if [[ "$source" == *frontmind-knowledge-base-incident-repair* ]]; then chmod 0700 "$target"; else chmod 0755 "$target"; fi
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(bin, "stat"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == -c ]]; then
  case "\${3:-}" in *frontmind-knowledge-base-incident-repair*) printf '%s\\n' 700 ;; *) printf '%s\\n' 755 ;; esac
  exit 0
fi
exec /usr/bin/stat "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  const result = spawnSync("bash", [updaterFile, "--apply-version=3"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return {
    result,
    controllerTarget,
    forcedTarget,
    incidentTarget,
    recoveryRoot,
    updaterFile,
    commandPath: `${bin}:${process.env.PATH}`,
  };
}

describe("production controller atomic updater", () => {
  it("installs the reviewed v3 controller, forced command and root incident wrapper atomically", async () => {
    const test = await harness();
    expect(test.result.status, test.result.stderr).toBe(0);
    expect(test.result.stdout).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_OK version=3",
    );
    expect(await readFile(test.controllerTarget, "utf8")).toContain(
      "frontmind-production-controller-version: 3",
    );
    expect(await readFile(test.forcedTarget, "utf8")).toContain(
      "--kb-manus-v2-rollout",
    );
    expect(await readFile(test.incidentTarget, "utf8")).toContain(
      "KB_INCIDENT_REPAIR_REQUIRES_ROOT",
    );
  });

  it("restores both old executables when the second install fails", async () => {
    const test = await harness({ failForcedInstall: true });
    expect(test.result.status, test.result.stderr).toBe(70);
    expect(test.result.stderr).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_ROLLED_BACK",
    );
    expect(await readFile(test.controllerTarget, "utf8")).toBe(
      "old-controller\n",
    );
    expect(await readFile(test.forcedTarget, "utf8")).toBe("old-forced\n");
  });

  it("recovers both old executables from a persisted interrupted-update marker", async () => {
    const test = await harness();
    await mkdir(test.recoveryRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(test.recoveryRoot, "frontmind-deploy-controller.previous"),
        "recovered-controller\n",
        { mode: 0o600 },
      ),
      writeFile(
        path.join(
          test.recoveryRoot,
          "frontmind-deploy-forced-command.previous",
        ),
        "recovered-forced\n",
        { mode: 0o600 },
      ),
      writeFile(
        path.join(
          test.recoveryRoot,
          "frontmind-knowledge-base-incident-repair.previous",
        ),
        "#!/usr/bin/env bash\necho recovered-incident\n",
        { mode: 0o600 },
      ),
      writeFile(path.join(test.recoveryRoot, "pending"), "version=3\n", {
        mode: 0o600,
      }),
      writeFile(test.controllerTarget, "mixed-new-controller\n", {
        mode: 0o755,
      }),
      writeFile(test.forcedTarget, "mixed-old-forced\n", { mode: 0o755 }),
    ]);
    const result = spawnSync("bash", [test.updaterFile, "--apply-version=3"], {
      encoding: "utf8",
      env: { ...process.env, PATH: test.commandPath },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_RECOVERED_PREVIOUS",
    );
    expect(await readFile(test.controllerTarget, "utf8")).toContain(
      "frontmind-production-controller-version: 3",
    );
  });

  it("restores both old executables when the first replacement fails", async () => {
    const test = await harness({ failControllerInstall: true });
    expect(test.result.status, test.result.stderr).toBe(70);
    expect(await readFile(test.controllerTarget, "utf8")).toBe(
      "old-controller\n",
    );
    expect(await readFile(test.forcedTarget, "utf8")).toBe("old-forced\n");
  });

  it("rejects a SIGKILL-style leftover marker if either recovery backup is missing", async () => {
    const test = await harness();
    await mkdir(test.recoveryRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(test.recoveryRoot, "frontmind-deploy-controller.previous"),
        "recoverable-controller\n",
        { mode: 0o600 },
      ),
      writeFile(path.join(test.recoveryRoot, "pending"), "version=3\n", {
        mode: 0o600,
      }),
    ]);
    const result = spawnSync("bash", [test.updaterFile, "--apply-version=3"], {
      encoding: "utf8",
      env: { ...process.env, PATH: test.commandPath },
    });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_FAILED",
    );
  });

  it("rejects an existing controller target that is not the exact root-owned executable shape", async () => {
    const test = await harness();
    const unsafeController = path.join(test.recoveryRoot, "unsafe-controller");
    await mkdir(test.recoveryRoot, { recursive: true });
    await writeFile(unsafeController, "unsafe-controller\n", { mode: 0o755 });
    await rm(test.controllerTarget);
    await symlink(unsafeController, test.controllerTarget);
    const result = spawnSync("bash", [test.updaterFile, "--apply-version=3"], {
      encoding: "utf8",
      env: { ...process.env, PATH: test.commandPath },
    });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain("PRODUCTION_CONTROLLER_TARGET_INVALID");
    expect(await readFile(unsafeController, "utf8")).toBe(
      "unsafe-controller\n",
    );
  });
});
