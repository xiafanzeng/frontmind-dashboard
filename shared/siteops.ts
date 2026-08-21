import { z } from "zod";

export const SITEOPS_WORKFLOW = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.1.0",
  runtimeManifestSha256:
    "9be677c02ef05d93f08acecf290196065f0ecc2b7c4bbfc097e81b6b29ed4f84",
  starterVersion: "1.1.0",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

export const siteOpsProjectStatusSchema = z.enum([
  "draft",
  "collecting_brief",
  "visual_searching",
  "awaiting_visual_selection",
  "building",
  "preview_ready",
  "approved",
  "live",
  "attention_required",
  "failed",
  "cancelled",
]);

export const siteOpsOperationKindSchema = z.enum([
  "brief_message",
  "visual_search",
  "site_build",
  "build_revision",
  "deploy",
  "rollback",
  "social_package",
  "domain_search",
  "domain_purchase",
  "domain_renewal",
  "domain_auto_renew",
  "dns_apply",
  "dns_rollback",
]);

export const siteOpsOperationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
  "attention_required",
  "cancelled",
]);

export const siteOpsBuildStatusSchema = z.enum([
  "preparing",
  "visual_searching",
  "awaiting_visual_selection",
  "design_compiling",
  "contract_ready",
  "building",
  "qa_running",
  "preview_ready",
  "approved",
  "failed",
  "attention_required",
  "cancelled",
  "superseded",
]);

export const siteOpsCardKindSchema = z.enum([
  "brief_question",
  "visual_board",
  "visual_choice",
  "build_progress",
  "build_preview",
  "qa_failed",
  "publish_options",
  "domain_quote",
  "domain_status",
  "icp_status",
  "content_review",
  "social_package",
  "operation_recovery",
  "release_status",
]);

export const siteOpsCardSchema = z
  .object({
    kind: siteOpsCardKindSchema,
    subjectId: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    status: z.enum(["active", "resolved", "expired"]),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const siteBriefSchema = z
  .object({
    companyName: z.string().trim().min(1).max(255),
    primaryLanguage: z.literal("zh-CN").or(z.string().trim().min(2).max(32)),
    contacts: z
      .array(
        z
          .object({
            kind: z.enum(["email", "phone", "address"]),
            value: z.string().trim().min(1).max(512),
            sourceDocumentIds: z.array(z.string().max(191)).max(20).default([]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    offerings: z.array(z.string().trim().min(1).max(500)).max(50),
    audience: z.array(z.string().trim().min(1).max(500)).max(30),
    conversionGoal: z.string().trim().min(1).max(500),
    routes: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            slug: z.string().trim().min(1).max(191),
            title: z.string().trim().min(1).max(255),
            sourceDocumentIds: z.array(z.string().max(191)).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    verifiedFacts: z
      .array(
        z
          .object({
            statement: z.string().trim().min(1).max(2_000),
            sourceDocumentIds: z.array(z.string().max(191)).min(1).max(50),
          })
          .strict(),
      )
      .max(200),
    publicAssetIds: z.array(z.string().max(191)).max(100).default([]),
    unknowns: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict();

export const visualTaxonomySchema = z
  .object({
    role: z.enum(["foundation", "section", "motion"]),
    palette: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
    typography: z.array(z.string().trim().min(1).max(128)).max(12).default([]),
    layout: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    motion: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    accessibility: z
      .array(z.string().trim().min(1).max(128))
      .max(20)
      .default([]),
  })
  .strict();

export const visualCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-I]$/),
    providerItemId: z.string().trim().min(1).max(512),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomy: visualTaxonomySchema,
    score: z.number().finite().min(0).max(100),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const visualSelectionBundleSchema = z
  .object({
    queryHash: z.string().regex(/^[a-f0-9]{64}$/),
    searchTarget: z.literal(18),
    detailTarget: z.literal(12),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateSchema).min(1).max(9),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict();

export const buildContractV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({
        knowledgeSnapshotId: z.string().uuid(),
        archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceBuildId: z.string().max(191).nullable(),
        sourceBuildRevision: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    workflow: z
      .object({
        upstreamSha256: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.string().max(32),
        packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
        starterVersion: z.string().max(32),
      })
      .strict(),
    identity: z
      .object({
        companyName: z.string().min(1).max(255),
        primaryLanguage: z.string().min(2).max(32),
        verifiedContacts: z.array(z.string().max(512)).max(20),
      })
      .strict(),
    visual: z
      .object({
        queryHash: z.string().regex(/^[a-f0-9]{64}$/),
        selectedCandidateId: z.string().max(191),
        promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
        taxonomy: visualTaxonomySchema,
      })
      .strict(),
    routes: siteBriefSchema.shape.routes,
    assets: z
      .array(
        z
          .object({
            id: z.string().max(191),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            decision: z.enum(["publish", "omit", "quarantine"]),
          })
          .strict(),
      )
      .max(500),
    seo: z.record(z.string(), z.unknown()),
    target: z
      .object({
        environment: z.enum(["preview", "global_excluding_cn", "mainland_cn"]),
        canonicalOrigin: z.string().url().nullable(),
      })
      .strict(),
    qaPolicyVersion: z.string().max(64),
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const siteOpsOpenInputSchema = z.object({}).strict().optional();

export const siteOpsObserveInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    afterSequence: z.number().int().nonnegative().optional(),
  })
  .strict();

export const siteOpsAliyunConnectionSetupInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    accountUid: z
      .string()
      .trim()
      .regex(/^\d{6,64}$/),
    roleArn: z
      .string()
      .trim()
      .regex(/^acs:ram::\d{6,64}:role\/[A-Za-z0-9.@_-]+$/),
  })
  .strict();

export const siteOpsAliyunConnectionInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
  })
  .strict();

export const siteOpsSendMessageInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    clientRequestId: z.string().trim().min(8).max(128),
    text: z.string().trim().min(1).max(20_000),
    localAssetIds: z.array(z.string().uuid()).max(20).default([]),
    expectedProjectRevision: z.number().int().positive(),
  })
  .strict();

export const siteOpsActionSchema = z.enum([
  "select_snapshot",
  "change_snapshot",
  "start_visual_search",
  "reselect_visual",
  "select_visual",
  "delegate_visual",
  "approve_build",
  "request_revision",
  "publish_global",
  "publish_mainland",
  "rollback",
  "create_wechat_package",
  "create_xiaohongshu_package",
  "domain_search",
  "domain_sync",
  "domain_prepare_purchase",
  "domain_confirm_purchase",
  "domain_prepare_renewal",
  "domain_confirm_renewal",
  "domain_set_auto_renew",
  "dns_plan",
  "dns_apply",
  "dns_rollback",
]);

export const siteOpsActInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    messageId: z.string().trim().min(1).max(191).optional(),
    cardKind: siteOpsCardKindSchema.optional(),
    action: siteOpsActionSchema,
    clientRequestId: z.string().trim().min(8).max(128),
    expectedRevision: z.number().int().positive(),
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type SiteOpsCard = z.infer<typeof siteOpsCardSchema>;
export type SiteBrief = z.infer<typeof siteBriefSchema>;
export type VisualSelectionBundle = z.infer<typeof visualSelectionBundleSchema>;
export type BuildContractV1 = z.infer<typeof buildContractV1Schema>;
export type SiteOpsActInput = z.infer<typeof siteOpsActInputSchema>;
