import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
});
