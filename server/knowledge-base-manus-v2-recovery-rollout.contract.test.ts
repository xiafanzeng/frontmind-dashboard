import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("knowledge-base Manus v2 recovery rollout wiring", () => {
  it("checks active-migration authority before lazy legacy cutover", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const dispatchStart = source.indexOf(
      "async function dispatchKnowledgeBaseRecoveryClaim(",
    );
    const migrationTypes = source.indexOf(
      "type KnowledgeBaseActiveLegacyMigrationCandidate",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, migrationTypes);
    const migrationGate = dispatch.indexOf(
      "knowledgeBaseManusV2ActiveMigrationEnabled()",
    );
    const cutover = dispatch.indexOf("activateKnowledgeBaseManusV2Handoff(");

    expect(dispatchStart).toBeGreaterThan(-1);
    expect(migrationTypes).toBeGreaterThan(dispatchStart);
    expect(migrationGate).toBeGreaterThan(-1);
    expect(cutover).toBeGreaterThan(migrationGate);
  });

  it("halts an unbound not-sent v2 recovery before file or task provider work", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const dispatchStart = source.indexOf(
      "async function dispatchKnowledgeBaseRecoveryClaim(",
    );
    const migrationTypes = source.indexOf(
      "type KnowledgeBaseActiveLegacyMigrationCandidate",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, migrationTypes);
    const authority = dispatch.indexOf(
      "knowledgeBaseManusV2RecoveryAuthority({",
    );
    const disabled = dispatch.indexOf(
      'recoveryAuthority === "deferred_disabled"',
      authority,
    );
    const prepare = dispatch.indexOf("ensureDispatch({", disabled);
    const upload = dispatch.indexOf("ensureManusV2Attachments({", disabled);
    const writerFence = dispatch.indexOf("beginDispatch({", disabled);
    const providerCreate = dispatch.indexOf(
      "const created = await client.createTask({",
      disabled,
    );

    expect(authority).toBeGreaterThan(-1);
    expect(disabled).toBeGreaterThan(authority);
    expect(prepare).toBeGreaterThan(disabled);
    expect(upload).toBeGreaterThan(prepare);
    expect(writerFence).toBeGreaterThan(upload);
    expect(providerCreate).toBeGreaterThan(writerFence);
  });

  it("gates the migration sweep independently of the new-build writer", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const migrationStart = source.indexOf(
      "export async function migrateActiveLegacyKnowledgeBaseBuilds(",
    );
    const migration = source.slice(migrationStart);
    const migrationGate = migration.indexOf(
      "if (!knowledgeBaseManusV2ActiveMigrationEnabled())",
    );
    const databaseAccess = migration.indexOf("const db = await getDb()");

    expect(migrationStart).toBeGreaterThan(-1);
    expect(migrationGate).toBeGreaterThan(-1);
    expect(databaseAccess).toBeGreaterThan(migrationGate);
    expect(source).not.toContain("knowledgeBaseManusV2WriterEnabled");
  });

  it("repairs only failed not-sent legacy turns inside the migration fence", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const migrationStart = source.indexOf(
      "export async function migrateActiveLegacyKnowledgeBaseBuilds(",
    );
    const migration = source.slice(migrationStart);
    const migrationGate = migration.indexOf(
      "if (!knowledgeBaseManusV2ActiveMigrationEnabled())",
    );
    const failedTurnGate = migration.indexOf(
      'candidate.activeTurnStatus !== "failed"',
    );
    const reserveRepair = migration.indexOf(
      "reserveKnowledgeBaseFailedNotSentLegacyHandoff({",
    );
    const claimReplacement = migration.indexOf(
      "turnId: replacement.replacementTurnId",
      reserveRepair,
    );
    const dispatchReplacement = migration.indexOf(
      "dispatchKnowledgeBaseRecoveryClaim(claim, credential)",
      claimReplacement,
    );

    expect(migrationGate).toBeGreaterThan(-1);
    expect(failedTurnGate).toBeGreaterThan(migrationGate);
    expect(reserveRepair).toBeGreaterThan(failedTurnGate);
    expect(claimReplacement).toBeGreaterThan(reserveRepair);
    expect(dispatchReplacement).toBeGreaterThan(claimReplacement);
  });

  it("keeps deleted canonical-credential rebind behind migration authority and the durable create fence", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const migrationStart = source.indexOf(
      "export async function migrateActiveLegacyKnowledgeBaseBuilds(",
    );
    const migration = source.slice(migrationStart);
    const migrationGate = migration.indexOf(
      "if (!knowledgeBaseManusV2ActiveMigrationEnabled())",
    );
    const classify = migration.indexOf(
      "classifyKnowledgeBaseManusV2CredentialRebind(candidate)",
    );
    const reserve = migration.indexOf('sourceProtocol: "manus_v2"', classify);
    const dispatch = migration.indexOf(
      "dispatchKnowledgeBaseAnchorHandoffClaim({",
      reserve,
    );
    const beginCreate = source.indexOf(
      "const authority = await beginKnowledgeBaseManusV2Dispatch({",
    );
    const providerCreate = source.indexOf(
      "const created = await client.createTask({",
      beginCreate,
    );

    expect(migrationGate).toBeGreaterThan(-1);
    expect(classify).toBeGreaterThan(migrationGate);
    expect(reserve).toBeGreaterThan(classify);
    expect(dispatch).toBeGreaterThan(reserve);
    expect(beginCreate).toBeGreaterThan(-1);
    expect(providerCreate).toBeGreaterThan(beginCreate);
  });

  it("filters deleted canonical credentials before the bounded rebind page and advances an independent cursor", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const migrationStart = source.indexOf(
      "export async function migrateActiveLegacyKnowledgeBaseBuilds(",
    );
    const rebindStart = source.indexOf(
      "const rebindCandidates =",
      migrationStart,
    );
    const rebindEnd = source.indexOf(
      "for (const candidate of rebindCandidates)",
      rebindStart,
    );
    const rebindQuery = source.slice(rebindStart, rebindEnd);
    const deletedFilter = rebindQuery.indexOf(
      'eq(apiCredentials.status, "deleted")',
    );
    const boundedPage = rebindQuery.lastIndexOf(".limit(limit)");

    expect(rebindStart).toBeGreaterThan(migrationStart);
    expect(rebindEnd).toBeGreaterThan(rebindStart);
    expect(deletedFilter).toBeGreaterThan(-1);
    expect(boundedPage).toBeGreaterThan(deletedFilter);
    expect(rebindQuery).not.toContain("options?.afterBuildId");
    expect(rebindQuery).toContain("options?.afterRebindBuildId");
    expect(rebindQuery).toContain(
      "gt(knowledgeBaseBuilds.id, options.afterRebindBuildId)",
    );
  });

  it("isolates a failed legacy outcome-unknown turn without a provider POST", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const migrationStart = source.indexOf(
      "export async function migrateActiveLegacyKnowledgeBaseBuilds(",
    );
    const migration = source.slice(migrationStart);
    const unknownBranch = migration.indexOf(
      'disposition === "legacy_outcome_unknown"',
    );
    const failedGate = migration.indexOf(
      'candidate.activeTurnStatus === "failed"',
      unknownBranch,
    );
    const attention = migration.indexOf(
      "markLegacyKnowledgeBaseCreateAttentionRequired({",
      failedGate,
    );
    const branchEnd = migration.indexOf(
      'if (disposition !== "migrate_anchor")',
      unknownBranch,
    );
    const branch = migration.slice(unknownBranch, branchEnd);

    expect(unknownBranch).toBeGreaterThan(-1);
    expect(failedGate).toBeGreaterThan(unknownBranch);
    expect(attention).toBeGreaterThan(failedGate);
    expect(branch).not.toContain("createTask(");
    expect(branch).not.toContain("dispatchKnowledgeBaseRecoveryClaim(");
  });

  it("keeps browser reconcile provider-write-free", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const start = source.indexOf('router.post("/progress/reconcile"');
    const end = source.indexOf("export default router", start);
    const route = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(route).toContain("normalizeKnowledgeBaseTerminalRejection({");
    expect(route).not.toContain("resumeKnowledgeBaseTurnAfterUserFix({");
    expect(route).not.toContain("launchAcceptedKnowledgeBaseClaim({");
    expect(route).not.toContain("createTask({");
    expect(route).not.toContain("sendMessage({");
  });

  it("coalesces explicit recovery before reserving a provider operation", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const start = source.indexOf('router.post("/recovery/execute"');
    const end = source.indexOf(
      'router.post("/canonical/recover-from-snapshot"',
      start,
    );
    const route = source.slice(start, end);
    const replay = route.indexOf("findKnowledgeBaseExplicitRecoveryReplay({");
    const compatible = route.indexOf(
      "reserveKnowledgeBaseCompatibleCreateRecovery({",
    );
    const generation = route.indexOf(
      "reserveKnowledgeBaseManusV2AnchorHandoff({",
    );

    expect(start).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(-1);
    expect(compatible).toBeGreaterThan(replay);
    expect(generation).toBeGreaterThan(replay);
    const concurrentReplay = route.indexOf(
      "findKnowledgeBaseExplicitRecoveryReplay({",
      generation,
    );
    expect(concurrentReplay).toBeGreaterThan(generation);
    expect(route.slice(concurrentReplay)).toContain(
      'disposition: "already_applied"',
    );
    expect(route).toContain(
      'decision.recovery.action === "retry_compatible_create"',
    );
  });

  it("does not require a migration snapshot for the one compatible create", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const dispatchStart = source.indexOf(
      "async function dispatchKnowledgeBaseRecoveryClaim(",
    );
    const migrationTypes = source.indexOf(
      "type KnowledgeBaseActiveLegacyMigrationCandidate",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, migrationTypes);
    const unboundSnapshotBranch = dispatch.indexOf(
      "existingBuild?.providerProtocol === \"manus_v2\"",
    );

    expect(unboundSnapshotBranch).toBeGreaterThan(-1);
    expect(dispatch.slice(unboundSnapshotBranch, unboundSnapshotBranch + 700)).toContain(
      'claim.recoveryMetadata.compatibilityMode !== "minimal_v2_create"',
    );
  });

  it("keeps title in the compatible create while omitting only optional request fields", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const dispatchStart = source.indexOf(
      "async function dispatchKnowledgeBaseRecoveryClaim(",
    );
    const migrationTypes = source.indexOf(
      "type KnowledgeBaseActiveLegacyMigrationCandidate",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, migrationTypes);
    const createStart = dispatch.indexOf("const created = await client.createTask({");
    const createEnd = dispatch.indexOf("});", createStart);
    const createRequest = dispatch.slice(createStart, createEnd);

    expect(createStart).toBeGreaterThan(-1);
    expect(createRequest).toContain("title: authority.title");
    expect(createRequest).toContain("minimalCompatibleCreate");
    expect(createRequest).toContain("agentProfile");
    expect(createRequest).toContain("structuredOutputSchema");
    expect(dispatch).toContain("titleUtf8Bytes");
    expect(dispatch).toContain("structuredOutputSchemaSha256");
  });
});
