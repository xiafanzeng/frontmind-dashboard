import { afterEach, describe, expect, it } from "vitest";

import {
  classifyKnowledgeBaseActiveLegacyMigration,
  classifyKnowledgeBaseManusV2CredentialRebind,
  migrateActiveLegacyKnowledgeBaseBuilds,
} from "./knowledge-base-api";

const originalWriterFlag = process.env.FRONTMIND_KB_MANUS_V2_WRITER;
const originalMigrationFlag =
  process.env.FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION;

afterEach(() => {
  if (originalWriterFlag === undefined) {
    delete process.env.FRONTMIND_KB_MANUS_V2_WRITER;
  } else {
    process.env.FRONTMIND_KB_MANUS_V2_WRITER = originalWriterFlag;
  }
  if (originalMigrationFlag === undefined) {
    delete process.env.FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION;
  } else {
    process.env.FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION = originalMigrationFlag;
  }
});

describe("active legacy knowledge-base migration policy", () => {
  const deletedV2Anchor = {
    id: "build-v2",
    userId: 9,
    generation: 4,
    stateEpoch: 8,
    revision: 12,
    currentLeafId: "2.3",
    status: "confirming",
    activeTurnId: null,
    canonicalTaskId: "old-task",
    canonicalTaskGeneration: 4,
    canonicalCredentialId: "old-credential",
    canonicalTaskState: "active",
    protocolErrorCode: null,
    credentialStatus: "deleted",
    resourceTaskId: "old-task",
    resourceCredentialId: "old-credential",
    resourceUserId: 9,
    resourceProjectAssignmentId: null,
    conversationUserId: 9,
    conversationProjectAssignmentId: null,
    conversationStatus: "awaiting_input",
    conversationDeletedAt: null,
  };

  it("selects only an idle deleted-credential v2 anchor for a new generation", () => {
    expect(classifyKnowledgeBaseManusV2CredentialRebind(deletedV2Anchor)).toBe(
      "rebind_anchor",
    );
    expect(
      classifyKnowledgeBaseManusV2CredentialRebind({
        ...deletedV2Anchor,
        activeTurnId: "sending-turn",
      }),
    ).toBe("active_operation");
    expect(
      classifyKnowledgeBaseManusV2CredentialRebind({
        ...deletedV2Anchor,
        credentialStatus: "retired",
      }),
    ).toBe("credential_still_available");
    expect(
      classifyKnowledgeBaseManusV2CredentialRebind({
        ...deletedV2Anchor,
        conversationStatus: "running",
      }),
    ).toBe("excluded");
  });

  it("requires the canonical task resource to share the exact conversation project scope", () => {
    expect(
      classifyKnowledgeBaseManusV2CredentialRebind({
        ...deletedV2Anchor,
        resourceProjectAssignmentId: "project-1",
        conversationProjectAssignmentId: "project-1",
      }),
    ).toBe("rebind_anchor");
    expect(
      classifyKnowledgeBaseManusV2CredentialRebind({
        ...deletedV2Anchor,
        resourceProjectAssignmentId: "project-other",
        conversationProjectAssignmentId: "project-1",
      }),
    ).toBe("excluded");
    expect(
      classifyKnowledgeBaseManusV2CredentialRebind({
        ...deletedV2Anchor,
        conversationUserId: 10,
      }),
    ).toBe("excluded");
  });

  it("selects only a no-active awaiting-input build for anchor handoff", () => {
    expect(
      classifyKnowledgeBaseActiveLegacyMigration({
        status: "confirming",
        activeTurnId: null,
        createAttemptState: null,
      }),
    ).toBe("migrate_anchor");
    expect(
      classifyKnowledgeBaseActiveLegacyMigration({
        status: "researching",
        activeTurnId: null,
        createAttemptState: null,
      }),
    ).toBe("legacy_outcome_unknown");
    expect(
      classifyKnowledgeBaseActiveLegacyMigration({
        status: "protocol_error",
        activeTurnId: null,
        createAttemptState: null,
      }),
    ).toBe("migrate_anchor");
  });

  it("classifies not-sent work for status-aware recovery or failed-turn repair", () => {
    expect(
      classifyKnowledgeBaseActiveLegacyMigration({
        status: "confirming",
        activeTurnId: "turn-1",
        createAttemptState: "not_sent",
      }),
    ).toBe("existing_not_sent_turn");
    expect(
      classifyKnowledgeBaseActiveLegacyMigration({
        status: "protocol_error",
        activeTurnId: "incident-replacement-turn",
        createAttemptState: "not_sent",
      }),
    ).toBe("existing_not_sent_turn");
  });

  it.each(["sending", "unknown", "acknowledged"])(
    "never creates a task while the legacy turn is %s",
    (createAttemptState) => {
      expect(
        classifyKnowledgeBaseActiveLegacyMigration({
          status: "confirming",
          activeTurnId: "turn-1",
          createAttemptState,
        }),
      ).toBe("legacy_outcome_unknown");
    },
  );

  it("does not reinterpret a protocol-error unknown create as a fresh repair", () => {
    expect(
      classifyKnowledgeBaseActiveLegacyMigration({
        status: "protocol_error",
        activeTurnId: "turn-unknown",
        createAttemptState: "unknown",
      }),
    ).toBe("legacy_outcome_unknown");
  });

  it.each(["ready_to_publish", "published", "failed"])(
    "keeps %s builds read-only",
    (status) => {
      expect(
        classifyKnowledgeBaseActiveLegacyMigration({
          status,
          activeTurnId: null,
          createAttemptState: null,
        }),
      ).toBe("excluded");
    },
  );

  it.each(["false", undefined])(
    "is a strict no-op while active migration is %s even when the new-build writer is enabled",
    async (migrationFlag) => {
      process.env.FRONTMIND_KB_MANUS_V2_WRITER = "true";
      if (migrationFlag === undefined) {
        delete process.env.FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION;
      } else {
        process.env.FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION = migrationFlag;
      }
      await expect(migrateActiveLegacyKnowledgeBaseBuilds()).resolves.toEqual({
        enabled: false,
        scanned: 0,
        reserved: 0,
        bound: 0,
        reconciled: 0,
        credentialRebindReserved: 0,
        credentialRebindSkipped: 0,
        existingNotSent: 0,
        awaitingLegacySettlement: 0,
        attentionRequired: 0,
        skipped: 0,
        failed: 0,
        nextCursor: null,
        hasMore: false,
        rebindNextCursor: null,
        rebindHasMore: false,
      });
    },
  );
});
