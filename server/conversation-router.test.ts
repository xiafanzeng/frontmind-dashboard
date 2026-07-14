import { describe, expect, it } from "vitest";
import {
  collectSnapshotResourceRefs,
  mergeConversationMessages,
  validateUpstreamResourceAccess,
  type ConversationSnapshot,
} from "./conversation-router";

type SnapshotMessage = ConversationSnapshot["messages"][number];

function message(
  id: string,
  role: SnapshotMessage["role"],
  timestamp: number,
  content = id,
): SnapshotMessage {
  return { id, role, timestamp, content };
}

describe("conversation multi-device merge", () => {
  it("retains independent turns created on two devices", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("assistant-a", "assistant", 110),
    ];
    const incoming = [
      message("user-b", "user", 105),
      message("assistant-b", "assistant", 115),
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map(item => item.id),
    ).toEqual(["user-a", "assistant-a", "user-b", "assistant-b"]);
  });

  it("replaces the assistant projection for a known turn", () => {
    const persisted = [
      message("user-a", "user", 100),
      { ...message("placeholder", "assistant", 110), isStepsPlaceholder: true },
    ];
    const incoming = [
      message("user-a", "user", 100),
      message("final", "assistant", 120, "完成"),
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map(item => item.id),
    ).toEqual(["user-a", "final"]);
  });

  it("does not regress a final projection from a stale device placeholder", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("final", "assistant", 120, "完整结果"),
    ];
    const incoming = [
      message("user-a", "user", 100),
      { ...message("placeholder", "assistant", 110), isStepsPlaceholder: true },
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map(item => item.id),
    ).toEqual(["user-a", "final"]);
  });

  it("applies deletion tombstones after merging", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("assistant-a", "assistant", 110),
    ];

    expect(
      mergeConversationMessages(persisted, [], ["assistant-a"]).map(
        item => item.id,
      ),
    ).toEqual(["user-a"]);
  });
});

describe("legacy upstream resource ownership validation", () => {
  it("deduplicates task and file IDs before upstream validation", () => {
    const snapshot: ConversationSnapshot = {
      id: "conversation-1",
      title: "Legacy",
      status: "completed",
      taskId: "task-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          ...message("user-1", "user", 1),
          attachments: [
            { id: "a", type: "file", name: "a.txt", fileId: "file-1" },
            { id: "b", type: "file", name: "b.txt", fileId: "file-1" },
          ],
        },
      ],
    };

    expect(collectSnapshotResourceRefs([snapshot])).toEqual([
      { kind: "task", id: "task-1" },
      { kind: "file", id: "file-1" },
    ]);
  });

  it("caps the number of legacy resources validated in one request", () => {
    const snapshot: ConversationSnapshot = {
      id: "conversation-many-files",
      title: "Legacy",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          ...message("user-many", "user", 1),
          attachments: Array.from({ length: 201 }, (_, index) => ({
            id: `attachment-${index}`,
            type: "file" as const,
            name: `${index}.txt`,
            fileId: `file-${index}`,
          })),
        },
      ],
    };

    expect(() => collectSnapshotResourceRefs([snapshot])).toThrow(
      "单次最多迁移 200 个历史任务或文件",
    );
  });

  it("uses the selected credential against the exact encoded resource URL", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    await validateUpstreamResourceAccess(
      "sk-owner",
      "file",
      "file/with spaces",
      async (input, init) => {
        requestedUrl = String(input);
        requestedHeaders = init?.headers;
        return new Response(null, { status: 200 });
      },
    );

    expect(requestedUrl).toContain("/v1/files/file%2Fwith%20spaces");
    expect(requestedHeaders).toMatchObject({
      API_KEY: "sk-owner",
      Authorization: "Bearer sk-owner",
    });
  });

  it.each([401, 403, 404])(
    "rejects an unprovable resource when upstream returns %s",
    async status => {
      await expect(
        validateUpstreamResourceAccess(
          "sk-wrong",
          "task",
          "task-victim",
          async () => new Response(null, { status }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("does not bind resources when upstream validation is unavailable", async () => {
    await expect(
      validateUpstreamResourceAccess(
        "sk-owner",
        "task",
        "task-1",
        async () => {
          throw new Error("timeout");
        },
      ),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
