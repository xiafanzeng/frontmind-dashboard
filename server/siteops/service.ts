import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  or,
} from "drizzle-orm";
import { z } from "zod";
import {
  conversations,
  conversationTurns,
  knowledgeBaseSnapshots,
  messages,
  presalesApiCredentials,
  siteBuilds,
  siteDeployments,
  siteDnsRecords,
  siteDomainOperations,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  socialPackages,
  users,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  workspaceSiteProfiles,
} from "../../drizzle/schema";
import {
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsAliyunConnectionSetupInputSchema,
  siteOpsObserveInputSchema,
  siteOpsSendMessageInputSchema,
  visualEvidenceV1Schema,
  type SiteOpsActInput,
  type SiteBrief,
} from "../../shared/siteops";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import { siteOpsObservationV1Schema } from "../../shared/siteops-contract";
import {
  visualSearchOperationInputV1Schema,
  type VisualSearchOperationInputV1,
} from "../../shared/siteops-workflow";
import type { AuthenticatedUser } from "../auth-service";
import { getDb } from "../db";
import { getServicePortal } from "../service-entitlement";
import { siteOpsProviderConfigured } from "./providers";
import {
  AliyunProviderError,
  disconnectAliyunCustomerConnection,
  getAliyunCustomerConnectionStatus,
  setupAliyunCustomerConnection,
  verifyAliyunCustomerConnection,
} from "./aliyun-provider";
import { inspectEsaRuntimeConfiguration } from "./esa-config";
import {
  assertSiteOpsServiceEntitlement,
  reserveSiteOpsQuota,
  siteOpsQuotaPeriodIds,
  SiteOpsQuotaError,
} from "./quota-service";

export type SiteOpsServiceErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "FEATURE_DISABLED"
  | "FORBIDDEN"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PROVIDER_NOT_CONFIGURED"
  | "REVISION_CONFLICT"
  | "STATE_CONFLICT";

export class SiteOpsServiceError extends Error {
  constructor(
    public readonly code: SiteOpsServiceErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SiteOpsServiceError";
  }
}

export function isSiteOpsOperationReplay(
  existing: { inputHash: string } | null | undefined,
  requestHash: string,
) {
  if (!existing) return false;
  if (existing.inputHash !== requestHash) {
    throw new SiteOpsServiceError(
      "IDEMPOTENCY_CONFLICT",
      "该请求标识已用于不同操作。",
      409,
    );
  }
  return true;
}

const uuidSchema = z.string().uuid();
const optionalUuidSchema = uuidSchema.optional();
const TWENTY_FIRST_OPERATION_MARKER_PREFIX = "siteops-21st-operation:";
const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\s/@?#\\]/u.test(value), "域名格式不正确");

const ALIYUN_CUSTOMER_ROLE_PERMISSIONS = {
  daily: [
    "domain:CheckDomain",
    "domain:QueryDomainByDomainName",
    "domain:QueryDomainList",
    "domain:QueryRegistrantProfiles",
    "domain:QueryTaskList",
    "domain:QueryTaskDetailList",
    "alidns:DescribeDomainRecords",
  ],
  purchase: ["domain:SaveSingleTaskForCreatingOrderActivate"],
  renewal: ["domain:SaveSingleTaskForCreatingOrderRenew"],
  autoRenew: ["domain:SetupDomainAutoRenew"],
  dnsWrite: [
    "alidns:AddDomainRecord",
    "alidns:UpdateDomainRecord",
    "alidns:UpdateDomainRecordRemark",
    "alidns:DeleteDomainRecord",
  ],
} as const;

export function normalizeSiteOpsDomain(value: string) {
  const withoutDot = value.trim().replace(/\.$/u, "");
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    isIP(ascii) !== 0 ||
    !ascii.includes(".") ||
    ascii
      .split(".")
      .some(
        (label) =>
          label.length < 1 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new SiteOpsServiceError("INVALID_INPUT", "域名格式不正确。", 400);
  }
  return { domain: ascii, domainUnicode: domainToUnicode(ascii) || withoutDot };
}

export function siteOpsActiveFinancialIntentKey(input: {
  projectId: string;
  accountUid: string;
  domain: string;
  kind: "purchase" | "renewal";
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        projectId: input.projectId,
        accountUid: input.accountUid,
        domain: input.domain.toLowerCase(),
        kind: input.kind,
      }),
      "utf8",
    )
    .digest("hex");
}

export function isSiteOpsIcpApprovedForCurrentDomain(input: {
  icpStatus: string | null;
  icpNumber: string | null;
  icpDomainRevision: number | null;
  domainRevision: number;
}) {
  return Boolean(
    input.icpStatus === "approved" &&
      input.icpNumber?.trim() &&
      input.icpDomainRevision === input.domainRevision,
  );
}

function assertEnabled() {
  if (process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0") {
    throw new SiteOpsServiceError(
      "FEATURE_DISABLED",
      "AI 建站服务当前已暂停，请稍后重试。",
      503,
    );
  }
}

function assertCustomer(actor: AuthenticatedUser) {
  if (actor.role !== "user") {
    throw new SiteOpsServiceError(
      "FORBIDDEN",
      "只有客户本人可以操作 AI 建站会话。",
      403,
    );
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new SiteOpsServiceError(
      "DATABASE_UNAVAILABLE",
      "AI 建站服务暂时不可用，请稍后重试。",
      503,
    );
  }
  return db;
}

async function requireSiteOpsEntitlement(userId: number) {
  try {
    return assertSiteOpsServiceEntitlement(await getServicePortal(userId));
  } catch (error) {
    if (error instanceof SiteOpsQuotaError) {
      throw new SiteOpsServiceError(
        "FORBIDDEN",
        error.message,
        error.statusCode,
      );
    }
    throw error;
  }
}

async function reserveSiteOpsDeliveryQuota(
  tx: any,
  input: {
    userId: number;
    portal: Awaited<ReturnType<typeof getServicePortal>>;
    quotaPool: "content_asset_publish" | "website_content_publish";
  },
) {
  try {
    return await reserveSiteOpsQuota(tx, {
      userId: input.userId,
      quotaPool: input.quotaPool,
      quotaPeriodIds: siteOpsQuotaPeriodIds(input.portal, input.quotaPool),
    });
  } catch (error) {
    if (error instanceof SiteOpsQuotaError) {
      throw new SiteOpsServiceError(
        error.code === "SITEOPS_ENTITLEMENT_REQUIRED"
          ? "FORBIDDEN"
          : "STATE_CONFLICT",
        error.message,
        error.statusCode,
      );
    }
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function compactKnowledgeText(value: unknown, max = 600) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[#>*_`|\[\]()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

export function siteBriefFromSnapshot(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
): SiteBrief {
  const publicDocuments = snapshot.documents.filter(
    (document) =>
      document.customerVisible !== false &&
      document.kind !== "evidence" &&
      // dashboard-core-v1 deliberately labels customer-confirmed leaf nodes as
      // needs_verification when their external evidence is incomplete. The
      // immutable active snapshot is still the customer's approved factual
      // source; keep its document ids in provenance and only exclude content
      // that the package itself classifies as inferred.
      document.evidenceStatus !== "inferred",
  );
  const idFor = (document: (typeof publicDocuments)[number]) =>
    String(document.id || document.path).slice(0, 191);
  const overview =
    publicDocuments.find((document) => document.kind === "overview") ??
    publicDocuments[0];
  const companyName =
    compactKnowledgeText(
      overview?.content.match(
        /(?:公司名称|企业名称|品牌名称)\s*[:：]\s*([^\n]+)/u,
      )?.[1],
      255,
    ) ||
    compactKnowledgeText(overview?.title, 255) ||
    compactKnowledgeText(
      snapshot.sourceFileName.replace(/\.(zip|md)$/iu, ""),
      255,
    );
  const offeringDocuments = publicDocuments.filter((document) =>
    /(?:产品|服务|解决方案|业务)/u.test(
      `${document.branchTitle ?? ""} ${document.title}`,
    ),
  );
  const offerings = offeringDocuments
    .map((document) => compactKnowledgeText(document.title, 500))
    .filter(Boolean)
    .slice(0, 20);
  if (offerings.length === 0 && overview?.title) {
    offerings.push(compactKnowledgeText(overview.title, 500));
  }
  const audience = publicDocuments
    .flatMap((document) =>
      [
        ...document.content.matchAll(
          /(?:适用于|面向|服务于)\s*([^。；\n]{2,120})/gu,
        ),
      ].map((match) => compactKnowledgeText(match[1], 500)),
    )
    .filter(Boolean)
    .slice(0, 12);
  const contacts: SiteBrief["contacts"] = [];
  for (const document of publicDocuments) {
    const sourceDocumentIds = [idFor(document)];
    const content = document.content.slice(0, 100_000);
    const email = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
    const phone = content.match(
      /(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})/u,
    )?.[0];
    const address = content.match(
      /(?:地址|办公地址|联系地址)\s*[:：]\s*([^\n]{4,200})/u,
    )?.[1];
    if (email)
      contacts.push({ kind: "email", value: email, sourceDocumentIds });
    if (phone)
      contacts.push({ kind: "phone", value: phone, sourceDocumentIds });
    if (address) {
      contacts.push({
        kind: "address",
        value: compactKnowledgeText(address, 512),
        sourceDocumentIds,
      });
    }
    if (contacts.length >= 20) break;
  }
  const aboutIds = publicDocuments.slice(0, 8).map(idFor);
  const offeringIds = (
    offeringDocuments.length ? offeringDocuments : publicDocuments.slice(0, 8)
  ).map(idFor);
  const routes: SiteBrief["routes"] = [
    { id: "home", slug: "/", title: "首页", sourceDocumentIds: aboutIds },
    {
      id: "about",
      slug: "/about",
      title: "关于我们",
      sourceDocumentIds: aboutIds,
    },
    {
      id: "offerings",
      slug: "/offerings",
      title: "产品与服务",
      sourceDocumentIds: offeringIds,
    },
  ];
  if (contacts.length > 0) {
    routes.push({
      id: "contact",
      slug: "/contact",
      title: "联系我们",
      sourceDocumentIds: [
        ...new Set(contacts.flatMap((item) => item.sourceDocumentIds)),
      ],
    });
  }
  const verifiedFacts = publicDocuments
    .flatMap((document) =>
      document.content
        .split(/\n\s*\n|(?<=[。！？])\s+/u)
        .map((statement) => compactKnowledgeText(statement, 2_000))
        .filter((statement) => statement.length >= 12)
        .slice(0, 4)
        .map((statement) => ({
          statement,
          sourceDocumentIds: [idFor(document)],
        })),
    )
    .slice(0, 120);
  const publicAssetIds = snapshot.assets
    .filter(
      (asset) =>
        Boolean(asset.id && asset.sha256) &&
        (asset.sourceKind === "official_logo_upload" ||
          (asset.ownership === "first_party" &&
            /logo/iu.test(`${asset.key} ${asset.path}`))),
    )
    .flatMap((asset) => (asset.id ? [asset.id] : []))
    .slice(0, 1);
  return siteBriefSchema.parse({
    companyName,
    primaryLanguage: "zh-CN",
    contacts,
    offerings,
    audience: audience.length > 0 ? audience : ["希望了解企业产品与服务的访客"],
    conversionGoal: contacts.length
      ? "帮助访客了解企业与产品，并通过已验证的联系方式进一步咨询"
      : "帮助访客准确了解企业与产品",
    routes,
    verifiedFacts,
    publicAssetIds,
    unknowns: [
      ...(audience.length > 0 ? [] : ["需要进一步确认核心目标受众"]),
      ...(contacts.length > 0 ? [] : ["知识库中暂无可公开的已验证联系方式"]),
    ],
  });
}

function mergeCustomerBriefMessage(brief: SiteBrief, text: string): SiteBrief {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const nextContacts = [...brief.contacts];
  const addContact = (
    kind: SiteBrief["contacts"][number]["kind"],
    value: string,
  ) => {
    const compact = compactKnowledgeText(value, 512);
    if (
      compact &&
      !nextContacts.some(
        (item) =>
          item.kind === kind &&
          item.value.toLowerCase() === compact.toLowerCase(),
      )
    ) {
      // A value explicitly supplied in the authenticated customer conversation
      // is customer-confirmed input. It is not attributed to a snapshot document.
      nextContacts.push({ kind, value: compact, sourceDocumentIds: [] });
    }
  };
  for (const email of normalized.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
  ) ?? []) {
    addContact("email", email);
  }
  for (const phone of normalized.match(
    /(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})/gu,
  ) ?? []) {
    addContact("phone", phone);
  }
  const address = normalized.match(
    /(?:办公地址|联系地址|公司地址|地址)\s*[:：]\s*([^\n]{4,200})/u,
  )?.[1];
  if (address) addContact("address", address);

  const audienceValue = normalized.match(
    /(?:目标受众|核心受众|受众|面向)\s*[:：]\s*([^\n]{2,500})/u,
  )?.[1];
  const conversionValue = normalized.match(
    /(?:转化目标|核心目标|建站目标)\s*[:：]\s*([^\n]{2,500})/u,
  )?.[1];
  const audience = audienceValue
    ? [compactKnowledgeText(audienceValue, 500)]
    : brief.audience;
  const conversionGoal = compactKnowledgeText(
    conversionValue || normalized,
    500,
  );
  const hasNewContact = nextContacts.length > brief.contacts.length;

  return siteBriefSchema.parse({
    ...brief,
    contacts: nextContacts.slice(0, 20),
    audience,
    conversionGoal: conversionGoal || brief.conversionGoal,
    unknowns: brief.unknowns.filter((item) => {
      if (audienceValue && item.includes("目标受众")) return false;
      if (conversionValue && item.includes("转化")) return false;
      if (hasNewContact && item.includes("联系方式")) return false;
      return true;
    }),
  });
}

export function hashSiteOpsRequest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

const RESETTABLE_PRE_BUILD_STATUSES = new Set([
  "draft",
  "collecting_brief",
  "visual_searching",
  "awaiting_visual_selection",
  "failed",
  "attention_required",
]);

export function siteOpsResetCapability(input: {
  projectStatus: string;
  currentBuild: boolean;
  liveHead: boolean;
  hasBuild: boolean;
  hasDeployment: boolean;
  hasBlockingOperation: boolean;
  hasActiveDns: boolean;
  hasUnresolvedFinancialIntent: boolean;
}) {
  if (input.currentBuild || input.hasBuild) {
    return {
      allowed: false as const,
      reason: "已有官网版本，不能重置为全新首轮任务。请使用版本修改或回滚。",
    };
  }
  if (input.liveHead) {
    return {
      allowed: false as const,
      reason: "已有线上官网，不能通过首轮重置清空当前项目。",
    };
  }
  if (input.hasDeployment) {
    return {
      allowed: false as const,
      reason: "已有发布记录，不能通过首轮重置清空当前项目。",
    };
  }
  if (input.hasBlockingOperation) {
    return {
      allowed: false as const,
      reason: "当前仍有任务正在执行或结果待确认，完成后才能重置。",
    };
  }
  if (input.hasActiveDns) {
    return {
      allowed: false as const,
      reason: "当前仍有 DNS 变更待完成或对账，完成后才能重置。",
    };
  }
  if (input.hasUnresolvedFinancialIntent) {
    return {
      allowed: false as const,
      reason: "当前仍有域名付费操作待确认，完成对账后才能重置。",
    };
  }
  if (!RESETTABLE_PRE_BUILD_STATUSES.has(input.projectStatus)) {
    return {
      allowed: false as const,
      reason: "当前阶段不能使用首轮重置，请使用对应的版本管理操作。",
    };
  }
  return { allowed: true as const };
}

async function appendMessage(
  tx: any,
  input: {
    conversationId: string;
    userId: number;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    turnId?: string | null;
    siteOps?: Record<string, unknown>;
  },
) {
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, input.conversationId));
  const sequence = Number(sequenceRows[0]?.sequence ?? 0) + 1;
  const id = randomUUID();
  await tx.insert(messages).values({
    id,
    conversationId: input.conversationId,
    turnId: input.turnId ?? null,
    userId: input.userId,
    role: input.role,
    content: input.content,
    sequence,
    metadata: input.siteOps ? { siteOps: input.siteOps } : {},
  });
  return { id, sequence };
}

async function loadOwnedProject(
  executor: any,
  userId: number,
  conversationId?: string,
  lock = false,
) {
  let query = executor
    .select()
    .from(siteProjects)
    .where(
      conversationId
        ? and(
            eq(siteProjects.userId, userId),
            eq(siteProjects.conversationId, conversationId),
          )
        : eq(siteProjects.userId, userId),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const rows = await query;
  return rows[0] ?? null;
}

async function loadProviderState(executor: any, projectId: string) {
  const [credentials, connections] = await Promise.all([
    executor
      .select({ slot: presalesApiCredentials.slot })
      .from(presalesApiCredentials)
      .where(
        and(
          inArray(presalesApiCredentials.slot, [
            "website",
            "site_builder_21st",
          ]),
          eq(presalesApiCredentials.status, "active"),
          eq(presalesApiCredentials.validationStatus, "verified"),
        ),
      ),
    executor
      .select({ status: siteProviderConnections.status })
      .from(siteProviderConnections)
      .where(
        and(
          eq(siteProviderConnections.projectId, projectId),
          eq(siteProviderConnections.provider, "aliyun_cn"),
        ),
      )
      .limit(1),
  ]);
  const slots = new Set(credentials.map((row: { slot: string }) => row.slot));
  const aliyunFeatureEnabled =
    process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() === "1";
  const aliyunRolePrincipalConfigured = Boolean(
    process.env.FRONTMIND_ALIYUN_ROLE_PRINCIPAL_ARN?.trim(),
  );
  const aliyunConnectionReady = connections[0]?.status === "active";
  const aliyunReady =
    aliyunFeatureEnabled &&
    aliyunRolePrincipalConfigured &&
    aliyunConnectionReady;
  const esa = inspectEsaRuntimeConfiguration({
    providerRegistered: siteOpsProviderConfigured("aliyun_esa"),
  });
  return {
    twentyFirst: {
      status: slots.has("site_builder_21st")
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: slots.has("site_builder_21st")
        ? undefined
        : "系统管理员尚未配置有效的 21st API Key",
    },
    manus: {
      status: slots.has("website")
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: slots.has("website")
        ? undefined
        : "系统管理员尚未配置有效的官网任务 API Key",
    },
    esa: {
      status: esa.configured
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: esa.configured ? undefined : esa.reason,
    },
    aliyun: {
      status: aliyunReady
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: aliyunReady
        ? undefined
        : !aliyunFeatureEnabled
          ? "阿里云域名与 DNS 功能尚未启用"
          : !aliyunRolePrincipalConfigured
            ? "FrontMind RAM 服务身份 ARN 尚未配置"
            : "客户尚未连接有效的阿里云 RAM Role",
    },
  };
}

function requireEsaRuntimeConfigured() {
  const configuration = inspectEsaRuntimeConfiguration({
    providerRegistered: siteOpsProviderConfigured("aliyun_esa"),
  });
  if (!configuration.configured) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      `${configuration.reason}，未创建任何虚假的 ESA 操作。`,
      412,
    );
  }
}

async function projectObservation(
  executor: any,
  input: {
    userId: number;
    project: typeof siteProjects.$inferSelect;
    afterSequence?: number;
  },
) {
  const messagePredicate =
    input.afterSequence === undefined
      ? and(
          eq(messages.conversationId, input.project.conversationId),
          isNull(messages.deletedAt),
        )
      : and(
          eq(messages.conversationId, input.project.conversationId),
          isNull(messages.deletedAt),
          gt(messages.sequence, input.afterSequence),
        );
  const [
    messageRows,
    buildRows,
    deploymentRows,
    packageRows,
    providerState,
    snapshotRows,
    batchRows,
    connectionRows,
    profileRows,
    domainOperationRows,
    dnsOperationRows,
    activeAliyunOperationRows,
    unresolvedFinancialRows,
    resetOperationRows,
    activeDnsRecordRows,
  ] = await Promise.all([
    executor
      .select()
      .from(messages)
      .where(messagePredicate)
      .orderBy(asc(messages.sequence))
      .limit(500),
    executor
      .select()
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.projectId, input.project.id),
          eq(siteBuilds.userId, input.userId),
        ),
      )
      .orderBy(desc(siteBuilds.ordinal))
      .limit(50),
    executor
      .select()
      .from(siteDeployments)
      .where(
        and(
          eq(siteDeployments.projectId, input.project.id),
          eq(siteDeployments.userId, input.userId),
        ),
      )
      .orderBy(desc(siteDeployments.createdAt))
      .limit(50),
    executor
      .select()
      .from(socialPackages)
      .where(
        and(
          eq(socialPackages.projectId, input.project.id),
          eq(socialPackages.userId, input.userId),
        ),
      )
      .orderBy(desc(socialPackages.createdAt))
      .limit(50),
    loadProviderState(executor, input.project.id),
    executor
      .select()
      .from(knowledgeBaseSnapshots)
      .where(
        and(
          eq(knowledgeBaseSnapshots.userId, input.userId),
          eq(knowledgeBaseSnapshots.status, "active"),
        ),
      )
      .orderBy(desc(knowledgeBaseSnapshots.version))
      .limit(200),
    executor
      .select()
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.userId, input.userId),
          eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
        ),
      )
      .orderBy(desc(websiteStyleSampleBatches.ordinal))
      .limit(1),
    executor
      .select()
      .from(siteProviderConnections)
      .where(
        and(
          eq(siteProviderConnections.projectId, input.project.id),
          eq(siteProviderConnections.userId, input.userId),
          eq(siteProviderConnections.provider, "aliyun_cn"),
        ),
      )
      .limit(1),
    executor
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.userId))
      .limit(1),
    executor
      .select()
      .from(siteDomainOperations)
      .where(
        and(
          eq(siteDomainOperations.projectId, input.project.id),
          eq(siteDomainOperations.userId, input.userId),
        ),
      )
      .orderBy(desc(siteDomainOperations.createdAt))
      .limit(20),
    executor
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.userId),
          eq(siteOperations.provider, "aliyun_alidns"),
          eq(siteOperations.kind, "dns_apply"),
          inArray(siteOperations.status, ["succeeded", "attention_required"]),
        ),
      )
      .orderBy(desc(siteOperations.createdAt))
      .limit(20),
    executor
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.userId),
          inArray(siteOperations.provider, ["aliyun_domain", "aliyun_alidns"]),
          inArray(siteOperations.status, [
            "queued",
            "running",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1),
    executor
      .select({ id: siteDomainOperations.id })
      .from(siteDomainOperations)
      .where(
        and(
          eq(siteDomainOperations.projectId, input.project.id),
          eq(siteDomainOperations.userId, input.userId),
          isNotNull(siteDomainOperations.activeFinancialKey),
        ),
      )
      .limit(1),
    executor
      .select({
        kind: siteOperations.kind,
        status: siteOperations.status,
      })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.userId),
          or(
            inArray(siteOperations.status, ["running", "outcome_unknown"]),
            and(
              eq(siteOperations.status, "queued"),
              ne(siteOperations.kind, "visual_search"),
            ),
          ),
        ),
      )
      .limit(1),
    executor
      .select({ id: siteDnsRecords.id })
      .from(siteDnsRecords)
      .where(
        and(
          eq(siteDnsRecords.projectId, input.project.id),
          eq(siteDnsRecords.userId, input.userId),
          inArray(siteDnsRecords.status, [
            "applying",
            "propagating",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1),
  ]);

  const candidateRows = batchRows[0]
    ? await executor
        .select()
        .from(websiteStyleSamples)
        .where(eq(websiteStyleSamples.batchId, batchRows[0].id))
        .orderBy(asc(websiteStyleSamples.sortOrder))
        .limit(9)
    : [];

  const messagesProjected = messageRows.map(
    (row: typeof messages.$inferSelect) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const siteOps = metadata.siteOps as Record<string, unknown> | undefined;
      const projectedMetadata =
        siteOps?.status === "active" &&
        Number(siteOps.revision) !== input.project.revision
          ? { ...metadata, siteOps: { ...siteOps, status: "expired" } }
          : metadata;
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        sequence: row.sequence,
        metadata: projectedMetadata,
        sentAt: row.sentAt.toISOString(),
      };
    },
  );
  const latestDnsPlanRow = dnsOperationRows.find(
    (row: typeof siteOperations.$inferSelect) =>
      (row.input as Record<string, unknown> | null)?.dnsIntent === "plan",
  ) as typeof siteOperations.$inferSelect | undefined;
  const latestDnsPlanResult = latestDnsPlanRow?.result as
    | Record<string, unknown>
    | undefined;
  const dnsPlanItems = Array.isArray(latestDnsPlanResult?.plan)
    ? latestDnsPlanResult.plan
    : [];
  const resetCapability = siteOpsResetCapability({
    projectStatus: input.project.status,
    currentBuild: Boolean(input.project.currentBuildId),
    liveHead: Boolean(
      input.project.globalLiveDeploymentId ||
        input.project.mainlandLiveDeploymentId,
    ),
    hasBuild: buildRows.length > 0,
    hasDeployment: deploymentRows.length > 0,
    hasBlockingOperation: resetOperationRows.length > 0,
    hasActiveDns: activeDnsRecordRows.length > 0,
    hasUnresolvedFinancialIntent: unresolvedFinancialRows.length > 0,
  });
  const observation = {
    schemaVersion: 1 as const,
    executionKind: "site_ops" as const,
    providerState,
    aliyunConnection: connectionRows[0]
      ? {
          configured: connectionRows[0].status !== "revoked",
          accountUid: connectionRows[0].accountUid,
          roleArn: connectionRows[0].roleArn,
          externalIdFingerprint: connectionRows[0].externalIdFingerprint,
          status: connectionRows[0].status,
          capabilities: connectionRows[0].capabilities,
          verifiedAt: connectionRows[0].verifiedAt?.toISOString() ?? null,
          lastErrorCode: connectionRows[0].lastErrorCode,
          canRotate:
            activeAliyunOperationRows.length === 0 &&
            unresolvedFinancialRows.length === 0,
        }
      : {
          configured: false,
          accountUid: null,
          roleArn: null,
          externalIdFingerprint: null,
          status: null,
          capabilities: [],
          verifiedAt: null,
          lastErrorCode: null,
          canRotate: true,
        },
    domainState: profileRows[0]
      ? {
          domain: profileRows[0].normalizedAsciiDomain ?? profileRows[0].domain,
          displayDomain:
            profileRows[0].unicodeDisplayDomain ?? profileRows[0].domain,
          revision: profileRows[0].domainRevision,
          registrar: profileRows[0].registrar,
          providerAccountUid: profileRows[0].providerAccountUid,
          expiresAt: profileRows[0].domainExpiresAt?.toISOString() ?? null,
          realNameStatus: profileRows[0].domainRealNameStatus,
          emailStatus: profileRows[0].domainEmailStatus,
          clientHold: profileRows[0].domainClientHold,
          ownershipStatus: profileRows[0].domainOwnershipStatus,
          dnsStatus: profileRows[0].dnsStatus,
          autoRenewDesired: profileRows[0].autoRenewDesired,
          autoRenewObserved: profileRows[0].autoRenewObserved,
          icpStatus: profileRows[0].icpStatus,
          icpDomainRevision: profileRows[0].icpDomainRevision,
          icpVerifiedAt: profileRows[0].icpVerifiedAt?.toISOString() ?? null,
        }
      : null,
    domainOperations: domainOperationRows.map(
      (row: typeof siteDomainOperations.$inferSelect) => ({
        id: row.id,
        kind: row.kind,
        domain: row.domainAscii,
        displayDomain: row.domainUnicode,
        status: row.status,
        quoteHash: row.quoteHash,
        quoteExpiresAt: row.quoteExpiresAt?.toISOString() ?? null,
        amountMinor: row.amountMinor,
        currency: row.currency,
        years: row.years,
        maskedRegistrantName: row.maskedRegistrantName,
        searchResult: (() => {
          const check = (row.providerResult as Record<string, unknown> | null)
            ?.check as Record<string, unknown> | undefined;
          return check && typeof check.available === "boolean"
            ? {
                available: check.available,
                premium: check.premium === true,
                reason: typeof check.reason === "string" ? check.reason : null,
              }
            : null;
        })(),
        registrantProfiles: (() => {
          const profiles = (
            row.providerResult as Record<string, unknown> | null
          )?.availableRegistrantProfiles;
          if (!Array.isArray(profiles)) return [];
          return profiles
            .filter((item): item is Record<string, unknown> =>
              Boolean(item && typeof item === "object"),
            )
            .map((item) => ({
              profileId: String(item.profileId ?? ""),
              holderType: ["individual", "enterprise"].includes(
                String(item.holderType),
              )
                ? (String(item.holderType) as "individual" | "enterprise")
                : ("unknown" as const),
              maskedName: String(item.maskedName ?? "***").slice(0, 255),
              realNameVerified: item.realNameVerified === true,
              emailVerified: item.emailVerified === true,
              isDefault: item.isDefault === true,
            }))
            .filter((item) => /^\d{1,191}$/u.test(item.profileId))
            .slice(0, 100);
        })(),
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    dnsPlan:
      latestDnsPlanRow &&
      typeof latestDnsPlanResult?.domain === "string" &&
      typeof latestDnsPlanResult.revision === "number" &&
      typeof latestDnsPlanResult.planHash === "string" &&
      typeof latestDnsPlanResult.providerSnapshotHash === "string"
        ? {
            operationId: latestDnsPlanRow.id,
            domain: latestDnsPlanResult.domain,
            domainRevision: latestDnsPlanResult.revision,
            planHash: latestDnsPlanResult.planHash,
            providerSnapshotHash: latestDnsPlanResult.providerSnapshotHash,
            canApply: latestDnsPlanResult.canApply === true,
            status:
              latestDnsPlanRow.status === "succeeded"
                ? ("succeeded" as const)
                : ("attention_required" as const),
            items: dnsPlanItems
              .filter((item): item is Record<string, unknown> =>
                Boolean(item && typeof item === "object"),
              )
              .map((item) => {
                const current =
                  item.current && typeof item.current === "object"
                    ? (item.current as Record<string, unknown>)
                    : null;
                return {
                  id: String(item.id ?? ""),
                  action: String(item.action ?? ""),
                  rr: String(item.rr ?? ""),
                  type: String(item.type ?? ""),
                  expectedValue: String(item.expectedValue ?? ""),
                  expectedTtl: Number(item.expectedTtl ?? 0),
                  currentValue:
                    typeof current?.value === "string" ? current.value : null,
                  currentTtl:
                    typeof current?.ttl === "number" ? current.ttl : null,
                  reason: typeof item.reason === "string" ? item.reason : null,
                };
              }),
            createdAt: latestDnsPlanRow.createdAt.toISOString(),
          }
        : null,
    project: {
      id: input.project.id,
      conversationId: input.project.conversationId,
      currentKnowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
      primaryLanguage: input.project.primaryLanguage,
      canonicalHostname: input.project.canonicalHostname,
      status: input.project.status,
      revision: input.project.revision,
      updatedAt: input.project.updatedAt.toISOString(),
    },
    brief: (() => {
      const parsed = siteBriefSchema.safeParse(input.project.brief);
      return parsed.success ? parsed.data : null;
    })(),
    knowledgeSnapshots: snapshotRows
      .filter(
        (row: typeof knowledgeBaseSnapshots.$inferSelect) =>
          typeof row.archiveHash === "string" &&
          /^[a-f0-9]{64}$/u.test(row.archiveHash),
      )
      .map((row: typeof knowledgeBaseSnapshots.$inferSelect) => ({
        id: row.id,
        label: `v${row.version} · ${row.sourceFileName}`,
        archiveSha256: row.archiveHash!,
        sourceProfile: null,
        createdAt: row.createdAt.toISOString(),
        active: row.id === input.project.currentKnowledgeSnapshotId,
      })),
    messages: messagesProjected,
    visualCandidates: candidateRows.map(
      (row: typeof websiteStyleSamples.$inferSelect) => ({
        id: row.id,
        label: row.label,
        title: row.note?.trim() || `视觉方向 ${row.label}`,
        previewUrl: `/api/site-ops/style-previews/${row.id}`,
        note: row.note,
        score: Number(row.sourceMetadata?.score ?? 0),
        selected: buildRows.some(
          (build: typeof siteBuilds.$inferSelect) =>
            build.styleSampleId === row.id &&
            !["cancelled", "superseded"].includes(build.status),
        ),
      }),
    ),
    builds: buildRows.map((row: typeof siteBuilds.$inferSelect) => ({
      id: row.id,
      parentBuildId: row.parentBuildId,
      ordinal: row.ordinal,
      status: row.status,
      previewUrl: row.distLocalAssetId
        ? `/api/site-ops/builds/${row.id}/preview/`
        : null,
      sourceUrl: row.sourceLocalAssetId
        ? `/api/site-ops/builds/${row.id}/source`
        : null,
      qaUrl: row.qaLocalAssetId ? `/api/site-ops/builds/${row.id}/qa` : null,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    deployments: deploymentRows.map(
      (row: typeof siteDeployments.$inferSelect) => ({
        id: row.id,
        buildId: row.buildId,
        target: row.target,
        publicUrl: row.publicUrl,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    socialPackages: packageRows.map(
      (row: typeof socialPackages.$inferSelect) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        archiveUrl: row.archiveLocalAssetId
          ? `/api/site-ops/social-packages/${row.id}/archive`
          : null,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    resetCapability,
    interactionState:
      input.project.status === "draft"
        ? ("select_snapshot" as const)
        : input.project.status,
    latestSequence: Math.max(
      input.afterSequence ?? 0,
      ...messagesProjected.map((row: { sequence: number }) => row.sequence),
    ),
  };
  return siteOpsObservationV1Schema.parse(observation);
}

export async function openSiteOps(actor: AuthenticatedUser) {
  assertEnabled();
  assertCustomer(actor);
  await requireSiteOpsEntitlement(actor.id);
  const db = await requireDb();
  const project = await db.transaction(async (tx: any) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1)
      .for("update");
    const existing = await loadOwnedProject(tx, actor.id, undefined, true);
    if (existing) return existing;

    const projectId = randomUUID();
    const conversationId = `siteops:${actor.id}`;
    await tx.insert(conversations).values({
      id: conversationId,
      userId: actor.id,
      title: "官网任务与AI建站",
      status: "awaiting_input",
      version: 1,
    });
    await tx.insert(siteProjects).values({
      id: projectId,
      userId: actor.id,
      conversationId,
      status: "draft",
      revision: 1,
    });
    await appendMessage(tx, {
      conversationId,
      userId: actor.id,
      role: "assistant",
      content:
        "请选择一个已完成的知识库 ZIP 版本。我会先核对公司资料，只询问真正缺失且会影响官网的内容。",
      siteOps: {
        kind: "brief_question",
        subjectId: projectId,
        revision: 1,
        status: "active",
        payload: { requested: "knowledge_snapshot" },
      },
    });
    const inserted = await loadOwnedProject(tx, actor.id, conversationId);
    if (!inserted) throw new Error("SITEOPS_PROJECT_INSERT_FAILED");
    return inserted;
  });
  return projectObservation(db, { userId: actor.id, project });
}

export async function observeSiteOps(actor: AuthenticatedUser, value: unknown) {
  assertEnabled();
  assertCustomer(actor);
  await requireSiteOpsEntitlement(actor.id);
  const input = siteOpsObserveInputSchema.parse(value);
  const db = await requireDb();
  const project = await loadOwnedProject(db, actor.id, input.conversationId);
  if (!project) {
    throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
  }
  return projectObservation(db, {
    userId: actor.id,
    project,
    afterSequence: input.afterSequence,
  });
}

function translateAliyunConnectionError(error: unknown): never {
  if (error instanceof SiteOpsServiceError) throw error;
  if (error instanceof AliyunProviderError) {
    const notFound = error.code === "NOT_FOUND";
    const invalid = [
      "INVALID_DOMAIN",
      "ACCOUNT_ROLE_MISMATCH",
      "CALLER_ACCOUNT_MISMATCH",
    ].includes(error.code);
    throw new SiteOpsServiceError(
      invalid ? "INVALID_INPUT" : notFound ? "NOT_FOUND" : "STATE_CONFLICT",
      error.message,
      invalid ? 400 : notFound ? 404 : 409,
    );
  }
  throw error;
}

async function requireOwnedAliyunProject(
  actor: AuthenticatedUser,
  conversationId: string,
) {
  assertEnabled();
  assertCustomer(actor);
  await requireSiteOpsEntitlement(actor.id);
  const db = await requireDb();
  const project = await loadOwnedProject(db, actor.id, conversationId);
  if (!project) {
    throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
  }
  return project;
}

export async function getSiteOpsAliyunConnection(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    const status = await getAliyunCustomerConnectionStatus({
      projectId: project.id,
      userId: actor.id,
    });
    return {
      ...status,
      verifiedAt: status.verifiedAt
        ? new Date(status.verifiedAt).toISOString()
        : null,
    };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function setupSiteOpsAliyunConnection(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionSetupInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    const result = await setupAliyunCustomerConnection({
      projectId: project.id,
      userId: actor.id,
      accountUid: input.accountUid,
      roleArn: input.roleArn,
    });
    const trustedPrincipalArn =
      process.env.FRONTMIND_ALIYUN_ROLE_PRINCIPAL_ARN?.trim() || null;
    return {
      ...result,
      trustedPrincipalArn,
      trustPolicy: trustedPrincipalArn
        ? {
            Version: "1",
            Statement: [
              {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { RAM: [trustedPrincipalArn] },
                Condition: {
                  StringEquals: { "sts:ExternalId": result.externalId },
                },
              },
            ],
          }
        : null,
      requiredPermissions: ALIYUN_CUSTOMER_ROLE_PERMISSIONS,
      permissionPolicy: {
        Version: "1",
        Statement: [
          {
            Action: Object.values(ALIYUN_CUSTOMER_ROLE_PERMISSIONS).flat(),
            Effect: "Allow",
            Resource: ["*"],
          },
        ],
      },
    };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function verifySiteOpsAliyunConnection(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    return await verifyAliyunCustomerConnection({
      projectId: project.id,
      userId: actor.id,
    });
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function disconnectSiteOpsAliyunConnection(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    return await disconnectAliyunCustomerConnection({
      projectId: project.id,
      userId: actor.id,
    });
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function sendSiteOpsMessage(
  actor: AuthenticatedUser,
  value: unknown,
) {
  assertEnabled();
  assertCustomer(actor);
  const entitlement = await requireSiteOpsEntitlement(actor.id);
  const input = siteOpsSendMessageInputSchema.parse(value);
  const request = {
    action: "brief_message",
    text: input.text,
    localAssetIds: [...input.localAssetIds].sort(),
  } as const;
  const requestHash = hashSiteOpsRequest(request);
  const db = await requireDb();
  await db.transaction(async (tx: any) => {
    const project = await loadOwnedProject(
      tx,
      actor.id,
      input.conversationId,
      true,
    );
    if (!project) {
      throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
    }
    const existing = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (isSiteOpsOperationReplay(existing[0], requestHash)) return;
    if (project.revision !== input.expectedProjectRevision) {
      throw new SiteOpsServiceError(
        "REVISION_CONFLICT",
        "建站项目已更新，请刷新后重试。",
        409,
      );
    }
    if (input.localAssetIds.length > 0) {
      // File ownership is verified by the upload/download subsystem. SiteOps v1
      // does not copy arbitrary bytes into the build contract from chat input.
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "当前建站会话暂不接受游离附件，请先更新知识库 ZIP。",
        400,
      );
    }
    const turnId = randomUUID();
    await tx.insert(conversationTurns).values({
      id: turnId,
      conversationId: project.conversationId,
      userId: actor.id,
      clientRequestId: input.clientRequestId,
      operationKey: `siteops:${hashSiteOpsRequest({
        projectId: project.id,
        clientRequestId: input.clientRequestId,
      })}`,
      operationType: "site_ops",
      expectedRevision: input.expectedProjectRevision,
      requestHash,
      status: "completed",
      completedAt: new Date(),
      metadata: { executionKind: "site_ops" },
    });
    if (
      project.currentBuildId &&
      [
        "preview_ready",
        "approved",
        "live",
        "failed",
        "attention_required",
      ].includes(project.status)
    ) {
      await handleRevision(tx, {
        actor,
        project,
        entitlement,
        turnId,
        requestId: input.clientRequestId,
        requestHash,
        payload: {
          buildId: project.currentBuildId,
          feedback: input.text,
        },
      });
      return;
    }
    const operationId = randomUUID();
    await tx.insert(siteOperations).values({
      id: operationId,
      projectId: project.id,
      userId: actor.id,
      conversationTurnId: turnId,
      kind: "brief_message",
      status: "succeeded",
      clientRequestId: input.clientRequestId,
      inputHash: requestHash,
      input: request,
      completedAt: new Date(),
    });
    await appendMessage(tx, {
      conversationId: project.conversationId,
      userId: actor.id,
      role: "user",
      content: input.text,
      turnId,
    });
    const existingBrief = siteBriefSchema.safeParse(project.brief);
    const nextBrief =
      project.status === "collecting_brief" && existingBrief.success
        ? mergeCustomerBriefMessage(existingBrief.data, input.text)
        : project.brief;
    if (project.status === "collecting_brief" && existingBrief.success) {
      await appendMessage(tx, {
        conversationId: project.conversationId,
        userId: actor.id,
        role: "assistant",
        content:
          "已把你明确补充的转化目标、受众或联系方式合并到 SiteBrief；知识库中的既有事实与来源保持不变。准备好后可以开始检索视觉方向。",
        turnId,
        siteOps: {
          kind: "brief_question",
          subjectId: project.id,
          revision: project.revision + 1,
          status: "active",
          payload: { updated: true },
        },
      });
    }
    await tx
      .update(siteProjects)
      .set({
        status:
          project.status === "draft" ? "collecting_brief" : project.status,
        brief: nextBrief,
        revision: project.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteProjects.id, project.id),
          eq(siteProjects.revision, project.revision),
        ),
      );
  });
  return observeSiteOps(actor, { conversationId: input.conversationId });
}

export function parseSiteOpsActionPayload(
  action: SiteOpsActInput["action"],
  raw: unknown,
) {
  switch (action) {
    case "reset_workflow":
      return z
        .object({ confirmed: z.literal(true) })
        .strict()
        .parse(raw);
    case "select_snapshot":
    case "change_snapshot":
      return z.object({ knowledgeSnapshotId: uuidSchema }).strict().parse(raw);
    case "start_visual_search":
    case "reselect_visual":
    case "dns_plan":
      return z.object({}).strict().parse(raw);
    case "select_visual":
      return z.object({ sampleId: uuidSchema }).strict().parse(raw);
    case "delegate_visual":
      // The public observation intentionally does not expose the internal
      // batch id. The server resolves the newest active board for this
      // project and then makes the deterministic highest-score choice.
      return z.object({}).strict().parse(raw);
    case "approve_build":
      return z.object({ buildId: uuidSchema }).strict().parse(raw);
    case "request_revision":
      return z
        .object({
          buildId: uuidSchema,
          feedback: z.string().trim().min(1).max(20_000),
        })
        .strict()
        .parse(raw);
    case "publish_global":
    case "publish_mainland":
      return z
        .object({
          buildId: uuidSchema,
          expectedHeadDeploymentId: optionalUuidSchema,
        })
        .strict()
        .parse(raw);
    case "rollback":
      return z.object({ deploymentId: uuidSchema }).strict().parse(raw);
    case "create_wechat_package":
    case "create_xiaohongshu_package":
      return z
        .object({ topic: z.string().trim().min(1).max(500).optional() })
        .strict()
        .parse(raw);
    case "domain_search":
      return normalizeSiteOpsDomain(
        z.object({ domain: domainSchema }).strict().parse(raw).domain,
      );
    case "domain_sync": {
      const parsed = z
        .object({
          domain: domainSchema,
          typedDomain: domainSchema,
          customerConfirmed: z.literal(true),
        })
        .strict()
        .parse(raw);
      const domain = normalizeSiteOpsDomain(parsed.domain);
      const typed = normalizeSiteOpsDomain(parsed.typedDomain);
      if (domain.domain !== typed.domain) {
        throw new SiteOpsServiceError(
          "INVALID_INPUT",
          "必须完整输入并确认要接入的已有域名。",
          400,
        );
      }
      return {
        ...domain,
        typedDomain: typed.domain,
        customerConfirmed: true as const,
      };
    }
    case "domain_prepare_purchase": {
      const parsed = z
        .object({
          domain: domainSchema,
          years: z.number().int().min(1).max(10),
          registrantProfileId: z
            .string()
            .trim()
            .regex(/^\d{1,191}$/)
            .optional(),
        })
        .strict()
        .parse(raw);
      return {
        ...normalizeSiteOpsDomain(parsed.domain),
        years: parsed.years,
        ...(parsed.registrantProfileId
          ? { registrantProfileId: parsed.registrantProfileId }
          : {}),
      };
    }
    case "domain_prepare_renewal": {
      const parsed = z
        .object({
          domain: domainSchema,
          years: z.number().int().min(1).max(10),
        })
        .strict()
        .parse(raw);
      return { ...normalizeSiteOpsDomain(parsed.domain), years: parsed.years };
    }
    case "domain_confirm_purchase":
    case "domain_confirm_renewal": {
      const parsed = z
        .object({
          domain: domainSchema,
          typedDomain: domainSchema,
          quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
          domainOperationId: uuidSchema,
        })
        .strict()
        .parse(raw);
      const domain = normalizeSiteOpsDomain(parsed.domain);
      const typed = normalizeSiteOpsDomain(parsed.typedDomain);
      if (domain.domain !== typed.domain) {
        throw new SiteOpsServiceError(
          "INVALID_INPUT",
          "必须完整输入所确认的域名。",
          400,
        );
      }
      return {
        ...domain,
        typedDomain: typed.domain,
        quoteHash: parsed.quoteHash,
        domainOperationId: parsed.domainOperationId,
      };
    }
    case "domain_set_auto_renew": {
      const parsed = z
        .object({
          domain: domainSchema,
          enabled: z.boolean(),
          customerConfirmed: z.literal(true),
        })
        .strict()
        .parse(raw);
      return {
        ...normalizeSiteOpsDomain(parsed.domain),
        enabled: parsed.enabled,
        customerConfirmed: parsed.customerConfirmed,
      };
    }
    case "dns_apply":
      return z
        .object({
          domainRevision: z.number().int().positive(),
          planOperationId: uuidSchema,
          planHash: z.string().regex(/^[a-f0-9]{64}$/),
          providerSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(raw);
    case "dns_rollback":
      return z
        .object({ domainRevision: z.number().int().positive() })
        .strict()
        .parse(raw);
  }
}

async function ensureActiveProviderCredential(
  tx: any,
  slot: "website" | "site_builder_21st",
) {
  const rows = await tx
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
  const row = rows[0];
  if (!row) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      slot === "site_builder_21st"
        ? "系统管理员尚未配置有效的 21st API Key。"
        : "系统管理员尚未配置有效的官网任务 API Key。",
      412,
    );
  }
  return row;
}

export async function resolvePinnedTwentyFirstCredentialForBatch(
  tx: any,
  input: {
    engineerNote: string | null;
    projectId: string;
    userId: number;
    knowledgeSnapshotId: string;
  },
) {
  const operationId = input.engineerNote?.startsWith(
    TWENTY_FIRST_OPERATION_MARKER_PREFIX,
  )
    ? input.engineerNote.slice(TWENTY_FIRST_OPERATION_MARKER_PREFIX.length)
    : "";
  if (!uuidSchema.safeParse(operationId).success) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉批次缺少可核验的 21st 检索凭据来源。",
      409,
    );
  }
  const operationRows = await tx
    .select({ input: siteOperations.input })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.id, operationId),
        eq(siteOperations.projectId, input.projectId),
        eq(siteOperations.userId, input.userId),
        eq(siteOperations.kind, "visual_search"),
        eq(siteOperations.provider, "21st"),
        eq(siteOperations.status, "succeeded"),
      ),
    )
    .limit(1);
  const frozen = visualSearchOperationInputV1Schema.safeParse(
    operationRows[0]?.input,
  );
  if (
    !frozen.success ||
    frozen.data.knowledgeSnapshotId !== input.knowledgeSnapshotId
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉批次与当前知识库或检索凭据不一致，请重新检索。",
      409,
    );
  }
  assertCurrentVisualWorkflowVersion(frozen.data.workflowVersion);
  const credentialRows = await tx
    .select({
      id: presalesApiCredentials.id,
      version: presalesApiCredentials.version,
    })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, frozen.data.credentialId),
        eq(presalesApiCredentials.slot, "site_builder_21st"),
      ),
    )
    .limit(1);
  const credential = credentialRows[0];
  if (!credential || credential.version !== frozen.data.credentialVersion) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉检索固定的 21st 凭据版本记录不存在。",
      409,
    );
  }
  return credential;
}

export function assertCurrentVisualWorkflowVersion(workflowVersion: string) {
  if (workflowVersion !== SITEOPS_WORKFLOW.frontMindVersion) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉检索使用的建站合同已升级，请重新检索视觉方向后再继续。",
      409,
    );
  }
}

export function createVisualSearchOperationInput(
  input: VisualSearchOperationInputV1,
) {
  return visualSearchOperationInputV1Schema.parse(input);
}

async function createActionTurn(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    requestId: string;
    requestHash: string;
    action: SiteOpsActInput["action"];
  },
) {
  const turnId = randomUUID();
  await tx.insert(conversationTurns).values({
    id: turnId,
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    clientRequestId: input.requestId,
    operationKey: `siteops:${hashSiteOpsRequest({
      projectId: input.project.id,
      clientRequestId: input.requestId,
    })}`,
    operationType: "site_ops",
    expectedRevision: input.project.revision,
    requestHash: input.requestHash,
    status: "completed",
    completedAt: new Date(),
    metadata: { executionKind: "site_ops", action: input.action },
  });
  return turnId;
}

async function reserveOperation(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    clientRequestId: string;
    requestHash: string;
    payload: Record<string, unknown>;
    kind: typeof siteOperations.$inferInsert.kind;
    buildId?: string;
    status?: typeof siteOperations.$inferInsert.status;
    provider?: string;
  },
) {
  const id = randomUUID();
  await tx.insert(siteOperations).values({
    id,
    projectId: input.project.id,
    userId: input.actor.id,
    conversationTurnId: input.turnId,
    buildId: input.buildId,
    kind: input.kind,
    status: input.status ?? "queued",
    clientRequestId: input.clientRequestId,
    inputHash: input.requestHash,
    input: input.payload,
    provider: input.provider,
    completedAt: input.status === "succeeded" ? new Date() : undefined,
  });
  return id;
}

async function handleResetWorkflow(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { confirmed: true };
  },
) {
  const nonterminalOperationRows = await tx
    .select({
      id: siteOperations.id,
      kind: siteOperations.kind,
      status: siteOperations.status,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        inArray(siteOperations.status, [
          "queued",
          "running",
          "outcome_unknown",
        ]),
      ),
    )
    .for("update");
  const buildRows = await tx
    .select({ id: siteBuilds.id })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
      ),
    )
    .limit(1)
    .for("update");
  const deploymentRows = await tx
    .select({ id: siteDeployments.id })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, input.project.id),
        eq(siteDeployments.userId, input.actor.id),
      ),
    )
    .limit(1)
    .for("update");
  const activeDnsRows = await tx
    .select({ id: siteDnsRecords.id })
    .from(siteDnsRecords)
    .where(
      and(
        eq(siteDnsRecords.projectId, input.project.id),
        eq(siteDnsRecords.userId, input.actor.id),
        inArray(siteDnsRecords.status, [
          "applying",
          "propagating",
          "outcome_unknown",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  const unresolvedFinancialRows = await tx
    .select({ id: siteDomainOperations.id })
    .from(siteDomainOperations)
    .where(
      and(
        eq(siteDomainOperations.projectId, input.project.id),
        eq(siteDomainOperations.userId, input.actor.id),
        isNotNull(siteDomainOperations.activeFinancialKey),
      ),
    )
    .limit(1)
    .for("update");

  const resetCapability = siteOpsResetCapability({
    projectStatus: input.project.status,
    currentBuild: Boolean(input.project.currentBuildId),
    liveHead: Boolean(
      input.project.globalLiveDeploymentId ||
        input.project.mainlandLiveDeploymentId,
    ),
    hasBuild: buildRows.length > 0,
    hasDeployment: deploymentRows.length > 0,
    hasBlockingOperation: nonterminalOperationRows.some(
      (row: { kind: string; status: string }) =>
        row.status !== "queued" || row.kind !== "visual_search",
    ),
    hasActiveDns: activeDnsRows.length > 0,
    hasUnresolvedFinancialIntent: unresolvedFinancialRows.length > 0,
  });
  if (!resetCapability.allowed) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      resetCapability.reason,
      409,
    );
  }

  const now = new Date();
  await tx
    .update(siteOperations)
    .set({
      status: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        eq(siteOperations.kind, "visual_search"),
        eq(siteOperations.status, "queued"),
      ),
    );
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  await tx
    .update(messages)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(messages.conversationId, input.project.conversationId),
        eq(messages.userId, input.actor.id),
        isNull(messages.deletedAt),
      ),
    );
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: { action: "reset_workflow", confirmed: input.payload.confirmed },
    kind: "brief_message",
    status: "succeeded",
  });
  const nextRevision = input.project.revision + 1;
  await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: null,
      currentBuildId: null,
      brief: null,
      status: "draft",
      revision: nextRevision,
      updatedAt: now,
    })
    .where(
      and(
        eq(siteProjects.id, input.project.id),
        eq(siteProjects.revision, input.project.revision),
      ),
    );
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      "已重置 AI 建站流程。请先全新上传知识库 ZIP，或选择一个已完成的知识库版本；旧任务不会恢复或续跑。",
    siteOps: {
      kind: "brief_question",
      subjectId: input.project.id,
      revision: nextRevision,
      status: "active",
      payload: { requested: "knowledge_snapshot", reset: true },
    },
  });
}

const IN_FLIGHT_DEPLOYMENT_STATUSES = [
  "reserved",
  "deploying",
  "verifying",
] as const;

const NONTERMINAL_BUILD_STATUSES = [
  "preparing",
  "visual_searching",
  "awaiting_visual_selection",
  "design_compiling",
  "contract_ready",
  "building",
  "qa_running",
] as const;

export function assertSiteOpsSnapshotChangeState(input: {
  sameSnapshot: boolean;
  activeBuild: boolean;
  activeDeployment: boolean;
  activeVisualSearch: boolean;
}) {
  if (input.sameSnapshot) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选知识库已经是当前版本。",
      409,
    );
  }
  if (input.activeBuild || input.activeDeployment || input.activeVisualSearch) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前仍有视觉检索、建站或发布任务在运行；完成后才能更换知识源。",
      409,
    );
  }
}

/**
 * The project row is already locked by actOnSiteOps. Locking the matching
 * deployment row as well makes admission explicit and prevents a second
 * request for the same target from reserving another ESA side effect. An
 * identical clientRequestId is replayed before reaching this boundary.
 */
export async function assertSiteOpsDeploymentTargetAvailable(
  tx: any,
  input: {
    projectId: string;
    target: "global_excluding_cn" | "mainland_cn";
  },
) {
  const rows = await tx
    .select({
      id: siteDeployments.id,
      buildId: siteDeployments.buildId,
      intent: siteDeployments.intent,
      status: siteDeployments.status,
    })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, input.projectId),
        inArray(siteDeployments.status, IN_FLIGHT_DEPLOYMENT_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  if (rows[0]) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      `当前 canonical hostname 已有${rows[0].intent === "rollback" ? "回滚" : "发布"}任务正在${rows[0].status === "verifying" ? "验活" : "处理"}；大陆与海外模式互斥，不能同时进入 ${input.target}。`,
      409,
    );
  }
}

async function handleSelectSnapshot(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { knowledgeSnapshotId: string };
  },
) {
  if (
    input.project.status !== "draft" ||
    input.project.currentKnowledgeSnapshotId
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "知识库版本已经冻结；更换知识源必须从当前版本创建新的建站版本。",
      409,
    );
  }
  const rows = await tx
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.payload.knowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, input.actor.id),
        eq(knowledgeBaseSnapshots.status, "active"),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new SiteOpsServiceError(
      "NOT_FOUND",
      "所选知识库 ZIP 版本不存在或不可用。",
      404,
    );
  }
  const brief = siteBriefFromSnapshot(rows[0]);
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: input.payload,
    kind: "brief_message",
    status: "succeeded",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: `已选择知识库 ZIP 版本：v${rows[0].version}`,
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      "知识库版本已锁定。接下来会基于其中可核验的公司资料整理 SiteBrief；未确认的信息不会被编造成官网事实。",
    siteOps: {
      kind: "brief_question",
      subjectId: input.project.id,
      revision: input.project.revision + 1,
      status: "active",
      payload: { knowledgeSnapshotId: rows[0].id },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: rows[0].id,
      brief,
      primaryLanguage: brief.primaryLanguage,
      status: "collecting_brief",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleChangeSnapshot(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { knowledgeSnapshotId: string };
  },
) {
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "首次选择知识库请使用当前的知识库选择入口。",
      409,
    );
  }
  const activeBuildRows = await tx
    .select({ id: siteBuilds.id })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        inArray(siteBuilds.status, NONTERMINAL_BUILD_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const activeDeploymentRows = await tx
    .select({ id: siteDeployments.id })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, input.project.id),
        inArray(siteDeployments.status, IN_FLIGHT_DEPLOYMENT_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const activeVisualRows = await tx
    .select({ id: siteOperations.id })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.kind, "visual_search"),
        inArray(siteOperations.status, [
          "queued",
          "running",
          "outcome_unknown",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  assertSiteOpsSnapshotChangeState({
    sameSnapshot:
      input.project.currentKnowledgeSnapshotId ===
      input.payload.knowledgeSnapshotId,
    activeBuild: activeBuildRows.length > 0,
    activeDeployment: activeDeploymentRows.length > 0,
    activeVisualSearch: activeVisualRows.length > 0,
  });
  const snapshotRows = await tx
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.payload.knowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, input.actor.id),
        eq(knowledgeBaseSnapshots.status, "active"),
      ),
    )
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot?.archiveHash) {
    throw new SiteOpsServiceError(
      "NOT_FOUND",
      "所选知识库 ZIP 版本不存在、已归档或缺少已验证哈希。",
      404,
    );
  }
  const brief = siteBriefFromSnapshot(snapshot);
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      ...input.payload,
      previousKnowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
      parentBuildId: input.project.currentBuildId,
    },
    kind: "brief_message",
    status: "succeeded",
  });
  // A completed but unselected board belongs to the previous snapshot and may
  // no longer be acted upon. Selected batches remain historical provenance for
  // their immutable builds.
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: `已将知识源更换为知识库 ZIP v${snapshot.version}。`,
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      "新的知识库快照已冻结并重新生成 SiteBrief。旧官网版本、源码、预览和线上版本保持不变；完成资料核对与新视觉选择后会创建它的子版本。",
    siteOps: {
      kind: "brief_question",
      subjectId: input.project.id,
      revision: input.project.revision + 1,
      status: "active",
      payload: {
        knowledgeSnapshotId: snapshot.id,
        previousKnowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
      },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: snapshot.id,
      brief,
      primaryLanguage: brief.primaryLanguage,
      status: "collecting_brief",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(siteProjects.id, input.project.id),
        eq(siteProjects.revision, input.project.revision),
      ),
    );
}

async function handleVisualSearch(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: Record<string, unknown>;
    reselect?: boolean;
  },
) {
  const allowedStatuses = input.reselect
    ? ["preview_ready", "approved", "live", "failed", "attention_required"]
    : ["collecting_brief"];
  if (!allowedStatuses.includes(input.project.status)) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      input.reselect
        ? "当前建站任务尚未结束，不能并行重新检索视觉方向。"
        : "当前阶段不能开始视觉检索。",
      409,
    );
  }
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先选择知识库 ZIP 版本。",
      409,
    );
  }
  const brief = siteBriefSchema.safeParse(input.project.brief);
  if (
    !brief.success ||
    brief.data.verifiedFacts.length === 0 ||
    brief.data.routes.some((route) => route.sourceDocumentIds.length === 0)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前知识库没有足够的可公开事实与来源，需先补齐知识库后再检索视觉方向。",
      409,
    );
  }
  const credential = await ensureActiveProviderCredential(
    tx,
    "site_builder_21st",
  );
  const operationPayload = createVisualSearchOperationInput({
    knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
    credentialId: credential.id,
    credentialVersion: credential.version,
    workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: operationPayload,
    kind: "visual_search",
    provider: "21st",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: input.reselect
      ? "正在重新检索真实视觉参考；当前预览与线上版本会保持不变。"
      : "正在检索真实视觉参考，完成后会一次展示最多 9 个 A–I 候选。",
    siteOps: {
      kind: "build_progress",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { stage: "visual_searching", targets: [18, 12, 9] },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      status: "visual_searching",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

async function selectVisualSample(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    sampleId?: string;
    batchId?: string;
    delegated: boolean;
  },
) {
  if (input.project.status !== "awaiting_visual_selection") {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前阶段不能再次选择视觉方向；需要重选时请先创建新的视觉检索。",
      409,
    );
  }
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先选择知识库 ZIP 版本。",
      409,
    );
  }
  const activeBuildRows = await tx
    .select({ id: siteBuilds.id })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        inArray(siteBuilds.status, [
          "preparing",
          "visual_searching",
          "awaiting_visual_selection",
          "design_compiling",
          "contract_ready",
          "building",
          "qa_running",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  if (activeBuildRows[0]) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前已有建站任务在运行，不能并行创建第二个根版本。",
      409,
    );
  }
  let batchId = input.batchId;
  if (input.delegated && !batchId) {
    const batchRows = await tx
      .select({ id: websiteStyleSampleBatches.id })
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.userId, input.actor.id),
          eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.status, "published"),
        ),
      )
      .orderBy(desc(websiteStyleSampleBatches.publishedAt))
      .limit(1);
    batchId = batchRows[0]?.id;
  }
  const sampleRows = await tx
    .select({ sample: websiteStyleSamples, batch: websiteStyleSampleBatches })
    .from(websiteStyleSamples)
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        input.sampleId
          ? eq(websiteStyleSamples.id, input.sampleId)
          : eq(websiteStyleSamples.batchId, batchId!),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  if (sampleRows.length < 1 || sampleRows.length > 9) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉候选尚未准备完成，请刷新后重试。",
      409,
    );
  }
  const selected = input.delegated
    ? [...sampleRows].sort(
        (left, right) =>
          Number(right.sample.sourceMetadata?.score ?? 0) -
          Number(left.sample.sourceMetadata?.score ?? 0),
      )[0]
    : sampleRows[0];
  if (
    !selected?.sample.previewLocalAssetId ||
    !selected.sample.sourceMetadata
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉参考缺少受控预览或来源证明。",
      409,
    );
  }
  const selectedMetadata = selected.sample.sourceMetadata;
  const selectedEvidence = visualEvidenceV1Schema.safeParse(
    selectedMetadata.visualEvidence,
  );
  if (
    !selectedEvidence.success ||
    selectedMetadata.providerItemKey !==
      selectedEvidence.data.providerItemKey ||
    createVisualEvidenceV1({
      evidenceKind: selectedEvidence.data.evidenceKind,
      providerItemKey: selectedEvidence.data.providerItemKey,
      metadataSha256: selectedEvidence.data.metadataSha256,
      providerResponseSha256: selectedEvidence.data.providerResponseSha256,
      previewSha256: selectedEvidence.data.previewSha256,
      taxonomyDerivationVersion:
        selectedEvidence.data.taxonomyDerivationVersion,
    }).evidenceSha256 !== selectedEvidence.data.evidenceSha256
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉参考的冻结证据无法通过校验，请重新检索后选择。",
      409,
    );
  }
  const snapshotRows = await tx
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.project.currentKnowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, input.actor.id),
      ),
    )
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot?.archiveHash) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "知识库 ZIP 缺少已验证的归档哈希，不能开始构建。",
      409,
    );
  }
  const credential = await resolvePinnedTwentyFirstCredentialForBatch(tx, {
    engineerNote: selected.batch.engineerNote,
    projectId: input.project.id,
    userId: input.actor.id,
    knowledgeSnapshotId: snapshot.id,
  });
  const manusCredential = await ensureActiveProviderCredential(tx, "website");
  const ordinalRows = await tx
    .select({ ordinal: max(siteBuilds.ordinal) })
    .from(siteBuilds)
    .where(eq(siteBuilds.projectId, input.project.id));
  const buildId = randomUUID();
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "selected", updatedAt: new Date() })
    .where(
      and(
        eq(websiteStyleSampleBatches.id, selected.batch.id),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  await tx.insert(siteBuilds).values({
    id: buildId,
    projectId: input.project.id,
    userId: input.actor.id,
    parentBuildId: input.project.currentBuildId,
    knowledgeSnapshotId: snapshot.id,
    knowledgeArchiveHash: snapshot.archiveHash,
    ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
    workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
    workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
    workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
    workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
    starterVersion: SITEOPS_WORKFLOW.starterVersion,
    twentyFirstCredentialId: credential.id,
    twentyFirstCredentialVersion: credential.version,
    styleSampleId: selected.sample.id,
    styleRevision: input.project.revision,
    brief: input.project.brief ?? {},
    selectionHash:
      selected.batch.selectionBundleHash ??
      hashSiteOpsRequest(selected.sample.sourceMetadata),
    status: "preparing",
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      buildId,
      styleSampleId: selected.sample.id,
      delegated: input.delegated,
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      manusCredentialId: manusCredential.id,
      manusCredentialVersion: manusCredential.version,
    },
    kind: "site_build",
    buildId,
    provider: "manus",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: input.delegated
      ? `已委托 AI 选择最高分视觉方向：${selected.sample.label}`
      : `已选择视觉方向：${selected.sample.label}`,
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "视觉方向已锁定，建站任务将自动继续，不需要第二次风格确认。",
    siteOps: {
      kind: "build_progress",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { stage: "preparing", buildId },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      currentBuildId: buildId,
      status: "building",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleApproveBuild(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { buildId: string };
  },
) {
  const rows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, input.payload.buildId),
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
      ),
    )
    .limit(1)
    .for("update");
  if (!rows[0]) {
    throw new SiteOpsServiceError("NOT_FOUND", "官网版本不存在。", 404);
  }
  if (rows[0].status !== "preview_ready") {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "只有已通过 QA 的私有预览才能批准。",
      409,
    );
  }
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: input.payload,
    kind: "brief_message",
    buildId: rows[0].id,
    status: "succeeded",
  });
  const now = new Date();
  await tx
    .update(siteBuilds)
    .set({ status: "approved", approvedAt: now, updatedAt: now })
    .where(eq(siteBuilds.id, rows[0].id));
  await tx
    .update(siteProjects)
    .set({
      currentBuildId: rows[0].id,
      status: "approved",
      revision: input.project.revision + 1,
      updatedAt: now,
    })
    .where(eq(siteProjects.id, input.project.id));
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: "已批准当前官网预览。",
  });
}

async function handleRevision(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { buildId: string; feedback: string };
  },
) {
  const rows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, input.payload.buildId),
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
      ),
    )
    .limit(1)
    .for("update");
  const parent = rows[0];
  if (
    !parent ||
    !["preview_ready", "approved", "failed", "attention_required"].includes(
      parent.status,
    )
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "只能修改已生成的私有预览版本。",
      409,
    );
  }
  const manusCredential = await ensureActiveProviderCredential(tx, "website");
  const quotaPeriodId = await reserveSiteOpsDeliveryQuota(tx, {
    userId: input.actor.id,
    portal: input.entitlement,
    quotaPool: "website_content_publish",
  });
  const ordinalRows = await tx
    .select({ ordinal: max(siteBuilds.ordinal) })
    .from(siteBuilds)
    .where(eq(siteBuilds.projectId, input.project.id));
  const buildId = randomUUID();
  await tx.insert(siteBuilds).values({
    id: buildId,
    projectId: parent.projectId,
    userId: parent.userId,
    knowledgeSnapshotId: parent.knowledgeSnapshotId,
    knowledgeArchiveHash: parent.knowledgeArchiveHash,
    parentBuildId: parent.id,
    quotaPeriodId,
    quotaState: "reserved",
    ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
    workflowUpstreamVersion: parent.workflowUpstreamVersion,
    workflowUpstreamHash: parent.workflowUpstreamHash,
    workflowVersion: parent.workflowVersion,
    workflowPackageHash: parent.workflowPackageHash,
    starterVersion: parent.starterVersion,
    twentyFirstCredentialId: parent.twentyFirstCredentialId,
    twentyFirstCredentialVersion: parent.twentyFirstCredentialVersion,
    styleSampleId: parent.styleSampleId,
    styleRevision: parent.styleRevision,
    brief: parent.brief,
    selectionHash: parent.selectionHash,
    status: "preparing",
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      ...input.payload,
      childBuildId: buildId,
      manusCredentialId: manusCredential.id,
      manusCredentialVersion: manusCredential.version,
    },
    kind: "build_revision",
    buildId,
    provider: "manus",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: input.payload.feedback,
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "已保留原版本并创建新的修改版本。",
    siteOps: {
      kind: "build_progress",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { stage: "revision", buildId, parentBuildId: parent.id },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      currentBuildId: buildId,
      status: "building",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

async function handlePublish(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { buildId: string; expectedHeadDeploymentId?: string };
    target: "global_excluding_cn" | "mainland_cn";
  },
) {
  requireEsaRuntimeConfigured();
  const [buildRows, profileRows] = await Promise.all([
    tx
      .select()
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.id, input.payload.buildId),
          eq(siteBuilds.projectId, input.project.id),
          eq(siteBuilds.userId, input.actor.id),
        ),
      )
      .limit(1),
    tx
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.actor.id))
      .limit(1),
  ]);
  const build = buildRows[0];
  const profile = profileRows[0];
  if (
    !build ||
    build.status !== "approved" ||
    !build.distLocalAssetId ||
    !build.distHash
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "只有已批准且具有固定 dist 摘要的版本才能发布。",
      409,
    );
  }
  if (
    !profile ||
    profile.domainStatus !== "completed" ||
    profile.domainOwnershipStatus !== "verified" ||
    profile.dnsStatus !== "active" ||
    !profile.normalizedAsciiDomain
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "域名所有权、DNS 或 TLS 尚未完成验证。",
      409,
    );
  }
  if (
    input.target === "mainland_cn" &&
    !isSiteOpsIcpApprovedForCurrentDomain(profile)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "大陆发布需要当前域名版本已通过 ICP 备案。",
      409,
    );
  }
  const currentHead =
    input.target === "mainland_cn"
      ? input.project.mainlandLiveDeploymentId
      : input.project.globalLiveDeploymentId;
  if ((input.payload.expectedHeadDeploymentId ?? null) !== currentHead) {
    throw new SiteOpsServiceError(
      "REVISION_CONFLICT",
      "线上版本已变化，请刷新后重试。",
      409,
    );
  }
  await assertSiteOpsDeploymentTargetAvailable(tx, {
    projectId: input.project.id,
    target: input.target,
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: { ...input.payload, target: input.target },
    kind: "deploy",
    buildId: build.id,
    provider: "aliyun_esa",
  });
  const deploymentId = randomUUID();
  await tx.insert(siteDeployments).values({
    id: deploymentId,
    projectId: input.project.id,
    userId: input.actor.id,
    buildId: build.id,
    operationId,
    target: input.target,
    intent: "deploy",
    expectedHeadDeploymentId: currentHead,
    distLocalAssetId: build.distLocalAssetId,
    distHash: build.distHash,
    domainRevision: profile.domainRevision,
    status: "reserved",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "已锁定精确官网版本并提交发布任务。旧站会保留到新版本验证成功。",
    siteOps: {
      kind: "release_status",
      subjectId: deploymentId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { target: input.target, status: "reserved" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleRollback(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { deploymentId: string };
  },
) {
  requireEsaRuntimeConfigured();
  const rows = await tx
    .select()
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.id, input.payload.deploymentId),
        eq(siteDeployments.projectId, input.project.id),
        eq(siteDeployments.userId, input.actor.id),
        inArray(siteDeployments.status, ["active", "superseded"]),
      ),
    )
    .limit(1);
  const targetDeployment = rows[0];
  if (!targetDeployment) {
    throw new SiteOpsServiceError(
      "NOT_FOUND",
      "可回滚的历史发布版本不存在。",
      404,
    );
  }
  const currentHead =
    targetDeployment.target === "mainland_cn"
      ? input.project.mainlandLiveDeploymentId
      : input.project.globalLiveDeploymentId;
  if (currentHead === targetDeployment.id) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选版本已经是当前线上版本。",
      409,
    );
  }
  const profileRows = await tx
    .select()
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, input.actor.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile || profile.domainRevision !== targetDeployment.domainRevision) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "历史版本属于不同的域名版本，不能直接回滚。",
      409,
    );
  }
  if (
    targetDeployment.target === "mainland_cn" &&
    (profile.icpStatus !== "approved" ||
      !profile.icpNumber ||
      profile.icpDomainRevision !== profile.domainRevision)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "大陆回滚仍需要当前域名版本已通过 ICP 备案。",
      409,
    );
  }
  await assertSiteOpsDeploymentTargetAvailable(tx, {
    projectId: input.project.id,
    target: targetDeployment.target,
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      targetDeploymentId: targetDeployment.id,
      expectedHeadDeploymentId: currentHead,
      target: targetDeployment.target,
    },
    kind: "rollback",
    buildId: targetDeployment.buildId,
    provider: "aliyun_esa",
  });
  const deploymentId = randomUUID();
  await tx.insert(siteDeployments).values({
    id: deploymentId,
    projectId: input.project.id,
    userId: input.actor.id,
    buildId: targetDeployment.buildId,
    operationId,
    target: targetDeployment.target,
    intent: "rollback",
    rollbackOfDeploymentId: targetDeployment.id,
    expectedHeadDeploymentId: currentHead,
    distLocalAssetId: targetDeployment.distLocalAssetId,
    distHash: targetDeployment.distHash,
    domainRevision: targetDeployment.domainRevision,
    status: "reserved",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "已锁定历史 dist 摘要并提交回滚；验证失败时当前线上版本保持不变。",
    siteOps: {
      kind: "release_status",
      subjectId: deploymentId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { target: targetDeployment.target, status: "reserved" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleSocialPackage(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { topic?: string };
    channel: "wechat" | "xiaohongshu";
  },
) {
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先选择知识库 ZIP 版本。",
      409,
    );
  }
  const manusCredential = await ensureActiveProviderCredential(tx, "website");
  const quotaPeriodId = await reserveSiteOpsDeliveryQuota(tx, {
    userId: input.actor.id,
    portal: input.entitlement,
    quotaPool: "content_asset_publish",
  });
  const packageId = randomUUID();
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      ...input.payload,
      channel: input.channel,
      packageId,
      manusCredentialId: manusCredential.id,
      manusCredentialVersion: manusCredential.version,
    },
    kind: "social_package",
    provider: "manus",
  });
  await tx.insert(socialPackages).values({
    id: packageId,
    projectId: input.project.id,
    userId: input.actor.id,
    knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
    operationId,
    quotaPeriodId,
    quotaState: "reserved",
    channel: input.channel,
    status: "queued",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      input.channel === "wechat"
        ? "微信公众号内容包已进入生成队列。"
        : "小红书 01–09 内容包已进入生成队列。",
    siteOps: {
      kind: "social_package",
      subjectId: packageId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { channel: input.channel, status: "queued" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function requireAliyunConnection(tx: any, projectId: string) {
  const rows = await tx
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, projectId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
        eq(siteProviderConnections.status, "active"),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "客户尚未连接有效的阿里云 RAM Role。",
      412,
    );
  }
  if (
    process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() !== "1" ||
    (!siteOpsProviderConfigured("aliyun_domain") &&
      !siteOpsProviderConfigured("aliyun_alidns"))
  ) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "阿里云域名适配器尚未配置，未提交任何域名或 DNS 操作。",
      412,
    );
  }
  return rows[0];
}

async function handleProviderOperation(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    action: SiteOpsActInput["action"];
    payload: Record<string, unknown>;
  },
) {
  const connection = await requireAliyunConnection(tx, input.project.id);
  let esaDnsPreparation: {
    prepareDomainBinding: true;
    domain: string;
    domainRevision: number;
  } | null = null;
  if (input.action === "dns_plan") {
    const profiles = await tx
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.actor.id))
      .limit(1);
    const profile = profiles[0];
    if (
      !profile?.normalizedAsciiDomain ||
      profile.domainStatus !== "completed" ||
      profile.domainOwnershipStatus !== "verified"
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "请先完成当前域名版本的购买或所有权验证。",
        409,
      );
    }
    const cnameRows = await tx
      .select({ id: siteDnsRecords.id })
      .from(siteDnsRecords)
      .where(
        and(
          eq(siteDnsRecords.projectId, input.project.id),
          eq(siteDnsRecords.userId, input.actor.id),
          eq(siteDnsRecords.domainRevision, profile.domainRevision),
          eq(siteDnsRecords.recordType, "CNAME"),
        ),
      )
      .limit(1);
    if (cnameRows.length === 0) {
      requireEsaRuntimeConfigured();
      esaDnsPreparation = {
        prepareDomainBinding: true,
        domain: profile.normalizedAsciiDomain,
        domainRevision: profile.domainRevision,
      };
    }
  }
  let referencedQuote: typeof siteDomainOperations.$inferSelect | null = null;
  if (
    input.action === "domain_confirm_purchase" ||
    input.action === "domain_confirm_renewal"
  ) {
    const referenceId = String(input.payload.domainOperationId ?? "");
    const references = await tx
      .select()
      .from(siteDomainOperations)
      .where(
        and(
          eq(siteDomainOperations.id, referenceId),
          eq(siteDomainOperations.projectId, input.project.id),
          eq(siteDomainOperations.userId, input.actor.id),
          eq(siteDomainOperations.connectionId, connection.id),
        ),
      )
      .limit(1);
    referencedQuote = references[0] ?? null;
    const referencedQuotePayload = (
      referencedQuote?.providerResult as Record<string, unknown> | null
    )?.quote as Record<string, unknown> | undefined;
    const expectedKind =
      input.action === "domain_confirm_purchase" ? "purchase" : "renewal";
    if (
      !referencedQuote ||
      referencedQuote.kind !== expectedKind ||
      !(
        ["quoted", "succeeded"].includes(referencedQuote.status) ||
        (referencedQuote.status === "attention_required" &&
          referencedQuote.errorCode === "QUOTE_CHANGED")
      ) ||
      referencedQuote.domainAscii !== input.payload.domain ||
      referencedQuote.quoteHash !== input.payload.quoteHash ||
      referencedQuotePayload?.quoteHash !== input.payload.quoteHash ||
      referencedQuotePayload?.domain !== input.payload.domain ||
      referencedQuotePayload?.accountUid !== connection.accountUid ||
      !referencedQuote.quoteExpiresAt ||
      referencedQuote.quoteExpiresAt.getTime() <= Date.now()
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "该精确报价不存在、已过期或已变化，请重新获取报价后确认。",
        409,
      );
    }
  }
  if (input.action === "dns_apply") {
    const planOperationId = String(input.payload.planOperationId ?? "");
    const planRows = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.id, planOperationId),
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.actor.id),
          eq(siteOperations.kind, "dns_apply"),
          eq(siteOperations.provider, "aliyun_alidns"),
          eq(siteOperations.status, "succeeded"),
        ),
      )
      .limit(1);
    const planOperation = planRows[0];
    const planInput = planOperation?.input as
      | Record<string, unknown>
      | undefined;
    const planResult = planOperation?.result as
      | Record<string, unknown>
      | undefined;
    const currentProfiles = await tx
      .select({
        domain: workspaceSiteProfiles.normalizedAsciiDomain,
        revision: workspaceSiteProfiles.domainRevision,
      })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.actor.id))
      .limit(1);
    const currentProfile = currentProfiles[0];
    if (
      !planOperation ||
      planInput?.dnsIntent !== "plan" ||
      planInput.connectionId !== connection.id ||
      planResult?.canApply !== true ||
      planResult?.revision !== input.payload.domainRevision ||
      currentProfile?.revision !== input.payload.domainRevision ||
      currentProfile?.domain !== planResult?.domain ||
      planResult?.planHash !== input.payload.planHash ||
      planResult?.providerSnapshotHash !== input.payload.providerSnapshotHash
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "DNS 应用必须引用当前项目同一域名版本的可执行精确计划，请重新规划。",
        409,
      );
    }
  }
  const kind = input.action.startsWith("dns_")
    ? input.action === "dns_rollback"
      ? "dns_rollback"
      : "dns_apply"
    : input.action.includes("purchase")
      ? "domain_purchase"
      : input.action.includes("renewal")
        ? "domain_renewal"
        : input.action.includes("auto_renew")
          ? "domain_auto_renew"
          : "domain_search";
  const financialIntentKind =
    input.action === "domain_confirm_purchase"
      ? ("purchase" as const)
      : input.action === "domain_confirm_renewal"
        ? ("renewal" as const)
        : null;
  const activeFinancialKey = financialIntentKind
    ? siteOpsActiveFinancialIntentKey({
        projectId: input.project.id,
        accountUid: connection.accountUid,
        domain: String(input.payload.domain ?? ""),
        kind: financialIntentKind,
      })
    : null;
  if (activeFinancialKey) {
    const activeRows = await tx
      .select({ id: siteDomainOperations.id })
      .from(siteDomainOperations)
      .where(eq(siteDomainOperations.activeFinancialKey, activeFinancialKey))
      .limit(1);
    if (activeRows.length > 0) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "该客户账号与域名已有同类型财务操作正在提交或对账，请等待其得到确定结果。",
        409,
      );
    }
  }
  const domainLedgerId = input.action.startsWith("dns_") ? null : randomUUID();
  const providerPayload = {
    ...(esaDnsPreparation ?? input.payload),
    connectionId: connection.id,
    ...(input.action === "domain_sync" ? { domainIntent: "sync" } : {}),
    ...(!esaDnsPreparation && input.action.startsWith("dns_")
      ? {
          dnsIntent:
            input.action === "dns_plan"
              ? "plan"
              : input.action === "dns_rollback"
                ? "rollback"
                : "apply",
        }
      : {}),
    ...(domainLedgerId ? { domainLedgerId } : {}),
  };
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: providerPayload,
    kind,
    provider: esaDnsPreparation
      ? "aliyun_esa"
      : input.action.startsWith("dns_")
        ? "aliyun_alidns"
        : "aliyun_domain",
  });
  if (!input.action.startsWith("dns_")) {
    const domain = String(input.payload.domain ?? "").toLowerCase();
    const domainKind = input.action.includes("purchase")
      ? "purchase"
      : input.action.includes("renewal")
        ? "renewal"
        : input.action.includes("auto_renew")
          ? input.payload.enabled === false
            ? "cancel_auto_renew"
            : "set_auto_renew"
          : input.action === "domain_sync"
            ? "sync"
            : "search";
    await tx.insert(siteDomainOperations).values({
      id: domainLedgerId!,
      projectId: input.project.id,
      userId: input.actor.id,
      connectionId: connection.id,
      operationId,
      kind: domainKind,
      domainAscii: domain,
      domainUnicode:
        typeof input.payload.domainUnicode === "string"
          ? input.payload.domainUnicode
          : domain,
      clientRequestId: input.requestId,
      requestFingerprint: input.requestHash,
      customerConfirmedAt:
        input.action.includes("confirm") ||
        input.action === "domain_set_auto_renew" ||
        input.action === "domain_sync"
          ? new Date()
          : undefined,
      customerConfirmationHash:
        input.action.includes("confirm") ||
        input.action === "domain_set_auto_renew" ||
        input.action === "domain_sync"
          ? input.requestHash
          : undefined,
      activeFinancialKey,
      status: "reserved",
    });
    if (referencedQuote) {
      await tx
        .update(siteDomainOperations)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(siteDomainOperations.id, referencedQuote.id),
            inArray(siteDomainOperations.status, [
              "quoted",
              "succeeded",
              "attention_required",
            ]),
          ),
        );
    }
  }
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      "操作已按请求指纹锁定，worker 只会提交一次并在结果不确定时转为查询对账。",
    siteOps: {
      kind: input.action.startsWith("dns_") ? "domain_status" : "domain_status",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { action: input.action, status: "reserved" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

export async function actOnSiteOps(actor: AuthenticatedUser, value: unknown) {
  assertEnabled();
  assertCustomer(actor);
  const entitlement = await requireSiteOpsEntitlement(actor.id);
  const input = siteOpsActInputSchema.parse(value);
  const payload = parseSiteOpsActionPayload(
    input.action,
    input.input,
  ) as Record<string, unknown>;
  const requestHash = hashSiteOpsRequest({ action: input.action, payload });
  const db = await requireDb();
  await db.transaction(async (tx: any) => {
    const project = await loadOwnedProject(
      tx,
      actor.id,
      input.conversationId,
      true,
    );
    if (!project) {
      throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
    }
    const existing = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (isSiteOpsOperationReplay(existing[0], requestHash)) return;
    if (project.revision !== input.expectedRevision) {
      throw new SiteOpsServiceError(
        "REVISION_CONFLICT",
        "建站项目已更新，请刷新后重试。",
        409,
      );
    }
    if (input.messageId) {
      const cardMessages = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.conversationId, project.conversationId),
            eq(messages.userId, actor.id),
          ),
        )
        .limit(1);
      const siteOps = cardMessages[0]?.metadata?.siteOps as
        | Record<string, unknown>
        | undefined;
      if (
        !siteOps ||
        (input.cardKind && siteOps.kind !== input.cardKind) ||
        Number(siteOps.revision) !== input.expectedRevision ||
        siteOps.status !== "active"
      ) {
        throw new SiteOpsServiceError(
          "REVISION_CONFLICT",
          "该操作卡片已过期，请刷新后重试。",
          409,
        );
      }
    }
    const turnId = await createActionTurn(tx, {
      actor,
      project,
      requestId: input.clientRequestId,
      requestHash,
      action: input.action,
    });
    const common = {
      actor,
      project,
      entitlement,
      turnId,
      requestId: input.clientRequestId,
      requestHash,
    };
    switch (input.action) {
      case "reset_workflow":
        await handleResetWorkflow(tx, {
          ...common,
          payload: payload as { confirmed: true },
        });
        break;
      case "select_snapshot":
        await handleSelectSnapshot(tx, {
          ...common,
          payload: payload as { knowledgeSnapshotId: string },
        });
        break;
      case "change_snapshot":
        await handleChangeSnapshot(tx, {
          ...common,
          payload: payload as { knowledgeSnapshotId: string },
        });
        break;
      case "start_visual_search":
        await handleVisualSearch(tx, { ...common, payload });
        break;
      case "reselect_visual":
        await handleVisualSearch(tx, {
          ...common,
          payload,
          reselect: true,
        });
        break;
      case "select_visual":
        await selectVisualSample(tx, {
          ...common,
          sampleId: String(payload.sampleId),
          delegated: false,
        });
        break;
      case "delegate_visual":
        await selectVisualSample(tx, {
          ...common,
          delegated: true,
        });
        break;
      case "approve_build":
        await handleApproveBuild(tx, {
          ...common,
          payload: payload as { buildId: string },
        });
        break;
      case "request_revision":
        await handleRevision(tx, {
          ...common,
          payload: payload as { buildId: string; feedback: string },
        });
        break;
      case "publish_global":
      case "publish_mainland":
        await handlePublish(tx, {
          ...common,
          payload: payload as {
            buildId: string;
            expectedHeadDeploymentId?: string;
          },
          target:
            input.action === "publish_mainland"
              ? "mainland_cn"
              : "global_excluding_cn",
        });
        break;
      case "create_wechat_package":
      case "create_xiaohongshu_package":
        await handleSocialPackage(tx, {
          ...common,
          payload: payload as { topic?: string },
          channel:
            input.action === "create_wechat_package" ? "wechat" : "xiaohongshu",
        });
        break;
      case "rollback":
        await handleRollback(tx, {
          ...common,
          payload: payload as { deploymentId: string },
        });
        break;
      default:
        await handleProviderOperation(tx, {
          ...common,
          action: input.action,
          payload,
        });
    }
  });
  return observeSiteOps(actor, { conversationId: input.conversationId });
}
