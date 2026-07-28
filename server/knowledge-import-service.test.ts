import { describe, expect, it } from "vitest";

import {
  knowledgeArtifactReceiptMatchesRequest,
  resolveKnowledgeImportProjectOwner,
  websiteKnowledgeImportSchema,
} from "./knowledge-import-service";

describe("website knowledge import v2 contract", () => {
  it("requires a project-scoped task descriptor and artifact hash", () => {
    const value = websiteKnowledgeImportSchema.parse({
      schemaVersion: 2,
      companyName: "示例企业",
      taskId: "task-website-kb-1",
      outputItemId: "output-1",
      fileId: "file-1",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "示例企业_knowledge_base.zip",
    });
    expect(value).not.toHaveProperty("userId");
    expect(value.schemaVersion).toBe(2);
  });

  it("rejects a caller-supplied user id", () => {
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        schemaVersion: 2,
        companyName: "示例企业",
        taskId: "task-website-kb-1",
        outputItemId: "output-1",
        descriptorHash: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        filename: "kb.zip",
        userId: 99,
      }),
    ).toThrow();
  });

  it("recognizes the same artifact descriptor when a caller rotates only the idempotency key", () => {
    const value = websiteKnowledgeImportSchema.parse({
      schemaVersion: 2,
      companyName: "示例企业",
      taskId: "task-website-kb-1",
      outputItemId: "output-1",
      fileId: "file-1",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "kb.zip",
    });
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.taskId,
          outputItemId: value.outputItemId,
          fileId: value.fileId ?? null,
          descriptorHash: value.descriptorHash.toUpperCase(),
        },
        { projectId: "project-1", value },
      ),
    ).toBe(true);
  });

  it("does not replay a hash whose task descriptor belongs to a different output", () => {
    const value = websiteKnowledgeImportSchema.parse({
      schemaVersion: 2,
      companyName: "示例企业",
      taskId: "task-website-kb-1",
      outputItemId: "output-1",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "kb.zip",
    });
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.taskId,
          outputItemId: "output-other",
          fileId: null,
          descriptorHash: value.descriptorHash,
        },
        { projectId: "project-1", value },
      ),
    ).toBe(false);
  });

  it("allows repeated purchases for one project when they resolve to one account and enterprise", () => {
    expect(
      resolveKnowledgeImportProjectOwner(
        [
          {
            userId: 7,
            companyName: "示例企业",
            status: "completed",
          },
          {
            userId: 7,
            companyName: " 示例 企业 ",
            status: "completed",
          },
          {
            userId: null,
            companyName: "示例企业",
            status: "pending_confirmation",
          },
        ],
        "示例企业",
      ),
    ).toEqual({
      userId: 7,
      companyName: "示例企业",
      purchaseCount: 2,
    });
  });

  it("rejects a project that resolves to multiple user accounts", () => {
    expect(() =>
      resolveKnowledgeImportProjectOwner(
        [
          { userId: 7, companyName: "示例企业", status: "completed" },
          { userId: 8, companyName: "示例企业", status: "completed" },
        ],
        "示例企业",
      ),
    ).toThrowError(expect.objectContaining({ code: "PROJECT_OWNER_CONFLICT" }));
  });

  it("rejects conflicting enterprise identities even when the account is the same", () => {
    expect(() =>
      resolveKnowledgeImportProjectOwner(
        [
          { userId: 7, companyName: "示例企业", status: "completed" },
          { userId: 7, companyName: "另一企业", status: "completed" },
        ],
        "示例企业",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PROJECT_ENTERPRISE_CONFLICT" }),
    );
  });
});
