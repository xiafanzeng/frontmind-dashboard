import { createHash, randomUUID } from "node:crypto";
import {
  resolve4,
  resolve6,
  resolveCname,
  resolveTxt,
} from "node:dns/promises";
import { domainToASCII, domainToUnicode } from "node:url";

import AliDns, * as AliDnsModels from "@alicloud/alidns20150109";
import Credential from "@alicloud/credentials";
import Domain, * as DomainModels from "@alicloud/domain20180129";
import * as OpenApi from "@alicloud/openapi-client";
import Sts, * as StsModels from "@alicloud/sts20150401";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";

import {
  siteDnsRecords,
  siteDeployments,
  siteDomainOperations,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  workspaceSiteProfiles,
  type SiteDomainOperation,
  type SiteDnsRecord,
  type SiteOperation,
  type SiteProviderConnection,
} from "../../drizzle/schema";
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "../auth-service";
import { getDb } from "../db";
import {
  registerSiteOpsProviderHandler,
  type SiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";

const STS_ENDPOINT = "sts.cn-hangzhou.aliyuncs.com";
const DOMAIN_ENDPOINT = "domain.aliyuncs.com";
const ALIDNS_ENDPOINT = "alidns.cn-hangzhou.aliyuncs.com";
const ALIYUN_REQUEST_TIMEOUT_MS = 12_000;
const QUOTE_TTL_MS = 60_000;
const RESPONSE_LOSS_RECONCILE_MS = 10 * 60_000;
const DNS_PROPAGATION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DNS_TTL = 600;

const connectionInputSchema = z
  .object({
    projectId: z.string().uuid(),
    userId: z.number().int().positive(),
    accountUid: z
      .string()
      .trim()
      .regex(/^\d{6,64}$/),
    roleArn: z
      .string()
      .trim()
      .regex(/^acs:ram::\d{6,64}:role\/[A-Za-z0-9.@_\-]+$/),
  })
  .strict();

const ownedConnectionInputSchema = z
  .object({
    projectId: z.string().uuid(),
    userId: z.number().int().positive(),
  })
  .strict();

const domainOperationInputSchema = z
  .object({
    domain: z.string().trim().min(1).max(255),
    domainUnicode: z.string().trim().min(1).max(255).optional(),
    domainIntent: z.enum(["sync"]).optional(),
    years: z.number().int().min(1).max(10).optional(),
    typedDomain: z.string().trim().min(1).max(255).optional(),
    quoteHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    domainOperationId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
    customerConfirmed: z.literal(true).optional(),
    registrantProfileId: z.string().trim().regex(/^\d+$/).optional(),
    connectionId: z.string().uuid(),
    domainLedgerId: z.string().uuid(),
  })
  .strict();

const dnsOperationInputSchema = z
  .object({
    domainRevision: z.number().int().positive().optional(),
    connectionId: z.string().uuid(),
    dnsIntent: z.enum(["plan", "apply", "rollback"]),
    planOperationId: z.string().uuid().optional(),
    planHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    providerSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dnsIntent !== "plan" && value.domainRevision == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domainRevision"],
        message: "DNS 写入或回滚必须绑定域名版本。",
      });
    }
    if (value.dnsIntent === "apply") {
      for (const field of [
        "domainRevision",
        "planOperationId",
        "planHash",
        "providerSnapshotHash",
      ] as const) {
        if (value[field] == null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "DNS apply 必须绑定已生成的精确计划。",
          });
        }
      }
    }
  });

type DbExecutor = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function assertAliyunConnectionMutable(
  db: DbExecutor,
  input: { projectId: string; userId: number },
) {
  const [running, unresolvedFinancial] = await Promise.all([
    db
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.projectId),
          eq(siteOperations.userId, input.userId),
          or(
            eq(siteOperations.provider, "aliyun_domain"),
            eq(siteOperations.provider, "aliyun_alidns"),
          ),
          inArray(siteOperations.status, [
            "queued",
            "running",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1),
    db
      .select({ id: siteDomainOperations.id })
      .from(siteDomainOperations)
      .where(
        and(
          eq(siteDomainOperations.projectId, input.projectId),
          eq(siteDomainOperations.userId, input.userId),
          isNotNull(siteDomainOperations.activeFinancialKey),
        ),
      )
      .limit(1),
  ]);
  if (running.length > 0 || unresolvedFinancial.length > 0) {
    throw new AliyunProviderError(
      "CONNECTION_IN_USE",
      "该 RAM Role 仍绑定正在执行或结果待对账的域名/DNS 操作，暂不能轮换或撤销。",
    );
  }
}

type AssumedCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string | null;
  assumedRoleArn: string | null;
};

export type AliyunRegistrantProfile = {
  profileId: string;
  holderType: "individual" | "enterprise" | "unknown";
  maskedName: string;
  realNameVerified: boolean;
  emailVerified: boolean;
  isDefault: boolean;
};

export type AliyunDomainDetails = {
  domain: string;
  instanceId: string;
  expirationDateMs: number;
  realNameStatus: string | null;
  emailStatus: string | null;
  clientHold: boolean;
  autoRenewEnabled: boolean | null;
};

export type AliyunDomainCheck = {
  domain: string;
  available: boolean;
  availabilityCode: string;
  premium: boolean;
  amountMinor: number | null;
  currency: "CNY";
  reason: string | null;
  requestId: string | null;
};

export type AliyunTaskState = {
  taskNo: string;
  state: "pending" | "succeeded" | "failed";
  domain: string | null;
  taskType: string | null;
  message: string | null;
  instanceId: string | null;
};

export type AliyunDnsRecordView = {
  recordId: string;
  rr: string;
  type: string;
  value: string;
  ttl: number;
  remark: string | null;
};

export interface AliyunDomainApi {
  checkDomain(input: {
    domain: string;
    command: "create" | "renew";
    years: number;
  }): Promise<AliyunDomainCheck>;
  listVerifiedRegistrantProfiles(): Promise<AliyunRegistrantProfile[]>;
  getDomain(domain: string): Promise<AliyunDomainDetails | null>;
  submitPurchase(input: {
    domain: string;
    years: number;
    registrantProfileId: string;
  }): Promise<{ taskNo: string; requestId: string | null }>;
  submitRenewal(input: {
    domain: string;
    years: number;
    currentExpirationDateMs: number;
  }): Promise<{ taskNo: string; requestId: string | null }>;
  setAutoRenew(input: {
    instanceId: string;
    enabled: boolean;
  }): Promise<{ ok: boolean; requestId: string | null }>;
  getTask(taskNo: string, domain: string): Promise<AliyunTaskState>;
  findTaskCandidates(input: {
    domain: string;
    kind: "purchase" | "renewal";
    createdAfter: Date;
  }): Promise<AliyunTaskState[]>;
}

export interface AliyunDnsApi {
  listRecords(domain: string): Promise<AliyunDnsRecordView[]>;
  addRecord(input: {
    domain: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }): Promise<{ recordId: string; requestId: string | null }>;
  updateRecord(input: {
    recordId: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }): Promise<{ requestId: string | null }>;
  updateRemark(input: {
    recordId: string;
    remark: string;
  }): Promise<{ requestId: string | null }>;
  deleteRecord(recordId: string): Promise<{ requestId: string | null }>;
}

export interface AliyunProviderSdkFactory {
  assumeRole(input: {
    roleArn: string;
    externalId: string;
    sessionName: string;
    policy: string;
  }): Promise<AssumedCredentials>;
  getCallerAccount(credentials: AssumedCredentials): Promise<string>;
  domain(credentials: AssumedCredentials): AliyunDomainApi;
  dns(credentials: AssumedCredentials): AliyunDnsApi;
}

export type PublicDnsResolver = (input: {
  hostname: string;
  type: string;
}) => Promise<string[]>;

export class AliyunProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AliyunProviderError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeAliyunDomain(value: string) {
  const trimmed = value.trim().replace(/\.$/, "");
  const ascii = domainToASCII(trimmed).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.includes("..") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      ascii,
    )
  ) {
    throw new AliyunProviderError("INVALID_DOMAIN", "域名格式无效。");
  }
  return { ascii, unicode: domainToUnicode(ascii) || trimmed };
}

function connectionAad(connectionId: string) {
  return `frontmind-aliyun-external-id:v1:${connectionId}`;
}

export function sealAliyunExternalId(connectionId: string, externalId: string) {
  const encrypted = encryptCredentialSecret(
    connectionAad(connectionId),
    externalId,
  );
  return {
    encryptionVersion: encrypted.encryptionVersion,
    encryptedExternalId: encrypted.encryptedKey,
    encryptionIv: encrypted.encryptionIv,
    encryptionAuthTag: encrypted.encryptionAuthTag,
    externalIdFingerprint: sha256(externalId).slice(0, 32),
  };
}

export function openAliyunExternalId(
  connection: Pick<
    SiteProviderConnection,
    | "id"
    | "encryptionVersion"
    | "encryptedExternalId"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(connectionAad(connection.id), {
    encryptionVersion: connection.encryptionVersion,
    encryptedKey: connection.encryptedExternalId,
    encryptionIv: connection.encryptionIv,
    encryptionAuthTag: connection.encryptionAuthTag,
  });
}

function roleAccount(roleArn: string) {
  return /^acs:ram::(\d+):role\//.exec(roleArn)?.[1] ?? null;
}

function operationPolicy(actions: string[]) {
  return JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: ["sts:GetCallerIdentity", ...actions],
        Resource: ["*"],
      },
    ],
  });
}

const DOMAIN_READ_POLICY = operationPolicy([
  "domain:CheckDomain",
  "domain:QueryDomainByDomainName",
  "domain:QueryDomainList",
  "domain:QueryRegistrantProfiles",
  "domain:QueryTaskList",
  "domain:QueryTaskDetailList",
]);

const DOMAIN_PURCHASE_POLICY = operationPolicy([
  "domain:CheckDomain",
  "domain:QueryDomainByDomainName",
  "domain:QueryRegistrantProfiles",
  "domain:QueryTaskList",
  "domain:QueryTaskDetailList",
  "domain:SaveSingleTaskForCreatingOrderActivate",
]);

const DOMAIN_RENEW_POLICY = operationPolicy([
  "domain:CheckDomain",
  "domain:QueryDomainByDomainName",
  "domain:QueryTaskList",
  "domain:QueryTaskDetailList",
  "domain:SaveSingleTaskForCreatingOrderRenew",
]);

const DOMAIN_AUTO_RENEW_POLICY = operationPolicy([
  "domain:QueryDomainByDomainName",
  "domain:QueryDomainList",
  "domain:SetupDomainAutoRenew",
]);

const DNS_READ_POLICY = operationPolicy([
  "alidns:DescribeDomains",
  "alidns:DescribeDomainRecords",
  "alidns:DescribeDomainRecordInfo",
]);

const DNS_WRITE_POLICY = operationPolicy([
  "alidns:DescribeDomainRecords",
  "alidns:DescribeDomainRecordInfo",
  "alidns:AddDomainRecord",
  "alidns:UpdateDomainRecord",
  "alidns:UpdateDomainRecordRemark",
  "alidns:DeleteDomainRecord",
]);

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new AliyunProviderError(
      "PROVIDER_TIMEOUT",
      "阿里云请求超时；系统不会盲目重发外部写操作。",
      true,
    );
  }
}

async function requireDb(): Promise<DbExecutor> {
  const db = await getDb();
  if (!db) {
    throw new AliyunProviderError(
      "DATABASE_UNAVAILABLE",
      "数据库未配置，无法执行阿里云操作。",
    );
  }
  return db;
}

function asDate(value: Date | string | number | null | undefined) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function maskName(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) return "***";
  const characters = Array.from(normalized);
  if (characters.length <= 2) return `${characters[0] ?? "*"}*`;
  return `${characters[0]}${"*".repeat(Math.min(6, characters.length - 2))}${characters.at(-1)}`;
}

function resultError(error: unknown): SiteOpsProviderResult {
  if (error instanceof AliyunProviderError) {
    return {
      status: error.outcomeUnknown ? "outcome_unknown" : "attention_required",
      code: error.code,
      message: error.message,
      result: error.details,
    };
  }
  return {
    status: "attention_required",
    code: "ALIYUN_PROVIDER_ERROR",
    message:
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "阿里云操作失败。",
  };
}

function temporaryConfig(credentials: AssumedCredentials, endpoint: string) {
  return new OpenApi.Config({
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    securityToken: credentials.securityToken,
    endpoint,
    protocol: "HTTPS",
    regionId: "cn-hangzhou",
    connectTimeout: ALIYUN_REQUEST_TIMEOUT_MS,
    readTimeout: ALIYUN_REQUEST_TIMEOUT_MS,
    userAgent: "frontmind-siteops/1.0",
  });
}

function amountToMinorUnits(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const fixed = value.toFixed(2);
  const [whole, fraction = ""] = fixed.split(".");
  const minor =
    Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : null;
}

function premiumFlag(value: unknown) {
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.toLowerCase() === "true";
}

function mapTaskState(
  taskNo: string,
  detail: {
    taskStatusCode?: number;
    domainName?: string;
    taskType?: string;
    failReason?: string;
    errorMsg?: string;
    instanceId?: string;
  } | null,
): AliyunTaskState {
  const code = detail?.taskStatusCode;
  return {
    taskNo,
    state: code === 2 ? "succeeded" : code === 3 ? "failed" : "pending",
    domain: detail?.domainName
      ? normalizeAliyunDomain(detail.domainName).ascii
      : null,
    taskType: detail?.taskType ?? null,
    message: detail?.failReason ?? detail?.errorMsg ?? null,
    instanceId: detail?.instanceId ?? null,
  };
}

class OfficialAliyunDomainApi implements AliyunDomainApi {
  private readonly client: Domain;

  constructor(credentials: AssumedCredentials) {
    this.client = new Domain(temporaryConfig(credentials, DOMAIN_ENDPOINT));
  }

  async checkDomain(input: {
    domain: string;
    command: "create" | "renew";
    years: number;
  }): Promise<AliyunDomainCheck> {
    const response = await this.client.checkDomain(
      new DomainModels.CheckDomainRequest({
        domainName: input.domain,
        feeCommand: input.command,
        feePeriod: input.years,
        lang: "en",
      }),
    );
    const body = response.body;
    const prices = body?.staticPriceInfo?.priceInfo ?? [];
    const preferred = prices.find((price) => {
      const action = price.action?.toLowerCase() ?? "";
      return input.command === "create"
        ? action.includes("create") || action.includes("activate")
        : action.includes("renew");
    });
    const amount = preferred?.money ?? body?.price;
    return {
      domain: normalizeAliyunDomain(body?.domainName ?? input.domain).ascii,
      available: body?.avail === "1",
      availabilityCode: body?.avail ?? "-1",
      premium: premiumFlag(body?.premium),
      amountMinor: amountToMinorUnits(amount),
      currency: "CNY",
      reason: body?.reason ?? null,
      requestId: body?.requestId ?? null,
    };
  }

  async listVerifiedRegistrantProfiles() {
    const response = await this.client.queryRegistrantProfiles(
      new DomainModels.QueryRegistrantProfilesRequest({
        pageNum: 1,
        pageSize: 500,
        realNameStatus: "SUCCEED",
        lang: "en",
      }),
    );
    return (response.body?.registrantProfiles?.registrantProfile ?? []).map(
      (profile): AliyunRegistrantProfile => {
        const holderName =
          profile.zhRegistrantOrganization ??
          profile.registrantOrganization ??
          profile.zhRegistrantName ??
          profile.registrantName;
        return {
          profileId: String(profile.registrantProfileId ?? ""),
          holderType:
            profile.registrantType === "1"
              ? "individual"
              : profile.registrantType === "2"
                ? "enterprise"
                : "unknown",
          maskedName: maskName(holderName),
          realNameVerified: profile.realNameStatus === "SUCCEED",
          emailVerified: profile.emailVerificationStatus === 1,
          isDefault: profile.defaultRegistrantProfile === true,
        };
      },
    );
  }

  async getDomain(domain: string): Promise<AliyunDomainDetails | null> {
    try {
      const [response, autoRenewResponse] = await Promise.all([
        this.client.queryDomainByDomainName(
          new DomainModels.QueryDomainByDomainNameRequest({
            domainName: domain,
            lang: "en",
          }),
        ),
        this.client.queryDomainList(
          new DomainModels.QueryDomainListRequest({
            domainName: domain,
            pageNum: 1,
            pageSize: 10,
            lang: "en",
          }),
        ),
      ]);
      const body = response.body;
      const accountDomains = autoRenewResponse.body?.data?.domain ?? [];
      const owned = accountDomains.find(
        (entry) =>
          entry.domainName &&
          normalizeAliyunDomain(entry.domainName).ascii ===
            normalizeAliyunDomain(domain).ascii,
      );
      const instanceId = body?.instanceId ?? owned?.instanceId;
      const expirationDateMs =
        body?.expirationDateLong ?? owned?.expirationDateLong;
      if (
        !body?.domainName ||
        !owned?.domainName ||
        !instanceId ||
        !expirationDateMs ||
        (body.instanceId &&
          owned.instanceId &&
          body.instanceId !== owned.instanceId)
      ) {
        return null;
      }
      return {
        domain: normalizeAliyunDomain(body.domainName).ascii,
        instanceId,
        expirationDateMs,
        realNameStatus: body.domainNameVerificationStatus ?? null,
        emailStatus:
          body.emailVerificationStatus == null
            ? null
            : String(body.emailVerificationStatus),
        clientHold: body.emailVerificationClientHold === true,
        autoRenewEnabled: owned.autoRenewEnabled ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not.?found|invalid.?domain|不存在/i.test(message)) return null;
      throw error;
    }
  }

  async submitPurchase(input: {
    domain: string;
    years: number;
    registrantProfileId: string;
  }) {
    const response = await this.client.saveSingleTaskForCreatingOrderActivate(
      new DomainModels.SaveSingleTaskForCreatingOrderActivateRequest({
        domainName: input.domain,
        subscriptionDuration: input.years,
        registrantProfileId: Number(input.registrantProfileId),
        permitPremiumActivation: false,
        aliyunDns: true,
        enableDomainProxy: false,
        useCoupon: false,
        usePromotion: false,
        lang: "en",
      }),
    );
    const taskNo = response.body?.taskNo;
    if (!taskNo) {
      throw new AliyunProviderError(
        "ALIYUN_TASK_NO_MISSING",
        "阿里云未返回注册任务号；结果必须通过只读查询对账。",
        true,
      );
    }
    return { taskNo, requestId: response.body?.requestId ?? null };
  }

  async submitRenewal(input: {
    domain: string;
    years: number;
    currentExpirationDateMs: number;
  }) {
    const response = await this.client.saveSingleTaskForCreatingOrderRenew(
      new DomainModels.SaveSingleTaskForCreatingOrderRenewRequest({
        domainName: input.domain,
        subscriptionDuration: input.years,
        currentExpirationDate: input.currentExpirationDateMs,
        permitPremiumRenew: false,
        useCoupon: false,
        usePromotion: false,
        lang: "en",
      }),
    );
    const taskNo = response.body?.taskNo;
    if (!taskNo) {
      throw new AliyunProviderError(
        "ALIYUN_TASK_NO_MISSING",
        "阿里云未返回续费任务号；结果必须通过只读查询对账。",
        true,
      );
    }
    return { taskNo, requestId: response.body?.requestId ?? null };
  }

  async setAutoRenew(input: { instanceId: string; enabled: boolean }) {
    const response = await this.client.setupDomainAutoRenew(
      new DomainModels.SetupDomainAutoRenewRequest({
        instanceId: input.instanceId,
        operation: input.enabled ? "SET" : "CANCEL",
      }),
    );
    return {
      ok: response.body?.result === true,
      requestId: response.body?.requestId ?? null,
    };
  }

  async getTask(taskNo: string, domain: string) {
    const response = await this.client.queryTaskDetailList(
      new DomainModels.QueryTaskDetailListRequest({
        taskNo,
        domainName: domain,
        pageNum: 1,
        pageSize: 100,
        lang: "en",
      }),
    );
    const details = response.body?.data?.taskDetail ?? [];
    const exact = details.find(
      (detail) =>
        detail.domainName &&
        normalizeAliyunDomain(detail.domainName).ascii === domain,
    );
    return mapTaskState(taskNo, exact ?? details[0] ?? null);
  }

  async findTaskCandidates(input: {
    domain: string;
    kind: "purchase" | "renewal";
    createdAfter: Date;
  }) {
    const response = await this.client.queryTaskList(
      new DomainModels.QueryTaskListRequest({
        beginCreateTime: input.createdAfter.getTime(),
        endCreateTime: Date.now(),
        pageNum: 1,
        pageSize: 100,
        lang: "en",
      }),
    );
    const tasks = response.body?.data?.taskInfo ?? [];
    const expectedPattern =
      input.kind === "purchase" ? /activate|create|register/i : /renew/i;
    const likely = tasks.filter((task) =>
      expectedPattern.test(
        `${task.taskBizType ?? ""} ${task.taskType ?? ""} ${task.taskTypeDescription ?? ""}`,
      ),
    );
    const states = await Promise.all(
      likely
        .slice(0, 50)
        .map((task) =>
          task.taskNo
            ? this.getTask(task.taskNo, input.domain)
            : Promise.resolve(null),
        ),
    );
    return states.filter((state): state is AliyunTaskState =>
      Boolean(state && state.domain === input.domain),
    );
  }
}

class OfficialAliyunDnsApi implements AliyunDnsApi {
  private readonly client: AliDns;

  constructor(credentials: AssumedCredentials) {
    this.client = new AliDns(temporaryConfig(credentials, ALIDNS_ENDPOINT));
  }

  async listRecords(domain: string) {
    const records: AliyunDnsRecordView[] = [];
    let page = 1;
    while (page <= 20) {
      const response = await this.client.describeDomainRecords(
        new AliDnsModels.DescribeDomainRecordsRequest({
          domainName: domain,
          pageNumber: page,
          pageSize: 500,
          searchMode: "COMBINATION",
          lang: "en",
        }),
      );
      const entries = response.body?.domainRecords?.record ?? [];
      records.push(
        ...entries.flatMap((record) =>
          record.recordId && record.RR && record.type && record.value
            ? [
                {
                  recordId: record.recordId,
                  rr: record.RR,
                  type: record.type.toUpperCase(),
                  value: record.value,
                  ttl: record.TTL ?? DEFAULT_DNS_TTL,
                  remark: record.remark ?? null,
                },
              ]
            : [],
        ),
      );
      if (entries.length < 500) break;
      page += 1;
    }
    return records;
  }

  async addRecord(input: {
    domain: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }) {
    const response = await this.client.addDomainRecord(
      new AliDnsModels.AddDomainRecordRequest({
        domainName: input.domain,
        RR: input.rr,
        type: input.type,
        value: input.value,
        TTL: input.ttl,
        lang: "en",
      }),
    );
    const recordId = response.body?.recordId;
    if (!recordId) {
      throw new AliyunProviderError(
        "ALIDNS_RECORD_ID_MISSING",
        "AliDNS 未返回 RecordId；不会自动重复新增记录。",
        true,
      );
    }
    return { recordId, requestId: response.body?.requestId ?? null };
  }

  async updateRecord(input: {
    recordId: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }) {
    const response = await this.client.updateDomainRecord(
      new AliDnsModels.UpdateDomainRecordRequest({
        recordId: input.recordId,
        RR: input.rr,
        type: input.type,
        value: input.value,
        TTL: input.ttl,
        lang: "en",
      }),
    );
    return { requestId: response.body?.requestId ?? null };
  }

  async updateRemark(input: { recordId: string; remark: string }) {
    const response = await this.client.updateDomainRecordRemark(
      new AliDnsModels.UpdateDomainRecordRemarkRequest({
        recordId: input.recordId,
        remark: input.remark,
        lang: "en",
      }),
    );
    return { requestId: response.body?.requestId ?? null };
  }

  async deleteRecord(recordId: string) {
    const response = await this.client.deleteDomainRecord(
      new AliDnsModels.DeleteDomainRecordRequest({ recordId, lang: "en" }),
    );
    return { requestId: response.body?.requestId ?? null };
  }
}

export class OfficialAliyunProviderSdkFactory
  implements AliyunProviderSdkFactory
{
  async assumeRole(input: {
    roleArn: string;
    externalId: string;
    sessionName: string;
    policy: string;
  }): Promise<AssumedCredentials> {
    let platformCredential: Credential;
    try {
      platformCredential = new Credential();
      const credential = await platformCredential.getCredential();
      if (!credential.accessKeyId || !credential.accessKeySecret) {
        throw new Error("empty platform credential");
      }
    } catch {
      throw new AliyunProviderError(
        "PLATFORM_IDENTITY_NOT_CONFIGURED",
        "FrontMind 服务身份未配置，无法 AssumeRole；未提交任何客户账号操作。",
      );
    }
    const sts = new Sts(
      new OpenApi.Config({
        credential: platformCredential,
        endpoint: STS_ENDPOINT,
        protocol: "HTTPS",
        regionId: "cn-hangzhou",
        connectTimeout: ALIYUN_REQUEST_TIMEOUT_MS,
        readTimeout: ALIYUN_REQUEST_TIMEOUT_MS,
        userAgent: "frontmind-siteops/1.0",
      }),
    );
    const response = await sts.assumeRole(
      new StsModels.AssumeRoleRequest({
        roleArn: input.roleArn,
        roleSessionName: input.sessionName.slice(0, 64),
        externalId: input.externalId,
        durationSeconds: 900,
        policy: input.policy,
      }),
    );
    const credentials = response.body?.credentials;
    if (
      !credentials?.accessKeyId ||
      !credentials.accessKeySecret ||
      !credentials.securityToken
    ) {
      throw new AliyunProviderError(
        "ASSUME_ROLE_FAILED",
        "阿里云未返回完整 STS 临时凭据。",
      );
    }
    return {
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      securityToken: credentials.securityToken,
      expiration: credentials.expiration ?? null,
      assumedRoleArn: response.body?.assumedRoleUser?.arn ?? null,
    };
  }

  async getCallerAccount(credentials: AssumedCredentials) {
    const client = new Sts(temporaryConfig(credentials, STS_ENDPOINT));
    const response = await client.getCallerIdentity();
    const accountId = response.body?.accountId;
    if (!accountId) {
      throw new AliyunProviderError(
        "CALLER_IDENTITY_MISSING",
        "无法确认阿里云临时身份所属账号。",
      );
    }
    return accountId;
  }

  domain(credentials: AssumedCredentials) {
    return new OfficialAliyunDomainApi(credentials);
  }

  dns(credentials: AssumedCredentials) {
    return new OfficialAliyunDnsApi(credentials);
  }
}

export type AliyunConnectionStatus = {
  configured: boolean;
  connectionId: string | null;
  accountUid: string | null;
  roleArn: string | null;
  externalIdFingerprint: string | null;
  status: "unverified" | "active" | "invalid" | "revoked" | null;
  capabilities: string[];
  verifiedAt: number | null;
  lastErrorCode: string | null;
};

async function loadOwnedConnection(
  db: DbExecutor,
  input: { projectId: string; userId: number },
) {
  const rows = await db
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, input.projectId),
        eq(siteProviderConnections.userId, input.userId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function assertOwnedProject(
  db: DbExecutor,
  input: { projectId: string; userId: number },
) {
  const rows = await db
    .select({ id: siteProjects.id })
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, input.projectId),
        eq(siteProjects.userId, input.userId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new AliyunProviderError("NOT_FOUND", "SiteOps 项目不存在。");
  }
}

/**
 * Creates or rotates the one customer-owned Aliyun connection for a project.
 * The returned ExternalId is shown once so the customer can configure the RAM
 * trust policy; status/read APIs expose only its fingerprint.
 */
export async function setupAliyunCustomerConnection(
  rawInput: z.input<typeof connectionInputSchema>,
) {
  const input = connectionInputSchema.parse(rawInput);
  if (roleAccount(input.roleArn) !== input.accountUid) {
    throw new AliyunProviderError(
      "ACCOUNT_ROLE_MISMATCH",
      "RAM Role ARN 与客户阿里云账号 UID 不一致。",
    );
  }
  const db = await requireDb();
  await assertOwnedProject(db, input);
  const existing = await loadOwnedConnection(db, input);
  if (existing) await assertAliyunConnectionMutable(db, input);
  const connectionId = existing?.id ?? randomUUID();
  const externalId = randomUUID();
  const sealed = sealAliyunExternalId(connectionId, externalId);
  if (existing) {
    await db
      .update(siteProviderConnections)
      .set({
        accountUid: input.accountUid,
        roleArn: input.roleArn,
        ...sealed,
        capabilities: [],
        status: "unverified",
        verifiedAt: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteProviderConnections.id, existing.id),
          eq(siteProviderConnections.userId, input.userId),
        ),
      );
  } else {
    await db.insert(siteProviderConnections).values({
      id: connectionId,
      projectId: input.projectId,
      userId: input.userId,
      provider: "aliyun_cn",
      accountUid: input.accountUid,
      roleArn: input.roleArn,
      ...sealed,
      capabilities: [],
      status: "unverified",
    });
  }
  return {
    connectionId,
    accountUid: input.accountUid,
    roleArn: input.roleArn,
    externalId,
    externalIdFingerprint: sealed.externalIdFingerprint,
    status: "unverified" as const,
  };
}

export async function getAliyunCustomerConnectionStatus(
  rawInput: z.input<typeof ownedConnectionInputSchema>,
): Promise<AliyunConnectionStatus> {
  const input = ownedConnectionInputSchema.parse(rawInput);
  const db = await requireDb();
  await assertOwnedProject(db, input);
  const connection = await loadOwnedConnection(db, input);
  if (!connection) {
    return {
      configured: false,
      connectionId: null,
      accountUid: null,
      roleArn: null,
      externalIdFingerprint: null,
      status: null,
      capabilities: [],
      verifiedAt: null,
      lastErrorCode: null,
    };
  }
  return {
    configured: connection.status !== "revoked",
    connectionId: connection.id,
    accountUid: connection.accountUid,
    roleArn: connection.roleArn,
    externalIdFingerprint: connection.externalIdFingerprint,
    status: connection.status,
    capabilities: [...connection.capabilities],
    verifiedAt: asDate(connection.verifiedAt)?.getTime() ?? null,
    lastErrorCode: connection.lastErrorCode,
  };
}

export async function verifyAliyunCustomerConnection(
  rawInput: z.input<typeof ownedConnectionInputSchema>,
  factory: AliyunProviderSdkFactory = new OfficialAliyunProviderSdkFactory(),
) {
  const input = ownedConnectionInputSchema.parse(rawInput);
  const db = await requireDb();
  await assertOwnedProject(db, input);
  const connection = await loadOwnedConnection(db, input);
  if (!connection || connection.status === "revoked") {
    throw new AliyunProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "客户尚未配置阿里云 RAM Role 连接。",
    );
  }
  try {
    const externalId = openAliyunExternalId(connection);
    const credentials = await factory.assumeRole({
      roleArn: connection.roleArn,
      externalId,
      sessionName: `frontmind-verify-${connection.id.slice(0, 8)}`,
      policy: DOMAIN_READ_POLICY,
    });
    const callerAccount = await factory.getCallerAccount(credentials);
    if (
      callerAccount !== connection.accountUid ||
      roleAccount(connection.roleArn) !== connection.accountUid
    ) {
      throw new AliyunProviderError(
        "CALLER_ACCOUNT_MISMATCH",
        "AssumeRole 临时身份不属于所声明的客户账号。",
      );
    }
    await factory.domain(credentials).listVerifiedRegistrantProfiles();
    const capabilities = ["sts_assume_role", "domain_read"];
    const profileRows = await db
      .select({ domain: workspaceSiteProfiles.normalizedAsciiDomain })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.userId))
      .limit(1);
    const domain = profileRows[0]?.domain;
    if (domain) {
      try {
        const dnsCredentials = await factory.assumeRole({
          roleArn: connection.roleArn,
          externalId,
          sessionName: `frontmind-dns-${connection.id.slice(0, 8)}`,
          policy: DNS_READ_POLICY,
        });
        if (
          (await factory.getCallerAccount(dnsCredentials)) === callerAccount
        ) {
          await factory.dns(dnsCredentials).listRecords(domain);
          capabilities.push("alidns_read");
        }
      } catch {
        // DNS is independently capability-scoped. Domain connection remains
        // usable and the missing permission is exposed by capabilities.
      }
    }
    await db
      .update(siteProviderConnections)
      .set({
        status: "active",
        capabilities,
        verifiedAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteProviderConnections.id, connection.id),
          eq(siteProviderConnections.status, connection.status),
        ),
      );
    return {
      ok: true as const,
      accountUid: callerAccount,
      capabilities,
    };
  } catch (error) {
    const code =
      error instanceof AliyunProviderError
        ? error.code
        : "ALIYUN_CONNECTION_VERIFICATION_FAILED";
    const definitelyInvalid = [
      "CALLER_ACCOUNT_MISMATCH",
      "ACCOUNT_ROLE_MISMATCH",
      "CALLER_IDENTITY_MISSING",
    ].includes(code);
    const preserveActive = connection.status === "active" && !definitelyInvalid;
    await db
      .update(siteProviderConnections)
      .set({
        // A transient platform/provider outage must not destroy a previously
        // verified customer connection. New/unverified connections remain
        // invalid until a complete verification succeeds.
        status: preserveActive ? "active" : "invalid",
        capabilities: preserveActive ? connection.capabilities : [],
        verifiedAt: preserveActive ? connection.verifiedAt : null,
        lastErrorCode: code,
        updatedAt: new Date(),
      })
      .where(eq(siteProviderConnections.id, connection.id));
    throw error;
  }
}

export async function disconnectAliyunCustomerConnection(
  rawInput: z.input<typeof ownedConnectionInputSchema>,
) {
  const input = ownedConnectionInputSchema.parse(rawInput);
  const db = await requireDb();
  await assertOwnedProject(db, input);
  const connection = await loadOwnedConnection(db, input);
  if (!connection) return { disconnected: true as const };
  await assertAliyunConnectionMutable(db, input);
  // Overwrite the encrypted value so a revoked connection cannot be assumed
  // even if a stale application object survives briefly in memory.
  const sealed = sealAliyunExternalId(connection.id, randomUUID());
  await db
    .update(siteProviderConnections)
    .set({
      ...sealed,
      status: "revoked",
      capabilities: [],
      verifiedAt: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(siteProviderConnections.id, connection.id),
        eq(siteProviderConnections.userId, input.userId),
      ),
    );
  return { disconnected: true as const };
}

async function assumeForConnection(
  connection: SiteProviderConnection,
  factory: AliyunProviderSdkFactory,
  policy: string,
  purpose: string,
) {
  if (connection.status !== "active") {
    throw new AliyunProviderError(
      "ALIYUN_CONNECTION_INACTIVE",
      "客户阿里云连接不是有效状态。",
    );
  }
  if (roleAccount(connection.roleArn) !== connection.accountUid) {
    throw new AliyunProviderError(
      "CALLER_ACCOUNT_MISMATCH",
      "RAM Role ARN 与已验证客户账号不一致。",
    );
  }
  const credentials = await factory.assumeRole({
    roleArn: connection.roleArn,
    externalId: openAliyunExternalId(connection),
    sessionName: `frontmind-${purpose}-${connection.id.slice(0, 8)}`,
    policy,
  });
  const account = await factory.getCallerAccount(credentials);
  if (account !== connection.accountUid) {
    throw new AliyunProviderError(
      "CALLER_ACCOUNT_MISMATCH",
      "临时身份所属账号与客户连接不一致。",
    );
  }
  return credentials;
}

export type AliyunDomainQuote = {
  schemaVersion: 1;
  kind: "purchase" | "renewal";
  domain: string;
  accountUid: string;
  amountMinor: number;
  currency: "CNY";
  years: number;
  registrantProfileId: string | null;
  maskedRegistrantName: string | null;
  currentExpirationDateMs: number | null;
  instanceId: string | null;
  issuedAt: string;
  expiresAt: string;
  quoteHash: string;
};

function quoteHash(
  quote: Omit<AliyunDomainQuote, "quoteHash" | "issuedAt" | "expiresAt">,
) {
  return sha256(
    stableJson({
      schemaVersion: quote.schemaVersion,
      kind: quote.kind,
      domain: quote.domain,
      accountUid: quote.accountUid,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      years: quote.years,
      registrantProfileId: quote.registrantProfileId,
      currentExpirationDateMs: quote.currentExpirationDateMs,
      instanceId: quote.instanceId,
    }),
  );
}

export function selectVerifiedRegistrantProfile(
  profiles: AliyunRegistrantProfile[],
  requestedProfileId?: string,
) {
  const eligible = profiles.filter(
    (profile) =>
      /^\d+$/.test(profile.profileId) &&
      Number.isSafeInteger(Number(profile.profileId)) &&
      profile.realNameVerified &&
      profile.emailVerified,
  );
  const defaults = eligible.filter((profile) => profile.isDefault);
  if (requestedProfileId) {
    const selected = eligible.find(
      (profile) => profile.profileId === requestedProfileId,
    );
    if (!selected) {
      throw new AliyunProviderError(
        "REGISTRANT_PROFILE_NOT_ELIGIBLE",
        "所选实名模板不存在、未实名或邮箱未验证。",
        false,
        { availableRegistrantProfiles: eligible },
      );
    }
    return selected;
  }
  if (defaults.length === 1) return defaults[0];
  if (defaults.length === 0 && eligible.length === 1) return eligible[0];
  throw new AliyunProviderError(
    eligible.length === 0
      ? "VERIFIED_REGISTRANT_PROFILE_REQUIRED"
      : "REGISTRANT_PROFILE_SELECTION_REQUIRED",
    eligible.length === 0
      ? "客户账号没有已实名且邮箱已验证的信息模板，请先在阿里云控制台完成。"
      : "客户账号有多个可用实名模板且没有唯一默认项，必须先明确选择；系统不会代选持有人。",
    false,
    { availableRegistrantProfiles: eligible },
  );
}

export async function prepareAliyunDomainQuote(input: {
  api: AliyunDomainApi;
  kind: "purchase" | "renewal";
  domain: string;
  accountUid: string;
  years: number;
  registrantProfileId?: string;
  now?: Date;
}): Promise<AliyunDomainQuote> {
  const now = input.now ?? new Date();
  const domain = normalizeAliyunDomain(input.domain).ascii;
  const [check, existing, profiles] = await Promise.all([
    input.api.checkDomain({
      domain,
      command: input.kind === "purchase" ? "create" : "renew",
      years: input.years,
    }),
    input.kind === "renewal"
      ? input.api.getDomain(domain)
      : Promise.resolve(null),
    input.kind === "purchase"
      ? input.api.listVerifiedRegistrantProfiles()
      : Promise.resolve([]),
  ]);
  if (check.domain !== domain) {
    throw new AliyunProviderError(
      "DOMAIN_RESPONSE_MISMATCH",
      "阿里云返回的域名与请求不一致。",
    );
  }
  if (input.kind === "purchase" && !check.available) {
    throw new AliyunProviderError(
      "DOMAIN_NOT_AVAILABLE",
      check.reason || "该域名当前不可注册。",
    );
  }
  if (check.premium) {
    throw new AliyunProviderError(
      "PREMIUM_DOMAIN_NOT_SUPPORTED",
      "首版不自动购买或续费溢价域名，请前往阿里云控制台处理。",
    );
  }
  if (check.amountMinor == null) {
    throw new AliyunProviderError(
      "DOMAIN_PRICE_UNAVAILABLE",
      "阿里云未返回可确认的精确价格。",
    );
  }
  if (input.kind === "renewal" && !existing) {
    throw new AliyunProviderError(
      "DOMAIN_NOT_OWNED",
      "该域名不在当前客户阿里云账号中，不能续费。",
    );
  }
  const profile =
    input.kind === "purchase"
      ? selectVerifiedRegistrantProfile(profiles, input.registrantProfileId)
      : null;
  const core = {
    schemaVersion: 1 as const,
    kind: input.kind,
    domain,
    accountUid: input.accountUid,
    amountMinor: check.amountMinor,
    currency: check.currency,
    years: input.years,
    registrantProfileId: profile?.profileId ?? null,
    maskedRegistrantName: profile?.maskedName ?? null,
    currentExpirationDateMs: existing?.expirationDateMs ?? null,
    instanceId: existing?.instanceId ?? null,
  };
  return {
    ...core,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
    quoteHash: quoteHash(core),
  };
}

function sameQuote(left: AliyunDomainQuote, right: AliyunDomainQuote) {
  return left.quoteHash === right.quoteHash;
}

function parseDomainQuote(value: unknown): AliyunDomainQuote {
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      kind: z.enum(["purchase", "renewal"]),
      domain: z.string(),
      accountUid: z.string(),
      amountMinor: z.number().int().nonnegative(),
      currency: z.literal("CNY"),
      years: z.number().int().min(1).max(10),
      registrantProfileId: z.string().nullable(),
      maskedRegistrantName: z.string().nullable(),
      currentExpirationDateMs: z.number().int().positive().nullable(),
      instanceId: z.string().nullable(),
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(value);
  const {
    quoteHash: claimedHash,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    ...core
  } = parsed;
  if (quoteHash(core) !== claimedHash) {
    throw new AliyunProviderError("QUOTE_TAMPERED", "报价内容哈希校验失败。");
  }
  return parsed;
}

function taskPendingResult(
  task: AliyunTaskState,
  result: Record<string, unknown>,
): SiteOpsProviderResult {
  if (task.state === "failed") {
    return {
      status: "failed",
      code: "ALIYUN_DOMAIN_TASK_FAILED",
      message: task.message || "阿里云域名任务失败。",
      providerTaskId: task.taskNo,
      result,
    };
  }
  return {
    status: "pending",
    providerTaskId: task.taskNo,
    nextPollMs: 10_000,
    result,
  };
}

function expectedRenewalExpiration(quote: AliyunDomainQuote) {
  if (!quote.currentExpirationDateMs) return null;
  const expected = new Date(quote.currentExpirationDateMs);
  expected.setUTCFullYear(expected.getUTCFullYear() + quote.years);
  return expected.getTime();
}

async function verifyCompletedFinancialTask(
  api: AliyunDomainApi,
  quote: AliyunDomainQuote,
  task: AliyunTaskState,
): Promise<SiteOpsProviderResult> {
  const current = await api.getDomain(quote.domain);
  if (!current || current.domain !== quote.domain) {
    return {
      status: "pending",
      providerTaskId: task.taskNo,
      nextPollMs: 10_000,
      result: { phase: "provider_succeeded_ownership_pending", quote },
    };
  }
  if (quote.kind === "renewal") {
    const expected = expectedRenewalExpiration(quote);
    if (
      expected == null ||
      Math.abs(current.expirationDateMs - expected) > 24 * 60 * 60_000
    ) {
      return {
        status: "attention_required",
        code: "RENEWAL_EXPIRATION_MISMATCH",
        message:
          "续费任务已结束，但到期日没有按确认年限精确延长；不会重复扣款，请人工对账。",
        providerTaskId: task.taskNo,
        result: {
          quote,
          observedExpirationDateMs: current.expirationDateMs,
          expectedExpirationDateMs: expected,
        },
      };
    }
  }
  return {
    status: "succeeded",
    providerTaskId: task.taskNo,
    result: {
      quote,
      domain: current.domain,
      instanceId: current.instanceId,
      expirationDateMs: current.expirationDateMs,
      realNameStatus: current.realNameStatus,
      emailStatus: current.emailStatus,
      clientHold: current.clientHold,
    },
    message:
      quote.kind === "purchase"
        ? `域名 ${quote.domain} 已注册到客户阿里云账号。`
        : `域名 ${quote.domain} 已完成续费。`,
  };
}

/**
 * Executes or reconciles one already-confirmed financial mutation. Callers
 * must persist mutationAttempted before the SDK write. On subsequent calls the
 * function is read-only even when no TaskNo was received.
 */
export async function executeAliyunFinancialMutation(input: {
  api: AliyunDomainApi;
  quote: AliyunDomainQuote;
  providerTaskNo?: string | null;
  mutationAttempted: boolean;
  operationCreatedAt: Date;
  now?: Date;
  beforeMutation?: () => Promise<void>;
}): Promise<SiteOpsProviderResult> {
  const now = input.now ?? new Date();
  const reconcile = async () => {
    let candidates: AliyunTaskState[];
    try {
      candidates = await input.api.findTaskCandidates({
        domain: input.quote.domain,
        kind: input.quote.kind,
        createdAfter: new Date(input.operationCreatedAt.getTime() - 60_000),
      });
    } catch {
      if (
        now.getTime() - input.operationCreatedAt.getTime() <
        RESPONSE_LOSS_RECONCILE_MS
      ) {
        return {
          status: "pending" as const,
          nextPollMs: 15_000,
          result: {
            mutationAttempted: true,
            phase: "response_loss_query_unavailable",
          },
        };
      }
      return {
        status: "attention_required" as const,
        code: "DOMAIN_RECONCILIATION_UNAVAILABLE",
        message:
          "已提交的域名操作无法完成只读对账；系统没有重下单，请人工核对。",
        result: { mutationAttempted: true },
      };
    }
    if (candidates.length > 1) {
      return {
        status: "attention_required" as const,
        code: "AMBIGUOUS_DOMAIN_TASK",
        message: "结果丢失后发现多个可能的阿里云任务，系统不会猜测或再次扣款。",
        result: { mutationAttempted: true, candidateCount: candidates.length },
      };
    }
    if (candidates.length === 0) {
      if (
        now.getTime() - input.operationCreatedAt.getTime() <
        RESPONSE_LOSS_RECONCILE_MS
      ) {
        return {
          status: "pending" as const,
          nextPollMs: 15_000,
          result: {
            mutationAttempted: true,
            phase: "response_loss_reconciling",
          },
        };
      }
      return {
        status: "attention_required" as const,
        code: "DOMAIN_TASK_NOT_FOUND_AFTER_RESPONSE_LOSS",
        message:
          "无法唯一确认先前域名操作结果；系统没有重下单，请人工核对客户账号。",
        result: { mutationAttempted: true, candidateCount: 0 },
      };
    }
    return candidates[0];
  };

  let task: AliyunTaskState;
  if (input.providerTaskNo) {
    task = await input.api.getTask(input.providerTaskNo, input.quote.domain);
  } else if (input.mutationAttempted) {
    const reconciled = await reconcile();
    if (!("taskNo" in reconciled)) return reconciled;
    task = reconciled;
  } else {
    await input.beforeMutation?.();
    try {
      const submitted =
        input.quote.kind === "purchase"
          ? await input.api.submitPurchase({
              domain: input.quote.domain,
              years: input.quote.years,
              registrantProfileId: input.quote.registrantProfileId!,
            })
          : await input.api.submitRenewal({
              domain: input.quote.domain,
              years: input.quote.years,
              currentExpirationDateMs: input.quote.currentExpirationDateMs!,
            });
      task = {
        taskNo: submitted.taskNo,
        state: "pending",
        domain: input.quote.domain,
        taskType: input.quote.kind,
        message: null,
        instanceId: null,
      };
    } catch {
      const reconciled = await reconcile();
      if (!("taskNo" in reconciled)) return reconciled;
      task = reconciled;
    }
  }
  const durableResult = {
    mutationAttempted: true,
    phase: task.state,
    quote: input.quote,
  };
  if (task.state !== "succeeded") {
    return taskPendingResult(task, durableResult);
  }
  return verifyCompletedFinancialTask(input.api, input.quote, task);
}

async function loadDomainOperationForSiteOperation(
  db: DbExecutor,
  operation: SiteOperation,
) {
  const rows = await db
    .select()
    .from(siteDomainOperations)
    .where(
      and(
        eq(siteDomainOperations.operationId, operation.id),
        eq(siteDomainOperations.projectId, operation.projectId),
        eq(siteDomainOperations.userId, operation.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AliyunProviderError(
      "DOMAIN_LEDGER_NOT_FOUND",
      "域名操作台账不存在；未执行外部请求。",
    );
  }
  return row;
}

async function loadConnectionForLedger(
  db: DbExecutor,
  ledger: SiteDomainOperation,
) {
  if (!ledger.connectionId) {
    throw new AliyunProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "域名操作没有绑定客户阿里云连接。",
    );
  }
  const rows = await db
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.id, ledger.connectionId),
        eq(siteProviderConnections.projectId, ledger.projectId),
        eq(siteProviderConnections.userId, ledger.userId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection) {
    throw new AliyunProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "客户阿里云连接不存在。",
    );
  }
  return connection;
}

async function persistQuote(
  db: DbExecutor,
  ledger: SiteDomainOperation,
  quote: AliyunDomainQuote,
) {
  await db
    .update(siteDomainOperations)
    .set({
      quoteHash: quote.quoteHash,
      quoteExpiresAt: new Date(quote.expiresAt),
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      years: quote.years,
      registrantProfileId: quote.registrantProfileId,
      maskedRegistrantName: quote.maskedRegistrantName,
      providerResult: { quote },
      status: "quoted",
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(siteDomainOperations.id, ledger.id));
}

async function applySuccessfulDomainState(
  db: DbExecutor,
  operation: SiteOperation,
  quote: AliyunDomainQuote,
  result: SiteOpsProviderResult,
) {
  if (result.status !== "succeeded") return;
  const domainResult = result.result ?? {};
  const expirationDateMs = Number(domainResult.expirationDateMs);
  await db.transaction(async (tx) => {
    const profileRows = await tx
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, operation.userId))
      .limit(1)
      .for("update");
    const current = profileRows[0];
    const switchingDomain =
      !current || current.normalizedAsciiDomain !== quote.domain;
    const nextRevision = switchingDomain
      ? (current?.domainRevision ?? 0) + 1
      : (current?.domainRevision ?? 1);
    const common = {
      domain: quote.domain,
      normalizedAsciiDomain: quote.domain,
      unicodeDisplayDomain: domainToUnicode(quote.domain),
      domainRevision: nextRevision,
      registrar: "aliyun_cn",
      providerAccountUid: quote.accountUid,
      domainInstanceId:
        typeof domainResult.instanceId === "string"
          ? domainResult.instanceId
          : quote.instanceId,
      domainExpiresAt: Number.isFinite(expirationDateMs)
        ? new Date(expirationDateMs)
        : undefined,
      domainRealNameStatus:
        typeof domainResult.realNameStatus === "string"
          ? domainResult.realNameStatus
          : null,
      domainEmailStatus:
        typeof domainResult.emailStatus === "string"
          ? domainResult.emailStatus
          : null,
      domainClientHold: domainResult.clientHold === true,
      domainOwnershipStatus: "verified",
      domainStatus: "completed" as const,
      domainVerifiedAt: new Date(),
      updatedAt: new Date(),
    };
    if (current) {
      await tx
        .update(workspaceSiteProfiles)
        .set({
          ...common,
          ...(switchingDomain
            ? {
                dnsStatus: "pending",
                icpDomainRevision: null,
                icpStatus: "not_submitted" as const,
                icpNumber: null,
                icpVerifiedAt: null,
                autoRenewDesired: false,
                autoRenewObserved: null,
                revision: current.revision + 1,
              }
            : {}),
        })
        .where(eq(workspaceSiteProfiles.userId, operation.userId));
    } else {
      await tx.insert(workspaceSiteProfiles).values({
        userId: operation.userId,
        ...common,
        dnsStatus: "pending",
        icpStatus: "not_submitted",
        autoRenewDesired: false,
        revision: 1,
      });
    }
    if (switchingDomain) {
      await tx
        .update(siteProjects)
        .set({
          canonicalHostname: quote.domain,
          mainlandLiveDeploymentId: null,
          updatedAt: new Date(),
        })
        .where(eq(siteProjects.id, operation.projectId));
    }
  });
}

type ExistingDomainProfile = Pick<
  typeof workspaceSiteProfiles.$inferSelect,
  | "domain"
  | "normalizedAsciiDomain"
  | "domainRevision"
  | "revision"
  | "icpStatus"
  | "icpNumber"
  | "icpDomainRevision"
  | "icpVerifiedAt"
  | "autoRenewDesired"
  | "dnsStatus"
>;

export function projectExistingAliyunDomainState(input: {
  current: ExistingDomainProfile | null;
  requestedDomain: string;
  accountUid: string;
  details: AliyunDomainDetails;
  now: Date;
}) {
  const requested = normalizeAliyunDomain(input.requestedDomain);
  const observed = normalizeAliyunDomain(input.details.domain);
  if (requested.ascii !== observed.ascii) {
    throw new AliyunProviderError(
      "DOMAIN_OWNERSHIP_MISMATCH",
      "阿里云返回的域名与客户确认接入的精确域名不一致。",
    );
  }
  const currentIdentity = (() => {
    const value =
      input.current?.normalizedAsciiDomain ?? input.current?.domain ?? "";
    if (!value) return null;
    try {
      return normalizeAliyunDomain(value).ascii;
    } catch {
      return null;
    }
  })();
  const switchingDomain = currentIdentity !== requested.ascii;
  const nextDomainRevision = switchingDomain
    ? (input.current?.domainRevision ?? 0) + 1
    : (input.current?.domainRevision ?? 1);
  if (
    !Number.isFinite(input.details.expirationDateMs) ||
    input.details.expirationDateMs <= 0
  ) {
    throw new AliyunProviderError(
      "DOMAIN_DETAILS_INVALID",
      "阿里云域名详情缺少有效到期时间，未更新本地域名状态。",
    );
  }
  return {
    switchingDomain,
    nextDomainRevision,
    values: {
      domain: requested.ascii,
      normalizedAsciiDomain: requested.ascii,
      unicodeDisplayDomain: requested.unicode,
      domainRevision: nextDomainRevision,
      registrar: "aliyun_cn",
      providerAccountUid: input.accountUid,
      domainInstanceId: input.details.instanceId,
      domainExpiresAt: new Date(input.details.expirationDateMs),
      domainRealNameStatus: input.details.realNameStatus,
      domainEmailStatus: input.details.emailStatus,
      domainClientHold: input.details.clientHold,
      domainOwnershipStatus: "verified",
      domainStatus: "completed" as const,
      domainVerifiedAt: input.now,
      autoRenewObserved: input.details.autoRenewEnabled,
      revision: (input.current?.revision ?? 0) + 1,
      updatedAt: input.now,
      ...(switchingDomain
        ? {
            dnsStatus: "pending",
            icpProvince: null,
            icpStatus: "not_submitted" as const,
            icpNumber: null,
            icpDomainRevision: null,
            icpVerifiedAt: null,
            autoRenewDesired: false,
          }
        : {}),
    },
  };
}

export async function readExistingAliyunDomainFromOwnedAccount(
  api: AliyunDomainApi,
  requestedDomain: string,
) {
  const domain = normalizeAliyunDomain(requestedDomain).ascii;
  const details = await api.getDomain(domain);
  if (!details || normalizeAliyunDomain(details.domain).ascii !== domain) {
    throw new AliyunProviderError(
      "DOMAIN_NOT_OWNED",
      "该精确域名不在当前客户阿里云账号中。",
    );
  }
  return details;
}

async function handleDomainSync(
  db: DbExecutor,
  operation: SiteOperation,
  ledger: SiteDomainOperation,
  connection: SiteProviderConnection,
  api: AliyunDomainApi,
  parsed: z.infer<typeof domainOperationInputSchema>,
) {
  if (
    ledger.kind !== "sync" ||
    parsed.domainIntent !== "sync" ||
    parsed.customerConfirmed !== true ||
    !ledger.customerConfirmedAt ||
    !ledger.customerConfirmationHash
  ) {
    throw new AliyunProviderError(
      "CUSTOMER_CONFIRMATION_REQUIRED",
      "接入已有域名必须由客户输入精确域名并明确确认。",
    );
  }
  const domain = normalizeAliyunDomain(parsed.domain).ascii;
  if (
    domain !== ledger.domainAscii ||
    normalizeAliyunDomain(parsed.typedDomain ?? "").ascii !== domain
  ) {
    throw new AliyunProviderError(
      "DOMAIN_LEDGER_MISMATCH",
      "客户确认的精确域名与只读同步台账不一致。",
    );
  }
  // QueryDomainByDomainName is executed with STS credentials already proven
  // by assumeForConnection to belong to connection.accountUid. A successful
  // exact result is therefore ownership evidence for that customer account;
  // CheckDomain availability is deliberately never used here.
  const details = await readExistingAliyunDomainFromOwnedAccount(api, domain);
  const now = new Date();
  const projection = await db.transaction(async (tx) => {
    const projectRows = await tx
      .select()
      .from(siteProjects)
      .where(
        and(
          eq(siteProjects.id, operation.projectId),
          eq(siteProjects.userId, operation.userId),
        ),
      )
      .limit(1)
      .for("update");
    const project = projectRows[0];
    if (!project) {
      throw new AliyunProviderError("NOT_FOUND", "SiteOps 项目不存在。");
    }
    const profileRows = await tx
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, operation.userId))
      .limit(1)
      .for("update");
    const current = profileRows[0] ?? null;
    const next = projectExistingAliyunDomainState({
      current,
      requestedDomain: domain,
      accountUid: connection.accountUid,
      details,
      now,
    });
    if (current) {
      await tx
        .update(workspaceSiteProfiles)
        .set(next.values)
        .where(eq(workspaceSiteProfiles.userId, operation.userId));
    } else {
      await tx.insert(workspaceSiteProfiles).values({
        userId: operation.userId,
        ...next.values,
      });
    }
    if (next.switchingDomain && project.mainlandLiveDeploymentId) {
      await tx
        .update(siteDeployments)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(siteDeployments.id, project.mainlandLiveDeploymentId),
            eq(siteDeployments.projectId, project.id),
            eq(siteDeployments.target, "mainland_cn"),
            eq(siteDeployments.status, "active"),
          ),
        );
    }
    await tx
      .update(siteProjects)
      .set({
        canonicalHostname: domain,
        ...(next.switchingDomain ? { mainlandLiveDeploymentId: null } : {}),
        updatedAt: now,
      })
      .where(eq(siteProjects.id, project.id));
    const safeResult = {
      domain,
      displayDomain: domainToUnicode(domain),
      accountUid: connection.accountUid,
      instanceId: details.instanceId,
      expirationDateMs: details.expirationDateMs,
      realNameStatus: details.realNameStatus,
      emailStatus: details.emailStatus,
      clientHold: details.clientHold,
      autoRenewObserved: details.autoRenewEnabled,
      domainRevision: next.nextDomainRevision,
      ownershipStatus: "verified",
      switchingDomain: next.switchingDomain,
    };
    await tx
      .update(siteDomainOperations)
      .set({
        domainRevision: next.nextDomainRevision,
        providerResult: safeResult,
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(siteDomainOperations.id, ledger.id));
    return safeResult;
  });
  return {
    status: "succeeded" as const,
    result: projection,
    message: projection.switchingDomain
      ? `已通过客户阿里云账号的只读域名详情确认并接入 ${domain}；旧域名 ICP 与大陆发布 head 已失效。`
      : `已通过客户阿里云账号只读同步 ${domain} 的到期、实名、邮箱与自动续费状态；当前 ICP 绑定保持不变。`,
  };
}

async function handleDomainSearch(
  db: DbExecutor,
  operation: SiteOperation,
  ledger: SiteDomainOperation,
  api: AliyunDomainApi,
  parsed: z.infer<typeof domainOperationInputSchema>,
) {
  const domain = normalizeAliyunDomain(parsed.domain).ascii;
  if (domain !== ledger.domainAscii) {
    throw new AliyunProviderError(
      "DOMAIN_LEDGER_MISMATCH",
      "域名操作与台账域名不一致。",
    );
  }
  const check = await api.checkDomain({ domain, command: "create", years: 1 });
  await db
    .update(siteDomainOperations)
    .set({
      providerResult: { check },
      status: "succeeded",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(siteDomainOperations.id, ledger.id));
  return {
    status: "succeeded" as const,
    result: { check },
    providerOperationId: check.requestId ?? undefined,
    message: check.available
      ? `${domain} 当前可注册；价格仅在短时确认报价中有效。`
      : `${domain} 当前不可注册。`,
  };
}

async function loadReferencedQuote(
  db: DbExecutor,
  operation: SiteOperation,
  referencedId: string,
) {
  const rows = await db
    .select()
    .from(siteDomainOperations)
    .where(
      and(
        eq(siteDomainOperations.id, referencedId),
        eq(siteDomainOperations.projectId, operation.projectId),
        eq(siteDomainOperations.userId, operation.userId),
      ),
    )
    .limit(1);
  const referenced = rows[0];
  if (!referenced) {
    throw new AliyunProviderError("QUOTE_NOT_FOUND", "报价不存在或已失效。");
  }
  const providerResult = referenced.providerResult as Record<
    string,
    unknown
  > | null;
  const quote = parseDomainQuote(providerResult?.quote);
  return { referenced, quote };
}

async function handleDomainFinancial(
  db: DbExecutor,
  operation: SiteOperation,
  ledger: SiteDomainOperation,
  connection: SiteProviderConnection,
  factory: AliyunProviderSdkFactory,
  parsed: z.infer<typeof domainOperationInputSchema>,
  signal: AbortSignal,
): Promise<SiteOpsProviderResult> {
  const kind = operation.kind === "domain_purchase" ? "purchase" : "renewal";
  const domain = normalizeAliyunDomain(parsed.domain).ascii;
  if (domain !== ledger.domainAscii) {
    throw new AliyunProviderError(
      "DOMAIN_LEDGER_MISMATCH",
      "域名操作与台账域名不一致。",
    );
  }
  const confirmed = Boolean(
    ledger.customerConfirmedAt && parsed.domainOperationId && parsed.quoteHash,
  );
  const policy = confirmed
    ? kind === "purchase"
      ? DOMAIN_PURCHASE_POLICY
      : DOMAIN_RENEW_POLICY
    : DOMAIN_READ_POLICY;
  const credentials = await assumeForConnection(
    connection,
    factory,
    policy,
    confirmed ? `${kind}-confirm` : `${kind}-quote`,
  );
  assertNotAborted(signal);
  const api = factory.domain(credentials);
  if (!confirmed) {
    if (!parsed.years) {
      throw new AliyunProviderError(
        "INVALID_DOMAIN_PERIOD",
        "报价缺少注册或续费年限。",
      );
    }
    const quote = await prepareAliyunDomainQuote({
      api,
      kind,
      domain,
      accountUid: connection.accountUid,
      years: parsed.years,
      registrantProfileId: parsed.registrantProfileId,
    });
    await persistQuote(db, ledger, quote);
    return {
      status: "succeeded",
      result: { quote },
      message: `${domain} 的精确报价已生成，有效期 60 秒。`,
    };
  }
  const { quote: confirmedQuote } = await loadReferencedQuote(
    db,
    operation,
    parsed.domainOperationId!,
  );
  if (
    confirmedQuote.domain !== domain ||
    confirmedQuote.kind !== kind ||
    confirmedQuote.accountUid !== connection.accountUid ||
    confirmedQuote.quoteHash !== parsed.quoteHash
  ) {
    throw new AliyunProviderError(
      "QUOTE_MISMATCH",
      "客户确认内容与原始报价不一致。",
    );
  }
  const previousResult = operation.result as Record<string, unknown> | null;
  const mutationAttempted =
    Boolean(operation.providerTaskId ?? ledger.providerTaskNo) ||
    previousResult?.mutationAttempted === true ||
    ["submitted", "reconciling", "outcome_unknown"].includes(ledger.status);
  // Quote expiry and the immediate price/availability refresh are admission
  // checks for the one provider mutation. Once admitted, later task polling is
  // read-only and must not fail merely because the 60-second quote has elapsed.
  if (!mutationAttempted) {
    if (new Date(confirmedQuote.expiresAt).getTime() <= Date.now()) {
      throw new AliyunProviderError(
        "QUOTE_EXPIRED",
        "报价已过期，请重新查询并确认。",
      );
    }
    const freshQuote = await prepareAliyunDomainQuote({
      api,
      kind,
      domain,
      accountUid: connection.accountUid,
      years: confirmedQuote.years,
      registrantProfileId: confirmedQuote.registrantProfileId ?? undefined,
    });
    if (!sameQuote(confirmedQuote, freshQuote)) {
      await persistQuote(db, ledger, freshQuote);
      return {
        status: "attention_required",
        code: "QUOTE_CHANGED",
        message:
          "价格、库存、持有人模板或到期日已经变化，必须重新确认；未提交扣款。",
        result: { quote: freshQuote },
      };
    }
  }
  await db
    .update(siteDomainOperations)
    .set({
      quoteHash: confirmedQuote.quoteHash,
      quoteExpiresAt: new Date(confirmedQuote.expiresAt),
      amountMinor: confirmedQuote.amountMinor,
      currency: confirmedQuote.currency,
      years: confirmedQuote.years,
      registrantProfileId: confirmedQuote.registrantProfileId,
      maskedRegistrantName: confirmedQuote.maskedRegistrantName,
      updatedAt: new Date(),
    })
    .where(eq(siteDomainOperations.id, ledger.id));
  const result = await executeAliyunFinancialMutation({
    api,
    quote: confirmedQuote,
    providerTaskNo: operation.providerTaskId ?? ledger.providerTaskNo,
    mutationAttempted,
    operationCreatedAt: asDate(operation.createdAt) ?? new Date(),
    beforeMutation: async () => {
      await db
        .update(siteDomainOperations)
        .set({
          status: "reconciling",
          providerResult: { mutationAttempted: true, quote: confirmedQuote },
          updatedAt: new Date(),
        })
        .where(eq(siteDomainOperations.id, ledger.id));
    },
  });
  if (result.status === "pending") {
    await db
      .update(siteDomainOperations)
      .set({
        status: result.providerTaskId ? "submitted" : "reconciling",
        providerTaskNo: result.providerTaskId,
        providerResult: result.result,
        updatedAt: new Date(),
      })
      .where(eq(siteDomainOperations.id, ledger.id));
  }
  await applySuccessfulDomainState(db, operation, confirmedQuote, result);
  return result;
}

async function handleDomainAutoRenew(
  db: DbExecutor,
  operation: SiteOperation,
  ledger: SiteDomainOperation,
  connection: SiteProviderConnection,
  factory: AliyunProviderSdkFactory,
  parsed: z.infer<typeof domainOperationInputSchema>,
) {
  if (
    parsed.enabled == null ||
    parsed.customerConfirmed !== true ||
    !ledger.customerConfirmedAt ||
    !ledger.customerConfirmationHash
  ) {
    throw new AliyunProviderError(
      "CUSTOMER_CONFIRMATION_REQUIRED",
      "自动续费必须由客户明确确认。",
    );
  }
  const domain = normalizeAliyunDomain(parsed.domain).ascii;
  const credentials = await assumeForConnection(
    connection,
    factory,
    DOMAIN_AUTO_RENEW_POLICY,
    "auto-renew",
  );
  const api = factory.domain(credentials);
  const details = await api.getDomain(domain);
  if (!details) {
    throw new AliyunProviderError(
      "DOMAIN_NOT_OWNED",
      "该域名不在客户阿里云账号中。",
    );
  }
  if (details.autoRenewEnabled === parsed.enabled) {
    await db
      .update(workspaceSiteProfiles)
      .set({
        autoRenewDesired: parsed.enabled,
        autoRenewObserved: parsed.enabled,
        updatedAt: new Date(),
      })
      .where(eq(workspaceSiteProfiles.userId, operation.userId));
    return {
      status: "succeeded" as const,
      result: { domain, autoRenewObserved: parsed.enabled },
      message: `域名 ${domain} 的自动续费状态已同步。`,
    };
  }
  const attempted =
    ["reconciling", "outcome_unknown"].includes(ledger.status) ||
    (operation.result as Record<string, unknown> | null)?.mutationAttempted ===
      true;
  if (attempted) {
    const age =
      Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
    if (age < RESPONSE_LOSS_RECONCILE_MS) {
      return {
        status: "pending" as const,
        nextPollMs: 15_000,
        result: { mutationAttempted: true, phase: "auto_renew_reconciling" },
      };
    }
    return {
      status: "attention_required" as const,
      code: "AUTO_RENEW_RESULT_UNKNOWN",
      message:
        "自动续费写入结果无法确认；系统没有盲目发送第二次 SET/CANCEL，请人工核对。",
      result: { mutationAttempted: true },
    };
  }
  await db
    .update(siteDomainOperations)
    .set({
      status: "reconciling",
      providerResult: { mutationAttempted: true },
      updatedAt: new Date(),
    })
    .where(eq(siteDomainOperations.id, ledger.id));
  let response: { ok: boolean; requestId: string | null };
  try {
    response = await api.setAutoRenew({
      instanceId: details.instanceId,
      enabled: parsed.enabled,
    });
  } catch {
    return {
      status: "pending" as const,
      nextPollMs: 15_000,
      result: { mutationAttempted: true, phase: "auto_renew_reconciling" },
    };
  }
  if (!response.ok) {
    throw new AliyunProviderError(
      "AUTO_RENEW_REJECTED",
      "阿里云未接受自动续费设置。",
    );
  }
  const observed = await api.getDomain(domain);
  if (!observed || observed.autoRenewEnabled !== parsed.enabled) {
    return {
      status: "pending" as const,
      nextPollMs: 15_000,
      providerOperationId: response.requestId ?? undefined,
      result: {
        mutationAttempted: true,
        phase: "auto_renew_observation_pending",
      },
    };
  }
  await db
    .update(workspaceSiteProfiles)
    .set({
      autoRenewDesired: parsed.enabled,
      autoRenewObserved: parsed.enabled,
      updatedAt: new Date(),
    })
    .where(eq(workspaceSiteProfiles.userId, operation.userId));
  return {
    status: "succeeded" as const,
    providerOperationId: response.requestId ?? undefined,
    result: { domain, autoRenewObserved: parsed.enabled },
    message: `域名 ${domain} 已${parsed.enabled ? "开启" : "关闭"}自动续费。`,
  };
}

export function createAliyunDomainProviderHandler(options?: {
  factory?: AliyunProviderSdkFactory;
}): SiteOpsProviderHandler {
  const factory = options?.factory ?? new OfficialAliyunProviderSdkFactory();
  return async ({ operation, signal }) => {
    try {
      if (process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() !== "1") {
        throw new AliyunProviderError(
          "PROVIDER_NOT_CONFIGURED",
          "阿里云域名自动化未启用；未提交任何外部操作。",
        );
      }
      assertNotAborted(signal);
      const db = await requireDb();
      const parsed = domainOperationInputSchema.parse(operation.input);
      const ledger = await loadDomainOperationForSiteOperation(db, operation);
      const connection = await loadConnectionForLedger(db, ledger);
      if (
        parsed.connectionId !== connection.id ||
        parsed.domainLedgerId !== ledger.id
      ) {
        throw new AliyunProviderError(
          "DOMAIN_LEDGER_MISMATCH",
          "域名操作绑定的客户连接或台账不一致。",
        );
      }
      if (operation.kind === "domain_search") {
        const credentials = await assumeForConnection(
          connection,
          factory,
          DOMAIN_READ_POLICY,
          ledger.kind === "sync" ? "domain-sync" : "domain-search",
        );
        const api = factory.domain(credentials);
        return ledger.kind === "sync"
          ? await handleDomainSync(
              db,
              operation,
              ledger,
              connection,
              api,
              parsed,
            )
          : await handleDomainSearch(db, operation, ledger, api, parsed);
      }
      if (
        operation.kind === "domain_purchase" ||
        operation.kind === "domain_renewal"
      ) {
        return await handleDomainFinancial(
          db,
          operation,
          ledger,
          connection,
          factory,
          parsed,
          signal,
        );
      }
      if (operation.kind === "domain_auto_renew") {
        return await handleDomainAutoRenew(
          db,
          operation,
          ledger,
          connection,
          factory,
          parsed,
        );
      }
      throw new AliyunProviderError(
        "UNSUPPORTED_DOMAIN_OPERATION",
        `不支持的域名操作：${operation.kind}`,
      );
    } catch (error) {
      return resultError(error);
    }
  };
}

export type AliyunDnsPlanItem = {
  id: string;
  action:
    | "create"
    | "update"
    | "adopt"
    | "verify"
    | "rollback_update"
    | "rollback_delete"
    | "conflict"
    | "unknown";
  current: AliyunDnsRecordView | null;
  reason: string | null;
};

export type AliyunDnsBoundPlanItem = {
  id: string;
  action: AliyunDnsPlanItem["action"];
  rr: string;
  type: string;
  expectedValue: string;
  expectedTtl: number;
  current: AliyunDnsRecordView | null;
  reason: string | null;
};

export function bindAliyunDnsPlan(input: {
  domain: string;
  revision: number;
  expectedRecords: SiteDnsRecord[];
  plan: AliyunDnsPlanItem[];
}) {
  const items = input.plan.map((item): AliyunDnsBoundPlanItem => {
    const expected = input.expectedRecords.find((row) => row.id === item.id);
    if (!expected) {
      throw new AliyunProviderError(
        "DNS_EXPECTATION_INVALID",
        "DNS 计划引用了不存在的期望记录。",
      );
    }
    return {
      id: item.id,
      action: item.action,
      rr: expected.rr,
      type: expected.recordType.toUpperCase(),
      expectedValue: expected.expectedValue,
      expectedTtl: expected.expectedTtl,
      current: item.current
        ? {
            recordId: item.current.recordId,
            rr: item.current.rr,
            type: item.current.type.toUpperCase(),
            value: item.current.value,
            ttl: item.current.ttl,
            remark: item.current.remark,
          }
        : null,
      reason: item.reason,
    };
  });
  const providerSnapshotHash = sha256(
    stableJson({
      schemaVersion: 1,
      domain: input.domain,
      revision: input.revision,
      records: items.map((item) => ({ id: item.id, current: item.current })),
    }),
  );
  const planHash = sha256(
    stableJson({
      schemaVersion: 1,
      domain: input.domain,
      revision: input.revision,
      providerSnapshotHash,
      items,
    }),
  );
  return {
    items,
    providerSnapshotHash,
    planHash,
    canApply: items.every(
      (item) => item.action !== "conflict" && item.action !== "unknown",
    ),
  };
}

function normalizedDnsValue(type: string, value: string) {
  const trimmed = value.trim();
  if (type.toUpperCase() === "CNAME") {
    return trimmed.replace(/\.$/, "").toLowerCase();
  }
  if (type.toUpperCase() === "TXT") {
    return trimmed.replace(/^"|"$/g, "");
  }
  return trimmed.toLowerCase();
}

function sameDnsTuple(
  current: AliyunDnsRecordView,
  expected: Pick<
    SiteDnsRecord,
    "rr" | "recordType" | "expectedValue" | "expectedTtl"
  >,
) {
  return (
    current.rr.toLowerCase() === expected.rr.toLowerCase() &&
    current.type.toUpperCase() === expected.recordType.toUpperCase() &&
    normalizedDnsValue(current.type, current.value) ===
      normalizedDnsValue(expected.recordType, expected.expectedValue) &&
    current.ttl === expected.expectedTtl
  );
}

function sameDnsOwner(
  current: AliyunDnsRecordView,
  expected: Pick<SiteDnsRecord, "providerRecordId" | "remarkMarker">,
) {
  return (
    Boolean(expected.providerRecordId) &&
    current.recordId === expected.providerRecordId &&
    current.remark === expected.remarkMarker
  );
}

export function planAliyunDnsRecords(
  expectedRecords: SiteDnsRecord[],
  currentRecords: AliyunDnsRecordView[],
  mode: "apply" | "rollback" = "apply",
): AliyunDnsPlanItem[] {
  return expectedRecords.map((expected): AliyunDnsPlanItem => {
    const type = expected.recordType.toUpperCase();
    if (!["TXT", "CNAME", "A", "AAAA"].includes(type)) {
      return {
        id: expected.id,
        action: "conflict",
        current: null,
        reason: `FrontMind 不管理 ${type} 记录。`,
      };
    }
    const tupleRecords = currentRecords.filter(
      (current) =>
        current.rr.toLowerCase() === expected.rr.toLowerCase() &&
        current.type.toUpperCase() === type,
    );
    const byId = expected.providerRecordId
      ? (currentRecords.find(
          (current) => current.recordId === expected.providerRecordId,
        ) ?? null)
      : null;
    if (mode === "rollback") {
      if (!byId || !sameDnsOwner(byId, expected)) {
        return {
          id: expected.id,
          action: "conflict",
          current: byId,
          reason: "RecordId 或 FrontMind remark 不再匹配，拒绝回滚。",
        };
      }
      if (!sameDnsTuple(byId, expected)) {
        return {
          id: expected.id,
          action: "conflict",
          current: byId,
          reason: "记录已被客户后续修改，拒绝覆盖或删除。",
        };
      }
      return {
        id: expected.id,
        action:
          expected.beforeValue == null ? "rollback_delete" : "rollback_update",
        current: byId,
        reason: null,
      };
    }
    if (expected.providerRecordId) {
      if (!byId || !sameDnsOwner(byId, expected)) {
        const unresolvedWrite =
          ["applying", "propagating", "outcome_unknown"].includes(
            expected.status,
          ) &&
          (!byId || byId.recordId === expected.providerRecordId);
        return {
          id: expected.id,
          action: unresolvedWrite ? "unknown" : "conflict",
          current: byId,
          reason: unresolvedWrite
            ? "RecordId/remark 尚未在控制面同时可见；只读等待，不重复写入。"
            : "RecordId 与 FrontMind remark 必须同时匹配后才能更新。",
        };
      }
      if (
        ["applying", "propagating", "outcome_unknown"].includes(
          expected.status,
        ) &&
        !sameDnsTuple(byId, expected)
      ) {
        return {
          id: expected.id,
          action: "unknown",
          current: byId,
          reason: "先前更新结果未知，当前值仍不匹配；拒绝自动再次发送 Update。",
        };
      }
      return {
        id: expected.id,
        action: sameDnsTuple(byId, expected) ? "verify" : "update",
        current: byId,
        reason: null,
      };
    }
    const recoverable = tupleRecords.filter(
      (current) =>
        current.remark === expected.remarkMarker &&
        sameDnsTuple(current, expected),
    );
    if (recoverable.length === 1 && tupleRecords.length === 1) {
      return {
        id: expected.id,
        action: "adopt",
        current: recoverable[0],
        reason: null,
      };
    }
    if (tupleRecords.length > 0) {
      return {
        id: expected.id,
        action: "conflict",
        current: tupleRecords[0],
        reason: "相同 RR/type 已有非 FrontMind 记录，拒绝覆盖。",
      };
    }
    if (["applying", "outcome_unknown"].includes(expected.status)) {
      return {
        id: expected.id,
        action: "unknown",
        current: null,
        reason:
          "先前写入结果未知且无法按精确 tuple+remark 对账，拒绝重复新增。",
      };
    }
    return { id: expected.id, action: "create", current: null, reason: null };
  });
}

async function defaultPublicDnsResolver(input: {
  hostname: string;
  type: string;
}) {
  try {
    switch (input.type.toUpperCase()) {
      case "A":
        return await resolve4(input.hostname);
      case "AAAA":
        return await resolve6(input.hostname);
      case "CNAME":
        return await resolveCname(input.hostname);
      case "TXT":
        return (await resolveTxt(input.hostname)).map((parts) =>
          parts.join(""),
        );
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function dnsHostname(domain: string, rr: string) {
  return rr === "@" ? domain : `${rr}.${domain}`;
}

async function verifyPublicDns(
  records: SiteDnsRecord[],
  resolver: PublicDnsResolver,
) {
  const observations = await Promise.all(
    records.map(async (record) => {
      const values = await resolver({
        hostname: dnsHostname(record.domainAscii, record.rr),
        type: record.recordType,
      });
      const expected = normalizedDnsValue(
        record.recordType,
        record.expectedValue,
      );
      return {
        id: record.id,
        values,
        matched: values.some(
          (value) => normalizedDnsValue(record.recordType, value) === expected,
        ),
      };
    }),
  );
  return {
    ok: observations.every((observation) => observation.matched),
    observations,
  };
}

async function loadActiveConnectionForOperation(
  db: DbExecutor,
  operation: SiteOperation,
) {
  const rows = await db
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, operation.projectId),
        eq(siteProviderConnections.userId, operation.userId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection) {
    throw new AliyunProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "客户阿里云连接不存在。",
    );
  }
  return connection;
}

async function loadDnsRows(
  db: DbExecutor,
  operation: SiteOperation,
  requestedRevision?: number,
) {
  let revision = requestedRevision;
  if (!revision) {
    const profiles = await db
      .select({ revision: workspaceSiteProfiles.domainRevision })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, operation.userId))
      .limit(1);
    revision = profiles[0]?.revision;
  }
  if (!revision) {
    throw new AliyunProviderError(
      "DOMAIN_REVISION_REQUIRED",
      "当前项目没有可规划的域名版本。",
    );
  }
  const rows = await db
    .select()
    .from(siteDnsRecords)
    .where(
      and(
        eq(siteDnsRecords.projectId, operation.projectId),
        eq(siteDnsRecords.userId, operation.userId),
        eq(siteDnsRecords.domainRevision, revision),
      ),
    );
  if (rows.length === 0) {
    throw new AliyunProviderError(
      "DNS_EXPECTATION_NOT_READY",
      "ESA 尚未生成该域名版本的期望 TXT/CNAME，未执行 DNS 写入。",
    );
  }
  const domains = new Set(rows.map((row) => row.domainAscii));
  if (domains.size !== 1) {
    throw new AliyunProviderError(
      "DNS_EXPECTATION_INVALID",
      "同一域名版本包含多个域名，拒绝执行。",
    );
  }
  return { revision, domain: rows[0].domainAscii, rows };
}

async function markDnsConflict(db: DbExecutor, item: AliyunDnsPlanItem) {
  await db
    .update(siteDnsRecords)
    .set({
      status: item.action === "unknown" ? "outcome_unknown" : "conflict",
      errorCode:
        item.action === "unknown" ? "DNS_OUTCOME_UNKNOWN" : "DNS_CONFLICT",
      errorMessage: item.reason,
      observedValue: item.current?.value,
      observedTtl: item.current?.ttl,
      updatedAt: new Date(),
    })
    .where(eq(siteDnsRecords.id, item.id));
}

async function applyDnsItem(
  db: DbExecutor,
  api: AliyunDnsApi,
  row: SiteDnsRecord,
  item: AliyunDnsPlanItem,
) {
  if (item.action === "adopt" && item.current) {
    await db
      .update(siteDnsRecords)
      .set({
        providerRecordId: item.current.recordId,
        observedValue: item.current.value,
        observedTtl: item.current.ttl,
        status: "propagating",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    return;
  }
  if (item.action === "verify") {
    await db
      .update(siteDnsRecords)
      .set({
        observedValue: item.current?.value,
        observedTtl: item.current?.ttl,
        status: "propagating",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    return;
  }
  await db
    .update(siteDnsRecords)
    .set({ status: "applying", updatedAt: new Date() })
    .where(eq(siteDnsRecords.id, row.id));
  try {
    if (item.action === "create") {
      const created = await api.addRecord({
        domain: row.domainAscii,
        rr: row.rr,
        type: row.recordType,
        value: row.expectedValue,
        ttl: row.expectedTtl,
      });
      // RecordId is persisted before the second provider mutation. If setting
      // the remark loses its response, the next sweep reconciles by id+remark.
      await db
        .update(siteDnsRecords)
        .set({ providerRecordId: created.recordId, updatedAt: new Date() })
        .where(eq(siteDnsRecords.id, row.id));
      await api.updateRemark({
        recordId: created.recordId,
        remark: row.remarkMarker,
      });
    } else if (item.action === "update" && item.current) {
      if (row.beforeValue == null) {
        await db
          .update(siteDnsRecords)
          .set({
            beforeValue: item.current.value,
            beforeTtl: item.current.ttl,
            updatedAt: new Date(),
          })
          .where(eq(siteDnsRecords.id, row.id));
      }
      await api.updateRecord({
        recordId: item.current.recordId,
        rr: row.rr,
        type: row.recordType,
        value: row.expectedValue,
        ttl: row.expectedTtl,
      });
    } else if (item.action === "rollback_delete" && item.current) {
      await api.deleteRecord(item.current.recordId);
      await db
        .update(siteDnsRecords)
        .set({
          status: "rolled_back",
          observedValue: null,
          observedTtl: null,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(siteDnsRecords.id, row.id));
      return;
    } else if (item.action === "rollback_update" && item.current) {
      await api.updateRecord({
        recordId: item.current.recordId,
        rr: row.rr,
        type: row.recordType,
        value: row.beforeValue!,
        ttl: row.beforeTtl ?? DEFAULT_DNS_TTL,
      });
      await api.updateRemark({ recordId: item.current.recordId, remark: "" });
      await db
        .update(siteDnsRecords)
        .set({
          status: "rolled_back",
          observedValue: row.beforeValue,
          observedTtl: row.beforeTtl ?? DEFAULT_DNS_TTL,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(siteDnsRecords.id, row.id));
      return;
    }
    await db
      .update(siteDnsRecords)
      .set({
        status: "propagating",
        observedValue: row.expectedValue,
        observedTtl: row.expectedTtl,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
  } catch (error) {
    await db
      .update(siteDnsRecords)
      .set({
        status: "outcome_unknown",
        errorCode: "ALIDNS_OUTCOME_UNKNOWN",
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "AliDNS 写入结果未知。",
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    throw new AliyunProviderError(
      "ALIDNS_OUTCOME_UNKNOWN",
      "AliDNS 写入结果未知；系统将按 RecordId、精确 tuple 和 remark 只读对账，不会盲目重发。",
      true,
    );
  }
}

export function createAliyunDnsProviderHandler(options?: {
  factory?: AliyunProviderSdkFactory;
  publicResolver?: PublicDnsResolver;
}): SiteOpsProviderHandler {
  const factory = options?.factory ?? new OfficialAliyunProviderSdkFactory();
  const publicResolver = options?.publicResolver ?? defaultPublicDnsResolver;
  return async ({ operation, signal }) => {
    try {
      if (process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() !== "1") {
        throw new AliyunProviderError(
          "PROVIDER_NOT_CONFIGURED",
          "AliDNS 自动化未启用；未写入任何解析记录。",
        );
      }
      assertNotAborted(signal);
      const db = await requireDb();
      const input = dnsOperationInputSchema.parse(operation.input);
      const connection = await loadActiveConnectionForOperation(db, operation);
      if (input.connectionId !== connection.id) {
        throw new AliyunProviderError(
          "DNS_CONNECTION_MISMATCH",
          "DNS 操作绑定的客户连接不一致。",
        );
      }
      const credentials = await assumeForConnection(
        connection,
        factory,
        input.dnsIntent === "plan" ? DNS_READ_POLICY : DNS_WRITE_POLICY,
        input.dnsIntent === "rollback" ? "dns-rollback" : "dns-apply",
      );
      const api = factory.dns(credentials);
      const expected = await loadDnsRows(db, operation, input.domainRevision);
      const current = await api.listRecords(expected.domain);
      const mode = input.dnsIntent === "rollback" ? "rollback" : "apply";
      const plan = planAliyunDnsRecords(expected.rows, current, mode);
      const boundPlan = bindAliyunDnsPlan({
        domain: expected.domain,
        revision: expected.revision,
        expectedRecords: expected.rows,
        plan,
      });
      if (
        input.dnsIntent === "apply" &&
        !operation.result &&
        (operation.attempt ?? 0) <= 1 &&
        (input.planHash !== boundPlan.planHash ||
          input.providerSnapshotHash !== boundPlan.providerSnapshotHash)
      ) {
        return {
          status: "attention_required",
          code: "DNS_PLAN_DRIFTED",
          message:
            "DNS 期望记录或供应商当前记录已变化；没有执行写入，请重新生成精确差异计划。",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            expectedPlanHash: input.planHash,
            observedPlanHash: boundPlan.planHash,
            expectedProviderSnapshotHash: input.providerSnapshotHash,
            observedProviderSnapshotHash: boundPlan.providerSnapshotHash,
            plan: boundPlan.items,
            canApply: false,
          },
        };
      }
      const blocked = plan.filter(
        (item) => item.action === "conflict" || item.action === "unknown",
      );
      for (const item of blocked) await markDnsConflict(db, item);
      if (blocked.length > 0) {
        const onlyUnknown = blocked.every((item) => item.action === "unknown");
        const age =
          Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
        if (onlyUnknown && age < DNS_PROPAGATION_TIMEOUT_MS) {
          return {
            status: "pending",
            nextPollMs: 15_000,
            result: {
              domain: expected.domain,
              revision: expected.revision,
              phase: "dns_write_reconciling",
              plan: boundPlan.items,
              planHash: boundPlan.planHash,
              providerSnapshotHash: boundPlan.providerSnapshotHash,
              canApply: false,
            },
          };
        }
        return {
          status: "attention_required",
          code: blocked.some((item) => item.action === "unknown")
            ? "DNS_OUTCOME_UNKNOWN"
            : "DNS_CONFLICT",
          message:
            "DNS 中存在非 FrontMind 记录、所有权标记不一致或未知写入结果；未覆盖客户记录。",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            plan: boundPlan.items,
            planHash: boundPlan.planHash,
            providerSnapshotHash: boundPlan.providerSnapshotHash,
            canApply: false,
          },
        };
      }
      if (input.dnsIntent === "plan") {
        return {
          status: "succeeded",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            plan: boundPlan.items,
            planHash: boundPlan.planHash,
            providerSnapshotHash: boundPlan.providerSnapshotHash,
            canApply: boundPlan.canApply,
          },
          message: "DNS 精确差异计划已生成，尚未写入任何记录。",
        };
      }
      for (const item of plan) {
        assertNotAborted(signal);
        const row = expected.rows.find((entry) => entry.id === item.id)!;
        await applyDnsItem(db, api, row, item);
      }
      if (mode === "rollback") {
        await db
          .update(workspaceSiteProfiles)
          .set({ dnsStatus: "rolled_back", updatedAt: new Date() })
          .where(
            and(
              eq(workspaceSiteProfiles.userId, operation.userId),
              eq(workspaceSiteProfiles.domainRevision, expected.revision),
            ),
          );
        return {
          status: "succeeded",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            rolledBack: true,
          },
          message: "仅 FrontMind 管理且未被客户后续修改的 DNS 记录已回滚。",
        };
      }
      const refreshed = await db
        .select()
        .from(siteDnsRecords)
        .where(
          and(
            eq(siteDnsRecords.projectId, operation.projectId),
            eq(siteDnsRecords.domainRevision, expected.revision),
          ),
        );
      const authoritativeRecords = await api.listRecords(expected.domain);
      const authoritativePlan = planAliyunDnsRecords(
        refreshed,
        authoritativeRecords,
        "apply",
      );
      const unresolvedAuthoritative = authoritativePlan.filter(
        (item) => item.action !== "verify" && item.action !== "adopt",
      );
      if (unresolvedAuthoritative.length > 0) {
        for (const item of unresolvedAuthoritative) {
          await db
            .update(siteDnsRecords)
            .set({
              status: "outcome_unknown",
              errorCode: "ALIDNS_CONTROL_PLANE_PENDING",
              errorMessage: item.reason ?? "AliDNS 控制面尚未返回期望记录。",
              updatedAt: new Date(),
            })
            .where(eq(siteDnsRecords.id, item.id));
        }
        const age =
          Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
        if (age < DNS_PROPAGATION_TIMEOUT_MS) {
          return {
            status: "pending",
            nextPollMs: 15_000,
            result: {
              domain: expected.domain,
              revision: expected.revision,
              phase: "dns_authoritative_reconciling",
              authoritativePlan,
            },
          };
        }
        return {
          status: "attention_required",
          code: "ALIDNS_CONTROL_PLANE_MISMATCH",
          message:
            "AliDNS 控制面未能确认精确 RecordId、tuple 与 remark；系统没有重复写入。",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            authoritativePlan,
          },
        };
      }
      const publicVerification = await verifyPublicDns(
        refreshed,
        publicResolver,
      );
      if (!publicVerification.ok) {
        const age =
          Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
        if (age >= DNS_PROPAGATION_TIMEOUT_MS) {
          return {
            status: "attention_required",
            code: "DNS_PROPAGATION_TIMEOUT",
            message: "AliDNS 控制面已写入，但公共解析在时限内未一致。",
            result: {
              domain: expected.domain,
              revision: expected.revision,
              publicVerification,
            },
          };
        }
        return {
          status: "pending",
          nextPollMs: 15_000,
          result: {
            domain: expected.domain,
            revision: expected.revision,
            phase: "dns_propagating",
            publicVerification,
          },
        };
      }
      await db
        .update(siteDnsRecords)
        .set({
          status: "active",
          verifiedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(siteDnsRecords.projectId, operation.projectId),
            eq(siteDnsRecords.domainRevision, expected.revision),
          ),
        );
      const hasCanonicalCname = refreshed.some(
        (record) => record.recordType.toUpperCase() === "CNAME",
      );
      await db
        .update(workspaceSiteProfiles)
        .set({
          dnsStatus: hasCanonicalCname ? "active" : "pending_esa_binding",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaceSiteProfiles.userId, operation.userId),
            eq(workspaceSiteProfiles.domainRevision, expected.revision),
          ),
        );
      return {
        status: "succeeded",
        result: {
          domain: expected.domain,
          revision: expected.revision,
          publicVerification,
        },
        message: hasCanonicalCname
          ? "AliDNS 控制面与公共解析均已验证。"
          : "ESA 所有权 TXT 已验证；请再次生成 DNS 计划以取得精确 CNAME。",
      };
    } catch (error) {
      return resultError(error);
    }
  };
}

let registeredAliyunProviders = false;

/** Registers the two narrow handlers once; no registration happens on import. */
export function registerAliyunSiteOpsProviders(options?: {
  factory?: AliyunProviderSdkFactory;
  publicResolver?: PublicDnsResolver;
}) {
  if (registeredAliyunProviders) return () => undefined;
  const unregisterDomain = registerSiteOpsProviderHandler(
    "aliyun_domain",
    createAliyunDomainProviderHandler({ factory: options?.factory }),
  );
  const unregisterDns = registerSiteOpsProviderHandler(
    "aliyun_alidns",
    createAliyunDnsProviderHandler({
      factory: options?.factory,
      publicResolver: options?.publicResolver,
    }),
  );
  registeredAliyunProviders = true;
  return () => {
    unregisterDomain();
    unregisterDns();
    registeredAliyunProviders = false;
  };
}
