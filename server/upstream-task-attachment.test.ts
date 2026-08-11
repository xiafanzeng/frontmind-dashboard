import { Readable } from "node:stream";

import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";

const baseInput = {
  baseUrl: "https://api.example.test",
  apiKey: "secret-test-key",
  filename: "socratic-kb-builder.skill.zip",
  bytes: Buffer.from("immutable-skill-archive"),
  mimeType: "application/zip",
};

function uploadedMetadata(fileId: string, filename = baseInput.filename) {
  return {
    status: 200,
    data: {
      id: fileId,
      filename,
      status: "uploaded",
    },
  };
}

function contentResponse(
  chunks: Array<Buffer | Uint8Array | string>,
  status = 200,
) {
  return {
    status,
    data: Readable.from(chunks),
  };
}

describe("durable upstream task attachments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses only the upload URL returned by file creation and binds ownership before uploading", async () => {
    const events: string[] = [];
    const uploadUrl =
      "https://uploads.example.test/generated.skill?X-Amz-Signature=initial";
    const post = vi.spyOn(axios, "post").mockImplementation(async () => {
      events.push("create");
      return {
        status: 201,
        data: { id: "provider-file-1", upload_url: uploadUrl },
      };
    });
    const get = vi.spyOn(axios, "get");
    const put = vi.spyOn(axios, "put").mockImplementation(async () => {
      events.push("upload");
      return { status: 200, data: "" };
    });

    const result = await uploadUpstreamTaskAttachment({
      ...baseInput,
      idempotencyKey: "frontmind-kb-file-v1:stable-operation",
      onFileResolved: async (fileId) => {
        events.push(`persist:${fileId}`);
      },
    });

    expect(events).toEqual(["create", "persist:provider-file-1", "upload"]);
    expect(result.fileId).toBe("provider-file-1");
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v1/files",
      { filename: baseInput.filename },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "frontmind-kb-file-v1:stable-operation",
        }),
      }),
    );
    expect(get).not.toHaveBeenCalled();
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("API_KEY");
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("Authorization");
  });

  it("fails a newly created file without its initial upload URL without consulting metadata", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: { id: "provider-file-no-capability" },
    });
    const get = vi.spyOn(axios, "get");
    const put = vi.spyOn(axios, "put");

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("upload URL is unavailable");
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("recovers an uploaded existing file by streaming authenticated content and matching size and SHA-256", async () => {
    const fileId = "provider-file-uploaded";
    const post = vi.spyOn(axios, "post");
    const put = vi.spyOn(axios, "put");
    const get = vi
      .spyOn(axios, "get")
      .mockResolvedValueOnce(uploadedMetadata(fileId))
      .mockResolvedValueOnce(
        contentResponse([
          baseInput.bytes.subarray(0, 7),
          baseInput.bytes.subarray(7),
        ]),
      );

    const result = await uploadUpstreamTaskAttachment({
      ...baseInput,
      existingFileId: fileId,
      onFileResolved: async () => undefined,
    });

    expect(result).toMatchObject({
      attachment: { file_id: fileId, filename: baseInput.filename },
      fileId,
    });
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(get).toHaveBeenNthCalledWith(
      1,
      `https://api.example.test/v1/files/${fileId}`,
      expect.objectContaining({
        headers: expect.objectContaining({ API_KEY: "secret-test-key" }),
      }),
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      `https://api.example.test/v1/files/${fileId}/content`,
      expect.objectContaining({
        responseType: "stream",
        maxRedirects: 0,
        headers: expect.objectContaining({ API_KEY: "secret-test-key" }),
      }),
    );
  });

  it("preserves every byte of an opaque existing file id", async () => {
    const fileId = " provider/file id ";
    const get = vi
      .spyOn(axios, "get")
      .mockResolvedValueOnce(uploadedMetadata(fileId))
      .mockResolvedValueOnce(contentResponse([baseInput.bytes]));

    const result = await uploadUpstreamTaskAttachment({
      ...baseInput,
      existingFileId: fileId,
      onFileResolved: async () => undefined,
    });

    expect(result.fileId).toBe(fileId);
    expect(get.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v1/files/%20provider%2Ffile%20id%20",
    );
    expect(get.mock.calls[1]?.[0]).toBe(
      "https://api.example.test/v1/files/%20provider%2Ffile%20id%20/content",
    );
  });

  it("rejects uploaded content with the same size but a different SHA-256", async () => {
    const get = vi
      .spyOn(axios, "get")
      .mockResolvedValueOnce(uploadedMetadata("provider-file-mismatch"))
      .mockResolvedValueOnce(
        contentResponse([Buffer.alloc(baseInput.bytes.length, 0x78)]),
      );
    const put = vi.spyOn(axios, "put");

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        existingFileId: "provider-file-mismatch",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("content mismatch");
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
  });

  it("stops an oversized uploaded-content stream as soon as it exceeds the expected size", async () => {
    const stream = Readable.from([baseInput.bytes, Buffer.from("overflow")]);
    const destroy = vi.spyOn(stream, "destroy");
    vi.spyOn(axios, "get")
      .mockResolvedValueOnce(uploadedMetadata("provider-file-oversize"))
      .mockResolvedValueOnce({ status: 200, data: stream });
    const put = vi.spyOn(axios, "put");

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        existingFileId: "provider-file-oversize",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("content mismatch");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated content endpoint is non-successful", async () => {
    const unavailable = contentResponse([Buffer.from("not found")], 404);
    const destroy = vi.spyOn(unavailable.data, "destroy");
    vi.spyOn(axios, "get")
      .mockResolvedValueOnce(uploadedMetadata("provider-file-missing-content"))
      .mockResolvedValueOnce(unavailable);
    const put = vi.spyOn(axios, "put");

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        existingFileId: "provider-file-missing-content",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("content lookup failed");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("fails closed for official pending metadata because no same-id upload capability exists", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: "provider-file-pending",
        filename: baseInput.filename,
        status: "pending",
      },
    });
    const post = vi.spyOn(axios, "post");
    const put = vi.spyOn(axios, "put");

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        existingFileId: "provider-file-pending",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("upload capability is unavailable for existing file");
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [
      "identity mismatch",
      {
        id: "provider-file-other",
        filename: baseInput.filename,
        status: "uploaded",
      },
      "metadata mismatch",
    ],
    [
      "filename mismatch",
      {
        id: "provider-file-frozen",
        filename: "other.skill.zip",
        status: "uploaded",
      },
      "metadata mismatch",
    ],
    [
      "unknown state",
      {
        id: "provider-file-frozen",
        filename: baseInput.filename,
        status: "processing",
      },
      "state is not safely replayable",
    ],
  ])("fails closed for existing-file %s", async (_label, data, error) => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data,
    });
    const put = vi.spyOn(axios, "put");

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        existingFileId: "provider-file-frozen",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow(error);
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not delete a bound file when attachment upload later fails", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-uncertain",
        upload_url:
          "https://uploads.example.test/uncertain.skill?X-Amz-Signature=initial",
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({ status: 503, data: "retry" });
    const remove = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 204,
      data: "",
    });

    await expect(
      uploadUpstreamTaskAttachment({
        ...baseInput,
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("Task attachment upload failed");
    expect(remove).not.toHaveBeenCalled();
  });
});
