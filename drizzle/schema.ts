import {
  boolean,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Internal FrontMind accounts. Legacy OAuth columns remain nullable so an
 * existing deployment can migrate before its users are converted to local
 * username/password accounts.
 */
export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    openId: varchar("openId", { length: 64 }).unique(),
    username: varchar("username", { length: 64 }).unique(),
    passwordHash: varchar("passwordHash", { length: 255 }),
    displayName: varchar("displayName", { length: 128 }),
    // Legacy profile fields retained for a safe additive migration.
    name: text("name"),
    email: varchar("email", { length: 320 }),
    loginMethod: varchar("loginMethod", { length: 64 }),
    role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    passwordChangedAt: timestamp("passwordChangedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn"),
  },
  table => [index("users_active_role_idx").on(table.isActive, table.role)]
);

/** Only a SHA-256 hash of the opaque browser token is persisted. */
export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("sessions_user_expires_idx").on(table.userId, table.expiresAt),
    index("sessions_token_active_idx").on(table.tokenHash, table.revokedAt),
  ]
);

/**
 * Versioned upstream credentials. encryptedKey is AES-256-GCM ciphertext;
 * iv and authTag are stored separately and are never returned to a browser.
 */
export const apiCredentials = mysqlTable(
  "api_credentials",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    encryptionVersion: int("encryptionVersion").default(1).notNull(),
    encryptedKey: text("encryptedKey").notNull(),
    encryptionIv: varchar("encryptionIv", { length: 32 }).notNull(),
    encryptionAuthTag: varchar("encryptionAuthTag", { length: 32 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["active", "retired", "deleted"])
      .default("active")
      .notNull(),
    validationStatus: mysqlEnum("validationStatus", [
      "unverified",
      "verified",
      "invalid",
    ])
      .default("unverified")
      .notNull(),
    verifiedAt: timestamp("verifiedAt"),
    retiredAt: timestamp("retiredAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("api_credentials_user_version_uq").on(
      table.userId,
      table.version
    ),
    index("api_credentials_user_status_idx").on(table.userId, table.status),
  ]
);

/**
 * Legacy API Key ownership rows retained for migration compatibility.
 * New credential assignments no longer write to this table because one
 * upstream API Key may be shared by multiple FrontMind users.
 */
export const apiKeyOwnership = mysqlTable(
  "api_key_ownership",
  {
    fingerprint: varchar("fingerprint", { length: 32 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("api_key_ownership_user_idx").on(table.userId)],
);

export const conversations = mysqlTable(
  "conversations",
  {
    // Client-generated IDs are retained during the one-time local import.
    id: varchar("id", { length: 191 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" }
    ),
    title: varchar("title", { length: 255 }).notNull(),
    status: mysqlEnum("status", [
      "idle",
      "running",
      "pending",
      "completed",
      "error",
      "failed",
      "archived",
    ])
      .default("idle")
      .notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    previousResponseId: varchar("previousResponseId", { length: 255 }),
    taskUrl: text("taskUrl"),
    lastKnownOutputLength: int("lastKnownOutputLength").default(0).notNull(),
    deletedMessageIds: json("deletedMessageIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    version: int("version").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  table => [
    index("conversations_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversations_user_status_idx").on(table.userId, table.status),
    index("conversations_upstream_task_idx").on(table.upstreamTaskId),
  ]
);

export const conversationTurns = mysqlTable(
  "conversation_turns",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    conversationId: varchar("conversationId", { length: 191 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" }
    ),
    clientRequestId: varchar("clientRequestId", { length: 128 }).notNull(),
    model: varchar("model", { length: 128 }),
    status: mysqlEnum("status", [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ])
      .default("queued")
      .notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorMessage: text("errorMessage"),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("conversation_turns_client_request_uq").on(
      table.conversationId,
      table.clientRequestId
    ),
    index("conversation_turns_user_status_idx").on(table.userId, table.status),
    index("conversation_turns_upstream_task_idx").on(table.upstreamTaskId),
  ]
);

export type MessageMetadata = {
  outputFiles?: Array<{ fileUrl: string; fileName: string; mimeType: string }>;
  inlineImages?: Array<{ src: string; alt?: string }>;
  elapsedTime?: number;
  responseStartedAt?: number;
  intermediateSteps?: unknown[];
  stepGroups?: unknown[];
  isStepsPlaceholder?: boolean;
  modelName?: string;
  [key: string]: unknown;
};

export const messages = mysqlTable(
  "messages",
  {
    id: varchar("id", { length: 191 }).primaryKey(),
    conversationId: varchar("conversationId", { length: 191 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turnId: varchar("turnId", { length: 36 }).references(
      () => conversationTurns.id,
      { onDelete: "set null" }
    ),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["user", "assistant", "system", "tool"]).notNull(),
    content: longtext("content").notNull(),
    sequence: int("sequence").notNull(),
    metadata: json("metadata").$type<MessageMetadata>(),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  table => [
    uniqueIndex("messages_conversation_sequence_uq").on(
      table.conversationId,
      table.sequence
    ),
    index("messages_user_conversation_idx").on(
      table.userId,
      table.conversationId
    ),
    index("messages_turn_idx").on(table.turnId),
  ]
);

export const attachments = mysqlTable(
  "attachments",
  {
    id: varchar("id", { length: 191 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: varchar("conversationId", { length: 191 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: varchar("messageId", { length: 191 })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" }
    ),
    kind: mysqlEnum("kind", ["file", "image"]).default("file").notNull(),
    fileName: varchar("fileName", { length: 512 }).notNull(),
    mimeType: varchar("mimeType", { length: 255 }),
    sizeBytes: int("sizeBytes", { unsigned: true }),
    upstreamFileId: varchar("upstreamFileId", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  table => [
    index("attachments_user_file_idx").on(table.userId, table.upstreamFileId),
    index("attachments_message_idx").on(table.messageId),
  ]
);

/** Security ownership ledger for all upstream task and file identifiers. */
export const upstreamResources = mysqlTable(
  "upstream_resources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 })
      .notNull()
      .references(() => apiCredentials.id, { onDelete: "restrict" }),
    kind: mysqlEnum("kind", ["task", "file"]).notNull(),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    conversationId: varchar("conversationId", { length: 191 }).references(
      () => conversations.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("upstream_resources_kind_id_uq").on(
      table.kind,
      table.upstreamId
    ),
    index("upstream_resources_user_kind_id_idx").on(
      table.userId,
      table.kind,
      table.upstreamId
    ),
  ]
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;
export type ApiCredential = typeof apiCredentials.$inferSelect;
export type InsertApiCredential = typeof apiCredentials.$inferInsert;
export type ApiKeyOwnership = typeof apiKeyOwnership.$inferSelect;
export type InsertApiKeyOwnership = typeof apiKeyOwnership.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;
export type ConversationTurn = typeof conversationTurns.$inferSelect;
export type InsertConversationTurn = typeof conversationTurns.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type InsertAttachment = typeof attachments.$inferInsert;
export type UpstreamResource = typeof upstreamResources.$inferSelect;
export type InsertUpstreamResource = typeof upstreamResources.$inferInsert;
