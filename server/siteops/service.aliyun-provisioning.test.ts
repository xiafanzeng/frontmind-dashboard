import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveAliyunBrokerCredential: vi.fn(),
  getAliyunCustomerConnectionStatus: vi.fn(),
  getAliyunCustomerRoleAuthorizationPackage: vi.fn(),
  getDb: vi.fn(),
  getServicePortal: vi.fn(),
  prepareAliyunCustomerRoleProvisioning: vi.fn(),
  probeAliyunCustomerConnection: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../service-entitlement", () => ({
  getServicePortal: mocks.getServicePortal,
}));
vi.mock("./aliyun-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aliyun-provider")>();
  return {
    ...actual,
    getAliyunCustomerConnectionStatus: mocks.getAliyunCustomerConnectionStatus,
    getAliyunCustomerRoleAuthorizationPackage:
      mocks.getAliyunCustomerRoleAuthorizationPackage,
    prepareAliyunCustomerRoleProvisioning:
      mocks.prepareAliyunCustomerRoleProvisioning,
    probeAliyunCustomerConnection: mocks.probeAliyunCustomerConnection,
  };
});
vi.mock("./aliyun-platform-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./aliyun-platform-service")>();
  return {
    ...actual,
    getActiveAliyunBrokerCredential: mocks.getActiveAliyunBrokerCredential,
  };
});

import {
  getPublicSiteOpsAliyunRosTemplate,
  probeSiteOpsAliyunRole,
  startSiteOpsAliyunRoleProvisioning,
} from "./service";
import { fingerprintAliyunProvisioningValue } from "./aliyun-ros-provisioning";
import { ALIYUN_CUSTOMER_ROLE_ACTIONS } from "./aliyun-platform-service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const BROKER_ID = "33333333-3333-4333-8333-333333333333";
const EXTERNAL_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_UID = "1234567890123456";
const ROLE_NAME = "FrontMindSiteOps-222222222222";
const ROLE_ARN = `acs:ram::${ACCOUNT_UID}:role/${ROLE_NAME}`;
const BROKER_ARN = "acs:ram::1244409121609391:user/frontmind-siteops";
const actor = { id: 42, role: "user", username: "customer-42" } as const;

function ownedProjectDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              id: PROJECT_ID,
              userId: actor.id,
              conversationId: "conversation-42",
            },
          ]),
        })),
      })),
    })),
  };
}

function connectionStatus() {
  return {
    configured: true,
    connectionId: CONNECTION_ID,
    accountUid: ACCOUNT_UID,
    roleArn: ROLE_ARN,
    externalIdFingerprint: fingerprintAliyunProvisioningValue(
      EXTERNAL_ID,
    ).slice(0, 32),
    status: "unverified",
    capabilities: [],
    verifiedAt: null,
    lastErrorCode: null,
  };
}

function authorizationPackage() {
  return {
    schemaVersion: 1,
    roleName: ROLE_NAME,
    description: "FrontMind AI友好官网域名与解析自动化",
    trustPolicyDocument: {
      Version: "1",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { RAM: [BROKER_ARN] },
          Condition: {
            StringEquals: { "sts:ExternalId": EXTERNAL_ID },
          },
        },
      ],
    },
    permissionPolicyDocument: {
      Version: "1",
      Statement: [
        {
          Action: [...ALIYUN_CUSTOMER_ROLE_ACTIONS],
          Effect: "Allow",
          Resource: ["*"],
        },
      ],
    },
  };
}

describe("SiteOps Aliyun ROS provisioning service", () => {
  const original = {
    encryptionKey: process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY,
    publicUrl: process.env.FRONTMIND_PUBLIC_URL,
    enabled: process.env.FRONTMIND_SITEOPS_ENABLED,
  };

  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
      32,
      81,
    ).toString("base64")}`;
    process.env.FRONTMIND_PUBLIC_URL = "https://dashboard.frontmind.net";
    delete process.env.FRONTMIND_SITEOPS_ENABLED;
    mocks.getDb.mockReset().mockResolvedValue(ownedProjectDb());
    mocks.getServicePortal.mockReset().mockResolvedValue({
      service: { status: "unconfigured" },
      entitlementRollout: { mode: "compatibility" },
    });
    mocks.getActiveAliyunBrokerCredential.mockReset().mockResolvedValue({
      id: BROKER_ID,
      version: 2,
      fingerprint: "broker-fingerprint",
      accessKeyId: "never-return-access-key-id",
      accessKeySecret: "never-return-access-key-secret",
      principalArn: BROKER_ARN,
    });
    mocks.getAliyunCustomerConnectionStatus
      .mockReset()
      .mockResolvedValue(connectionStatus());
    mocks.getAliyunCustomerRoleAuthorizationPackage
      .mockReset()
      .mockResolvedValue(authorizationPackage());
    mocks.prepareAliyunCustomerRoleProvisioning.mockReset().mockResolvedValue({
      connectionId: CONNECTION_ID,
      accountUid: ACCOUNT_UID,
      roleArn: ROLE_ARN,
      roleName: ROLE_NAME,
      status: "unverified",
      roleChanged: false,
    });
    mocks.probeAliyunCustomerConnection.mockReset().mockResolvedValue({
      status: "pending",
      connected: false,
      reason: "role_not_ready",
      retryAfterMs: 2_000,
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      FRONTMIND_CREDENTIAL_ENCRYPTION_KEY: original.encryptionKey,
      FRONTMIND_PUBLIC_URL: original.publicUrl,
      FRONTMIND_SITEOPS_ENABLED: original.enabled,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("issues an opaque official ROS URL and serves its connection-bound template", async () => {
    const started = await startSiteOpsAliyunRoleProvisioning(actor as never, {
      conversationId: "conversation-42",
    });

    expect(started).toMatchObject({
      status: "ready",
      connected: false,
      retryAfterMs: 2_000,
    });
    if (started.status !== "ready") throw new Error("expected ready");
    const rosUrl = new URL(started.rosAuthorizationUrl);
    const templateUrlValue = rosUrl.searchParams.get("templateUrl");
    expect(rosUrl.origin).toBe("https://ros.console.aliyun.com");
    expect(templateUrlValue).toBeTruthy();
    const templateUrl = new URL(templateUrlValue ?? "");
    const capability = templateUrl.pathname.split("/").at(-1) ?? "";
    expect(capability).toMatch(/^ar1\./u);
    expect(started.rosAuthorizationUrl).not.toContain(EXTERNAL_ID);
    expect(started.rosAuthorizationUrl).not.toContain(ACCOUNT_UID);
    expect(started.rosAuthorizationUrl).not.toContain(BROKER_ARN);
    expect(started.rosAuthorizationUrl).not.toContain(
      "never-return-access-key-secret",
    );

    const template = await getPublicSiteOpsAliyunRosTemplate(capability);
    expect(template.Resources.FrontMindSiteOpsRole.Properties.RoleName).toBe(
      ROLE_NAME,
    );
    expect(template.Parameters.FrontMindExternalId).toMatchObject({
      NoEcho: true,
      Default: EXTERNAL_ID,
    });
  });

  it("returns pending probes without converting them to endpoint failures", async () => {
    await expect(
      probeSiteOpsAliyunRole(actor as never, {
        conversationId: "conversation-42",
      }),
    ).resolves.toEqual({
      status: "pending",
      connected: false,
      reason: "role_not_ready",
      retryAfterMs: 2_000,
    });
  });

  it("projects an active probe without exposing the customer account UID", async () => {
    mocks.probeAliyunCustomerConnection.mockResolvedValueOnce({
      status: "active",
      connected: true,
      accountUid: ACCOUNT_UID,
      capabilities: ["sts_assume_role", "domain_read", "alidns_read"],
    });

    await expect(
      probeSiteOpsAliyunRole(actor as never, {
        conversationId: "conversation-42",
      }),
    ).resolves.toEqual({ status: "active", connected: true });
  });

  it("rejects a capability after the bound connection changes", async () => {
    const started = await startSiteOpsAliyunRoleProvisioning(actor as never, {
      conversationId: "conversation-42",
    });
    if (started.status !== "ready") throw new Error("expected ready");
    const rosUrl = new URL(started.rosAuthorizationUrl);
    const templateUrl = new URL(rosUrl.searchParams.get("templateUrl") ?? "");
    const capability = templateUrl.pathname.split("/").at(-1) ?? "";
    mocks.getAliyunCustomerConnectionStatus.mockResolvedValueOnce({
      ...connectionStatus(),
      externalIdFingerprint: "b".repeat(32),
    });

    await expect(
      getPublicSiteOpsAliyunRosTemplate(capability),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("rejects a capability when the connection rotates while the template is prepared", async () => {
    const started = await startSiteOpsAliyunRoleProvisioning(actor as never, {
      conversationId: "conversation-42",
    });
    if (started.status !== "ready") throw new Error("expected ready");
    const rosUrl = new URL(started.rosAuthorizationUrl);
    const templateUrl = new URL(rosUrl.searchParams.get("templateUrl") ?? "");
    const capability = templateUrl.pathname.split("/").at(-1) ?? "";
    mocks.getAliyunCustomerConnectionStatus
      .mockResolvedValueOnce(connectionStatus())
      .mockResolvedValueOnce({
        ...connectionStatus(),
        externalIdFingerprint: "b".repeat(32),
      });

    await expect(
      getPublicSiteOpsAliyunRosTemplate(capability),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it.each([
    ["active", { status: "active" }],
    ["revoked", { configured: false, status: "revoked" }],
    [
      "role ARN rotated",
      {
        roleArn: `acs:ram::${ACCOUNT_UID}:role/FrontMindSiteOps-aaaaaaaaaaaa`,
      },
    ],
    [
      "connection rotated",
      { connectionId: "55555555-5555-4555-8555-555555555555" },
    ],
  ])(
    "invalidates a capability when the connection becomes %s",
    async (_label, changes) => {
      const started = await startSiteOpsAliyunRoleProvisioning(actor as never, {
        conversationId: "conversation-42",
      });
      if (started.status !== "ready") throw new Error("expected ready");
      const rosUrl = new URL(started.rosAuthorizationUrl);
      const templateUrl = new URL(rosUrl.searchParams.get("templateUrl") ?? "");
      const capability = templateUrl.pathname.split("/").at(-1) ?? "";
      mocks.getAliyunCustomerConnectionStatus.mockResolvedValueOnce({
        ...connectionStatus(),
        ...changes,
      });

      await expect(
        getPublicSiteOpsAliyunRosTemplate(capability),
      ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    },
  );

  it("invalidates a capability when the Broker credential rotates", async () => {
    const started = await startSiteOpsAliyunRoleProvisioning(actor as never, {
      conversationId: "conversation-42",
    });
    if (started.status !== "ready") throw new Error("expected ready");
    const rosUrl = new URL(started.rosAuthorizationUrl);
    const templateUrl = new URL(rosUrl.searchParams.get("templateUrl") ?? "");
    const capability = templateUrl.pathname.split("/").at(-1) ?? "";
    mocks.getActiveAliyunBrokerCredential.mockResolvedValueOnce({
      id: BROKER_ID,
      version: 3,
      fingerprint: "rotated-broker-fingerprint",
      accessKeyId: "rotated-access-key-id",
      accessKeySecret: "rotated-access-key-secret",
      principalArn: BROKER_ARN,
    });

    await expect(
      getPublicSiteOpsAliyunRosTemplate(capability),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("logs only safe provisioning coordinates", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const started = await startSiteOpsAliyunRoleProvisioning(actor as never, {
        conversationId: "conversation-42",
      });
      if (started.status !== "ready") throw new Error("expected ready");
      const rosUrl = new URL(started.rosAuthorizationUrl);
      const templateUrl = new URL(rosUrl.searchParams.get("templateUrl") ?? "");
      const capability = templateUrl.pathname.split("/").at(-1) ?? "";
      await getPublicSiteOpsAliyunRosTemplate(capability);
      await probeSiteOpsAliyunRole(actor as never, {
        conversationId: "conversation-42",
      });

      const serialized = JSON.stringify(consoleInfo.mock.calls);
      for (const forbidden of [
        capability,
        started.rosAuthorizationUrl,
        EXTERNAL_ID,
        ACCOUNT_UID,
        ROLE_ARN,
        BROKER_ARN,
        "never-return-access-key-id",
        "never-return-access-key-secret",
        "oauth-app-secret-sentinel",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(serialized).toContain("ros_capability_issue");
      expect(serialized).toContain("ros_template_fetch");
      expect(serialized).toContain("role_probe");
      expect(serialized).toContain("templateVersion");
      expect(serialized).toContain("correlationId");
    } finally {
      consoleInfo.mockRestore();
    }
  });
});
