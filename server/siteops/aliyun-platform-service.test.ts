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
  ALIYUN_CUSTOMER_ROLE_ACTIONS,
  ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
  ALIYUN_OAUTH_CREDENTIAL_SLOT,
  ALIYUN_OAUTH_TOKEN_ENDPOINT,
  ALIYUN_OAUTH_USERINFO_ENDPOINT,
  aliyunBrokerCredentialInputSchema,
  aliyunOAuthApplicationIdSchema,
  aliyunOAuthCredentialInputSchema,
  aliyunOAuthApplicationIdTail,
  aliyunOAuthConfigurationIssue,
  assertAliyunOAuthScopes,
  buildAliyunOAuthAuthorizationUrl,
  buildAliyunOAuthState,
  canonicalAliyunOAuthCallbackUrl,
  createAliyunOAuthAuthorization,
  decryptAliyunPlatformCredential,
  encryptAliyunPlatformCredential,
  exchangeAliyunOAuthCode,
  getActiveAliyunOAuthCredential,
  getAliyunPlatformCredentialStatus,
  inspectAliyunBrokerCredential,
  inspectAliyunOAuthConfiguration,
  probeAliyunOAuthAuthorization,
  replaceAliyunOAuthCredential,
  verifyAliyunOAuthState,
} from "./aliyun-platform-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
const originalPublicUrl = process.env.FRONTMIND_PUBLIC_URL;
const originalSiteOpsEnabled = process.env.FRONTMIND_SITEOPS_ENABLED;

const oauthCredential = {
  clientId: "4724570903440411234",
  clientSecret: "frontmind-oauth-client-secret",
  callbackUrl:
    "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
};

const brokerCredential = {
  accessKeyId: "LTAI5frontmindtest",
  accessKeySecret: "frontmind-test-access-key-secret",
  principalArn: "acs:ram::1244409121609391:user/frontmind-siteops",
};

describe("Aliyun customer role permissions", () => {
  it("uses Alibaba Cloud RAM actions rather than Domain API method names", () => {
    expect(ALIYUN_CUSTOMER_ROLE_ACTIONS).toEqual(
      expect.arrayContaining([
        "domain:QueryDomain",
        "domain:QueryCommonInfo",
        "domain:QueryRegistrantProfile",
        "domain:QueryDomainTask",
        "domain:CreateOrderActivate",
        "domain:CreateOrderRenew",
        "domain:SetupDomainAutoRenew",
      ]),
    );
    expect(ALIYUN_CUSTOMER_ROLE_ACTIONS).not.toEqual(
      expect.arrayContaining([
        "domain:CheckDomain",
        "domain:QueryDomainList",
        "domain:SaveSingleTaskForCreatingOrderActivate",
      ]),
    );
  });
});

function storedOAuthCredential(
  id = randomUUID(),
  value: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  } = oauthCredential,
) {
  return {
    id,
    slot: ALIYUN_OAUTH_CREDENTIAL_SLOT,
    version: 1,
    status: "active",
    validationStatus: "unverified",
    fingerprint: "sha256:test-oauth",
    ...encryptAliyunPlatformCredential(ALIYUN_OAUTH_CREDENTIAL_SLOT, id, value),
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

function oauthReplacementDatabase() {
  const inserted: Array<Record<string, unknown>> = [];
  const transaction = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => []),
            })),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 0 })) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        inserted.push(row);
      }),
    })),
  };
  const db = {
    transaction: vi.fn(
      async (operation: (tx: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  return { db, inserted };
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

const validDiscoveryResponse = () =>
  jsonResponse({
    authorization_endpoint: ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
    token_endpoint: ALIYUN_OAUTH_TOKEN_ENDPOINT,
    userinfo_endpoint: ALIYUN_OAUTH_USERINFO_ENDPOINT,
    scopes_supported: ["openid", "aliuid", "profile"],
  });

describe("Aliyun platform credentials", () => {
  beforeEach(() => {
    dependencies.getDb.mockReset();
    dependencies.getServicePortal.mockClear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
    process.env.FRONTMIND_PUBLIC_URL = "https://dashboard.frontmind.net";
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
    if (originalPublicUrl === undefined) {
      delete process.env.FRONTMIND_PUBLIC_URL;
    } else {
      process.env.FRONTMIND_PUBLIC_URL = originalPublicUrl;
    }
  });

  it("round-trips encrypted JSON without crossing broker and OAuth AAD slots", () => {
    const id = randomUUID();
    const sealed = encryptAliyunPlatformCredential(
      ALIYUN_BROKER_CREDENTIAL_SLOT,
      id,
      brokerCredential,
    );
    expect(Object.values(sealed).join(" ")).not.toContain(
      brokerCredential.accessKeySecret,
    );
    expect(
      decryptAliyunPlatformCredential(ALIYUN_BROKER_CREDENTIAL_SLOT, {
        id,
        ...sealed,
      }),
    ).toEqual(brokerCredential);
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
      aliyunBrokerCredentialInputSchema.parse({
        ...brokerCredential,
        principalArn: "acs:ram::1244409121609391:role/FrontMindSiteOpsAccess",
      }),
    ).toThrow();
    expect(() =>
      aliyunOAuthCredentialInputSchema.parse({
        clientId: oauthCredential.clientId,
        clientSecret: "frontmind-oauth-client-secret",
        callbackUrl:
          "http://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
      }),
    ).toThrow();
    expect(
      aliyunOAuthCredentialInputSchema.parse({
        clientId: oauthCredential.clientId,
        clientSecret: "frontmind-oauth-client-secret",
        callbackUrl:
          "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
      }).callbackUrl,
    ).toBe(
      "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
    );
    expect(
      aliyunOAuthCredentialInputSchema.parse({
        clientId: oauthCredential.clientId,
        clientSecret: oauthCredential.clientSecret,
      }),
    ).toEqual({
      clientId: oauthCredential.clientId,
      clientSecret: oauthCredential.clientSecret,
    });
    expect(() =>
      aliyunOAuthCredentialInputSchema.parse({
        clientId: oauthCredential.clientId,
        clientSecret: oauthCredential.clientSecret,
        unexpected: "not-accepted",
      }),
    ).toThrow();
  });

  it("derives one canonical callback and classifies historical configuration issues", () => {
    expect(canonicalAliyunOAuthCallbackUrl()).toBe(oauthCredential.callbackUrl);
    expect(
      canonicalAliyunOAuthCallbackUrl({
        ...process.env,
        FRONTMIND_PUBLIC_URL: "https://console.frontmind.net/",
      }),
    ).toBe("https://console.frontmind.net/api/site-ops/aliyun/oauth/callback");
    expect(aliyunOAuthConfigurationIssue(oauthCredential)).toBeNull();
    expect(
      aliyunOAuthConfigurationIssue({
        ...oauthCredential,
        clientId: "5be78a96-6d64-42a0-b764-49474a8d5e04",
      }),
    ).toBe("application_id_is_secret_id");
    expect(
      aliyunOAuthConfigurationIssue({
        ...oauthCredential,
        clientId: "frontmind-oauth",
      }),
    ).toBe("invalid_application_id");
    expect(
      aliyunOAuthConfigurationIssue({
        ...oauthCredential,
        callbackUrl:
          "https://other.frontmind.net/api/site-ops/aliyun/oauth/callback",
      }),
    ).toBe("callback_mismatch");
  });

  it("accepts numeric AppId values and identifies an AppSecretId UUID", () => {
    expect(aliyunOAuthApplicationIdSchema.parse(oauthCredential.clientId)).toBe(
      oauthCredential.clientId,
    );
    const appSecretId = "5be78a96-6d64-42a0-b764-49474a8d5e04";
    const result = aliyunOAuthApplicationIdSchema.safeParse(appSecretId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "当前填写的是应用密钥 ID，请改填 OAuth 应用基本信息中的应用 ID。",
      );
    }
    expect(() =>
      aliyunOAuthApplicationIdSchema.parse("frontmind-oauth"),
    ).toThrow("OAuth 应用 ID 必须填写应用基本信息中的数字型 AppId。");
    expect(aliyunOAuthApplicationIdTail(oauthCredential.clientId)).toBe(
      "40411234",
    );
    expect(aliyunOAuthApplicationIdTail(appSecretId)).toBe("5e04");
  });

  it("keeps a legacy UUID credential visible but blocks authorization before fetch", async () => {
    const legacyClientId = "5be78a96-6d64-42a0-b764-49474a8d5e04";
    const legacyCredential = storedOAuthCredential(randomUUID(), {
      ...oauthCredential,
      clientId: legacyClientId,
    });
    const activeDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [legacyCredential]),
            })),
          })),
        })),
      })),
    };
    dependencies.getDb.mockResolvedValue(activeDb);
    await expect(getActiveAliyunOAuthCredential()).resolves.toMatchObject({
      clientId: legacyClientId,
      version: 1,
    });

    let credentialSelectCall = 0;
    const statusDb = {
      select: vi.fn((selection?: unknown) => {
        if (selection) {
          return {
            from: vi.fn(() => ({ where: vi.fn(async () => []) })),
          };
        }
        credentialSelectCall += 1;
        const rows =
          credentialSelectCall === 2 || credentialSelectCall === 3
            ? [legacyCredential]
            : [];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
            })),
          })),
        };
      }),
    };
    dependencies.getDb.mockResolvedValue(statusDb);
    await expect(getAliyunPlatformCredentialStatus()).resolves.toMatchObject({
      oauth: {
        configured: true,
        version: 1,
        callbackUrl: oauthCredential.callbackUrl,
        applicationIdTail: "5e04",
        usableForAuthorization: false,
        requiresReplacement: true,
        configurationIssue: "application_id_is_secret_id",
      },
    });

    dependencies.getDb.mockResolvedValue(activeDb);
    const fetchImpl = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createAliyunOAuthAuthorization({
        projectId: randomUUID(),
        userId: 42,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: expect.stringContaining("应用密钥 ID"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("projects enriched stored metadata before beginning one authorization flow", async () => {
    const credential = storedOAuthCredential();
    const activeDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [credential]),
            })),
          })),
        })),
      })),
    };
    dependencies.getDb.mockResolvedValue(activeDb);
    const fetchImpl = vi.fn(
      async () =>
        new Response("<!doctype html><title>Alibaba Cloud sign in</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const projectId = randomUUID();

    const result = await createAliyunOAuthAuthorization({
      projectId,
      userId: 42,
      nowMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      oauthCredential.clientId,
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      oauthCredential.callbackUrl,
    );
    expect(authorizationUrl.searchParams.has("prompt")).toBe(false);
    expect(result.authorizationUrl).not.toContain(oauthCredential.clientSecret);
    expect(result.expiresAt).toBe(new Date(1_000 + 10 * 60_000).toISOString());

    const entries = infoLog.mock.calls
      .map((call) => call[1])
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            "event" in entry &&
            entry.event === "siteops_aliyun_oauth_stage",
        ),
      );
    expect(entries.map((entry) => entry.stage)).toEqual([
      "credential_load",
      "credential_contract",
      "authorization_probe",
      "authorization_issued",
    ]);
    expect(new Set(entries.map((entry) => entry.correlationId)).size).toBe(1);
    expect(entries[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const serializedLog = JSON.stringify(infoLog.mock.calls);
    expect(serializedLog).not.toContain(oauthCredential.clientId);
    expect(serializedLog).not.toContain(oauthCredential.clientSecret);
    expect(serializedLog).not.toContain(oauthCredential.callbackUrl);
    expect(serializedLog).not.toContain(result.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    expect(serializedLog).not.toContain(state);
  });

  it("accepts only the exact broker account and RAM user ARN returned by STS", async () => {
    await expect(
      inspectAliyunBrokerCredential(brokerCredential, async () => ({
        body: {
          accountId: "1244409121609391",
          arn: brokerCredential.principalArn,
        },
      })),
    ).resolves.toEqual({
      ok: true,
      accountId: "1244409121609391",
      principalArn: brokerCredential.principalArn,
    });
    await expect(
      inspectAliyunBrokerCredential(brokerCredential, async () => ({
        body: {
          accountId: "9999999999999999",
          arn: brokerCredential.principalArn,
        },
      })),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    await expect(
      inspectAliyunBrokerCredential(brokerCredential, async () => ({
        body: {
          accountId: "1244409121609391",
          arn: "acs:ram::1244409121609391:user/another-user",
        },
      })),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it.each([
    {
      label: "AccessKey and secret mismatch",
      error: {
        name: "ResponseError",
        code: "SignatureDoesNotMatch",
        statusCode: 400,
        data: { RequestId: "broker-request-1" },
      },
      expectedCode: "INVALID_CREDENTIAL",
      expectedMessage: "不匹配",
    },
    {
      label: "AccessKey missing",
      error: {
        name: "ResponseError",
        code: "InvalidAccessKeyId.NotFound",
        statusCode: 404,
        data: { RequestId: "broker-request-2" },
      },
      expectedCode: "INVALID_CREDENTIAL",
      expectedMessage: "不存在",
    },
    {
      label: "AccessKey disabled",
      error: {
        name: "ResponseError",
        code: "Forbidden.AccessKeyDisabled",
        statusCode: 403,
        data: { RequestId: "broker-request-3" },
      },
      expectedCode: "INVALID_CREDENTIAL",
      expectedMessage: "已停用",
    },
    {
      label: "STS throttled",
      error: {
        name: "ResponseError",
        code: "Throttling.User",
        statusCode: 429,
        data: { RequestId: "broker-request-4" },
      },
      expectedCode: "RATE_LIMITED",
      expectedMessage: "请求过于频繁",
    },
    {
      label: "STS unavailable",
      error: {
        name: "ResponseError",
        code: "ServiceUnavailable",
        statusCode: 503,
        data: { RequestId: "broker-request-5" },
      },
      expectedCode: "UPSTREAM_UNAVAILABLE",
      expectedMessage: "暂时不可用",
    },
    {
      label: "network retries exhausted",
      error: {
        name: "UnretryableError",
        code: "UnretryableError",
        data: {
          lastRequest: {
            headers: {
              authorization: `Bearer ${brokerCredential.accessKeySecret}`,
            },
          },
        },
      },
      expectedCode: "UPSTREAM_UNAVAILABLE",
      expectedMessage: "暂时不可用",
    },
  ])(
    "maps $label without exposing credentials",
    async ({ error, expectedCode, expectedMessage }) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        inspectAliyunBrokerCredential(brokerCredential, async () => {
          throw error;
        }),
      ).rejects.toMatchObject({
        code: expectedCode,
        message: expect.stringContaining(expectedMessage),
      });
      expect(log).toHaveBeenCalledTimes(1);
      const serializedLog = JSON.stringify(log.mock.calls);
      expect(serializedLog).not.toContain(brokerCredential.accessKeyId);
      expect(serializedLog).not.toContain(brokerCredential.accessKeySecret);
      expect(serializedLog.toLowerCase()).not.toContain("authorization");
    },
  );

  it("accepts only the locked discovery contract and a normal authorization page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>Alibaba Cloud sign in</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    await expect(
      inspectAliyunOAuthConfiguration(
        oauthCredential,
        fetchImpl as typeof fetch,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const authorizationUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      oauthCredential.clientId,
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      oauthCredential.callbackUrl,
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "openid aliuid profile",
    );
    expect(authorizationUrl.searchParams.has("prompt")).toBe(false);
  });

  it("builds the authorization URL from the locked OAuth contract", () => {
    const url = buildAliyunOAuthAuthorizationUrl(
      oauthCredential,
      "probe-state-never-logged",
    );
    expect(url.origin + url.pathname).toBe(ALIYUN_OAUTH_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe(oauthCredential.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      oauthCredential.callbackUrl,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid aliuid profile");
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.get("state")).toBe("probe-state-never-logged");
  });

  it("rejects an HTTP 200 invalid_client response without echoing the AppId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: "invalid_client",
        error_description: `App not exists:${oauthCredential.clientId}`,
      }),
    );
    let caught: unknown;
    try {
      await probeAliyunOAuthAuthorization(
        oauthCredential,
        fetchImpl as typeof fetch,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: expect.stringContaining("无法识别该 OAuth 应用 ID"),
    });
    expect(String((caught as Error).message)).not.toContain(
      oauthCredential.clientId,
    );
  });

  it.each([
    {
      label: "callback mismatch",
      payload: {
        error: "redirect_uri_mismatch",
        error_description: "",
      },
      message: "回调地址",
    },
    {
      label: "unsupported scope",
      payload: {
        error: "invalid_scope",
        error_description: "unsupported scope",
      },
      message: "openid、aliuid 和 profile",
    },
  ])("rejects $label before saving", async ({ payload, message }) => {
    await expect(
      probeAliyunOAuthAuthorization(
        oauthCredential,
        vi.fn(async () => jsonResponse(payload)) as typeof fetch,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: expect.stringContaining(message),
    });
  });

  it("accepts a normal login redirect without following it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://signin.aliyun.com/login.htm" },
        }),
    );
    await expect(
      probeAliyunOAuthAuthorization(oauthCredential, fetchImpl as typeof fetch),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(ALIYUN_OAUTH_AUTHORIZE_ENDPOINT),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it.each([
    {
      label: "an empty JSON object",
      response: jsonResponse({}),
    },
    {
      label: "malformed JSON",
      response: new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
    {
      label: "plain text",
      response: new Response("unexpected authorization response", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    },
  ])(
    "rejects $label instead of treating it as a login page",
    async ({ response }) => {
      await expect(
        probeAliyunOAuthAuthorization(
          oauthCredential,
          vi.fn(async () => response) as typeof fetch,
        ),
      ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    },
  );

  it.each([
    {
      label: "rate limiting",
      response: jsonResponse({}, { status: 429 }),
      expectedCode: "RATE_LIMITED",
    },
    {
      label: "provider failure",
      response: jsonResponse({}, { status: 503 }),
      expectedCode: "UPSTREAM_UNAVAILABLE",
    },
  ])(
    "maps authorization $label to a retryable error",
    async ({ response, expectedCode }) => {
      await expect(
        probeAliyunOAuthAuthorization(
          oauthCredential,
          vi.fn(async () => response) as typeof fetch,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
    },
  );

  it("maps authorization transport failure without leaking request values", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(
        `timeout ${oauthCredential.clientId} ${oauthCredential.clientSecret}`,
      );
    });
    let caught: unknown;
    try {
      await probeAliyunOAuthAuthorization(
        oauthCredential,
        fetchImpl as typeof fetch,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const message = String((caught as Error).message);
    expect(message).not.toContain(oauthCredential.clientId);
    expect(message).not.toContain(oauthCredential.clientSecret);
  });

  it("derives and persists the canonical callback when replacement omits it", async () => {
    const fixture = oauthReplacementDatabase();
    dependencies.getDb.mockResolvedValue(fixture.db);
    const inspect = vi.fn(async () => ({ ok: true }));

    await expect(
      replaceAliyunOAuthCredential(
        42,
        {
          clientId: oauthCredential.clientId,
          clientSecret: oauthCredential.clientSecret,
        },
        inspect,
      ),
    ).resolves.toMatchObject({
      configured: false,
      status: "active",
      version: 1,
    });

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(oauthCredential);
    expect(fixture.inserted).toHaveLength(1);
    expect(
      decryptAliyunPlatformCredential(ALIYUN_OAUTH_CREDENTIAL_SLOT, {
        id: String(fixture.inserted[0]?.id),
        encryptionVersion: Number(fixture.inserted[0]?.encryptionVersion),
        encryptedKey: String(fixture.inserted[0]?.encryptedKey),
        encryptionIv: String(fixture.inserted[0]?.encryptionIv),
        encryptionAuthTag: String(fixture.inserted[0]?.encryptionAuthTag),
      }),
    ).toEqual(oauthCredential);
  });

  it("rejects a legacy submitted callback unless it matches the canonical URL", async () => {
    const inspect = vi.fn(async () => ({ ok: true }));

    await expect(
      replaceAliyunOAuthCredential(
        42,
        {
          clientId: oauthCredential.clientId,
          clientSecret: oauthCredential.clientSecret,
          callbackUrl:
            "https://other.frontmind.net/api/site-ops/aliyun/oauth/callback",
        },
        inspect,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });

    expect(inspect).not.toHaveBeenCalled();
    expect(dependencies.getDb).not.toHaveBeenCalled();
  });

  it("does not access the database or retire the old version when preflight fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(validDiscoveryResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          error: "invalid_client",
          error_description: `App not exists:${oauthCredential.clientId}`,
        }),
      );
    await expect(
      replaceAliyunOAuthCredential(42, oauthCredential, (credential) =>
        inspectAliyunOAuthConfiguration(credential, fetchImpl as typeof fetch),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(dependencies.getDb).not.toHaveBeenCalled();
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
  ])(
    "rejects $label without verifying the credential",
    async ({ responses }) => {
      const credential = storedOAuthCredential();
      const fixture = oauthDatabase(credential);
      dependencies.getDb.mockResolvedValue(fixture.db);
      const fetchImpl = vi.fn();
      for (const response of responses)
        fetchImpl.mockResolvedValueOnce(response);

      await expect(
        exchangeAliyunOAuthCode({
          code: "oauth-code-1234",
          state: signedOAuthState({ credentialId: credential.id }),
          userId: 42,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(fixture.updates).toEqual([]);
    },
  );

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

  it("returns the frozen credential identity without directly persisting verification", async () => {
    const projectId = randomUUID();
    const credential = storedOAuthCredential();
    const fixture = oauthDatabase(credential);
    dependencies.getDb.mockResolvedValue(fixture.db);
    const state = signedOAuthState({
      credentialId: credential.id,
      projectId,
      userId: 42,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(validTokenResponse())
      .mockResolvedValueOnce(jsonResponse({ aid: "1234567890123456" }));
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      exchangeAliyunOAuthCode({
        code: "oauth-code-success",
        state,
        userId: 42,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      credentialId: credential.id,
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
    expect(fixture.updates).toEqual([]);

    const entries = infoLog.mock.calls
      .map((call) => call[1])
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            "event" in entry &&
            entry.event === "siteops_aliyun_oauth_stage",
        ),
      );
    expect(entries.map((entry) => entry.stage)).toEqual([
      "state_verify",
      "token_exchange",
      "scope_verify",
      "userinfo",
    ]);
    expect(new Set(entries.map((entry) => entry.correlationId)).size).toBe(1);
    const serializedLog = JSON.stringify(infoLog.mock.calls);
    expect(serializedLog).not.toContain("oauth-code-success");
    expect(serializedLog).not.toContain(state);
    expect(serializedLog).not.toContain(oauthCredential.clientId);
    expect(serializedLog).not.toContain(oauthCredential.clientSecret);
    expect(serializedLog).not.toContain("oauth-access-token-never-persist");
    expect(serializedLog).not.toContain("1234567890123456");
  });

  it("refuses callback completion for a project owned by another tenant", async () => {
    const transaction = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: vi.fn(async () => []) })),
          })),
        })),
      })),
    };
    dependencies.getDb.mockResolvedValue({
      transaction: vi.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    });
    const { completeSiteOpsAliyunOAuth } = await import("./service");

    await expect(
      completeSiteOpsAliyunOAuth({
        actor: { id: 42, role: "user", username: "customer-42" } as never,
        credentialId: randomUUID(),
        projectId: randomUUID(),
        accountUid: "1234567890123456",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });
});
