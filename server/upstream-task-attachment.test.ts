import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";

describe("durable upstream task attachments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates with the stable idempotency key and persists the file id before uploading bytes", async () => {
    const events: string[] = [];
    const uploadUrl =
      "https://uploads.example.test/generated.skill?X-Amz-Signature=stable";
    const post = vi.spyOn(axios, "post").mockImplementation(async () => {
      events.push("create");
      return {
        status: 201,
        data: { id: "provider-file-1", upload_url: uploadUrl },
      };
    });
    const put = vi.spyOn(axios, "put").mockImplementation(async () => {
      events.push("upload");
      return { status: 200, data: "" };
    });

    const result = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename: "socratic-kb-builder-v4.skill",
      bytes: Buffer.from("immutable-skill"),
      idempotencyKey: "frontmind-kb-file-v1:stable-operation",
      onFileResolved: async (fileId) => {
        events.push(`persist:${fileId}`);
      },
    });

    expect(events).toEqual(["create", "persist:provider-file-1", "upload"]);
    expect(result.fileId).toBe("provider-file-1");
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v1/files",
      { filename: "socratic-kb-builder-v4.skill" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "frontmind-kb-file-v1:stable-operation",
        }),
      }),
    );
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("API_KEY");
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("Authorization");
  });

  it("skips creation on completed replay and refreshes the signed upload URL for the same file", async () => {
    const bytes = Buffer.from("immutable-skill");
    const post = vi.spyOn(axios, "post");
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-1",
        filename: "socratic-kb-builder-v4.skill",
        status: "pending",
        upload_url:
          "https://uploads.example.test/replayed.skill?X-Amz-Signature=fresh",
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 200,
      data: "",
    });
    const onFileResolved = vi.fn().mockResolvedValue(undefined);

    const result = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename: "socratic-kb-builder-v4.skill",
      bytes,
      existingFileId: "provider-file-1",
      idempotencyKey: "frontmind-kb-file-v1:stable-operation",
      onFileResolved,
    });

    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(
      "https://api.example.test/v1/files/provider-file-1",
      expect.objectContaining({
        headers: expect.objectContaining({ API_KEY: "secret-test-key" }),
      }),
    );
    expect(onFileResolved).toHaveBeenCalledWith("provider-file-1");
    expect(put).toHaveBeenCalledTimes(1);
    expect(result.attachment.file_id).toBe("provider-file-1");
  });

  it("treats an exactly matching uploaded provider file as a completed crash-after-PUT replay", async () => {
    const filename = "socratic-kb-builder.skill.zip";
    const bytes = Buffer.from("immutable-skill-archive");
    const post = vi.spyOn(axios, "post");
    const put = vi.spyOn(axios, "put");
    const remove = vi.spyOn(axios, "delete");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-uploaded",
        filename,
        status: "uploaded",
        bytes: bytes.length,
        upload_url: null,
        mime_type: null,
      },
    });
    const onFileResolved = vi.fn().mockResolvedValue(undefined);

    const result = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename,
      bytes,
      existingFileId: "provider-file-uploaded",
      idempotencyKey: "frontmind-kb-file-v1:stable-operation",
      onFileResolved,
    });

    expect(result).toMatchObject({
      attachment: { file_id: "provider-file-uploaded", filename },
      fileId: "provider-file-uploaded",
    });
    expect(onFileResolved).toHaveBeenCalledWith("provider-file-uploaded");
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("continues a final-delivery recovery after the Skill PUT crash and uploads only the missing finalization input", async () => {
    const skillFilename = "socratic-kb-builder.skill.zip";
    const skillBytes = Buffer.from("immutable-skill-archive");
    const finalizationFilename = "frontmind-kb-finalization-input.zip";
    const finalizationBytes = Buffer.from("immutable-finalization-input");
    const finalizationUploadUrl =
      "https://uploads.example.test/finalization?X-Amz-Signature=fresh";
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-skill",
        filename: skillFilename,
        status: "uploaded",
        size_bytes: skillBytes.length,
      },
    });
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-finalization",
        filename: finalizationFilename,
        upload_url: finalizationUploadUrl,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 200,
      data: "",
    });

    const recoveredSkill = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename: skillFilename,
      bytes: skillBytes,
      existingFileId: "provider-file-skill",
      onFileResolved: async () => undefined,
    });
    const uploadedFinalization = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename: finalizationFilename,
      bytes: finalizationBytes,
      idempotencyKey: "frontmind-kb-file-v1:finalization",
      onFileResolved: async () => undefined,
    });

    expect(recoveredSkill.fileId).toBe("provider-file-skill");
    expect(uploadedFinalization.fileId).toBe("provider-file-finalization");
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toEqual({
      filename: finalizationFilename,
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe(finalizationUploadUrl);
  });

  it("accepts canonical provider aliases only when every frozen value agrees", async () => {
    const filename = "frontmind-kb-finalization-input.zip";
    const bytes = Buffer.from("immutable-finalization-input");
    const put = vi.spyOn(axios, "put");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-finalization",
        file_id: "provider-file-finalization",
        filename,
        status: "UPLOADED",
        upload_status: "uploaded",
        size: String(bytes.length),
        size_bytes: bytes.length,
        mime_type: "application/zip",
      },
    });

    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename,
        bytes,
        mimeType: "application/zip",
        existingFileId: "provider-file-finalization",
        onFileResolved: async () => undefined,
      }),
    ).resolves.toMatchObject({ fileId: "provider-file-finalization" });
    expect(put).not.toHaveBeenCalled();
  });

  it("accepts the provider's generic binary MIME normalization for an exact uploaded ZIP", async () => {
    const filename = "socratic-kb-builder.skill.zip";
    const bytes = Buffer.from("immutable-skill-archive");
    const put = vi.spyOn(axios, "put");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-skill",
        filename,
        status: "uploaded",
        bytes: String(bytes.length),
        content_type: "application/octet-stream",
      },
    });

    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename,
        bytes,
        mimeType: "application/zip",
        existingFileId: "provider-file-skill",
        onFileResolved: async () => undefined,
      }),
    ).resolves.toMatchObject({ fileId: "provider-file-skill" });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a different id",
      {
        id: "provider-file-other",
        filename: "socratic-kb-builder.skill.zip",
        status: "uploaded",
        bytes: 7,
      },
      "metadata mismatch",
    ],
    [
      "a different filename",
      {
        id: "provider-file-frozen",
        filename: "other.skill.zip",
        status: "uploaded",
        bytes: 7,
      },
      "metadata mismatch",
    ],
    [
      "a different uploaded size",
      {
        id: "provider-file-frozen",
        filename: "socratic-kb-builder.skill.zip",
        status: "uploaded",
        bytes: 8,
      },
      "metadata mismatch",
    ],
    [
      "an incompatible uploaded MIME type",
      {
        id: "provider-file-frozen",
        filename: "socratic-kb-builder.skill.zip",
        status: "uploaded",
        bytes: 7,
        content_type: "image/png",
      },
      "metadata mismatch",
    ],
    [
      "conflicting size aliases",
      {
        id: "provider-file-frozen",
        filename: "socratic-kb-builder.skill.zip",
        status: "uploaded",
        bytes: 7,
        size_bytes: 8,
      },
      "metadata is invalid",
    ],
    [
      "an unknown state with an upload URL",
      {
        id: "provider-file-frozen",
        filename: "socratic-kb-builder.skill.zip",
        status: "processing",
        bytes: 7,
        upload_url:
          "https://uploads.example.test/unsafe-replay?X-Amz-Signature=fresh",
      },
      "state is not safely replayable",
    ],
  ])(
    "fails closed when provider metadata has %s",
    async (_label, data, error) => {
      const put = vi.spyOn(axios, "put");
      const remove = vi.spyOn(axios, "delete");
      vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data });

      await expect(
        uploadUpstreamTaskAttachment({
          baseUrl: "https://api.example.test",
          apiKey: "secret-test-key",
          filename: "socratic-kb-builder.skill.zip",
          bytes: Buffer.from("1234567"),
          existingFileId: "provider-file-frozen",
          onFileResolved: async () => undefined,
        }),
      ).rejects.toThrow(error);
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("does not PUT an explicitly pending replay without a fresh upload URL", async () => {
    const put = vi.spyOn(axios, "put");
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-pending",
        filename: "socratic-kb-builder.skill.zip",
        status: "pending",
      },
    });

    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename: "socratic-kb-builder.skill.zip",
        bytes: Buffer.from("immutable-skill"),
        existingFileId: "provider-file-pending",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("upload URL is unavailable");
    expect(put).not.toHaveBeenCalled();
  });

  it("does not delete an idempotently recoverable file when binding or upload fails", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-uncertain",
        upload_url:
          "https://uploads.example.test/uncertain.skill?X-Amz-Signature=one",
      },
    });
    const remove = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 204,
      data: "",
    });

    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename: "socratic-kb-builder-v4.skill",
        bytes: Buffer.from("immutable-skill"),
        idempotencyKey: "frontmind-kb-file-v1:stable-operation",
        onFileResolved: async () => {
          throw new Error("simulated database interruption");
        },
      }),
    ).rejects.toThrow("simulated database interruption");
    expect(remove).not.toHaveBeenCalled();

    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-uncertain",
        filename: "socratic-kb-builder-v4.skill",
        status: "pending",
        upload_url:
          "https://uploads.example.test/uncertain.skill?X-Amz-Signature=two",
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({ status: 503, data: "retry" });
    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename: "socratic-kb-builder-v4.skill",
        bytes: Buffer.from("immutable-skill"),
        existingFileId: "provider-file-uncertain",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("Task attachment upload failed");
    expect(remove).not.toHaveBeenCalled();
  });
});
