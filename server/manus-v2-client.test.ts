import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendManusV2KnowledgeBaseOperationContract,
  buildManusV2KnowledgeBaseStructuredOutputSchema,
  buildManusV2MessageContent,
  classifyManusV2StructuredResultEnvelope,
  latestManusV2WaitingDetail,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventsContainOperationToken,
  normalizeManusV2Output,
} from "./manus-v2-client";

afterEach(() => vi.restoreAllMocks());

describe("ManusV2Client", () => {
  const operationContract = {
    operationToken: "op-1",
    turnId: "turn-1",
    generation: 2,
    baseRevision: 7,
    action: "confirm" as const,
    fromLeafId: "leaf-7",
    expectContentCompleted: false,
    requiresManifest: false,
  };

  it("creates once and sends every continuation to the same task", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post");
    post
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          request_id: "req-create",
          task_id: "task-canonical",
          task_title: "FrontMind KB build-1 g1",
          task_url: "https://manus.im/app/task-canonical",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          request_id: "req-send",
          task_id: "task-canonical",
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const structuredOutputSchema =
      buildManusV2KnowledgeBaseStructuredOutputSchema(operationContract);

    const created = await client.createTask({
      prompt: "start operation-token-1",
      title: "FrontMind KB build-1 g1",
      attachments: [{ file_id: "file-1", filename: "facts.pdf" }],
      structuredOutputSchema,
    });
    const sent = await client.sendMessage({
      taskId: created.taskId,
      prompt: "confirm operation-token-2",
      structuredOutputSchema,
    });

    expect(sent.taskId).toBe("task-canonical");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v2/task.create",
    );
    expect(post.mock.calls[1]?.[0]).toBe(
      "https://api.example.test/v2/task.sendMessage",
    );
    expect(post.mock.calls[1]?.[1]).toMatchObject({
      task_id: "task-canonical",
      structured_output_schema: structuredOutputSchema,
    });
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      structured_output_schema: structuredOutputSchema,
    });
    expect(post.mock.calls[0]?.[2]?.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("rejects a send acknowledgement that changes canonical task identity", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: { ok: true, task_id: "different-task" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.sendMessage({ taskId: "canonical-task", prompt: "continue" }),
    ).rejects.toMatchObject({ code: "TASK_ID_CONFLICT" });
  });

  it("confirms the exact pending event on the canonical task", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        request_id: "req-confirm",
        task_id: "canonical-task",
        confirmed: true,
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.confirmAction({
        taskId: "canonical-task",
        eventId: "evt-1",
        confirmationInput: { accept: true },
      }),
    ).resolves.toMatchObject({
      taskId: "canonical-task",
      eventId: "evt-1",
    });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v2/task.confirmAction",
      {
        task_id: "canonical-task",
        event_id: "evt-1",
        input: { accept: true },
      },
      { headers: { "Content-Type": "application/json" } },
    );
  });

  it.each([
    ["has no task identity", { ok: true, confirmed: true }],
    [
      "changes canonical task identity",
      { ok: true, task_id: "other-task", confirmed: true },
    ],
    [
      "does not acknowledge confirmation",
      { ok: true, task_id: "canonical-task", confirmed: false },
    ],
  ])(
    "treats a task.confirmAction 2xx response that %s as outcome unknown",
    async (_label, data) => {
      vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
        status: 200,
        data,
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      await expect(
        client.confirmAction({
          taskId: "canonical-task",
          eventId: "evt-1",
          confirmationInput: { accept: true },
        }),
      ).rejects.toMatchObject({
        outcomeUnknown: true,
        retryable: false,
      });
    },
  );

  it("extracts only the newest waiting event and its confirmation schema", () => {
    expect(
      latestManusV2WaitingDetail([
        {
          id: "old",
          type: "status_update",
          timestamp: 1,
          status_update: {
            agent_status: "waiting",
            status_detail: {
              waiting_for_event_id: "evt-old",
              waiting_for_event_type: "messageAskUser",
            },
          },
        },
        {
          id: "new",
          type: "status_update",
          timestamp: 2,
          status_update: {
            agent_status: "waiting",
            status_detail: {
              waiting_for_event_id: "evt-new",
              waiting_for_event_type: "mapreduceAction",
              confirm_input_schema: {
                type: "object",
                properties: { accept: { type: "boolean" } },
              },
            },
          },
        },
      ]),
    ).toMatchObject({
      eventId: "evt-new",
      eventType: "mapreduceAction",
      statusEventId: "new",
    });
  });

  it("marks side-effect transport loss unknown and never labels it retryable", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockRejectedValue(
      new Error("socket reset"),
    );
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const error = await client
      .createTask({ prompt: "start", title: "unique title" })
      .catch((value) => value);
    expect(error).toBeInstanceOf(ManusV2ApiError);
    expect(error).toMatchObject({
      code: "TRANSPORT_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it.each([
    ["an empty 2xx body", undefined],
    ["a malformed 2xx body", "not-an-object"],
    ["a 2xx body without task identity", { ok: true }],
  ])("treats task.create %s as outcome unknown", async (_label, data) => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data,
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("treats a task.sendMessage 2xx body without task identity as outcome unknown", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: { ok: true, request_id: "req-send" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.sendMessage({ taskId: "canonical-task", prompt: "continue" }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("treats a non-explicit side-effect error response as outcome unknown", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 503,
      data: { code: "TEMPORARY" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "TEMPORARY",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("keeps an explicit provider rejection distinct from outcome unknown", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 422,
      data: { ok: false, code: "INVALID_INPUT" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      outcomeUnknown: false,
      retryable: false,
    });
  });

  it("captures only allowlisted request and validation coordinates from an explicit rejection", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 400,
      headers: { "x-request-id": "req-create-400:01" },
      data: {
        ok: false,
        error: {
          code: "invalid_argument",
          field: "agent_profile",
          path: "request.agent_profile[0]",
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      outcomeUnknown: false,
      providerRequestId: "req-create-400:01",
      providerField: "agent_profile",
      providerPath: "agent_profile",
    });
  });

  it("drops malformed provider diagnostics instead of retaining response text", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 400,
      headers: { "x-request-id": "request id with unsafe text" },
      data: {
        ok: false,
        request_id: "../../unsafe request id",
        error: {
          code: "invalid_argument",
          field: "sk-proj-secret",
          path: "secret.token",
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      outcomeUnknown: false,
      providerRequestId: null,
      providerField: null,
      providerPath: null,
    });
  });

  it("uses Retry-After only when Manus explicitly rejected the request and supplied it", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post");
    post
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "7" },
        data: { ok: false, code: "RATE_LIMITED" },
      })
      .mockResolvedValueOnce({
        status: 503,
        headers: { "retry-after": "7" },
        data: { code: "AMBIGUOUS" },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      outcomeUnknown: false,
      retryable: true,
      retryAfterMs: 7_000,
    });

    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      outcomeUnknown: true,
      retryAfterMs: null,
    });
  });

  it("paginates and deduplicates event ids while preserving chronological output", async () => {
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "e2",
              type: "assistant_message",
              timestamp: 20,
              assistant_message: { content: "second" },
            },
            {
              id: "e1",
              type: "user_message",
              timestamp: 10,
              user_message: {
                content:
                  'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"operation-token-1"}',
              },
            },
          ],
          has_more: true,
          next_cursor: "page-2",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "e2",
              type: "assistant_message",
              timestamp: 20,
              assistant_message: { content: "second" },
            },
            {
              id: "e3",
              type: "status_update",
              timestamp: 30,
              status_update: { agent_status: "stopped" },
            },
          ],
          has_more: false,
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const events = await client.listAllMessages({
      taskId: "canonical-task",
      order: "asc",
    });

    expect(events.map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
    expect(
      manusV2EventsContainOperationToken(events, "operation-token-1"),
    ).toBe(true);
    expect(latestManusV2TaskState(events)).toBe("stopped");
    expect(normalizeManusV2Output(events)).toMatchObject([
      { id: "e2", role: "assistant", text: "second" },
    ]);
    expect(get.mock.calls[1]?.[1]?.params).toMatchObject({ cursor: "page-2" });
  });

  it("reconciles unknown create only when title and operation token identify one task", async () => {
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          data: [
            {
              id: "candidate-one",
              title: "unique title",
              created_at: 100,
              task_url: "https://manus.im/app/candidate-one",
            },
            {
              id: "candidate-two",
              title: "unique title",
              created_at: 101,
            },
          ],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "candidate-one",
          messages: [
            {
              id: "first-user",
              type: "user_message",
              timestamp: 1,
              user_message: {
                content:
                  'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"operation-token-1"}',
              },
            },
          ],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "candidate-two",
          messages: [
            {
              id: "other-user",
              type: "user_message",
              timestamp: 1,
              user_message: { content: "other operation" },
            },
          ],
          has_more: false,
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const result = await client.findCreatedTask({
      title: "unique title",
      operationToken: "operation-token-1",
      createdAfterSeconds: 90,
      createdBeforeSeconds: 110,
    });
    expect(result.unique?.id).toBe("candidate-one");
    expect(result.candidates).toHaveLength(2);
  });

  it("matches operation tokens as exact contract values, never substrings", () => {
    const event = {
      id: "u1",
      type: "user_message",
      timestamp: 1,
      user_message: {
        content:
          'prefix operation-token-1-suffix\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"operation-token-10"}',
      },
    };
    expect(
      manusV2EventsContainOperationToken([event], "operation-token-1"),
    ).toBe(false);
    expect(
      manusV2EventsContainOperationToken([event], "operation-token-10"),
    ).toBe(true);
  });

  it.each([
    [
      "missing file identity",
      {
        ok: true,
        file: { filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: 2_000_000_000,
      },
    ],
    [
      "missing upload URL",
      {
        ok: true,
        file: { id: "file-1", filename: "facts.pdf" },
        upload_expires_at: 2_000_000_000,
      },
    ],
  ])("treats file.upload 2xx %s as outcome unknown", async (_label, data) => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data,
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(client.createFile("facts.pdf")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("accepts a file only after exact uploaded bytes and sufficient lifetime", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-1", filename: "facts.pdf", created_at: now },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-1",
            filename: "facts.pdf",
            status: "pending",
            bytes: null,
            expires_at: now + 48 * 3600,
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-1",
            filename: "facts.pdf",
            status: "uploaded",
            bytes: 3,
            expires_at: now + 48 * 3600,
          },
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const result = await client.uploadFile({
      filename: "facts.pdf",
      bytes: Buffer.from("abc"),
      contentType: "application/pdf",
      sleep: async () => undefined,
    });
    expect(result.detail).toMatchObject({
      fileId: "file-1",
      status: "uploaded",
      bytes: 3,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty(
      "x-manus-api-key",
    );
  });

  it("awaits durable candidate and PUT boundaries before advancing", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-journaled", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const order: string[] = [];
    vi.spyOn(axios, "put").mockImplementation(async () => {
      order.push("put");
      return { status: 200 } as any;
    });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-journaled",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          expires_at: now + 48 * 3600,
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await client.uploadFile({
      filename: "facts.pdf",
      bytes: Buffer.from("abc"),
      contentType: "application/pdf",
      observer: {
        onCandidateCreated: async () => {
          order.push("candidate");
        },
        onPutStarted: async () => {
          order.push("put_sending");
        },
        onPutAccepted: async () => {
          order.push("put_accepted");
        },
      },
    });
    expect(order).toEqual(["candidate", "put_sending", "put", "put_accepted"]);
  });

  it("records PUT response loss against the known candidate", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-ambiguous", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    vi.spyOn(axios, "put").mockRejectedValue(new Error("socket closed"));
    const unknown = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        observer: { onPutOutcomeUnknown: unknown },
      }),
    ).rejects.toMatchObject({
      operation: "file.upload.content",
      outcomeUnknown: true,
    });
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-ambiguous" }),
    );
  });

  it("retries explicit PUT throttles on the same signed URL and honors Retry-After", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-throttled", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi
      .spyOn(axios, "put")
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "0" },
      })
      .mockResolvedValueOnce({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-throttled",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          expires_at: now + 48 * 3600,
        },
      },
    });
    const retryWait = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        sleep,
        observer: { onPutRetryWait: retryWait },
      }),
    ).resolves.toMatchObject({ fileId: "file-throttled" });
    expect(put).toHaveBeenCalledTimes(2);
    expect(retryWait).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-throttled" }),
      expect.objectContaining({
        status: 429,
        retryAfterMs: 0,
        rejectionCount: 1,
      }),
    );
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("does not retry a PUT response loss", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-unknown-once", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi
      .spyOn(axios, "put")
      .mockRejectedValue(new Error("response lost"));
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(put).toHaveBeenCalledOnce();
  });

  it("resumes a known candidate by detail without POST or PUT", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post");
    const put = vi.spyOn(axios, "put");
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-existing",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          expires_at: now + 48 * 3600,
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        existingCandidate: {
          fileId: "file-existing",
          filename: "facts.pdf",
        },
      }),
    ).resolves.toMatchObject({
      fileId: "file-existing",
      detail: { status: "uploaded", bytes: 3 },
    });
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("resumes the first PUT for a durable candidate with rejection count zero", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post");
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-before-first-put",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          expires_at: now + 48 * 3600,
        },
      },
    });
    const putStarted = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        existingCandidate: {
          fileId: "file-before-first-put",
          filename: "facts.pdf",
          uploadUrl: "https://uploads.example.test/signed-first-put",
          uploadExpiresAt: now + 180,
          resumePutRejectionCount: 0,
        },
        observer: { onPutStarted: putStarted },
      }),
    ).resolves.toMatchObject({ fileId: "file-before-first-put" });

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(putStarted).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing file", { ok: true }],
    [
      "wrong id",
      {
        ok: true,
        file: {
          id: "other-file",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          expires_at: 2_000_000_000,
        },
      },
    ],
    [
      "invalid bytes",
      {
        ok: true,
        file: {
          id: "file-existing",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: "not-a-number",
          expires_at: 2_000_000_000,
        },
      },
    ],
  ])(
    "treats file.detail %s as ambiguous, never as replacement proof",
    async (_label, data) => {
      vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
        status: 200,
        data,
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      await expect(client.fileDetail("file-existing")).rejects.toMatchObject({
        outcomeUnknown: true,
        retryable: false,
      });
    },
  );

  it("builds v2 multipart content with text first and file ids", () => {
    expect(
      buildManusV2MessageContent("prompt", [
        { file_id: "f1", filename: "a.pdf" },
      ]),
    ).toEqual([
      { type: "text", text: "prompt" },
      { type: "file", file_id: "f1", filename: "a.pdf" },
    ]);
  });

  it("builds the documented inline file_data part and rejects malformed base64", () => {
    const encoded = Buffer.from("pinned system Skill bytes").toString("base64");
    expect(
      buildManusV2MessageContent("full business prompt", [
        {
          file_data: `data:application/zip;base64,${encoded}`,
          filename: "socratic-kb-builder.skill.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([
      { type: "text", text: "full business prompt" },
      {
        type: "file",
        file_data: `data:application/zip;base64,${encoded}`,
        filename: "socratic-kb-builder.skill.zip",
        mime_type: "application/zip",
      },
    ]);
    expect(() =>
      buildManusV2MessageContent("prompt", [
        {
          file_data: "data:application/zip;base64,***",
          filename: "broken.skill.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toThrow(/inline attachment/u);
  });

  it.each([
    ["unbound task.create", "create"],
    ["bound task.sendMessage", "send"],
  ] as const)(
    "dispatches the rejected-system-file inline fallback once through %s with the full snapshot prompt",
    async (_label, method) => {
      const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
        status: 200,
        data: {
          ok: true,
          request_id: `request-${method}`,
          task_id: "canonical-task",
          ...(method === "create"
            ? { task_url: "https://manus.im/app/canonical-task" }
            : {}),
        },
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      const snapshotPrompt = [
        "# FrontMind local canonical rehydrate",
        "snapshotSha256=" + "a".repeat(64),
        '{"revision":41,"leafId":"industry-cases"}',
        "Confirm the current node and continue.",
      ].join("\n");
      const attachment = {
        file_data: `data:application/zip;base64,${Buffer.from("pinned system Skill bytes").toString("base64")}`,
        filename: "socratic-kb-builder.skill.zip",
        mime_type: "application/zip",
      } as const;

      if (method === "create") {
        await client.createTask({
          prompt: snapshotPrompt,
          title: "FrontMind KB build g1",
          attachments: [attachment],
        });
      } else {
        await client.sendMessage({
          taskId: "canonical-task",
          prompt: snapshotPrompt,
          attachments: [attachment],
        });
      }

      expect(post).toHaveBeenCalledOnce();
      expect(post.mock.calls[0]?.[0]).toBe(
        method === "create"
          ? "https://api.example.test/v2/task.create"
          : "https://api.example.test/v2/task.sendMessage",
      );
      expect(post.mock.calls[0]?.[1]).toMatchObject({
        message: {
          content: [
            { type: "text", text: snapshotPrompt },
            {
              type: "file",
              file_data: attachment.file_data,
              filename: attachment.filename,
              mime_type: attachment.mime_type,
            },
          ],
        },
      });
    },
  );

  it("pins every structured-result coordinate in the schema and in-band prompt", () => {
    const schema = buildManusV2KnowledgeBaseStructuredOutputSchema(
      operationContract,
    ) as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).not.toContain("manifestJson");
    expect(schema.properties).toMatchObject({
      operationToken: { enum: ["op-1"] },
      turnId: { enum: ["turn-1"] },
      generation: { enum: [2] },
      baseRevision: { enum: [7] },
      action: { enum: ["confirm"] },
      fromLeafId: { enum: ["leaf-7"] },
      contentCompleted: { enum: [false] },
    });
    expect(
      appendManusV2KnowledgeBaseOperationContract(
        "business",
        operationContract,
      ),
    ).toContain('"operationToken":"op-1"');
  });

  it("requires a manifest only for initial tree creation", () => {
    const schema = buildManusV2KnowledgeBaseStructuredOutputSchema({
      ...operationContract,
      action: "start",
      fromLeafId: null,
      baseRevision: 0,
      requiresManifest: true,
    }) as any;
    expect(schema.required).toContain("manifestJson");
    expect(schema.properties.manifestJson).toEqual({ type: "string" });
  });

  it("accepts core content without requiring a model-supplied protocol payload", () => {
    const output = normalizeManusV2Output(
      [
        {
          id: "user-old",
          type: "user_message",
          timestamp: 1,
          user_message: {
            content:
              'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"op-old"}',
          },
        },
        {
          id: "old-result",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: true,
            value: {
              schemaVersion: 1,
              operationToken: "op-old",
              turnId: "turn-old",
              generation: 2,
              baseRevision: 6,
              action: "confirm",
              fromLeafId: "leaf-6",
              nextLeafId: "leaf-7",
              visibleMarkdown: "old body",
              contentCompleted: false,
            },
          },
        },
        {
          id: "user-new",
          type: "user_message",
          timestamp: 3,
          user_message: {
            content:
              'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"op-1"}',
          },
        },
        {
          id: "new-result",
          type: "structured_output_result",
          timestamp: 4,
          structured_output_result: {
            success: true,
            value: JSON.stringify({
              schemaVersion: 1,
              operationToken: "op-1",
              turnId: "turn-1",
              generation: 2,
              baseRevision: 7,
              action: "confirm",
              fromLeafId: "leaf-7",
              nextLeafId: "leaf-8",
              visibleMarkdown: "new body",
              contentCompleted: false,
            }),
          },
        },
      ],
      operationContract,
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      id: "new-result",
      text: "new body",
      structuredOutput: true,
    });
  });

  it("never accepts a provider-declared extraction failure's schema-shaped zero value", () => {
    const zeroValue = {
      schemaVersion: 1,
      operationToken: "op-1",
      turnId: "turn-1",
      generation: 2,
      baseRevision: 7,
      action: "confirm",
      fromLeafId: "leaf-7",
      nextLeafId: "",
      visibleMarkdown: "",
      contentCompleted: false,
    };
    const envelope = {
      error: "Failed to extract structured output",
      value: zeroValue,
    };
    expect(classifyManusV2StructuredResultEnvelope(envelope)).toEqual({
      kind: "rejected",
      code: "STRUCTURED_OUTPUT_REJECTED",
    });
    expect(
      normalizeManusV2Output(
        [
          {
            id: "failed-extraction",
            type: "structured_output_result",
            timestamp: 10,
            structured_output_result: envelope,
          },
        ],
        operationContract,
      ),
    ).toEqual([]);
  });

  it("rejects a contradictory nonempty error even when success is true", () => {
    expect(
      classifyManusV2StructuredResultEnvelope({
        success: true,
        error: "provider reported an extraction error",
        value: { visibleMarkdown: "must not be accepted" },
      }),
    ).toMatchObject({ kind: "rejected" });
  });

  it("accepts only an explicit successful envelope with no provider error", () => {
    expect(
      classifyManusV2StructuredResultEnvelope({
        success: true,
        error: "   ",
        value: { visibleMarkdown: "accepted" },
      }),
    ).toEqual({
      kind: "accepted",
      value: { visibleMarkdown: "accepted" },
    });
    expect(
      classifyManusV2StructuredResultEnvelope({
        error: null,
        value: { visibleMarkdown: "missing success" },
      }),
    ).toMatchObject({ kind: "rejected" });
  });

  it("rejects a structured result that reuses the token with stale coordinates", () => {
    expect(() =>
      normalizeManusV2Output(
        [
          {
            id: "stale",
            type: "structured_output_result",
            timestamp: 5,
            structured_output_result: {
              success: true,
              value: {
                schemaVersion: 1,
                operationToken: "op-1",
                turnId: "turn-1",
                generation: 1,
                baseRevision: 7,
                action: "confirm",
                fromLeafId: "leaf-7",
                nextLeafId: "leaf-8",
                visibleMarkdown: "stale body",
                contentCompleted: false,
              },
            },
          },
        ],
        operationContract,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "OPERATION_COORDINATE_CONFLICT" }),
    );
  });
});
