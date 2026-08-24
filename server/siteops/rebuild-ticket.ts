import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, max, or } from "drizzle-orm";
import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
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

type SiteOpsRebuildNote =
  | SiteOpsRebuildNoteV1
  | SiteOpsRebuildNoteV2
  | SiteOpsRebuildNoteV3;

function parseSiteOpsRebuildNote(
  value: string | null | undefined,
): SiteOpsRebuildNote | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.kind !== REBUILD_NOTE_KIND ||
      ![1, 2, 3].includes(Number(parsed.schemaVersion)) ||
      typeof parsed.projectId !== "string" ||
      (typeof parsed.sourceBuildId !== "string" &&
        !(parsed.schemaVersion === 3 && parsed.sourceBuildId === null)) ||
      (typeof parsed.knowledgeSnapshotId !== "string" &&
        !(parsed.schemaVersion === 3 && parsed.knowledgeSnapshotId === null))
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
        (note.schemaVersion === 3 && note.resetAppliedAt)),
  );
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
  const projectScopedNote: SiteOpsRebuildNoteV3 = {
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
  const [buildRows, ticketRows] = await Promise.all([
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
  ]);
  const ticket = ticketRows[0];
  const resetApplied = siteOpsRebuildResetApplied(ticket?.internalNote);
  const parsedNote = parseSiteOpsRebuildNote(ticket?.internalNote);
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
    resetSourceBuildId: parsedNote?.sourceBuildId ?? null,
    acceptedForCurrentCycle: siteOpsRebuildAcceptedForCurrentCycle({
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
  },
) {
  if (input.ticket.operation !== "site_rebuild") return null;
  const existingNote = parseSiteOpsRebuildNote(input.ticket.internalNote);
  const targetBuildId = siteOpsRebuildBuildId(input.ticket.targetPage);
  const targetProjectId = siteOpsRebuildProjectId(input.ticket.targetPage);
  if (
    !existingNote ||
    (existingNote.schemaVersion === 3
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
    if (
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
  const nextRevision = project.revision + 1;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId));
  const now = input.now;
  const preservedBuildId = project.currentBuildId ?? existingNote.sourceBuildId;
  await tx
    .update(messages)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(messages.conversationId, project.conversationId),
        eq(messages.userId, project.userId),
        isNull(messages.deletedAt),
      ),
    );
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.userId, project.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
      ),
    );
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: project.conversationId,
    userId: project.userId,
    role: "assistant",
    content:
      "官网重制需求已通过。旧官网和线上网站保持不变，请重新上传或选择知识库版本。",
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "brief_question",
        subjectId: input.ticket.id,
        revision: nextRevision,
        status: "active",
        payload: {
          rebuildTicketId: input.ticket.id,
          sourceBuildId: preservedBuildId,
          requested: "knowledge_snapshot",
          reset: true,
        },
      },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: null,
      brief: null,
      status: "draft",
      revision: nextRevision,
      updatedAt: now,
    })
    .where(
      and(
        eq(siteProjects.id, project.id),
        eq(siteProjects.revision, project.revision),
      ),
    );
  const upgradedNote: SiteOpsRebuildNoteV2 | SiteOpsRebuildNoteV3 =
    existingNote.schemaVersion === 3
      ? {
          ...existingNote,
          sourceBuildId: preservedBuildId,
          knowledgeSnapshotId:
            project.currentKnowledgeSnapshotId ??
            currentBuild?.knowledgeSnapshotId ??
            existingNote.knowledgeSnapshotId,
          resetAppliedAt: now.toISOString(),
          resetAppliedProjectRevision: nextRevision,
        }
      : {
          ...existingNote,
          schemaVersion: 2,
          resetAppliedAt: now.toISOString(),
          resetAppliedProjectRevision: nextRevision,
        };
  return {
    projectId: project.id,
    sourceBuildId: preservedBuildId,
    resetApplied: true as const,
    resetAppliedProjectRevision: nextRevision,
    internalNote: JSON.stringify(upgradedNote),
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
    !siteOpsRebuildResetApplied(ticket.internalNote) ||
    parseSiteOpsRebuildNote(ticket.internalNote)?.projectId !== input.projectId
  ) {
    return null;
  }
  const message = "新的官网版本已完成，原官网与历史版本仍可继续使用。";
  await tx
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
