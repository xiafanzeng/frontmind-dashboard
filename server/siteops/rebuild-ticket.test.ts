import { describe, expect, it } from "vitest";

import {
  messages,
  siteBuilds,
  siteDeployments,
  siteDnsRecords,
  siteDomainOperations,
  siteOperations,
  siteProjects,
  websiteStyleSampleBatches,
} from "../../drizzle/schema";
import {
  approveSiteOpsRebuildTicket,
  siteOpsRebuildBuildId,
  siteOpsRebuildAcceptedForCurrentCycle,
  siteOpsRebuildDeliveryClientRequestId,
  siteOpsRebuildDedupeKey,
  siteOpsRebuildProjectDedupeKey,
  siteOpsRebuildProjectId,
  siteOpsRebuildProjectTargetPage,
  siteOpsRebuildRequestDisposition,
  siteOpsRebuildResubmissionProjection,
  siteOpsRebuildResetApplied,
  siteOpsRebuildTargetPage,
  SiteOpsRebuildTicketError,
} from "./rebuild-ticket";

describe("SiteOps rebuild ticket coordinates", () => {
  const immutableBuildId = "10000000-0000-4000-8000-000000000001";

  it("binds the ticket to one exact immutable source build", () => {
    expect(siteOpsRebuildDedupeKey(immutableBuildId)).toBe(
      `site-rebuild:${immutableBuildId}`,
    );
    expect(
      siteOpsRebuildBuildId(siteOpsRebuildTargetPage(immutableBuildId)),
    ).toBe(immutableBuildId);
  });

  it("rejects arbitrary pages and malformed build ids", () => {
    expect(siteOpsRebuildBuildId("https://example.com/siteops/builds/x")).toBe(
      null,
    );
    expect(siteOpsRebuildBuildId("/siteops/builds/not-a-uuid")).toBe(null);
  });

  it("binds an any-stage reset request to the project before a build exists", () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    expect(siteOpsRebuildProjectDedupeKey(projectId)).toBe(
      `site-rebuild-project:${projectId}`,
    );
    expect(
      siteOpsRebuildProjectId(siteOpsRebuildProjectTargetPage(projectId)),
    ).toBe(projectId);
    expect(siteOpsRebuildProjectId("/siteops/projects/not-a-uuid")).toBeNull();
  });

  it.each([
    [true, null, false, "create"],
    [true, "submitted", false, "pending"],
    [true, "in_progress", true, "resubmit"],
    [false, null, false, "unavailable"],
  ] as const)(
    "projects requestability without interrupting the workflow (%s, %s, %s)",
    (hasWorkflowProgress, ticketStatus, resetApplied, expected) => {
      expect(
        siteOpsRebuildRequestDisposition({
          hasWorkflowProgress,
          ticketStatus,
          resetApplied,
        }),
      ).toBe(expected);
    },
  );

  it("keeps a prior reset authorization valid only until its replacement becomes current", () => {
    const sourceBuildId = "30000000-0000-4000-8000-000000000003";
    const internalNote = JSON.stringify({
      schemaVersion: 3,
      kind: "frontmind.siteops-rebuild.v1",
      projectId: "20000000-0000-4000-8000-000000000002",
      sourceBuildId,
      knowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
      resetAppliedAt: "2026-08-24T08:00:00.000Z",
      resetAppliedProjectRevision: 12,
    });

    expect(
      siteOpsRebuildAcceptedForCurrentCycle({
        internalNote,
        currentBuildId: sourceBuildId,
      }),
    ).toBe(true);
    expect(
      siteOpsRebuildAcceptedForCurrentCycle({
        internalNote,
        currentBuildId: "50000000-0000-4000-8000-000000000005",
      }),
    ).toBe(false);
  });

  it("upgrades a production-shaped V2 build ticket to a stable project coordinate on resubmission", () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    const sourceBuildId = "30000000-0000-4000-8000-000000000003";
    const projection = siteOpsRebuildResubmissionProjection({
      projectId,
      internalNote: JSON.stringify({
        schemaVersion: 2,
        kind: "frontmind.siteops-rebuild.v1",
        projectId,
        sourceBuildId,
        knowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
        resetAppliedAt: "2026-08-24T08:00:00.000Z",
        resetAppliedProjectRevision: 12,
      }),
    });

    expect(projection).toMatchObject({
      targetPage: `/siteops/projects/${projectId}`,
      technicalDedupeKey: `site-rebuild-project:${projectId}`,
    });
    expect(JSON.parse(projection!.internalNote)).toMatchObject({
      schemaVersion: 3,
      projectId,
      sourceBuildId,
      resetAppliedProjectRevision: 12,
    });
  });

  it("maps every accepted SiteOps request id to one deterministic delivery UUID", () => {
    const shared = {
      userId: 27,
      projectId: "20000000-0000-4000-8000-000000000002",
    };
    const prefixedRequestId = "siteops-10000000-0000-4000-8000-000000000001";
    const longRequestId = "request-".padEnd(128, "x");
    const prefixed = siteOpsRebuildDeliveryClientRequestId({
      ...shared,
      clientRequestId: prefixedRequestId,
    });

    expect(prefixedRequestId).toHaveLength(44);
    expect(longRequestId).toHaveLength(128);
    expect(prefixed).toHaveLength(36);
    expect(prefixed).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        clientRequestId: prefixedRequestId,
      }),
    ).toBe(prefixed);
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        clientRequestId: longRequestId,
      }),
    ).not.toBe(prefixed);
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        projectId: "30000000-0000-4000-8000-000000000003",
        clientRequestId: prefixedRequestId,
      }),
    ).not.toBe(prefixed);
  });
});

const projectId = "10000000-0000-4000-8000-000000000001";
const buildId = "20000000-0000-4000-8000-000000000002";
const snapshotId = "30000000-0000-4000-8000-000000000003";
const ticketId = "40000000-0000-4000-8000-000000000004";

function rebuildNoteV1() {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "frontmind.siteops-rebuild.v1",
    projectId,
    sourceBuildId: buildId,
    knowledgeSnapshotId: snapshotId,
  });
}

function fixture(options?: {
  activeOperation?: boolean;
  internalNote?: string;
  projectOverrides?: Record<string, unknown>;
  targetPage?: string;
  ticketStatus?: string;
}) {
  const project = {
    id: projectId,
    userId: 9,
    conversationId: "siteops:9",
    currentKnowledgeSnapshotId: snapshotId,
    currentBuildId: buildId,
    globalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
    mainlandLiveDeploymentId: null,
    brief: { companyName: "FrontMind" },
    status: "approved",
    revision: 12,
    ...options?.projectOverrides,
  };
  const build = {
    id: buildId,
    projectId,
    userId: 9,
    knowledgeSnapshotId: snapshotId,
    status: "approved",
    contractLocalAssetId: "contract",
    sourceLocalAssetId: "source",
    distLocalAssetId: "dist",
    qaLocalAssetId: "qa",
    provenanceLocalAssetId: "provenance",
  };
  const ticket = {
    id: ticketId,
    userId: 9,
    operation: "site_rebuild",
    targetPage: options?.targetPage ?? `/siteops/builds/${buildId}`,
    internalNote: options?.internalNote ?? rebuildNoteV1(),
    status: options?.ticketStatus ?? "submitted",
  } as any;
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const rowsFor = (table: unknown) => {
    if (table === siteProjects) return [project];
    if (table === siteBuilds) return [build];
    if (table === siteOperations) {
      return options?.activeOperation ? [{ id: "running-operation" }] : [];
    }
    if (
      table === siteDeployments ||
      table === siteDnsRecords ||
      table === siteDomainOperations
    ) {
      return [];
    }
    if (table === messages) return [{ sequence: 7 }];
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
  const tx = {
    select,
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
          if (table === siteProjects) Object.assign(project, values);
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
      },
    }),
  };
  return { tx, ticket, project, updates, inserts };
}

describe("site rebuild reset approval", () => {
  it("opens a fresh knowledge selection while retaining the existing build and live head", async () => {
    const state = fixture();
    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      projectId,
      sourceBuildId: buildId,
      resetApplied: true,
      resetAppliedProjectRevision: 13,
    });
    expect(siteOpsRebuildResetApplied(result!.internalNote)).toBe(true);
    expect(state.project).toMatchObject({
      currentKnowledgeSnapshotId: null,
      currentBuildId: buildId,
      globalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
      brief: null,
      status: "draft",
      revision: 13,
    });
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: messages,
          values: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
        expect.objectContaining({
          table: websiteStyleSampleBatches,
          values: expect.objectContaining({ status: "superseded" }),
        }),
      ]),
    );
    expect(state.inserts).toEqual([
      expect.objectContaining({
        table: messages,
        values: expect.objectContaining({
          sequence: 8,
          content: expect.stringContaining("旧官网和线上网站保持不变"),
        }),
      }),
    ]);
  });

  it("replays an existing reset marker without changing project state again", async () => {
    const first = fixture();
    const marker = await approveSiteOpsRebuildTicket(first.tx, {
      ticket: first.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const replay = fixture({ internalNote: marker!.internalNote });

    await expect(
      approveSiteOpsRebuildTicket(replay.tx, {
        ticket: replay.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      resetApplied: true,
      resetAppliedProjectRevision: 13,
    });
    expect(replay.updates).toHaveLength(0);
    expect(replay.inserts).toHaveLength(0);
  });

  it("approves a project-scoped request before any build exists", async () => {
    const projectNote = JSON.stringify({
      schemaVersion: 3,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: null,
      knowledgeSnapshotId: snapshotId,
    });
    const state = fixture({
      internalNote: projectNote,
      targetPage: `/siteops/projects/${projectId}`,
      projectOverrides: {
        currentBuildId: null,
        status: "awaiting_visual_selection",
      },
    });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:30:00.000Z"),
    });

    expect(result).toMatchObject({
      projectId,
      sourceBuildId: null,
      resetApplied: true,
      resetAppliedProjectRevision: 13,
    });
    expect(siteOpsRebuildResetApplied(result!.internalNote)).toBe(true);
    expect(state.project).toMatchObject({
      currentBuildId: null,
      currentKnowledgeSnapshotId: null,
      status: "draft",
      revision: 13,
    });
  });

  it("reapplies an approved project reset after the customer requests again", async () => {
    const first = fixture({
      internalNote: JSON.stringify({
        schemaVersion: 3,
        kind: "frontmind.siteops-rebuild.v1",
        projectId,
        sourceBuildId: buildId,
        knowledgeSnapshotId: snapshotId,
      }),
      targetPage: `/siteops/projects/${projectId}`,
    });
    const marker = await approveSiteOpsRebuildTicket(first.tx, {
      ticket: first.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const repeated = fixture({
      internalNote: marker!.internalNote,
      targetPage: `/siteops/projects/${projectId}`,
      ticketStatus: "submitted",
    });

    await expect(
      approveSiteOpsRebuildTicket(repeated.tx, {
        ticket: repeated.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
        reapply: true,
      }),
    ).resolves.toMatchObject({
      resetApplied: true,
      resetAppliedProjectRevision: 13,
    });
    expect(repeated.updates.length).toBeGreaterThan(0);
    expect(repeated.inserts).toHaveLength(1);
  });

  it("does not hide messages or clear the snapshot while an operation is active", async () => {
    const state = fixture({ activeOperation: true });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T08:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(SiteOpsRebuildTicketError);
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(state.project.currentKnowledgeSnapshotId).toBe(snapshotId);
  });
});
