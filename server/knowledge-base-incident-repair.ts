import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  messages,
  upstreamResources,
  type Conversation,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
  type UpstreamResource,
} from "../drizzle/schema";
import { getDb } from "./db";
import { writeSystemMaintenanceWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  knowledgeBaseConversationStorageId,
  sanitizeKnowledgeBaseRecoveryMetadata,
} from "./knowledge-base-turn-service";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  knowledgeBaseManusV2ActiveMigrationEnabled,
  knowledgeBaseManusV2InitialCreateEnabled,
} from "./knowledge-base-manus-v2-rollout";

export const knowledgeBaseIncidentRepairKinds = [
  "legacy_skill_404_confirm",
  "retained_upstream_create_3_start",
] as const;

export type KnowledgeBaseIncidentRepairKind =
  (typeof knowledgeBaseIncidentRepairKinds)[number];

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RETAINED_SOURCE_BYTES = 100 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

type CredentialFact = {
  id: string;
  userId: number;
  status: string;
} | null;

export type KnowledgeBaseIncidentRepairFacts = {
  build: KnowledgeBaseBuild;
  activeTurn: ConversationTurn | null;
  nodes: KnowledgeBaseBuildNode[];
  conversation: Conversation | null;
  credential: CredentialFact;
  attachmentResources: UpstreamResource[];
  /** Immutable assistant receipts bound to the selected source turn. */
  acceptedReceiptCount?: number;
  /** The source was recovered from history because build.activeTurnId is null. */
  historicalSourceTurn?: boolean;
  /** Current active credential selected for the replacement Provider writer. */
  replacementCredential?: CredentialFact;
  /** New uploaded sources are owned by replacementCredential, not the source turn. */
  replacementSourcesProvided?: boolean;
};

export type KnowledgeBaseIncidentRepairReselection = {
  ordinal: number;
  code:
    | "manifest_invalid"
    | "ownership_mismatch"
    | "missing"
    | "unreadable"
    | "size_mismatch"
    | "sha256_mismatch";
};

export type KnowledgeBaseIncidentRepairPreviewFacts =
  KnowledgeBaseIncidentRepairFacts & {
    retainedSourceProofs?: KnowledgeBaseIncidentRepairReselection[];
  };

export type KnowledgeBaseIncidentRepairPreview = {
  repairKind: KnowledgeBaseIncidentRepairKind;
  stateHash: string;
  applicable: boolean;
  blockers: string[];
  requiresReselection: KnowledgeBaseIncidentRepairReselection[];
  buildGeneration: number;
  buildRevision: number;
  stateEpoch: number;
  nodeCount: number;
  userAttachmentCount: number;
  plannedActions: string[];
};

export type KnowledgeBaseIncidentRepairApplyResult = {
  applied: boolean;
  noopReason:
    | null
    | "state_changed"
    | "predicate_not_met"
    | "requires_reselection";
  repairKind: KnowledgeBaseIncidentRepairKind;
  expectedStateHash: string;
  observedStateHash: string;
  buildId: string;
  previousGeneration: number;
  generation: number;
  replacementTurnId: string | null;
  nodeCount: number;
  userAttachmentCount: number;
  requiresReselection: KnowledgeBaseIncidentRepairReselection[];
};

export type KnowledgeBaseRetainedStartReplay = {
  turnId: string;
  clientRequestId: string;
  generation: number;
  mode: "resume_start_from_retained_sources" | "reselect_start_sources";
};

type RepairDependencies = {
  getDatabase?: typeof getDb;
  readStoredFile?: typeof readStoredPresalesFile;
  environment?: NodeJS.ProcessEnv;
  maintenanceAuthority?: symbol;
};

/**
 * This capability is intentionally module-private. It cannot be serialized,
 * reconstructed from CLI arguments, or supplied through the administrator
 * router. Only the signed-image maintenance wrappers below can attach it to a
 * preview/apply invocation.
 */
const SIGNED_IMAGE_MAINTENANCE_AUTHORITY = Symbol(
  "frontmind.knowledge-base.incident-repair.signed-image-maintenance",
);

export type ApplyKnowledgeBaseIncidentRepairInput = {
  userId: number;
  conversationId: string;
  repairKind: KnowledgeBaseIncidentRepairKind;
  expectedStateHash: string;
  /** Customer-owned retry identity; persisted on the unique replacement. */
  clientRequestId?: string;
  /** Current active credential; historical source credentials are provenance only. */
  replacementCredentialId?: string;
  replacementSources?: {
    apiCredentialId?: string;
    attachments: Array<{ file_id: string; filename: string }>;
    attachmentManifest: Array<{
      filename: string;
      sizeBytes: number;
      mimeType: string;
      lastModified: number;
      sha256: string;
    }>;
  };
  now?: Date;
  afterApplyInTransaction?: (
    result: KnowledgeBaseIncidentRepairApplyResult,
    executor: any,
  ) => Promise<void>;
  onBeforeCommit?: (input: {
    result: KnowledgeBaseIncidentRepairApplyResult;
    facts: KnowledgeBaseIncidentRepairFacts;
    sourceTurn: ConversationTurn;
    replacementTurn: typeof conversationTurns.$inferInsert;
    buildUpdate: Partial<typeof knowledgeBaseBuilds.$inferInsert>;
    conversationUpdate: Partial<typeof conversations.$inferInsert>;
    executor: any;
  }) => Promise<void>;
};

export class KnowledgeBaseIncidentRepairAuthorizationError extends Error {
  readonly code = "MANUS_V2_REPAIR_ROLLOUT_DISABLED";

  constructor() {
    super(
      "The incident repair requires an explicit Manus v2 writer or active-migration rollout",
    );
    this.name = "KnowledgeBaseIncidentRepairAuthorizationError";
  }
}

export function assertKnowledgeBaseIncidentRepairRolloutAuthorized(
  repairKind: KnowledgeBaseIncidentRepairKind,
  environment: NodeJS.ProcessEnv = process.env,
  maintenanceAuthority?: symbol,
) {
  const writerEnabled = knowledgeBaseManusV2InitialCreateEnabled(environment);
  const activeMigration =
    knowledgeBaseManusV2ActiveMigrationEnabled(environment);
  if (
    maintenanceAuthority === SIGNED_IMAGE_MAINTENANCE_AUTHORITY &&
    writerEnabled &&
    !activeMigration
  ) {
    return;
  }
  // The 15:52 replacement remains a legacy-shaped, not-sent turn until the
  // active-migration cutover atomically installs its self-contained v2
  // handoff. Authorizing it with only the new-build writer would let ordinary
  // recovery fall through to the legacy task.create path.
  if (repairKind === "legacy_skill_404_confirm" && !activeMigration) {
    throw new KnowledgeBaseIncidentRepairAuthorizationError();
  }
  if (repairKind === "retained_upstream_create_3_start" && !writerEnabled) {
    throw new KnowledgeBaseIncidentRepairAuthorizationError();
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function derivedCreateAttemptState(turn: ConversationTurn) {
  if (turn.upstreamTaskId) return "acknowledged";
  const metadata = record(turn.metadata);
  const stored = safeString(metadata.createAttemptState);
  if (
    stored &&
    ["not_sent", "sending", "acknowledged", "rejected", "unknown"].includes(
      stored,
    )
  ) {
    return stored;
  }
  if (metadata.dispatchingAt || metadata.outcomeUnknownAt) return "unknown";
  return "not_sent";
}

function generatedAttachmentState(metadata: JsonRecord) {
  const reservations = record(metadata.generatedAttachmentReservations);
  return Object.entries(reservations)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, raw]) => {
      const value = record(raw);
      return {
        slot,
        role: safeString(value.role),
        attachmentIndex: safeInteger(value.attachmentIndex),
        requestHash: safeString(value.requestHash),
        contentSha256: safeString(value.contentSha256),
        sizeBytes: safeInteger(value.sizeBytes),
        status: safeString(value.status),
        replacementCount: safeInteger(value.replacementCount),
      };
    });
}

function operationMetadataState(turn: ConversationTurn) {
  const metadata = record(turn.metadata);
  const prepared = record(metadata.preparedDispatch);
  return {
    attachmentsFrozen: metadata.attachmentsFrozen === true,
    awaitingClientAttachments: metadata.awaitingClientAttachments === true,
    expectedAttachmentCount: safeInteger(metadata.expectedAttachmentCount),
    userAttachmentCount: safeInteger(metadata.userAttachmentCount),
    clientAttachmentManifestHash: safeString(
      metadata.clientAttachmentManifestHash,
    ),
    expectedPresentationKey: safeString(metadata.expectedPresentationKey),
    createAttemptState: derivedCreateAttemptState(turn),
    providerProtocol: safeString(metadata.providerProtocol),
    providerMethod: safeString(metadata.providerMethod),
    providerAttemptState: safeString(metadata.providerAttemptState),
    operationToken: safeString(metadata.operationToken),
    frozenProviderRequestHash: safeString(metadata.frozenProviderRequestHash),
    dispatchState: safeString(metadata.dispatchState),
    failureClass: safeString(metadata.failureClass),
    recoveryAction: safeString(metadata.recoveryAction),
    preparedDispatch:
      Object.keys(prepared).length === 0
        ? null
        : {
            schemaVersion: safeInteger(prepared.schemaVersion),
            bodySha256: safeString(prepared.bodySha256),
            preparedAt: safeString(prepared.preparedAt),
          },
    recoverySha256: hashKnowledgeBaseTurnRequest(record(metadata.recovery)),
    generatedAttachments: generatedAttachmentState(metadata),
    supersedesTurnId: safeString(metadata.supersedesTurnId),
    supersededByTurnId: safeString(metadata.supersededByTurnId),
    repairKind: safeString(metadata.repairKind),
  };
}

/**
 * Hash-only repair authority. The hash includes actual node markdown digests,
 * not merely the stored digest column, so a stale/tampered contentSha256 value
 * can never hide accepted-content drift between preview and apply.
 */
export function knowledgeBaseIncidentRepairState(
  facts: KnowledgeBaseIncidentRepairFacts,
) {
  const { build, activeTurn } = facts;
  return {
    schemaVersion: 1,
    build: {
      id: build.id,
      userId: build.userId,
      conversationId: build.conversationId,
      generation: build.generation,
      stateEpoch: build.stateEpoch,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      currentPresentationKey: build.currentPresentationKey,
      status: build.status,
      activeTurnId: build.activeTurnId,
      providerProtocol: build.providerProtocol,
      upstreamTaskIdSha256: build.upstreamTaskId
        ? sha256(build.upstreamTaskId)
        : null,
      canonicalTaskIdSha256: build.canonicalTaskId
        ? sha256(build.canonicalTaskId)
        : null,
      canonicalTaskGeneration: build.canonicalTaskGeneration,
      canonicalCredentialId: build.canonicalCredentialId,
      canonicalTaskState: build.canonicalTaskState,
      lastAppliedOperationKey: build.lastAppliedOperationKey,
      totalNodeCount: build.totalNodeCount,
      confirmedCount: build.confirmedCount,
      directPrefilledCount: build.directPrefilledCount,
      needsVerificationCount: build.needsVerificationCount,
      protocolErrorCode: build.protocolErrorCode,
      historicalSourceTurn: facts.historicalSourceTurn === true,
      acceptedReceiptCount: facts.acceptedReceiptCount ?? 0,
    },
    conversation: facts.conversation
      ? {
          id: facts.conversation.id,
          userId: facts.conversation.userId,
          projectAssignmentId: facts.conversation.projectAssignmentId,
          status: facts.conversation.status,
          version: facts.conversation.version,
          deletedAt: facts.conversation.deletedAt,
          apiCredentialId: facts.conversation.apiCredentialId,
        }
      : null,
    activeTurn: activeTurn
      ? {
          id: activeTurn.id,
          conversationId: activeTurn.conversationId,
          userId: activeTurn.userId,
          apiCredentialId: activeTurn.apiCredentialId,
          clientRequestId: activeTurn.clientRequestId,
          buildId: activeTurn.buildId,
          buildGeneration: activeTurn.buildGeneration,
          operationKey: activeTurn.operationKey,
          operationType: activeTurn.operationType,
          expectedRevision: activeTurn.expectedRevision,
          expectedLeafId: activeTurn.expectedLeafId,
          requestHash: activeTurn.requestHash,
          upstreamIdempotencyKeyHash: activeTurn.upstreamIdempotencyKeyHash,
          attachmentFileIdsSha256: hashKnowledgeBaseTurnRequest(
            activeTurn.attachmentFileIds,
          ),
          attachmentFileCount: activeTurn.attachmentFileIds.length,
          status: activeTurn.status,
          upstreamTaskIdSha256: activeTurn.upstreamTaskId
            ? sha256(activeTurn.upstreamTaskId)
            : null,
          errorCode: activeTurn.errorCode,
          metadata: operationMetadataState(activeTurn),
        }
      : null,
    nodes: [...facts.nodes]
      .sort(
        (left, right) =>
          left.ordinal - right.ordinal ||
          left.leafId.localeCompare(right.leafId),
      )
      .map((node) => ({
        id: node.id,
        leafId: node.leafId,
        ordinal: node.ordinal,
        status: node.status,
        storedContentSha256: node.contentSha256,
        actualContentSha256: sha256(String(node.contentMarkdown ?? "")),
        presentationKey: node.presentationKey,
        sourceTurnId: node.sourceTurnId,
      })),
    credential: facts.credential
      ? {
          id: facts.credential.id,
          userId: facts.credential.userId,
          status: facts.credential.status,
        }
      : null,
    attachmentResources: [...facts.attachmentResources]
      .sort((left, right) => left.upstreamId.localeCompare(right.upstreamId))
      .map((resource) => ({
        upstreamIdSha256: sha256(resource.upstreamId),
        userId: resource.userId,
        apiCredentialId: resource.apiCredentialId,
        projectAssignmentId: resource.projectAssignmentId,
        kind: resource.kind,
        conversationId: resource.conversationId,
        contentDeletedAt: resource.contentDeletedAt,
      })),
  };
}

export function hashKnowledgeBaseIncidentRepairState(
  facts: KnowledgeBaseIncidentRepairFacts,
) {
  return hashKnowledgeBaseTurnRequest(knowledgeBaseIncidentRepairState(facts));
}

function userAttachments(turn: ConversationTurn | null) {
  if (!turn) return [];
  const recovery = record(record(turn.metadata).recovery);
  return Array.isArray(recovery.attachments)
    ? recovery.attachments.map((raw) => {
        const value = record(raw);
        return {
          file_id: safeString(value.file_id) || "",
          filename: safeString(value.filename) || "",
        };
      })
    : [];
}

function attachmentManifest(turn: ConversationTurn | null) {
  if (!turn) return [];
  const recovery = record(record(turn.metadata).recovery);
  return Array.isArray(recovery.attachmentManifest)
    ? recovery.attachmentManifest.map((raw) => record(raw))
    : [];
}

export function uniqueHistoricalKnowledgeBaseStartSource(
  candidates: readonly ConversationTurn[],
) {
  const eligible = candidates.filter(
    (turn) =>
      turn.status === "failed" &&
      turn.operationType === "start" &&
      turn.errorCode === "UPSTREAM_CREATE_3" &&
      turn.upstreamTaskId === null &&
      turn.expectedRevision === 0 &&
      turn.expectedLeafId === null,
  );
  return eligible.length === 1 ? eligible[0]! : null;
}

function credentialUsable(facts: KnowledgeBaseIncidentRepairFacts) {
  const turn = facts.activeTurn;
  const credential = facts.replacementCredential ?? facts.credential;
  const expectedCredentialId =
    facts.replacementCredential?.id ?? turn?.apiCredentialId;
  return Boolean(
    expectedCredentialId &&
      credential?.id === expectedCredentialId &&
      (facts.replacementCredential
        ? credential.status === "active"
        : credential.status === "active" || credential.status === "retired"),
  );
}

function conversationUsable(facts: KnowledgeBaseIncidentRepairFacts) {
  const turn = facts.activeTurn;
  return Boolean(
    turn &&
      facts.conversation &&
      facts.conversation.id === turn.conversationId &&
      facts.conversation.userId === facts.build.userId &&
      facts.conversation.projectAssignmentId === null &&
      !facts.conversation.deletedAt &&
      turn.conversationId ===
        knowledgeBaseConversationStorageId(
          facts.build.userId,
          facts.build.conversationId,
        ),
  );
}

function commonBlockers(facts: KnowledgeBaseIncidentRepairFacts) {
  const blockers: string[] = [];
  const { build, activeTurn } = facts;
  const historicalStartAuthority = Boolean(
    facts.historicalSourceTurn === true &&
      build.activeTurnId === null &&
      activeTurn?.status === "failed" &&
      activeTurn.operationType === "start" &&
      activeTurn.errorCode === "UPSTREAM_CREATE_3" &&
      activeTurn.buildId === build.id &&
      activeTurn.buildGeneration === build.generation,
  );
  if (
    !activeTurn ||
    (activeTurn.id !== build.activeTurnId && !historicalStartAuthority)
  ) {
    blockers.push("active_turn_mismatch");
  } else if (
    activeTurn.userId !== build.userId ||
    activeTurn.buildId !== build.id ||
    activeTurn.buildGeneration !== build.generation ||
    activeTurn.expectedRevision !== build.revision ||
    (activeTurn.expectedLeafId ?? null) !== (build.currentLeafId ?? null)
  ) {
    blockers.push("turn_coordinate_mismatch");
  }
  if (!conversationUsable(facts)) blockers.push("conversation_unavailable");
  if (!credentialUsable(facts)) blockers.push("credential_unavailable");
  if (build.canonicalTaskId) blockers.push("canonical_task_already_bound");
  return blockers;
}

function confirmIncidentBlockers(facts: KnowledgeBaseIncidentRepairFacts) {
  const blockers = commonBlockers(facts);
  const turn = facts.activeTurn;
  const metadata = record(turn?.metadata);
  const recoveryAttachments = userAttachments(turn);
  const declaredUserAttachmentCount = safeInteger(metadata.userAttachmentCount);
  if (facts.build.providerProtocol !== "legacy_v1") {
    blockers.push("build_not_legacy_v1");
  }
  if (!turn || turn.status !== "failed" || turn.operationType !== "confirm") {
    blockers.push("not_failed_confirmation");
  } else {
    if (turn.upstreamTaskId) blockers.push("turn_task_already_bound");
    if (derivedCreateAttemptState(turn) !== "not_sent") {
      blockers.push("provider_attempt_not_not_sent");
    }
    if (Object.keys(record(metadata.preparedDispatch)).length > 0) {
      blockers.push("prepared_dispatch_exists");
    }
    if (
      recoveryAttachments.length !== 0 ||
      (declaredUserAttachmentCount !== null &&
        declaredUserAttachmentCount !== 0)
    ) {
      blockers.push("confirmation_has_user_attachments");
    }
  }
  return Array.from(new Set(blockers));
}

function startAttachmentOwnershipBlockers(
  facts: KnowledgeBaseIncidentRepairFacts,
) {
  const attachments = userAttachments(facts.activeTurn);
  const ids = attachments.map((attachment) => attachment.file_id);
  const resources = new Map(
    facts.attachmentResources.map((resource) => [
      resource.upstreamId,
      resource,
    ]),
  );
  const mismatches: KnowledgeBaseIncidentRepairReselection[] = [];
  const expectedCredentialId = facts.replacementSourcesProvided
    ? facts.replacementCredential?.id
    : facts.activeTurn?.apiCredentialId;
  ids.forEach((fileId, index) => {
    const resource = resources.get(fileId);
    if (
      !fileId ||
      !resource ||
      resource.userId !== facts.build.userId ||
      resource.kind !== "file" ||
      resource.projectAssignmentId !== null ||
      resource.apiCredentialId !== expectedCredentialId ||
      Boolean(resource.contentDeletedAt)
    ) {
      mismatches.push({ ordinal: index + 1, code: "ownership_mismatch" });
    }
  });
  return mismatches;
}

function startIncidentBlockers(facts: KnowledgeBaseIncidentRepairFacts) {
  const blockers = commonBlockers(facts);
  const { build, activeTurn: turn } = facts;
  const attachments = userAttachments(turn);
  const manifest = attachmentManifest(turn);
  const declaredUserAttachmentCount = safeInteger(
    record(turn?.metadata).userAttachmentCount,
  );
  if (build.status !== "failed" && build.status !== "protocol_error") {
    blockers.push("starter_build_not_failed");
  }
  if (
    !turn ||
    turn.status !== "failed" ||
    turn.operationType !== "start" ||
    turn.errorCode !== "UPSTREAM_CREATE_3"
  ) {
    blockers.push("not_failed_upstream_create_3_start");
  } else if (turn.upstreamTaskId) {
    blockers.push("turn_task_already_bound");
  }
  if (build.upstreamTaskId) blockers.push("build_task_already_bound");
  if (build.canonicalTaskId) blockers.push("canonical_task_already_bound");
  if (
    build.revision !== 0 ||
    build.currentLeafId !== null ||
    facts.nodes.length !== 0 ||
    build.totalNodeCount !== 0 ||
    build.confirmedCount !== 0 ||
    build.directPrefilledCount !== 0 ||
    build.needsVerificationCount !== 0
  ) {
    blockers.push("starter_already_has_accepted_nodes");
  }
  if ((facts.acceptedReceiptCount ?? 0) !== 0) {
    blockers.push("starter_has_accepted_receipt");
  }
  if (
    attachments.length < 1 ||
    manifest.length !== attachments.length ||
    new Set(attachments.map((attachment) => attachment.file_id)).size !==
      attachments.length ||
    (declaredUserAttachmentCount !== null &&
      declaredUserAttachmentCount !== attachments.length)
  ) {
    blockers.push("retained_attachment_ledger_incomplete");
  }
  return Array.from(new Set(blockers));
}

export function inspectKnowledgeBaseIncidentRepairFacts(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  repairKind: KnowledgeBaseIncidentRepairKind;
}) {
  const blockers =
    input.repairKind === "legacy_skill_404_confirm"
      ? confirmIncidentBlockers(input.facts)
      : startIncidentBlockers(input.facts);
  return {
    blockers,
    userAttachmentCount: userAttachments(input.facts.activeTurn).length,
    ownershipReselection:
      input.repairKind === "retained_upstream_create_3_start"
        ? startAttachmentOwnershipBlockers(input.facts)
        : [],
  };
}

async function retainedAttachmentProofs(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  readStoredFile: typeof readStoredPresalesFile;
}) {
  const attachments = userAttachments(input.facts.activeTurn);
  const manifest = attachmentManifest(input.facts.activeTurn);
  const failures: KnowledgeBaseIncidentRepairReselection[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    const descriptor = manifest[index] || {};
    const expectedSize = safeInteger(descriptor.sizeBytes);
    const expectedSha = String(descriptor.sha256 || "")
      .trim()
      .toLowerCase();
    if (
      !attachment.file_id ||
      !attachment.filename ||
      descriptor.filename !== attachment.filename ||
      expectedSize === null ||
      expectedSize < 1 ||
      expectedSize > MAX_RETAINED_SOURCE_BYTES ||
      !SHA256_PATTERN.test(expectedSha)
    ) {
      failures.push({ ordinal: index + 1, code: "manifest_invalid" });
      continue;
    }
    let stored: Awaited<ReturnType<typeof readStoredPresalesFile>>;
    try {
      stored = await input.readStoredFile(attachment.file_id);
    } catch {
      failures.push({ ordinal: index + 1, code: "unreadable" });
      continue;
    }
    if (!stored) {
      failures.push({ ordinal: index + 1, code: "missing" });
      continue;
    }
    if (
      stored.sizeBytes !== expectedSize ||
      (stored.recordedSizeBytes !== null &&
        stored.recordedSizeBytes !== expectedSize)
    ) {
      failures.push({ ordinal: index + 1, code: "size_mismatch" });
      continue;
    }
    if (stored.sha256 && stored.sha256.toLowerCase() !== expectedSha) {
      failures.push({ ordinal: index + 1, code: "sha256_mismatch" });
      continue;
    }
    const hash = createHash("sha256");
    let total = 0;
    try {
      for await (const chunk of stored.createReadStream()) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_RETAINED_SOURCE_BYTES || total > expectedSize) {
          break;
        }
        hash.update(bytes);
      }
    } catch {
      failures.push({ ordinal: index + 1, code: "unreadable" });
      continue;
    }
    if (total !== expectedSize) {
      failures.push({ ordinal: index + 1, code: "size_mismatch" });
    } else if (hash.digest("hex") !== expectedSha) {
      failures.push({ ordinal: index + 1, code: "sha256_mismatch" });
    }
  }
  return failures;
}

async function loadRepairFacts(input: {
  executor: any;
  userId: number;
  conversationId: string;
  lock: boolean;
  repairKind: KnowledgeBaseIncidentRepairKind;
}) {
  let buildQuery = input.executor
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  if (input.lock) buildQuery = buildQuery.for("update");
  const build = (await buildQuery)[0] as KnowledgeBaseBuild | undefined;
  if (!build) return null;

  let turn: ConversationTurn | null = null;
  if (build.activeTurnId) {
    let turnQuery = input.executor
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, build.activeTurnId))
      .limit(1);
    if (input.lock) turnQuery = turnQuery.for("update");
    turn = ((await turnQuery)[0] as ConversationTurn | undefined) ?? null;
  } else if (input.repairKind === "retained_upstream_create_3_start") {
    let candidatesQuery = input.executor
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, build.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          eq(conversationTurns.operationType, "start"),
          eq(conversationTurns.status, "failed"),
          eq(conversationTurns.errorCode, "UPSTREAM_CREATE_3"),
          isNull(conversationTurns.upstreamTaskId),
          eq(conversationTurns.expectedRevision, 0),
          isNull(conversationTurns.expectedLeafId),
        ),
      )
      .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id))
      .limit(2);
    if (input.lock) candidatesQuery = candidatesQuery.for("update");
    const candidates = (await candidatesQuery) as ConversationTurn[];
    // Never guess among historical failures. Exactly one source is required.
    turn = uniqueHistoricalKnowledgeBaseStartSource(candidates);
  }

  let nodesQuery = input.executor
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
  if (input.lock) nodesQuery = nodesQuery.for("update");
  const nodes = (await nodesQuery) as KnowledgeBaseBuildNode[];

  let conversationQuery = input.executor
    .select()
    .from(conversations)
    .where(
      and(
        eq(
          conversations.id,
          knowledgeBaseConversationStorageId(
            build.userId,
            build.conversationId,
          ),
        ),
        eq(conversations.userId, build.userId),
      ),
    )
    .limit(1);
  if (input.lock) conversationQuery = conversationQuery.for("update");
  const conversation =
    ((await conversationQuery)[0] as Conversation | undefined) ?? null;

  let credential: CredentialFact = null;
  if (turn?.apiCredentialId) {
    let credentialQuery = input.executor
      .select({
        id: apiCredentials.id,
        userId: apiCredentials.userId,
        status: apiCredentials.status,
      })
      .from(apiCredentials)
      .where(eq(apiCredentials.id, turn.apiCredentialId))
      .limit(1);
    if (input.lock) credentialQuery = credentialQuery.for("update");
    credential = ((await credentialQuery)[0] as CredentialFact) ?? null;
  }

  const attachmentIds = userAttachments(turn)
    .map((attachment) => attachment.file_id)
    .filter(Boolean);
  let attachmentResources: UpstreamResource[] = [];
  if (attachmentIds.length > 0) {
    let resourceQuery = input.executor
      .select()
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, "file"),
          inArray(upstreamResources.upstreamId, attachmentIds),
        ),
      )
      .limit(attachmentIds.length);
    if (input.lock) resourceQuery = resourceQuery.for("update");
    attachmentResources = (await resourceQuery) as UpstreamResource[];
  }
  let acceptedReceiptCount = 0;
  if (turn) {
    const acceptedRows = await input.executor
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.userId, build.userId),
          eq(
            messages.conversationId,
            knowledgeBaseConversationStorageId(
              build.userId,
              build.conversationId,
            ),
          ),
          eq(messages.turnId, turn.id),
          eq(messages.role, "assistant"),
          isNull(messages.deletedAt),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${messages.metadata}, '$.knowledgeBase.serverOwned')) = 'true'`,
          sql`JSON_UNQUOTE(JSON_EXTRACT(${messages.metadata}, '$.knowledgeBase.kind')) IN ('presentation', 'completion')`,
        ),
      )
      .limit(1);
    acceptedReceiptCount = acceptedRows.length;
  }
  return {
    build,
    activeTurn: turn,
    nodes,
    conversation,
    credential,
    attachmentResources,
    acceptedReceiptCount,
    historicalSourceTurn: build.activeTurnId === null && turn !== null,
  } satisfies KnowledgeBaseIncidentRepairFacts;
}

function plannedActions(kind: KnowledgeBaseIncidentRepairKind) {
  return kind === "legacy_skill_404_confirm"
    ? [
        "cancel_failed_turn_with_supersession_receipt",
        "reserve_hidden_confirmation_without_user_message_or_charge",
        "recover_from_pinned_skill_bytes",
        "handoff_legacy_build_to_one_manus_v2_canonical_task",
      ]
    : [
        "cancel_failed_start_turn_with_supersession_receipt",
        "advance_build_generation",
        "reserve_hidden_manus_v2_start_without_user_message_or_charge",
        "rebuild_files_from_verified_dashboard_retention",
      ];
}

function previewFromInspection(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  repairKind: KnowledgeBaseIncidentRepairKind;
  requiresReselection: KnowledgeBaseIncidentRepairReselection[];
}) {
  const inspection = inspectKnowledgeBaseIncidentRepairFacts(input);
  const requiresReselection = deduplicateKnowledgeBaseIncidentReselection([
    ...inspection.ownershipReselection,
    ...input.requiresReselection,
  ]);
  return {
    repairKind: input.repairKind,
    stateHash: hashKnowledgeBaseIncidentRepairState(input.facts),
    applicable:
      inspection.blockers.length === 0 && requiresReselection.length === 0,
    blockers: inspection.blockers,
    requiresReselection,
    buildGeneration: input.facts.build.generation,
    buildRevision: input.facts.build.revision,
    stateEpoch: input.facts.build.stateEpoch,
    nodeCount: input.facts.nodes.length,
    userAttachmentCount: inspection.userAttachmentCount,
    plannedActions: plannedActions(input.repairKind),
  } satisfies KnowledgeBaseIncidentRepairPreview;
}

export function deduplicateKnowledgeBaseIncidentReselection(
  failures: readonly KnowledgeBaseIncidentRepairReselection[],
) {
  return failures.filter(
    (failure, index, all) =>
      all.findIndex((candidate) => candidate.ordinal === failure.ordinal) ===
      index,
  );
}

/** Pure preview helper used by fixtures and the database-backed endpoint. */
export function previewKnowledgeBaseIncidentRepairFacts(input: {
  facts: KnowledgeBaseIncidentRepairPreviewFacts;
  repairKind: KnowledgeBaseIncidentRepairKind;
  environment?: NodeJS.ProcessEnv;
}) {
  assertKnowledgeBaseIncidentRepairRolloutAuthorized(
    input.repairKind,
    input.environment,
  );
  return previewFromInspection({
    facts: input.facts,
    repairKind: input.repairKind,
    requiresReselection: input.facts.retainedSourceProofs ?? [],
  });
}

export async function previewKnowledgeBaseIncidentRepair(
  input: {
    userId: number;
    conversationId: string;
    repairKind: KnowledgeBaseIncidentRepairKind;
  },
  dependencies: RepairDependencies = {},
): Promise<KnowledgeBaseIncidentRepairPreview | null> {
  assertKnowledgeBaseIncidentRepairRolloutAuthorized(
    input.repairKind,
    dependencies.environment,
    dependencies.maintenanceAuthority,
  );
  const db = await (dependencies.getDatabase ?? getDb)();
  if (!db) throw new Error("Database is not configured");
  const facts = await loadRepairFacts({
    executor: db,
    userId: input.userId,
    conversationId: input.conversationId.trim(),
    lock: false,
    repairKind: input.repairKind,
  });
  if (!facts) return null;
  const retainedFailures =
    input.repairKind === "retained_upstream_create_3_start"
      ? await retainedAttachmentProofs({
          facts,
          readStoredFile: dependencies.readStoredFile ?? readStoredPresalesFile,
        })
      : [];
  const previewFacts: KnowledgeBaseIncidentRepairPreviewFacts =
    retainedFailures.length > 0
      ? { ...facts, retainedSourceProofs: retainedFailures }
      : facts;
  return previewFromInspection({
    facts: previewFacts,
    repairKind: input.repairKind,
    requiresReselection: retainedFailures,
  });
}

export function previewKnowledgeBaseIncidentRepairFromSignedImageMaintenance(
  input: Parameters<typeof previewKnowledgeBaseIncidentRepair>[0],
  dependencies: Omit<RepairDependencies, "maintenanceAuthority"> = {},
) {
  return previewKnowledgeBaseIncidentRepair(input, {
    ...dependencies,
    maintenanceAuthority: SIGNED_IMAGE_MAINTENANCE_AUTHORITY,
  });
}

function replacementRecovery(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  repairKind: KnowledgeBaseIncidentRepairKind;
}) {
  const { build, activeTurn: turn } = input.facts;
  if (!turn) throw new Error("Incident repair has no active turn");
  const source = record(record(turn.metadata).recovery);
  if (input.repairKind === "legacy_skill_404_confirm") {
    return sanitizeKnowledgeBaseRecoveryMetadata({
      ...source,
      kind: "turn",
      conversationId: build.conversationId,
      parentTaskId:
        safeString(source.parentTaskId) ||
        safeString(build.upstreamTaskId) ||
        "legacy-task-unavailable",
      userMessage: safeString(source.userMessage) || "确认当前内容",
      attachments: [],
      attachmentManifest: [],
      capturedClientAttachments: true,
      deferredClientAttachments: false,
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      instructionsAttachmentRequired: true,
    });
  }
  return sanitizeKnowledgeBaseRecoveryMetadata({
    ...source,
    kind: "start",
    conversationId: build.conversationId,
    companyName: build.companyName,
    companyWebsite: build.companyWebsite || "",
    attachments: userAttachments(turn),
    attachmentManifest: attachmentManifest(turn),
    capturedClientAttachments: true,
    deferredClientAttachments: false,
    skillVersion: build.skillVersion,
    skillContentHash: build.skillContentHash,
    instructionsAttachmentRequired: true,
  });
}

function replacementTurnValues(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  repairKind: KnowledgeBaseIncidentRepairKind;
  now: Date;
  clientRequestId?: string;
  replacementSourcesProvided?: boolean;
}) {
  const { build, activeTurn: source } = input.facts;
  if (!source) throw new Error("Incident repair has no active turn");
  const generation =
    input.repairKind === "retained_upstream_create_3_start"
      ? build.generation + 1
      : build.generation;
  const operationType =
    input.repairKind === "legacy_skill_404_confirm" ? "confirm" : "start";
  const expectedRevision =
    input.repairKind === "legacy_skill_404_confirm" ? build.revision : 0;
  const expectedLeafId =
    input.repairKind === "legacy_skill_404_confirm"
      ? build.currentLeafId
      : null;
  const operationKey = createKnowledgeBaseOperationKey({
    buildId: build.id,
    buildGeneration: generation,
    operationType,
    expectedRevision,
    expectedLeafId,
    operationInstanceId: `repair:${source.id}`,
  });
  const recovery = replacementRecovery(input);
  const userAttachmentCount = userAttachments(source).length;
  const includePrefill =
    input.repairKind === "retained_upstream_create_3_start" &&
    recovery.includePrefill === true;
  const expectedAttachmentCount =
    input.repairKind === "legacy_skill_404_confirm"
      ? 2
      : userAttachmentCount + 2 + (includePrefill ? 1 : 0);
  const turnId = randomUUID();
  const requestHash = hashKnowledgeBaseTurnRequest({
    protocol: "frontmind.knowledge-base.incident-repair.v1",
    repairKind: input.repairKind,
    supersedesTurnId: source.id,
    originalRequestHash: source.requestHash,
    operationType,
    generation,
    revision: expectedRevision,
    leafId: expectedLeafId,
    recovery,
  });
  const providerProtocol =
    input.repairKind === "legacy_skill_404_confirm"
      ? ("legacy_v1" as const)
      : ("manus_v2" as const);
  return {
    row: {
      id: turnId,
      conversationId: source.conversationId,
      userId: build.userId,
      apiCredentialId:
        input.facts.replacementCredential?.id ?? source.apiCredentialId,
      clientRequestId: input.clientRequestId || `kb-repair-${turnId}`,
      buildId: build.id,
      buildGeneration: generation,
      operationKey,
      operationType,
      expectedRevision,
      expectedLeafId,
      requestHash,
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      // Customer ids remain only in recovery metadata. The v2 mapper reads
      // retained bytes locally and replaces them with exact ready v2 ids.
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: false,
        expectedAttachmentCount,
        userAttachmentCount,
        awaitingClientAttachments: false,
        recovery,
        createAttemptState: "not_sent",
        createAttemptUpdatedAt: input.now.toISOString(),
        providerProtocol,
        providerAttemptState: "not_sent",
        operationToken: operationKey,
        dispatchState: "reserved",
        failureClass: null,
        recoveryAction: "wait",
        canRegenerate: false,
        repairKind: input.repairKind,
        supersedesTurnId: source.id,
        hiddenReplacement: true,
        chargeDisposition: "reuse_original_no_charge",
        historicalSourceTurnId:
          input.facts.historicalSourceTurn === true ? source.id : undefined,
        sourceRecoveryMode:
          input.repairKind === "retained_upstream_create_3_start"
            ? input.replacementSourcesProvided
              ? "reselect_start_sources"
              : "resume_start_from_retained_sources"
            : undefined,
        sourceRecoveryClientRequestId: input.clientRequestId,
      },
      leaseExpiresAt: null,
      model: null,
      status: "queued" as const,
      upstreamTaskId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    userAttachmentCount,
  };
}

function buildUpdateValues(input: {
  facts: KnowledgeBaseIncidentRepairFacts;
  repairKind: KnowledgeBaseIncidentRepairKind;
  replacementTurnId: string;
  userAttachmentCount: number;
  now: Date;
}) {
  const { build } = input.facts;
  const common = {
    activeTurnId: input.replacementTurnId,
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    stateEpoch: build.stateEpoch + 1,
    protocolErrorCode: null,
    protocolError: null,
    awaitingResponseSince: input.now,
    lastTurnAttachmentCount: input.userAttachmentCount,
    updatedAt: input.now,
  };
  if (input.repairKind === "legacy_skill_404_confirm") {
    return { ...common, status: "confirming" as const };
  }
  return {
    ...common,
    generation: build.generation + 1,
    status: "researching" as const,
    providerProtocol: "manus_v2",
    upstreamTaskId: null,
    canonicalTaskId: null,
    canonicalTaskGeneration: null,
    canonicalCredentialId: null,
    canonicalTaskState: "unbound",
    canonicalTaskUrl: null,
    canonicalTaskCreatedAt: null,
    handoffProvenance: null,
    currentPresentationKey: null,
    lastAppliedOperationKey: null,
    revision: 0,
    currentLeafId: null,
    totalNodeCount: 0,
    confirmedCount: 0,
    directPrefilledCount: 0,
    needsVerificationCount: 0,
    lastReconciledHash: null,
    lastOutputLength: 0,
    lastOutputItemIds: [],
    contentCompletedAt: null,
    completedAt: null,
    packageRevision: null,
    packageTaskId: null,
    packageOutputItemId: null,
    packageFileId: null,
    packageFilename: null,
    packageDescriptorHash: null,
    packageStorageKey: null,
    packageArchiveSha256: null,
    packageSizeBytes: null,
    packageStatus: "not_started",
    packageAttemptCount: 0,
    packageNextRetryAt: null,
    packageLastErrorCode: null,
  };
}

export async function applyKnowledgeBaseIncidentRepair(
  input: ApplyKnowledgeBaseIncidentRepairInput,
  dependencies: RepairDependencies = {},
): Promise<KnowledgeBaseIncidentRepairApplyResult> {
  assertKnowledgeBaseIncidentRepairRolloutAuthorized(
    input.repairKind,
    dependencies.environment,
    dependencies.maintenanceAuthority,
  );
  const expectedStateHash = input.expectedStateHash.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expectedStateHash)) {
    throw new TypeError("Knowledge-base incident repair state hash is invalid");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Knowledge-base incident repair timestamp is invalid");
  }
  const db = await (dependencies.getDatabase ?? getDb)();
  if (!db) throw new Error("Database is not configured");
  return db.transaction(async (tx: any) => {
    let replacementCredential: CredentialFact = null;
    if (
      input.repairKind === "retained_upstream_create_3_start" &&
      input.replacementCredentialId
    ) {
      const replacementCredentialId = input.replacementCredentialId.trim();
      if (!replacementCredentialId || replacementCredentialId.length > 36) {
        throw new TypeError(
          "Knowledge-base start recovery credential id is invalid",
        );
      }
      const replacementCredentialRows = await tx
        .select({
          id: apiCredentials.id,
          userId: apiCredentials.userId,
          status: apiCredentials.status,
        })
        .from(apiCredentials)
        .where(
          and(
            eq(apiCredentials.id, replacementCredentialId),
            eq(apiCredentials.userId, input.userId),
            eq(apiCredentials.status, "active"),
          ),
        )
        .limit(1)
        .for("update");
      replacementCredential =
        (replacementCredentialRows[0] as CredentialFact) ?? null;
      if (!replacementCredential) {
        throw new KnowledgeBaseIncidentRepairAuthorizationError();
      }
    }
    const facts = await loadRepairFacts({
      executor: tx,
      userId: input.userId,
      conversationId: input.conversationId.trim(),
      lock: true,
      repairKind: input.repairKind,
    });
    if (!facts) throw new Error("Knowledge-base build was not found");
    const observedStateHash = hashKnowledgeBaseIncidentRepairState(facts);
    const baseResult = {
      repairKind: input.repairKind,
      expectedStateHash,
      observedStateHash,
      buildId: facts.build.id,
      previousGeneration: facts.build.generation,
      generation: facts.build.generation,
      replacementTurnId: null,
      nodeCount: facts.nodes.length,
      userAttachmentCount: userAttachments(facts.activeTurn).length,
      requiresReselection: [] as KnowledgeBaseIncidentRepairReselection[],
    };
    if (observedStateHash !== expectedStateHash) {
      return {
        ...baseResult,
        applied: false,
        noopReason: "state_changed",
      };
    }
    let effectiveFacts: KnowledgeBaseIncidentRepairFacts = replacementCredential
      ? { ...facts, replacementCredential }
      : facts;
    if (
      input.repairKind === "retained_upstream_create_3_start" &&
      input.replacementSources
    ) {
      const source = facts.activeTurn;
      if (!source) {
        return {
          ...baseResult,
          applied: false,
          noopReason: "predicate_not_met",
        };
      }
      const sourceMetadata = record(source.metadata);
      const recovery = record(sourceMetadata.recovery);
      const attachments = input.replacementSources.attachments;
      const attachmentManifest = input.replacementSources.attachmentManifest;
      if (
        attachments.length < 1 ||
        attachments.length !== attachmentManifest.length ||
        new Set(attachments.map((item) => item.file_id)).size !==
          attachments.length
      ) {
        return {
          ...baseResult,
          applied: false,
          noopReason: "requires_reselection",
        };
      }
      const ids = attachments.map((item) => item.file_id);
      const replacementResources = (await tx
        .select()
        .from(upstreamResources)
        .where(
          and(
            eq(upstreamResources.kind, "file"),
            inArray(upstreamResources.upstreamId, ids),
          ),
        )
        .limit(ids.length)
        .for("update")) as UpstreamResource[];
      effectiveFacts = {
        ...effectiveFacts,
        activeTurn: {
          ...source,
          attachmentFileIds: ids,
          metadata: {
            ...sourceMetadata,
            userAttachmentCount: attachments.length,
            expectedAttachmentCount: attachments.length + 2,
            recovery: {
              ...recovery,
              attachments,
              attachmentManifest,
              capturedClientAttachments: true,
              deferredClientAttachments: false,
            },
          },
        },
        attachmentResources: replacementResources,
        replacementSourcesProvided: true,
      };
    }
    const inspection = inspectKnowledgeBaseIncidentRepairFacts({
      facts: effectiveFacts,
      repairKind: input.repairKind,
    });
    if (inspection.blockers.length > 0) {
      return {
        ...baseResult,
        applied: false,
        noopReason: "predicate_not_met",
        requiresReselection: inspection.ownershipReselection,
      };
    }
    const retainedFailures =
      input.repairKind === "retained_upstream_create_3_start"
        ? await retainedAttachmentProofs({
            facts: effectiveFacts,
            readStoredFile:
              dependencies.readStoredFile ?? readStoredPresalesFile,
          })
        : [];
    const requiresReselection = deduplicateKnowledgeBaseIncidentReselection([
      ...inspection.ownershipReselection,
      ...retainedFailures,
    ]);
    if (requiresReselection.length > 0) {
      return {
        ...baseResult,
        applied: false,
        noopReason: "requires_reselection",
        requiresReselection,
      };
    }
    const source = facts.activeTurn!;
    const replacement = replacementTurnValues({
      facts: effectiveFacts,
      repairKind: input.repairKind,
      now,
      clientRequestId: input.clientRequestId,
      replacementSourcesProvided: input.replacementSources !== undefined,
    });
    const sourceMetadata = record(source.metadata);
    const nextBuildValues = buildUpdateValues({
      facts,
      repairKind: input.repairKind,
      replacementTurnId: replacement.row.id,
      userAttachmentCount: replacement.userAttachmentCount,
      now,
    });
    const conversation = facts.conversation!;
    const nextConversationValues = {
      apiCredentialId: replacement.row.apiCredentialId,
      status: "running" as const,
      upstreamTaskId:
        input.repairKind === "legacy_skill_404_confirm"
          ? facts.build.upstreamTaskId
          : null,
      previousResponseId:
        input.repairKind === "legacy_skill_404_confirm"
          ? facts.build.upstreamTaskId
          : null,
      version: conversation.version + 1,
      completedAt: null,
      updatedAt: now,
    };
    const sourceTurnUpdated = await tx
      .update(conversationTurns)
      .set({
        status: "cancelled",
        completedAt: now,
        leaseExpiresAt: null,
        metadata: {
          ...sourceMetadata,
          supersededByTurnId: replacement.row.id,
          supersededAt: now.toISOString(),
          supersededReason: input.repairKind,
          releasedOperationTombstone: {
            operationKey: source.operationKey,
            generation: source.buildGeneration,
            releasedAt: now.toISOString(),
            reason: input.repairKind,
          },
          historicalSourceTurnId:
            facts.historicalSourceTurn === true ? source.id : undefined,
          sourceRecoveryMode:
            input.replacementSources !== undefined
              ? "reselect_start_sources"
              : "resume_start_from_retained_sources",
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, source.id),
          eq(conversationTurns.status, "failed"),
          eq(conversationTurns.buildGeneration, source.buildGeneration!),
        ),
      );
    if (sourceTurnUpdated[0]?.affectedRows !== 1) {
      throw new Error("Knowledge-base incident source turn CAS was lost");
    }
    await tx.insert(conversationTurns).values(replacement.row);
    const activeTurnPredicate = facts.historicalSourceTurn
      ? isNull(knowledgeBaseBuilds.activeTurnId)
      : eq(knowledgeBaseBuilds.activeTurnId, source.id);
    const updated = await tx
      .update(knowledgeBaseBuilds)
      .set(nextBuildValues)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, facts.build.id),
          eq(knowledgeBaseBuilds.userId, facts.build.userId),
          eq(knowledgeBaseBuilds.generation, facts.build.generation),
          eq(knowledgeBaseBuilds.stateEpoch, facts.build.stateEpoch),
          activeTurnPredicate,
        ),
      );
    if (updated[0]?.affectedRows !== 1) {
      throw new Error("Knowledge-base incident repair CAS was lost");
    }
    const conversationUpdated = await tx
      .update(conversations)
      .set(nextConversationValues)
      .where(
        and(
          eq(conversations.id, conversation.id),
          eq(conversations.userId, facts.build.userId),
          eq(conversations.version, conversation.version),
        ),
      );
    if (conversationUpdated[0]?.affectedRows !== 1) {
      throw new Error("Knowledge-base incident conversation CAS was lost");
    }
    const result: KnowledgeBaseIncidentRepairApplyResult = {
      ...baseResult,
      applied: true,
      noopReason: null,
      generation: replacement.row.buildGeneration,
      replacementTurnId: replacement.row.id,
    };
    await input.onBeforeCommit?.({
      result,
      facts,
      sourceTurn: source,
      replacementTurn: replacement.row,
      buildUpdate: nextBuildValues,
      conversationUpdate: nextConversationValues,
      executor: tx,
    });
    await input.afterApplyInTransaction?.(result, tx);
    return result;
  });
}

function applyKnowledgeBaseIncidentRepairWithSignedImageAuthority(
  input: ApplyKnowledgeBaseIncidentRepairInput,
  dependencies: Omit<RepairDependencies, "maintenanceAuthority"> = {},
) {
  return applyKnowledgeBaseIncidentRepair(input, {
    ...dependencies,
    maintenanceAuthority: SIGNED_IMAGE_MAINTENANCE_AUTHORITY,
  });
}

export function executeKnowledgeBaseIncidentRepairFromSignedImageMaintenance(
  input: {
    userId: number;
    conversationId: string;
    repairKind: KnowledgeBaseIncidentRepairKind;
    expectedStateHash: string;
    reasonCode: string;
    now?: Date;
  },
  dependencies: Omit<RepairDependencies, "maintenanceAuthority"> = {},
) {
  if (input.reasonCode !== "authorized_incident_recovery") {
    throw new TypeError(
      "Knowledge-base incident repair maintenance reason code is invalid",
    );
  }
  return applyKnowledgeBaseIncidentRepairWithSignedImageAuthority(
    {
      userId: input.userId,
      conversationId: input.conversationId,
      repairKind: input.repairKind,
      expectedStateHash: input.expectedStateHash,
      now: input.now,
      afterApplyInTransaction: async (result, executor) => {
        if (!result.applied) return;
        await writeSystemMaintenanceWorkspaceAuditEvent(
          {
            action: "knowledge_base.incident_repair_applied",
            targetType: "knowledge_base_repair",
            targetId: knowledgeBaseIncidentAuditTarget(result.buildId),
            workspaceUserId: input.userId,
            reasonCode: "authorized_incident_recovery",
            metadata: {
              repairKind: result.repairKind,
              stateHash: result.expectedStateHash,
              previousGeneration: result.previousGeneration,
              generation: result.generation,
              nodeCount: result.nodeCount,
              userAttachmentCount: result.userAttachmentCount,
              outcome: "applied",
            },
            now: input.now,
          },
          executor,
        );
      },
    },
    dependencies,
  );
}

/**
 * Customer-triggered retained-source restart. The browser supplies only CAS
 * coordinates and an idempotency id; source-turn selection remains entirely
 * server-side and still requires the exact single historical failure.
 */
export function executeKnowledgeBaseRetainedStartRecoveryFromCustomer(
  input: {
    userId: number;
    conversationId: string;
    expectedStateHash: string;
    clientRequestId: string;
    replacementCredentialId: string;
    replacementSources?: ApplyKnowledgeBaseIncidentRepairInput["replacementSources"];
    now?: Date;
  },
  dependencies: Omit<RepairDependencies, "maintenanceAuthority"> = {},
) {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 128) {
    throw new TypeError("Knowledge-base start recovery request id is invalid");
  }
  return applyKnowledgeBaseIncidentRepairWithSignedImageAuthority(
    {
      userId: input.userId,
      conversationId: input.conversationId,
      repairKind: "retained_upstream_create_3_start",
      expectedStateHash: input.expectedStateHash,
      clientRequestId,
      replacementCredentialId: input.replacementCredentialId,
      replacementSources: input.replacementSources,
      now: input.now,
    },
    dependencies,
  );
}

export async function findKnowledgeBaseRetainedStartRecoveryReplay(
  input: { userId: number; conversationId: string; clientRequestId: string },
  dependencies: Pick<RepairDependencies, "getDatabase"> = {},
): Promise<KnowledgeBaseRetainedStartReplay | null> {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId) return null;
  const db = await (dependencies.getDatabase ?? getDb)();
  if (!db) throw new Error("Database is not configured");
  const buildRows = await db
    .select({
      id: knowledgeBaseBuilds.id,
      generation: knowledgeBaseBuilds.generation,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, input.conversationId.trim()),
      ),
    )
    .limit(1);
  const build = buildRows[0];
  if (!build) return null;
  const rows = (await db
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, build.id),
        eq(conversationTurns.clientRequestId, clientRequestId),
        eq(conversationTurns.operationType, "start"),
      ),
    )
    .limit(2)) as ConversationTurn[];
  const replay = rows.find((row) => {
    const metadata = record(row.metadata);
    return (
      metadata.repairKind === "retained_upstream_create_3_start" &&
      metadata.chargeDisposition === "reuse_original_no_charge" &&
      row.buildGeneration === build.generation
    );
  });
  return replay?.buildGeneration
    ? {
        turnId: replay.id,
        clientRequestId: replay.clientRequestId,
        generation: replay.buildGeneration,
        mode:
          record(replay.metadata).sourceRecoveryMode ===
          "reselect_start_sources"
            ? "reselect_start_sources"
            : "resume_start_from_retained_sources",
      }
    : null;
}

export function knowledgeBaseIncidentAuditTarget(buildId: string) {
  return `kb-repair:${sha256(buildId).slice(0, 32)}`;
}
