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
  apiCredentials,
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
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL,
  siteBriefSchema,
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsObserveInputSchema,
  siteOpsSendMessageInputSchema,
  visualEvidenceV1Schema,
  type SiteOpsActInput,
  type SiteBrief,
} from "../../shared/siteops";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "../../shared/siteops-branding";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import {
  siteOpsObservationV1Schema,
  type SiteOpsExecutionStep,
} from "../../shared/siteops-contract";
import {
  referenceBlueprintForVisualCandidate,
  referenceBlueprintSchema,
  referenceBlueprintV3Schema,
  referenceBlueprintV4Schema,
  type ReferenceBlueprint,
} from "../../shared/siteops-design";
import {
  visualSearchOperationInputV1Schema,
  type VisualSearchOperationInputV1,
} from "../../shared/siteops-workflow";
import {
  managedAgentProfileSchema,
  normalizeManagedAgentProfile,
  type ManagedAgentProfile,
} from "../../shared/manus-agent-profile";
import {
  AuthServiceError,
  getDecryptedCredentialForUser,
  type AuthenticatedUser,
} from "../auth-service";
import { getDb } from "../db";
import { ManusV2Client } from "../manus-v2-client";
import { getPresalesCredentialById } from "../presales-service";
import { getServicePortal } from "../service-entitlement";
import { siteOpsProviderConfigured } from "./providers";
import {
  AliyunProviderError,
  bindAliyunCustomerAccountFromOAuth,
  disconnectAliyunCustomerConnection,
  getAliyunCustomerConnectionStatus,
  getAliyunCustomerRoleAuthorizationPackage,
  verifyAliyunCustomerConnection,
} from "./aliyun-provider";
import {
  ALIYUN_OAUTH_CREDENTIAL_SLOT,
  createAliyunOAuthAuthorization,
  getActiveAliyunBrokerCredential,
} from "./aliyun-platform-service";
import { inspectEsaRuntimeConfiguration } from "./esa-config";
import {
  publicSiteOpsDomainIssue,
  publicSiteOpsMessageText,
  sanitizeFrontMindPublicText,
} from "./public-errors";
import { terminalTaskState } from "./task-terminal-state";
import {
  assertSiteOpsServiceEntitlement,
  reserveSiteOpsQuota,
  siteOpsQuotaPeriodIds,
  SiteOpsQuotaError,
} from "./quota-service";
import {
  createSiteOpsRebuildTicket,
  loadSiteOpsRebuildRequest,
  SiteOpsRebuildTicketError,
} from "./rebuild-ticket";

export type SiteOpsServiceErrorCode =
  | "CREDENTIAL_ROTATED"
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

export function siteOpsServiceErrorFromQuota(error: SiteOpsQuotaError) {
  return new SiteOpsServiceError(
    error.code === "SITEOPS_ENTITLEMENT_REQUIRED"
      ? "FORBIDDEN"
      : "STATE_CONFLICT",
    error.message,
    error.statusCode,
  );
}

export function requireAcceptedSiteOpsRebuild(input: {
  acceptedForCurrentCycle: boolean;
}) {
  if (!input.acceptedForCurrentCycle) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先提交官网重制需求并等待 FrontMind 通过重置。",
      409,
    );
  }
}

export function currentSiteOpsBuildWorkflowCoordinates() {
  return {
    workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
    workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
    workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
    workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
    starterVersion: SITEOPS_WORKFLOW.starterVersion,
  } as const;
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
      throw siteOpsServiceErrorFromQuota(error);
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
      throw siteOpsServiceErrorFromQuota(error);
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

const GENERIC_SITE_IDENTITY =
  /^(?:企业与品牌概览|品牌概览|公司介绍|企业介绍|关于我们|产品与服务|首页|知识库|企业概览)$/u;

function siteIdentityCandidate(value: unknown) {
  const candidate = compactKnowledgeText(value, 255)
    .replace(/^[\s「」『』“”"']+|[\s「」『』“”"']+$/gu, "")
    .replace(/(?:知识库|knowledge[\s_-]*base)$/iu, "")
    .trim();
  if (
    candidate.length < 2 ||
    candidate.length > 80 ||
    GENERIC_SITE_IDENTITY.test(candidate)
  ) {
    return "";
  }
  return candidate;
}

function companyIdentityFromPublicDocuments(
  documents: Array<
    (typeof knowledgeBaseSnapshots.$inferSelect)["documents"][number]
  >,
  sourceFileName: string,
) {
  const contents = documents.map((document) =>
    document.content.slice(0, 100_000),
  );
  const firstMatch = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      for (const content of contents) {
        const candidate = siteIdentityCandidate(content.match(pattern)?.[1]);
        if (candidate) return candidate;
      }
    }
    return "";
  };

  const publicBrand = firstMatch([
    /(?:对外品牌|品牌名称|品牌名)\s*[:：为是]\s*[「『“"']?([^「」『』“”"'\n，。；;]{2,80})/u,
    /(?:以|使用)\s*[「『“"']([^」』”"']{2,80})[」』”"']\s*(?:为|作为)\s*(?:对外)?品牌/u,
    /(?:以|使用)\s*([\p{L}\p{N}·&（）()\- ]{2,80})\s*(?:为|作为)\s*(?:对外)?品牌/u,
  ]);
  if (publicBrand) return { companyName: publicBrand, unresolved: false };

  const legalName = firstMatch([
    /(?:公司名称|企业名称)\s*[:：为是]\s*[「『“"']?([^「」『』“”"'\n，。；;]{2,80})/u,
  ]);
  if (legalName) return { companyName: legalName, unresolved: false };

  const introductoryName = firstMatch([
    /(?:^|[。！？\n])\s*([\p{L}\p{N}·&（）()\-]{2,80})\s*是一家[^。！？\n]{0,180}(?:公司|企业)/u,
  ]);
  if (introductoryName) {
    return { companyName: introductoryName, unresolved: false };
  }

  for (const document of documents) {
    const title = siteIdentityCandidate(document.title);
    if (title) return { companyName: title, unresolved: false };
  }
  const fileName = siteIdentityCandidate(
    sourceFileName.replace(/\.(?:zip|md)$/iu, ""),
  );
  if (fileName) return { companyName: fileName, unresolved: false };
  return { companyName: "待确认企业名称", unresolved: true };
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
  const identity = companyIdentityFromPublicDocuments(
    publicDocuments,
    snapshot.sourceFileName,
  );
  const companyName = identity.companyName;
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
  const routeDocuments = (pattern: RegExp) =>
    publicDocuments.filter((document) =>
      pattern.test(
        `${document.branchTitle ?? ""} ${document.title} ${document.path}`,
      ),
    );
  const inventoryDocuments = {
    product: routeDocuments(/(?:产品|设备|软件|平台)/u),
    service: routeDocuments(/(?:服务|解决方案|业务)/u),
    application: routeDocuments(/(?:应用|场景|行业方案)/u),
    case_study: routeDocuments(/(?:案例|客户故事|实践)/u),
    blog: routeDocuments(/(?:博客|知识|科普|指南|洞察|白皮书)/u),
    company_news: routeDocuments(
      /(?:企业新闻|公司新闻|企业动态|公司动态|新闻中心)/u,
    ),
    faq: routeDocuments(/(?:FAQ|常见问题|问答|Q&A)/iu),
  } as const;
  const contentInventory: SiteBrief["contentInventory"] = {
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    entries: Object.entries(inventoryDocuments).flatMap(([kind, documents]) =>
      documents.length > 0
        ? [
            {
              kind: kind as keyof typeof inventoryDocuments,
              sourceDocumentIds: [
                ...new Set(documents.slice(0, 100).map(idFor)),
              ],
            },
          ]
        : [],
    ),
  };
  const conditionalRoute = (input: {
    id: string;
    slug: string;
    title: string;
    documents: typeof publicDocuments;
  }): SiteBrief["routes"][number] | null =>
    input.documents.length > 0
      ? {
          id: input.id,
          slug: input.slug,
          title: input.title,
          sourceDocumentIds: input.documents.slice(0, 100).map(idFor),
        }
      : null;
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
  for (const route of [
    conditionalRoute({
      id: "products",
      slug: "/products",
      title: "产品",
      documents: inventoryDocuments.product,
    }),
    conditionalRoute({
      id: "services",
      slug: "/services",
      title: "服务",
      documents: inventoryDocuments.service,
    }),
    conditionalRoute({
      id: "applications",
      slug: "/applications",
      title: "应用场景",
      documents: inventoryDocuments.application,
    }),
    conditionalRoute({
      id: "cases",
      slug: "/cases",
      title: "案例",
      documents: inventoryDocuments.case_study,
    }),
    conditionalRoute({
      id: "blog",
      slug: "/blog",
      title: "知识库",
      documents: inventoryDocuments.blog,
    }),
    conditionalRoute({
      id: "faq",
      slug: "/faq",
      title: "常见问题",
      documents: inventoryDocuments.faq,
    }),
  ]) {
    if (route && !routes.some((existing) => existing.slug === route.slug)) {
      routes.push(route);
    }
  }
  // Enterprise news is the sole always-addressable collection. An empty
  // snapshot inventory renders the host-owned legal empty state; it never
  // authorizes the provider to browse for or synthesize industry news.
  routes.push({
    id: "news",
    slug: "/news",
    title: "企业动态",
    sourceDocumentIds: [...new Set(inventoryDocuments.company_news.map(idFor))],
  });
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
    contentInventory,
    routes,
    verifiedFacts,
    publicAssetIds,
    unknowns: [
      ...(identity.unresolved ? ["需要确认企业或品牌名称"] : []),
      ...(audience.length > 0 ? [] : ["需要进一步确认核心目标受众"]),
      ...(contacts.length > 0 ? [] : ["知识库中暂无可公开的已验证联系方式"]),
    ],
  });
}

export type VisualSearchReadiness =
  | { ready: true; brief: SiteBrief }
  | {
      ready: false;
      reason: "invalid_brief" | "no_public_facts" | "source_contract_mismatch";
      routeId?: string;
    };

/**
 * Validates the frozen SiteBrief immediately before visual-search reservation.
 * Company news is the only always-addressable collection with a legal empty
 * state: /news may have no sources only when the frozen inventory itself has
 * no company_news entry. Every other route remains source-bound.
 */
export function visualSearchReadiness(value: unknown): VisualSearchReadiness {
  const parsed = siteBriefSchema.safeParse(value);
  if (!parsed.success) {
    return { ready: false, reason: "invalid_brief" };
  }
  if (parsed.data.verifiedFacts.length === 0) {
    return { ready: false, reason: "no_public_facts" };
  }

  const hasCompanyNews = parsed.data.contentInventory.entries.some(
    (entry) => entry.kind === "company_news",
  );
  if (
    hasCompanyNews &&
    !parsed.data.routes.some(
      (route) => route.id === "news" && route.sourceDocumentIds.length > 0,
    )
  ) {
    return {
      ready: false,
      reason: "source_contract_mismatch",
      routeId: "news",
    };
  }
  const invalidRoute = parsed.data.routes.find((route) => {
    if (route.sourceDocumentIds.length > 0) return false;
    return !(route.id === "news" && route.slug === "/news" && !hasCompanyNews);
  });
  if (invalidRoute) {
    return {
      ready: false,
      reason: "source_contract_mismatch",
      routeId: invalidRoute.id,
    };
  }

  return { ready: true, brief: parsed.data };
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

const publicVisualFamilySchema = z.enum([
  "floating_orbit",
  "split_media",
  "editorial",
  "bento",
  "feature_grid",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "full_bleed_statement",
]);

function publicVisualMetadata(value: unknown) {
  const metadata =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const visualFamily = publicVisualFamilySchema.safeParse(metadata.heroFamily);
  return {
    providerTitle:
      typeof metadata.title === "string" ? metadata.title.trim() : "",
    visualFamily: visualFamily.success ? visualFamily.data : null,
  };
}

export function freezeSiteOpsReferenceBlueprint(input: {
  sampleId: string;
  previewLocalAssetId?: string | null;
  note: string | null;
  sourceMetadata: unknown;
}) {
  const metadata =
    input.sourceMetadata &&
    typeof input.sourceMetadata === "object" &&
    !Array.isArray(input.sourceMetadata)
      ? (input.sourceMetadata as Record<string, unknown>)
      : {};
  const evidence = visualEvidenceV1Schema.safeParse(metadata.visualEvidence);
  const frozenV4 = referenceBlueprintV4Schema.safeParse(
    metadata.referenceBlueprint,
  );
  const frozenV3 = referenceBlueprintV3Schema.safeParse(
    metadata.referenceBlueprint,
  );
  const heroEligibility = z
    .object({
      eligible: z.literal(true),
      variant: z.enum([
        "centered_statement",
        "split_media",
        "editorial_modular",
        "immersive_visual",
      ]),
    })
    .passthrough()
    .safeParse(metadata.heroEligibility);
  const evidenceIsValid =
    evidence.success &&
    metadata.providerItemKey === evidence.data.providerItemKey &&
    createVisualEvidenceV1({
      evidenceKind: evidence.data.evidenceKind,
      providerItemKey: evidence.data.providerItemKey,
      metadataSha256: evidence.data.metadataSha256,
      providerResponseSha256: evidence.data.providerResponseSha256,
      previewSha256: evidence.data.previewSha256,
      taxonomyDerivationVersion: evidence.data.taxonomyDerivationVersion,
    }).evidenceSha256 === evidence.data.evidenceSha256;
  const metadataRealizationPreviewLocalAssetId = z
    .string()
    .uuid()
    .safeParse(metadata.realizationPreviewLocalAssetId);
  const metadataRealizationPreviewSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .safeParse(metadata.realizationPreviewSha256);
  if (
    frozenV4.success &&
    evidence.success &&
    evidenceIsValid &&
    metadataRealizationPreviewLocalAssetId.success &&
    metadataRealizationPreviewSha256.success &&
    frozenV4.data.candidateId === input.sampleId &&
    frozenV4.data.providerItemKey === evidence.data.providerItemKey &&
    frozenV4.data.referencePreviewSha256 === evidence.data.previewSha256 &&
    (!input.previewLocalAssetId ||
      frozenV4.data.referencePreviewLocalAssetId ===
        input.previewLocalAssetId) &&
    frozenV4.data.previewLocalAssetId ===
      metadataRealizationPreviewLocalAssetId.data &&
    frozenV4.data.previewSha256 === metadataRealizationPreviewSha256.data
  ) {
    return frozenV4.data;
  }
  if (
    metadata.referenceBlueprint &&
    typeof metadata.referenceBlueprint === "object" &&
    !Array.isArray(metadata.referenceBlueprint) &&
    (metadata.referenceBlueprint as Record<string, unknown>).schemaVersion === 4
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉方案已失效，请重新生成视觉候选后选择。",
      409,
    );
  }
  if (
    frozenV3.success &&
    evidence.success &&
    evidenceIsValid &&
    frozenV3.data.candidateId === input.sampleId &&
    frozenV3.data.providerItemKey === evidence.data.providerItemKey &&
    frozenV3.data.previewSha256 === evidence.data.previewSha256 &&
    (!input.previewLocalAssetId ||
      frozenV3.data.previewLocalAssetId === input.previewLocalAssetId)
  ) {
    return frozenV3.data;
  }
  if (!evidence.success || !heroEligibility.success || !evidenceIsValid) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉方案已失效，请重新生成视觉候选后选择。",
      409,
    );
  }
  return referenceBlueprintForVisualCandidate({
    candidateId: input.sampleId,
    providerItemKey: evidence.data.providerItemKey,
    previewSha256: evidence.data.previewSha256,
    title: typeof metadata.title === "string" ? metadata.title : input.note,
    sourceUrl:
      typeof metadata.sourceUrl === "string" ? metadata.sourceUrl : null,
    heroEligibility: heroEligibility.data,
  });
}

export function referenceBlueprintForSiteOpsRevision(input: {
  parentWorkflowVersion: string;
  parentOperationInput: unknown;
  derivedReferenceBlueprint: ReferenceBlueprint;
}) {
  const operationInput =
    input.parentOperationInput &&
    typeof input.parentOperationInput === "object" &&
    !Array.isArray(input.parentOperationInput)
      ? (input.parentOperationInput as Record<string, unknown>)
      : null;
  const inherited = referenceBlueprintSchema.safeParse(
    operationInput?.referenceBlueprint,
  );
  const inheritedMatches =
    inherited.success &&
    inherited.data.candidateId ===
      input.derivedReferenceBlueprint.candidateId &&
    inherited.data.providerItemKey ===
      input.derivedReferenceBlueprint.providerItemKey &&
    inherited.data.previewSha256 ===
      input.derivedReferenceBlueprint.previewSha256 &&
    (inherited.data.schemaVersion !== 4 ||
      (input.derivedReferenceBlueprint.schemaVersion === 4 &&
        inherited.data.referencePreviewLocalAssetId ===
          input.derivedReferenceBlueprint.referencePreviewLocalAssetId &&
        inherited.data.referencePreviewSha256 ===
          input.derivedReferenceBlueprint.referencePreviewSha256 &&
        inherited.data.inspirationTaxonomySha256 ===
          input.derivedReferenceBlueprint.inspirationTaxonomySha256 &&
        inherited.data.styleSignature ===
          input.derivedReferenceBlueprint.styleSignature));
  if (input.parentWorkflowVersion.startsWith("2.") && !inheritedMatches) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网版本的冻结视觉构图合同不完整，不能静默改变视觉方向。",
      409,
    );
  }
  // A 2.x child inherits the exact immutable Blueprint, rather than running
  // its selection back through a mapping algorithm that may have evolved.
  // Legacy Astro parents have no Blueprint and are upgraded once from their
  // frozen selected visual evidence.
  return inherited.success && inheritedMatches
    ? inherited.data
    : input.derivedReferenceBlueprint;
}

export function siteOpsResetCapability(input: {
  projectStatus: string;
  currentBuild: boolean;
  liveHead: boolean;
  hasBuild: boolean;
  resettableFailedBuild?: boolean;
  hasDeployment: boolean;
  hasBlockingOperation: boolean;
  hasActiveDns: boolean;
  hasUnresolvedFinancialIntent: boolean;
}) {
  if (
    (input.currentBuild || input.hasBuild) &&
    input.resettableFailedBuild !== true
  ) {
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

export function isSiteOpsFailedBuildResettable(input: {
  ordinal: number;
  parentBuildId: string | null;
  status: string;
  upstreamManusTaskId: string | null;
  contractLocalAssetId: string | null;
  contractHash: string | null;
  sourceLocalAssetId: string | null;
  sourceHash: string | null;
  distLocalAssetId: string | null;
  distHash: string | null;
  qaLocalAssetId: string | null;
  provenanceLocalAssetId: string | null;
  approvedAt: Date | null;
  hasProviderTask: boolean;
  providerTaskStopped?: boolean;
}) {
  const providerTaskIsSafe = input.hasProviderTask
    ? input.providerTaskStopped === true && input.upstreamManusTaskId !== null
    : input.upstreamManusTaskId === null;
  return (
    input.ordinal >= 1 &&
    input.parentBuildId === null &&
    ["failed", "attention_required"].includes(input.status) &&
    providerTaskIsSafe &&
    input.contractLocalAssetId === null &&
    input.contractHash === null &&
    input.sourceLocalAssetId === null &&
    input.sourceHash === null &&
    input.distLocalAssetId === null &&
    input.distHash === null &&
    input.qaLocalAssetId === null &&
    input.provenanceLocalAssetId === null &&
    input.approvedAt === null
  );
}

type ResetProviderTaskPreflight = {
  buildId: string;
  providerTaskId: string;
  state: "stopped" | "not_stopped" | "unavailable";
};

export function siteOpsResetCredentialScope(
  value: unknown,
): "customer" | "legacy_presales" | null {
  if (value === "customer") return "customer";
  // Only operations written before credentialScope existed may use the
  // service-wide credential for read-only reset inspection.
  if (value === undefined) return "legacy_presales";
  return null;
}

export type SiteOpsResetProviderTaskInspector = (input: {
  actorId: number;
  providerTaskId: string;
  credentialId: string;
  credentialVersion: number;
  credentialScope: "customer" | "legacy_presales";
}) => Promise<"stopped" | "not_stopped" | "unavailable">;

export function isSiteOpsStoppedProviderTaskResetSafe(input: {
  buildId: string;
  buildProviderTaskId: string | null;
  operationProviderTaskIds: string[];
  operationStatuses: string[];
  preflight?: ResetProviderTaskPreflight | null;
}) {
  if (
    !input.buildProviderTaskId ||
    input.operationProviderTaskIds.length === 0 ||
    input.operationProviderTaskIds.some(
      (taskId) => taskId !== input.buildProviderTaskId,
    ) ||
    input.operationStatuses.some((status) =>
      ["queued", "running", "outcome_unknown"].includes(status),
    )
  ) {
    return false;
  }
  return Boolean(
    input.preflight?.state === "stopped" &&
      input.preflight.buildId === input.buildId &&
      input.preflight.providerTaskId === input.buildProviderTaskId,
  );
}

async function defaultResetProviderTaskInspector(input: {
  actorId: number;
  providerTaskId: string;
  credentialId: string;
  credentialVersion: number;
  credentialScope: "customer" | "legacy_presales";
}) {
  try {
    const credential =
      input.credentialScope === "customer"
        ? await getDecryptedCredentialForUser(input.actorId, input.credentialId)
        : await getPresalesCredentialById(input.credentialId);
    if (!credential || credential.version !== input.credentialVersion) {
      return "unavailable" as const;
    }
    const client = new ManusV2Client({
      baseUrl: process.env.MANUS_API_BASE_URL?.trim() || "https://api.manus.ai",
      apiKey: credential.apiKey,
      rateLimitScope: credential.id,
      timeoutMs: 30_000,
    });
    const detail = await client.taskDetail(input.providerTaskId);
    const terminal = terminalTaskState(detail.status);
    return terminal.completed || terminal.failed
      ? ("stopped" as const)
      : ("not_stopped" as const);
  } catch {
    return "unavailable" as const;
  }
}

async function prepareResetProviderTaskPreflight(
  db: any,
  input: {
    actorId: number;
    conversationId: string;
    inspect: SiteOpsResetProviderTaskInspector;
  },
): Promise<ResetProviderTaskPreflight | null> {
  const projectRows = await db
    .select({
      id: siteProjects.id,
      currentBuildId: siteProjects.currentBuildId,
    })
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.userId, input.actorId),
        eq(siteProjects.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  const project = projectRows[0];
  if (!project?.currentBuildId) return null;
  const buildRows = await db
    .select({
      id: siteBuilds.id,
      upstreamTaskId: siteBuilds.upstreamManusTaskId,
    })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, project.currentBuildId),
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, input.actorId),
      ),
    )
    .limit(1);
  const build = buildRows[0];
  if (!build?.upstreamTaskId) return null;
  const operationRows = await db
    .select({
      providerTaskId: siteOperations.providerTaskId,
      status: siteOperations.status,
      operationInput: siteOperations.input,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, project.id),
        eq(siteOperations.userId, input.actorId),
        eq(siteOperations.buildId, build.id),
        isNotNull(siteOperations.providerTaskId),
      ),
    )
    .orderBy(desc(siteOperations.createdAt))
    .limit(10);
  const matching = operationRows.filter(
    (row: { providerTaskId: string | null }) =>
      row.providerTaskId === build.upstreamTaskId,
  );
  if (
    matching.length === 0 ||
    operationRows.some(
      (row: { providerTaskId: string | null }) =>
        row.providerTaskId !== build.upstreamTaskId,
    ) ||
    matching.some((row: { status: string }) =>
      ["queued", "running", "outcome_unknown"].includes(row.status),
    )
  ) {
    return {
      buildId: build.id,
      providerTaskId: build.upstreamTaskId,
      state: "not_stopped",
    };
  }
  const frozen = (matching[0]?.operationInput ?? {}) as Record<string, unknown>;
  const credentialId =
    typeof frozen.manusCredentialId === "string"
      ? frozen.manusCredentialId
      : "";
  const credentialVersion = Number(frozen.manusCredentialVersion);
  const credentialScope = siteOpsResetCredentialScope(frozen.credentialScope);
  if (
    !credentialId ||
    !Number.isSafeInteger(credentialVersion) ||
    !credentialScope
  ) {
    return {
      buildId: build.id,
      providerTaskId: build.upstreamTaskId,
      state: "unavailable",
    };
  }
  return {
    buildId: build.id,
    providerTaskId: build.upstreamTaskId,
    state: await input.inspect({
      actorId: input.actorId,
      providerTaskId: build.upstreamTaskId,
      credentialId,
      credentialVersion,
      credentialScope,
    }),
  };
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

async function loadServiceReadiness(
  executor: any,
  input: { projectId: string; userId: number },
) {
  const [platformCredentials, aiBuilderCredentials, connections] =
    await Promise.all([
      executor
        .select({ slot: presalesApiCredentials.slot })
        .from(presalesApiCredentials)
        .where(
          and(
            inArray(presalesApiCredentials.slot, [
              "site_builder_21st",
              "siteops_aliyun_broker",
              "siteops_aliyun_oauth",
            ]),
            eq(presalesApiCredentials.status, "active"),
            eq(presalesApiCredentials.validationStatus, "verified"),
          ),
        ),
      executor
        .select({ id: apiCredentials.id })
        .from(apiCredentials)
        .where(
          and(
            eq(apiCredentials.userId, input.userId),
            eq(apiCredentials.status, "active"),
            eq(apiCredentials.validationStatus, "verified"),
            isNotNull(apiCredentials.verifiedAt),
            isNull(apiCredentials.deletedAt),
          ),
        )
        .orderBy(desc(apiCredentials.version))
        .limit(1),
      executor
        .select({ status: siteProviderConnections.status })
        .from(siteProviderConnections)
        .where(
          and(
            eq(siteProviderConnections.projectId, input.projectId),
            eq(siteProviderConnections.provider, "aliyun_cn"),
          ),
        )
        .limit(1),
    ]);
  const hasTwentyFirstCredential = platformCredentials.some(
    (row: { slot: string }) => row.slot === "site_builder_21st",
  );
  const hasAliyunBrokerCredential = platformCredentials.some(
    (row: { slot: string }) => row.slot === "siteops_aliyun_broker",
  );
  const hasAliyunOAuthCredential = platformCredentials.some(
    (row: { slot: string }) => row.slot === "siteops_aliyun_oauth",
  );
  const hasAiBuilderCredential = aiBuilderCredentials.length > 0;
  const aliyunFeatureEnabled =
    process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() === "1";
  const aliyunConnectionReady = connections[0]?.status === "active";
  const aliyunReady =
    aliyunFeatureEnabled &&
    hasAliyunBrokerCredential &&
    hasAliyunOAuthCredential &&
    aliyunConnectionReady;
  const esa = inspectEsaRuntimeConfiguration({
    providerRegistered: siteOpsProviderConfigured("aliyun_esa"),
  });
  return {
    visuals: {
      status: hasTwentyFirstCredential
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: hasTwentyFirstCredential
        ? undefined
        : "视觉候选服务尚未就绪，请联系 FrontMind",
    },
    website: {
      status: hasAiBuilderCredential
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: hasAiBuilderCredential
        ? undefined
        : "AI 建站服务尚未就绪，请联系 FrontMind",
    },
    publishing: {
      status: esa.configured
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: esa.configured
        ? undefined
        : sanitizeFrontMindPublicText(esa.reason),
    },
    domain: {
      status: aliyunReady
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: aliyunReady
        ? undefined
        : !aliyunFeatureEnabled
          ? "域名与发布服务尚未启用"
          : !hasAliyunBrokerCredential || !hasAliyunOAuthCredential
            ? "域名与发布平台尚未配置完成"
            : "请先完成阿里云账号授权",
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
      "发布服务尚未配置完成，请联系 FrontMind。",
      412,
    );
  }
}

const SITEOPS_EXECUTION_STAGE_LABELS = {
  visual_searching: "视觉候选搜索",
  preparing: "项目准备",
  design_compiling: "设计合同生成",
  content_building: "页面内容生成",
  qa_running: "质量校验",
  completed: "完成",
} as const;

type SiteOpsExecutionStage = keyof typeof SITEOPS_EXECUTION_STAGE_LABELS;

function publicExecutionStage(value: unknown): SiteOpsExecutionStage | null {
  if (value === "contract_ready" || value === "building") {
    return "content_building";
  }
  return [
    "visual_searching",
    "preparing",
    "design_compiling",
    "content_building",
    "qa_running",
    "completed",
  ].includes(String(value))
    ? (value as SiteOpsExecutionStage)
    : null;
}

function publicExecutionStatus(status: string) {
  if (status === "queued") return "queued" as const;
  if (status === "running" || status === "outcome_unknown") {
    return "running" as const;
  }
  if (status === "succeeded") return "succeeded" as const;
  if (status === "failed") return "failed" as const;
  if (status === "cancelled") return "cancelled" as const;
  return "attention_required" as const;
}

export function projectSiteOpsExecutionSteps(input: {
  operations: Array<{
    id: string;
    buildId: string | null;
    kind: string;
    status: string;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
  }>;
  timelineMessages: Array<{
    id: string;
    metadata: unknown;
    sentAt: Date;
  }>;
}): SiteOpsExecutionStep[] {
  const events = input.timelineMessages.flatMap((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const siteOps = (metadata.siteOps ?? {}) as Record<string, unknown>;
    const payload = (siteOps.payload ?? {}) as Record<string, unknown>;
    const stage = publicExecutionStage(payload.stage);
    return stage && typeof siteOps.subjectId === "string"
      ? [
          {
            id: row.id,
            operationId: siteOps.subjectId,
            buildId:
              typeof payload.buildId === "string" ? payload.buildId : null,
            stage,
            startedAt:
              typeof payload.occurredAt === "string" &&
              Number.isFinite(Date.parse(payload.occurredAt))
                ? new Date(payload.occurredAt)
                : row.sentAt,
          },
        ]
      : [];
  });
  return input.operations.flatMap((operation) => {
    if (
      !["visual_search", "site_build", "build_revision", "deploy"].includes(
        operation.kind,
      )
    ) {
      return [];
    }
    const operationKind = operation.kind as
      | "visual_search"
      | "site_build"
      | "build_revision"
      | "deploy";
    if (operationKind === "visual_search") {
      const startedAt = operation.startedAt ?? operation.createdAt;
      return [
        {
          id: `${operation.id}:visual_searching`,
          operationKind,
          buildId: null,
          stage: "visual_searching" as const,
          label: SITEOPS_EXECUTION_STAGE_LABELS.visual_searching,
          status: publicExecutionStatus(operation.status),
          startedAt: startedAt.toISOString(),
          completedAt: operation.completedAt?.toISOString() ?? null,
        },
      ];
    }
    if (operationKind === "deploy") return [];
    const operationEvents = events
      .filter((item) => item.operationId === operation.id)
      .sort(
        (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
      );
    if (operationEvents.length === 0) {
      const startedAt = operation.startedAt ?? operation.createdAt;
      return [
        {
          id: `${operation.id}:legacy-total`,
          operationKind,
          buildId: operation.buildId,
          stage:
            operation.status === "succeeded"
              ? ("completed" as const)
              : ("preparing" as const),
          label: operation.status === "succeeded" ? "官网制作" : "官网制作中",
          status: publicExecutionStatus(operation.status),
          startedAt: startedAt.toISOString(),
          completedAt: operation.completedAt?.toISOString() ?? null,
        },
      ];
    }
    const byStage = new Map<SiteOpsExecutionStage, (typeof events)[number]>();
    for (const event of operationEvents) {
      if (!byStage.has(event.stage)) byStage.set(event.stage, event);
    }
    if (!byStage.has("preparing")) {
      byStage.set("preparing", {
        id: `${operation.id}:preparing:fallback`,
        operationId: operation.id,
        buildId: operation.buildId,
        stage: "preparing",
        startedAt: operation.startedAt ?? operation.createdAt,
      });
    }
    const ordered = [
      "preparing",
      "design_compiling",
      "content_building",
      "qa_running",
    ].flatMap((stage) => {
      const event = byStage.get(stage as SiteOpsExecutionStage);
      return event ? [event] : [];
    });
    const projected: SiteOpsExecutionStep[] = ordered.map((event, index) => {
      const next = ordered[index + 1];
      const completedAt =
        next?.startedAt ??
        (operation.completedAt && operation.status !== "running"
          ? operation.completedAt
          : null);
      return {
        id: `${operation.id}:${event.stage}`,
        operationKind,
        buildId: operation.buildId,
        stage: event.stage,
        label: SITEOPS_EXECUTION_STAGE_LABELS[event.stage],
        status: next
          ? ("succeeded" as const)
          : publicExecutionStatus(operation.status),
        startedAt: event.startedAt.toISOString(),
        completedAt: completedAt?.toISOString() ?? null,
      };
    });
    if (operation.status === "succeeded" && operation.completedAt) {
      projected.push({
        id: `${operation.id}:completed`,
        operationKind,
        buildId: operation.buildId,
        stage: "completed",
        label: SITEOPS_EXECUTION_STAGE_LABELS.completed,
        status: "succeeded",
        startedAt: operation.completedAt.toISOString(),
        completedAt: operation.completedAt.toISOString(),
      });
    }
    return projected;
  });
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
    timelineMessageRows,
    buildRows,
    deploymentRows,
    packageRows,
    serviceReadiness,
    snapshotRows,
    batchRows,
    timelineOperationRows,
    connectionRows,
    profileRows,
    domainOperationRows,
    dnsOperationRows,
    activeAliyunOperationRows,
    unresolvedFinancialRows,
    resetOperationRows,
    providerTaskRows,
    activeDnsRecordRows,
    rebuildRequest,
  ] = await Promise.all([
    executor
      .select()
      .from(messages)
      .where(messagePredicate)
      .orderBy(asc(messages.sequence))
      .limit(500),
    executor
      .select({
        id: messages.id,
        metadata: messages.metadata,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.project.conversationId),
          isNull(messages.deletedAt),
        ),
      )
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
    loadServiceReadiness(executor, {
      projectId: input.project.id,
      userId: input.userId,
    }),
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
      .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES + 1),
    executor
      .select({
        id: siteOperations.id,
        buildId: siteOperations.buildId,
        kind: siteOperations.kind,
        status: siteOperations.status,
        startedAt: siteOperations.startedAt,
        completedAt: siteOperations.completedAt,
        createdAt: siteOperations.createdAt,
      })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.userId),
          inArray(siteOperations.kind, [
            "visual_search",
            "site_build",
            "build_revision",
            "deploy",
          ]),
        ),
      )
      .orderBy(desc(siteOperations.createdAt))
      .limit(50),
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
      .select({
        buildId: siteOperations.buildId,
        providerTaskId: siteOperations.providerTaskId,
        status: siteOperations.status,
      })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.userId),
          isNotNull(siteOperations.providerTaskId),
        ),
      )
      .limit(50),
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
    loadSiteOpsRebuildRequest(executor, {
      userId: input.userId,
      projectId: input.project.id,
      currentBuildId: input.project.currentBuildId,
      hasWorkflowProgress: Boolean(
        input.project.currentBuildId ||
          input.project.currentKnowledgeSnapshotId ||
          input.project.status !== "draft",
      ),
    }),
  ]);

  const publishedBatchRows = batchRows
    .filter(
      (row: typeof websiteStyleSampleBatches.$inferSelect) =>
        row.status === "published",
    )
    .sort(
      (
        left: typeof websiteStyleSampleBatches.$inferSelect,
        right: typeof websiteStyleSampleBatches.$inferSelect,
      ) => left.ordinal - right.ordinal,
    )
    .slice(0, SITEOPS_VISUAL_CANDIDATE_MAX_PAGES);
  const visibleBatchRows =
    publishedBatchRows.length > 0
      ? publishedBatchRows
      : batchRows
          .filter(
            (row: typeof websiteStyleSampleBatches.$inferSelect) =>
              row.status === "selected",
          )
          .slice(0, 1);
  const visibleBatchIds = visibleBatchRows.map(
    (row: typeof websiteStyleSampleBatches.$inferSelect) => row.id,
  );
  const candidateRows =
    visibleBatchIds.length > 0
      ? await executor
          .select()
          .from(websiteStyleSamples)
          .where(inArray(websiteStyleSamples.batchId, visibleBatchIds))
          .limit(SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL)
      : [];
  const messagesProjected = messageRows.flatMap(
    (row: typeof messages.$inferSelect) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const siteOps = metadata.siteOps as Record<string, unknown> | undefined;
      const originalPayload = siteOps?.payload as
        | Record<string, unknown>
        | undefined;
      if (
        originalPayload?.visibility === "timeline" ||
        originalPayload?.timelineOnly === true
      ) {
        return [];
      }
      const statusProjectedMetadata =
        siteOps?.status === "active" &&
        Number(siteOps.revision) !== input.project.revision
          ? { ...metadata, siteOps: { ...siteOps, status: "expired" } }
          : metadata;
      const statusProjectedSiteOps = statusProjectedMetadata.siteOps as
        | Record<string, unknown>
        | undefined;
      const payload = statusProjectedSiteOps?.payload as
        | Record<string, unknown>
        | undefined;
      const projectedMetadata = statusProjectedSiteOps
        ? {
            ...statusProjectedMetadata,
            siteOps: {
              ...statusProjectedSiteOps,
              subjectId: row.id,
              payload: {},
            },
          }
        : statusProjectedMetadata;
      return [
        {
          id: row.id,
          role: row.role,
          content:
            row.role === "assistant" && siteOps
              ? publicSiteOpsMessageText({
                  content: row.content,
                  errorCode:
                    typeof payload?.errorCode === "string"
                      ? payload.errorCode
                      : null,
                })
              : row.content,
          sequence: row.sequence,
          metadata: projectedMetadata,
          sentAt: row.sentAt.toISOString(),
        },
      ];
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
  const activeBuildRows = buildRows.filter(
    (row: typeof siteBuilds.$inferSelect) =>
      !["cancelled", "superseded"].includes(row.status),
  );
  const currentBuild = activeBuildRows.find(
    (row: typeof siteBuilds.$inferSelect) =>
      row.id === input.project.currentBuildId,
  );
  const currentProviderTaskRows = currentBuild
    ? providerTaskRows.filter(
        (row: {
          buildId: string | null;
          providerTaskId: string | null;
          status: string;
        }) => row.buildId === currentBuild.id && Boolean(row.providerTaskId),
      )
    : [];
  const providerTaskCanBeCheckedBeforeReset = Boolean(
    currentBuild?.upstreamManusTaskId &&
      currentProviderTaskRows.length > 0 &&
      currentProviderTaskRows.every(
        (row: { providerTaskId: string | null; status: string }) =>
          row.providerTaskId === currentBuild.upstreamManusTaskId &&
          !["queued", "running", "outcome_unknown"].includes(row.status),
      ),
  );
  const resettableFailedBuild = Boolean(
    currentBuild &&
      activeBuildRows.length === 1 &&
      isSiteOpsFailedBuildResettable({
        ...currentBuild,
        hasProviderTask: providerTaskRows.some(
          (row: { buildId: string | null; providerTaskId: string | null }) =>
            row.buildId === currentBuild.id && Boolean(row.providerTaskId),
        ),
        providerTaskStopped: providerTaskCanBeCheckedBeforeReset,
      }),
  );
  const resetCapability = siteOpsResetCapability({
    projectStatus: input.project.status,
    currentBuild: Boolean(input.project.currentBuildId),
    liveHead: Boolean(
      input.project.globalLiveDeploymentId ||
        input.project.mainlandLiveDeploymentId,
    ),
    hasBuild: activeBuildRows.length > 0,
    resettableFailedBuild,
    hasDeployment: deploymentRows.length > 0,
    hasBlockingOperation: resetOperationRows.length > 0,
    hasActiveDns: activeDnsRecordRows.length > 0,
    hasUnresolvedFinancialIntent: unresolvedFinancialRows.length > 0,
  });
  const selectedSampleIds = new Set(
    buildRows
      .filter(
        (build: typeof siteBuilds.$inferSelect) =>
          !["cancelled", "superseded"].includes(build.status),
      )
      .flatMap((build: typeof siteBuilds.$inferSelect) =>
        build.styleSampleId ? [build.styleSampleId] : [],
      ),
  );
  const projectVisualCandidate = (
    row: typeof websiteStyleSamples.$inferSelect,
  ) => {
    const { providerTitle, ...heroMetadata } = publicVisualMetadata(
      row.sourceMetadata,
    );
    return {
      id: row.id,
      label: row.label,
      title: providerTitle || row.note?.trim() || `视觉方向 ${row.label}`,
      previewUrl: `/api/site-ops/style-previews/${row.id}`,
      note: row.note,
      ...heroMetadata,
      selected: selectedSampleIds.has(row.id),
    };
  };
  const visualCandidatePages = visibleBatchRows.flatMap(
    (
      batch: typeof websiteStyleSampleBatches.$inferSelect,
      pageIndex: number,
    ) => {
      const candidates = candidateRows
        .filter(
          (row: typeof websiteStyleSamples.$inferSelect) =>
            row.batchId === batch.id,
        )
        .sort(
          (
            left: typeof websiteStyleSamples.$inferSelect,
            right: typeof websiteStyleSamples.$inferSelect,
          ) => left.sortOrder - right.sortOrder,
        )
        .map(projectVisualCandidate);
      return candidates.length === 9
        ? [{ batchId: batch.id, page: pageIndex + 1, candidates }]
        : [];
    },
  );
  const visualCandidates =
    visualCandidatePages[visualCandidatePages.length - 1]?.candidates ?? [];
  const observation = {
    schemaVersion: 1 as const,
    executionKind: "site_ops" as const,
    serviceReadiness,
    aliyunConnection: connectionRows[0]
      ? {
          configured: connectionRows[0].status === "active",
          status:
            connectionRows[0].status === "active"
              ? ("active" as const)
              : connectionRows[0].status === "unverified"
                ? ("authorization_required" as const)
                : connectionRows[0].status === "invalid"
                  ? ("attention_required" as const)
                  : ("not_connected" as const),
          verifiedAt: connectionRows[0].verifiedAt?.toISOString() ?? null,
          canRotate:
            activeAliyunOperationRows.length === 0 &&
            unresolvedFinancialRows.length === 0,
        }
      : {
          configured: false,
          status: "not_connected" as const,
          verifiedAt: null,
          canRotate: true,
        },
    domainState: profileRows[0]
      ? {
          domain: profileRows[0].normalizedAsciiDomain ?? profileRows[0].domain,
          displayDomain:
            profileRows[0].unicodeDisplayDomain ?? profileRows[0].domain,
          revision: profileRows[0].domainRevision,
          registrar: profileRows[0].registrar,
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
                reason:
                  check.available === false && typeof check.reason === "string"
                    ? "当前域名暂不可注册，请尝试其他名称。"
                    : null,
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
        issue: publicSiteOpsDomainIssue(row.errorCode, row.status),
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    dnsPlan:
      latestDnsPlanRow && latestDnsPlanResult
        ? {
            canApply: latestDnsPlanResult.canApply === true,
            status:
              latestDnsPlanRow.status === "succeeded"
                ? ("succeeded" as const)
                : ("attention_required" as const),
            changeCount: dnsPlanItems.filter(
              (item) =>
                item &&
                typeof item === "object" &&
                !["conflict", "unknown", "verify"].includes(
                  String((item as Record<string, unknown>).action ?? ""),
                ),
            ).length,
            conflictCount: dnsPlanItems.filter(
              (item) =>
                item &&
                typeof item === "object" &&
                ["conflict", "unknown"].includes(
                  String((item as Record<string, unknown>).action ?? ""),
                ),
            ).length,
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
    visualCandidates,
    visualCandidatePages,
    visualGeneration: {
      generatedPages: visualCandidatePages.length,
      maxPages: SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
      canGenerateMore:
        input.project.status === "awaiting_visual_selection" &&
        publishedBatchRows.length > 0 &&
        publishedBatchRows.length < SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
    },
    executionSteps: projectSiteOpsExecutionSteps({
      operations: timelineOperationRows,
      timelineMessages: timelineMessageRows,
    }),
    builds: buildRows.map((row: typeof siteBuilds.$inferSelect) => {
      return {
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
        needsHelp:
          row.status === "failed" || row.status === "attention_required",
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
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
    rebuildRequest: {
      allowed: rebuildRequest.allowed,
      ticketId: rebuildRequest.ticketId,
      status: rebuildRequest.status,
      resetApplied: rebuildRequest.resetApplied,
      resetSourceBuildId: rebuildRequest.resetSourceBuildId,
    },
    interactionState:
      input.project.status === "draft"
        ? ("select_snapshot" as const)
        : input.project.status,
    latestSequence: Math.max(
      input.afterSequence ?? 0,
      ...messageRows.map((row: typeof messages.$inferSelect) => row.sequence),
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
  if (error instanceof AuthServiceError) {
    if (error.code === "INVALID_CREDENTIAL" || error.code === "NOT_FOUND") {
      throw new SiteOpsServiceError(
        "PROVIDER_NOT_CONFIGURED",
        "阿里云连接配置需要 FrontMind 管理员更新。",
        409,
      );
    }
    if (
      error.code === "RATE_LIMITED" ||
      error.code === "UPSTREAM_UNAVAILABLE"
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "阿里云授权服务暂时不可用，请稍后重试。",
        503,
      );
    }
  }
  if (error instanceof AliyunProviderError) {
    const notFound = error.code === "NOT_FOUND";
    const invalid = [
      "INVALID_DOMAIN",
      "ACCOUNT_ROLE_MISMATCH",
      "CALLER_ACCOUNT_MISMATCH",
    ].includes(error.code);
    const authorizationNeeded =
      publicSiteOpsDomainIssue(error.code, "attention_required") ===
      "authorization_needed";
    throw new SiteOpsServiceError(
      invalid ? "INVALID_INPUT" : notFound ? "NOT_FOUND" : "STATE_CONFLICT",
      error.code === "INVALID_DOMAIN"
        ? "域名格式不正确，请检查后重试。"
        : notFound
          ? "当前项目或连接不存在，请刷新后重试。"
          : authorizationNeeded
            ? "阿里云授权尚未完成，请重新前往官方页面完成授权。"
            : "连接或配置暂未完成，请稍后重试或提交授权协助工单。",
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
      configured: status.status === "active",
      status:
        status.status === "active"
          ? ("active" as const)
          : status.status === "unverified"
            ? ("authorization_required" as const)
            : status.status === "invalid"
              ? ("attention_required" as const)
              : ("not_connected" as const),
      verifiedAt: status.verifiedAt
        ? new Date(status.verifiedAt).toISOString()
        : null,
      canRotate: true,
    };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function beginSiteOpsAliyunOAuth(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    return await createAliyunOAuthAuthorization({
      projectId: project.id,
      userId: actor.id,
    });
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function getSiteOpsAliyunAuthorizationGuide(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    const [status, broker] = await Promise.all([
      getAliyunCustomerConnectionStatus({
        projectId: project.id,
        userId: actor.id,
      }),
      getActiveAliyunBrokerCredential(),
    ]);
    const available = Boolean(
      broker &&
        status.configured &&
        status.status !== "revoked" &&
        status.status !== "active",
    );
    const authorization =
      available && broker
        ? await getAliyunCustomerRoleAuthorizationPackage({
            projectId: project.id,
            userId: actor.id,
            trustedPrincipalArn: broker.principalArn,
          })
        : null;
    return {
      available,
      consoleUrl: available ? "https://ram.console.aliyun.com/roles" : "",
      configurationDownloadUrl: available
        ? `/api/site-ops/aliyun/role-configuration?conversationId=${encodeURIComponent(input.conversationId)}`
        : "",
      roleName: authorization?.roleName ?? "",
      trustPolicyText: authorization
        ? JSON.stringify(authorization.trustPolicyDocument, null, 2)
        : "",
      permissionPolicyText: authorization
        ? JSON.stringify(authorization.permissionPolicyDocument, null, 2)
        : "",
    };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function completeSiteOpsAliyunOAuth(input: {
  actor: AuthenticatedUser;
  credentialId: string;
  projectId: string;
  accountUid: string;
}) {
  assertEnabled();
  assertCustomer(input.actor);
  await requireSiteOpsEntitlement(input.actor.id);
  const db = await requireDb();
  const credentialId = z.string().uuid().parse(input.credentialId);
  const projectId = z.string().uuid().parse(input.projectId);
  try {
    await db.transaction(async (tx) => {
      const projectRows = await tx
        .select({ id: siteProjects.id })
        .from(siteProjects)
        .where(
          and(
            eq(siteProjects.id, projectId),
            eq(siteProjects.userId, input.actor.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!projectRows[0]) {
        throw new SiteOpsServiceError(
          "NOT_FOUND",
          `${SITEOPS_CUSTOMER_DISPLAY_NAME}项目不存在。`,
          404,
        );
      }

      const credentialRows = await tx
        .select({ id: presalesApiCredentials.id })
        .from(presalesApiCredentials)
        .where(
          and(
            eq(presalesApiCredentials.id, credentialId),
            eq(presalesApiCredentials.slot, ALIYUN_OAUTH_CREDENTIAL_SLOT),
            eq(presalesApiCredentials.status, "active"),
          ),
        )
        .limit(1)
        .for("update");
      if (!credentialRows[0]) {
        throw new SiteOpsServiceError(
          "CREDENTIAL_ROTATED",
          "阿里云 OAuth 配置已在授权期间更新，请重新发起连接。",
          409,
        );
      }

      const now = new Date();
      await tx
        .update(presalesApiCredentials)
        .set({
          validationStatus: "verified",
          verifiedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(presalesApiCredentials.id, credentialId),
            eq(presalesApiCredentials.slot, ALIYUN_OAUTH_CREDENTIAL_SLOT),
            eq(presalesApiCredentials.status, "active"),
          ),
        );
      await bindAliyunCustomerAccountFromOAuth(
        {
          projectId,
          userId: input.actor.id,
          accountUid: input.accountUid,
        },
        tx,
      );
    });
    return { connected: false as const, authorizationRequired: true as const };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function getSiteOpsAliyunRoleConfiguration(
  actor: AuthenticatedUser,
  conversationId: string,
) {
  const project = await requireOwnedAliyunProject(actor, conversationId);
  const broker = await getActiveAliyunBrokerCredential();
  if (!broker) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "域名与发布平台尚未配置完成。",
      409,
    );
  }
  try {
    return await getAliyunCustomerRoleAuthorizationPackage({
      projectId: project.id,
      userId: actor.id,
      trustedPrincipalArn: broker.principalArn,
    });
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
    await verifyAliyunCustomerConnection({
      projectId: project.id,
      userId: actor.id,
    });
    return { ok: true as const, connected: true as const };
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
        content: "已记录你补充的信息。资料完整后即可生成视觉候选。",
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
    case "request_rebuild":
      return z
        .object({ reason: z.string().trim().max(4_000).optional() })
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
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "官网制作和检查完成后会自动批准，无需重复操作。",
        409,
      );
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
  slot: "site_builder_21st",
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
      "系统管理员尚未配置有效的 21st API Key。",
      412,
    );
  }
  return row;
}

async function ensureActiveCustomerAiCredential(tx: any, userId: number) {
  const rows = await tx
    .select()
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.userId, userId),
        eq(apiCredentials.status, "active"),
        eq(apiCredentials.validationStatus, "verified"),
        isNotNull(apiCredentials.verifiedAt),
        isNull(apiCredentials.deletedAt),
      ),
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "当前账号尚未配置有效的 AI 建站 API Key。",
      412,
    );
  }
  return row;
}

export function resolveSiteOpsAgentProfile(input: {
  requested?: unknown;
  parentOperationInput?: unknown;
  credentialDefault?: unknown;
}): ManagedAgentProfile {
  const requested = managedAgentProfileSchema.safeParse(input.requested);
  if (requested.success) return requested.data;
  const parentInput =
    input.parentOperationInput &&
    typeof input.parentOperationInput === "object" &&
    !Array.isArray(input.parentOperationInput)
      ? (input.parentOperationInput as Record<string, unknown>)
      : {};
  const parent = managedAgentProfileSchema.safeParse(parentInput.agentProfile);
  if (parent.success) return parent.data;
  return normalizeManagedAgentProfile(input.credentialDefault);
}

export function freezeSiteOpsCustomerAiCredential(input: {
  credential: { id: string; version: number; agentProfile?: unknown };
  requestedProfile?: unknown;
  parentOperationInput?: unknown;
}) {
  return {
    manusCredentialId: input.credential.id,
    manusCredentialVersion: input.credential.version,
    credentialScope: "customer" as const,
    agentProfile: resolveSiteOpsAgentProfile({
      requested: input.requestedProfile,
      parentOperationInput: input.parentOperationInput,
      credentialDefault: input.credential.agentProfile,
    }),
  };
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

async function handleRequestRebuild(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { reason?: string };
  },
) {
  const now = new Date();
  let created: {
    ticketId: string;
    buildId: string | null;
    resubmitted: boolean;
  };
  try {
    created = await createSiteOpsRebuildTicket(tx, {
      userId: input.actor.id,
      projectId: input.project.id,
      currentBuildId: input.project.currentBuildId,
      clientRequestId: input.requestId,
      reason: input.payload.reason,
      quotaPeriodIds: Array.from(
        new Set([
          ...siteOpsQuotaPeriodIds(
            input.entitlement,
            "website_content_publish",
          ),
          ...siteOpsQuotaPeriodIds(input.entitlement, "content_asset_publish"),
        ]),
      ),
      now,
    });
  } catch (error) {
    if (error instanceof SiteOpsQuotaError) {
      throw siteOpsServiceErrorFromQuota(error);
    }
    if (error instanceof SiteOpsRebuildTicketError) {
      throw new SiteOpsServiceError(
        error.code === "DELIVERY_OWNER_NOT_ASSIGNED" ||
        error.code === "ENTITLEMENT_NOT_FOUND"
          ? "FORBIDDEN"
          : "STATE_CONFLICT",
        error.message,
        error.code === "DELIVERY_OWNER_NOT_ASSIGNED" ||
        error.code === "ENTITLEMENT_NOT_FOUND"
          ? 412
          : 409,
      );
    }
    throw error;
  }
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      action: "request_rebuild",
      ticketId: created.ticketId,
      ...(created.buildId ? { sourceBuildId: created.buildId } : {}),
    },
    kind: "brief_message",
    ...(created.buildId ? { buildId: created.buildId } : {}),
    status: "succeeded",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: created.resubmitted
      ? "官网重制需求已再次提交。当前制作流程暂不受影响，FrontMind 通过后会重新开启全新流程。"
      : "官网重制需求已提交。当前制作流程暂不受影响，FrontMind 通过后会重新开启全新流程。",
    siteOps: {
      kind: "operation_recovery",
      subjectId: created.ticketId,
      revision: input.project.revision,
      status: "resolved",
      payload: { rebuildTicketId: created.ticketId, status: "submitted" },
    },
  });
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
    providerTaskPreflight: ResetProviderTaskPreflight | null;
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
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
      ),
    )
    .limit(50)
    .for("update");
  const providerTaskRows = await tx
    .select({
      buildId: siteOperations.buildId,
      providerTaskId: siteOperations.providerTaskId,
      status: siteOperations.status,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        isNotNull(siteOperations.providerTaskId),
      ),
    )
    .limit(50)
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

  const activeBuildRows = buildRows.filter(
    (row: typeof siteBuilds.$inferSelect) =>
      !["cancelled", "superseded"].includes(row.status),
  );
  const currentBuild = activeBuildRows.find(
    (row: typeof siteBuilds.$inferSelect) =>
      row.id === input.project.currentBuildId,
  );
  const currentProviderTaskRows = currentBuild
    ? providerTaskRows.filter(
        (row: {
          buildId: string | null;
          providerTaskId: string | null;
          status: string;
        }) => row.buildId === currentBuild.id && Boolean(row.providerTaskId),
      )
    : [];
  const providerTaskStopped = currentBuild
    ? isSiteOpsStoppedProviderTaskResetSafe({
        buildId: currentBuild.id,
        buildProviderTaskId: currentBuild.upstreamManusTaskId,
        operationProviderTaskIds: currentProviderTaskRows.flatMap(
          (row: { providerTaskId: string | null }) =>
            row.providerTaskId ? [row.providerTaskId] : [],
        ),
        operationStatuses: currentProviderTaskRows.map(
          (row: { status: string }) => row.status,
        ),
        preflight: input.providerTaskPreflight,
      })
    : false;
  const resettableFailedBuild = Boolean(
    currentBuild &&
      activeBuildRows.length === 1 &&
      isSiteOpsFailedBuildResettable({
        ...currentBuild,
        hasProviderTask: providerTaskRows.some(
          (row: { buildId: string | null; providerTaskId: string | null }) =>
            row.buildId === currentBuild.id && Boolean(row.providerTaskId),
        ),
        providerTaskStopped,
      }),
  );
  const resetCapability = siteOpsResetCapability({
    projectStatus: input.project.status,
    currentBuild: Boolean(input.project.currentBuildId),
    liveHead: Boolean(
      input.project.globalLiveDeploymentId ||
        input.project.mainlandLiveDeploymentId,
    ),
    hasBuild: activeBuildRows.length > 0,
    resettableFailedBuild,
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
  if (resettableFailedBuild && currentBuild) {
    await tx
      .update(siteBuilds)
      .set({
        status: "cancelled",
        ...(currentBuild.quotaState === "reserved"
          ? { quotaState: "released" as const }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(siteBuilds.id, currentBuild.id),
          inArray(siteBuilds.status, ["failed", "attention_required"]),
        ),
      );
  }
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
        inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
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
      `当前域名已有${rows[0].intent === "rollback" ? "回滚" : "发布"}任务正在${rows[0].status === "verifying" ? "验证" : "处理"}，不同发布区域不能同时操作。`,
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
      "知识库版本已选择，FrontMind 正在整理建站资料；未确认的信息不会写入官网。",
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
  if (input.project.currentBuildId) {
    const rebuild = await loadSiteOpsRebuildRequest(tx, {
      userId: input.actor.id,
      projectId: input.project.id,
      currentBuildId: input.project.currentBuildId,
    });
    requireAcceptedSiteOpsRebuild(rebuild);
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
    content: "已更换知识库并重新整理建站资料。旧官网和线上网站保持不变。",
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

export function visualSearchAllowedForProjectStatus(
  status: string,
  reselect = false,
) {
  return (
    reselect
      ? [
          "awaiting_visual_selection",
          "preview_ready",
          "approved",
          "live",
          "failed",
          "attention_required",
        ]
      : ["collecting_brief"]
  ).includes(status);
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
  if (input.project.currentBuildId) {
    const rebuild = await loadSiteOpsRebuildRequest(tx, {
      userId: input.actor.id,
      projectId: input.project.id,
      currentBuildId: input.project.currentBuildId,
    });
    requireAcceptedSiteOpsRebuild(rebuild);
  }
  if (
    !visualSearchAllowedForProjectStatus(input.project.status, input.reselect)
  ) {
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
  const currentPublishedBatches = await tx
    .select({ id: websiteStyleSampleBatches.id })
    .from(websiteStyleSampleBatches)
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    )
    .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES)
    .for("update");
  if (
    input.reselect &&
    currentPublishedBatches.length >= SITEOPS_VISUAL_CANDIDATE_MAX_PAGES
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮已生成全部 27 个视觉候选，请从三个候选组中选择一个方向。",
      409,
    );
  }
  const readiness = visualSearchReadiness(input.project.brief);
  if (!readiness.ready) {
    if (readiness.reason !== "no_public_facts") {
      console.error("[SiteOps] visual_search_readiness_failed", {
        event: "siteops_visual_search_readiness_failed",
        projectId: input.project.id,
        projectRevision: input.project.revision,
        reason: readiness.reason,
        routeId: readiness.routeId ?? null,
      });
    }
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      readiness.reason === "no_public_facts"
        ? "当前知识库没有足够的可公开事实与来源，需先补齐知识库后再检索视觉方向。"
        : "FrontMind暂时无法整理建站资料，请刷新后重试。",
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
      ? `正在生成第 ${currentPublishedBatches.length + 1} 组全新视觉候选；前面展示过的参考不会重复。`
      : "正在生成 9 个视觉候选，完成后会一次展示。",
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
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
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
  const batchId = input.batchId;
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
          : batchId
            ? eq(websiteStyleSamples.batchId, batchId)
            : eq(websiteStyleSampleBatches.status, "published"),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  if (
    sampleRows.length < 1 ||
    sampleRows.length > SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL
  ) {
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
  const selectedMetadataRecord = selectedMetadata as unknown as Record<
    string,
    unknown
  >;
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
  const referenceBlueprint = freezeSiteOpsReferenceBlueprint({
    sampleId: selected.sample.id,
    previewLocalAssetId: selected.sample.previewLocalAssetId,
    note: selected.sample.note,
    sourceMetadata: selectedMetadataRecord,
  });
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
      "知识库版本校验尚未完成，暂时不能开始制作官网。",
      409,
    );
  }
  const credential = await resolvePinnedTwentyFirstCredentialForBatch(tx, {
    engineerNote: selected.batch.engineerNote,
    projectId: input.project.id,
    userId: input.actor.id,
    knowledgeSnapshotId: snapshot.id,
  });
  const aiCredential = await ensureActiveCustomerAiCredential(
    tx,
    input.actor.id,
  );
  const aiCredentialBinding = freezeSiteOpsCustomerAiCredential({
    credential: aiCredential,
  });
  const parentBuildId = input.project.currentBuildId;
  if (parentBuildId) {
    const rebuild = await loadSiteOpsRebuildRequest(tx, {
      userId: input.actor.id,
      projectId: input.project.id,
      currentBuildId: parentBuildId,
    });
    requireAcceptedSiteOpsRebuild(rebuild);
  }
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
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
        ne(websiteStyleSampleBatches.id, selected.batch.id),
      ),
    );
  await tx.insert(siteBuilds).values({
    id: buildId,
    projectId: input.project.id,
    userId: input.actor.id,
    parentBuildId,
    quotaPeriodId,
    quotaState: "reserved",
    knowledgeSnapshotId: snapshot.id,
    knowledgeArchiveHash: snapshot.archiveHash,
    ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
    ...currentSiteOpsBuildWorkflowCoordinates(),
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
      ...(parentBuildId ? { childBuildId: buildId, parentBuildId } : {}),
      styleSampleId: selected.sample.id,
      delegated: input.delegated,
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      referenceBlueprint,
      ...aiCredentialBinding,
    },
    kind: parentBuildId ? "build_revision" : "site_build",
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
      ...(parentBuildId ? {} : { currentBuildId: buildId }),
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
  if (!parent.styleSampleId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网版本缺少可冻结的视觉方案，请提交官网重制需求。",
      409,
    );
  }
  const rebuild = await loadSiteOpsRebuildRequest(tx, {
    userId: input.actor.id,
    projectId: input.project.id,
    currentBuildId: parent.id,
  });
  requireAcceptedSiteOpsRebuild(rebuild);
  const styleRows = await tx
    .select({ sample: websiteStyleSamples })
    .from(websiteStyleSamples)
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        eq(websiteStyleSamples.id, parent.styleSampleId),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
      ),
    )
    .limit(1);
  const styleSample = styleRows[0]?.sample;
  if (!styleSample?.previewLocalAssetId || !styleSample.sourceMetadata) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网版本的视觉方案不完整，请提交官网重制需求。",
      409,
    );
  }
  const derivedReferenceBlueprint = freezeSiteOpsReferenceBlueprint({
    sampleId: styleSample.id,
    previewLocalAssetId: styleSample.previewLocalAssetId,
    note: styleSample.note,
    sourceMetadata: styleSample.sourceMetadata,
  });
  const aiCredential = await ensureActiveCustomerAiCredential(
    tx,
    input.actor.id,
  );
  const parentOperationRows = await tx
    .select({ input: siteOperations.input })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        eq(siteOperations.buildId, parent.id),
        inArray(siteOperations.kind, ["site_build", "build_revision"]),
      ),
    )
    .orderBy(desc(siteOperations.createdAt))
    .limit(1);
  const parentOperationInput = parentOperationRows[0]?.input;
  const referenceBlueprint = referenceBlueprintForSiteOpsRevision({
    parentWorkflowVersion: parent.workflowVersion,
    parentOperationInput,
    derivedReferenceBlueprint,
  });
  const aiCredentialBinding = freezeSiteOpsCustomerAiCredential({
    credential: aiCredential,
    parentOperationInput,
  });
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
    // A revision is a new immutable build. Freeze the current workflow,
    // starter and materializer as one coordinate set instead of pairing the
    // current host runtime with a historical parent's contract.
    ...currentSiteOpsBuildWorkflowCoordinates(),
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
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      referenceBlueprint,
      ...aiCredentialBinding,
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
      "域名与网站配置尚未完成验证。",
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
    content: "已提交恢复历史官网版本；如验证未完成，当前线上网站不会变化。",
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
  const aiCredential = await ensureActiveCustomerAiCredential(
    tx,
    input.actor.id,
  );
  const aiCredentialBinding = freezeSiteOpsCustomerAiCredential({
    credential: aiCredential,
  });
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
      ...aiCredentialBinding,
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
      "阿里云授权尚未完成，请按页面指引完成授权。",
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
      "域名服务尚未配置完成，请联系 FrontMind。",
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
  let renewalTarget: {
    expectedCanonicalHostname: string;
    expectedDomainRevision: number;
  } | null = null;
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
    if (input.action === "domain_confirm_renewal") {
      const profileRows = await tx
        .select({
          domain: workspaceSiteProfiles.normalizedAsciiDomain,
          revision: workspaceSiteProfiles.domainRevision,
        })
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, input.actor.id))
        .limit(1)
        .for("update");
      const profile = profileRows[0];
      if (!profile?.domain || profile.domain !== input.payload.domain) {
        throw new SiteOpsServiceError(
          "STATE_CONFLICT",
          "当前官网域名已经变化，请重新获取续费报价。",
          409,
        );
      }
      renewalTarget = {
        expectedCanonicalHostname: profile.domain,
        expectedDomainRevision: profile.revision,
      };
    }
  }
  if (input.action === "domain_set_auto_renew") {
    const profileRows = await tx
      .select({
        domain: workspaceSiteProfiles.normalizedAsciiDomain,
        revision: workspaceSiteProfiles.domainRevision,
      })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.actor.id))
      .limit(1)
      .for("update");
    const profile = profileRows[0];
    if (!profile?.domain || profile.domain !== input.payload.domain) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "当前官网域名已经变化，请刷新后重新确认自动续费设置。",
        409,
      );
    }
    renewalTarget = {
      expectedCanonicalHostname: profile.domain,
      expectedDomainRevision: profile.revision,
    };
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
        "当前域名配置已变化，请重新获取配置方案。",
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
  const brokerCredential = esaDnsPreparation
    ? null
    : await getActiveAliyunBrokerCredential();
  if (!esaDnsPreparation && !brokerCredential) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "域名与发布平台尚未配置完成，未提交任何域名或解析操作。",
      412,
    );
  }
  const providerPayload = {
    ...(esaDnsPreparation ?? input.payload),
    connectionId: connection.id,
    ...(brokerCredential
      ? {
          brokerCredentialId: brokerCredential.id,
          brokerCredentialVersion: brokerCredential.version,
        }
      : {}),
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
    ...(renewalTarget ?? {}),
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
    content: "操作已安全提交，FrontMind 会自动确认结果，避免重复执行。",
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

export async function actOnSiteOps(
  actor: AuthenticatedUser,
  value: unknown,
  options: {
    inspectResetProviderTask?: SiteOpsResetProviderTaskInspector;
  } = {},
) {
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
  // A provider task is inspected before the transaction. The transaction then
  // rechecks the exact build/task ids and every local in-flight boundary before
  // accepting the immutable stopped result. No network call is made while DB
  // locks are held.
  const providerTaskPreflight =
    input.action === "reset_workflow"
      ? await prepareResetProviderTaskPreflight(db, {
          actorId: actor.id,
          conversationId: input.conversationId,
          inspect:
            options.inspectResetProviderTask ??
            defaultResetProviderTaskInspector,
        })
      : null;
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
          providerTaskPreflight,
        });
        break;
      case "request_rebuild":
        await handleRequestRebuild(tx, {
          ...common,
          payload: payload as { reason?: string },
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
