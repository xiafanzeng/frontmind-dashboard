import type { Connection, ResultSetHeader } from "mysql2/promise";

export const DEFAULT_CONVERSATION_RETENTION_DAYS = 30;

export type ConversationRetentionResult = {
  cutoff: Date;
  conversations: number;
};

export function getConversationRetentionCutoff(
  retentionDays = DEFAULT_CONVERSATION_RETENTION_DAYS,
  now = new Date(),
) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("保留天数必须是大于 0 的整数");
  }
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Permanently removes conversations that have not been updated during the
 * retention window. Foreign keys atomically cascade the delete to turns,
 * messages, and attachments.
 */
export async function cleanupExpiredConversations(
  connection: Connection,
  retentionDays = DEFAULT_CONVERSATION_RETENTION_DAYS,
  now = new Date(),
): Promise<ConversationRetentionResult> {
  const cutoff = getConversationRetentionCutoff(retentionDays, now);
  await connection.beginTransaction();
  try {
    const [result] = await connection.execute<ResultSetHeader>(
      "DELETE FROM conversations WHERE updatedAt < ?",
      [cutoff],
    );
    await connection.commit();
    return {
      cutoff,
      conversations: result.affectedRows,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
