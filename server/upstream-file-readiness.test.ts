import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkUpstreamFileReadiness,
  UpstreamFileReadinessError,
  waitForUpstreamFilesReady,
} from "./upstream-file-readiness";

const base = {
  baseUrl: "https://api.example.test/",
  apiKey: "secret-test-key",
  file: { fileId: "file-1", filename: "provider-name.pdf" },
};

describe("upstream file readiness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts the official v1 shape and sends API_KEY only", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: base.file.fileId,
        filename: base.file.filename,
        status: "uploaded",
      },
    });

    await expect(checkUpstreamFileReadiness(base)).resolves.toMatchObject({
      ...base.file,
      state: "uploaded",
    });
    const options = get.mock.calls[0]?.[1];
    expect(options?.timeout).toBe(10_000);
    expect(options?.headers).toEqual({
      API_KEY: base.apiKey,
      Accept: "application/json",
    });
    expect(options?.headers).not.toHaveProperty("Authorization");
  });

  it("waits pending metadata with the bounded backoff before succeeding", async () => {
    vi.spyOn(axios, "get")
      .mockResolvedValueOnce({
        status: 200,
        data: { ...base.file, id: base.file.fileId, status: "pending" },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { ...base.file, id: base.file.fileId, status: "pending" },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { ...base.file, id: base.file.fileId, status: "uploaded" },
      });
    const delays: number[] = [];

    const result = await waitForUpstreamFilesReady({
      ...base,
      files: [base.file],
      deadlineMs: 10_000,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays).toEqual([500, 1_000]);
    expect(result.pending).toEqual([]);
    expect(result.ready).toHaveLength(1);
  });

  it("returns pending when the readiness deadline is reached", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: base.file.fileId,
        filename: base.file.filename,
        status: "pending",
      },
    });

    const result = await waitForUpstreamFilesReady({
      ...base,
      files: [base.file],
      deadlineMs: 0,
    });

    expect(result.pending).toHaveLength(1);
    expect(result.ready).toEqual([]);
  });

  it("supports an authoritative provider filename for first-time canonicalization", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: base.file.fileId,
        filename: "provider-normalized.pdf",
        status: "uploaded",
      },
    });

    await expect(
      checkUpstreamFileReadiness({
        ...base,
        filenamePolicy: "provider_authoritative",
      }),
    ).resolves.toMatchObject({ filename: "provider-normalized.pdf" });
    await expect(checkUpstreamFileReadiness(base)).rejects.toMatchObject({
      code: "UPSTREAM_FILE_IDENTITY_MISMATCH",
    });
  });

  it("rejects an all-whitespace provider filename before task preparation", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        id: base.file.fileId,
        filename: "   ",
        status: "uploaded",
      },
    });

    await expect(
      checkUpstreamFileReadiness({
        ...base,
        filenamePolicy: "provider_authoritative",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FILE_METADATA_INVALID",
      retryable: false,
    });
  });

  it("fails closed for deleted, error, unknown, or mismatched identities", async () => {
    const get = vi.spyOn(axios, "get");
    for (const status of ["deleted", "error", "processing"]) {
      get.mockResolvedValueOnce({
        status: 200,
        data: { id: base.file.fileId, filename: base.file.filename, status },
      });
      await expect(checkUpstreamFileReadiness(base)).rejects.toBeInstanceOf(
        UpstreamFileReadinessError,
      );
    }
    get.mockResolvedValueOnce({
      status: 200,
      data: { id: "other", filename: base.file.filename, status: "uploaded" },
    });
    await expect(checkUpstreamFileReadiness(base)).rejects.toMatchObject({
      code: "UPSTREAM_FILE_IDENTITY_MISMATCH",
      retryable: false,
    });
  });

  it("classifies temporary metadata failures without exposing response data", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 503,
      data: { secret: "must-not-be-copied" },
    });

    await expect(checkUpstreamFileReadiness(base)).rejects.toMatchObject({
      code: "UPSTREAM_FILE_METADATA_UNAVAILABLE",
      retryable: true,
      httpStatus: 503,
      message: "Upstream file metadata is temporarily unavailable",
    });
  });
});
