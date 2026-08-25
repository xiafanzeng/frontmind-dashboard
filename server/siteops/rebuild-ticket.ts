import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
} from "drizzle-orm";
import { z } from "zod";
import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  knowledgeBaseSnapshots,
  messages,
  serviceQuotaPeriods,
  siteBuilds,
  siteDeployments,
  siteDnsRecords,
  siteDomainOperations,
  siteOperations,
  siteProjects,
  users,
  websiteStyleSampleBatches,
} from "../../drizzle/schema";

const REBUILD_TARGET_PREFIX = "/siteops/builds/";
const REBUILD_PROJECT_TARGET_PREFIX = "/siteops/projects/";
const REBUILD_NOTE_KIND = "frontmind.siteops-rebuild.v1";
export const APPROVED_RESET_UNPUBLISH = "approved_reset_unpublish";
const ACTIVE_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

type SiteOpsRebuildNoteV1 = {
  schemaVersion: 1;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string;
  knowledgeSnapshotId: string;
};

type SiteOpsRebuildNoteV2 = Omit<SiteOpsRebuildNoteV1, "schemaVersion"> & {
  schemaVersion: 2;
  resetAppliedAt: string;
  resetAppliedProjectRevision: number;
};

type SiteOpsRebuildNoteV3 = {
  schemaVersion: 3;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string | null;
  knowledgeSnapshotId: string | null;
  resetAppliedAt?: string;
  resetAppliedProjectRevision?: number;
};

type SiteOpsRebuildNoteV4 = {
  schemaVersion: 4;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string | null;
  knowledgeSnapshotId: string | null;
  resetIntent: typeof APPROVED_RESET_UNPUBLISH;
  resetOperationId: string;
  resetApprovedAt: string;
  resetExpectedProjectRevision: number;
  minimumKnowledgeSnapshotVersion: number;
  resetAppliedAt?: string;
  resetAppliedProjectRevision?: number;
  freshRootApplied?: true;
  unpublishOperationId?: string;
};

const completedFreshRootResetNoteV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    kind: z.literal(REBUILD_NOTE_KIND),
    projectId: z.string().uuid(),
    sourceBuildId: z.string().uuid().nullable(),
    knowledgeSnapshotId: z.string().uuid().nullable(),
    resetIntent: z.literal(APPROVED_RESET_UNPUBLISH),
    resetOperationId: z.string().uuid(),
    resetApprovedAt: z.string().datetime(),
    resetExpectedProjectRevision: z.number().int().positive(),
    minimumKnowledgeSnapshotVersion: z.number().int().positive(),
    resetAppliedAt: z.string().datetime(),
    resetAppliedProjectRevision: z.number().int().positive(),
    freshRootApplied: z.literal(true),
    unpublishOperationId: z.string().uuid(),
  })
  .strict()
  .refine(
    (note) => note.unpublishOperationId === note.resetOperationId,
    "reset operation coordinate mismatch",
  );

const completedFreshRootResetOperationResultV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    stage: z.literal("exposure_removed"),
    resetOperationId: z.string().uuid(),
    projectId: z.string().uuid(),
    freshRootApplied: z.literal(true),
    minimumKnowledgeSnapshotVersion: z.number().int().positive(),
    resetAppliedProjectRevision: z.number().int().positive(),
  })
  .strict();

function completedFreshRootResetOperationResult(input: {
  operationId: string;
  projectId: string;
  operationInput: unknown;
  result: unknown;
}) {
  const resetInput = parseApprovedResetUnpublishInput(input.operationInput);
  const parsed = completedFreshRootResetOperationResultV2Schema.safeParse(
    input.result,
  );
  if (
    !resetInput ||
    !parsed.success ||
    parsed.data.resetOperationId !== input.operationId ||
    parsed.data.projectId !== input.projectId ||
    parsed.data.resetAppliedProjectRevision !==
      resetInput.expectedProjectRevision + 1
  ) {
    return null;
  }
  return parsed.data;
}

function completedFreshRootResetOperationProjection(input: {
  operationId: string;
  projectId: string;
  minimumKnowledgeSnapshotVersion: number;
  resetAppliedProjectRevision: number;
}) {
  return completedFreshRootResetOperationResultV2Schema.parse({
    schemaVersion: 2,
    intent: APPROVED_RESET_UNPUBLISH,
    stage: "exposure_removed",
    resetOperationId: input.operationId,
    projectId: input.projectId,
    freshRootApplied: true,
    minimumKnowledgeSnapshotVersion: input.minimumKnowledgeSnapshotVersion,
    resetAppliedProjectRevision: input.resetAppliedProjectRevision,
  });
}

function completedFreshRootResetNote(
  value: string | null | undefined,
  projectId: string,
): SiteOpsRebuildNoteV4 | null {
  if (!value) return null;
  try {
    const parsed = completedFreshRootResetNoteV4Schema.safeParse(
      JSON.parse(value),
    );
    return parsed.success && parsed.data.projectId === projectId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

type SiteOpsRebuildNote =
  | SiteOpsRebuildNoteV1
  | SiteOpsRebuildNoteV2
  | SiteOpsRebuildNoteV3
  | SiteOpsRebuildNoteV4;

export const approvedResetUnpublishInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    rebuildTicketId: z.string().uuid(),
    expectedProjectRevision: z.number().int().positive(),
    expectedCurrentBuildId: z.string().uuid().nullable(),
    expectedKnowledgeSnapshotId: z.string().uuid().nullable(),
    expectedGlobalLiveDeploymentId: z.string().uuid().nullable(),
    expectedMainlandLiveDeploymentId: z.string().uuid().nullable(),
    expectedCanonicalHostname: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();

export type ApprovedResetUnpublishInput = z.infer<
  typeof approvedResetUnpublishInputSchema
>;

export function parseApprovedResetUnpublishInput(value: unknown) {
  const parsed = approvedResetUnpublishInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function approvedResetUnpublishProjectMatches(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    | "revision"
    | "currentBuildId"
    | "currentKnowledgeSnapshotId"
    | "globalLiveDeploymentId"
    | "mainlandLiveDeploymentId"
    | "canonicalHostname"
  >,
) {
  return (
    project.revision === input.expectedProjectRevision &&
    project.currentBuildId === input.expectedCurrentBuildId &&
    project.currentKnowledgeSnapshotId ===
      input.expectedKnowledgeSnapshotId &&
    project.globalLiveDeploymentId ===
      input.expectedGlobalLiveDeploymentId &&
    project.mainlandLiveDeploymentId ===
      input.expectedMainlandLiveDeploymentId &&
    project.canonicalHostname === input.expectedCanonicalHostname
  );
}

function parseSiteOpsRebuildNote(
  value: string | null | undefined,
): SiteOpsRebuildNote | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.kind !== REBUILD_NOTE_KIND ||
      ![1, 2, 3, 4].includes(Number(parsed.schemaVersion)) ||
      typeof parsed.projectId !== "string" ||
      (typeof parsed.sourceBuildId !== "string" &&
        !([3, 4].includes(Number(parsed.schemaVersion)) &&
          parsed.sourceBuildId === null)) ||
      (typeof parsed.knowledgeSnapshotId !== "string" &&
        !([3, 4].includes(Number(parsed.schemaVersion)) &&
          parsed.knowledgeSnapshotId === null))
    ) {
      return null;
    }
    if (parsed.schemaVersion === 2) {
      if (
        typeof parsed.resetAppliedAt !== "string" ||
        !Number.isInteger(parsed.resetAppliedProjectRevision) ||
        Number(parsed.resetAppliedProjectRevision) < 1
      ) {
        return null;
      }
      return parsed as SiteOpsRebuildNoteV2;
    }
    if (parsed.schemaVersion === 3) {
      const hasResetTimestamp = typeof parsed.resetAppliedAt === "string";
      const hasResetRevision =
        Number.isInteger(parsed.resetAppliedProjectRevision) &&
        Number(parsed.resetAppliedProjectRevision) > 0;
      if (hasResetTimestamp !== hasResetRevision) return null;
      return parsed as SiteOpsRebuildNoteV3;
    }
    if (parsed.schemaVersion === 4) {
      const hasResetTimestamp = typeof parsed.resetAppliedAt === "string";
      const hasResetRevision =
        Number.isInteger(parsed.resetAppliedProjectRevision) &&
        Number(parsed.resetAppliedProjectRevision) > 0;
      if (
        parsed.resetIntent !== APPROVED_RESET_UNPUBLISH ||
        typeof parsed.resetOperationId !== "string" ||
        !z.string().uuid().safeParse(parsed.resetOperationId).success ||
        typeof parsed.resetApprovedAt !== "string" ||
        !Number.isInteger(parsed.resetExpectedProjectRevision) ||
        Number(parsed.resetExpectedProjectRevision) < 1 ||
        !Number.isInteger(parsed.minimumKnowledgeSnapshotVersion) ||
        Number(parsed.minimumKnowledgeSnapshotVersion) < 1 ||
        (hasResetTimestamp &&
          (parsed.freshRootApplied !== true ||
            parsed.unpublishOperationId !== parsed.resetOperationId)) ||
        (!hasResetTimestamp &&
          (parsed.freshRootApplied !== undefined ||
            parsed.unpublishOperationId !== undefined)) ||
        hasResetTimestamp !== hasResetRevision
      ) {
        return null;
      }
      return parsed as SiteOpsRebuildNoteV4;
    }
    return parsed as SiteOpsRebuildNoteV1;
  } catch {
    return null;
  }
}

export function siteOpsRebuildResetApplied(value: string | null | undefined) {
  const note = parseSiteOpsRebuildNote(value);
  return Boolean(
    note &&
      (note.schemaVersion === 2 ||
        ((note.schemaVersion === 3 || note.schemaVersion === 4) &&
          note.resetAppliedAt)),
  );
}

export function siteOpsRebuildResetPending(value: string | null | undefined) {
  const note = parseSiteOpsRebuildNote(value);
  return Boolean(
    note && note.schemaVersion === 4 && !note.resetAppliedAt,
  );
}

export function siteOpsRebuildMinimumSnapshotVersion(
  value: string | null | undefined,
) {
  const note = parseSiteOpsRebuildNote(value);
  return note?.schemaVersion === 4
    ? note.minimumKnowledgeSnapshotVersion
    : null;
}

export function siteOpsRebuildAcceptedForCurrentCycle(input: {
  internalNote: string | null | undefined;
  currentBuildId: string | null;
}) {
  const note = parseSiteOpsRebuildNote(input.internalNote);
  return Boolean(
    note &&
      siteOpsRebuildResetApplied(input.internalNote) &&
      note.sourceBuildId === input.currentBuildId,
  );
}

export function siteOpsRebuildRequestDisposition(input: {
  hasWorkflowProgress: boolean;
  ticketStatus: string | null;
  resetApplied: boolean;
}) {
  if (!input.hasWorkflowProgress) return "unavailable" as const;
  if (!input.ticketStatus) return "create" as const;
  if (input.ticketStatus === "in_progress" && input.resetApplied) {
    return "resubmit" as const;
  }
  return "pending" as const;
}

export class SiteOpsRebuildTicketError extends Error {
  constructor(
    public readonly code:
      | "BUILD_NOT_READY"
      | "DELIVERY_OWNER_NOT_ASSIGNED"
      | "ENTITLEMENT_NOT_FOUND"
      | "IN_FLIGHT_OPERATION"
      | "INVALID_TICKET"
      | "TICKET_ALREADY_OPEN",
    message: string,
  ) {
    super(message);
    this.name = "SiteOpsRebuildTicketError";
  }
}

export function siteOpsRebuildDedupeKey(buildId: string) {
  return `site-rebuild:${buildId}`;
}

export function siteOpsRebuildProjectDedupeKey(projectId: string) {
  return `site-rebuild-project:${projectId}`;
}

export function siteOpsRebuildDeliveryClientRequestId(input: {
  userId: number;
  projectId: string;
  clientRequestId: string;
}) {
  const bytes = createHash("sha256")
    .update("frontmind.siteops-rebuild.delivery-request.v1\0", "utf8")
    .update(String(input.userId), "utf8")
    .update("\0", "utf8")
    .update(input.projectId.trim(), "utf8")
    .update("\0", "utf8")
    .update(input.clientRequestId.trim(), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function siteOpsRebuildTargetPage(buildId: string) {
  return `${REBUILD_TARGET_PREFIX}${buildId}`;
}

export function siteOpsRebuildProjectTargetPage(projectId: string) {
  return `${REBUILD_PROJECT_TARGET_PREFIX}${projectId}`;
}

export function siteOpsRebuildProjectId(targetPage: string | null | undefined) {
  const value = targetPage?.trim() ?? "";
  const projectId = value.startsWith(REBUILD_PROJECT_TARGET_PREFIX)
    ? value.slice(REBUILD_PROJECT_TARGET_PREFIX.length)
    : "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    projectId,
  )
    ? projectId
    : null;
}

export function siteOpsRebuildResubmissionProjection(input: {
  projectId: string;
  internalNote: string | null | undefined;
}) {
  const note = parseSiteOpsRebuildNote(input.internalNote);
  if (
    !note ||
    note.schemaVersion === 1 ||
    !note.resetAppliedAt ||
    !note.resetAppliedProjectRevision
  ) {
    return null;
  }
  const projectScopedNote: SiteOpsRebuildNoteV3 | SiteOpsRebuildNoteV4 =
    note.schemaVersion === 4
      ? { ...note, projectId: input.projectId }
      : {
          schemaVersion: 3,
          kind: REBUILD_NOTE_KIND,
          projectId: input.projectId,
          sourceBuildId: note.sourceBuildId,
          knowledgeSnapshotId: note.knowledgeSnapshotId,
          resetAppliedAt: note.resetAppliedAt,
          resetAppliedProjectRevision: note.resetAppliedProjectRevision,
        };
  return {
    targetPage: siteOpsRebuildProjectTargetPage(input.projectId),
    technicalDedupeKey: siteOpsRebuildProjectDedupeKey(input.projectId),
    internalNote: JSON.stringify(projectScopedNote),
  };
}

export function siteOpsRebuildBuildId(targetPage: string | null | undefined) {
  const value = targetPage?.trim() ?? "";
  const buildId = value.startsWith(REBUILD_TARGET_PREFIX)
    ? value.slice(REBUILD_TARGET_PREFIX.length)
    : "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    buildId,
  )
    ? buildId
    : null;
}

function buildHasCompletePreview(
  build: typeof siteBuilds.$inferSelect | null | undefined,
) {
  return Boolean(
    build &&
      ["preview_ready", "approved"].includes(build.status) &&
      build.contractLocalAssetId &&
      build.sourceLocalAssetId &&
      build.distLocalAssetId &&
      build.qaLocalAssetId &&
      build.provenanceLocalAssetId,
  );
}

export async function loadSiteOpsRebuildRequest(
  executor: any,
  input: {
    userId: number;
    projectId: string;
    currentBuildId: string | null;
    hasWorkflowProgress?: boolean;
  },
) {
  const ticketDedupePredicate = input.currentBuildId
    ? or(
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildDedupeKey(input.currentBuildId),
        ),
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildProjectDedupeKey(input.projectId),
        ),
      )
    : eq(
        deliveryTickets.technicalDedupeKey,
        siteOpsRebuildProjectDedupeKey(input.projectId),
      );
  const [
    buildRows,
    ticketRows,
    completedTicketRows,
    completedResetOperationRows,
  ] = await Promise.all([
    input.currentBuildId
      ? executor
          .select()
          .from(siteBuilds)
          .where(
            and(
              eq(siteBuilds.id, input.currentBuildId),
              eq(siteBuilds.projectId, input.projectId),
              eq(siteBuilds.userId, input.userId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    executor
      .select({
        id: deliveryTickets.id,
        status: deliveryTickets.status,
        internalNote: deliveryTickets.internalNote,
      })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.userId),
          eq(deliveryTickets.operation, "site_rebuild"),
          ticketDedupePredicate,
          inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
        ),
      )
      .orderBy(asc(deliveryTickets.createdAt))
      .limit(1),
    executor
      .select({
        id: deliveryTickets.id,
        status: deliveryTickets.status,
        internalNote: deliveryTickets.internalNote,
      })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.userId),
          eq(deliveryTickets.operation, "site_rebuild"),
          eq(deliveryTickets.status, "completed"),
          isNotNull(deliveryTickets.internalNote),
        ),
      )
      .orderBy(desc(deliveryTickets.updatedAt)),
    executor
      .select({
        id: siteOperations.id,
        input: siteOperations.input,
        result: siteOperations.result,
      })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.userId, input.userId),
          eq(siteOperations.projectId, input.projectId),
          eq(siteOperations.kind, "rollback"),
          eq(siteOperations.provider, "aliyun_esa"),
          eq(siteOperations.status, "succeeded"),
          isNotNull(siteOperations.result),
        ),
      )
      .orderBy(desc(siteOperations.updatedAt)),
  ]);
  const ticket = ticketRows[0];
  const activeNote = parseSiteOpsRebuildNote(ticket?.internalNote);
  let completedTicket:
    | { id: string; status: string; internalNote: string | null }
    | undefined;
  let completedNote: SiteOpsRebuildNoteV4 | null = null;
  let completedFloor: number | null = null;
  for (const candidate of completedTicketRows as Array<{
    id: string;
    status: string;
    internalNote: string | null;
  }>) {
    if (candidate.status !== "completed") continue;
    const note = completedFreshRootResetNote(
      candidate.internalNote,
      input.projectId,
    );
    if (!note) continue;
    completedFloor = Math.max(
      completedFloor ?? 0,
      note.minimumKnowledgeSnapshotVersion,
    );
    // Rows are newest-first. Preserve the newest valid completed coordinate
    // for display, but scan every valid reset so the permanent isolation floor
    // can never move backwards after multiple fresh-root cycles.
    if (!completedTicket) {
      completedTicket = candidate;
      completedNote = note;
    }
  }
  let completedOperationFloor: number | null = null;
  for (const candidate of completedResetOperationRows as Array<{
    id: string;
    input: unknown;
    result: unknown;
  }>) {
    const result = completedFreshRootResetOperationResult({
      operationId: candidate.id,
      projectId: input.projectId,
      operationInput: candidate.input,
      result: candidate.result,
    });
    if (!result) continue;
    completedOperationFloor = Math.max(
      completedOperationFloor ?? 0,
      result.minimumKnowledgeSnapshotVersion,
    );
  }
  const activeFloor = siteOpsRebuildMinimumSnapshotVersion(
    ticket?.internalNote,
  );
  const floorCandidates = [
    activeFloor,
    completedFloor,
    completedOperationFloor,
  ].filter((value): value is number => value !== null);
  const minimumKnowledgeSnapshotVersion = floorCandidates.length
    ? Math.max(...floorCandidates)
    : null;
  const resetApplied = ticket
    ? siteOpsRebuildResetApplied(ticket.internalNote)
    : siteOpsRebuildResetApplied(completedTicket?.internalNote) ||
      completedOperationFloor !== null;
  const coordinateNote = ticket ? activeNote : completedNote;
  const disposition = siteOpsRebuildRequestDisposition({
    hasWorkflowProgress:
      input.hasWorkflowProgress ??
      Boolean(input.currentBuildId || buildRows[0] || ticket),
    ticketStatus: ticket?.status ?? null,
    resetApplied,
  });
  return {
    allowed: disposition === "create" || disposition === "resubmit",
    ticketId: ticket?.id ?? null,
    status: ticket?.status ?? null,
    resetApplied,
    resetPending: siteOpsRebuildResetPending(ticket?.internalNote),
    minimumKnowledgeSnapshotVersion,
    resetSourceBuildId: coordinateNote?.sourceBuildId ?? null,
    acceptedForCurrentCycle: siteOpsRebuildAcceptedForCurrentCycle({
      // A completed ticket contributes only the permanent isolation floor.
      // It must never authorize another child build after its cycle closed.
      internalNote: ticket?.internalNote,
      currentBuildId: input.currentBuildId,
    }),
  };
}

export async function createSiteOpsRebuildTicket(
  tx: any,
  input: {
    userId: number;
    projectId: string;
    currentBuildId: string | null;
    clientRequestId: string;
    reason?: string;
    quotaPeriodIds: string[];
    now: Date;
  },
) {
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, input.projectId),
        eq(siteProjects.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project || project.currentBuildId !== input.currentBuildId) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前官网版本已变化，请刷新后重试。",
    );
  }
  if (
    !project.currentBuildId &&
    !project.currentKnowledgeSnapshotId &&
    project.status === "draft"
  ) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前尚未开始建站流程，无需提交重置需求。",
    );
  }
  const buildRows = input.currentBuildId
    ? await tx
        .select()
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.id, input.currentBuildId),
            eq(siteBuilds.projectId, input.projectId),
            eq(siteBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    : [];
  const build = buildRows[0];
  if (input.currentBuildId && !build) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前建站版本已变化，请刷新后重试。",
    );
  }
  const completedSourceBuild = buildHasCompletePreview(build) ? build : null;
  const technicalDedupeKey = completedSourceBuild
    ? siteOpsRebuildDedupeKey(completedSourceBuild.id)
    : siteOpsRebuildProjectDedupeKey(project.id);
  const activeDedupeKeys = Array.from(
    new Set([
      technicalDedupeKey,
      siteOpsRebuildProjectDedupeKey(project.id),
      ...(input.currentBuildId
        ? [siteOpsRebuildDedupeKey(input.currentBuildId)]
        : []),
    ]),
  );
  const openRows = await tx
    .select({
      id: deliveryTickets.id,
      status: deliveryTickets.status,
      internalNote: deliveryTickets.internalNote,
      revision: deliveryTickets.revision,
    })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        inArray(deliveryTickets.technicalDedupeKey, activeDedupeKeys),
        inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const openTicket = openRows[0];
  const openTicketDisposition = siteOpsRebuildRequestDisposition({
    hasWorkflowProgress: true,
    ticketStatus: openTicket?.status ?? null,
    resetApplied: siteOpsRebuildResetApplied(openTicket?.internalNote),
  });
  if (openTicket && openTicketDisposition !== "resubmit") {
    throw new SiteOpsRebuildTicketError(
      "TICKET_ALREADY_OPEN",
      "当前官网版本已有一张重制工单。",
    );
  }
  if (input.quotaPeriodIds.length === 0) {
    throw new SiteOpsRebuildTicketError(
      "ENTITLEMENT_NOT_FOUND",
      "当前服务权益无法创建重制工单。",
    );
  }
  const periodRows = await tx
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.userId),
        inArray(serviceQuotaPeriods.id, input.quotaPeriodIds),
      ),
    )
    .orderBy(asc(serviceQuotaPeriods.startsAt))
    .limit(1);
  const period = periodRows[0];
  if (!period) {
    throw new SiteOpsRebuildTicketError(
      "ENTITLEMENT_NOT_FOUND",
      "当前服务权益无法创建重制工单。",
    );
  }
  const ownerRows = await tx
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      memberId: deliveryProjectAssignments.engineerUserId,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.customerUserId, input.userId),
        eq(deliveryProjectAssignments.roleType, "ai_operations_engineer"),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, "ai_operations_engineer"),
        eq(users.isActive, true),
      ),
    )
    .limit(1)
    .for("update");
  const owner = ownerRows[0];
  if (!owner?.memberId) {
    throw new SiteOpsRebuildTicketError(
      "DELIVERY_OWNER_NOT_ASSIGNED",
      "当前业务尚未配置 AI 运营负责人。",
    );
  }
  const ticketId = randomUUID();
  const reason = input.reason?.trim().slice(0, 4_000) || "希望重新制作官网。";
  const deliveryClientRequestId = siteOpsRebuildDeliveryClientRequestId({
    userId: input.userId,
    projectId: input.projectId,
    clientRequestId: input.clientRequestId,
  });
  if (openTicket) {
    const resubmission = siteOpsRebuildResubmissionProjection({
      projectId: project.id,
      internalNote: openTicket.internalNote,
    });
    if (!resubmission) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重制工单缺少有效的重置记录。",
      );
    }
    const message = "客户再次提交官网重制需求，等待 FrontMind 通过重置。";
    await tx
      .update(deliveryTickets)
      .set({
        status: "submitted",
        ...resubmission,
        description: reason,
        publicSummary: message,
        resolvedAt: null,
        revision: openTicket.revision + 1,
        updatedByUserId: input.userId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(deliveryTickets.id, openTicket.id),
          eq(deliveryTickets.revision, openTicket.revision),
        ),
      );
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: openTicket.id,
      userId: input.userId,
      actorUserId: input.userId,
      actorRole: "user",
      kind: "status_change",
      visibility: "customer",
      clientRequestId: deliveryClientRequestId,
      message: reason,
      fromStatus: openTicket.status,
      toStatus: "submitted",
      createdAt: input.now,
    });
    return {
      ticketId: openTicket.id,
      buildId: completedSourceBuild?.id ?? input.currentBuildId,
      resubmitted: true,
    };
  }
  await tx.insert(deliveryTickets).values({
    id: ticketId,
    isWorkflowContainer: false,
    userId: input.userId,
    contractId: period.contractId,
    quotaPeriodId: period.id,
    type: "website_operation",
    quotaPool: null,
    quotaState: "consumed",
    ordinal: 0,
    clientRequestId: deliveryClientRequestId,
    category: "site_rebuild",
    topic: "官网重制",
    title: "官网重制需求",
    description: reason,
    targetPage: completedSourceBuild
      ? siteOpsRebuildTargetPage(completedSourceBuild.id)
      : siteOpsRebuildProjectTargetPage(project.id),
    knowledgeSnapshotId:
      project.currentKnowledgeSnapshotId ??
      completedSourceBuild?.knowledgeSnapshotId ??
      null,
    workflowDomain: "ai_operations_engineer",
    operation: "site_rebuild",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.memberId,
    technicalDedupeKey,
    internalNote: JSON.stringify({
      schemaVersion: 3,
      kind: REBUILD_NOTE_KIND,
      projectId: project.id,
      sourceBuildId: completedSourceBuild?.id ?? null,
      knowledgeSnapshotId:
        project.currentKnowledgeSnapshotId ??
        completedSourceBuild?.knowledgeSnapshotId ??
        null,
    }),
    materialUrls: [],
    status: "submitted",
    publicSummary: "官网重制需求已提交，等待 FrontMind 受理。",
    createdByUserId: input.userId,
    updatedByUserId: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await tx.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId,
    userId: input.userId,
    actorUserId: input.userId,
    actorRole: "user",
    kind: "created",
    visibility: "customer",
    clientRequestId: deliveryClientRequestId,
    message: reason,
    toStatus: "submitted",
    createdAt: input.now,
  });
  return {
    ticketId,
    buildId: completedSourceBuild?.id ?? input.currentBuildId,
    resubmitted: false,
  };
}

export async function approveSiteOpsRebuildTicket(
  tx: any,
  input: {
    ticket: typeof deliveryTickets.$inferSelect;
    actorUserId: number;
    now: Date;
    reapply?: boolean;
    allowPendingRetry?: boolean;
  },
) {
  if (input.ticket.operation !== "site_rebuild") return null;
  const existingNote = parseSiteOpsRebuildNote(input.ticket.internalNote);
  const targetBuildId = siteOpsRebuildBuildId(input.ticket.targetPage);
  const targetProjectId = siteOpsRebuildProjectId(input.ticket.targetPage);
  if (
    !existingNote ||
    ([3, 4].includes(existingNote.schemaVersion)
      ? targetProjectId !== existingNote.projectId &&
        targetBuildId !== existingNote.sourceBuildId
      : targetBuildId !== existingNote.sourceBuildId)
  ) {
    throw new SiteOpsRebuildTicketError(
      "INVALID_TICKET",
      "官网重制工单缺少有效的项目或原版本坐标。",
    );
  }
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, existingNote.projectId),
        eq(siteProjects.userId, input.ticket.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前建站项目已变化或不再满足重制条件。",
    );
  }
  const currentBuildRows = project.currentBuildId
    ? await tx
        .select()
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.id, project.currentBuildId),
            eq(siteBuilds.projectId, project.id),
            eq(siteBuilds.userId, input.ticket.userId),
          ),
        )
        .limit(1)
        .for("update")
    : [];
  const currentBuild = currentBuildRows[0];
  if (project.currentBuildId && !currentBuild) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前建站版本已变化，请刷新后重试。",
    );
  }
  if (existingNote.schemaVersion !== 3) {
    if (existingNote.schemaVersion === 4) {
      // V4 is already project-scoped and carries its own immutable approval
      // coordinate. The operation/finalizer below performs the strict CAS.
    } else if (
      !currentBuild ||
      currentBuild.id !== existingNote.sourceBuildId ||
      currentBuild.knowledgeSnapshotId !== existingNote.knowledgeSnapshotId ||
      !buildHasCompletePreview(currentBuild)
    ) {
      throw new SiteOpsRebuildTicketError(
        "BUILD_NOT_READY",
        "原官网版本已变化或不再满足重制条件。",
      );
    }
  }
  if (
    existingNote.schemaVersion === 4 &&
    !existingNote.resetAppliedAt &&
    !input.reapply
  ) {
    const resetOperationRows = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.id, existingNote.resetOperationId),
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.userId, project.userId),
        ),
      )
      .limit(1)
      .for("update");
    const resetOperation = resetOperationRows[0];
    const resetInput = resetOperation
      ? parseApprovedResetUnpublishInput(resetOperation.input)
      : null;
    if (
      !resetOperation ||
      resetOperation.id !== existingNote.resetOperationId ||
      resetOperation.projectId !== project.id ||
      resetOperation.userId !== project.userId ||
      resetOperation.kind !== "rollback" ||
      resetOperation.provider !== "aliyun_esa" ||
      !resetInput ||
      resetInput.rebuildTicketId !== input.ticket.id ||
      resetInput.expectedProjectRevision !==
        existingNote.resetExpectedProjectRevision
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重置下线任务坐标不一致，不能重放或重新排队。",
      );
    }
    const pendingResult = {
      projectId: project.id,
      sourceBuildId: existingNote.sourceBuildId,
      resetApplied: true as const,
      resetPending: true as const,
      resetOperationId: existingNote.resetOperationId,
      resetAppliedProjectRevision:
        existingNote.resetExpectedProjectRevision,
      internalNote: JSON.stringify(existingNote),
    };
    if (
      ["queued", "running", "outcome_unknown"].includes(
        resetOperation.status,
      )
    ) {
      return { ...pendingResult, pendingReplay: true as const };
    }
    if (
      !["failed", "attention_required"].includes(resetOperation.status)
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重置下线任务已结束且不能安全重试。",
      );
    }
    if (!input.allowPendingRetry) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "需求已被更新，请刷新后重试。",
      );
    }
    const retryErrorCode = resetOperation.errorCode;
    const retryablePreMutationCode =
      typeof retryErrorCode === "string" &&
      (retryErrorCode === "ESA_RUNTIME_DISABLED" ||
        retryErrorCode === "DATABASE_UNAVAILABLE" ||
        /^ESA_[A-Z0-9_]+_NOT_CONFIGURED$/u.test(retryErrorCode));
    const hasMutationBoundary =
      resetOperation.result != null ||
      resetOperation.providerOperationId != null ||
      resetOperation.providerTaskId != null;
    const attempt = Number(resetOperation.attempt ?? 0);
    if (
      typeof retryErrorCode !== "string" ||
      !retryablePreMutationCode ||
      hasMutationBoundary ||
      !Number.isInteger(attempt) ||
      attempt < 0 ||
      attempt >= 3
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重置下线任务已失败，因已触达外部变更边界、错误不可重试或重试次数已用尽，不能盲目重新执行。",
      );
    }
    const retryUpdate = await tx
      .update(siteOperations)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(siteOperations.id, existingNote.resetOperationId),
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.userId, project.userId),
          eq(siteOperations.kind, "rollback"),
          eq(siteOperations.provider, "aliyun_esa"),
          eq(siteOperations.status, resetOperation.status),
          eq(siteOperations.errorCode, retryErrorCode),
          eq(siteOperations.attempt, attempt),
          isNull(siteOperations.result),
          isNull(siteOperations.providerOperationId),
          isNull(siteOperations.providerTaskId),
        ),
      );
    if (affectedRows(retryUpdate) !== 1) {
      throw new SiteOpsRebuildTicketError(
        "IN_FLIGHT_OPERATION",
        "官网重置下线任务已变化，未重新排队，请刷新后重试。",
      );
    }
    return { ...pendingResult, resetRequeued: true as const };
  }
  if (siteOpsRebuildResetApplied(input.ticket.internalNote) && !input.reapply) {
    if (
      existingNote.schemaVersion === 1 ||
      !existingNote.resetAppliedProjectRevision
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重制工单缺少有效的重置记录。",
      );
    }
    return {
      projectId: project.id,
      sourceBuildId: existingNote.sourceBuildId,
      resetApplied: true as const,
      resetAppliedProjectRevision: existingNote.resetAppliedProjectRevision,
      internalNote: JSON.stringify(existingNote),
    };
  }
  const [
    activeOperationRows,
    activeDeploymentRows,
    activeDnsRows,
    financialRows,
  ] = await Promise.all([
    tx
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, project.id),
          inArray(siteOperations.status, [
            "queued",
            "running",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: siteDeployments.id })
      .from(siteDeployments)
      .where(
        and(
          eq(siteDeployments.projectId, project.id),
          inArray(siteDeployments.status, [
            "reserved",
            "deploying",
            "verifying",
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: siteDnsRecords.id })
      .from(siteDnsRecords)
      .where(
        and(
          eq(siteDnsRecords.projectId, project.id),
          inArray(siteDnsRecords.status, [
            "applying",
            "propagating",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1),
    tx
      .select({ id: siteDomainOperations.id })
      .from(siteDomainOperations)
      .where(
        and(
          eq(siteDomainOperations.projectId, project.id),
          isNotNull(siteDomainOperations.activeFinancialKey),
        ),
      )
      .limit(1),
  ]);
  if (
    activeOperationRows[0] ||
    activeDeploymentRows[0] ||
    activeDnsRows[0] ||
    financialRows[0]
  ) {
    throw new SiteOpsRebuildTicketError(
      "IN_FLIGHT_OPERATION",
      "当前仍有建站、发布、域名或 DNS 操作执行中，暂时不能开启重制。",
    );
  }
  const now = input.now;
  const snapshotVersionRows = await tx
    .select({ version: max(knowledgeBaseSnapshots.version) })
    .from(knowledgeBaseSnapshots)
    .where(eq(knowledgeBaseSnapshots.userId, project.userId));
  const minimumKnowledgeSnapshotVersion =
    Number(snapshotVersionRows[0]?.version ?? 0) + 1;
  const preservedBuildId = project.currentBuildId ?? existingNote.sourceBuildId;
  const resetOperationId = randomUUID();
  const resetInput = approvedResetUnpublishInputSchema.parse({
    schemaVersion: 1,
    intent: APPROVED_RESET_UNPUBLISH,
    rebuildTicketId: input.ticket.id,
    expectedProjectRevision: project.revision,
    expectedCurrentBuildId: project.currentBuildId ?? null,
    expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId ?? null,
    expectedGlobalLiveDeploymentId: project.globalLiveDeploymentId ?? null,
    expectedMainlandLiveDeploymentId: project.mainlandLiveDeploymentId ?? null,
    expectedCanonicalHostname: project.canonicalHostname ?? null,
  });
  const resetInputHash = createHash("sha256")
    .update(JSON.stringify(resetInput), "utf8")
    .digest("hex");
  await tx.insert(siteOperations).values({
    id: resetOperationId,
    projectId: project.id,
    userId: project.userId,
    conversationTurnId: null,
    buildId: preservedBuildId,
    kind: "rollback",
    status: "queued",
    clientRequestId: `site-rebuild-unpublish:${input.ticket.id}:${project.revision}`,
    inputHash: resetInputHash,
    input: resetInput,
    provider: "aliyun_esa",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  });
  const upgradedNote: SiteOpsRebuildNoteV4 = {
    schemaVersion: 4,
    kind: REBUILD_NOTE_KIND,
    projectId: project.id,
    sourceBuildId: preservedBuildId,
    knowledgeSnapshotId:
      project.currentKnowledgeSnapshotId ??
      currentBuild?.knowledgeSnapshotId ??
      existingNote.knowledgeSnapshotId,
    resetIntent: APPROVED_RESET_UNPUBLISH,
    resetOperationId,
    resetApprovedAt: now.toISOString(),
    resetExpectedProjectRevision: project.revision,
    minimumKnowledgeSnapshotVersion,
  };
  return {
    projectId: project.id,
    sourceBuildId: preservedBuildId,
    resetApplied: true as const,
    resetPending: true as const,
    resetOperationId,
    // Compatibility for the delivery approval response. The durable V4 note
    // does not claim completion until the worker stores resetAppliedAt.
    resetAppliedProjectRevision: project.revision,
    internalNote: JSON.stringify(upgradedNote),
  };
}

function affectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ??
      0,
  );
}

function nullableCoordinate(column: any, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

/**
 * Completes an approved reset only after ESA has read-only reconciled the
 * related-record and Routine deletions. All customer workflow coordinates are
 * cleared in the same transaction; immutable builds, deployments and ticket
 * events remain as audit history.
 */
export async function finalizeApprovedSiteOpsReset(
  tx: any,
  input: {
    operation: typeof siteOperations.$inferSelect;
    now: Date;
  },
) {
  const reset = parseApprovedResetUnpublishInput(input.operation.input);
  if (
    input.operation.kind !== "rollback" ||
    input.operation.provider !== "aliyun_esa" ||
    !reset
  ) {
    return { status: "not_applicable" as const };
  }
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, input.operation.projectId),
        eq(siteProjects.userId, input.operation.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project || !approvedResetUnpublishProjectMatches(reset, project)) {
    return { status: "invalidated" as const };
  }
  const ticketRows = await tx
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.id, reset.rebuildTicketId),
        eq(deliveryTickets.userId, input.operation.userId),
        eq(deliveryTickets.operation, "site_rebuild"),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  const note = parseSiteOpsRebuildNote(ticket?.internalNote);
  if (
    !ticket ||
    !note ||
    note.schemaVersion !== 4 ||
    note.projectId !== project.id ||
    note.resetOperationId !== input.operation.id ||
    note.resetExpectedProjectRevision !== project.revision
  ) {
    return { status: "invalidated" as const };
  }
  if (note.resetAppliedAt && note.resetAppliedProjectRevision) {
    return {
      status: "applied" as const,
      projectRevision: note.resetAppliedProjectRevision,
      internalNote: JSON.stringify(note),
      operationResult: completedFreshRootResetOperationProjection({
        operationId: input.operation.id,
        projectId: project.id,
        minimumKnowledgeSnapshotVersion:
          note.minimumKnowledgeSnapshotVersion,
        resetAppliedProjectRevision: note.resetAppliedProjectRevision,
      }),
    };
  }

  const nextRevision = project.revision + 1;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId));
  const projectUpdate = await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: null,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      brief: null,
      status: "draft",
      revision: nextRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteProjects.id, project.id),
        eq(siteProjects.userId, project.userId),
        eq(siteProjects.revision, reset.expectedProjectRevision),
        nullableCoordinate(
          siteProjects.currentBuildId,
          reset.expectedCurrentBuildId,
        ),
        nullableCoordinate(
          siteProjects.currentKnowledgeSnapshotId,
          reset.expectedKnowledgeSnapshotId,
        ),
        nullableCoordinate(
          siteProjects.globalLiveDeploymentId,
          reset.expectedGlobalLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.mainlandLiveDeploymentId,
          reset.expectedMainlandLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.canonicalHostname,
          reset.expectedCanonicalHostname,
        ),
      ),
    );
  if (affectedRows(projectUpdate) !== 1) {
    return { status: "invalidated" as const };
  }

  await tx
    .update(siteBuilds)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, project.userId),
        inArray(siteBuilds.status, [
          "preparing",
          "visual_searching",
          "awaiting_visual_selection",
          "design_compiling",
          "contract_ready",
          "building",
          "qa_running",
          "failed",
          "attention_required",
        ]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, project.userId),
        inArray(siteBuilds.status, ["preview_ready", "approved"]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ quotaState: "released", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, project.userId),
        eq(siteBuilds.quotaState, "reserved"),
      ),
    );

  await tx
    .update(messages)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(messages.conversationId, project.conversationId),
        eq(messages.userId, project.userId),
        isNull(messages.deletedAt),
      ),
    );
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.userId, project.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
      ),
    );
  const previousHeads = [
    reset.expectedGlobalLiveDeploymentId,
    reset.expectedMainlandLiveDeploymentId,
  ].filter((value): value is string => Boolean(value));
  const previousHeadIds = new Set(previousHeads);
  const deploymentRows = await tx
    .select({
      id: siteDeployments.id,
      status: siteDeployments.status,
      verification: siteDeployments.verification,
    })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, project.id),
        eq(siteDeployments.userId, project.userId),
      ),
    )
    .for("update");
  for (const deployment of deploymentRows) {
    await tx
      .update(siteDeployments)
      .set({
        status: previousHeadIds.has(deployment.id)
          ? "superseded"
          : deployment.status,
        verification: {
          ...(deployment.verification ?? {}),
          resetInvalidated: true,
          resetInvalidatedAt: input.now.toISOString(),
          resetOperationId: input.operation.id,
        },
        updatedAt: input.now,
      })
      .where(eq(siteDeployments.id, deployment.id));
  }
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: project.conversationId,
    userId: project.userId,
    role: "assistant",
    content:
      "旧官网已下线，官网重置已完成；企业知识库保持不变，可从当前知识库重新开始建站。",
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "brief_question",
        subjectId: ticket.id,
        revision: nextRevision,
        status: "active",
        payload: {
          rebuildTicketId: ticket.id,
          requested: "current_knowledge",
          reset: true,
          unpublishCompleted: true,
        },
      },
    },
  });
  const appliedNote: SiteOpsRebuildNoteV4 = {
    ...note,
    resetAppliedAt: input.now.toISOString(),
    resetAppliedProjectRevision: nextRevision,
    freshRootApplied: true,
    unpublishOperationId: input.operation.id,
  };
  const priorTicketStatus = ticket.status;
  const ticketUpdate = await tx
    .update(deliveryTickets)
    .set({
      status: "completed",
      publicSummary:
        "旧网站已安全下线，官网重置已完成；企业知识库保持不变，可创建独立的新建站任务。",
      internalNote: JSON.stringify(appliedNote),
      quotaState: "consumed",
      technicalDedupeKey: null,
      resolvedAt: input.now,
      revision: ticket.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
      ),
    );
  if (affectedRows(ticketUpdate) !== 1) {
    throw new Error("SITEOPS_RESET_TICKET_CAS_CONFLICT");
  }
  await tx.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: ticket.id,
    userId: ticket.userId,
    actorUserId: null,
    actorRole: "system",
    kind: "delivery_result",
    visibility: "customer",
    message:
      "旧网站已安全下线，旧建站流程已清空；企业知识库保持不变，可从当前知识库创建全新官网任务。",
    fromStatus: priorTicketStatus,
    toStatus: "completed",
    actorContext: {
      projectAssignmentId: ticket.assignedProjectAssignmentId!,
      customerUserId: ticket.userId,
      roleType: "ai_operations_engineer",
    },
    createdAt: input.now,
  });
  return {
    status: "applied" as const,
    projectRevision: nextRevision,
    internalNote: JSON.stringify(appliedNote),
    operationResult: completedFreshRootResetOperationProjection({
      operationId: input.operation.id,
      projectId: project.id,
      minimumKnowledgeSnapshotVersion:
        appliedNote.minimumKnowledgeSnapshotVersion,
      resetAppliedProjectRevision: nextRevision,
    }),
  };
}

export async function completeSiteOpsRebuildTicket(
  tx: any,
  input: {
    userId: number;
    projectId: string;
    parentBuildId: string | null;
    childBuildId: string;
    now: Date;
  },
) {
  const dedupePredicate = input.parentBuildId
    ? or(
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildDedupeKey(input.parentBuildId),
        ),
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildProjectDedupeKey(input.projectId),
        ),
      )
    : eq(
        deliveryTickets.technicalDedupeKey,
        siteOpsRebuildProjectDedupeKey(input.projectId),
      );
  const ticketRows = await tx
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        eq(deliveryTickets.operation, "site_rebuild"),
        dedupePredicate,
        eq(deliveryTickets.status, "in_progress"),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  if (
    !ticket ||
    ticket.status !== "in_progress" ||
    !siteOpsRebuildResetApplied(ticket.internalNote) ||
    parseSiteOpsRebuildNote(ticket.internalNote)?.projectId !== input.projectId
  ) {
    return null;
  }
  const message =
    "全新官网预览已完成；旧官网与旧任务保持下线和隔离，不会被再次发布。";
  const completed = await tx
    .update(deliveryTickets)
    .set({
      status: "completed",
      publicSummary: message,
      quotaState: "consumed",
      technicalDedupeKey: null,
      resolvedAt: input.now,
      revision: ticket.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
      ),
    );
  if (affectedRows(completed) !== 1) {
    throw new Error("SITEOPS_REBUILD_COMPLETION_CAS_CONFLICT");
  }
  await tx.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: ticket.id,
    userId: ticket.userId,
    actorUserId: null,
    actorRole: "system",
    kind: "delivery_result",
    visibility: "customer",
    message,
    fromStatus: ticket.status,
    toStatus: "completed",
    actorContext: {
      projectAssignmentId: ticket.assignedProjectAssignmentId!,
      customerUserId: ticket.userId,
      roleType: "ai_operations_engineer",
    },
    createdAt: input.now,
  });
  return { ticketId: ticket.id, childBuildId: input.childBuildId };
}
