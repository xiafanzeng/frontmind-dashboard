import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiCredentials,
  apiKeyOwnership,
  upstreamResources,
  users,
} from "../drizzle/schema";
import {
  AuthServiceError,
  assertAdminHasNoHistoricalCredentialResources,
  assertAdminHasNoUsageOwnedUsers,
  credentialsUseSameUpstreamApiKey,
  deleteActiveApiCredentialInTransaction,
  deleteManagedUser,
  decryptApiKey,
  encryptApiKey,
  getApiKeyFingerprint,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  permanentlyDeleteManagedUserRows,
  verifyPassword,
} from "./auth-service";
import {
  decryptPresalesApiKey,
  encryptPresalesApiKey,
} from "./presales-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

describe("password authentication primitives", () => {
  it("normalizes usernames consistently", () => {
    expect(normalizeUsername("  Internal.User  ")).toBe("internal.user");
    expect(normalizeUsername("ＦＯＯ")).toBe("foo");
  });

  it("hashes passwords with a random salt and verifies in constant-time form", async () => {
    const first = await hashPassword("a sufficiently long password");
    const second = await hashPassword("a sufficiently long password");

    expect(first).not.toBe(second);
    expect(first).not.toContain("a sufficiently long password");
    await expect(
      verifyPassword("a sufficiently long password", first),
    ).resolves.toBe(true);
    await expect(verifyPassword("the wrong password", first)).resolves.toBe(
      false,
    );
    await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(
      false,
    );
  });

  it("hashes opaque session tokens without retaining their plaintext", () => {
    const token = randomBytes(32).toString("base64url");
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash);
  });
});

describe("managed account deletion", () => {
  it("physically removes restrictive ledgers before deleting the user", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const deleteFrom = vi.fn().mockReturnValue({ where });

    await permanentlyDeleteManagedUserRows({ delete: deleteFrom }, 42);

    expect(deleteFrom).toHaveBeenCalledTimes(3);
    expect(deleteFrom).toHaveBeenNthCalledWith(1, upstreamResources);
    expect(deleteFrom).toHaveBeenNthCalledWith(2, apiKeyOwnership);
    expect(deleteFrom).toHaveBeenNthCalledWith(3, users);
    expect(where).toHaveBeenCalledTimes(3);
  });

  it("rejects deleting the administrator's current account", async () => {
    await expect(deleteManagedUser(42, 42)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it.each([
    ["deactivate", "停用管理员"],
    ["delete", "删除管理员"],
  ] as const)(
    "requires usage ownership transfer before attempting to %s a delivery administrator",
    (mutation, actionLabel) => {
      expect(() =>
        assertAdminHasNoUsageOwnedUsers({
          ownedUserCount: 1,
          mutation,
        }),
      ).toThrowError(
        `该管理员仍负责用户，请先转移这些用户的 Key 与积分归属，再${actionLabel}`,
      );
    },
  );

  it("allows administrator lifecycle changes after all usage ownership is transferred", () => {
    expect(() =>
      assertAdminHasNoUsageOwnedUsers({
        ownedUserCount: 0,
        mutation: "deactivate",
      }),
    ).not.toThrow();
  });

  it("preserves customer task history when an old administrator Key is still referenced", () => {
    expect(() => assertAdminHasNoHistoricalCredentialResources(1)).toThrowError(
      "该管理员的历史 Key 仍关联客户任务或文件，不能永久删除；可以停用账号并保留历史成果",
    );
    expect(() =>
      assertAdminHasNoHistoricalCredentialResources(0),
    ).not.toThrow();
  });
});

describe("API credential encryption", () => {
  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
  });

  it("round-trips with AES-256-GCM without placing plaintext in stored fields", () => {
    const credentialId = randomUUID();
    const apiKey = "sk-test-this-value-must-never-be-returned";
    const encrypted = encryptApiKey(42, credentialId, apiKey);

    expect(Object.values(encrypted).join(" ")).not.toContain(apiKey);
    expect(
      decryptApiKey({
        id: credentialId,
        userId: 42,
        ...encrypted,
      }),
    ).toBe(apiKey);
  });

  it("binds ciphertext to its user and credential id through authenticated data", () => {
    const credentialId = randomUUID();
    const encrypted = encryptApiKey(42, credentialId, "sk-test-secret");

    expect(() =>
      decryptApiKey({ id: credentialId, userId: 43, ...encrypted }),
    ).toThrowError(AuthServiceError);
    expect(() =>
      decryptApiKey({ id: randomUUID(), userId: 42, ...encrypted }),
    ).toThrowError(AuthServiceError);
  });

  it("exposes only a stable one-way fingerprint", () => {
    const apiKey = "sk-test-secret-material";
    const fingerprint = getApiKeyFingerprint(apiKey);
    expect(fingerprint).toMatch(/^fp_[a-f0-9]{16}$/);
    expect(fingerprint).not.toContain(apiKey.slice(0, 4));
    expect(getApiKeyFingerprint(apiKey)).toBe(fingerprint);
    expect(getApiKeyFingerprint(`${apiKey}x`)).not.toBe(fingerprint);
  });

  it("recognizes the same upstream key across separate account credentials", () => {
    const apiKey = "sk-shared-across-frontmind-accounts";
    const fingerprint = getApiKeyFingerprint(apiKey);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstEncrypted = encryptApiKey(11, firstId, apiKey);
    const secondEncrypted = encryptApiKey(12, secondId, apiKey);
    expect(firstEncrypted.encryptedKey).not.toBe(secondEncrypted.encryptedKey);
    const firstDecrypted = decryptApiKey({
      id: firstId,
      userId: 11,
      ...firstEncrypted,
    });
    const secondDecrypted = decryptApiKey({
      id: secondId,
      userId: 12,
      ...secondEncrypted,
    });

    expect(
      credentialsUseSameUpstreamApiKey(
        { apiKey: firstDecrypted, fingerprint },
        { apiKey: secondDecrypted, fingerprint },
      ),
    ).toBe(true);
    expect(
      credentialsUseSameUpstreamApiKey(
        { apiKey, fingerprint },
        { apiKey: `${apiKey}-different`, fingerprint },
      ),
    ).toBe(false);
    expect(
      credentialsUseSameUpstreamApiKey(
        { apiKey, fingerprint },
        {
          apiKey: `${apiKey}-different`,
          fingerprint: getApiKeyFingerprint(`${apiKey}-different`),
        },
      ),
    ).toBe(false);
  });

  it("allows an account credential to independently store the website's raw Key", () => {
    const apiKey = "sk-shared-between-account-and-website";
    const accountCredentialId = randomUUID();
    const websiteCredentialId = randomUUID();
    const accountEncrypted = encryptApiKey(42, accountCredentialId, apiKey);
    const websiteEncrypted = encryptPresalesApiKey(websiteCredentialId, apiKey);

    expect(accountEncrypted.encryptedKey).not.toBe(
      websiteEncrypted.encryptedKey,
    );
    expect(
      decryptApiKey({
        id: accountCredentialId,
        userId: 42,
        ...accountEncrypted,
      }),
    ).toBe(apiKey);
    expect(
      decryptPresalesApiKey({
        id: websiteCredentialId,
        ...websiteEncrypted,
      }),
    ).toBe(apiKey);
  });

  it("adds a monotonically versioned tombstone when a Key is revoked", async () => {
    const active = {
      id: randomUUID(),
      userId: 42,
      version: 3,
      status: "active",
      encryptedKey: "encrypted",
    };
    const inserted: Array<Record<string, unknown>> = [];
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn((table) => {
          expect(table).toBe(apiCredentials);
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn().mockResolvedValue([active]),
                })),
              })),
            })),
          };
        }),
      })),
      update: vi.fn((table) => {
        expect(table).toBe(apiCredentials);
        return {
          set: vi.fn((values) => ({
            where: vi.fn(async () => Object.assign(active, values)),
          })),
        };
      }),
      insert: vi.fn((table) => {
        expect(table).toBe(apiCredentials);
        return {
          values: vi.fn(async (values) => {
            inserted.push(values);
          }),
        };
      }),
    };

    await expect(
      deleteActiveApiCredentialInTransaction({
        executor,
        userId: 42,
        now: new Date("2026-07-30T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ version: 4, deleted: true });
    expect(active.status).toBe("deleted");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: 42,
      version: 4,
      status: "deleted",
      validationStatus: "unverified",
    });
    expect(JSON.stringify(inserted[0])).not.toContain("sk-");
  });

  it("fails closed when the encryption key is missing or malformed", () => {
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptApiKey(1, randomUUID(), "sk-test-secret")).toThrowError(
      AuthServiceError,
    );

    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = "too-short";
    expect(() => encryptApiKey(1, randomUUID(), "sk-test-secret")).toThrowError(
      AuthServiceError,
    );
  });
});
