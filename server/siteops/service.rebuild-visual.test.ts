import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getServicePortal: vi.fn(async () => ({})),
  reserveQuota: vi.fn(async () => "50000000-0000-4000-8000-000000000005"),
  loadRebuild: vi.fn(),
  getTwentyFirstCredentialStatus: vi.fn(async () => ({
    configured: true,
    version: 3,
    fingerprint: "fingerprint",
    capabilities: { search: true },
    nativeTemplateReadiness: "ready" as const,
  })),
}));

vi.mock("../db", () => ({ getDb: dependencies.getDb }));
vi.mock("../service-entitlement", () => ({
  getServicePortal: dependencies.getServicePortal,
}));
vi.mock("./quota-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./quota-service")>();
  return {
    ...actual,
    assertSiteOpsServiceEntitlement: (portal: unknown) => portal,
    siteOpsQuotaPeriodIds: () => ["50000000-0000-4000-8000-000000000005"],
    reserveSiteOpsQuota: dependencies.reserveQuota,
  };
});
vi.mock("./rebuild-ticket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rebuild-ticket")>();
  return { ...actual, loadSiteOpsRebuildRequest: dependencies.loadRebuild };
});
vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return { ...actual, siteOpsProviderConfigured: () => false };
});
vi.mock("../twenty-first-service", () => ({
  getTwentyFirstCredentialStatus: dependencies.getTwentyFirstCredentialStatus,
}));

import {
  apiCredentials,
  conversationTurns,
  knowledgeBaseSnapshots,
  messages,
  presalesApiCredentials,
  siteBuilds,
  siteOperations,
  siteProjects,
  users,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../../drizzle/schema";
import { SITEOPS_MATERIALIZER_V2_6 } from "../../shared/siteops";
import { referenceBlueprintV4ForFamily } from "../../shared/siteops-design";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import { actOnSiteOps, siteBriefFromSnapshot } from "./service";

type Insert = { table: unknown; values: Record<string, unknown> };

function serviceDatabaseFixture() {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const project = {
    id: "10000000-0000-4000-8000-000000000001",
    userId: 7,
    conversationId: "siteops:7",
    currentKnowledgeSnapshotId: "20000000-0000-4000-8000-000000000002",
    currentBuildId: "30000000-0000-4000-8000-000000000003",
    globalLiveDeploymentId: null,
    mainlandLiveDeploymentId: null,
    primaryLanguage: "zh-CN",
    canonicalHostname: null,
    status: "awaiting_visual_selection",
    revision: 8,
    brief: null,
    currentTaskStartedAt: now,
    minimumKnowledgeSnapshotVersion: null as number | null,
    updatedAt: now,
  };
  const snapshot = {
    id: project.currentKnowledgeSnapshotId,
    userId: 7,
    archiveHash: "a".repeat(64),
    version: 2,
    sourceFileName: "knowledge.zip",
    documents: [
      {
        id: "overview-source",
        path: "企业概览.md",
        title: "企业概览",
        content: "星河智造提供经过来源核验的设备巡检服务。",
        kind: "overview",
        evidenceStatus: "verified_first_party",
        customerVisible: true,
      },
    ],
    assets: [],
    status: "active",
    createdAt: now,
  };
  const snapshots = [snapshot];
  const userRows: Array<{ id: number }> = [{ id: 7 }];
  const sampleId = "40000000-0000-4000-8000-000000000004";
  const previewLocalAssetId = "41000000-0000-4000-8000-000000000004";
  const visualOperationId = "42000000-0000-4000-8000-000000000004";
  const platformCredentialId = "43000000-0000-4000-8000-000000000004";
  const customerCredentialId = "44000000-0000-4000-8000-000000000004";
  const evidence = createVisualEvidenceV1({
    evidenceKind: "catalog_metadata_preview_v1",
    providerItemKey: "n:8435",
    metadataSha256: "b".repeat(64),
    providerResponseSha256: "c".repeat(64),
    previewSha256: "d".repeat(64),
    taxonomyDerivationVersion: "catalog-metadata-preview-v1",
  });
  const referencePreviewLocalAssetId = "41100000-0000-4000-8000-000000000004";
  const realizationPreviewSha256 = "e".repeat(64);
  const inspirationTaxonomy = {
    role: "foundation" as const,
    palette: [],
    typography: [],
    layout: ["split-layout"],
    motion: [],
    accessibility: ["reduced-motion"],
  };
  const referenceBlueprint = referenceBlueprintV4ForFamily({
    candidateId: sampleId,
    providerItemKey: evidence.providerItemKey,
    referencePreviewLocalAssetId,
    referencePreviewSha256: evidence.previewSha256,
    realizationPreviewLocalAssetId: previewLocalAssetId,
    realizationPreviewSha256,
    heroFamily: "split_media",
    inspirationEvidenceId: evidence.evidenceSha256,
    inspirationTaxonomy,
  });
  const batch = {
    id: "45000000-0000-4000-8000-000000000004",
    userId: 7,
    siteProjectId: project.id,
    sourceKind: "siteops_21st",
    status: "published",
    selectionBundleHash: "e".repeat(64),
    engineerNote: `siteops-21st-operation:${visualOperationId}`,
  };
  const sample = {
    id: sampleId,
    batchId: batch.id,
    label: "A",
    note: "浮动轨道 Hero",
    previewLocalAssetId: referencePreviewLocalAssetId,
    sourceMetadata: {
      providerItemKey: evidence.providerItemKey,
      title: "Floating Orbit Hero",
      sourceUrl: "https://21st.dev/community/components/floating-orbit",
      visualEvidence: evidence,
      taxonomy: inspirationTaxonomy,
      referenceBlueprint,
      realizationPreviewLocalAssetId: previewLocalAssetId,
      realizationPreviewSha256,
      referencePerceptualHash: "1".repeat(16),
      realizationPerceptualHash: "2".repeat(16),
      score: 95,
    },
  };
  const visualRows = [{ sample, batch }];
  const publishedBatches: Array<{ id: string }> = [];
  const activeVisualOperations: Array<{ id: string }> = [];
  const visualOperationInput = {
    knowledgeSnapshotId: snapshot.id,
    credentialId: platformCredentialId,
    credentialVersion: 3,
    workflowVersion: SITEOPS_MATERIALIZER_V2_6.frontMindVersion,
  };
  const customerCredential = {
    id: customerCredentialId,
    userId: 7,
    version: 6,
    agentProfile: "frontmind-pro",
    status: "active",
    validationStatus: "verified",
    verifiedAt: now,
    deletedAt: null,
  };

  const inserts: Insert[] = [];
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const insertFailures = new Map<unknown, unknown>();
  let inTransaction = false;
  const rowsFor = (table: unknown, selection: unknown) => {
    const keys = Object.keys((selection as Record<string, unknown>) ?? {});
    if (table === siteProjects) return [project];
    if (table === siteBuilds) {
      if (inTransaction && keys.includes("id")) return [];
      if (inTransaction && keys.includes("ordinal")) return [{ ordinal: 1 }];
      return [];
    }
    if (table === websiteStyleSamples) {
      return inTransaction && keys.includes("sample") ? visualRows : [];
    }
    if (table === knowledgeBaseSnapshots) return snapshots;
    if (table === users) return userRows;
    if (table === siteOperations) {
      if (inTransaction && keys.includes("input")) {
        return [{ input: visualOperationInput }];
      }
      if (inTransaction && keys.includes("id")) {
        return activeVisualOperations;
      }
      return [];
    }
    if (table === presalesApiCredentials) {
      if (inTransaction && keys.includes("version")) {
        return [
          { id: platformCredentialId, version: 3, fingerprint: "fingerprint" },
        ];
      }
      return keys.includes("slot") ? [{ slot: "site_builder_21st" }] : [];
    }
    if (table === apiCredentials) {
      return inTransaction
        ? [customerCredential]
        : [{ id: customerCredentialId }];
    }
    if (table === messages) {
      return inTransaction && keys.includes("sequence")
        ? [{ sequence: 0 }]
        : [];
    }
    if (table === websiteStyleSampleBatches) return publishedBatches;
    return [];
  };
  const select = (selection?: unknown) => {
    let table: unknown;
    const query: any = {
      from(value: unknown) {
        table = value;
        return query;
      },
      innerJoin() {
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
        return Promise.resolve(rowsFor(table, selection));
      },
      then(
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) {
        return Promise.resolve(rowsFor(table, selection)).then(resolve, reject);
      },
    };
    return query;
  };
  const tx = {
    select,
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (insertFailures.has(table)) throw insertFailures.get(table);
        inserts.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
          if (table === siteProjects) Object.assign(project, values);
          if (table === websiteStyleSampleBatches) Object.assign(batch, values);
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };
  const db = {
    ...tx,
    transaction: async <T>(callback: (executor: typeof tx) => Promise<T>) => {
      inTransaction = true;
      try {
        return await callback(tx);
      } finally {
        inTransaction = false;
      }
    },
  };
  return {
    db,
    project,
    sample,
    batch,
    inserts,
    insertFailures,
    updates,
    customerCredential,
    visualRows,
    publishedBatches,
    activeVisualOperations,
    snapshots,
    userRows,
    inspirationTaxonomy,
    referenceBlueprint,
  };
}

const actor = {
  id: 7,
  role: "user",
  username: "customer-7",
} as const;

function selectVisualInput(revision: number, sampleId: string) {
  return {
    conversationId: "siteops:7",
    action: "select_visual",
    clientRequestId: "select-visual-rebuild-1",
    expectedRevision: revision,
    input: { sampleId },
  };
}

function delegateVisualInput(revision: number) {
  return {
    conversationId: "siteops:7",
    action: "delegate_visual",
    clientRequestId: "delegate-visual-across-pages-1",
    expectedRevision: revision,
    input: {},
  } as const;
}

function connectKnowledgeInput(revision: number, knowledgeSnapshotId?: string) {
  return {
    conversationId: "siteops:7",
    action: "select_snapshot",
    clientRequestId: "connect-current-knowledge-1",
    expectedRevision: revision,
    input: knowledgeSnapshotId ? { knowledgeSnapshotId } : {},
  } as const;
}

beforeEach(() => {
  dependencies.getDb.mockReset();
  dependencies.reserveQuota.mockClear();
  dependencies.loadRebuild.mockReset();
  dependencies.loadRebuild.mockResolvedValue({
    allowed: false,
    ticketId: null,
    status: null,
    resetApplied: false,
    resetPending: false,
    minimumKnowledgeSnapshotVersion: null,
    resetSourceBuildId: null,
    acceptedForCurrentCycle: false,
  });
  dependencies.getServicePortal.mockClear();
  dependencies.getTwentyFirstCredentialStatus.mockClear();
});

describe("SiteOps visual selection and current-task revisions", () => {
  it("locks the account and binds the newest valid active snapshot without a client-selected id", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentKnowledgeSnapshotId = null;
    fixture.project.currentBuildId = null;
    fixture.project.status = "draft";
    const validSnapshot = fixture.snapshots[0]!;
    fixture.snapshots.unshift({
      ...validSnapshot,
      id: "21000000-0000-4000-8000-000000000002",
      version: 3,
      archiveHash: "not-a-valid-digest",
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
    });
    dependencies.getDb.mockResolvedValue(fixture.db);
    await actOnSiteOps(
      actor as never,
      connectKnowledgeInput(fixture.project.revision),
    );

    expect(fixture.project).toMatchObject({
      currentKnowledgeSnapshotId: validSnapshot.id,
      status: "collecting_brief",
      revision: 9,
    });
    expect(
      fixture.inserts.find(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "brief_message",
      )?.values,
    ).toMatchObject({
      status: "succeeded",
      input: {
        knowledgeSnapshotId: validSnapshot.id,
        knowledgeArchiveHash: validSnapshot.archiveHash,
      },
    });
  });

  it("reconnects a retained legacy snapshot pointer on an otherwise fresh draft", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    fixture.project.status = "draft";
    const validSnapshot = fixture.snapshots[0]!;
    fixture.project.currentKnowledgeSnapshotId = validSnapshot.id;
    dependencies.getDb.mockResolvedValue(fixture.db);

    await actOnSiteOps(
      actor as never,
      connectKnowledgeInput(fixture.project.revision),
    );

    expect(fixture.project).toMatchObject({
      currentKnowledgeSnapshotId: validSnapshot.id,
      status: "collecting_brief",
      revision: 9,
    });
    expect(
      fixture.inserts.filter(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "brief_message",
      ),
    ).toHaveLength(1);

    await expect(
      actOnSiteOps(actor as never, {
        ...connectKnowledgeInput(fixture.project.revision),
        clientRequestId: "connect-current-knowledge-2",
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });
    expect(
      fixture.inserts.filter(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "brief_message",
      ),
    ).toHaveLength(1);
  });

  it("accepts an old client id only when it equals the newest valid active snapshot", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentKnowledgeSnapshotId = null;
    fixture.project.currentBuildId = null;
    fixture.project.status = "draft";
    const currentSnapshot = fixture.snapshots[0]!;
    dependencies.getDb.mockResolvedValue(fixture.db);

    await actOnSiteOps(
      actor as never,
      connectKnowledgeInput(fixture.project.revision, currentSnapshot.id),
    );

    expect(fixture.project.currentKnowledgeSnapshotId).toBe(currentSnapshot.id);
  });

  it("rejects an old client snapshot id when it is not the newest valid active snapshot", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentKnowledgeSnapshotId = null;
    fixture.project.currentBuildId = null;
    fixture.project.status = "draft";
    const currentSnapshot = fixture.snapshots[0]!;
    fixture.snapshots.unshift({
      ...currentSnapshot,
      id: "21000000-0000-4000-8000-000000000002",
      version: 3,
      archiveHash: "b".repeat(64),
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
    });
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(
      actOnSiteOps(
        actor as never,
        connectKnowledgeInput(fixture.project.revision, currentSnapshot.id),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", statusCode: 409 });
    expect(fixture.project.currentKnowledgeSnapshotId).toBeNull();
  });

  it("fails closed before reading knowledge snapshots when the account lock is missing", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentKnowledgeSnapshotId = null;
    fixture.project.currentBuildId = null;
    fixture.project.status = "draft";
    fixture.userRows.splice(0);
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(
      actOnSiteOps(
        actor as never,
        connectKnowledgeInput(fixture.project.revision),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(fixture.project.currentKnowledgeSnapshotId).toBeNull();
  });

  it("rejects a second supplemental visual operation while one is active", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    Object.assign(fixture.project, {
      brief: siteBriefFromSnapshot({
        sourceFileName: "knowledge.zip",
        documents: [
          {
            id: "overview-source",
            path: "企业概览.md",
            title: "企业概览",
            content: "星河智造提供经过来源核验的设备巡检服务。",
            kind: "overview",
            evidenceStatus: "verified_first_party",
            customerVisible: true,
          },
        ],
        assets: [],
      } as never),
    });
    fixture.publishedBatches.push({ id: fixture.batch.id });
    fixture.activeVisualOperations.push({
      id: "47000000-0000-4000-8000-000000000004",
    });
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(
      actOnSiteOps(actor as never, {
        conversationId: "siteops:7",
        action: "reselect_visual",
        clientRequestId: "reselect-visual-while-active",
        expectedRevision: fixture.project.revision,
        input: {},
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });
    expect(
      fixture.inserts.some(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "visual_search",
      ),
    ).toBe(false);
  });

  it("rejects a fourth visual page before reserving another operation", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    Object.assign(fixture.project, {
      brief: siteBriefFromSnapshot({
        sourceFileName: "knowledge.zip",
        documents: [
          {
            id: "overview-source",
            path: "企业概览.md",
            title: "企业概览",
            content: "星河智造提供经过来源核验的设备巡检服务。",
            kind: "overview",
            evidenceStatus: "verified_first_party",
            customerVisible: true,
          },
        ],
        assets: [],
      } as never),
    });
    fixture.publishedBatches.push(
      { id: "45000000-0000-4000-8000-000000000001" },
      { id: "45000000-0000-4000-8000-000000000002" },
      { id: "45000000-0000-4000-8000-000000000003" },
    );
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(
      actOnSiteOps(actor as never, {
        conversationId: "siteops:7",
        action: "reselect_visual",
        clientRequestId: "reselect-visual-page-four",
        expectedRevision: fixture.project.revision,
        input: {},
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });
    expect(
      fixture.inserts.some((entry) => entry.table === siteOperations),
    ).toBe(false);
  });

  it("recommends the highest score across all 27 published candidates", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    fixture.visualRows.splice(
      0,
      fixture.visualRows.length,
      ...Array.from({ length: 27 }, (_, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        const sampleId = `40000000-0000-4000-8000-${suffix}`;
        const realizationPreviewLocalAssetId = `41000000-0000-4000-8000-${suffix}`;
        const referencePreviewLocalAssetId = `41100000-0000-4000-8000-${suffix}`;
        const digest = ((index % 15) + 1).toString(16).repeat(64);
        const realizationPreviewSha256 = (index + 16)
          .toString(16)
          .repeat(64)
          .slice(0, 64);
        const visualEvidence = createVisualEvidenceV1({
          evidenceKind: "catalog_metadata_preview_v1",
          providerItemKey: `n:${index + 1}`,
          metadataSha256: digest,
          providerResponseSha256: digest,
          previewSha256: digest,
          taxonomyDerivationVersion: "catalog-metadata-preview-v1",
        });
        const referenceBlueprint = referenceBlueprintV4ForFamily({
          candidateId: sampleId,
          providerItemKey: visualEvidence.providerItemKey,
          referencePreviewLocalAssetId,
          referencePreviewSha256: visualEvidence.previewSha256,
          realizationPreviewLocalAssetId,
          realizationPreviewSha256,
          heroFamily: "split_media",
          inspirationEvidenceId: visualEvidence.evidenceSha256,
          inspirationTaxonomy: fixture.inspirationTaxonomy,
        });
        return {
          batch: fixture.batch,
          sample: {
            ...fixture.sample,
            id: sampleId,
            previewLocalAssetId: referencePreviewLocalAssetId,
            sourceMetadata: {
              ...fixture.sample.sourceMetadata,
              providerItemKey: visualEvidence.providerItemKey,
              visualEvidence,
              referenceBlueprint,
              realizationPreviewLocalAssetId,
              realizationPreviewSha256,
              referencePerceptualHash: index.toString(16).padStart(16, "0"),
              score: index,
            },
          },
        };
      }),
    );
    dependencies.getDb.mockResolvedValue(fixture.db);

    await actOnSiteOps(
      actor as never,
      delegateVisualInput(fixture.project.revision),
    );

    expect(
      fixture.inserts.find((entry) => entry.table === siteBuilds)?.values,
    ).toMatchObject({
      styleSampleId: "40000000-0000-4000-8000-000000000027",
    });
  });

  it("reserves the first website build quota and makes the root build current", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    dependencies.getDb.mockResolvedValue(fixture.db);

    await actOnSiteOps(
      actor as never,
      selectVisualInput(fixture.project.revision, fixture.sample.id),
    );

    const buildInsert = fixture.inserts.find(
      (entry) => entry.table === siteBuilds,
    );
    const operationInsert = fixture.inserts.find(
      (entry) =>
        entry.table === siteOperations && entry.values.kind === "site_build",
    );
    // One transaction-local read enforces resetPending before reserving quota;
    // the second read projects the committed observation.
    expect(dependencies.loadRebuild).toHaveBeenCalledTimes(2);
    expect(dependencies.reserveQuota).toHaveBeenCalledOnce();
    expect(buildInsert?.values).toMatchObject({
      parentBuildId: null,
      quotaPeriodId: "50000000-0000-4000-8000-000000000005",
      quotaState: "reserved",
      workflowVersion: SITEOPS_MATERIALIZER_V2_6.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V2_6.runtimeManifestSha256,
    });
    expect(operationInsert?.values).toMatchObject({
      kind: "site_build",
      input: {
        workflowVersion: SITEOPS_MATERIALIZER_V2_6.frontMindVersion,
        referenceBlueprint: fixture.referenceBlueprint,
      },
    });
    expect(fixture.project.currentBuildId).toBe(buildInsert?.values.id);
  });

  it("returns one safe 503 when select_visual build persistence rolls back", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    const secret = "customer-private-template-choice";
    const driverError = Object.assign(
      new Error(
        `Data too long for column 'workflow_upstream_version': ${secret}`,
      ),
      {
        code: "ER_DATA_TOO_LONG",
        errno: 1406,
        sqlState: "22001",
      },
    );
    fixture.insertFailures.set(
      siteBuilds,
      Object.assign(new Error(`Failed query with ${secret}`), {
        query: "insert into site_builds values (?)",
        params: [secret],
        cause: driverError,
      }),
    );
    dependencies.getDb.mockResolvedValue(fixture.db);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const previousRelease = process.env.FRONTMIND_BUILD_SHA;
    process.env.FRONTMIND_BUILD_SHA = "f".repeat(40);

    try {
      await expect(
        actOnSiteOps(
          actor as never,
          selectVisualInput(fixture.project.revision, fixture.sample.id),
        ),
      ).rejects.toMatchObject({
        code: "VISUAL_SELECTION_PERSISTENCE_FAILED",
        statusCode: 503,
        message:
          "建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择。",
      });
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps] visual_selection_persistence_failed",
        {
          event: "siteops_visual_selection_persistence_failed",
          action: "select_visual",
          stage: "transaction",
          projectId: fixture.project.id,
          expectedRevision: fixture.project.revision,
          releaseSha: "f".repeat(40),
          driverCode: "ER_DATA_TOO_LONG",
          errno: 1406,
          sqlState: "22001",
          column: "workflow_upstream_version",
          transactionOutcome: "rolled_back",
        },
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    } finally {
      if (previousRelease === undefined) {
        delete process.env.FRONTMIND_BUILD_SHA;
      } else {
        process.env.FRONTMIND_BUILD_SHA = previousRelease;
      }
      consoleError.mockRestore();
    }
  });

  it("uses the same safe persistence boundary for delegate_visual", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    fixture.insertFailures.set(
      siteBuilds,
      Object.assign(new Error("deadlock"), {
        code: "ER_LOCK_DEADLOCK",
        errno: 1213,
        sqlState: "40001",
      }),
    );
    dependencies.getDb.mockResolvedValue(fixture.db);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const previousRelease = process.env.FRONTMIND_BUILD_SHA;
    const unsafeRelease = "release-secret-customer";
    process.env.FRONTMIND_BUILD_SHA = unsafeRelease;

    try {
      await expect(
        actOnSiteOps(
          actor as never,
          delegateVisualInput(fixture.project.revision),
        ),
      ).rejects.toMatchObject({
        code: "VISUAL_SELECTION_PERSISTENCE_FAILED",
        statusCode: 503,
      });
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps] visual_selection_persistence_failed",
        expect.objectContaining({
          event: "siteops_visual_selection_persistence_failed",
          action: "delegate_visual",
          driverCode: "ER_LOCK_DEADLOCK",
          errno: 1213,
          sqlState: "40001",
          releaseSha: null,
          transactionOutcome: "rolled_back",
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        unsafeRelease,
      );
    } finally {
      if (previousRelease === undefined) {
        delete process.env.FRONTMIND_BUILD_SHA;
      } else {
        process.env.FRONTMIND_BUILD_SHA = previousRelease;
      }
      consoleError.mockRestore();
    }
  });

  it("does not classify an unknown select_visual failure as persistence", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    const unknownError = new Error("unexpected selection bug");
    fixture.insertFailures.set(siteBuilds, unknownError);
    dependencies.getDb.mockResolvedValue(fixture.db);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      await expect(
        actOnSiteOps(
          actor as never,
          selectVisualInput(fixture.project.revision, fixture.sample.id),
        ),
      ).rejects.toBe(unknownError);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("creates a fresh root build from a snapshot at the post-reset floor", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    fixture.project.minimumKnowledgeSnapshotVersion = 2;
    dependencies.getDb.mockResolvedValue(fixture.db);

    await actOnSiteOps(
      actor as never,
      selectVisualInput(fixture.project.revision, fixture.sample.id),
    );

    expect(dependencies.reserveQuota).toHaveBeenCalledOnce();
    expect(
      fixture.inserts.find((entry) => entry.table === siteBuilds)?.values,
    ).toMatchObject({
      parentBuildId: null,
      knowledgeSnapshotId: fixture.snapshots[0]!.id,
      knowledgeArchiveHash: fixture.snapshots[0]!.archiveHash,
      workflowVersion: SITEOPS_MATERIALIZER_V2_6.frontMindVersion,
    });
    expect(
      fixture.inserts.find(
        (entry) =>
          entry.table === siteOperations && entry.values.kind === "site_build",
      )?.values,
    ).toMatchObject({
      input: {
        workflowVersion: SITEOPS_MATERIALIZER_V2_6.frontMindVersion,
        referenceBlueprint: fixture.referenceBlueprint,
      },
    });
  });

  it("starts a new visual root while the old external reset boundary is still reconciling", async () => {
    const fixture = serviceDatabaseFixture();
    fixture.project.currentBuildId = null;
    dependencies.loadRebuild.mockResolvedValue({
      allowed: false,
      ticketId: "46000000-0000-4000-8000-000000000004",
      status: "in_progress",
      resetApplied: true,
      resetPending: true,
      minimumKnowledgeSnapshotVersion: null,
      resetSourceBuildId: "30000000-0000-4000-8000-000000000003",
      acceptedForCurrentCycle: false,
    });
    dependencies.getDb.mockResolvedValue(fixture.db);

    await actOnSiteOps(
      actor as never,
      selectVisualInput(fixture.project.revision, fixture.sample.id),
    );

    expect(dependencies.reserveQuota).toHaveBeenCalledOnce();
    expect(
      fixture.inserts.find(
        (entry) =>
          entry.table === siteOperations && entry.values.kind === "site_build",
      )?.values,
    ).toMatchObject({
      buildId: expect.any(String),
      kind: "site_build",
      provider: "manus",
    });
  });

  it("creates one reserved child build and build_revision only after site_rebuild is in progress", async () => {
    const fixture = serviceDatabaseFixture();
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.loadRebuild.mockResolvedValue({
      allowed: false,
      ticketId: "46000000-0000-4000-8000-000000000004",
      status: "in_progress",
      resetApplied: true,
      resetPending: false,
      minimumKnowledgeSnapshotVersion: null,
      resetSourceBuildId: fixture.project.currentBuildId,
      acceptedForCurrentCycle: true,
    });

    await actOnSiteOps(
      actor as never,
      selectVisualInput(fixture.project.revision, fixture.sample.id),
    );

    const buildInsert = fixture.inserts.find(
      (entry) => entry.table === siteBuilds,
    );
    const operationInsert = fixture.inserts.find(
      (entry) =>
        entry.table === siteOperations &&
        entry.values.kind === "build_revision",
    );
    expect(dependencies.reserveQuota).toHaveBeenCalledTimes(1);
    expect(dependencies.reserveQuota).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 7,
        quotaPool: "website_content_publish",
      }),
    );
    expect(buildInsert?.values).toMatchObject({
      parentBuildId: "30000000-0000-4000-8000-000000000003",
      quotaPeriodId: "50000000-0000-4000-8000-000000000005",
      quotaState: "reserved",
      status: "preparing",
    });
    expect(operationInsert?.values).toMatchObject({
      kind: "build_revision",
      status: "queued",
      provider: "manus",
      buildId: buildInsert?.values.id,
      input: expect.objectContaining({
        parentBuildId: "30000000-0000-4000-8000-000000000003",
        childBuildId: buildInsert?.values.id,
        credentialScope: "customer",
        manusCredentialId: fixture.customerCredential.id,
        manusCredentialVersion: fixture.customerCredential.version,
      }),
    });
    expect(fixture.project).toMatchObject({
      currentBuildId: "30000000-0000-4000-8000-000000000003",
      status: "building",
      revision: 9,
    });
  });

  it("does not reserve quota or create a child build while site_rebuild is only submitted", async () => {
    const fixture = serviceDatabaseFixture();
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.loadRebuild.mockResolvedValue({
      allowed: false,
      ticketId: "46000000-0000-4000-8000-000000000004",
      status: "submitted",
      resetApplied: false,
      resetSourceBuildId: fixture.project.currentBuildId,
      acceptedForCurrentCycle: false,
    });

    await expect(
      actOnSiteOps(
        actor as never,
        selectVisualInput(fixture.project.revision, fixture.sample.id),
      ),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });

    expect(dependencies.reserveQuota).not.toHaveBeenCalled();
    expect(fixture.inserts.some((entry) => entry.table === siteBuilds)).toBe(
      false,
    );
    expect(
      fixture.inserts.some(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "build_revision",
      ),
    ).toBe(false);
  });

  it("rejects a child build when the completed reset source is not the current parent", async () => {
    const fixture = serviceDatabaseFixture();
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.loadRebuild.mockResolvedValue({
      allowed: true,
      ticketId: null,
      status: null,
      resetApplied: true,
      resetPending: false,
      minimumKnowledgeSnapshotVersion: 1,
      resetSourceBuildId: "39000000-0000-4000-8000-000000000009",
      acceptedForCurrentCycle: false,
    });

    await expect(
      actOnSiteOps(
        actor as never,
        selectVisualInput(fixture.project.revision, fixture.sample.id),
      ),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });

    expect(dependencies.reserveQuota).not.toHaveBeenCalled();
    expect(fixture.inserts.some((entry) => entry.table === siteBuilds)).toBe(
      false,
    );
  });

  it("keeps the accepted rebuild cycle usable while a second reset request is submitted", async () => {
    const fixture = serviceDatabaseFixture();
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.loadRebuild.mockResolvedValue({
      allowed: false,
      ticketId: "46000000-0000-4000-8000-000000000004",
      status: "submitted",
      resetApplied: true,
      resetSourceBuildId: fixture.project.currentBuildId,
      acceptedForCurrentCycle: true,
    });

    await actOnSiteOps(
      actor as never,
      selectVisualInput(fixture.project.revision, fixture.sample.id),
    );

    expect(dependencies.reserveQuota).toHaveBeenCalledOnce();
    expect(
      fixture.inserts.some(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "build_revision",
      ),
    ).toBe(true);
  });

  it("does not trust a legacy in-progress rebuild until the reset marker exists", async () => {
    const fixture = serviceDatabaseFixture();
    dependencies.getDb.mockResolvedValue(fixture.db);
    dependencies.loadRebuild.mockResolvedValue({
      allowed: false,
      ticketId: "46000000-0000-4000-8000-000000000004",
      status: "in_progress",
      resetApplied: true,
      resetPending: true,
      minimumKnowledgeSnapshotVersion: 3,
      resetSourceBuildId: fixture.project.currentBuildId,
    });

    await expect(
      actOnSiteOps(
        actor as never,
        selectVisualInput(fixture.project.revision, fixture.sample.id),
      ),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });

    expect(dependencies.reserveQuota).not.toHaveBeenCalled();
    expect(fixture.inserts.some((entry) => entry.table === siteBuilds)).toBe(
      false,
    );
    expect(
      fixture.inserts.some(
        (entry) =>
          entry.table === siteOperations &&
          entry.values.kind === "build_revision",
      ),
    ).toBe(false);
  });
});
