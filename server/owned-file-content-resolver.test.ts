import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  OwnedFileContentResolver,
  type OwnedFileContentResolverDependencies,
} from "./owned-file-content-resolver";
import type { StoredPresalesFile } from "./presales-file-store";

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function storedFile(
  bytes: Buffer,
  overrides: Partial<StoredPresalesFile> = {},
): StoredPresalesFile {
  return {
    filename: "report.txt",
    mimeType: "text/plain",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    uploadedAt: null,
    contentExpiresAt: null,
    contentStoredAt: null,
    manifestUpdatedAt: null,
    createReadStream: () => Readable.from([bytes]),
    ...overrides,
  };
}

function dependencies(input?: {
  stored?: StoredPresalesFile | null;
  contentSource?: "user_upload" | "assistant_output";
  parentTaskId?: string | null;
  expiresAt?: Date | null;
}) {
  const request = vi.fn();
  const removeStoredFile = vi.fn(async () => undefined);
  const deps: OwnedFileContentResolverDependencies = {
    getCredential: vi.fn(async () => ({
      id: "credential-1",
      apiKey: "secret-api-key",
      resource: {
        parentTaskId: input?.parentTaskId ?? null,
        contentSource: input?.contentSource ?? "user_upload",
        uploadedAt: new Date("2026-08-01T00:00:00Z"),
        contentExpiresAt:
          input && "expiresAt" in input
            ? input.expiresAt
            : new Date("2026-09-01T00:00:00Z"),
        contentDeletedAt: null,
      },
    })),
    readStoredFile: vi.fn(async () => input?.stored ?? null),
    removeStoredFile,
    stageStoredFile: vi.fn(async () => {
      throw new Error("v2 resolver must not recapture provider content");
    }),
    getBaseUrl: () => "https://api.frontmind.example",
    request,
  };
  return { deps, request, removeStoredFile };
}

describe("OwnedFileContentResolver v2 local authority", () => {
  it("serves a size/SHA verified local copy without Provider access", async () => {
    const bytes = Buffer.from("durable local copy");
    const { deps, request } = dependencies({ stored: storedFile(bytes) });
    const resolved = await new OwnedFileContentResolver(deps).resolve({
      ownerUserId: 7,
      fileId: "file-1",
      projectAssignmentId: "project-a",
      expectedCredentialId: "credential-1",
      now: Date.parse("2026-08-04T00:00:00Z"),
    });

    expect(resolved.source).toBe("local");
    expect(await readAll(resolved.stream)).toEqual(bytes);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a missing local copy without calling legacy /content", async () => {
    const { deps, request } = dependencies({ stored: null });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "file-missing",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
      statusCode: 410,
      retryable: false,
      recoveryAction: "reupload",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("isolates a corrupt local copy and fails closed", async () => {
    const { deps, request, removeStoredFile } = dependencies({
      stored: storedFile(Buffer.from("corrupt"), { sha256: "0".repeat(64) }),
    });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "file-corrupt",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
    expect(removeStoredFile).toHaveBeenCalledWith("file-corrupt");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires a newly materialized artifact when assistant output is absent", async () => {
    const { deps, request } = dependencies({
      stored: null,
      contentSource: "assistant_output",
      parentTaskId: "provider-task-1",
      expiresAt: null,
    });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "assistant-artifact-missing",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
      message: "本地成品文件不可用，请重新生成",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the existing local retention fence", async () => {
    const { deps } = dependencies({
      stored: storedFile(Buffer.from("expired")),
      expiresAt: new Date("2026-08-02T00:00:00Z"),
    });
    await expect(
      new OwnedFileContentResolver(deps).resolve({
        ownerUserId: 7,
        fileId: "expired-file",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_EXPIRED",
      statusCode: 410,
    });
  });
});
