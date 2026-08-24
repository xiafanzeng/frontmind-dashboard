import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import Sts from "@alicloud/sts20150401";
import * as OpenApi from "@alicloud/openapi-client";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import {
  presalesApiCredentials,
  siteOperations,
  siteProviderConnections,
  type PresalesApiCredential,
} from "../../drizzle/schema";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
  getApiKeyFingerprint,
} from "../auth-service";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import { getDb } from "../db";

export const ALIYUN_PLATFORM_UID = "1244409121609391";
export const ALIYUN_CUSTOMER_ROLE_NAME = "FrontMindSiteOpsAccess";
export const ALIYUN_BROKER_CREDENTIAL_SLOT = "siteops_aliyun_broker";
export const ALIYUN_OAUTH_CREDENTIAL_SLOT = "siteops_aliyun_oauth";
export const ALIYUN_OAUTH_AUTHORIZE_ENDPOINT =
  "https://signin.aliyun.com/oauth2/v1/auth";
export const ALIYUN_OAUTH_TOKEN_ENDPOINT = "https://oauth.aliyun.com/v1/token";
export const ALIYUN_OAUTH_USERINFO_ENDPOINT =
  "https://oauth.aliyun.com/v1/userinfo";
export const ALIYUN_OIDC_DISCOVERY_ENDPOINT =
  "https://oauth.aliyun.com/.well-known/openid-configuration";
export const ALIYUN_DOMAIN_READ_ACTIONS = [
  "domain:QueryDomain",
  "domain:QueryCommonInfo",
  "domain:QueryRegistrantProfile",
  "domain:QueryDomainTask",
] as const;
export const ALIYUN_DOMAIN_PURCHASE_ACTIONS = [
  ...ALIYUN_DOMAIN_READ_ACTIONS,
  "domain:CreateOrderActivate",
] as const;
export const ALIYUN_DOMAIN_RENEW_ACTIONS = [
  "domain:QueryDomain",
  "domain:QueryCommonInfo",
  "domain:QueryDomainTask",
  "domain:CreateOrderRenew",
] as const;
export const ALIYUN_DOMAIN_AUTO_RENEW_ACTIONS = [
  "domain:QueryCommonInfo",
  "domain:SetupDomainAutoRenew",
] as const;
export const ALIYUN_CUSTOMER_ROLE_ACTIONS = [
  ...ALIYUN_DOMAIN_READ_ACTIONS,
  "domain:CreateOrderActivate",
  "domain:CreateOrderRenew",
  "domain:SetupDomainAutoRenew",
  "alidns:DescribeDomains",
  "alidns:DescribeDomainRecords",
  "alidns:DescribeDomainRecordInfo",
  "alidns:AddDomainRecord",
  "alidns:UpdateDomainRecord",
  "alidns:UpdateDomainRecordRemark",
  "alidns:DeleteDomainRecord",
] as const;

const STS_ENDPOINT = "sts.cn-hangzhou.aliyuncs.com";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const OAUTH_STATE_TTL_MS = 10 * 60_000;

const noControlCharacters = (value: string) =>
  !/[\u0000-\u001f\u007f]/u.test(value);

export const aliyunBrokerCredentialInputSchema = z
  .object({
    accessKeyId: z.string().trim().min(8).max(128).refine(noControlCharacters),
    accessKeySecret: z
      .string()
      .trim()
      .min(16)
      .max(4_096)
      .refine(noControlCharacters),
    principalArn: z
      .string()
      .trim()
      .regex(/^acs:ram::1244409121609391:user\/[A-Za-z0-9.@_-]+$/),
  })
  .strict();

export const aliyunOAuthCredentialInputSchema = z
  .object({
    clientId: z.string().trim().min(4).max(256).refine(noControlCharacters),
    clientSecret: z
      .string()
      .trim()
      .min(16)
      .max(4_096)
      .refine(noControlCharacters),
    callbackUrl: z
      .string()
      .url()
      .max(2_048)
      .transform((value, context) => {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          url.search ||
          url.hash ||
          url.pathname !== "/api/site-ops/aliyun/oauth/callback"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "阿里云 OAuth 回调必须是无查询参数的 HTTPS SiteOps 回调地址。",
          });
          return z.NEVER;
        }
        return url.toString();
      }),
  })
  .strict();

export type AliyunBrokerCredential = z.infer<
  typeof aliyunBrokerCredentialInputSchema
>;
export type AliyunOAuthCredential = z.infer<
  typeof aliyunOAuthCredentialInputSchema
>;

type PlatformCredentialSlot =
  | typeof ALIYUN_BROKER_CREDENTIAL_SLOT
  | typeof ALIYUN_OAUTH_CREDENTIAL_SLOT;

type AliyunPlatformCredentialStatus = {
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  version: number | null;
  verifiedAt: number | null;
  updatedAt: number | null;
};

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function credentialAad(slot: PlatformCredentialSlot, credentialId: string) {
  return `frontmind-aliyun-platform-credential:v1:${slot}:${credentialId}`;
}

function canonicalCredentialJson(value: unknown) {
  return JSON.stringify(value);
}

export function encryptAliyunPlatformCredential(
  slot: PlatformCredentialSlot,
  credentialId: string,
  value: AliyunBrokerCredential | AliyunOAuthCredential,
) {
  return encryptCredentialSecret(
    credentialAad(slot, credentialId),
    canonicalCredentialJson(value),
  );
}

export function decryptAliyunPlatformCredential<T>(
  slot: PlatformCredentialSlot,
  credential: Pick<
    PresalesApiCredential,
    | "id"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return JSON.parse(
    decryptCredentialSecret(credentialAad(slot, credential.id), credential),
  ) as T;
}

function toStatus(
  credential: PresalesApiCredential | undefined,
): AliyunPlatformCredentialStatus {
  const visible = credential && credential.status !== "deleted";
  const configured = Boolean(
    visible &&
      credential?.status === "active" &&
      credential.validationStatus === "verified",
  );
  return {
    configured,
    fingerprint: visible ? (credential?.fingerprint ?? null) : null,
    status: visible
      ? credential?.validationStatus === "invalid"
        ? "invalid"
        : credential?.status === "active"
          ? "active"
          : credential?.status === "retired"
            ? "retired"
            : null
      : null,
    version: visible ? (credential?.version ?? null) : null,
    verifiedAt: visible ? (credential?.verifiedAt?.getTime() ?? null) : null,
    updatedAt: visible ? (credential?.updatedAt?.getTime() ?? null) : null,
  };
}

async function latestCredential(slot: PlatformCredentialSlot) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, slot),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return rows[0];
}

async function activeCredential(slot: PlatformCredentialSlot) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, slot),
        eq(presalesApiCredentials.status, "active"),
        eq(presalesApiCredentials.validationStatus, "verified"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return rows[0];
}

async function activeStoredCredential(slot: PlatformCredentialSlot) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, slot),
        eq(presalesApiCredentials.status, "active"),
        ne(presalesApiCredentials.validationStatus, "invalid"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return rows[0];
}

async function credentialById(
  slot: PlatformCredentialSlot,
  credentialId: string,
) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, credentialId),
        eq(presalesApiCredentials.slot, slot),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  return rows[0];
}

async function boundedJson(
  response: Response,
  allowedStatus = 200,
): Promise<Record<string, unknown>> {
  if (response.status !== allowedStatus) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      `阿里云身份服务返回 HTTP ${response.status}`,
    );
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "阿里云身份服务响应超过安全上限",
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "阿里云身份服务响应超过安全上限",
    );
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "阿里云身份服务返回了无效响应",
    );
  }
  return value as Record<string, unknown>;
}

export async function inspectAliyunOAuthConfiguration(
  _credential: AliyunOAuthCredential,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(ALIYUN_OIDC_DISCOVERY_ENDPOINT, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  const document = await boundedJson(response);
  if (
    document.authorization_endpoint !== ALIYUN_OAUTH_AUTHORIZE_ENDPOINT ||
    document.token_endpoint !== ALIYUN_OAUTH_TOKEN_ENDPOINT ||
    document.userinfo_endpoint !== ALIYUN_OAUTH_USERINFO_ENDPOINT
  ) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "阿里云 OIDC 发现文档与 FrontMind 锁定端点不一致",
    );
  }
  const scopes = Array.isArray(document.scopes_supported)
    ? document.scopes_supported.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (!["openid", "aliuid", "profile"].every((item) => scopes.includes(item))) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "阿里云 OAuth 未提供所需账号身份范围",
    );
  }
  return { ok: true as const, scopes: ["openid", "aliuid", "profile"] };
}

export async function inspectAliyunBrokerCredential(
  credential: AliyunBrokerCredential,
  getCallerIdentity: (
    value: AliyunBrokerCredential,
  ) => Promise<{
    body?: { accountId?: string; arn?: string };
  }> = requestAliyunBrokerCallerIdentity,
) {
  let response: { body?: { accountId?: string; arn?: string } };
  try {
    response = await getCallerIdentity(credential);
  } catch (error) {
    throwAliyunBrokerInspectionError(error, credential);
  }
  const accountId = response.body?.accountId;
  const arn = response.body?.arn ?? null;
  if (accountId !== ALIYUN_PLATFORM_UID) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Broker 服务身份不属于 FrontMind 锁定阿里云账号",
    );
  }
  if (!arn || arn.toLowerCase() !== credential.principalArn.toLowerCase()) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Broker principal ARN 与阿里云返回身份不一致",
    );
  }
  return {
    ok: true as const,
    accountId,
    principalArn: credential.principalArn,
  };
}

async function requestAliyunBrokerCallerIdentity(
  credential: AliyunBrokerCredential,
) {
  const client = new Sts(
    new OpenApi.Config({
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      endpoint: STS_ENDPOINT,
      protocol: "HTTPS",
      regionId: "cn-hangzhou",
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      userAgent: "frontmind-siteops/2.1",
    }),
  );
  return client.getCallerIdentity();
}

type AliyunSdkErrorDetails = {
  errorClass: string;
  providerCode: string | null;
  statusCode: number | null;
  requestId: string | null;
};

function safeProviderCoordinate(value: unknown, maxLength = 160) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return /^[A-Za-z0-9._:/-]+$/u.test(normalized) ? normalized : null;
}

export function aliyunSdkErrorDetails(error: unknown): AliyunSdkErrorDetails {
  if (!error || typeof error !== "object") {
    return {
      errorClass: "UnknownError",
      providerCode: null,
      statusCode: null,
      requestId: null,
    };
  }
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    data?: unknown;
  };
  const data =
    candidate.data && typeof candidate.data === "object"
      ? (candidate.data as Record<string, unknown>)
      : {};
  const statusCandidate = candidate.statusCode ?? data.statusCode;
  const statusCode =
    typeof statusCandidate === "number" && Number.isInteger(statusCandidate)
      ? statusCandidate
      : typeof statusCandidate === "string" && /^\d{3}$/u.test(statusCandidate)
        ? Number(statusCandidate)
        : null;
  return {
    errorClass: safeProviderCoordinate(candidate.name) ?? "Error",
    providerCode: safeProviderCoordinate(candidate.code),
    statusCode,
    requestId: safeProviderCoordinate(data.RequestId ?? data.requestId),
  };
}

export function throwAliyunBrokerInspectionError(
  error: unknown,
  credential: AliyunBrokerCredential,
): never {
  if (error instanceof AuthServiceError) throw error;
  const details = aliyunSdkErrorDetails(error);
  console.error("[SiteOps Aliyun] broker_identity_check_failed", {
    event: "siteops_aliyun_broker_identity_check_failed",
    stage: "get_caller_identity",
    ...details,
    error: runtimeErrorForLog(error, {
      additionalSecrets: [credential.accessKeyId, credential.accessKeySecret],
    }),
  });

  const providerCode = details.providerCode ?? "";
  if (/SignatureDoesNotMatch/iu.test(providerCode)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "AccessKey ID 与 AccessKey Secret 不匹配；请使用同一次创建时保存的一对值后重试。",
    );
  }
  if (/InvalidAccessKeyId|InvalidCredentials/iu.test(providerCode)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "AccessKey ID 不存在、已删除或已停用；请在 frontmind-siteops RAM 用户下重新创建 AccessKey 后重试。",
    );
  }
  if (
    /(?:AccessKey|User).*(?:Disabled|Inactive)|Forbidden\.(?:RAM|AccessKey|User)/iu.test(
      providerCode,
    ) ||
    details.statusCode === 401 ||
    details.statusCode === 403
  ) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "frontmind-siteops RAM 用户或 AccessKey 已停用，无法通过阿里云身份验证。",
    );
  }
  if (
    details.statusCode === 429 ||
    /^(?:Throttling.*|TooManyRequests)$/iu.test(providerCode)
  ) {
    throw new AuthServiceError(
      "RATE_LIMITED",
      "阿里云 STS 请求过于频繁，请稍后重试；现有平台配置未被覆盖。",
    );
  }
  if (
    (details.statusCode !== null && details.statusCode >= 500) ||
    /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|TimeoutError|UnretryableError)$/iu.test(
      providerCode || details.errorClass,
    )
  ) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "阿里云 STS 暂时不可用，请稍后重试；现有平台配置未被覆盖。",
    );
  }
  throw new AuthServiceError(
    "UPSTREAM_UNAVAILABLE",
    "阿里云暂时无法验证 Broker 身份，请稍后重试；现有平台配置未被覆盖。",
  );
}

async function replaceCredential<
  T extends AliyunBrokerCredential | AliyunOAuthCredential,
>(input: {
  actorUserId: number;
  slot: PlatformCredentialSlot;
  value: T;
  inspect: (value: T) => Promise<unknown>;
  verifiedAfterInspection?: boolean;
}) {
  await input.inspect(input.value);
  const db = await requireDb();
  const credentialId = randomUUID();
  const encrypted = encryptAliyunPlatformCredential(
    input.slot,
    credentialId,
    input.value,
  );
  const fingerprint = getApiKeyFingerprint(
    canonicalCredentialJson(input.value),
  );
  const now = new Date();
  const inserted = await db.transaction(async (tx) => {
    const latest = await tx
      .select()
      .from(presalesApiCredentials)
      .where(eq(presalesApiCredentials.slot, input.slot))
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx
      .update(presalesApiCredentials)
      .set({ status: "retired", retiredAt: now, updatedAt: now })
      .where(
        and(
          eq(presalesApiCredentials.slot, input.slot),
          eq(presalesApiCredentials.status, "active"),
        ),
      );
    const verified = input.verifiedAfterInspection !== false;
    const row = {
      id: credentialId,
      slot: input.slot,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active" as const,
      validationStatus: verified
        ? ("verified" as const)
        : ("unverified" as const),
      createdByUserId: input.actorUserId,
      verifiedAt: verified ? now : null,
      retiredAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(presalesApiCredentials).values(row);
    return row;
  });
  return toStatus(inserted as PresalesApiCredential);
}

export async function replaceAliyunBrokerCredential(
  actorUserId: number,
  rawInput: AliyunBrokerCredential,
  inspect: (
    value: AliyunBrokerCredential,
  ) => Promise<unknown> = inspectAliyunBrokerCredential,
) {
  const value = aliyunBrokerCredentialInputSchema.parse(rawInput);
  const existing = await getActiveAliyunBrokerCredential();
  if (
    existing &&
    existing.principalArn.toLowerCase() !== value.principalArn.toLowerCase()
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "Broker principal ARN 已锁定；请保持同一 RAM 身份轮换 AccessKey。",
    );
  }
  return replaceCredential({
    actorUserId,
    slot: ALIYUN_BROKER_CREDENTIAL_SLOT,
    value,
    inspect,
  });
}

export async function replaceAliyunOAuthCredential(
  actorUserId: number,
  rawInput: AliyunOAuthCredential,
  inspect: (
    value: AliyunOAuthCredential,
  ) => Promise<unknown> = inspectAliyunOAuthConfiguration,
) {
  const value = aliyunOAuthCredentialInputSchema.parse(rawInput);
  return replaceCredential({
    actorUserId,
    slot: ALIYUN_OAUTH_CREDENTIAL_SLOT,
    value,
    inspect,
    verifiedAfterInspection: false,
  });
}

export async function getActiveAliyunBrokerCredential() {
  const credential = await activeCredential(ALIYUN_BROKER_CREDENTIAL_SLOT);
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    ...aliyunBrokerCredentialInputSchema.parse(
      decryptAliyunPlatformCredential<AliyunBrokerCredential>(
        ALIYUN_BROKER_CREDENTIAL_SLOT,
        credential,
      ),
    ),
  };
}

export async function getPinnedAliyunBrokerCredential(
  credentialId: string,
  credentialVersion: number,
) {
  const credential = await credentialById(
    ALIYUN_BROKER_CREDENTIAL_SLOT,
    z.string().uuid().parse(credentialId),
  );
  if (!credential || credential.version !== credentialVersion) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    ...aliyunBrokerCredentialInputSchema.parse(
      decryptAliyunPlatformCredential<AliyunBrokerCredential>(
        ALIYUN_BROKER_CREDENTIAL_SLOT,
        credential,
      ),
    ),
  };
}

export async function getActiveAliyunOAuthCredential() {
  const credential = await activeStoredCredential(ALIYUN_OAUTH_CREDENTIAL_SLOT);
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    ...aliyunOAuthCredentialInputSchema.parse(
      decryptAliyunPlatformCredential<AliyunOAuthCredential>(
        ALIYUN_OAUTH_CREDENTIAL_SLOT,
        credential,
      ),
    ),
  };
}

async function getAliyunOAuthCredentialById(credentialId: string) {
  const credential = await credentialById(
    ALIYUN_OAUTH_CREDENTIAL_SLOT,
    credentialId,
  );
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    ...aliyunOAuthCredentialInputSchema.parse(
      decryptAliyunPlatformCredential<AliyunOAuthCredential>(
        ALIYUN_OAUTH_CREDENTIAL_SLOT,
        credential,
      ),
    ),
  };
}

export async function getAliyunPlatformCredentialStatus() {
  const db = await requireDb();
  const [broker, oauth, verifiedConnections] = await Promise.all([
    latestCredential(ALIYUN_BROKER_CREDENTIAL_SLOT),
    latestCredential(ALIYUN_OAUTH_CREDENTIAL_SLOT),
    db
      .select({ capabilities: siteProviderConnections.capabilities })
      .from(siteProviderConnections)
      .where(eq(siteProviderConnections.status, "active")),
  ]);
  const brokerStatus = toStatus(broker);
  const oauthStatus = {
    ...toStatus(oauth),
    configured: Boolean(
      oauth &&
        oauth.status === "active" &&
        oauth.validationStatus !== "invalid",
    ),
  };
  const oauthValue = oauthStatus.configured
    ? await getActiveAliyunOAuthCredential()
    : null;
  const identityConfigured =
    brokerStatus.configured && Boolean(oauthStatus.verifiedAt);
  const customerCapabilityVerified = verifiedConnections.some(
    (row: { capabilities: string[] }) =>
      row.capabilities.includes("domain_read") &&
      row.capabilities.includes("alidns_read"),
  );
  return {
    platformUid: ALIYUN_PLATFORM_UID,
    customerRoleName: ALIYUN_CUSTOMER_ROLE_NAME,
    identityConfigured,
    ready: identityConfigured && customerCapabilityVerified,
    customerCapabilityVerified,
    broker: brokerStatus,
    oauth: {
      ...oauthStatus,
      callbackUrl: oauthValue?.callbackUrl ?? null,
    },
  };
}

export async function testAliyunPlatformCredentials(
  target: "broker" | "oauth" | "all" = "all",
) {
  const [broker, oauth] = await Promise.all([
    target === "oauth"
      ? Promise.resolve(null)
      : getActiveAliyunBrokerCredential(),
    target === "broker"
      ? Promise.resolve(null)
      : getActiveAliyunOAuthCredential(),
  ]);
  if (target !== "oauth" && !broker) {
    throw new AuthServiceError("NOT_FOUND", "请先配置阿里云 Broker 凭据");
  }
  if (target !== "broker" && !oauth) {
    throw new AuthServiceError("NOT_FOUND", "请先配置阿里云 OAuth 应用");
  }
  const [brokerResult, oauthResult] = await Promise.all([
    broker ? inspectAliyunBrokerCredential(broker) : Promise.resolve(null),
    oauth ? inspectAliyunOAuthConfiguration(oauth) : Promise.resolve(null),
  ]);
  return { ok: true as const, broker: brokerResult, oauth: oauthResult };
}

export async function deleteAliyunPlatformCredentials(
  target: "broker" | "oauth" | "all" = "all",
) {
  const slots =
    target === "all"
      ? [ALIYUN_BROKER_CREDENTIAL_SLOT, ALIYUN_OAUTH_CREDENTIAL_SLOT]
      : [
          target === "broker"
            ? ALIYUN_BROKER_CREDENTIAL_SLOT
            : ALIYUN_OAUTH_CREDENTIAL_SLOT,
        ];
  const db = await requireDb();
  if (target === "broker" || target === "all") {
    const inFlight = await db
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          inArray(siteOperations.provider, ["aliyun_domain", "aliyun_alidns"]),
          inArray(siteOperations.status, [
            "queued",
            "running",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1);
    if (inFlight[0]) {
      throw new AuthServiceError(
        "CONFLICT",
        "仍有域名或解析操作使用已冻结的 Broker 凭据，完成对账后才能撤销。",
      );
    }
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const slot of slots) {
      await tx
        .update(presalesApiCredentials)
        .set({
          status: "deleted",
          validationStatus: "unverified",
          deletedAt: now,
          encryptedKey: randomBytes(32).toString("base64"),
          encryptionIv: randomBytes(12).toString("base64"),
          encryptionAuthTag: randomBytes(16).toString("base64"),
          updatedAt: now,
        })
        .where(
          and(
            eq(presalesApiCredentials.slot, slot),
            ne(presalesApiCredentials.status, "deleted"),
          ),
        );
    }
  });
  return { deleted: true as const, target };
}

const oauthStatePayloadSchema = z
  .object({
    v: z.literal(1),
    credentialId: z.string().uuid(),
    projectId: z.string().uuid(),
    userId: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();

function stateSignature(payload: string, clientSecret: string) {
  return createHmac("sha256", clientSecret)
    .update("frontmind-aliyun-oauth-state:v1\0")
    .update(payload)
    .digest("base64url");
}

export function buildAliyunOAuthState(input: {
  credentialId: string;
  projectId: string;
  userId: number;
  clientSecret: string;
  expiresAt: number;
  nonce?: string;
}) {
  const payload = Buffer.from(
    JSON.stringify(
      oauthStatePayloadSchema.parse({
        v: 1,
        credentialId: input.credentialId,
        projectId: input.projectId,
        userId: input.userId,
        nonce: input.nonce ?? randomBytes(18).toString("base64url"),
        expiresAt: input.expiresAt,
      }),
    ),
    "utf8",
  ).toString("base64url");
  return `${payload}.${stateSignature(payload, input.clientSecret)}`;
}

export async function createAliyunOAuthAuthorization(input: {
  projectId: string;
  userId: number;
  nowMs?: number;
}) {
  const credential = await getActiveAliyunOAuthCredential();
  if (!credential) {
    throw new AuthServiceError("NOT_FOUND", "域名与发布平台尚未配置完成");
  }
  const nowMs = input.nowMs ?? Date.now();
  const state = buildAliyunOAuthState({
    credentialId: credential.id,
    projectId: input.projectId,
    userId: input.userId,
    clientSecret: credential.clientSecret,
    expiresAt: nowMs + OAUTH_STATE_TTL_MS,
  });
  const url = new URL(ALIYUN_OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", credential.clientId);
  url.searchParams.set("redirect_uri", credential.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid aliuid profile");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "admin_consent");
  url.searchParams.set("state", state);
  return {
    authorizationUrl: url.toString(),
    expiresAt: new Date(nowMs + OAUTH_STATE_TTL_MS).toISOString(),
  };
}

export async function verifyAliyunOAuthState(input: {
  state: string;
  userId: number;
  nowMs?: number;
}) {
  const [payloadPart, signaturePart, extra] = input.state.split(".");
  if (!payloadPart || !signaturePart || extra || input.state.length > 4_096) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "阿里云授权状态无效");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    );
  } catch {
    throw new AuthServiceError("INVALID_CREDENTIAL", "阿里云授权状态无效");
  }
  const payload = oauthStatePayloadSchema.parse(decoded);
  if (
    payload.userId !== input.userId ||
    payload.expiresAt < (input.nowMs ?? Date.now())
  ) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "阿里云授权状态已失效");
  }
  const credential = await getAliyunOAuthCredentialById(payload.credentialId);
  if (!credential) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "阿里云授权配置已失效");
  }
  const expected = Buffer.from(
    stateSignature(payloadPart, credential.clientSecret),
    "utf8",
  );
  const actual = Buffer.from(signaturePart, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "阿里云授权状态无效");
  }
  return { payload, credential };
}

export async function exchangeAliyunOAuthCode(input: {
  code: string;
  state: string;
  userId: number;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}) {
  const code = z
    .string()
    .trim()
    .min(8)
    .max(4_096)
    .refine(noControlCharacters)
    .parse(input.code);
  const { payload, credential } = await verifyAliyunOAuthState(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenResponse = await fetchImpl(ALIYUN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      redirect_uri: credential.callbackUrl,
      grant_type: "authorization_code",
    }),
  });
  const token = await boundedJson(tokenResponse);
  const accessToken = z.string().min(8).max(16_384).parse(token.access_token);
  assertAliyunOAuthScopes(token.scope);
  const userResponse = await fetchImpl(ALIYUN_OAUTH_USERINFO_ENDPOINT, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const userInfo = await boundedJson(userResponse);
  const accountUid = z
    .string()
    .regex(/^\d{6,64}$/)
    .parse(userInfo.aid);
  const db = await requireDb();
  const now = new Date();
  await db
    .update(presalesApiCredentials)
    .set({
      validationStatus: "verified",
      verifiedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(presalesApiCredentials.id, credential.id),
        eq(presalesApiCredentials.slot, ALIYUN_OAUTH_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    );
  return {
    projectId: payload.projectId,
    userId: payload.userId,
    accountUid,
  };
}

export function assertAliyunOAuthScopes(value: unknown) {
  const grantedScopes = z
    .string()
    .max(4_096)
    .parse(value)
    .split(/\s+/u)
    .filter(Boolean);
  if (
    !["openid", "aliuid", "profile"].every((scope) =>
      grantedScopes.includes(scope),
    )
  ) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "阿里云 OAuth 授权未包含所需账号身份范围",
    );
  }
  return grantedScopes;
}
