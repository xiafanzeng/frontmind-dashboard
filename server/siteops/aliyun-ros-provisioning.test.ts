import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AliyunRosProvisioningError,
  buildAliyunRosAuthorizationUrl,
  buildAliyunRosRoleTemplate,
  fingerprintAliyunProvisioningValue,
  issueAliyunRosTemplateCapability,
  readAliyunRosTemplateCapability,
} from "./aliyun-ros-provisioning";
import { ALIYUN_CUSTOMER_ROLE_ACTIONS } from "./aliyun-platform-service";

const NOW = Date.UTC(2026, 7, 25, 8, 0, 0);
const CONNECTION_ID = "11111111-2222-4333-8444-555555555555";
const PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BROKER_ID = "99999999-8888-4777-8666-555555555555";
const EXTERNAL_ID = "12345678-1234-4234-8234-1234567890ab";
const ROLE_ARN = "acs:ram::1234567890123456:role/FrontMindSiteOps-111111112222";
const BROKER_ARN = "acs:ram::1244409121609391:user/frontmind-siteops";
const originalEncryptionKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

function capabilityInput() {
  return {
    connectionId: CONNECTION_ID,
    projectId: PROJECT_ID,
    userId: 42,
    externalIdFingerprint: fingerprintAliyunProvisioningValue(
      EXTERNAL_ID,
    ).slice(0, 32),
    roleArnFingerprint: fingerprintAliyunProvisioningValue(ROLE_ARN),
    brokerCredentialId: BROKER_ID,
    brokerCredentialVersion: 2,
    brokerPrincipalFingerprint: fingerprintAliyunProvisioningValue(BROKER_ARN),
  };
}

beforeEach(() => {
  process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
    32,
    73,
  ).toString("base64")}`;
});

afterEach(() => {
  if (originalEncryptionKey == null) {
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
  }
});

describe("Aliyun ROS provisioning capability", () => {
  it("encrypts strict connection-bound claims for exactly twenty minutes", () => {
    const issued = issueAliyunRosTemplateCapability(capabilityInput(), NOW);

    expect(issued.token).toMatch(
      /^ar1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    expect(issued.token).not.toContain(CONNECTION_ID);
    expect(issued.token).not.toContain(EXTERNAL_ID);
    expect(readAliyunRosTemplateCapability(issued.token, NOW + 1_000)).toEqual({
      v: 1,
      kind: "aliyun_ros_template",
      templateVersion: 1,
      correlationId: expect.stringMatching(/^[a-f0-9]{24}$/u),
      ...capabilityInput(),
      iat: NOW,
      exp: NOW + 20 * 60_000,
    });
    expect(() =>
      readAliyunRosTemplateCapability(issued.token, NOW + 20 * 60_000),
    ).toThrowError(AliyunRosProvisioningError);
  });

  it("rejects a tampered encrypted capability", () => {
    const issued = issueAliyunRosTemplateCapability(capabilityInput(), NOW);
    const parts = issued.token.split(".");
    const ciphertext = Buffer.from(parts[2], "base64url");
    ciphertext[Math.floor(ciphertext.length / 2)] ^= 1;
    const tampered = [
      parts[0],
      parts[1],
      ciphertext.toString("base64url"),
      parts[3],
    ].join(".");
    expect(() => readAliyunRosTemplateCapability(tampered, NOW)).toThrowError(
      AliyunRosProvisioningError,
    );
  });
});

describe("Aliyun ROS role template", () => {
  const authorization = {
    schemaVersion: 1 as const,
    roleName: "FrontMindSiteOps-111111112222",
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

  it("creates one strict RAM role and masks the per-connection ExternalId", () => {
    const template = buildAliyunRosRoleTemplate(authorization);
    expect(template.Parameters.FrontMindExternalId).toMatchObject({
      NoEcho: true,
      Default: EXTERNAL_ID,
    });
    expect(template.Metadata).toEqual({
      FrontMindTemplate: "aliyun-siteops-role",
      FrontMindTemplateVersion: 1,
    });
    expect(Object.keys(template.Resources)).toEqual(["FrontMindSiteOpsRole"]);
    expect(template.Resources.FrontMindSiteOpsRole).toMatchObject({
      Type: "ALIYUN::RAM::Role",
      Properties: {
        RoleName: authorization.roleName,
        IgnoreExisting: false,
        DeletionForce: false,
        MaxSessionDuration: 3_600,
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Principal: { RAM: [BROKER_ARN] },
              Condition: {
                StringEquals: {
                  "sts:ExternalId": { Ref: "FrontMindExternalId" },
                },
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(template.Outputs)).not.toContain(EXTERNAL_ID);
    expect(JSON.stringify(template)).not.toContain("ram:*");
    expect(JSON.stringify(template)).not.toContain("ros:*");
  });

  it("rejects any permission outside the locked SiteOps action set", () => {
    expect(() =>
      buildAliyunRosRoleTemplate({
        ...authorization,
        permissionPolicyDocument: {
          ...authorization.permissionPolicyDocument,
          Statement: [
            {
              ...authorization.permissionPolicyDocument.Statement[0],
              Action: [...ALIYUN_CUSTOMER_ROLE_ACTIONS, "ram:*"],
            },
          ],
        },
      }),
    ).toThrowError(AliyunRosProvisioningError);
  });

  it("builds only the official ROS URL without raw provider identifiers", () => {
    const capability = issueAliyunRosTemplateCapability(capabilityInput(), NOW);
    const value = buildAliyunRosAuthorizationUrl({
      capability: capability.token,
      roleName: authorization.roleName,
      env: {
        NODE_ENV: "production",
        FRONTMIND_PUBLIC_URL: "https://dashboard.frontmind.net",
      },
    });
    const url = new URL(value);
    expect(url.origin).toBe("https://ros.console.aliyun.com");
    expect(url.pathname).toBe("/cn-hangzhou/stacks/create");
    expect(url.searchParams.get("step")).toBe("1");
    expect(url.searchParams.get("disableRollback")).toBe("false");
    const templateUrl = url.searchParams.get("templateUrl") ?? "";
    expect(templateUrl).toBe(
      `https://dashboard.frontmind.net/api/site-ops/aliyun/ros-template/${capability.token}`,
    );
    expect(value).not.toContain(EXTERNAL_ID);
    expect(value).not.toContain(BROKER_ARN);
    expect(value).not.toContain("1234567890123456");
  });
});
