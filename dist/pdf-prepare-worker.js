// server/pdf-prepare-worker.ts
import { spawn as spawn2 } from "node:child_process";
import fs3 from "node:fs/promises";
import path2 from "node:path";
import { parentPort, workerData } from "node:worker_threads";

// server/manus-proxy.ts
import { Router } from "express";
import axios2 from "axios";
import zlib from "zlib";
import { randomUUID as randomUUID2 } from "crypto";
import fs2 from "node:fs/promises";

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

// server/auth-service.ts
var SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1e3;
var LOGIN_WINDOW_MS = 15 * 60 * 1e3;
var AuthServiceError = class extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.name = "AuthServiceError";
  }
};
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
function credentialAad(userId, credentialId) {
  return Buffer.from(`frontmind-api-credential:v1:${userId}:${credentialId}`, "utf8");
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
import fs from "node:fs/promises";
import path from "node:path";
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
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function pathSize(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(targetPath);
    let total = 0;
    for (const entry of entries) {
      total += await pathSize(path.join(targetPath, entry));
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
    this.rootDir = rootDir || process.env.FRONTMIND_PREPARED_FILE_DIR || (process.env.NODE_ENV === "production" ? "/var/lib/frontmind/prepared-files" : path.resolve(process.cwd(), ".frontmind-prepared-files"));
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
    await fs.mkdir(this.rootDir, { recursive: true, mode: 448 });
    await fs.chmod(this.rootDir, 448).catch(() => void 0);
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
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(this.rootDir, entry.name);
      if (entry.isDirectory() && (entry.name.endsWith(".work") || entry.name.endsWith(".tmp-work"))) {
        await fs.rm(fullPath, { recursive: true, force: true });
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith(".source.tmp") || entry.name.endsWith(".prepared.tmp") || entry.name.endsWith(".json.tmp"))) {
        await fs.rm(fullPath, { force: true });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await fs.readFile(fullPath, "utf8")
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
    const stats = await fs.statfs(this.rootDir);
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
      const outputStat = await fs.stat(preparedTempPath);
      if (outputStat.size < 5) {
        throw new PreparedFileError(
          "INVALID_PDF",
          "\u5904\u7406\u540E\u7684 PDF \u6587\u4EF6\u4E3A\u7A7A"
        );
      }
      const handle = await fs.open(preparedTempPath, "r");
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
      await fs.rename(preparedTempPath, this.pdfPath(manifest.id));
      await fs.chmod(this.pdfPath(manifest.id), 384).catch(() => void 0);
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
      await fs.rm(sourcePath, { force: true }).catch(() => void 0);
      await fs.rm(preparedTempPath, { force: true }).catch(() => void 0);
      await fs.rm(workDir, { recursive: true, force: true }).catch(
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
      const output = await fs.open(destination, "w", 384);
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
    await fs.mkdir(workDir, { recursive: true, mode: 448 });
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
      await fs.writeFile(temporary, snapshot, {
        encoding: "utf8",
        mode: 384
      });
      await fs.rename(temporary, destination);
    });
    this.manifestWrites.set(manifest.id, operation);
    return operation.finally(() => {
      if (this.manifestWrites.get(manifest.id) === operation) {
        this.manifestWrites.delete(manifest.id);
      }
    });
  }
  async ensureDiskSpace() {
    const stats = await fs.statfs(this.rootDir);
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
    const refreshed = await fs.statfs(this.rootDir);
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
    await fs.mkdir(this.rootDir, { recursive: true, mode: 448 });
    const now = Date.now();
    const candidates = [...this.manifests.values()].filter((manifest) => !this.active.has(manifest.id)).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (const manifest of candidates) {
      if (now - manifest.lastAccessedAt <= this.retentionMs) continue;
      await this.deleteAsset(manifest.id);
    }
    const stats = await fs.statfs(this.rootDir);
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
      const refreshed = await fs.statfs(this.rootDir);
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
      fs.rm(this.manifestPath(assetId), { force: true }),
      fs.rm(this.pdfPath(assetId), { force: true }),
      fs.rm(this.sourcePath(assetId), { force: true }),
      fs.rm(this.preparedTempPath(assetId), { force: true }),
      fs.rm(this.workPath(assetId), { recursive: true, force: true })
    ]);
  }
  manifestPath(assetId) {
    return path.join(this.rootDir, `${assetId}.json`);
  }
  sourcePath(assetId) {
    return path.join(this.rootDir, `${assetId}.source.tmp`);
  }
  preparedTempPath(assetId) {
    return path.join(this.rootDir, `${assetId}.prepared.tmp`);
  }
  pdfPath(assetId) {
    return path.join(this.rootDir, `${assetId}.pdf`);
  }
  workPath(assetId) {
    return path.join(this.rootDir, `${assetId}.work`);
  }
};
var preparedFileService = new PreparedFileService();

// server/manus-proxy.ts
var router = Router();
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
  downloadTokenCache.forEach((data2, token) => {
    if (now - data2.createdAt > DOWNLOAD_TOKEN_TTL) {
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
function isPdfMagicBytes(data2) {
  return data2.length >= 5 && data2.subarray(0, 5).toString("ascii") === "%PDF-";
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
function ensureFilenameMatchesContent(filename, data2, contentType) {
  const safe = sanitizeFilename(filename);
  const lower = safe.toLowerCase();
  if ((isPdfMagicBytes(data2) || isPdfFile(safe, contentType)) && !lower.endsWith(".pdf")) {
    return hasUsableExtension(safe) ? safe.replace(/\.[^.\/]+$/, ".pdf") : `${safe}.pdf`;
  }
  return safe;
}
function normalizeContentTypeForBuffer(filename, data2, contentType) {
  const ct = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
  if (isPdfMagicBytes(data2) || isPdfFile(filename, contentType)) {
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
function sanitizeTextFileBuffer(data2, filename, contentType) {
  if (!isTextBasedFile(filename, contentType)) {
    return { buffer: data2, wasSanitized: false };
  }
  try {
    const text2 = data2.toString("utf-8");
    const sanitized = sanitizeText(text2);
    if (sanitized !== text2) {
      console.log(`[FrontMind Proxy] Sanitized source-brand references in text file: ${filename}`);
      return { buffer: Buffer.from(sanitized, "utf-8"), wasSanitized: true };
    }
    return { buffer: data2, wasSanitized: false };
  } catch (e) {
    return { buffer: data2, wasSanitized: false };
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
async function sanitizePdfFile(inputPath, outputPath) {
  const input = await fs2.readFile(inputPath);
  const result = await sanitizePdfBuffer(input);
  await fs2.writeFile(outputPath, result.buffer, { mode: 384 });
  return { wasSanitized: result.wasSanitized };
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
function isZipMagicBytes(data2) {
  return data2.length >= 4 && data2[0] === 80 && data2[1] === 75 && data2[2] === 3 && data2[3] === 4;
}
async function sanitizeOfficeXmlBuffer(data2) {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(data2);
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
    return { buffer: data2, wasSanitized: false };
  } catch (err) {
    console.error(`[FrontMind Proxy] Office XML sanitization error: ${err.message}`);
    return { buffer: data2, wasSanitized: false };
  }
}
async function sanitizeFileBuffer(data2, filename, contentType) {
  if (isPdfFile(filename, contentType) || isPdfMagicBytes(data2)) {
    console.log(`[FrontMind Proxy] Detected PDF file: ${filename} (magic=${isPdfMagicBytes(data2)}, ext/ct=${isPdfFile(filename, contentType)})`);
    return sanitizePdfBuffer(data2);
  }
  if (isOfficeXmlFile(filename, contentType) || isZipMagicBytes(data2) && !isTextBasedFile(filename, contentType)) {
    console.log(`[FrontMind Proxy] Detected Office XML file: ${filename}`);
    return sanitizeOfficeXmlBuffer(data2);
  }
  return sanitizeTextFileBuffer(data2, filename, contentType);
}
router.put("/proxy-upload", async (req, res) => {
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
router.get("/proxy-download", async (req, res) => {
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
  const data2 = response.data;
  console.log(`[FrontMind Proxy] File metadata: id=${data2.id}, filename=${data2.filename}, status=${data2.status}, has_upload_url=${!!data2.upload_url}`);
  if (data2.upload_url) {
    const meta = { upload_url: data2.upload_url, filename: data2.filename || fileId };
    setCachedMeta(fileId, meta);
    return meta;
  }
  return { upload_url: "", filename: data2.filename || fileId };
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
router.post("/download-token", async (req, res) => {
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
    const token = randomUUID2();
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
router.get("/download/:token", async (req, res) => {
  try {
    cleanupExpiredDownloadTokens();
    const token = req.params.token;
    const data2 = downloadTokenCache.get(token);
    if (!data2) {
      return res.status(410).json({ error: { message: "Download link expired", code: "DOWNLOAD_LINK_EXPIRED" } });
    }
    if (!req.frontmindUser || req.frontmindUser.id !== data2.userId) {
      return res.status(403).json({ error: { message: "\u4E0B\u8F7D\u94FE\u63A5\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7", code: "DOWNLOAD_FORBIDDEN" } });
    }
    downloadTokenCache.delete(token);
    await handleFileDownload(
      res,
      data2.baseUrl,
      data2.fileId,
      data2.apiKey,
      "attachment",
      data2.userId,
      data2.credentialId
    );
  } catch (error) {
    console.error("[FrontMind Proxy] Direct token download error:", error.message);
    res.status(500).json({ error: { message: "\u4E0B\u8F7D\u94FE\u63A5\u5DF2\u5931\u6548\u6216\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25", code: "DIRECT_DOWNLOAD_ERROR" } });
  }
});
router.get("/v1/files/:fileId", async (req, res) => {
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
router.get("/v1/files/:fileId/content", async (req, res) => {
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
router.all("/*", async (req, res) => {
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

// server/pdf-prepare-worker.ts
var data = workerData;
function send(message) {
  parentPort?.postMessage(message);
}
async function run(command, args, onActivity) {
  await new Promise((resolve, reject) => {
    const child = spawn2(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stdout.on("data", () => onActivity?.());
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      onActivity?.();
      stderr += String(chunk).slice(0, 16e3);
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} exited with ${code}: ${stderr.slice(-2e3)}`
          )
        );
      }
    });
  });
}
async function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn2(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 16e3);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            `${command} exited with ${code}: ${stderr.slice(-2e3)}`
          )
        );
      }
    });
  });
}
async function commandAvailable2(command) {
  try {
    await run(command, ["-v"]);
    return true;
  } catch {
    try {
      await run(command, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
}
async function getPageCount(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn2("pdfinfo", [filePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`pdfinfo failed: ${stderr.slice(-2e3)}`));
        return;
      }
      const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(pages) || pages < 1) {
        reject(new Error("pdfinfo did not return a valid page count"));
        return;
      }
      resolve(pages);
    });
  });
}
async function sanitizeSinglePdf(inputPath, outputPath) {
  const result = await sanitizePdfFile(inputPath, outputPath);
  return result.wasSanitized;
}
async function sanitizeLargePdf(pageCount) {
  const splitPattern = path2.join(data.workDir, "source-%06d.pdf");
  await run("pdfseparate", [data.inputPath, splitPattern]);
  const sourcePages = (await fs3.readdir(data.workDir)).filter((name) => /^source-\d+\.pdf$/.test(name)).sort();
  if (sourcePages.length !== pageCount) {
    throw new Error(
      `PDF split page mismatch: expected ${pageCount}, got ${sourcePages.length}`
    );
  }
  const sanitizedPages = [];
  let wasSanitized = false;
  for (let index2 = 0; index2 < sourcePages.length; index2 += 1) {
    const sourcePage = path2.join(data.workDir, sourcePages[index2]);
    const sanitizedPage = path2.join(
      data.workDir,
      `prepared-${String(index2 + 1).padStart(6, "0")}.pdf`
    );
    wasSanitized = await sanitizeSinglePdf(sourcePage, sanitizedPage) || wasSanitized;
    sanitizedPages.push(sanitizedPage);
    await fs3.rm(sourcePage, { force: true });
    send({
      type: "progress",
      phase: "sanitizing",
      page: index2 + 1,
      pageCount
    });
  }
  send({ type: "progress", phase: "optimizing", pageCount });
  const mergedPath = path2.join(data.workDir, "merged.pdf");
  await run("pdfunite", [...sanitizedPages, mergedPath]);
  await run(
    "gs",
    [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.6",
      "-dPDFSETTINGS=/prepress",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dPreserveAnnots=true",
      "-dNOPAUSE",
      "-dBATCH",
      `-sOutputFile=${data.outputPath}`,
      mergedPath
    ],
    () => send({ type: "progress", phase: "optimizing", pageCount })
  );
  return wasSanitized;
}
async function main() {
  await fs3.mkdir(data.workDir, { recursive: true, mode: 448 });
  const stat = await fs3.stat(data.inputPath);
  const [hasPdfInfo, hasPdfToText] = await Promise.all([
    commandAvailable2("pdfinfo"),
    commandAvailable2("pdftotext")
  ]);
  if (!hasPdfInfo || !hasPdfToText) {
    throw Object.assign(
      new Error("\u7F3A\u5C11 PDF \u6821\u9A8C\u5DE5\u5177\uFF1B\u8BF7\u5728\u670D\u52A1\u5668\u5B89\u88C5 poppler-utils"),
      { code: "PDF_TOOLING_UNAVAILABLE" }
    );
  }
  const pageCount = await getPageCount(data.inputPath);
  send({ type: "progress", phase: "sanitizing", page: 0, pageCount });
  let wasSanitized;
  if (stat.size >= data.largePdfThresholdBytes) {
    const [hasPdfSeparate, hasPdfUnite, hasGhostscript] = await Promise.all([
      commandAvailable2("pdfseparate"),
      commandAvailable2("pdfunite"),
      commandAvailable2("gs")
    ]);
    if (!hasPdfSeparate || !hasPdfUnite || !hasGhostscript) {
      throw Object.assign(
        new Error(
          "\u5927\u6587\u4EF6\u5904\u7406\u9700\u8981 Poppler \u548C Ghostscript\uFF1B\u8BF7\u5B89\u88C5 poppler-utils \u4E0E ghostscript"
        ),
        { code: "PDF_TOOLING_UNAVAILABLE" }
      );
    }
    wasSanitized = await sanitizeLargePdf(pageCount);
  } else {
    wasSanitized = await sanitizeSinglePdf(data.inputPath, data.outputPath);
    send({ type: "progress", phase: "optimizing", pageCount });
  }
  const outputPageCount = await getPageCount(data.outputPath);
  if (outputPageCount !== pageCount) {
    throw Object.assign(
      new Error(
        `\u5904\u7406\u524D\u540E\u9875\u6570\u4E0D\u4E00\u81F4\uFF1A${pageCount} -> ${outputPageCount}`
      ),
      { code: "PDF_PAGE_COUNT_MISMATCH" }
    );
  }
  const extractedText = await runCapture("pdftotext", [data.outputPath, "-"]);
  const sourceBrand = ["ma", "nus"].join("");
  if (new RegExp(`\\b${sourceBrand}\\b`, "i").test(extractedText)) {
    throw Object.assign(
      new Error("\u54C1\u724C\u66FF\u6362\u6821\u9A8C\u672A\u901A\u8FC7\uFF0C\u5904\u7406\u7ED3\u679C\u672A\u53D1\u5E03"),
      { code: "BRAND_REPLACEMENT_INCOMPLETE" }
    );
  }
  send({
    type: "complete",
    pageCount: outputPageCount,
    wasSanitized
  });
}
void main().catch((error) => {
  send({
    type: "error",
    code: error?.code || "PDF_PREPARATION_FAILED",
    message: error?.message || "PDF \u5904\u7406\u5931\u8D25"
  });
});
