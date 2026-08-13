import { describe, expect, it } from "vitest";

import {
  assertKnowledgeBaseIncidentRepairCliRuntime,
  knowledgeBaseIncidentRepairCliFailureResult,
  parseKnowledgeBaseIncidentRepairCliArgs,
  serializeKnowledgeBaseIncidentRepairCliResult,
} from "./knowledge-base-incident-repair-cli-core";

const buildSourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const environment = {
  NODE_ENV: "production",
  FRONTMIND_RELEASE_CHANNEL: "development",
  FRONTMIND_BUILD_SHA: buildSourceSha,
  FRONTMIND_IMAGE_DIGEST: digest,
  FRONTMIND_KB_MANUS_V2_WRITER: "true",
  FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "false",
};
const readiness = {
  status: "ok",
  channel: "development",
  build: { sha: buildSourceSha, imageDigest: digest },
  migration: { status: "exact", schema: { status: "exact" } },
  configuration: {
    knowledgeBaseManusV2Writer: {
      enabled: true,
      newBuildProviderProtocol: "manus_v2",
    },
    knowledgeBaseManusV2ActiveMigration: { enabled: false },
  },
};

describe("signed-image incident repair CLI core", () => {
  it("strictly parses preview and apply without accepting extra authority", () => {
    expect(
      parseKnowledgeBaseIncidentRepairCliArgs([
        "preview",
        "--user-id=7",
        "--conversation-id=conversation-incident",
        "--repair-kind=legacy_skill_404_confirm",
      ]),
    ).toEqual({
      mode: "preview",
      userId: 7,
      conversationId: "conversation-incident",
      repairKind: "legacy_skill_404_confirm",
    });
    expect(
      parseKnowledgeBaseIncidentRepairCliArgs([
        "apply",
        "--user-id=7",
        "--conversation-id=conversation-incident",
        "--repair-kind=retained_upstream_create_3_start",
        `--expected-state-sha256=${"c".repeat(64)}`,
        "--reason-code=authorized_incident_recovery",
      ]),
    ).toMatchObject({ mode: "apply", expectedStateHash: "c".repeat(64) });
    expect(
      parseKnowledgeBaseIncidentRepairCliArgs([
        "reset-pollution-preview",
        "--user-id=7",
        "--conversation-id=conversation-incident",
        "--build-id=build-incident",
        "--reset-request-id=reset-approved",
        "--expected-reset-revision=3",
      ]),
    ).toMatchObject({ mode: "reset-pollution-preview" });
    for (const argv of [
      [
        "preview",
        "--user-id=7",
        "--conversation-id=conversation-incident",
        "--repair-kind=legacy_skill_404_confirm",
        `--expected-state-sha256=${"c".repeat(64)}`,
      ],
      [
        "apply",
        "--user-id=7",
        "--user-id=8",
        "--conversation-id=conversation-incident",
        "--repair-kind=legacy_skill_404_confirm",
        `--expected-state-sha256=${"c".repeat(64)}`,
        "--reason-code=authorized_incident_recovery",
      ],
      [
        "apply",
        "--user-id=7",
        "--conversation-id=conversation-incident",
        "--repair-kind=legacy_skill_404_confirm",
        "--expected-state-sha256=not-a-hash",
        "--reason-code=free-form-reason",
      ],
    ]) {
      expect(() => parseKnowledgeBaseIncidentRepairCliArgs(argv)).toThrow(
        /^KB_INCIDENT_REPAIR_CLI_/u,
      );
    }
  });

  it("requires exact signed identity, schema and writer-only rollout phase", () => {
    expect(
      assertKnowledgeBaseIncidentRepairCliRuntime({
        env: environment,
        compiledBuildSha: buildSourceSha,
        compiledReleaseChannel: "development",
        runtimeIdentity: {
          buildSourceSha,
          releaseChannel: "development",
        },
        readiness,
      }),
    ).toMatchObject(readiness);
    for (const mutation of [
      { NODE_ENV: "development" },
      { FRONTMIND_BUILD_SHA: "c".repeat(40) },
      { FRONTMIND_IMAGE_DIGEST: `sha256:${"d".repeat(64)}` },
      { FRONTMIND_KB_MANUS_V2_WRITER: "false" },
      { FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION: "true" },
    ]) {
      expect(() =>
        assertKnowledgeBaseIncidentRepairCliRuntime({
          env: { ...environment, ...mutation },
          compiledBuildSha: buildSourceSha,
          compiledReleaseChannel: "development",
          runtimeIdentity: {
            buildSourceSha,
            releaseChannel: "development",
          },
          readiness,
        }),
      ).toThrow(/^KB_INCIDENT_REPAIR_CLI_/u);
    }
    expect(() =>
      assertKnowledgeBaseIncidentRepairCliRuntime({
        env: environment,
        compiledBuildSha: buildSourceSha,
        compiledReleaseChannel: "development",
        runtimeIdentity: {
          buildSourceSha,
          releaseChannel: "development",
        },
        readiness: {
          ...readiness,
          migration: { status: "exact", schema: { status: "diverged" } },
        },
      }),
    ).toThrow("KB_INCIDENT_REPAIR_CLI_READINESS_CONTRACT_INVALID");
    expect(
      assertKnowledgeBaseIncidentRepairCliRuntime({
        env: environment,
        compiledBuildSha: buildSourceSha,
        compiledReleaseChannel: "development",
        runtimeIdentity: {
          buildSourceSha,
          releaseChannel: "development",
        },
        readiness: null,
        skipLoopbackReadiness: true,
      }),
    ).toBeNull();
  });

  it("maps arbitrary failures to one strict allowlisted JSON line", () => {
    const result = knowledgeBaseIncidentRepairCliFailureResult({
      error: new Error(
        "mysql://secret@customer-db/private customer.pdf provider-task-id",
      ),
      command: parseKnowledgeBaseIncidentRepairCliArgs([
        "preview",
        "--user-id=7",
        "--conversation-id=conversation-incident",
        "--repair-kind=legacy_skill_404_confirm",
      ]),
      buildSourceSha,
      imageDigest: digest,
    });
    const output = serializeKnowledgeBaseIncidentRepairCliResult(result);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({
      success: false,
      code: "KB_INCIDENT_REPAIR_CLI_FAILED",
    });
    expect(output).not.toContain("secret");
    expect(output).not.toContain("customer.pdf");
    expect(output).not.toContain("provider-task-id");
    expect(output).not.toContain("conversation-incident");
  });
});
