import { z } from "zod";

/** Immutable coordinates for the FrontMind 1.2 host materializer. Keep this
 * record when a later workflow registers a new handler. */
export const SITEOPS_MATERIALIZER_V1_2 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.2.0",
  runtimeManifestSha256:
    "5123e62b0ee7f5c73a9ee42410bb62276938a765781d28ad2345b7ce3814cad6",
  starterVersion: "1.2.0",
  starterSha256:
    "441c938e156745de1469f527649397a087ca4379bffa2a4e47d12bcbc94662fe",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "ba508966169adbd03f87444d499644697b2a5ccaa9b67d0b74730448aaf1eecf",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.3 keeps the trusted materializer implementation while changing
 * the frozen visual-provider evidence contract to search-only V2 bundles. */
export const SITEOPS_MATERIALIZER_V1_3 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.3.0",
  runtimeManifestSha256:
    "6c4b7aed53a2ba821a05a749690efe7686c75dbfd4011b6dcc7b8ae1550fe1bf",
  starterVersion: "1.3.0",
  starterSha256:
    "ad058ea2db058859e5bf5f6399ae027af98f256fba98eeff32c3b075a27cbbff",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "f309d1ecabbef376df54fcd9976c37ff5408a62a9f16aabfc8ca699413c76b5a",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.4 keeps the trusted host materializer while freezing Hero-only
 * visual evidence, attachment-bound knowledge and flat provider wire output. */
export const SITEOPS_MATERIALIZER_V1_4 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.4.0",
  runtimeManifestSha256:
    "a0e52bf6b61c7e1bbd6c506d1b00a6922e2e844f88d9c198b363b04a6c3f4039",
  starterVersion: "1.4.0",
  starterSha256:
    "a7b23f68b51c4a4f3b14ed74a625dfda855817e59c865c9424b9ffd45dcacc4d",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "981a1af2cc6d9030173b9be0a7ec073e60d0303ab4af3c8769b27293221bdce7",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.5 removes redundant provider-owned SEO/order fields while
 * retaining the same strict canonical specifications and trusted host. */
export const SITEOPS_MATERIALIZER_V1_5 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.5.0",
  runtimeManifestSha256:
    "4c7230dc43444e51eb6e87c531168a401f3ce0e787ec70b3e1070671daeb8248",
  starterVersion: "1.5.0",
  starterSha256:
    "07e07aa3618e8967e120cba6b68897b4b73d8a7a79edbfd10f747bb69d75ba69",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "4b28fdd0f22a1a694b2b1248cffdf59c9eb3e37f383ec4bae1e340d1147a351a",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.6 freezes Dashboard-owned JSON-data/Astro-template
 * materialization, SHA-alias asset decisions, semantic contrast roles and
 * typed host materialization stages while retaining Wire V2 provider output. */
export const SITEOPS_MATERIALIZER_V1_6 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.6.0",
  runtimeManifestSha256:
    "89d3b2986f82c460dc5115405b1d2204dff8820a5b15eeeab489e7e2ae806cd3",
  starterVersion: "1.6.0",
  starterSha256:
    "cdb266816ee05d32f57a697ea4e9f54575d84715af63eb231c0c7516cd653c2d",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.6.0",
  materializerSha256:
    "fc2a878a5880cd1a66a487dff5feccc8188389dc643088f25881340fc157f2c7",
  qaPolicyVersion: "siteops-qa-v2",
} as const;

/** React Static 2.0 freezes the high-fidelity ReferenceBlueprintV2, renders
 * host-owned React 19 components to complete static HTML and finalizes an
 * immutable BuildContractV3 only after source/dist digests exist. */
export const SITEOPS_MATERIALIZER_V2_0 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.0.0",
  runtimeManifestSha256:
    "fe38fafa49b1e0a4565c7ac27e5e0c80ff1109232eb00e3543b60623559c2ca4",
  starterVersion: "2.0.0",
  starterSha256:
    "9bef440d7d732f384adccd0d2443610010315c43611335c7292bba84937d93ac",
  componentLibraryVersion: "2.0.0",
  materializerVersion: "2.0.0",
  materializerSha256:
    "e186cbbe63b15b782c9d02e4943da219be0d1ced91f629629e3745f47030b0e0",
  qaPolicyVersion: "siteops-qa-v3",
} as const;

export const SITEOPS_WORKFLOW = SITEOPS_MATERIALIZER_V2_0;

const SITEOPS_WORKFLOWS_BY_VERSION = {
  [SITEOPS_MATERIALIZER_V1_2.frontMindVersion]: SITEOPS_MATERIALIZER_V1_2,
  [SITEOPS_MATERIALIZER_V1_3.frontMindVersion]: SITEOPS_MATERIALIZER_V1_3,
  [SITEOPS_MATERIALIZER_V1_4.frontMindVersion]: SITEOPS_MATERIALIZER_V1_4,
  [SITEOPS_MATERIALIZER_V1_5.frontMindVersion]: SITEOPS_MATERIALIZER_V1_5,
  [SITEOPS_MATERIALIZER_V1_6.frontMindVersion]: SITEOPS_MATERIALIZER_V1_6,
  [SITEOPS_MATERIALIZER_V2_0.frontMindVersion]: SITEOPS_MATERIALIZER_V2_0,
} as const;

export function siteOpsWorkflowForVersion(version: string) {
  const workflow =
    SITEOPS_WORKFLOWS_BY_VERSION[
      version as keyof typeof SITEOPS_WORKFLOWS_BY_VERSION
    ];
  if (!workflow)
    throw new Error(`SITEOPS_WORKFLOW_VERSION_UNSUPPORTED:${version}`);
  return workflow;
}

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

export const visualEvidenceV1Schema = z
  .object({
    evidenceKind: z.literal("catalog_metadata_preview_v1"),
    providerItemKey: z
      .string()
      .trim()
      .min(3)
      .max(514)
      .regex(/^(?:n:[1-9]\d*|s:.+)$/u),
    metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
    providerResponseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomyDerivationVersion: z.literal("catalog-metadata-preview-v1"),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const visualCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-I]$/),
    providerItemKey: z.string().trim().min(3).max(514),
    visualEvidence: visualEvidenceV1Schema,
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomy: visualTaxonomySchema,
    score: z.number().finite().min(0).max(100),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerItemKey !== value.visualEvidence.providerItemKey) {
      context.addIssue({
        code: "custom",
        path: ["visualEvidence", "providerItemKey"],
        message: "Visual evidence provider item does not match candidate",
      });
    }
    if (value.previewSha256 !== value.visualEvidence.previewSha256) {
      context.addIssue({
        code: "custom",
        path: ["visualEvidence", "previewSha256"],
        message: "Visual evidence preview does not match candidate",
      });
    }
  });

export const visualSelectionBundleV1Schema = z
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

export const visualQueryAxisSchema = z.enum([
  "foundation_split",
  "foundation_editorial_modular",
  "section_proof_conversion",
  "motion_accessible",
]);

const visualCandidateV2BaseSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    queryAxis: visualQueryAxisSchema,
    providerItemKey: z.string().trim().min(3).max(514),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(300).nullable(),
    author: z.string().trim().min(1).max(300).nullable(),
    sourceUrl: z.string().url().max(2_048).nullable(),
    visualEvidence: visualEvidenceV1Schema,
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomy: visualTaxonomySchema,
    score: z.number().finite().min(0).max(100),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

function expectedRoleForVisualAxis(
  axis: z.infer<typeof visualQueryAxisSchema>,
) {
  if (axis.startsWith("foundation_")) return "foundation" as const;
  if (axis.startsWith("section_")) return "section" as const;
  return "motion" as const;
}

function validateVisualCandidateCoordinates(
  value: z.infer<typeof visualCandidateV2BaseSchema>,
  context: z.RefinementCtx,
) {
  if (value.providerItemKey !== value.visualEvidence.providerItemKey) {
    context.addIssue({
      code: "custom",
      path: ["visualEvidence", "providerItemKey"],
      message: "Visual evidence provider item does not match candidate",
    });
  }
  if (value.previewSha256 !== value.visualEvidence.previewSha256) {
    context.addIssue({
      code: "custom",
      path: ["visualEvidence", "previewSha256"],
      message: "Visual evidence preview does not match candidate",
    });
  }
  if (value.taxonomy.role !== expectedRoleForVisualAxis(value.queryAxis)) {
    context.addIssue({
      code: "custom",
      path: ["taxonomy", "role"],
      message: "Visual taxonomy role does not match query axis",
    });
  }
}

export const visualCandidateV2Schema = visualCandidateV2BaseSchema
  .extend({ label: z.string().regex(/^[A-I]$/) })
  .strict()
  .superRefine(validateVisualCandidateCoordinates);

export const visualSupportingCandidateV2Schema =
  visualCandidateV2BaseSchema.superRefine(validateVisualCandidateCoordinates);

export const visualSelectionBundleV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    queryPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    searchTarget: z.literal(18),
    shortlistTarget: z.literal(12),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateV2Schema).min(1).max(9),
    supportingCandidates: z
      .array(visualSupportingCandidateV2Schema)
      .max(2)
      .default([]),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const labels = new Set<string>();
    for (const candidate of value.candidates) {
      if (labels.has(candidate.label)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", "label"],
          message: "Visual candidate labels must be unique",
        });
      }
      labels.add(candidate.label);
    }
    const ids = new Set<string>();
    const providerKeys = new Set<string>();
    const assetIds = new Set<string>();
    const evidenceHashes = new Set<string>();
    for (const candidate of [
      ...value.candidates,
      ...value.supportingCandidates,
    ]) {
      for (const [collection, coordinate, path] of [
        [ids, candidate.id, "id"],
        [providerKeys, candidate.providerItemKey, "providerItemKey"],
        [assetIds, candidate.previewLocalAssetId, "previewLocalAssetId"],
        [
          evidenceHashes,
          candidate.visualEvidence.evidenceSha256,
          "visualEvidence.evidenceSha256",
        ],
      ] as const) {
        if (collection.has(coordinate)) {
          context.addIssue({
            code: "custom",
            path: [path],
            message: "Visual selection coordinates must be unique",
          });
        }
        collection.add(coordinate);
      }
    }
    if (
      value.selectedCandidateId !== null &&
      !value.candidates.some(
        (candidate) => candidate.id === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected visual candidate is absent",
      });
    }
  });

/** Immutable V1 artifacts remain readable; every new visual operation writes V2. */
export const visualSelectionBundleSchema = z.union([
  visualSelectionBundleV2Schema,
  visualSelectionBundleV1Schema,
]);

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
  "reset_workflow",
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
export type VisualSelectionBundleV1 = z.infer<
  typeof visualSelectionBundleV1Schema
>;
export type VisualSelectionBundleV2 = z.infer<
  typeof visualSelectionBundleV2Schema
>;
export type VisualSelectionBundle = z.infer<typeof visualSelectionBundleSchema>;
export type BuildContractV1 = z.infer<typeof buildContractV1Schema>;
export type SiteOpsActInput = z.infer<typeof siteOpsActInputSchema>;
