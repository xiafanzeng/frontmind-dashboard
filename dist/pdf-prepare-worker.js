// server/pdf-prepare-worker.ts
import { spawn as spawn2 } from "node:child_process";
import fs3 from "node:fs/promises";
import path2 from "node:path";
import { parentPort, workerData } from "node:worker_threads";

// server/manus-proxy.ts
import { Router } from "express";
import axios2 from "axios";
import zlib from "zlib";
import { randomUUID as randomUUID3 } from "crypto";
import fs2 from "node:fs/promises";

// server/upstream-config.ts
var UPSTREAM_VENDOR = ["ma", "nus"].join("");
var DEFAULT_UPSTREAM_BASE_URL = `https://api.${UPSTREAM_VENDOR}.im`;
function configuredUpstreamBaseUrl(env = process.env) {
  const raw = env.FRONTMIND_UPSTREAM_BASE_URL?.trim() || DEFAULT_UPSTREAM_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/.test(raw)) {
    return null;
  }
  return parsed.toString().replace(/\/+$/, "");
}
function assertUpstreamBaseUrlConfigured(env = process.env) {
  const configured = configuredUpstreamBaseUrl(env);
  if (!configured) {
    throw new Error(
      "FRONTMIND_UPSTREAM_BASE_URL must be an HTTPS URL without credentials, query, or fragment"
    );
  }
  return configured;
}
function getUpstreamBaseUrl(_req) {
  return assertUpstreamBaseUrlConfigured();
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
  asc,
  desc,
  eq as eq2,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne
} from "drizzle-orm";

// shared/const.ts
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;

// shared/admin-access.ts
function isExplicitAdminAccessLevel(value) {
  return value === "system_admin" || value === "delivery_admin";
}

// drizzle/schema.ts
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
    role: mysqlEnum("role", ["user", "admin", "delivery_member"]).default("user").notNull(),
    adminAccessLevel: mysqlEnum("adminAccessLevel", [
      "system_admin",
      "delivery_admin"
    ]),
    engineerRoleType: mysqlEnum("engineerRoleType", [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer"
    ]),
    marketEdition: mysqlEnum("marketEdition", ["domestic", "overseas"]).default("domestic").notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    passwordChangedAt: timestamp("passwordChangedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn")
  },
  (table) => [
    index("users_active_role_idx").on(table.isActive, table.role),
    check(
      "users_engineer_role_consistency_ck",
      sql`(
        (${table.role} = 'delivery_member' AND ${table.engineerRoleType} IS NOT NULL)
        OR
        (${table.role} <> 'delivery_member' AND ${table.engineerRoleType} IS NULL)
      )`
    )
  ]
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
var userPasswordSetupTokens = mysqlTable(
  "user_password_setup_tokens",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("user_password_setup_tokens_user_expires_idx").on(
      table.userId,
      table.expiresAt
    ),
    index("user_password_setup_tokens_hash_consumed_idx").on(
      table.tokenHash,
      table.consumedAt
    )
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
var presalesApiCredentials = mysqlTable(
  "presales_api_credentials",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    slot: varchar("slot", { length: 32 }).default("website").notNull(),
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
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    verifiedAt: timestamp("verifiedAt"),
    retiredAt: timestamp("retiredAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("presales_api_credentials_slot_version_uq").on(
      table.slot,
      table.version
    ),
    index("presales_api_credentials_slot_status_idx").on(
      table.slot,
      table.status
    )
  ]
);
var apiUsagePolicies = mysqlTable(
  "api_usage_policies",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    policyKey: varchar("policyKey", { length: 96 }).notNull().unique(),
    scope: mysqlEnum("scope", ["website_frontend", "managed_user"]).notNull(),
    workspaceUserId: int("workspaceUserId").references(() => users.id, {
      onDelete: "cascade"
    }),
    limit: int("limit", { unsigned: true }).default(23e4).notNull(),
    warningRatioBasisPoints: int("warningRatioBasisPoints", { unsigned: true }).default(8e3).notNull(),
    windowDays: int("windowDays", { unsigned: true }).default(30).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("api_usage_policies_scope_user_idx").on(
      table.scope,
      table.workspaceUserId
    )
  ]
);
var apiUsageSnapshots = mysqlTable(
  "api_usage_snapshots",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    policyId: varchar("policyId", { length: 36 }).notNull().references(() => apiUsagePolicies.id, { onDelete: "cascade" }),
    credentialFingerprint: varchar("credentialFingerprint", { length: 32 }),
    /** Whole shared Key pool usage observed upstream for the active period. */
    used: int("used", { unsigned: true }).default(0).notNull(),
    /** Usage attributed by the local ownership ledger to this policy's user. */
    accountUsed: int("accountUsed", { unsigned: true }).default(0).notNull(),
    windowStartedAt: timestamp("windowStartedAt").notNull(),
    fetchedAt: timestamp("fetchedAt"),
    syncStatus: mysqlEnum("syncStatus", [
      "pending",
      "ok",
      "error",
      "unconfigured"
    ]).default("pending").notNull(),
    errorCode: varchar("errorCode", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("api_usage_snapshots_policy_uq").on(table.policyId),
    index("api_usage_snapshots_status_fetched_idx").on(
      table.syncStatus,
      table.fetchedAt
    )
  ]
);
var presalesUpstreamResources = mysqlTable(
  "presales_upstream_resources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    kind: mysqlEnum("kind", ["task", "file"]).notNull(),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    parentTaskId: varchar("parentTaskId", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    foreignKey({
      name: "presales_resources_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [presalesApiCredentials.id]
    }).onDelete("restrict"),
    uniqueIndex("presales_upstream_resources_kind_id_uq").on(
      table.kind,
      table.upstreamId
    ),
    index("presales_upstream_resources_parent_task_idx").on(table.parentTaskId)
  ]
);
var presalesOutputUrls = mysqlTable(
  "presales_output_urls",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    parentTaskId: varchar("parentTaskId", { length: 255 }).notNull(),
    urlHash: varchar("urlHash", { length: 64 }).notNull(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    foreignKey({
      name: "presales_output_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [presalesApiCredentials.id]
    }).onDelete("restrict"),
    uniqueIndex("presales_output_urls_task_hash_uq").on(
      table.parentTaskId,
      table.urlHash
    ),
    index("presales_output_urls_credential_task_idx").on(
      table.apiCredentialId,
      table.parentTaskId
    )
  ]
);
var presalesTaskRequests = mysqlTable(
  "presales_task_requests",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("projectId", { length: 80 }),
    keyHash: varchar("keyHash", { length: 64 }).notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    credentialVersion: int("credentialVersion").notNull(),
    status: mysqlEnum("status", ["pending", "completed"]).default("pending").notNull(),
    attemptId: varchar("attemptId", { length: 36 }).notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    foreignKey({
      name: "presales_task_request_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [presalesApiCredentials.id]
    }).onDelete("restrict"),
    uniqueIndex("presales_task_requests_key_uq").on(table.keyHash),
    index("presales_task_requests_credential_status_idx").on(
      table.apiCredentialId,
      table.status
    ),
    index("presales_task_requests_project_idx").on(table.projectId)
  ]
);
var presalesMonitorRuns = mysqlTable(
  "presales_monitor_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 }).notNull().unique(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    credentialVersion: int("credentialVersion").notNull(),
    question: text("question").notNull(),
    platforms: json("platforms").$type().notNull(),
    expectedItems: int("expectedItems").notNull(),
    status: mysqlEnum("status", [
      "submission_in_progress",
      "submission_unknown",
      "submitted",
      "polling",
      "completed",
      "partial_review_required",
      "remote_failed",
      "shape_mismatch"
    ]).default("submission_in_progress").notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 128 }),
    submitTotalItems: int("submitTotalItems"),
    initialSubtaskIds: json("initialSubtaskIds").$type(),
    subtaskScopes: json("subtaskScopes").$type(),
    remoteStatus: varchar("remoteStatus", { length: 64 }),
    completedItems: int("completedItems").default(0).notNull(),
    failedItems: int("failedItems").default(0).notNull(),
    totalItems: int("totalItems"),
    checkpoint: json("checkpoint").$type(),
    finalResult: json("finalResult").$type(),
    shapeMismatch: boolean("shapeMismatch").default(false).notNull(),
    terminalSnapshotHash: varchar("terminalSnapshotHash", { length: 64 }),
    terminalStableCount: int("terminalStableCount").default(0).notNull(),
    lastError: text("lastError"),
    nextPollAt: timestamp("nextPollAt"),
    lastPollStartedAt: timestamp("lastPollStartedAt"),
    pollLeaseId: varchar("pollLeaseId", { length: 36 }),
    pollLeaseExpiresAt: timestamp("pollLeaseExpiresAt"),
    submittedAt: timestamp("submittedAt"),
    completedAt: timestamp("completedAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("presales_monitor_credential_status_idx").on(
      table.apiCredentialId,
      table.status
    ),
    index("presales_monitor_poll_idx").on(table.status, table.nextPollAt)
  ]
);
var websitePaymentReceipts = mysqlTable(
  "website_payment_receipts",
  {
    orderId: varchar("orderId", { length: 128 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true }).default(1).notNull(),
    tradeNo: varchar("tradeNo", { length: 128 }).notNull().unique(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    paidAt: timestamp("paidAt", { fsp: 3 }).notNull(),
    purchaseType: mysqlEnum("purchaseType", [
      "monitoring",
      "service"
    ]).notNull(),
    scopeHash: varchar("scopeHash", { length: 64 }).notNull(),
    authorizationDigest: varchar("authorizationDigest", {
      length: 64
    }).notNull(),
    reviewRequired: boolean("reviewRequired").notNull(),
    createdAt: timestamp("createdAt", { fsp: 3 }).default(sql`CURRENT_TIMESTAMP(3)`).notNull()
  },
  (table) => [
    index("website_payment_receipts_scope_idx").on(
      table.scopeHash,
      table.authorizationDigest
    ),
    check(
      "website_payment_receipts_schema_version_ck",
      sql`${table.schemaVersion} = 1`
    ),
    check(
      "website_payment_receipts_amount_ck",
      sql`${table.amountFen} > 0 AND ${table.amountFen} <= 10000000`
    ),
    check(
      "website_payment_receipts_scope_hash_ck",
      sql`${table.scopeHash} REGEXP '^[a-f0-9]{64}$'`
    ),
    check(
      "website_payment_receipts_authorization_digest_ck",
      sql`${table.authorizationDigest} REGEXP '^[a-f0-9]{64}$'`
    )
  ]
);
var websiteProjectOrders = mysqlTable(
  "website_project_orders",
  {
    orderId: varchar("orderId", { length: 128 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true }).default(1).notNull(),
    projectId: varchar("projectId", { length: 80 }).notNull(),
    purchaseType: mysqlEnum("purchaseType", [
      "monitoring",
      "service"
    ]).notNull(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    authorizationDigest: varchar("authorizationDigest", {
      length: 64
    }).notNull().unique(),
    state: mysqlEnum("state", [
      "pending",
      "paid",
      "fulfilling",
      "fulfilled",
      "review_required",
      "terminal_failed",
      "closed"
    ]).notNull(),
    checkoutExpiresAt: timestamp("checkoutExpiresAt", { fsp: 3 }).notNull(),
    paidAt: timestamp("paidAt", { fsp: 3 }),
    fulfilledAt: timestamp("fulfilledAt", { fsp: 3 }),
    lastEventAt: timestamp("lastEventAt", { fsp: 3 }).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    // drizzle-kit 0.31 renders onUpdateNow without the column fsp, so migration
    // 0032 must keep its ON UPDATE clause pinned to CURRENT_TIMESTAMP(3).
    createdAt: timestamp("createdAt", { fsp: 3 }).default(sql`CURRENT_TIMESTAMP(3)`).notNull(),
    updatedAt: timestamp("updatedAt", { fsp: 3 }).default(sql`CURRENT_TIMESTAMP(3)`).onUpdateNow().notNull()
  },
  (table) => [
    index("website_project_orders_project_state_idx").on(
      table.projectId,
      table.state
    ),
    check(
      "website_project_orders_schema_version_ck",
      sql`${table.schemaVersion} = 1`
    ),
    check(
      "website_project_orders_amount_ck",
      sql`${table.amountFen} > 0 AND ${table.amountFen} <= 10000000`
    ),
    check(
      "website_project_orders_authorization_digest_ck",
      sql`${table.authorizationDigest} REGEXP '^[a-f0-9]{64}$'`
    ),
    check("website_project_orders_revision_ck", sql`${table.revision} > 0`),
    check(
      "website_project_orders_paid_state_ck",
      sql`${table.state} IN ('pending', 'closed') OR ${table.paidAt} IS NOT NULL`
    ),
    check(
      "website_project_orders_fulfilled_state_ck",
      sql`(${table.state} = 'fulfilled' AND ${table.fulfilledAt} IS NOT NULL) OR (${table.state} <> 'fulfilled' AND ${table.fulfilledAt} IS NULL)`
    ),
    check(
      "website_project_orders_fulfilled_time_ck",
      sql`${table.fulfilledAt} IS NULL OR (${table.paidAt} IS NOT NULL AND ${table.fulfilledAt} >= ${table.paidAt})`
    )
  ]
);
var websiteUserProvisions = mysqlTable(
  "website_user_provisions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true }).default(1).notNull(),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 }).notNull().unique(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    projectId: varchar("projectId", { length: 80 }).notNull(),
    companyName: varchar("companyName", { length: 200 }).notNull(),
    orderId: varchar("orderId", { length: 64 }).notNull().unique(),
    tradeNo: varchar("tradeNo", { length: 128 }).notNull().unique(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    paidAt: timestamp("paidAt").notNull(),
    serviceCategory: mysqlEnum("serviceCategory", [
      "product_scenario",
      "reputation",
      "competitor_comparison"
    ]).notNull(),
    planCode: mysqlEnum("planCode", ["basic", "advanced", "luxury"]),
    questionId: varchar("questionId", { length: 80 }).notNull(),
    question: text("question").notNull(),
    contractId: varchar("contractId", { length: 128 }).notNull().unique(),
    contractTemplateVersion: varchar("contractTemplateVersion", {
      length: 64
    }).notNull(),
    contractDocumentSha256: varchar("contractDocumentSha256", {
      length: 64
    }).notNull(),
    contractEvidence: json("contractEvidence").$type(),
    contractConfirmationStatus: mysqlEnum("contractConfirmationStatus", [
      "confirmed",
      "pending_confirmation",
      "rejected"
    ]).default("confirmed").notNull(),
    contractSignedAt: timestamp("contractSignedAt"),
    signatoryId: varchar("signatoryId", { length: 128 }),
    requestedUsername: varchar("requestedUsername", { length: 64 }).notNull(),
    requestedDisplayName: varchar("requestedDisplayName", {
      length: 128
    }).notNull(),
    accountMode: mysqlEnum("accountMode", ["create", "bind_existing"]).default("create").notNull(),
    purchaseIntentId: varchar("purchaseIntentId", { length: 36 }).references(
      () => purchaseIntents.id,
      { onDelete: "set null" }
    ),
    userId: int("userId").references(() => users.id, {
      onDelete: "set null"
    }),
    status: mysqlEnum("status", [
      "pending_confirmation",
      "pending",
      "completed",
      "failed"
    ]).default("pending").notNull(),
    accountSetupTokenHash: varchar("accountSetupTokenHash", {
      length: 64
    }).unique(),
    accountSetupTokenExpiresAt: timestamp("accountSetupTokenExpiresAt"),
    accountSetupTokenConsumedAt: timestamp("accountSetupTokenConsumedAt"),
    lastError: text("lastError"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("website_user_provisions_project_idx").on(table.projectId),
    index("website_user_provisions_user_idx").on(table.userId),
    index("website_user_provisions_status_idx").on(table.status),
    index("website_user_provisions_purchase_intent_idx").on(
      table.purchaseIntentId
    )
  ]
);
var websiteManualServiceOrders = mysqlTable(
  "website_manual_service_orders",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true }).default(1).notNull(),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 }).notNull().unique(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    projectId: varchar("projectId", { length: 80 }).notNull(),
    companyName: varchar("companyName", { length: 200 }).notNull(),
    contractProfile: json("contractProfile").$type().notNull(),
    serviceCategory: mysqlEnum("serviceCategory", [
      "product_scenario",
      "reputation",
      "competitor_comparison"
    ]).notNull(),
    planCode: mysqlEnum("planCode", ["basic"]).default("basic").notNull(),
    serviceDays: int("serviceDays", { unsigned: true }).default(30).notNull(),
    questionId: varchar("questionId", { length: 80 }).notNull(),
    question: text("question").notNull(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    contractTemplateVersion: varchar("contractTemplateVersion", {
      length: 64
    }).notNull(),
    externalContractId: varchar("externalContractId", {
      length: 128
    }).unique(),
    signingUrl: varchar("signingUrl", { length: 2048 }),
    signedPdfFileId: varchar("signedPdfFileId", { length: 255 }).unique(),
    signedPdfFilename: varchar("signedPdfFilename", { length: 512 }),
    signedPdfSha256: varchar("signedPdfSha256", { length: 64 }),
    evidenceReportFileId: varchar("evidenceReportFileId", {
      length: 255
    }),
    evidenceReportFilename: varchar("evidenceReportFilename", { length: 512 }),
    evidenceReportSha256: varchar("evidenceReportSha256", { length: 64 }),
    signedAt: timestamp("signedAt"),
    signatoryId: varchar("signatoryId", { length: 128 }),
    signatureNote: text("signatureNote"),
    paymentIdempotencyKeyHash: varchar("paymentIdempotencyKeyHash", {
      length: 64
    }).unique(),
    paymentRequestHash: varchar("paymentRequestHash", { length: 64 }),
    paymentOrderId: varchar("paymentOrderId", { length: 64 }).unique(),
    paymentTradeNo: varchar("paymentTradeNo", { length: 128 }).unique(),
    paidAt: timestamp("paidAt"),
    accountSetupIdempotencyKeyHash: varchar("accountSetupIdempotencyKeyHash", {
      length: 64
    }).unique(),
    accountSetupRequestHash: varchar("accountSetupRequestHash", { length: 64 }),
    accountMode: mysqlEnum("accountMode", ["create", "bind_existing"]),
    requestedUsername: varchar("requestedUsername", { length: 64 }),
    requestedDisplayName: varchar("requestedDisplayName", { length: 128 }),
    requestedPasswordHash: varchar("requestedPasswordHash", { length: 255 }),
    provisioningReference: varchar("provisioningReference", {
      length: 128
    }).unique(),
    status: mysqlEnum("status", [
      "pending_admin",
      "signature_required",
      "payment_required",
      "account_setup_required",
      "activation_required",
      "active",
      "rejected",
      "failed"
    ]).default("pending_admin").notNull(),
    preparedByUserId: int("preparedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    signedByUserId: int("signedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    activatedByUserId: int("activatedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    rejectedByUserId: int("rejectedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    preparedAt: timestamp("preparedAt"),
    accountSetupAt: timestamp("accountSetupAt"),
    activatedAt: timestamp("activatedAt"),
    rejectedAt: timestamp("rejectedAt"),
    lastError: text("lastError"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("manual_service_orders_project_idx").on(table.projectId),
    index("manual_service_orders_status_created_idx").on(
      table.status,
      table.createdAt
    ),
    index("manual_service_orders_payment_idx").on(
      table.paymentOrderId,
      table.paymentTradeNo
    )
  ]
);
var serviceContracts = mysqlTable(
  "service_contracts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    planCode: mysqlEnum("planCode", ["basic", "advanced", "luxury"]).notNull(),
    planVersion: int("planVersion", { unsigned: true }).default(1).notNull(),
    status: mysqlEnum("status", [
      "pending_confirmation",
      "scheduled",
      "active",
      "suspended",
      "cancelled",
      "superseded"
    ]).default("active").notNull(),
    startsAt: timestamp("startsAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    source: mysqlEnum("source", ["website", "offline", "admin"]).default("admin").notNull(),
    amountFen: int("amountFen", { unsigned: true }),
    currency: varchar("currency", { length: 3 }).default("CNY").notNull(),
    prepaidMonths: int("prepaidMonths", { unsigned: true }),
    orderReference: varchar("orderReference", { length: 128 }),
    externalContractReference: varchar("externalContractReference", {
      length: 128
    }),
    signedAt: timestamp("signedAt"),
    signatoryId: varchar("signatoryId", { length: 128 }),
    signingEvidence: json("signingEvidence").$type(),
    replacesContractIds: json("replacesContractIds").$type().default([]).notNull(),
    sourceReference: varchar("sourceReference", { length: 191 }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("service_contracts_user_revision_uq").on(
      table.userId,
      table.revision
    ),
    index("service_contracts_user_status_ends_idx").on(
      table.userId,
      table.status,
      table.endsAt
    ),
    index("service_contracts_source_reference_idx").on(
      table.source,
      table.sourceReference
    ),
    index("service_contracts_order_reference_idx").on(
      table.source,
      table.orderReference
    )
  ]
);
var serviceQuotaPeriods = mysqlTable(
  "service_quota_periods",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    contractId: varchar("contractId", { length: 36 }).notNull().references(() => serviceContracts.id, { onDelete: "cascade" }),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    startsAt: timestamp("startsAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    industryLimit: int("industryLimit", { unsigned: true }).default(0).notNull(),
    competitorComparisonLimit: int("competitorComparisonLimit", {
      unsigned: true
    }).default(0).notNull(),
    reputationLimit: int("reputationLimit", { unsigned: true }).default(0).notNull(),
    productScenarioLimit: int("productScenarioLimit", { unsigned: true }).default(0).notNull(),
    totalQuestionLimit: int("totalQuestionLimit", { unsigned: true }).default(0).notNull(),
    contentAssetPublishLimit: int("contentAssetPublishLimit", {
      unsigned: true
    }).default(0).notNull(),
    websiteContentPublishLimit: int("websiteContentPublishLimit", {
      unsigned: true
    }).default(0).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("service_quota_periods_contract_ordinal_uq").on(
      table.contractId,
      table.ordinal
    ),
    index("service_quota_periods_user_window_idx").on(
      table.userId,
      table.startsAt,
      table.endsAt
    )
  ]
);
var deliveryTickets = mysqlTable(
  "delivery_tickets",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 }).notNull().references(() => serviceContracts.id, { onDelete: "restrict" }),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 }).notNull().references(() => serviceQuotaPeriods.id, { onDelete: "restrict" }),
    type: mysqlEnum("type", [
      "content_asset",
      "website_operation",
      "knowledge_base"
    ]).notNull(),
    quotaPool: mysqlEnum("quotaPool", [
      "content_asset_publish",
      "website_content_publish"
    ]),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    clientRequestId: varchar("clientRequestId", { length: 36 }).notNull(),
    category: varchar("category", { length: 64 }),
    topic: varchar("topic", { length: 512 }),
    title: varchar("title", { length: 512 }),
    description: text("description"),
    preferredMedia: varchar("preferredMedia", { length: 32 }),
    icpProvince: varchar("icpProvince", { length: 64 }),
    icpDeclarations: json("icpDeclarations").$type(),
    targetPage: text("targetPage"),
    knowledgeSnapshotId: varchar("knowledgeSnapshotId", { length: 36 }),
    workflowDomain: mysqlEnum("workflowDomain", [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer"
    ]),
    operation: varchar("operation", { length: 64 }),
    assignedProjectAssignmentId: varchar("assignedProjectAssignmentId", {
      length: 36
    }),
    assignedMemberId: int("assignedMemberId").references(() => users.id, {
      onDelete: "set null"
    }),
    sourceQuestionId: varchar("sourceQuestionId", { length: 191 }),
    monitoringBatchKey: varchar("monitoringBatchKey", { length: 191 }),
    responseLogicRevision: int("responseLogicRevision"),
    contentAssetIds: json("contentAssetIds").$type().default([]).notNull(),
    technicalDedupeKey: varchar("technicalDedupeKey", { length: 64 }),
    materialUrls: json("materialUrls").$type().default([]).notNull(),
    priority: mysqlEnum("priority", ["low", "normal", "high", "urgent"]).default("normal").notNull(),
    status: mysqlEnum("status", [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled"
    ]).default("submitted").notNull(),
    quotaState: mysqlEnum("quotaState", ["reserved", "consumed", "released"]).default("reserved").notNull(),
    internalNote: text("internalNote"),
    publicSummary: text("publicSummary"),
    deliveryLinks: json("deliveryLinks").$type().default([]).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    resolvedAt: timestamp("resolvedAt"),
    scheduledAt: timestamp("scheduledAt"),
    quotaReleasedAt: timestamp("quotaReleasedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("delivery_tickets_period_pool_ordinal_uq").on(
      table.quotaPeriodId,
      table.quotaPool,
      table.ordinal
    ),
    uniqueIndex("delivery_tickets_user_request_uq").on(
      table.userId,
      table.clientRequestId
    ),
    uniqueIndex("delivery_tickets_user_technical_dedupe_uq").on(
      table.userId,
      table.technicalDedupeKey
    ),
    index("delivery_tickets_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    index("delivery_tickets_period_pool_state_idx").on(
      table.quotaPeriodId,
      table.quotaPool,
      table.quotaState
    ),
    index("delivery_tickets_status_updated_idx").on(
      table.status,
      table.updatedAt
    ),
    index("delivery_tickets_user_updated_id_idx").on(
      table.userId,
      table.updatedAt,
      table.id
    ),
    index("delivery_tickets_user_period_updated_id_idx").on(
      table.userId,
      table.quotaPeriodId,
      table.updatedAt,
      table.id
    ),
    index("delivery_tickets_type_status_updated_id_idx").on(
      table.type,
      table.status,
      table.updatedAt,
      table.id
    ),
    index("delivery_tickets_role_member_status_idx").on(
      table.workflowDomain,
      table.assignedMemberId,
      table.status
    ),
    index("delivery_tickets_member_status_resolved_id_idx").on(
      table.assignedMemberId,
      table.status,
      table.resolvedAt,
      table.id
    ),
    foreignKey({
      name: "delivery_tickets_project_assignment_fk",
      columns: [table.assignedProjectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id]
    }).onDelete("set null")
  ]
);
var deliveryTicketEvents = mysqlTable(
  "delivery_ticket_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ticketId: varchar("ticketId", { length: 36 }).notNull().references(() => deliveryTickets.id, { onDelete: "cascade" }),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    actorUserId: int("actorUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    actorRole: mysqlEnum("actorRole", [
      "user",
      "admin",
      "delivery_member",
      "system"
    ]).notNull(),
    actorContext: json("actorContext").$type(),
    kind: mysqlEnum("kind", [
      "created",
      "message",
      "status_change",
      "attachment",
      "delivery_result"
    ]).notNull(),
    visibility: mysqlEnum("visibility", ["customer", "internal"]).default("customer").notNull(),
    clientRequestId: varchar("clientRequestId", { length: 36 }),
    message: text("message"),
    fromStatus: mysqlEnum("fromStatus", [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled"
    ]),
    toStatus: mysqlEnum("toStatus", [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled"
    ]),
    operationResult: json("operationResult").$type(),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("delivery_ticket_events_actor_request_uq").on(
      table.actorUserId,
      table.clientRequestId
    ),
    index("delivery_ticket_events_ticket_created_idx").on(
      table.ticketId,
      table.createdAt
    ),
    index("delivery_ticket_events_user_created_idx").on(
      table.userId,
      table.createdAt
    )
  ]
);
var deliveryTicketAttachments = mysqlTable(
  "delivery_ticket_attachments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ticketId: varchar("ticketId", { length: 36 }).notNull().references(() => deliveryTickets.id, { onDelete: "cascade" }),
    eventId: varchar("eventId", { length: 36 }).references(
      () => deliveryTicketEvents.id,
      { onDelete: "set null" }
    ),
    workspaceUserId: int("workspaceUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
    ownerUserId: int("ownerUserId").notNull().references(() => users.id, { onDelete: "restrict" }),
    kind: mysqlEnum("kind", ["input", "deliverable"]).default("input").notNull(),
    upstreamFileId: varchar("upstreamFileId", { length: 255 }),
    filename: varchar("filename", { length: 512 }).notNull(),
    mimeType: varchar("mimeType", { length: 255 }),
    sizeBytes: int("sizeBytes", { unsigned: true }),
    sha256: varchar("sha256", { length: 64 }),
    purpose: varchar("purpose", { length: 160 }),
    authorization: mysqlEnum("authorization", [
      "owned",
      "licensed",
      "public",
      "authorization_pending"
    ]),
    copyrightNote: text("copyrightNote"),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("delivery_ticket_attachments_event_file_kind_uq").on(
      table.eventId,
      table.upstreamFileId,
      table.kind
    ),
    index("delivery_ticket_attachments_ticket_created_idx").on(
      table.ticketId,
      table.createdAt
    ),
    index("delivery_ticket_attachments_owner_file_idx").on(
      table.ownerUserId,
      table.upstreamFileId
    )
  ]
);
var deliveryMemberOrigins = mysqlTable(
  "delivery_member_origins",
  {
    engineerUserId: int("engineerUserId").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    createdByAdminId: int("createdByAdminId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    index("delivery_member_origins_admin_idx").on(table.createdByAdminId)
  ]
);
var websiteStyleWorkflows = mysqlTable(
  "website_style_workflows",
  {
    userId: int("userId").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    status: mysqlEnum("status", [
      "waiting_samples",
      "awaiting_selection",
      "revision_requested",
      "confirmed",
      "legacy_confirmed"
    ]).default("waiting_samples").notNull(),
    currentBatchId: varchar("currentBatchId", { length: 36 }),
    selectedSampleId: varchar("selectedSampleId", { length: 36 }),
    selectedByUserId: int("selectedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    selectedAt: timestamp("selectedAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [index("website_style_workflows_status_idx").on(table.status)]
);
var websiteStyleSampleBatches = mysqlTable(
  "website_style_sample_batches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    ticketId: varchar("ticketId", { length: 36 }).notNull().references(() => deliveryTickets.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    status: mysqlEnum("status", [
      "published",
      "revision_requested",
      "selected",
      "superseded"
    ]).default("published").notNull(),
    engineerNote: text("engineerNote"),
    publishedByUserId: int("publishedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    publishedAt: timestamp("publishedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("website_style_batches_user_ordinal_uq").on(
      table.userId,
      table.ordinal
    ),
    index("website_style_batches_ticket_status_idx").on(
      table.ticketId,
      table.status
    )
  ]
);
var websiteStyleSamples = mysqlTable(
  "website_style_samples",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    batchId: varchar("batchId", { length: 36 }).notNull().references(() => websiteStyleSampleBatches.id, {
      onDelete: "cascade"
    }),
    attachmentId: varchar("attachmentId", { length: 36 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    note: text("note"),
    sortOrder: int("sortOrder", { unsigned: true }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("website_style_samples_batch_order_uq").on(
      table.batchId,
      table.sortOrder
    ),
    uniqueIndex("website_style_samples_batch_attachment_uq").on(
      table.batchId,
      table.attachmentId
    ),
    foreignKey({
      name: "website_style_samples_attachment_fk",
      columns: [table.attachmentId],
      foreignColumns: [deliveryTicketAttachments.id]
    }).onDelete("restrict")
  ]
);
var workspaceSiteProfiles = mysqlTable(
  "workspace_site_profiles",
  {
    userId: int("userId").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }),
    siteMode: mysqlEnum("siteMode", ["managed", "external", "unknown"]).default("unknown").notNull(),
    domainStatus: mysqlEnum("domainStatus", [
      "not_started",
      "pending",
      "completed"
    ]).default("not_started").notNull(),
    domainVerifiedAt: timestamp("domainVerifiedAt"),
    icpProvince: varchar("icpProvince", { length: 64 }),
    icpNumber: varchar("icpNumber", { length: 128 }),
    icpStatus: mysqlEnum("icpStatus", [
      "not_submitted",
      "preparing",
      "submitted",
      "approved",
      "rejected",
      "not_required"
    ]).default("not_submitted").notNull(),
    icpVerifiedAt: timestamp("icpVerifiedAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("workspace_site_profiles_domain_idx").on(table.domain),
    index("workspace_site_profiles_workflow_idx").on(
      table.domainStatus,
      table.icpStatus
    )
  ]
);
var workspaceSiteChecks = mysqlTable(
  "workspace_site_checks",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    status: mysqlEnum("status", [
      "not_checked",
      "pending",
      "passed",
      "warning",
      "failed",
      "not_applicable"
    ]).default("not_checked").notNull(),
    summary: text("summary"),
    evidence: text("evidence"),
    source: text("source"),
    checkedAt: timestamp("checkedAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("workspace_site_checks_user_key_uq").on(
      table.userId,
      table.key
    ),
    index("workspace_site_checks_user_status_idx").on(
      table.userId,
      table.status
    )
  ]
);
var deliveryRedirectPreviews = mysqlTable(
  "delivery_redirect_previews",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    ownerUserId: int("ownerUserId").notNull().references(() => users.id, { onDelete: "restrict" }),
    upstreamFileId: varchar("upstreamFileId", { length: 255 }).notNull(),
    filename: varchar("filename", { length: 512 }).notNull(),
    fileHash: varchar("fileHash", { length: 64 }).notNull(),
    rows: json("rows").$type().default([]).notNull(),
    errors: json("errors").$type().default([]).notNull(),
    total: int("total", { unsigned: true }).default(0).notNull(),
    validCount: int("validCount", { unsigned: true }).default(0).notNull(),
    errorCount: int("errorCount", { unsigned: true }).default(0).notNull(),
    status: mysqlEnum("status", ["previewed", "applied", "expired"]).default("previewed").notNull(),
    appliedTicketId: varchar("appliedTicketId", { length: 36 }).references(
      () => deliveryTickets.id,
      { onDelete: "set null" }
    ),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    appliedAt: timestamp("appliedAt")
  },
  (table) => [
    uniqueIndex("delivery_redirect_previews_user_hash_uq").on(
      table.userId,
      table.fileHash
    ),
    index("delivery_redirect_previews_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    index("delivery_redirect_previews_status_expires_idx").on(
      table.status,
      table.expiresAt
    )
  ]
);
var serviceProgressReports = mysqlTable(
  "service_progress_reports",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 }).notNull().references(() => serviceContracts.id, { onDelete: "cascade" }),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 }).notNull().references(() => serviceQuotaPeriods.id, { onDelete: "cascade" }),
    payload: json("payload").$type().notNull(),
    sourceName: varchar("sourceName", { length: 512 }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    publishedByUserId: int("publishedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("service_progress_reports_period_revision_uq").on(
      table.quotaPeriodId,
      table.revision
    ),
    index("service_progress_reports_user_period_created_idx").on(
      table.userId,
      table.quotaPeriodId,
      table.createdAt
    ),
    index("service_progress_reports_contract_idx").on(table.contractId)
  ]
);
var workspaceQuestions = mysqlTable(
  "workspace_questions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 }).notNull().references(() => serviceContracts.id, { onDelete: "cascade" }),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 }).notNull().references(() => serviceQuotaPeriods.id, { onDelete: "cascade" }),
    externalQuestionId: varchar("externalQuestionId", { length: 191 }),
    sourceQuestionId: varchar("sourceQuestionId", { length: 36 }),
    candidateKey: varchar("candidateKey", { length: 191 }),
    category: mysqlEnum("category", [
      "industry",
      "competitor_comparison",
      "reputation",
      "product_scenario"
    ]).notNull(),
    question: text("question").notNull(),
    intent: text("intent"),
    intentRevision: int("intentRevision", { unsigned: true }).default(1).notNull(),
    intentConfirmedRevision: int("intentConfirmedRevision", {
      unsigned: true
    }),
    intentConfirmedAt: timestamp("intentConfirmedAt"),
    intentConfirmedByUserId: int("intentConfirmedByUserId").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    rationale: text("rationale"),
    evidence: json("evidence").$type().default([]).notNull(),
    risks: json("risks").$type().default([]).notNull(),
    source: mysqlEnum("source", [
      "model",
      "website",
      "offline",
      "admin",
      "user"
    ]).default("model").notNull(),
    status: mysqlEnum("status", ["candidate", "selected", "archived"]).default("candidate").notNull(),
    selectionApprovalStatus: mysqlEnum("selectionApprovalStatus", [
      "not_requested",
      "pending",
      "approved"
    ]).default("not_requested").notNull(),
    selectionRequestedAt: timestamp("selectionRequestedAt"),
    selectionRequestedByUserId: int("selectionRequestedByUserId").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    selectionApprovedAt: timestamp("selectionApprovedAt"),
    selectionApprovedByUserId: int("selectionApprovedByUserId").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    locked: boolean("locked").default(false).notNull(),
    sourceTaskId: varchar("sourceTaskId", { length: 255 }),
    knowledgeSnapshotId: varchar("knowledgeSnapshotId", {
      length: 36
    }).references(() => knowledgeBaseSnapshots.id, { onDelete: "set null" }),
    ordinal: int("ordinal", { unsigned: true }).default(0).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    selectedAt: timestamp("selectedAt"),
    archivedAt: timestamp("archivedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("workspace_questions_generation_key_uq").on(
      table.quotaPeriodId,
      table.sourceTaskId,
      table.candidateKey
    ),
    index("workspace_questions_user_period_status_idx").on(
      table.userId,
      table.quotaPeriodId,
      table.status
    ),
    index("workspace_questions_user_category_status_idx").on(
      table.userId,
      table.category,
      table.status
    ),
    index("workspace_questions_user_approval_status_idx").on(
      table.userId,
      table.selectionApprovalStatus,
      table.updatedAt
    ),
    index("workspace_questions_external_idx").on(
      table.userId,
      table.externalQuestionId
    ),
    index("workspace_questions_source_question_idx").on(
      table.userId,
      table.sourceQuestionId
    )
  ]
);
var knowledgeImportReceipts = mysqlTable(
  "knowledge_import_receipts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    source: mysqlEnum("source", ["website", "offline", "admin"]).default("website").notNull(),
    projectId: varchar("projectId", { length: 80 }),
    companyName: varchar("companyName", { length: 200 }),
    taskId: varchar("taskId", { length: 255 }),
    fileId: varchar("fileId", { length: 255 }),
    outputItemId: varchar("outputItemId", { length: 255 }),
    descriptorHash: varchar("descriptorHash", { length: 64 }),
    sourceReference: varchar("sourceReference", { length: 191 }),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 }).notNull().unique(),
    artifactHash: varchar("artifactHash", { length: 64 }).notNull(),
    sourceFileName: varchar("sourceFileName", { length: 512 }).notNull(),
    status: mysqlEnum("status", [
      "pending",
      "processing",
      "completed",
      "failed"
    ]).default("pending").notNull(),
    snapshotId: varchar("snapshotId", { length: 36 }).references(
      () => knowledgeBaseSnapshots.id,
      { onDelete: "set null" }
    ),
    attemptCount: int("attemptCount", { unsigned: true }).default(0).notNull(),
    errorCode: varchar("errorCode", { length: 128 }),
    errorMessage: text("errorMessage"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("knowledge_import_receipts_user_artifact_uq").on(
      table.userId,
      table.artifactHash
    ),
    uniqueIndex("knowledge_import_receipts_project_descriptor_uq").on(
      table.projectId,
      table.taskId,
      table.outputItemId,
      table.descriptorHash
    ),
    index("knowledge_import_receipts_user_status_idx").on(
      table.userId,
      table.status
    ),
    index("knowledge_import_receipts_project_task_idx").on(
      table.projectId,
      table.taskId
    )
  ]
);
var purchaseIntents = mysqlTable(
  "purchase_intents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    sourceContractId: varchar("sourceContractId", {
      length: 36
    }).references(() => serviceContracts.id, { onDelete: "set null" }),
    resultingContractId: varchar("resultingContractId", {
      length: 36
    }).references(() => serviceContracts.id, { onDelete: "set null" }),
    targetPlanCode: mysqlEnum("targetPlanCode", [
      "basic",
      "advanced",
      "luxury"
    ]).notNull(),
    kind: mysqlEnum("kind", [
      "new_purchase",
      "repeat_basic",
      "upgrade",
      "renewal"
    ]).notNull(),
    status: mysqlEnum("status", ["pending", "consumed", "cancelled"]).default("pending").notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    externalOrderId: varchar("externalOrderId", { length: 128 }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("purchase_intents_user_status_expires_idx").on(
      table.userId,
      table.status,
      table.expiresAt
    ),
    index("purchase_intents_external_order_idx").on(table.externalOrderId)
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
var userAdminAssignments = mysqlTable(
  "user_admin_assignments",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    adminId: int("adminId").notNull().references(() => users.id, { onDelete: "cascade" }),
    assignedByUserId: int("assignedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("user_admin_assignments_user_admin_uq").on(
      table.userId,
      table.adminId
    ),
    index("user_admin_assignments_admin_idx").on(table.adminId)
  ]
);
var deliveryProjectAssignments = mysqlTable(
  "delivery_project_assignments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    customerUserId: int("customerUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleType: mysqlEnum("roleType", [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer"
    ]).notNull(),
    engineerUserId: int("engineerUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    assignedByUserId: int("assignedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("delivery_project_assignments_customer_type_uq").on(
      table.customerUserId,
      table.roleType
    ),
    index("delivery_project_assignments_engineer_type_idx").on(
      table.engineerUserId,
      table.roleType
    )
  ]
);
var userUsageOwners = mysqlTable(
  "user_usage_owners",
  {
    userId: int("userId").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    deliveryAdminId: int("deliveryAdminId").notNull().references(() => users.id, { onDelete: "restrict" }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    index("user_usage_owners_delivery_admin_idx").on(table.deliveryAdminId)
  ]
);
var workspaceAuditEvents = mysqlTable(
  "workspace_audit_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    actorUserId: int("actorUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    actorUsername: varchar("actorUsername", { length: 64 }),
    actorAccessLevel: mysqlEnum("actorAccessLevel", [
      "system_admin",
      "delivery_admin"
    ]),
    action: varchar("action", { length: 128 }).notNull(),
    targetType: varchar("targetType", { length: 64 }).notNull(),
    targetId: varchar("targetId", { length: 191 }).notNull(),
    workspaceUserId: int("workspaceUserId"),
    reason: text("reason"),
    metadata: json("metadata").$type().default({}).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    index("workspace_audit_events_actor_created_idx").on(
      table.actorUserId,
      table.createdAt
    ),
    index("workspace_audit_events_workspace_created_idx").on(
      table.workspaceUserId,
      table.createdAt
    ),
    index("workspace_audit_events_action_created_idx").on(
      table.action,
      table.createdAt
    ),
    index("workspace_audit_events_target_idx").on(
      table.targetType,
      table.targetId
    )
  ]
);
var dashboardImportPreflights = mysqlTable(
  "dashboard_import_preflights",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    actorUserId: int("actorUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceUserId: int("workspaceUserId").notNull().references(() => users.id, { onDelete: "cascade" }),
    module: varchar("module", { length: 64 }).notNull(),
    dashboardRevision: int("dashboardRevision", { unsigned: true }).notNull(),
    fileHash: varchar("fileHash", { length: 64 }).notNull(),
    sectionId: varchar("sectionId", { length: 80 }),
    targetBatchKey: varchar("targetBatchKey", { length: 191 }),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    index("dashboard_import_preflights_actor_expires_idx").on(
      table.actorUserId,
      table.expiresAt
    ),
    index("dashboard_import_preflights_workspace_expires_idx").on(
      table.workspaceUserId,
      table.expiresAt
    ),
    index("dashboard_import_preflights_consumed_expires_idx").on(
      table.consumedAt,
      table.expiresAt
    )
  ]
);
var userDashboardContents = mysqlTable(
  "user_dashboard_contents",
  {
    userId: int("userId").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    payload: json("payload").$type().notNull(),
    sourceName: varchar("sourceName", { length: 512 }),
    enterpriseIdentityBoundAt: timestamp("enterpriseIdentityBoundAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [index("user_dashboard_contents_updated_idx").on(table.updatedAt)]
);
var workspaceContentRevisions = mysqlTable(
  "workspace_content_revisions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    module: varchar("module", { length: 64 }).default("dashboard").notNull(),
    revision: int("revision", { unsigned: true }).notNull(),
    payload: json("payload").$type().notNull(),
    sourceName: varchar("sourceName", { length: 512 }),
    enterpriseIdentityBoundAt: timestamp("enterpriseIdentityBoundAt"),
    publicationKind: mysqlEnum("publicationKind", [
      "publish",
      "rollback",
      "migration"
    ]).default("publish").notNull(),
    rolledBackFromRevision: int("rolledBackFromRevision", { unsigned: true }),
    publishedByUserId: int("publishedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    reason: text("reason"),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("workspace_content_revisions_user_module_revision_uq").on(
      table.userId,
      table.module,
      table.revision
    ),
    index("workspace_content_revisions_user_module_created_idx").on(
      table.userId,
      table.module,
      table.createdAt
    ),
    index("workspace_content_revisions_publisher_idx").on(
      table.publishedByUserId
    )
  ]
);
var monitoringBatches = mysqlTable(
  "monitoring_batches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 }).references(
      () => serviceContracts.id,
      { onDelete: "cascade" }
    ),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 }).references(
      () => serviceQuotaPeriods.id,
      { onDelete: "cascade" }
    ),
    batchKey: varchar("batchKey", { length: 191 }).notNull(),
    sourceName: varchar("sourceName", { length: 512 }).notNull(),
    collectedAt: timestamp("collectedAt").notNull(),
    sampleCount: int("sampleCount", { unsigned: true }).default(0).notNull(),
    citationCount: int("citationCount", { unsigned: true }).default(0).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    importedByUserId: int("importedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("monitoring_batches_user_period_key_uq").on(
      table.userId,
      table.quotaPeriodId,
      table.batchKey
    ),
    index("monitoring_batches_contract_period_idx").on(
      table.contractId,
      table.quotaPeriodId
    ),
    index("monitoring_batches_user_collected_idx").on(
      table.userId,
      table.collectedAt
    )
  ]
);
var monitoringSamples = mysqlTable(
  "monitoring_samples",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    batchId: varchar("batchId", { length: 36 }).notNull().references(() => monitoringBatches.id, { onDelete: "cascade" }),
    sourceRecordId: varchar("sourceRecordId", { length: 191 }).notNull(),
    questionId: varchar("questionId", { length: 191 }).notNull(),
    question: text("question").notNull(),
    platform: varchar("platform", { length: 128 }).notNull(),
    answerNo: int("answerNo", { unsigned: true }).default(1).notNull(),
    content: longtext("content").notNull(),
    citationCount: int("citationCount", { unsigned: true }).default(0).notNull(),
    monitorRank: int("monitorRank", { unsigned: true }),
    screenshotUrl: text("screenshotUrl"),
    collectedAt: timestamp("collectedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("monitoring_samples_user_batch_source_uq").on(
      table.userId,
      table.batchId,
      table.sourceRecordId
    ),
    index("monitoring_samples_user_question_collected_idx").on(
      table.userId,
      table.questionId,
      table.collectedAt
    ),
    index("monitoring_samples_user_batch_idx").on(table.userId, table.batchId),
    index("monitoring_samples_user_platform_idx").on(
      table.userId,
      table.platform
    )
  ]
);
var monitoringCitationRecords = mysqlTable(
  "monitoring_citation_records",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    batchId: varchar("batchId", { length: 36 }).notNull().references(() => monitoringBatches.id, { onDelete: "cascade" }),
    sampleId: varchar("sampleId", { length: 36 }).references(
      () => monitoringSamples.id,
      { onDelete: "set null" }
    ),
    sourceRecordId: varchar("sourceRecordId", { length: 191 }).notNull(),
    questionId: varchar("questionId", { length: 191 }).notNull(),
    question: text("question").notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    media: varchar("media", { length: 255 }).notNull(),
    domain: varchar("domain", { length: 255 }).notNull(),
    publishedAt: timestamp("publishedAt"),
    collectedAt: timestamp("collectedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("monitoring_citations_user_batch_source_uq").on(
      table.userId,
      table.batchId,
      table.sourceRecordId
    ),
    index("monitoring_citations_user_question_collected_idx").on(
      table.userId,
      table.questionId,
      table.collectedAt
    ),
    index("monitoring_citations_user_batch_idx").on(
      table.userId,
      table.batchId
    ),
    index("monitoring_citations_user_model_idx").on(table.userId, table.model),
    index("monitoring_citations_user_media_idx").on(table.userId, table.media),
    index("monitoring_citations_user_domain_idx").on(
      table.userId,
      table.domain
    ),
    index("monitoring_citations_sample_idx").on(table.sampleId)
  ]
);
var knowledgeBaseSnapshots = mysqlTable(
  "knowledge_base_snapshots",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    sourceFileName: varchar("sourceFileName", { length: 512 }).notNull(),
    sourceConversationId: varchar("sourceConversationId", { length: 191 }),
    sourceBuildId: varchar("sourceBuildId", { length: 36 }),
    sourceBuildRevision: int("sourceBuildRevision"),
    sourceTaskId: varchar("sourceTaskId", { length: 255 }),
    sourceArtifactHash: varchar("sourceArtifactHash", { length: 64 }),
    archiveHash: varchar("archiveHash", { length: 64 }),
    maintenanceTicketId: varchar("maintenanceTicketId", { length: 36 }),
    documents: json("documents").$type().notNull(),
    assets: json("assets").$type().notNull(),
    documentCount: int("documentCount").default(0).notNull(),
    imageCount: int("imageCount").default(0).notNull(),
    characterCount: int("characterCount").default(0).notNull(),
    totalBytes: int("totalBytes", { unsigned: true }).default(0).notNull(),
    status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("knowledge_base_snapshots_user_version_uq").on(
      table.userId,
      table.version
    ),
    index("knowledge_base_snapshots_user_status_idx").on(
      table.userId,
      table.status
    ),
    uniqueIndex("knowledge_base_snapshots_source_artifact_uq").on(
      table.userId,
      table.sourceBuildId,
      table.sourceBuildRevision,
      table.sourceArtifactHash
    )
  ]
);
var knowledgeBaseBuilds = mysqlTable(
  "knowledge_base_builds",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: varchar("conversationId", { length: 191 }).notNull(),
    companyName: varchar("companyName", { length: 255 }).notNull(),
    companyWebsite: text("companyWebsite"),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    skillName: varchar("skillName", { length: 128 }).default("socratic-kb-builder").notNull(),
    skillVersion: varchar("skillVersion", { length: 64 }).default("1").notNull(),
    skillContentHash: varchar("skillContentHash", { length: 64 }),
    status: mysqlEnum("status", [
      "researching",
      "confirming",
      "ready_to_publish",
      "published",
      "protocol_error",
      "failed"
    ]).default("researching").notNull(),
    revision: int("revision").default(0).notNull(),
    currentLeafId: varchar("currentLeafId", { length: 191 }),
    totalNodeCount: int("totalNodeCount").default(0).notNull(),
    confirmedCount: int("confirmedCount").default(0).notNull(),
    directPrefilledCount: int("directPrefilledCount").default(0).notNull(),
    needsVerificationCount: int("needsVerificationCount").default(0).notNull(),
    lastReconciledHash: varchar("lastReconciledHash", { length: 64 }),
    lastOutputLength: int("lastOutputLength").default(0).notNull(),
    lastOutputItemIds: json("lastOutputItemIds").$type().default([]).notNull(),
    lastTurnUserText: longtext("lastTurnUserText"),
    lastTurnAttachmentCount: int("lastTurnAttachmentCount").default(0).notNull(),
    awaitingResponseSince: timestamp("awaitingResponseSince"),
    packageRevision: int("packageRevision"),
    packageTaskId: varchar("packageTaskId", { length: 255 }),
    packageOutputItemId: varchar("packageOutputItemId", { length: 255 }),
    packageFileId: varchar("packageFileId", { length: 255 }),
    packageFilename: varchar("packageFilename", { length: 512 }),
    packageDescriptorHash: varchar("packageDescriptorHash", { length: 64 }),
    protocolError: text("protocolError"),
    publishedSnapshotId: varchar("publishedSnapshotId", {
      length: 36
    }).references(() => knowledgeBaseSnapshots.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    completedAt: timestamp("completedAt"),
    publishedAt: timestamp("publishedAt")
  },
  (table) => [
    uniqueIndex("knowledge_base_builds_user_conversation_uq").on(
      table.userId,
      table.conversationId
    ),
    index("knowledge_base_builds_user_status_idx").on(
      table.userId,
      table.status
    ),
    index("knowledge_base_builds_task_idx").on(table.upstreamTaskId)
  ]
);
var knowledgeBaseBuildNodes = mysqlTable(
  "knowledge_base_build_nodes",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    buildId: varchar("buildId", { length: 36 }).notNull().references(() => knowledgeBaseBuilds.id, { onDelete: "cascade" }),
    leafId: varchar("leafId", { length: 191 }).notNull(),
    branchId: varchar("branchId", { length: 128 }).notNull(),
    branchTitle: varchar("branchTitle", { length: 255 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    ordinal: int("ordinal").notNull(),
    status: mysqlEnum("status", [
      "pending",
      "current",
      "confirmed",
      "direct_prefilled",
      "needs_verification"
    ]).default("pending").notNull(),
    transitionReason: text("transitionReason"),
    contentMarkdown: longtext("contentMarkdown"),
    lastUserInput: longtext("lastUserInput"),
    sourceUrls: json("sourceUrls").$type().default([]).notNull(),
    imageUrls: json("imageUrls").$type().default([]).notNull(),
    lastTaskId: varchar("lastTaskId", { length: 255 }),
    lastResponseAt: timestamp("lastResponseAt"),
    confirmedAt: timestamp("confirmedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("knowledge_base_build_nodes_leaf_uq").on(
      table.buildId,
      table.leafId
    ),
    uniqueIndex("knowledge_base_build_nodes_ordinal_uq").on(
      table.buildId,
      table.ordinal
    ),
    index("knowledge_base_build_nodes_status_idx").on(
      table.buildId,
      table.status
    )
  ]
);
var knowledgeBaseResetRequests = mysqlTable(
  "knowledge_base_reset_requests",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ticketId: varchar("ticketId", { length: 36 }).notNull().references(() => deliveryTickets.id, { onDelete: "restrict" }),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    assignedProjectAssignmentId: varchar("assignedProjectAssignmentId", {
      length: 36
    }),
    assignedMemberId: int("assignedMemberId").references(() => users.id, {
      onDelete: "set null"
    }),
    activeKey: varchar("activeKey", { length: 191 }),
    reasonCode: mysqlEnum("reasonCode", [
      "stuck",
      "upload_error",
      "build_error",
      "enterprise_materials",
      "other"
    ]).notNull(),
    reasonNote: text("reasonNote"),
    status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
    decisionNote: text("decisionNote"),
    decidedByUserId: int("decidedByUserId").references(() => users.id, {
      onDelete: "set null"
    }),
    cleanupSummary: json("cleanupSummary").$type(),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("knowledge_base_reset_requests_ticket_uq").on(table.ticketId),
    uniqueIndex("knowledge_base_reset_requests_active_key_uq").on(
      table.activeKey
    ),
    index("knowledge_base_reset_requests_user_status_idx").on(
      table.userId,
      table.status
    ),
    index("knowledge_base_reset_requests_member_status_idx").on(
      table.assignedMemberId,
      table.status
    ),
    foreignKey({
      name: "kb_reset_project_assignment_fk",
      columns: [table.assignedProjectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id]
    }).onDelete("set null")
  ]
);
var knowledgeBaseResetStates = mysqlTable(
  "knowledge_base_reset_states",
  {
    userId: int("userId").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    revision: int("revision", { unsigned: true }).default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  }
);
var knowledgeBaseConversationTombstones = mysqlTable(
  "knowledge_base_conversation_tombstones",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    publicConversationId: varchar("publicConversationId", {
      length: 191
    }).notNull(),
    resetRequestId: varchar("resetRequestId", { length: 36 }).notNull().references(() => knowledgeBaseResetRequests.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("kb_conversation_tombstones_user_conversation_uq").on(
      table.userId,
      table.publicConversationId
    )
  ]
);
var knowledgeBaseResetCleanupJobs = mysqlTable(
  "knowledge_base_reset_cleanup_jobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    resetRequestId: varchar("resetRequestId", { length: 36 }).notNull().references(() => knowledgeBaseResetRequests.id, {
      onDelete: "cascade"
    }),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" }
    ),
    kind: mysqlEnum("kind", ["task", "file", "local_asset"]).notNull(),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["pending", "completed", "failed"]).default("pending").notNull(),
    attemptCount: int("attemptCount", { unsigned: true }).default(0).notNull(),
    lastError: text("lastError"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("kb_reset_cleanup_request_resource_uq").on(
      table.resetRequestId,
      table.kind,
      table.upstreamId
    ),
    index("kb_reset_cleanup_status_attempt_idx").on(
      table.status,
      table.attemptCount
    )
  ]
);
var responseLogicEntries = mysqlTable(
  "response_logic_entries",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    questionId: varchar("questionId", { length: 191 }).notNull(),
    groupId: varchar("groupId", { length: 128 }).notNull(),
    groupTitle: varchar("groupTitle", { length: 255 }).notNull(),
    question: text("question").notNull(),
    intent: text("intent").notNull(),
    summary: text("summary").notNull(),
    conversationId: varchar("conversationId", { length: 191 }),
    lastTaskId: varchar("lastTaskId", { length: 255 }),
    skillName: varchar("skillName", { length: 128 }).default("response-logic-builder").notNull(),
    skillVersion: varchar("skillVersion", { length: 64 }).default("1").notNull(),
    skillContentHash: varchar("skillContentHash", { length: 64 }),
    draft: json("draft").$type().notNull(),
    confirmed: json("confirmed").$type(),
    version: int("version").default(0).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    status: mysqlEnum("status", ["draft", "confirmed"]).default("draft").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => [
    uniqueIndex("response_logic_entries_user_question_uq").on(
      table.userId,
      table.questionId
    ),
    index("response_logic_entries_user_status_idx").on(
      table.userId,
      table.status
    ),
    uniqueIndex("response_logic_entries_user_conversation_uq").on(
      table.userId,
      table.conversationId
    )
  ]
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
    projectAssignmentId: varchar("projectAssignmentId", { length: 36 }),
    title: varchar("title", { length: 255 }).notNull(),
    status: mysqlEnum("status", [
      "idle",
      "running",
      "pending",
      "awaiting_input",
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
    index("conversations_user_project_updated_idx").on(
      table.userId,
      table.projectAssignmentId,
      table.updatedAt
    ),
    index("conversations_upstream_task_idx").on(table.upstreamTaskId),
    foreignKey({
      name: "conversations_project_assignment_fk",
      columns: [table.projectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id]
    }).onDelete("cascade")
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
    projectAssignmentId: varchar("projectAssignmentId", { length: 36 }),
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
    ),
    index("upstream_resources_user_project_idx").on(
      table.userId,
      table.projectAssignmentId
    ),
    foreignKey({
      name: "upstream_resources_project_assignment_fk",
      columns: [table.projectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id]
    }).onDelete("cascade")
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
var MANAGED_ACCOUNT_SETUP_DURATION_MS = 48 * 60 * 60 * 1e3;
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
  return Buffer.from(
    `frontmind-api-credential:v1:${userId}:${credentialId}`,
    "utf8"
  );
}
function decryptCredentialSecret(aad, credential) {
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
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(credential.encryptionAuthTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.encryptedKey, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Credential cannot be decrypted"
    );
  }
}
function decryptApiKey(credential) {
  return decryptCredentialSecret(
    credentialAad(credential.userId, credential.id).toString("utf8"),
    credential
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
async function getEffectiveDecryptedCredentialForAccount(accountId) {
  const db = await requireDb();
  const accountRows = await db.select({ role: users.role }).from(users).where(eq2(users.id, accountId)).limit(1);
  const account = accountRows[0];
  if (!account) return null;
  const directCredential = await getDecryptedCredentialForUser(accountId);
  if (directCredential || account.role === "admin") return directCredential;
  const ownerRows = await db.select({ deliveryAdminId: userUsageOwners.deliveryAdminId }).from(userUsageOwners).where(eq2(userUsageOwners.userId, accountId)).limit(1);
  const ownerId = ownerRows[0]?.deliveryAdminId;
  return ownerId ? getDecryptedCredentialForUser(ownerId) : null;
}
async function credentialMayServeAccount(executor, accountId, credentialId) {
  const credentialRows = await executor.select({
    ownerUserId: apiCredentials.userId,
    status: apiCredentials.status
  }).from(apiCredentials).where(eq2(apiCredentials.id, credentialId)).limit(1);
  const credential = credentialRows[0];
  if (!credential || credential.status === "deleted") return false;
  if (credential.ownerUserId === accountId) return true;
  const ownerRows = await executor.select({ deliveryAdminId: userUsageOwners.deliveryAdminId }).from(userUsageOwners).where(eq2(userUsageOwners.userId, accountId)).limit(1);
  return ownerRows[0]?.deliveryAdminId === credential.ownerUserId;
}
async function getCredentialForUpstreamResource(userId, kind, upstreamId, projectAssignmentId) {
  const db = await requireDb();
  const rows = await db.select({ resource: upstreamResources, credential: apiCredentials }).from(upstreamResources).innerJoin(
    apiCredentials,
    eq2(upstreamResources.apiCredentialId, apiCredentials.id)
  ).where(
    and(
      projectAssignmentId ? eq2(upstreamResources.projectAssignmentId, projectAssignmentId) : and(
        eq2(upstreamResources.userId, userId),
        isNull(upstreamResources.projectAssignmentId)
      ),
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
async function getOwnedUpstreamResourceIds(userId, kind, upstreamIds, projectAssignmentId) {
  const uniqueIds = [...new Set(upstreamIds.filter(Boolean))];
  if (uniqueIds.length === 0) return /* @__PURE__ */ new Set();
  const db = await requireDb();
  const rows = await db.select({ upstreamId: upstreamResources.upstreamId }).from(upstreamResources).where(
    and(
      projectAssignmentId ? eq2(upstreamResources.projectAssignmentId, projectAssignmentId) : and(
        eq2(upstreamResources.userId, userId),
        isNull(upstreamResources.projectAssignmentId)
      ),
      eq2(upstreamResources.kind, kind),
      inArray(upstreamResources.upstreamId, uniqueIds)
    )
  );
  return new Set(rows.map((row) => row.upstreamId));
}
async function recordUpstreamResource(input) {
  const db = await requireDb();
  const projectAssignmentId = input.projectAssignmentId ?? null;
  const existing = await db.select().from(upstreamResources).where(
    and(
      eq2(upstreamResources.kind, input.kind),
      eq2(upstreamResources.upstreamId, input.upstreamId)
    )
  ).limit(1);
  if (existing[0]) {
    const ownedByRequestedScope = projectAssignmentId ? existing[0].projectAssignmentId === projectAssignmentId : existing[0].userId === input.userId && existing[0].projectAssignmentId == null;
    if (!ownedByRequestedScope) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource is already owned by another account or project"
      );
    }
    return existing[0];
  }
  if (projectAssignmentId) {
    const assignmentRows = await db.select({ id: deliveryProjectAssignments.id }).from(deliveryProjectAssignments).where(
      and(
        eq2(deliveryProjectAssignments.id, projectAssignmentId),
        eq2(deliveryProjectAssignments.engineerUserId, input.userId)
      )
    ).limit(1);
    if (!assignmentRows[0]) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "Customer project assignment not found"
      );
    }
  }
  const credentialMayServeCurrentEngineer = await credentialMayServeAccount(
    db,
    input.userId,
    input.apiCredentialId
  );
  const credentialAlreadyBoundToProject = projectAssignmentId && !credentialMayServeCurrentEngineer ? await db.select({ id: upstreamResources.id }).from(upstreamResources).innerJoin(
    apiCredentials,
    eq2(upstreamResources.apiCredentialId, apiCredentials.id)
  ).where(
    and(
      eq2(upstreamResources.projectAssignmentId, projectAssignmentId),
      eq2(upstreamResources.apiCredentialId, input.apiCredentialId),
      ne(apiCredentials.status, "deleted")
    )
  ).limit(1) : [];
  if (!credentialMayServeCurrentEngineer && !credentialAlreadyBoundToProject[0]) {
    throw new AuthServiceError("NOT_FOUND", "API credential not found");
  }
  if (input.conversationId) {
    const conversation = await db.select({ id: conversations.id }).from(conversations).where(
      and(
        eq2(conversations.id, input.conversationId),
        projectAssignmentId ? eq2(conversations.projectAssignmentId, projectAssignmentId) : and(
          eq2(conversations.userId, input.userId),
          isNull(conversations.projectAssignmentId)
        )
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
    projectAssignmentId,
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
        projectAssignmentId ? eq2(upstreamResources.projectAssignmentId, projectAssignmentId) : and(
          eq2(upstreamResources.userId, input.userId),
          isNull(upstreamResources.projectAssignmentId)
        )
      )
    ).limit(1);
    if (raced[0]) return raced[0];
    throw new AuthServiceError(
      "CONFLICT",
      "Upstream resource is already owned by another account or project"
    );
  }
}

// server/dashboard-service.ts
import { and as and5, desc as desc5, eq as eq6, inArray as inArray4, lt as lt2 } from "drizzle-orm";

// shared/dashboard.ts
import { z as z3 } from "zod";

// shared/service-portal.ts
import { z } from "zod";
var servicePlanCodeSchema = z.enum(["basic", "advanced", "luxury"]);
var workspaceQuestionCategorySchema = z.enum([
  "industry",
  "competitor_comparison",
  "reputation",
  "product_scenario"
]);
var serviceContractSourceSchema = z.enum([
  "website",
  "offline",
  "admin"
]);
var serviceCapabilityKeySchema = z.enum([
  "knowledgeBuild",
  "knowledgeDisplay",
  "globalKeywords",
  "questionSelection",
  "intentOptimization",
  "responseLogic",
  "monitoring",
  "channelDistribution",
  "progressReport",
  "contentAssets"
]);
var serviceQuotaLimitsSchema = z.object({
  industryLimit: z.number().int().nonnegative(),
  competitorComparisonLimit: z.number().int().nonnegative(),
  reputationLimit: z.number().int().nonnegative(),
  productScenarioLimit: z.number().int().nonnegative(),
  totalQuestionLimit: z.number().int().nonnegative()
});
var serviceQuotaUsageSchema = z.object({
  industry: z.number().int().nonnegative(),
  competitorComparison: z.number().int().nonnegative(),
  reputation: z.number().int().nonnegative(),
  productScenario: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
});
var EMPTY_SERVICE_QUOTA_USAGE = Object.freeze({
  industry: 0,
  competitorComparison: 0,
  reputation: 0,
  productScenario: 0,
  total: 0
});
var FULL_SERVICE_CAPABILITIES = Object.freeze({
  knowledgeBuild: true,
  knowledgeDisplay: true,
  globalKeywords: true,
  questionSelection: true,
  intentOptimization: true,
  responseLogic: true,
  monitoring: true,
  channelDistribution: true,
  progressReport: true,
  contentAssets: true
});
var SERVICE_PLAN_CATALOG = Object.freeze({
  basic: {
    code: "basic",
    name: "\u666E\u901A\u7248",
    description: "30 \u5929\u5185\u4EA4\u4ED8\u4E00\u4E2A\u5DF2\u8D2D\u4E70\u7684\u975E\u884C\u4E1A\u95EE\u9898\u53CA\u77E5\u8BC6\u5E93\u5C55\u793A\u3002",
    planVersion: 1,
    contractTerm: { unit: "day", count: 30 },
    quotaCadence: "contract",
    prepaidMonths: null,
    billingLabel: "30 \u5929\u5355\u9898\u670D\u52A1",
    // Each permitted non-industry category has a ceiling of one, while the
    // shared total ceiling guarantees that Basic can select only one of them.
    limits: {
      industryLimit: 0,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 1,
      totalQuestionLimit: 1
    },
    includedCapabilities: {
      knowledgeBuild: false,
      knowledgeDisplay: true,
      globalKeywords: false,
      questionSelection: false,
      intentOptimization: true,
      responseLogic: true,
      monitoring: true,
      channelDistribution: true,
      progressReport: true,
      contentAssets: true
    }
  },
  advanced: {
    code: "advanced",
    name: "\u8FDB\u9636\u7248",
    description: "\u6309\u5B63\u5EA6\u4EA4\u4ED8\u884C\u4E1A\u3001\u7ADE\u54C1\u3001\u7F8E\u8A89\u4E0E\u4EA7\u54C1\u573A\u666F\u95EE\u9898\u3002",
    planVersion: 1,
    contractTerm: { unit: "month", count: 3 },
    quotaCadence: "quarter",
    prepaidMonths: 3,
    billingLabel: "\u5B63\u5EA6\u670D\u52A1",
    limits: {
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8
    },
    includedCapabilities: { ...FULL_SERVICE_CAPABILITIES }
  },
  luxury: {
    code: "luxury",
    name: "\u8C6A\u534E\u7248",
    description: "\u63D0\u4F9B\u8C6A\u534E\u7248\u5B8C\u6574\u670D\u52A1\u3002",
    planVersion: 1,
    contractTerm: { unit: "month", count: 3 },
    quotaCadence: "month",
    prepaidMonths: 3,
    billingLabel: "\u5B63\u5EA6\u670D\u52A1",
    limits: {
      industryLimit: 4,
      competitorComparisonLimit: 4,
      reputationLimit: 4,
      productScenarioLimit: 20,
      totalQuestionLimit: 32
    },
    includedCapabilities: { ...FULL_SERVICE_CAPABILITIES }
  }
});
var effectiveServiceStatusSchema = z.enum([
  "unconfigured",
  "pending_confirmation",
  "scheduled",
  "active",
  "suspended",
  "expired",
  "cancelled"
]);
var serviceCapabilityAccessSchema = z.object({
  allowed: z.boolean(),
  effectiveStatus: z.enum([
    "available",
    "not_in_plan",
    "service_unconfigured",
    "service_pending_confirmation",
    "service_scheduled",
    "service_suspended",
    "service_expired",
    "service_cancelled"
  ]),
  reason: z.string().nullable()
});
var serviceCapabilitiesSchema = z.object({
  knowledgeBuild: serviceCapabilityAccessSchema,
  knowledgeDisplay: serviceCapabilityAccessSchema,
  globalKeywords: serviceCapabilityAccessSchema,
  questionSelection: serviceCapabilityAccessSchema,
  intentOptimization: serviceCapabilityAccessSchema,
  responseLogic: serviceCapabilityAccessSchema,
  monitoring: serviceCapabilityAccessSchema,
  channelDistribution: serviceCapabilityAccessSchema,
  progressReport: serviceCapabilityAccessSchema,
  contentAssets: serviceCapabilityAccessSchema
});
var serviceNextActionKindSchema = z.enum([
  "await_service_configuration",
  "await_service_confirmation",
  "await_service_start",
  "contact_service_support",
  "renew_service",
  "await_knowledge_import",
  "view_knowledge",
  "resume_knowledge_build",
  "start_knowledge_build",
  "await_question_import",
  "generate_question_candidates",
  "select_service_questions",
  "await_question_confirmation",
  "optimize_service_questions",
  "build_response_logic",
  "await_monitoring_data",
  "await_channel_distribution",
  "await_progress_report",
  "view_progress_report"
]);
var serviceNextActionSchema = z.object({
  kind: serviceNextActionKindSchema,
  label: z.string().min(1),
  href: z.string().nullable()
});
var serviceWorkflowStepSchema = z.object({
  id: z.enum([
    "knowledge",
    "question",
    "intent_optimization",
    "response_logic",
    "monitoring",
    "channel_distribution",
    "progress_report"
  ]),
  label: z.string().min(1),
  status: z.enum(["complete", "ready", "locked"]),
  lockedReason: z.string().nullable(),
  href: z.string().nullable(),
  nextAction: serviceNextActionSchema.nullable().default(null)
});
var servicePortalQuestionSchema = z.object({
  id: z.string(),
  contractId: z.string().nullable(),
  quotaPeriodId: z.string(),
  externalQuestionId: z.string().nullable(),
  sourceQuestionId: z.string().nullable(),
  category: workspaceQuestionCategorySchema,
  question: z.string(),
  intent: z.string().nullable(),
  intentRevision: z.number().int().positive(),
  intentConfirmedRevision: z.number().int().positive().nullable(),
  intentConfirmedAt: z.number().int().nonnegative().nullable(),
  intentConfirmed: z.boolean(),
  rationale: z.string().nullable(),
  evidence: z.array(
    z.object({
      documentPath: z.string(),
      excerpt: z.string(),
      relevance: z.string()
    })
  ),
  risks: z.array(z.string()),
  source: z.enum(["model", "website", "offline", "admin", "user"]),
  status: z.enum(["candidate", "selected", "archived"]),
  selectionApprovalStatus: z.enum(["not_requested", "pending", "approved"]),
  selectionRequestedAt: z.number().int().nonnegative().nullable(),
  selectionApprovedAt: z.number().int().nonnegative().nullable(),
  locked: z.boolean(),
  revision: z.number().int().positive()
});
var servicePortalQuotaPeriodSchema = z.object({
  periodId: z.string(),
  contractId: z.string(),
  validFrom: z.number().int(),
  validUntil: z.number().int(),
  revision: z.number().int().positive(),
  limits: serviceQuotaLimitsSchema,
  usage: serviceQuotaUsageSchema,
  remaining: serviceQuotaUsageSchema
});
var servicePortalSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  entitlementRollout: z.object({
    mode: z.enum(["compatibility", "enforced"]),
    pendingUserCount: z.number().int().nonnegative()
  }),
  account: z.object({
    userId: z.number().int().positive(),
    username: z.string().nullable(),
    displayName: z.string().nullable()
  }).nullable(),
  service: z.object({
    contractId: z.string().nullable(),
    planCode: servicePlanCodeSchema.nullable(),
    planName: z.string(),
    status: effectiveServiceStatusSchema,
    validFrom: z.number().int().nullable(),
    validUntil: z.number().int().nullable(),
    billingLabel: z.string(),
    source: serviceContractSourceSchema.nullable()
  }),
  quotas: servicePortalQuotaPeriodSchema.nullable(),
  quotaPeriods: z.array(servicePortalQuotaPeriodSchema),
  purchases: z.array(
    z.object({
      id: z.string(),
      planCode: servicePlanCodeSchema,
      planName: z.string(),
      purchasedAt: z.number().int(),
      validFrom: z.number().int(),
      validUntil: z.number().int(),
      status: z.enum([
        "pending_confirmation",
        "scheduled",
        "active",
        "suspended",
        "expired",
        "cancelled",
        "superseded"
      ]),
      amountFen: z.number().int().nonnegative().nullable(),
      currency: z.string().length(3),
      prepaidMonths: z.number().int().positive().nullable(),
      orderReference: z.string().nullable(),
      contractReference: z.string().nullable(),
      signedAt: z.number().int().nullable(),
      signatoryId: z.string().nullable(),
      hasSigningEvidence: z.boolean(),
      revision: z.number().int().positive()
    })
  ),
  knowledge: z.object({
    version: z.number().int().positive().nullable(),
    authenticatedVersion: z.number().int().positive().nullable(),
    authenticatedForCurrentService: z.boolean(),
    status: z.enum(["display_ready", "importing", "missing", "failed"]),
    latestImportStatus: z.enum(["pending", "processing", "completed", "failed"]).nullable()
  }),
  purchasedQuestions: z.array(servicePortalQuestionSchema),
  historicalQuestions: z.array(servicePortalQuestionSchema),
  capabilities: serviceCapabilitiesSchema,
  workflowSteps: z.array(serviceWorkflowStepSchema),
  nextAction: serviceNextActionSchema
});
var publicServicePortalQuestionSchema = servicePortalQuestionSchema.omit({
  contractId: true,
  quotaPeriodId: true
});
var publicServicePortalQuotaPeriodSchema = servicePortalQuotaPeriodSchema.omit({
  contractId: true
});
var publicServicePortalSchema = servicePortalSchema.omit({
  entitlementRollout: true,
  quotaPeriods: true,
  purchases: true
}).extend({
  service: servicePortalSchema.shape.service.omit({
    contractId: true,
    source: true
  }),
  quotas: publicServicePortalQuotaPeriodSchema.nullable(),
  purchasedQuestions: z.array(publicServicePortalQuestionSchema),
  historicalQuestions: z.array(publicServicePortalQuestionSchema)
});

// shared/monitoring.ts
import { z as z2 } from "zod";
var identifierSchema = z2.string().trim().min(1).max(191);
var boundedDateSchema = z2.string().trim().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value)), "\u65E5\u671F\u683C\u5F0F\u65E0\u6548");
var monitoringSampleImportSchema = z2.object({
  sourceRecordId: identifierSchema,
  questionId: identifierSchema,
  platform: z2.string().trim().min(1).max(128),
  answerNo: z2.number().int().positive().max(1e4).default(1),
  content: z2.string().trim().max(2e5).default(""),
  citationCount: z2.number().int().nonnegative().max(1e5).optional(),
  monitorRank: z2.number().int().positive().max(1e5).optional(),
  screenshotUrl: z2.string().trim().max(2048).default(""),
  collectedAt: boundedDateSchema.optional()
}).strict();
var monitoringCitationImportSchema = z2.object({
  sourceRecordId: identifierSchema,
  questionId: identifierSchema,
  sampleSourceRecordId: identifierSchema.optional(),
  model: z2.string().trim().min(1).max(128),
  title: z2.string().trim().max(1e3).default(""),
  url: z2.string().trim().max(2048).default(""),
  media: z2.string().trim().max(255).default(""),
  domain: z2.string().trim().max(255).default(""),
  publishedAt: boundedDateSchema.optional(),
  collectedAt: boundedDateSchema.optional()
}).strict();
var replaceMonitoringBatchSchema = z2.object({
  userId: z2.number().int().positive(),
  batchKey: identifierSchema,
  sourceName: z2.string().trim().min(1).max(512),
  collectedAt: boundedDateSchema,
  samples: z2.array(monitoringSampleImportSchema).max(1e5).default([]),
  citations: z2.array(monitoringCitationImportSchema).max(1e5).default([])
}).strict().refine(
  (value) => value.samples.length > 0 || value.citations.length > 0,
  "\u76D1\u63A7\u6837\u672C\u548C\u5F15\u7528\u8BB0\u5F55\u4E0D\u80FD\u540C\u65F6\u4E3A\u7A7A"
);
var listBaseSchema = z2.object({
  questionId: identifierSchema.optional(),
  batchKey: identifierSchema.optional(),
  from: boundedDateSchema.optional(),
  to: boundedDateSchema.optional(),
  query: z2.string().trim().max(500).default(""),
  page: z2.number().int().positive().max(1e6).default(1),
  pageSize: z2.number().int().positive().max(100).default(25)
}).strict();
var listMonitoringSamplesSchema = listBaseSchema.extend({
  /** @deprecated Use model. Kept for existing clients and imported data. */
  platform: z2.string().trim().min(1).max(128).optional(),
  model: z2.string().trim().min(1).max(128).optional(),
  sortOrder: z2.enum(["asc", "desc"]).default("desc")
});
var listMonitoringCitationsSchema = listBaseSchema.extend({
  sampleId: identifierSchema.optional(),
  model: z2.string().trim().min(1).max(128).optional(),
  media: z2.string().trim().min(1).max(255).optional(),
  domain: z2.string().trim().min(1).max(255).optional(),
  sortBy: z2.enum(["collectedAt", "publishedAt", "question", "model", "title", "media"]).default("collectedAt"),
  sortOrder: z2.enum(["asc", "desc"]).default("desc")
});
var monitoringCitationSummarySchema = z2.object({
  batchKey: identifierSchema.optional(),
  questionId: identifierSchema,
  model: z2.string().trim().min(1).max(128).optional(),
  from: boundedDateSchema.optional(),
  to: boundedDateSchema.optional()
}).strict().refine(
  (value) => !value.from || !value.to || new Date(value.from).getTime() <= new Date(value.to).getTime(),
  {
    message: "\u76D1\u63A7\u65E5\u671F\u533A\u95F4\u65E0\u6548",
    path: ["to"]
  }
);
var monitoringFilterOptionsSchema = z2.object({
  batchKey: identifierSchema.optional(),
  questionId: identifierSchema.optional()
}).strict();
var listMonitoringSampleCitationsSchema = z2.object({
  batchKey: identifierSchema,
  questionId: identifierSchema,
  /** Server-generated monitoring_samples.id. Source record IDs are rejected. */
  sampleId: z2.string().uuid(),
  cursor: z2.string().uuid().optional(),
  limit: z2.number().int().positive().max(100).default(50)
}).strict();

// shared/dashboard.ts
var dashboardMetricSchema = z3.object({
  label: z3.string().trim().min(1).max(80),
  value: z3.union([z3.string(), z3.number()]),
  unit: z3.string().trim().max(24).optional(),
  note: z3.string().trim().max(160).optional()
});
var dashboardItemSchema = z3.object({
  title: z3.string().trim().min(1).max(160),
  description: z3.string().trim().max(4e3).optional(),
  meta: z3.string().trim().max(160).optional(),
  imageUrl: z3.string().trim().max(2048).optional()
});
var dashboardTableSchema = z3.object({
  id: z3.string().trim().min(1).max(80),
  title: z3.string().trim().min(1).max(160),
  description: z3.string().trim().max(1e3).optional(),
  columns: z3.array(z3.string().trim().min(1).max(160)).min(1).max(50),
  rows: z3.array(z3.array(z3.string().trim().max(8e3)).max(50)).max(1e4).default([])
});
var dashboardSectionSchema = z3.object({
  id: z3.string().trim().min(1).max(80),
  title: z3.string().trim().min(1).max(160),
  subtitle: z3.string().trim().max(300).optional(),
  body: z3.string().trim().max(2e4).optional(),
  items: z3.array(dashboardItemSchema).max(100).default([]),
  tables: z3.array(dashboardTableSchema).max(20).default([])
});
var dashboardQuestionSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  groupId: z3.string().trim().min(1).max(128),
  groupTitle: z3.string().trim().min(1).max(255),
  groupSubtitle: z3.string().trim().max(300).default(""),
  tone: z3.enum(["plum", "teal", "amber", "blue"]).default("plum"),
  question: z3.string().trim().min(1).max(2e3),
  intent: z3.string().trim().max(8e3).default(""),
  summary: z3.string().trim().max(8e3).default("")
});
var dashboardMonitoringCitationSchema = z3.object({
  id: z3.string().trim().min(1).max(191).optional(),
  title: z3.string().trim().max(1e3).default(""),
  url: z3.string().trim().max(2048).default(""),
  media: z3.string().trim().max(255).default(""),
  publishedAt: z3.string().trim().max(64).optional()
});
var dashboardMonitoringAnswerSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  questionId: z3.string().trim().min(1).max(191),
  platform: z3.string().trim().min(1).max(128),
  collectedAt: z3.string().trim().max(64).default(""),
  answerNo: z3.number().int().positive().max(1e4).default(1),
  content: z3.string().trim().max(2e5).default(""),
  citationCount: z3.number().int().nonnegative().max(1e5).optional(),
  monitorRank: z3.number().positive().max(1e5).optional(),
  screenshotUrl: z3.string().trim().max(2048).default(""),
  citations: z3.array(dashboardMonitoringCitationSchema).max(200).default([])
});
var dashboardCitationRecordSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  questionId: z3.string().trim().max(191).default(""),
  model: z3.string().trim().max(128).default(""),
  question: z3.string().trim().max(2e3).default(""),
  title: z3.string().trim().max(1e3).default(""),
  url: z3.string().trim().max(2048).default(""),
  media: z3.string().trim().max(255).default(""),
  domain: z3.string().trim().max(255).default(""),
  date: z3.string().trim().max(64).default("")
});
var dashboardContentMediaSchema = z3.object({
  url: z3.string().trim().min(1).max(2048),
  alt: z3.string().trim().max(500).default(""),
  caption: z3.string().trim().max(1e3).default(""),
  source: z3.string().trim().max(2048).default("")
});
var dashboardContentArticleSectionSchema = z3.union([
  z3.tuple([z3.string().trim().max(500), z3.string().trim().max(3e4)]),
  z3.object({
    heading: z3.string().trim().max(500).default(""),
    body: z3.string().trim().max(3e4).default(""),
    media: z3.array(dashboardContentMediaSchema).max(50).default([])
  })
]);
var dashboardContentArticleSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  title: z3.string().trim().min(1).max(500),
  intro: z3.string().trim().max(8e3).default(""),
  sections: z3.array(dashboardContentArticleSectionSchema).max(100).default([])
});
var dashboardContentAssetSchema = z3.object({
  id: z3.string().trim().min(1).max(80),
  group: z3.string().trim().max(255).default("\u5185\u5BB9\u8D44\u4EA7"),
  name: z3.string().trim().min(1).max(255),
  description: z3.string().trim().max(2e3).default(""),
  wordRange: z3.string().trim().max(128).default(""),
  imageCount: z3.number().int().nonnegative().max(1e5).optional(),
  scene: z3.string().trim().max(1e3).default(""),
  impact: z3.number().min(0).max(100).optional(),
  articles: z3.array(dashboardContentArticleSchema).max(500).default([])
});
var optimizationKpiSchema = z3.tuple([
  z3.string(),
  z3.string(),
  z3.string(),
  z3.number(),
  z3.string()
]);
var optimizationPlatformSchema = z3.tuple([
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string()
]);
var optimizationJourneySchema = z3.tuple([
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string()
]);
var optimizationFourColumnSchema = z3.tuple([
  z3.string(),
  z3.string(),
  z3.string(),
  z3.string()
]);
var optimizationRoadmapSchema = z3.tuple([z3.string(), z3.string(), z3.string()]);
var dashboardOptimizationBaselineSchema = z3.object({
  id: z3.string().trim().max(191).default(""),
  questionId: z3.string().trim().max(191).default(""),
  question: z3.string().trim().max(2e3).default(""),
  category: z3.string().trim().max(120).default(""),
  generatedAt: z3.string().trim().max(120).default(""),
  period: z3.string().trim().max(500).default(""),
  title: z3.string().trim().min(1).max(500),
  subtitle: z3.string().trim().max(8e3).default(""),
  scopeLabel: z3.string().trim().max(1e3).default(""),
  sample: z3.object({
    platforms: z3.array(z3.string().trim().min(1).max(120)).max(20).default([]),
    expectedResponses: z3.number().int().nonnegative().max(1e5),
    successfulResponses: z3.number().int().nonnegative().max(1e5),
    failedResponses: z3.number().int().nonnegative().max(1e5)
  }).optional(),
  totalScore: z3.number().min(0).max(100).nullable().default(null),
  rawTotalScore: z3.number().min(0).max(100).nullable().optional(),
  applicableScore: z3.number().min(0).max(100).nullable().optional(),
  applicableMaxScore: z3.number().positive().max(100).nullable().optional(),
  structuralExcludedMaxScore: z3.number().nonnegative().max(100).nullable().optional(),
  coverage: z3.number().min(0).max(100).nullable().optional(),
  confidence: z3.enum(["high", "medium", "low"]).nullable().optional(),
  grade: z3.string().trim().max(20).default(""),
  summary: z3.string().trim().max(2e4).default(""),
  dimensions: z3.array(
    z3.object({
      id: z3.string().trim().min(1).max(80),
      label: z3.string().trim().min(1).max(255),
      score: z3.number().min(0).max(100),
      maxScore: z3.number().positive().max(100),
      summary: z3.string().trim().max(4e3).default("")
    })
  ).max(20).default([]),
  platforms: z3.array(
    z3.object({
      platform: z3.string().trim().min(1).max(120),
      responseCount: z3.number().int().nonnegative().max(1e5),
      mentionRate: z3.string().trim().max(80).nullable().default(null),
      averageRank: z3.string().trim().max(80).nullable().default(null),
      factAccuracy: z3.string().trim().max(80).nullable().default(null),
      propositionHitRate: z3.string().trim().max(80).nullable().default(null),
      citationCount: z3.number().int().nonnegative().max(1e5),
      referenceCount: z3.number().int().nonnegative().max(1e5).default(0),
      verdict: z3.string().trim().max(8e3).default(""),
      evidenceRefs: z3.array(z3.string().trim().min(1).max(4e3)).max(100).default([])
    })
  ).max(100).default([]),
  findings: z3.array(
    z3.object({
      topic: z3.string().trim().min(1).max(500),
      status: z3.enum(["aligned", "missing", "conflict", "opportunity"]),
      currentEvidence: z3.string().trim().max(8e3).default(""),
      gap: z3.string().trim().max(8e3).default(""),
      action: z3.string().trim().max(8e3).default(""),
      evidenceRefs: z3.array(z3.string().trim().min(1).max(4e3)).max(100).default([])
    })
  ).max(500).default([]),
  priorityActions: z3.array(
    z3.object({
      priority: z3.number().int().positive().max(100),
      dimension: z3.string().trim().max(255).default(""),
      action: z3.string().trim().min(1).max(8e3),
      expectedImpact: z3.string().trim().max(4e3).default(""),
      evidenceRefs: z3.array(z3.string().trim().min(1).max(4e3)).max(100).default([])
    })
  ).max(100).default([]),
  limitations: z3.array(z3.string().trim().max(4e3)).max(100).default([])
});
var dashboardOptimizationAnswerScreenshotSchema = z3.object({
  id: z3.string().trim().max(191).default(""),
  url: z3.string().trim().min(1).max(4e3).regex(
    /^\/api\/dashboard\/report-assets\/[1-9]\d*\/[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/i,
    "\u7B54\u6848\u622A\u56FE\u5FC5\u987B\u5148\u901A\u8FC7\u7BA1\u7406\u5458\u53D7\u4FDD\u62A4\u4E0A\u4F20\u5165\u53E3\u4E0A\u4F20"
  ),
  alt: z3.string().trim().max(500).default("")
});
var dashboardOptimizationQuestionSampleSchema = z3.object({
  platform: z3.string().trim().max(120).default(""),
  capturedAt: z3.string().trim().max(120).default(""),
  content: z3.string().trim().max(1e5).default(""),
  screenshots: z3.array(dashboardOptimizationAnswerScreenshotSchema).max(20).default([])
});
var dashboardOptimizationAfterEffectSchema = z3.object({
  released: z3.boolean().default(false),
  totalScore: z3.number().min(0).max(100).nullable().default(null),
  grade: z3.string().trim().max(20).default(""),
  summary: z3.string().trim().max(2e4).default(""),
  dimensions: z3.array(
    z3.object({
      id: z3.string().trim().min(1).max(80),
      label: z3.string().trim().min(1).max(255),
      score: z3.number().min(0).max(100),
      maxScore: z3.number().positive().max(100),
      summary: z3.string().trim().max(4e3).default("")
    })
  ).max(20).default([]),
  platforms: z3.array(
    z3.object({
      platform: z3.string().trim().min(1).max(120),
      responseCount: z3.number().int().nonnegative().max(1e5),
      mentionRate: z3.string().trim().max(80).nullable().default(null),
      averageRank: z3.string().trim().max(80).nullable().default(null),
      factAccuracy: z3.string().trim().max(80).nullable().default(null),
      propositionHitRate: z3.string().trim().max(80).nullable().default(null),
      citationCount: z3.number().int().nonnegative().max(1e5),
      referenceCount: z3.number().int().nonnegative().max(1e5).default(0),
      verdict: z3.string().trim().max(8e3).default("")
    })
  ).max(100).default([]),
  gapFillSummary: z3.string().trim().max(2e4).default(""),
  gapClosures: z3.array(
    z3.object({
      topic: z3.string().trim().min(1).max(500),
      beforeGap: z3.string().trim().max(8e3).default(""),
      result: z3.string().trim().max(8e3).default(""),
      status: z3.enum(["filled", "partial", "open"])
    })
  ).max(500).default([])
}).superRefine((effect, context) => {
  if (!effect.released) return;
  if (effect.totalScore === null) {
    context.addIssue({
      code: "custom",
      path: ["totalScore"],
      message: "\u5F00\u653E\u4F18\u5316\u540E\u6548\u679C\u524D\u5FC5\u987B\u586B\u5199\u4F18\u5316\u540E\u8BED\u4E49\u8D44\u4EA7\u8BC4\u5206"
    });
  }
  if (effect.platforms.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["platforms"],
      message: "\u5F00\u653E\u4F18\u5316\u540E\u6548\u679C\u524D\u5FC5\u987B\u586B\u5199\u81F3\u5C11\u4E00\u4E2A\u5E73\u53F0\u7684\u771F\u5B9E\u590D\u6D4B\u7ED3\u679C"
    });
  }
  if (!effect.gapFillSummary && effect.gapClosures.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["gapFillSummary"],
      message: "\u5F00\u653E\u4F18\u5316\u540E\u6548\u679C\u524D\u5FC5\u987B\u586B\u5199\u77E5\u8BC6\u4E8B\u5B9E\u4E0E\u6A21\u578B\u56DE\u7B54\u5DEE\u8DDD\u7684\u586B\u8865\u7ED3\u679C"
    });
  }
});
var dashboardOptimizationQuestionReportSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  category: z3.string().trim().max(120).default(""),
  question: z3.string().trim().min(1).max(2e3),
  summary: z3.string().trim().max(8e3).default(""),
  metrics: z3.array(
    z3.object({
      label: z3.string().trim().min(1).max(255),
      before: z3.string().trim().max(120).default(""),
      after: z3.string().trim().max(120).default(""),
      change: z3.string().trim().max(120).default(""),
      note: z3.string().trim().max(1e3).default("")
    })
  ).max(50).default([]),
  before: dashboardOptimizationQuestionSampleSchema.default({
    platform: "",
    capturedAt: "",
    content: "",
    screenshots: []
  }),
  expectedLogic: z3.string().trim().max(2e4).default(""),
  gaps: z3.array(z3.string().trim().max(8e3)).max(100).default([]),
  after: dashboardOptimizationQuestionSampleSchema.default({
    platform: "",
    capturedAt: "",
    content: "",
    screenshots: []
  }),
  improvements: z3.array(z3.string().trim().max(8e3)).max(100).default([]),
  analysis: z3.string().trim().max(2e4).default(""),
  evidence: z3.array(
    z3.object({
      label: z3.string().trim().min(1).max(500),
      source: z3.string().trim().max(1e3).default(""),
      url: z3.string().trim().max(4e3).default(""),
      capturedAt: z3.string().trim().max(120).default(""),
      isOfficial: z3.boolean().default(false)
    })
  ).max(100).default([]),
  afterEffect: dashboardOptimizationAfterEffectSchema.optional()
});
var dashboardOptimizationReportSchema = z3.object({
  period: z3.string().trim().max(500).default(""),
  title: z3.string().trim().min(1).max(500),
  subtitle: z3.string().trim().max(8e3).default(""),
  executiveSummary: z3.array(z3.string().trim().max(2e4)).max(50).default([]),
  kpis: z3.array(optimizationKpiSchema).max(100).default([]),
  platforms: z3.array(optimizationPlatformSchema).max(100).default([]),
  journeys: z3.array(optimizationJourneySchema).max(100).default([]),
  competitorTiers: z3.array(optimizationFourColumnSchema).max(100).default([]),
  sourceMix: z3.array(optimizationFourColumnSchema).max(100).default([]),
  risks: z3.array(optimizationFourColumnSchema).max(100).default([]),
  roadmap: z3.array(optimizationRoadmapSchema).max(100).default([]),
  reportRecords: z3.array(optimizationFourColumnSchema).max(500).default([]),
  baseline: dashboardOptimizationBaselineSchema.nullable().optional(),
  questionBaselines: z3.array(dashboardOptimizationBaselineSchema).max(500).optional(),
  questionReports: z3.array(dashboardOptimizationQuestionReportSchema).max(500).optional()
}).superRefine((report, context) => {
  const ensureUnique = (values, path3) => {
    const seen = /* @__PURE__ */ new Set();
    values.forEach((value, index2) => {
      if (!value || !seen.has(value)) {
        if (value) seen.add(value);
        return;
      }
      context.addIssue({
        code: "custom",
        path: [
          path3,
          index2,
          path3 === "questionBaselines" ? "questionId" : "id"
        ],
        message: "\u540C\u4E00\u95EE\u9898\u53EA\u80FD\u53D1\u5E03\u4E00\u4EFD\u62A5\u544A"
      });
    });
  };
  ensureUnique(
    (report.questionBaselines ?? []).map(
      (baseline) => baseline.questionId || baseline.id
    ),
    "questionBaselines"
  );
  ensureUnique(
    (report.questionReports ?? []).map((question) => question.id),
    "questionReports"
  );
});
var dashboardTemplateModuleSchema = z3.enum([
  "profile",
  "metrics",
  "sections",
  "keywords",
  "questions",
  "monitoring",
  "response-logic",
  "content-assets",
  "optimization-report"
]);
var dashboardAdminImportModuleSchema = z3.enum([
  "profile",
  "metrics",
  "sections",
  "section-table",
  "keywords",
  "questions",
  "monitoring",
  "response-logic",
  "content-assets",
  "optimization-report"
]);
var dashboardModuleTemplateMetadataSchema = z3.object({
  format: z3.literal("frontmind.dashboard-module-template.v1"),
  module: dashboardTemplateModuleSchema,
  templateRevision: z3.number().int().nonnegative(),
  exportedAt: z3.string().trim().min(1).max(120)
});
var dashboardQuestionTemplateRecordSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  revision: z3.number().int().positive(),
  category: workspaceQuestionCategorySchema,
  question: z3.string().trim().min(1).max(4e3),
  intent: z3.string().trim().max(16e3).nullable().default(null),
  rationale: z3.string().trim().max(16e3).nullable().default(null)
});
var dashboardQuestionsTemplateSchema = dashboardModuleTemplateMetadataSchema.extend({
  module: z3.literal("questions"),
  questions: z3.array(dashboardQuestionTemplateRecordSchema).max(500)
}).superRefine((template, context) => {
  const seen = /* @__PURE__ */ new Set();
  template.questions.forEach((question, index2) => {
    if (seen.has(question.id)) {
      context.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["questions", index2, "id"],
        message: "\u540C\u4E00\u6B63\u5F0F\u95EE\u9898\u53EA\u80FD\u5728\u6A21\u677F\u4E2D\u51FA\u73B0\u4E00\u6B21"
      });
    }
    seen.add(question.id);
  });
});
var dashboardMonitoringTemplateBatchSchema = z3.object({
  batchKey: z3.string().trim().min(1).max(191),
  revision: z3.number().int().positive(),
  sourceName: z3.string().trim().min(1).max(512),
  collectedAt: z3.string().datetime(),
  samples: z3.array(monitoringSampleImportSchema).max(1e5),
  citations: z3.array(monitoringCitationImportSchema).max(1e5)
}).refine(
  (batch) => batch.samples.length > 0 || batch.citations.length > 0,
  "\u76D1\u63A7\u6279\u6B21\u4E0D\u80FD\u540C\u65F6\u7F3A\u5C11\u7B54\u6848\u548C\u5F15\u7528\u8BB0\u5F55"
);
var dashboardMonitoringCurrentTemplateSchema = dashboardModuleTemplateMetadataSchema.extend({
  module: z3.literal("monitoring"),
  workspaceUserId: z3.number().int().positive(),
  batches: z3.array(dashboardMonitoringTemplateBatchSchema).max(100)
}).superRefine((template, context) => {
  const batchKeys = /* @__PURE__ */ new Set();
  template.batches.forEach((batch, batchIndex) => {
    if (batchKeys.has(batch.batchKey)) {
      context.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["batches", batchIndex, "batchKey"],
        message: "\u540C\u4E00\u76D1\u63A7\u6279\u6B21\u53EA\u80FD\u5728\u5F53\u524D\u5185\u5BB9\u6A21\u677F\u4E2D\u51FA\u73B0\u4E00\u6B21"
      });
    }
    batchKeys.add(batch.batchKey);
    for (const [field, records] of [
      ["samples", batch.samples],
      ["citations", batch.citations]
    ]) {
      const sourceIds = /* @__PURE__ */ new Set();
      records.forEach((record, recordIndex) => {
        if (sourceIds.has(record.sourceRecordId)) {
          context.addIssue({
            code: z3.ZodIssueCode.custom,
            path: [
              "batches",
              batchIndex,
              field,
              recordIndex,
              "sourceRecordId"
            ],
            message: "\u540C\u4E00\u6279\u6B21\u7684\u8BB0\u5F55 ID \u4E0D\u80FD\u91CD\u590D"
          });
        }
        sourceIds.add(record.sourceRecordId);
      });
    }
  });
});
var dashboardOptimizationReportTemplateSchema = dashboardModuleTemplateMetadataSchema.extend({
  module: z3.literal("optimization-report"),
  optimizationReport: dashboardOptimizationReportSchema
});
var dashboardProgressReportVersionSchema = z3.object({
  id: z3.string().trim().min(1).max(191),
  revision: z3.number().int().positive(),
  publishedAt: z3.number().int().nonnegative(),
  report: dashboardOptimizationReportSchema
});
var dashboardPayloadSchema = z3.object({
  brandName: z3.string().trim().min(1).max(160),
  headline: z3.string().trim().min(1).max(300),
  summary: z3.string().trim().max(4e3).default(""),
  metrics: z3.array(dashboardMetricSchema).max(24).default([]),
  sections: z3.array(dashboardSectionSchema).max(40).default([]),
  keywordTables: z3.array(dashboardTableSchema).max(20).default([]),
  questions: z3.array(dashboardQuestionSchema).max(500).default([]),
  monitoringAnswers: z3.array(dashboardMonitoringAnswerSchema).max(1e5).default([]),
  citations: z3.array(dashboardCitationRecordSchema).max(1e5).default([]),
  contentAssets: z3.array(dashboardContentAssetSchema).max(200).default([]),
  optimizationReport: dashboardOptimizationReportSchema.nullable().default(null),
  progressReports: z3.array(dashboardProgressReportVersionSchema).max(100).default([])
});
var dashboardImportRecordStatsSchema = z3.object({
  label: z3.string().trim().min(1).max(120),
  beforeCount: z3.number().int().nonnegative(),
  afterCount: z3.number().int().nonnegative(),
  added: z3.number().int().nonnegative(),
  updated: z3.number().int().nonnegative(),
  removed: z3.number().int().nonnegative(),
  unchanged: z3.number().int().nonnegative()
});
var dashboardImportChangedFieldSchema = z3.object({
  field: z3.string().trim().min(1).max(120),
  label: z3.string().trim().min(1).max(120),
  before: z3.string().max(500),
  after: z3.string().max(500)
});
var dashboardImportPreviewMetadataSchema = z3.object({
  module: dashboardAdminImportModuleSchema,
  sourceName: z3.string().trim().min(1).max(1e3),
  fileHash: z3.string().regex(/^[a-f0-9]{64}$/),
  templateRevision: z3.number().int().nonnegative(),
  summary: z3.array(z3.string().trim().min(1).max(1e3)).max(30),
  preflightToken: z3.string().trim().min(1).max(4096).optional(),
  preflightExpiresAt: z3.string().datetime().optional(),
  preflightTargetBatchKey: z3.string().trim().min(1).max(191).optional()
});
var dashboardModuleImportPreviewSchema = dashboardImportPreviewMetadataSchema.extend({
  mode: z3.literal("dashboard-module"),
  sectionId: z3.string().trim().min(1).max(80).optional(),
  recordStats: z3.array(dashboardImportRecordStatsSchema).max(20),
  changedFields: z3.array(dashboardImportChangedFieldSchema).max(30).default([])
});

// server/service-entitlement.ts
import { and as and3, asc as asc2, desc as desc3, eq as eq4, gt as gt2, inArray as inArray2, lte } from "drizzle-orm";

// shared/delivery-ticket.ts
import { z as z5 } from "zod";

// shared/account-edition.ts
import { z as z4 } from "zod";
var accountMarketEditionSchema = z4.enum(["domestic", "overseas"]);

// shared/delivery-ticket.ts
var deliveryTicketTypeSchema = z5.enum([
  "content_asset",
  "website_operation",
  "knowledge_base"
]);
var deliveryTicketQuotaPoolSchema = z5.enum([
  "content_asset_publish",
  "website_content_publish"
]);
var websiteOperationCategorySchema = z5.enum([
  "domain_application",
  "icp_filing",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
  "knowledge_base_maintenance",
  // Legacy categories remain parseable for historical records. New ticket
  // creation is restricted by resolveDeliveryTicketQuotaPool below.
  "blog_update",
  "company_blog",
  "product_page_content",
  "case_study",
  "landing_page_content",
  "content_correction",
  "domain_https",
  "privacy_compliance",
  "metadata_tdk",
  "structured_data",
  "image_accessibility",
  "crawl_directives",
  "url_governance",
  "webmaster_indexing",
  "local_service",
  "multilingual_region",
  "verification_code",
  "bulk_redirect",
  "technical_diagnosis",
  "site_rebuild",
  "prelaunch_review",
  "llms_txt_experiment"
]);
var websiteContentCategorySchema = z5.enum([
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content"
]);
var deliveryTicketStatusSchema = z5.enum([
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
  "completed",
  "rejected",
  "cancelled"
]);
var deliveryTicketQuotaStateSchema = z5.enum([
  "reserved",
  "consumed",
  "released"
]);
var preferredContentMediaSchema = z5.enum([
  "\u4ECA\u65E5\u5934\u6761",
  "\u641C\u72D0",
  "\u7F51\u6613",
  "\u817E\u8BAF",
  "\u65B0\u6D6A",
  "\u767E\u5EA6",
  "\u4E2D\u534E\u7F51",
  "\u51E4\u51F0\u7F51",
  "\u5FAE\u535A",
  "\u7F8E\u8054\u793E",
  "\u4ECA\u65E5\u7F8E\u56FD",
  "\u96C5\u864E",
  "Business Insider",
  "Barchart"
]);
var deliveryTicketAttachmentInputSchema = z5.object({
  fileId: z5.string().trim().min(1).max(255),
  filename: z5.string().trim().min(1).max(512),
  mimeType: z5.string().trim().max(255).optional(),
  sizeBytes: z5.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  sha256: z5.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  purpose: z5.string().trim().max(160).optional(),
  authorization: z5.enum(["owned", "licensed", "public", "authorization_pending"]).optional(),
  copyrightNote: z5.string().trim().max(2e3).optional()
}).strict();
var optionalTrimmedText = (maximum) => z5.string().trim().max(maximum).optional();
var httpUrlSchema = z5.string().trim().max(2048).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "\u4EC5\u652F\u6301 http \u6216 https \u94FE\u63A5");
var targetPageSchema = z5.string().trim().max(2048).refine((value) => {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "\u76EE\u6807\u9875\u9762\u5FC5\u987B\u662F\u7AD9\u5185\u8DEF\u5F84\u6216\u5B8C\u6574\u7684 http/https \u94FE\u63A5");
var icpNonSensitiveDeclarationsSchema = z5.object({
  icpNumber: z5.string().trim().min(1, "\u8BF7\u586B\u5199 ICP \u4E3B\u4F53\u5907\u6848\u53F7").max(128)
}).strict();
var createDeliveryTicketSchema = z5.object({
  clientRequestId: z5.string().uuid(),
  type: z5.enum(["content_asset", "website_operation"]),
  category: optionalTrimmedText(64),
  topic: optionalTrimmedText(512),
  title: optionalTrimmedText(512),
  description: optionalTrimmedText(5e4),
  preferredMedia: preferredContentMediaSchema.optional(),
  icpProvince: optionalTrimmedText(64),
  icpDeclarations: icpNonSensitiveDeclarationsSchema.optional(),
  targetPage: targetPageSchema.optional(),
  materialUrls: z5.array(httpUrlSchema).max(30).default([]),
  knowledgeSnapshotId: z5.string().uuid().optional(),
  attachments: z5.array(deliveryTicketAttachmentInputSchema).max(30).default([])
}).refine(
  (value) => Boolean(
    value.category?.trim() || value.topic?.trim() || value.title?.trim()
  ),
  {
    message: "\u8BF7\u81F3\u5C11\u586B\u5199\u5185\u5BB9\u7C7B\u578B\u3001\u8BDD\u9898\u65B9\u5411\u6216\u9700\u6C42\u6807\u9898",
    path: ["topic"]
  }
).superRefine((value, context) => {
  if (value.category === "icp_filing" && !value.icpDeclarations) {
    context.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["icpDeclarations"],
      message: "\u8BF7\u5728\u963F\u91CC\u4E91\u5B8C\u6210\u5907\u6848\u540E\u586B\u5199 ICP \u4E3B\u4F53\u5907\u6848\u53F7"
    });
  }
  if (value.category === "icp_filing" && value.attachments.length > 0) {
    context.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["attachments"],
      message: "\u57DF\u540D\u4E0E ICP \u5907\u6848\u7ED3\u679C\u4E0D\u63A5\u6536\u9644\u4EF6\uFF0C\u8BF7\u4EC5\u586B\u5199\u5DF2\u5907\u6848\u57DF\u540D\u548C ICP \u4E3B\u4F53\u5907\u6848\u53F7"
    });
  }
  if (value.category === "knowledge_base_maintenance" && !value.knowledgeSnapshotId) {
    context.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["knowledgeSnapshotId"],
      message: "\u7EF4\u62A4\u5DE5\u5355\u5FC5\u987B\u5173\u8054\u5F53\u524D\u5DF2\u53D1\u5E03\u77E5\u8BC6\u5E93"
    });
  }
});
var deliveryTicketDetailInputSchema = z5.object({
  ticketId: z5.string().uuid()
});
var deliveryTicketListInputSchema = z5.object({
  type: deliveryTicketTypeSchema.optional(),
  publicStatus: z5.enum(["pending", "completed"]).optional(),
  limit: z5.number().int().min(1).max(100).default(20),
  cursor: z5.string().trim().min(1).max(1024).optional(),
  // tRPC's TanStack infinite-query adapter injects the fetch direction into
  // the serialized input. It is transport metadata only; list services keep
  // using the opaque cursor and deterministic server-side sort order.
  direction: z5.enum(["forward", "backward"]).optional()
}).strict();
var adminDeliveryTicketListInputSchema = deliveryTicketListInputSchema.extend({
  userId: z5.number().int().positive().optional(),
  assignedAdminId: z5.number().int().positive().optional(),
  query: z5.string().trim().max(100).optional(),
  status: deliveryTicketStatusSchema.optional(),
  quotaPeriodId: z5.string().uuid().optional(),
  order: z5.enum(["updated_desc", "created_asc"]).default("updated_desc")
});
var adjustDeliveryTicketQuotaSchema = z5.object({
  userId: z5.number().int().positive(),
  quotaPeriodId: z5.string().uuid(),
  expectedRevision: z5.number().int().positive(),
  contentAssetPublishLimit: z5.number().int().nonnegative().max(1e6),
  websiteContentPublishLimit: z5.number().int().nonnegative().max(1e6),
  reason: z5.string().trim().min(2).max(2e3)
});
var addDeliveryTicketMessageSchema = z5.object({
  ticketId: z5.string().uuid(),
  clientRequestId: z5.string().uuid(),
  message: z5.string().trim().min(1).max(5e4),
  attachments: z5.array(deliveryTicketAttachmentInputSchema).max(30).default([])
});
var updateDeliveryTicketSchema = z5.object({
  ticketId: z5.string().uuid(),
  expectedRevision: z5.number().int().positive(),
  status: z5.literal("completed"),
  publicMessage: z5.string().trim().max(5e4).optional(),
  publicSummary: z5.string().trim().max(5e4).nullable().optional(),
  deliveryLinks: z5.array(
    z5.object({
      label: z5.string().trim().min(1).max(160),
      url: httpUrlSchema
    })
  ).max(30).optional(),
  verifiedDomain: z5.string().trim().max(255).optional(),
  internalNote: z5.string().trim().max(5e4).nullable().optional()
});
var websiteContentTemplateRecordSchema = z5.object({
  ticketId: z5.string().uuid(),
  revision: z5.number().int().positive(),
  category: websiteContentCategorySchema,
  topic: z5.string().trim().max(512),
  publicSummary: z5.string().trim().max(5e4),
  complete: z5.boolean()
}).strict();
var websiteContentTemplateSchema = z5.object({
  format: z5.literal("frontmind.website-content-template.v1"),
  workspaceUserId: z5.number().int().positive(),
  exportedAt: z5.string().datetime({ offset: true }),
  records: z5.array(websiteContentTemplateRecordSchema).max(5e3)
}).strict().superRefine((value, context) => {
  const seen = /* @__PURE__ */ new Set();
  value.records.forEach((record, index2) => {
    if (seen.has(record.ticketId)) {
      context.addIssue({
        code: z5.ZodIssueCode.custom,
        path: ["records", index2, "ticketId"],
        message: "\u540C\u4E00\u5DE5\u5355\u5728\u6A21\u677F\u4E2D\u53EA\u80FD\u51FA\u73B0\u4E00\u6B21"
      });
    }
    seen.add(record.ticketId);
  });
});
var adminAddDeliveryTicketMessageSchema = addDeliveryTicketMessageSchema.extend({
  userId: z5.number().int().positive(),
  visibility: z5.enum(["customer", "internal"]).default("customer"),
  attachmentKind: z5.enum(["input", "deliverable"]).default("deliverable")
});
var deliverySiteCheckStatusSchema = z5.enum([
  "not_checked",
  "pending",
  "passed",
  "warning",
  "failed",
  "not_applicable"
]);
var updateWorkspaceSiteProfileSchema = z5.object({
  userId: z5.number().int().positive(),
  expectedRevision: z5.number().int().nonnegative(),
  domain: z5.string().trim().max(255),
  siteMode: z5.enum(["managed", "external", "unknown"]),
  domainStatus: z5.enum(["not_started", "pending", "completed"]).default("not_started"),
  icpProvince: z5.string().trim().max(64).nullable().optional(),
  icpNumber: z5.string().trim().max(128).nullable().optional(),
  icpStatus: z5.enum([
    "not_submitted",
    "preparing",
    "submitted",
    "approved",
    "rejected",
    "not_required"
  ])
});
var upsertWorkspaceSiteCheckSchema = z5.object({
  userId: z5.number().int().positive(),
  key: z5.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z5.string().trim().min(1).max(160),
  status: deliverySiteCheckStatusSchema,
  summary: z5.string().trim().max(4e3).optional(),
  evidence: z5.string().trim().max(8e3).optional(),
  source: z5.string().trim().max(2048).optional(),
  checkedAt: z5.number().int().nonnegative().nullable().optional(),
  expectedRevision: z5.number().int().nonnegative()
});
var DELIVERY_TICKET_LIMITS = Object.freeze({
  basic: Object.freeze({
    content_asset_publish: 1,
    website_content_publish: 0
  }),
  knowledge: Object.freeze({
    content_asset_publish: 0,
    website_content_publish: 0
  }),
  advanced: Object.freeze({
    content_asset_publish: 5,
    website_content_publish: 20
  }),
  luxury: Object.freeze({
    content_asset_publish: 20,
    website_content_publish: 100
  })
});
var WEBSITE_OPERATION_CATEGORIES = new Set(
  websiteOperationCategorySchema.options
);
var ACTIVE_WEBSITE_OPERATION_CATEGORIES = Object.freeze([
  "domain_application",
  "icp_filing",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content"
]);
var DELIVERY_TICKET_STATUS_LABELS = Object.freeze({
  submitted: "\u5DF2\u63D0\u4EA4",
  needs_information: "\u5F85\u8865\u5145\u8D44\u6599",
  scheduled: "\u5DF2\u6392\u671F",
  in_progress: "\u5904\u7406\u4E2D",
  completed: "\u5DF2\u5B8C\u6210",
  rejected: "\u672A\u53D7\u7406",
  cancelled: "\u5DF2\u53D6\u6D88"
});
var DELIVERY_TICKET_PUBLIC_STATUS_LABELS = Object.freeze({
  pending: "\u5F85\u53D7\u7406",
  completed: "\u5DF2\u5B8C\u6210"
});
var DELIVERY_TICKET_PUBLIC_STAGE_LABELS = Object.freeze({
  awaiting_service: "\u5DF2\u63D0\u4EA4",
  processing: "\u5904\u7406\u4E2D",
  action_required: "\u5F85\u60A8\u8865\u5145",
  completed: "\u5DF2\u5B8C\u6210",
  closed: "\u5DF2\u7ED3\u675F"
});
var publicDeliveryLinkSchema = z5.object({
  label: z5.string().trim().min(1).max(160),
  url: httpUrlSchema
}).strict();
var publicDeliveryTicketSummaryBaseSchema = z5.object({
  id: z5.string().uuid(),
  type: deliveryTicketTypeSchema,
  category: z5.string().trim().max(64).nullable(),
  categoryLabel: z5.string().trim().max(160).nullable(),
  topic: z5.string().trim().max(512).nullable(),
  publicStatus: z5.enum(["pending", "completed"]),
  publicStatusLabel: z5.enum(["\u5F85\u53D7\u7406", "\u5DF2\u5B8C\u6210"]),
  publicStage: z5.enum([
    "awaiting_service",
    "processing",
    "action_required",
    "completed",
    "closed"
  ]),
  publicStageLabel: z5.enum([
    "\u5DF2\u63D0\u4EA4",
    "\u5904\u7406\u4E2D",
    "\u5F85\u60A8\u8865\u5145",
    "\u5DF2\u5B8C\u6210",
    "\u5DF2\u7ED3\u675F"
  ]),
  publicSummary: z5.string().max(5e4).nullable(),
  knowledgeSnapshotId: z5.string().uuid().nullable().optional()
});
var publicContentAssetTicketSummarySchema = publicDeliveryTicketSummaryBaseSchema.extend({
  type: z5.literal("content_asset"),
  deliveryLinks: z5.array(publicDeliveryLinkSchema).max(30)
}).strict();
var publicWebsiteTicketSummarySchema = publicDeliveryTicketSummaryBaseSchema.extend({
  type: z5.literal("website_operation")
}).strict();
var publicKnowledgeBaseTicketSummarySchema = publicDeliveryTicketSummaryBaseSchema.extend({
  type: z5.literal("knowledge_base")
}).strict();
var publicDeliveryTicketSummarySchema = z5.discriminatedUnion("type", [
  publicContentAssetTicketSummarySchema,
  publicWebsiteTicketSummarySchema,
  publicKnowledgeBaseTicketSummarySchema
]);
var publicDeliveryTicketEventSchema = z5.object({
  id: z5.string().uuid(),
  actorRole: z5.enum(["user", "admin", "delivery_member", "system"]),
  actorLabel: z5.enum(["\u7528\u6237", "\u670D\u52A1\u56E2\u961F"]),
  message: z5.string().max(5e4).nullable(),
  createdAt: z5.number().int().nonnegative().nullable()
}).strict();
var publicDeliveryTicketAttachmentSchema = z5.object({
  id: z5.string().uuid(),
  filename: z5.string().trim().min(1).max(512),
  mimeType: z5.string().trim().max(255).nullable(),
  sizeBytes: z5.number().int().nonnegative().nullable(),
  purpose: z5.string().trim().max(160).nullable(),
  kind: z5.enum(["input", "deliverable"]).nullable(),
  createdAt: z5.number().int().nonnegative().nullable(),
  downloadUrl: z5.string().regex(/^\/api\/delivery-ticket-attachments\/[0-9a-f-]{36}\/content$/)
}).strict();
var publicContentAssetTicketDetailSchema = z5.object({
  ticket: publicContentAssetTicketSummarySchema.extend({
    preferredMedia: preferredContentMediaSchema.nullable(),
    revision: z5.number().int().positive(),
    canReply: z5.boolean()
  }).strict(),
  events: z5.array(publicDeliveryTicketEventSchema),
  attachments: z5.array(publicDeliveryTicketAttachmentSchema).max(100)
}).strict();
var publicWebsiteTicketDetailSchema = z5.object({
  ticket: publicWebsiteTicketSummarySchema.extend({
    revision: z5.number().int().positive(),
    canReply: z5.boolean(),
    canAttach: z5.boolean()
  }).strict(),
  events: z5.array(publicDeliveryTicketEventSchema),
  attachments: z5.array(publicDeliveryTicketAttachmentSchema).max(100)
}).strict();
var publicKnowledgeBaseTicketDetailSchema = z5.object({
  ticket: publicKnowledgeBaseTicketSummarySchema,
  events: z5.array(publicDeliveryTicketEventSchema)
}).strict();
var publicDeliveryTicketDetailSchema = z5.union([
  publicContentAssetTicketDetailSchema,
  publicWebsiteTicketDetailSchema,
  publicKnowledgeBaseTicketDetailSchema
]);
var publicDeliveryTicketQuotaSchema = z5.object({
  type: deliveryTicketQuotaPoolSchema,
  allowed: z5.boolean(),
  used: z5.number().int().nonnegative(),
  limit: z5.number().int().nonnegative(),
  remaining: z5.number().int().nonnegative(),
  reason: z5.string().nullable()
}).strict();
var publicContentAssetCatalogItemSchema = z5.object({
  id: z5.string().trim().min(1).max(64),
  code: z5.string().trim().min(1).max(64),
  group: z5.string().trim().min(1).max(64),
  type: z5.string().trim().min(1).max(160),
  label: z5.string().trim().min(1).max(160),
  description: z5.string().trim().min(1).max(500).optional()
}).strict();
var publicWebsiteContentCatalogItemSchema = z5.object({
  value: z5.enum([
    "company_facts",
    "product_case_docs",
    "industry_news",
    "company_news",
    "faq_content"
  ]),
  label: z5.string().trim().min(1).max(160)
}).strict();
var publicDeliveryTicketWorkspaceMetadataSchema = z5.object({
  quotas: z5.object({
    content_asset_publish: publicDeliveryTicketQuotaSchema,
    website_content_publish: publicDeliveryTicketQuotaSchema
  }).strict(),
  contentAssetCatalog: z5.array(publicContentAssetCatalogItemSchema),
  websiteContentCatalog: z5.array(publicWebsiteContentCatalogItemSchema),
  marketEdition: accountMarketEditionSchema,
  preferredMediaOptions: z5.array(preferredContentMediaSchema),
  deliveryOwners: z5.object({
    aiOperations: z5.boolean(),
    monitoringOptimization: z5.boolean(),
    contentDistribution: z5.boolean()
  }).strict(),
  websiteWorkflow: z5.object({
    domainCompleted: z5.boolean(),
    icpCompleted: z5.boolean(),
    styleState: z5.enum([
      "locked",
      "waiting_samples",
      "awaiting_selection",
      "revision_requested",
      "confirmed",
      "legacy_confirmed"
    ]),
    styleRevision: z5.number().int().nonnegative(),
    styleBatch: z5.object({
      id: z5.string().uuid(),
      ordinal: z5.number().int().positive(),
      status: z5.enum([
        "published",
        "revision_requested",
        "selected",
        "superseded"
      ]),
      engineerNote: z5.string().nullable(),
      publishedAt: z5.number().int().nonnegative().nullable(),
      samples: z5.array(
        z5.object({
          id: z5.string().uuid(),
          label: z5.string().trim().min(1).max(160),
          note: z5.string().nullable(),
          sortOrder: z5.number().int().positive(),
          attachmentId: z5.string().uuid(),
          filename: z5.string().trim().min(1).max(512),
          mimeType: z5.string().nullable(),
          imageUrl: z5.string().trim().min(1)
        }).strict()
      ).length(3)
    }).strict().nullable(),
    selectedStyleSampleId: z5.string().uuid().nullable(),
    styleConfirmed: z5.boolean(),
    canSelectStyle: z5.boolean(),
    canRequestStyleRevision: z5.boolean(),
    canSubmitDomain: z5.boolean(),
    canSubmitIcp: z5.boolean(),
    canSubmitContent: z5.boolean(),
    domainLockReason: z5.string().nullable(),
    icpLockReason: z5.string().nullable(),
    contentLockReason: z5.string().nullable(),
    icpProvinceOptions: z5.array(z5.string().trim().min(1).max(64))
  }).strict()
}).strict();
var deliveryOperationResultSchema = z5.object({
  platform: z5.string().trim().min(1).max(160),
  targetUrl: httpUrlSchema,
  executedAt: z5.number().int().nonnegative(),
  resultStatus: z5.enum(["success", "failed", "pending_confirmation"]),
  platformMessage: z5.string().trim().max(8e3).optional(),
  screenshotFileId: z5.string().trim().min(1).max(255).optional()
});
var recordDeliveryOperationSchema = z5.object({
  userId: z5.number().int().positive(),
  ticketId: z5.string().uuid(),
  expectedRevision: z5.number().int().positive(),
  clientRequestId: z5.string().uuid(),
  result: deliveryOperationResultSchema,
  attachments: z5.array(deliveryTicketAttachmentInputSchema).max(20).default([])
});
var redirectPreviewRowSchema = z5.object({
  row: z5.number().int().positive(),
  sourceUrl: z5.string(),
  targetUrl: z5.string(),
  statusCode: z5.number().int()
});
var previewRedirectWorkbookSchema = z5.object({
  userId: z5.number().int().positive(),
  fileId: z5.string().trim().min(1).max(255),
  filename: z5.string().trim().min(1).max(512)
});
var confirmRedirectWorkbookSchema = z5.object({
  userId: z5.number().int().positive(),
  ticketId: z5.string().uuid(),
  previewId: z5.string().uuid(),
  expectedRevision: z5.number().int().positive()
});

// server/authenticated-knowledge-service.ts
import { and as and2, desc as desc2, eq as eq3, gte } from "drizzle-orm";

// server/service-entitlement.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid service date");
  }
  return date;
}
function epoch(value) {
  return asDate(value).getTime();
}
function deriveEffectiveServiceStatus(contract, now = /* @__PURE__ */ new Date()) {
  if (!contract) return "unconfigured";
  if (contract.status === "cancelled" || contract.status === "superseded") {
    return "cancelled";
  }
  if (epoch(contract.endsAt) <= epoch(now)) return "expired";
  if (contract.status === "pending_confirmation") {
    return "pending_confirmation";
  }
  if (contract.status === "suspended") return "suspended";
  if (epoch(contract.startsAt) > epoch(now)) return "scheduled";
  return "active";
}
function selectPortalContract(contracts, now = /* @__PURE__ */ new Date()) {
  const statusRank = {
    active: 6,
    pending_confirmation: 5,
    scheduled: 4,
    suspended: 3,
    expired: 2,
    cancelled: 1,
    unconfigured: 0
  };
  const planRank = {
    basic: 1,
    advanced: 2,
    luxury: 3
  };
  return [...contracts].sort((left, right) => {
    const statusDifference = statusRank[deriveEffectiveServiceStatus(right, now)] - statusRank[deriveEffectiveServiceStatus(left, now)];
    if (statusDifference) return statusDifference;
    const planDifference = planRank[right.planCode] - planRank[left.planCode];
    if (planDifference) return planDifference;
    return right.revision - left.revision;
  })[0] ?? null;
}

// server/knowledge-snapshot-archive-store.ts
var MAX_KNOWLEDGE_SNAPSHOT_ARCHIVE_BYTES = 250 * 1024 * 1024;

// server/admin-control-plane-service.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { and as and4, desc as desc4, eq as eq5, gte as gte2, inArray as inArray3, isNull as isNull2, lt, or } from "drizzle-orm";
function getEffectiveAdminAccessLevel(user) {
  if (user.role !== "admin") return null;
  return isExplicitAdminAccessLevel(user.adminAccessLevel) ? user.adminAccessLevel : null;
}
async function requireDb2() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured"
    );
  }
  return db;
}
var SENSITIVE_AUDIT_KEY = /(?:^|[_-])(password|passphrase|secret|token|authorization|cookie|encrypted[_-]?key|encryption[_-]?(?:iv|auth[_-]?tag)|api[_-]?key)(?:$|[_-])|(?:password|passphrase|secret|token|apiKey|authorization|cookie|encryptedKey|encryptionIv|encryptionAuthTag|authTag)$/i;
function sanitizeAuditValue(value, depth) {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 4e3 ? `${value.slice(0, 4e3)}\u2026` : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      SENSITIVE_AUDIT_KEY.test(key) ? "[REDACTED]" : sanitizeAuditValue(item, depth + 1)
    ]);
    return Object.fromEntries(entries);
  }
  return String(value);
}
function sanitizeAuditMetadata(metadata) {
  return sanitizeAuditValue(metadata ?? {}, 0) ?? {};
}
async function writeWorkspaceAuditEvent(input, executor) {
  const db = executor ?? await requireDb2();
  const event = {
    id: randomUUID2(),
    actorUserId: input.actor.id,
    actorUsername: input.actor.username.slice(0, 64),
    actorAccessLevel: getEffectiveAdminAccessLevel(input.actor),
    action: input.action.slice(0, 128),
    targetType: input.targetType.slice(0, 64),
    targetId: String(input.targetId).slice(0, 191),
    workspaceUserId: input.workspaceUserId ?? null,
    reason: input.reason?.trim() || null,
    metadata: sanitizeAuditMetadata(input.metadata),
    createdAt: input.now ?? /* @__PURE__ */ new Date()
  };
  await db.insert(workspaceAuditEvents).values(event);
  return event;
}

// server/dashboard-service.ts
var CREDIT_PAGE_LIMIT = 100;
var CREDIT_MAX_PAGES = 20;
function parseCreatedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1e3;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12 ? numeric : numeric * 1e3;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function aggregateSharedKeyCreditUsagePage(input) {
  const recentTasks = [];
  let totalUsed = 0;
  let accountUsed = 0;
  let reachedCutoff = false;
  for (const task of input.tasks) {
    const id = String(task?.id ?? task?.task_id ?? "");
    if (!id || input.seenTaskIds.has(id)) continue;
    input.seenTaskIds.add(id);
    const createdAtMs = parseCreatedAt(task?.created_at);
    if (createdAtMs !== null && createdAtMs < input.cutoff) {
      reachedCutoff = true;
      break;
    }
    if (createdAtMs !== null && input.endExclusive !== void 0 && createdAtMs >= input.endExclusive) {
      continue;
    }
    const creditUsage = Number(
      task?.credit_usage ?? task?.metadata?.credit_usage ?? 0
    );
    if (!Number.isFinite(creditUsage) || creditUsage <= 0) continue;
    totalUsed += creditUsage;
    if (!input.ownedTaskIds.has(id)) continue;
    accountUsed += creditUsage;
    recentTasks.push({
      id,
      title: String(task?.metadata?.task_title ?? "").trim() || String(task?.instructions ?? "").slice(0, 30) || id.slice(0, 12),
      creditUsage,
      createdAt: createdAtMs === null ? void 0 : new Date(createdAtMs).toLocaleDateString("zh-CN", {
        timeZone: "Asia/Shanghai"
      })
    });
  }
  return { totalUsed, accountUsed, recentTasks, reachedCutoff };
}
function getShanghaiCalendarMonthPeriod(now = Date.now()) {
  const shanghaiOffsetMs = 8 * 60 * 60 * 1e3;
  const shanghaiNow = new Date(now + shanghaiOffsetMs);
  const year = shanghaiNow.getUTCFullYear();
  const monthIndex = shanghaiNow.getUTCMonth();
  const startAt = Date.UTC(year, monthIndex, 1, 0, 0, 0, 0) - shanghaiOffsetMs;
  const endAt = Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0) - shanghaiOffsetMs;
  return {
    key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    label: `${year} \u5E74 ${monthIndex + 1} \u6708`,
    timezone: "Asia/Shanghai",
    startAt,
    endAt
  };
}
async function getAccountCreditUsageBetween(userId, input) {
  const credential = await getEffectiveDecryptedCredentialForAccount(userId);
  if (!credential)
    return {
      totalUsed: 0,
      accountUsed: 0,
      recentTasks: [],
      fetchedAt: Date.now(),
      fingerprint: null,
      complete: true,
      ...input.period ? { period: input.period } : {}
    };
  const recentTasks = [];
  const seen = /* @__PURE__ */ new Set();
  let totalUsed = 0;
  let accountUsed = 0;
  let after;
  let reachedCutoff = false;
  let complete = true;
  for (let pageIndex = 0; pageIndex < CREDIT_MAX_PAGES && !reachedCutoff; pageIndex += 1) {
    const params = new URLSearchParams({
      limit: String(CREDIT_PAGE_LIMIT),
      order: "desc"
    });
    if (after) params.set("after", after);
    const response = await fetch(
      `${getUpstreamBaseUrl()}/v1/tasks?${params.toString()}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
          Accept: "application/json"
        },
        redirect: "error",
        signal: AbortSignal.timeout(3e4)
      }
    );
    if (!response.ok) {
      throw new AuthServiceError(
        response.status === 401 || response.status === 403 ? "INVALID_CREDENTIAL" : "UPSTREAM_UNAVAILABLE",
        "\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u8BE5\u7528\u6237\u7684\u79EF\u5206\u4F7F\u7528\u60C5\u51B5"
      );
    }
    const payload = await response.json();
    const tasks = Array.isArray(payload?.data) ? payload.data : [];
    if (tasks.length === 0) break;
    const taskIds = tasks.map((task) => String(task?.id ?? task?.task_id ?? "")).filter(Boolean);
    const ownedTaskIds = await getOwnedUpstreamResourceIds(
      userId,
      "task",
      taskIds
    );
    const pageResult = aggregateSharedKeyCreditUsagePage({
      tasks,
      ownedTaskIds,
      cutoff: input.cutoff,
      endExclusive: input.endExclusive,
      seenTaskIds: seen
    });
    totalUsed += pageResult.totalUsed;
    accountUsed += pageResult.accountUsed;
    recentTasks.push(...pageResult.recentTasks);
    reachedCutoff = pageResult.reachedCutoff;
    after = payload?.last_id || tasks[tasks.length - 1]?.id;
    if (pageIndex === CREDIT_MAX_PAGES - 1 && payload?.has_more && after && !reachedCutoff) {
      complete = false;
    }
    if (!payload?.has_more || !after) break;
  }
  return {
    totalUsed,
    accountUsed,
    recentTasks,
    fetchedAt: Date.now(),
    fingerprint: credential.fingerprint,
    complete,
    ...input.period ? { period: input.period } : {}
  };
}
async function getAccountMonthlyCreditUsage(userId, now = Date.now()) {
  const period = getShanghaiCalendarMonthPeriod(now);
  return getAccountCreditUsageBetween(userId, {
    cutoff: period.startAt,
    endExclusive: period.endAt,
    period
  });
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

// server/_core/sensitive-data.ts
var REDACTED = "[REDACTED]";
var TRUNCATED = "[TRUNCATED]";
var CIRCULAR = "[CIRCULAR]";
var UNSUPPORTED = "[UNSUPPORTED]";
function normalizedSecrets(values) {
  return Array.from(values ?? []).flatMap((value) => typeof value === "string" ? [value.trim()] : []).filter(Boolean).sort((left, right) => right.length - left.length);
}
function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function isSensitiveDataKey(value) {
  const key = normalizedKey(value);
  return key.includes("apikey") || key.includes("authorization") || key.includes("cookie") || key.includes("token") || key.includes("secret") || key.includes("password") || key.includes("passphrase") || key.includes("credential");
}
function redactSensitiveText(value, secrets) {
  let result = value;
  for (const secret of normalizedSecrets(secrets)) {
    result = result.split(secret).join(REDACTED);
  }
  return result.replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`).replace(
    /\b(api[\s_-]*key|authorization|cookie|token|secret|password|passphrase|credential)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, key, separator) => `${key}${separator}${REDACTED}`
  ).replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED);
}
function redactSensitivePayload(value, options = {}) {
  const secrets = normalizedSecrets(options.secrets);
  const maxDepth = options.maxDepth ?? 40;
  const maxEntries = options.maxEntries ?? 1e4;
  const seen = /* @__PURE__ */ new WeakSet();
  let entries = 0;
  const visit = (current, depth) => {
    if (depth > maxDepth || entries >= maxEntries) return TRUNCATED;
    if (current === null || current === void 0 || typeof current === "boolean" || typeof current === "number") {
      return current;
    }
    if (typeof current === "string") {
      return redactSensitiveText(current, secrets);
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current !== "object") return UNSUPPORTED;
    if (current instanceof Date) return current.toISOString();
    if (Buffer.isBuffer(current)) return "[BINARY REDACTED]";
    if (seen.has(current)) return CIRCULAR;
    seen.add(current);
    if (Array.isArray(current)) {
      const result = [];
      for (const item of current) {
        entries += 1;
        result.push(visit(item, depth + 1));
        if (entries >= maxEntries) {
          result.push(TRUNCATED);
          break;
        }
      }
      return result;
    }
    const output = {};
    let objectEntries;
    try {
      objectEntries = Object.entries(current);
    } catch {
      return REDACTED;
    }
    for (const [key, child] of objectEntries) {
      entries += 1;
      if (isSensitiveDataKey(key)) continue;
      try {
        output[key] = visit(child, depth + 1);
      } catch {
        output[key] = REDACTED;
      }
      if (entries >= maxEntries) {
        output.__truncated__ = TRUNCATED;
        break;
      }
    }
    return output;
  };
  return visit(value, 0);
}
function safeProperty(value, key) {
  if (!value || typeof value !== "object" && typeof value !== "function") {
    return void 0;
  }
  try {
    return value[key];
  } catch {
    return void 0;
  }
}
function safeLogText(value, secrets, maxLength = 1e3) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  return redactSensitiveText(value, secrets).slice(0, maxLength);
}
function safeStatus(error) {
  const direct = safeProperty(error, "status");
  const response = safeProperty(error, "response");
  const nested = safeProperty(response, "status");
  const candidate = typeof direct === "number" ? direct : nested;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : void 0;
}
function safeRequestId(error, secrets) {
  const response = safeProperty(error, "response");
  const headers = safeProperty(response, "headers");
  if (!headers || typeof headers !== "object") return void 0;
  for (const key of ["x-request-id", "request-id", "trace-id"]) {
    let candidate;
    const getter = safeProperty(headers, "get");
    if (typeof getter === "function") {
      try {
        candidate = getter.call(headers, key);
      } catch {
        candidate = void 0;
      }
    }
    if (candidate === void 0) {
      const matchingKey = Object.keys(headers).find(
        (header) => header.toLowerCase() === key
      );
      if (matchingKey) candidate = safeProperty(headers, matchingKey);
    }
    const normalized = safeLogText(candidate, secrets, 200);
    if (normalized) return normalized;
  }
  return void 0;
}
function safeErrorForLog(error, options = {}) {
  const secrets = normalizedSecrets(options.secrets);
  const result = {
    name: safeLogText(safeProperty(error, "name"), secrets, 120) ?? "Error",
    message: safeLogText(
      typeof error === "string" ? error : safeProperty(error, "message"),
      secrets
    ) ?? "Request failed"
  };
  const code = safeLogText(safeProperty(error, "code"), secrets, 120);
  const status = safeStatus(error);
  const requestId = safeRequestId(error, secrets);
  if (code) result.code = code;
  if (status !== void 0) result.status = status;
  if (requestId) result.requestId = requestId;
  return result;
}

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
function createPreparedAssetId(ownerUserId, credentialId, source, projectAssignmentId) {
  const sourceIdentity = source.kind === "file" ? `file:${source.fileId}` : `external:${stableExternalIdentity(source.url)}`;
  return createHash2("sha256").update(
    `frontmind-pdf-v1\0${ownerUserId}\0${credentialId}\0${sourceIdentity}${projectAssignmentId ? `\0project-assignment:${projectAssignmentId}` : ""}`
  ).digest("hex").slice(0, 40);
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
        source,
        input.projectAssignmentId
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      projectAssignmentId: input.projectAssignmentId ?? null,
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
        source,
        input.projectAssignmentId
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      projectAssignmentId: input.projectAssignmentId ?? null,
      source,
      filename: normalizeFilename(input.filename)
    });
  }
  async register(input) {
    const now = Date.now();
    const existing = this.manifests.get(input.id);
    if (existing) {
      if ((existing.projectAssignmentId ?? null) !== input.projectAssignmentId) {
        throw new PreparedFileError(
          "SOURCE_FORBIDDEN",
          "\u6587\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5BA2\u6237\u9879\u76EE"
        );
      }
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
      projectAssignmentId: input.projectAssignmentId,
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
  async getStatus(assetId, ownerUserId, projectAssignmentId) {
    const manifest = await this.requireOwned(
      assetId,
      ownerUserId,
      projectAssignmentId
    );
    await this.touch(manifest);
    return publicStatus(manifest);
  }
  async getReadyManifest(assetId, ownerUserId, projectAssignmentId) {
    const manifest = await this.requireOwned(
      assetId,
      ownerUserId,
      projectAssignmentId
    );
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
  async retry(assetId, ownerUserId, projectAssignmentId) {
    const manifest = await this.requireOwned(
      assetId,
      ownerUserId,
      projectAssignmentId
    );
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
  async requireOwned(assetId, ownerUserId, projectAssignmentId) {
    await this.initialize();
    if (!/^[a-f0-9]{40}$/.test(assetId)) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "\u6587\u4EF6\u4E0D\u5B58\u5728");
    }
    const manifest = this.manifests.get(assetId);
    const owned = projectAssignmentId ? manifest?.projectAssignmentId === projectAssignmentId : manifest?.ownerUserId === ownerUserId && (manifest.projectAssignmentId ?? null) === null;
    if (!manifest || !owned) {
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
        throw new PreparedFileError("INVALID_PDF", "\u5904\u7406\u540E\u7684 PDF \u6587\u4EF6\u4E3A\u7A7A");
      }
      const handle = await fs.open(preparedTempPath, "r");
      try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString("ascii") !== "%PDF-") {
          throw new PreparedFileError("INVALID_PDF", "\u5904\u7406\u7ED3\u679C\u4E0D\u662F\u6709\u6548\u7684 PDF");
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
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => void 0);
    }
  }
  async downloadSource(manifest, destination, persistProgress) {
    let sourceUrl;
    let headers;
    if (manifest.source.kind === "file") {
      const credential = await getCredentialForUpstreamResource(
        manifest.ownerUserId,
        "file",
        manifest.source.fileId,
        manifest.projectAssignmentId ?? void 0
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

// server/delivery-role-service.ts
import { and as and8, asc as asc5, desc as desc8, eq as eq9, inArray as inArray6, isNull as isNull4, lt as lt4, or as or3, sql as sql3 } from "drizzle-orm";

// shared/delivery-roles.ts
import { z as z6 } from "zod";
var deliveryRoleTypeSchema = z6.enum([
  "ai_operations_engineer",
  "monitoring_optimization_engineer",
  "content_distribution_engineer"
]);
var deliveryWorkflowOperationSchema = z6.enum([
  "build_exception",
  "knowledge_maintenance",
  "knowledge_reset",
  "question_catalog",
  "initial_monitoring",
  "monitoring_import",
  "monitoring_retest",
  "stage_report",
  "response_logic",
  "content_asset_publish",
  "channel_distribution",
  "domain_application",
  "icp_filing",
  "website_style_samples",
  "company_facts",
  "product_case_docs",
  "industry_news",
  "company_news",
  "faq_content",
  "site_check"
]);
var knowledgeResetReasonSchema = z6.enum([
  "stuck",
  "upload_error",
  "build_error",
  "enterprise_materials",
  "other"
]);

// server/delivery-ticket-service.ts
import {
  and as and6,
  asc as asc3,
  count,
  desc as desc6,
  eq as eq7,
  gt as gt3,
  inArray as inArray5,
  like,
  lt as lt3,
  max,
  ne as ne2,
  or as or2,
  sql as sql2
} from "drizzle-orm";

// shared/delivery-catalog.ts
var CONTENT_ASSET_CATALOG = Object.freeze([
  {
    id: "A1",
    code: "A1",
    group: "A",
    type: "\u54C1\u724C\u4E8B\u5B9E\u5185\u5BB9",
    label: "\u4F01\u4E1A\u8D44\u6599\u4E0E\u54C1\u724C\u4E8B\u5B9E",
    description: "\u6574\u7406\u4F01\u4E1A\u7B80\u4ECB\u3001\u53D1\u5C55\u5386\u7A0B\u3001\u8D44\u8D28\u8363\u8A89\u7B49\u53EF\u6838\u9A8C\u7684\u54C1\u724C\u4E8B\u5B9E\u3002"
  },
  {
    id: "A2",
    code: "A2",
    group: "A",
    type: "\u6848\u4F8B\u5185\u5BB9",
    label: "\u7528\u6237\u6848\u4F8B\u4E0E\u6210\u529F\u6545\u4E8B",
    description: "\u5C06\u9879\u76EE\u80CC\u666F\u3001\u89E3\u51B3\u65B9\u6848\u4E0E\u91CF\u5316\u6210\u679C\u6574\u7406\u4E3A\u53EF\u4FE1\u5BA2\u6237\u6848\u4F8B\u3002"
  },
  {
    id: "B1",
    code: "B1",
    group: "B",
    type: "\u884C\u4E1A\u5185\u5BB9",
    label: "\u884C\u4E1A\u89C2\u70B9\u4E0E\u8D8B\u52BF\u89C2\u5BDF",
    description: "\u56F4\u7ED5\u884C\u4E1A\u53D8\u5316\u3001\u5173\u952E\u8BAE\u9898\u548C\u4E13\u4E1A\u5224\u65AD\u5F62\u6210\u6DF1\u5EA6\u89C2\u70B9\u5185\u5BB9\u3002"
  },
  {
    id: "B2",
    code: "B2",
    group: "B",
    type: "\u4EA7\u54C1\u5185\u5BB9",
    label: "\u4EA7\u54C1\u80FD\u529B\u4E0E\u5E94\u7528\u573A\u666F",
    description: "\u6E05\u6670\u8BF4\u660E\u4EA7\u54C1\u80FD\u529B\u3001\u9002\u7528\u573A\u666F\u3001\u4F7F\u7528\u65B9\u5F0F\u4E0E\u9009\u62E9\u4F9D\u636E\u3002"
  },
  {
    id: "C1",
    code: "C1",
    group: "C",
    type: "\u65B0\u95FB\u5185\u5BB9",
    label: "\u4F01\u4E1A\u65B0\u95FB\u4E0E\u52A8\u6001",
    description: "\u53D1\u5E03\u4F01\u4E1A\u8FDB\u5C55\u3001\u5408\u4F5C\u52A8\u6001\u3001\u6D3B\u52A8\u4FE1\u606F\u4E0E\u91CD\u8981\u91CC\u7A0B\u7891\u3002"
  },
  {
    id: "D1",
    code: "D1",
    group: "D",
    type: "\u95EE\u7B54\u5185\u5BB9",
    label: "\u77E5\u4E4E\u95EE\u7B54",
    description: "\u56F4\u7ED5\u7528\u6237\u771F\u5B9E\u95EE\u9898\u8F93\u51FA\u4E13\u4E1A\u3001\u81EA\u7136\u4E14\u6709\u4E8B\u5B9E\u652F\u6491\u7684\u56DE\u7B54\u3002"
  }
]);
var WEBSITE_CONTENT_CATALOG = Object.freeze([
  { value: "company_facts", label: "\u4F01\u4E1A\u8D44\u6599\u4E0E\u54C1\u724C\u4E8B\u5B9E" },
  { value: "product_case_docs", label: "\u4EA7\u54C1\u6848\u4F8B\u4E0E\u6587\u6863" },
  { value: "industry_news", label: "\u884C\u4E1A\u65B0\u95FB\u4E0E\u89C2\u5BDF" },
  { value: "company_news", label: "\u4F01\u4E1A\u65B0\u95FB\u4E0E\u52A8\u6001" },
  { value: "faq_content", label: "FAQ \u4E0E\u95EE\u7B54\u9875\u9762" }
]);
var DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  "\u4ECA\u65E5\u5934\u6761",
  "\u641C\u72D0",
  "\u7F51\u6613",
  "\u817E\u8BAF",
  "\u65B0\u6D6A",
  "\u767E\u5EA6",
  "\u4E2D\u534E\u7F51",
  "\u51E4\u51F0\u7F51",
  "\u5FAE\u535A"
]);
var OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  "\u7F8E\u8054\u793E",
  "\u4ECA\u65E5\u7F8E\u56FD",
  "\u96C5\u864E",
  "Business Insider",
  "Barchart"
]);
var ALL_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  ...DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS,
  ...OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS
]);
var ICP_PROVINCES = Object.freeze([
  "\u5317\u4EAC",
  "\u5929\u6D25",
  "\u6CB3\u5317",
  "\u5C71\u897F",
  "\u5185\u8499\u53E4",
  "\u8FBD\u5B81",
  "\u5409\u6797",
  "\u9ED1\u9F99\u6C5F",
  "\u4E0A\u6D77",
  "\u6C5F\u82CF",
  "\u6D59\u6C5F",
  "\u5B89\u5FBD",
  "\u798F\u5EFA",
  "\u6C5F\u897F",
  "\u5C71\u4E1C",
  "\u6CB3\u5357",
  "\u6E56\u5317",
  "\u6E56\u5357",
  "\u5E7F\u4E1C",
  "\u5E7F\u897F",
  "\u6D77\u5357",
  "\u91CD\u5E86",
  "\u56DB\u5DDD",
  "\u8D35\u5DDE",
  "\u4E91\u5357",
  "\u897F\u85CF",
  "\u9655\u897F",
  "\u7518\u8083",
  "\u9752\u6D77",
  "\u5B81\u590F",
  "\u65B0\u7586"
]);

// server/delivery-ticket-service.ts
var WEBSITE_CONTENT_CATEGORIES = new Set(
  WEBSITE_CONTENT_CATALOG.map((item) => item.value)
);

// server/knowledge-base-progress-service.ts
import { and as and7, asc as asc4, desc as desc7, eq as eq8, isNotNull as isNotNull2, isNull as isNull3 } from "drizzle-orm";

// server/delivery-role-service.ts
async function requireDb3() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured"
    );
  }
  return db;
}
function requiredRolesForPlan(planCode) {
  const roles = [
    "monitoring_optimization_engineer",
    "content_distribution_engineer"
  ];
  if (planCode === "advanced" || planCode === "luxury") {
    roles.unshift("ai_operations_engineer");
  }
  return roles;
}
var ACTIVE_DELIVERY_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress"
];
async function assertDeliveryProjectContext(input) {
  if (input.actor.role !== "delivery_member") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "\u9700\u8981\u4EA4\u4ED8\u6210\u5458\u6743\u9650");
  }
  const db = input.executor ?? await requireDb3();
  const rows = await db.select({
    projectAssignmentId: deliveryProjectAssignments.id,
    customerUserId: deliveryProjectAssignments.customerUserId,
    roleType: deliveryProjectAssignments.roleType,
    customerUsername: users.username,
    customerName: users.displayName
  }).from(deliveryProjectAssignments).innerJoin(users, eq9(users.id, deliveryProjectAssignments.customerUserId)).where(
    and8(
      eq9(deliveryProjectAssignments.id, input.projectAssignmentId),
      eq9(deliveryProjectAssignments.engineerUserId, input.actor.id),
      eq9(users.role, "user"),
      eq9(users.isActive, true)
    )
  ).limit(1);
  const role = rows[0];
  if (!role || role.roleType !== input.actor.engineerRoleType || input.expectedRoleType && role.roleType !== input.expectedRoleType) {
    throw new AuthServiceError("NOT_FOUND", "\u5F53\u524D\u5BA2\u6237\u9879\u76EE\u5C97\u4F4D\u4E0D\u5B58\u5728");
  }
  if (input.customerUserId !== void 0 && input.customerUserId !== role.customerUserId) {
    throw new AuthServiceError("NOT_FOUND", "\u5BA2\u6237\u672A\u5206\u914D\u7ED9\u5F53\u524D\u5DE5\u7A0B\u5E08");
  }
  const contractRows = await db.select().from(serviceContracts).where(eq9(serviceContracts.userId, role.customerUserId));
  const currentContract = selectPortalContract(
    contractRows
  );
  if (!requiredRolesForPlan(currentContract?.planCode).includes(role.roleType)) {
    const activeTicketRows = await db.select({ id: deliveryTickets.id }).from(deliveryTickets).where(
      and8(
        eq9(
          deliveryTickets.assignedProjectAssignmentId,
          role.projectAssignmentId
        ),
        inArray6(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES)
      )
    ).limit(1);
    if (!activeTicketRows[0]) {
      throw new AuthServiceError("NOT_FOUND", "\u5F53\u524D\u5957\u9910\u672A\u542F\u7528\u8BE5\u5DE5\u7A0B\u5E08\u5C97\u4F4D");
    }
  }
  return {
    ...role,
    customerName: role.customerName || role.customerUsername || `\u5BA2\u6237 ${role.customerUserId}`
  };
}

// shared/knowledge-base-copy.ts
var KNOWLEDGE_COLLECTION_STATUS_COPY = "FrontMind \u6B63\u5728\u6309\u4E1A\u52A1\u5206\u652F\u8FDB\u884C\u8D44\u6599\u91C7\u96C6\u3002\u6B64\u9636\u6BB5\u65E0\u9700\u9010\u9879\u786E\u8BA4\uFF0C\u5B8C\u6210\u540E\u5C06\u76F4\u63A5\u751F\u6210\u53EF\u6838\u9A8C\u77E5\u8BC6\u5E93\u3002";
var HISTORICAL_KNOWLEDGE_COPY_REWRITES = [
  {
    from: "FrontMind \u6B63\u5728\u6309\u4E1A\u52A1\u5206\u652F\u8FDB\u884C\u5E7F\u5EA6\u4F18\u5148\u3001\u6DF1\u5EA6\u53D7\u63A7\u7684\u8D44\u6599\u91C7\u96C6\u3002\u6B64\u9636\u6BB5\u65E0\u9700\u9010\u9879\u786E\u8BA4\uFF0C\u5B8C\u6210\u540E\u5C06\u76F4\u63A5\u751F\u6210\u53EF\u6838\u9A8C\u77E5\u8BC6\u5E93\u3002",
    to: KNOWLEDGE_COLLECTION_STATUS_COPY
  }
];
function normalizeKnowledgeCollectionCopy(value) {
  return HISTORICAL_KNOWLEDGE_COPY_REWRITES.reduce(
    (current, rewrite) => current.replaceAll(rewrite.from, rewrite.to),
    value
  );
}

// server/upstream-output-resources.ts
function normalizedUpstreamFileId(value) {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 255 && !/[\s/?#\u0000-\u001f\u007f]/u.test(normalized) ? normalized : "";
}
function collectUpstreamOutputFileIds(value, ids = /* @__PURE__ */ new Set(), currentKey, depth = 0) {
  if (value === null || value === void 0 || depth > 50) return ids;
  if (typeof value === "string") {
    if ((currentKey === "file_id" || currentKey === "fileId") && value) {
      const fileId = normalizedUpstreamFileId(value);
      if (fileId) ids.add(fileId);
    }
    if (currentKey === "url" || currentKey === "file_url" || currentKey === "fileUrl" || currentKey === "image_url" || currentKey === "imageUrl") {
      const match = value.match(/\/v1\/files\/([^/?#]+)/);
      if (match?.[1]) {
        try {
          const fileId = normalizedUpstreamFileId(decodeURIComponent(match[1]));
          if (fileId) ids.add(fileId);
        } catch {
        }
      }
    }
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUpstreamOutputFileIds(item, ids, void 0, depth + 1);
    }
    return ids;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(
      value
    )) {
      collectUpstreamOutputFileIds(item, ids, key, depth + 1);
    }
  }
  return ids;
}

// server/manus-proxy.ts
var router = Router();
var fileMetaCache = /* @__PURE__ */ new Map();
var CACHE_TTL = 10 * 60 * 1e3;
var downloadTokenCache = /* @__PURE__ */ new Map();
var DOWNLOAD_TOKEN_TTL = 5 * 60 * 1e3;
var MAX_EXTERNAL_DOWNLOAD_BYTES = 64 * 1024 * 1024;
var ExternalDownloadTooLargeError = class extends Error {
  constructor(maxBytes = MAX_EXTERNAL_DOWNLOAD_BYTES) {
    super("External download exceeds the permitted size");
    this.maxBytes = maxBytes;
    this.code = "EXTERNAL_DOWNLOAD_TOO_LARGE";
    this.name = "ExternalDownloadTooLargeError";
  }
};
function isPrivateUpstreamCollectionRequest(method, targetPath) {
  if (!["GET", "HEAD"].includes(method.toUpperCase())) return false;
  const pathname = targetPath.split("?")[0]?.replace(/\/+$/, "") || "/";
  return ["/v1/tasks", "/v1/responses", "/v1/files"].includes(pathname);
}
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
  if (contentType && contentType.toLowerCase().includes("application/pdf"))
    return true;
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
    const sanitized = text2.replace(
      new RegExp(`https?:\\/\\/api\\.${sourceLower}\\.`, "gi"),
      "https://api.frontmind."
    ).replace(
      new RegExp(`https?:\\/\\/www\\.${sourceLower}\\.`, "gi"),
      "https://www.frontmind."
    ).replace(
      new RegExp(`https?:\\/\\/${sourceLower}\\.`, "gi"),
      "https://frontmind."
    ).replace(
      new RegExp(`\\b${escapeRegExp(sourceUpper)}\\b`, "g"),
      "FrontMind"
    ).replace(
      new RegExp(`\\b${escapeRegExp(sourceTitle)}\\b`, "g"),
      "FrontMind"
    ).replace(
      new RegExp(`\\b${escapeRegExp(sourceLower)}\\b`, "g"),
      "frontmind"
    );
    return normalizeKnowledgeCollectionCopy(sanitized);
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
  res.setHeader(
    "content-disposition",
    `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`
  );
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
function responseHeaderValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const normalized = value.filter(
      (item) => ["string", "number", "boolean"].includes(typeof item)
    ).map(String);
    return normalized.length ? normalized.join(", ") : void 0;
  }
  return void 0;
}
function declaredContentLength(headers) {
  if (!headers || typeof headers !== "object") return void 0;
  const raw = responseHeaderValue(
    headers["content-length"]
  );
  if (!raw || !/^\d+$/.test(raw)) return void 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : void 0;
}
function destroyDownloadStream(value) {
  if (value && typeof value === "object" && typeof value.destroy === "function") {
    value.destroy();
  }
}
async function readBoundedExternalDownload(data2, headers, maxBytes = MAX_EXTERNAL_DOWNLOAD_BYTES) {
  const declared = declaredContentLength(headers);
  if (declared !== void 0 && declared > maxBytes) {
    destroyDownloadStream(data2);
    throw new ExternalDownloadTooLargeError(maxBytes);
  }
  if (data2 && typeof data2 === "object" && Symbol.asyncIterator in data2 && typeof data2[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let totalBytes = 0;
    try {
      for await (const chunk of data2) {
        const buffer2 = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
        totalBytes += buffer2.length;
        if (totalBytes > maxBytes) {
          throw new ExternalDownloadTooLargeError(maxBytes);
        }
        chunks.push(buffer2);
      }
    } catch (error) {
      destroyDownloadStream(data2);
      throw error;
    }
    return Buffer.concat(chunks, totalBytes);
  }
  const buffer = Buffer.isBuffer(data2) ? data2 : data2 instanceof Uint8Array ? Buffer.from(data2) : data2 instanceof ArrayBuffer ? Buffer.from(data2) : Buffer.from(String(data2 ?? ""));
  if (buffer.length > maxBytes) {
    throw new ExternalDownloadTooLargeError(maxBytes);
  }
  return buffer;
}
function isExternalDownloadTooLarge(error) {
  if (error instanceof ExternalDownloadTooLargeError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error;
  return candidate.code === "ERR_BAD_RESPONSE" && typeof candidate.message === "string" && candidate.message.includes("maxContentLength");
}
function sendExternalDownloadTooLarge(res) {
  return res.status(413).json({
    error: {
      message: "\u6587\u4EF6\u8D85\u8FC7\u5141\u8BB8\u7684\u4E0B\u8F7D\u5927\u5C0F",
      code: "EXTERNAL_DOWNLOAD_TOO_LARGE"
    }
  });
}
async function fetchBoundedExternalDownload(url, options) {
  const response = await axios2.get(url, {
    ...options,
    responseType: "stream",
    maxContentLength: MAX_EXTERNAL_DOWNLOAD_BYTES
  });
  const data2 = await readBoundedExternalDownload(
    response.data,
    response.headers
  );
  return { ...response, data: data2 };
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
function publicUpstreamPayload(value, apiKey) {
  return deepSanitizeJson(
    redactSensitivePayload(value, {
      secrets: [apiKey]
    })
  );
}
function publicUpstreamFilePayload(value, apiKey) {
  const sanitized = publicUpstreamPayload(value, apiKey);
  if (!value || typeof value !== "object" || Array.isArray(value) || !sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return sanitized;
  }
  const rawUploadUrl = value.upload_url;
  if (typeof rawUploadUrl !== "string") return sanitized;
  return {
    ...sanitized,
    upload_url: assertSafeExternalUrl(rawUploadUrl)
  };
}
function isPublicFilePayloadRequest(method, targetPath) {
  const pathname = targetPath.split("?")[0]?.replace(/\/+$/, "") || "/";
  return method.toUpperCase() === "POST" && pathname === "/v1/files" || ["GET", "HEAD"].includes(method.toUpperCase()) && /^\/v1\/files\/[^/]+$/.test(pathname);
}
var PUBLIC_TASK_TOP_LEVEL_SCALAR_KEYS = [
  "id",
  "task_id",
  "response_id",
  "object",
  "status",
  "model",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "credit_usage",
  "task_url",
  "share_url",
  "task_title",
  "title"
];
var PUBLIC_TASK_OUTPUT_SCALAR_KEYS = [
  "id",
  "type",
  "status",
  "name",
  "call_id",
  "text",
  "message",
  "output",
  "file_id",
  "fileId",
  "url",
  "file_url",
  "fileUrl",
  "image_url",
  "imageUrl",
  "filename",
  "fileName",
  "mime_type",
  "mimeType"
];
var PUBLIC_TASK_CONTENT_SCALAR_KEYS = [
  "type",
  "text",
  "file_id",
  "fileId",
  "file_url",
  "fileUrl",
  "image_url",
  "imageUrl",
  "url",
  "filename",
  "fileName",
  "mime_type",
  "mimeType"
];
var PUBLIC_TASK_METADATA_SCALAR_KEYS = [
  "credit_usage",
  "task_url",
  "share_url",
  "task_title",
  "title"
];
var PUBLIC_TASK_ERROR_SCALAR_KEYS = [
  "message",
  "code",
  "type",
  "param",
  "status"
];
var PUBLIC_TASK_ANNOTATION_SCALAR_KEYS = [
  "type",
  "url",
  "title",
  "start_index",
  "end_index",
  "file_id",
  "fileId",
  "filename",
  "fileName",
  "index",
  "quote"
];
var PUBLIC_TASK_ACTION_SCALAR_KEYS = [
  "type",
  "url",
  "query",
  "selector",
  "x",
  "y"
];
var PUBLIC_TASK_TELEMETRY_KEY = /^(?:(?:input|output)_(?:tokens?|credits?|cost|characters|count)(?:_|$)|(?:id|name|label|kind|version|status|stage|step|phase|progress|percent|percentage|current|total|completed|failed|success|successful|count|usage|credit|credits|token|tokens|cost|duration|elapsed|remaining|message|summary|visited|links|pages|characters|images|documents|queries|saved|downloaded|parsed|started|finished|created|updated)(?:_|$))/i;
function isPublicScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function pickPublicScalars(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value;
  const result = {};
  for (const key of keys) {
    if (isPublicScalar(source[key])) {
      result[key] = source[key];
    }
  }
  return result;
}
function publicTaskTelemetry(value, depth = 0) {
  if (value === null || depth > 8) return void 0;
  if (isPublicScalar(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => publicTaskTelemetry(item, depth + 1)).filter((item) => item !== void 0);
  }
  if (typeof value !== "object") return void 0;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!PUBLIC_TASK_TELEMETRY_KEY.test(key)) continue;
    const sanitized = publicTaskTelemetry(item, depth + 1);
    if (sanitized !== void 0) result[key] = sanitized;
  }
  return result;
}
function publicTaskAnnotations(value) {
  if (!Array.isArray(value)) return void 0;
  const annotations = value.map((item) => pickPublicScalars(item, PUBLIC_TASK_ANNOTATION_SCALAR_KEYS)).filter((item) => Object.keys(item).length > 0);
  return annotations.length > 0 ? annotations : void 0;
}
function publicTaskContent(value) {
  if (!Array.isArray(value)) return [];
  const content = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item;
    const type = typeof source.type === "string" ? source.type.toLowerCase() : "";
    if (type.startsWith("input_") || type.includes("instruction")) continue;
    const sanitized = pickPublicScalars(
      source,
      PUBLIC_TASK_CONTENT_SCALAR_KEYS
    );
    const annotations = publicTaskAnnotations(source.annotations);
    if (annotations) sanitized.annotations = annotations;
    if (Object.keys(sanitized).length > 0) content.push(sanitized);
  }
  return content;
}
function publicTaskOutput(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item;
    const role = typeof source.role === "string" ? source.role.toLowerCase() : "";
    const type = typeof source.type === "string" ? source.type.toLowerCase() : "";
    if (role === "user" || role === "system" || type.startsWith("input_") || type.includes("instruction")) {
      continue;
    }
    const sanitized = pickPublicScalars(
      source,
      PUBLIC_TASK_OUTPUT_SCALAR_KEYS
    );
    if (role === "assistant") sanitized.role = "assistant";
    const content = publicTaskContent(source.content);
    if (content.length > 0) sanitized.content = content;
    if (Array.isArray(source.summary)) {
      const summary = source.summary.map((entry) => pickPublicScalars(entry, ["type", "text"])).filter((entry) => Object.keys(entry).length > 0);
      if (summary.length > 0) sanitized.summary = summary;
    }
    if (Array.isArray(source.queries)) {
      const queries = source.queries.filter(
        (query) => typeof query === "string"
      );
      if (queries.length > 0) sanitized.queries = queries;
    }
    const action = pickPublicScalars(
      source.action,
      PUBLIC_TASK_ACTION_SCALAR_KEYS
    );
    if (Object.keys(action).length > 0) sanitized.action = action;
    if (Object.keys(sanitized).length > 0) output.push(sanitized);
  }
  return output;
}
function redactPublicTaskValues(value, apiKey) {
  if (typeof value === "string") {
    return redactSensitiveText(value, [apiKey]);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicTaskValues(item, apiKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactPublicTaskValues(item, apiKey)
      ])
    );
  }
  return value;
}
function publicUpstreamTaskPayload(value, apiKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value;
  const result = pickPublicScalars(
    source,
    PUBLIC_TASK_TOP_LEVEL_SCALAR_KEYS
  );
  const metadata = pickPublicScalars(
    source.metadata,
    PUBLIC_TASK_METADATA_SCALAR_KEYS
  );
  if (Object.keys(metadata).length > 0) result.metadata = metadata;
  if (Array.isArray(source.output)) {
    result.output = publicTaskOutput(source.output);
  }
  const error = pickPublicScalars(source.error, PUBLIC_TASK_ERROR_SCALAR_KEYS);
  if (Object.keys(error).length > 0) result.error = error;
  const usage = publicTaskTelemetry(source.usage);
  if (usage !== void 0 && (typeof usage !== "object" || Object.keys(usage).length > 0)) {
    result.usage = usage;
  }
  const progress = publicTaskTelemetry(source.progress);
  if (progress !== void 0 && (typeof progress !== "object" || Object.keys(progress).length > 0)) {
    result.progress = progress;
  }
  return deepSanitizeJson(redactPublicTaskValues(result, apiKey));
}
function isPublicTaskPayloadRequest(method, targetPath) {
  const path3 = targetPath.split("?")[0].replace(/\/+$/, "");
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "POST" && (path3 === "/v1/tasks" || path3 === "/v1/responses")) {
    return true;
  }
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") return false;
  return /^\/v1\/(?:tasks|responses)\/[^/]+$/.test(path3);
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
    const url = String(object.file_url ?? object.fileUrl ?? object.url ?? "");
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
      console.log(
        `[FrontMind Proxy] Sanitized source-brand references in text file: ${filename}`
      );
      return { buffer: Buffer.from(sanitized, "utf-8"), wasSanitized: true };
    }
    return { buffer: data2, wasSanitized: false };
  } catch (e) {
    return { buffer: data2, wasSanitized: false };
  }
}
async function sanitizePdfBuffer(pdfBuffer) {
  try {
    const {
      PDFDocument,
      PDFName,
      decodePDFRawStream,
      PDFRawStream,
      StandardFonts,
      rgb,
      PDFHexString
    } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true
    });
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
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getTitle(),
      (value) => pdfDoc.setTitle(value)
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getSubject(),
      (value) => pdfDoc.setSubject(value)
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getAuthor(),
      (value) => pdfDoc.setAuthor(value)
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getCreator(),
      (value) => pdfDoc.setCreator(value)
    );
    setSanitizedPdfStringMetadata(
      () => pdfDoc.getProducer(),
      (value) => pdfDoc.setProducer(value)
    );
    try {
      const infoRef = context.trailerInfo?.Info;
      const infoDict = infoRef ? context.lookup(infoRef) : void 0;
      const metadataKeys = [
        "Title",
        "Subject",
        "Author",
        "Creator",
        "Producer",
        "Keywords"
      ];
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
        if (!cmapText.includes("beginbfchar") && !cmapText.includes("beginbfrange"))
          return;
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
          const compressed = zlib.deflateSync(Buffer.from(sanitized, "latin1"));
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
          advance += estimateGlyphAdvance(
            glyph.toLowerCase().padStart(4, "0"),
            pattern.glyphToUnicode,
            fontSize
          );
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
        streamRefToPageIndex.set(
          `${content.objectNumber} ${content.generationNumber} R`,
          pageIndex
        );
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
            const exactRefPattern = new RegExp(
              `(^|\\D)${refObjectNumber}\\s+0\\s+R(\\D|$)`
            );
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
          const tdTjMatch = line.match(
            /^([\d.eE+-]+)\s+([\d.eE+-]+)\s+Td\s+<([0-9a-fA-F]+)>\s+Tj$/
          );
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
            lines[i] = originalLine.replace(
              arrayRegex,
              (fullMatch, body) => {
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
                    orderedTokens.push({
                      kind: "number",
                      value: Number(tokenMatch[2])
                    });
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
                      const matchAdvance = calculateTjGlyphAdvance(
                        orderedTokens,
                        hexTokens,
                        gi,
                        pattern,
                        currentFontSize
                      );
                      const matchWidth = Math.max(
                        calculateTjGlyphAdvance(
                          orderedTokens,
                          hexTokens,
                          gi + patLen,
                          pattern,
                          currentFontSize
                        ) - matchAdvance,
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
                        replacementText: replacementTextForTarget(
                          pattern.target
                        ),
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
              }
            );
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
              console.log(
                `[FrontMind Proxy] FOUND "${pattern.target}" in PDF stream ${ref.toString()}`
              );
              for (let j = 0; j < patLen; j++) {
                const tj = tjInfos[i + j];
                const oldHex = tj.glyphHexInLine;
                const newHex = pattern.spaceGlyph.toUpperCase().padStart(oldHex.length, "0");
                lines[tj.lineIndex] = lines[tj.lineIndex].replace(
                  `<${oldHex}>`,
                  `<${newHex}>`
                );
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
        const replacementWidth = font.widthOfTextAtSize(
          replacementText,
          pos.effectiveFontSize
        );
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
      console.log(
        `[FrontMind Proxy] PDF sanitized: ${totalModified} stream(s) modified, ${overlayPositions.length} overlay(s) applied, metadata=${pdfMetadataModified}`
      );
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
    console.error(
      `[FrontMind Proxy] Office XML sanitization error: ${err.message}`
    );
    return { buffer: data2, wasSanitized: false };
  }
}
async function sanitizeFileBuffer(data2, filename, contentType) {
  if (isPdfFile(filename, contentType) || isPdfMagicBytes(data2)) {
    console.log(
      `[FrontMind Proxy] Detected PDF file: ${filename} (magic=${isPdfMagicBytes(data2)}, ext/ct=${isPdfFile(filename, contentType)})`
    );
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
      // Redirecting a SigV4 URL changes the signed request target and produces
      // a misleading authentication failure. Presigned uploads must be exact.
      maxRedirects: 0,
      maxBodyLength: Infinity,
      maxContentLength: 1024 * 1024,
      signal: controller.signal,
      validateStatus: () => true
    });
    console.log(`[FrontMind Proxy] Proxy-upload response: ${response.status}`);
    if (response.status >= 200 && response.status < 300) {
      res.status(response.status).send("");
      return;
    }
    res.status(response.status).json({
      error: {
        message: response.status >= 400 && response.status < 500 ? "\u4E0A\u4F20\u5730\u5740\u65E0\u6548\u6216\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6587\u4EF6\u540E\u91CD\u8BD5" : "\u6587\u4EF6\u5B58\u50A8\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "UPSTREAM_UPLOAD_REJECTED"
      }
    });
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
      const credential = await getEffectiveDecryptedCredentialForAccount(
        req.frontmindUser.id
      );
      const asset = await preparedFileService.registerExternal({
        ownerUserId: req.frontmindUser.id,
        credentialId: credential?.id || "external",
        projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
        url: targetUrl,
        filename: candidateFilename
      });
      if (asset.status !== "ready") {
        return res.status(202).json(asset);
      }
      const suffix = disposition === "attachment" ? "?download=1" : "";
      return res.redirect(307, `${asset.contentUrl}${suffix}`);
    }
    console.log(
      `[FrontMind Proxy] Proxy-download: ${safeUrlForLog(targetUrl)}`
    );
    const response = await fetchBoundedExternalDownload(targetUrl, {
      ...safeExternalRequestOptions,
      timeout: 12e4,
      validateStatus: () => true
    });
    console.log(
      `[FrontMind Proxy] Proxy-download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`
    );
    res.status(response.status);
    const rawBuffer = Buffer.from(response.data);
    const upstreamContentType = responseHeaderValue(
      response.headers["content-type"]
    );
    const urlFilename = ensureFilenameMatchesContent(
      candidateFilename,
      rawBuffer,
      upstreamContentType
    );
    const finalContentType = normalizeContentTypeForBuffer(
      urlFilename,
      rawBuffer,
      upstreamContentType
    );
    for (const header of ["cache-control", "etag", "last-modified"]) {
      const value = responseHeaderValue(response.headers[header]);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("content-type", finalContentType);
    setSafeContentDisposition(
      res,
      disposition,
      urlFilename
    );
    const { buffer: sanitizedBuffer, wasSanitized } = await sanitizeFileBuffer(
      rawBuffer,
      urlFilename,
      finalContentType
    );
    if (wasSanitized) {
      res.setHeader("content-length", String(sanitizedBuffer.length));
    } else {
      const contentLength = responseHeaderValue(
        response.headers["content-length"]
      );
      if (contentLength) res.setHeader("content-length", contentLength);
    }
    res.send(sanitizedBuffer);
  } catch (error) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
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
    console.error(
      `[FrontMind Proxy] File metadata request failed: ${response.status}`
    );
    return null;
  }
  const data2 = response.data;
  console.log(
    `[FrontMind Proxy] File metadata: id=${data2.id}, filename=${data2.filename}, status=${data2.status}, has_upload_url=${!!data2.upload_url}`
  );
  if (data2.upload_url) {
    const meta = {
      upload_url: data2.upload_url,
      filename: data2.filename || fileId
    };
    setCachedMeta(fileId, meta);
    return meta;
  }
  return { upload_url: "", filename: data2.filename || fileId };
}
async function downloadFromS3(res, s3Url, filename, disposition = "inline") {
  const safeS3Url = assertSafeExternalUrl(s3Url);
  console.log(
    `[FrontMind Proxy] Downloading from object storage: ${safeUrlForLog(safeS3Url)}`
  );
  const response = await fetchBoundedExternalDownload(safeS3Url, {
    ...safeExternalRequestOptions,
    timeout: 12e4,
    validateStatus: () => true
  });
  console.log(
    `[FrontMind Proxy] S3 download response: ${response.status}, content-type: ${response.headers["content-type"]}, size: ${response.data?.length || 0}`
  );
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
  const upstreamContentType = responseHeaderValue(
    response.headers["content-type"]
  );
  const finalFilename = ensureFilenameMatchesContent(
    filename,
    rawBuffer,
    upstreamContentType
  );
  const finalContentType = normalizeContentTypeForBuffer(
    finalFilename,
    rawBuffer,
    upstreamContentType
  );
  for (const header of ["cache-control", "etag", "last-modified"]) {
    const value = responseHeaderValue(response.headers[header]);
    if (value) res.setHeader(header, value);
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
async function handleFileDownload(res, baseUrl, fileId, apiKey, disposition = "inline", ownerUserId, credentialId, projectAssignmentId) {
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
      projectAssignmentId,
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
    console.warn(
      `[FrontMind Proxy] No upload_url for file ${fileId}, trying direct API download`
    );
    const cleanBaseUrl = baseUrl.replace(/\/$/, "");
    const contentUrl = `${cleanBaseUrl}/v1/files/${fileId}/content`;
    try {
      const response = await fetchBoundedExternalDownload(contentUrl, {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 12e4,
        validateStatus: () => true
      });
      const upstreamContentType = responseHeaderValue(
        response.headers["content-type"]
      );
      if (response.status === 200 && upstreamContentType !== "application/json") {
        console.log(
          `[FrontMind Proxy] Direct /content download succeeded: ${response.status}`
        );
        res.status(200);
        for (const header of ["content-type", "content-disposition"]) {
          const value = responseHeaderValue(response.headers[header]);
          if (value) {
            if (header === "content-disposition") {
              res.setHeader(header, sanitizeText(value));
            } else {
              res.setHeader(header, value);
            }
          }
        }
        const rawBuffer = Buffer.from(response.data);
        const finalFilename = ensureFilenameMatchesContent(
          meta.filename,
          rawBuffer,
          upstreamContentType
        );
        const finalContentType = normalizeContentTypeForBuffer(
          finalFilename,
          rawBuffer,
          upstreamContentType
        );
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
      if (isExternalDownloadTooLarge(e)) throw e;
      console.warn(
        "[FrontMind Proxy] Direct /content download failed:",
        safeErrorForLog(e, { secrets: [apiKey] })
      );
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
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    cleanupExpiredDownloadTokens();
    const fileId = req.body?.fileId || "";
    if (!apiKey) {
      return res.status(401).json({
        error: { message: "\u5C1A\u672A\u914D\u7F6E API Key", code: "MISSING_API_KEY" }
      });
    }
    if (!fileId) {
      return res.status(400).json({
        error: { message: "Missing fileId", code: "MISSING_FILE_ID" }
      });
    }
    const token = randomUUID3();
    if (!req.frontmindUser || !req.frontmindCredential) {
      return res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
    }
    downloadTokenCache.set(token, {
      fileId,
      userId: req.frontmindUser.id,
      credentialId: req.frontmindCredential.id,
      projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
      apiKey,
      baseUrl,
      createdAt: Date.now()
    });
    res.json({
      downloadUrl: `/api/frontmind/download/${token}`,
      expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL
    });
  } catch (error) {
    console.error(
      "[FrontMind Proxy] Create download token error:",
      safeErrorForLog(error, { secrets: [apiKey] })
    );
    res.status(500).json({
      error: {
        message: "\u521B\u5EFA\u4E0B\u8F7D\u94FE\u63A5\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "DOWNLOAD_TOKEN_ERROR"
      }
    });
  }
});
router.get("/download/:token", async (req, res) => {
  let logSecret = "";
  try {
    cleanupExpiredDownloadTokens();
    const token = req.params.token;
    const data2 = downloadTokenCache.get(token);
    if (!data2) {
      return res.status(410).json({
        error: {
          message: "Download link expired",
          code: "DOWNLOAD_LINK_EXPIRED"
        }
      });
    }
    logSecret = data2.apiKey;
    if (!req.frontmindUser || req.frontmindUser.id !== data2.userId) {
      return res.status(403).json({
        error: {
          message: "\u4E0B\u8F7D\u94FE\u63A5\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7",
          code: "DOWNLOAD_FORBIDDEN"
        }
      });
    }
    if (req.frontmindUser.role === "delivery_member") {
      if (!data2.projectAssignmentId) {
        return res.status(403).json({
          error: {
            message: "\u4E0B\u8F7D\u94FE\u63A5\u7F3A\u5C11\u5BA2\u6237\u9879\u76EE\u4E0A\u4E0B\u6587",
            code: "DELIVERY_PROJECT_CONTEXT_FORBIDDEN"
          }
        });
      }
      await assertDeliveryProjectContext({
        actor: req.frontmindUser,
        projectAssignmentId: data2.projectAssignmentId
      });
    }
    downloadTokenCache.delete(token);
    await handleFileDownload(
      res,
      data2.baseUrl,
      data2.fileId,
      data2.apiKey,
      "attachment",
      data2.userId,
      data2.credentialId,
      data2.projectAssignmentId
    );
  } catch (error) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    console.error(
      "[FrontMind Proxy] Direct token download error:",
      safeErrorForLog(error, { secrets: [logSecret] })
    );
    res.status(500).json({
      error: {
        message: "\u4E0B\u8F7D\u94FE\u63A5\u5DF2\u5931\u6548\u6216\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25",
        code: "DIRECT_DOWNLOAD_ERROR"
      }
    });
  }
});
router.get("/v1/files/:fileId", async (req, res) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    const fileId = req.params.fileId;
    await handleFileDownload(
      res,
      baseUrl,
      fileId,
      apiKey,
      "inline",
      req.frontmindUser?.id,
      req.frontmindCredential?.id,
      req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null
    );
  } catch (error) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    console.error(
      "[FrontMind Proxy] File download error:",
      safeErrorForLog(error, { secrets: [apiKey] })
    );
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "FILE_DOWNLOAD_ERROR"
      }
    });
  }
});
router.get("/v1/files/:fileId/content", async (req, res) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    const fileId = req.params.fileId;
    await handleFileDownload(
      res,
      baseUrl,
      fileId,
      apiKey,
      "inline",
      req.frontmindUser?.id,
      req.frontmindCredential?.id,
      req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null
    );
  } catch (error) {
    if (isExternalDownloadTooLarge(error)) {
      return sendExternalDownloadTooLarge(res);
    }
    console.error(
      "[FrontMind Proxy] File content download error:",
      safeErrorForLog(error, { secrets: [apiKey] })
    );
    res.status(500).json({
      error: {
        message: "\u6587\u4EF6\u5185\u5BB9\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: "FILE_CONTENT_ERROR"
      }
    });
  }
});
router.get("/account-credit-usage", async (req, res) => {
  if (!req.frontmindUser) {
    res.status(401).json({ error: { message: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHORIZED" } });
    return;
  }
  if (req.frontmindUser.role !== "admin") {
    res.status(403).json({ error: { message: "\u4EC5\u7BA1\u7406\u5458\u53EF\u67E5\u770B\u79EF\u5206", code: "FORBIDDEN" } });
    return;
  }
  try {
    const result = await getAccountMonthlyCreditUsage(req.frontmindUser.id);
    res.json(result);
  } catch (error) {
    console.error(
      "[FrontMind Proxy] Credit usage error",
      safeErrorForLog(error, {
        secrets: [req.frontmindCredential?.apiKey]
      })
    );
    res.status(503).json({
      error: {
        message: "\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u5F53\u524D Key \u7684\u79EF\u5206\u4F7F\u7528\u60C5\u51B5",
        code: "CREDIT_USAGE_UNAVAILABLE"
      }
    });
  }
});
router.get("/credential-check", async (req, res) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    const response = await axios2.get(
      `${baseUrl.replace(/\/$/, "")}/v1/tasks?limit=1`,
      {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        },
        timeout: 15e3,
        validateStatus: () => true
      }
    );
    if (response.status === 401 || response.status === 403) {
      res.status(401).json({
        error: { message: "API Key \u65E0\u6548", code: "INVALID_CREDENTIAL" }
      });
      return;
    }
    if (response.status < 200 || response.status >= 300) {
      res.status(503).json({
        error: {
          message: "\u4E0A\u6E38\u670D\u52A1\u6682\u65F6\u65E0\u6CD5\u9A8C\u8BC1 API Key",
          code: "UPSTREAM_UNAVAILABLE"
        }
      });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(
      "[FrontMind Proxy] Credential check error",
      safeErrorForLog(error, { secrets: [apiKey] })
    );
    res.status(503).json({
      error: {
        message: "\u4E0A\u6E38\u670D\u52A1\u6682\u65F6\u65E0\u6CD5\u9A8C\u8BC1 API Key",
        code: "UPSTREAM_UNAVAILABLE"
      }
    });
  }
});
router.all("/*", async (req, res) => {
  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  try {
    if (!apiKey) {
      return res.status(401).json({
        error: { message: "\u5C1A\u672A\u914D\u7F6E API Key", code: "MISSING_API_KEY" }
      });
    }
    const targetPath = req.originalUrl.replace(/^\/api\/frontmind/, "");
    if (isPrivateUpstreamCollectionRequest(req.method, targetPath)) {
      res.status(403).json({
        error: {
          message: "\u4EFB\u52A1\u4E0E\u6587\u4EF6\u76EE\u5F55\u4EC5\u6309\u5F53\u524D\u8D26\u53F7\u7684\u672C\u5730\u8BB0\u5F55\u5C55\u793A",
          code: "UPSTREAM_COLLECTION_FORBIDDEN"
        }
      });
      return;
    }
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
      const resourceId = String(
        response.data.id || response.data.task_id || ""
      );
      const isTaskCreate = req.method === "POST" && targetPath.split("?")[0] === "/v1/tasks";
      const isFileCreate = req.method === "POST" && targetPath.split("?")[0] === "/v1/files";
      if (resourceId && (isTaskCreate || isFileCreate)) {
        await recordUpstreamResource({
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: isTaskCreate ? "task" : "file",
          upstreamId: resourceId,
          projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null
        });
        if (isTaskCreate && req.frontmindUser.role === "delivery_member" && req.frontmindDeliveryProjectContext) {
          await writeWorkspaceAuditEvent({
            actor: req.frontmindUser,
            action: "delivery_member.agent.task_created",
            targetType: "upstream_task",
            targetId: resourceId,
            workspaceUserId: null,
            metadata: {
              projectAssignmentId: req.frontmindDeliveryProjectContext.projectAssignmentId,
              customerUserId: req.frontmindDeliveryProjectContext.customerUserId,
              roleType: req.frontmindDeliveryProjectContext.roleType,
              customerName: req.frontmindDeliveryProjectContext.customerName
            }
          });
        }
      }
      for (const fileId of collectUpstreamOutputFileIds(response.data)) {
        const registration = {
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: "file",
          upstreamId: fileId,
          projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null
        };
        let recorded = false;
        let lastError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await recordUpstreamResource(registration);
            recorded = true;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) {
              await new Promise(
                (resolve) => setTimeout(resolve, 50 * 2 ** attempt)
              );
            }
          }
        }
        if (recorded) continue;
        console.error(
          "[FrontMind Proxy] Output file registration pending",
          safeErrorForLog(lastError)
        );
        res.setHeader("X-FrontMind-Resource-Registration", "pending");
        const retryTimer = setTimeout(() => {
          void recordUpstreamResource(registration).catch((error) => {
            console.error(
              "[FrontMind Proxy] Output file retry failed",
              safeErrorForLog(error)
            );
          });
        }, 1e3);
        retryTimer.unref?.();
      }
      for (const descriptor of collectOutputPdfDescriptors(response.data)) {
        try {
          if (descriptor.fileId) {
            await preparedFileService.registerFile({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
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
              projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
              fileId: decodeURIComponent(match[1]),
              filename: descriptor.filename
            });
          } else {
            await preparedFileService.registerExternal({
              ownerUserId: req.frontmindUser.id,
              credentialId: req.frontmindCredential.id,
              projectAssignmentId: req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
              url: descriptor.url,
              filename: descriptor.filename
            });
          }
        } catch (error) {
          console.warn(
            "[PreparedFiles] Auto-registration failed",
            safeErrorForLog(error, { secrets: [apiKey] })
          );
        }
      }
    }
    const publicResponse = typeof response.data === "object" ? isPublicTaskPayloadRequest(req.method, targetPath) ? publicUpstreamTaskPayload(response.data, apiKey) : isPublicFilePayloadRequest(req.method, targetPath) ? publicUpstreamFilePayload(response.data, apiKey) : publicUpstreamPayload(response.data, apiKey) : typeof response.data === "string" ? sanitizeText(redactSensitiveText(response.data, [apiKey])) : response.data;
    if (publicResponse && typeof publicResponse === "object" && !Array.isArray(publicResponse) && Array.isArray(publicResponse.output)) {
      const publicRecord = publicResponse;
      const outputSummary = publicRecord.output.map(
        (item, i) => `${i}:${item.type || "message"}${item.id ? "(" + item.id.slice(0, 8) + ")" : ""}`
      ).join(", ");
      console.log(
        `[FrontMind Proxy] Response: ${response.status} id=${String(publicRecord.id || "").slice(0, 12)} status=${String(publicRecord.status || "")} output=[${publicRecord.output.length} items: ${outputSummary.slice(0, 300)}]`
      );
    } else {
      console.log(`[FrontMind Proxy] Response: ${response.status}`);
    }
    res.status(response.status);
    const contentType = responseHeaderValue(response.headers["content-type"]);
    if (contentType) res.setHeader("content-type", contentType);
    if (typeof publicResponse === "object") {
      res.json(publicResponse);
    } else if (typeof publicResponse === "string") {
      res.send(publicResponse);
    } else {
      res.send(publicResponse);
    }
  } catch (error) {
    console.error(
      "[FrontMind Proxy] Error:",
      safeErrorForLog(error, { secrets: [apiKey] })
    );
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
async function getPdfInfo(filePath) {
  return new Promise(
    (resolve, reject) => {
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
        resolve({ pageCount: pages, infoText: stdout });
      });
    }
  );
}
async function containsSourceBrand(filePath, onActivity) {
  const sourceBrand = ["ma", "nus"].join("");
  const brandPattern = new RegExp(`\\b${sourceBrand}\\b`, "i");
  return new Promise((resolve, reject) => {
    const child = spawn2("pdftotext", [filePath, "-"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let tail = "";
    let found = false;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      onActivity?.();
      const candidate = `${tail}${String(chunk)}`;
      if (!found && brandPattern.test(candidate)) {
        found = true;
        child.kill("SIGTERM");
      }
      tail = candidate.slice(-64);
    });
    child.stderr.on("data", (chunk) => {
      onActivity?.();
      stderr = `${stderr}${String(chunk)}`.slice(-16e3);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      if (found) {
        finish(() => resolve(true));
      } else if (code === 0) {
        finish(() => resolve(false));
      } else {
        finish(
          () => reject(
            new Error(
              `pdftotext exited with ${code}: ${stderr.slice(-2e3)}`
            )
          )
        );
      }
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
  const sourceInfo = await getPdfInfo(data.inputPath);
  const pageCount = sourceInfo.pageCount;
  send({ type: "progress", phase: "sanitizing", page: 0, pageCount });
  const sourceBrand = ["ma", "nus"].join("");
  const sourceBrandPattern = new RegExp(`\\b${sourceBrand}\\b`, "i");
  const sourceTextContainsBrand = await containsSourceBrand(
    data.inputPath,
    () => send({
      type: "progress",
      phase: "sanitizing",
      page: 0,
      pageCount
    })
  );
  const needsSanitization = sourceTextContainsBrand || sourceBrandPattern.test(sourceInfo.infoText);
  let wasSanitized;
  if (!needsSanitization) {
    await fs3.copyFile(data.inputPath, data.outputPath);
    wasSanitized = false;
    send({ type: "progress", phase: "optimizing", pageCount });
  } else if (stat.size >= data.largePdfThresholdBytes) {
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
  const outputInfo = await getPdfInfo(data.outputPath);
  const outputPageCount = outputInfo.pageCount;
  if (outputPageCount !== pageCount) {
    throw Object.assign(
      new Error(
        `\u5904\u7406\u524D\u540E\u9875\u6570\u4E0D\u4E00\u81F4\uFF1A${pageCount} -> ${outputPageCount}`
      ),
      { code: "PDF_PAGE_COUNT_MISMATCH" }
    );
  }
  const outputContainsBrand = needsSanitization ? await containsSourceBrand(
    data.outputPath,
    () => send({ type: "progress", phase: "optimizing", pageCount })
  ) : false;
  if (outputContainsBrand || sourceBrandPattern.test(outputInfo.infoText)) {
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
