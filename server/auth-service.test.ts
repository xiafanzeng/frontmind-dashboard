import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyOwnership,
  upstreamResources,
  users,
} from "../drizzle/schema";
import {
  AuthServiceError,
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
      verifyPassword("a sufficiently long password", first)
    ).resolves.toBe(true);
    await expect(verifyPassword("the wrong password", first)).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(
      false
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
});

describe("API credential encryption", () => {
  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString(
      "base64"
    );
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
      })
    ).toBe(apiKey);
  });

  it("binds ciphertext to its user and credential id through authenticated data", () => {
    const credentialId = randomUUID();
    const encrypted = encryptApiKey(42, credentialId, "sk-test-secret");

    expect(() =>
      decryptApiKey({ id: credentialId, userId: 43, ...encrypted })
    ).toThrowError(AuthServiceError);
    expect(() =>
      decryptApiKey({ id: randomUUID(), userId: 42, ...encrypted })
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

  it("fails closed when the encryption key is missing or malformed", () => {
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptApiKey(1, randomUUID(), "sk-test-secret")).toThrowError(
      AuthServiceError
    );

    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = "too-short";
    expect(() => encryptApiKey(1, randomUUID(), "sk-test-secret")).toThrowError(
      AuthServiceError
    );
  });
});
