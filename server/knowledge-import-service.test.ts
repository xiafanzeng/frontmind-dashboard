import { describe, expect, it } from "vitest";

import {
  knowledgeArtifactReceiptMatchesRequest,
  knowledgeImportReceiptSourceReference,
  resolveKnowledgeImportProjectOwner,
  websiteKnowledgeImportSchema,
} from "./knowledge-import-service";

function knowledgeImportRequest(schemaVersion: 2 | 3): Record<string, unknown> {
  return {
    schemaVersion,
    companyName: "示例企业",
    taskId: "task-website-kb-1",
    outputItemId: "output-1",
    fileId: "file-1",
    descriptorHash: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    filename: "示例企业_knowledge_base.zip",
    ...(schemaVersion === 3
      ? {
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
        }
      : {}),
  };
}

describe("website knowledge import v2/v3 contract", () => {
  it("requires a project-scoped task descriptor and artifact hash", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(2));
    expect(value).not.toHaveProperty("userId");
    expect(value.schemaVersion).toBe(2);
    expect(value).not.toHaveProperty("archiveContractVersion");
    expect(value).not.toHaveProperty("validationProfile");
    expect(value).not.toHaveProperty("packageManifestSha256");
  });

  it("accepts v3 only with the bounded Website archive contract", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    expect(value).toMatchObject({
      schemaVersion: 3,
      archiveContractVersion: 1,
      validationProfile: "website-lead-v1",
      packageManifestSha256: "c".repeat(64),
    });
  });

  it.each([
    "archiveContractVersion",
    "validationProfile",
    "packageManifestSha256",
  ] as const)("requires v3 field %s", (field) => {
    const request = knowledgeImportRequest(3);
    delete request[field];
    expect(() => websiteKnowledgeImportSchema.parse(request)).toThrow();
  });

  it("rejects unknown v3 archive contracts, profiles, and malformed manifest hashes", () => {
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        archiveContractVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        validationProfile: "historical",
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        packageManifestSha256: "not-a-sha256",
      }),
    ).toThrow();
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

  it("does not treat a legacy v2 receipt as an already-validated v3 import", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.taskId,
          outputItemId: value.outputItemId,
          fileId: value.fileId ?? null,
          descriptorHash: value.descriptorHash,
          sourceReference: `project-1:${value.taskId}`,
        },
        { projectId: "project-1", value },
      ),
    ).toBe(false);
  });

  it("replays a v3 receipt only when its archive contract and manifest hash match", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    const input = { projectId: "project-1", value };
    const receipt = {
      projectId: "project-1",
      taskId: value.taskId,
      outputItemId: value.outputItemId,
      fileId: value.fileId ?? null,
      descriptorHash: value.descriptorHash,
      sourceReference: knowledgeImportReceiptSourceReference(input),
    };
    expect(knowledgeArtifactReceiptMatchesRequest(receipt, input)).toBe(true);
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          ...receipt,
          sourceReference: receipt.sourceReference.replace(
            value.packageManifestSha256,
            "d".repeat(64),
          ),
        },
        input,
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
