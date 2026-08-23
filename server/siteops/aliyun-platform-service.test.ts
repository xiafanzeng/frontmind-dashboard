import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getServicePortal: vi.fn(async () => ({})),
}));

vi.mock("../db", () => ({ getDb: dependencies.getDb }));
vi.mock("../service-entitlement", () => ({
  getServicePortal: dependencies.getServicePortal,
}));
vi.mock("./quota-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./quota-service")>();
  return {
    ...actual,
    assertSiteOpsServiceEntitlement: (portal: unknown) => portal,
  };
});

import { AuthServiceError } from "../auth-service";
import {
  ALIYUN_BROKER_CREDENTIAL_SLOT,
  ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
  ALIYUN_OAUTH_CREDENTIAL_SLOT,
  ALIYUN_OAUTH_TOKEN_ENDPOINT,
  ALIYUN_OAUTH_USERINFO_ENDPOINT,
  aliyunBrokerCredentialInputSchema,
  aliyunOAuthCredentialInputSchema,
  assertAliyunOAuthScopes,
  buildAliyunOAuthState,
  decryptAliyunPlatformCredential,
  encryptAliyunPlatformCredential,
  exchangeAliyunOAuthCode,
  inspectAliyunOAuthConfiguration,
  verifyAliyunOAuthState,
} from "./aliyun-platform-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
const originalSiteOpsEnabled = process.env.FRONTMIND_SITEOPS_ENABLED;

const oauthCredential = {
  clientId: "frontmind-oauth",
  clientSecret: "frontmind-oauth-client-secret",
  callbackUrl:
    "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
};

function storedOAuthCredential(id = randomUUID()) {
  return {
    id,
    slot: ALIYUN_OAUTH_CREDENTIAL_SLOT,
    version: 1,
    status: "active",
    validationStatus: "unverified",
    fingerprint: "sha256:test-oauth",
    ...encryptAliyunPlatformCredential(
      ALIYUN_OAUTH_CREDENTIAL_SLOT,
      id,
      oauthCredential,
    ),
  };
}

function oauthDatabase(row: ReturnType<typeof storedOAuthCredential> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (row ? [row] : [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updates.push(values);
          return { affectedRows: 1 };
        }),
      })),
    })),
  };
  return { db, updates };
}

function signedOAuthState(input: {
  credentialId: string;
  projectId?: string;
  userId?: number;
  expiresAt?: number;
}) {
  return buildAliyunOAuthState({
    credentialId: input.credentialId,
    projectId: input.projectId ?? randomUUID(),
    userId: input.userId ?? 42,
    clientSecret: oauthCredential.clientSecret,
    expiresAt: input.expiresAt ?? Date.now() + 60_000,
    nonce: "abcdefghijklmnop",
  });
}

function jsonResponse(
  value: Record<string, unknown>,
  input: { status?: number; contentLength?: number } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.contentLength !== undefined) {
    headers.set("content-length", String(input.contentLength));
  }
  return new Response(JSON.stringify(value), {
    status: input.status ?? 200,
    headers,
  });
}

const validTokenResponse = () =>
  jsonResponse({
    access_token: "oauth-access-token-never-persist",
    scope: "openid aliuid profile",
  });

describe("Aliyun platform credentials", () => {
  beforeEach(() => {
    dependencies.getDb.mockReset();
    dependencies.getServicePortal.mockClear();
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
    process.env.FRONTMIND_SITEOPS_ENABLED = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
    if (originalSiteOpsEnabled === undefined) {
      delete process.env.FRONTMIND_SITEOPS_ENABLED;
    } else {
      process.env.FRONTMIND_SITEOPS_ENABLED = originalSiteOpsEnabled;
    }
  });

  it("round-trips encrypted JSON without crossing broker and OAuth AAD slots", () => {
    const id = randomUUID();
    const broker = {
      accessKeyId: "LTAI5frontmindtest",
      accessKeySecret: "frontmind-test-access-key-secret",
      principalArn: "acs:ram::1244409121609391:user/frontmind-siteops",
    };
    const sealed = encryptAliyunPlatformCredential(
      ALIYUN_BROKER_CREDENTIAL_SLOT,
      id,
      broker,
    );
    expect(Object.values(sealed).join(" ")).not.toContain(
      broker.accessKeySecret,
    );
    expect(
      decryptAliyunPlatformCredential(ALIYUN_BROKER_CREDENTIAL_SLOT, {
        id,
        ...sealed,
      }),
    ).toEqual(broker);
    expect(() =>
      decryptAliyunPlatformCredential(ALIYUN_OAUTH_CREDENTIAL_SLOT, {
        id,
        ...sealed,
      }),
    ).toThrowError(AuthServiceError);
  });

  it("locks the broker identity to the FrontMind account and callback to HTTPS", () => {
    expect(() =>
      aliyunBrokerCredentialInputSchema.parse({
        accessKeyId: "LTAI5frontmindtest",
        accessKeySecret: "frontmind-test-access-key-secret",
        principalArn: "acs:ram::999999999999:user/not-frontmind",
      }),
    ).toThrow();
    expect(() =>
      aliyunOAuthCredentialInputSchema.parse({
        clientId: "frontmind-oauth",
        clientSecret: "frontmind-oauth-client-secret",
        callbackUrl:
          "http://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
      }),
    ).toThrow();
    expect(
      aliyunOAuthCredentialInputSchema.parse({
        clientId: "frontmind-oauth",
        clientSecret: "frontmind-oauth-client-secret",
        callbackUrl:
          "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
      }).callbackUrl,
    ).toBe(
      "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
    );
  });

  it("accepts only the locked official OIDC discovery contract", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authorization_endpoint: ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
            token_endpoint: ALIYUN_OAUTH_TOKEN_ENDPOINT,
            userinfo_endpoint: ALIYUN_OAUTH_USERINFO_ENDPOINT,
            scopes_supported: ["openid", "aliuid", "profile"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    await expect(
      inspectAliyunOAuthConfiguration(
        {
          clientId: "frontmind-oauth",
          clientSecret: "frontmind-oauth-client-secret",
          callbackUrl:
            "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
        },
        fetchImpl as typeof fetch,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("signs OAuth state without embedding the client secret", () => {
    const secret = "frontmind-oauth-client-secret";
    const state = buildAliyunOAuthState({
      credentialId: randomUUID(),
      projectId: randomUUID(),
      userId: 42,
      clientSecret: secret,
      expiresAt: Date.now() + 60_000,
      nonce: "abcdefghijklmnop",
    });
    expect(state).not.toContain(secret);
    expect(state.split(".")).toHaveLength(2);
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a token response that omits any locked identity scope", () => {
    expect(assertAliyunOAuthScopes("openid aliuid profile")).toEqual([
      "openid",
      "aliuid",
      "profile",
    ]);
    expect(() => assertAliyunOAuthScopes("openid profile")).toThrowError(
      AuthServiceError,
    );
  });

  it("rejects tampered, expired, and cross-user OAuth state before exchange", async () => {
    const credential = storedOAuthCredential();
    const fixture = oauthDatabase(credential);
    dependencies.getDb.mockResolvedValue(fixture.db);

    const valid = signedOAuthState({ credentialId: credential.id });
    const [payload, signature] = valid.split(".");
    const tampered = `${payload}.${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;
    await expect(
      verifyAliyunOAuthState({ state: tampered, userId: 42 }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });

    await expect(
      verifyAliyunOAuthState({
        state: signedOAuthState({
          credentialId: credential.id,
          expiresAt: 1_000,
        }),
        userId: 42,
        nowMs: 1_001,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });

    await expect(
      verifyAliyunOAuthState({ state: valid, userId: 43 }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("rejects state whose frozen OAuth credential no longer exists", async () => {
    const credentialId = randomUUID();
    const fixture = oauthDatabase(null);
    dependencies.getDb.mockResolvedValue(fixture.db);

    await expect(
      verifyAliyunOAuthState({
        state: signedOAuthState({ credentialId }),
        userId: 42,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it.each([
    {
      label: "token non-2xx",
      responses: [jsonResponse({}, { status: 503 })],
    },
    {
      label: "token over the response limit",
      responses: [jsonResponse({}, { contentLength: 64 * 1024 + 1 })],
    },
    {
      label: "userinfo non-2xx",
      responses: [validTokenResponse(), jsonResponse({}, { status: 502 })],
    },
    {
      label: "userinfo over the response limit",
      responses: [
        validTokenResponse(),
        jsonResponse({ aid: "123456789012" }, { contentLength: 64 * 1024 + 1 }),
      ],
    },
  ])("rejects $label without verifying the credential", async ({ responses }) => {
    const credential = storedOAuthCredential();
    const fixture = oauthDatabase(credential);
    dependencies.getDb.mockResolvedValue(fixture.db);
    const fetchImpl = vi.fn();
    for (const response of responses) fetchImpl.mockResolvedValueOnce(response);

    await expect(
      exchangeAliyunOAuthCode({
        code: "oauth-code-1234",
        state: signedOAuthState({ credentialId: credential.id }),
        userId: 42,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fixture.updates).toEqual([]);
  });

  it("rejects missing scopes and an invalid account UID without persistence", async () => {
    const credential = storedOAuthCredential();
    const fixture = oauthDatabase(credential);
    dependencies.getDb.mockResolvedValue(fixture.db);

    const missingScopeFetch = vi.fn(async () =>
      jsonResponse({
        access_token: "oauth-access-token-never-persist",
        scope: "openid profile",
      }),
    );
    await expect(
      exchangeAliyunOAuthCode({
        code: "oauth-code-1234",
        state: signedOAuthState({ credentialId: credential.id }),
        userId: 42,
        fetchImpl: missingScopeFetch as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });

    const invalidAidFetch = vi
      .fn()
      .mockResolvedValueOnce(validTokenResponse())
      .mockResolvedValueOnce(jsonResponse({ aid: "not-an-aliyun-uid" }));
    await expect(
      exchangeAliyunOAuthCode({
        code: "oauth-code-5678",
        state: signedOAuthState({ credentialId: credential.id }),
        userId: 42,
        fetchImpl: invalidAidFetch as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(fixture.updates).toEqual([]);
  });

  it("returns the signed tenant identity and persists verification without the access token", async () => {
    const projectId = randomUUID();
    const credential = storedOAuthCredential();
    const fixture = oauthDatabase(credential);
    dependencies.getDb.mockResolvedValue(fixture.db);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(validTokenResponse())
      .mockResolvedValueOnce(jsonResponse({ aid: "1234567890123456" }));

    await expect(
      exchangeAliyunOAuthCode({
        code: "oauth-code-success",
        state: signedOAuthState({
          credentialId: credential.id,
          projectId,
          userId: 42,
        }),
        userId: 42,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      projectId,
      userId: 42,
      accountUid: "1234567890123456",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      ALIYUN_OAUTH_USERINFO_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-access-token-never-persist",
        }),
      }),
    );
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.updates[0]).toMatchObject({
      validationStatus: "verified",
      verifiedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(JSON.stringify(fixture.updates)).not.toContain(
      "oauth-access-token-never-persist",
    );
  });

  it("refuses callback completion for a project owned by another tenant", async () => {
    const fixture = oauthDatabase(null);
    dependencies.getDb.mockResolvedValue(fixture.db);
    const { completeSiteOpsAliyunOAuth } = await import("./service");

    await expect(
      completeSiteOpsAliyunOAuth({
        actor: { id: 42, role: "user", username: "customer-42" } as never,
        projectId: randomUUID(),
        accountUid: "1234567890123456",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });
});
