import { z } from "zod";
import {
  siteBriefSchema,
  siteOpsBuildStatusSchema,
  siteOpsCardSchema,
  siteOpsProjectStatusSchema,
} from "./siteops";
import { managedAgentProfileSchema } from "./manus-agent-profile";

export type SiteOpsAgentProfile = z.infer<typeof managedAgentProfileSchema>;

export const siteOpsKnowledgeSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(255),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceProfile: z.string().trim().min(1).max(64).nullable().default(null),
    createdAt: z.string().datetime(),
    active: z.boolean().default(false),
  })
  .strict();

export const siteOpsProjectProjectionSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    status: siteOpsProjectStatusSchema,
    currentKnowledgeSnapshotId: z.string().uuid().nullable(),
    primaryLanguage: z.string().trim().min(2).max(32),
    canonicalHostname: z.string().trim().max(255).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const siteOpsMessageProjectionSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().max(100_000),
    sequence: z.number().int().nonnegative(),
    metadata: z
      .object({
        siteOps: siteOpsCardSchema.optional(),
      })
      .passthrough()
      .nullable()
      .default(null),
    sentAt: z.string().datetime(),
  })
  .strict();

export const siteOpsVisualCandidateProjectionSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-I]$/),
    title: z.string().trim().min(1).max(255),
    previewUrl: z.string().min(1).max(2_048),
    note: z.string().trim().max(2_000).nullable().default(null),
    score: z.number().finite().min(0).max(100),
    heroVariant: z
      .enum([
        "centered_statement",
        "split_media",
        "editorial_modular",
        "immersive_visual",
      ])
      .optional(),
    heroConfidence: z.enum(["explicit", "strong", "conditional"]).optional(),
    selected: z.boolean().default(false),
  })
  .strict();

export const siteOpsBuildProjectionSchema = z
  .object({
    id: z.string().uuid(),
    ordinal: z.number().int().positive(),
    parentBuildId: z.string().uuid().nullable(),
    agentProfile: managedAgentProfileSchema.nullable().optional(),
    status: siteOpsBuildStatusSchema,
    previewUrl: z.string().max(2_048).nullable().default(null),
    sourceUrl: z.string().max(2_048).nullable().default(null),
    qaUrl: z.string().max(2_048).nullable().default(null),
    errorCode: z.string().max(128).nullable().default(null),
    errorMessage: z.string().max(4_000).nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const siteOpsDeploymentProjectionSchema = z
  .object({
    id: z.string().uuid(),
    buildId: z.string().uuid(),
    target: z.enum(["global_excluding_cn", "mainland_cn"]),
    status: z.enum([
      "reserved",
      "deploying",
      "verifying",
      "active",
      "failed",
      "attention_required",
      "superseded",
    ]),
    publicUrl: z.string().max(2_048).nullable().default(null),
    createdAt: z.string().datetime(),
  })
  .strict();

export const siteOpsSocialPackageProjectionSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.enum(["wechat", "xiaohongshu"]),
    status: z.enum([
      "queued",
      "building",
      "qa_running",
      "ready",
      "failed",
      "attention_required",
      "cancelled",
    ]),
    archiveUrl: z.string().max(2_048).nullable().default(null),
    createdAt: z.string().datetime(),
  })
  .strict();

export const siteOpsAliyunConnectionProjectionSchema = z
  .object({
    configured: z.boolean(),
    accountUid: z.string().max(128).nullable(),
    roleArn: z.string().max(512).nullable(),
    externalIdFingerprint: z.string().max(32).nullable(),
    status: z.enum(["unverified", "active", "invalid", "revoked"]).nullable(),
    capabilities: z.array(z.string().max(64)).max(20),
    verifiedAt: z.string().datetime().nullable(),
    lastErrorCode: z.string().max(128).nullable(),
    canRotate: z.boolean().default(true),
  })
  .strict();

export const siteOpsDomainStateProjectionSchema = z
  .object({
    domain: z.string().max(255).nullable(),
    displayDomain: z.string().max(255).nullable(),
    revision: z.number().int().positive(),
    registrar: z.string().max(64).nullable(),
    providerAccountUid: z.string().max(128).nullable(),
    expiresAt: z.string().datetime().nullable(),
    realNameStatus: z.string().max(64).nullable(),
    emailStatus: z.string().max(64).nullable(),
    clientHold: z.boolean(),
    ownershipStatus: z.string().max(64).nullable(),
    dnsStatus: z.string().max(64).nullable(),
    autoRenewDesired: z.boolean(),
    autoRenewObserved: z.boolean().nullable(),
    icpStatus: z.enum([
      "not_submitted",
      "preparing",
      "submitted",
      "approved",
      "rejected",
      "not_required",
    ]),
    icpDomainRevision: z.number().int().positive().nullable(),
    icpVerifiedAt: z.string().datetime().nullable(),
  })
  .strict();

export const siteOpsDomainOperationProjectionSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum([
      "search",
      "purchase",
      "renewal",
      "set_auto_renew",
      "cancel_auto_renew",
      "sync",
    ]),
    domain: z.string().max(255),
    displayDomain: z.string().max(255).nullable(),
    status: z.enum([
      "quoted",
      "reserved",
      "submitted",
      "reconciling",
      "succeeded",
      "failed",
      "outcome_unknown",
      "attention_required",
      "expired",
      "cancelled",
    ]),
    quoteHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    quoteExpiresAt: z.string().datetime().nullable(),
    amountMinor: z.number().int().nonnegative().nullable(),
    currency: z.string().max(8).nullable(),
    years: z.number().int().positive().nullable(),
    maskedRegistrantName: z.string().max(255).nullable(),
    searchResult: z
      .object({
        available: z.boolean(),
        premium: z.boolean(),
        reason: z.string().max(1_000).nullable(),
      })
      .strict()
      .nullable(),
    registrantProfiles: z
      .array(
        z
          .object({
            profileId: z.string().max(191),
            holderType: z.enum(["individual", "enterprise", "unknown"]),
            maskedName: z.string().max(255),
            realNameVerified: z.boolean(),
            emailVerified: z.boolean(),
            isDefault: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    errorCode: z.string().max(128).nullable(),
    errorMessage: z.string().max(2_000).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const siteOpsDnsPlanProjectionSchema = z
  .object({
    operationId: z.string().uuid(),
    domain: z.string().max(255),
    domainRevision: z.number().int().positive(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    providerSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    canApply: z.boolean(),
    status: z.enum(["succeeded", "attention_required"]),
    items: z
      .array(
        z
          .object({
            id: z.string().max(191),
            action: z.enum([
              "create",
              "update",
              "adopt",
              "verify",
              "rollback_update",
              "rollback_delete",
              "conflict",
              "unknown",
            ]),
            rr: z.string().max(255),
            type: z.string().max(16),
            expectedValue: z.string().max(2_048),
            expectedTtl: z.number().int().positive(),
            currentValue: z.string().max(2_048).nullable(),
            currentTtl: z.number().int().positive().nullable(),
            reason: z.string().max(2_000).nullable(),
          })
          .strict(),
      )
      .max(100),
    createdAt: z.string().datetime(),
  })
  .strict();

export const siteOpsInteractionStateSchema = z.enum([
  "select_snapshot",
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

export const siteOpsObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    executionKind: z.literal("site_ops"),
    providerState: z
      .object({
        twentyFirst: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
        aiBuilder: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
        esa: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
        aliyun: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
      })
      .strict(),
    aliyunConnection: siteOpsAliyunConnectionProjectionSchema,
    domainState: siteOpsDomainStateProjectionSchema.nullable(),
    domainOperations: z
      .array(siteOpsDomainOperationProjectionSchema)
      .max(20)
      .default([]),
    dnsPlan: siteOpsDnsPlanProjectionSchema.nullable().default(null),
    project: siteOpsProjectProjectionSchema,
    brief: siteBriefSchema.nullable(),
    knowledgeSnapshots: z
      .array(siteOpsKnowledgeSnapshotSchema)
      .max(200)
      .default([]),
    messages: z.array(siteOpsMessageProjectionSchema).max(1_000),
    visualCandidates: z
      .array(siteOpsVisualCandidateProjectionSchema)
      .max(9)
      .default([]),
    builds: z.array(siteOpsBuildProjectionSchema).max(100).default([]),
    deployments: z
      .array(siteOpsDeploymentProjectionSchema)
      .max(100)
      .default([]),
    socialPackages: z
      .array(siteOpsSocialPackageProjectionSchema)
      .max(100)
      .default([]),
    resetCapability: z
      .object({
        allowed: z.boolean(),
        reason: z.string().trim().min(1).max(1_000).optional(),
      })
      .strict(),
    interactionState: siteOpsInteractionStateSchema,
    latestSequence: z.number().int().nonnegative(),
  })
  .strict();

export type SiteOpsKnowledgeSnapshot = z.infer<
  typeof siteOpsKnowledgeSnapshotSchema
>;
export type SiteOpsProjectProjection = z.infer<
  typeof siteOpsProjectProjectionSchema
>;
export type SiteOpsMessageProjection = z.infer<
  typeof siteOpsMessageProjectionSchema
>;
export type SiteOpsPublicVisualCandidate = z.infer<
  typeof siteOpsVisualCandidateProjectionSchema
>;
export type SiteOpsBuildProjection = z.infer<
  typeof siteOpsBuildProjectionSchema
>;
export type SiteOpsObservationV1 = z.infer<typeof siteOpsObservationV1Schema>;
