import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mysql2/promise";

import {
  cleanupExpiredConversations,
  getConversationRetentionCutoff,
} from "./conversation-retention";

describe("conversation retention", () => {
  it("computes a 30-day rolling cutoff", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(getConversationRetentionCutoff(30, now).toISOString()).toBe(
      "2026-06-14T12:00:00.000Z",
    );
  });

  it("deletes conversations by last update and relies on foreign-key cascades", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 2 }]);
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute,
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connection;

    const result = await cleanupExpiredConversations(
      connection,
      30,
      new Date("2026-07-14T12:00:00.000Z"),
    );

    expect(execute).toHaveBeenCalledWith(
      "DELETE FROM conversations WHERE updatedAt < ?",
      [new Date("2026-06-14T12:00:00.000Z")],
    );
    expect(result.conversations).toBe(2);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});
