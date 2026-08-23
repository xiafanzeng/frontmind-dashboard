import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull, or } from "drizzle-orm";
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
  SITEOPS_MATERIALIZER_V2_0,
  SITEOPS_MATERIALIZER_V2_1,
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  visualEvidenceV1Schema,
  visualSelectionBundleSchema,
  visualTaxonomySchema,
  siteOpsWorkflowForVersion,
  type VisualSelectionBundle,
  type VisualSelectionBundleV1,
  type VisualSelectionBundleV2,
  type VisualSelectionBundleV3,
} from "../../shared/siteops";
import {
  managedAgentProfileModel,
  managedAgentProfileSchema,
} from "../../shared/manus-agent-profile";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import {
  canonicalSiteOpsSha256,
  composeBuildContractV2,
  composeBuildPlanContractV3,
  composeBuildPlanContractV4,
  referenceBlueprintSchema,
  siteDesignResultV1Schema,
  siteDesignResultV2Schema,
  siteOpsRuntimeVisualEvidenceV1Schema,
  siteOpsRuntimeVisualEvidenceV2Schema,
  validateDesignAndContentBindings,
} from "../../shared/siteops-design";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import { getDecryptedCredentialForUser } from "../auth-service";
import { getDb } from "../db";
import { assertUpstreamPromptBudget } from "../upstream-prompt-budget";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2WaitingDetail,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventOperationToken,
  manusV2EventsContainOperationToken,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
  type ManusV2StructuredOutputSchema,
} from "../manus-v2-client";
import { readKnowledgeSnapshotArchive } from "../knowledge-snapshot-archive-store";
import {
  generateSocialPackage,
  materializeAstroSite,
  siteOpsGeneratedContentSchema,
  siteOpsGeneratedContentV2Schema,
  socialPackageInputSchema,
} from "./build-runtime";
import {
  SiteOpsMaterializationError,
  toSiteOpsMaterializationError,
  type SiteOpsMaterializationPhase,
  type SiteOpsMaterializationRetryClass,
  type SiteOpsMaterializationSafeDetails,
} from "./materialization-error";
import { persistSiteOpsArtifact, readSiteOpsArtifact } from "./artifact-store";
import {
  registerSiteOpsProviderHandler,
  type SiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";
import { readSelectedOfficialLogoFromKnowledgeArchive } from "./knowledge-brand-asset";
import {
  pageContentResultFromWire,
  pageContentResultV2FromWire,
  pageContentWireOutputSchema,
  pageContentWireV3OutputSchema,
  siteDesignResultFromWire,
  siteDesignResultV2FromWire,
  siteDesignWireOutputSchema,
  siteDesignWireV3OutputSchema,
  siteOpsBuildContractAttachment,
  siteOpsBuildPlanContractV3Attachment,
  siteOpsBuildPlanContractV4Attachment,
  siteOpsCustomerFeedbackAttachment,
  siteOpsSocialSourceAttachment,
  siteOpsSourceDossierAttachments,
  socialWireOutputSchema,
} from "./manus-wire-contract";
import {
  resolveSiteOpsWireOutput,
  SITEOPS_WIRE_OUTPUT_FILES,
  SiteOpsWireOutputResolutionError,
  type SiteOpsWireOutputPhase,
} from "./manus-wire-output-resolver";
import { terminalTaskState } from "./task-terminal-state";

export { terminalTaskState } from "./task-terminal-state";

const operationInputSchema = z
  .object({
    credentialScope: z.literal("customer"),
    manusCredentialId: z.string().uuid(),
    manusCredentialVersion: z.number().int().positive(),
    agentProfile: managedAgentProfileSchema.default("frontmind-pro"),
    buildId: z.string().uuid().optional(),
    childBuildId: z.string().uuid().optional(),
    parentBuildId: z.string().uuid().optional(),
    feedback: z.string().trim().min(1).max(8_000).optional(),
    channel: z.enum(["wechat", "xiaohongshu"]).optional(),
    packageId: z.string().uuid().optional(),
    topic: z.string().trim().max(500).optional(),
    referenceBlueprint: referenceBlueprintSchema.optional(),
  })
  .passthrough();

const designResultSchema = z.union([
  siteDesignResultV2Schema,
  siteDesignResultV1Schema,
]);

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
      "create_rejected",
    ]),
    taskId: z.string().min(1).max(255).optional(),
    design: designResultSchema.optional(),
    repairKind: z.enum(["design", "content"]).optional(),
    repairAttempt: z.number().int().min(1).max(3).optional(),
    resultPendingSince: z.string().datetime().optional(),
    handledWaitingEventId: z.string().min(1).max(512).optional(),
    handledWaitingAt: z.string().datetime().optional(),
  })
  .strict();

type ProviderState = z.infer<typeof providerStateSchema>;

type ManusProviderDependencies = {
  getDb?: typeof getDb;
  getCredential?: typeof getDecryptedCredentialForUser;
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
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const SAFE_MATERIALIZATION_DETAIL_KEY =
  /^(?:durationMs|assetDecisionCount|publishedCount|omittedCount|omittedDuplicateCount|quarantineCount|exitCode|signal|performance|accessibility|bestPractices|seo|cls|axeViolationCount|axeViolationIds|failedAuditIds|localRetryCount)$/u;

function untypedMaterializationCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.match(/^SITEOPS_[A-Z0-9_]+/u)?.[0] ??
    "SITEOPS_HOST_MATERIALIZATION_FAILED"
  );
}

export function classifySiteOpsMaterializationFailure(
  error: unknown,
): SiteOpsMaterializationError {
  if (error instanceof SiteOpsMaterializationError) return error;
  const code = untypedMaterializationCode(error);
  let phase: SiteOpsMaterializationPhase = "source_generation";
  let retryClass: SiteOpsMaterializationRetryClass = "host_deterministic";
  if (/(?:ASSET|QUARANTIN)/u.test(code)) phase = "asset_projection";
  else if (/ASTRO_BUILD/u.test(code)) phase = "astro_build";
  else if (/LIGHTHOUSE/u.test(code)) phase = "lighthouse";
  else if (/AXE|BROWSER|PLAYWRIGHT/u.test(code)) phase = "browser_qa";
  else if (/QA_PACKAG|ARCHIVE|ARTIFACT_HASH/u.test(code)) {
    phase = "qa_packaging";
  } else if (/_QA_|QA_FAILED/u.test(code)) phase = "static_qa";
  if (/(?:GENERATED_|CONTENT_|SENSITIVE_OR_DEMO_TEXT)/u.test(code)) {
    retryClass = "content_repair";
  } else if (
    /(?:BROWSER_LAUNCH|CHROME|ECONNREFUSED|ETIMEDOUT|LIGHTHOUSE_NO_RESULT)/u.test(
      `${code}:${error instanceof Error ? error.message : ""}`,
    )
  ) {
    retryClass = "host_transient";
  }
  return toSiteOpsMaterializationError({
    error,
    phase,
    fallbackCode: code,
    retryClass,
  });
}

function safeMaterializationDetails(
  error: SiteOpsMaterializationError,
  base: SiteOpsMaterializationSafeDetails,
) {
  const details: SiteOpsMaterializationSafeDetails = { ...base };
  for (const [key, value] of Object.entries(error.safeDetails)) {
    if (!SAFE_MATERIALIZATION_DETAIL_KEY.test(key)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      details[key] = typeof value === "string" ? value.slice(0, 512) : value;
    }
  }
  return details;
}

export async function materializeWithSingleHostRetry<T>(input: {
  run: () => Promise<T>;
  signal: AbortSignal;
}) {
  let localRetryCount = 0;
  while (true) {
    input.signal.throwIfAborted();
    try {
      return {
        value: await input.run(),
        localRetryCount,
      };
    } catch (error) {
      input.signal.throwIfAborted();
      const classified = classifySiteOpsMaterializationFailure(error);
      if (classified.retryClass !== "host_transient" || localRetryCount >= 1) {
        throw classified;
      }
      localRetryCount += 1;
    }
  }
}

function publicMaterializationFailure(
  error: SiteOpsMaterializationError,
  taskId: string,
  diagnostics: Record<string, unknown>,
): SiteOpsProviderResult {
  if (error.retryClass === "host_transient") {
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_RUNTIME_UNAVAILABLE",
      message: "FrontMind AI 建站运行环境暂时不可用，请稍后重试或重置流程。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  if (error.phase === "asset_projection") {
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_ASSET_CONFLICT",
      message: "FrontMind AI 建站检测到知识资产冲突，请重置后重新开始。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  if (["astro_build", "react_static_build"].includes(String(error.phase))) {
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_COMPILE_FAILED",
      message: "FrontMind AI 建站未能完成可信网站编译，请重置后重新开始。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  return {
    status: "failed",
    code: "FRONTMIND_BUILD_QA_FAILED",
    message: "FrontMind AI 建站未通过网站质量检查，请重置后重新开始。",
    providerTaskId: taskId,
    result: diagnostics,
  };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const workflowPackagePromises = new Map<string, Promise<Buffer>>();

function workflowRoots(workflow: ReturnType<typeof siteOpsWorkflowForVersion>) {
  const configured = process.env.FRONTMIND_SITEOPS_WORKFLOW_PATH?.trim();
  const directory = workflow.frontMindVersion.startsWith("2.")
    ? `react-static-company-site-workflow-v${workflow.frontMindVersion}`
    : `astro-company-site-workflow-v${workflow.frontMindVersion}`;
  return [
    ...(configured &&
    workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion
      ? [path.resolve(configured)]
      : []),
    path.resolve(process.cwd(), "private-workflows", directory),
    path.resolve(process.cwd(), "dist/private-workflows", directory),
  ];
}

function reactStaticRendererCoordinates(
  workflow: ReturnType<typeof siteOpsWorkflowForVersion>,
) {
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_0.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_0.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_0.materializerVersion,
    } as const;
  }
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_1.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_1.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_1.materializerVersion,
    } as const;
  }
  if (workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion) {
    return {
      componentLibraryVersion: SITEOPS_WORKFLOW.componentLibraryVersion,
      materializerVersion: SITEOPS_WORKFLOW.materializerVersion,
    } as const;
  }
  throw new SiteOpsManusFailure(
    "SITEOPS_REACT_WORKFLOW_VERSION_UNSUPPORTED",
    "FrontMind React 建站工作流版本不受支持。",
    "failed",
  );
}

export async function loadVerifiedSiteOpsWorkflowPackage(
  workflow: ReturnType<typeof siteOpsWorkflowForVersion> = SITEOPS_WORKFLOW,
) {
  const existing = workflowPackagePromises.get(workflow.frontMindVersion);
  if (existing) return existing;
  const loading = (async () => {
    let root: string | null = null;
    let manifestBytes: Buffer | null = null;
    for (const candidate of workflowRoots(workflow)) {
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
        `FrontMind ${workflow.frontMindVersion} 建站工作流未进入运行镜像。`,
      );
    }
    if (sha256(manifestBytes) !== workflow.runtimeManifestSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_MANIFEST_MISMATCH",
        `FrontMind ${workflow.frontMindVersion} 建站工作流 manifest 哈希不一致。`,
        "failed",
      );
    }
    const manifest = z
      .object({
        version: z.literal(workflow.frontMindVersion),
        entrypoint: z.literal("SKILL.md"),
        upstream: z.object({
          version: z.literal(workflow.upstreamVersion),
          archiveSha256: z.literal(workflow.upstreamSha256),
        }),
        host: z
          .object({
            starterSha256: z.literal(workflow.starterSha256),
            componentLibraryVersion: z.literal(
              workflow.componentLibraryVersion,
            ),
            materializerVersion: z.literal(workflow.materializerVersion),
            materializerSha256: z.literal(workflow.materializerSha256),
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
          `FrontMind ${workflow.frontMindVersion} 建站工作流包含不安全路径。`,
          "failed",
        );
      }
      const absolute = path.resolve(root, entry.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          `FrontMind ${workflow.frontMindVersion} 建站工作流路径越界。`,
          "failed",
        );
      }
      const fileStat = await lstat(absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_INVALID",
          `FrontMind ${workflow.frontMindVersion} 建站工作流包含非普通文件。`,
          "failed",
        );
      }
      const bytes = await readFile(absolute);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_MISMATCH",
          `FrontMind ${workflow.frontMindVersion} 建站工作流文件校验失败：${entry.path}`,
          "failed",
        );
      }
      total += bytes.length;
      if (total > 18 * 1024 * 1024) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PACKAGE_TOO_LARGE",
          `FrontMind ${workflow.frontMindVersion} 建站工作流超过附件上限。`,
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
        `FrontMind ${workflow.frontMindVersion} 建站工作流缺少 SKILL 或 runtime contract。`,
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
    workflowPackagePromises.delete(workflow.frontMindVersion);
    throw error;
  });
  workflowPackagePromises.set(workflow.frontMindVersion, loading);
  return loading;
}

function workflowAttachment(
  bytes: Buffer,
  workflow: ReturnType<typeof siteOpsWorkflowForVersion>,
) {
  const product = workflow.frontMindVersion.startsWith("2.")
    ? "react-static-company-site-workflow"
    : "astro-company-site-workflow";
  return {
    filename: `frontmind-${product}-${workflow.frontMindVersion}.zip`,
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

function isVisualSelectionBundleV3(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV3 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 3;
}

function visualSelectionQueryHash(bundle: VisualSelectionBundle) {
  return isVisualSelectionBundleV2(bundle) || isVisualSelectionBundleV3(bundle)
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
  return assertUpstreamPromptBudget(
    `${prompt}\n\n# FrontMind operation contract\n${operationMarker(token)}`,
  );
}

function operationTitle(operation: SiteOperation) {
  return `FrontMind SiteOps ${operation.id}`;
}

function baseUrl() {
  return process.env.MANUS_API_BASE_URL?.trim() || "https://api.manus.ai";
}

function acceptedSocialStructuredValue(
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

export function combinedTerminalTaskState(
  eventStatus: string | null | undefined,
  detailStatus: string | null | undefined,
) {
  const eventState = terminalTaskState(eventStatus);
  const detailState = terminalTaskState(detailStatus);
  const normalizedDetail = String(detailStatus ?? "")
    .trim()
    .toLowerCase();
  const detailIsKnownNonterminal = [
    "created",
    "queued",
    "starting",
    "running",
    "pending",
    "waiting",
  ].includes(normalizedDetail);
  // task.detail is the current task authority. An older phase may have left a
  // stopped status event in the shared one-task history; it must not complete
  // the next phase while detail already says that phase is running.
  if (detailIsKnownNonterminal) {
    return { failed: false, completed: false };
  }
  const detailIsTerminal = detailState.failed || detailState.completed;
  const failed = detailIsTerminal ? detailState.failed : eventState.failed;
  return {
    failed,
    completed:
      !failed &&
      (detailIsTerminal ? detailState.completed : eventState.completed),
  };
}

export function phaseTerminalTaskState(
  eventStatus: string | null | undefined,
  detailStatus: string | null | undefined,
) {
  const eventState = terminalTaskState(eventStatus);
  const detailState = terminalTaskState(detailStatus);
  const failed = eventState.failed || detailState.failed;
  return {
    failed,
    // Both authorities must describe completion for the current token window.
    // This prevents the previous stopped phase in a one-task conversation from
    // completing a newly sent phase before it actually stops.
    completed: !failed && eventState.completed && detailState.completed,
  };
}

const STRUCTURED_RESULT_GRACE_MS = 120_000;

export function structuredResultGrace(
  state: ProviderState,
  completed: boolean,
  now = Date.now(),
) {
  if (!completed) return { expired: false, state };
  const parsed = state.resultPendingSince
    ? Date.parse(state.resultPendingSince)
    : Number.NaN;
  const since = Number.isFinite(parsed) ? parsed : now;
  return {
    expired: now - since >= STRUCTURED_RESULT_GRACE_MS,
    state: {
      ...state,
      resultPendingSince: new Date(since).toISOString(),
    } satisfies ProviderState,
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
    .map((document) => ({
      id: String(document.id || document.path).slice(0, 191),
      path: document.path.slice(0, 512),
      title: document.title.slice(0, 255),
      content: document.content,
      kind: document.kind,
      customerVisible: true as const,
    }));
}

export function frozenAssetDecisions(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
  brief: z.infer<typeof siteBriefSchema>,
) {
  const validAssets = snapshot.assets.flatMap((asset) => {
    if (!asset.id || !asset.sha256 || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
      return [];
    }
    const isOfficialLogo =
      asset.sourceKind === "official_logo_upload" ||
      (asset.ownership === "first_party" &&
        /logo/iu.test(`${asset.key} ${asset.path}`));
    return [
      {
        id: asset.id,
        sha256: asset.sha256.toLowerCase(),
        isOfficialLogo,
      },
    ];
  });
  const selectedLogo = brief.publicAssetIds
    .map((id) =>
      validAssets.find((asset) => asset.id === id && asset.isOfficialLogo),
    )
    .find((asset) => asset?.isOfficialLogo);

  return validAssets.map((asset) => ({
    id: asset.id,
    sha256: asset.sha256,
    decision:
      asset === selectedLogo
        ? ("publish" as const)
        : selectedLogo && asset.sha256 === selectedLogo.sha256
          ? ("omit" as const)
          : ("quarantine" as const),
  }));
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
  renderer: "legacy_astro" | "react_static",
): ManusV2StructuredOutputSchema {
  const input = {
    operationToken: token,
    routeIds,
    paletteSize,
  };
  return renderer === "react_static"
    ? siteDesignWireV3OutputSchema(input)
    : siteDesignWireOutputSchema(input);
}

function generatedContentOutputSchema(
  token: string,
  routeCompositions: Array<{
    routeId: string;
    slots: Array<{ slotId: string }>;
  }>,
  sourceDocumentIds: string[],
  workflowVersion: string,
) {
  const input = {
    operationToken: token,
    routeIds: routeCompositions.map((route) => route.routeId),
    sourceDocumentIds,
  };
  return workflowVersion === SITEOPS_WORKFLOW.frontMindVersion
    ? pageContentWireV3OutputSchema(input)
    : pageContentWireOutputSchema(input);
}

function socialOutputSchema(
  token: string,
  channel: "wechat" | "xiaohongshu",
  sourceDocumentIds: string[],
) {
  return socialWireOutputSchema({
    operationToken: token,
    channel,
    sourceDocumentIds,
  });
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
  userId: number,
  getCredential: typeof getDecryptedCredentialForUser,
) {
  const credential = await getCredential(userId, input.manusCredentialId);
  if (
    !credential ||
    credential.userId !== userId ||
    credential.version !== input.manusCredentialVersion
  ) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_CUSTOMER_CREDENTIAL_VERSION_UNAVAILABLE",
      "当前账号绑定的 AI 建站 API Key 版本不可用。",
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
  const updated = await db
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
  const affectedRows = Number(
    (Array.isArray(updated)
      ? (updated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (updated as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
  if (affectedRows !== 1) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
}

async function bindCreatedBuildTask(input: {
  db: any;
  operation: SiteOperation;
  buildId: string;
  taskId: string;
  state: ProviderState;
}) {
  if (!input.operation.leaseOwner) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
  await input.db.transaction(async (tx: any) => {
    await persistOperationProgress(
      tx,
      input.operation,
      input.state,
      input.taskId,
    );
    const updated = await tx
      .update(siteBuilds)
      .set({
        upstreamManusTaskId: input.taskId,
        status: "design_compiling",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteBuilds.id, input.buildId),
          eq(siteBuilds.userId, input.operation.userId),
          or(
            isNull(siteBuilds.upstreamManusTaskId),
            eq(siteBuilds.upstreamManusTaskId, input.taskId),
          ),
        ),
      );
    const affectedRows = Number(
      (Array.isArray(updated)
        ? (updated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
        : (updated as { affectedRows?: unknown } | undefined)?.affectedRows) ??
        0,
    );
    if (affectedRows !== 1) {
      throw new Error("SITEOPS_BUILD_TASK_BINDING_CONFLICT");
    }
  });
}

function currentPhaseEvents(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  const ordered = orderManusV2EventsByProviderRank(events, "oldest_first");
  let start = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) === operationToken) {
      start = index;
    }
  }
  if (start < 0) return [];
  let end = ordered.length;
  for (let index = start + 1; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) !== null) {
      end = index;
      break;
    }
  }
  return ordered.slice(start + 1, end);
}

async function pollEvents(
  client: ManusV2Client,
  taskId: string,
  operationToken: string,
) {
  const [detail, events] = await Promise.all([
    client.taskDetail(taskId),
    client.listAllMessages({ taskId, order: "asc" }),
  ]);
  return {
    detail,
    events,
    state: phaseTerminalTaskState(
      latestManusV2TaskState(currentPhaseEvents(events, operationToken)),
      detail.status,
    ),
    waiting: latestManusV2WaitingDetail(events),
  };
}

async function resolveBuildWireValue(input: {
  events: readonly ManusV2MessageEvent[];
  operationToken: string;
  phase: SiteOpsWireOutputPhase;
  expectedFilename: string;
  taskCompleted: boolean;
  signal: AbortSignal;
}) {
  try {
    const resolved = await resolveSiteOpsWireOutput(input);
    return { value: resolved?.value ?? null, invalid: false as const };
  } catch (error) {
    if (error instanceof SiteOpsWireOutputResolutionError) {
      if (error.code === "SITEOPS_WIRE_OUTPUT_UNAVAILABLE") {
        return { value: null, invalid: false as const };
      }
      return { value: null, invalid: true as const };
    }
    throw error;
  }
}

export function messageAskUserWaiting(
  waiting: ReturnType<typeof latestManusV2WaitingDetail>,
) {
  return (
    waiting?.eventType.replace(/[^a-z]/giu, "").toLowerCase() ===
    "messageaskuser"
  );
}

export function handledWaitingResolution(
  state: ProviderState,
  waitingEventId: string,
  now = Date.now(),
) {
  if (state.handledWaitingEventId !== waitingEventId) return "new" as const;
  const handledAt = state.handledWaitingAt
    ? Date.parse(state.handledWaitingAt)
    : Number.NaN;
  return Number.isFinite(handledAt) && now - handledAt < 120_000
    ? ("pending" as const)
    : ("expired" as const);
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

export function completedSiteBuildMessage() {
  return "FrontMind 静态官网已完成构建和 QA，可以在私有预览中检查并批准。";
}

export function contentRepairPrompt(input: {
  repairAttempt: number;
  outputFilename?: string;
  wireVersion?: 2 | 3;
}) {
  const wire = `PageContentWireV${input.wireVersion ?? 2}`;
  return `继续同一个 FrontMind AI 建站任务。上一次 ${wire} 或受信网站 QA 未通过。第 ${input.repairAttempt}/3 次修复：重新读取已附加 source dossier 与 build contract，按冻结 route/slot 顺序完整返回 ${wire}，只能引用允许的 sourceDocumentIds，并把完全相同的 JSON 对象附加为 ${input.outputFilename ?? SITEOPS_WIRE_OUTPUT_FILES.content}。不得浏览或补写外部新闻，不得输出源码、脚本或未知事实。`;
}

async function scheduleRepair(input: {
  db: any;
  operation: SiteOperation;
  build: typeof siteBuilds.$inferSelect;
  taskId: string;
  kind: "design" | "content";
  design?: z.infer<typeof designResultSchema>;
  handledWaitingEventId?: string;
  handledWaitingAt?: string;
}) {
  const attempt = input.build.repairAttempts + 1;
  if (attempt > 3)
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message:
        "同一 FrontMind AI 建站任务已自动修复 3 次，仍未通过结构或 QA 校验。",
      providerTaskId: input.taskId,
    } satisfies SiteOpsProviderResult;
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
      ...(input.handledWaitingEventId
        ? { handledWaitingEventId: input.handledWaitingEventId }
        : {}),
      ...(input.handledWaitingAt
        ? { handledWaitingAt: input.handledWaitingAt }
        : {}),
    },
    input.taskId,
    input.kind === "design" ? "design_compiling" : "qa_running",
  );
}

async function persistBuildArtifacts(
  operation: SiteOperation,
  materialized: Awaited<ReturnType<typeof materializeAstroSite>>,
  persist: typeof persistSiteOpsArtifact,
  assertExecutionActive: () => Promise<void>,
) {
  await assertExecutionActive();
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
    throw new SiteOpsMaterializationError({
      phase: "artifact_persistence",
      code: "SITEOPS_BUILD_ARTIFACT_HASH_MISMATCH",
      retryClass: "host_deterministic",
    });
  }
  await assertExecutionActive();
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

export function resultFailure(error: unknown): SiteOpsProviderResult {
  if (error instanceof SiteOpsManusFailure) {
    return {
      status: error.status,
      code: error.code,
      message: /manus/iu.test(error.message)
        ? "FrontMind AI 建站任务未能安全推进，请稍后重试或由运营人员处理。"
        : error.message,
      ...(error.result ? { result: error.result } : {}),
    };
  }
  if (error instanceof ManusV2ApiError) {
    if (error.outcomeUnknown) {
      return {
        status: "outcome_unknown",
        code: "FRONTMIND_BUILD_RESULT_PENDING",
        message: "FrontMind AI 建站操作结果仍在确认中，系统不会重复创建任务。",
      };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        status: "failed",
        code: "FRONTMIND_BUILD_REQUEST_INVALID",
        message: "FrontMind AI 建站输入未通过上游协议校验，请重置后重新开始。",
        result: {
          schemaVersion: 1,
          stage:
            error.operation === "task.create"
              ? "create_rejected"
              : "request_rejected",
        },
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        status: "attention_required",
        code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
        message:
          "当前账号的 AI 建站 API Key 无法通过连接验证，请联系系统管理员检查该账号配置。",
      };
    }
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_SERVICE_UNAVAILABLE",
      message: "FrontMind AI 建站服务暂时不可用，请稍后重试。",
    };
  }
  return {
    status: "failed",
    code: "FRONTMIND_BUILD_FAILED",
    message: "FrontMind AI 建站任务未能安全完成，请重置后重新开始。",
  };
}

export function createManusSiteOpsProviderHandler(
  dependencies: ManusProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const getCredential =
    dependencies.getCredential ?? getDecryptedCredentialForUser;
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

  return async ({ operation, signal, assertLeaseActive }) => {
    try {
      const assertExecutionActive = async () => {
        signal.throwIfAborted();
        await assertLeaseActive?.();
        signal.throwIfAborted();
      };
      await assertExecutionActive();
      const db = await dbGetter();
      if (!db)
        throw new SiteOpsManusFailure(
          "DATABASE_UNAVAILABLE",
          "AI 建站数据库暂时不可用。",
        );
      const input = operationInputSchema.parse(operation.input);
      const credential = await assertFrozenCredential(
        input,
        operation.userId,
        getCredential,
      );
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
              `你是 FrontMind 企业内容编辑。必须遵守已附加并通过 manifest 校验的 ${context.package.channel} 内容包 workflow，以及 frontmind-social-source-documents-v1.json 中的冻结知识来源。生成${context.package.channel === "wechat" ? "微信公众号文章及三张封面所需文案" : "小红书九页图文（封面加八节）"}；不得编造数字、客户、资质或案例，不得请求账号凭据、排期或执行发布。主题：${input.topic || "基于企业知识库选择最有价值的主题"}。仅返回要求的结构化结果。`,
              token,
            );
            await persistOperationProgress(db, operation, {
              schemaVersion: 1,
              stage: "create_unknown",
            });
            try {
              await assertExecutionActive();
              const created = await client.createTask({
                title: operationTitle(operation),
                prompt,
                attachments: [
                  socialWorkflowAttachment(
                    context.package.channel,
                    socialWorkflow,
                  ),
                  siteOpsSocialSourceAttachment({
                    operationToken: token,
                    documents,
                  }),
                ],
                locale: "zh-CN",
                agentProfile: managedAgentProfileModel(input.agentProfile),
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
            try {
              await persistOperationProgress(
                db,
                operation,
                { schemaVersion: 1, stage: "content_pending", taskId },
                taskId,
              );
            } catch (error) {
              const code = error instanceof Error ? error.message : "";
              if (/^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(code)) {
                throw error;
              }
              return pending({ schemaVersion: 1, stage: "create_unknown" });
            }
            return pending(
              { schemaVersion: 1, stage: "content_pending", taskId },
              taskId,
            );
          }
        }
        await assertExecutionActive();
        const polled = await pollEvents(client, taskId, token);
        await assertExecutionActive();
        const value = acceptedSocialStructuredValue(polled.events, token);
        if (!value) {
          if (polled.waiting)
            throw new SiteOpsManusFailure(
              "FRONTMIND_SOCIAL_UNEXPECTED_WAITING_ACTION",
              "FrontMind AI 内容任务请求了当前流程不允许的交互，已安全停止。",
              "failed",
            );
          if (polled.state.failed)
            throw new SiteOpsManusFailure(
              "MANUS_SOCIAL_TASK_FAILED",
              "FrontMind AI 内容任务未生成可验证的结构化内容。",
              "failed",
            );
          const grace = structuredResultGrace(
            {
              schemaVersion: 1,
              stage: "content_pending",
              taskId,
              ...(state?.resultPendingSince
                ? { resultPendingSince: state.resultPendingSince }
                : {}),
            },
            polled.state.completed,
          );
          if (grace.expired)
            throw new SiteOpsManusFailure(
              "FRONTMIND_SOCIAL_OUTPUT_MISSING",
              "FrontMind AI 内容任务已结束，但未返回可验证的结构化结果。",
              "failed",
            );
          return pending(grace.state, taskId);
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
        await assertExecutionActive();
        const generated = await socialGenerate(generatedInput);
        await assertExecutionActive();
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
        await assertExecutionActive();
        if (archive.contentSha256 !== generated.archiveSha256)
          throw new SiteOpsManusFailure(
            "SOCIAL_ARCHIVE_HASH_MISMATCH",
            "社媒 ZIP 写入校验失败。",
            "failed",
          );
        const packageUpdated = await db
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
        const packageAffectedRows = Number(
          (Array.isArray(packageUpdated)
            ? (packageUpdated[0] as { affectedRows?: unknown } | undefined)
                ?.affectedRows
            : (packageUpdated as { affectedRows?: unknown } | undefined)
                ?.affectedRows) ?? 0,
        );
        if (packageAffectedRows !== 1) {
          throw new Error("SITEOPS_OPERATION_LEASE_LOST");
        }
        await assertExecutionActive();
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
      const workflow = siteOpsWorkflowForVersion(context.build.workflowVersion);
      const reactStatic = workflow.frontMindVersion.startsWith("2.");
      const designOutputFilename = reactStatic
        ? SITEOPS_WIRE_OUTPUT_FILES.designV3
        : SITEOPS_WIRE_OUTPUT_FILES.design;
      const contentOutputFilename =
        workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion
          ? SITEOPS_WIRE_OUTPUT_FILES.contentV3
          : SITEOPS_WIRE_OUTPUT_FILES.content;
      const referenceBlueprint = referenceBlueprintSchema.safeParse(
        input.referenceBlueprint,
      );
      const selectionV3 = isVisualSelectionBundleV3(selection.bundle)
        ? selection.bundle
        : null;
      const selectedV3Blueprint = selectionV3?.candidates.find(
        (candidate) => candidate.id === context.sample.id,
      )?.referenceBlueprint;
      if (
        reactStatic &&
        (!referenceBlueprint.success ||
          referenceBlueprint.data.candidateId !== context.sample.id ||
          referenceBlueprint.data.providerItemKey !==
            visualEvidence.providerItemKey ||
          referenceBlueprint.data.previewSha256 !==
            visualEvidence.previewSha256 ||
          (selectedV3Blueprint &&
            selectedV3Blueprint.blueprintHash !==
              referenceBlueprint.data.blueprintHash))
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_REFERENCE_BLUEPRINT_MISMATCH",
          "冻结的视觉构图合同与所选 Hero 不一致，请重新检索后选择。",
          "failed",
        );
      }
      const visualEvidenceInput = {
        queryHash: visualSelectionQueryHash(selection.bundle),
        selectedCandidateId: context.sample.id,
        providerItemKey: visualEvidence.providerItemKey,
        visualEvidenceSha256: visualEvidence.evidenceSha256,
        previewSha256: visualEvidence.previewSha256,
        supportEvidenceSha256s: supportingEvidence.map(
          (evidence) => evidence.evidenceSha256,
        ),
        taxonomy,
      };
      const visual = reactStatic
        ? siteOpsRuntimeVisualEvidenceV2Schema.parse({
            schemaVersion: 2,
            ...visualEvidenceInput,
            referenceBlueprint: referenceBlueprint.success
              ? referenceBlueprint.data
              : undefined,
          })
        : siteOpsRuntimeVisualEvidenceV1Schema.parse(visualEvidenceInput);
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
          const designPendingState: ProviderState = {
            schemaVersion: 1,
            stage: "design_pending",
            taskId,
          };
          try {
            await bindCreatedBuildTask({
              db,
              operation,
              buildId: context.build.id,
              taskId,
              state: designPendingState,
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (/^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(code)) {
              throw error;
            }
            if (code === "SITEOPS_BUILD_TASK_BINDING_CONFLICT") {
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_RESULT_PENDING",
                "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
              );
            }
            return pending(
              { schemaVersion: 1, stage: "create_unknown" },
              undefined,
              "design_compiling",
            );
          }
          return pending(designPendingState, taskId, "design_compiling");
        } else {
          const workflowPackage =
            await loadVerifiedSiteOpsWorkflowPackage(workflow);
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
            workflowAttachment(workflowPackage, workflow),
            ...siteOpsSourceDossierAttachments({
              operationToken: designToken,
              snapshot: {
                id: context.snapshot.id,
                archiveSha256: context.build.knowledgeArchiveHash,
                sourceBuildId: context.snapshot.sourceBuildId,
                sourceBuildRevision: context.snapshot.sourceBuildRevision,
              },
              brief: promptBrief,
              visualEvidence: visual,
              documents,
            }),
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
            reactStatic
              ? `你是 FrontMind 官网设计与信息架构师。严格遵守已附加且通过 manifest 校验的 React Static Company Site Workflow ${workflow.frontMindVersion}，并只使用 frontmind-siteops-source-dossier-v1.json 中冻结的 SiteBrief、视觉证据和知识来源。referenceBlueprint 是 Dashboard 已冻结的主视觉合同，不得替换 Hero family；selected-visual.png 是 FrontMind 可信宿主实际可生成的主视觉预览，不是客户网站素材。请返回 SiteDesignWireV3：为每个 route 输出按数组顺序排列且唯一的 routeSlots，并使用 dossier 中的冻结调色板；同时把完全相同的 JSON 对象附加为 ${designOutputFilename}，作为结构化抽取失败时的受控恢复副本。不得输出 Hero family、源码、HTML、CSS、依赖、脚本、第三方组件代码或未知事实。`
              : `你是 FrontMind 官网设计与信息架构师。严格遵守已附加且通过 manifest 校验的 Astro Company Site Workflow ${workflow.frontMindVersion}，并只使用冻结 SiteBrief、视觉证据和知识来源。请返回 SiteDesignWireV2，并把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.design}。不得输出源码、脚本、21st 代码或未知事实。`,
            designToken,
          );
          await persistOperationProgress(db, operation, {
            schemaVersion: 1,
            stage: "create_unknown",
          });
          try {
            await assertExecutionActive();
            const created = await client.createTask({
              title: operationTitle(operation),
              prompt,
              attachments: visualAttachments,
              locale: brief.primaryLanguage,
              agentProfile: managedAgentProfileModel(input.agentProfile),
              structuredOutputSchema: designOutputSchema(
                designToken,
                brief.routes.map((route) => route.id),
                taxonomy.palette.length,
                reactStatic ? "react_static" : "legacy_astro",
              ),
            });
            taskId = created.taskId;
          } catch (error) {
            if (error instanceof ManusV2ApiError && error.outcomeUnknown)
              return pending(
                { schemaVersion: 1, stage: "create_unknown" },
                undefined,
                "design_compiling",
              );
            throw error;
          }
          const designPendingState: ProviderState = {
            schemaVersion: 1,
            stage: "design_pending",
            taskId,
          };
          try {
            await bindCreatedBuildTask({
              db,
              operation,
              buildId: context.build.id,
              taskId,
              state: designPendingState,
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (/^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(code)) {
              throw error;
            }
            if (code === "SITEOPS_BUILD_TASK_BINDING_CONFLICT") {
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_RESULT_PENDING",
                "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
              );
            }
            // create_unknown was durably reserved before task.create. A
            // transient post-ack DB failure therefore reconciles by the exact
            // operation token instead of creating a second private task.
            return pending(
              { schemaVersion: 1, stage: "create_unknown" },
              undefined,
              "design_compiling",
            );
          }
          return pending(designPendingState, taskId, "design_compiling");
        }
      }

      if (context.build.upstreamManusTaskId !== taskId) {
        if (context.build.upstreamManusTaskId !== null) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_RESULT_PENDING",
            "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
          );
        }
        const updated = await db
          .update(siteBuilds)
          .set({ upstreamManusTaskId: taskId, updatedAt: new Date() })
          .where(
            and(
              eq(siteBuilds.id, context.build.id),
              eq(siteBuilds.userId, operation.userId),
              isNull(siteBuilds.upstreamManusTaskId),
            ),
          );
        const affectedRows = Number(
          (Array.isArray(updated)
            ? (updated[0] as { affectedRows?: unknown } | undefined)
                ?.affectedRows
            : (updated as { affectedRows?: unknown } | undefined)
                ?.affectedRows) ?? 0,
        );
        if (affectedRows !== 1) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_RESULT_PENDING",
            "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
          );
        }
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
                reactStatic ? "react_static" : "legacy_astro",
              )
            : generatedContentOutputSchema(
                repairToken,
                state.design?.designSpec.routeCompositions ?? [],
                documents.map((document) => document.id),
                workflow.frontMindVersion,
              );
        if (state.stage === "repair_send_ready") {
          const repairPrompt = promptWithMarker(
            state.repairKind === "design"
              ? reactStatic
                ? `继续同一个 FrontMind AI 建站任务。上一次 SiteDesignWireV3 未通过 Dashboard 严格合同。第 ${state.repairAttempt}/3 次修复：重新读取已附加 workflow、source dossier 与冻结视觉参考，完整返回 SiteDesignWireV3；不得返回或改变 Hero family，并把完全相同的 JSON 对象附加为 ${designOutputFilename}。不得输出源码、脚本或未知事实。`
                : `继续同一个 FrontMind AI 建站任务。上一次 SiteDesignWireV2 未通过 Dashboard 严格合同。第 ${state.repairAttempt}/3 次修复：完整返回 SiteDesignWireV2，并把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.design}。不得输出源码、脚本或未知事实。`
              : contentRepairPrompt({
                  repairAttempt: state.repairAttempt,
                  outputFilename: contentOutputFilename,
                  wireVersion:
                    workflow.frontMindVersion ===
                    SITEOPS_WORKFLOW.frontMindVersion
                      ? 3
                      : 2,
                }),
            repairToken,
          );
          const unknownState: ProviderState = {
            ...state,
            stage: "repair_send_unknown",
          };
          await persistOperationProgress(db, operation, unknownState, taskId);
          try {
            await assertExecutionActive();
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
        const repaired = await pollEvents(client, taskId, repairToken);
        const repairResolution = await resolveBuildWireValue({
          events: repaired.events,
          operationToken: repairToken,
          phase: state.repairKind,
          expectedFilename:
            state.repairKind === "design"
              ? designOutputFilename
              : contentOutputFilename,
          taskCompleted: repaired.state.completed,
          signal,
        });
        if (repairResolution.invalid) {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: state.repairKind,
            design: state.design,
          });
        }
        const rawRepair = repairResolution.value;
        if (!rawRepair) {
          if (repaired.waiting) {
            if (!messageAskUserWaiting(repaired.waiting))
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
                "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
                "failed",
              );
            const resolution = handledWaitingResolution(
              state,
              repaired.waiting.eventId,
            );
            if (resolution === "pending")
              return pending(
                state,
                taskId,
                state.repairKind === "design"
                  ? "design_compiling"
                  : "qa_running",
              );
            if (resolution === "expired")
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_WAITING_UNRESOLVED",
                "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
                "failed",
              );
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              design: state.design,
              handledWaitingEventId: repaired.waiting.eventId,
              handledWaitingAt: new Date().toISOString(),
            });
          }
          if (repaired.state.failed) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              design: state.design,
            });
          }
          const grace = structuredResultGrace(state, repaired.state.completed);
          if (grace.expired) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              design: state.design,
            });
          }
          return pending(
            grace.state,
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        if (state.repairKind === "design") {
          try {
            const repairedDesign =
              reactStatic && referenceBlueprint.success
                ? siteDesignResultV2FromWire(
                    rawRepair,
                    brief.routes.map((route) => route.id),
                    referenceBlueprint.data,
                  )
                : siteDesignResultFromWire(
                    rawRepair,
                    brief.routes.map((route) => route.id),
                  );
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
            return await scheduleRepair({
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
        const polled = await pollEvents(client, taskId, designToken);
        const designResolution = await resolveBuildWireValue({
          events: polled.events,
          operationToken: designToken,
          phase: "design",
          expectedFilename: designOutputFilename,
          taskCompleted: polled.state.completed,
          signal,
        });
        if (designResolution.invalid) {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "design",
          });
        }
        const raw = designResolution.value;
        if (!raw) {
          if (polled.waiting) {
            if (!messageAskUserWaiting(polled.waiting))
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
                "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
                "failed",
              );
            const resolution = handledWaitingResolution(
              state ?? {
                schemaVersion: 1,
                stage: "design_pending",
                taskId,
              },
              polled.waiting.eventId,
            );
            if (resolution === "pending")
              return pending(
                state ?? {
                  schemaVersion: 1,
                  stage: "design_pending",
                  taskId,
                },
                taskId,
                "design_compiling",
              );
            if (resolution === "expired")
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_WAITING_UNRESOLVED",
                "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
                "failed",
              );
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
              handledWaitingEventId: polled.waiting.eventId,
              handledWaitingAt: new Date().toISOString(),
            });
          }
          if (polled.state.failed) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
            });
          }
          const designPendingState: ProviderState = {
            schemaVersion: 1,
            stage: "design_pending",
            taskId,
            ...(state?.resultPendingSince
              ? { resultPendingSince: state.resultPendingSince }
              : {}),
          };
          const grace = structuredResultGrace(
            designPendingState,
            polled.state.completed,
          );
          if (grace.expired) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
            });
          }
          return pending(grace.state, taskId, "design_compiling");
        }
        try {
          design =
            reactStatic && referenceBlueprint.success
              ? siteDesignResultV2FromWire(
                  raw,
                  brief.routes.map((route) => route.id),
                  referenceBlueprint.data,
                )
              : siteDesignResultFromWire(
                  raw,
                  brief.routes.map((route) => route.id),
                );
          validateDesignAndContentBindings({
            routeIds: brief.routes.map((route) => route.id),
            paletteSize: taxonomy.palette.length,
            designSpec: design.designSpec,
          });
        } catch {
          return await scheduleRepair({
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
          ? "客户本次修改要求已作为 frontmind-customer-feedback-v1.json 附件提供，必须在事实与构建合同范围内落实。"
          : "这是首版官网内容。";
        const commonContract = {
          source: {
            knowledgeSnapshotId: context.snapshot.id,
            archiveSha256: context.build.knowledgeArchiveHash,
            sourceBuildId: context.snapshot.sourceBuildId,
            sourceBuildRevision: context.snapshot.sourceBuildRevision,
          },
          workflow: {
            upstreamSha256: workflow.upstreamSha256,
            version: workflow.frontMindVersion,
            manifestSha256: workflow.runtimeManifestSha256,
            starterVersion: workflow.starterVersion,
            starterSha256: workflow.starterSha256,
            componentLibraryVersion: workflow.componentLibraryVersion,
            materializerVersion: workflow.materializerVersion,
            materializerSha256: workflow.materializerSha256,
          },
          identity: {
            companyName: brief.companyName,
            primaryLanguage: brief.primaryLanguage,
            verifiedContacts: brief.contacts.map(
              (contact) => `${contact.kind}:${contact.value}`,
            ),
          },
          routes: brief.routes,
          assets: assetDecisions,
          seo: {
            ...design.designSpec.seoPlan,
            environment: "preview",
            canonicalPolicy: "forbidden",
          },
          target: { environment: "preview", canonicalOrigin: null },
          qaPolicyVersion: workflow.qaPolicyVersion,
        } as const;
        const canonicalContract =
          reactStatic && referenceBlueprint.success
            ? (() => {
                const rendererCoordinates =
                  reactStaticRendererCoordinates(workflow);
                const parsedVisual =
                  siteOpsRuntimeVisualEvidenceV2Schema.parse(visual);
                const {
                  schemaVersion: _visualSchemaVersion,
                  referenceBlueprint: _visualReferenceBlueprint,
                  ...visualEvidence
                } = parsedVisual;
                const currentContentContract =
                  workflow.frontMindVersion ===
                  SITEOPS_WORKFLOW.frontMindVersion;
                return currentContentContract
                  ? composeBuildPlanContractV4({
                      schemaVersion: 4,
                      contractKind: "build_plan",
                      ...commonContract,
                      renderer: {
                        kind: "react_static_v2",
                        reactVersion: "19.2.1",
                        componentLibraryVersion: "2.2.0",
                        materializerVersion: "2.2.0",
                      },
                      content: {
                        schemaVersion: 2,
                        inventoryHash: canonicalSiteOpsSha256(
                          brief.contentInventory,
                        ),
                        routePolicyVersion: "snapshot-conditional-v1",
                        sourcePolicy: "frozen_snapshot_only",
                        externalAcquisitionAllowed: false,
                        publicSourceLabels: "forbidden",
                      },
                      visual: visualEvidence,
                      referenceBlueprint: referenceBlueprint.data,
                      designSpecHash: canonicalSiteOpsSha256(design.designSpec),
                    })
                  : composeBuildPlanContractV3({
                      schemaVersion: 3,
                      contractKind: "build_plan",
                      ...commonContract,
                      renderer: {
                        kind: "react_static_v1",
                        reactVersion: "19.2.1",
                        componentLibraryVersion:
                          rendererCoordinates.componentLibraryVersion as
                            | "2.0.0"
                            | "2.1.0",
                        materializerVersion:
                          rendererCoordinates.materializerVersion as
                            | "2.0.0"
                            | "2.1.0",
                      },
                      visual: visualEvidence,
                      referenceBlueprint: referenceBlueprint.data,
                      designSpecHash: canonicalSiteOpsSha256(design.designSpec),
                    });
              })()
            : composeBuildContractV2({
                schemaVersion: 2,
                ...commonContract,
                visual: {
                  ...siteOpsRuntimeVisualEvidenceV1Schema.parse(visual),
                  designSpecHash: canonicalSiteOpsSha256(design.designSpec),
                  componentLibraryVersion: workflow.componentLibraryVersion,
                },
              });
        const contractAttachment =
          reactStatic && referenceBlueprint.success
            ? workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion
              ? siteOpsBuildPlanContractV4Attachment(canonicalContract)
              : siteOpsBuildPlanContractV3Attachment(canonicalContract)
            : siteOpsBuildContractAttachment(canonicalContract);
        const prompt = promptWithMarker(
          workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion
            ? `继续同一个 FrontMind AI 建站任务。frontmind-build-plan-contract-v4.json 是 Dashboard 根据已校验设计与冻结知识库存生成的预物化计划合同；冻结的 ReferenceBlueprint、Hero family、route 与 inventory 不可更改。请返回 PageContentWireV3：使用受支持的 typed blockType，实体、FAQ 与 officialLinks 只能来自 source dossier 且逐项绑定 sourceDocumentIds；不得输出内部来源标签。若 news route 在 inventory 中没有 company_news，必须保留该 route 但不要为它输出 block 或 company_news entity，Dashboard 会渲染可信空状态。不得浏览、抓取或编造行业/企业新闻。把完全相同的 JSON 对象附加为 ${contentOutputFilename}。不得重复 SEO，不得生成源码、HTML、依赖、表单提交或外部脚本。${revisionInstruction}`
            : reactStatic
              ? `继续同一个 FrontMind AI 建站任务。frontmind-build-plan-contract-v3.json 是 Dashboard 根据已校验设计生成的预物化计划合同；冻结的 ReferenceBlueprint 与 Hero family 不可更改，source dossier 仍是唯一事实来源。请返回 PageContentWireV2，routeId 与 slotId 必须按合同完全一致，每段关键内容必须引用允许的 sourceDocumentIds；同时把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.content}，作为结构化抽取失败时的受控恢复副本。不得重复 SEO，不得生成源码、HTML、依赖、表单提交、外部脚本或未知事实。${revisionInstruction}`
              : `继续同一个 FrontMind AI 建站任务。frontmind-build-contract-v2.json 是 Dashboard 根据已校验设计生成的唯一构建合同；source dossier 仍是唯一事实来源。请返回 PageContentWireV2，并严格匹配冻结 route、slot 与 sourceDocumentIds；同时把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.content}，作为结构化抽取失败时的受控恢复副本。${revisionInstruction}`,
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
          await assertExecutionActive();
          await client.sendMessage({
            taskId,
            prompt,
            attachments: [
              contractAttachment,
              ...(input.feedback
                ? [siteOpsCustomerFeedbackAttachment(input.feedback)]
                : []),
            ],
            structuredOutputSchema: generatedContentOutputSchema(
              contentToken,
              design.designSpec.routeCompositions,
              documents.map((document) => document.id),
              workflow.frontMindVersion,
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
        repairedContent === null
          ? await pollEvents(client, taskId, contentToken)
          : null;
      const contentResolution = polled
        ? await resolveBuildWireValue({
            events: polled.events,
            operationToken: contentToken,
            phase: "content",
            expectedFilename: contentOutputFilename,
            taskCompleted: polled.state.completed,
            signal,
          })
        : null;
      if (contentResolution?.invalid) {
        return await scheduleRepair({
          db,
          operation,
          build: context.build,
          taskId,
          kind: "content",
          design,
        });
      }
      const rawContent = repairedContent ?? contentResolution?.value ?? null;
      if (!rawContent) {
        if (polled!.waiting) {
          if (!messageAskUserWaiting(polled!.waiting))
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
              "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
              "failed",
            );
          const resolution = handledWaitingResolution(
            state ?? {
              schemaVersion: 1,
              stage: "content_pending",
              taskId,
              design,
            },
            polled!.waiting.eventId,
          );
          if (resolution === "pending")
            return pending(
              state ?? {
                schemaVersion: 1,
                stage: "content_pending",
                taskId,
                design,
              },
              taskId,
              "building",
            );
          if (resolution === "expired")
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_WAITING_UNRESOLVED",
              "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
              "failed",
            );
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            design,
            handledWaitingEventId: polled!.waiting.eventId,
            handledWaitingAt: new Date().toISOString(),
          });
        }
        if (polled!.state.failed) {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            design,
          });
        }
        const contentPendingState: ProviderState = {
          schemaVersion: 1,
          stage: "content_pending",
          taskId,
          design,
          ...(state?.resultPendingSince
            ? { resultPendingSince: state.resultPendingSince }
            : {}),
        };
        const grace = structuredResultGrace(
          contentPendingState,
          polled!.state.completed,
        );
        if (grace.expired) {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            design,
          });
        }
        return pending(grace.state, taskId, "building");
      }
      let generatedContent: z.infer<typeof siteOpsGeneratedContentSchema>;
      try {
        const currentContent =
          workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion;
        const contentResult = currentContent
          ? pageContentResultV2FromWire(
              rawContent,
              brief.routes.map((route) => route.id),
              documents.map((document) => document.id),
              brief.contentInventory.entries.some(
                (entry) => entry.kind === "company_news",
              )
                ? []
                : ["news"],
            )
          : pageContentResultFromWire(
              rawContent,
              brief.routes.map((route) => route.id),
              documents.map((document) => document.id),
            );
        validateDesignAndContentBindings({
          routeIds: brief.routes.map((route) => route.id),
          paletteSize: taxonomy.palette.length,
          designSpec: design!.designSpec,
          pageContent: contentResult.pageContent,
        });
        generatedContent = currentContent
          ? siteOpsGeneratedContentV2Schema.parse({
              seo: design!.designSpec.seoPlan,
              ...contentResult.pageContent,
            })
          : siteOpsGeneratedContentSchema.parse({
              seo: design!.designSpec.seoPlan,
              routes: contentResult.pageContent.routes,
            });
      } catch {
        return await scheduleRepair({
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
      const materializationStartedAt = Date.now();
      let localRetryCount = 0;
      try {
        await assertExecutionActive();
        const attempt = await materializeWithSingleHostRetry({
          signal,
          run: () =>
            materialize({
              build: context.build,
              snapshot: { ...context.snapshot, documents },
              brief,
              visual,
              designSpec: design!.designSpec,
              generatedContent,
              assetDecisions,
              brandAsset,
              mode: "preview",
              abortSignal: signal,
            }),
        });
        materialized = attempt.value;
        localRetryCount = attempt.localRetryCount;
        await assertExecutionActive();
      } catch (error) {
        signal.throwIfAborted();
        const classified = classifySiteOpsMaterializationFailure(error);
        if (classified.retryClass === "content_repair") {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            design,
          });
        }
        const safeDetails = safeMaterializationDetails(classified, {
          durationMs: Date.now() - materializationStartedAt,
          assetDecisionCount: assetDecisions.length,
          publishedCount: assetDecisions.filter(
            (decision) => decision.decision === "publish",
          ).length,
          omittedDuplicateCount: assetDecisions.filter(
            (decision) => decision.decision === "omit",
          ).length,
          quarantineCount: assetDecisions.filter(
            (decision) => decision.decision === "quarantine",
          ).length,
          localRetryCount:
            classified.retryClass === "host_transient" ? 1 : localRetryCount,
        });
        const diagnostics = {
          schemaVersion: 1,
          stage: "materialization_failed",
          taskId,
          materialization: {
            phase: classified.phase,
            internalCode: classified.code,
            retryClass: classified.retryClass,
            safeDetails,
          },
        } satisfies Record<string, unknown>;
        console.error("[siteops-manus] materialization_failed", {
          event: "siteops_materialization_failed",
          operationId: operation.id,
          projectId: operation.projectId,
          buildId: context.build.id,
          providerTaskId: taskId,
          workflowVersion: context.build.workflowVersion,
          phase: classified.phase,
          internalCode: classified.code,
          retryClass: classified.retryClass,
          ...safeDetails,
        });
        return publicMaterializationFailure(classified, taskId, diagnostics);
      }
      let artifacts: Awaited<ReturnType<typeof persistBuildArtifacts>>;
      try {
        artifacts = await persistBuildArtifacts(
          operation,
          materialized,
          persist,
          assertExecutionActive,
        );
      } catch (error) {
        signal.throwIfAborted();
        const classified =
          error instanceof SiteOpsMaterializationError
            ? error
            : new SiteOpsMaterializationError({
                phase: "artifact_persistence",
                code: "SITEOPS_BUILD_ARTIFACT_PERSISTENCE_FAILED",
                retryClass: "host_deterministic",
                cause: error,
              });
        const safeDetails = safeMaterializationDetails(classified, {
          durationMs: Date.now() - materializationStartedAt,
          assetDecisionCount: assetDecisions.length,
          publishedCount: assetDecisions.filter(
            (decision) => decision.decision === "publish",
          ).length,
          omittedDuplicateCount: assetDecisions.filter(
            (decision) => decision.decision === "omit",
          ).length,
          quarantineCount: assetDecisions.filter(
            (decision) => decision.decision === "quarantine",
          ).length,
          localRetryCount,
        });
        const diagnostics = {
          schemaVersion: 1,
          stage: "materialization_failed",
          taskId,
          materialization: {
            phase: classified.phase,
            internalCode: classified.code,
            retryClass: classified.retryClass,
            safeDetails,
          },
        } satisfies Record<string, unknown>;
        console.error("[siteops-manus] materialization_failed", {
          event: "siteops_materialization_failed",
          operationId: operation.id,
          projectId: operation.projectId,
          buildId: context.build.id,
          providerTaskId: taskId,
          workflowVersion: context.build.workflowVersion,
          phase: classified.phase,
          internalCode: classified.code,
          retryClass: classified.retryClass,
          ...safeDetails,
        });
        return publicMaterializationFailure(classified, taskId, diagnostics);
      }
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
          artifactBindings: {
            contract: {
              id: artifacts.contract.id,
              sha256: materialized.contractSha256,
              bytes: materialized.contractJson.length,
              mimeType: "application/json",
            },
            source: {
              id: artifacts.source.id,
              sha256: materialized.sourceSha256,
              bytes: materialized.sourceZip.length,
              mimeType: "application/zip",
            },
            dist: {
              id: artifacts.dist.id,
              sha256: materialized.distSha256,
              bytes: materialized.distZip.length,
              mimeType: "application/zip",
            },
            qa: {
              id: artifacts.qa.id,
              sha256: materialized.visualQaSha256,
              bytes: materialized.visualQaZip.length,
              mimeType: "application/zip",
            },
            provenance: {
              id: artifacts.provenance.id,
              sha256: materialized.provenanceSha256,
              bytes: materialized.provenanceJson.length,
              mimeType: "application/json",
            },
          },
        },
        message: completedSiteBuildMessage(),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof Error &&
        /^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(error.message)
      ) {
        throw error;
      }
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
