import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getProvider: vi.fn(),
  finalizeCredentialRevocations: vi.fn(async () => undefined),
  completeRebuildTicket: vi.fn(async () => null),
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
}));

import {
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
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
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
    artifactBindings,
  };
}

beforeEach(() => {
  dependencies.getDb.mockReset();
  dependencies.getProvider.mockReset();
  dependencies.completeRebuildTicket.mockClear();
  dependencies.finalizeCredentialRevocations.mockClear();
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
    expect(dependencies.completeRebuildTicket).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 7,
        parentBuildId: "40000000-0000-4000-8000-000000000004",
        childBuildId: fixture.build.id,
      }),
    );
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
});
