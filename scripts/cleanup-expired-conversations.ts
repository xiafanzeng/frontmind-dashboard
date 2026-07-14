import "dotenv/config";
import mysql from "mysql2/promise";

import {
  cleanupExpiredConversations,
  DEFAULT_CONVERSATION_RETENTION_DAYS,
} from "../server/conversation-retention";

function readRetentionDays() {
  const flagIndex = process.argv.indexOf("--retention-days");
  const rawValue =
    flagIndex >= 0
      ? process.argv[flagIndex + 1]
      : process.env.FRONTMIND_CONVERSATION_RETENTION_DAYS;
  if (!rawValue) return DEFAULT_CONVERSATION_RETENTION_DAYS;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--retention-days 必须是大于 0 的整数");
  }
  return value;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");

  const connection = await mysql.createConnection(databaseUrl);
  try {
    const retentionDays = readRetentionDays();
    const result = await cleanupExpiredConversations(
      connection,
      retentionDays,
    );
    console.log(
      [
        "过期会话清理完成",
        `保留期=${retentionDays}天`,
        `截止=${result.cutoff.toISOString()}`,
        `会话=${result.conversations}`,
        "关联消息、附件和对话轮次已级联删除",
      ].join(" "),
    );
  } finally {
    await connection.end();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
