import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpGeoPresalesBroker } from "../../frontmind-website/server/geo/broker";

vi.mock("./presales-service", async () => {
  const actual =
    await vi.importActual<typeof import("./presales-service")>(
      "./presales-service",
    );
  return {
    ...actual,
    acquirePresalesTaskReservation: vi.fn(),
    completePresalesTaskReservation: vi.fn(),
    getActivePresalesCredential: vi.fn(),
    getPresalesCredentialForResource: vi.fn(),
    hasPresalesOutputUrlGrant: vi.fn(),
    recordPresalesUpstreamResource: vi.fn(),
    releasePresalesTaskReservation: vi.fn(),
    resolvePresalesTaskCredentialForFiles: vi.fn(),
    syncPresalesOutputUrlGrants: vi.fn(),
  };
});

import presalesProxy from "./presales-proxy";
import { AuthServiceError } from "./auth-service";
import {
  acquirePresalesTaskReservation,
  completePresalesTaskReservation,
  getActivePresalesCredential,
  getPresalesCredentialForResource,
  hasPresalesOutputUrlGrant,
  recordPresalesUpstreamResource,
  releasePresalesTaskReservation,
  resolvePresalesTaskCredentialForFiles,
  syncPresalesOutputUrlGrants,
} from "./presales-service";

const token = "4UT1aQh7tFzS0I8NDkcM8Gv7r5d9ZLr0shF9xXfPjYg";
const originalServiceToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
const originalMonitorKey = process.env.FRONTMIND_MONITOR_API_KEY;
const originalPublicUrl = process.env.FRONTMIND_PUBLIC_URL;
const originalDashboardAssetDir = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
let dashboardAssetDir = "";

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use("/api/internal/presales", presalesProxy);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/internal/presales`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("presales readiness status", () => {
  afterEach(() => {
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
    if (originalMonitorKey === undefined) {
      delete process.env.FRONTMIND_MONITOR_API_KEY;
    } else {
      process.env.FRONTMIND_MONITOR_API_KEY = originalMonitorKey;
    }
    if (originalPublicUrl === undefined) {
      delete process.env.FRONTMIND_PUBLIC_URL;
    } else {
      process.env.FRONTMIND_PUBLIC_URL = originalPublicUrl;
    }
    vi.mocked(getActivePresalesCredential).mockReset();
  });

  it("returns only non-secret readiness booleans for paid monitoring", async () => {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_MONITOR_API_KEY =
      "dedicated-monitor-credential-for-tests";
    process.env.FRONTMIND_PUBLIC_URL = "https://agent.frontmind.test";
    vi.mocked(getActivePresalesCredential).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "ordinary-presales-test-key",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/status`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        ok: true,
        credentialConfigured: true,
        monitorCredentialConfigured: true,
        publicUrlConfigured: true,
      });
      expect(JSON.stringify(body)).not.toContain(
        process.env.FRONTMIND_MONITOR_API_KEY,
      );
    });
  });
});

describe("presales create-time upload capability", () => {
  beforeEach(async () => {
    dashboardAssetDir = await mkdtemp(
      path.join(tmpdir(), "frontmind-presales-files-test-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = dashboardAssetDir;
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    vi.mocked(getActivePresalesCredential).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-upload-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(getPresalesCredentialForResource).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-upload-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
      resource: {
        id: "resource-1",
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: "file-1",
        parentTaskId: null,
        createdAt: new Date(),
      },
    });
    vi.mocked(recordPresalesUpstreamResource).mockResolvedValue(undefined);
    vi.mocked(hasPresalesOutputUrlGrant).mockResolvedValue(true);
    vi.mocked(syncPresalesOutputUrlGrants).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(getActivePresalesCredential).mockReset();
    vi.mocked(getPresalesCredentialForResource).mockReset();
    vi.mocked(hasPresalesOutputUrlGrant).mockReset();
    vi.mocked(recordPresalesUpstreamResource).mockReset();
    vi.mocked(syncPresalesOutputUrlGrants).mockReset();
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
    if (originalDashboardAssetDir === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = originalDashboardAssetDir;
    }
    await rm(dashboardAssetDir, { recursive: true, force: true });
  });

  it("uploads with the signed URL returned by file creation even when details omit it", async () => {
    const signedUrl =
      "https://uploads.example.test/catalog.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcdef0123456789";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-1",
        filename: "catalog.pdf",
        upload_url: signedUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    const metadataLookup = vi.spyOn(axios, "get");
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 204,
      data: "",
    });

    await withServer(async (baseUrl) => {
      const created = await fetch(`${baseUrl}/files`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          filename: "catalog.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        }),
      });
      expect(created.status).toBe(201);
      const file = (await created.json()) as Record<string, string>;
      expect(file.proxy_upload_ticket).toMatch(/^v1\./);

      const uploaded = await fetch(`${baseUrl}/files/file-1/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "3",
          "x-original-content-type": "application/pdf",
          "x-frontmind-service-token": token,
          "x-frontmind-upload-ticket": file.proxy_upload_ticket,
        },
        body: Buffer.from("pdf"),
      });
      expect(uploaded.status).toBe(200);
    });

    expect(metadataLookup).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      signedUrl,
      expect.anything(),
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });

  it("round-trips Website Broker bytes through durable local storage without calling an upstream download endpoint", async () => {
    const bytes = Buffer.from("zip");
    let storedBytes = Buffer.alloc(0);
    const signedUploadUrl =
      "https://uploads.example.test/final.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=put-only";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-1",
        filename: "final.zip",
        upload_url: signedUploadUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    vi.spyOn(axios, "put").mockImplementation(async (_url, body) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      storedBytes = Buffer.concat(chunks);
      return { status: 204, data: "" };
    });
    const get = vi.spyOn(axios, "get").mockImplementation(async () => ({
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(storedBytes.length),
        "content-disposition": "attachment; filename*=UTF-8''website-final.zip",
      },
      data: Readable.from([storedBytes]),
    }));

    await withServer(async (baseUrl) => {
      const broker = new HttpGeoPresalesBroker({
        baseUrl,
        serviceToken: token,
        fetchImpl: (input, init) =>
          fetch(input, { ...init, signal: undefined }),
      });
      const file = await broker.createFile({
        filename: "final.zip",
        mimeType: "application/zip",
        sizeBytes: bytes.length,
      });
      await broker.uploadFile(
        file.id,
        bytes,
        "application/zip",
        file.proxy_upload_ticket,
      );
      const downloaded = await broker.downloadFile(file.id);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      expect(downloaded.headers.get("content-disposition")).toContain(
        "final.zip",
      );
    });

    expect(storedBytes).toEqual(bytes);
    expect(get).not.toHaveBeenCalled();
  });

  it("does not publish a local file when the upstream upload was rejected", async () => {
    const signedUploadUrl =
      "https://uploads.example.test/rejected.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=rejected";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "file-1",
        filename: "rejected.zip",
        upload_url: signedUploadUrl,
        upload_expires_at: new Date(Date.now() + 180_000).toISOString(),
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({
      status: 403,
      data: { message: "rejected" },
    });
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 404,
      headers: {},
      data: Readable.from([]),
    });

    await withServer(async (baseUrl) => {
      const broker = new HttpGeoPresalesBroker({
        baseUrl,
        serviceToken: token,
        fetchImpl: (input, init) =>
          fetch(input, { ...init, signal: undefined }),
      });
      const file = await broker.createFile({
        filename: "rejected.zip",
        mimeType: "application/zip",
        sizeBytes: 3,
      });
      await expect(
        broker.uploadFile(
          file.id,
          Buffer.from("zip"),
          "application/zip",
          file.proxy_upload_ticket,
        ),
      ).rejects.toThrow("rejected");

      const downloaded = await fetch(`${baseUrl}/files/file-1/content`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(downloaded.status).toBe(404);
    });

    expect(get).toHaveBeenCalledOnce();
  });

  it.each([403, 404, 503])(
    "returns a controlled file-content error for upstream status %s",
    async (status) => {
      vi.spyOn(axios, "get").mockResolvedValue({
        status,
        headers: {},
        data: { secret: "must-not-leak" },
      });

      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/files/file-1/content`, {
          headers: { "x-frontmind-service-token": token },
        });
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "UPSTREAM_FILE_CONTENT_FAILED",
            message: "File content download failed",
          },
        });
      });
    },
  );

  it("rejects an empty upstream file body", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/zip" },
      data: Readable.from([]),
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "UPSTREAM_FILE_CONTENT_EMPTY",
          message: "File content download failed",
        },
      });
    });
  });

  it("rejects an upstream file whose declared body exceeds the archive limit", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(100 * 1024 * 1024 + 1),
      },
      data: Readable.from([Buffer.from("must-not-stream")]),
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "UPSTREAM_FILE_CONTENT_TOO_LARGE",
          message: "File content download failed",
        },
      });
    });
  });

  it("keeps the trusted URL-only task-output fallback for historical tasks", async () => {
    const target = "https://downloads.example.test/historical.zip?sig=trusted";
    const bytes = Buffer.from("historical-zip");
    const get = vi
      .spyOn(axios, "get")
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: "task-legacy",
          status: "completed",
          output: [
            {
              role: "assistant",
              content: [
                {
                  type: "output_file",
                  filename: "historical.zip",
                  file_url: target,
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(bytes.length),
        },
        data: Readable.from([bytes]),
      });

    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/tasks/task-legacy/output?${new URLSearchParams({
          url: target,
          filename: "historical.zip",
        }).toString()}`,
        { headers: { "x-frontmind-service-token": token } },
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]![0]).toContain("/v1/tasks/task-legacy");
    expect(get.mock.calls[1]![0]).toBe(target);
    expect(hasPresalesOutputUrlGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "task-legacy",
        url: target,
      }),
    );
  });
});

describe("presales deletion routes", () => {
  beforeEach(() => {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    vi.mocked(getPresalesCredentialForResource).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-delete-file",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
      resource: {
        id: "resource-1",
        apiCredentialId: "credential-1",
        kind: "file",
        upstreamId: "file-1",
        parentTaskId: null,
        createdAt: new Date(),
      },
    });
    vi.mocked(resolvePresalesTaskCredentialForFiles).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-create-task",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(completePresalesTaskReservation).mockResolvedValue(undefined);
    vi.mocked(releasePresalesTaskReservation).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
  });

  it("returns 204 when the upstream file is already absent", async () => {
    const deleteMock = vi
      .spyOn(axios, "delete")
      .mockResolvedValue({ status: 404, data: { message: "not found" } });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1`, {
        method: "DELETE",
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });

    expect(deleteMock).toHaveBeenCalledOnce();
    expect(deleteMock.mock.calls[0][0]).toContain("/v1/files/file-1");
  });

  it("forwards a controlled JSON error for an upstream failure", async () => {
    vi.spyOn(axios, "delete").mockResolvedValue({
      status: 503,
      data: { message: "storage unavailable" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1`, {
        method: "DELETE",
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "UPSTREAM_FILE_DELETE_FAILED",
          message: "storage unavailable",
        },
      });
    });
  });

  it("uploads website attachments to the exact SigV4 URL without redirects", async () => {
    const signedUrl =
      "https://uploads.example.test/catalog.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef0123456789";
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: { id: "file-1", filename: "catalog.pdf", upload_url: signedUrl },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 204,
      data: "",
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/files/file-1/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-original-content-type": "application/pdf",
          "x-frontmind-service-token": token,
        },
        body: Buffer.from("pdf"),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "uploaded",
      });
    });

    expect(put).toHaveBeenCalledWith(
      signedUrl,
      expect.anything(),
      expect.objectContaining({
        maxRedirects: 0,
        headers: expect.objectContaining({
          "Content-Type": "application/pdf",
        }),
      }),
    );
  });

  it("returns 204 when the upstream task is already absent", async () => {
    const deleteMock = vi
      .spyOn(axios, "delete")
      .mockResolvedValue({ status: 404, data: { message: "not found" } });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks/task-1`, {
        method: "DELETE",
        headers: { "x-frontmind-service-token": token },
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });

    expect(deleteMock).toHaveBeenCalledOnce();
    expect(deleteMock.mock.calls[0][0]).toContain("/v1/tasks/task-1");
  });
});

describe("presales idempotent task route", () => {
  beforeEach(() => {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    vi.mocked(resolvePresalesTaskCredentialForFiles).mockResolvedValue({
      id: "credential-1",
      version: 1,
      apiKey: "sk-create-task",
      fingerprint: "fingerprint",
      status: "active",
      verifiedAt: new Date(),
    });
    vi.mocked(completePresalesTaskReservation).mockResolvedValue(undefined);
    vi.mocked(releasePresalesTaskReservation).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalServiceToken === undefined) {
      delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    } else {
      process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
    }
  });

  it("calls upstream once with the hash and trusted Pro profile", async () => {
    const keyHash = "a".repeat(64);
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-1",
      attemptId: "attempt-1",
      keyHash,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const createMock = vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: { id: "task-1", status: "queued" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          attachments: [],
          idempotencyKey: "project-123:knowledge-base:create",
          agentProfile: "frontmind-pro",
        }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ id: "task-1" });
    });

    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0][1]).toMatchObject({
      prompt: "build knowledge base",
      agentProfile: "manus-1.6-max",
      taskMode: "agent",
    });
    expect(JSON.stringify(createMock.mock.calls[0][1])).not.toContain(
      "idempotencyKey",
    );
    expect(createMock.mock.calls[0][2]).toMatchObject({
      headers: { "Idempotency-Key": keyHash },
    });
    expect(completePresalesTaskReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation-1",
        attemptId: "attempt-1",
        upstreamTaskId: "task-1",
      }),
    );
  });

  it("returns a completed reservation without calling upstream", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "completed",
      upstreamTaskId: "task-original",
      task: { id: "task-original", status: "queued" },
    });
    const createMock = vi.spyOn(axios, "post");

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("idempotent-replayed")).toBe("true");
      await expect(response.json()).resolves.toEqual({
        id: "task-original",
        status: "queued",
      });
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 425 with Retry-After while another process owns the lease", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockRejectedValue(
      new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "相同任务正在创建中，请稍后重试",
        2_000,
      ),
    );
    const createMock = vi.spyOn(axios, "post");

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(425);
      expect(response.headers.get("retry-after")).toBe("2");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "IDEMPOTENCY_PENDING" },
      });
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("releases the reservation after a known upstream failure", async () => {
    const acquired = {
      state: "acquired" as const,
      reservationId: "reservation-failed",
      attemptId: "attempt-failed",
      keyHash: "b".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue(acquired);
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 503,
      data: { message: "upstream unavailable" },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UPSTREAM_TASK_CREATE_FAILED" },
      });
    });
    expect(releasePresalesTaskReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: acquired.reservationId,
        attemptId: acquired.attemptId,
      }),
    );
    expect(completePresalesTaskReservation).not.toHaveBeenCalled();
  });

  it("keeps the lease after an ambiguous transport failure", async () => {
    vi.mocked(acquirePresalesTaskReservation).mockResolvedValue({
      state: "acquired",
      reservationId: "reservation-timeout",
      attemptId: "attempt-timeout",
      keyHash: "c".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    vi.spyOn(axios, "post").mockRejectedValue(new Error("request timed out"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-service-token": token,
        },
        body: JSON.stringify({
          prompt: "build knowledge base",
          idempotencyKey: "project-123:knowledge-base:create",
        }),
      });
      expect(response.status).toBe(502);
    });
    expect(releasePresalesTaskReservation).not.toHaveBeenCalled();
    expect(completePresalesTaskReservation).not.toHaveBeenCalled();
  });
});
