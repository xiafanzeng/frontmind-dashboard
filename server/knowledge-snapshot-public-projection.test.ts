import { describe, expect, it } from "vitest";

import { toKnowledgeSnapshotPublicJson } from "./dashboard-service";

describe("knowledge snapshot public JSON", () => {
  it("projects customer text and URLs without exposing publication metadata", () => {
    const privateBrand = ["Ma", "nus"].join("");
    const snapshot = toKnowledgeSnapshotPublicJson(
      {
        id: "snapshot-1",
        userId: 42,
        version: 7,
        sourceFileName: `${privateBrand}_V2_export.zip`,
        sourceTaskId: `${privateBrand.toLowerCase()}-task-private`,
        archiveHash: "a".repeat(64),
        documents: [
          {
            id: "doc-1",
            path: `${privateBrand}/node.md`,
            title: `${privateBrand} 节点`,
            content: `${privateBrand.toUpperCase()}_V2_TASK https://open.${privateBrand.toLowerCase()}.ai/task/1`,
            historicalMetadata: {
              notice: `${privateBrand.toUpperCase()}_V2_INTERNAL_NOTICE`,
            },
            sourceIds: [
              `https://api.${privateBrand.toLowerCase()}.ai/source`,
              "https://frontmind.net/source",
            ],
          },
        ],
        documentCount: 1,
        imageCount: 1,
        characterCount: 20,
        totalBytes: 100,
        assets: [
          {
            id: `${privateBrand.toLowerCase()}-logo`,
            key: `${privateBrand.toLowerCase()}/private/storage-key.png`,
            path: `${privateBrand}_logo.png`,
            mimeType: "image/png",
            size: 10,
            caption: `${privateBrand} Logo`,
            alt: `${privateBrand} Logo`,
            sourcePageUrl: `https://www.${privateBrand.toLowerCase()}.ai/`,
            sourceAssetUrl: `https://cdn.${privateBrand.toLowerCase()}.ai/logo.png`,
            sourceUploadFileId: `${privateBrand.toLowerCase()}-file-private`,
            sourceUploadSha256: "b".repeat(64),
            sourceUploadMimeType: `image/${privateBrand.toLowerCase()}`,
          },
        ],
        status: "active" as const,
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
      },
      true,
    );

    expect(JSON.stringify(snapshot)).not.toMatch(/manus/iu);
    expect(snapshot).not.toHaveProperty("userId");
    expect(snapshot).not.toHaveProperty("sourceTaskId");
    expect(snapshot.documents[0]?.sourceIds).toEqual([
      "https://frontmind.net/source",
    ]);
    expect(snapshot.assets[0]).toMatchObject({
      id: "FrontMind",
      key: "FrontMind",
      url: "/api/dashboard/knowledge/assets/snapshot-1/0",
      sourcePageUrl: undefined,
      sourceAssetUrl: undefined,
      sourceUploadFileId: undefined,
      sourceUploadSha256: undefined,
    });
  });
});
