import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponseLogicTask, sanitizeBrandText } from "./frontmind-api";

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
