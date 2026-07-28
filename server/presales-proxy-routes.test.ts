import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    releasePresalesTaskReservation: vi.fn(),
    resolvePresalesTaskCredentialForFiles: vi.fn(),
  };
});

import presalesProxy from "./presales-proxy";
import { AuthServiceError } from "./auth-service";
import {
  acquirePresalesTaskReservation,
  completePresalesTaskReservation,
  getActivePresalesCredential,
  getPresalesCredentialForResource,
  releasePresalesTaskReservation,
  resolvePresalesTaskCredentialForFiles,
} from "./presales-service";

const token = "4UT1aQh7tFzS0I8NDkcM8Gv7r5d9ZLr0shF9xXfPjYg";
const originalServiceToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
const originalMonitorKey = process.env.FRONTMIND_MONITOR_API_KEY;
const originalPublicUrl = process.env.FRONTMIND_PUBLIC_URL;

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

  it("calls upstream once with the hash and completes the reservation", async () => {
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
      agentProfile: "manus-1.6",
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
