import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  apiCredentials,
  conversations,
  upstreamResources,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import {
  collectSnapshotResourceRefs,
  getActiveCredentialId,
  mergeConversationMessages,
  mergeConversationTaskPointers,
  permanentlyDeleteConversation,
  repairSnapshotMessageIds,
  resolveSnapshotCredentialId,
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

function createSelectExecutor(rowsForTable: (table: unknown) => unknown[]) {
  const selectedTables: unknown[] = [];
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      selectedTables.push(table);
      const rows = rowsForTable(table);
      const query: {
        where: () => typeof query;
        orderBy: () => typeof query;
        limit: () => Promise<unknown[]>;
        then: Promise<unknown[]>["then"];
      } = {
        where: () => query,
        orderBy: () => query,
        limit: async () => rows,
        then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
      };
      return query;
    },
  }));
  return { executor: { select }, selectedTables };
}

describe("conversation multi-device merge", () => {
  it("repairs a provider assistant ID reused across two confirmed turns", () => {
    const repaired = repairSnapshotMessageIds([
      message("confirm-1", "user", 100, "确认"),
      message("provider-output", "assistant", 110, "节点 2.3"),
      message("confirm-2", "user", 120, "确认"),
      message("provider-output", "assistant", 130, "节点 2.4"),
    ]);

    expect(repaired.map((item) => item.id)).toEqual([
      "confirm-1",
      "provider-output",
      "confirm-2",
      "provider-output~2",
    ]);
    expect(repaired.map((item) => item.content)).toEqual([
      "确认",
      "节点 2.3",
      "确认",
      "节点 2.4",
    ]);
  });

  it("repairs duplicate attachment IDs without dropping either message", () => {
    const repaired = repairSnapshotMessageIds([
      {
        ...message("assistant-1", "assistant", 100),
        attachments: [
          { id: "asset", type: "image", name: "one.webp", fileId: "file-1" },
        ],
      },
      {
        ...message("assistant-2", "assistant", 110),
        attachments: [
          { id: "asset", type: "image", name: "two.webp", fileId: "file-2" },
        ],
      },
    ]);

    expect(repaired.flatMap((item) => item.attachments ?? []).map((item) => item.id))
      .toEqual(["asset", "asset~2"]);
  });

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
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
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
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
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
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
    ).toEqual(["user-a", "final"]);
  });

  it("applies deletion tombstones after merging", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("assistant-a", "assistant", 110),
    ];

    expect(
      mergeConversationMessages(persisted, [], ["assistant-a"]).map(
        (item) => item.id,
      ),
    ).toEqual(["user-a"]);
  });

  it("does not let a stale device roll the task pointer from T2 back to T1", () => {
    const persisted = [
      message("user-turn-1", "user", 100),
      message("assistant-turn-1", "assistant", 110),
      message("user-turn-2", "user", 200),
      message("assistant-turn-2", "assistant", 210),
    ];
    const stale = [
      message("user-turn-1", "user", 100),
      message("assistant-turn-1", "assistant", 110),
    ];

    expect(
      mergeConversationTaskPointers({
        existing: { taskId: "T2", previousResponseId: "T2" },
        incoming: { taskId: "T1", previousResponseId: "T1" },
        persistedMessages: persisted,
        incomingMessages: stale,
        resourceCreatedAt: new Map([
          ["T1", 1_000],
          ["T2", 2_000],
        ]),
        existingUpdatedAt: 2_000,
        // Even a badly skewed client clock cannot defeat ledger ordering.
        incomingUpdatedAt: 99_000,
      }),
    ).toEqual({ taskId: "T2", previousResponseId: "T2" });
  });

  it("accepts the next task pointer when its user turn is current", () => {
    const currentMessages = [
      message("user-turn-1", "user", 100),
      message("assistant-turn-1", "assistant", 110),
      message("user-turn-2", "user", 200),
    ];

    expect(
      mergeConversationTaskPointers({
        existing: { taskId: "T1", previousResponseId: "T1" },
        incoming: { taskId: "T2", previousResponseId: "T2" },
        persistedMessages: currentMessages,
        incomingMessages: currentMessages,
        // MySQL task timestamps can share one-second precision.
        resourceCreatedAt: new Map([
          ["T1", 1_000],
          ["T2", 1_000],
        ]),
        existingUpdatedAt: 2_000,
        incomingUpdatedAt: 2_001,
      }),
    ).toEqual({ taskId: "T2", previousResponseId: "T2" });
  });
});

describe("conversation deletion", () => {
  it("physically deletes the owned conversation instead of marking it deleted", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const deleteFrom = vi.fn().mockReturnValue({ where });

    await permanentlyDeleteConversation(
      { delete: deleteFrom },
      7,
      "u7:conversation-1",
    );

    expect(deleteFrom).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("uses id plus project scope so a replacement engineer can delete project history without crossing A/B", async () => {
    const rows = [
      {
        id: "pproject-a:conversation-1",
        userId: 7,
        projectAssignmentId: "project-a",
      },
    ];
    const predicates: Array<{ sql: string; params: unknown[] }> = [];
    const deleteFrom = vi.fn((table: unknown) => {
      expect(table).toBe(conversations);
      return {
        where: async (expression: unknown) => {
          const query = new MySqlDialect().sqlToQuery(expression as any);
          predicates.push(query);
          const [id, projectAssignmentId] = query.params;
          const index = rows.findIndex(
            (row) =>
              row.id === id && row.projectAssignmentId === projectAssignmentId,
          );
          if (index >= 0) rows.splice(index, 1);
        },
      };
    });

    await permanentlyDeleteConversation(
      { delete: deleteFrom },
      99,
      "pproject-a:conversation-1",
      "project-b",
    );
    expect(rows).toHaveLength(1);

    await permanentlyDeleteConversation(
      { delete: deleteFrom },
      99,
      "pproject-a:conversation-1",
      "project-a",
    );
    expect(rows).toEqual([]);

    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) {
      expect(predicate.sql).toContain("`conversations`.`id` = ?");
      expect(predicate.sql).toContain(
        "`conversations`.`projectAssignmentId` = ?",
      );
      expect(predicate.sql).not.toContain("`conversations`.`userId`");
    }
    expect(predicates[0]?.params).toEqual([
      "pproject-a:conversation-1",
      "project-b",
    ]);
    expect(predicates[1]?.params).toEqual([
      "pproject-a:conversation-1",
      "project-a",
    ]);
  });
});

describe("conversation credential binding", () => {
  it("uses the customer's direct key even when a delivery admin is assigned", async () => {
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === users) return [{ role: "user" }];
      if (table === apiCredentials) {
        return [{ id: "credential-customer" }];
      }
      if (table === userUsageOwners) {
        return [{ deliveryAdminId: 42 }];
      }
      return [];
    });

    await expect(getActiveCredentialId(executor, 7)).resolves.toBe(
      "credential-customer",
    );
    expect(selectedTables).toEqual([users, apiCredentials]);
    expect(selectedTables).not.toContain(userUsageOwners);
  });

  it("falls back to the assigned delivery admin only when the customer has no key", async () => {
    let credentialQueryCount = 0;
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === users) return [{ role: "user" }];
      if (table === userUsageOwners) return [{ deliveryAdminId: 42 }];
      if (table === apiCredentials) {
        credentialQueryCount += 1;
        return credentialQueryCount === 1
          ? []
          : [{ id: "credential-delivery-admin" }];
      }
      return [];
    });

    await expect(getActiveCredentialId(executor, 7)).resolves.toBe(
      "credential-delivery-admin",
    );
    expect(selectedTables).toEqual([
      users,
      apiCredentials,
      userUsageOwners,
      apiCredentials,
    ]);
  });

  it("keeps an old task bound to its original credential after manager reassignment", async () => {
    const snapshot: ConversationSnapshot = {
      id: "conversation-old-task",
      title: "历史任务",
      status: "completed",
      taskId: "task-before-reassignment",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === upstreamResources) {
        return [
          {
            userId: 7,
            kind: "task",
            upstreamId: "task-before-reassignment",
            apiCredentialId: "credential-former-manager",
          },
        ];
      }
      if (table === apiCredentials) return [{ status: "retired" }];
      if (table === userUsageOwners) {
        return [{ deliveryAdminId: 99 }];
      }
      return [];
    });

    await expect(
      resolveSnapshotCredentialId(executor, 7, snapshot, {
        existingCredentialId: "credential-former-manager",
      }),
    ).resolves.toMatchObject({
      credentialId: "credential-former-manager",
    });
    expect(selectedTables).toEqual([upstreamResources, apiCredentials]);
    expect(selectedTables).not.toContain(userUsageOwners);
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
    async (status) => {
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
      validateUpstreamResourceAccess("sk-owner", "task", "task-1", async () => {
        throw new Error("timeout");
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
