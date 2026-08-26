import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getProvider: vi.fn(),
  finalizeCredentialRevocations: vi.fn(async () => undefined),
  completeRebuildTicket: vi.fn(async () => null),
  parseApprovedReset: vi.fn(() => null as Record<string, unknown> | null),
  finalizeApprovedReset: vi.fn(async () => ({
    status: "not_applicable" as const,
  })),
  safeNoExposure: vi.fn(async () => false),
  parseSafeNoExposureProof: vi.fn(() => null),
}));

vi.mock("../db", () => ({ getDb: dependencies.getDb }));
vi.mock("./providers", () => ({
  getSiteOpsProviderHandler: dependencies.getProvider,
}));
vi.mock("../twenty-first-service", () => ({
  finalizePendingTwentyFirstCredentialRevocations:
    dependencies.finalizeCredentialRevocations,
}));
vi.mock("./rebuild-ticket", () => ({
  completeSiteOpsRebuildTicket: dependencies.completeRebuildTicket,
  parseApprovedResetUnpublishInput: dependencies.parseApprovedReset,
  finalizeApprovedSiteOpsReset: dependencies.finalizeApprovedReset,
}));
vi.mock("./esa-provider", () => ({
  approvedResetHasNoUnresolvedExternalExposure: dependencies.safeNoExposure,
  parseApprovedResetSafeNoExposureProof: dependencies.parseSafeNoExposureProof,
}));

import {
  deliveryTickets,
  localAssets,
  messages,
  siteBuilds,
  siteOperations,
  siteProjects,
} from "../../drizzle/schema";
import { runSiteOpsWorkerSweep } from "./worker";

type Write = {
  transactionId: number;
  table: unknown;
  values: Record<string, unknown>;
};

function databaseFixture() {
  const projectId = "20000000-0000-4000-8000-000000000002";
  const buildId = "30000000-0000-4000-8000-000000000003";
  const operation = {
    id: "10000000-0000-4000-8000-000000000001",
    projectId,
    userId: 7,
    conversationTurnId: null,
    buildId,
    kind: "build_revision",
    status: "queued",
    clientRequestId: "worker-atomic-success",
    inputHash: "a".repeat(64),
    input: {},
    provider: "manus",
    providerOperationId: null,
    providerTaskId: "customer-private-task-1",
    leaseOwner: null,
    leaseExpiresAt: null,
    attempt: 0,
    result: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:00.000Z"),
  };
  const build = {
    id: buildId,
    projectId,
    userId: 7,
    parentBuildId: "40000000-0000-4000-8000-000000000004",
    status: "qa_running",
    quotaPeriodId: "50000000-0000-4000-8000-000000000005",
    quotaState: "reserved",
    contractLocalAssetId: null,
    sourceLocalAssetId: null,
    distLocalAssetId: null,
    qaLocalAssetId: null,
    provenanceLocalAssetId: null,
    approvedAt: null,
  };
  const project = {
    id: projectId,
    userId: 7,
    conversationId: "siteops:7",
    currentBuildId: build.parentBuildId,
    status: "building",
    revision: 4,
    globalLiveDeploymentId: null,
    mainlandLiveDeploymentId: null,
  };
  const ticket = {
    id: "70000000-0000-4000-8000-000000000007",
    userId: 7,
    operation: "site_rebuild",
    status: "in_progress",
    internalNote: null as string | null,
  };
  const kinds = ["contract", "source", "dist", "qa", "provenance"] as const;
  const artifactBindings = Object.fromEntries(
    kinds.map((kind, index) => {
      const id = `60000000-0000-4000-8000-00000000000${index + 1}`;
      return [
        kind,
        {
          id,
          sha256: String(index + 1).repeat(64),
          bytes: index + 10,
          mimeType:
            kind === "contract" || kind === "provenance"
              ? "application/json"
              : "application/zip",
        },
      ];
    }),
  ) as Record<
    (typeof kinds)[number],
    { id: string; sha256: string; bytes: number; mimeType: string }
  >;
  const storageKinds = {
    contract: "site-contract",
    source: "site-source",
    dist: "site-dist",
    qa: "site-qa",
    provenance: "site-provenance",
  } as const;
  const assets = kinds.map((kind) => ({
    id: artifactBindings[kind].id,
    scope: "managed_user",
    accountUserId: 7,
    presalesProjectId: null,
    mimeType: artifactBindings[kind].mimeType,
    sizeBytes: artifactBindings[kind].bytes,
    contentSha256: artifactBindings[kind].sha256,
    storageKey: `siteops:${projectId}:${storageKinds[kind]}:${artifactBindings[kind].id}`,
  }));

  const writes: Write[] = [];
  let transactionId = 0;
  let activeTransactionId = 0;
  const rowsFor = (table: unknown) => {
    if (table === siteOperations) return [operation];
    if (table === siteBuilds) return [build];
    if (table === localAssets) return assets;
    if (table === siteProjects) return [project];
    if (table === messages) return [{ sequence: 0 }];
    if (table === deliveryTickets) return [ticket];
    return [];
  };
  const select = () => {
    let table: unknown;
    const query: any = {
      from(value: unknown) {
        table = value;
        return query;
      },
      where() {
        return query;
      },
      orderBy() {
        return query;
      },
      limit() {
        return query;
      },
      for() {
        return Promise.resolve(rowsFor(table));
      },
      then(
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) {
        return Promise.resolve(rowsFor(table)).then(resolve, reject);
      },
    };
    return query;
  };
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        writes.push({ transactionId: activeTransactionId, table, values });
        if (table === siteOperations) Object.assign(operation, values);
        if (table === siteBuilds) Object.assign(build, values);
        if (table === siteProjects) Object.assign(project, values);
        return [{ affectedRows: 1 }];
      },
    }),
  });
  const insert = (table: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      writes.push({ transactionId: activeTransactionId, table, values });
    },
  });
  const tx = { select, update, insert };
  const db = {
    ...tx,
    transaction: async <T>(callback: (executor: typeof tx) => Promise<T>) => {
      transactionId += 1;
      const previous = activeTransactionId;
      activeTransactionId = transactionId;
      try {
        return await callback(tx);
      } finally {
        activeTransactionId = previous;
      }
    },
  };
  return {
    db,
    writes,
    operation,
    build,
    project,
    ticket,
    artifactBindings,
  };
}

beforeEach(() => {
  dependencies.getDb.mockReset();
  dependencies.getProvider.mockReset();
  dependencies.completeRebuildTicket.mockClear();
  dependencies.finalizeCredentialRevocations.mockClear();
  dependencies.parseApprovedReset.mockReset().mockReturnValue(null);
  dependencies.finalizeApprovedReset
    .mockReset()
    .mockResolvedValue({ status: "not_applicable" });
  dependencies.safeNoExposure.mockReset().mockResolvedValue(false);
  dependencies.parseSafeNoExposureProof.mockReset().mockReturnValue(null);
});

describe("SiteOps React/QA terminal transaction", () => {
  it("atomically approves the verified build/project, succeeds the operation, and consumes revision quota", async () => {
    const fixture = databaseFixture();
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.getProvider.mockReturnValue(
      vi.fn(async ({ assertLeaseActive }) => {
        await assertLeaseActive?.();
        return {
          status: "succeeded",
          providerTaskId: "customer-private-task-1",
          projectStatus: "preview_ready",
          buildStatus: "preview_ready",
          result: { artifactBindings: fixture.artifactBindings },
          message: "FrontMind React 官网已完成 QA。",
        };
      }),
    );

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    });

    const terminalWrites = fixture.writes.filter(
      (write) => write.transactionId === 2,
    );
    const operationWrite = terminalWrites.find(
      (write) =>
        write.table === siteOperations && write.values.status === "succeeded",
    );
    const buildWrite = terminalWrites.find(
      (write) =>
        write.table === siteBuilds && write.values.status === "approved",
    );
    const projectWrite = terminalWrites.find(
      (write) =>
        write.table === siteProjects && write.values.status === "approved",
    );

    expect(operationWrite?.values).toMatchObject({
      status: "succeeded",
      providerTaskId: "customer-private-task-1",
      errorCode: null,
      errorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(buildWrite?.values).toMatchObject({
      status: "approved",
      quotaState: "consumed",
      errorCode: null,
      errorMessage: null,
    });
    expect(buildWrite?.values.approvedAt).toBeInstanceOf(Date);
    expect(projectWrite?.values).toMatchObject({
      status: "approved",
      currentBuildId: fixture.build.id,
    });
    expect(operationWrite).toBeTruthy();
    expect(buildWrite).toBeTruthy();
    expect(projectWrite).toBeTruthy();
    expect(fixture.operation.status).toBe("succeeded");
    expect(fixture.build).toMatchObject({
      status: "approved",
      quotaState: "consumed",
    });
    expect(fixture.project.status).toBe("approved");
    expect(fixture.project.currentBuildId).toBe(fixture.build.id);
    expect(dependencies.completeRebuildTicket).not.toHaveBeenCalled();
  });

  it("consumes the reserved quota for a successful root website build", async () => {
    const fixture = databaseFixture();
    fixture.operation.kind = "site_build";
    fixture.build.parentBuildId = null;
    fixture.project.currentBuildId = fixture.build.id;
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.getProvider.mockReturnValue(
      vi.fn(async () => ({
        status: "succeeded",
        providerTaskId: "customer-private-task-1",
        projectStatus: "preview_ready",
        buildStatus: "preview_ready",
        result: { artifactBindings: fixture.artifactBindings },
        message: "官网已完成。",
      })),
    );

    await runSiteOpsWorkerSweep({ max: 1 });

    expect(fixture.build).toMatchObject({
      status: "approved",
      quotaState: "consumed",
    });
    expect(fixture.project).toMatchObject({
      status: "approved",
      currentBuildId: fixture.build.id,
    });
  });

  it("finalizes an approved reset without entering the generic rollback finalizer", async () => {
    const fixture = databaseFixture();
    const reset = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: "60000000-0000-4000-8000-000000000006",
      expectedProjectRevision: 4,
      expectedCurrentBuildId: fixture.project.currentBuildId,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
    };
    fixture.operation.kind = "rollback";
    fixture.operation.provider = "aliyun_esa";
    fixture.operation.input = reset;
    dependencies.parseApprovedReset.mockReturnValue(reset);
    dependencies.finalizeApprovedReset.mockResolvedValue({
      status: "applied",
      projectRevision: 5,
      internalNote: "safe-marker",
      operationResult: {
        schemaVersion: 2,
        intent: "approved_reset_unpublish",
        stage: "exposure_removed",
        resetOperationId: fixture.operation.id,
        projectId: fixture.project.id,
        freshRootApplied: true,
        minimumKnowledgeSnapshotVersion: 8,
        resetAppliedProjectRevision: 5,
      },
    });
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.getProvider.mockReturnValue(
      vi.fn(async () => ({
        status: "succeeded",
        result: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          stage: "exposure_removed",
        },
        message: "旧网站已下线。",
      })),
    );

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    });

    expect(dependencies.finalizeApprovedReset).toHaveBeenCalledTimes(1);
    expect(dependencies.finalizeApprovedReset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: expect.objectContaining({
          id: fixture.operation.id,
          kind: "rollback",
        }),
      }),
    );
    expect(fixture.operation.status).toBe("succeeded");
    expect(fixture.operation.result).toMatchObject({
      schemaVersion: 2,
      resetOperationId: fixture.operation.id,
      projectId: fixture.project.id,
      minimumKnowledgeSnapshotVersion: 8,
      resetAppliedProjectRevision: 5,
    });
    const terminalWrites = fixture.writes.filter(
      (write) => write.transactionId === 2,
    );
    expect(
      terminalWrites.some(
        (write) => write.table === siteBuilds || write.table === siteProjects,
      ),
    ).toBe(false);
  });

  it("automatically requeues the same safe pre-mutation reset operation and finalizes it", async () => {
    const fixture = databaseFixture();
    const reset = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: fixture.ticket.id,
      expectedProjectRevision: 4,
      expectedCurrentBuildId: fixture.project.currentBuildId,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
    };
    fixture.operation.kind = "rollback";
    fixture.operation.provider = "aliyun_esa";
    fixture.operation.status = "attention_required";
    fixture.operation.input = reset;
    fixture.operation.result = null;
    fixture.operation.providerOperationId = null;
    fixture.operation.providerTaskId = null;
    fixture.operation.errorCode = "ESA_RUNTIME_DISABLED";
    fixture.operation.attempt = 7;
    fixture.operation.completedAt = new Date("2026-08-26T00:00:00.000Z");
    fixture.ticket.internalNote = JSON.stringify({
      schemaVersion: 4,
      kind: "frontmind.siteops-rebuild.v1",
      projectId: fixture.project.id,
      sourceBuildId: fixture.project.currentBuildId,
      knowledgeSnapshotId: null,
      resetIntent: "approved_reset_unpublish",
      resetOperationId: fixture.operation.id,
      resetApprovedAt: "2026-08-26T00:00:00.000Z",
      resetExpectedProjectRevision: 4,
      minimumKnowledgeSnapshotVersion: 8,
    });
    const migrationProof = {
      schemaVersion: 1 as const,
      classification: "safe_no_exposure" as const,
      source: "migration_0065_revision_only" as const,
      resetOperationId: fixture.operation.id,
      projectId: fixture.project.id,
      expectedProjectRevision: 4,
      observedProjectRevision: 5,
      observedProjectUpdatedAt: "2026-08-26T01:00:00.000Z",
    };
    dependencies.parseApprovedReset.mockReturnValue(reset);
    dependencies.safeNoExposure.mockResolvedValue(migrationProof);
    dependencies.parseSafeNoExposureProof.mockReturnValue(migrationProof);
    dependencies.finalizeApprovedReset.mockResolvedValue({
      status: "applied",
      projectRevision: 5,
      internalNote: "safe-marker",
      operationResult: {
        schemaVersion: 2,
        intent: "approved_reset_unpublish",
        stage: "exposure_removed",
        resetOperationId: fixture.operation.id,
        projectId: fixture.project.id,
        freshRootApplied: true,
        minimumKnowledgeSnapshotVersion: 8,
        resetAppliedProjectRevision: 5,
      },
    });
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.getProvider.mockReturnValue(
      vi.fn(async () => ({
        status: "succeeded",
        result: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          stage: "exposure_removed",
          safeNoExposureProof: migrationProof,
        },
        message: "无需执行 ESA 下线。",
      })),
    );

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    });

    expect(dependencies.safeNoExposure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ id: fixture.operation.id }),
        reset,
        allowCanonicalHostname: true,
        allowMigration0065RevisionDrift: true,
      }),
    );
    expect(dependencies.finalizeApprovedReset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ safeNoExposureProof: migrationProof }),
    );
    expect(dependencies.getProvider).toHaveBeenCalledOnce();
    expect(fixture.operation.id).toBe("10000000-0000-4000-8000-000000000001");
    expect(fixture.operation.status).toBe("succeeded");
    expect(fixture.operation.attempt).toBe(8);
  });

  it("leaves an unsafe attention-required reset terminal and does not invoke a provider", async () => {
    const fixture = databaseFixture();
    const reset = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: fixture.ticket.id,
      expectedProjectRevision: 4,
      expectedCurrentBuildId: fixture.project.currentBuildId,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
    };
    fixture.operation.kind = "rollback";
    fixture.operation.provider = "aliyun_esa";
    fixture.operation.status = "attention_required";
    fixture.operation.input = reset;
    fixture.operation.result = null;
    fixture.operation.errorCode = "ESA_RUNTIME_DISABLED";
    fixture.ticket.internalNote = JSON.stringify({
      schemaVersion: 4,
      kind: "frontmind.siteops-rebuild.v1",
      projectId: fixture.project.id,
      sourceBuildId: fixture.project.currentBuildId,
      knowledgeSnapshotId: null,
      resetIntent: "approved_reset_unpublish",
      resetOperationId: fixture.operation.id,
      resetApprovedAt: "2026-08-26T00:00:00.000Z",
      resetExpectedProjectRevision: 4,
      minimumKnowledgeSnapshotVersion: 8,
    });
    dependencies.parseApprovedReset.mockReturnValue(reset);
    dependencies.safeNoExposure.mockResolvedValue(false);
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    });

    expect(dependencies.getProvider).not.toHaveBeenCalled();
    expect(fixture.operation.status).toBe("attention_required");
  });

  it("terminalizes stale auto-recovery coordinates without aborting the sweep", async () => {
    const fixture = databaseFixture();
    const reset = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: fixture.ticket.id,
      expectedProjectRevision: 4,
      expectedCurrentBuildId: fixture.project.currentBuildId,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
    };
    fixture.operation.kind = "rollback";
    fixture.operation.provider = "aliyun_esa";
    fixture.operation.status = "attention_required";
    fixture.operation.input = reset;
    fixture.operation.result = null;
    fixture.operation.providerOperationId = null;
    fixture.operation.providerTaskId = null;
    fixture.operation.errorCode = "ESA_RUNTIME_DISABLED";
    fixture.ticket.internalNote = JSON.stringify({
      schemaVersion: 4,
      kind: "frontmind.siteops-rebuild.v1",
      projectId: fixture.project.id,
      sourceBuildId: fixture.project.currentBuildId,
      knowledgeSnapshotId: null,
      resetIntent: "approved_reset_unpublish",
      resetOperationId: fixture.operation.id,
      resetApprovedAt: "2026-08-26T00:00:00.000Z",
      resetExpectedProjectRevision: 4,
      minimumKnowledgeSnapshotVersion: 8,
    });
    dependencies.parseApprovedReset.mockReturnValue(reset);
    dependencies.safeNoExposure.mockRejectedValue({
      code: "SITEOPS_RESET_INVALIDATED",
    });
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    });

    expect(dependencies.getProvider).not.toHaveBeenCalled();
    expect(fixture.operation).toMatchObject({
      status: "failed",
      errorCode: "SITEOPS_RESET_INVALIDATED",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("keeps approved-reset outcome unknown terminal instead of polling forever", async () => {
    const fixture = databaseFixture();
    const reset = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: fixture.ticket.id,
      expectedProjectRevision: 4,
      expectedCurrentBuildId: fixture.project.currentBuildId,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
    };
    fixture.operation.kind = "rollback";
    fixture.operation.provider = "aliyun_esa";
    fixture.operation.status = "queued";
    fixture.operation.input = reset;
    fixture.operation.result = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      stage: "routine_delete_unknown",
      stageStartedAttempt: 1,
    };
    dependencies.parseApprovedReset.mockReturnValue(reset);
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.getProvider.mockReturnValue(
      vi.fn(async () => ({
        status: "outcome_unknown",
        code: "ESA_ROUTINE_DELETE_OUTCOME_UNKNOWN",
        message: "ESA Routine 删除结果无法确认。",
        result: fixture.operation.result,
      })),
    );

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 1,
      failed: 0,
    });

    expect(fixture.operation).toMatchObject({
      status: "outcome_unknown",
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: "ESA_ROUTINE_DELETE_OUTCOME_UNKNOWN",
    });
    expect(fixture.operation.completedAt).toBeInstanceOf(Date);
  });

  it("also terminalizes an AliDNS reset predecessor outcome unknown", async () => {
    const fixture = databaseFixture();
    const reset = {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: fixture.ticket.id,
      expectedProjectRevision: 4,
      expectedCurrentBuildId: fixture.project.currentBuildId,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
    };
    const nestedInput = {
      schemaVersion: 1,
      dnsIntent: "rollback",
      approvedReset: reset,
    };
    fixture.operation.kind = "dns_rollback";
    fixture.operation.provider = "aliyun_alidns";
    fixture.operation.status = "queued";
    fixture.operation.input = nestedInput;
    fixture.operation.result = {
      schemaVersion: 1,
      stage: "dns_rollback_outcome_unknown",
    };
    dependencies.parseApprovedReset.mockImplementation((value) =>
      value === reset ? reset : null,
    );
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.getProvider.mockReturnValue(
      vi.fn(async () => ({
        status: "outcome_unknown",
        code: "ALIDNS_ROLLBACK_OUTCOME_UNKNOWN",
        message: "AliDNS 回滚结果无法确认。",
        result: fixture.operation.result,
      })),
    );

    await expect(runSiteOpsWorkerSweep({ max: 1 })).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 1,
      failed: 0,
    });

    expect(dependencies.parseApprovedReset).toHaveBeenCalledWith(nestedInput);
    expect(dependencies.parseApprovedReset).toHaveBeenCalledWith(reset);
    expect(fixture.operation).toMatchObject({
      status: "outcome_unknown",
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: "ALIDNS_ROLLBACK_OUTCOME_UNKNOWN",
    });
    expect(fixture.operation.completedAt).toBeInstanceOf(Date);
  });
});
