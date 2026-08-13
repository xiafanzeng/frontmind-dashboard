import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV,
  KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV,
  knowledgeBaseManusV2ActiveMigrationEnabled,
  knowledgeBaseManusV2InitialCreateEnabled,
  knowledgeBaseManusV2RecoveryAuthority,
  knowledgeBaseManusV2WriterEnabled,
  knowledgeBaseNewBuildProviderProtocol,
} from "./knowledge-base-manus-v2-rollout";

describe("knowledge-base Manus v2 writer rollout", () => {
  it.each(["development", "production"])(
    "keeps the %s writer closed until an operator explicitly enables v2",
    (nodeEnv) => {
      expect(knowledgeBaseManusV2WriterEnabled({ NODE_ENV: nodeEnv })).toBe(
        false,
      );
      expect(knowledgeBaseNewBuildProviderProtocol({ NODE_ENV: nodeEnv })).toBe(
        "legacy_v1",
      );
      expect(
        knowledgeBaseManusV2ActiveMigrationEnabled({ NODE_ENV: nodeEnv }),
      ).toBe(false);
      expect(
        knowledgeBaseManusV2InitialCreateEnabled({ NODE_ENV: nodeEnv }),
      ).toBe(false);
    },
  );

  it("selects the v2 new-build writer only when explicitly enabled", () => {
    expect(
      knowledgeBaseManusV2WriterEnabled({
        [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: "false",
      }),
    ).toBe(false);
    expect(
      knowledgeBaseNewBuildProviderProtocol({
        [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: "false",
      }),
    ).toBe("legacy_v1");
    expect(
      knowledgeBaseNewBuildProviderProtocol({
        [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: "true",
      }),
    ).toBe("manus_v2");
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ] as const)(
    "combines new-build=%s and active-migration=%s into initial-create=%s",
    (newBuildWriter, activeMigration, expected) => {
      const environment = {
        [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: String(newBuildWriter),
        [KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV]: String(activeMigration),
      };
      expect(knowledgeBaseManusV2WriterEnabled(environment)).toBe(
        newBuildWriter,
      );
      expect(knowledgeBaseManusV2ActiveMigrationEnabled(environment)).toBe(
        activeMigration,
      );
      expect(knowledgeBaseManusV2InitialCreateEnabled(environment)).toBe(
        expected,
      );
    },
  );

  it.each([
    [false, false, "deferred_disabled"],
    [true, false, "initial_create"],
    [false, true, "initial_create"],
    [true, true, "initial_create"],
  ] as const)(
    "authorizes unbound recovery with new-build=%s active-migration=%s as %s",
    (newBuildWriter, activeMigration, expected) => {
      expect(
        knowledgeBaseManusV2RecoveryAuthority({
          canonicalTaskId: null,
          createAttemptState: "not_sent",
          providerAttemptState: "not_sent",
          environment: {
            [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: String(newBuildWriter),
            [KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV]:
              String(activeMigration),
          },
        }),
      ).toBe(expected);
    },
  );

  it("keeps unattempted unbound recovery inert while allowing reconciliation and canonical forward progress", () => {
    const disabled = {
      [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: "false",
      [KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV]: "false",
    };
    expect(
      knowledgeBaseManusV2RecoveryAuthority({
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        canonicalTaskId: null,
        environment: disabled,
      }),
    ).toBe("deferred_disabled");
    expect(
      knowledgeBaseManusV2RecoveryAuthority({
        createAttemptState: "sending",
        providerAttemptState: "sending",
        canonicalTaskId: null,
        environment: disabled,
      }),
    ).toBe("reconcile_only");
    expect(
      knowledgeBaseManusV2RecoveryAuthority({
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        canonicalTaskId: null,
        environment: disabled,
      }),
    ).toBe("reconcile_only");
    expect(
      knowledgeBaseManusV2RecoveryAuthority({
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        canonicalTaskId: "canonical-task",
        environment: disabled,
      }),
    ).toBe("forward_on_canonical");
  });

  it.each(["", "TRUE", "False", " true", "false ", "1", "enabled"])(
    "rejects the ambiguous value %j",
    (configured) => {
      expect(() =>
        knowledgeBaseManusV2WriterEnabled({
          [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: configured,
        }),
      ).toThrow(KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV);
    },
  );

  it.each(["", "TRUE", "False", " true", "false ", "1", "enabled"])(
    "rejects the ambiguous active-migration value %j even when the new writer is enabled",
    (configured) => {
      expect(() =>
        knowledgeBaseManusV2InitialCreateEnabled({
          [KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV]: "true",
          [KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV]: configured,
        }),
      ).toThrow(KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV);
    },
  );
});
