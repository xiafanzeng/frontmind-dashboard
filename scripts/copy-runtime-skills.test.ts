import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

describe("copy-runtime-skills", () => {
  it("freshly bundles both frozen 2.2 and current 2.3 SiteOps workflows", async () => {
    await execFileAsync(process.execPath, ["scripts/copy-runtime-skills.mjs"], {
      cwd: projectRoot,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });

    for (const version of ["2.2.0", "2.3.0"]) {
      const workflowRoot = path.join(
        projectRoot,
        "dist",
        "private-workflows",
        `react-static-company-site-workflow-v${version}`,
      );
      const requiredFiles = [
        "MANIFEST.json",
        "SKILL.md",
        "runtime-contract.json",
        "adapters/frontmind-dashboard.md",
        "schemas/frontmind-run-envelope.schema.json",
        "schemas/site-design-wire-v3.schema.json",
        "schemas/page-content-wire-v3.schema.json",
        "schemas/materialization-stage-v2.schema.json",
        "assets/host-starter-contract.json",
      ];
      for (const relativePath of requiredFiles) {
        const absolutePath = path.join(workflowRoot, relativePath);
        await access(absolutePath);
        expect((await stat(absolutePath)).size, absolutePath).toBeGreaterThan(
          0,
        );
      }
      const runtime = JSON.parse(
        await readFile(
          path.join(workflowRoot, "runtime-contract.json"),
          "utf8",
        ),
      );
      expect(runtime).toMatchObject({
        adapterVersion: version,
        aiTask: { phaseTwoOutput: "PageContentWireV3" },
        contentSystem: { buildContract: "BuildContractV4" },
        renderer: {
          kind: "react_static_v2",
          componentLibraryVersion: version,
          materializerVersion: version,
        },
      });
    }
  }, 120_000);
});
