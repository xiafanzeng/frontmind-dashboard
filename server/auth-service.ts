import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  ne,
} from "drizzle-orm";
import type { Request } from "express";
import { COOKIE_NAME } from "../shared/const";
import {
  apiCredentials,
  apiKeyOwnership,
  conversations,
  sessions,
  upstreamResources,
  users,
  type ApiCredential,
  type UpstreamResource,
  type User,
} from "../drizzle/schema";
import { getDb } from "./db";
import { getUpstreamBaseUrl } from "./upstream-config";

export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_VERSION = "v1";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const DUMMY_PASSWORD_HASH =
  "scrypt$v1$16384$8$1$RnJvbnRNaW5kRHVtbXkwMQ==$v5gxAmM2/2xmlb6BhcM2tE6ivMw+PG8CtewPcO0jJcY86Ak1/I0770tV9pqMocaZiA4z4hu7Obq9HgC6hFn4qw==";

export type AuthServiceErrorCode =
  | "ACCOUNT_DISABLED"
  | "CONFLICT"
  | "DATABASE_UNAVAILABLE"
  | "INVALID_CREDENTIAL"
  | "INVALID_MASTER_KEY"
  | "INVALID_PASSWORD"
  | "LAST_ADMIN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE";

export class AuthServiceError extends Error {
  constructor(
    public readonly code: AuthServiceErrorCode,
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export type AuthenticatedUser = Omit<
  Pick<
    User,
    | "id"
    | "openId"
    | "username"
    | "displayName"
    | "name"
    | "email"
    | "loginMethod"
    | "role"
    | "isActive"
    | "createdAt"
    | "updatedAt"
    | "lastSignedIn"
  >,
  "username" | "displayName"
> & {
  username: string;
  displayName: string | null;
};

export type DecryptedCredential = {
  id: string;
  userId: number;
  version: number;
  apiKey: string;
  fingerprint: string;
  status: "active" | "retired";
  verifiedAt: Date | null;
};

export type CredentialStatus = {
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  verifiedAt: number | null;
};

type LoginAttempt = {
  failures: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

function toAuthenticatedUser(user: User): AuthenticatedUser {
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
    lastSignedIn: user.lastSignedIn,
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

function runScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      }
    );
  });
}

export function normalizeUsername(username: string) {
  return username.normalize("NFKC").trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await runScrypt(password, salt);
  return [
    "scrypt",
    SCRYPT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string
): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== SCRYPT_VERSION) {
    return false;
  }

  const n = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

  try {
    const salt = Buffer.from(parts[5]!, "base64");
    const expected = Buffer.from(parts[6]!, "base64");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await runScrypt(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function getSessionTokenFromRequest(req: Request): string | null {
  try {
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    return cookies[COOKIE_NAME] || null;
  } catch {
    return null;
  }
}

export async function createSession(userId: number) {
  const db = await requireDb();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session = {
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now + SESSION_DURATION_MS),
    lastSeenAt: new Date(now),
  };

  await db.insert(sessions).values(session);
  return { token, session };
}

export async function authenticateRequest(
  req: Request
): Promise<AuthenticatedUser | null> {
  const token = getSessionTokenFromRequest(req);
  if (!token) return null;

  const db = await getDb();
  if (!db) return null;

  const tokenHash = hashSessionToken(token);
  const rows = await db
    .select({ user: users, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  return toAuthenticatedUser(row.user);
}

export async function revokeSessionToken(token: string | null | undefined) {
  if (!token) return;
  const db = await getDb();
  if (!db) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        isNull(sessions.revokedAt)
      )
    );
}

export async function revokeAllUserSessions(
  userId: number,
  exceptToken?: string | null
) {
  const db = await requireDb();
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptToken) {
    conditions.push(ne(sessions.tokenHash, hashSessionToken(exceptToken)));
  }
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions));
}

function loginAttemptKey(username: string, clientAddress: string) {
  return `${normalizeUsername(username)}\u0000${clientAddress}`;
}

function assertLoginAllowed(key: string) {
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

function recordLoginFailure(key: string) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now >= current.resetAt) {
    loginAttempts.set(key, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    current.failures += 1;
  }

  // Bound memory if a public endpoint is sprayed with distinct identifiers.
  if (loginAttempts.size > 10_000) {
    for (const [entryKey, value] of loginAttempts) {
      if (now >= value.resetAt) loginAttempts.delete(entryKey);
      if (loginAttempts.size <= 8_000) break;
    }
  }
}

export async function loginWithPassword(
  username: string,
  password: string,
  clientAddress: string
) {
  const normalizedUsername = normalizeUsername(username);
  const attemptKey = loginAttemptKey(normalizedUsername, clientAddress);
  assertLoginAllowed(attemptKey);

  const db = await requireDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, normalizedUsername))
    .limit(1);
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
  const lastSignedIn = new Date();
  await db.update(users).set({ lastSignedIn }).where(eq(users.id, user.id));
  const created = await createSession(user.id);

  return {
    user: toAuthenticatedUser({ ...user, lastSignedIn }),
    ...created,
  };
}

export async function changeOwnPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  currentSessionToken?: string | null
) {
  const db = await requireDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AuthServiceError("INVALID_PASSWORD", "Current password is incorrect");
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, passwordChangedAt: new Date() })
    .where(eq(users.id, userId));
  await revokeAllUserSessions(userId, currentSessionToken);
}

export async function listManagedUsers(): Promise<AuthenticatedUser[]> {
  const db = await requireDb();
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  return rows.map(toAuthenticatedUser);
}

export async function getManagedUser(userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ? toAuthenticatedUser(rows[0]) : null;
}

export async function createManagedUser(input: {
  username: string;
  password: string;
  displayName?: string | null;
  role: "user" | "admin";
}) {
  const db = await requireDb();
  const username = normalizeUsername(input.username);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
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
      passwordChangedAt: new Date(),
    });
  } catch (error) {
    const mysqlError = error as { code?: string };
    if (mysqlError.code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "Username already exists");
    }
    throw error;
  }

  const created = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!created[0]) {
    throw new AuthServiceError("NOT_FOUND", "Created user could not be loaded");
  }
  return toAuthenticatedUser(created[0]);
}

export async function resetManagedUserPassword(
  userId: number,
  newPassword: string
) {
  const db = await requireDb();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!existing[0]) throw new AuthServiceError("NOT_FOUND", "User not found");

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, passwordChangedAt: new Date() })
    .where(eq(users.id, userId));
  await revokeAllUserSessions(userId);
}

export async function setManagedUserActive(userId: number, isActive: boolean) {
  const db = await requireDb();
  await db.transaction(async tx => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    const user = rows[0];
    if (!user) throw new AuthServiceError("NOT_FOUND", "User not found");

    if (!isActive && user.isActive && user.role === "admin") {
      const activeAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.isActive, true)))
        .limit(2)
        .for("update");
      if (activeAdmins.length <= 1) {
        throw new AuthServiceError(
          "LAST_ADMIN",
          "The last active administrator cannot be disabled"
        );
      }
    }

    await tx.update(users).set({ isActive }).where(eq(users.id, userId));
  });
  if (!isActive) await revokeAllUserSessions(userId);
  const updated = await getManagedUser(userId);
  if (!updated) throw new AuthServiceError("NOT_FOUND", "User not found");
  return updated;
}

function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  let decoded: Buffer;

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

/** Fail-fast validation used by the production entrypoint. */
export function assertCredentialEncryptionConfigured() {
  getCredentialMasterKey();
}

function credentialAad(userId: number, credentialId: string) {
  return Buffer.from(`frontmind-api-credential:v1:${userId}:${credentialId}`, "utf8");
}

export function getApiKeyFingerprint(apiKey: string) {
  return `fp_${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 16)}`;
}

export function encryptApiKey(
  userId: number,
  credentialId: string,
  apiKey: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getCredentialMasterKey(), iv);
  cipher.setAAD(credentialAad(userId, credentialId));
  const encrypted = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  return {
    encryptionVersion: 1,
    encryptedKey: encrypted.toString("base64"),
    encryptionIv: iv.toString("base64"),
    encryptionAuthTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptApiKey(credential: Pick<
  ApiCredential,
  | "id"
  | "userId"
  | "encryptionVersion"
  | "encryptedKey"
  | "encryptionIv"
  | "encryptionAuthTag"
>) {
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
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError("INVALID_CREDENTIAL", "Credential cannot be decrypted");
  }
}

export async function validateUpstreamApiKey(apiKey: string) {
  let response: globalThis.Response;
  try {
    response = await fetch(`${getUpstreamBaseUrl()}/v1/tasks?limit=1`, {
      method: "GET",
      redirect: "error",
      headers: {
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
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

function toCredentialStatus(credential?: ApiCredential | null): CredentialStatus {
  const status =
    credential?.status === "deleted"
      ? null
      : credential?.validationStatus === "invalid"
        ? "invalid"
        : credential?.status ?? null;
  return {
    configured: Boolean(credential && credential.status === "active"),
    fingerprint: credential?.fingerprint ?? null,
    status,
    verifiedAt: credential?.verifiedAt?.getTime() ?? null,
  };
}

export async function getApiCredentialStatus(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(apiCredentials)
    .where(
      and(eq(apiCredentials.userId, userId), eq(apiCredentials.status, "active"))
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  return toCredentialStatus(rows[0]);
}

export async function replaceApiCredential(
  userId: number,
  apiKey: string,
  validator: (apiKey: string) => Promise<void> = validateUpstreamApiKey
): Promise<CredentialStatus> {
  const db = await requireDb();
  await validator(apiKey);
  const fingerprint = getApiKeyFingerprint(apiKey);
  const credentialId = randomUUID();
  const encrypted = encryptApiKey(userId, credentialId, apiKey);
  const now = new Date();

  const credential = await db.transaction(async tx => {
    await tx
      .insert(apiKeyOwnership)
      .values({ fingerprint, userId })
      .onDuplicateKeyUpdate({ set: { fingerprint } });
    const ownership = await tx
      .select({ userId: apiKeyOwnership.userId })
      .from(apiKeyOwnership)
      .where(eq(apiKeyOwnership.fingerprint, fingerprint))
      .limit(1)
      .for("update");
    if (!ownership[0] || ownership[0].userId !== userId) {
      throw new AuthServiceError(
        "CONFLICT",
        "This API credential is already assigned to another account"
      );
    }

    const latest = await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.userId, userId))
      .orderBy(desc(apiCredentials.version))
      .limit(1);
    const nextVersion = (latest[0]?.version ?? 0) + 1;

    await tx
      .update(apiCredentials)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(eq(apiCredentials.userId, userId), eq(apiCredentials.status, "active"))
      );

    const inserted = {
      id: credentialId,
      userId,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active" as const,
      validationStatus: "verified" as const,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
      deletedAt: null,
    };
    await tx.insert(apiCredentials).values(inserted);
    return inserted;
  });

  return toCredentialStatus(credential);
}

export async function deleteActiveApiCredential(userId: number) {
  const db = await requireDb();
  const now = new Date();
  await db
    .update(apiCredentials)
    .set({
      status: "deleted",
      deletedAt: now,
      encryptedKey: randomBytes(32).toString("base64"),
      encryptionIv: randomBytes(12).toString("base64"),
      encryptionAuthTag: randomBytes(16).toString("base64"),
    })
    .where(
      and(eq(apiCredentials.userId, userId), eq(apiCredentials.status, "active"))
    );
}

export async function getDecryptedCredentialForUser(
  userId: number,
  credentialId?: string | null
): Promise<DecryptedCredential | null> {
  const db = await requireDb();
  const conditions = [
    eq(apiCredentials.userId, userId),
    ne(apiCredentials.status, "deleted"),
  ];
  if (credentialId) conditions.push(eq(apiCredentials.id, credentialId));
  else conditions.push(eq(apiCredentials.status, "active"));

  const rows = await db
    .select()
    .from(apiCredentials)
    .where(and(...conditions))
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const credential = rows[0];
  if (!credential || credential.status === "deleted") return null;

  return {
    id: credential.id,
    userId: credential.userId,
    version: credential.version,
    apiKey: decryptApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
  };
}

export async function getCredentialForUpstreamResource(
  userId: number,
  kind: "task" | "file",
  upstreamId: string
): Promise<(DecryptedCredential & { resource: UpstreamResource }) | null> {
  const db = await requireDb();
  const rows = await db
    .select({ resource: upstreamResources, credential: apiCredentials })
    .from(upstreamResources)
    .innerJoin(
      apiCredentials,
      eq(upstreamResources.apiCredentialId, apiCredentials.id)
    )
    .where(
      and(
        eq(upstreamResources.userId, userId),
        eq(upstreamResources.kind, kind),
        eq(upstreamResources.upstreamId, upstreamId),
        ne(apiCredentials.status, "deleted")
      )
    )
    .limit(1);
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
    resource: row.resource,
  };
}

export async function recordUpstreamResource(input: {
  userId: number;
  apiCredentialId: string;
  kind: "task" | "file";
  upstreamId: string;
  conversationId?: string | null;
}): Promise<UpstreamResource> {
  const db = await requireDb();
  const existing = await db
    .select()
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, input.kind),
        eq(upstreamResources.upstreamId, input.upstreamId)
      )
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].userId !== input.userId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource is already owned by another account"
      );
    }
    return existing[0];
  }

  const credential = await db
    .select({ id: apiCredentials.id })
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.id, input.apiCredentialId),
        eq(apiCredentials.userId, input.userId),
        ne(apiCredentials.status, "deleted")
      )
    )
    .limit(1);
  if (!credential[0]) {
    throw new AuthServiceError("NOT_FOUND", "API credential not found");
  }

  if (input.conversationId) {
    const conversation = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, input.userId)
        )
      )
      .limit(1);
    if (!conversation[0]) {
      throw new AuthServiceError("NOT_FOUND", "Conversation not found");
    }
  }

  const resource: UpstreamResource = {
    id: randomUUID(),
    userId: input.userId,
    apiCredentialId: input.apiCredentialId,
    kind: input.kind,
    upstreamId: input.upstreamId,
    conversationId: input.conversationId ?? null,
    createdAt: new Date(),
  };
  try {
    await db.insert(upstreamResources).values(resource);
    return resource;
  } catch (error) {
    const mysqlError = error as { code?: string };
    if (mysqlError.code !== "ER_DUP_ENTRY") throw error;

    const raced = await db
      .select()
      .from(upstreamResources)
      .where(
        and(
            eq(upstreamResources.kind, input.kind),
            eq(upstreamResources.upstreamId, input.upstreamId),
            eq(upstreamResources.userId, input.userId)
          )
      )
      .limit(1);
    if (raced[0]) return raced[0];
    throw new AuthServiceError(
      "CONFLICT",
      "Upstream resource is already owned by another account"
    );
  }
}
