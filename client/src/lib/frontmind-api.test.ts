import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResponseLogicTask,
  retrieveTask,
  sanitizeBrandText,
  uploadFile,
} from "./frontmind-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeBrandText", () => {
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

describe("retrieveTask", () => {
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
  it("creates one file record and reuses its URL across transient PUT retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "file-one",
        filename: "report.pdf",
        upload_url: "https://uploads.example/signed-one",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const requests: Array<{ method: string; url: string }> = [];
    const outcomes = ["error", "error", "load"] as const;
    let nextOutcome = 0;

    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private method = "";
      private url = "";
      private listeners = new Map<string, () => void>();

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      setRequestHeader() {}

      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }

      send() {
        requests.push({ method: this.method, url: this.url });
        const outcome = outcomes[nextOutcome++];
        if (outcome === "load") this.status = 200;
        queueMicrotask(() => this.listeners.get(outcome)?.());
      }
    }

    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        new File(["pdf"], "report.pdf", { type: "application/pdf" }),
        undefined,
        {
          maxRetries: 1,
          initialDelay: 0,
          maxDelay: 0,
        },
      ),
    ).resolves.toEqual({
      fileId: "file-one",
      filename: "report.pdf",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requests).toEqual([
      { method: "PUT", url: "https://uploads.example/signed-one" },
      {
        method: "PUT",
        url: "/api/frontmind/proxy-upload?target=https%3A%2F%2Fuploads.example%2Fsigned-one",
      },
      {
        method: "PUT",
        url: "/api/frontmind/proxy-upload?target=https%3A%2F%2Fuploads.example%2Fsigned-one",
      },
    ]);
  });
});
