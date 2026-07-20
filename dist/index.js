// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// server/admin-router.ts
import { z as z2 } from "zod";

// server/_core/trpc.ts
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please log in" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
var adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Administrator permission is required"
    });
  }
  return next({ ctx });
});

// server/auth-service.ts
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual
} from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import {
  and,
  desc,
  eq as eq2,
  gt,
  isNull,
  ne
} from "drizzle-orm";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;

// drizzle/schema.ts
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
  varchar
} from "drizzle-orm/mysql-core";
var users = mysqlTable(
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
    lastSignedIn: timestamp("lastSignedIn")
  },
  (table) => [index("users_active_role_idx").on(table.isActive, table.role)]
);
var sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    index("sessions_user_expires_idx").on(table.userId, table.expiresAt),
    index("sessions_token_active_idx").on(table.tokenHash, table.revokedAt)
  ]
);
var apiCredentials = mysqlTable(
  "api_credentials",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    encryptionVersion: int("encryptionVersion").default(1).notNull(),
    encryptedKey: text("encryptedKey").notNull(),
    encryptionIv: varchar("encryptionIv", { length: 32 }).notNull(),
    encryptionAuthTag: varchar("encryptionAuthTag", { length: 32 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["active", "retired", "deleted"]).default("active").notNull(),
    validationStatus: mysqlEnum("validationStatus", [
      "unverified",
      "verified",
      "invalid"
    ]).default("unverified").notNull(),
    verifiedAt: timestamp("verifiedAt"),
    retiredAt: timestamp("retiredAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("api_credentials_user_version_uq").on(
      table.userId,
      table.version
    ),
    index("api_credentials_user_status_idx").on(table.userId, table.status)
  ]
);
var apiKeyOwnership = mysqlTable(
  "api_key_ownership",
  {
    fingerprint: varchar("fingerprint", { length: 32 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [index("api_key_ownership_user_idx").on(table.userId)]
);
var conversations = mysqlTable(
  "conversations",
  {
    // Client-generated IDs are retained during the one-time local import.
    id: varchar("id", { length: 191 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
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
      "archived"
    ]).default("idle").notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    previousResponseId: varchar("previousResponseId", { length: 255 }),
    taskUrl: text("taskUrl"),
    lastKnownOutputLength: int("lastKnownOutputLength").default(0).notNull(),
    deletedMessageIds: json("deletedMessageIds").$type().default([]).notNull(),
    version: int("version").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt")
  },
  (table) => [
    index("conversations_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversations_user_status_idx").on(table.userId, table.status),
    index("conversations_upstream_task_idx").on(table.upstreamTaskId)
  ]
);
var conversationTurns = mysqlTable(
  "conversation_turns",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    conversationId: varchar("conversationId", { length: 191 }).notNull().references(() => conversations.id, { onDelete: "cascade" }),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
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
      "cancelled"
    ]).default("queued").notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorMessage: text("errorMessage"),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("conversation_turns_client_request_uq").on(
      table.conversationId,
      table.clientRequestId
    ),
    index("conversation_turns_user_status_idx").on(table.userId, table.status),
    index("conversation_turns_upstream_task_idx").on(table.upstreamTaskId)
  ]
);
var messages = mysqlTable(
  "messages",
  {
    id: varchar("id", { length: 191 }).primaryKey(),
    conversationId: varchar("conversationId", { length: 191 }).notNull().references(() => conversations.id, { onDelete: "cascade" }),
    turnId: varchar("turnId", { length: 36 }).references(
      () => conversationTurns.id,
      { onDelete: "set null" }
    ),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["user", "assistant", "system", "tool"]).notNull(),
    content: longtext("content").notNull(),
    sequence: int("sequence").notNull(),
    metadata: json("metadata").$type(),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt")
  },
  (table) => [
    uniqueIndex("messages_conversation_sequence_uq").on(
      table.conversationId,
      table.sequence
    ),
    index("messages_user_conversation_idx").on(
      table.userId,
      table.conversationId
    ),
    index("messages_turn_idx").on(table.turnId)
  ]
);
var attachments = mysqlTable(
  "attachments",
  {
    id: varchar("id", { length: 191 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: varchar("conversationId", { length: 191 }).notNull().references(() => conversations.id, { onDelete: "cascade" }),
    messageId: varchar("messageId", { length: 191 }).notNull().references(() => messages.id, { onDelete: "cascade" }),
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
    deletedAt: timestamp("deletedAt")
  },
  (table) => [
    index("attachments_user_file_idx").on(table.userId, table.upstreamFileId),
    index("attachments_message_idx").on(table.messageId)
  ]
);
var upstreamResources = mysqlTable(
  "upstream_resources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull().references(() => apiCredentials.id, { onDelete: "restrict" }),
    kind: mysqlEnum("kind", ["task", "file"]).notNull(),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    conversationId: varchar("conversationId", { length: 191 }).references(
      () => conversations.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("upstream_resources_kind_id_uq").on(
      table.kind,
      table.upstreamId
    ),
    index("upstream_resources_user_kind_id_idx").on(
      table.userId,
      table.kind,
      table.upstreamId
    )
  ]
);

// server/db.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// server/upstream-config.ts
var UPSTREAM_VENDOR = ["ma", "nus"].join("");
var DEFAULT_UPSTREAM_BASE_URL = `https://api.${UPSTREAM_VENDOR}.im`;
function getUpstreamBaseUrl(req) {
  const configured = process.env.FRONTMIND_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL;
  return configured.replace(/\/$/, "");
}
function getFrontMindApiKey(req) {
  return req.frontmindCredential?.apiKey ?? "";
}
function getFrontMindCredentials(req) {
  return {
    apiKey: getFrontMindApiKey(req),
    baseUrl: getUpstreamBaseUrl(req)
  };
}
function toUpstreamAgentProfile(agentProfile) {
  switch (agentProfile) {
    case "frontmind-lite":
      return `${UPSTREAM_VENDOR}-1.6-lite`;
    case "frontmind-base":
      return `${UPSTREAM_VENDOR}-1.6`;
    case "frontmind-pro":
    case void 0:
    case "":
      return `${UPSTREAM_VENDOR}-1.6-max`;
    default:
      return agentProfile;
  }
}
function translateTaskBodyForUpstream(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const next = { ...body };
  if (typeof next.agentProfile === "string") {
    next.agentProfile = toUpstreamAgentProfile(next.agentProfile);
  }
  return next;
}

// server/auth-service.ts
var SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1e3;
var SCRYPT_VERSION = "v1";
var SCRYPT_N = 16384;
var SCRYPT_R = 8;
var SCRYPT_P = 1;
var SCRYPT_KEY_LENGTH = 64;
var LOGIN_WINDOW_MS = 15 * 60 * 1e3;
var LOGIN_MAX_FAILURES = 5;
var DUMMY_PASSWORD_HASH = "scrypt$v1$16384$8$1$RnJvbnRNaW5kRHVtbXkwMQ==$v5gxAmM2/2xmlb6BhcM2tE6ivMw+PG8CtewPcO0jJcY86Ak1/I0770tV9pqMocaZiA4z4hu7Obq9HgC6hFn4qw==";
var AuthServiceError = class extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.name = "AuthServiceError";
  }
};
var loginAttempts = /* @__PURE__ */ new Map();
function toAuthenticatedUser(user) {
  const username = user.username ?? user.openId ?? `legacy-${user.id}`;
  return {
    id: user.id,
    openId: user.openId,
    username,
    displayName: user.displayName ?? user.name ?? username,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSignedIn: user.lastSignedIn
  };
}
async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured"
    );
  }
  return db;
}
function runScrypt(password, salt) {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      }
    );
  });
}
function normalizeUsername(username) {
  return username.normalize("NFKC").trim().toLowerCase();
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await runScrypt(password, salt);
  return [
    "scrypt",
    SCRYPT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derivedKey.toString("base64")
  ].join("$");
}
async function verifyPassword(password, encodedHash) {
  const parts = encodedHash.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== SCRYPT_VERSION) {
    return false;
  }
  const n = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  try {
    const salt = Buffer.from(parts[5], "base64");
    const expected = Buffer.from(parts[6], "base64");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await runScrypt(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
function hashSessionToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function getSessionTokenFromRequest(req) {
  try {
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    return cookies[COOKIE_NAME] || null;
  } catch {
    return null;
  }
}
async function createSession(userId) {
  const db = await requireDb();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session = {
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now + SESSION_DURATION_MS),
    lastSeenAt: new Date(now)
  };
  await db.insert(sessions).values(session);
  return { token, session };
}
async function authenticateRequest(req) {
  const token = getSessionTokenFromRequest(req);
  if (!token) return null;
  const db = await getDb();
  if (!db) return null;
  const tokenHash = hashSessionToken(token);
  const rows = await db.select({ user: users, lastSeenAt: sessions.lastSeenAt }).from(sessions).innerJoin(users, eq2(sessions.userId, users.id)).where(
    and(
      eq2(sessions.tokenHash, tokenHash),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, /* @__PURE__ */ new Date()),
      eq2(users.isActive, true)
    )
  ).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60 * 1e3) {
    await db.update(sessions).set({ lastSeenAt: /* @__PURE__ */ new Date() }).where(eq2(sessions.tokenHash, tokenHash));
  }
  return toAuthenticatedUser(row.user);
}
async function revokeSessionToken(token) {
  if (!token) return;
  const db = await getDb();
  if (!db) return;
  await db.update(sessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(
    and(
      eq2(sessions.tokenHash, hashSessionToken(token)),
      isNull(sessions.revokedAt)
    )
  );
}
async function revokeAllUserSessions(userId, exceptToken) {
  const db = await requireDb();
  const conditions = [eq2(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptToken) {
    conditions.push(ne(sessions.tokenHash, hashSessionToken(exceptToken)));
  }
  await db.update(sessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(and(...conditions));
}
function loginAttemptKey(username, clientAddress) {
  return `${normalizeUsername(username)}\0${clientAddress}`;
}
function assertLoginAllowed(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return;
  const now = Date.now();
  if (now >= attempt.resetAt) {
    loginAttempts.delete(key);
    return;
  }
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    throw new AuthServiceError(
      "RATE_LIMITED",
      "Too many login attempts",
      attempt.resetAt - now
    );
  }
}
function recordLoginFailure(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now >= current.resetAt) {
    loginAttempts.set(key, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    current.failures += 1;
  }
  if (loginAttempts.size > 1e4) {
    for (const [entryKey, value] of loginAttempts) {
      if (now >= value.resetAt) loginAttempts.delete(entryKey);
      if (loginAttempts.size <= 8e3) break;
    }
  }
}
async function loginWithPassword(username, password, clientAddress) {
  const normalizedUsername = normalizeUsername(username);
  const attemptKey = loginAttemptKey(normalizedUsername, clientAddress);
  assertLoginAllowed(attemptKey);
  const db = await requireDb();
  const rows = await db.select().from(users).where(eq2(users.username, normalizedUsername)).limit(1);
  const user = rows[0];
  const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, passwordHash);
  if (!user || !passwordMatches) {
    recordLoginFailure(attemptKey);
    throw new AuthServiceError("INVALID_PASSWORD", "Invalid username or password");
  }
  if (!user.isActive) {
    recordLoginFailure(attemptKey);
    throw new AuthServiceError("ACCOUNT_DISABLED", "Account is disabled");
  }
  loginAttempts.delete(attemptKey);
  const lastSignedIn = /* @__PURE__ */ new Date();
  await db.update(users).set({ lastSignedIn }).where(eq2(users.id, user.id));
  const created = await createSession(user.id);
  return {
    user: toAuthenticatedUser({ ...user, lastSignedIn }),
    ...created
  };
}
async function changeOwnPassword(userId, currentPassword, newPassword, currentSessionToken) {
  const db = await requireDb();
  const rows = await db.select().from(users).where(eq2(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.passwordHash || !await verifyPassword(currentPassword, user.passwordHash)) {
    throw new AuthServiceError("INVALID_PASSWORD", "Current password is incorrect");
  }
  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash, passwordChangedAt: /* @__PURE__ */ new Date() }).where(eq2(users.id, userId));
  await revokeAllUserSessions(userId, currentSessionToken);
}
async function listManagedUsers() {
  const db = await requireDb();
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  return rows.map(toAuthenticatedUser);
}
async function getManagedUser(userId) {
  const db = await requireDb();
  const rows = await db.select().from(users).where(eq2(users.id, userId)).limit(1);
  return rows[0] ? toAuthenticatedUser(rows[0]) : null;
}
async function createManagedUser(input) {
  const db = await requireDb();
  const username = normalizeUsername(input.username);
  const existing = await db.select({ id: users.id }).from(users).where(eq2(users.username, username)).limit(1);
  if (existing.length > 0) {
    throw new AuthServiceError("CONFLICT", "Username already exists");
  }
  const passwordHash = await hashPassword(input.password);
  try {
    await db.insert(users).values({
      username,
      passwordHash,
      displayName: input.displayName?.trim() || null,
      name: input.displayName?.trim() || null,
      loginMethod: "password",
      role: input.role,
      isActive: true,
      passwordChangedAt: /* @__PURE__ */ new Date()
    });
  } catch (error) {
    const mysqlError = error;
    if (mysqlError.code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "Username already exists");
    }
    throw error;
  }
  const created = await db.select().from(users).where(eq2(users.username, username)).limit(1);
  if (!created[0]) {
    throw new AuthServiceError("NOT_FOUND", "Created user could not be loaded");
  }
  return toAuthenticatedUser(created[0]);
}
async function resetManagedUserPassword(userId, newPassword) {
  const db = await requireDb();
  const existing = await db.select({ id: users.id }).from(users).where(eq2(users.id, userId)).limit(1);
  if (!existing[0]) throw new AuthServiceError("NOT_FOUND", "User not found");
  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash, passwordChangedAt: /* @__PURE__ */ new Date() }).where(eq2(users.id, userId));
  await revokeAllUserSessions(userId);
}
async function setManagedUserActive(userId, isActive) {
  const db = await requireDb();
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(users).where(eq2(users.id, userId)).limit(1).for("update");
    const user = rows[0];
    if (!user) throw new AuthServiceError("NOT_FOUND", "User not found");
    if (!isActive && user.isActive && user.role === "admin") {
      const activeAdmins = await tx.select({ id: users.id }).from(users).where(and(eq2(users.role, "admin"), eq2(users.isActive, true))).limit(2).for("update");
      if (activeAdmins.length <= 1) {
        throw new AuthServiceError(
          "LAST_ADMIN",
          "The last active administrator cannot be disabled"
        );
      }
    }
    await tx.update(users).set({ isActive }).where(eq2(users.id, userId));
  });
  if (!isActive) await revokeAllUserSessions(userId);
  const updated = await getManagedUser(userId);
  if (!updated) throw new AuthServiceError("NOT_FOUND", "User not found");
  return updated;
}
async function permanentlyDeleteManagedUserRows(executor, userId) {
  await executor.delete(upstreamResources).where(eq2(upstreamResources.userId, userId));
  await executor.delete(apiKeyOwnership).where(eq2(apiKeyOwnership.userId, userId));
  await executor.delete(users).where(eq2(users.id, userId));
}
async function deleteManagedUser(actorUserId, targetUserId) {
  if (actorUserId === targetUserId) {
    throw new AuthServiceError(
      "CONFLICT",
      "The current administrator account cannot be deleted"
    );
  }
  const db = await requireDb();
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(users).where(eq2(users.id, targetUserId)).limit(1).for("update");
    const user = rows[0];
    if (!user) throw new AuthServiceError("NOT_FOUND", "User not found");
    if (user.role === "admin" && user.isActive) {
      const activeAdmins = await tx.select({ id: users.id }).from(users).where(and(eq2(users.role, "admin"), eq2(users.isActive, true))).limit(2).for("update");
      if (activeAdmins.length <= 1) {
        throw new AuthServiceError(
          "LAST_ADMIN",
          "The last active administrator cannot be deleted"
        );
      }
    }
    await permanentlyDeleteManagedUserRows(tx, targetUserId);
  });
}
function decodeMasterKey(value) {
  const trimmed = value.trim();
  let decoded;
  if (trimmed.startsWith("base64:")) {
    decoded = Buffer.from(trimmed.slice(7), "base64");
  } else if (trimmed.startsWith("hex:")) {
    decoded = Buffer.from(trimmed.slice(4), "hex");
  } else if (/^[a-f\d]{64}$/i.test(trimmed)) {
    decoded = Buffer.from(trimmed, "hex");
  } else {
    decoded = Buffer.from(trimmed, "base64");
  }
  if (decoded.length !== 32) {
    throw new AuthServiceError(
      "INVALID_MASTER_KEY",
      "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY must encode exactly 32 bytes"
    );
  }
  return decoded;
}
function getCredentialMasterKey() {
  const configured = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  if (!configured) {
    throw new AuthServiceError(
      "INVALID_MASTER_KEY",
      "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY is not configured"
    );
  }
  return decodeMasterKey(configured);
}
function assertCredentialEncryptionConfigured() {
  getCredentialMasterKey();
}
function credentialAad(userId, credentialId) {
  return Buffer.from(`frontmind-api-credential:v1:${userId}:${credentialId}`, "utf8");
}
function getApiKeyFingerprint(apiKey) {
  return `fp_${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 16)}`;
}
function encryptApiKey(userId, credentialId, apiKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getCredentialMasterKey(), iv);
  cipher.setAAD(credentialAad(userId, credentialId));
  const encrypted = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final()
  ]);
  return {
    encryptionVersion: 1,
    encryptedKey: encrypted.toString("base64"),
    encryptionIv: iv.toString("base64"),
    encryptionAuthTag: cipher.getAuthTag().toString("base64")
  };
}
function decryptApiKey(credential) {
  try {
    if (credential.encryptionVersion !== 1) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        "Credential encryption version is not supported"
      );
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getCredentialMasterKey(),
      Buffer.from(credential.encryptionIv, "base64")
    );
    decipher.setAAD(credentialAad(credential.userId, credential.id));
    decipher.setAuthTag(Buffer.from(credential.encryptionAuthTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.encryptedKey, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError("INVALID_CREDENTIAL", "Credential cannot be decrypted");
  }
}
async function validateUpstreamApiKey(apiKey) {
  let response;
  try {
    response = await fetch(`${getUpstreamBaseUrl()}/v1/tasks?limit=1`, {
      method: "GET",
      redirect: "error",
      headers: {
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15e3)
    });
  } catch {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "Unable to validate the API credential"
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "API credential is invalid");
  }
  if (!response.ok) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "Upstream service could not validate the API credential"
    );
  }
}
function toCredentialStatus(credential) {
  const status = credential?.status === "deleted" ? null : credential?.validationStatus === "invalid" ? "invalid" : credential?.status ?? null;
  return {
    configured: Boolean(credential && credential.status === "active"),
    fingerprint: credential?.fingerprint ?? null,
    status,
    verifiedAt: credential?.verifiedAt?.getTime() ?? null
  };
}
async function getApiCredentialStatus(userId) {
  const db = await requireDb();
  const rows = await db.select().from(apiCredentials).where(
    and(eq2(apiCredentials.userId, userId), eq2(apiCredentials.status, "active"))
  ).orderBy(desc(apiCredentials.version)).limit(1);
  return toCredentialStatus(rows[0]);
}
async function replaceApiCredential(userId, apiKey, validator = validateUpstreamApiKey) {
  const db = await requireDb();
  await validator(apiKey);
  const fingerprint = getApiKeyFingerprint(apiKey);
  const credentialId = randomUUID();
  const encrypted = encryptApiKey(userId, credentialId, apiKey);
  const now = /* @__PURE__ */ new Date();
  const credential = await db.transaction(async (tx) => {
    const latest = await tx.select().from(apiCredentials).where(eq2(apiCredentials.userId, userId)).orderBy(desc(apiCredentials.version)).limit(1);
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx.update(apiCredentials).set({ status: "retired", retiredAt: now }).where(
      and(eq2(apiCredentials.userId, userId), eq2(apiCredentials.status, "active"))
    );
    const inserted = {
      id: credentialId,
      userId,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active",
      validationStatus: "verified",
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
      deletedAt: null
    };
    await tx.insert(apiCredentials).values(inserted);
    return inserted;
  });
  return toCredentialStatus(credential);
}
async function deleteActiveApiCredential(userId) {
  const db = await requireDb();
  const now = /* @__PURE__ */ new Date();
  await db.update(apiCredentials).set({
    status: "deleted",
    deletedAt: now,
    encryptedKey: randomBytes(32).toString("base64"),
    encryptionIv: randomBytes(12).toString("base64"),
    encryptionAuthTag: randomBytes(16).toString("base64")
  }).where(
    and(eq2(apiCredentials.userId, userId), eq2(apiCredentials.status, "active"))
  );
}
async function getDecryptedCredentialForUser(userId, credentialId) {
  const db = await requireDb();
  const conditions = [
    eq2(apiCredentials.userId, userId),
    ne(apiCredentials.status, "deleted")
  ];
  if (credentialId) conditions.push(eq2(apiCredentials.id, credentialId));
  else conditions.push(eq2(apiCredentials.status, "active"));
  const rows = await db.select().from(apiCredentials).where(and(...conditions)).orderBy(desc(apiCredentials.version)).limit(1);
  const credential = rows[0];
  if (!credential || credential.status === "deleted") return null;
  return {
    id: credential.id,
    userId: credential.userId,
    version: credential.version,
    apiKey: decryptApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt
  };
}
async function getCredentialForUpstreamResource(userId, kind, upstreamId) {
  const db = await requireDb();
  const rows = await db.select({ resource: upstreamResources, credential: apiCredentials }).from(upstreamResources).innerJoin(
    apiCredentials,
    eq2(upstreamResources.apiCredentialId, apiCredentials.id)
  ).where(
    and(
      eq2(upstreamResources.userId, userId),
      eq2(upstreamResources.kind, kind),
      eq2(upstreamResources.upstreamId, upstreamId),
      ne(apiCredentials.status, "deleted")
    )
  ).limit(1);
  const row = rows[0];
  if (!row || row.credential.status === "deleted") return null;
  return {
    id: row.credential.id,
    userId: row.credential.userId,
    version: row.credential.version,
    apiKey: decryptApiKey(row.credential),
    fingerprint: row.credential.fingerprint,
    status: row.credential.status,
    verifiedAt: row.credential.verifiedAt,
    resource: row.resource
  };
}
async function recordUpstreamResource(input) {
  const db = await requireDb();
  const existing = await db.select().from(upstreamResources).where(
    and(
      eq2(upstreamResources.kind, input.kind),
      eq2(upstreamResources.upstreamId, input.upstreamId)
    )
  ).limit(1);
  if (existing[0]) {
    if (existing[0].userId !== input.userId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource is already owned by another account"
      );
    }
    return existing[0];
  }
  const credential = await db.select({ id: apiCredentials.id }).from(apiCredentials).where(
    and(
      eq2(apiCredentials.id, input.apiCredentialId),
      eq2(apiCredentials.userId, input.userId),
      ne(apiCredentials.status, "deleted")
    )
  ).limit(1);
  if (!credential[0]) {
    throw new AuthServiceError("NOT_FOUND", "API credential not found");
  }
  if (input.conversationId) {
    const conversation = await db.select({ id: conversations.id }).from(conversations).where(
      and(
        eq2(conversations.id, input.conversationId),
        eq2(conversations.userId, input.userId)
      )
    ).limit(1);
    if (!conversation[0]) {
      throw new AuthServiceError("NOT_FOUND", "Conversation not found");
    }
  }
  const resource = {
    id: randomUUID(),
    userId: input.userId,
    apiCredentialId: input.apiCredentialId,
    kind: input.kind,
    upstreamId: input.upstreamId,
    conversationId: input.conversationId ?? null,
    createdAt: /* @__PURE__ */ new Date()
  };
  try {
    await db.insert(upstreamResources).values(resource);
    return resource;
  } catch (error) {
    const mysqlError = error;
    if (mysqlError.code !== "ER_DUP_ENTRY") throw error;
    const raced = await db.select().from(upstreamResources).where(
      and(
        eq2(upstreamResources.kind, input.kind),
        eq2(upstreamResources.upstreamId, input.upstreamId),
        eq2(upstreamResources.userId, input.userId)
      )
    ).limit(1);
    if (raced[0]) return raced[0];
    throw new AuthServiceError(
      "CONFLICT",
      "Upstream resource is already owned by another account"
    );
  }
}

// server/auth-router.ts
import { TRPCError as TRPCError2 } from "@trpc/server";
import { z } from "zod";

// shared/auth-constraints.ts
var MIN_PASSWORD_LENGTH = 6;
var MAX_PASSWORD_LENGTH = 128;

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: ENV.isProduction || isSecureRequest(req)
  };
}

// server/auth-router.ts
var passwordSchema = z.string().min(
  MIN_PASSWORD_LENGTH,
  `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`
).max(MAX_PASSWORD_LENGTH, "Password is too long");
function toTrpcError(error) {
  if (!(error instanceof AuthServiceError)) {
    return new TRPCError2({
      code: "INTERNAL_SERVER_ERROR",
      message: "The request could not be completed",
      cause: error
    });
  }
  switch (error.code) {
    case "INVALID_PASSWORD":
      return new TRPCError2({ code: "UNAUTHORIZED", message: error.message });
    case "ACCOUNT_DISABLED":
      return new TRPCError2({ code: "FORBIDDEN", message: error.message });
    case "RATE_LIMITED":
      return new TRPCError2({ code: "TOO_MANY_REQUESTS", message: error.message });
    case "CONFLICT":
    case "LAST_ADMIN":
      return new TRPCError2({ code: "CONFLICT", message: error.message });
    case "NOT_FOUND":
      return new TRPCError2({ code: "NOT_FOUND", message: error.message });
    case "INVALID_CREDENTIAL":
      return new TRPCError2({ code: "BAD_REQUEST", message: error.message });
    case "UPSTREAM_UNAVAILABLE":
      return new TRPCError2({ code: "BAD_GATEWAY", message: error.message });
    case "DATABASE_UNAVAILABLE":
    case "INVALID_MASTER_KEY":
      return new TRPCError2({
        code: "INTERNAL_SERVER_ERROR",
        message: "The service is not configured correctly",
        cause: error
      });
  }
}
var authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),
  login: publicProcedure.input(
    z.object({
      username: z.string().trim().min(1).max(64),
      password: z.string().min(1).max(MAX_PASSWORD_LENGTH)
    })
  ).mutation(async ({ ctx, input }) => {
    try {
      const clientAddress = ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown";
      const result = await loginWithPassword(
        input.username,
        input.password,
        clientAddress
      );
      ctx.res.cookie(COOKIE_NAME, result.token, {
        ...getSessionCookieOptions(ctx.req),
        sameSite: "lax",
        maxAge: SESSION_DURATION_MS
      });
      return {
        user: result.user,
        expiresAt: result.session.expiresAt
      };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),
  logout: publicProcedure.mutation(async ({ ctx }) => {
    await revokeSessionToken(getSessionTokenFromRequest(ctx.req));
    ctx.res.clearCookie(COOKIE_NAME, {
      ...getSessionCookieOptions(ctx.req),
      sameSite: "lax",
      maxAge: -1
    });
    return { success: true };
  }),
  changePassword: protectedProcedure.input(
    z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: passwordSchema
    })
  ).mutation(async ({ ctx, input }) => {
    try {
      await changeOwnPassword(
        ctx.user.id,
        input.currentPassword,
        input.newPassword,
        getSessionTokenFromRequest(ctx.req)
      );
      return { success: true };
    } catch (error) {
      throw toTrpcError(error);
    }
  })
});

// server/admin-router.ts
var usernameSchema = z2.string().trim().min(3, "Username must contain at least 3 characters").max(64, "Username is too long").regex(
  /^[a-zA-Z0-9._-]+$/,
  "Username may only contain letters, numbers, dots, underscores, and hyphens"
);
var adminRouter = router({
  users: router({
    list: adminProcedure.query(async () => {
      try {
        return { users: await listManagedUsers() };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    create: adminProcedure.input(
      z2.object({
        username: usernameSchema,
        password: passwordSchema,
        displayName: z2.string().trim().max(128).optional(),
        role: z2.enum(["user", "admin"]).default("user")
      })
    ).mutation(async ({ input }) => {
      try {
        const user = await createManagedUser(input);
        return { user };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    resetPassword: adminProcedure.input(
      z2.object({
        userId: z2.number().int().positive(),
        newPassword: passwordSchema
      })
    ).mutation(async ({ input }) => {
      try {
        await resetManagedUserPassword(input.userId, input.newPassword);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    setActive: adminProcedure.input(
      z2.object({
        userId: z2.number().int().positive(),
        isActive: z2.boolean()
      })
    ).mutation(async ({ input }) => {
      try {
        const user = await setManagedUserActive(input.userId, input.isActive);
        return { user };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    delete: adminProcedure.input(z2.object({ userId: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      try {
        await deleteManagedUser(ctx.user.id, input.userId);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    })
  })
});

// server/conversation-router.ts
import { TRPCError as TRPCError3 } from "@trpc/server";
import { and as and2, asc, desc as desc2, eq as eq3, inArray, isNull as isNull2 } from "drizzle-orm";
import { randomUUID as randomUUID2 } from "node:crypto";
import { z as z3 } from "zod";
var attachmentSchema = z3.object({
  id: z3.string().min(1).max(128),
  type: z3.enum(["file", "image"]),
  name: z3.string().min(1).max(512),
  fileId: z3.string().min(1).max(255).optional()
});
var outputFileSchema = z3.object({
  fileUrl: z3.string().max(4096),
  fileName: z3.string().max(512),
  mimeType: z3.string().max(255)
});
var inlineImageSchema = z3.object({
  src: z3.string().max(4096),
  alt: z3.string().max(512).optional()
});
var messageSchema = z3.object({
  id: z3.string().min(1).max(128),
  role: z3.enum(["user", "assistant"]),
  content: z3.string().max(2e6),
  attachments: z3.array(attachmentSchema).max(100).optional(),
  timestamp: z3.number().finite().nonnegative(),
  outputFiles: z3.array(outputFileSchema).max(200).optional(),
  inlineImages: z3.array(inlineImageSchema).max(200).optional(),
  elapsedTime: z3.number().finite().nonnegative().optional(),
  responseStartedAt: z3.number().finite().nonnegative().optional(),
  intermediateSteps: z3.array(z3.unknown()).max(2e3).optional(),
  stepGroups: z3.array(z3.unknown()).max(500).optional(),
  isStepsPlaceholder: z3.boolean().optional(),
  modelName: z3.string().max(128).optional()
});
var conversationSnapshotSchema = z3.object({
  id: z3.string().min(1).max(128),
  title: z3.string().min(1).max(255),
  messages: z3.array(messageSchema).max(5e3),
  taskId: z3.string().max(255).optional(),
  previousResponseId: z3.string().max(255).optional(),
  status: z3.enum(["idle", "running", "pending", "completed", "error", "failed"]),
  taskUrl: z3.string().max(4096).optional(),
  createdAt: z3.number().finite().nonnegative(),
  updatedAt: z3.number().finite().nonnegative(),
  startedAt: z3.number().finite().nonnegative().optional(),
  completedAt: z3.number().finite().nonnegative().optional(),
  lastKnownOutputLength: z3.number().int().nonnegative().optional(),
  deletedMessageIds: z3.array(z3.string().max(128)).max(5e3).optional()
});
var LEGACY_IMPORT_MAX_RESOURCES = 200;
var LEGACY_IMPORT_VALIDATION_CONCURRENCY = 4;
var LEGACY_IMPORT_VALIDATION_TIMEOUT_MS = 3e4;
function upstreamResourceKey(kind, id) {
  return JSON.stringify([kind, id]);
}
function collectSnapshotResourceRefs(snapshots) {
  const resources = /* @__PURE__ */ new Map();
  const add = (kind, id) => {
    if (!id) return;
    resources.set(upstreamResourceKey(kind, id), { kind, id });
    if (resources.size > LEGACY_IMPORT_MAX_RESOURCES) {
      throw new TRPCError3({
        code: "PAYLOAD_TOO_LARGE",
        message: `\u5355\u6B21\u6700\u591A\u8FC1\u79FB ${LEGACY_IMPORT_MAX_RESOURCES} \u4E2A\u5386\u53F2\u4EFB\u52A1\u6216\u6587\u4EF6`
      });
    }
  };
  for (const snapshot of snapshots) {
    add("task", snapshot.taskId);
    for (const message of snapshot.messages) {
      for (const attachment of message.attachments ?? []) {
        add("file", attachment.fileId);
      }
    }
  }
  return Array.from(resources.values());
}
function storageId(userId, publicId2) {
  return `u${userId}:${publicId2}`;
}
function publicId(userId, persistedId) {
  const prefix = `u${userId}:`;
  return persistedId.startsWith(prefix) ? persistedId.slice(prefix.length) : persistedId;
}
function asDate(value) {
  if (value === void 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function requireDb2(db) {
  if (!db) {
    throw new TRPCError3({
      code: "INTERNAL_SERVER_ERROR",
      message: "\u6570\u636E\u5E93\u6682\u4E0D\u53EF\u7528"
    });
  }
  return db;
}
async function permanentlyDeleteConversation(executor, userId, persistedConversationId) {
  await executor.delete(conversations).where(
    and2(
      eq3(conversations.id, persistedConversationId),
      eq3(conversations.userId, userId)
    )
  );
}
async function getActiveCredentialId(executor, userId) {
  const rows = await executor.select({ id: apiCredentials.id }).from(apiCredentials).where(
    and2(
      eq3(apiCredentials.userId, userId),
      eq3(apiCredentials.status, "active"),
      eq3(apiCredentials.validationStatus, "verified"),
      isNull2(apiCredentials.deletedAt)
    )
  ).orderBy(desc2(apiCredentials.version)).limit(1);
  return rows[0]?.id;
}
async function assertResourceOwnership(executor, userId, kind, upstreamId) {
  const rows = await executor.select({ userId: upstreamResources.userId }).from(upstreamResources).where(
    and2(
      eq3(upstreamResources.kind, kind),
      eq3(upstreamResources.upstreamId, upstreamId)
    )
  ).limit(1);
  if (rows[0] && rows[0].userId !== userId) {
    throw new TRPCError3({ code: "FORBIDDEN", message: "\u4E0A\u6E38\u8D44\u6E90\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7" });
  }
  return rows[0] ?? null;
}
async function validateUpstreamResourceAccess(apiKey, kind, upstreamId, request = fetch, signal = AbortSignal.timeout(15e3)) {
  let response;
  try {
    const collection = kind === "task" ? "tasks" : "files";
    response = await request(
      `${getUpstreamBaseUrl()}/v1/${collection}/${encodeURIComponent(upstreamId)}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        },
        signal
      }
    );
  } catch {
    throw new TRPCError3({
      code: "SERVICE_UNAVAILABLE",
      message: "\u4E0A\u6E38\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u9A8C\u8BC1\u5386\u53F2\u4EFB\u52A1\u6216\u6587\u4EF6\u5F52\u5C5E"
    });
  }
  const { ok, status } = response;
  await response.body?.cancel().catch(() => void 0);
  if (status === 401 || status === 403 || status === 404) {
    throw new TRPCError3({
      code: "FORBIDDEN",
      message: "\u5F53\u524D API Key \u65E0\u6CD5\u8BBF\u95EE\u8BE5\u5386\u53F2\u4EFB\u52A1\u6216\u6587\u4EF6"
    });
  }
  if (!ok) {
    throw new TRPCError3({
      code: "SERVICE_UNAVAILABLE",
      message: "\u4E0A\u6E38\u670D\u52A1\u6682\u65F6\u65E0\u6CD5\u9A8C\u8BC1\u5386\u53F2\u4EFB\u52A1\u6216\u6587\u4EF6\u5F52\u5C5E"
    });
  }
}
async function persistResource(executor, input, validatedResourceKeys) {
  const existing = await assertResourceOwnership(
    executor,
    input.userId,
    input.kind,
    input.upstreamId
  );
  if (existing) return;
  if (!validatedResourceKeys?.has(upstreamResourceKey(input.kind, input.upstreamId))) {
    throw new TRPCError3({
      code: "FORBIDDEN",
      message: "\u5386\u53F2\u4EFB\u52A1\u6216\u6587\u4EF6\u5C1A\u672A\u9A8C\u8BC1\uFF0C\u8BF7\u901A\u8FC7\u672C\u5730\u8BB0\u5F55\u8FC1\u79FB\u5165\u53E3\u5BFC\u5165"
    });
  }
  await executor.insert(upstreamResources).values({
    id: randomUUID2(),
    userId: input.userId,
    apiCredentialId: input.apiCredentialId,
    kind: input.kind,
    upstreamId: input.upstreamId,
    conversationId: input.conversationId
  }).onDuplicateKeyUpdate({
    // Never mutate an existing owner's row on a duplicate-key race.
    set: { upstreamId: input.upstreamId }
  });
  await assertResourceOwnership(executor, input.userId, input.kind, input.upstreamId);
}
function buildMessageMetadata(message) {
  const metadata = {};
  if (message.outputFiles) metadata.outputFiles = message.outputFiles;
  if (message.inlineImages) metadata.inlineImages = message.inlineImages;
  if (message.elapsedTime !== void 0) metadata.elapsedTime = message.elapsedTime;
  if (message.responseStartedAt !== void 0) {
    metadata.responseStartedAt = message.responseStartedAt;
  }
  if (message.intermediateSteps) metadata.intermediateSteps = message.intermediateSteps;
  if (message.stepGroups) metadata.stepGroups = message.stepGroups;
  if (message.isStepsPlaceholder !== void 0) {
    metadata.isStepsPlaceholder = message.isStepsPlaceholder;
  }
  if (message.modelName) metadata.modelName = message.modelName;
  return Object.keys(metadata).length > 0 ? metadata : null;
}
async function loadPersistedMessages(executor, userId, conversationId) {
  const messageRows = await executor.select().from(messages).where(
    and2(
      eq3(messages.userId, userId),
      eq3(messages.conversationId, conversationId),
      isNull2(messages.deletedAt)
    )
  ).orderBy(asc(messages.sequence));
  const messageIds = messageRows.map((row) => row.id);
  const attachmentRows = messageIds.length === 0 ? [] : await executor.select().from(attachments).where(
    and2(
      eq3(attachments.userId, userId),
      inArray(attachments.messageId, messageIds),
      isNull2(attachments.deletedAt)
    )
  );
  const attachmentsByMessage = /* @__PURE__ */ new Map();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }
  return messageRows.map((message) => {
    const metadata = message.metadata ?? {};
    return {
      id: publicId(userId, message.id),
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
      timestamp: message.sentAt.getTime(),
      attachments: (attachmentsByMessage.get(message.id) ?? []).map(
        (attachment) => ({
          id: publicId(userId, attachment.id),
          type: attachment.kind,
          name: attachment.fileName,
          ...attachment.upstreamFileId ? { fileId: attachment.upstreamFileId } : {}
        })
      ),
      ...metadata.outputFiles ? { outputFiles: metadata.outputFiles } : {},
      ...metadata.inlineImages ? { inlineImages: metadata.inlineImages } : {},
      ...metadata.elapsedTime !== void 0 ? { elapsedTime: metadata.elapsedTime } : {},
      ...metadata.responseStartedAt !== void 0 ? { responseStartedAt: metadata.responseStartedAt } : {},
      ...metadata.intermediateSteps ? { intermediateSteps: metadata.intermediateSteps } : {},
      ...metadata.stepGroups ? { stepGroups: metadata.stepGroups } : {},
      ...metadata.isStepsPlaceholder !== void 0 ? { isStepsPlaceholder: metadata.isStepsPlaceholder } : {},
      ...metadata.modelName ? { modelName: metadata.modelName } : {}
    };
  });
}
function splitMessageTurns(messagesToSplit) {
  const prelude = [];
  const turns = [];
  let currentTurn = null;
  for (const message of messagesToSplit) {
    if (message.role === "user") {
      currentTurn = { user: message, assistants: [] };
      turns.push(currentTurn);
    } else if (currentTurn) {
      currentTurn.assistants.push(message);
    } else {
      prelude.push(message);
    }
  }
  return { prelude, turns };
}
function assistantProjectionScore(projected) {
  const hasConcreteResult = projected.some((message) => !message.isStepsPlaceholder);
  return projected.reduce((score, message) => {
    if (message.isStepsPlaceholder) return score + 1;
    return score + message.content.length + (message.outputFiles?.length ?? 0) * 1e4 + (message.inlineImages?.length ?? 0) * 1e4 + (message.stepGroups?.length ?? 0) * 1e3 + (message.intermediateSteps?.length ?? 0) * 100;
  }, hasConcreteResult ? 1e9 : 0);
}
function mergeConversationMessages(persisted, incoming, deletedMessageIds) {
  const deleted = new Set(deletedMessageIds);
  const persistedSplit = splitMessageTurns(persisted);
  const incomingSplit = splitMessageTurns(incoming);
  const prelude = /* @__PURE__ */ new Map();
  for (const message of persistedSplit.prelude) prelude.set(message.id, message);
  for (const message of incomingSplit.prelude) prelude.set(message.id, message);
  const turns = /* @__PURE__ */ new Map();
  for (const turn of persistedSplit.turns) turns.set(turn.user.id, turn);
  for (const turn of incomingSplit.turns) {
    const persistedTurn = turns.get(turn.user.id);
    if (!persistedTurn) {
      turns.set(turn.user.id, turn);
      continue;
    }
    if (assistantProjectionScore(turn.assistants) > assistantProjectionScore(persistedTurn.assistants)) {
      turns.set(turn.user.id, {
        user: persistedTurn.user,
        assistants: turn.assistants
      });
    }
  }
  const mergedPrelude = Array.from(prelude.values()).filter((message) => !deleted.has(message.id)).sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const mergedTurns = Array.from(turns.values()).filter((turn) => !deleted.has(turn.user.id)).sort(
    (left, right) => left.user.timestamp - right.user.timestamp || left.user.id.localeCompare(right.user.id)
  );
  return [
    ...mergedPrelude,
    ...mergedTurns.flatMap((turn) => [
      turn.user,
      ...turn.assistants.filter((message) => !deleted.has(message.id))
    ])
  ];
}
async function persistSnapshot(executor, userId, snapshot, options = {}) {
  const persistedConversationId = storageId(userId, snapshot.id);
  const existingRows = await executor.select().from(conversations).where(eq3(conversations.id, persistedConversationId)).limit(1).for("update");
  const existing = existingRows[0];
  if (existing && existing.userId !== userId) {
    throw new TRPCError3({ code: "FORBIDDEN", message: "\u4F1A\u8BDD ID \u5DF2\u5C5E\u4E8E\u5176\u4ED6\u8D26\u53F7" });
  }
  if (existing?.deletedAt) {
    if (options.skipExisting) return "skipped";
    throw new TRPCError3({ code: "NOT_FOUND", message: "\u4F1A\u8BDD\u5DF2\u5220\u9664" });
  }
  if (existing && options.skipExisting) return "skipped";
  if (existing) {
    const deletedMessageIds = Array.from(
      /* @__PURE__ */ new Set([
        ...existing.deletedMessageIds,
        ...snapshot.deletedMessageIds ?? []
      ])
    );
    const persistedMessages = await loadPersistedMessages(
      executor,
      userId,
      persistedConversationId
    );
    snapshot = {
      ...snapshot,
      messages: mergeConversationMessages(
        persistedMessages,
        snapshot.messages,
        deletedMessageIds
      ),
      taskId: snapshot.taskId ?? existing.upstreamTaskId ?? void 0,
      previousResponseId: snapshot.previousResponseId ?? existing.previousResponseId ?? void 0,
      taskUrl: snapshot.taskUrl ?? existing.taskUrl ?? void 0,
      startedAt: snapshot.startedAt ?? existing.startedAt?.getTime(),
      completedAt: snapshot.completedAt ?? existing.completedAt?.getTime(),
      lastKnownOutputLength: Math.max(
        snapshot.lastKnownOutputLength ?? 0,
        existing.lastKnownOutputLength
      ),
      deletedMessageIds,
      createdAt: existing.createdAt.getTime(),
      // Server arrival order determines scalar-field precedence; message turns
      // are merged above, so device clock skew cannot erase another turn.
      updatedAt: Date.now()
    };
  }
  const apiCredentialId = existing?.apiCredentialId ?? options.importCredentialId ?? await getActiveCredentialId(executor, userId) ?? null;
  const hasUpstreamResources = Boolean(snapshot.taskId) || snapshot.messages.some(
    (message) => message.attachments?.some((attachment) => Boolean(attachment.fileId))
  );
  if (hasUpstreamResources && !apiCredentialId) {
    throw new TRPCError3({
      code: "PRECONDITION_FAILED",
      message: "\u8BF7\u5148\u8FC1\u79FB\u6216\u914D\u7F6E\u8BE5\u4F1A\u8BDD\u539F\u6765\u4F7F\u7528\u7684 API Key\uFF0C\u518D\u5BFC\u5165\u5386\u53F2\u4F1A\u8BDD"
    });
  }
  if (hasUpstreamResources && apiCredentialId) {
    const credentialRows = await executor.select({ status: apiCredentials.status }).from(apiCredentials).where(
      and2(
        eq3(apiCredentials.id, apiCredentialId),
        eq3(apiCredentials.userId, userId)
      )
    ).limit(1);
    const credential = credentialRows[0];
    if (!credential || credential.status === "deleted") {
      throw new TRPCError3({
        code: "PRECONDITION_FAILED",
        message: "\u8BE5\u4F1A\u8BDD\u539F\u6765\u4F7F\u7528\u7684 API Key \u5DF2\u4E0D\u53EF\u7528"
      });
    }
  }
  const conversationValues = {
    userId,
    apiCredentialId,
    title: snapshot.title,
    status: snapshot.status,
    upstreamTaskId: snapshot.taskId ?? null,
    previousResponseId: snapshot.previousResponseId ?? null,
    taskUrl: snapshot.taskUrl ?? null,
    lastKnownOutputLength: snapshot.lastKnownOutputLength ?? 0,
    deletedMessageIds: snapshot.deletedMessageIds ?? [],
    startedAt: asDate(snapshot.startedAt),
    completedAt: asDate(snapshot.completedAt),
    createdAt: asDate(snapshot.createdAt) ?? /* @__PURE__ */ new Date(),
    updatedAt: asDate(snapshot.updatedAt) ?? /* @__PURE__ */ new Date()
  };
  if (existing) {
    await executor.update(conversations).set({ ...conversationValues, version: existing.version + 1 }).where(
      and2(
        eq3(conversations.id, persistedConversationId),
        eq3(conversations.userId, userId)
      )
    );
  } else {
    await executor.insert(conversations).values({
      id: persistedConversationId,
      ...conversationValues,
      version: 1
    });
  }
  const incomingMessageIds = snapshot.messages.map((message) => storageId(userId, message.id));
  if (incomingMessageIds.length > 0) {
    const collisions = await executor.select({ id: messages.id, conversationId: messages.conversationId, userId: messages.userId }).from(messages).where(inArray(messages.id, incomingMessageIds));
    if (collisions.some(
      (row) => row.userId !== userId || row.conversationId !== persistedConversationId
    )) {
      throw new TRPCError3({ code: "CONFLICT", message: "\u6D88\u606F ID \u4E0E\u5176\u4ED6\u4F1A\u8BDD\u51B2\u7A81" });
    }
  }
  await executor.delete(messages).where(eq3(messages.conversationId, persistedConversationId));
  for (let sequence = 0; sequence < snapshot.messages.length; sequence += 1) {
    const message = snapshot.messages[sequence];
    const sentAt = asDate(message.timestamp) ?? /* @__PURE__ */ new Date();
    await executor.insert(messages).values({
      id: storageId(userId, message.id),
      conversationId: persistedConversationId,
      userId,
      role: message.role,
      content: message.content,
      sequence,
      metadata: buildMessageMetadata(message),
      sentAt,
      createdAt: sentAt
    });
    for (const attachment of message.attachments ?? []) {
      await executor.insert(attachments).values({
        id: storageId(userId, attachment.id),
        userId,
        conversationId: persistedConversationId,
        messageId: storageId(userId, message.id),
        apiCredentialId,
        kind: attachment.type,
        fileName: attachment.name,
        upstreamFileId: attachment.fileId ?? null
      });
      if (attachment.fileId && apiCredentialId) {
        await persistResource(executor, {
          userId,
          apiCredentialId,
          kind: "file",
          upstreamId: attachment.fileId,
          conversationId: persistedConversationId
        }, options.validatedResourceKeys);
      }
    }
  }
  if (snapshot.taskId && apiCredentialId) {
    await persistResource(executor, {
      userId,
      apiCredentialId,
      kind: "task",
      upstreamId: snapshot.taskId,
      conversationId: persistedConversationId
    }, options.validatedResourceKeys);
  }
  return existing ? "updated" : "imported";
}
async function validateWithBoundedConcurrency(resources, apiKey) {
  if (resources.length === 0) return;
  const abortController = new AbortController();
  const signal = AbortSignal.any([
    abortController.signal,
    AbortSignal.timeout(LEGACY_IMPORT_VALIDATION_TIMEOUT_MS)
  ]);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < resources.length) {
      const resource = resources[nextIndex];
      nextIndex += 1;
      await validateUpstreamResourceAccess(
        apiKey,
        resource.kind,
        resource.id,
        fetch,
        signal
      );
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(LEGACY_IMPORT_VALIDATION_CONCURRENCY, resources.length) },
        () => worker()
      )
    );
  } catch (error) {
    abortController.abort();
    throw error;
  }
}
async function prepareLegacyImport(userId, snapshots) {
  const db = requireDb2(await getDb());
  const persistedIds = snapshots.map((snapshot) => storageId(userId, snapshot.id));
  const existingRows = persistedIds.length === 0 ? [] : await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.id, persistedIds));
  const existingIds = new Set(existingRows.map((row) => row.id));
  const newSnapshots = snapshots.filter(
    (snapshot) => !existingIds.has(storageId(userId, snapshot.id))
  );
  const resources = collectSnapshotResourceRefs(newSnapshots);
  if (resources.length === 0) {
    return { credentialId: void 0, validatedResourceKeys: /* @__PURE__ */ new Set() };
  }
  const taskIds = resources.filter((item) => item.kind === "task").map((item) => item.id);
  const fileIds = resources.filter((item) => item.kind === "file").map((item) => item.id);
  const [knownTasks, knownFiles] = await Promise.all([
    taskIds.length === 0 ? [] : db.select({
      kind: upstreamResources.kind,
      upstreamId: upstreamResources.upstreamId,
      userId: upstreamResources.userId
    }).from(upstreamResources).where(
      and2(
        eq3(upstreamResources.kind, "task"),
        inArray(upstreamResources.upstreamId, taskIds)
      )
    ),
    fileIds.length === 0 ? [] : db.select({
      kind: upstreamResources.kind,
      upstreamId: upstreamResources.upstreamId,
      userId: upstreamResources.userId
    }).from(upstreamResources).where(
      and2(
        eq3(upstreamResources.kind, "file"),
        inArray(upstreamResources.upstreamId, fileIds)
      )
    )
  ]);
  const known = /* @__PURE__ */ new Set();
  for (const resource of [...knownTasks, ...knownFiles]) {
    if (resource.userId !== userId) {
      throw new TRPCError3({
        code: "FORBIDDEN",
        message: "\u5386\u53F2\u4EFB\u52A1\u6216\u6587\u4EF6\u5DF2\u5C5E\u4E8E\u5176\u4ED6\u8D26\u53F7"
      });
    }
    known.add(upstreamResourceKey(resource.kind, resource.upstreamId));
  }
  const unknown = resources.filter(
    (resource) => !known.has(upstreamResourceKey(resource.kind, resource.id))
  );
  const credential = await getDecryptedCredentialForUser(userId);
  if (!credential) {
    throw new TRPCError3({
      code: "PRECONDITION_FAILED",
      message: "\u8BF7\u5148\u8FC1\u79FB\u6216\u914D\u7F6E\u8BE5\u4F1A\u8BDD\u539F\u6765\u4F7F\u7528\u7684 API Key\uFF0C\u518D\u5BFC\u5165\u5386\u53F2\u4F1A\u8BDD"
    });
  }
  await validateWithBoundedConcurrency(unknown, credential.apiKey);
  return {
    credentialId: credential.id,
    validatedResourceKeys: new Set(
      unknown.map((resource) => upstreamResourceKey(resource.kind, resource.id))
    )
  };
}
async function listSnapshots(userId) {
  const db = requireDb2(await getDb());
  const conversationRows = await db.select().from(conversations).where(and2(eq3(conversations.userId, userId), isNull2(conversations.deletedAt))).orderBy(desc2(conversations.updatedAt));
  if (conversationRows.length === 0) return [];
  const ids = conversationRows.map((row) => row.id);
  const messageRows = await db.select().from(messages).where(
    and2(
      eq3(messages.userId, userId),
      inArray(messages.conversationId, ids),
      isNull2(messages.deletedAt)
    )
  ).orderBy(asc(messages.sequence));
  const messageIds = messageRows.map((row) => row.id);
  const attachmentRows = messageIds.length === 0 ? [] : await db.select().from(attachments).where(
    and2(
      eq3(attachments.userId, userId),
      inArray(attachments.messageId, messageIds),
      isNull2(attachments.deletedAt)
    )
  );
  const attachmentsByMessage = /* @__PURE__ */ new Map();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }
  const messagesByConversation = /* @__PURE__ */ new Map();
  for (const message of messageRows) {
    const current = messagesByConversation.get(message.conversationId) ?? [];
    current.push(message);
    messagesByConversation.set(message.conversationId, current);
  }
  return conversationRows.map((row) => ({
    id: publicId(userId, row.id),
    title: row.title,
    messages: (messagesByConversation.get(row.id) ?? []).map((message) => {
      const metadata = message.metadata ?? {};
      return {
        id: publicId(userId, message.id),
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        timestamp: message.sentAt.getTime(),
        attachments: (attachmentsByMessage.get(message.id) ?? []).map((attachment) => ({
          id: publicId(userId, attachment.id),
          type: attachment.kind,
          name: attachment.fileName,
          ...attachment.upstreamFileId ? { fileId: attachment.upstreamFileId } : {}
        })),
        ...metadata.outputFiles ? { outputFiles: metadata.outputFiles } : {},
        ...metadata.inlineImages ? { inlineImages: metadata.inlineImages } : {},
        ...metadata.elapsedTime !== void 0 ? { elapsedTime: metadata.elapsedTime } : {},
        ...metadata.responseStartedAt !== void 0 ? { responseStartedAt: metadata.responseStartedAt } : {},
        ...metadata.intermediateSteps ? { intermediateSteps: metadata.intermediateSteps } : {},
        ...metadata.stepGroups ? { stepGroups: metadata.stepGroups } : {},
        ...metadata.isStepsPlaceholder !== void 0 ? { isStepsPlaceholder: metadata.isStepsPlaceholder } : {},
        ...metadata.modelName ? { modelName: metadata.modelName } : {}
      };
    }),
    ...row.upstreamTaskId ? { taskId: row.upstreamTaskId } : {},
    ...row.previousResponseId ? { previousResponseId: row.previousResponseId } : {},
    status: row.status === "archived" ? "completed" : row.status,
    ...row.taskUrl ? { taskUrl: row.taskUrl } : {},
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...row.startedAt ? { startedAt: row.startedAt.getTime() } : {},
    ...row.completedAt ? { completedAt: row.completedAt.getTime() } : {},
    lastKnownOutputLength: row.lastKnownOutputLength,
    deletedMessageIds: row.deletedMessageIds
  }));
}
var conversationRouter = router({
  list: protectedProcedure.query(({ ctx }) => listSnapshots(ctx.user.id)),
  syncSnapshot: protectedProcedure.input(z3.object({ conversation: conversationSnapshotSchema })).mutation(async ({ ctx, input }) => {
    const db = requireDb2(await getDb());
    await db.transaction(async (tx) => {
      await persistSnapshot(tx, ctx.user.id, input.conversation);
    });
    const snapshots = await listSnapshots(ctx.user.id);
    const persisted = snapshots.find((item) => item.id === input.conversation.id);
    if (!persisted) {
      throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: "\u4F1A\u8BDD\u4FDD\u5B58\u5931\u8D25" });
    }
    return persisted;
  }),
  delete: protectedProcedure.input(z3.object({ id: z3.string().min(1).max(128) })).mutation(async ({ ctx, input }) => {
    const db = requireDb2(await getDb());
    const persistedConversationId = storageId(ctx.user.id, input.id);
    const existing = await db.select({ userId: conversations.userId }).from(conversations).where(eq3(conversations.id, persistedConversationId)).limit(1);
    if (!existing[0] || existing[0].userId !== ctx.user.id) {
      throw new TRPCError3({ code: "NOT_FOUND", message: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" });
    }
    await permanentlyDeleteConversation(
      db,
      ctx.user.id,
      persistedConversationId
    );
    return { success: true };
  }),
  importLocal: protectedProcedure.input(z3.object({ conversations: z3.array(conversationSnapshotSchema).max(200) })).mutation(async ({ ctx, input }) => {
    const db = requireDb2(await getDb());
    const prepared = await prepareLegacyImport(ctx.user.id, input.conversations);
    let imported = 0;
    let skipped = 0;
    for (const conversation of input.conversations) {
      const result = await db.transaction(
        (tx) => persistSnapshot(tx, ctx.user.id, conversation, {
          skipExisting: true,
          importCredentialId: prepared.credentialId,
          validatedResourceKeys: prepared.validatedResourceKeys
        })
      );
      if (result === "imported") imported += 1;
      else skipped += 1;
    }
    return { imported, skipped };
  })
});

// server/credential-router.ts
import { z as z4 } from "zod";
var apiKeyInput = z4.object({
  apiKey: z4.string().trim().min(8, "API Key is too short").max(4096)
});
var testApiKeyInput = z4.object({
  apiKey: z4.string().trim().min(8, "API Key is too short").max(4096).optional()
});
async function saveCredential(userId, apiKey) {
  try {
    return await replaceApiCredential(userId, apiKey);
  } catch (error) {
    throw toTrpcError(error);
  }
}
var credentialRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await getApiCredentialStatus(ctx.user.id);
    } catch (error) {
      throw toTrpcError(error);
    }
  }),
  set: protectedProcedure.input(apiKeyInput).mutation(({ ctx, input }) => saveCredential(ctx.user.id, input.apiKey)),
  replace: protectedProcedure.input(apiKeyInput).mutation(({ ctx, input }) => saveCredential(ctx.user.id, input.apiKey)),
  test: protectedProcedure.input(testApiKeyInput).mutation(async ({ ctx, input }) => {
    try {
      const savedCredential = input.apiKey ? null : await getDecryptedCredentialForUser(ctx.user.id);
      const apiKey = input.apiKey ?? savedCredential?.apiKey;
      if (!apiKey) {
        throw new AuthServiceError("NOT_FOUND", "\u8BF7\u5148\u586B\u5199\u6216\u4FDD\u5B58 API Key");
      }
      await validateUpstreamApiKey(apiKey);
      return { ok: true };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),
  delete: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await deleteActiveApiCredential(ctx.user.id);
      return { success: true };
    } catch (error) {
      throw toTrpcError(error);
    }
  })
});

// server/_core/systemRouter.ts
import { z as z5 } from "zod";

// server/_core/notification.ts
import { TRPCError as TRPCError4 } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError4({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError4({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z5.object({
      timestamp: z5.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z5.object({
      title: z5.string().min(1, "title is required"),
      content: z5.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
var appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  credential: credentialRouter,
  conversation: conversationRouter
});

// server/_core/context.ts
async function createContext(opts) {
  const user = await authenticateRequest(opts.req);
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".frontmind-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginFrontMindDebugCollector() {
  return {
    name: "frontmind-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__frontmind__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__frontmind__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
function vitePluginFrontMindBuildVersion(buildVersion) {
  return {
    name: "frontmind-build-version",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "__frontmind__/version.json",
        source: `${JSON.stringify({ version: buildVersion })}
`
      });
    }
  };
}
var vite_config_default = defineConfig(({ mode }) => {
  const isProduction = mode === "production";
  const buildVersion = process.env.FRONTMIND_BUILD_VERSION?.trim() || `${Date.now()}`;
  const plugins = [
    react(),
    tailwindcss(),
    vitePluginFrontMindBuildVersion(buildVersion),
    !isProduction && jsxLocPlugin(),
    !isProduction && vitePluginFrontMindDebugCollector()
  ].filter(Boolean);
  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets")
      }
    },
    define: {
      __FRONTMIND_BUILD_VERSION__: JSON.stringify(buildVersion)
    },
    envDir: path.resolve(import.meta.dirname),
    root: path.resolve(import.meta.dirname, "client"),
    publicDir: path.resolve(import.meta.dirname, "client", "public"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true
    },
    server: {
      host: true,
      allowedHosts: ["localhost", "127.0.0.1"],
      fs: {
        strict: true,
        deny: ["**/.*"]
      }
    }
  };
});

// server/_core/vite.ts
function resolveViteConfig() {
  if (typeof vite_config_default === "function") {
    return vite_config_default({ command: "serve", mode: "development" });
  }
  return vite_config_default;
}
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...resolveViteConfig(),
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.get("/__frontmind__/version.json", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path2.resolve(distPath, "__frontmind__", "version.json"));
  });
  app.use(
    "/assets",
    express.static(path2.resolve(distPath, "assets"), {
      maxAge: "1y",
      immutable: true
    })
  );
  app.use(
    express.static(distPath, {
      maxAge: "1h",
      // Exclude index.html from static serving - we handle it separately below
      index: false
    })
  );
  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/manus-proxy.ts
import { Router } from "express";
import axios2 from "axios";
import zlib from "zlib";
import { randomUUID as randomUUID3 } from "crypto";

// server/_core/safe-external-url.ts
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
var ExternalUrlRejectedError = class extends Error {
};
function isBlockedIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  const [a, b, c] = parts;
  return parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 192 && b === 0 && c === 0 || a === 198 && (b === 18 || b === 19) || a >= 224;
}
function isBlockedNetworkAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return normalized === "::" || normalized === "::1" || normalized.startsWith("::") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe") || normalized.startsWith("ff");
}
function assertSafeHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal" || host === "metadata.google.internal" || net.isIP(host) > 0 && isBlockedNetworkAddress(host)) {
    throw new ExternalUrlRejectedError("Blocked external URL host");
  }
}
function assertSafeExternalUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ExternalUrlRejectedError("Invalid external URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ExternalUrlRejectedError("Unsupported external URL protocol");
  }
  if (parsed.username || parsed.password) {
    throw new ExternalUrlRejectedError("Credentials are not allowed in external URLs");
  }
  assertSafeHostname(parsed.hostname);
  return parsed.toString();
}
var safeLookup = ((hostname, options, callback) => {
  const requestedFamily = typeof options === "number" ? options : options?.family ?? 0;
  const returnAll = typeof options === "object" && Boolean(options?.all);
  try {
    assertSafeHostname(hostname);
  } catch (error) {
    callback(error);
    return;
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (addresses.length === 0 || addresses.some((result) => isBlockedNetworkAddress(result.address))) {
      callback(new ExternalUrlRejectedError("External hostname resolved to a blocked address"));
      return;
    }
    const matching = requestedFamily ? addresses.filter((result) => result.family === requestedFamily) : addresses;
    if (matching.length === 0) {
      callback(new ExternalUrlRejectedError("External hostname has no usable address"));
      return;
    }
    if (returnAll) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  });
});
var httpAgent = new http.Agent({ keepAlive: true, lookup: safeLookup });
var httpsAgent = new https.Agent({ keepAlive: true, lookup: safeLookup });
function beforeRedirect(options) {
  const protocol = String(options.protocol ?? "");
  const hostname = String(options.hostname ?? "");
  if (protocol !== "http:" && protocol !== "https:") {
    throw new ExternalUrlRejectedError("Blocked redirect protocol");
  }
  if (options.auth) {
    throw new ExternalUrlRejectedError("Blocked redirect credentials");
  }
  assertSafeHostname(hostname);
}
var safeExternalRequestOptions = {
  httpAgent,
  httpsAgent,
  // Axios otherwise honors HTTP(S)_PROXY. That would move DNS resolution to
  // the proxy and bypass the private-address checks in safeLookup.
  proxy: false,
  maxRedirects: 3,
  beforeRedirect
};

// server/prepared-file-service.ts
import axios from "axios";
import { createHash as createHash2 } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs3 from "node:fs/promises";
import path3 from "node:path";
import { Worker } from "node:worker_threads";
var THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
var FIVE_MINUTES_MS = 5 * 60 * 1e3;
var FIVE_GIB = 5 * 1024 * 1024 * 1024;
var DISK_CHECK_INTERVAL_BYTES = 64 * 1024 * 1024;
var DEFAULT_LARGE_PDF_THRESHOLD_BYTES = 64 * 1024 * 1024;
var PreparedFileError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PreparedFileError";
  }
};
function normalizeFilename(filename) {
  const safe = String(filename || "document.pdf").replace(/[\\/\0]/g, "_").trim();
  const withExtension = safe.toLowerCase().endsWith(".pdf") ? safe : `${safe || "document"}.pdf`;
  return withExtension || "document.pdf";
}
function stableExternalIdentity(url) {
  const parsed = new URL(url);
  const ephemeralNames = /* @__PURE__ */ new Set([
    "accesskeyid",
    "credential",
    "expires",
    "googleaccessid",
    "key-pair-id",
    "policy",
    "security-token",
    "signature",
    "token"
  ]);
  const stableParameters = [...parsed.searchParams.entries()].filter(([name]) => {
    const lower = name.toLowerCase();
    return !ephemeralNames.has(lower) && !lower.startsWith("x-amz-") && !lower.startsWith("x-goog-") && !lower.startsWith("x-oss-");
  }).sort(
    ([leftName, leftValue], [rightName, rightValue]) => leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
  );
  const stableQuery = new URLSearchParams(stableParameters).toString();
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${stableQuery ? `?${stableQuery}` : ""}`;
}
function createPreparedAssetId(ownerUserId, credentialId, source) {
  const sourceIdentity = source.kind === "file" ? `file:${source.fileId}` : `external:${stableExternalIdentity(source.url)}`;
  return createHash2("sha256").update(`frontmind-pdf-v1\0${ownerUserId}\0${credentialId}\0${sourceIdentity}`).digest("hex").slice(0, 40);
}
function publicStatus(manifest) {
  return {
    assetId: manifest.id,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    status: manifest.status,
    phase: manifest.phase,
    size: manifest.size,
    sourceBytes: manifest.sourceBytes,
    pageCount: manifest.pageCount,
    errorCode: manifest.errorCode,
    errorMessage: manifest.errorMessage,
    retryAfterMs: manifest.status === "queued" || manifest.status === "processing" ? 2e3 : void 0,
    contentUrl: `/api/frontmind/assets/${manifest.id}/content`,
    downloadTokenUrl: `/api/frontmind/assets/${manifest.id}/download-token`
  };
}
function finitePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
async function fileExists(filePath) {
  try {
    await fs3.access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function pathSize(targetPath) {
  try {
    const stat = await fs3.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs3.readdir(targetPath);
    let total = 0;
    for (const entry of entries) {
      total += await pathSize(path3.join(targetPath, entry));
    }
    return total;
  } catch {
    return 0;
  }
}
async function commandAvailable(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash2("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
var PreparedFileService = class {
  constructor(rootDir) {
    this.manifests = /* @__PURE__ */ new Map();
    this.queue = [];
    this.queued = /* @__PURE__ */ new Set();
    this.active = /* @__PURE__ */ new Set();
    this.manifestWrites = /* @__PURE__ */ new Map();
    this.initPromise = null;
    this.processing = 0;
    this.cleanupTimer = null;
    this.rootDir = rootDir || process.env.FRONTMIND_PREPARED_FILE_DIR || (process.env.NODE_ENV === "production" ? "/var/lib/frontmind/prepared-files" : path3.resolve(process.cwd(), ".frontmind-prepared-files"));
    this.workerConcurrency = finitePositiveInteger(
      process.env.FRONTMIND_PDF_WORKERS,
      1
    );
    this.retentionMs = finitePositiveInteger(
      process.env.FRONTMIND_PREPARED_FILE_TTL_MS,
      THIRTY_DAYS_MS
    );
    this.largePdfThresholdBytes = finitePositiveInteger(
      process.env.FRONTMIND_LARGE_PDF_THRESHOLD_BYTES,
      DEFAULT_LARGE_PDF_THRESHOLD_BYTES
    );
  }
  async initialize() {
    if (!this.initPromise) {
      this.initPromise = this.initializeOnce();
    }
    return this.initPromise;
  }
  async initializeOnce() {
    await fs3.mkdir(this.rootDir, { recursive: true, mode: 448 });
    await fs3.chmod(this.rootDir, 448).catch(() => void 0);
    const tooling = await Promise.all([
      commandAvailable("pdfinfo", ["-v"]),
      commandAvailable("pdftotext", ["-v"]),
      commandAvailable("pdfseparate", ["-v"]),
      commandAvailable("pdfunite", ["-v"]),
      commandAvailable("gs", ["--version"])
    ]);
    if (tooling.some((available) => !available)) {
      throw new PreparedFileError(
        "PDF_TOOLING_UNAVAILABLE",
        "PDF \u670D\u52A1\u4F9D\u8D56\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u5B89\u88C5 poppler-utils \u4E0E ghostscript"
      );
    }
    const entries = await fs3.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path3.join(this.rootDir, entry.name);
      if (entry.isDirectory() && (entry.name.endsWith(".work") || entry.name.endsWith(".tmp-work"))) {
        await fs3.rm(fullPath, { recursive: true, force: true });
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith(".source.tmp") || entry.name.endsWith(".prepared.tmp") || entry.name.endsWith(".json.tmp"))) {
        await fs3.rm(fullPath, { force: true });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await fs3.readFile(fullPath, "utf8")
        );
        if (parsed.version !== 1 || !/^[a-f0-9]{40}$/.test(parsed.id) || parsed.id !== entry.name.slice(0, -5)) {
          continue;
        }
        if (parsed.status === "processing") {
          parsed.status = "queued";
          parsed.phase = "queued";
          parsed.updatedAt = Date.now();
          await this.persistManifest(parsed);
        }
        this.manifests.set(parsed.id, parsed);
        if (parsed.status === "queued") this.enqueue(parsed.id);
      } catch (error) {
        console.warn(
          `[PreparedFiles] Ignoring invalid manifest ${entry.name}`,
          error
        );
      }
    }
    await this.cleanup();
    this.cleanupTimer = setInterval(
      () => void this.cleanup(),
      24 * 60 * 60 * 1e3
    );
    this.cleanupTimer.unref();
  }
  async registerFile(input) {
    await this.initialize();
    const source = { kind: "file", fileId: input.fileId };
    return this.register({
      id: createPreparedAssetId(
        input.ownerUserId,
        input.credentialId,
        source
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      source,
      filename: normalizeFilename(input.filename)
    });
  }
  async registerExternal(input) {
    await this.initialize();
    const source = {
      kind: "external",
      url: assertSafeExternalUrl(input.url)
    };
    return this.register({
      id: createPreparedAssetId(
        input.ownerUserId,
        input.credentialId,
        source
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      source,
      filename: normalizeFilename(input.filename)
    });
  }
  async register(input) {
    const now = Date.now();
    const existing = this.manifests.get(input.id);
    if (existing) {
      existing.filename = input.filename;
      existing.lastAccessedAt = now;
      if (input.source.kind === "external") {
        existing.source = input.source;
      }
      if (existing.status === "failed" && existing.errorCode === "SOURCE_EXPIRED") {
        existing.status = "queued";
        existing.phase = "queued";
        delete existing.errorCode;
        delete existing.errorMessage;
        this.enqueue(existing.id);
      }
      await this.persistManifest(existing);
      return publicStatus(existing);
    }
    const manifest = {
      version: 1,
      id: input.id,
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      source: input.source,
      filename: input.filename,
      mimeType: "application/pdf",
      status: "queued",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now
    };
    this.manifests.set(manifest.id, manifest);
    await this.persistManifest(manifest);
    this.enqueue(manifest.id);
    return publicStatus(manifest);
  }
  async getStatus(assetId, ownerUserId) {
    const manifest = await this.requireOwned(assetId, ownerUserId);
    await this.touch(manifest);
    return publicStatus(manifest);
  }
  async getReadyManifest(assetId, ownerUserId) {
    const manifest = await this.requireOwned(assetId, ownerUserId);
    await this.touch(manifest);
    if (manifest.status !== "ready") return manifest;
    if (!await fileExists(this.pdfPath(assetId))) {
      manifest.status = "queued";
      manifest.phase = "queued";
      delete manifest.size;
      delete manifest.etag;
      await this.persistManifest(manifest);
      this.enqueue(assetId);
    }
    return manifest;
  }
  async retry(assetId, ownerUserId) {
    const manifest = await this.requireOwned(assetId, ownerUserId);
    if (manifest.status === "ready") return publicStatus(manifest);
    manifest.status = "queued";
    manifest.phase = "queued";
    manifest.updatedAt = Date.now();
    delete manifest.errorCode;
    delete manifest.errorMessage;
    await this.persistManifest(manifest);
    this.enqueue(assetId);
    return publicStatus(manifest);
  }
  contentPath(assetId) {
    return this.pdfPath(assetId);
  }
  beginUse(assetId) {
    this.active.add(assetId);
  }
  endUse(assetId) {
    this.active.delete(assetId);
  }
  async health() {
    await this.initialize();
    const stats = await fs3.statfs(this.rootDir);
    return {
      cacheDirectory: this.rootDir,
      availableBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      queueLength: this.queue.length,
      activeWorkers: this.processing
    };
  }
  async requireOwned(assetId, ownerUserId) {
    await this.initialize();
    if (!/^[a-f0-9]{40}$/.test(assetId)) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "\u6587\u4EF6\u4E0D\u5B58\u5728");
    }
    const manifest = this.manifests.get(assetId);
    if (!manifest || manifest.ownerUserId !== ownerUserId) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "\u6587\u4EF6\u4E0D\u5B58\u5728");
    }
    return manifest;
  }
  enqueue(assetId) {
    if (this.queued.has(assetId)) return;
    this.queued.add(assetId);
    this.queue.push(assetId);
    queueMicrotask(() => void this.drainQueue());
  }
  async drainQueue() {
    while (this.processing < this.workerConcurrency && this.queue.length > 0) {
      const assetId = this.queue.shift();
      if (!assetId) return;
      this.queued.delete(assetId);
      const manifest = this.manifests.get(assetId);
      if (!manifest || manifest.status !== "queued") continue;
      this.processing += 1;
      void this.processAsset(manifest).catch((error) => {
        console.error(
          `[PreparedFiles] Unhandled job error for ${manifest.id}`,
          error
        );
      }).finally(() => {
        this.processing -= 1;
        void this.drainQueue();
      });
    }
  }
  async processAsset(manifest) {
    const sourcePath = this.sourcePath(manifest.id);
    const preparedTempPath = this.preparedTempPath(manifest.id);
    const workDir = this.workPath(manifest.id);
    this.active.add(manifest.id);
    try {
      manifest.status = "processing";
      manifest.phase = "downloading";
      manifest.updatedAt = Date.now();
      delete manifest.errorCode;
      delete manifest.errorMessage;
      await this.persistManifest(manifest);
      await this.ensureDiskSpace();
      const sourceBytes = await this.downloadSource(
        manifest,
        sourcePath,
        async (downloadedBytes) => {
          manifest.sourceBytes = downloadedBytes;
          manifest.updatedAt = Date.now();
          await this.persistManifest(manifest);
        }
      );
      manifest.sourceBytes = sourceBytes;
      manifest.phase = "sanitizing";
      manifest.updatedAt = Date.now();
      await this.persistManifest(manifest);
      const result = await this.runWorker(
        manifest,
        sourcePath,
        preparedTempPath,
        workDir
      );
      manifest.phase = "optimizing";
      manifest.updatedAt = Date.now();
      await this.persistManifest(manifest);
      const outputStat = await fs3.stat(preparedTempPath);
      if (outputStat.size < 5) {
        throw new PreparedFileError(
          "INVALID_PDF",
          "\u5904\u7406\u540E\u7684 PDF \u6587\u4EF6\u4E3A\u7A7A"
        );
      }
      const handle = await fs3.open(preparedTempPath, "r");
      try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString("ascii") !== "%PDF-") {
          throw new PreparedFileError(
            "INVALID_PDF",
            "\u5904\u7406\u7ED3\u679C\u4E0D\u662F\u6709\u6548\u7684 PDF"
          );
        }
      } finally {
        await handle.close();
      }
      const etag = await hashFile(preparedTempPath);
      await fs3.rename(preparedTempPath, this.pdfPath(manifest.id));
      await fs3.chmod(this.pdfPath(manifest.id), 384).catch(() => void 0);
      manifest.status = "ready";
      manifest.phase = "ready";
      manifest.size = outputStat.size;
      manifest.pageCount = result.pageCount;
      manifest.etag = etag;
      manifest.updatedAt = Date.now();
      manifest.lastAccessedAt = Date.now();
      await this.persistManifest(manifest);
      await this.cleanup();
    } catch (error) {
      const preparedError = error instanceof PreparedFileError ? error : new PreparedFileError(
        "PDF_PREPARATION_FAILED",
        error instanceof Error ? error.message : "PDF \u5904\u7406\u5931\u8D25"
      );
      manifest.status = "failed";
      manifest.phase = "failed";
      manifest.errorCode = preparedError.code;
      manifest.errorMessage = preparedError.message;
      manifest.updatedAt = Date.now();
      await this.persistManifest(manifest);
      console.error(
        `[PreparedFiles] Failed to prepare ${manifest.id}: ${preparedError.code} ${preparedError.message}`
      );
    } finally {
      this.active.delete(manifest.id);
      await fs3.rm(sourcePath, { force: true }).catch(() => void 0);
      await fs3.rm(preparedTempPath, { force: true }).catch(() => void 0);
      await fs3.rm(workDir, { recursive: true, force: true }).catch(
        () => void 0
      );
    }
  }
  async downloadSource(manifest, destination, persistProgress) {
    let sourceUrl;
    let headers;
    if (manifest.source.kind === "file") {
      const credential = await getCredentialForUpstreamResource(
        manifest.ownerUserId,
        "file",
        manifest.source.fileId
      );
      if (!credential || credential.id !== manifest.credentialId) {
        throw new PreparedFileError(
          "SOURCE_FORBIDDEN",
          "\u6587\u4EF6\u6240\u5C5E API Key \u5DF2\u5220\u9664\u6216\u4E0D\u53EF\u7528"
        );
      }
      const baseUrl = getUpstreamBaseUrl();
      const metadataResponse = await axios.get(
        `${baseUrl}/v1/files/${encodeURIComponent(manifest.source.fileId)}`,
        {
          headers: {
            API_KEY: credential.apiKey,
            Authorization: `Bearer ${credential.apiKey}`
          },
          timeout: FIVE_MINUTES_MS,
          validateStatus: () => true
        }
      );
      if (metadataResponse.status !== 200) {
        throw new PreparedFileError(
          metadataResponse.status === 404 ? "SOURCE_NOT_FOUND" : "SOURCE_METADATA_FAILED",
          `\u83B7\u53D6\u6587\u4EF6\u4FE1\u606F\u5931\u8D25 (${metadataResponse.status})`
        );
      }
      if (metadataResponse.data?.filename) {
        manifest.filename = normalizeFilename(metadataResponse.data.filename);
      }
      if (!metadataResponse.data?.upload_url) {
        sourceUrl = `${baseUrl}/v1/files/${encodeURIComponent(
          manifest.source.fileId
        )}/content`;
        headers = {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`
        };
      } else {
        sourceUrl = assertSafeExternalUrl(metadataResponse.data.upload_url);
      }
    } else {
      sourceUrl = assertSafeExternalUrl(manifest.source.url);
    }
    const controller = new AbortController();
    let lastProgressAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt >= FIVE_MINUTES_MS) {
        controller.abort(
          new PreparedFileError(
            "SOURCE_STALLED",
            "\u6587\u4EF6\u4E0B\u8F7D\u8FDE\u7EED 5 \u5206\u949F\u6CA1\u6709\u8FDB\u5C55"
          )
        );
      }
    }, 3e4);
    watchdog.unref();
    try {
      const response = await axios.get(sourceUrl, {
        ...safeExternalRequestOptions,
        headers,
        responseType: "stream",
        timeout: FIVE_MINUTES_MS,
        maxContentLength: Infinity,
        signal: controller.signal,
        validateStatus: () => true
      });
      if (response.status !== 200) {
        throw new PreparedFileError(
          response.status === 401 || response.status === 403 || response.status === 404 ? "SOURCE_EXPIRED" : "SOURCE_DOWNLOAD_FAILED",
          `\u4E0A\u6E38\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25 (${response.status})`
        );
      }
      const output = await fs3.open(destination, "w", 384);
      let total = 0;
      let nextDiskCheck = DISK_CHECK_INTERVAL_BYTES;
      let nextPersist = DISK_CHECK_INTERVAL_BYTES;
      try {
        for await (const rawChunk of response.data) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          await output.write(chunk);
          total += chunk.length;
          lastProgressAt = Date.now();
          if (total >= nextPersist) {
            await persistProgress(total);
            nextPersist = total + DISK_CHECK_INTERVAL_BYTES;
          }
          if (total >= nextDiskCheck) {
            await this.ensureDiskSpace();
            nextDiskCheck = total + DISK_CHECK_INTERVAL_BYTES;
          }
        }
      } finally {
        await output.close();
      }
      await persistProgress(total);
      return total;
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof PreparedFileError) throw reason;
        throw new PreparedFileError(
          "SOURCE_STALLED",
          "\u6587\u4EF6\u4E0B\u8F7D\u8FDE\u7EED 5 \u5206\u949F\u6CA1\u6709\u8FDB\u5C55"
        );
      }
      if (error instanceof PreparedFileError) throw error;
      throw new PreparedFileError(
        "SOURCE_DOWNLOAD_FAILED",
        error?.message || "\u4E0A\u6E38\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25"
      );
    } finally {
      clearInterval(watchdog);
    }
  }
  async runWorker(manifest, inputPath, outputPath, workDir) {
    await fs3.mkdir(workDir, { recursive: true, mode: 448 });
    const production = process.env.NODE_ENV === "production";
    const workerUrl = new URL(
      production ? "./pdf-prepare-worker.js" : "./pdf-prepare-worker-bootstrap.mjs",
      import.meta.url
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastProgressAt = Date.now();
      let lastProgressPersistedAt = 0;
      let checkingDisk = false;
      const worker = new Worker(workerUrl, {
        workerData: {
          inputPath,
          outputPath,
          workDir,
          largePdfThresholdBytes: this.largePdfThresholdBytes
        },
        execArgv: []
      });
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        callback();
      };
      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt >= FIVE_MINUTES_MS) {
          void worker.terminate();
          finish(
            () => reject(
              new PreparedFileError(
                "PDF_PROCESSING_STALLED",
                "PDF \u5904\u7406\u8FDE\u7EED 5 \u5206\u949F\u6CA1\u6709\u8FDB\u5C55"
              )
            )
          );
          return;
        }
        if (checkingDisk) return;
        checkingDisk = true;
        void this.ensureDiskSpace().catch((error) => {
          void worker.terminate();
          finish(
            () => reject(
              error instanceof PreparedFileError ? error : new PreparedFileError(
                "INSUFFICIENT_STORAGE",
                "\u670D\u52A1\u5668\u53EF\u7528\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u8BF7\u6E05\u7406\u7F13\u5B58\u540E\u91CD\u8BD5"
              )
            )
          );
        }).finally(() => {
          checkingDisk = false;
        });
      }, 3e4);
      watchdog.unref();
      worker.on("message", (message) => {
        lastProgressAt = Date.now();
        if (message.type === "progress") {
          manifest.phase = message.phase;
          manifest.updatedAt = Date.now();
          if (message.pageCount) manifest.pageCount = message.pageCount;
          if (Date.now() - lastProgressPersistedAt >= 1e3 || message.pageCount && message.page === message.pageCount) {
            lastProgressPersistedAt = Date.now();
            void this.persistManifest(manifest);
          }
          return;
        }
        if (message.type === "complete") {
          finish(() => resolve(message));
          return;
        }
        finish(
          () => reject(
            new PreparedFileError(
              message.code || "PDF_PREPARATION_FAILED",
              message.message
            )
          )
        );
      });
      worker.on("error", (error) => {
        finish(
          () => reject(
            new PreparedFileError(
              "PDF_WORKER_FAILED",
              error.message || "PDF Worker \u542F\u52A8\u5931\u8D25"
            )
          )
        );
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          finish(
            () => reject(
              new PreparedFileError(
                "PDF_WORKER_FAILED",
                `PDF Worker \u5F02\u5E38\u9000\u51FA (${code})`
              )
            )
          );
        }
      });
    });
  }
  async touch(manifest) {
    const now = Date.now();
    if (now - manifest.lastAccessedAt < 60 * 60 * 1e3) return;
    manifest.lastAccessedAt = now;
    await this.persistManifest(manifest);
  }
  persistManifest(manifest) {
    const destination = this.manifestPath(manifest.id);
    const temporary = `${destination}.tmp`;
    const snapshot = `${JSON.stringify(manifest)}
`;
    const previous = this.manifestWrites.get(manifest.id) || Promise.resolve();
    const operation = previous.catch(() => void 0).then(async () => {
      await fs3.writeFile(temporary, snapshot, {
        encoding: "utf8",
        mode: 384
      });
      await fs3.rename(temporary, destination);
    });
    this.manifestWrites.set(manifest.id, operation);
    return operation.finally(() => {
      if (this.manifestWrites.get(manifest.id) === operation) {
        this.manifestWrites.delete(manifest.id);
      }
    });
  }
  async ensureDiskSpace() {
    const stats = await fs3.statfs(this.rootDir);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
    const maximumCacheBytes = Math.min(
      Math.floor(totalBytes * 0.8),
      Math.max(0, totalBytes - reserveBytes)
    );
    const cacheBytes = await this.cacheSize();
    if (availableBytes >= reserveBytes && cacheBytes <= maximumCacheBytes) {
      return;
    }
    await this.cleanup();
    const refreshed = await fs3.statfs(this.rootDir);
    const refreshedAvailable = refreshed.bavail * refreshed.bsize;
    const refreshedCacheBytes = await this.cacheSize();
    if (refreshedAvailable < reserveBytes || refreshedCacheBytes > maximumCacheBytes) {
      throw new PreparedFileError(
        "INSUFFICIENT_STORAGE",
        "\u670D\u52A1\u5668\u53EF\u7528\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u8BF7\u6E05\u7406\u7F13\u5B58\u540E\u91CD\u8BD5"
      );
    }
  }
  async cleanup() {
    await fs3.mkdir(this.rootDir, { recursive: true, mode: 448 });
    const now = Date.now();
    const candidates = [...this.manifests.values()].filter((manifest) => !this.active.has(manifest.id)).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (const manifest of candidates) {
      if (now - manifest.lastAccessedAt <= this.retentionMs) continue;
      await this.deleteAsset(manifest.id);
    }
    const stats = await fs3.statfs(this.rootDir);
    const totalBytes = stats.blocks * stats.bsize;
    const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
    const maximumCacheBytes = Math.min(
      Math.floor(totalBytes * 0.8),
      Math.max(0, totalBytes - reserveBytes)
    );
    let cacheBytes = await this.cacheSize();
    let availableBytes = stats.bavail * stats.bsize;
    if (cacheBytes <= maximumCacheBytes && availableBytes >= reserveBytes) {
      return;
    }
    for (const manifest of candidates) {
      if (cacheBytes <= maximumCacheBytes && availableBytes >= reserveBytes) {
        break;
      }
      if (this.active.has(manifest.id) || manifest.status === "processing" || manifest.status === "queued") {
        continue;
      }
      const before = await this.assetSize(manifest.id);
      await this.deleteAsset(manifest.id);
      cacheBytes = Math.max(0, cacheBytes - before);
      const refreshed = await fs3.statfs(this.rootDir);
      availableBytes = refreshed.bavail * refreshed.bsize;
    }
  }
  async assetSize(assetId) {
    let size = 0;
    for (const filePath of [
      this.manifestPath(assetId),
      this.pdfPath(assetId),
      this.sourcePath(assetId),
      this.preparedTempPath(assetId),
      this.workPath(assetId)
    ]) {
      size += await pathSize(filePath);
    }
    return size;
  }
  async cacheSize() {
    return pathSize(this.rootDir);
  }
  async deleteAsset(assetId) {
    if (this.active.has(assetId)) return;
    this.manifests.delete(assetId);
    this.queued.delete(assetId);
    const queueIndex = this.queue.indexOf(assetId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    await Promise.all([
      fs3.rm(this.manifestPath(assetId), { force: true }),
      fs3.rm(this.pdfPath(assetId), { force: true }),
      fs3.rm(this.sourcePath(assetId), { force: true }),
      fs3.rm(this.preparedTempPath(assetId), { force: true }),
      fs3.rm(this.workPath(assetId), { recursive: true, force: true })
    ]);
  }
  manifestPath(assetId) {
    return path3.join(this.rootDir, `${assetId}.json`);
  }
  sourcePath(assetId) {
    return path3.join(this.rootDir, `${assetId}.source.tmp`);
  }
  preparedTempPath(assetId) {
    return path3.join(this.rootDir, `${assetId}.prepared.tmp`);
  }
  pdfPath(assetId) {
    return path3.join(this.rootDir, `${assetId}.pdf`);
  }
  workPath(assetId) {
    return path3.join(this.rootDir, `${assetId}.work`);
  }
};
var preparedFileService = new PreparedFileService();

// server/manus-proxy.ts
var router2 = Router();
var fileMetaCache = /* @__PURE__ */ new Map();
var CACHE_TTL = 10 * 60 * 1e3;
var downloadTokenCache = /* @__PURE__ */ new Map();
var DOWNLOAD_TOKEN_TTL = 5 * 60 * 1e3;
function safeUrlForLog(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 160);
  } catch {
    return "[invalid URL]";
  }
}
function cleanupExpiredDownloadTokens() {
  const now = Date.now();
  downloadTokenCache.forEach((data, token) => {
    if (now - data.createdAt > DOWNLOAD_TOKEN_TTL) {
      downloadTokenCache.delete(token);
    }
  });
}
function getCachedMeta(fileId) {
  const entry = fileMetaCache.get(fileId);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL) {
    return { upload_url: entry.upload_url, filename: entry.filename };
  }
  fileMetaCache.delete(fileId);
  return null;
}
function setCachedMeta(fileId, meta) {
  fileMetaCache.set(fileId, { ...meta, cachedAt: Date.now() });
}
function inferMimeType(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap = {
    pdf: "application/pdf",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    xml: "application/xml",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    js: "application/javascript",
    ts: "text/typescript",
    jsx: "text/jsx",
    tsx: "text/tsx",
    css: "text/css",
    py: "text/x-python",
    java: "text/x-java",
    c: "text/x-c",
    cpp: "text/x-c++",
    h: "text/x-c",
    // Images
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    // Archives
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
    // Documents
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Audio/Video
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm"
  };
  return mimeMap[ext] || "application/octet-stream";
}
function isTextBasedFile(filename, contentType) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const textExtensions = [
    "md",
    "markdown",
    "txt",
    "html",
    "htm",
    "json",
    "xml",
    "csv",
    "js",
    "ts",
    "jsx",
    "tsx",
    "css",
    "py",
    "java",
    "c",
    "cpp",
    "h",
    "svg",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "log",
    "sh",
    "bash",
    "zsh",
    "bat",
    "ps1",
    "rb",
    "php",
    "go",
    "rs",
    "swift",
    "kt",
    "scala",
    "r",
    "sql",
    "graphql",
    "proto"
  ];
  if (textExtensions.includes(ext)) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript") || ct.includes("markdown") || ct.includes("svg")) {
      return true;
    }
  }
  return false;
}
function isPdfFile(filename, contentType) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return true;
  if (contentType && contentType.toLowerCase().includes("application/pdf")) return true;
  return false;
}
function isPdfMagicBytes(data) {
  return data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-";
}
function getSourceBrandLower() {
  return ["ma", "nus"].join("");
}
function getSourceBrandTitle() {
  const lower = getSourceBrandLower();
  return lower[0].toUpperCase() + lower.slice(1);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sanitizeText(text2) {
  if (!text2 || typeof text2 !== "string") return text2 || "";
  try {
    const sourceLower = getSourceBrandLower();
    const sourceTitle = getSourceBrandTitle();
    const sourceUpper = sourceLower.toUpperCase();
    return text2.replace(new RegExp(`https?:\\/\\/api\\.${sourceLower}\\.`, "gi"), "https://api.frontmind.").replace(new RegExp(`https?:\\/\\/www\\.${sourceLower}\\.`, "gi"), "https://www.frontmind.").replace(new RegExp(`https?:\\/\\/${sourceLower}\\.`, "gi"), "https://frontmind.").replace(new RegExp(`\\b${escapeRegExp(sourceUpper)}\\b`, "g"), "FrontMind").replace(new RegExp(`\\b${escapeRegExp(sourceTitle)}\\b`, "g"), "FrontMind").replace(new RegExp(`\\b${escapeRegExp(sourceLower)}\\b`, "g"), "frontmind");
  } catch (e) {
    console.error("[sanitizeText] Error:", e);
    return text2;
  }
}
function sanitizeFilename(filename, fallback = "file") {
  const sanitized = sanitizeText(filename || fallback).replace(/[\\/\0]/g, "_").trim();
  return sanitized || fallback;
}
function setSafeContentDisposition(res, disposition, filename) {
  const safeFileName = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safeFileName);
  res.setHeader("content-disposition", `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`);
}
function hasUsableExtension(filename) {
  const last = filename.split(/[\/]/).pop() || filename;
  return /\.[A-Za-z0-9]{1,10}$/.test(last);
}
function ensureFilenameMatchesContent(filename, data, contentType) {
  const safe = sanitizeFilename(filename);
  const lower = safe.toLowerCase();
  if ((isPdfMagicBytes(data) || isPdfFile(safe, contentType)) && !lower.endsWith(".pdf")) {
    return hasUsableExtension(safe) ? safe.replace(/\.[^.\/]+$/, ".pdf") : `${safe}.pdf`;
  }
  return safe;
}
function normalizeContentTypeForBuffer(filename, data, contentType) {
  const ct = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
  if (isPdfMagicBytes(data) || isPdfFile(filename, contentType)) {
    return "application/pdf";
  }
  if (!ct || ct === "application/octet-stream" || ct === "binary/octet-stream") {
    return inferMimeType(filename);
  }
  return contentType || inferMimeType(filename);
}
var SANITIZE_SKIP_KEYS = /* @__PURE__ */ new Set([
  "id",
  "task_id",
  "file_id",
  "call_id",
  "response_id",
  "object",
  "upload_url",
  "upload_expires_at",
  "created_at",
  "updated_at",
  "url",
  "file_url",
  "fileUrl",
  "image_url",
  "imageUrl",
  "src",
  "href",
  "download_url",
  "api_key",
  "apiKey",
  "token",
  "authorization",
  "base64",
  "data",
  "hash",
  "checksum",
  "etag",
  "previous_response_id",
  "previousResponseId",
  "task_url",
  "share_url"
]);
function deepSanitizeJson(value, currentKey, depth = 0) {
  if (value === null || value === void 0) return value;
  if (depth > 50) return value;
  if (typeof value === "string") {
    if (currentKey && SANITIZE_SKIP_KEYS.has(currentKey)) {
      return value;
    }
    if (value.match(/^[a-zA-Z0-9_-]{8,}$/) && !value.includes(" ")) {
      return value;
    }
    if (value.length > 1e5) {
      return value;
    }
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepSanitizeJson(item, void 0, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepSanitizeJson(val, key, depth + 1);
    }
    return result;
  }
  return value;
}
function collectOutputFileIds(value, ids = /* @__PURE__ */ new Set(), currentKey, depth = 0) {
  if (value === null || value === void 0 || depth > 50) return ids;
  if (typeof value === "string") {
    if ((currentKey === "file_id" || currentKey === "fileId") && value) {
      ids.add(value);
    }
    if (currentKey === "url" || currentKey === "file_url" || currentKey === "fileUrl" || currentKey === "image_url" || currentKey === "imageUrl") {
      const match = value.match(/\/v1\/files\/([^/?#]+)/);
      if (match?.[1]) {
        try {
          ids.add(decodeURIComponent(match[1]));
        } catch {
        }
      }
    }
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOutputFileIds(item, ids, void 0, depth + 1);
    return ids;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectOutputFileIds(item, ids, key, depth + 1);
    }
  }
  return ids;
}
function collectOutputPdfDescriptors(value, descriptors = [], depth = 0) {
  if (!value || depth > 50) return descriptors;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOutputPdfDescriptors(item, descriptors, depth + 1);
    }
    return descriptors;
  }
  if (typeof value !== "object") return descriptors;
  const object = value;
  const filename = String(
    object.fileName ?? object.file_name ?? object.filename ?? object.name ?? ""
  );
  const mimeType = String(
    object.mimeType ?? object.mime_type ?? object.content_type ?? ""
  ).toLowerCase();
  const type = String(object.type ?? "");
  const looksLikePdf = filename.toLowerCase().endsWith(".pdf") || mimeType.includes("application/pdf");
  const looksLikeOutputFile = type === "output_file" || type === "file" || "file_id" in object || "fileId" in object;
  if (looksLikePdf && looksLikeOutputFile) {
    const fileId = String(object.file_id ?? object.fileId ?? "");
    const url = String(
      object.file_url ?? object.fileUrl ?? object.url ?? ""
    );
    descriptors.push({
      fileId: fileId || void 0,
      url: url || void 0,
      filename: filename || "document.pdf"
    });
  }
  for (const child of Object.values(object)) {
    collectOutputPdfDescriptors(child, descriptors, depth + 1);
  }
  return descriptors;
}
function sanitizeTextFileBuffer(data, filename, contentType) {
  if (!isTextBasedFile(filename, contentType)) {
    return { buffer: data, wasSanitized: false };
  }
  try {
    const text2 = data.toString("utf-8");
    const sanitized = sanitizeText(text2);
    if (sanitized !== text2) {
      console.log(`[FrontMind Proxy] Sanitized source-brand references in text file: ${filename}`);
      return { buffer: Buffer.from(sanitized, "utf-8"), wasSanitized: true };
    }
    return { buffer: data, wasSanitized: false };
  } catch (e) {
    return { buffer: data, wasSanitized: false };
  }
}
async function sanitizePdfBuffer(pdfBuffer) {
  try {
    const { PDFDocument, PDFName, decodePDFRawStream, PDFRawStream, StandardFonts, rgb, PDFHexString } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const context = pdfDoc.context;
    let pdfMetadataModified = false;
    const setSanitizedPdfStringMetadata = (getter, setter) => {
      try {
        const current = getter();
        if (!current) return;
        const sanitized = sanitizeText(current);
        if (sanitized !== current) {
          setter(sanitized);
          pdfMetadataModified = true;
        }
      } catch {
      }
    };
    setSanitizedPdfStringMetadata(() => pdfDoc.getTitle(), (value) => pdfDoc.setTitle(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getSubject(), (value) => pdfDoc.setSubject(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getAuthor(), (value) => pdfDoc.setAuthor(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getCreator(), (value) => pdfDoc.setCreator(value));
    setSanitizedPdfStringMetadata(() => pdfDoc.getProducer(), (value) => pdfDoc.setProducer(value));
    try {
      const infoRef = context.trailerInfo?.Info;
      const infoDict = infoRef ? context.lookup(infoRef) : void 0;
      const metadataKeys = ["Title", "Subject", "Author", "Creator", "Producer", "Keywords"];
      if (infoDict && typeof infoDict.lookup === "function" && typeof infoDict.set === "function") {
        for (const key of metadataKeys) {
          const pdfKey = PDFName.of(key);
          const currentValue = infoDict.lookup(pdfKey);
          const currentText = currentValue && typeof currentValue.decodeText === "function" ? currentValue.decodeText() : currentValue && typeof currentValue.asString === "function" ? currentValue.asString() : void 0;
          if (!currentText) continue;
          const sanitized = sanitizeText(currentText);
          if (sanitized !== currentText) {
            infoDict.set(pdfKey, PDFHexString.fromText(sanitized));
            pdfMetadataModified = true;
          }
        }
      }
    } catch {
    }
    const allCMaps = [];
    context.enumerateIndirectObjects().forEach(([_ref, obj]) => {
      if (!obj || obj.constructor.name !== "PDFRawStream") return;
      try {
        const decoded = decodePDFRawStream(obj);
        const cmapText = Buffer.from(decoded.decode()).toString("latin1");
        if (!cmapText.includes("beginbfchar") && !cmapText.includes("beginbfrange")) return;
        const unicodeToGlyph = /* @__PURE__ */ new Map();
        const glyphToUnicode = /* @__PURE__ */ new Map();
        const charMapRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let match;
        while ((match = charMapRegex.exec(cmapText)) !== null) {
          try {
            const glyphHex = match[1].toLowerCase().padStart(4, "0");
            const buf = Buffer.from(match[2], "hex");
            let unicodeChar = "";
            for (let i = 0; i < buf.length; i += 2) {
              if (i + 1 < buf.length) {
                unicodeChar += String.fromCharCode(buf[i] << 8 | buf[i + 1]);
              }
            }
            if (unicodeChar) {
              unicodeToGlyph.set(unicodeChar, glyphHex);
              glyphToUnicode.set(glyphHex, unicodeChar);
            }
          } catch {
          }
        }
        const bfrangeRegex = /beginbfrange\s*([\s\S]*?)\s*endbfrange/g;
        let rangeMatch;
        while ((rangeMatch = bfrangeRegex.exec(cmapText)) !== null) {
          const rangeEntryRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
          let entry;
          while ((entry = rangeEntryRegex.exec(rangeMatch[1])) !== null) {
            const start = parseInt(entry[1], 16);
            const end = parseInt(entry[2], 16);
            const unicodeStart = parseInt(entry[3], 16);
            for (let offset = 0; offset <= end - start; offset++) {
              const unicodeChar = String.fromCharCode(unicodeStart + offset);
              const glyphHex = (start + offset).toString(16).padStart(4, "0");
              unicodeToGlyph.set(unicodeChar, glyphHex);
              glyphToUnicode.set(glyphHex, unicodeChar);
            }
          }
        }
        if (unicodeToGlyph.size > 0) {
          allCMaps.push({ unicodeToGlyph, glyphToUnicode });
        }
      } catch {
      }
    });
    const sourceLower = getSourceBrandLower();
    const sourceTitle = getSourceBrandTitle();
    const sourceUpper = sourceLower.toUpperCase();
    const targetStrings = [
      `${sourceTitle} AI`,
      `${sourceUpper} AI`,
      `${sourceLower} AI`,
      sourceTitle,
      sourceUpper,
      sourceLower
    ];
    const replaceSimpleBrandEncodings = (content) => {
      let sanitized = content;
      const replacements = [...new Set(targetStrings)].sort(
        (left, right) => right.length - left.length
      );
      for (const sourceText of replacements) {
        const replacement = "FrontMind";
        sanitized = sanitized.replace(
          new RegExp(escapeRegExp(sourceText), "g"),
          replacement
        );
        const sourceHex = Buffer.from(sourceText, "latin1").toString("hex");
        const replacementHex = Buffer.from(replacement, "latin1").toString(
          "hex"
        );
        sanitized = sanitized.replace(
          new RegExp(escapeRegExp(sourceHex), "gi"),
          replacementHex
        );
      }
      return sanitized;
    };
    const glyphPatterns = [];
    for (const cmap of allCMaps) {
      for (const target of targetStrings) {
        const glyphs = [];
        let canBuild = true;
        for (const char of target) {
          const glyph = cmap.unicodeToGlyph.get(char);
          if (!glyph) {
            canBuild = false;
            break;
          }
          glyphs.push(glyph);
        }
        if (canBuild) {
          glyphPatterns.push({
            target,
            glyphs,
            spaceGlyph: cmap.unicodeToGlyph.get(" ") || "0001",
            glyphToUnicode: cmap.glyphToUnicode
          });
        }
      }
    }
    glyphPatterns.sort((a, b) => b.glyphs.length - a.glyphs.length);
    if (glyphPatterns.length === 0) {
      let simpleStreamsModified = 0;
      context.enumerateIndirectObjects().forEach(([ref, obj]) => {
        if (!obj || obj.constructor.name !== "PDFRawStream") return;
        try {
          const decoded = decodePDFRawStream(obj);
          const streamText = Buffer.from(decoded.decode()).toString("latin1");
          if (!streamText.includes("Tj") && !streamText.includes("TJ")) return;
          const sanitized = replaceSimpleBrandEncodings(streamText);
          if (sanitized === streamText) return;
          const compressed = zlib.deflateSync(
            Buffer.from(sanitized, "latin1")
          );
          const dict = obj.dict.clone(context);
          dict.set(PDFName.of("Length"), context.obj(compressed.length));
          dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
          context.assign(ref, PDFRawStream.of(dict, compressed));
          simpleStreamsModified += 1;
        } catch {
        }
      });
      if (simpleStreamsModified > 0 || pdfMetadataModified) {
        const savedBytes = await pdfDoc.save();
        console.log(
          `[FrontMind Proxy] PDF simple streams sanitized: ${simpleStreamsModified}, metadata=${pdfMetadataModified}`
        );
        return { buffer: Buffer.from(savedBytes), wasSanitized: true };
      }
      return { buffer: pdfBuffer, wasSanitized: false };
    }
    const overlayPositions = [];
    let totalModified = 0;
    const replacementTextForTarget = (_target) => "FrontMind";
    const estimateGlyphAdvance = (glyph, glyphToUnicode, fontSize) => {
      const char = glyphToUnicode.get(glyph);
      if (!char) return fontSize * 0.6;
      if (char === " ") return fontSize * 0.32;
      const codePoint = char.codePointAt(0) || 0;
      if (codePoint > 11904 || codePoint === 65306 || codePoint === 65288 || codePoint === 65289) {
        return fontSize;
      }
      if (/[ilI1.,:;|!]/.test(char)) return fontSize * 0.3;
      if (/[MW@#%]/.test(char)) return fontSize * 0.78;
      return fontSize * 0.56;
    };
    const splitGlyphHex = (rawHex) => {
      if (!rawHex) return [];
      const normalized = rawHex.length % 4 === 0 ? rawHex : rawHex.padStart(Math.ceil(rawHex.length / 4) * 4, "0");
      const chunks = [];
      for (let i = 0; i < normalized.length; i += 4) {
        chunks.push(normalized.slice(i, i + 4));
      }
      return chunks;
    };
    const calculateTjGlyphAdvance = (tokens, hexTokens, glyphIndexLimit, pattern, fontSize) => {
      let glyphIndex = 0;
      let advance = 0;
      for (const token of tokens) {
        if (token.kind === "number") {
          advance += -((token.value || 0) / 1e3) * fontSize;
          continue;
        }
        const hexToken = hexTokens[token.tokenIndex ?? -1];
        if (!hexToken) continue;
        for (const glyph of hexToken.chunks) {
          if (glyphIndex >= glyphIndexLimit) return advance;
          advance += estimateGlyphAdvance(glyph.toLowerCase().padStart(4, "0"), pattern.glyphToUnicode, fontSize);
          glyphIndex++;
        }
      }
      return advance;
    };
    const rebuildTjArrayBody = (body, hexTokens) => {
      const modifiedTokens = hexTokens.filter((token) => token.modified);
      if (modifiedTokens.length === 0) return body;
      let rebuilt = "";
      let cursor = 0;
      for (const token of modifiedTokens.sort((a, b) => a.start - b.start)) {
        rebuilt += body.slice(cursor, token.start + 1);
        rebuilt += token.chunks.join("").toUpperCase();
        rebuilt += body.slice(token.start + 1 + token.rawHex.length, token.end);
        cursor = token.end;
      }
      rebuilt += body.slice(cursor);
      return rebuilt;
    };
    const pages = pdfDoc.getPages();
    const streamRefToPageIndex = /* @__PURE__ */ new Map();
    const streamObjectToPageIndex = /* @__PURE__ */ new WeakMap();
    const registerPageContent = (content, pageIndex) => {
      if (!content) return;
      if (content.constructor?.name === "PDFRawStream") {
        streamObjectToPageIndex.set(content, pageIndex);
      }
      if (typeof content.toString === "function") {
        streamRefToPageIndex.set(content.toString(), pageIndex);
      }
      if (content.objectNumber !== void 0) {
        streamRefToPageIndex.set(`${content.objectNumber} ${content.generationNumber} R`, pageIndex);
      }
      if (typeof content.size === "function" && typeof content.get === "function") {
        for (let i = 0; i < content.size(); i++) {
          registerPageContent(content.get(i), pageIndex);
        }
      }
    };
    for (let pi = 0; pi < pages.length; pi++) {
      try {
        const contentsRef = pages[pi].node.Contents();
        registerPageContent(contentsRef, pi);
      } catch {
      }
    }
    context.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!obj || obj.constructor.name !== "PDFRawStream") return;
      try {
        const decoded = decodePDFRawStream(obj);
        const bytes = decoded.decode();
        const streamText = Buffer.from(bytes).toString("latin1");
        if (!streamText.includes("Tj") && !streamText.includes("TJ")) return;
        const simpleSanitizedStream = replaceSimpleBrandEncodings(streamText);
        const lines = simpleSanitizedStream.split("\n");
        const ctmStack = [
          { sx: 1, sy: 1, tx: 0, ty: 0 }
        ];
        let currentCtm = { sx: 1, sy: 1, tx: 0, ty: 0 };
        let currentFontSize = 0;
        let currentTm = null;
        let tdAccumX = 0;
        let tdAccumY = 0;
        const tjInfos = [];
        let streamModified = simpleSanitizedStream !== streamText;
        const getPageIndexForStream = () => {
          const objectPageIndex = streamObjectToPageIndex.get(obj);
          if (objectPageIndex !== void 0) return objectPageIndex;
          const refStr = ref.toString();
          let pageIndex = 0;
          let found = false;
          streamRefToPageIndex.forEach((idx, key) => {
            if (found) return;
            const refObjectNumber = refStr.split(" ")[0];
            const exactRefPattern = new RegExp(`(^|\\D)${refObjectNumber}\\s+0\\s+R(\\D|$)`);
            if (refStr === key || exactRefPattern.test(key)) {
              pageIndex = idx;
              found = true;
            }
          });
          return pageIndex;
        };
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === "q") {
            ctmStack.push({ ...currentCtm });
          }
          if (line === "Q") {
            if (ctmStack.length > 1) {
              ctmStack.pop();
              currentCtm = { ...ctmStack[ctmStack.length - 1] };
            }
          }
          const cmMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+cm$/
          );
          if (cmMatch) {
            const [a, , , d, e, f] = cmMatch.slice(1, 7).map(Number);
            const newCtm = {
              sx: currentCtm.sx * a,
              sy: currentCtm.sy * d,
              tx: currentCtm.sx * e + currentCtm.tx,
              ty: currentCtm.sy * f + currentCtm.ty
            };
            currentCtm = newCtm;
            ctmStack[ctmStack.length - 1] = { ...currentCtm };
          }
          const tmMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+Tm$/
          );
          if (tmMatch) {
            currentTm = tmMatch.slice(1, 7).map(Number);
            tdAccumX = 0;
            tdAccumY = 0;
          }
          if (line === "BT") {
            tdAccumX = 0;
            tdAccumY = 0;
          }
          const fontMatch = line.match(/^\/(\w+)\s+([\d.]+)\s+Tf$/);
          if (fontMatch) {
            currentFontSize = parseFloat(fontMatch[2]);
          }
          const tdTjMatch = line.match(/^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td\s+<([0-9a-fA-F]+)>\s+Tj$/);
          if (tdTjMatch) {
            tdAccumX += parseFloat(tdTjMatch[1]);
            tdAccumY += parseFloat(tdTjMatch[2]);
            tjInfos.push({
              glyph: tdTjMatch[3].toLowerCase().padStart(4, "0"),
              lineIndex: i,
              glyphHexInLine: tdTjMatch[3],
              absX: tdAccumX,
              absY: tdAccumY,
              fontSize: currentFontSize,
              tm: currentTm ? [...currentTm] : null,
              ctm: { ...currentCtm }
            });
            continue;
          }
          const tdMatch = line.match(/^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td$/);
          if (tdMatch) {
            tdAccumX += parseFloat(tdMatch[1]);
            tdAccumY += parseFloat(tdMatch[2]);
          }
          if (line.includes("TJ")) {
            const originalLine = lines[i];
            let lineWasModified = false;
            const arrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
            lines[i] = originalLine.replace(arrayRegex, (fullMatch, body) => {
              const hexTokens = [];
              const orderedTokens = [];
              const glyphs = [];
              const tokenRegex = /<([0-9a-fA-F]*)>|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
              let tokenMatch;
              while ((tokenMatch = tokenRegex.exec(body)) !== null) {
                if (tokenMatch[1] !== void 0) {
                  const tokenIndex = hexTokens.length;
                  const chunks = splitGlyphHex(tokenMatch[1]);
                  hexTokens.push({
                    start: tokenMatch.index,
                    end: tokenMatch.index + tokenMatch[0].length,
                    rawHex: tokenMatch[1],
                    chunks,
                    modified: false
                  });
                  orderedTokens.push({ kind: "hex", tokenIndex });
                  chunks.forEach((chunk, chunkIndex) => {
                    glyphs.push({
                      glyph: chunk.toLowerCase().padStart(4, "0"),
                      tokenIndex,
                      chunkIndex
                    });
                  });
                } else if (tokenMatch[2] !== void 0) {
                  orderedTokens.push({ kind: "number", value: Number(tokenMatch[2]) });
                }
              }
              if (glyphs.length === 0) return fullMatch;
              const replacedGlyphIndexes = /* @__PURE__ */ new Set();
              let arrayWasModified = false;
              for (const pattern of glyphPatterns) {
                const patLen = pattern.glyphs.length;
                if (patLen === 0 || glyphs.length < patLen) continue;
                for (let gi = 0; gi <= glyphs.length - patLen; gi++) {
                  if (replacedGlyphIndexes.has(gi)) continue;
                  let matches = true;
                  for (let pj = 0; pj < patLen; pj++) {
                    if (replacedGlyphIndexes.has(gi + pj) || glyphs[gi + pj].glyph !== pattern.glyphs[pj]) {
                      matches = false;
                      break;
                    }
                  }
                  if (!matches) continue;
                  for (let pj = 0; pj < patLen; pj++) {
                    const glyphInfo = glyphs[gi + pj];
                    const token = hexTokens[glyphInfo.tokenIndex];
                    const originalChunk = token.chunks[glyphInfo.chunkIndex] || "0000";
                    token.chunks[glyphInfo.chunkIndex] = pattern.spaceGlyph.toUpperCase().padStart(originalChunk.length, "0");
                    token.modified = true;
                    replacedGlyphIndexes.add(gi + pj);
                  }
                  arrayWasModified = true;
                  lineWasModified = true;
                  if (currentTm) {
                    const tm = currentTm;
                    const ctm = currentCtm;
                    const matchAdvance = calculateTjGlyphAdvance(orderedTokens, hexTokens, gi, pattern, currentFontSize);
                    const matchWidth = Math.max(
                      calculateTjGlyphAdvance(orderedTokens, hexTokens, gi + patLen, pattern, currentFontSize) - matchAdvance,
                      pattern.glyphs.length * currentFontSize * 0.55
                    );
                    const contentX = tm[4] + tdAccumX + matchAdvance;
                    const contentY = tm[5] + tdAccumY;
                    const pageX = ctm.sx * contentX + ctm.tx;
                    const pageY = ctm.sy * contentY + ctm.ty;
                    const effectiveFontSize = Math.abs(ctm.sx) * currentFontSize;
                    const pageWidth = Math.abs(ctm.sx) * matchWidth;
                    const pageIndex = getPageIndexForStream();
                    overlayPositions.push({
                      target: pattern.target,
                      replacementText: replacementTextForTarget(pattern.target),
                      pageX,
                      pageY,
                      pageWidth,
                      effectiveFontSize,
                      pageIndex
                    });
                    console.log(
                      `[FrontMind Proxy] PDF TJ overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`
                    );
                  }
                }
              }
              if (!arrayWasModified) return fullMatch;
              return `[${rebuildTjArrayBody(body, hexTokens)}] TJ`;
            });
            if (lineWasModified) {
              streamModified = true;
            }
          }
          const tjMatch = line.match(/^<([0-9a-fA-F]+)>\s+Tj$/);
          if (tjMatch) {
            const originalHex = tjMatch[1];
            const fullHexLower = originalHex.toLowerCase();
            if (fullHexLower.length >= 8 && fullHexLower.length % 4 === 0) {
              let multiGlyphMatched = false;
              for (const pattern of glyphPatterns) {
                const needle = pattern.glyphs.join("").toLowerCase();
                const matchOffset = fullHexLower.indexOf(needle);
                if (matchOffset < 0 || matchOffset % 4 !== 0) continue;
                const replacementHex = pattern.glyphs.map(() => pattern.spaceGlyph.toUpperCase().padStart(4, "0")).join("");
                const newHex = originalHex.slice(0, matchOffset) + replacementHex + originalHex.slice(matchOffset + needle.length);
                lines[i] = lines[i].replace(`<${originalHex}>`, `<${newHex}>`);
                streamModified = true;
                multiGlyphMatched = true;
                if (currentTm) {
                  const glyphOffset = matchOffset / 4;
                  const tm = currentTm;
                  const ctm = currentCtm;
                  const contentX = tm[4] + tdAccumX + glyphOffset * currentFontSize * 0.55;
                  const contentY = tm[5];
                  const pageX = ctm.sx * contentX + ctm.tx;
                  const pageY = ctm.sy * contentY + ctm.ty;
                  const effectiveFontSize = Math.abs(ctm.sx) * currentFontSize;
                  const pageWidth = Math.abs(ctm.sx) * pattern.glyphs.length * currentFontSize * 0.65;
                  const pageIndex = getPageIndexForStream();
                  overlayPositions.push({
                    target: pattern.target,
                    replacementText: replacementTextForTarget(pattern.target),
                    pageX,
                    pageY,
                    pageWidth,
                    effectiveFontSize,
                    pageIndex
                  });
                  console.log(
                    `[FrontMind Proxy] PDF multi-CID overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`
                  );
                }
                break;
              }
              if (multiGlyphMatched) continue;
            }
            tjInfos.push({
              glyph: tjMatch[1].toLowerCase().padStart(4, "0"),
              lineIndex: i,
              glyphHexInLine: tjMatch[1],
              absX: tdAccumX,
              absY: tdAccumY,
              fontSize: currentFontSize,
              tm: currentTm ? [...currentTm] : null,
              ctm: { ...currentCtm }
            });
          }
        }
        const alreadyReplaced = /* @__PURE__ */ new Set();
        for (const pattern of glyphPatterns) {
          const patLen = pattern.glyphs.length;
          for (let i = 0; i <= tjInfos.length - patLen; i++) {
            if (alreadyReplaced.has(i)) continue;
            let matches = true;
            for (let j = 0; j < patLen; j++) {
              if (tjInfos[i + j].glyph !== pattern.glyphs[j] || alreadyReplaced.has(i + j)) {
                matches = false;
                break;
              }
            }
            if (matches) {
              console.log(`[FrontMind Proxy] FOUND "${pattern.target}" in PDF stream ${ref.toString()}`);
              for (let j = 0; j < patLen; j++) {
                const tj = tjInfos[i + j];
                const oldHex = tj.glyphHexInLine;
                const newHex = pattern.spaceGlyph.toUpperCase().padStart(oldHex.length, "0");
                lines[tj.lineIndex] = lines[tj.lineIndex].replace(`<${oldHex}>`, `<${newHex}>`);
                alreadyReplaced.add(i + j);
              }
              streamModified = true;
              const firstTj = tjInfos[i];
              if (firstTj.tm) {
                const tm = firstTj.tm;
                const ctm = firstTj.ctm;
                const contentX = tm[4] + firstTj.absX;
                const contentY = tm[5];
                const pageX = ctm.sx * contentX + ctm.tx;
                const pageY = ctm.sy * contentY + ctm.ty;
                const effectiveFontSize = Math.abs(ctm.sx) * firstTj.fontSize;
                let contentWidth = 0;
                for (let j = 1; j < patLen; j++) {
                  contentWidth += tjInfos[i + j].absX - tjInfos[i + j - 1].absX;
                }
                contentWidth += firstTj.fontSize * 0.6;
                const pageWidth = Math.abs(ctm.sx) * contentWidth;
                const pageIndex = getPageIndexForStream();
                overlayPositions.push({
                  target: pattern.target,
                  replacementText: replacementTextForTarget(pattern.target),
                  pageX,
                  pageY,
                  pageWidth,
                  effectiveFontSize,
                  pageIndex
                });
                console.log(
                  `[FrontMind Proxy] PDF overlay: "${pattern.target}" -> "FrontMind" at page=${pageIndex} x=${pageX.toFixed(1)} y=${pageY.toFixed(1)} size=${effectiveFontSize.toFixed(1)}`
                );
              }
            }
          }
        }
        if (streamModified) {
          const newText = lines.join("\n");
          const newBytes = Buffer.from(newText, "latin1");
          const compressed = zlib.deflateSync(newBytes);
          const dict = obj.dict.clone(context);
          dict.set(PDFName.of("Length"), context.obj(compressed.length));
          dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
          context.assign(ref, PDFRawStream.of(dict, compressed));
          totalModified++;
        }
      } catch {
      }
    });
    if (overlayPositions.length > 0) {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      for (const pos of overlayPositions) {
        const page = pages[pos.pageIndex] || pages[0];
        const replacementText = pos.replacementText;
        const replacementWidth = font.widthOfTextAtSize(replacementText, pos.effectiveFontSize);
        page.drawRectangle({
          x: pos.pageX - 1,
          y: pos.pageY - 2,
          width: Math.max(pos.pageWidth, replacementWidth) + 4,
          height: pos.effectiveFontSize + 4,
          color: rgb(1, 1, 1),
          opacity: 1
        });
        page.drawText(replacementText, {
          x: pos.pageX,
          y: pos.pageY,
          size: pos.effectiveFontSize,
          font,
          color: rgb(0, 0, 0)
        });
      }
    }
    if (totalModified > 0 || pdfMetadataModified) {
      const savedBytes = await pdfDoc.save();
      console.log(`[FrontMind Proxy] PDF sanitized: ${totalModified} stream(s) modified, ${overlayPositions.length} overlay(s) applied, metadata=${pdfMetadataModified}`);
      return { buffer: Buffer.from(savedBytes), wasSanitized: true };
    }
    return { buffer: pdfBuffer, wasSanitized: false };
  } catch (err) {
    console.error("[FrontMind Proxy] PDF sanitization error:", err.message);
    throw new Error(`PDF sanitization failed: ${err.message}`);
  }
}
function isOfficeXmlFile(filename, contentType) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const officeExtensions = ["docx", "xlsx", "pptx", "doc", "xls", "ppt"];
  if (officeExtensions.includes(ext)) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("officedocument") || ct.includes("msword") || ct.includes("ms-excel") || ct.includes("ms-powerpoint")) {
      return true;
    }
  }
  return false;
}
function isZipMagicBytes(data) {
  return data.length >= 4 && data[0] === 80 && data[1] === 75 && data[2] === 3 && data[3] === 4;
}
async function sanitizeOfficeXmlBuffer(data) {
  try {
    const JSZip3 = (await import("jszip")).default;
    const zip = await JSZip3.loadAsync(data);
    let modified = false;
    const fileNames = Object.keys(zip.files);
    for (const fname of fileNames) {
      const file = zip.files[fname];
      if (file.dir) continue;
      const lowerName = fname.toLowerCase();
      if (lowerName.endsWith(".xml") || lowerName.endsWith(".rels") || lowerName === "[content_types].xml") {
        try {
          const content = await file.async("string");
          const sanitized = sanitizeText(content);
          if (sanitized !== content) {
            zip.file(fname, sanitized);
            modified = true;
          }
        } catch {
        }
      }
    }
    if (modified) {
      const newBuffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });
      console.log(`[FrontMind Proxy] Office XML file sanitized`);
      return { buffer: newBuffer, wasSanitized: true };
    }
    return { buffer: data, wasSanitized: false };
  } catch (err) {
    console.error(`[FrontMind Proxy] Office XML sanitization error: ${err.message}`);
    return { buffer: data, wasSanitized: false };
  }
}
async function sanitizeFileBuffer(data, filename, contentType) {
  if (isPdfFile(filename, contentType) || isPdfMagicBytes(data)) {
    console.log(`[FrontMind Proxy] Detected PDF file: ${filename} (magic=${isPdfMagicBytes(data)}, ext/ct=${isPdfFile(filename, contentType)})`);
    return sanitizePdfBuffer(data);
  }
  if (isOfficeXmlFile(filename, contentType) || isZipMagicBytes(data) && !isTextBasedFile(filename, contentType)) {
    console.log(`[FrontMind Proxy] Detected Office XML file: ${filename}`);
    return sanitizeOfficeXmlBuffer(data);
  }
  return sanitizeTextFileBuffer(data, filename, contentType);
}
router2.put("/proxy-upload", async (req, res) => {
  try {
    const rawTarget = req.query.target;
    if (!rawTarget) {
      return res.status(400).json({ error: { message: "Missing target URL" } });
    }
    const target = assertSafeExternalUrl(rawTarget);
    console.log(`[FrontMind Proxy] Proxy-upload to: ${safeUrlForLog(target)}`);
    const realContentType = req.headers["x-original-content-type"] || req.headers["content-type"] || "application/octet-stream";
    const uploadHeaders = {
      "Content-Type": realContentType
    };
    if (typeof req.headers["content-length"] === "string") {
      uploadHeaders["Content-Length"] = req.headers["content-length"];
    }
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    const response = await axios2.put(target, req, {
      ...safeExternalRequestOptions,
      headers: uploadHeaders,
      timeout: 3e5,
      maxBodyLength: Infinity,
      maxContentLength: 1024 * 1024,
      signal: controller.signal,
      validateStatus: () => true
    });
    console.log(`[FrontMind Proxy] Proxy-upload response: ${response.status}`);
    res.status(response.status).send(response.data || "");
  } catch (error) {
    if (error instanceof ExternalUrlRejectedError) {
      return res.status(400).json({
        error: {
          message: "\u5916\u90E8\u6587\u4EF6\u94FE\u63A5\u4E0D\u53EF\u7528",
          code: "INVALID_EXTERNAL_URL"
        }
      });
    }
    console.error("[FrontMind Proxy] Proxy-upload error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "PROXY_UPLOAD_ERROR"
      }
    });
  }
});
router2.get("/proxy-download", async (req, res) => {
  try {
    const rawTargetUrl = req.query.url;
    const requestedFilename = typeof req.query.filename === "string" ? req.query.filename : "";
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    if (!rawTargetUrl) {
      return res.status(400).json({ error: { message: "Missing url parameter" } });
    }
    const targetUrl = assertSafeExternalUrl(rawTargetUrl);
    const urlFilenameRaw = targetUrl.split("/").pop()?.split("?")[0] || "file";
    const candidateFilename = requestedFilename || decodeURIComponent(urlFilenameRaw);
    if (isPdfFile(candidateFilename) && req.frontmindUser) {
      const credential = await getDecryptedCredentialForUser(
        req.frontmindUser.id
      );
      const asset = await preparedFileService.registerExternal({
        ownerUserId: req.frontmindUser.id,
        credentialId: credential?.id || "external",
        url: targetUrl,
        filename: candidateFilename
      });
      if (asset.status !== "ready") {
        return res.status(202).json(asset);
      }
      const suffix = disposition === "attachment" ? "?download=1" : "";
      return res.redirect(307, `${asset.contentUrl}${suffix}`);
    }
    console.log(`[FrontMind Proxy] Proxy-download: ${safeUrlForLog(targetUrl)}`);
    const response = await axios2.get(targetUrl, {
      ...safeExternalRequestOptions,
      responseType: "arraybuffer",
      timeout: 12e4,
      maxContentLength: Infinity,
      validateStatus: () => true
    });
    console.log(`[FrontMind Proxy] Proxy-download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`);
    res.status(response.status);
    const rawBuffer = Buffer.from(response.data);
    const urlFilename = ensureFilenameMatchesContent(
      candidateFilename,
      rawBuffer,
      response.headers["content-type"]
    );
    const finalContentType = normalizeContentTypeForBuffer(urlFilename, rawBuffer, response.headers["content-type"]);
    for (const header of ["cache-control", "etag", "last-modified"]) {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    }
    res.setHeader("content-type", finalContentType);
    setSafeContentDisposition(res, disposition, urlFilename);
    const { buffer: sanitizedBuffer, wasSanitized } = await sanitizeFileBuffer(
      rawBuffer,
      urlFilename,
      finalContentType
    );
    if (wasSanitized) {
      res.setHeader("content-length", String(sanitizedBuffer.length));
    } else if (response.headers["content-length"]) {
      res.setHeader("content-length", response.headers["content-length"]);
    }
    res.send(sanitizedBuffer);
  } catch (error) {
    if (error instanceof ExternalUrlRejectedError) {
      return res.status(400).json({
        error: {
          message: "\u5916\u90E8\u6587\u4EF6\u94FE\u63A5\u4E0D\u53EF\u7528",
          code: "INVALID_EXTERNAL_URL"
        }
      });
    }
    console.error("[FrontMind Proxy] Proxy-download error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "PROXY_DOWNLOAD_ERROR"
      }
    });
  }
});
async function fetchFileMetadata(baseUrl, fileId, apiKey) {
  const cached = getCachedMeta(fileId);
  if (cached) {
    console.log(`[FrontMind Proxy] File metadata cache hit for ${fileId}`);
    return cached;
  }
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  const metadataUrl = `${cleanBaseUrl}/v1/files/${fileId}`;
  console.log(`[FrontMind Proxy] Fetching file metadata: GET ${metadataUrl}`);
  const response = await axios2.get(metadataUrl, {
    headers: {
      API_KEY: apiKey,
      Authorization: `Bearer ${apiKey}`
    },
    timeout: 3e4,
    validateStatus: () => true
  });
  if (response.status !== 200) {
    console.error(`[FrontMind Proxy] File metadata request failed: ${response.status}`);
    return null;
  }
  const data = response.data;
  console.log(`[FrontMind Proxy] File metadata: id=${data.id}, filename=${data.filename}, status=${data.status}, has_upload_url=${!!data.upload_url}`);
  if (data.upload_url) {
    const meta = { upload_url: data.upload_url, filename: data.filename || fileId };
    setCachedMeta(fileId, meta);
    return meta;
  }
  return { upload_url: "", filename: data.filename || fileId };
}
async function downloadFromS3(res, s3Url, filename, disposition = "inline") {
  const safeS3Url = assertSafeExternalUrl(s3Url);
  console.log(`[FrontMind Proxy] Downloading from object storage: ${safeUrlForLog(safeS3Url)}`);
  const response = await axios2.get(safeS3Url, {
    ...safeExternalRequestOptions,
    responseType: "arraybuffer",
    timeout: 12e4,
    maxContentLength: Infinity,
    validateStatus: () => true
  });
  console.log(`[FrontMind Proxy] S3 download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`);
  if (response.status !== 200) {
    res.status(response.status);
    res.json({
      error: {
        message: `S3 download failed with status ${response.status}`,
        code: "S3_DOWNLOAD_ERROR"
      }
    });
    return;
  }
  res.status(200);
  const rawBuffer = Buffer.from(response.data);
  const finalFilename = ensureFilenameMatchesContent(filename, rawBuffer, response.headers["content-type"]);
  const finalContentType = normalizeContentTypeForBuffer(finalFilename, rawBuffer, response.headers["content-type"]);
  for (const header of ["cache-control", "etag", "last-modified"]) {
    if (response.headers[header]) {
      res.setHeader(header, response.headers[header]);
    }
  }
  res.setHeader("content-type", finalContentType);
  setSafeContentDisposition(res, disposition, finalFilename);
  const { buffer: sanitizedBuffer } = await sanitizeFileBuffer(
    rawBuffer,
    finalFilename,
    finalContentType
  );
  res.setHeader("content-length", String(sanitizedBuffer.length));
  res.send(sanitizedBuffer);
}
async function handleFileDownload(res, baseUrl, fileId, apiKey, disposition = "inline", ownerUserId, credentialId) {
  const meta = await fetchFileMetadata(baseUrl, fileId, apiKey);
  if (!meta) {
    res.status(404).json({
      error: {
        message: `File not found: ${fileId}`,
        code: "FILE_NOT_FOUND"
      }
    });
    return;
  }
  if (isPdfFile(meta.filename) && ownerUserId && credentialId) {
    const asset = await preparedFileService.registerFile({
      ownerUserId,
      credentialId,
      fileId,
      filename: meta.filename
    });
    if (asset.status !== "ready") {
      res.status(202).json(asset);
      return;
    }
    const suffix = disposition === "attachment" ? "?download=1" : "";
    res.redirect(307, `${asset.contentUrl}${suffix}`);
    return;
  }
  if (!meta.upload_url) {
    console.warn(`[FrontMind Proxy] No upload_url for file ${fileId}, trying direct API download`);
    const cleanBaseUrl = baseUrl.replace(/\/$/, "");
    const contentUrl = `${cleanBaseUrl}/v1/files/${fileId}/content`;
    try {
      const response = await axios2.get(contentUrl, {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`
        },
        responseType: "arraybuffer",
        timeout: 12e4,
        maxContentLength: Infinity,
        validateStatus: () => true
      });
      if (response.status === 200 && response.headers["content-type"] !== "application/json") {
        console.log(`[FrontMind Proxy] Direct /content download succeeded: ${response.status}`);
        res.status(200);
        for (const header of ["content-type", "content-disposition"]) {
          if (response.headers[header]) {
            if (header === "content-disposition") {
              res.setHeader(header, sanitizeText(String(response.headers[header])));
            } else {
              res.setHeader(header, response.headers[header]);
            }
          }
        }
        const rawBuffer = Buffer.from(response.data);
        const finalFilename = ensureFilenameMatchesContent(meta.filename, rawBuffer, response.headers["content-type"]);
        const finalContentType = normalizeContentTypeForBuffer(finalFilename, rawBuffer, response.headers["content-type"]);
        res.setHeader("content-type", finalContentType);
        setSafeContentDisposition(res, disposition, finalFilename);
        const { buffer: sanitizedBuffer } = await sanitizeFileBuffer(
          rawBuffer,
          finalFilename,
          finalContentType
        );
        res.setHeader("content-length", String(sanitizedBuffer.length));
        res.send(sanitizedBuffer);
        return;
      }
    } catch (e) {
      console.warn(`[FrontMind Proxy] Direct /content download failed: ${e.message}`);
    }
    res.status(404).json({
      error: {
        message: `No download URL available for file ${fileId}`,
        code: "NO_DOWNLOAD_URL"
      }
    });
    return;
  }
  await downloadFromS3(res, meta.upload_url, meta.filename, disposition);
}
router2.post("/download-token", async (req, res) => {
  try {
    cleanupExpiredDownloadTokens();
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    const fileId = req.body?.fileId || "";
    if (!apiKey) {
      return res.status(401).json({ error: { message: "Missing API key", code: "MISSING_API_KEY" } });
    }
    if (!fileId) {
      return res.status(400).json({ error: { message: "Missing fileId", code: "MISSING_FILE_ID" } });
    }
    const token = randomUUID3();
    if (!req.frontmindUser || !req.frontmindCredential) {
      return res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
    }
    downloadTokenCache.set(token, {
      fileId,
      userId: req.frontmindUser.id,
      credentialId: req.frontmindCredential.id,
      apiKey,
      baseUrl,
      createdAt: Date.now()
    });
    res.json({ downloadUrl: `/api/frontmind/download/${token}`, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL });
  } catch (error) {
    console.error("[FrontMind Proxy] Create download token error:", error.message);
    res.status(500).json({ error: { message: "\u521B\u5EFA\u4E0B\u8F7D\u94FE\u63A5\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "DOWNLOAD_TOKEN_ERROR" } });
  }
});
router2.get("/download/:token", async (req, res) => {
  try {
    cleanupExpiredDownloadTokens();
    const token = req.params.token;
    const data = downloadTokenCache.get(token);
    if (!data) {
      return res.status(410).json({ error: { message: "Download link expired", code: "DOWNLOAD_LINK_EXPIRED" } });
    }
    if (!req.frontmindUser || req.frontmindUser.id !== data.userId) {
      return res.status(403).json({ error: { message: "\u4E0B\u8F7D\u94FE\u63A5\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7", code: "DOWNLOAD_FORBIDDEN" } });
    }
    downloadTokenCache.delete(token);
    await handleFileDownload(
      res,
      data.baseUrl,
      data.fileId,
      data.apiKey,
      "attachment",
      data.userId,
      data.credentialId
    );
  } catch (error) {
    console.error("[FrontMind Proxy] Direct token download error:", error.message);
    res.status(500).json({ error: { message: "\u4E0B\u8F7D\u94FE\u63A5\u5DF2\u5931\u6548\u6216\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25", code: "DIRECT_DOWNLOAD_ERROR" } });
  }
});
router2.get("/v1/files/:fileId", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    const fileId = req.params.fileId;
    await handleFileDownload(
      res,
      baseUrl,
      fileId,
      apiKey,
      "inline",
      req.frontmindUser?.id,
      req.frontmindCredential?.id
    );
  } catch (error) {
    console.error("[FrontMind Proxy] File download error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "FILE_DOWNLOAD_ERROR"
      }
    });
  }
});
router2.get("/v1/files/:fileId/content", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    const fileId = req.params.fileId;
    await handleFileDownload(
      res,
      baseUrl,
      fileId,
      apiKey,
      "inline",
      req.frontmindUser?.id,
      req.frontmindCredential?.id
    );
  } catch (error) {
    console.error("[FrontMind Proxy] File content download error:", error.message);
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u5185\u5BB9\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "FILE_CONTENT_ERROR"
      }
    });
  }
});
router2.all("/*", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getFrontMindCredentials(req);
    if (!apiKey) {
      return res.status(401).json({ error: { message: "Missing API key", code: "MISSING_API_KEY" } });
    }
    const targetPath = req.originalUrl.replace(/^\/api\/frontmind/, "");
    const targetUrl = `${baseUrl.replace(/\/$/, "")}${targetPath}`;
    console.log(`[FrontMind Proxy] ${req.method} ${targetPath}`);
    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
      API_KEY: apiKey,
      Authorization: `Bearer ${apiKey}`
    };
    const axiosConfig = {
      method: req.method,
      url: targetUrl,
      headers,
      timeout: 3e5,
      validateStatus: () => true
    };
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      axiosConfig.data = translateTaskBodyForUpstream(req.body);
    }
    const response = await axios2(axiosConfig);
    if (response.status >= 200 && response.status < 300 && req.frontmindUser && req.frontmindCredential && response.data && typeof response.data === "object") {
      const resourceId = String(response.data.id || response.data.task_id || "");
      const isTaskCreate = req.method === "POST" && targetPath.split("?")[0] === "/v1/tasks";
      const isFileCreate = req.method === "POST" && targetPath.split("?")[0] === "/v1/files";
      if (resourceId && (isTaskCreate || isFileCreate)) {
        await recordUpstreamResource({
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: isTaskCreate ? "task" : "file",
          upstreamId: resourceId
        });
      }
      for (const fileId of collectOutputFileIds(response.data)) {
        await recordUpstreamResource({
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: "file",
          upstreamId: fileId
        });
      }
      for (const descriptor of collectOutputPdfDescriptors(response.data)) {
        try {
          if (descriptor.fileId) {
            await preparedFileService.registerFile({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              fileId: descriptor.fileId,
              filename: descriptor.filename
            });
            continue;
          }
          if (!descriptor.url) continue;
          const match = descriptor.url.match(/\/v1\/files\/([^/?#]+)/);
          if (match?.[1]) {
            await preparedFileService.registerFile({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              fileId: decodeURIComponent(match[1]),
              filename: descriptor.filename
            });
          } else {
            await preparedFileService.registerExternal({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              url: descriptor.url,
              filename: descriptor.filename
            });
          }
        } catch (error) {
          console.warn("[PreparedFiles] Auto-registration failed", error);
        }
      }
    }
    if (typeof response.data === "object" && response.data?.output) {
      const outputSummary = response.data.output.map(
        (item, i) => `${i}:${item.type || "message"}${item.id ? "(" + item.id.slice(0, 8) + ")" : ""}`
      ).join(", ");
      console.log(`[FrontMind Proxy] Response: ${response.status} id=${response.data.id?.slice(0, 12)} status=${response.data.status} output=[${response.data.output.length} items: ${outputSummary.slice(0, 300)}]`);
    } else {
      console.log(`[FrontMind Proxy] Response: ${response.status}`, typeof response.data === "object" ? JSON.stringify(response.data).slice(0, 200) : "");
    }
    res.status(response.status);
    if (response.headers["content-type"]) {
      res.setHeader("content-type", response.headers["content-type"]);
    }
    if (typeof response.data === "object") {
      const sanitized = deepSanitizeJson(response.data);
      res.json(sanitized);
    } else if (typeof response.data === "string") {
      res.send(sanitizeText(response.data));
    } else {
      res.send(response.data);
    }
  } catch (error) {
    console.error("[FrontMind Proxy] Error:", error.message);
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      res.status(502).json({
        error: {
          message: "\u65E0\u6CD5\u8FDE\u63A5\u5230\u670D\u52A1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u68C0\u67E5\u914D\u7F6E",
          code: "PROXY_CONNECTION_ERROR"
        }
      });
    } else if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
      res.status(504).json({
        error: {
          message: "API \u8BF7\u6C42\u8D85\u65F6",
          code: "PROXY_TIMEOUT"
        }
      });
    } else {
      res.status(500).json({
        error: {
          message: "\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
          code: "PROXY_ERROR"
        }
      });
    }
  }
});
var manus_proxy_default = router2;

// server/workflow-api.ts
import { randomUUID as randomUUID4 } from "crypto";
import { createReadStream as createReadStream2, createWriteStream } from "fs";
import fs5 from "fs/promises";
import path5 from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import axios3 from "axios";
import {
  Router as Router2
} from "express";
import JSZip from "jszip";

// server/workflow/manifest.ts
import fs4 from "fs/promises";
import path4 from "path";
var commonControlSources = [
  "Master_Control/FrontMind_Master_Control.md",
  "00.FrontMind\u603B\u63A7\u8DEF\u7531.skill"
];
function strategySources(...sources) {
  return [
    ...commonControlSources,
    "Strategy_Workflow/shared",
    ...sources
  ];
}
function executionSources(...sources) {
  return [
    ...commonControlSources,
    "Execution_Workflow/shared",
    ...sources
  ];
}
function step(data) {
  return data;
}
var steps = [
  step({
    id: "S0",
    layer: "strategy",
    kind: "agent",
    sequence: 10,
    title: "\u7B56\u7565\u7F16\u6392",
    buttonLabel: "\u542F\u52A8\u7B56\u7565",
    description: "\u5EFA\u7ACB\u7B56\u7565\u5C42\u4EFB\u52A1\u4E0A\u4E0B\u6587\uFF0C\u786E\u8BA4\u54C1\u724C\u76EE\u6807\u3001\u8D44\u6599\u8FB9\u754C\u548C\u4EA7\u7269\u8DEF\u7EBF\u3002",
    owner: "S0 \u7B56\u7565\u7F16\u6392\u5E08",
    inputs: ["\u54C1\u724C\u540D\u79F0", "\u4E1A\u52A1\u76EE\u6807", "\u5DF2\u6709\u8D44\u6599"],
    outputs: ["\u7B56\u7565\u4EFB\u52A1\u8DEF\u7531", "\u6267\u884C\u987A\u5E8F", "\u5F85\u786E\u8BA4\u6E05\u5355"],
    dependencies: [],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S0.\u7B56\u7565\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "S1",
    layer: "strategy",
    kind: "agent",
    sequence: 20,
    title: "\u7B56\u7565\u542F\u52A8\u4E0E\u54C1\u724C\u4E8B\u5B9E",
    buttonLabel: "\u542F\u52A8\u54C1\u724C\u4E8B\u5B9E",
    description: "\u5EFA\u7ACB\u7B56\u7565\u4E0A\u4E0B\u6587\uFF0C\u5E76\u62BD\u53D6\u54C1\u724C\u3001\u4EA7\u54C1\u3001\u6E20\u9053\u3001\u5BA2\u6237\u4E0E\u8BC1\u636E\uFF0C\u5F62\u6210\u7EDF\u4E00\u4E8B\u5B9E\u5E95\u5EA7\u3002",
    owner: "S1 \u54C1\u724C\u4E8B\u5B9E\u4E0E\u7B56\u7565\u7F16\u6392",
    inputs: ["\u54C1\u724C\u540D\u79F0", "\u4E1A\u52A1\u76EE\u6807", "\u5DF2\u6709\u8D44\u6599", "\u5B98\u7F51", "\u4EA7\u54C1\u8D44\u6599", "\u9500\u552E\u8D44\u6599"],
    outputs: ["\u7B56\u7565\u4EFB\u52A1\u8DEF\u7531", "brand_facts.json", "brand_knowledge.md", "\u5F85\u786E\u8BA4\u6E05\u5355"],
    dependencies: [],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources(
      "Strategy_Workflow/S0.\u7B56\u7565\u7F16\u6392\u5E08.skill",
      "Strategy_Workflow/S1.\u54C1\u724C\u8D44\u4EA7\u77E5\u8BC6\u5E93.skill"
    )
  }),
  step({
    id: "SP1",
    layer: "strategy",
    kind: "pause",
    sequence: 30,
    title: "\u786E\u8BA4\u54C1\u724C\u4E8B\u5B9E",
    buttonLabel: "\u786E\u8BA4\u4E8B\u5B9E",
    description: "\u4EBA\u5DE5\u786E\u8BA4 S1 \u7684\u54C1\u724C\u4E8B\u5B9E\u56FE\u8C31\uFF0C\u907F\u514D\u540E\u7EED\u7B56\u7565\u5EFA\u7ACB\u5728\u9519\u8BEF\u8D44\u6599\u4E0A\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 1",
    inputs: ["S1 \u4EA7\u7269", "\u4FEE\u6B63\u610F\u89C1"],
    outputs: ["\u4E8B\u5B9E\u786E\u8BA4\u8BB0\u5F55"],
    dependencies: ["S1"],
    phase: "\u7B56\u7565\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "S2",
    layer: "strategy",
    kind: "agent",
    sequence: 40,
    title: "\u8425\u9500\u56FE\u8C31",
    buttonLabel: "\u8425\u9500\u56FE\u8C31",
    description: "\u5EFA\u7ACB\u7528\u6237\u573A\u666F\u3001\u641C\u7D22\u610F\u56FE\u3001\u95EE\u9898\u7C07\u4E0E AI \u95EE\u7B54\u63A2\u9488\u3002",
    owner: "S2 \u8425\u9500\u56FE\u8C31\u4E13\u5BB6",
    inputs: ["\u54C1\u724C\u4E8B\u5B9E", "\u5BA2\u6237\u573A\u666F"],
    outputs: ["\u7528\u6237-\u573A\u666F-\u610F\u56FE\u4E09\u5143\u7EC4", "AI \u63A2\u9488\u95EE\u9898"],
    dependencies: ["SP1"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S2.\u8425\u9500\u56FE\u8C31\u4E13\u5BB6.skill")
  }),
  step({
    id: "S3",
    layer: "strategy",
    kind: "agent",
    sequence: 50,
    title: "\u54C1\u7C7B\u8D8B\u52BF",
    buttonLabel: "\u54C1\u7C7B\u8D8B\u52BF",
    description: "\u5224\u65AD\u54C1\u7C7B\u641C\u7D22\u8D8B\u52BF\u3001\u7ADE\u4E89\u5F3A\u5EA6\u3001AI \u63A8\u8350\u8BED\u5883\u548C\u673A\u4F1A\u7A97\u53E3\u3002",
    owner: "S3 \u54C1\u7C7B\u8D8B\u52BF\u7814\u5224\u5E08",
    inputs: ["\u54C1\u7C7B\u5173\u952E\u8BCD", "\u7ADE\u4E89\u54C1\u724C"],
    outputs: ["\u8D8B\u52BF\u7814\u5224\u62A5\u544A", "\u54C1\u7C7B\u673A\u4F1A\u8BC4\u5206"],
    dependencies: ["S2"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S3.\u54C1\u7C7B\u8D8B\u52BF\u7814\u5224\u5E08.skill")
  }),
  step({
    id: "S4",
    layer: "strategy",
    kind: "agent",
    sequence: 60,
    title: "\u54C1\u724C\u5B9A\u4F4D",
    buttonLabel: "\u54C1\u724C\u5B9A\u4F4D",
    description: "\u5F62\u6210\u54C1\u724C\u5B9A\u4F4D\u58F0\u660E\u3001\u5DEE\u5F02\u5316\u77E9\u9635\u548C\u6838\u5FC3\u7ADE\u4E89\u7406\u7531\u3002",
    owner: "S4 \u54C1\u724C\u5B9A\u4F4D\u5206\u6790\u5E08",
    inputs: ["\u54C1\u724C\u4E8B\u5B9E", "\u8D8B\u52BF\u7814\u5224", "\u7ADE\u54C1\u8D44\u6599"],
    outputs: ["\u5B9A\u4F4D\u58F0\u660E", "\u5DEE\u5F02\u5316\u77E9\u9635"],
    dependencies: ["S3"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S4.\u54C1\u724C\u5B9A\u4F4D\u5206\u6790\u5E08.skill")
  }),
  step({
    id: "SP2",
    layer: "strategy",
    kind: "pause",
    sequence: 70,
    title: "\u8D44\u6599\u8865\u5145\u5224\u65AD",
    buttonLabel: "\u8865\u5145\u5224\u65AD",
    description: "\u51B3\u5B9A\u662F\u5426\u8FDB\u5165\u54C1\u724C\u8D44\u6599\u8865\u5145\u8868\uFF0C\u8865\u9F50\u5B9A\u4F4D\u4E0E\u8BCA\u65AD\u524D\u7684\u7F3A\u53E3\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 2",
    inputs: ["S4 \u4EA7\u7269", "\u8D44\u6599\u7F3A\u53E3"],
    outputs: ["\u8D44\u6599\u8865\u5145\u5224\u65AD", "pause_2 \u8BB0\u5F55"],
    dependencies: ["S4"],
    phase: "\u7B56\u7565\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "SP3",
    layer: "strategy",
    kind: "pause",
    sequence: 80,
    title: "\u5730\u57DF\u4E0E\u76D1\u6D4B\u6570\u636E",
    buttonLabel: "\u5730\u57DF\u6570\u636E",
    description: "\u9009\u62E9 AI \u53EF\u89C1\u6027\u76D1\u6D4B\u5730\u57DF\uFF0C\u590D\u7528 S2/S4.5 \u4EE3\u8868\u9898\uFF0C\u5E76\u4E0A\u4F20\u6216\u786E\u8BA4\u76D1\u6D4B\u6570\u636E\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 3",
    inputs: ["\u76EE\u6807\u5730\u57DF", "AI \u53EF\u89C1\u6027\u6570\u636E", "S2 15 \u4E2A\u4EE3\u8868\u9898"],
    outputs: ["\u5730\u57DF\u8303\u56F4", "\u76D1\u6D4B\u6570\u636E\u7D22\u5F15"],
    dependencies: ["SP2"],
    phase: "\u7B56\u7565\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "S5",
    layer: "strategy",
    kind: "agent",
    sequence: 90,
    title: "AI \u53EF\u89C1\u6027\u8BCA\u65AD",
    buttonLabel: "\u53EF\u89C1\u6027\u8BCA\u65AD",
    description: "\u5206\u6790\u54C1\u724C\u5728 AI \u641C\u7D22\u3001\u95EE\u7B54\u3001\u63A8\u8350\u8BED\u5883\u4E2D\u7684\u51FA\u73B0\u7387\u4E0E\u7F3A\u53E3\u3002",
    owner: "S5 \u54C1\u724C\u8BCA\u65AD\u4E13\u5BB6",
    inputs: ["\u76D1\u6D4B\u6570\u636E", "\u54C1\u724C\u4E8B\u5B9E", "\u5B9A\u4F4D\u58F0\u660E"],
    outputs: ["AI \u53EF\u89C1\u6027\u8BCA\u65AD", "\u7F3A\u53E3\u62A5\u544A"],
    dependencies: ["SP3"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S5.\u54C1\u724C\u8BCA\u65AD\u4E13\u5BB6.skill")
  }),
  step({
    id: "S5_5",
    layer: "strategy",
    kind: "agent",
    sequence: 100,
    title: "\u8BED\u4E49\u8D44\u4EA7\u5BA1\u8BA1",
    buttonLabel: "\u8BED\u4E49\u5BA1\u8BA1",
    description: "\u8BC4\u4F30\u54C1\u724C\u5728\u8BED\u4E49\u8D44\u4EA7\u3001\u5B9E\u4F53\u5173\u7CFB\u548C\u53EF\u5F15\u7528\u8BC1\u636E\u4E0A\u7684\u5B8C\u6574\u5EA6\u3002",
    owner: "S5.5 \u54C1\u724C\u8BED\u4E49\u8D44\u4EA7\u5BA1\u8BA1\u5E08",
    inputs: ["S5 \u8BCA\u65AD", "\u54C1\u724C\u77E5\u8BC6\u5E93"],
    outputs: ["\u8BED\u4E49\u8D44\u4EA7\u8BC4\u5206\u5361", "\u8865\u5F3A\u5EFA\u8BAE"],
    dependencies: ["S5"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S5.5.\u54C1\u724C\u8BED\u4E49\u8D44\u4EA7\u5BA1\u8BA1\u5E08.skill")
  }),
  step({
    id: "S6",
    layer: "strategy",
    kind: "agent",
    sequence: 110,
    title: "\u8BDD\u8BED\u4F53\u7CFB",
    buttonLabel: "\u8BDD\u8BED\u4F53\u7CFB",
    description: "\u6C89\u6DC0\u54C1\u724C\u8BED\u6C14\u3001\u4EF7\u503C\u8868\u8FBE\u3001\u6838\u5FC3\u53E5\u5F0F\u548C\u53EF\u590D\u7528\u8BED\u8A00\u8D44\u4EA7\u3002",
    owner: "S6 \u54C1\u724C\u8BDD\u8BED\u4F53\u7CFB",
    inputs: ["\u5B9A\u4F4D\u58F0\u660E", "\u8BED\u4E49\u5BA1\u8BA1"],
    outputs: ["\u54C1\u724C\u8BDD\u8BED\u624B\u518C", "brand_voice_token.json"],
    dependencies: ["S5_5"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S6.\u54C1\u724C\u8BDD\u8BED\u4F53\u7CFB.skill")
  }),
  step({
    id: "S7",
    layer: "strategy",
    kind: "agent",
    sequence: 120,
    title: "\u89C6\u89C9\u7B26\u53F7",
    buttonLabel: "\u89C6\u89C9\u4F53\u7CFB",
    description: "\u5B9A\u4E49\u54C1\u724C\u89C6\u89C9\u63D0\u793A\u8BCD\u3001\u753B\u9762\u98CE\u683C\u3001\u7981\u7528\u5143\u7D20\u548C\u8D44\u4EA7\u751F\u6210\u89C4\u8303\u3002",
    owner: "S7 \u89C6\u89C9\u7B26\u53F7\u4F53\u7CFB",
    inputs: ["\u54C1\u724C\u5B9A\u4F4D", "\u8BDD\u8BED\u4F53\u7CFB"],
    outputs: ["visual_prompt_pack.json", "\u89C6\u89C9\u89C4\u8303"],
    dependencies: ["S6"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S7.\u89C6\u89C9\u7B26\u53F7\u4F53\u7CFB.skill")
  }),
  step({
    id: "S8",
    layer: "strategy",
    kind: "agent",
    sequence: 130,
    title: "\u95EE\u7B54\u67B6\u6784",
    buttonLabel: "\u95EE\u7B54\u77E9\u9635",
    description: "\u89C4\u5212 AI \u53EF\u5F15\u7528\u5185\u5BB9\u7684\u95EE\u7B54\u6811\u3001\u5185\u5BB9\u77E9\u9635\u3001\u4E3B\u9898\u65E5\u5386\u548C\u843D\u5730\u9875\u84DD\u56FE\u3002",
    owner: "S8 \u95EE\u7B54\u67B6\u6784\u5E08",
    inputs: ["\u8425\u9500\u56FE\u8C31", "\u8BDD\u8BED\u4F53\u7CFB", "\u89C6\u89C9\u89C4\u8303"],
    outputs: ["QA tree", "\u5185\u5BB9\u77E9\u9635", "\u5185\u5BB9\u65E5\u5386", "\u843D\u5730\u9875\u84DD\u56FE"],
    dependencies: ["S7"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S8.\u95EE\u7B54\u67B6\u6784\u5E08.skill")
  }),
  step({
    id: "S9",
    layer: "strategy",
    kind: "agent",
    sequence: 140,
    title: "\u4E1A\u52A1\u8D4B\u80FD\u89C4\u5212",
    buttonLabel: "\u4E1A\u52A1\u8D4B\u80FD",
    description: "\u6C47\u603B S1-S8 \u4F01\u4E1A\u95EE\u9898\uFF0C\u8F6C\u4E3A GEO \u4E1A\u52A1\u5EFA\u8BAE\u4E0E\u4F18\u5148\u884C\u52A8\u6E05\u5355\u3002",
    owner: "S9 \u4E1A\u52A1\u8D4B\u80FD\u89C4\u5212\u5E08",
    inputs: ["S1-S8 \u4EA7\u7269"],
    outputs: ["GEO \u884C\u52A8\u6E05\u5355", "\u4E1A\u52A1\u8D4B\u80FD\u5EFA\u8BAE"],
    dependencies: ["S8"],
    phase: "\u7B56\u7565\u5C42",
    privateSources: strategySources("Strategy_Workflow/S9.\u4E1A\u52A1\u8D4B\u80FD\u89C4\u5212\u5E08.skill")
  }),
  step({
    id: "S10",
    layer: "strategy",
    kind: "agent",
    sequence: 150,
    title: "\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868",
    buttonLabel: "\u786E\u8BA4\u8868",
    description: "\u57FA\u4E8E S1-S9 \u7B56\u7565\u6210\u679C\u548C\u5E94\u7B54\u903B\u8F91\u786E\u8BA4\u8868\uFF0C\u751F\u6210\u5BA2\u6237\u6700\u7EC8\u786E\u8BA4\u7528\u7684\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868\u3002",
    owner: "S10 \u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868\u751F\u6210\u5E08",
    inputs: ["S1-S9 \u8D44\u6599\u5305", "\u5E94\u7B54\u903B\u8F91\u786E\u8BA4\u8868", "\u5BA2\u6237\u786E\u8BA4\u53E3\u5F84"],
    outputs: [
      "S10_{brand}_\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868.xlsx",
      "{brand}_\u54C1\u724C\u4FE1\u606F\u4FEE\u6539\u6E05\u5355.json"
    ],
    dependencies: ["S9"],
    phase: "\u7B56\u7565\u5C42\u6700\u7EC8\u786E\u8BA4",
    privateSources: strategySources("Strategy_Workflow/S10.\u54C1\u724C\u4FE1\u606F\u786E\u8BA4\u8868\u751F\u6210\u5E08.skill")
  }),
  step({
    id: "STRATEGY_PACK",
    layer: "strategy",
    kind: "export",
    sequence: 160,
    title: "\u7B56\u7565\u5305\u5BFC\u51FA",
    buttonLabel: "\u5BFC\u51FA\u7B56\u7565\u5305",
    description: "\u5C01\u88C5 S1-S10 \u5DE5\u7A0B\u8D44\u4EA7\u4E0E\u5BA2\u6237\u786E\u8BA4\u8BB0\u5F55\uFF0C\u5F62\u6210\u6267\u884C\u5C42\u552F\u4E00\u4EA4\u63A5\u6587\u4EF6\u3002",
    owner: "S0 \u7B56\u7565\u7F16\u6392\u5E08",
    inputs: ["S1-S10 \u5DE5\u7A0B\u4EA7\u7269", "\u5BA2\u6237\u786E\u8BA4\u8BB0\u5F55", "pause_log"],
    outputs: ["S0_{brand}_strategy_pack_vN.json", "\u7B56\u7565\u5C42\u6267\u884C\u65E5\u5FD7"],
    dependencies: ["S10"],
    phase: "\u7B56\u7565\u5C42\u4EA4\u4ED8",
    privateSources: strategySources("Strategy_Workflow/S0.\u7B56\u7565\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "E0",
    layer: "execution",
    kind: "agent",
    sequence: 210,
    title: "\u6267\u884C\u7F16\u6392",
    buttonLabel: "\u5BFC\u5165\u7B56\u7565\u5305",
    description: "\u8BFB\u53D6 strategy_pack\uFF0C\u5EFA\u7ACB\u6267\u884C\u5C42\u4EFB\u52A1\u4E0A\u4E0B\u6587\u4E0E\u4EA7\u7269\u8DEF\u7EBF\u3002",
    owner: "E0 \u6267\u884C\u7F16\u6392\u5E08",
    inputs: ["strategy_pack_vN.json", "recommended_business_actions", "\u4F01\u4E1A\u63D0\u4EA4\u56FE\u7247\u5E93"],
    outputs: ["\u6267\u884C\u8DEF\u7531", "\u4EFB\u52A1\u62C6\u5206", "\u56FE\u7247\u5E93\u6821\u9A8C\u62A5\u544A"],
    dependencies: ["STRATEGY_PACK"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E0.\u6267\u884C\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "E1",
    layer: "execution",
    kind: "agent",
    sequence: 220,
    title: "\u5185\u5BB9\u7B56\u7565\u83DC\u5355",
    buttonLabel: "\u5185\u5BB9\u83DC\u5355",
    description: "\u751F\u6210\u4E3B\u9898\u77E9\u9635\u3001\u4F18\u5148\u7EA7\u3001\u5185\u5BB9\u7C7B\u578B\u548C\u5F85\u751F\u4EA7\u6E05\u5355\u3002",
    owner: "E1 \u5185\u5BB9\u7B56\u7565\u5E08",
    inputs: ["strategy_pack", "\u4E1A\u52A1\u76EE\u6807"],
    outputs: ["topic_matrix.json", "content_menu.md"],
    dependencies: ["E0"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E1.\u5185\u5BB9\u7B56\u7565\u5E08.skill")
  }),
  step({
    id: "EP4",
    layer: "execution",
    kind: "pause",
    sequence: 230,
    title: "\u5BA1\u6279\u751F\u4EA7\u5185\u5BB9",
    buttonLabel: "\u5BA1\u6279\u5185\u5BB9",
    description: "\u786E\u8BA4\u672C\u8F6E\u8981\u751F\u4EA7\u7684\u6587\u7AE0\u3001\u7D20\u6750\u548C\u4F18\u5148\u7EA7\u3002",
    owner: "\u4EBA\u5DE5\u786E\u8BA4\u70B9 4",
    inputs: ["E1 \u83DC\u5355", "\u5BA1\u6279\u610F\u89C1"],
    outputs: ["\u5DF2\u6279\u51C6\u5185\u5BB9\u6E05\u5355"],
    dependencies: ["E1"],
    phase: "\u6267\u884C\u5C42\u786E\u8BA4",
    privateSources: []
  }),
  step({
    id: "E2",
    layer: "execution",
    kind: "agent",
    sequence: 240,
    title: "\u6587\u5B57\u5185\u5BB9\u751F\u6210",
    buttonLabel: "\u751F\u6210\u6587\u7AE0",
    description: "\u6309\u83B7\u6279\u4E3B\u9898\u751F\u6210\u6587\u7AE0\u3001FAQ\u3001\u6458\u8981\u548C\u56FE\u7247\u9700\u6C42\u8BF4\u660E\u3002",
    owner: "E2 \u6587\u5B57\u5185\u5BB9\u751F\u6210\u5E08",
    inputs: ["\u83B7\u6279\u4E3B\u9898", "\u8BDD\u8BED\u4F53\u7CFB", "\u5185\u5BB9\u8981\u6C42"],
    outputs: ["article.md", "image_requirements.json"],
    dependencies: ["EP4"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E2.\u6587\u5B57\u5185\u5BB9\u751F\u6210\u5E08.skill")
  }),
  step({
    id: "E3",
    layer: "execution",
    kind: "agent",
    sequence: 250,
    title: "\u89C6\u89C9\u8D44\u4EA7\u751F\u6210",
    buttonLabel: "\u751F\u6210\u89C6\u89C9",
    description: "\u6839\u636E\u89C6\u89C9\u89C4\u8303\u4E0E\u56FE\u7247\u9700\u6C42\u751F\u6210\u6216\u7EC4\u7EC7\u56FE\u7247\u8D44\u4EA7\u3002",
    owner: "E3 \u89C6\u89C9\u8D44\u4EA7\u751F\u6210\u5E08",
    inputs: ["image_requirements", "visual_prompt_pack"],
    outputs: ["\u89C6\u89C9\u56FE\u7247", "\u6821\u9A8C\u8BB0\u5F55"],
    dependencies: ["E2"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E3.\u89C6\u89C9\u8D44\u4EA7\u751F\u6210\u5E08.skill")
  }),
  step({
    id: "E4",
    layer: "execution",
    kind: "agent",
    sequence: 260,
    title: "\u5BA1\u67E5\u4E0E\u7EC4\u88C5",
    buttonLabel: "\u5BA1\u67E5\u7EC4\u88C5",
    description: "\u5B8C\u6210\u8D28\u91CF\u68C0\u67E5\u3001\u54C1\u724C\u4E00\u81F4\u6027\u5BA1\u67E5\u548C\u6587\u6863\u88C5\u914D\u3002",
    owner: "E4 \u8D28\u91CF\u5BA1\u67E5\u4E0E\u7EC4\u88C5\u5E08",
    inputs: ["\u6587\u7AE0", "\u56FE\u7247", "\u54C1\u724C\u89C4\u5219"],
    outputs: ["DOCX", "\u8D28\u91CF\u5BA1\u67E5\u62A5\u544A"],
    dependencies: ["E3"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources(
      "Execution_Workflow/E4.\u8D28\u91CF\u5BA1\u67E5\u4E0E\u7EC4\u88C5\u5E08.skill"
    )
  }),
  step({
    id: "E5",
    layer: "execution",
    kind: "agent",
    sequence: 270,
    title: "\u5206\u53D1\u7F16\u6392",
    buttonLabel: "\u5206\u53D1\u7F16\u6392",
    description: "\u9002\u914D\u6E20\u9053\u3001\u751F\u6210\u5206\u53D1\u8BA1\u5212\u548C GEO \u4F18\u5316\u5EFA\u8BAE\u3002",
    owner: "E5 \u5206\u53D1\u7F16\u6392\u5E08",
    inputs: ["\u5DF2\u5BA1\u5185\u5BB9", "\u6E20\u9053\u8981\u6C42"],
    outputs: ["channel_plan.json", "\u5206\u53D1\u6E05\u5355"],
    dependencies: ["E4"],
    phase: "\u6267\u884C\u5C42",
    privateSources: executionSources("Execution_Workflow/E5.\u5206\u53D1\u7F16\u6392\u5E08.skill")
  }),
  step({
    id: "EP5",
    layer: "execution",
    kind: "pause",
    sequence: 280,
    title: "\u7EE7\u7EED\u751F\u4EA7\u786E\u8BA4",
    buttonLabel: "\u7EE7\u7EED\u786E\u8BA4",
    description: "E5 \u5B8C\u6210\u540E\u786E\u8BA4\u7ED3\u675F\u3001\u56DE\u9009\u9898\u5BA1\u6279\u3001\u56DE E1 \u6216\u8FD4\u56DE\u7B56\u7565\u5C42\u3002",
    owner: "E5-END \u7EE7\u7EED\u751F\u4EA7\u786E\u8BA4",
    inputs: ["E5 \u5206\u53D1\u6B63\u672C", "\u7EE7\u7EED\u751F\u4EA7\u9009\u62E9"],
    outputs: ["\u7ED3\u675F / \u56DE\u6682\u505C5 / \u56DE E1 / \u8FD4\u56DE\u7B56\u7565\u5C42"],
    dependencies: ["E5"],
    phase: "\u6267\u884C\u5C42\u786E\u8BA4",
    privateSources: []
  })
];
var workflowRootCandidates = [
  process.env.FRONTMIND_WORKFLOW_ROOT,
  path4.resolve(import.meta.dirname, "..", "private-workflows", "FrontMind_Workflow"),
  path4.resolve(import.meta.dirname, "..", "..", "private-workflows", "FrontMind_Workflow")
].filter(Boolean);
var workflowManifest = {
  workflowId: "frontmind-unified-workflow",
  title: "FrontMind Workflow",
  version: "v3.1-panorama-report",
  description: "",
  steps: steps.filter((stepData) => stepData.id !== "S0").map(({ privateSources: _privateSources, ...publicStep }) => publicStep),
  securityRules: []
};
function getPrivateWorkflowStep(stepId) {
  return steps.find((item) => item.id === stepId) ?? null;
}
async function resolveWorkflowRoot() {
  for (const candidate of workflowRootCandidates) {
    try {
      const stat = await fs4.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
    }
  }
  return null;
}
function isInsideRoot(candidatePath, rootPath) {
  const relative = path4.relative(rootPath, candidatePath);
  return relative === "" || !relative.startsWith("..") && !path4.isAbsolute(relative);
}
async function readPrivateFileStats(filePath) {
  const content = await fs4.readFile(filePath);
  return {
    checkedFiles: 1,
    availableFiles: 1,
    loadedBytes: content.byteLength
  };
}
async function readPrivateDirectoryStats(dirPath) {
  let checkedFiles = 0;
  let availableFiles = 0;
  let loadedBytes = 0;
  const entries = await fs4.readdir(dirPath, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith(".")).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of visibleEntries) {
    const entryPath = path4.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await readPrivateDirectoryStats(entryPath);
      checkedFiles += nested.checkedFiles;
      availableFiles += nested.availableFiles;
      loadedBytes += nested.loadedBytes;
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    checkedFiles += 1;
    try {
      const fileStats = await readPrivateFileStats(entryPath);
      availableFiles += fileStats.availableFiles;
      loadedBytes += fileStats.loadedBytes;
    } catch {
    }
  }
  return { checkedFiles, availableFiles, loadedBytes };
}
async function readPrivateSourceStats(workflowRoot, relativeSource) {
  const rootPath = path4.resolve(workflowRoot);
  const fullPath = path4.resolve(rootPath, relativeSource);
  if (!isInsideRoot(fullPath, rootPath)) {
    return { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
  }
  try {
    const stat = await fs4.stat(fullPath);
    if (stat.isDirectory()) {
      const directoryStats = await readPrivateDirectoryStats(fullPath);
      return directoryStats.checkedFiles > 0 ? directoryStats : { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
    }
    if (stat.isFile()) {
      return readPrivateFileStats(fullPath);
    }
  } catch {
  }
  return { checkedFiles: 1, availableFiles: 0, loadedBytes: 0 };
}
function artifactKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".html") || lower.includes("\u7F51\u7AD9") || lower.includes("astro") || lower.includes("json-ld")) return "site";
  if (lower.endsWith(".docx") || lower.endsWith(".pdf") || lower.endsWith(".xlsx") || lower.includes("docx")) return "document";
  if (lower.endsWith(".md") || lower.includes("\u62A5\u544A") || lower.includes("\u6E05\u5355")) return "markdown";
  if (lower.includes("\u56FE\u7247") || lower.includes("\u89C6\u89C9")) return "image";
  return "package";
}
async function loadPrivateSkillPackage(stepId) {
  const stepData = getPrivateWorkflowStep(stepId);
  if (!stepData) {
    return null;
  }
  const workflowRoot = await resolveWorkflowRoot();
  if (!workflowRoot) {
    return {
      step: stepData,
      workflowRootConfigured: false,
      checkedSources: stepData.privateSources.length,
      availableSources: 0,
      loadedBytes: 0,
      loaded: stepData.privateSources.length === 0,
      artifactPlaceholders: stepData.outputs.map((name) => ({ name, kind: artifactKind(name) }))
    };
  }
  let checkedSources = 0;
  let availableSources = 0;
  let loadedBytes = 0;
  for (const relativeSource of stepData.privateSources) {
    const sourceStats = await readPrivateSourceStats(workflowRoot, relativeSource);
    checkedSources += sourceStats.checkedFiles;
    availableSources += sourceStats.availableFiles;
    loadedBytes += sourceStats.loadedBytes;
  }
  return {
    step: stepData,
    workflowRootConfigured: true,
    checkedSources,
    availableSources,
    loadedBytes,
    loaded: stepData.privateSources.length === 0 || checkedSources > 0 && availableSources === checkedSources,
    artifactPlaceholders: stepData.outputs.map((name) => ({ name, kind: artifactKind(name) }))
  };
}
function buildOperatorMessages(kind, title, inputs, outputs, hasOperatorNotes) {
  if (kind === "pause") {
    return [
      `${title} \u5DF2\u8BB0\u5F55\u4E3A\u4EBA\u5DE5\u786E\u8BA4\u8282\u70B9\u3002`,
      hasOperatorNotes ? "\u64CD\u4F5C\u8005\u8865\u5145\u610F\u89C1\u5DF2\u8BB0\u5F55\u3002" : "\u5F53\u524D\u53EF\u76F4\u63A5\u786E\u8BA4\uFF0C\u4E5F\u53EF\u4EE5\u8865\u5145\u4FEE\u6B63\u610F\u89C1\u540E\u518D\u786E\u8BA4\u3002",
      `\u786E\u8BA4\u540E\u5C06\u89E3\u9501\u4E0B\u4E00\u6B65\uFF0C\u9884\u671F\u8F93\u51FA\uFF1A${outputs.join("\u3001")}\u3002`
    ];
  }
  return [
    `${title} \u5DF2\u8FDB\u5165\u5F53\u524D\u4EFB\u52A1\u3002`,
    hasOperatorNotes ? "\u64CD\u4F5C\u8005\u8865\u5145\u5DF2\u8BB0\u5F55\u3002" : `\u5EFA\u8BAE\u8865\u5145\uFF1A${inputs.join("\u3001")}\u3002`,
    `\u672C\u73AF\u8282\u9884\u671F\u751F\u6210\uFF1A${outputs.join("\u3001")}\u3002`
  ];
}

// server/workflow-api.ts
var router3 = Router2();
var uploadsRoot = path5.resolve(process.cwd(), ".workflow-uploads");
var uploadIndexName = "index.json";
var defaultUploadRetentionMs = 24 * 60 * 60 * 1e3;
function asyncRoute(handler) {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}
function sanitizeSegment(value, fallback) {
  const safe = String(value || "").replace(/[\\/\0]/g, "_").replace(/^\.+$/, "").trim().slice(0, 140);
  return safe || fallback;
}
function sanitizeFileName(value) {
  return sanitizeSegment(value, "upload.bin");
}
function safeDecodeHeader(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function getUploadDir(userId, runId, stepId) {
  return path5.join(
    uploadsRoot,
    String(userId),
    sanitizeSegment(runId, "run"),
    sanitizeSegment(stepId, "step")
  );
}
function toPublicUpload(file) {
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    stepId: file.stepId,
    uploadedAt: file.uploadedAt
  };
}
async function readUploadIndex(userId, runId, stepId) {
  const indexPath = path5.join(getUploadDir(userId, runId, stepId), uploadIndexName);
  try {
    const raw = await fs5.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function writeUploadIndex(userId, runId, stepId, files) {
  const uploadDir = getUploadDir(userId, runId, stepId);
  await fs5.mkdir(uploadDir, { recursive: true });
  await fs5.writeFile(path5.join(uploadDir, uploadIndexName), JSON.stringify(files, null, 2), "utf-8");
}
async function cleanupStaleWorkflowUploads() {
  const retentionMs = Number(process.env.FRONTMIND_WORKFLOW_UPLOAD_TTL_MS || defaultUploadRetentionMs);
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return;
  let userEntries;
  try {
    userEntries = await fs5.readdir(uploadsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionMs;
  await Promise.all(
    userEntries.filter((entry) => entry.isDirectory()).map(async (userEntry) => {
      const userPath = path5.join(uploadsRoot, userEntry.name);
      try {
        const runEntries = await fs5.readdir(userPath, { withFileTypes: true });
        await Promise.all(
          runEntries.filter((entry) => entry.isDirectory()).map(async (runEntry) => {
            const runPath = path5.join(userPath, runEntry.name);
            const stat = await fs5.stat(runPath);
            if (stat.mtimeMs < cutoff) {
              await fs5.rm(runPath, { recursive: true, force: true });
            }
          })
        );
        if ((await fs5.readdir(userPath)).length === 0) {
          await fs5.rmdir(userPath);
        }
      } catch {
      }
    })
  );
}
async function listPublicUploads(userId, runId, stepId) {
  const files = await readUploadIndex(userId, runId, stepId);
  return files.map(toPublicUpload);
}
async function addPathToZip(zip, workflowRoot, relativeSource) {
  const rootPath = path5.resolve(workflowRoot);
  const fullPath = path5.resolve(rootPath, relativeSource);
  const relativeToRoot = path5.relative(rootPath, fullPath);
  if (relativeToRoot.startsWith("..") || path5.isAbsolute(relativeToRoot)) {
    return;
  }
  const stat = await fs5.stat(fullPath);
  if (stat.isFile()) {
    const buffer = await fs5.readFile(fullPath);
    zip.file(path5.posix.join("workflow", relativeToRoot.split(path5.sep).join("/")), buffer);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const entries = await fs5.readdir(fullPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    await addPathToZip(zip, workflowRoot, path5.join(relativeSource, entry.name));
  }
}
function buildRunContextMarkdown(step2, body, uploads) {
  const fields = body.fields || {};
  const fieldRows = Object.entries(fields).filter(([, value]) => String(value || "").trim().length > 0).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- \u65E0";
  const uploadRows = uploads.map((file) => `- ${file.name} (${file.type || "application/octet-stream"}, ${file.size} bytes)`).join("\n") || "- \u65E0";
  return [
    `# FrontMind Workflow Run Context`,
    ``,
    `## Step`,
    `- id: ${step2.id}`,
    `- title: ${step2.title}`,
    `- owner: ${step2.owner}`,
    `- phase: ${step2.phase}`,
    ``,
    `## Operator Fields`,
    fieldRows,
    ``,
    `## Operator Notes`,
    String(body.operatorNotes || "").trim() || "\u65E0",
    ``,
    `## Uploaded Files`,
    uploadRows,
    ``,
    `## Expected Outputs`,
    step2.outputs.map((output) => `- ${output}`).join("\n"),
    ``
  ].join("\n");
}
function buildCurrentStepGateMarkdown(step2) {
  return [
    `# Current Step Gate`,
    ``,
    `## Current Step`,
    `- id: ${step2.id}`,
    `- title: ${step2.title}`,
    `- owner: ${step2.owner}`,
    `- phase: ${step2.phase}`,
    ``,
    `## Execution Boundary`,
    `This run loads the complete FrontMind Workflow package for global context.`,
    `Execute the workflow only until the current step above is complete, then stop.`,
    `Do not continue into downstream steps even if the original workflow instructions would normally proceed automatically.`,
    ``,
    `## Required Output Boundary`,
    `Begin the response with the current step id and title.`,
    `Output only the deliverables for this current step.`,
    `If required inputs are missing, list the missing items and pause at this step.`,
    ``,
    `## Current Step Expected Outputs`,
    step2.outputs.map((output) => `- ${output}`).join("\n"),
    ``
  ].join("\n");
}
async function buildExecutionBundle(userId, step2, runId, body, uploads) {
  const workflowRoot = await resolveWorkflowRoot();
  if (!workflowRoot) {
    throw new Error("Workflow root not configured");
  }
  const zip = new JSZip();
  await addPathToZip(zip, workflowRoot, ".");
  const storedUploads = await readUploadIndex(userId, runId, step2.id);
  const uploadDir = getUploadDir(userId, runId, step2.id);
  for (const upload of storedUploads) {
    const uploadPath = path5.join(uploadDir, upload.storedName);
    const buffer = await fs5.readFile(uploadPath);
    zip.file(path5.posix.join("user_uploads", step2.id, upload.name), buffer);
  }
  zip.file("RUN_CONTEXT.md", buildRunContextMarkdown(step2, body, uploads));
  zip.file("CURRENT_STEP_GATE.md", buildCurrentStepGateMarkdown(step2));
  zip.file("PUBLIC_STEP.json", JSON.stringify({
    id: step2.id,
    layer: step2.layer,
    kind: step2.kind,
    title: step2.title,
    owner: step2.owner,
    inputs: step2.inputs,
    outputs: step2.outputs,
    dependencies: step2.dependencies,
    phase: step2.phase,
    currentStepOnly: true
  }, null, 2));
  zip.file("PUBLIC_WORKFLOW_MANIFEST.json", JSON.stringify(workflowManifest, null, 2));
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}
async function uploadBufferToFrontMind(baseUrl, apiKey, filename, buffer, contentType = "application/zip") {
  const fileRecordResponse = await axios3.post(
    `${baseUrl}/v1/files`,
    { filename },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 12e4,
      validateStatus: () => true
    }
  );
  if (fileRecordResponse.status < 200 || fileRecordResponse.status >= 300) {
    throw new Error(`Create file record failed (${fileRecordResponse.status})`);
  }
  const fileRecord = fileRecordResponse.data;
  if (!fileRecord?.id || !fileRecord?.upload_url) {
    throw new Error("Create file record failed: missing file id or upload url");
  }
  const uploadResponse = await axios3.put(
    assertSafeExternalUrl(fileRecord.upload_url),
    buffer,
    {
      ...safeExternalRequestOptions,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length)
      },
      timeout: 3e5,
      maxBodyLength: buffer.length,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true
    }
  );
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new Error(`Upload file failed (${uploadResponse.status})`);
  }
  return { fileId: fileRecord.id, filename };
}
async function uploadFilePathToFrontMind(baseUrl, apiKey, filename, filePath, contentType = "application/octet-stream") {
  const fileRecordResponse = await axios3.post(
    `${baseUrl}/v1/files`,
    { filename },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 12e4,
      validateStatus: () => true
    }
  );
  if (fileRecordResponse.status < 200 || fileRecordResponse.status >= 300) {
    throw new Error(`Create file record failed (${fileRecordResponse.status})`);
  }
  const fileRecord = fileRecordResponse.data;
  if (!fileRecord?.id || !fileRecord?.upload_url) {
    throw new Error("Create file record failed: missing file id or upload url");
  }
  const stat = await fs5.stat(filePath);
  const uploadResponse = await axios3.put(
    assertSafeExternalUrl(fileRecord.upload_url),
    createReadStream2(filePath),
    {
      ...safeExternalRequestOptions,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size)
      },
      timeout: 3e5,
      maxBodyLength: Infinity,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true
    }
  );
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new Error(`Upload file failed (${uploadResponse.status})`);
  }
  return { fileId: fileRecord.id, filename };
}
async function uploadStoredUserFiles(userId, baseUrl, apiKey, runId, stepId) {
  const storedUploads = await readUploadIndex(userId, runId, stepId);
  const uploadDir = getUploadDir(userId, runId, stepId);
  const attachments2 = [];
  for (const upload of storedUploads) {
    const uploaded = await uploadFilePathToFrontMind(
      baseUrl,
      apiKey,
      upload.name,
      path5.join(uploadDir, upload.storedName),
      upload.type || "application/octet-stream"
    );
    attachments2.push({ file_id: uploaded.fileId, filename: uploaded.filename });
  }
  return attachments2;
}
function buildAgentPrompt(step2) {
  return [
    `\u8BF7\u542F\u52A8\u5B8C\u6574 FrontMind Workflow\uFF0C\u5E76\u6267\u884C\u5230\u5F53\u524D\u95F8\u95E8\u73AF\u8282\uFF1A${step2.id}\u300C${step2.title}\u300D\u3002`,
    ``,
    `\u4F60\u4F1A\u6536\u5230\u4E00\u4E2A\u5B8C\u6574 workflow \u6267\u884C\u5305 ZIP\u3002\u8BF7\u5148\u89E3\u538B\u5E76\u6309\u987A\u5E8F\u8BFB\u53D6\uFF1A`,
    `1. RUN_CONTEXT.md\uFF1A\u672C\u6B21\u7528\u6237\u8F93\u5165\u3001\u4E0A\u4F20\u8D44\u6599\u548C\u8FD0\u884C\u4E0A\u4E0B\u6587\u3002`,
    `2. workflow/Master_Control/FrontMind_Master_Control.md \u4E0E workflow/00.FrontMind\u603B\u63A7\u8DEF\u7531.skill\uFF1A\u5B8C\u6574\u5DE5\u4F5C\u6D41\u603B\u63A7\u3002`,
    `3. CURRENT_STEP_GATE.md\uFF1A\u672C\u6B21\u5F3A\u5236\u505C\u987F\u7684\u5F53\u524D\u73AF\u8282\u3002`,
    `4. workflow/Strategy_Workflow \u4E0E workflow/Execution_Workflow\uFF1A\u5B8C\u6574\u7B56\u7565\u5C42\u4E0E\u6267\u884C\u5C42 skill\u3002`,
    `\u5982\u6709\u7528\u6237\u4E0A\u4F20\u8D44\u6599\uFF0C\u4E5F\u4F1A\u5728\u9644\u4EF6\u4E2D\u5355\u72EC\u63D0\u4F9B\uFF0C\u5E76\u5728 ZIP \u7684 user_uploads/ \u4E2D\u5907\u4EFD\u3002`,
    ``,
    `\u6267\u884C\u8981\u6C42\uFF1A`,
    `1. \u5148\u5EFA\u7ACB\u5B8C\u6574 FrontMind Workflow \u7684\u5168\u5C40\u4E0A\u4E0B\u6587\uFF0C\u518D\u8FDB\u5165 ${step2.id}\u300C${step2.title}\u300D\u3002`,
    `2. \u6309 ${step2.owner} \u7684\u804C\u8D23\u6267\u884C\u5F53\u524D\u73AF\u8282\u3002`,
    `3. \u53EA\u8F93\u51FA\u5F53\u524D\u73AF\u8282\u7ED3\u679C\uFF0C\u5F00\u5934\u660E\u786E\u6807\u6CE8\u201C\u5F53\u524D\u73AF\u8282\uFF1A${step2.id} ${step2.title}\u201D\u3002`,
    `4. \u5F53\u524D\u73AF\u8282\u5B8C\u6210\u540E\u5FC5\u987B\u6682\u505C\uFF0C\u4E0D\u8981\u81EA\u52A8\u7EE7\u7EED\u540E\u7EED S/E/P \u73AF\u8282\u3002`,
    `5. \u5982\u679C\u7F3A\u5C11\u5FC5\u8981\u8D44\u6599\uFF0C\u660E\u786E\u5217\u51FA\u7F3A\u53E3\u5E76\u505C\u5728\u5F53\u524D\u73AF\u8282\u3002`,
    ``,
    `\u5F53\u524D\u73AF\u8282\u9884\u671F\u4EA7\u7269\uFF1A`,
    step2.outputs.map((output) => `- ${output}`).join("\n")
  ].join("\n");
}
router3.get("/manifest", (_req, res) => {
  res.json(workflowManifest);
});
router3.delete("/runs/:runId", asyncRoute(async (req, res) => {
  const runId = sanitizeSegment(String(req.params.runId || ""), "");
  if (!runId) {
    res.status(400).json({ error: "Missing run id" });
    return;
  }
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55" });
    return;
  }
  await fs5.rm(path5.join(uploadsRoot, String(userId), runId), {
    recursive: true,
    force: true
  });
  res.json({ success: true });
}));
router3.post(
  "/runs/:runId/steps/:stepId/uploads",
  asyncRoute(async (req, res) => {
    const runId = sanitizeSegment(String(req.params.runId || ""), `wf_${randomUUID4()}`);
    const stepId = String(req.params.stepId || "");
    const step2 = getPrivateWorkflowStep(stepId);
    const userId = req.frontmindUser?.id;
    if (!userId) {
      res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55" });
      return;
    }
    if (!step2) {
      res.status(404).json({ error: "Unknown workflow step" });
      return;
    }
    const originalName = sanitizeFileName(safeDecodeHeader(String(req.header("x-file-name") || "upload.bin")));
    const contentType = String(req.header("x-file-type") || "application/octet-stream");
    const id = randomUUID4();
    const storedName = `${id}_${originalName}`;
    const uploadDir = getUploadDir(userId, runId, step2.id);
    await fs5.mkdir(uploadDir, { recursive: true });
    const storedPath = path5.join(uploadDir, storedName);
    const temporaryPath = `${storedPath}.tmp`;
    let uploadedBytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        uploadedBytes += chunk.length;
        callback(null, chunk);
      }
    });
    try {
      await pipeline(
        req,
        counter,
        createWriteStream(temporaryPath, { mode: 384 })
      );
      if (uploadedBytes === 0) {
        await fs5.rm(temporaryPath, { force: true });
        res.status(400).json({ error: "Empty upload body" });
        return;
      }
      await fs5.rename(temporaryPath, storedPath);
    } catch (error) {
      await fs5.rm(temporaryPath, { force: true });
      throw error;
    }
    const file = {
      id,
      storedName,
      name: originalName,
      type: contentType,
      size: uploadedBytes,
      stepId: step2.id,
      uploadedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const index2 = await readUploadIndex(userId, runId, step2.id);
    index2.push(file);
    await writeUploadIndex(userId, runId, step2.id, index2);
    const response = {
      runId,
      stepId: step2.id,
      file: toPublicUpload(file)
    };
    res.json(response);
  })
);
router3.post("/steps/:stepId/load", asyncRoute(async (req, res) => {
  const stepId = String(req.params.stepId || "");
  const body = req.body || {};
  const loadedPackage = await loadPrivateSkillPackage(stepId);
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55" });
    return;
  }
  if (!loadedPackage) {
    res.status(404).json({ error: "Unknown workflow step" });
    return;
  }
  const runId = body.runId || `wf_${randomUUID4()}`;
  const sessionId = `exec_${stepId}_${randomUUID4()}`;
  const hasOperatorNotes = typeof body.operatorNotes === "string" && body.operatorNotes.trim().length > 0;
  const loaded = loadedPackage.loaded;
  const contextUploads = await listPublicUploads(userId, runId, stepId);
  const uploadMessages = contextUploads.length > 0 ? [`\u5DF2\u7EB3\u5165 ${contextUploads.length} \u4E2A\u4E0A\u4F20\u6587\u4EF6\uFF1A${contextUploads.map((file) => file.name).join("\u3001")}\u3002`] : [];
  const response = {
    runId,
    stepId,
    status: loaded ? "loaded" : "missing_private_package",
    loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId,
    nextStatus: loaded ? "done" : "unavailable",
    serverLoad: {
      privatePackageLoaded: loaded,
      workflowRootConfigured: loadedPackage.workflowRootConfigured,
      checkedSources: loadedPackage.checkedSources,
      availableSources: loadedPackage.availableSources,
      loadedBytes: loadedPackage.loadedBytes,
      promptVisibleToClient: false,
      returnedPromptContent: false
    },
    contextUploads,
    operatorMessages: [
      ...buildOperatorMessages(
        loadedPackage.step.kind,
        loadedPackage.step.title,
        loadedPackage.step.inputs,
        loadedPackage.step.outputs,
        hasOperatorNotes
      ),
      ...uploadMessages
    ],
    artifactPlaceholders: loadedPackage.artifactPlaceholders,
    safety: {
      promptStoredServerSide: true,
      frontendReceivesPublicManifestOnly: true,
      rawSkillContentReturned: false
    }
  };
  res.json(response);
}));
router3.post("/steps/:stepId/execute", asyncRoute(async (req, res) => {
  const stepId = String(req.params.stepId || "");
  const body = req.body || {};
  const loadedPackage = await loadPrivateSkillPackage(stepId);
  const step2 = getPrivateWorkflowStep(stepId);
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55" });
    return;
  }
  if (!loadedPackage || !step2) {
    res.status(404).json({ error: "Unknown workflow step" });
    return;
  }
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  const runId = body.runId || `wf_${randomUUID4()}`;
  const sessionId = `exec_${stepId}_${randomUUID4()}`;
  const hasOperatorNotes = typeof body.operatorNotes === "string" && body.operatorNotes.trim().length > 0;
  const contextUploads = await listPublicUploads(userId, runId, stepId);
  try {
    const bundle = await buildExecutionBundle(
      userId,
      step2,
      runId,
      body,
      contextUploads
    );
    const bundleFile = await uploadBufferToFrontMind(
      baseUrl,
      apiKey,
      `FrontMind_${step2.id}_${runId}_full_workflow_bundle.zip`,
      bundle,
      "application/zip"
    );
    const userFileAttachments = await uploadStoredUserFiles(
      userId,
      baseUrl,
      apiKey,
      runId,
      stepId
    );
    const attachments2 = [
      { filename: bundleFile.filename, file_id: bundleFile.fileId },
      ...userFileAttachments
    ];
    if (!req.frontmindUser || !req.frontmindCredential) {
      res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55\u5E76\u914D\u7F6E API Key" });
      return;
    }
    for (const attachment of attachments2) {
      await recordUpstreamResource({
        userId: req.frontmindUser.id,
        apiCredentialId: req.frontmindCredential.id,
        kind: "file",
        upstreamId: attachment.file_id
      });
    }
    const taskResponse = await axios3.post(
      `${baseUrl}/v1/tasks`,
      {
        prompt: buildAgentPrompt(step2),
        agentProfile: toUpstreamAgentProfile(body.agentProfile),
        taskMode: "agent",
        attachments: attachments2
      },
      {
        headers: {
          "Content-Type": "application/json",
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 12e4,
        validateStatus: () => true
      }
    );
    if (taskResponse.status < 200 || taskResponse.status >= 300) {
      const detail = taskResponse.data?.error?.message || taskResponse.data?.message || `Create task failed (${taskResponse.status})`;
      console.warn("[Workflow Execute] create task failed:", detail);
      res.status(taskResponse.status).json({ error: "\u521B\u5EFA\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u6216\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    const taskData = taskResponse.data || {};
    const taskId = taskData.id || taskData.task_id;
    if (!taskId) {
      res.status(502).json({ error: "Create task failed: missing task id" });
      return;
    }
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(taskId)
    });
    const normalizedStatus = taskData.status === "failed" ? "error" : taskData.status || "running";
    const uploadMessages = contextUploads.length > 0 ? [`\u5DF2\u7EB3\u5165 ${contextUploads.length} \u4E2A\u4E0A\u4F20\u6587\u4EF6\uFF1A${contextUploads.map((file) => file.name).join("\u3001")}\u3002`] : [];
    const response = {
      runId,
      stepId,
      status: loadedPackage.loaded ? "loaded" : "missing_private_package",
      loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
      sessionId,
      task: {
        id: taskId,
        status: normalizedStatus,
        taskUrl: taskData.task_url || taskData.metadata?.task_url,
        title: taskData.task_title || taskData.metadata?.task_title
      },
      nextStatus: loadedPackage.loaded ? "done" : "unavailable",
      serverLoad: {
        privatePackageLoaded: loadedPackage.loaded,
        workflowRootConfigured: loadedPackage.workflowRootConfigured,
        checkedSources: loadedPackage.checkedSources,
        availableSources: loadedPackage.availableSources,
        loadedBytes: loadedPackage.loadedBytes,
        promptVisibleToClient: false,
        returnedPromptContent: false
      },
      contextUploads,
      operatorMessages: [
        `\u5DF2\u8F7D\u5165\u5B8C\u6574 FrontMind Workflow \u5305\uFF0C\u5E76\u5B9A\u4F4D\u5230\u5F53\u524D\u73AF\u8282\uFF1A${step2.id}\u300C${step2.title}\u300D\u3002`,
        `\u672C\u6B21\u8FD0\u884C\u4F1A\u5728\u5F53\u524D\u73AF\u8282\u5B8C\u6210\u540E\u6682\u505C\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u7EE7\u7EED\u540E\u7EED\u73AF\u8282\u3002`,
        ...buildOperatorMessages(
          step2.kind,
          step2.title,
          step2.inputs,
          step2.outputs,
          hasOperatorNotes
        ),
        ...uploadMessages
      ],
      artifactPlaceholders: loadedPackage.artifactPlaceholders,
      safety: {
        promptStoredServerSide: true,
        frontendReceivesPublicManifestOnly: true,
        rawSkillContentReturned: false
      }
    };
    res.json(response);
  } catch (error) {
    console.error("[Workflow Execute] error:", error.message);
    res.status(500).json({ error: "\u6267\u884C\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
  }
}));
var workflow_api_default = router3;

// server/news-release-api.ts
import axios4 from "axios";
import { Router as Router3 } from "express";
var router4 = Router3();
function sanitizeFilename2(value, fallback) {
  const safe = String(value || "").replace(/[\\/\0]/g, "_").replace(/^\.+$/, "").trim().slice(0, 160);
  return safe || fallback;
}
function normalizeUserAttachments(attachments2) {
  return (attachments2 || []).map((attachment) => {
    const fileId = attachment.file_id || attachment.fileId || "";
    const filename = sanitizeFilename2(
      attachment.filename || attachment.name || "user_material",
      "user_material"
    );
    return fileId ? { file_id: fileId, filename } : null;
  }).filter(Boolean);
}
function buildPublishedNewsReleasePrompt(companyName, operatorNotes) {
  const template = `\u4F60\u662F\u4E00\u540D\u8D44\u6DF1\u4F01\u4E1A\u65B0\u95FB\u53D1\u5E03\u4F1A\u7B56\u5212\u4EBA\u3001\u8D22\u7ECF\u79D1\u6280\u5A92\u4F53\u4E3B\u7F16\u3001\u54C1\u724C\u6218\u7565\u987E\u95EE\u3001\u4E8B\u5B9E\u6838\u67E5\u7F16\u8F91\u548C\u89C6\u89C9\u521B\u610F\u603B\u76D1\u3002

\u8BF7\u56F4\u7ED5\u3010{\u4F01\u4E1A\u540D\u79F0}\u3011\u751F\u6210\u4E00\u4EFD\u53EF\u76F4\u63A5\u7528\u4E8E\u6B63\u5F0F\u5BF9\u5916\u53D1\u5E03\u7684\u9AD8\u7AEF\u65B0\u95FB\u53D1\u5E03\u4F1A\u56FE\u6587\u65B0\u95FB\u7A3F\uFF0C\u6700\u7EC8\u8F93\u51FA\u4E3A Markdown \u683C\u5F0F\u3002

\u6700\u7EC8\u7A3F\u5FC5\u987B\u662F\u9762\u5411\u5BA2\u6237\u3001\u5A92\u4F53\u548C\u516C\u4F17\u7684\u6210\u54C1\u65B0\u95FB\u7A3F\uFF0C\u4E0D\u5F97\u8F93\u51FA\u4EFB\u4F55\u4E2D\u95F4\u8FC7\u7A0B\u3001\u5199\u4F5C\u8BF4\u660E\u3001\u56FE\u7247\u751F\u6210 Prompt\u3001\u4E8B\u5B9E\u6838\u9A8C\u8868\u3001\u5BA1\u6821\u6E05\u5355\u3001\u5F85\u529E\u4E8B\u9879\u6216\u6A21\u578B\u81EA\u8BC4\u5185\u5BB9\u3002

---

## \u4E00\u3001\u57FA\u7840\u4FE1\u606F

\u4F01\u4E1A\u540D\u79F0\uFF1A{\u4F01\u4E1A\u540D\u79F0}

\u53D1\u5E03\u4E3B\u9898\uFF1A{\u53D1\u5E03\u4E3B\u9898 / \u65B0\u54C1\u53D1\u5E03 / \u6218\u7565\u5347\u7EA7 / \u6280\u672F\u6210\u679C / \u54C1\u724C\u53D1\u5E03 / \u9879\u76EE\u843D\u5730}

\u53D1\u5E03\u65E5\u671F\u4E0E\u5730\u70B9\uFF1A{\u65E5\u671F\u3001\u57CE\u5E02\uFF0C\u5982\u672A\u77E5\u8BF7\u4E0D\u8981\u5728\u6B63\u6587\u4E2D\u5F3A\u884C\u7F16\u9020}

\u76EE\u6807\u53D7\u4F17\uFF1A{\u5A92\u4F53 / \u6295\u8D44\u4EBA / \u5BA2\u6237 / \u653F\u5E9C / \u884C\u4E1A\u4F19\u4F34 / \u516C\u4F17}

\u884C\u4E1A\u9886\u57DF\uFF1A{\u884C\u4E1A}

\u4F01\u4E1A\u5B98\u7F51\u6216\u5B98\u65B9\u8D44\u6599\uFF1A{\u5B98\u7F51\u94FE\u63A5 / \u4E0A\u4F20\u56FE\u518C / \u4EA7\u54C1\u624B\u518C / \u65B0\u95FB\u8D44\u6599\u5305 / \u5B98\u65B9\u516C\u4F17\u53F7 / \u767D\u76AE\u4E66 / \u5E74\u62A5 / \u62DB\u80A1\u4E66}

\u5FC5\u987B\u4F7F\u7528\u7684\u4FE1\u606F\uFF1A{\u5982\u6709\uFF0C\u8BF7\u5217\u51FA}

\u7981\u6B62\u4F7F\u7528\u6216\u907F\u514D\u63D0\u53CA\u7684\u4FE1\u606F\uFF1A{\u5982\u6709\uFF0C\u8BF7\u5217\u51FA}

\u54C1\u724C\u8C03\u6027\uFF1A\u9AD8\u7AEF\u3001\u53EF\u4FE1\u3001\u514B\u5236\u3001\u56FD\u9645\u5316\u3001\u4E13\u4E1A\u3001\u6709\u65B0\u95FB\u4EF7\u503C\uFF0C\u907F\u514D\u7A7A\u6D1E\u8425\u9500\u8154\u3002

---

## \u4E8C\u3001\u8D44\u6599\u4E0E\u4E8B\u5B9E\u8981\u6C42

\u8BF7\u4F18\u5148\u4F7F\u7528\u4EE5\u4E0B\u6765\u6E90\u5B8C\u6210\u8D44\u6599\u5224\u65AD\u548C\u4E8B\u5B9E\u6838\u9A8C\uFF1A

1. \u4F01\u4E1A\u5B98\u7F51\u3001\u5B98\u65B9\u516C\u4F17\u53F7\u3001\u4EA7\u54C1\u624B\u518C\u3001\u767D\u76AE\u4E66\u3001\u5E74\u62A5\u3001\u62DB\u80A1\u4E66\u3001\u65B0\u95FB\u7A3F\u3001\u8BA4\u8BC1\u6587\u4EF6\uFF1B
2. \u7528\u6237\u4E0A\u4F20\u7684\u56FE\u518C\u3001\u4EA7\u54C1\u8D44\u6599\u3001\u5BA3\u4F20\u518C\u3001\u65B0\u95FB\u8D44\u6599\u5305\uFF1B
3. \u6743\u5A01\u5A92\u4F53\u62A5\u9053\uFF1B
4. \u653F\u5E9C\u3001\u534F\u4F1A\u3001\u4EA4\u6613\u6240\u3001\u76D1\u7BA1\u673A\u6784\u516C\u5F00\u4FE1\u606F\uFF1B
5. \u884C\u4E1A\u62A5\u544A\u3001\u5B66\u672F\u8BBA\u6587\u3001\u4E13\u5229\u6570\u636E\u5E93\u3002

\u6240\u6709\u5173\u952E\u4E8B\u5B9E\u5FC5\u987B\u53EF\u6838\u9A8C\u3002\u4E0D\u5F97\u7F16\u9020\u4EE5\u4E0B\u5185\u5BB9\uFF1A

- \u4F01\u4E1A\u8425\u6536\uFF1B
- \u878D\u8D44\u91D1\u989D\uFF1B
- \u5E02\u573A\u4EFD\u989D\uFF1B
- \u5BA2\u6237\u540D\u79F0\uFF1B
- \u5408\u4F5C\u4F19\u4F34\uFF1B
- \u8D44\u8D28\u8BA4\u8BC1\uFF1B
- \u9886\u5BFC\u59D3\u540D\u4E0E\u804C\u52A1\uFF1B
- \u53D1\u5E03\u4F1A\u5609\u5BBE\uFF1B
- \u4EA7\u54C1\u53C2\u6570\uFF1B
- \u4E13\u5229\u6570\u91CF\uFF1B
- \u5956\u9879\uFF1B
- \u653F\u5E9C\u80CC\u4E66\uFF1B
- \u4E0A\u5E02\u8BA1\u5212\uFF1B
- \u4EA7\u80FD\u6570\u636E\uFF1B
- \u9500\u552E\u6570\u636E\uFF1B
- \u7528\u6237\u89C4\u6A21\u3002

\u5982\u8D44\u6599\u4E0D\u8DB3\uFF0C\u8BF7\u5728\u6B63\u6587\u4E2D\u91C7\u7528\u514B\u5236\u3001\u4E2D\u6027\u3001\u53EF\u53D1\u5E03\u7684\u8868\u8FBE\u65B9\u5F0F\uFF0C\u4E0D\u5F97\u4F7F\u7528\u201C\u5F85\u786E\u8BA4\u201D\u201C\u8D44\u6599\u4E0D\u8DB3\u201D\u201C\u65E0\u6CD5\u786E\u8BA4\u201D\u7B49\u7834\u574F\u6210\u7A3F\u611F\u7684\u5B57\u6837\uFF0C\u4E5F\u4E0D\u5F97\u81EA\u884C\u5047\u8BBE\u3002

\u5982\u679C\u516C\u5F00\u8D44\u6599\u5B58\u5728\u51B2\u7A81\uFF0C\u8BF7\u4F18\u5148\u91C7\u7528\u4F01\u4E1A\u5B98\u65B9\u8D44\u6599\u3001\u76D1\u7BA1\u673A\u6784\u8D44\u6599\u6216\u66F4\u6743\u5A01\u3001\u66F4\u8FD1\u671F\u7684\u6765\u6E90\uFF0C\u4E0D\u8981\u5728\u6700\u7EC8\u65B0\u95FB\u7A3F\u4E2D\u66B4\u9732\u8D44\u6599\u51B2\u7A81\u8FC7\u7A0B\u3002

---

## \u4E09\u3001\u65B0\u95FB\u7A3F\u5199\u4F5C\u8981\u6C42

\u8BF7\u751F\u6210\u4E00\u7BC7\u8FBE\u5230\u9876\u7EA7\u5546\u4E1A\u5A92\u4F53\u3001\u79D1\u6280\u5A92\u4F53\u3001\u8D22\u7ECF\u5A92\u4F53\u53D1\u5E03\u6807\u51C6\u7684\u65B0\u95FB\u53D1\u5E03\u4F1A\u7A3F\u4EF6\u3002

\u65B0\u95FB\u7A3F\u5FC5\u987B\u5177\u5907\uFF1A

- \u660E\u786E\u65B0\u95FB\u4E8B\u4EF6\uFF1B
- \u6E05\u6670\u884C\u4E1A\u80CC\u666F\uFF1B
- \u771F\u5B9E\u4F01\u4E1A\u4FE1\u606F\uFF1B
- \u53EF\u4FE1\u4EA7\u54C1\u6216\u670D\u52A1\u63CF\u8FF0\uFF1B
- \u5177\u4F53\u5E94\u7528\u4EF7\u503C\uFF1B
- \u514B\u5236\u7684\u6218\u7565\u8868\u8FBE\uFF1B
- \u9AD8\u7AEF\u4F46\u4E0D\u6D6E\u5938\u7684\u8BED\u8A00\uFF1B
- \u5A92\u4F53\u53EF\u76F4\u63A5\u91C7\u7528\u7684\u6210\u7A3F\u8D28\u611F\u3002

\u6587\u7AE0\u7ED3\u6784\u5305\u62EC\uFF1A

### 1. \u4E3B\u6807\u9898

\u8981\u6C42\uFF1A

- \u5177\u6709\u65B0\u95FB\u4EF7\u503C\uFF1B
- \u7A81\u51FA\u53D1\u5E03\u4F1A\u6838\u5FC3\u4E8B\u4EF6\uFF1B
- \u4E0D\u6D6E\u5938\uFF1B
- \u4E0D\u4F7F\u7528\u201C\u9707\u64BC\u53D1\u5E03\u201D\u201C\u91CD\u78C5\u6765\u88AD\u201D\u201C\u5F15\u9886\u672A\u6765\u201D\u201C\u98A0\u8986\u884C\u4E1A\u201D\u7B49\u7A7A\u6CDB\u8868\u8FBE\u3002

### 2. \u526F\u6807\u9898

\u8981\u6C42\uFF1A

- \u8865\u5145\u6218\u7565\u610F\u4E49\u3001\u4EA7\u54C1\u4EF7\u503C\u3001\u884C\u4E1A\u80CC\u666F\u6216\u5546\u4E1A\u6210\u679C\uFF1B
- \u4E0E\u4E3B\u6807\u9898\u5F62\u6210\u9012\u8FDB\u5173\u7CFB\uFF1B
- \u8BED\u8A00\u514B\u5236\u3001\u4E13\u4E1A\u3001\u6709\u5A92\u4F53\u611F\u3002

### 3. \u5BFC\u8BED

\u8981\u6C42\uFF1A

- \u7528\u4E00\u6BB5\u8BDD\u4EA4\u4EE3\u65F6\u95F4\u3001\u5730\u70B9\u3001\u4F01\u4E1A\u3001\u53D1\u5E03\u5185\u5BB9\u548C\u6838\u5FC3\u610F\u4E49\uFF1B
- \u9075\u5FAA\u65B0\u95FB\u5199\u4F5C 5W1H\uFF1B
- \u4E0D\u5199\u6210\u5E7F\u544A\u8BED\u6216\u5BA3\u4F20\u7247\u65C1\u767D\u3002

### 4. \u6B63\u6587\u4E3B\u4F53

\u6B63\u6587\u8BF7\u6309\u4EE5\u4E0B\u903B\u8F91\u81EA\u7136\u5C55\u5F00\uFF1A

- \u53D1\u5E03\u4F1A\u6838\u5FC3\u4E8B\u4EF6\uFF1B
- \u4F01\u4E1A\u80CC\u666F\u4E0E\u4E1A\u52A1\u5B9A\u4F4D\uFF1B
- \u4EA7\u54C1\u3001\u6280\u672F\u6216\u670D\u52A1\u4EAE\u70B9\uFF1B
- \u884C\u4E1A\u75DB\u70B9\u4E0E\u89E3\u51B3\u65B9\u6848\uFF1B
- \u5E94\u7528\u573A\u666F\u6216\u5BA2\u6237\u4EF7\u503C\uFF1B
- \u4F01\u4E1A\u6218\u7565\u5E03\u5C40\uFF1B
- \u5BF9\u884C\u4E1A\u3001\u5BA2\u6237\u3001\u751F\u6001\u4F19\u4F34\u7684\u610F\u4E49\uFF1B
- \u540E\u7EED\u8BA1\u5212\u3002

### 5. \u6570\u636E\u4E0E\u4E8B\u5B9E

- \u6BCF\u4E2A\u5173\u952E\u6570\u636E\u5FC5\u987B\u6709\u53EF\u9760\u6765\u6E90\u652F\u6491\uFF1B
- \u4E0D\u786E\u5B9A\u6570\u636E\u4E0D\u5F97\u8FDB\u5165\u6B63\u6587\u4E3B\u53D9\u4E8B\uFF1B
- \u4E0D\u5F97\u4F7F\u7528\u65E0\u6CD5\u8BC1\u5B9E\u7684\u6392\u540D\u3001\u7B2C\u4E00\u3001\u9886\u5148\u3001\u552F\u4E00\u3001\u6700\u5927\u7B49\u7EDD\u5BF9\u5316\u8868\u8FF0\uFF1B
- \u5982\u9700\u5F15\u7528\u6765\u6E90\uFF0C\u53EF\u5728\u6587\u672B\u4EE5\u201C\u8D44\u6599\u6765\u6E90\u201D\u5F62\u5F0F\u7B80\u6D01\u5217\u51FA\u3002

### 6. \u7ED3\u5C3E

\u7ED3\u5C3E\u5E94\u5305\u62EC\uFF1A

- \u672C\u6B21\u53D1\u5E03\u4F1A\u7684\u603B\u7ED3\u6027\u610F\u4E49\uFF1B
- \u4F01\u4E1A\u672A\u6765\u65B9\u5411\uFF1B
- \u201C\u5173\u4E8E{\u4F01\u4E1A\u540D\u79F0}\u201D\u6807\u51C6\u516C\u53F8\u4ECB\u7ECD\uFF1B
- \u5A92\u4F53\u8054\u7CFB\u65B9\u5F0F\u3002

---

## \u56DB\u3001\u56FE\u7247\u4E0E\u89C6\u89C9\u8981\u6C42

\u8BF7\u5728\u6700\u7EC8 Markdown \u65B0\u95FB\u7A3F\u4E2D\u63D2\u5165\u81F3\u5C11 3 \u5F20\u56FE\u7247\u3002\u56FE\u7247\u5FC5\u987B\u670D\u52A1\u4E8E\u65B0\u95FB\u5185\u5BB9\uFF0C\u4E0D\u5F97\u53EA\u662F\u88C5\u9970\u56FE\u3002

\u56FE\u7247\u5E94\u5F53\u4E0E\u4F01\u4E1A\u771F\u5B9E\u4E1A\u52A1\u3001\u4EA7\u54C1\u3001\u670D\u52A1\u3001\u6280\u672F\u3001\u5E94\u7528\u573A\u666F\u6216\u54C1\u724C\u6C14\u8D28\u76F8\u5173\uFF0C\u5E76\u4F18\u5148\u53C2\u8003\u4F01\u4E1A\u5B98\u7F51\u3001\u4E0A\u4F20\u56FE\u518C\u3001\u4EA7\u54C1\u624B\u518C\u3001\u65B0\u95FB\u8D44\u6599\u5305\u6216\u516C\u5F00\u8D44\u6599\u4E2D\u7684\u771F\u5B9E\u5143\u7D20\u3002

\u56FE\u7247\u7C7B\u578B\u81F3\u5C11\u5305\u62EC\uFF1A

### \u56FE 1\uFF1A\u53D1\u5E03\u4F1A\u4E3B\u89C6\u89C9\u56FE

\u7528\u4E8E\u6587\u7AE0\u9876\u90E8\uFF0C\u4F53\u73B0\u53D1\u5E03\u4E3B\u9898\u3001\u4F01\u4E1A\u6C14\u8D28\u3001\u884C\u4E1A\u5C5E\u6027\u548C\u65B0\u95FB\u53D1\u5E03\u573A\u666F\u3002

\u8981\u6C42\uFF1A

- \u9AD8\u7AEF\u3001\u514B\u5236\u3001\u771F\u5B9E\u53EF\u4FE1\uFF1B
- \u50CF\u771F\u5B9E\u53D1\u5E03\u4F1A\u73B0\u573A\u3001\u4F01\u4E1A\u54C1\u724C\u5927\u7247\u6216\u5A92\u4F53\u5934\u56FE\uFF1B
- \u907F\u514D\u865A\u5047\u821E\u53F0\u3001\u5938\u5F20\u5149\u6548\u3001\u5EC9\u4EF7\u79D1\u6280\u80CC\u666F\u548C\u65E0\u5173\u89C6\u89C9\u5143\u7D20\uFF1B
- \u4E0D\u5F97\u865A\u6784\u4E0D\u5B58\u5728\u7684 Logo\u3001\u4F1A\u573A\u3001\u5609\u5BBE\u6216\u4F01\u4E1A\u6807\u8BC6\u3002

### \u56FE 2\uFF1A\u4EA7\u54C1 / \u670D\u52A1 / \u5E94\u7528\u573A\u666F\u56FE

\u7528\u4E8E\u5C55\u793A\u4F01\u4E1A\u5B9E\u9645\u4EA7\u54C1\u3001\u89E3\u51B3\u65B9\u6848\u3001\u5E73\u53F0\u3001\u8BBE\u5907\u3001\u5DE5\u5382\u3001\u95E8\u5E97\u3001\u8F6F\u4EF6\u754C\u9762\u6216\u670D\u52A1\u573A\u666F\u3002

\u8981\u6C42\uFF1A

- \u5FC5\u987B\u4E0E\u4F01\u4E1A\u771F\u5B9E\u4E1A\u52A1\u76F8\u5173\uFF1B
- \u4F18\u5148\u53C2\u8003\u4E0A\u4F20\u56FE\u518C\u3001\u5B98\u7F51\u4EA7\u54C1\u56FE\u6216\u516C\u5F00\u8D44\u6599\uFF1B
- \u4E0D\u5F97\u51ED\u7A7A\u521B\u9020\u6838\u5FC3\u4EA7\u54C1\u5916\u89C2\uFF1B
- \u4E0D\u5F97\u865A\u6784\u5BA2\u6237\u73B0\u573A\u3001\u5408\u4F5C\u4F19\u4F34\u6216\u5177\u4F53\u9879\u76EE\uFF1B
- \u5982\u65E0\u6CD5\u786E\u8BA4\u771F\u5B9E\u573A\u666F\uFF0C\u5E94\u91C7\u7528\u4E0D\u8BEF\u5BFC\u8BFB\u8005\u7684\u573A\u666F\u5316\u8868\u8FBE\u3002

### \u56FE 3\uFF1A\u4E1A\u52A1\u903B\u8F91\u56FE / \u6280\u672F\u67B6\u6784\u56FE / \u4EA7\u4E1A\u4EF7\u503C\u56FE

\u7528\u4E8E\u89E3\u91CA\u4F01\u4E1A\u5982\u4F55\u521B\u9020\u4EF7\u503C\uFF0C\u5E2E\u52A9\u8BFB\u8005\u7406\u89E3\u4F01\u4E1A\u7684\u4E1A\u52A1\u903B\u8F91\u3001\u6280\u672F\u8DEF\u5F84\u3001\u4EA7\u54C1\u77E9\u9635\u6216\u4EA7\u4E1A\u4F4D\u7F6E\u3002

\u8981\u6C42\uFF1A

- \u4FE1\u606F\u7ED3\u6784\u6E05\u6670\uFF1B
- \u6A21\u5757\u5173\u7CFB\u51C6\u786E\uFF1B
- \u89C6\u89C9\u5E72\u51C0\u4E13\u4E1A\uFF1B
- \u9002\u5408\u5A92\u4F53\u53D1\u5E03\uFF1B
- \u4E0D\u4F7F\u7528\u590D\u6742\u5C0F\u5B57\uFF1B
- \u4E0D\u4F7F\u7528\u8D5B\u535A\u670B\u514B\u3001\u9713\u8679\u3001\u5168\u606F\u3001\u5938\u5F20 3D \u6548\u679C\uFF1B
- \u98CE\u683C\u63A5\u8FD1\u4E13\u4E1A\u8D22\u7ECF\u5A92\u4F53\u3001\u54A8\u8BE2\u62A5\u544A\u6216\u4F01\u4E1A\u62DB\u80A1\u4E66\u4E2D\u7684\u4FE1\u606F\u56FE\u3002

---

## \u4E94\u3001\u56FE\u7247\u53BB AI \u5473\u513F\u8981\u6C42

\u6240\u6709\u56FE\u7247\u5FC5\u987B\u907F\u514D\u660E\u663E AI \u751F\u6210\u611F\u3002\u6574\u4F53\u89C6\u89C9\u5E94\u63A5\u8FD1\u771F\u5B9E\u5546\u4E1A\u6444\u5F71\u3001\u65B0\u95FB\u7EAA\u5B9E\u6444\u5F71\u3001\u4F01\u4E1A\u5B98\u7F51\u7EA7\u4EA7\u54C1\u6444\u5F71\u6216\u4E13\u4E1A\u4FE1\u606F\u56FE\u3002

\u56FE\u7247\u5E94\u5177\u5907\uFF1A

- \u771F\u5B9E\u5149\u7EBF\uFF1B
- \u771F\u5B9E\u6750\u8D28\uFF1B
- \u771F\u5B9E\u9634\u5F71\uFF1B
- \u81EA\u7136\u666F\u6DF1\uFF1B
- \u5408\u7406\u900F\u89C6\uFF1B
- \u514B\u5236\u6784\u56FE\uFF1B
- \u5E72\u51C0\u753B\u9762\uFF1B
- \u5546\u4E1A\u5A92\u4F53\u8D28\u611F\uFF1B
- \u4F01\u4E1A\u6B63\u5F0F\u5BF9\u5916\u53D1\u5E03\u7D20\u6750\u7684\u53EF\u4FE1\u5EA6\u3002

\u56FE\u7247\u5FC5\u987B\u907F\u514D\uFF1A

- AI \u6D77\u62A5\u611F\uFF1B
- \u5EC9\u4EF7\u84DD\u8272\u79D1\u6280\u611F\uFF1B
- \u5851\u6599\u8D28\u611F\uFF1B
- \u8721\u50CF\u4EBA\u7269\uFF1B
- \u7578\u5F62\u624B\u6307\uFF1B
- \u4E0D\u81EA\u7136\u7B11\u5BB9\uFF1B
- \u8FC7\u5EA6\u78E8\u76AE\uFF1B
- \u4E71\u7801\u6587\u5B57\uFF1B
- \u4F2A Logo\uFF1B
- \u865A\u6784\u5BA2\u6237\u540D\u79F0\uFF1B
- \u968F\u673A\u53D1\u5149\u7EBF\u6761\uFF1B
- \u6F02\u6D6E\u56FE\u6807\uFF1B
- \u5168\u606F\u6295\u5F71\uFF1B
- \u8D5B\u535A\u670B\u514B\u9713\u8679\uFF1B
- \u5938\u5F20\u955C\u5934\u5149\u6591\uFF1B
- \u8FC7\u5EA6\u9510\u5316\uFF1B
- \u8FC7\u9971\u548C\uFF1B
- \u5047 HDR\uFF1B
- \u7D20\u6750\u5E93\u62FC\u8D34\u611F\uFF1B
- \u6982\u5FF5\u6E32\u67D3\u611F\uFF1B
- \u4E0D\u771F\u5B9E\u7684\u5DE5\u5382\u3001\u5B9E\u9A8C\u5BA4\u3001\u95E8\u5E97\u3001\u4F1A\u573A\u6216\u4EA7\u54C1\u5916\u89C2\u3002

\u56FE\u7247\u5185\u6587\u5B57\u5E94\u5C3D\u91CF\u5C11\uFF0C\u5982\u5FC5\u987B\u51FA\u73B0\u6587\u5B57\uFF0C\u5E94\u6E05\u6670\u3001\u51C6\u786E\u3001\u65E0\u4E71\u7801\u3002\u4E0D\u5F97\u5728\u56FE\u7247\u4E2D\u52A0\u5165\u672A\u7ECF\u786E\u8BA4\u7684\u4F01\u4E1A\u53E3\u53F7\u3001\u6570\u636E\u3001\u6392\u540D\u3001\u5BA2\u6237\u540D\u79F0\u6216\u5408\u4F5C\u4F19\u4F34\u540D\u79F0\u3002

\u56FE\u7247\u5EFA\u8BAE\u4E3A 4K \u6216\u8FD1 4K \u8D28\u91CF\u3002\u5982\u9700 8K\uFF0C\u53EF\u5728\u56FE\u50CF\u751F\u6210\u540E\u901A\u8FC7\u5916\u90E8\u8D85\u5206\u8FA8\u7387\u5DE5\u5177\u4E8C\u6B21\u653E\u5927\u3002

---

## \u516D\u3001\u6700\u7EC8 Markdown \u8F93\u51FA\u683C\u5F0F

\u8BF7\u53EA\u8F93\u51FA\u4EE5\u4E0B\u6210\u54C1\u65B0\u95FB\u7A3F\u7ED3\u6784\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u989D\u5916\u8BF4\u660E\u3002

---

# {\u65B0\u95FB\u7A3F\u4E3B\u6807\u9898}

> \u526F\u6807\u9898\uFF1A{\u526F\u6807\u9898}

![\u53D1\u5E03\u4F1A\u4E3B\u89C6\u89C9\u56FE](./images/hero.png)
*\u56FE 1\uFF1A{\u56FE\u6CE8}*

## \u5BFC\u8BED

{\u65B0\u95FB\u5BFC\u8BED}

## \u4E00\u3001\u53D1\u5E03\u4F1A\u6838\u5FC3\u4FE1\u606F

{\u6B63\u6587\u5185\u5BB9}

## \u4E8C\u3001\u4F01\u4E1A\u80CC\u666F\u4E0E\u4E1A\u52A1\u5B9A\u4F4D

{\u6B63\u6587\u5185\u5BB9}

## \u4E09\u3001\u4EA7\u54C1 / \u6280\u672F / \u670D\u52A1\u4EAE\u70B9

{\u6B63\u6587\u5185\u5BB9}

![\u4EA7\u54C1\u6216\u5E94\u7528\u573A\u666F\u56FE](./images/product-scene.png)
*\u56FE 2\uFF1A{\u56FE\u6CE8}*

## \u56DB\u3001\u884C\u4E1A\u75DB\u70B9\u4E0E\u89E3\u51B3\u65B9\u6848

{\u6B63\u6587\u5185\u5BB9}

## \u4E94\u3001\u5E94\u7528\u573A\u666F\u4E0E\u5BA2\u6237\u4EF7\u503C

{\u6B63\u6587\u5185\u5BB9}

## \u516D\u3001\u6218\u7565\u5E03\u5C40\u4E0E\u672A\u6765\u8BA1\u5212

{\u6B63\u6587\u5185\u5BB9}

![\u4E1A\u52A1\u903B\u8F91\u56FE](./images/business-logic.png)
*\u56FE 3\uFF1A{\u56FE\u6CE8}*

## \u4E03\u3001\u5173\u4E8E{\u4F01\u4E1A\u540D\u79F0}

{100 \u81F3 200 \u5B57\u4F01\u4E1A\u4ECB\u7ECD}

## \u516B\u3001\u5A92\u4F53\u8054\u7CFB\u65B9\u5F0F

\u8054\u7CFB\u4EBA\uFF1A{\u8054\u7CFB\u4EBA}
\u7535\u8BDD\uFF1A{\u7535\u8BDD}
\u90AE\u7BB1\uFF1A{\u90AE\u7BB1}
\u5B98\u7F51\uFF1A{\u5B98\u7F51}

## \u8D44\u6599\u6765\u6E90

{\u4EC5\u5217\u51FA\u6B63\u6587\u4E2D\u5B9E\u9645\u4F7F\u7528\u7684\u91CD\u8981\u516C\u5F00\u8D44\u6599\u6765\u6E90\uFF1B\u5982\u4E0D\u9002\u5408\u516C\u5F00\u5C55\u793A\uFF0C\u53EF\u5220\u9664\u672C\u90E8\u5206}

---

## \u4E03\u3001\u6700\u7EC8\u8F93\u51FA\u9650\u5236

\u6700\u7EC8\u8F93\u51FA\u5FC5\u987B\u662F\u53EF\u76F4\u63A5\u53D1\u5E03\u7684 Markdown \u65B0\u95FB\u7A3F\u3002

\u4E0D\u5F97\u51FA\u73B0\u4EE5\u4E0B\u5185\u5BB9\uFF1A

- \u5199\u4F5C\u601D\u8DEF\uFF1B
- \u751F\u6210\u6B65\u9AA4\uFF1B
- \u56FE\u7247\u751F\u6210 Prompt\uFF1B
- \u8D1F\u9762 Prompt\uFF1B
- \u4E8B\u5B9E\u6838\u9A8C\u8868\uFF1B
- \u53D1\u5E03\u524D\u5BA1\u6821\u6E05\u5355\uFF1B
- \u7A3F\u4EF6\u8D28\u91CF\u81EA\u8BC4\uFF1B
- \u5F85\u786E\u8BA4\u4E8B\u9879\u6E05\u5355\uFF1B
- \u201C\u4F5C\u4E3A AI\u201D\uFF1B
- \u201C\u6211\u5EFA\u8BAE\u201D\uFF1B
- \u201C\u4EE5\u4E0B\u662F\u201D\uFF1B
- \u201C\u9700\u8981\u8FDB\u4E00\u6B65\u786E\u8BA4\u201D\uFF1B
- \u4EFB\u4F55\u9762\u5411\u5185\u90E8\u5236\u4F5C\u6D41\u7A0B\u7684\u8BF4\u660E\u3002

\u6240\u6709\u4E0D\u786E\u5B9A\u4FE1\u606F\u5FC5\u987B\u5728\u5199\u4F5C\u4E2D\u81EA\u7136\u89C4\u907F\uFF0C\u4E0D\u5F97\u7834\u574F\u65B0\u95FB\u7A3F\u7684\u6B63\u5F0F\u53D1\u5E03\u611F\u3002`;
  const lines = [template.replaceAll("{\u4F01\u4E1A\u540D\u79F0}", companyName)];
  if (operatorNotes.trim()) {
    lines.push("", "\u8865\u5145\u4FE1\u606F\uFF1A", operatorNotes.trim());
  }
  return lines.join("\n");
}
async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  agentProfile,
  attachments: attachments2
}) {
  const taskResponse = await axios4.post(
    `${baseUrl}/v1/tasks`,
    {
      prompt,
      agentProfile: toUpstreamAgentProfile(agentProfile),
      taskMode: "agent",
      attachments: attachments2
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 12e4,
      validateStatus: () => true
    }
  );
  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const detail = taskResponse.data?.error?.message || taskResponse.data?.message || `Create task failed (${taskResponse.status})`;
    return { ok: false, status: taskResponse.status, detail };
  }
  const taskData = taskResponse.data || {};
  const taskId = taskData.id || taskData.task_id;
  if (!taskId) {
    return { ok: false, status: 502, detail: "Create task failed: missing task id" };
  }
  return {
    ok: true,
    task: {
      id: taskId,
      status: taskData.status === "failed" ? "error" : taskData.status || "running",
      taskUrl: taskData.task_url || taskData.metadata?.task_url,
      title: taskData.task_title || taskData.metadata?.task_title,
      output: taskData.output || []
    }
  };
}
router4.post("/start", async (req, res) => {
  const body = req.body || {};
  const companyName = String(body.companyName || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();
  if (!companyName) {
    res.status(400).json({ error: "Missing company name" });
    return;
  }
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  try {
    const userAttachments = normalizeUserAttachments(body.attachments);
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt: buildPublishedNewsReleasePrompt(companyName, operatorNotes),
      agentProfile: body.agentProfile,
      attachments: userAttachments
    });
    if (!created.ok) {
      console.warn("[News Release Start] create task failed:", created.detail);
      res.status(created.status).json({ error: "\u521B\u5EFA\u65B0\u95FB\u7A3F\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u6216\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    if (!req.frontmindUser || !req.frontmindCredential) {
      res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55\u5E76\u914D\u7F6E API Key" });
      return;
    }
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(created.task.id)
    });
    res.json({
      visibleMessage: "\u5F00\u59CB\u5236\u4F5C\u54C1\u724C\u65B0\u95FB\u7A3F\u6837\u4F8B",
      task: created.task,
      startedAt: Date.now()
    });
  } catch (error) {
    console.error("[News Release Start] error:", error.message);
    res.status(500).json({ error: "\u542F\u52A8\u65B0\u95FB\u7A3F\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
  }
});
var news_release_api_default = router4;

// server/knowledge-base-api.ts
import axios5 from "axios";
import { Router as Router4 } from "express";
import fs6 from "fs/promises";
import JSZip2 from "jszip";
import path6 from "path";
var router5 = Router4();
var skillArchiveCandidates = [
  process.env.FRONTMIND_KB_SKILL_PATH,
  path6.resolve(process.cwd(), "private-workflows", "socratic-kb-builder.skill"),
  path6.resolve(import.meta.dirname, "..", "private-workflows", "socratic-kb-builder.skill"),
  path6.resolve(import.meta.dirname, "..", "..", "private-workflows", "socratic-kb-builder.skill")
].filter(Boolean);
var cachedSkillInstructions = null;
function sanitizeFilename3(value, fallback) {
  const safe = String(value || "").replace(/[\\/\0]/g, "_").replace(/^\.+$/, "").trim().slice(0, 160);
  return safe || fallback;
}
function normalizeUserAttachments2(attachments2) {
  return (attachments2 || []).map((attachment) => {
    const fileId = attachment.file_id || attachment.fileId || "";
    const filename = sanitizeFilename3(
      attachment.filename || attachment.name || "company_material",
      "company_material"
    );
    return fileId ? { file_id: fileId, filename } : null;
  }).filter(Boolean);
}
async function readSkillArchive() {
  if (cachedSkillInstructions) return cachedSkillInstructions;
  let lastError;
  for (const candidate of skillArchiveCandidates) {
    try {
      const archive = await fs6.readFile(candidate);
      const zip = await JSZip2.loadAsync(archive);
      const entries = [
        ["SKILL.md", "Skill"],
        ["references/knowledge-tree.md", "Knowledge Tree"],
        ["references/questioning-strategy.md", "Questioning Strategy"],
        ["references/output-format.md", "Output Format"]
      ];
      const sections = [];
      for (const [entryName, title] of entries) {
        const entry = zip.file(entryName);
        if (!entry) {
          throw new Error(`Missing ${entryName} in socratic-kb-builder.skill`);
        }
        const content = await entry.async("string");
        sections.push(`# ${title}

${content.trim()}`);
      }
      cachedSkillInstructions = sections.join("\n\n---\n\n");
      return cachedSkillInstructions;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not load socratic-kb-builder.skill");
}
async function buildKnowledgeBasePrompt({
  companyName,
  companyWebsite,
  operatorNotes,
  attachments: attachments2
}) {
  const skillInstructions = await readSkillArchive();
  const attachmentList = attachments2.length > 0 ? attachments2.map((attachment) => `- ${attachment.filename}`).join("\n") : "- \u672A\u4E0A\u4F20\u9644\u4EF6\uFF0C\u8BF7\u4F18\u5148\u4F7F\u7528\u4F01\u4E1A\u5B98\u7F51\u548C\u516C\u5F00\u8D44\u6599\u8FDB\u884C\u9884\u586B";
  return [
    "\u4F60\u5FC5\u987B\u4E25\u683C\u6267\u884C\u4E0B\u65B9 socratic-kb-builder skill\uFF0C\u4E3A\u4F01\u4E1A\u6784\u5EFA\u53EF\u590D\u7528\u7684\u7ED3\u6784\u5316\u77E5\u8BC6\u5E93\u3002",
    "",
    "## \u672C\u6B21\u4EFB\u52A1\u8F93\u5165",
    `\u4F01\u4E1A\u540D\u79F0\uFF1A${companyName}`,
    `\u4F01\u4E1A\u5B98\u7F51\uFF1A${companyWebsite || "\u672A\u586B\u5199"}`,
    "\u7528\u6237\u4E0A\u4F20\u8D44\u6599\uFF1A",
    attachmentList,
    operatorNotes ? `\u64CD\u4F5C\u8005\u5907\u6CE8\uFF1A
${operatorNotes}` : "\u64CD\u4F5C\u8005\u5907\u6CE8\uFF1A\u672A\u586B\u5199",
    "",
    "## \u6267\u884C\u8981\u6C42",
    "1. \u5148\u8BFB\u53D6\u7528\u6237\u4E0A\u4F20\u8D44\u6599\uFF0C\u5E76\u7ED3\u5408\u4F01\u4E1A\u5B98\u7F51\u548C\u516C\u5F00\u8D44\u6599\u505A\u6DF1\u5EA6\u7814\u7A76\u3002",
    "2. \u6309 skill \u8981\u6C42\u5148\u9884\u586B\u77E5\u8BC6\u6811\uFF0C\u518D\u4EE5\u82CF\u683C\u62C9\u5E95\u5F0F\u786E\u8BA4\u63A8\u8FDB\uFF0C\u4E0D\u80FD\u8BA9\u7528\u6237\u4ECE\u7A7A\u767D\u95EE\u9898\u5F00\u59CB\u5199\u3002",
    "3. \u5BF9\u6BCF\u4E2A\u4E8B\u5B9E\u6807\u6CE8\u6765\u6E90\uFF1A\u4E0A\u4F20\u8D44\u6599\u3001\u4F01\u4E1A\u5B98\u7F51\u3001\u516C\u5F00\u8D44\u6599\u6216\u884C\u4E1A\u8C03\u7814\u3002",
    "4. \u5982\u5F53\u524D\u4FE1\u606F\u4E0D\u8DB3\uFF0C\u8BF7\u5C55\u793A\u5DF2\u9884\u586B\u8349\u7A3F\u3001\u7F3A\u53E3\u548C\u53EF\u786E\u8BA4\u95EE\u9898\uFF0C\u7B49\u5F85\u7528\u6237\u786E\u8BA4\u6216\u8865\u5145\u3002",
    "5. \u6700\u7EC8\u4EA4\u4ED8\u5E94\u6309 skill \u7684 ZIP/Markdown \u77E5\u8BC6\u5E93\u7ED3\u6784\u7EC4\u7EC7\u3002",
    "",
    "## socratic-kb-builder.skill",
    skillInstructions
  ].join("\n");
}
async function createFrontMindTask2({
  baseUrl,
  apiKey,
  prompt,
  agentProfile,
  attachments: attachments2
}) {
  const taskResponse = await axios5.post(
    `${baseUrl}/v1/tasks`,
    {
      prompt,
      agentProfile: toUpstreamAgentProfile(agentProfile),
      taskMode: "agent",
      attachments: attachments2
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 12e4,
      validateStatus: () => true
    }
  );
  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const detail = taskResponse.data?.error?.message || taskResponse.data?.message || `Create task failed (${taskResponse.status})`;
    return { ok: false, status: taskResponse.status, detail };
  }
  const taskData = taskResponse.data || {};
  const taskId = taskData.id || taskData.task_id;
  if (!taskId) {
    return { ok: false, status: 502, detail: "Create task failed: missing task id" };
  }
  return {
    ok: true,
    task: {
      id: taskId,
      status: taskData.status === "failed" ? "error" : taskData.status || "running",
      taskUrl: taskData.task_url || taskData.metadata?.task_url,
      title: taskData.task_title || taskData.metadata?.task_title,
      output: taskData.output || []
    }
  };
}
router5.post("/start", async (req, res) => {
  const body = req.body || {};
  const companyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();
  if (!companyName) {
    res.status(400).json({ error: "Missing company name" });
    return;
  }
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  try {
    const userAttachments = normalizeUserAttachments2(body.attachments);
    const created = await createFrontMindTask2({
      baseUrl,
      apiKey,
      prompt: await buildKnowledgeBasePrompt({
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments
      }),
      agentProfile: body.agentProfile,
      attachments: userAttachments
    });
    if (!created.ok) {
      console.warn("[Knowledge Base Start] create task failed:", created.detail);
      res.status(created.status).json({ error: "\u521B\u5EFA\u4F01\u4E1A\u77E5\u8BC6\u5E93\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u6216\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    if (!req.frontmindUser || !req.frontmindCredential) {
      res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55\u5E76\u914D\u7F6E API Key" });
      return;
    }
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(created.task.id)
    });
    res.json({
      visibleMessage: "\u5F00\u59CB\u6784\u5EFA\u4F01\u4E1A\u77E5\u8BC6\u5E93",
      task: created.task,
      startedAt: Date.now()
    });
  } catch (error) {
    console.error("[Knowledge Base Start] error:", error.message);
    res.status(500).json({ error: "\u542F\u52A8\u4F01\u4E1A\u77E5\u8BC6\u5E93\u4EFB\u52A1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
  }
});
var knowledge_base_api_default = router5;

// server/prepared-file-router.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { createReadStream as createReadStream3 } from "node:fs";
import fs7 from "node:fs/promises";
import { Router as Router5 } from "express";
var router6 = Router5();
var DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1e3;
var downloadTokens = /* @__PURE__ */ new Map();
function parseByteRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size < 1) return "invalid";
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
function sanitizeFilename4(filename) {
  const source = ["ma", "nus"].join("");
  const replaced = String(filename || "document.pdf").replace(
    new RegExp(source, "gi"),
    "FrontMind"
  );
  return replaced.replace(/[\\/\0"]/g, "_").trim() || "document.pdf";
}
function contentDisposition(disposition, filename) {
  const safe = sanitizeFilename4(filename);
  const encoded = encodeURIComponent(safe);
  return `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}
function sendPreparedError(res, error) {
  if (error instanceof PreparedFileError) {
    const status = error.code === "ASSET_NOT_FOUND" ? 404 : error.code === "INSUFFICIENT_STORAGE" ? 507 : error.code === "SOURCE_FORBIDDEN" ? 403 : 400;
    res.status(status).json({
      error: { message: error.message, code: error.code }
    });
    return;
  }
  console.error("[PreparedFiles] Request failed", error);
  res.status(500).json({
    error: {
      message: "\u6587\u4EF6\u51C6\u5907\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528",
      code: "PREPARED_FILE_SERVICE_ERROR"
    }
  });
}
function extractSource(fileUrl) {
  const parsed = new URL(fileUrl, "http://frontmind.local");
  const fileMatch = parsed.pathname.match(
    /(?:\/api\/frontmind)?\/v1\/files\/([^/]+)/
  );
  if (fileMatch?.[1]) {
    return {
      kind: "file",
      fileId: decodeURIComponent(fileMatch[1])
    };
  }
  if (parsed.pathname.endsWith("/api/frontmind/proxy-download")) {
    const externalUrl = parsed.searchParams.get("url");
    if (externalUrl) {
      return { kind: "external", url: externalUrl };
    }
  }
  if (/^https?:\/\//i.test(fileUrl)) {
    return { kind: "external", url: fileUrl };
  }
  throw new PreparedFileError(
    "INVALID_FILE_SOURCE",
    "\u65E0\u6CD5\u8BC6\u522B PDF \u6587\u4EF6\u6765\u6E90"
  );
}
router6.post("/prepare", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
      return;
    }
    const fileUrl = String(req.body?.fileUrl || "");
    const filename = sanitizeFilename4(
      String(req.body?.fileName || "document.pdf")
    );
    if (!fileUrl) {
      res.status(400).json({
        error: { message: "\u7F3A\u5C11\u6587\u4EF6\u5730\u5740", code: "MISSING_FILE_URL" }
      });
      return;
    }
    const source = extractSource(fileUrl);
    if (source.kind === "file") {
      const credential2 = await getCredentialForUpstreamResource(
        ownerUserId,
        "file",
        source.fileId
      );
      if (!credential2) {
        res.status(403).json({
          error: {
            message: "\u8BE5\u6587\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7\uFF0C\u6216\u5176\u539F API Key \u5DF2\u5220\u9664",
            code: "UPSTREAM_RESOURCE_FORBIDDEN"
          }
        });
        return;
      }
      res.json(
        await preparedFileService.registerFile({
          ownerUserId,
          credentialId: credential2.id,
          fileId: source.fileId,
          filename
        })
      );
      return;
    }
    const credential = await getDecryptedCredentialForUser(ownerUserId);
    res.json(
      await preparedFileService.registerExternal({
        ownerUserId,
        credentialId: credential?.id || "external",
        url: source.url,
        filename
      })
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});
router6.get("/:assetId/status", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
      return;
    }
    res.json(
      await preparedFileService.getStatus(req.params.assetId, ownerUserId)
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});
router6.post("/:assetId/retry", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
      return;
    }
    res.json(
      await preparedFileService.retry(req.params.assetId, ownerUserId)
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});
function cleanupDownloadTokens() {
  const now = Date.now();
  for (const [token, value] of downloadTokens) {
    if (value.expiresAt <= now) downloadTokens.delete(token);
  }
}
router6.post("/:assetId/download-token", async (req, res) => {
  try {
    cleanupDownloadTokens();
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId
    );
    if (manifest.status !== "ready") {
      res.status(409).json({
        error: {
          message: "\u6587\u4EF6\u4ECD\u5728\u51C6\u5907\u4E2D",
          code: "FILE_NOT_READY",
          status: manifest.status,
          phase: manifest.phase
        }
      });
      return;
    }
    const token = randomUUID5();
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    downloadTokens.set(token, {
      assetId: manifest.id,
      ownerUserId,
      expiresAt
    });
    res.json({
      downloadUrl: `/api/frontmind/assets/download/${token}`,
      expiresAt
    });
  } catch (error) {
    sendPreparedError(res, error);
  }
});
async function streamPreparedFile(req, res, manifest, disposition) {
  const filePath = preparedFileService.contentPath(manifest.id);
  const stat = await fs7.stat(filePath);
  const range = parseByteRange(
    typeof req.headers.range === "string" ? req.headers.range : void 0,
    stat.size
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600, must-revalidate");
  res.setHeader(
    "Content-Disposition",
    contentDisposition(disposition, manifest.filename)
  );
  const etag = manifest.etag ? `"${manifest.etag}"` : void 0;
  const ifNoneMatch = typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : void 0;
  if (etag) res.setHeader("ETag", etag);
  if (etag && !req.headers.range && ifNoneMatch?.split(",").map((value) => value.trim()).includes(etag)) {
    res.status(304).end();
    return;
  }
  if (range === "invalid") {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const contentLength = end - start + 1;
  res.setHeader("Content-Length", String(contentLength));
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  } else {
    res.status(200);
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  preparedFileService.beginUse(manifest.id);
  const stream = createReadStream3(filePath, { start, end });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    preparedFileService.endUse(manifest.id);
  };
  stream.on("error", (error) => {
    release();
    if (!res.headersSent) sendPreparedError(res, error);
    else res.destroy(error);
  });
  stream.on("close", release);
  res.on("close", () => {
    if (!res.writableEnded) stream.destroy();
    release();
  });
  stream.pipe(res);
}
router6.get("/download/:token", async (req, res) => {
  try {
    cleanupDownloadTokens();
    const ownerUserId = req.frontmindUser?.id;
    const token = downloadTokens.get(req.params.token);
    if (!ownerUserId || !token || token.expiresAt <= Date.now()) {
      res.status(410).json({
        error: {
          message: "\u4E0B\u8F7D\u94FE\u63A5\u5DF2\u5931\u6548",
          code: "DOWNLOAD_LINK_EXPIRED"
        }
      });
      return;
    }
    if (token.ownerUserId !== ownerUserId) {
      res.status(403).json({
        error: {
          message: "\u4E0B\u8F7D\u94FE\u63A5\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7",
          code: "DOWNLOAD_FORBIDDEN"
        }
      });
      return;
    }
    downloadTokens.delete(req.params.token);
    const manifest = await preparedFileService.getReadyManifest(
      token.assetId,
      ownerUserId
    );
    if (manifest.status !== "ready") {
      res.status(409).json({
        error: { message: "\u6587\u4EF6\u5C1A\u672A\u51C6\u5907\u5B8C\u6210", code: "FILE_NOT_READY" }
      });
      return;
    }
    await streamPreparedFile(req, res, manifest, "attachment");
  } catch (error) {
    sendPreparedError(res, error);
  }
});
router6.get("/:assetId/content", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId
    );
    if (manifest.status !== "ready") {
      res.status(202).json({
        assetId: manifest.id,
        status: manifest.status,
        phase: manifest.phase,
        errorCode: manifest.errorCode,
        errorMessage: manifest.errorMessage,
        retryAfterMs: 2e3
      });
      return;
    }
    await streamPreparedFile(
      req,
      res,
      manifest,
      req.query.download === "1" ? "attachment" : "inline"
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});
router6.head("/:assetId/content", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).end();
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId
    );
    if (manifest.status !== "ready") {
      res.status(202).end();
      return;
    }
    await streamPreparedFile(req, res, manifest, "inline");
  } catch (error) {
    sendPreparedError(res, error);
  }
});
var prepared_file_router_default = router6;

// server/_core/express-auth.ts
function sendAuthError(res, status, message, code) {
  res.status(status).json({ error: { message, code } });
}
async function requireExpressAuth(req, res, next) {
  try {
    const user = await authenticateRequest(req);
    if (!user) {
      sendAuthError(res, 401, "\u8BF7\u5148\u767B\u5F55", "UNAUTHORIZED");
      return;
    }
    req.frontmindUser = user;
    next();
  } catch (error) {
    console.error("[Auth] Express authentication failed", error);
    sendAuthError(res, 503, "\u767B\u5F55\u670D\u52A1\u6682\u4E0D\u53EF\u7528", "AUTH_UNAVAILABLE");
  }
}
async function attachOptionalActiveCredential(req, res, next) {
  if (!req.frontmindUser) {
    sendAuthError(res, 401, "\u8BF7\u5148\u767B\u5F55", "UNAUTHORIZED");
    return;
  }
  try {
    const credential = await getDecryptedCredentialForUser(req.frontmindUser.id);
    if (credential) req.frontmindCredential = credential;
    next();
  } catch (error) {
    const invalidKey = error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to load account credential", error);
    sendAuthError(
      res,
      503,
      invalidKey ? "\u670D\u52A1\u7AEF\u51ED\u636E\u52A0\u5BC6\u914D\u7F6E\u65E0\u6548" : "API Key \u6682\u4E0D\u53EF\u7528",
      invalidKey ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE"
    );
  }
}

// server/_core/upstream-credential.ts
function pathWithoutQuery(req) {
  return req.originalUrl.replace(/^\/api\/frontmind/, "").split("?")[0] || "/";
}
function getPrimaryResource(req) {
  const path7 = pathWithoutQuery(req);
  const taskMatch = path7.match(/^\/v1\/(?:tasks|responses)\/([^/]+)/);
  if (taskMatch) return { kind: "task", id: decodeURIComponent(taskMatch[1]) };
  const fileMatch = path7.match(/^\/v1\/files\/([^/]+)/);
  if (fileMatch) return { kind: "file", id: decodeURIComponent(fileMatch[1]) };
  if (path7 === "/download-token" && typeof req.body?.fileId === "string") {
    return { kind: "file", id: req.body.fileId };
  }
  if (req.method === "POST" && path7 === "/v1/tasks") {
    const continuationId = req.body?.taskId ?? req.body?.previous_response_id;
    if (typeof continuationId === "string" && continuationId) {
      return { kind: "task", id: continuationId };
    }
  }
  return null;
}
function getAttachmentFileIds(req) {
  if (req.method !== "POST") return [];
  if (!Array.isArray(req.body?.attachments)) return [];
  return req.body.attachments.map(
    (item) => item && typeof item === "object" ? String(
      item.file_id ?? item.fileId ?? ""
    ) : ""
  ).filter(Boolean);
}
function sendCredentialError(res, status, message, code) {
  res.status(status).json({ error: { message, code } });
}
async function resolveUpstreamCredential(req, res, next) {
  const user = req.frontmindUser;
  if (!user) {
    sendCredentialError(res, 401, "\u8BF7\u5148\u767B\u5F55", "UNAUTHORIZED");
    return;
  }
  try {
    const requestPath = pathWithoutQuery(req);
    if (requestPath === "/proxy-download" || /^\/download\/[^/]+$/.test(requestPath)) {
      next();
      return;
    }
    const primaryResource = getPrimaryResource(req);
    const credential = primaryResource ? await getCredentialForUpstreamResource(
      user.id,
      primaryResource.kind,
      primaryResource.id
    ) : await getDecryptedCredentialForUser(user.id);
    if (!credential) {
      sendCredentialError(
        res,
        primaryResource ? 403 : 428,
        primaryResource ? "\u8BE5\u4EFB\u52A1\u6216\u6587\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7\uFF0C\u6216\u5176\u539F API Key \u5DF2\u5220\u9664" : "\u8BF7\u5148\u5728\u8D26\u53F7\u8BBE\u7F6E\u4E2D\u914D\u7F6E API Key",
        primaryResource ? "UPSTREAM_RESOURCE_FORBIDDEN" : "API_CREDENTIAL_REQUIRED"
      );
      return;
    }
    for (const fileId of getAttachmentFileIds(req)) {
      const ownedFile = await getCredentialForUpstreamResource(user.id, "file", fileId);
      if (!ownedFile || ownedFile.id !== credential.id) {
        sendCredentialError(
          res,
          403,
          "\u9644\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7\u6216\u4F7F\u7528\u4E86\u4E0D\u540C\u7684 API Key",
          "ATTACHMENT_FORBIDDEN"
        );
        return;
      }
    }
    req.frontmindCredential = credential;
    next();
  } catch (error) {
    const configurationError = error instanceof AuthServiceError && error.code === "INVALID_MASTER_KEY";
    console.error("[Credential] Failed to resolve upstream credential", error);
    sendCredentialError(
      res,
      503,
      configurationError ? "\u670D\u52A1\u7AEF\u51ED\u636E\u52A0\u5BC6\u914D\u7F6E\u65E0\u6548" : "API Key \u6682\u4E0D\u53EF\u7528",
      configurationError ? "CREDENTIAL_ENCRYPTION_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE"
    );
  }
}

// server/_core/index.ts
function assertProductionConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  assertCredentialEncryptionConfigured();
}
async function startServer() {
  assertProductionConfiguration();
  await preparedFileService.initialize();
  const app = express2();
  const server = createServer(app);
  void cleanupStaleWorkflowUploads();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "object-src 'none'; worker-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains"
      );
    }
    next();
  });
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  app.get("/healthz", async (_req, res) => {
    try {
      const db = await getDb();
      if (!db) throw new Error("Database is not configured");
      await db.execute(sql`select 1`);
      const preparedFiles = await preparedFileService.health();
      res.json({
        status: "ok",
        preparedFiles: {
          status: "ok",
          availableBytes: preparedFiles.availableBytes,
          queueLength: preparedFiles.queueLength,
          activeWorkers: preparedFiles.activeWorkers
        }
      });
    } catch (error) {
      console.error("[Health] Database readiness check failed", error);
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use(
    "/api/frontmind/assets",
    requireExpressAuth,
    prepared_file_router_default
  );
  app.use(
    "/api/frontmind",
    requireExpressAuth,
    resolveUpstreamCredential,
    manus_proxy_default
  );
  app.use("/api/manus", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  app.use(
    "/api/workflow",
    requireExpressAuth,
    attachOptionalActiveCredential,
    workflow_api_default
  );
  app.use(
    "/api/news-release",
    requireExpressAuth,
    resolveUpstreamCredential,
    news_release_api_default
  );
  app.use(
    "/api/knowledge-base",
    requireExpressAuth,
    resolveUpstreamCredential,
    knowledge_base_api_default
  );
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  app.use((err, _req, res, next) => {
    if (err instanceof URIError) {
      res.status(400).end();
      return;
    }
    console.error("[HTTP] Unhandled request error", err);
    if (res.headersSent) {
      next(err);
      return;
    }
    const candidateStatus = Number(err?.status ?? err?.statusCode);
    const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 600 ? candidateStatus : 500;
    res.status(status).json({
      error: {
        message: status === 413 ? "\u8BF7\u6C42\u5185\u5BB9\u8FC7\u5927" : "\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u8BF7\u6C42",
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_SERVER_ERROR"
      }
    });
  });
  const port = Number.parseInt(process.env.PORT || "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
  });
}
startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
