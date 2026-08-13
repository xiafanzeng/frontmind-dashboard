import { createHash } from "node:crypto";

import { z } from "zod";

import {
  knowledgeBaseIncidentRepairKinds,
  type KnowledgeBaseIncidentRepairApplyResult,
  type KnowledgeBaseIncidentRepairKind,
  type KnowledgeBaseIncidentRepairPreview,
} from "./knowledge-base-incident-repair";
import {
  parseResetPollutionCleanupCliArgs,
  type ResetPollutionCleanupCliCommand,
} from "./knowledge-base-reset-pollution-cleanup-cli-core";

export const KNOWLEDGE_BASE_INCIDENT_REPAIR_CLI_ERROR_PREFIX =
  "KB_INCIDENT_REPAIR_CLI";
export const KNOWLEDGE_BASE_INCIDENT_REPAIR_CLI_LOCK_NAME =
  "frontmind_kb_incident_repair";
export const KNOWLEDGE_BASE_INCIDENT_REPAIR_REASON_CODE =
  "authorized_incident_recovery";

const sha40 = z.string().regex(/^[a-f0-9]{40}$/u);
const sha64 = z.string().regex(/^[a-f0-9]{64}$/u);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const repairKindSchema = z.enum(knowledgeBaseIncidentRepairKinds);

function fail(code: string): never {
  throw new Error(`${KNOWLEDGE_BASE_INCIDENT_REPAIR_CLI_ERROR_PREFIX}_${code}`);
}

export type KnowledgeBaseIncidentRepairCliCommand =
  | {
      mode: "preview";
      userId: number;
      conversationId: string;
      repairKind: KnowledgeBaseIncidentRepairKind;
    }
  | {
      mode: "apply";
      userId: number;
      conversationId: string;
      repairKind: KnowledgeBaseIncidentRepairKind;
      expectedStateHash: string;
      reasonCode: typeof KNOWLEDGE_BASE_INCIDENT_REPAIR_REASON_CODE;
    }
  | ResetPollutionCleanupCliCommand;

export function parseKnowledgeBaseIncidentRepairCliArgs(
  argv: readonly string[],
): KnowledgeBaseIncidentRepairCliCommand {
  const [mode, ...rawOptions] = argv;
  if (mode === "reset-pollution-preview" || mode === "reset-pollution-apply") {
    return parseResetPollutionCleanupCliArgs(argv);
  }
  if (mode !== "preview" && mode !== "apply") fail("COMMAND_INVALID");
  const values = new Map<string, string>();
  for (const option of rawOptions) {
    const match = option.match(/^--([a-z][a-z0-9-]*)=(.*)$/u);
    if (!match) fail("ARGUMENT_FORMAT_INVALID");
    const [, name, value] = match;
    if (values.has(name!)) fail("ARGUMENT_DUPLICATE");
    values.set(name!, value!);
  }
  const allowed = new Set([
    "user-id",
    "conversation-id",
    "repair-kind",
    ...(mode === "apply" ? ["expected-state-sha256", "reason-code"] : []),
  ]);
  if ([...values.keys()].some((name) => !allowed.has(name))) {
    fail("ARGUMENT_UNKNOWN");
  }
  if (values.size !== allowed.size) fail("ARGUMENT_REQUIRED");

  const userIdValue = values.get("user-id")!;
  if (!/^[1-9]\d{0,9}$/u.test(userIdValue)) fail("USER_ID_INVALID");
  const userId = Number(userIdValue);
  if (!Number.isSafeInteger(userId) || userId > 2_147_483_647) {
    fail("USER_ID_INVALID");
  }
  const conversationId = values.get("conversation-id")!;
  if (
    !conversationId ||
    conversationId.length > 191 ||
    conversationId.trim() !== conversationId ||
    /[\u0000-\u001f\u007f]/u.test(conversationId)
  ) {
    fail("CONVERSATION_ID_INVALID");
  }
  const parsedRepairKind = repairKindSchema.safeParse(
    values.get("repair-kind"),
  );
  if (!parsedRepairKind.success) fail("REPAIR_KIND_INVALID");
  const common = {
    userId,
    conversationId,
    repairKind: parsedRepairKind.data,
  };
  if (mode === "preview") return { mode, ...common };

  const expectedStateHash = values.get("expected-state-sha256")!;
  if (!sha64.safeParse(expectedStateHash).success) {
    fail("EXPECTED_STATE_SHA256_INVALID");
  }
  const reasonCode = values.get("reason-code");
  if (reasonCode !== KNOWLEDGE_BASE_INCIDENT_REPAIR_REASON_CODE) {
    fail("REASON_CODE_INVALID");
  }
  return {
    mode,
    ...common,
    expectedStateHash,
    reasonCode,
  };
}

const readinessSchema = z
  .object({
    status: z.literal("ok"),
    channel: z.enum(["development", "production"]),
    build: z
      .object({
        sha: sha40,
        imageDigest,
      })
      .passthrough(),
    migration: z
      .object({
        status: z.literal("exact"),
        schema: z.object({ status: z.literal("exact") }).passthrough(),
      })
      .passthrough(),
    configuration: z
      .object({
        knowledgeBaseManusV2Writer: z
          .object({
            enabled: z.literal(true),
            newBuildProviderProtocol: z.literal("manus_v2"),
          })
          .passthrough(),
        knowledgeBaseManusV2ActiveMigration: z
          .object({ enabled: z.literal(false) })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type KnowledgeBaseIncidentRepairCliRuntimeIdentity = {
  buildSourceSha: string;
  releaseChannel: string;
};

export function assertKnowledgeBaseIncidentRepairCliRuntime(input: {
  env: NodeJS.ProcessEnv;
  compiledBuildSha: string;
  compiledReleaseChannel: string;
  runtimeIdentity: KnowledgeBaseIncidentRepairCliRuntimeIdentity;
  readiness: unknown;
  skipLoopbackReadiness?: boolean;
}) {
  if (input.env.NODE_ENV !== "production") fail("SIGNED_RUNTIME_REQUIRED");
  if (!sha40.safeParse(input.compiledBuildSha).success) {
    fail("COMPILED_BUILD_SHA_INVALID");
  }
  if (
    !new Set(["development", "production"]).has(input.compiledReleaseChannel)
  ) {
    fail("COMPILED_RELEASE_CHANNEL_INVALID");
  }
  if (
    input.runtimeIdentity.buildSourceSha !== input.compiledBuildSha ||
    input.runtimeIdentity.releaseChannel !== input.compiledReleaseChannel ||
    input.env.FRONTMIND_BUILD_SHA !== input.compiledBuildSha ||
    input.env.FRONTMIND_RELEASE_CHANNEL !== input.compiledReleaseChannel ||
    !imageDigest.safeParse(input.env.FRONTMIND_IMAGE_DIGEST).success
  ) {
    fail("RUNTIME_IDENTITY_MISMATCH");
  }
  if (
    input.env.FRONTMIND_KB_MANUS_V2_WRITER !== "true" ||
    input.env.FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION !== "false"
  ) {
    fail("ROLLOUT_PHASE_INVALID");
  }
  if (input.skipLoopbackReadiness === true) return null;
  const readiness = readinessSchema.safeParse(input.readiness);
  if (!readiness.success) fail("READINESS_CONTRACT_INVALID");
  if (
    readiness.data.channel !== input.compiledReleaseChannel ||
    readiness.data.build.sha !== input.compiledBuildSha ||
    readiness.data.build.imageDigest !== input.env.FRONTMIND_IMAGE_DIGEST
  ) {
    fail("READINESS_IDENTITY_MISMATCH");
  }
  return readiness.data;
}

export function knowledgeBaseIncidentRepairCliSha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const reselectionSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  code: z.enum([
    "manifest_invalid",
    "ownership_mismatch",
    "missing",
    "unreadable",
    "size_mismatch",
    "sha256_mismatch",
  ]),
});

const resultSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["preview", "apply"]).nullable(),
    success: z.boolean(),
    code: z.string().regex(/^KB_INCIDENT_REPAIR_CLI_[A-Z0-9_]{1,96}$/u),
    repairKind: repairKindSchema.nullable(),
    buildSourceSha: sha40.nullable(),
    imageDigestSha256: sha64.nullable(),
    stateSha256: sha64.nullable(),
    expectedStateSha256: sha64.nullable(),
    observedStateSha256: sha64.nullable(),
    applicable: z.boolean().nullable(),
    applied: z.boolean().nullable(),
    noopReason: z
      .enum(["state_changed", "predicate_not_met", "requires_reselection"])
      .nullable(),
    blockerCodes: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/u)).max(32),
    requiresReselection: z.array(reselectionSchema).max(99),
    buildGeneration: z.number().int().nonnegative().nullable(),
    buildRevision: z.number().int().nonnegative().nullable(),
    stateEpoch: z.number().int().nonnegative().nullable(),
    previousGeneration: z.number().int().nonnegative().nullable(),
    generation: z.number().int().nonnegative().nullable(),
    nodeCount: z.number().int().nonnegative().nullable(),
    userAttachmentCount: z.number().int().nonnegative().nullable(),
    buildIdSha256: sha64.nullable(),
    replacementTurnIdSha256: sha64.nullable(),
    lockReleased: z.boolean(),
  })
  .strict();

export type KnowledgeBaseIncidentRepairCliResult = z.infer<typeof resultSchema>;

function baseResult(input: {
  mode: "preview" | "apply" | null;
  code: string;
  success: boolean;
  repairKind: KnowledgeBaseIncidentRepairKind | null;
  buildSourceSha?: string | null;
  imageDigest?: string | null;
}): KnowledgeBaseIncidentRepairCliResult {
  return {
    schemaVersion: 1,
    mode: input.mode,
    success: input.success,
    code: input.code,
    repairKind: input.repairKind,
    buildSourceSha: input.buildSourceSha ?? null,
    imageDigestSha256: input.imageDigest?.startsWith("sha256:")
      ? input.imageDigest.slice("sha256:".length)
      : null,
    stateSha256: null,
    expectedStateSha256: null,
    observedStateSha256: null,
    applicable: null,
    applied: null,
    noopReason: null,
    blockerCodes: [],
    requiresReselection: [],
    buildGeneration: null,
    buildRevision: null,
    stateEpoch: null,
    previousGeneration: null,
    generation: null,
    nodeCount: null,
    userAttachmentCount: null,
    buildIdSha256: null,
    replacementTurnIdSha256: null,
    lockReleased: false,
  };
}

function safeBlockerCodes(blockers: readonly string[]) {
  return blockers
    .slice(0, 32)
    .map((code) =>
      /^[a-z0-9_]{1,64}$/u.test(code) ? code : "unknown_blocker",
    );
}

export function knowledgeBaseIncidentRepairCliPreviewResult(input: {
  preview: KnowledgeBaseIncidentRepairPreview;
  buildSourceSha: string;
  imageDigest: string;
  lockReleased: boolean;
}): KnowledgeBaseIncidentRepairCliResult {
  return {
    ...baseResult({
      mode: "preview",
      success: input.lockReleased && input.preview.applicable,
      code: !input.lockReleased
        ? "KB_INCIDENT_REPAIR_CLI_LOCK_RELEASE_UNCONFIRMED"
        : input.preview.applicable
          ? "KB_INCIDENT_REPAIR_CLI_PREVIEW_COMPLETE"
          : "KB_INCIDENT_REPAIR_CLI_PREVIEW_NOT_APPLICABLE",
      repairKind: input.preview.repairKind,
      buildSourceSha: input.buildSourceSha,
      imageDigest: input.imageDigest,
    }),
    stateSha256: input.preview.stateHash,
    applicable: input.preview.applicable,
    blockerCodes: safeBlockerCodes(input.preview.blockers),
    requiresReselection: input.preview.requiresReselection,
    buildGeneration: input.preview.buildGeneration,
    buildRevision: input.preview.buildRevision,
    stateEpoch: input.preview.stateEpoch,
    nodeCount: input.preview.nodeCount,
    userAttachmentCount: input.preview.userAttachmentCount,
    lockReleased: input.lockReleased,
  };
}

export function knowledgeBaseIncidentRepairCliApplyResult(input: {
  result: KnowledgeBaseIncidentRepairApplyResult;
  buildSourceSha: string;
  imageDigest: string;
  lockReleased: boolean;
}): KnowledgeBaseIncidentRepairCliResult {
  const code = !input.lockReleased
    ? "KB_INCIDENT_REPAIR_CLI_LOCK_RELEASE_UNCONFIRMED"
    : input.result.applied
      ? "KB_INCIDENT_REPAIR_CLI_APPLY_COMPLETE"
      : `KB_INCIDENT_REPAIR_CLI_APPLY_NOOP_${input.result.noopReason!.toUpperCase()}`;
  return {
    ...baseResult({
      mode: "apply",
      success: input.lockReleased,
      code,
      repairKind: input.result.repairKind,
      buildSourceSha: input.buildSourceSha,
      imageDigest: input.imageDigest,
    }),
    expectedStateSha256: input.result.expectedStateHash,
    observedStateSha256: input.result.observedStateHash,
    applied: input.result.applied,
    noopReason: input.result.noopReason,
    requiresReselection: input.result.requiresReselection,
    previousGeneration: input.result.previousGeneration,
    generation: input.result.generation,
    nodeCount: input.result.nodeCount,
    userAttachmentCount: input.result.userAttachmentCount,
    buildIdSha256: knowledgeBaseIncidentRepairCliSha256(input.result.buildId),
    replacementTurnIdSha256: input.result.replacementTurnId
      ? knowledgeBaseIncidentRepairCliSha256(input.result.replacementTurnId)
      : null,
    lockReleased: input.lockReleased,
  };
}

export function knowledgeBaseIncidentRepairCliFailureResult(input: {
  error: unknown;
  command?: KnowledgeBaseIncidentRepairCliCommand | null;
  buildSourceSha?: string | null;
  imageDigest?: string | null;
}): KnowledgeBaseIncidentRepairCliResult {
  const raw = input.error instanceof Error ? input.error.message : "";
  const code = /^KB_INCIDENT_REPAIR_CLI_[A-Z0-9_]{1,96}$/u.test(raw)
    ? raw
    : "KB_INCIDENT_REPAIR_CLI_FAILED";
  return baseResult({
    mode:
      input.command?.mode === "preview" || input.command?.mode === "apply"
        ? input.command.mode
        : null,
    success: false,
    code,
    repairKind:
      input.command && "repairKind" in input.command
        ? input.command.repairKind
        : null,
    buildSourceSha: sha40.safeParse(input.buildSourceSha).success
      ? input.buildSourceSha
      : null,
    imageDigest: imageDigest.safeParse(input.imageDigest).success
      ? input.imageDigest
      : null,
  });
}

export function serializeKnowledgeBaseIncidentRepairCliResult(
  value: KnowledgeBaseIncidentRepairCliResult,
) {
  return `${JSON.stringify(resultSchema.parse(value))}\n`;
}
