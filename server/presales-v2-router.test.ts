import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import { describe, expect, it, vi } from "vitest";

import presalesV2Router, {
  acceptedPresalesV2StructuredResult,
  bindPresalesV2TaskAssetProject,
  parsePresalesV2TaskCreate,
  presalesV2ArtifactBeforeRedirect,
  presalesV2RemoteCleanupFailure,
  presalesV2PreparationFailureState,
  presalesV2AssistantAttachments,
  presalesV2PublicTask,
  presalesV2SafeEvents,
} from "./presales-v2-router";
import { PRESALES_V2_CONTRACT_HASHES } from "./presales-v2-contracts";
import { ManusV2ApiError } from "./manus-v2-client";
import {
  acquirePresalesV2Task,
  readPresalesV2Task,
  updatePresalesV2Task,
  type PresalesV2TaskRecord,
} from "./presales-v2-store";

function taskRecord(
  overrides: Partial<PresalesV2TaskRecord> = {},
): PresalesV2TaskRecord {
  return {
    schemaVersion: 2,
    localTaskId: "00000000-0000-4000-8000-000000000001",
    operationId: "00000000-0000-4000-8000-000000000002",
    idempotencyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    projectId: "project-acceptance-001",
    contract: {
      name: "website.question-recommendation",
      revision: 2,
      schemaHash:
        PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
    },
    profile: "frontmind-pro",
    upstreamModel: "manus-1.6-max",
    operationToken: "00000000-0000-4000-8000-000000000002",
    operationMarker: "secret-operation-marker",
    providerTitle: "private provider title",
    credentialId: "credential-secret-id",
    credentialVersion: 3,
    providerTaskId: "provider-task-secret",
    providerRequestId: "provider-request-secret",
    providerFileLeases: [
      {
        localAssetId: "00000000-0000-4000-8000-000000000003",
        providerFileId: "provider-file-secret",
        filename: "facts.pdf",
        expiresAt: 2_000_000_000,
        providerRequestId: "provider-file-request-secret",
        uploadState: "uploaded",
      },
    ],
    status: "succeeded",
    safeEvents: [{ id: "event-1", type: "status_update", timestamp: 1 }],
    structuredResult: { questions: [] },
    artifacts: [],
    errorCode: null,
    resultDeadlineAt: null,
    createSearchUntil: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Presales v2 public contract", () => {
  it("replays the durable project bind after the local asset index was already bound", async () => {
    const asset = {
      schemaVersion: 2 as const,
      localAssetId: "00000000-0000-4000-8000-000000000003",
      idempotencyHash: "a".repeat(64),
      requestHash: "b".repeat(64),
      projectId: "project-acceptance-001",
      filename: "facts.pdf",
      mimeType: "application/pdf",
      expectedBytes: 3,
      bytes: 3,
      sha256: "c".repeat(64),
      status: "uploaded" as const,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const bindLocalRecord = vi.fn();
    const bindDurableRecord = vi.fn(async () => ({ id: asset.localAssetId }));

    await expect(
      bindPresalesV2TaskAssetProject(
        { asset, projectId: asset.projectId },
        { bindLocalRecord, bindDurableRecord },
      ),
    ).resolves.toBe(asset);
    expect(bindLocalRecord).not.toHaveBeenCalled();
    expect(bindDurableRecord).toHaveBeenCalledWith({
      localAssetId: asset.localAssetId,
      projectId: asset.projectId,
    });
  });

  it("keeps ambiguous file uploads attention-required for durable reconciliation", () => {
    expect(
      presalesV2PreparationFailureState(
        new (class extends Error {
          readonly outcomeUnknown = true;
        })(),
      ),
    ).toEqual({ status: "failed", errorCode: "TASK_PREPARATION_FAILED" });
    expect(
      presalesV2PreparationFailureState(
        new ManusV2ApiError(
          "file.upload.content",
          null,
          "TRANSPORT_UNKNOWN",
          false,
          true,
        ),
      ),
    ).toEqual({
      status: "attention_required",
      errorCode: "FILE_UPLOAD_OUTCOME_UNKNOWN",
    });
  });
  it("rejects caller-selected model/profile/task mode before any dispatch", () => {
    const body = {
      projectId: "project-acceptance-001",
      prompt: "recommend questions",
      localAssetIds: [],
      idempotencyKey: "recommendation-request-0001",
      contract: {
        name: "website.question-recommendation",
        revision: 2,
        schemaHash:
          PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
      },
    };
    expect(parsePresalesV2TaskCreate(body)).toEqual(body);
    expect(() =>
      parsePresalesV2TaskCreate(
        Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== "projectId"),
        ),
      ),
    ).toThrow();
    for (const forbidden of ["agentProfile", "model", "taskMode"] as const) {
      expect(() =>
        parsePresalesV2TaskCreate({ ...body, [forbidden]: "frontmind-base" }),
      ).toThrow();
    }
  });

  it("discards success:false values and returns accepted top-level objects unchanged", () => {
    expect(
      acceptedPresalesV2StructuredResult([
        {
          id: "event-failed",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: false,
            value: { questions: [] },
            error: "no meaningful result",
          },
        },
      ]),
    ).toBeNull();
    const structuredResult = { questions: [{ id: "q1" }] };
    expect(
      acceptedPresalesV2StructuredResult([
        {
          id: "event-ready",
          type: "structured_output_result",
          timestamp: 3,
          structured_output_result: {
            success: true,
            value: structuredResult,
            error: null,
          },
        },
      ]),
    ).toBe(structuredResult);
  });

  it("reads only documented assistant attachment coordinates", () => {
    expect(
      presalesV2AssistantAttachments([
        {
          id: "event-zip",
          type: "assistant_message",
          timestamp: 4,
          assistant_message: {
            content: "done",
            attachments: [
              {
                filename: "candidate.zip",
                url: "https://downloads.example/candidate.zip",
                content_type: "application/zip",
              },
              { file_id: "legacy-provider-file", filename: "legacy.zip" },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        eventId: "event-zip",
        attachmentIndex: 0,
        filename: "candidate.zip",
        contentType: "application/zip",
        url: "https://downloads.example/candidate.zip",
      },
    ]);
  });

  it("allows HTTPS artifact redirects but rejects HTTPS-to-HTTP downgrade", () => {
    expect(() =>
      presalesV2ArtifactBeforeRedirect({
        protocol: "https:",
        hostname: "downloads.example",
      }),
    ).not.toThrow();
    expect(() =>
      presalesV2ArtifactBeforeRedirect({
        protocol: "http:",
        hostname: "downloads.example",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UNSAFE_ARTIFACT_URL", status: 502 }),
    );
  });

  it("treats revoked or expired Provider cleanup as terminal without retrying unknown outcomes", () => {
    for (const status of [401, 403, 404, 410]) {
      expect(
        presalesV2RemoteCleanupFailure(
          new ManusV2ApiError(
            "task.delete",
            status,
            `HTTP_${status}`,
            false,
            false,
          ),
        ),
      ).toEqual({
        disposition: "terminal_unavailable",
        errorCode: `HTTP_${status}`,
      });
    }
    expect(
      presalesV2RemoteCleanupFailure(
        new ManusV2ApiError(
          "task.delete",
          502,
          "TRANSPORT_UNKNOWN",
          false,
          true,
        ),
      ),
    ).toEqual({
      disposition: "outcome_unknown",
      errorCode: "TRANSPORT_UNKNOWN",
    });
  });

  it("never exposes Provider, credential, marker, or model identity", () => {
    const serialized = JSON.stringify(presalesV2PublicTask(taskRecord()));
    expect(serialized).toContain("00000000-0000-4000-8000-000000000001");
    for (const secret of [
      "provider-task-secret",
      "provider-request-secret",
      "provider-file-secret",
      "credential-secret-id",
      "secret-operation-marker",
      "manus-1.6-max",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("replaces Provider event identities with stable task-scoped local ids", () => {
    const providerEventId = "provider-event-secret-20260814";
    const providerEvents = [
      {
        id: providerEventId,
        type: "status_update",
        timestamp: 1_723_648_000_000,
      },
    ];
    const first = presalesV2SafeEvents(
      "00000000-0000-4000-8000-000000000001",
      providerEvents,
    );
    const rescanned = presalesV2SafeEvents(
      "00000000-0000-4000-8000-000000000001",
      first,
    );
    const otherTask = presalesV2SafeEvents(
      "00000000-0000-4000-8000-000000000099",
      providerEvents,
    );

    expect(first).toEqual(rescanned);
    expect(first[0]?.id).toMatch(/^safeevt_[a-f0-9]{64}$/u);
    expect(first[0]?.id).not.toBe(otherTask[0]?.id);
    expect(JSON.stringify(first)).not.toContain(providerEventId);

    const publicTask = presalesV2PublicTask(
      taskRecord({ safeEvents: providerEvents }),
    );
    expect(JSON.stringify(publicTask)).not.toContain(providerEventId);
    expect(publicTask.safeEvents).toEqual(first);
  });

  it("omits result until ready and emits only a safe retryability flag", () => {
    const running = presalesV2PublicTask(
      taskRecord({ status: "running", errorCode: null }),
    );
    expect(running).not.toHaveProperty("result");

    const failed = presalesV2PublicTask(
      taskRecord({ status: "failed", errorCode: "INVALID_OUTPUT" }),
    );
    expect(failed).not.toHaveProperty("result");
    expect(failed).toMatchObject({
      error: { code: "INVALID_OUTPUT", retryable: false },
    });
  });

  it("serves an idempotent project-scoped cleanup DTO on the v2 route", async () => {
    const previousToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    const previousAssetDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const assetDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-presales-v2-project-delete-"),
    );
    const token = "presales-v2-project-delete-test-token-20260814";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;

    const app = express();
    app.use("/api/internal/presales/v2", presalesV2Router);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/internal/presales/v2/projects/project-acceptance-001/tasks`,
          {
            method: "DELETE",
            headers: { "x-frontmind-service-token": token },
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          schemaVersion: 1,
          projectId: "project-acceptance-001",
          status: "deleted",
          deletedTasks: 0,
          deletedFiles: 0,
          pendingReservations: 0,
        });
      }

      const pendingRecord = await acquirePresalesV2Task({
        idempotencyKey: "pending-project-task-delete-test",
        requestHash: "f".repeat(64),
        projectId: "project-pending-001",
        contract: {
          name: "website.question-recommendation",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
        },
        profile: "frontmind-pro",
        upstreamModel: "manus-1.6-max",
        credentialId: "00000000-0000-4000-8000-000000000099",
        credentialVersion: 1,
      });
      const pending = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/projects/project-pending-001/tasks`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({
        schemaVersion: 1,
        projectId: "project-pending-001",
        status: "deleted",
        deletedTasks: 1,
        deletedFiles: 0,
        pendingReservations: 0,
      });
      await expect(
        readPresalesV2Task(pendingRecord.record.localTaskId),
      ).resolves.toMatchObject({
        projectCleanupAt: expect.any(String),
        providerCleanupDisposition: "outcome_unknown",
        providerCleanupErrorCode: "PROVIDER_TASK_ID_UNAVAILABLE",
      });

      const revokedRecord = await acquirePresalesV2Task({
        idempotencyKey: "revoked-project-task-delete-test",
        requestHash: "e".repeat(64),
        projectId: "project-revoked-001",
        contract: {
          name: "website.question-recommendation",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
        },
        profile: "frontmind-pro",
        upstreamModel: "manus-1.6-max",
        credentialId: "00000000-0000-4000-8000-000000000098",
        credentialVersion: 1,
      });
      await updatePresalesV2Task(revokedRecord.record.localTaskId, (record) => ({
        ...record,
        providerTaskId: "provider-task-from-revoked-key",
        status: "succeeded",
      }));
      const revoked = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/projects/project-revoked-001/tasks`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        status: "deleted",
        deletedTasks: 1,
        pendingReservations: 0,
      });
      await expect(
        readPresalesV2Task(revokedRecord.record.localTaskId),
      ).resolves.toMatchObject({
        projectCleanupAt: expect.any(String),
        providerCleanupDisposition: "outcome_unknown",
        providerCleanupErrorCode: "REMOTE_CLEANUP_OUTCOME_UNKNOWN",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(assetDirectory, { force: true, recursive: true });
      if (previousToken === undefined) {
        delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
      } else {
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = previousToken;
      }
      if (previousAssetDirectory === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetDirectory;
      }
    }
  });
});
