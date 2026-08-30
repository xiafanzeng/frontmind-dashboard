import { beforeEach, describe, expect, it, vi } from "vitest";

import { knowledgeBaseSnapshots, siteProjects } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  projectRows: [] as any[],
  snapshotRows: [] as any[],
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

import {
  assertSiteOpsKnowledgeSnapshotPublicationEpoch,
  getLatestKnowledgeSnapshotForSiteOpsInput,
} from "./dashboard-service";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "62000000-0000-4000-8000-000000000001",
    userId: 7,
    version: 1,
    sourceFileName: "knowledge.md",
    archiveHash: null,
    documents: [],
    documentCount: 0,
    imageCount: 0,
    characterCount: 0,
    totalBytes: 0,
    assets: [],
    status: "active",
    siteOpsKnowledgeInputEpochId: "61000000-0000-4000-8000-000000000001",
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    ...overrides,
  };
}

function database() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === siteProjects
              ? mocks.projectRows
              : table === knowledgeBaseSnapshots
                ? mocks.snapshotRows
                : [];
          return {
            limit: async () => rows,
            orderBy: () => ({ limit: async () => rows }),
          };
        },
      }),
    }),
  };
}

describe("SiteOps knowledge prefill epoch", () => {
  beforeEach(() => {
    mocks.projectRows = [];
    mocks.snapshotRows = [];
    mocks.getDb.mockReset().mockResolvedValue(database());
  });

  it("returns no prefill for the first build after an approved epoch rotation", async () => {
    mocks.projectRows = [
      {
        knowledgeInputEpochId: "63000000-0000-4000-8000-000000000001",
      },
    ];
    mocks.snapshotRows = [snapshot()];

    await expect(
      getLatestKnowledgeSnapshotForSiteOpsInput(7),
    ).resolves.toBeNull();
  });

  it("returns an active snapshot only when it belongs to the exact epoch", async () => {
    const knowledgeInputEpochId = "63000000-0000-4000-8000-000000000002";
    mocks.projectRows = [{ knowledgeInputEpochId }];
    mocks.snapshotRows = [
      snapshot({ siteOpsKnowledgeInputEpochId: knowledgeInputEpochId }),
    ];

    await expect(
      getLatestKnowledgeSnapshotForSiteOpsInput(7),
    ).resolves.toMatchObject({
      id: "62000000-0000-4000-8000-000000000001",
      version: 1,
    });
  });

  it("preserves the historical active-snapshot behavior for a null epoch", async () => {
    mocks.projectRows = [{ knowledgeInputEpochId: null }];
    mocks.snapshotRows = [snapshot()];

    await expect(
      getLatestKnowledgeSnapshotForSiteOpsInput(7),
    ).resolves.toMatchObject({
      id: "62000000-0000-4000-8000-000000000001",
      version: 1,
    });
  });

  it("rejects delayed build/import publication before it can eclipse the current epoch", () => {
    const currentProjectEpochId =
      "63000000-0000-4000-8000-000000000003";
    expect(() =>
      assertSiteOpsKnowledgeSnapshotPublicationEpoch({
        currentProjectEpochId,
        immutableSourceEpochId:
          "63000000-0000-4000-8000-000000000002",
        hasImmutableSource: true,
      }),
    ).toThrow(/早于当前官网重置批次/u);
    expect(() =>
      assertSiteOpsKnowledgeSnapshotPublicationEpoch({
        currentProjectEpochId,
        immutableSourceEpochId: null,
        hasImmutableSource: false,
      }),
    ).toThrow(/早于当前官网重置批次/u);
    expect(() =>
      assertSiteOpsKnowledgeSnapshotPublicationEpoch({
        currentProjectEpochId,
        immutableSourceEpochId: currentProjectEpochId,
        hasImmutableSource: true,
      }),
    ).not.toThrow();
  });
});
