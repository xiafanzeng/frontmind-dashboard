import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, max } from "drizzle-orm";
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
} from "../../drizzle/schema";

const REBUILD_TARGET_PREFIX = "/siteops/builds/";
const REBUILD_NOTE_KIND = "frontmind.siteops-rebuild.v1";
const ACTIVE_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

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

export function siteOpsRebuildTargetPage(buildId: string) {
  return `${REBUILD_TARGET_PREFIX}${buildId}`;
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
  input: { userId: number; projectId: string; currentBuildId: string | null },
) {
  if (!input.currentBuildId) {
    return { allowed: false, ticketId: null, status: null } as const;
  }
  const [buildRows, ticketRows] = await Promise.all([
    executor
      .select()
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.id, input.currentBuildId),
          eq(siteBuilds.projectId, input.projectId),
          eq(siteBuilds.userId, input.userId),
        ),
      )
      .limit(1),
    executor
      .select({ id: deliveryTickets.id, status: deliveryTickets.status })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.userId),
          eq(deliveryTickets.operation, "site_rebuild"),
          eq(
            deliveryTickets.technicalDedupeKey,
            siteOpsRebuildDedupeKey(input.currentBuildId),
          ),
          inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
        ),
      )
      .orderBy(asc(deliveryTickets.createdAt))
      .limit(1),
  ]);
  const ticket = ticketRows[0];
  return {
    allowed: buildHasCompletePreview(buildRows[0]) && !ticket,
    ticketId: ticket?.id ?? null,
    status: ticket?.status ?? null,
  };
}

export async function createSiteOpsRebuildTicket(
  tx: any,
  input: {
    userId: number;
    projectId: string;
    currentBuildId: string;
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
  const buildRows = await tx
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
    .for("update");
  const build = buildRows[0];
  if (!buildHasCompletePreview(build)) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "官网尚未完成，暂时不能提交重制需求。",
    );
  }
  const technicalDedupeKey = siteOpsRebuildDedupeKey(build.id);
  const openRows = await tx
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        eq(deliveryTickets.technicalDedupeKey, technicalDedupeKey),
        inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  if (openRows[0]) {
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
    clientRequestId: input.clientRequestId,
    category: "site_rebuild",
    topic: "官网重制",
    title: "官网重制需求",
    description: reason,
    targetPage: siteOpsRebuildTargetPage(build.id),
    knowledgeSnapshotId: build.knowledgeSnapshotId,
    workflowDomain: "ai_operations_engineer",
    operation: "site_rebuild",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.memberId,
    technicalDedupeKey,
    internalNote: JSON.stringify({
      schemaVersion: 1,
      kind: REBUILD_NOTE_KIND,
      projectId: project.id,
      sourceBuildId: build.id,
      knowledgeSnapshotId: build.knowledgeSnapshotId,
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
    clientRequestId: input.clientRequestId,
    message: reason,
    toStatus: "submitted",
    createdAt: input.now,
  });
  return { ticketId, buildId: build.id };
}

export async function acceptSiteOpsRebuildTicket(
  tx: any,
  input: {
    ticket: typeof deliveryTickets.$inferSelect;
    actorUserId: number;
    now: Date;
  },
) {
  if (input.ticket.operation !== "site_rebuild") return null;
  const sourceBuildId = siteOpsRebuildBuildId(input.ticket.targetPage);
  if (!sourceBuildId) {
    throw new SiteOpsRebuildTicketError(
      "INVALID_TICKET",
      "官网重制工单缺少有效的原版本坐标。",
    );
  }
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(eq(siteProjects.userId, input.ticket.userId))
    .limit(1)
    .for("update");
  const project = projectRows[0];
  const buildRows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, sourceBuildId),
        eq(siteBuilds.userId, input.ticket.userId),
      ),
    )
    .limit(1)
    .for("update");
  const sourceBuild = buildRows[0];
  if (
    !project ||
    project.currentBuildId !== sourceBuildId ||
    sourceBuild?.projectId !== project.id ||
    !buildHasCompletePreview(sourceBuild)
  ) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "原官网版本已变化或不再满足重制条件。",
    );
  }
  const [activeOperationRows, activeDeploymentRows, activeDnsRows, financialRows] =
    await Promise.all([
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
            inArray(siteDeployments.status, ["reserved", "deploying", "verifying"]),
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
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: project.conversationId,
    userId: project.userId,
    role: "assistant",
    content:
      "官网重制需求已受理。当前官网会继续保留；请确认知识库内容，然后生成新的视觉候选。",
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "brief_question",
        subjectId: input.ticket.id,
        revision: nextRevision,
        status: "active",
        payload: { rebuildTicketId: input.ticket.id, sourceBuildId },
      },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      status: "collecting_brief",
      revision: nextRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteProjects.id, project.id),
        eq(siteProjects.revision, project.revision),
      ),
    );
  return { projectId: project.id, sourceBuildId };
}

export async function completeSiteOpsRebuildTicket(
  tx: any,
  input: {
    userId: number;
    parentBuildId: string | null;
    childBuildId: string;
    now: Date;
  },
) {
  if (!input.parentBuildId) return null;
  const ticketRows = await tx
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        eq(deliveryTickets.operation, "site_rebuild"),
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildDedupeKey(input.parentBuildId),
        ),
        eq(deliveryTickets.status, "in_progress"),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  if (!ticket) return null;
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
