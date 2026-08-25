import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import { assertFrontMindPublicUrlConfigured } from "../public-url";
import { ALIYUN_CUSTOMER_ROLE_ACTIONS } from "./aliyun-platform-service";

const CAPABILITY_VERSION = "ar1" as const;
export const ALIYUN_ROS_TEMPLATE_VERSION = 1 as const;
const CAPABILITY_TTL_MS = 20 * 60_000;
const TOKEN_AAD = Buffer.from(
  "frontmind-dashboard/aliyun-ros-template-capability:v1",
  "utf8",
);
const TOKEN_DERIVATION_SALT = Buffer.from(
  "frontmind-dashboard/aliyun-ros-template-capability/salt/v1",
  "utf8",
);
const TOKEN_DERIVATION_INFO = Buffer.from(
  "frontmind-dashboard/aliyun-ros-template-capability/aes-256-gcm/v1",
  "utf8",
);

const aliyunRosCapabilityClaimsSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("aliyun_ros_template"),
    templateVersion: z.literal(ALIYUN_ROS_TEMPLATE_VERSION),
    correlationId: z.string().regex(/^[a-f0-9]{24}$/u),
    connectionId: z.string().uuid(),
    projectId: z.string().uuid(),
    userId: z.number().int().positive(),
    externalIdFingerprint: z.string().regex(/^[a-f0-9]{32}$/u),
    roleArnFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    brokerCredentialId: z.string().uuid(),
    brokerCredentialVersion: z.number().int().positive(),
    brokerPrincipalFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type AliyunRosCapabilityClaims = z.infer<
  typeof aliyunRosCapabilityClaimsSchema
>;

export class AliyunRosProvisioningError extends Error {
  constructor(
    readonly code:
      | "CAPABILITY_SECRET_UNAVAILABLE"
      | "CAPABILITY_INVALID"
      | "CAPABILITY_EXPIRED"
      | "PROVISIONING_INPUT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "AliyunRosProvisioningError";
  }
}

function invalidCapability(message = "Invalid Aliyun ROS capability"): never {
  throw new AliyunRosProvisioningError("CAPABILITY_INVALID", message);
}

function decodeCredentialMasterKey(value: string) {
  const trimmed = value.trim();
  let decoded: Buffer;
  try {
    if (trimmed.startsWith("base64:")) {
      decoded = Buffer.from(trimmed.slice("base64:".length), "base64");
    } else if (trimmed.startsWith("hex:")) {
      decoded = Buffer.from(trimmed.slice("hex:".length), "hex");
    } else if (/^[a-f\d]{64}$/iu.test(trimmed)) {
      decoded = Buffer.from(trimmed, "hex");
    } else {
      decoded = Buffer.from(trimmed, "base64");
    }
  } catch {
    throw new AliyunRosProvisioningError(
      "CAPABILITY_SECRET_UNAVAILABLE",
      "Aliyun ROS capability key is invalid",
    );
  }
  if (decoded.length !== 32) {
    throw new AliyunRosProvisioningError(
      "CAPABILITY_SECRET_UNAVAILABLE",
      "Aliyun ROS capability key must contain exactly 32 bytes",
    );
  }
  return decoded;
}

export function deriveAliyunRosCapabilityKey(encodedMasterKey: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeCredentialMasterKey(encodedMasterKey),
      TOKEN_DERIVATION_SALT,
      TOKEN_DERIVATION_INFO,
      32,
    ),
  );
}

function resolveCapabilityKey() {
  const configured = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new AliyunRosProvisioningError(
      "CAPABILITY_SECRET_UNAVAILABLE",
      "Aliyun ROS capability key is not configured",
    );
  }
  return deriveAliyunRosCapabilityKey(configured);
}

export function fingerprintAliyunProvisioningValue(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function issueAliyunRosTemplateCapability(
  input: Omit<
    AliyunRosCapabilityClaims,
    "v" | "kind" | "templateVersion" | "correlationId" | "iat" | "exp"
  >,
  nowMs = Date.now(),
) {
  const correlationId = randomBytes(12).toString("hex");
  const claims = aliyunRosCapabilityClaimsSchema.parse({
    v: 1,
    kind: "aliyun_ros_template",
    templateVersion: ALIYUN_ROS_TEMPLATE_VERSION,
    correlationId,
    ...input,
    iat: nowMs,
    exp: nowMs + CAPABILITY_TTL_MS,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveCapabilityKey(), iv);
  cipher.setAAD(TOKEN_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    token: [
      CAPABILITY_VERSION,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      authTag.toString("base64url"),
    ].join("."),
    expiresAt: new Date(claims.exp).toISOString(),
    correlationId,
    templateVersion: ALIYUN_ROS_TEMPLATE_VERSION,
  };
}

export function readAliyunRosTemplateCapability(
  token: string,
  nowMs = Date.now(),
) {
  if (token.length < 40 || token.length > 2_048) invalidCapability();
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== CAPABILITY_VERSION) {
    invalidCapability();
  }
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const authTag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length < 16) {
      invalidCapability();
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      resolveCapabilityKey(),
      iv,
    );
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(authTag);
    const claims = aliyunRosCapabilityClaimsSchema.parse(
      JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          "utf8",
        ),
      ),
    );
    if (claims.exp <= nowMs || claims.iat > nowMs + 30_000) {
      throw new AliyunRosProvisioningError(
        "CAPABILITY_EXPIRED",
        "Aliyun ROS capability expired",
      );
    }
    if (claims.exp - claims.iat !== CAPABILITY_TTL_MS) invalidCapability();
    return claims;
  } catch (error) {
    if (error instanceof AliyunRosProvisioningError) throw error;
    invalidCapability();
  }
}

type AliyunRoleAuthorizationPackage = {
  schemaVersion: 1;
  roleName: string;
  description: string;
  trustPolicyDocument: {
    Version: string;
    Statement: Array<{
      Action: string;
      Effect: string;
      Principal: { RAM: string[] };
      Condition: { StringEquals: { "sts:ExternalId": string } };
    }>;
  };
  permissionPolicyDocument: {
    Version: string;
    Statement: Array<{
      Action: string[];
      Effect: string;
      Resource: string[];
    }>;
  };
};

export function buildAliyunRosRoleTemplate(
  authorization: AliyunRoleAuthorizationPackage,
) {
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      roleName: z.string().regex(/^FrontMindSiteOps-[a-f0-9]{12}$/u),
      description: z.string().min(1).max(1_024),
      trustPolicyDocument: z
        .object({
          Version: z.literal("1"),
          Statement: z
            .array(
              z
                .object({
                  Action: z.literal("sts:AssumeRole"),
                  Effect: z.literal("Allow"),
                  Principal: z
                    .object({
                      RAM: z
                        .array(
                          z
                            .string()
                            .regex(/^acs:ram::\d+:user\/[A-Za-z0-9.@_-]+$/u),
                        )
                        .length(1),
                    })
                    .strict(),
                  Condition: z
                    .object({
                      StringEquals: z
                        .object({
                          "sts:ExternalId": z.string().uuid(),
                        })
                        .strict(),
                    })
                    .strict(),
                })
                .strict(),
            )
            .length(1),
        })
        .strict(),
      permissionPolicyDocument: z
        .object({
          Version: z.literal("1"),
          Statement: z
            .array(
              z
                .object({
                  Action: z.array(z.string().min(1)).min(1),
                  Effect: z.literal("Allow"),
                  Resource: z.array(z.string().min(1)).min(1),
                })
                .strict(),
            )
            .length(1),
        })
        .strict(),
    })
    .strict()
    .parse(authorization);
  const statement = parsed.trustPolicyDocument.Statement[0];
  const permissionStatement = parsed.permissionPolicyDocument.Statement[0];
  const allowedActions = new Set<string>(ALIYUN_CUSTOMER_ROLE_ACTIONS);
  const submittedActions = new Set(permissionStatement.Action);
  if (
    submittedActions.size !== permissionStatement.Action.length ||
    submittedActions.size !== allowedActions.size ||
    [...submittedActions].some((action) => !allowedActions.has(action)) ||
    permissionStatement.Resource.length !== 1 ||
    permissionStatement.Resource[0] !== "*"
  ) {
    throw new AliyunRosProvisioningError(
      "PROVISIONING_INPUT_INVALID",
      "Aliyun ROS role permissions do not match the locked SiteOps policy",
    );
  }
  const externalId = statement.Condition.StringEquals["sts:ExternalId"];
  return {
    ROSTemplateFormatVersion: "2015-09-01",
    Metadata: {
      FrontMindTemplate: "aliyun-siteops-role",
      FrontMindTemplateVersion: ALIYUN_ROS_TEMPLATE_VERSION,
    },
    Description: {
      "zh-cn": "创建 FrontMind 域名与解析自动化专用跨账号 RAM 角色",
      en: "Create the dedicated FrontMind cross-account SiteOps RAM role",
    },
    Parameters: {
      FrontMindExternalId: {
        Type: "String",
        NoEcho: true,
        Default: externalId,
        MinLength: 36,
        MaxLength: 36,
        AllowedPattern: "^[A-Fa-f0-9-]{36}$",
        Label: {
          "zh-cn": "FrontMind 安全授权标识",
          en: "FrontMind security binding",
        },
      },
    },
    Resources: {
      FrontMindSiteOpsRole: {
        Type: "ALIYUN::RAM::Role",
        Properties: {
          RoleName: parsed.roleName,
          Description: parsed.description,
          MaxSessionDuration: 3_600,
          IgnoreExisting: false,
          DeletionForce: false,
          AssumeRolePolicyDocument: {
            Version: "1",
            Statement: [
              {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: statement.Principal,
                Condition: {
                  StringEquals: {
                    "sts:ExternalId": { Ref: "FrontMindExternalId" },
                  },
                },
              },
            ],
          },
          Policies: [
            {
              PolicyName: "FrontMindSiteOpsPolicy",
              PolicyDocument: {
                Version: "1",
                Statement: [
                  {
                    Action: [...ALIYUN_CUSTOMER_ROLE_ACTIONS],
                    Effect: "Allow",
                    Resource: ["*"],
                  },
                ],
              },
            },
          ],
        },
      },
    },
    Outputs: {
      RoleName: {
        Value: {
          "Fn::GetAtt": ["FrontMindSiteOpsRole", "RoleName"],
        },
      },
      RoleArn: {
        Value: {
          "Fn::GetAtt": ["FrontMindSiteOpsRole", "Arn"],
        },
      },
    },
  };
}

export function buildAliyunRosAuthorizationUrl(input: {
  capability: string;
  roleName: string;
  env?: NodeJS.ProcessEnv;
}) {
  const roleName = z
    .string()
    .regex(/^FrontMindSiteOps-[a-f0-9]{12}$/u)
    .parse(input.roleName);
  const capability = z.string().min(40).max(2_048).parse(input.capability);
  const publicUrl = assertFrontMindPublicUrlConfigured(input.env);
  const templateUrl = new URL(
    `/api/site-ops/aliyun/ros-template/${encodeURIComponent(capability)}`,
    `${publicUrl}/`,
  );
  const rosUrl = new URL(
    "https://ros.console.aliyun.com/cn-hangzhou/stacks/create",
  );
  rosUrl.searchParams.set("step", "1");
  rosUrl.searchParams.set("templateType", "url");
  rosUrl.searchParams.set("templateUrl", templateUrl.toString());
  rosUrl.searchParams.set("stackNamePrefix", roleName);
  rosUrl.searchParams.set("hideTemplateSelector", "true");
  rosUrl.searchParams.set("isSimplified", "true");
  rosUrl.searchParams.set("productNavBar", "disabled");
  rosUrl.searchParams.set("showTag", "false");
  rosUrl.searchParams.set("disableRollback", "false");
  rosUrl.searchParams.set(
    "pageTitle",
    JSON.stringify({
      "zh-cn": "创建 FrontMind 安全角色",
      en: "Create FrontMind secure role",
    }),
  );
  return rosUrl.toString();
}
