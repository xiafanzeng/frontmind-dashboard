import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("knowledge-base Manus v2 recovery rollout wiring", () => {
  it("keeps attachment staging provider-write-free and dispatch as the sole claim boundary", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const stageStart = source.indexOf('router.post("/turn/attachments/stage"');
    const dispatchStart = source.indexOf('router.post("/turn/dispatch"');
    const nextRoute = source.indexOf('router.post("/turn"', dispatchStart);
    const stageRoute = source.slice(stageStart, dispatchStart);
    const dispatchRoute = source.slice(dispatchStart, nextRoute);

    expect(stageStart).toBeGreaterThan(-1);
    expect(dispatchStart).toBeGreaterThan(stageStart);
    expect(stageRoute).toContain("stageKnowledgeBaseDeferredTurnAttachment({");
    expect(stageRoute).not.toContain(
      "stageAndClaimKnowledgeBaseDeferredTurnAttachment({",
    );
    expect(stageRoute).not.toContain(
      "claimKnowledgeBaseDeferredTurnDispatch({",
    );
    expect(stageRoute).not.toContain("launchAcceptedKnowledgeBaseClaim({");
    expect(stageRoute).not.toContain("persistKnowledgeBaseBuildSource({");
    expect(stageRoute).toContain("managedUploadBytes: localAsset.bytes");
    expect(dispatchRoute).toContain("claimKnowledgeBaseDeferredTurnDispatch({");
    expect(dispatchRoute).toContain("launchAcceptedKnowledgeBaseClaim({");
  });

  it("retires all public legacy recovery routes before credential or recovery work", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const routeStarts = [
      'router.post("/start/recover"',
      'router.post("/recovery/execute"',
      'router.post("/canonical/recover-from-snapshot"',
    ];

    for (const [index, routeStart] of routeStarts.entries()) {
      const start = source.indexOf(routeStart);
      const next =
        index + 1 < routeStarts.length
          ? source.indexOf(routeStarts[index + 1]!, start)
          : source.indexOf("router.post(", start + routeStart.length);
      const route = source.slice(start, next);
      const retired = route.indexOf(
        "if (knowledgeBaseLegacyRecoveryRoutesRetired())",
      );
      const gone = route.indexOf("res.status(410)", retired);
      const credential = route.indexOf("if (!req.frontmindCredential)", gone);

      expect(start).toBeGreaterThan(-1);
      expect(next).toBeGreaterThan(start);
      expect(retired).toBeGreaterThan(-1);
      expect(gone).toBeGreaterThan(retired);
      expect(credential).toBeGreaterThan(gone);
      expect(route.slice(retired, credential)).toContain(
        'code: "RESET_REQUIRED"',
      );
    }
  });

  it("dispatches only reset-authorized materialized work", async () => {
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
    const birthAuthority = dispatch.indexOf(
      "knowledgeBaseMaterializedRecoveryContractVersion(existingBuild) !== 1",
    );
    const materializedDispatch = dispatch.indexOf(
      "return dispatchMaterializedKnowledgeBaseClaim({",
    );

    expect(dispatchStart).toBeGreaterThan(-1);
    expect(migrationTypes).toBeGreaterThan(dispatchStart);
    expect(birthAuthority).toBeGreaterThan(-1);
    expect(materializedDispatch).toBeGreaterThan(birthAuthority);
    expect(dispatch).not.toContain("activateKnowledgeBaseManusV2Handoff(");
    expect(dispatch).not.toContain("knowledgeBaseManusV2RecoveryAuthority({");
    expect(dispatch).not.toContain("client.createTask({");
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
    expect(route).toContain("requireMaterializedKnowledgeBaseBuild({");
    expect(route).toContain("Browser polling is projection-only");
    expect(route).not.toContain("normalizeKnowledgeBaseTerminalRejection({");
    expect(route).not.toContain("resumeKnowledgeBaseTurnAfterUserFix({");
    expect(route).not.toContain("launchAcceptedKnowledgeBaseClaim({");
    expect(route).not.toContain("dispatchAcceptedKnowledgeBaseClaim({");
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

  it("checks anchor birth authority before skill pinning or Provider access", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const dispatchStart = source.indexOf(
      "async function dispatchKnowledgeBaseAnchorHandoffClaim(",
    );
    const dispatchEnd = source.indexOf(
      "async function persistKnowledgeBaseDispatchFailure(",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, dispatchEnd);
    const firstAuthority = dispatch.indexOf(
      "knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1",
    );
    const skillPin = dispatch.indexOf("await ensureSkillArchivePin({");
    const secondAuthority = dispatch.indexOf(
      "knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1",
      firstAuthority + 1,
    );
    const provider = dispatch.indexOf("const client =");

    expect(dispatchStart).toBeGreaterThan(-1);
    expect(dispatchEnd).toBeGreaterThan(dispatchStart);
    expect(firstAuthority).toBeGreaterThan(-1);
    expect(skillPin).toBeGreaterThan(firstAuthority);
    expect(secondAuthority).toBeGreaterThan(skillPin);
    expect(provider).toBeGreaterThan(secondAuthority);
  });

  it("checks birth authority before prepare, mapping, and the durable create fence", async () => {
    const source = await fs.readFile(
      path.resolve("server/knowledge-base-api.ts"),
      "utf8",
    );
    const dispatchStart = source.indexOf(
      "async function dispatchMaterializedKnowledgeBaseClaim(",
    );
    const dispatchEnd = source.indexOf(
      "async function dispatchKnowledgeBaseRecoveryClaim(",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, dispatchEnd);
    const birthAuthority = dispatch.indexOf(
      "knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1",
    );
    const prepare = dispatch.indexOf("await input.ensureDispatch({");
    const mapping = dispatch.indexOf("await input.ensureManusV2Attachments({");
    const writerFence = dispatch.indexOf("await input.beginDispatch({");
    const providerCreate = dispatch.indexOf("await client.createTask({");

    expect(dispatchStart).toBeGreaterThan(-1);
    expect(dispatchEnd).toBeGreaterThan(dispatchStart);
    expect(birthAuthority).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(birthAuthority);
    expect(mapping).toBeGreaterThan(prepare);
    expect(writerFence).toBeGreaterThan(mapping);
    expect(providerCreate).toBeGreaterThan(writerFence);
  });
});
