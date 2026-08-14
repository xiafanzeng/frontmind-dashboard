import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Dashboard ordinary-chat v2 boundary", () => {
  const serverSource = readFileSync(
    resolve(process.cwd(), "server/frontmind-v2-chat-router.ts"),
    "utf8",
  );
  const clientSource = readFileSync(
    resolve(process.cwd(), "client/src/lib/frontmind-api.ts"),
    "utf8",
  );

  it("uses local task, message, asset and artifact identities", () => {
    expect(serverSource).toContain('router.post("/tasks"');
    expect(serverSource).toContain(
      'router.post("/tasks/:localTaskId/messages"',
    );
    expect(serverSource).toContain('router.post("/assets"');
    expect(serverSource).toContain(
      'router.get("/artifacts/:artifactId/content"',
    );
    expect(serverSource).toContain("providerFileLeases");
    expect(serverSource).toContain(
      "await client.fileDetail(reusable.providerFileId)",
    );
    expect(serverSource).toContain('.set({ uploadState: "expired" })');
  });

  it("never routes ordinary chat through a Manus v1 endpoint", () => {
    expect(serverSource).not.toMatch(/\/v1\/(?:tasks|responses|files)/u);
    expect(clientSource).toContain(
      "/v2/tasks/${encodeURIComponent(localTaskId)}/messages",
    );
    expect(clientSource).not.toContain(
      "[retrieveTask] /v1/tasks/ is unavailable",
    );
  });

  it("freezes model policy from the credential and rejects browser model fields", () => {
    expect(serverSource).toContain(
      "upstreamModel: input.credential.upstreamModel",
    );
    expect(serverSource).toContain(
      "agentProfile: reserved.operation.upstreamModel",
    );
    expect(clientSource).not.toContain('taskMode: "agent"');
    expect(clientSource).not.toContain("agentProfile: modelToUse");
  });

  it("reconciles outcome-unknown side effects by operation marker", () => {
    expect(serverSource).toContain("findCreatedTask({");
    expect(serverSource).toContain("manusV2EventsContainOperationToken");
    expect(serverSource).toContain('status: "attention_required"');
    expect(serverSource).not.toContain("previous_response_id");
  });
});
