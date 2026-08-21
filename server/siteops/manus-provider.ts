import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";

import {
  knowledgeBaseSnapshots,
  siteBuilds,
  siteOperations,
  siteProjects,
  socialPackages,
  websiteStyleSamples,
  type SiteOperation,
} from "../../drizzle/schema";
import {
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  visualTaxonomySchema,
} from "../../shared/siteops";
import {
  canonicalJson,
  composeBuildContractV1,
} from "../../shared/siteops-workflow";
import { getDb } from "../db";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventsContainOperationToken,
  type ManusV2MessageEvent,
  type ManusV2StructuredOutputSchema,
} from "../manus-v2-client";
import { getPresalesCredentialById } from "../presales-service";
import { readKnowledgeSnapshotArchive } from "../knowledge-snapshot-archive-store";
import {
  generateSocialPackage,
  materializeAstroSite,
  siteOpsGeneratedContentSchema,
  socialPackageInputSchema,
} from "./build-runtime";
import { persistSiteOpsArtifact } from "./artifact-store";
import {
  registerSiteOpsProviderHandler,
  type SiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";
import { readSelectedOfficialLogoFromKnowledgeArchive } from "./knowledge-brand-asset";

const operationInputSchema = z
  .object({
    manusCredentialId: z.string().uuid(),
    manusCredentialVersion: z.number().int().positive(),
    buildId: z.string().uuid().optional(),
    childBuildId: z.string().uuid().optional(),
    parentBuildId: z.string().uuid().optional(),
    feedback: z.string().trim().min(1).max(8_000).optional(),
    channel: z.enum(["wechat", "xiaohongshu"]).optional(),
    packageId: z.string().uuid().optional(),
    topic: z.string().trim().max(500).optional(),
  })
  .passthrough();

const designResultSchema = z
  .object({
    operationToken: z.string().min(1).max(128),
    designSystem: z
      .object({
        visualDirection: z.string().trim().min(1).max(600),
        informationHierarchy: z.string().trim().min(1).max(1_200),
        contentTone: z.string().trim().min(1).max(600),
      })
      .strict(),
    seoPlan: z
      .object({
        siteTitle: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(200),
        organizationType: z.enum([
          "Organization",
          "Corporation",
          "ProfessionalService",
        ]),
      })
      .strict(),
  })
  .strict();

const providerStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.enum([
      "create_unknown",
      "design_pending",
      "content_send_ready",
      "content_send_unknown",
      "content_pending",
      "repair_send_ready",
      "repair_send_unknown",
      "repair_pending",
    ]),
    taskId: z.string().min(1).max(255).optional(),
    design: designResultSchema.optional(),
    repairKind: z.enum(["design", "content"]).optional(),
    repairAttempt: z.number().int().min(1).max(3).optional(),
  })
  .strict();

type ProviderState = z.infer<typeof providerStateSchema>;

type ManusProviderDependencies = {
  getDb?: typeof getDb;
  getCredential?: typeof getPresalesCredentialById;
  createClient?: (input: { apiKey: string; credentialId: string }) => ManusV2Client;
  readSnapshotArchive?: typeof readKnowledgeSnapshotArchive;
  persistArtifact?: typeof persistSiteOpsArtifact;
  materializeSite?: typeof materializeAstroSite;
  generateSocial?: typeof generateSocialPackage;
};

class SiteOpsManusFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: "failed" | "attention_required" = "attention_required",
  ) {
    super(message);
  }
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
let workflowPackagePromise: Promise<Buffer> | null = null;

function workflowRoots() {
  const configured = process.env.FRONTMIND_SITEOPS_WORKFLOW_PATH?.trim();
  return [
    ...(configured ? [path.resolve(configured)] : []),
    path.resolve(
      process.cwd(),
      "dist/private-workflows/astro-company-site-workflow-v1.1.0",
    ),
    path.resolve(
      process.cwd(),
      "private-workflows/astro-company-site-workflow-v1.1.0",
    ),
  ];
}

export async function loadVerifiedSiteOpsWorkflowPackage() {
  if (workflowPackagePromise) return workflowPackagePromise;
  workflowPackagePromise = (async () => {
    let root: string | null = null;
    let manifestBytes: Buffer | null = null;
    for (const candidate of workflowRoots()) {
      try {
        manifestBytes = await readFile(path.join(candidate, "MANIFEST.json"));
        root = candidate;
        break;
      } catch {
        // Try the next trusted source/runtime location.
      }
    }
    if (!root || !manifestBytes) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_NOT_FOUND",
        "FrontMind 1.1.0 建站工作流未进入运行镜像。",
      );
    }
    if (sha256(manifestBytes) !== SITEOPS_WORKFLOW.runtimeManifestSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_MANIFEST_MISMATCH",
        "FrontMind 1.1.0 建站工作流 manifest 哈希不一致。",
        "failed",
      );
    }
    const manifest = z
      .object({
        version: z.literal(SITEOPS_WORKFLOW.frontMindVersion),
        entrypoint: z.literal("SKILL.md"),
        upstream: z.object({
          version: z.literal(SITEOPS_WORKFLOW.upstreamVersion),
          archiveSha256: z.literal(SITEOPS_WORKFLOW.upstreamSha256),
        }),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(512),
              bytes: z.number().int().positive().max(5 * 1024 * 1024),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            }),
          )
          .min(1)
          .max(100),
      })
      .passthrough()
      .parse(JSON.parse(manifestBytes.toString("utf8")));
    const zip = new JSZip();
    zip.file("MANIFEST.json", manifestBytes, { date: FIXED_ZIP_DATE });
    let total = manifestBytes.length;
    for (const entry of manifest.files) {
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.split("/").some((segment) => segment === ".." || segment === ".") ||
        entry.path.normalize("NFKC") !== entry.path
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          "FrontMind 1.1.0 建站工作流包含不安全路径。",
          "failed",
        );
      }
      const absolute = path.resolve(root, entry.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          "FrontMind 1.1.0 建站工作流路径越界。",
          "failed",
        );
      }
      const fileStat = await lstat(absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_INVALID",
          "FrontMind 1.1.0 建站工作流包含非普通文件。",
          "failed",
        );
      }
      const bytes = await readFile(absolute);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_MISMATCH",
          `FrontMind 1.1.0 建站工作流文件校验失败：${entry.path}`,
          "failed",
        );
      }
      total += bytes.length;
      if (total > 18 * 1024 * 1024) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PACKAGE_TOO_LARGE",
          "FrontMind 1.1.0 建站工作流超过附件上限。",
          "failed",
        );
      }
      zip.file(entry.path, bytes, { date: FIXED_ZIP_DATE });
    }
    const skill = manifest.files.find((entry) => entry.path === "SKILL.md");
    const contract = manifest.files.find(
      (entry) => entry.path === "runtime-contract.json",
    );
    if (!skill || !contract) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_CONTRACT_MISSING",
        "FrontMind 1.1.0 建站工作流缺少 SKILL 或 runtime contract。",
        "failed",
      );
    }
    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    });
  })().catch((error) => {
    workflowPackagePromise = null;
    throw error;
  });
  return workflowPackagePromise;
}

function workflowAttachment(bytes: Buffer) {
  return {
    filename: `frontmind-astro-company-site-workflow-${SITEOPS_WORKFLOW.frontMindVersion}.zip`,
    mime_type: "application/zip",
    file_data: `data:application/zip;base64,${bytes.toString("base64")}`,
  } as const;
}

const SOCIAL_WORKFLOWS = {
  wechat: {
    directory: "siteops-wechat-package-v1.0.0",
    version: "1.0.0",
    manifestSha256:
      "5eb002ee34132105f8d13e3c4416fe4d08e07fadb1daa8ac660c066404689a6f",
  },
  xiaohongshu: {
    directory: "siteops-xiaohongshu-package-v1.0.0",
    version: "1.0.0",
    manifestSha256:
      "a359f8bfd6b46ab030fe7a36f8e7caf25fd873c286b533073c2db25661e93b0c",
  },
} as const;

const socialWorkflowPackages = new Map<
  keyof typeof SOCIAL_WORKFLOWS,
  Promise<Buffer>
>();

export async function loadVerifiedSiteOpsSocialWorkflowPackage(
  channel: keyof typeof SOCIAL_WORKFLOWS,
) {
  const existing = socialWorkflowPackages.get(channel);
  if (existing) return existing;
  const definition = SOCIAL_WORKFLOWS[channel];
  const loading = (async () => {
    const candidates = [
      path.resolve(process.cwd(), "dist/private-workflows", definition.directory),
      path.resolve(process.cwd(), "private-workflows", definition.directory),
    ];
    let root: string | null = null;
    let manifestBytes: Buffer | null = null;
    for (const candidate of candidates) {
      try {
        manifestBytes = await readFile(path.join(candidate, "MANIFEST.json"));
        root = candidate;
        break;
      } catch {
        // Try source after the immutable runtime location.
      }
    }
    if (!root || !manifestBytes) {
      throw new SiteOpsManusFailure(
        "SITEOPS_SOCIAL_WORKFLOW_NOT_FOUND",
        `${channel} 内容包工作流未进入运行镜像。`,
      );
    }
    if (sha256(manifestBytes) !== definition.manifestSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_SOCIAL_WORKFLOW_MANIFEST_MISMATCH",
        `${channel} 内容包工作流 manifest 哈希不一致。`,
        "failed",
      );
    }
    const manifest = z
      .object({
        channel: z.literal(channel),
        version: z.literal(definition.version),
        entrypoint: z.literal("SKILL.md"),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(191),
              bytes: z.number().int().positive().max(1_000_000),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            }),
          )
          .min(2)
          .max(10),
      })
      .passthrough()
      .parse(JSON.parse(manifestBytes.toString("utf8")));
    const zip = new JSZip();
    zip.file("MANIFEST.json", manifestBytes, { date: FIXED_ZIP_DATE });
    for (const entry of manifest.files) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.path) ||
        entry.path.normalize("NFKC") !== entry.path
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_SOCIAL_WORKFLOW_PATH_INVALID",
          `${channel} 内容包工作流包含不安全路径。`,
          "failed",
        );
      }
      const absolute = path.resolve(root, entry.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        throw new SiteOpsManusFailure(
          "SITEOPS_SOCIAL_WORKFLOW_PATH_INVALID",
          `${channel} 内容包工作流路径越界。`,
          "failed",
        );
      }
      const fileStat = await lstat(absolute);
      const bytes = await readFile(absolute);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        bytes.length !== entry.bytes ||
        sha256(bytes) !== entry.sha256
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_SOCIAL_WORKFLOW_FILE_MISMATCH",
          `${channel} 内容包工作流文件校验失败。`,
          "failed",
        );
      }
      zip.file(entry.path, bytes, { date: FIXED_ZIP_DATE });
    }
    if (
      !manifest.files.some((entry) => entry.path === "SKILL.md") ||
      !manifest.files.some((entry) => entry.path === "runtime-contract.json")
    ) {
      throw new SiteOpsManusFailure(
        "SITEOPS_SOCIAL_WORKFLOW_CONTRACT_MISSING",
        `${channel} 内容包工作流缺少 SKILL 或 runtime contract。`,
        "failed",
      );
    }
    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    });
  })().catch((error) => {
    socialWorkflowPackages.delete(channel);
    throw error;
  });
  socialWorkflowPackages.set(channel, loading);
  return loading;
}

export async function getSiteOpsSocialWorkflowReadiness() {
  const [websitePackage, entries] = await Promise.all([
    loadVerifiedSiteOpsWorkflowPackage(),
    Promise.all(
      (
        Object.keys(SOCIAL_WORKFLOWS) as Array<keyof typeof SOCIAL_WORKFLOWS>
      ).map(async (channel) => ({
          channel,
          version: SOCIAL_WORKFLOWS[channel].version,
          manifestSha256: SOCIAL_WORKFLOWS[channel].manifestSha256,
          packageBytes: (
            await loadVerifiedSiteOpsSocialWorkflowPackage(channel)
          ).length,
        })),
    ),
  ]);
  return {
    ready: true as const,
    website: {
      version: SITEOPS_WORKFLOW.frontMindVersion,
      manifestSha256: SITEOPS_WORKFLOW.runtimeManifestSha256,
      packageBytes: websitePackage.length,
    },
    workflows: entries,
  };
}

function socialWorkflowAttachment(
  channel: keyof typeof SOCIAL_WORKFLOWS,
  bytes: Buffer,
) {
  return {
    filename: `${SOCIAL_WORKFLOWS[channel].directory}.zip`,
    mime_type: "application/zip",
    file_data: `data:application/zip;base64,${bytes.toString("base64")}`,
  } as const;
}

function operationMarker(token: string) {
  return `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: token })}`;
}

function promptWithMarker(prompt: string, token: string) {
  return `${prompt}\n\n# FrontMind operation contract\n${operationMarker(token)}`;
}

function operationTitle(operation: SiteOperation) {
  return `FrontMind SiteOps ${operation.id}`;
}

function baseUrl() {
  return process.env.MANUS_API_BASE_URL?.trim() || "https://api.manus.ai";
}

function acceptedStructuredValue(events: readonly ManusV2MessageEvent[], token: string) {
  for (const event of [...events].reverse()) {
    if (event.type !== "structured_output_result") continue;
    const classified = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (classified.kind !== "accepted") continue;
    let value = classified.value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).operationToken === token
    ) {
      return value;
    }
  }
  return null;
}

function terminalTaskState(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return {
    completed: ["completed", "complete", "finished", "done", "success"].includes(
      normalized,
    ),
    failed: ["failed", "error", "cancelled", "canceled", "stopped"].includes(
      normalized,
    ),
  };
}

export function safePublicDocuments(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
) {
  return snapshot.documents
    .filter(
      (document) =>
        document.customerVisible !== false &&
        document.kind !== "evidence" &&
        // dashboard-core-v1 uses needs_verification for customer-confirmed
        // facts whose external evidence is incomplete. They remain usable as
        // customer-approved source material, with their ids preserved. Only
        // inferred content is excluded from the generation prompt.
        document.evidenceStatus !== "inferred",
    )
    .slice(0, 80)
    .map((document) => ({
      id: String(document.id || document.path).slice(0, 191),
      path: document.path,
      title: document.title,
      content: document.content.slice(0, 20_000),
      kind: document.kind,
      customerVisible: true,
    }));
}

export function frozenAssetDecisions(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
  brief: z.infer<typeof siteBriefSchema>,
) {
  const publish = new Set(brief.publicAssetIds);
  let publishedOfficialLogo = false;
  return snapshot.assets.flatMap((asset) => {
    if (!asset.id || !asset.sha256 || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
      return [];
    }
    const isOfficialLogo =
      asset.sourceKind === "official_logo_upload" ||
      (asset.ownership === "first_party" &&
        /logo/iu.test(`${asset.key} ${asset.path}`));
    const shouldPublish =
      isOfficialLogo && publish.has(asset.id) && !publishedOfficialLogo;
    if (shouldPublish) publishedOfficialLogo = true;
    return [
      {
        id: asset.id,
        sha256: asset.sha256.toLowerCase(),
        decision:
          shouldPublish
            ? ("publish" as const)
            : ("quarantine" as const),
      },
    ];
  });
}

export function briefWithoutBrandAssets(brief: z.infer<typeof siteBriefSchema>) {
  return { ...brief, publicAssetIds: [] };
}

function designOutputSchema(token: string): ManusV2StructuredOutputSchema {
  return {
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [token] },
      designSystem: {
        type: "object",
        properties: {
          visualDirection: { type: "string" },
          informationHierarchy: { type: "string" },
          contentTone: { type: "string" },
        },
        required: ["visualDirection", "informationHierarchy", "contentTone"],
        additionalProperties: false,
      },
      seoPlan: {
        type: "object",
        properties: {
          siteTitle: { type: "string" },
          description: { type: "string" },
          organizationType: {
            type: "string",
            enum: ["Organization", "Corporation", "ProfessionalService"],
          },
        },
        required: ["siteTitle", "description", "organizationType"],
        additionalProperties: false,
      },
    },
    required: ["operationToken", "designSystem", "seoPlan"],
    additionalProperties: false,
  };
}

function generatedContentOutputSchema(token: string, routeIds: string[]) {
  return {
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [token] },
      seo: {
        type: "object",
        properties: {
          siteTitle: { type: "string" },
          description: { type: "string" },
          organizationType: {
            type: "string",
            enum: ["Organization", "Corporation", "ProfessionalService"],
          },
        },
        required: ["siteTitle", "description", "organizationType"],
        additionalProperties: false,
      },
      routes: {
        type: "array",
        minItems: routeIds.length,
        maxItems: routeIds.length,
        items: {
          type: "object",
          properties: {
            routeId: { type: "string", enum: routeIds },
            eyebrow: { type: "string" },
            heading: { type: "string" },
            summary: { type: "string" },
            sections: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: {
                type: "object",
                properties: {
                  heading: { type: "string" },
                  paragraphs: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: { type: "string" },
                  },
                  sourceDocumentIds: {
                    type: "array",
                    minItems: 1,
                    maxItems: 30,
                    items: { type: "string" },
                  },
                },
                required: ["heading", "paragraphs", "sourceDocumentIds"],
                additionalProperties: false,
              },
            },
          },
          required: ["routeId", "heading", "summary", "sections"],
          additionalProperties: false,
        },
      },
    },
    required: ["operationToken", "seo", "routes"],
    additionalProperties: false,
  } satisfies ManusV2StructuredOutputSchema;
}

function socialOutputSchema(
  token: string,
  channel: "wechat" | "xiaohongshu",
  sourceDocumentIds: string[],
) {
  return {
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [token] },
      companyName: { type: "string" },
      title: { type: "string" },
      deck: { type: "string" },
      sourceDocuments: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: sourceDocumentIds },
            title: { type: "string" },
            sha256: { type: "string" },
          },
          required: ["id", "title"],
          additionalProperties: false,
        },
      },
      sections: {
        type: "array",
        minItems: channel === "xiaohongshu" ? 8 : 1,
        maxItems: channel === "xiaohongshu" ? 8 : 20,
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            paragraphs: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
            sourceDocumentIds: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", enum: sourceDocumentIds },
            },
          },
          required: ["heading", "paragraphs", "sourceDocumentIds"],
          additionalProperties: false,
        },
      },
      hashtags: { type: "array", maxItems: 10, items: { type: "string" } },
    },
    required: [
      "operationToken",
      "companyName",
      "title",
      "deck",
      "sourceDocuments",
      "sections",
      "hashtags",
    ],
    additionalProperties: false,
  } satisfies ManusV2StructuredOutputSchema;
}

async function findUniqueCreatedTask(
  client: ManusV2Client,
  operation: SiteOperation,
  token: string,
) {
  const result = await client.findCreatedTask({
    title: operationTitle(operation),
    operationToken: token,
    createdAfterSeconds: Math.floor(operation.createdAt.getTime() / 1_000) - 300,
  });
  if (result.matches.length > 1) {
    throw new SiteOpsManusFailure(
      "MANUS_CREATE_RECONCILIATION_AMBIGUOUS",
      "找到多个同一建站操作的 Manus 任务，已停止自动推进以避免使用错误结果。",
    );
  }
  return result.unique;
}

async function loadBuildContext(db: any, operation: SiteOperation) {
  if (!operation.buildId) throw new SiteOpsManusFailure("BUILD_ID_MISSING", "建站操作缺少版本标识。", "failed");
  const rows = await db
    .select({ build: siteBuilds, project: siteProjects, snapshot: knowledgeBaseSnapshots, sample: websiteStyleSamples })
    .from(siteBuilds)
    .innerJoin(siteProjects, eq(siteProjects.id, siteBuilds.projectId))
    .innerJoin(knowledgeBaseSnapshots, eq(knowledgeBaseSnapshots.id, siteBuilds.knowledgeSnapshotId))
    .innerJoin(websiteStyleSamples, eq(websiteStyleSamples.id, siteBuilds.styleSampleId))
    .where(and(eq(siteBuilds.id, operation.buildId), eq(siteBuilds.userId, operation.userId)))
    .limit(1);
  const context = rows[0];
  if (!context) throw new SiteOpsManusFailure("BUILD_CONTEXT_NOT_FOUND", "官网版本或视觉方向不存在。", "failed");
  if (context.snapshot.archiveHash !== context.build.knowledgeArchiveHash) {
    throw new SiteOpsManusFailure("KNOWLEDGE_ARCHIVE_HASH_MISMATCH", "知识库 ZIP 哈希与冻结版本不一致。", "failed");
  }
  return context;
}

async function assertFrozenCredential(input: z.infer<typeof operationInputSchema>, getCredential: typeof getPresalesCredentialById) {
  const credential = await getCredential(input.manusCredentialId);
  if (!credential || credential.version !== input.manusCredentialVersion) {
    throw new SiteOpsManusFailure("MANUS_CREDENTIAL_VERSION_UNAVAILABLE", "建站任务绑定的 Manus 凭据版本不可用。", "attention_required");
  }
  return credential;
}

function stateFromOperation(operation: SiteOperation): ProviderState | null {
  const parsed = providerStateSchema.safeParse(operation.result);
  return parsed.success ? parsed.data : null;
}

async function persistOperationProgress(
  db: any,
  operation: SiteOperation,
  state: ProviderState,
  taskId?: string,
) {
  if (!operation.leaseOwner) {
    throw new SiteOpsManusFailure(
      "MANUS_OPERATION_LEASE_MISSING",
      "建站操作缺少有效租约，未调用外部服务。",
    );
  }
  await db
    .update(siteOperations)
    .set({
      result: state,
      ...(taskId ? { providerTaskId: taskId } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(siteOperations.id, operation.id),
        eq(siteOperations.status, "running"),
        eq(siteOperations.leaseOwner, operation.leaseOwner),
      ),
    );
}

async function pollEvents(client: ManusV2Client, taskId: string) {
  const [detail, events] = await Promise.all([
    client.taskDetail(taskId),
    client.listAllMessages({ taskId, order: "asc" }),
  ]);
  return { detail, events, state: terminalTaskState(latestManusV2TaskState(events) ?? detail.status) };
}

function pending(state: ProviderState, taskId?: string, buildStatus?: "design_compiling" | "contract_ready" | "building" | "qa_running"): SiteOpsProviderResult {
  return {
    status: "pending",
    result: state,
    providerTaskId: taskId,
    nextPollMs: 10_000,
    projectStatus: "building",
    buildStatus,
  };
}

async function scheduleRepair(input: {
  db: any;
  operation: SiteOperation;
  build: typeof siteBuilds.$inferSelect;
  taskId: string;
  kind: "design" | "content";
  design?: z.infer<typeof designResultSchema>;
}) {
  const attempt = input.build.repairAttempts + 1;
  if (attempt > 3) {
    throw new SiteOpsManusFailure(
      "MANUS_REPAIR_LIMIT_EXCEEDED",
      "同一 Manus 建站任务已自动修复 3 次，仍未通过结构或 QA 校验。",
      "failed",
    );
  }
  await input.db
    .update(siteBuilds)
    .set({ repairAttempts: attempt, updatedAt: new Date() })
    .where(
      and(
        eq(siteBuilds.id, input.build.id),
        eq(siteBuilds.repairAttempts, input.build.repairAttempts),
      ),
    );
  return pending(
    {
      schemaVersion: 1,
      stage: "repair_send_ready",
      taskId: input.taskId,
      design: input.design,
      repairKind: input.kind,
      repairAttempt: attempt,
    },
    input.taskId,
    input.kind === "design" ? "design_compiling" : "qa_running",
  );
}

async function persistBuildArtifacts(
  db: any,
  operation: SiteOperation,
  materialized: Awaited<ReturnType<typeof materializeAstroSite>>,
  persist: typeof persistSiteOpsArtifact,
) {
  const common = { userId: operation.userId, projectId: operation.projectId };
  const [contract, source, dist, qa, provenance] = await Promise.all([
    persist({ ...common, kind: "site-contract", filename: `build-${operation.buildId}-contract.json`, mimeType: "application/json", buffer: materialized.contractJson }),
    persist({ ...common, kind: "site-source", filename: `build-${operation.buildId}-source.zip`, mimeType: "application/zip", buffer: materialized.sourceZip }),
    persist({ ...common, kind: "site-dist", filename: `build-${operation.buildId}-dist.zip`, mimeType: "application/zip", buffer: materialized.distZip }),
    persist({ ...common, kind: "site-qa", filename: `build-${operation.buildId}-visual-qa.zip`, mimeType: "application/zip", buffer: materialized.visualQaZip }),
    persist({ ...common, kind: "site-provenance", filename: `build-${operation.buildId}-provenance.json`, mimeType: "application/json", buffer: materialized.provenanceJson }),
  ]);
  if (
    contract.contentSha256 !== materialized.contractSha256 ||
    source.contentSha256 !== materialized.sourceSha256 ||
    dist.contentSha256 !== materialized.distSha256 ||
    qa.contentSha256 !== materialized.visualQaSha256 ||
    provenance.contentSha256 !== materialized.provenanceSha256
  ) {
    throw new SiteOpsManusFailure("BUILD_ARTIFACT_HASH_MISMATCH", "官网产物写入后的哈希校验失败。", "failed");
  }
  await db
    .update(siteBuilds)
    .set({
      contractLocalAssetId: contract.id,
      contractHash: materialized.contractSha256,
      sourceLocalAssetId: source.id,
      sourceHash: materialized.sourceSha256,
      distLocalAssetId: dist.id,
      distHash: materialized.distSha256,
      qaLocalAssetId: qa.id,
      provenanceLocalAssetId: provenance.id,
      status: "preview_ready",
      updatedAt: new Date(),
    })
    .where(and(eq(siteBuilds.id, operation.buildId!), eq(siteBuilds.userId, operation.userId)));
  return {
    contract,
    source,
    dist,
    qa,
    provenance,
    qaSummary: JSON.parse(materialized.qaJson.toString("utf8")) as Record<
      string,
      unknown
    >,
  };
}

function resultFailure(error: unknown): SiteOpsProviderResult {
  if (error instanceof SiteOpsManusFailure) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ManusV2ApiError) {
    return {
      status: error.outcomeUnknown ? "outcome_unknown" : "attention_required",
      code: error.code,
      message: error.outcomeUnknown
        ? "Manus 外部操作结果未知，系统已停止重发并等待对账。"
        : "Manus 暂时无法完成该任务，请稍后重试或由运营人员处理。",
    };
  }
  return {
    status: "attention_required",
    code: "MANUS_SITEOPS_FAILED",
    message: error instanceof Error ? error.message.slice(0, 2_000) : "Manus 建站任务失败。",
  };
}

export function createManusSiteOpsProviderHandler(
  dependencies: ManusProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const getCredential = dependencies.getCredential ?? getPresalesCredentialById;
  const createClient = dependencies.createClient ?? ((input) => new ManusV2Client({ baseUrl: baseUrl(), apiKey: input.apiKey, rateLimitScope: input.credentialId, timeoutMs: 30_000 }));
  const readArchive = dependencies.readSnapshotArchive ?? readKnowledgeSnapshotArchive;
  const persist = dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const materialize = dependencies.materializeSite ?? materializeAstroSite;
  const socialGenerate = dependencies.generateSocial ?? generateSocialPackage;

  return async ({ operation }) => {
    try {
      const db = await dbGetter();
      if (!db) throw new SiteOpsManusFailure("DATABASE_UNAVAILABLE", "AI 建站数据库暂时不可用。");
      const input = operationInputSchema.parse(operation.input);
      const credential = await assertFrozenCredential(input, getCredential);
      const client = createClient({ apiKey: credential.apiKey, credentialId: credential.id });
      const state = stateFromOperation(operation);

      if (operation.kind === "social_package") {
        const rows = await db
          .select({ package: socialPackages, snapshot: knowledgeBaseSnapshots, project: siteProjects })
          .from(socialPackages)
          .innerJoin(knowledgeBaseSnapshots, eq(knowledgeBaseSnapshots.id, socialPackages.knowledgeSnapshotId))
          .innerJoin(siteProjects, eq(siteProjects.id, socialPackages.projectId))
          .where(and(eq(socialPackages.operationId, operation.id), eq(socialPackages.userId, operation.userId)))
          .limit(1);
        const context = rows[0];
        if (!context) throw new SiteOpsManusFailure("SOCIAL_CONTEXT_NOT_FOUND", "社媒内容包上下文不存在。", "failed");
        const token = `siteops-social:${operation.id}`;
        let taskId = state?.taskId ?? operation.providerTaskId ?? undefined;
        if (!taskId) {
          if (state?.stage === "create_unknown") {
            const found = await findUniqueCreatedTask(client, operation, token);
            if (!found) return pending({ schemaVersion: 1, stage: "create_unknown" });
            taskId = found.id;
          } else {
            const documents = safePublicDocuments(context.snapshot);
            const socialWorkflow =
              await loadVerifiedSiteOpsSocialWorkflowPackage(
                context.package.channel,
              );
            const prompt = promptWithMarker(
              `你是企业内容编辑。必须遵守附件中经 manifest 校验的 FrontMind ${context.package.channel} 内容包 workflow、SKILL.md 与 runtime-contract.json。仅根据下列已验证知识资料生成${context.package.channel === "wechat" ? "微信公众号文章及三张封面所需文案" : "小红书九页图文（封面加八节）"}。不得编造数字、客户、资质或案例，不得请求账号凭据、排期或执行发布。主题：${input.topic || "基于企业知识库选择最有价值的主题"}\n\n知识资料：\n${JSON.stringify(documents)}`,
              token,
            );
            await persistOperationProgress(db, operation, {
              schemaVersion: 1,
              stage: "create_unknown",
            });
            try {
              const created = await client.createTask({
                title: operationTitle(operation),
                prompt,
                attachments: [
                  socialWorkflowAttachment(
                    context.package.channel,
                    socialWorkflow,
                  ),
                ],
                locale: "zh-CN",
                structuredOutputSchema: socialOutputSchema(
                  token,
                  context.package.channel,
                  documents.map((document) => document.id),
                ),
              });
              taskId = created.taskId;
            } catch (error) {
              if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
                return pending({ schemaVersion: 1, stage: "create_unknown" });
              }
              throw error;
            }
            await persistOperationProgress(
              db,
              operation,
              { schemaVersion: 1, stage: "content_pending", taskId },
              taskId,
            );
            return pending({ schemaVersion: 1, stage: "content_pending", taskId }, taskId);
          }
        }
        const polled = await pollEvents(client, taskId);
        const value = acceptedStructuredValue(polled.events, token);
        if (!value) {
          if (polled.state.failed) throw new SiteOpsManusFailure("MANUS_SOCIAL_TASK_FAILED", "Manus 未生成可验证的社媒结构化内容。", "failed");
          return pending({ schemaVersion: 1, stage: "content_pending", taskId }, taskId);
        }
        const record = value as Record<string, unknown>;
        const generatedInput = socialPackageInputSchema.parse({
          channel: context.package.channel,
          companyName: record.companyName,
          title: record.title,
          deck: record.deck,
          sourceDocuments: record.sourceDocuments,
          sections: record.sections,
          hashtags: record.hashtags,
        });
        const verifiedIds = new Set(
          safePublicDocuments(context.snapshot).map((document) => document.id),
        );
        if (
          generatedInput.sourceDocuments.some(
            (document) => !verifiedIds.has(document.id),
          )
        ) {
          throw new SiteOpsManusFailure(
            "SOCIAL_SOURCE_NOT_VERIFIED",
            "社媒内容引用了知识库之外的来源。",
            "failed",
          );
        }
        const generated = await socialGenerate(generatedInput);
        const archive = await persist({ userId: operation.userId, projectId: operation.projectId, kind: "social-archive", filename: `${context.package.channel}-${context.package.id}.zip`, mimeType: "application/zip", buffer: generated.archive });
        const previews = await Promise.all(generated.previews.map((preview, index) => persist({ userId: operation.userId, projectId: operation.projectId, kind: "social-preview", filename: `${context.package.channel}-${context.package.id}-${String(index + 1).padStart(2, "0")}.png`, mimeType: preview.mimeType, buffer: preview.buffer })));
        if (archive.contentSha256 !== generated.archiveSha256) throw new SiteOpsManusFailure("SOCIAL_ARCHIVE_HASH_MISMATCH", "社媒 ZIP 写入校验失败。", "failed");
        await db.update(socialPackages).set({
          manifest: generated.manifest,
          manifestHash: generated.manifestSha256,
          archiveLocalAssetId: archive.id,
          archiveHash: generated.archiveSha256,
          previewLocalAssetIds: previews.map((item) => item.id),
          qa: generated.qa,
          status: "ready",
          updatedAt: new Date(),
        }).where(eq(socialPackages.id, context.package.id));
        return { status: "succeeded", providerTaskId: taskId, socialPackageStatus: "ready", result: { packageId: context.package.id, archiveHash: generated.archiveSha256, previewCount: previews.length }, message: "社媒内容包已通过来源与结构校验，可以预览和下载。" };
      }

      if (!operation.kind.includes("build")) throw new SiteOpsManusFailure("MANUS_OPERATION_KIND_UNSUPPORTED", "Manus SiteOps 适配器不支持该操作。", "failed");
      const context = await loadBuildContext(db, operation);
      const archiveBytes = await readArchive({ userId: operation.userId, snapshotId: context.snapshot.id, expectedSha256: context.snapshot.archiveHash!, expectedBytes: context.snapshot.totalBytes });
      const brief = siteBriefSchema.parse(context.build.brief);
      const promptBrief = briefWithoutBrandAssets(brief);
      const assetDecisions = frozenAssetDecisions(context.snapshot, brief);
      const brandAsset = await readSelectedOfficialLogoFromKnowledgeArchive({
        archiveBytes,
        assets: context.snapshot.assets,
        decisions: assetDecisions,
      });
      const metadata = context.sample.sourceMetadata;
      if (!metadata || !context.sample.previewLocalAssetId) throw new SiteOpsManusFailure("VISUAL_SELECTION_INCOMPLETE", "冻结的视觉选择缺少可信元数据。", "failed");
      const rawTaxonomy = metadata.taxonomy;
      const taxonomy = visualTaxonomySchema.parse({
        role: rawTaxonomy.role,
        palette: rawTaxonomy.palette,
        typography: rawTaxonomy.typography,
        layout: rawTaxonomy.layout,
        motion: rawTaxonomy.motion,
        accessibility: rawTaxonomy.accessibility,
      });
      const documents = safePublicDocuments(context.snapshot);
      const workflowPackage = await loadVerifiedSiteOpsWorkflowPackage();
      const previewArtifact = await import("./artifact-store").then(
        ({ readSiteOpsArtifact }) =>
          readSiteOpsArtifact({
            userId: operation.userId,
            localAssetId: context.sample.previewLocalAssetId!,
            expectedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          }),
      );
      if (!previewArtifact) {
        throw new SiteOpsManusFailure(
          "VISUAL_PREVIEW_NOT_FOUND",
          "视觉预览资产不存在。",
          "failed",
        );
      }
      const visual = {
        queryHash:
          context.build.selectionHash ?? sha256(context.sample.batchId),
        selectedCandidateId: context.sample.id,
        promptSha256: metadata.promptSha256,
        previewSha256: previewArtifact.row.contentSha256,
        taxonomy,
      };
      const designToken = `siteops-design:${operation.id}`;
      const contentToken = `siteops-content:${operation.id}`;
      let taskId = state?.taskId ?? operation.providerTaskId ?? undefined;

      if (!taskId) {
        if (state?.stage === "create_unknown") {
          const found = await findUniqueCreatedTask(client, operation, designToken);
          if (!found) return pending({ schemaVersion: 1, stage: "create_unknown" }, undefined, "design_compiling");
          taskId = found.id;
        } else {
          const prompt = promptWithMarker(
            `你是 FrontMind 官网信息架构师。必须遵守附件中经 manifest 校验的 FrontMind Astro Company Site Workflow ${SITEOPS_WORKFLOW.frontMindVersion}、SKILL.md 和 runtime-contract.json。根据已验证 SiteBrief、视觉 taxonomy 和知识资料输出设计系统摘要与 SEO 计划。不要生成源码、依赖、脚本或 21st 组件代码；不要扩写未知事实。\n\nSiteBrief：${JSON.stringify(promptBrief)}\n视觉 taxonomy：${JSON.stringify(taxonomy)}\n知识资料：${JSON.stringify(documents)}`,
            designToken,
          );
          await persistOperationProgress(db, operation, {
            schemaVersion: 1,
            stage: "create_unknown",
          });
          try {
            const created = await client.createTask({
              title: operationTitle(operation),
              prompt,
              attachments: [workflowAttachment(workflowPackage)],
              locale: brief.primaryLanguage,
              structuredOutputSchema: designOutputSchema(designToken),
            });
            taskId = created.taskId;
            await db.update(siteBuilds).set({ upstreamManusTaskId: taskId, status: "design_compiling", updatedAt: new Date() }).where(eq(siteBuilds.id, context.build.id));
          } catch (error) {
            if (error instanceof ManusV2ApiError && error.outcomeUnknown) return pending({ schemaVersion: 1, stage: "create_unknown" }, undefined, "design_compiling");
            throw error;
          }
          await persistOperationProgress(
            db,
            operation,
            { schemaVersion: 1, stage: "design_pending", taskId },
            taskId,
          );
          return pending({ schemaVersion: 1, stage: "design_pending", taskId }, taskId, "design_compiling");
        }
      }

      if (context.build.upstreamManusTaskId !== taskId) {
        await db
          .update(siteBuilds)
          .set({ upstreamManusTaskId: taskId, updatedAt: new Date() })
          .where(eq(siteBuilds.id, context.build.id));
      }
      let repairedContent: unknown = null;
      if (
        state?.stage === "repair_send_ready" ||
        state?.stage === "repair_send_unknown" ||
        state?.stage === "repair_pending"
      ) {
        if (!state.repairKind || !state.repairAttempt) {
          throw new SiteOpsManusFailure(
            "MANUS_REPAIR_STATE_INVALID",
            "Manus 自动修复状态不完整。",
            "failed",
          );
        }
        const repairToken = `siteops-repair:${operation.id}:${state.repairKind}:${state.repairAttempt}`;
        const repairSchema =
          state.repairKind === "design"
            ? designOutputSchema(repairToken)
            : generatedContentOutputSchema(
                repairToken,
                brief.routes.map((route) => route.id),
              );
        if (state.stage === "repair_send_ready") {
          const repairPrompt = promptWithMarker(
            state.repairKind === "design"
              ? `继续同一个 FrontMind 建站任务。上一次设计/SEO 结构未通过严格契约。第 ${state.repairAttempt}/3 次修复：重新输出完整设计系统与 SEO 结构；继续遵守已附加的 FrontMind workflow，不得输出源码或未知事实。SiteBrief：${JSON.stringify(promptBrief)}\n视觉 taxonomy：${JSON.stringify(taxonomy)}`
              : `继续同一个 FrontMind 建站任务。上一次官网正文或 Astro/SEO/视觉 QA 未通过。第 ${state.repairAttempt}/3 次修复：重新输出所有 route 的完整结构化正文，严格使用允许的 routeId 与 sourceDocumentIds，不得输出源码、脚本或未知事实。设计摘要：${JSON.stringify(state.design)}\nSiteBrief：${JSON.stringify(promptBrief)}\n知识资料：${JSON.stringify(documents)}`,
            repairToken,
          );
          const unknownState: ProviderState = {
            ...state,
            stage: "repair_send_unknown",
          };
          await persistOperationProgress(
            db,
            operation,
            unknownState,
            taskId,
          );
          try {
            await client.sendMessage({
              taskId,
              prompt: repairPrompt,
              structuredOutputSchema: repairSchema,
            });
          } catch (error) {
            if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
              return pending(
                unknownState,
                taskId,
                state.repairKind === "design"
                  ? "design_compiling"
                  : "qa_running",
              );
            }
            throw error;
          }
          const waitingState: ProviderState = {
            ...state,
            stage: "repair_pending",
          };
          await persistOperationProgress(
            db,
            operation,
            waitingState,
            taskId,
          );
          return pending(
            waitingState,
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        if (state.stage === "repair_send_unknown") {
          const events = await client.listAllMessages({
            taskId,
            order: "asc",
            stopAfterOperationToken: repairToken,
          });
          if (!manusV2EventsContainOperationToken(events, repairToken)) {
            return pending(
              state,
              taskId,
              state.repairKind === "design"
                ? "design_compiling"
                : "qa_running",
            );
          }
          return pending(
            { ...state, stage: "repair_pending" },
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        const repaired = await pollEvents(client, taskId);
        const rawRepair = acceptedStructuredValue(repaired.events, repairToken);
        if (!rawRepair) {
          if (repaired.state.failed) {
            return scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              design: state.design,
            });
          }
          return pending(
            state,
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        if (state.repairKind === "design") {
          try {
            const repairedDesign = designResultSchema.parse(rawRepair);
            return pending(
              {
                schemaVersion: 1,
                stage: "content_send_ready",
                taskId,
                design: repairedDesign,
              },
              taskId,
              "contract_ready",
            );
          } catch {
            return scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
            });
          }
        }
        repairedContent = rawRepair;
      }
      let design = state?.design;
      if (!design && repairedContent === null) {
        const polled = await pollEvents(client, taskId);
        const raw = acceptedStructuredValue(polled.events, designToken);
        if (!raw) {
          if (polled.state.failed) {
            return scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
            });
          }
          return pending({ schemaVersion: 1, stage: "design_pending", taskId }, taskId, "design_compiling");
        }
        try {
          design = designResultSchema.parse(raw);
        } catch {
          return scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "design",
          });
        }
        return pending({ schemaVersion: 1, stage: "content_send_ready", taskId, design }, taskId, "contract_ready");
      }

      if (state?.stage === "content_send_ready") {
        if (!design) {
          throw new SiteOpsManusFailure(
            "MANUS_DESIGN_STATE_MISSING",
            "同一 Manus 任务缺少已校验的设计合同。",
            "failed",
          );
        }
        const revisionInstruction = input.feedback ? `客户本次修改要求：${input.feedback}` : "这是首版官网内容。";
        const canonicalContract = composeBuildContractV1({
          schemaVersion: 1,
          source: {
            knowledgeSnapshotId: context.snapshot.id,
            archiveSha256: context.build.knowledgeArchiveHash,
            sourceBuildId: context.snapshot.sourceBuildId,
            sourceBuildRevision: context.snapshot.sourceBuildRevision,
          },
          workflow: {
            upstreamSha256: SITEOPS_WORKFLOW.upstreamSha256,
            version: SITEOPS_WORKFLOW.frontMindVersion,
            packageSha256: SITEOPS_WORKFLOW.runtimeManifestSha256,
            starterVersion: SITEOPS_WORKFLOW.starterVersion,
          },
          identity: {
            companyName: brief.companyName,
            primaryLanguage: brief.primaryLanguage,
            verifiedContacts: brief.contacts.map(
              (contact) => `${contact.kind}:${contact.value}`,
            ),
          },
          visual,
          routes: brief.routes,
          assets: [],
          seo: {
            ...design.seoPlan,
            environment: "preview",
            canonicalPolicy: "forbidden",
          },
          target: { environment: "preview", canonicalOrigin: null },
          qaPolicyVersion: SITEOPS_WORKFLOW.qaPolicyVersion,
        });
        const prompt = promptWithMarker(
          `继续同一个建站任务。以下 canonical build-contract.json 已由 Dashboard 根据受信 workflow 生成并校验，必须遵守：${canonicalJson(canonicalContract)}。请仅输出各路由的静态官网正文与 SEO 字段；routeId 必须与 SiteBrief 完全一致，每段关键内容必须引用给定 sourceDocumentIds。不得生成源码、依赖、表单提交、外部脚本或未知事实。${revisionInstruction}\n\nSiteBrief：${JSON.stringify(promptBrief)}\n知识资料：${JSON.stringify(documents)}`,
          contentToken,
        );
        await persistOperationProgress(
          db,
          operation,
          {
            schemaVersion: 1,
            stage: "content_send_unknown",
            taskId,
            design,
          },
          taskId,
        );
        try {
          await client.sendMessage({ taskId, prompt, structuredOutputSchema: generatedContentOutputSchema(contentToken, brief.routes.map((route) => route.id)) });
        } catch (error) {
          if (error instanceof ManusV2ApiError && error.outcomeUnknown) return pending({ schemaVersion: 1, stage: "content_send_unknown", taskId, design }, taskId, "building");
          throw error;
        }
        await persistOperationProgress(
          db,
          operation,
          {
            schemaVersion: 1,
            stage: "content_pending",
            taskId,
            design,
          },
          taskId,
        );
        return pending({ schemaVersion: 1, stage: "content_pending", taskId, design }, taskId, "building");
      }

      if (state?.stage === "content_send_unknown") {
        const events = await client.listAllMessages({ taskId, order: "asc", stopAfterOperationToken: contentToken });
        if (!manusV2EventsContainOperationToken(events, contentToken)) return pending({ schemaVersion: 1, stage: "content_send_unknown", taskId, design }, taskId, "building");
        return pending({ schemaVersion: 1, stage: "content_pending", taskId, design }, taskId, "building");
      }

      const polled =
        repairedContent === null ? await pollEvents(client, taskId) : null;
      const rawContent =
        repairedContent ?? acceptedStructuredValue(polled!.events, contentToken);
      if (!rawContent) {
        if (polled!.state.failed) {
          return scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            design,
          });
        }
        return pending({ schemaVersion: 1, stage: "content_pending", taskId, design }, taskId, "building");
      }
      const rawRecord = rawContent as Record<string, unknown>;
      let generatedContent: z.infer<typeof siteOpsGeneratedContentSchema>;
      try {
        generatedContent = siteOpsGeneratedContentSchema.parse({
          // Dashboard owns the contract. Provider SEO drift cannot change the
          // canonical contract sent to this same task.
          seo: design!.seoPlan,
          routes: rawRecord.routes,
        });
      } catch {
        return scheduleRepair({
          db,
          operation,
          build: context.build,
          taskId,
          kind: "content",
          design,
        });
      }
      await db.update(siteBuilds).set({ status: "qa_running", updatedAt: new Date() }).where(eq(siteBuilds.id, context.build.id));
      let materialized: Awaited<ReturnType<typeof materializeAstroSite>>;
      try {
        materialized = await materialize({
          build: context.build,
          snapshot: { ...context.snapshot, documents },
          brief,
          visual,
          generatedContent,
          assetDecisions,
          brandAsset,
          mode: "preview",
        });
      } catch {
        return scheduleRepair({
          db,
          operation,
          build: context.build,
          taskId,
          kind: "content",
          design,
        });
      }
      const artifacts = await persistBuildArtifacts(db, operation, materialized, persist);
      return {
        status: "succeeded",
        providerTaskId: taskId,
        projectStatus: "preview_ready",
        buildStatus: "preview_ready",
        result: { buildId: context.build.id, specHash: materialized.contract.specHash, distHash: materialized.distSha256, qaSummary: artifacts.qaSummary, artifactIds: { contract: artifacts.contract.id, source: artifacts.source.id, dist: artifacts.dist.id, qa: artifacts.qa.id, provenance: artifacts.provenance.id } },
        message: "原生 Astro 官网已完成构建和 QA，可以在私有预览中检查并批准。",
      };
    } catch (error) {
      return resultFailure(error);
    }
  };
}

let registered = false;

export function registerManusSiteOpsProvider(dependencies: ManusProviderDependencies = {}) {
  if (registered) return () => undefined;
  const unregister = registerSiteOpsProviderHandler("manus", createManusSiteOpsProviderHandler(dependencies));
  registered = true;
  return () => {
    unregister();
    registered = false;
  };
}
