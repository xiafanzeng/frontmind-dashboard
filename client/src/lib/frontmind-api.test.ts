import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createKnowledgeBaseTurnTask,
  discardUnboundUpload,
  reserveKnowledgeBaseTurnWithAttachments,
  stageKnowledgeBaseTurnAttachment,
  createResponseLogicTask,
  DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
  FILE_UPLOAD_STALL_TIMEOUT_MS,
  getModelDisplayName,
  MANAGED_UPLOAD_RECOVERY_TIMEOUT_MS,
  recoverManagedUpload,
  retrieveTask,
  sanitizeBrandText,
  type ManagedUploadHandle,
  uploadFile,
  uploadFileToUrl,
} from "./frontmind-api";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sanitizeBrandText", () => {
  it("rebrands alternate provider copy before it reaches the interface", () => {
    const sourceBrand = ["Jeno", "va"].join("");
    const visible = sanitizeBrandText(
      `独立 ${sourceBrand} 凭证 · ${sourceBrand.toLowerCase()} Brand Tracker · https://api.${sourceBrand.toLowerCase()}.ai`,
    );

    expect(visible).toBe(
      "独立 FrontMind 凭证 · FrontMind Brand Tracker · https://api.frontmind.ai",
    );
    expect(visible.toLowerCase()).not.toContain(sourceBrand.toLowerCase());
    expect(getModelDisplayName(`${sourceBrand} Pro`)).toBe("FrontMind Pro");
  });

  it("removes knowledge-base protocol envelopes from visible assistant text", () => {
    const visible = sanitizeBrandText(
      [
        "请确认当前节点。",
        '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress","revision":3} -->',
        "确认后继续。",
      ].join("\n"),
    );

    expect(visible).toContain("请确认当前节点。");
    expect(visible).toContain("确认后继续。");
    expect(visible).not.toContain("FRONTMIND_KB_PROGRESS");
    expect(visible).not.toContain('"revision":3');
  });

  it("hides bare protocol JSON from real knowledge-base output", () => {
    const visible = sanitizeBrandText(
      [
        "## 1.1 企业定位",
        "企业定位正文。",
        JSON.stringify({
          kind: "frontmind.knowledge-base.manifest",
          schemaVersion: 1,
          leaves: [{ id: "1.1", title: "企业定位" }],
        }),
        JSON.stringify({
          kind: "frontmind.workflow-state",
          schemaVersion: 1,
          currentLeafId: "1.1",
        }),
        JSON.stringify({
          kind: "frontmind.knowledge-base.presentation",
          schemaVersion: 1,
          leafId: "1.1",
        }),
      ].join("\n"),
    );

    expect(visible).toContain("企业定位正文。");
    expect(visible).not.toContain("frontmind.knowledge-base.manifest");
    expect(visible).not.toContain("frontmind.workflow-state");
    expect(visible).not.toContain("frontmind.knowledge-base.presentation");
  });

  it("keeps the source provider name out of production client source", () => {
    const sourceBrand = ["ma", "nus"].join("");
    const sourceRoot = resolve(process.cwd(), "client/src");
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const pathname = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(pathname);
          continue;
        }
        if (
          !/\.(?:ts|tsx)$/.test(entry.name) ||
          /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
        ) {
          continue;
        }
        if (
          readFileSync(pathname, "utf8")
            .toLowerCase()
            .includes(sourceBrand.toLowerCase())
        ) {
          offenders.push(pathname.slice(sourceRoot.length + 1));
        }
      }
    };

    visit(sourceRoot);
    expect(offenders).toEqual([]);
  });
});

describe("createResponseLogicTask", () => {
  it("sends MIME metadata only to the authenticated response-logic route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: "task-response-logic", status: "running", output: [] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createResponseLogicTask(
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "请核验本轮资料。" },
            {
              type: "input_file",
              file_id: "file-image",
              filename: "evidence.png",
              mime_type: "image/png",
            },
          ],
        },
      ],
      {
        conversationId: "conv-response-logic",
        questionId: "question-1",
        groupId: "group-1",
        groupTitle: "产品场景",
        question: "如何回答？",
        intent: "核验事实",
        summary: "形成应答逻辑",
        draft: {
          concern: "",
          conclusion: "",
          facts: "",
          pending: "",
          boundaries: "",
          references: "",
          images: [],
          attachments: [],
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/response-logic/start",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments).toEqual([
      {
        file_id: "file-image",
        filename: "evidence.png",
        mime_type: "image/png",
      },
    ]);
  });
});

describe("createKnowledgeBaseTurnTask", () => {
  it("preserves the server error code and Retry-After metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "2" : null,
      },
      json: async () => ({
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "相同附件仍在暂存",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reserveKnowledgeBaseTurnWithAttachments([], {
        conversationId: "conv-kb",
        clientRequestId: "request-files",
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        expectedPresentationKey: "presentation-5",
        attachmentManifest: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_PENDING",
      retryAfter: "2",
      retryAfterMs: 2_000,
    });
  });

  it("retries a disconnected turn request with the exact same logical body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "accepted-turn", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask(
      [{ role: "user", content: [{ type: "input_text", text: "确认" }] }],
      {
        conversationId: "conv-kb",
        clientRequestId: "stable-request-id",
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        expectedPresentationKey: "presentation-5",
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(created).resolves.toMatchObject({ id: "accepted-turn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      conversationId: "conv-kb",
      clientRequestId: "stable-request-id",
      expectedGeneration: 2,
      expectedRevision: 5,
      expectedLeafId: "1.6",
      expectedPresentationKey: "presentation-5",
      userMessage: "确认",
    });
  });

  it("replays the exact legacy takeover manifest with the same request bytes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "legacy-turn", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const attachmentManifest = [
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 123,
        sha256: "a".repeat(64),
      },
    ];

    const created = createKnowledgeBaseTurnTask(
      [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: "replacement-file",
              filename: "facts.pdf",
            },
          ],
        },
      ],
      {
        conversationId: "conv-kb",
        clientRequestId: "legacy-request",
        expectedRevision: 5,
        expectedLeafId: "1.6",
        legacyAttachmentTakeover: { attachmentManifest },
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(created).resolves.toMatchObject({ id: "legacy-turn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      resumeLegacyAttachments: true,
      attachmentManifest,
    });
  });

  it.each([408, 425, 429, 503])(
    "retries transient HTTP %s turn responses",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status,
          headers: { get: () => "0" },
          json: async () => ({
            error: { code: "TRANSIENT", message: "请稍后重试" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            task: { id: `accepted-${status}`, status: "running" },
          }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const created = createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: `request-${status}`,
        expectedRevision: 5,
        expectedLeafId: "1.6",
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(created).resolves.toMatchObject({
        id: `accepted-${status}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].body).toBe(
        fetchMock.mock.calls[1][1].body,
      );
    },
  );

  it("replays repeated pending Logo responses with one stable request body", async () => {
    vi.useFakeTimers();
    const pendingResponse = () => ({
      ok: false,
      status: 425,
      headers: { get: () => "0" },
      json: async () => ({
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "Logo 任务仍在绑定",
        },
        observation: {
          stateEpoch: 2,
          generation: 1,
          activeTurn: { clientRequestId: "request-logo-replay" },
          interaction: {
            progress: null,
            interactionState: "executing",
            canReply: false,
            canPublish: false,
            lockReason: "Logo 正在处理中",
          },
        },
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "frontmind-logo-task", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-logo-replay",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      submissionKind: "logo",
    });
    await vi.advanceTimersByTimeAsync(500 + 1_000);

    await expect(created).resolves.toMatchObject({
      id: "frontmind-logo-task",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(fetchMock.mock.calls.map((call) => call[1].body))).toEqual(
      new Set([fetchMock.mock.calls[0][1].body]),
    );
  });

  it("sanitizes a knowledge-base rejection before exposing its message", async () => {
    const sourceBrand = ["Ma", "nus"].join("");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      headers: { get: () => null },
      json: async () => ({
        error: {
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message: `${sourceBrand} 拒绝了无效 Logo`,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-invalid-logo",
        submissionKind: "logo",
      }),
    ).rejects.toMatchObject({
      message: "FrontMind 拒绝了无效 Logo",
      status: 422,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for Retry-After before replaying the same turn request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "2" },
        json: async () => ({
          error: { code: "RATE_LIMITED", message: "请求过快" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "accepted-after-delay", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-with-retry-after",
      expectedRevision: 5,
      expectedLeafId: "1.6",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(created).resolves.toMatchObject({
      id: "accepted-after-delay",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops replaying a turn request after four transient responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({
        error: { code: "TEMPORARILY_UNAVAILABLE", message: "服务繁忙" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "bounded-request",
      expectedRevision: 5,
      expectedLeafId: "1.6",
    });
    const rejection = expect(created).rejects.toMatchObject({
      status: 503,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Set(fetchMock.mock.calls.map((call) => call[1].body))).toEqual(
      new Set([fetchMock.mock.calls[0][1].body]),
    );
  });

  it("reserves the logical turn before any file id exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reservation: {
          state: "awaiting_attachments",
          turnId: "turn-reserved",
          clientRequestId: "request-files",
          generation: 2,
          revision: 5,
          leafId: "1.6",
          stagedAttachmentCount: 0,
          expectedAttachmentCount: 1,
          requiresUpload: true,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = [
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];

    await reserveKnowledgeBaseTurnWithAttachments(
      [{ role: "user", content: [{ type: "input_text", text: "修订" }] }],
      {
        conversationId: "conv-kb",
        clientRequestId: "request-files",
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        expectedPresentationKey: "presentation-5",
        attachmentManifest: manifest,
      },
    );

    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge-base/turn/reserve");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      expectedGeneration: 2,
      expectedRevision: 5,
      expectedLeafId: "1.6",
      expectedPresentationKey: "presentation-5",
      userMessage: "修订",
      attachmentManifest: manifest,
      resumeExisting: false,
    });
  });

  it("stages one stable file id and dispatches without resending file ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task: { id: "task-next", status: "running" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = [
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];
    await stageKnowledgeBaseTurnAttachment({
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      attachmentManifest: manifest,
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    });
    await createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      attachmentReservation: {
        turnId: "turn-reserved",
        attachmentManifest: manifest,
      },
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/knowledge-base/turn/attachments/stage",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/knowledge-base/turn/dispatch",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      turnId: "turn-reserved",
      attachmentManifest: manifest,
    });
  });

  it("retries transient attachment staging failures with the exact same file id", async () => {
    vi.useFakeTimers();
    const transientFailures = [
      { status: 409, code: "IDEMPOTENCY_PENDING" },
      { status: 425, code: "TOO_EARLY" },
      { status: 429, code: "RATE_LIMITED" },
      { status: 503, code: "TEMPORARILY_UNAVAILABLE" },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      attachmentManifest: [
        {
          filename: "facts.pdf",
          sizeBytes: 12,
          mimeType: "application/pdf",
          lastModified: 10,
          sha256: "a".repeat(64),
        },
      ],
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    };

    for (const failure of transientFailures) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: failure.status,
          headers: { get: () => "0.25" },
          json: async () => ({
            error: { code: failure.code, message: "请稍后重试" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ reservation: { stagedAttachmentCount: 1 } }),
        });

      const staged = stageKnowledgeBaseTurnAttachment(input);
      await vi.advanceTimersByTimeAsync(500);
      await expect(staged).resolves.toMatchObject({
        reservation: { stagedAttachmentCount: 1 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map((call) => call[1].body);
      expect(new Set(requestBodies)).toEqual(new Set([JSON.stringify(input)]));
      expect(JSON.parse(requestBodies[0]).attachment.file_id).toBe(
        "file-facts",
      );
    }
  });

  it("retries a network staging failure without creating an unbounded loop", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reservation: { stagedAttachmentCount: 1 } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      attachmentManifest: [],
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    };

    const staged = stageKnowledgeBaseTurnAttachment(input);
    await vi.advanceTimersByTimeAsync(500);
    await expect(staged).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
  });

  it("stops attachment staging after four transient attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({
        error: { code: "TEMPORARILY_UNAVAILABLE", message: "服务繁忙" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const staged = stageKnowledgeBaseTurnAttachment({
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      attachmentManifest: [],
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    });
    const rejection = expect(staged).rejects.toMatchObject({
      status: 503,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fences a confirmation to the visible revision and leaf", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: "task-next", status: "running", output: [] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createKnowledgeBaseTurnTask(
      [{ role: "user", content: [{ type: "input_text", text: "确认" }] }],
      {
        conversationId: "conv-kb",
        clientRequestId: "request-confirm-1",
        expectedRevision: 45,
        expectedLeafId: "5.5",
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      conversationId: "conv-kb",
      clientRequestId: "request-confirm-1",
      userMessage: "确认",
      expectedRevision: 45,
      expectedLeafId: "5.5",
    });
  });

  it("marks a dedicated Logo submission and accepts only the returned upstream task id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: "manus-logo-task", status: "running" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createKnowledgeBaseTurnTask(
        [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                file_id: "file-logo",
                filename: "logo.png",
              },
            ],
          },
        ],
        {
          conversationId: "conv-kb",
          clientRequestId: "request-logo-1",
          expectedRevision: 1,
          expectedLeafId: "1.1",
          submissionKind: "logo",
        },
      ),
    ).resolves.toMatchObject({ id: "manus-logo-task" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      submissionKind: "logo",
      clientRequestId: "request-logo-1",
      attachments: [{ file_id: "file-logo", filename: "logo.png" }],
    });
  });

  it("rejects a successful response only when it has neither a task nor an authoritative observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ accepted: true }),
      }),
    );

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-logo-missing-task",
        submissionKind: "logo",
      }),
    ).rejects.toThrow("任务创建失败：未返回权威任务状态");
  });

  it("accepts a recovering Logo observation without inventing a task id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          accepted: true,
          observation: {
            stateEpoch: 4,
            generation: 1,
            authoritativeTaskId: null,
            activeTurn: {
              id: "logo-turn-pending-task-id",
              clientRequestId: "request-logo-pending-task-id",
            },
            interaction: {
              progress: null,
              interactionState: "executing",
              canReply: false,
              canPublish: false,
              lockReason: "Logo 正在处理中",
            },
            approvedPresentation: null,
            completedTurn: null,
            package: null,
            notice: null,
            conversationVersion: 4,
          },
        }),
      }),
    );

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-logo-pending-task-id",
        submissionKind: "logo",
      }),
    ).resolves.toMatchObject({
      id: "",
      status: "running",
      knowledgeObservation: {
        stateEpoch: 4,
        generation: 1,
        activeTurn: {
          id: "logo-turn-pending-task-id",
          clientRequestId: "request-logo-pending-task-id",
        },
      },
    });
  });

  it("accepts a complete terminal observation without a task pointer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        observation: {
          stateEpoch: 8,
          generation: 2,
          authoritativeTaskId: null,
          activeTurn: null,
          interaction: {
            progress: null,
            interactionState: "published",
            canReply: false,
            canPublish: false,
            lockReason: null,
          },
          approvedPresentation: null,
          package: null,
          notice: null,
          conversationVersion: 9,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createKnowledgeBaseTurnTask(
        [{ role: "user", content: [{ type: "input_text", text: "确认" }] }],
        {
          conversationId: "conv-terminal",
          clientRequestId: "request-terminal",
        },
      ),
    ).resolves.toMatchObject({
      id: "",
      knowledgeObservation: { stateEpoch: 8, generation: 2 },
    });
  });
});

describe("retrieveTask", () => {
  it("sends the selected customer project assignment in the delivery header", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn((key: string) =>
        key === DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY
          ? "project-assignment-1"
          : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "task-project",
        status: "completed",
        output: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await retrieveTask("task-project");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/tasks/task-project",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-delivery-project-assignment-id": "project-assignment-1",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "x-delivery-role-assignment-id",
    );
  });

  it("preserves a structured authorization error without trying the legacy endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: "当前账号无权访问该任务" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(retrieveTask("task-private")).rejects.toMatchObject({
      message: "当前账号无权访问该任务",
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/tasks/task-private",
      expect.any(Object),
    );
  });

  it("falls back to the legacy endpoint only when the task endpoint is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: "route not found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "task-legacy",
          status: "completed",
          output: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(retrieveTask("task-legacy")).resolves.toMatchObject({
      id: "task-legacy",
      status: "completed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/frontmind/v1/responses/task-legacy",
    );
  });
});

describe("uploadFile", () => {
  const uploadedAt = Date.parse("2026-08-04T00:00:00.000Z");
  const expiresAt = Date.parse("2026-09-03T00:00:00.000Z");

  const receipt = (
    fileId: string,
    sizeBytes: number,
    overrides: Partial<{
      fileId: string;
      sizeBytes: number;
      uploadedAt: number;
      expiresAt: number;
      replayed: boolean;
      recovered: boolean;
    }> = {},
  ) => ({
    fileId,
    sizeBytes,
    uploadedAt,
    expiresAt,
    replayed: false,
    recovered: false,
    ...overrides,
  });

  const stubFileRecord = (
    fileId: string,
    filename: string,
    uploadUrl = "https://uploads.example/signed?X-Amz-Signature=secret",
  ) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: fileId,
        filename,
        upload_url: uploadUrl,
        proxy_upload_ticket: `ticket:${fileId}`,
        proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("aborts a half-open upload only after a long no-progress watchdog", async () => {
    vi.useFakeTimers();
    class MockXMLHttpRequest {
      status = 0;
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {}
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const upload = uploadFileToUrl(
      "https://uploads.example/stalled",
      new File(["png"], "proof.png", { type: "image/png" }),
    );
    let settled = false;
    void upload.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(FILE_UPLOAD_STALL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(upload).rejects.toThrow("长时间没有进度");
  });

  it("keeps the signed URL out of a captured request and preserves both filenames", async () => {
    const signedUrl =
      "https://uploads.example/signed-unicode?X-Amz-Signature=unicode";
    const providerFilename = "供应商原名😀.pdf";
    const captureFilename = "知识库规范名.pdf";
    const fetchMock = stubFileRecord(
      "file-unicode",
      providerFilename,
      signedUrl,
    );
    const file = new File(["pdf"], providerFilename, {
      type: "application/pdf",
    });

    const headers = new Map<string, string>();
    let requestUrl = "";
    let requestBody: unknown;
    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();

      open(_method: string, url: string) {
        requestUrl = url;
      }
      setRequestHeader(name: string, value: string) {
        headers.set(name, value);
      }
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        requestBody = body;
        this.status = 200;
        this.responseText = JSON.stringify(receipt("file-unicode", file.size));
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        file,
        undefined,
        { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
        {
          captureLocalCopy: true,
          captureFilename,
          batchId: "kb-batch-123",
          batchOrdinal: 2,
          batchTotal: 5,
        },
      ),
    ).resolves.toMatchObject({
      fileId: "file-unicode",
      sizeBytes: file.size,
      uploadedAt,
      expiresAt,
    });

    expect(requestUrl).toBe(
      "/api/frontmind/proxy-upload?capture_file_id=file-unicode",
    );
    expect(requestUrl).not.toContain("target=");
    expect(requestUrl).not.toContain(signedUrl);
    expect(requestBody).toBe(file);
    expect(headers.get("X-FrontMind-Provider-Filename-UTF8")).toBe(
      encodeURIComponent(providerFilename),
    );
    expect(headers.get("X-FrontMind-Capture-Filename-UTF8")).toBe(
      encodeURIComponent(captureFilename),
    );
    expect(headers.get("X-FrontMind-Upload-Batch-Id")).toBe("kb-batch-123");
    expect(headers.get("X-FrontMind-Upload-Ordinal")).toBe("2");
    expect(headers.get("X-FrontMind-Upload-Total")).toBe("5");
    expect(headers.get("X-FrontMind-Upload-Ticket")).toBe(
      "ticket:file-unicode",
    );
    expect(headers.get("X-FrontMind-Capture-Filename-UTF8")).toMatch(
      /^[\x20-\x7e]+$/u,
    );
    expect(fetchMock.mock.calls[0][1].body).toBe(
      JSON.stringify({ filename: providerFilename }),
    );
  });

  it("keeps the original requested filename in recovery when the public record display name is sanitized", async () => {
    const providerFilename = `${["M", "a", "n", "u", "s"].join("")}-资料.pdf`;
    const displayFilename = "FrontMind-资料.pdf";
    const fileId = "file-brand-filename";
    const file = new File(["brand"], providerFilename, {
      type: "application/pdf",
    });
    const recoveryBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/frontmind/v1/files") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: fileId,
              filename: displayFilename,
              upload_url: "https://uploads.example/legacy",
              proxy_upload_ticket: "ticket-brand-filename",
              proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
            }),
          };
        }
        if (url.endsWith(`/${fileId}/upload-recovery`)) {
          recoveryBodies.push(JSON.parse(String(init?.body)));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              fileId,
              state: "uploaded",
              recreateRequired: false,
              receipt: receipt(fileId, file.size, { recovered: true }),
            }),
          };
        }
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    let sentBodies = 0;
    class MockXMLHttpRequest {
      status = 503;
      responseText = JSON.stringify({
        error: {
          code: "UPSTREAM_UPLOAD_UNAVAILABLE",
          message: "上游暂时不可用",
          retryable: true,
          recoveryAction: "retry_same_file",
          fileId,
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        sentBodies += 1;
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    let uploadHandle: ManagedUploadHandle | undefined;

    await expect(
      uploadFile(file, undefined, undefined, {
        onFileRecord: (event) => {
          uploadHandle = event.uploadHandle;
        },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UPLOAD_UNAVAILABLE" });
    expect(uploadHandle).toMatchObject({
      fileId,
      filename: providerFilename,
      ticket: "ticket-brand-filename",
    });

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: uploadHandle!,
      }),
    ).resolves.toMatchObject({ fileId, recovered: true });
    expect(recoveryBodies).toEqual([
      {
        filename: providerFilename,
        sizeBytes: file.size,
        mimeType: "application/pdf",
      },
    ]);
    expect(sentBodies).toBe(1);
  });

  it("sends only one captured browser body on 403 and preserves the server code", async () => {
    stubFileRecord("file-forbidden", "private.pdf");
    const sentBodies: unknown[] = [];
    class MockXMLHttpRequest {
      status = 403;
      statusText = "";
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_CAPTURE_FORBIDDEN",
          message: "上传文件不属于当前账号",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        sentBodies.push(body);
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const error = await uploadFile(
      new File(["private"], "private.pdf", { type: "application/pdf" }),
      undefined,
      { maxRetries: 9, initialDelay: 0, maxDelay: 0 },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "上传文件不属于当前账号",
      code: "UPLOAD_CAPTURE_FORBIDDEN",
      status: 403,
      fileId: "file-forbidden",
      retryable: false,
    });
    expect((error as Error).message).not.toContain("失效");
    expect(sentBodies).toHaveLength(1);
  });

  it.each([
    {
      status: 409,
      code: "UPLOAD_IN_PROGRESS",
      retryable: true,
    },
    {
      status: 503,
      code: "UPSTREAM_UPLOAD_UNAVAILABLE",
      retryable: false,
    },
  ])(
    "honors server retryable=$retryable for a $status captured response",
    async ({ status, code, retryable }) => {
      const fileId = `file-server-retryable-${status}`;
      stubFileRecord(fileId, "server-retryable.pdf");
      class MockXMLHttpRequest {
        status = 0;
        responseText = "";
        upload = { addEventListener: vi.fn() };
        private listeners = new Map<string, () => void>();
        open() {}
        setRequestHeader() {}
        addEventListener(event: string, listener: () => void) {
          this.listeners.set(event, listener);
        }
        send() {
          this.status = status;
          this.responseText = JSON.stringify({
            error: {
              code,
              message: "服务端上传状态需要由显式合同判断",
              retryable,
            },
          });
          queueMicrotask(() => this.listeners.get("load")?.());
        }
      }
      vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

      await expect(
        uploadFile(
          new File(["retry"], "server-retryable.pdf", {
            type: "application/pdf",
          }),
        ),
      ).rejects.toMatchObject({
        code,
        status,
        fileId,
        retryable,
      });
    },
  );

  it("cancels the active captured XHR through AbortSignal", async () => {
    stubFileRecord("file-cancel", "cancel.pdf");
    const controller = new AbortController();
    const sentBodies: unknown[] = [];
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        sentBodies.push(body);
        controller.abort();
      }
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const error = await uploadFile(
      new File(["cancel"], "cancel.pdf", { type: "application/pdf" }),
      undefined,
      undefined,
      { signal: controller.signal },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "UPLOAD_CANCELLED",
      fileId: "file-cancel",
      retryable: false,
      cancelled: true,
    });
    expect(sentBodies).toHaveLength(1);
  });

  it("reuses an existing file id without creating another provider record", async () => {
    const existingFileId = "opaque/file+existing";
    const existingHandle = {
      fileId: existingFileId,
      filename: " manual-retry.pdf ",
      ticket: "opaque-retry-ticket",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fileId: existingFileId,
        state: "ready",
        recreateRequired: false,
        traceId: "trace-recovery-ready",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["retry"], existingHandle.filename, {
      type: "application/pdf",
    });
    const requestUrls: string[] = [];
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open(_method: string, url: string) {
        requestUrls.push(url);
      }
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        this.status = 200;
        this.responseText = JSON.stringify(receipt(existingFileId, file.size));
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const onFileRecord = vi.fn();

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: existingHandle,
        onFileRecord,
      }),
    ).resolves.toMatchObject({ fileId: existingFileId, sizeBytes: file.size });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/frontmind/v1/files/${encodeURIComponent(existingFileId)}/upload-recovery`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-FrontMind-Upload-Ticket": existingHandle.ticket,
        }),
      }),
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      filename: existingHandle.filename,
      sizeBytes: file.size,
      mimeType: "application/pdf",
    });
    expect(requestUrls).toEqual([
      `/api/frontmind/proxy-upload?capture_file_id=${encodeURIComponent(existingFileId)}`,
    ]);
    expect(onFileRecord).toHaveBeenCalledWith({
      fileId: existingFileId,
      filename: existingHandle.filename,
      uploadHandle: existingHandle,
      reusedExistingFileId: true,
    });
  });

  it("recovers a confirmed receipt without sending another browser body", async () => {
    const file = new File(["already uploaded"], "recovered.pdf", {
      type: "application/pdf",
    });
    const handle = {
      fileId: "file-recovered",
      filename: file.name,
      ticket: "ticket-recovered",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fileId: handle.fileId,
        state: "uploaded",
        recreateRequired: false,
        traceId: "trace-recovered",
        receipt: receipt(handle.fileId, file.size, {
          recovered: true,
        }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const stages: string[] = [];

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: handle,
        onStage: (event) => stages.push(event.stage),
      }),
    ).resolves.toMatchObject({
      fileId: handle.fileId,
      recovered: true,
      traceId: "trace-recovered",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(xhrCount).toBe(0);
    expect(stages).toEqual(["creating_record", "recovering", "uploaded"]);
  });

  it("bounds managed recovery and keeps the action at check_status", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const recovery = recoverManagedUpload(
      { fileId: "file-timeout", ticket: "ticket-timeout" },
      new File(["timeout"], "timeout.pdf"),
    );
    const settled = recovery.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(MANAGED_UPLOAD_RECOVERY_TIMEOUT_MS);

    await expect(settled).resolves.toMatchObject({
      code: "UPLOAD_RECOVERY_UNAVAILABLE",
      recoveryAction: "check_status",
      retryable: true,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never discards when recreateRequired lacks the explicit discard action", async () => {
    const file = new File(["mismatch"], "mismatch.pdf", {
      type: "application/pdf",
    });
    const handle: ManagedUploadHandle = {
      fileId: "file-mismatched-directive",
      filename: file.name,
      ticket: "ticket-mismatched-directive",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestUrls.push(url);
      if (!url.endsWith("/upload-recovery")) {
        throw new Error(`unsafe follow-up request ${url}`);
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "UPLOAD_RECOVERY_UNVERIFIED",
            message: "恢复元数据互相矛盾",
            retryable: false,
            recoveryAction: "retry_same_file",
            recreateRequired: true,
            fileId: handle.fileId,
            traceId: "trace-mismatched-directive",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: handle,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_RECOVERY_UNVERIFIED",
      recoveryAction: "check_status",
      recreateRequired: false,
      fileId: handle.fileId,
      traceId: "trace-mismatched-directive",
    });
    expect(requestUrls).toEqual([
      `/api/frontmind/v1/files/${handle.fileId}/upload-recovery`,
    ]);
    expect(xhrCount).toBe(0);
  });

  it("keeps the expected id when a recovery error names another record", async () => {
    const expectedFileId = "file-expected-recovery";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "UPLOAD_CAPABILITY_EXPIRED_RECREATE_REQUIRED",
            message: "需要重建上传记录",
            retryable: false,
            recoveryAction: "discard_and_recreate",
            recreateRequired: true,
            fileId: "file-unrelated-recovery",
            traceId: "trace-wrong-recovery-id",
          },
        }),
      }),
    );

    await expect(
      recoverManagedUpload(
        { fileId: expectedFileId, ticket: "ticket-expected-recovery" },
        new File(["recovery"], "recovery-id.pdf"),
      ),
    ).rejects.toMatchObject({
      code: "UPLOAD_RECOVERY_INVALID",
      fileId: expectedFileId,
      retryable: true,
      recoveryAction: "check_status",
      recreateRequired: false,
      traceId: "trace-wrong-recovery-id",
    });
  });

  it.each([
    {
      label: "restage_required even with a valid ticket",
      state: "restage_required" as const,
      existingUploadHandle: {
        fileId: "file-restage-unverified",
        filename: "recovery-guard.pdf",
        ticket: "ticket-restage-unverified",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      },
      existingFileId: undefined,
      expectedCode: "UPLOAD_RECOVERY_UNVERIFIED",
    },
    {
      label: "ready without a ticket",
      state: "ready" as const,
      existingUploadHandle: undefined,
      existingFileId: "file-ready-ticketless",
      expectedCode: "UPLOAD_CAPABILITY_REQUIRED",
    },
    {
      label: "ready with an expired ticket",
      state: "ready" as const,
      existingUploadHandle: {
        fileId: "file-ready-expired",
        filename: "recovery-guard.pdf",
        ticket: "ticket-ready-expired",
        expiresAt: Date.parse("2020-01-01T00:00:00.000Z"),
      },
      existingFileId: undefined,
      expectedCode: "UPLOAD_CAPABILITY_EXPIRED",
    },
    {
      label: "ready with less than fifteen seconds left on its ticket",
      state: "ready" as const,
      existingUploadHandle: {
        fileId: "file-ready-near-expiry",
        filename: "recovery-guard.pdf",
        ticket: "ticket-ready-near-expiry",
        expiresAt: Date.now() + 5_000,
      },
      existingFileId: undefined,
      expectedCode: "UPLOAD_CAPABILITY_EXPIRED",
    },
  ])(
    "fails closed for $label without sending a browser body",
    async (input) => {
      const file = new File(["guard"], "recovery-guard.pdf", {
        type: "application/pdf",
      });
      const fileId =
        input.existingUploadHandle?.fileId || input.existingFileId || "";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            fileId,
            state: input.state,
            recreateRequired: false,
            traceId: "trace-recovery-guard",
          }),
        }),
      );
      let xhrCount = 0;
      class MockXMLHttpRequest {
        constructor() {
          xhrCount += 1;
        }
      }
      vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

      await expect(
        uploadFile(file, undefined, undefined, {
          ...(input.existingUploadHandle
            ? { existingUploadHandle: input.existingUploadHandle }
            : { existingFileId: input.existingFileId }),
        }),
      ).rejects.toMatchObject({
        code: input.expectedCode,
        recoveryAction: "check_status",
        recreateRequired: false,
        fileId,
        traceId: "trace-recovery-guard",
      });
      expect(xhrCount).toBe(0);
    },
  );

  it("reconciles, discards, and only then creates a replacement managed record", async () => {
    const file = new File(["replacement"], "replacement.pdf", {
      type: "application/pdf",
    });
    const oldHandle = {
      fileId: "file-old",
      filename: file.name,
      ticket: "ticket-old",
      expiresAt: Date.parse("2026-01-01T00:00:00.000Z"),
    };
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/file-old/upload-recovery")) {
        order.push("recover");
        return {
          ok: false,
          status: 410,
          json: async () => ({
            error: {
              code: "UPLOAD_CAPABILITY_EXPIRED",
              message: "上传凭证已过期",
              retryable: false,
              recoveryAction: "discard_and_recreate",
              recreateRequired: true,
              fileId: oldHandle.fileId,
              traceId: "trace-expired",
            },
          }),
        };
      }
      if (url.endsWith("/file-old/discard")) {
        order.push("discard");
        return { status: 204 };
      }
      if (url === "/api/frontmind/v1/files") {
        order.push("create");
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "file-new",
            filename: file.name,
            upload_url: "https://uploads.example/new",
            proxy_upload_ticket: "ticket-new",
            proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        order.push("xhr");
        this.status = 200;
        this.responseText = JSON.stringify(receipt("file-new", file.size));
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const onFileRecordDiscarded = vi.fn();
    const onFileRecord = vi.fn();

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: oldHandle,
        onFileRecordDiscarded,
        onFileRecord,
      }),
    ).resolves.toMatchObject({ fileId: "file-new" });

    expect(order).toEqual(["recover", "discard", "create", "xhr"]);
    expect(onFileRecordDiscarded).toHaveBeenCalledWith("file-old");
    expect(onFileRecord).toHaveBeenLastCalledWith({
      fileId: "file-new",
      filename: file.name,
      uploadHandle: expect.objectContaining({
        fileId: "file-new",
        ticket: "ticket-new",
      }),
      reusedExistingFileId: false,
    });
  });

  it("parses managed recovery action and trace id without retrying the body", async () => {
    stubFileRecord("file-traced", "traced.pdf");
    let sentBodies = 0;
    class MockXMLHttpRequest {
      status = 409;
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
          message: "文件身份不匹配",
          retryable: false,
          recoveryAction: "discard_and_recreate",
          recreateRequired: true,
          fileId: "file-traced",
          traceId: "trace-identity",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        sentBodies += 1;
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const stages: string[] = [];
    const progress: number[] = [];

    await expect(
      uploadFile(
        new File(["trace"], "traced.pdf"),
        (percent) => progress.push(percent),
        undefined,
        { onStage: (event) => stages.push(event.stage) },
      ),
    ).rejects.toMatchObject({
      code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
      recoveryAction: "discard_and_recreate",
      recreateRequired: true,
      traceId: "trace-identity",
    });
    expect(sentBodies).toBe(1);
    expect(progress).toEqual([0]);
    expect(stages).toEqual(["creating_record", "uploading"]);
  });

  it("keeps the expected file id and fails closed when an upload error names another record", async () => {
    const expectedFileId = "file-expected-error";
    stubFileRecord(expectedFileId, "identity-error.pdf");
    class MockXMLHttpRequest {
      status = 409;
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_CAPABILITY_EXPIRED_RECREATE_REQUIRED",
          message: "需要重建上传记录",
          retryable: false,
          recoveryAction: "discard_and_recreate",
          recreateRequired: true,
          fileId: "file-unrelated-error",
          traceId: "trace-wrong-error-id",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(new File(["identity"], "identity-error.pdf")),
    ).rejects.toMatchObject({
      code: "UPLOAD_RECOVERY_INVALID",
      fileId: expectedFileId,
      retryable: true,
      recoveryAction: "check_status",
      recreateRequired: false,
      traceId: "trace-wrong-error-id",
    });
  });

  it("returns the file id and sends no bytes when the record callback fails", async () => {
    stubFileRecord("file-callback", "callback.pdf");
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        new File(["callback"], "callback.pdf", { type: "application/pdf" }),
        undefined,
        undefined,
        {
          onFileRecord: async () => {
            throw new Error("local persistence unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "FILE_RECORD_CALLBACK_FAILED",
      fileId: "file-callback",
      retryable: true,
    });
    expect(xhrCount).toBe(0);
  });

  it("returns the created id and sends no bytes when a managed ticket is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "file-ticket-missing",
        filename: "missing-ticket.pdf",
        upload_url: "https://uploads.example/legacy-only",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const onFileRecord = vi.fn();

    await expect(
      uploadFile(
        new File(["missing"], "missing-ticket.pdf", {
          type: "application/pdf",
        }),
        undefined,
        undefined,
        { onFileRecord },
      ),
    ).rejects.toMatchObject({
      code: "FILE_RECORD_INVALID",
      fileId: "file-ticket-missing",
      recoveryAction: "retry_same_file",
    });
    expect(onFileRecord).not.toHaveBeenCalled();
    expect(xhrCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports ordered stages, numeric progress, and the validated receipt", async () => {
    stubFileRecord("file-progress", "progress.pdf");
    const file = new File(["abcdef"], "progress.pdf", {
      type: "application/pdf",
    });
    const lifecycleOrder: string[] = [];
    type Listener = (event?: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      private listeners = new Map<string, Listener>();
      private uploadListeners = new Map<string, Listener>();
      upload = {
        addEventListener: (event: string, listener: Listener) => {
          this.uploadListeners.set(event, listener);
        },
      };
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: Listener) {
        this.listeners.set(event, listener);
      }
      send() {
        lifecycleOrder.push("body");
        this.uploadListeners.get("progress")?.({
          lengthComputable: true,
          loaded: file.size / 2,
          total: file.size,
        });
        this.uploadListeners.get("load")?.();
        this.status = 200;
        this.responseText = JSON.stringify(
          receipt("file-progress", file.size, {
            replayed: true,
            recovered: true,
          }),
        );
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const progress: number[] = [];
    const stages: Array<{
      stage: string;
      fileId?: string;
      loadedBytes?: number;
      totalBytes?: number;
      receipt?: unknown;
    }> = [];
    const onFileRecord = vi.fn(() => lifecycleOrder.push("record"));

    const result = await uploadFile(
      file,
      (percent) => progress.push(percent),
      undefined,
      {
        onStage: (event) => stages.push(event),
        onFileRecord,
      },
    );

    expect(progress).toEqual([0, 50, 100]);
    expect(
      stages
        .map((event) => event.stage)
        .filter((stage, index, all) => index === 0 || stage !== all[index - 1]),
    ).toEqual([
      "creating_record",
      "uploading",
      "server_processing",
      "uploaded",
    ]);
    expect(stages[stages.length - 1]).toMatchObject({
      stage: "uploaded",
      fileId: "file-progress",
      loadedBytes: file.size,
      totalBytes: file.size,
      receipt: {
        fileId: "file-progress",
        sizeBytes: file.size,
        uploadedAt,
        expiresAt,
        replayed: true,
        recovered: true,
      },
    });
    expect(lifecycleOrder).toEqual(["record", "body"]);
    expect(result).toEqual({
      fileId: "file-progress",
      filename: "progress.pdf",
      sizeBytes: file.size,
      uploadedAt,
      expiresAt,
      replayed: true,
      recovered: true,
    });
  });

  it.each([
    {
      label: "file id",
      makeReceipt: (sizeBytes: number) => receipt("file-other", sizeBytes),
      code: "UPLOAD_RECEIPT_FILE_MISMATCH",
    },
    {
      label: "file size",
      makeReceipt: (sizeBytes: number) =>
        receipt("file-validation", sizeBytes, { sizeBytes: sizeBytes + 1 }),
      code: "UPLOAD_RECEIPT_INVALID",
    },
  ])(
    "rejects a receipt with the wrong $label",
    async ({ makeReceipt, code }) => {
      stubFileRecord("file-validation", "validation.pdf");
      const file = new File(["validate"], "validation.pdf", {
        type: "application/pdf",
      });
      class MockXMLHttpRequest {
        status = 0;
        responseText = "";
        upload = { addEventListener: vi.fn() };
        private listeners = new Map<string, () => void>();
        open() {}
        setRequestHeader() {}
        addEventListener(event: string, listener: () => void) {
          this.listeners.set(event, listener);
        }
        send() {
          this.status = 200;
          this.responseText = JSON.stringify(makeReceipt(file.size));
          queueMicrotask(() => this.listeners.get("load")?.());
        }
      }
      vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

      await expect(uploadFile(file)).rejects.toMatchObject({
        code,
        fileId: "file-validation",
        retryable: true,
      });
    },
  );

  it("rejects a file over 100 MB before creating an upstream record", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oversized = new File(["x"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: 100 * 1024 * 1024 + 1,
    });

    await expect(uploadFile(oversized)).rejects.toThrow(
      "文件“oversized.pdf”不能超过 100 MB",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy direct-to-generic-proxy retry path for non-captured uploads", async () => {
    const signedUrl =
      "https://uploads.example/legacy?X-Amz-Signature=legacy-secret";
    const fetchMock = stubFileRecord("file-legacy", "legacy.pdf", signedUrl);
    const requests: Array<{ url: string; body: unknown }> = [];
    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private url = "";
      private listeners = new Map<string, () => void>();

      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        requests.push({ url: this.url, body });
        if (requests.length === 1) {
          queueMicrotask(() => this.listeners.get("error")?.());
          return;
        }
        this.status = requests.length === 2 ? 503 : 204;
        if (this.status === 503) {
          this.responseText = JSON.stringify({
            error: {
              code: "UPLOAD_PROXY_UNAVAILABLE",
              message: "上传服务暂时不可用",
            },
          });
        }
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const file = new File(["legacy"], "legacy.pdf", {
      type: "application/pdf",
    });

    await expect(
      uploadFile(
        file,
        undefined,
        { maxRetries: 1, initialDelay: 0, maxDelay: 0 },
        { captureLocalCopy: false },
      ),
    ).resolves.toEqual({ fileId: "file-legacy", filename: "legacy.pdf" });

    const genericProxyUrl = `/api/frontmind/proxy-upload?target=${encodeURIComponent(signedUrl)}`;
    expect(requests.map((request) => request.url)).toEqual([
      signedUrl,
      genericProxyUrl,
      genericProxyUrl,
    ]);
    expect(requests.every((request) => request.body === file)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards an explicitly removed unbound upload through the authorized route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discardUnboundUpload(" file/unused "),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files/%20file%2Funused%20/discard",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
      }),
    );
  });

  it("preserves a structured conflict when a discard target is already bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        error: {
          code: "UPLOAD_ALREADY_BOUND",
          message: "文件已经绑定到任务",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const opaqueFileId = " file-bound ";
    await expect(discardUnboundUpload(opaqueFileId)).rejects.toMatchObject({
      message: "文件已经绑定到任务",
      code: "UPLOAD_ALREADY_BOUND",
      status: 409,
      fileId: opaqueFileId,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files/%20file-bound%20/discard",
      expect.any(Object),
    );
  });
});
