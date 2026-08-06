import { afterEach, describe, expect, it, vi } from "vitest";

import {
  knowledgeBaseObservationFromPayload,
  reconcileKnowledgeBaseObservation,
  repairKnowledgeBaseLogoProvenance,
} from "./knowledge-progress";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconcileKnowledgeBaseObservation", () => {
  it("preserves an explicit unbound authority instead of adopting a placeholder task id", () => {
    const observation = knowledgeBaseObservationFromPayload({
      task: { id: "turn-placeholder", status: "running" },
      observation: {
        stateEpoch: 4,
        generation: 2,
        authoritativeTaskId: null,
        activeTurn: { id: "turn-placeholder", status: "queued" },
        interaction: {
          progress: null,
          interactionState: "queued",
          canReply: false,
          canPublish: false,
          lockReason: null,
        },
        approvedPresentation: null,
        package: null,
        notice: null,
        conversationVersion: 4,
      },
    });

    expect(observation.authoritativeTaskId).toBeNull();
  });

  it("recovers a durable failed projection after reconcile returns 422", async () => {
    const failedObservation = {
      stateEpoch: 3,
      generation: 1,
      authoritativeTaskId: "task-1",
      activeTurn: null,
      interaction: {
        progress: null,
        interactionState: "failed",
        canReply: false,
        canPublish: false,
        lockReason: "PROGRESS_PROTOCOL_INVALID",
      },
      approvedPresentation: null,
      package: null,
      notice: {
        key: "kb:task-1:protocol-error",
        code: "PROGRESS_PROTOCOL_INVALID",
        severity: "error",
        message: "知识库资源校验未通过，本轮内容尚未更新",
        retryable: true,
        turnId: "turn-1",
        createdAt: 3,
      },
      conversationVersion: 3,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "PROGRESS_PROTOCOL_INVALID",
              message: "知识库资源校验未通过，本轮内容尚未更新",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ observation: failedObservation }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileKnowledgeBaseObservation({ conversationId: "conversation-1" }),
    ).resolves.toMatchObject({
      stateEpoch: 3,
      interaction: { interactionState: "failed" },
      notice: { code: "PROGRESS_PROTOCOL_INVALID", retryable: true },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/knowledge-base/progress/conversation-1",
      { credentials: "include", signal: undefined },
    );
  });
});

describe("repairKnowledgeBaseLogoProvenance", () => {
  const observation = {
    stateEpoch: 8,
    generation: 1,
    authoritativeTaskId: "task-1",
    activeTurn: null,
    interaction: {
      progress: null,
      interactionState: "failed",
      canReply: false,
      canPublish: false,
      lockReason: "FINAL_PACKAGE_INVALID",
    },
    approvedPresentation: null,
    package: null,
    notice: {
      key: "kb:final-retry",
      code: "FINAL_PACKAGE_INVALID",
      severity: "error",
      message: "请重试本轮",
      retryable: true,
      turnId: "turn-50",
      createdAt: 8,
    },
    conversationVersion: 8,
  };
  const input = {
    conversationId: "conversation-1",
    clientRequestId: "logo-repair-1",
    expectedGeneration: 1,
    expectedRevision: 50,
    expectedLeafId: "7.5",
    attachmentManifest: [
      {
        filename: "official-logo.png",
        sizeBytes: 9556,
        mimeType: "image/png",
        lastModified: 123,
        sha256: "a".repeat(64),
      },
    ] as [
      {
        filename: string;
        sizeBytes: number;
        mimeType: string;
        lastModified: number;
        sha256: string;
      },
    ],
    attachment: {
      file_id: "file-logo-1",
      filename: "official-logo.png",
    },
  };

  it("posts the exact captured file and one-item browser manifest", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ repaired: true, observation }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      repairKnowledgeBaseLogoProvenance(input),
    ).resolves.toMatchObject({
      stateEpoch: 8,
      notice: { code: "FINAL_PACKAGE_INVALID", retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge-base/logo-provenance/repair",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  });

  it("preserves the byte-mismatch error code for explicit UI guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
              message: "Logo bytes do not match",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      repairKnowledgeBaseLogoProvenance(input),
    ).rejects.toMatchObject({
      message: "Logo bytes do not match",
      status: 422,
      code: "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
    });
  });
});
