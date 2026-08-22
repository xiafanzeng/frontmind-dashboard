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
  websiteStyleSampleBatches,
  websiteStyleSamples,
  type SiteOperation,
} from "../../drizzle/schema";
import {
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  visualEvidenceV1Schema,
  visualSelectionBundleSchema,
  visualTaxonomySchema,
  type VisualSelectionBundle,
  type VisualSelectionBundleV1,
  type VisualSelectionBundleV2,
} from "../../shared/siteops";
import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";
import {
  canonicalSiteOpsSha256,
  composeBuildContractV2,
  pageContentResultV1Schema,
  siteDesignResultV1Schema,
  siteOpsRuntimeVisualEvidenceV1Schema,
  validateDesignAndContentBindings,
} from "../../shared/siteops-design";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
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
import { persistSiteOpsArtifact, readSiteOpsArtifact } from "./artifact-store";
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

const designResultSchema = siteDesignResultV1Schema;

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
  createClient?: (input: {
    apiKey: string;
    credentialId: string;
  }) => ManusV2Client;
  readSnapshotArchive?: typeof readKnowledgeSnapshotArchive;
  persistArtifact?: typeof persistSiteOpsArtifact;
  readArtifact?: typeof readSiteOpsArtifact;
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
      `dist/private-workflows/astro-company-site-workflow-v${SITEOPS_WORKFLOW.frontMindVersion}`,
    ),
    path.resolve(
      process.cwd(),
      `private-workflows/astro-company-site-workflow-v${SITEOPS_WORKFLOW.frontMindVersion}`,
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
        `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流未进入运行镜像。`,
      );
    }
    if (sha256(manifestBytes) !== SITEOPS_WORKFLOW.runtimeManifestSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_MANIFEST_MISMATCH",
        `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流 manifest 哈希不一致。`,
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
        host: z
          .object({
            starterSha256: z.literal(SITEOPS_WORKFLOW.starterSha256),
            componentLibraryVersion: z.literal(
              SITEOPS_WORKFLOW.componentLibraryVersion,
            ),
            materializerVersion: z.literal(
              SITEOPS_WORKFLOW.materializerVersion,
            ),
            materializerSha256: z.literal(SITEOPS_WORKFLOW.materializerSha256),
          })
          .strict(),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(512),
              bytes: z
                .number()
                .int()
                .positive()
                .max(5 * 1024 * 1024),
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
        entry.path
          .split("/")
          .some((segment) => segment === ".." || segment === ".") ||
        entry.path.normalize("NFKC") !== entry.path
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流包含不安全路径。`,
          "failed",
        );
      }
      const absolute = path.resolve(root, entry.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流路径越界。`,
          "failed",
        );
      }
      const fileStat = await lstat(absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_INVALID",
          `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流包含非普通文件。`,
          "failed",
        );
      }
      const bytes = await readFile(absolute);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_MISMATCH",
          `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流文件校验失败：${entry.path}`,
          "failed",
        );
      }
      total += bytes.length;
      if (total > 18 * 1024 * 1024) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PACKAGE_TOO_LARGE",
          `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流超过附件上限。`,
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
        `FrontMind ${SITEOPS_WORKFLOW.frontMindVersion} 建站工作流缺少 SKILL 或 runtime contract。`,
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

async function storedArtifactBytes(
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>,
) {
  if (
    artifact.stored.sizeBytes < 1 ||
    artifact.stored.sizeBytes > 8 * 1024 * 1024
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_PREVIEW_ATTACHMENT_INVALID",
      "冻结的视觉预览超过建站任务附件上限。",
      "failed",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of artifact.stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > artifact.stored.sizeBytes || total > 8 * 1024 * 1024) {
      throw new SiteOpsManusFailure(
        "VISUAL_PREVIEW_ATTACHMENT_INVALID",
        "冻结的视觉预览读取结果不一致。",
        "failed",
      );
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== artifact.stored.sizeBytes ||
    sha256(bytes) !== artifact.row.contentSha256
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_PREVIEW_ATTACHMENT_INVALID",
      "冻结的视觉预览哈希校验失败。",
      "failed",
    );
  }
  return bytes;
}

export async function visualPreviewAttachment(
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>,
  filename: string,
) {
  const mimeType = z
    .enum(["image/png", "image/jpeg", "image/webp"])
    .parse(artifact.row.mimeType);
  const bytes = await storedArtifactBytes(artifact);
  return {
    filename,
    mime_type: mimeType,
    file_data: `data:${mimeType};base64,${bytes.toString("base64")}`,
  } as const;
}

async function readFrozenSelectionBundle(input: {
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>;
  expectedCandidateId: string;
}) {
  try {
    if (input.artifact.stored.sizeBytes > 1_000_000) {
      throw new Error("selection bundle exceeds limit");
    }
    const bytes = await storedArtifactBytes(input.artifact);
    const bundle = visualSelectionBundleSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    const candidate = bundle.candidates.find(
      (item) => item.id === input.expectedCandidateId,
    );
    if (!candidate) throw new Error("selected candidate is absent");
    return { bundle, candidate };
  } catch (error) {
    if (error instanceof SiteOpsManusFailure) throw error;
    throw new SiteOpsManusFailure(
      "VISUAL_SELECTION_BUNDLE_INVALID",
      "冻结的视觉选择合同无法通过校验。",
      "failed",
    );
  }
}

function isVisualSelectionBundleV2(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV2 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 2;
}

function visualSelectionQueryHash(bundle: VisualSelectionBundle) {
  return isVisualSelectionBundleV2(bundle)
    ? bundle.queryPlanHash
    : (bundle as VisualSelectionBundleV1).queryHash;
}

function assertProjectVisualArtifact(
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>,
  input: { userId: number; projectId: string },
) {
  if (
    artifact.row.scope !== "managed_user" ||
    artifact.row.accountUserId !== input.userId ||
    !artifact.row.storageKey.startsWith(`siteops:${input.projectId}:`)
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_PREVIEW_TENANT_MISMATCH",
      "冻结的视觉预览不属于当前建站项目。",
      "failed",
    );
  }
}

function verifiedVisualEvidence(candidate: {
  providerItemKey: string;
  previewSha256: string;
  visualEvidence: z.infer<typeof visualEvidenceV1Schema>;
}) {
  const evidence = visualEvidenceV1Schema.parse(candidate.visualEvidence);
  const recomposed = createVisualEvidenceV1({
    evidenceKind: evidence.evidenceKind,
    providerItemKey: evidence.providerItemKey,
    metadataSha256: evidence.metadataSha256,
    providerResponseSha256: evidence.providerResponseSha256,
    previewSha256: evidence.previewSha256,
    taxonomyDerivationVersion: evidence.taxonomyDerivationVersion,
  });
  if (
    recomposed.evidenceSha256 !== evidence.evidenceSha256 ||
    candidate.providerItemKey !== evidence.providerItemKey ||
    candidate.previewSha256 !== evidence.previewSha256
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_EVIDENCE_COORDINATES_MISMATCH",
      "冻结的视觉证据坐标不一致。",
      "failed",
    );
  }
  return evidence;
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
      path.resolve(
        process.cwd(),
        "dist/private-workflows",
        definition.directory,
      ),
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
        packageBytes: (await loadVerifiedSiteOpsSocialWorkflowPackage(channel))
          .length,
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

function acceptedStructuredValue(
  events: readonly ManusV2MessageEvent[],
  token: string,
) {
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
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return {
    completed: [
      "completed",
      "complete",
      "finished",
      "done",
      "success",
    ].includes(normalized),
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
        decision: shouldPublish
          ? ("publish" as const)
          : ("quarantine" as const),
      },
    ];
  });
}

export function briefWithoutBrandAssets(
  brief: z.infer<typeof siteBriefSchema>,
) {
  return { ...brief, publicAssetIds: [] };
}

function accessibleRuntimePalette(values: readonly string[]) {
  return Array.from(
    new Set(
      [
        ...values.filter((value) => /^#[a-f0-9]{6}$/iu.test(value)),
        "#F5F2EA",
        "#10212B",
        "#A33A1B",
      ].map((value) => value.toUpperCase()),
    ),
  ).slice(0, 12);
}

function designOutputSchema(
  token: string,
  routeIds: string[],
  paletteSize: number,
): ManusV2StructuredOutputSchema {
  const colorMaximum = Math.max(0, paletteSize - 1);
  return {
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [token] },
      designSpec: {
        type: "object",
        properties: {
          schemaVersion: { type: "number", enum: [1] },
          layoutArchetype: {
            type: "string",
            enum: ["hero_led", "editorial", "modular", "split", "asymmetric"],
          },
          heroVariant: {
            type: "string",
            enum: [
              "split_media",
              "centered_statement",
              "editorial_lede",
              "proof_grid",
            ],
          },
          density: {
            type: "string",
            enum: ["compact", "balanced", "spacious"],
          },
          surfaceStyle: {
            type: "string",
            enum: ["flat", "bordered", "soft_depth", "layered"],
          },
          typeScale: {
            type: "string",
            enum: ["restrained", "editorial", "display"],
          },
          imageTreatment: {
            type: "string",
            enum: ["contained", "wide", "masked", "none"],
          },
          motionLevel: { type: "string", enum: ["none", "subtle"] },
          colorRoles: {
            type: "object",
            properties: {
              backgroundPaletteIndex: {
                type: "number",
                minimum: 0,
                maximum: colorMaximum,
              },
              textPaletteIndex: {
                type: "number",
                minimum: 0,
                maximum: colorMaximum,
              },
              accentPaletteIndex: {
                type: "number",
                minimum: 0,
                maximum: colorMaximum,
              },
            },
            required: [
              "backgroundPaletteIndex",
              "textPaletteIndex",
              "accentPaletteIndex",
            ],
            additionalProperties: false,
          },
          routeCompositions: {
            type: "array",
            minItems: routeIds.length,
            maxItems: routeIds.length,
            items: {
              type: "object",
              properties: {
                routeId: { type: "string", enum: routeIds },
                slots: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: {
                    type: "object",
                    properties: {
                      slotId: {
                        type: "string",
                        pattern: "^[a-z][a-z0-9_-]{0,63}$",
                      },
                      variant: {
                        type: "string",
                        enum: [
                          "statement",
                          "split",
                          "cards",
                          "timeline",
                          "faq",
                          "proof",
                          "cta",
                        ],
                      },
                    },
                    required: ["slotId", "variant"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["routeId", "slots"],
              additionalProperties: false,
            },
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
        required: [
          "schemaVersion",
          "layoutArchetype",
          "heroVariant",
          "density",
          "surfaceStyle",
          "typeScale",
          "imageTreatment",
          "motionLevel",
          "colorRoles",
          "routeCompositions",
          "seoPlan",
        ],
        additionalProperties: false,
      },
    },
    required: ["operationToken", "designSpec"],
    additionalProperties: false,
  };
}

function generatedContentOutputSchema(
  token: string,
  routeCompositions: Array<{
    routeId: string;
    slots: Array<{ slotId: string }>;
  }>,
) {
  const routeIds = routeCompositions.map((route) => route.routeId);
  return {
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [token] },
      pageContent: {
        type: "object",
        properties: {
          schemaVersion: { type: "number", enum: [1] },
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
                      slotId: {
                        type: "string",
                        pattern: "^[a-z][a-z0-9_-]{0,63}$",
                      },
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
                    required: [
                      "slotId",
                      "heading",
                      "paragraphs",
                      "sourceDocumentIds",
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: ["routeId", "heading", "summary", "sections"],
              additionalProperties: false,
            },
          },
        },
        required: ["schemaVersion", "routes"],
        additionalProperties: false,
      },
    },
    required: ["operationToken", "pageContent"],
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
            paragraphs: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: { type: "string" },
            },
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
    createdAfterSeconds:
      Math.floor(operation.createdAt.getTime() / 1_000) - 300,
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
  if (!operation.buildId)
    throw new SiteOpsManusFailure(
      "BUILD_ID_MISSING",
      "建站操作缺少版本标识。",
      "failed",
    );
  const rows = await db
    .select({
      build: siteBuilds,
      project: siteProjects,
      snapshot: knowledgeBaseSnapshots,
      batch: websiteStyleSampleBatches,
      sample: websiteStyleSamples,
    })
    .from(siteBuilds)
    .innerJoin(siteProjects, eq(siteProjects.id, siteBuilds.projectId))
    .innerJoin(
      knowledgeBaseSnapshots,
      eq(knowledgeBaseSnapshots.id, siteBuilds.knowledgeSnapshotId),
    )
    .innerJoin(
      websiteStyleSamples,
      eq(websiteStyleSamples.id, siteBuilds.styleSampleId),
    )
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        eq(siteBuilds.id, operation.buildId),
        eq(siteBuilds.userId, operation.userId),
      ),
    )
    .limit(1);
  const context = rows[0];
  if (!context)
    throw new SiteOpsManusFailure(
      "BUILD_CONTEXT_NOT_FOUND",
      "官网版本或视觉方向不存在。",
      "failed",
    );
  if (context.snapshot.archiveHash !== context.build.knowledgeArchiveHash) {
    throw new SiteOpsManusFailure(
      "KNOWLEDGE_ARCHIVE_HASH_MISMATCH",
      "知识库 ZIP 哈希与冻结版本不一致。",
      "failed",
    );
  }
  return context;
}

async function assertFrozenCredential(
  input: z.infer<typeof operationInputSchema>,
  getCredential: typeof getPresalesCredentialById,
) {
  const credential = await getCredential(input.manusCredentialId);
  if (!credential || credential.version !== input.manusCredentialVersion) {
    throw new SiteOpsManusFailure(
      "MANUS_CREDENTIAL_VERSION_UNAVAILABLE",
      "建站任务绑定的 Manus 凭据版本不可用。",
      "attention_required",
    );
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
  return {
    detail,
    events,
    state: terminalTaskState(latestManusV2TaskState(events) ?? detail.status),
  };
}

function pending(
  state: ProviderState,
  taskId?: string,
  buildStatus?:
    | "design_compiling"
    | "contract_ready"
    | "building"
    | "qa_running",
): SiteOpsProviderResult {
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
    persist({
      ...common,
      kind: "site-contract",
      filename: `build-${operation.buildId}-contract.json`,
      mimeType: "application/json",
      buffer: materialized.contractJson,
    }),
    persist({
      ...common,
      kind: "site-source",
      filename: `build-${operation.buildId}-source.zip`,
      mimeType: "application/zip",
      buffer: materialized.sourceZip,
    }),
    persist({
      ...common,
      kind: "site-dist",
      filename: `build-${operation.buildId}-dist.zip`,
      mimeType: "application/zip",
      buffer: materialized.distZip,
    }),
    persist({
      ...common,
      kind: "site-qa",
      filename: `build-${operation.buildId}-visual-qa.zip`,
      mimeType: "application/zip",
      buffer: materialized.visualQaZip,
    }),
    persist({
      ...common,
      kind: "site-provenance",
      filename: `build-${operation.buildId}-provenance.json`,
      mimeType: "application/json",
      buffer: materialized.provenanceJson,
    }),
  ]);
  if (
    contract.contentSha256 !== materialized.contractSha256 ||
    source.contentSha256 !== materialized.sourceSha256 ||
    dist.contentSha256 !== materialized.distSha256 ||
    qa.contentSha256 !== materialized.visualQaSha256 ||
    provenance.contentSha256 !== materialized.provenanceSha256
  ) {
    throw new SiteOpsManusFailure(
      "BUILD_ARTIFACT_HASH_MISMATCH",
      "官网产物写入后的哈希校验失败。",
      "failed",
    );
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
    .where(
      and(
        eq(siteBuilds.id, operation.buildId!),
        eq(siteBuilds.userId, operation.userId),
      ),
    );
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
    message: "Manus 建站任务未能安全推进，请稍后重试或由运营人员处理。",
  };
}

export function createManusSiteOpsProviderHandler(
  dependencies: ManusProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const getCredential = dependencies.getCredential ?? getPresalesCredentialById;
  const createClient =
    dependencies.createClient ??
    ((input) =>
      new ManusV2Client({
        baseUrl: baseUrl(),
        apiKey: input.apiKey,
        rateLimitScope: input.credentialId,
        timeoutMs: 30_000,
      }));
  const readArchive =
    dependencies.readSnapshotArchive ?? readKnowledgeSnapshotArchive;
  const persist = dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const readArtifact = dependencies.readArtifact ?? readSiteOpsArtifact;
  const materialize = dependencies.materializeSite ?? materializeAstroSite;
  const socialGenerate = dependencies.generateSocial ?? generateSocialPackage;

  return async ({ operation }) => {
    try {
      const db = await dbGetter();
      if (!db)
        throw new SiteOpsManusFailure(
          "DATABASE_UNAVAILABLE",
          "AI 建站数据库暂时不可用。",
        );
      const input = operationInputSchema.parse(operation.input);
      const credential = await assertFrozenCredential(input, getCredential);
      const client = createClient({
        apiKey: credential.apiKey,
        credentialId: credential.id,
      });
      const state = stateFromOperation(operation);

      if (operation.kind === "social_package") {
        const rows = await db
          .select({
            package: socialPackages,
            snapshot: knowledgeBaseSnapshots,
            project: siteProjects,
          })
          .from(socialPackages)
          .innerJoin(
            knowledgeBaseSnapshots,
            eq(knowledgeBaseSnapshots.id, socialPackages.knowledgeSnapshotId),
          )
          .innerJoin(
            siteProjects,
            eq(siteProjects.id, socialPackages.projectId),
          )
          .where(
            and(
              eq(socialPackages.operationId, operation.id),
              eq(socialPackages.userId, operation.userId),
            ),
          )
          .limit(1);
        const context = rows[0];
        if (!context)
          throw new SiteOpsManusFailure(
            "SOCIAL_CONTEXT_NOT_FOUND",
            "社媒内容包上下文不存在。",
            "failed",
          );
        const token = `siteops-social:${operation.id}`;
        let taskId = state?.taskId ?? operation.providerTaskId ?? undefined;
        if (!taskId) {
          if (state?.stage === "create_unknown") {
            const found = await findUniqueCreatedTask(client, operation, token);
            if (!found)
              return pending({ schemaVersion: 1, stage: "create_unknown" });
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
            return pending(
              { schemaVersion: 1, stage: "content_pending", taskId },
              taskId,
            );
          }
        }
        const polled = await pollEvents(client, taskId);
        const value = acceptedStructuredValue(polled.events, token);
        if (!value) {
          if (polled.state.failed)
            throw new SiteOpsManusFailure(
              "MANUS_SOCIAL_TASK_FAILED",
              "Manus 未生成可验证的社媒结构化内容。",
              "failed",
            );
          return pending(
            { schemaVersion: 1, stage: "content_pending", taskId },
            taskId,
          );
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
        const archive = await persist({
          userId: operation.userId,
          projectId: operation.projectId,
          kind: "social-archive",
          filename: `${context.package.channel}-${context.package.id}.zip`,
          mimeType: "application/zip",
          buffer: generated.archive,
        });
        const previews = await Promise.all(
          generated.previews.map((preview, index) =>
            persist({
              userId: operation.userId,
              projectId: operation.projectId,
              kind: "social-preview",
              filename: `${context.package.channel}-${context.package.id}-${String(index + 1).padStart(2, "0")}.png`,
              mimeType: preview.mimeType,
              buffer: preview.buffer,
            }),
          ),
        );
        if (archive.contentSha256 !== generated.archiveSha256)
          throw new SiteOpsManusFailure(
            "SOCIAL_ARCHIVE_HASH_MISMATCH",
            "社媒 ZIP 写入校验失败。",
            "failed",
          );
        await db
          .update(socialPackages)
          .set({
            manifest: generated.manifest,
            manifestHash: generated.manifestSha256,
            archiveLocalAssetId: archive.id,
            archiveHash: generated.archiveSha256,
            previewLocalAssetIds: previews.map((item) => item.id),
            qa: generated.qa,
            status: "ready",
            updatedAt: new Date(),
          })
          .where(eq(socialPackages.id, context.package.id));
        return {
          status: "succeeded",
          providerTaskId: taskId,
          socialPackageStatus: "ready",
          result: {
            packageId: context.package.id,
            archiveHash: generated.archiveSha256,
            previewCount: previews.length,
          },
          message: "社媒内容包已通过来源与结构校验，可以预览和下载。",
        };
      }

      if (!operation.kind.includes("build"))
        throw new SiteOpsManusFailure(
          "MANUS_OPERATION_KIND_UNSUPPORTED",
          "Manus SiteOps 适配器不支持该操作。",
          "failed",
        );
      const context = await loadBuildContext(db, operation);
      const archiveBytes = await readArchive({
        userId: operation.userId,
        snapshotId: context.snapshot.id,
        expectedSha256: context.snapshot.archiveHash!,
        expectedBytes: context.snapshot.totalBytes,
      });
      const brief = siteBriefSchema.parse(context.build.brief);
      const promptBrief = briefWithoutBrandAssets(brief);
      const assetDecisions = frozenAssetDecisions(context.snapshot, brief);
      const brandAsset = await readSelectedOfficialLogoFromKnowledgeArchive({
        archiveBytes,
        assets: context.snapshot.assets,
        decisions: assetDecisions,
      });
      const metadata = context.sample.sourceMetadata;
      if (!metadata || !context.sample.previewLocalAssetId)
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_INCOMPLETE",
          "冻结的视觉选择缺少可信元数据。",
          "failed",
        );
      const metadataRecord = metadata as unknown as Record<string, unknown>;
      const rawTaxonomy = metadata.taxonomy;
      const parsedTaxonomy = visualTaxonomySchema.parse({
        role: rawTaxonomy.role,
        palette: rawTaxonomy.palette,
        typography: rawTaxonomy.typography,
        layout: rawTaxonomy.layout,
        motion: rawTaxonomy.motion,
        accessibility: rawTaxonomy.accessibility,
      });
      const taxonomy = {
        ...parsedTaxonomy,
        palette: accessibleRuntimePalette(parsedTaxonomy.palette),
      };
      const documents = safePublicDocuments(context.snapshot);
      const visualEvidence = visualEvidenceV1Schema.parse(
        metadataRecord.visualEvidence,
      );
      const recomposedVisualEvidence = createVisualEvidenceV1({
        evidenceKind: visualEvidence.evidenceKind,
        providerItemKey: visualEvidence.providerItemKey,
        metadataSha256: visualEvidence.metadataSha256,
        providerResponseSha256: visualEvidence.providerResponseSha256,
        previewSha256: visualEvidence.previewSha256,
        taxonomyDerivationVersion: visualEvidence.taxonomyDerivationVersion,
      });
      const metadataProviderItemKey = z
        .string()
        .trim()
        .min(1)
        .max(512)
        .parse(metadataRecord.providerItemKey);
      if (
        recomposedVisualEvidence.evidenceSha256 !==
          visualEvidence.evidenceSha256 ||
        metadataProviderItemKey !== visualEvidence.providerItemKey ||
        context.sample.sourceMetadata?.visualEvidence?.previewSha256 !==
          visualEvidence.previewSha256
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_EVIDENCE_COORDINATES_MISMATCH",
          "冻结的视觉证据与预览坐标不一致。",
          "failed",
        );
      }
      if (
        !context.batch.selectionBundleLocalAssetId ||
        !context.batch.selectionBundleHash
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_BUNDLE_MISSING",
          "冻结的视觉选择合同不存在。",
          "failed",
        );
      }
      const selectionArtifact = await readArtifact({
        userId: operation.userId,
        localAssetId: context.batch.selectionBundleLocalAssetId,
        expectedSha256: context.batch.selectionBundleHash,
        expectedMimeTypes: ["application/json"],
      });
      if (!selectionArtifact) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_BUNDLE_MISSING",
          "冻结的视觉选择合同不存在。",
          "failed",
        );
      }
      const selection = await readFrozenSelectionBundle({
        artifact: selectionArtifact,
        expectedCandidateId: context.sample.id,
      });
      if (
        selection.candidate.providerItemKey !==
          visualEvidence.providerItemKey ||
        selection.candidate.visualEvidence.evidenceSha256 !==
          visualEvidence.evidenceSha256 ||
        selection.candidate.previewSha256 !== visualEvidence.previewSha256 ||
        selection.candidate.previewLocalAssetId !==
          context.sample.previewLocalAssetId
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_COORDINATES_MISMATCH",
          "冻结的视觉候选与选择合同坐标不一致。",
          "failed",
        );
      }
      const selectionV2: VisualSelectionBundleV2 | null =
        isVisualSelectionBundleV2(selection.bundle) ? selection.bundle : null;
      const supportingCandidates = selectionV2?.supportingCandidates ?? [];
      const supportingEvidence = supportingCandidates.map((candidate) =>
        verifiedVisualEvidence(candidate),
      );
      const visual = siteOpsRuntimeVisualEvidenceV1Schema.parse({
        queryHash: visualSelectionQueryHash(selection.bundle),
        selectedCandidateId: context.sample.id,
        providerItemKey: visualEvidence.providerItemKey,
        visualEvidenceSha256: visualEvidence.evidenceSha256,
        previewSha256: visualEvidence.previewSha256,
        supportEvidenceSha256s: supportingEvidence.map(
          (evidence) => evidence.evidenceSha256,
        ),
        taxonomy,
      });
      const designToken = `siteops-design:${operation.id}`;
      const contentToken = `siteops-content:${operation.id}`;
      let taskId = state?.taskId ?? operation.providerTaskId ?? undefined;

      if (!taskId) {
        if (state?.stage === "create_unknown") {
          const found = await findUniqueCreatedTask(
            client,
            operation,
            designToken,
          );
          if (!found)
            return pending(
              { schemaVersion: 1, stage: "create_unknown" },
              undefined,
              "design_compiling",
            );
          taskId = found.id;
        } else {
          const workflowPackage = await loadVerifiedSiteOpsWorkflowPackage();
          const previewArtifact = await readArtifact({
            userId: operation.userId,
            localAssetId: context.sample.previewLocalAssetId,
            expectedSha256: visualEvidence.previewSha256,
            expectedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          });
          if (!previewArtifact) {
            throw new SiteOpsManusFailure(
              "VISUAL_PREVIEW_NOT_FOUND",
              "视觉预览资产不存在。",
              "failed",
            );
          }
          assertProjectVisualArtifact(previewArtifact, {
            userId: operation.userId,
            projectId: context.project.id,
          });
          const supportArtifacts = await Promise.all(
            supportingCandidates.map(async (candidate) => {
              const artifact = await readArtifact({
                userId: operation.userId,
                localAssetId: candidate.previewLocalAssetId,
                expectedSha256: candidate.previewSha256,
                expectedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
              });
              if (!artifact) {
                throw new SiteOpsManusFailure(
                  "VISUAL_PREVIEW_NOT_FOUND",
                  "冻结的辅助视觉预览不存在。",
                  "failed",
                );
              }
              assertProjectVisualArtifact(artifact, {
                userId: operation.userId,
                projectId: context.project.id,
              });
              return artifact;
            }),
          );
          const visualAttachments = [
            workflowAttachment(workflowPackage),
            await visualPreviewAttachment(
              previewArtifact,
              "selected-visual.png",
            ),
            ...(await Promise.all(
              supportArtifacts.map((artifact, index) =>
                visualPreviewAttachment(
                  artifact,
                  `support-visual-${index + 1}.png`,
                ),
              ),
            )),
          ];
          const prompt = promptWithMarker(
            `你是 FrontMind 官网设计与信息架构师。必须遵守附件中经 manifest 校验的 FrontMind Astro Company Site Workflow ${SITEOPS_WORKFLOW.frontMindVersion}、SKILL.md 和 runtime-contract.json。选中的安全视觉预览已作为主参考附件提供；可选 support-visual 附件只用于 section/motion 辅助参考，全部参考图都不是客户网站素材。根据 SiteBrief、视觉 taxonomy、冻结调色板和知识资料输出严格 SiteDesignSpecV1：只使用允许的布局、hero、section slot、视觉 token 与 SEO 字段。每个 route 都必须有唯一 slotId。不要生成源码、HTML、CSS、依赖、脚本或 21st 组件代码；不要扩写未知事实。\n\nSiteBrief：${JSON.stringify(promptBrief)}\n视觉证据：${JSON.stringify(visual)}\n知识资料：${JSON.stringify(documents)}`,
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
              attachments: visualAttachments,
              locale: brief.primaryLanguage,
              structuredOutputSchema: designOutputSchema(
                designToken,
                brief.routes.map((route) => route.id),
                taxonomy.palette.length,
              ),
            });
            taskId = created.taskId;
            await db
              .update(siteBuilds)
              .set({
                upstreamManusTaskId: taskId,
                status: "design_compiling",
                updatedAt: new Date(),
              })
              .where(eq(siteBuilds.id, context.build.id));
          } catch (error) {
            if (error instanceof ManusV2ApiError && error.outcomeUnknown)
              return pending(
                { schemaVersion: 1, stage: "create_unknown" },
                undefined,
                "design_compiling",
              );
            throw error;
          }
          await persistOperationProgress(
            db,
            operation,
            { schemaVersion: 1, stage: "design_pending", taskId },
            taskId,
          );
          return pending(
            { schemaVersion: 1, stage: "design_pending", taskId },
            taskId,
            "design_compiling",
          );
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
            ? designOutputSchema(
                repairToken,
                brief.routes.map((route) => route.id),
                taxonomy.palette.length,
              )
            : generatedContentOutputSchema(
                repairToken,
                state.design?.designSpec.routeCompositions ?? [],
              );
        if (state.stage === "repair_send_ready") {
          const repairPrompt = promptWithMarker(
            state.repairKind === "design"
              ? `继续同一个 FrontMind 建站任务。上一次 SiteDesignSpecV1 未通过严格契约。第 ${state.repairAttempt}/3 次修复：重新输出完整设计、route slot 与 SEO 结构；继续遵守已附加 workflow，不得输出源码或未知事实。SiteBrief：${JSON.stringify(promptBrief)}\n视觉 taxonomy：${JSON.stringify(taxonomy)}`
              : `继续同一个 FrontMind 建站任务。上一次 PageContentSpecV1 或 Astro/SEO/视觉 QA 未通过。第 ${state.repairAttempt}/3 次修复：按已冻结 designSpec 的 route/slot 顺序重新输出完整结构化正文，严格使用允许的 sourceDocumentIds，不得输出源码、脚本或未知事实。设计合同：${JSON.stringify(state.design?.designSpec)}\nSiteBrief：${JSON.stringify(promptBrief)}\n知识资料：${JSON.stringify(documents)}`,
            repairToken,
          );
          const unknownState: ProviderState = {
            ...state,
            stage: "repair_send_unknown",
          };
          await persistOperationProgress(db, operation, unknownState, taskId);
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
          await persistOperationProgress(db, operation, waitingState, taskId);
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
              state.repairKind === "design" ? "design_compiling" : "qa_running",
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
            validateDesignAndContentBindings({
              routeIds: brief.routes.map((route) => route.id),
              paletteSize: taxonomy.palette.length,
              designSpec: repairedDesign.designSpec,
            });
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
          return pending(
            { schemaVersion: 1, stage: "design_pending", taskId },
            taskId,
            "design_compiling",
          );
        }
        try {
          design = designResultSchema.parse(raw);
          validateDesignAndContentBindings({
            routeIds: brief.routes.map((route) => route.id),
            paletteSize: taxonomy.palette.length,
            designSpec: design.designSpec,
          });
        } catch {
          return scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "design",
          });
        }
        return pending(
          { schemaVersion: 1, stage: "content_send_ready", taskId, design },
          taskId,
          "contract_ready",
        );
      }

      if (state?.stage === "content_send_ready") {
        if (!design) {
          throw new SiteOpsManusFailure(
            "MANUS_DESIGN_STATE_MISSING",
            "同一 Manus 任务缺少已校验的设计合同。",
            "failed",
          );
        }
        const revisionInstruction = input.feedback
          ? `客户本次修改要求：${input.feedback}`
          : "这是首版官网内容。";
        const canonicalContract = composeBuildContractV2({
          schemaVersion: 2,
          source: {
            knowledgeSnapshotId: context.snapshot.id,
            archiveSha256: context.build.knowledgeArchiveHash,
            sourceBuildId: context.snapshot.sourceBuildId,
            sourceBuildRevision: context.snapshot.sourceBuildRevision,
          },
          workflow: {
            upstreamSha256: SITEOPS_WORKFLOW.upstreamSha256,
            version: SITEOPS_WORKFLOW.frontMindVersion,
            manifestSha256: SITEOPS_WORKFLOW.runtimeManifestSha256,
            starterVersion: SITEOPS_WORKFLOW.starterVersion,
            starterSha256: SITEOPS_WORKFLOW.starterSha256,
            componentLibraryVersion: SITEOPS_WORKFLOW.componentLibraryVersion,
            materializerVersion: SITEOPS_WORKFLOW.materializerVersion,
            materializerSha256: SITEOPS_WORKFLOW.materializerSha256,
          },
          identity: {
            companyName: brief.companyName,
            primaryLanguage: brief.primaryLanguage,
            verifiedContacts: brief.contacts.map(
              (contact) => `${contact.kind}:${contact.value}`,
            ),
          },
          visual: {
            ...visual,
            designSpecHash: canonicalSiteOpsSha256(design.designSpec),
            componentLibraryVersion: SITEOPS_WORKFLOW.componentLibraryVersion,
          },
          routes: brief.routes,
          assets: assetDecisions,
          seo: {
            ...design.designSpec.seoPlan,
            environment: "preview",
            canonicalPolicy: "forbidden",
          },
          target: { environment: "preview", canonicalOrigin: null },
          qaPolicyVersion: SITEOPS_WORKFLOW.qaPolicyVersion,
        });
        const prompt = promptWithMarker(
          `继续同一个建站任务。以下 canonical build-contract.json 已由 Dashboard 根据受信 workflow 和刚才通过校验的 SiteDesignSpecV1 生成，必须遵守：${canonicalJson(canonicalContract)}。请仅输出 PageContentSpecV1；routeId 和 slotId 必须按 designSpec 完全一致且顺序相同，每段关键内容必须引用给定 sourceDocumentIds。不得重复 SEO、生成源码、HTML、依赖、表单提交、外部脚本或未知事实。${revisionInstruction}\n\nSiteBrief：${JSON.stringify(promptBrief)}\n知识资料：${JSON.stringify(documents)}`,
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
          await client.sendMessage({
            taskId,
            prompt,
            structuredOutputSchema: generatedContentOutputSchema(
              contentToken,
              design.designSpec.routeCompositions,
            ),
          });
        } catch (error) {
          if (error instanceof ManusV2ApiError && error.outcomeUnknown)
            return pending(
              {
                schemaVersion: 1,
                stage: "content_send_unknown",
                taskId,
                design,
              },
              taskId,
              "building",
            );
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
        return pending(
          { schemaVersion: 1, stage: "content_pending", taskId, design },
          taskId,
          "building",
        );
      }

      if (state?.stage === "content_send_unknown") {
        const events = await client.listAllMessages({
          taskId,
          order: "asc",
          stopAfterOperationToken: contentToken,
        });
        if (!manusV2EventsContainOperationToken(events, contentToken))
          return pending(
            { schemaVersion: 1, stage: "content_send_unknown", taskId, design },
            taskId,
            "building",
          );
        return pending(
          { schemaVersion: 1, stage: "content_pending", taskId, design },
          taskId,
          "building",
        );
      }

      const polled =
        repairedContent === null ? await pollEvents(client, taskId) : null;
      const rawContent =
        repairedContent ??
        acceptedStructuredValue(polled!.events, contentToken);
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
        return pending(
          { schemaVersion: 1, stage: "content_pending", taskId, design },
          taskId,
          "building",
        );
      }
      let generatedContent: z.infer<typeof siteOpsGeneratedContentSchema>;
      try {
        const contentResult = pageContentResultV1Schema.parse(rawContent);
        validateDesignAndContentBindings({
          routeIds: brief.routes.map((route) => route.id),
          paletteSize: taxonomy.palette.length,
          designSpec: design!.designSpec,
          pageContent: contentResult.pageContent,
        });
        generatedContent = siteOpsGeneratedContentSchema.parse({
          seo: design!.designSpec.seoPlan,
          routes: contentResult.pageContent.routes,
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
      await db
        .update(siteBuilds)
        .set({ status: "qa_running", updatedAt: new Date() })
        .where(eq(siteBuilds.id, context.build.id));
      let materialized: Awaited<ReturnType<typeof materializeAstroSite>>;
      try {
        materialized = await materialize({
          build: context.build,
          snapshot: { ...context.snapshot, documents },
          brief,
          visual,
          designSpec: design!.designSpec,
          generatedContent,
          assetDecisions,
          brandAsset,
          mode: "preview",
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (
          /^(?:SITEOPS_GENERATED_|SITEOPS_CONTENT_|SITEOPS_SENSITIVE_OR_DEMO_TEXT_REJECTED|SITEOPS_QA_FAILED|SITEOPS_AXE_BLOCKING_VIOLATIONS)/u.test(
            code,
          )
        ) {
          return scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            design,
          });
        }
        throw new SiteOpsManusFailure(
          "SITEOPS_HOST_MATERIALIZATION_FAILED",
          "受信 Astro 构建或 QA 运行环境未能安全完成本次任务。",
          "attention_required",
        );
      }
      const artifacts = await persistBuildArtifacts(
        db,
        operation,
        materialized,
        persist,
      );
      return {
        status: "succeeded",
        providerTaskId: taskId,
        projectStatus: "preview_ready",
        buildStatus: "preview_ready",
        result: {
          buildId: context.build.id,
          specHash: materialized.contract.specHash,
          distHash: materialized.distSha256,
          qaSummary: artifacts.qaSummary,
          artifactIds: {
            contract: artifacts.contract.id,
            source: artifacts.source.id,
            dist: artifacts.dist.id,
            qa: artifacts.qa.id,
            provenance: artifacts.provenance.id,
          },
        },
        message: "原生 Astro 官网已完成构建和 QA，可以在私有预览中检查并批准。",
      };
    } catch (error) {
      console.error("[siteops-manus] provider_failed", {
        event: "siteops_manus_provider_failed",
        operationId: operation.id,
        projectId: operation.projectId,
        kind: operation.kind,
        error: runtimeErrorForLog(error),
      });
      return resultFailure(error);
    }
  };
}

let registered = false;

export function registerManusSiteOpsProvider(
  dependencies: ManusProviderDependencies = {},
) {
  if (registered) return () => undefined;
  const unregister = registerSiteOpsProviderHandler(
    "manus",
    createManusSiteOpsProviderHandler(dependencies),
  );
  registered = true;
  return () => {
    unregister();
    registered = false;
  };
}
