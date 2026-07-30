import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  apiCredentials,
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  knowledgeBaseResetRequests,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  monitoringBatches,
  serviceContracts,
  serviceQuotaPeriods,
  userAdminAssignments,
  userDashboardContents,
  userUsageOwners,
  users,
  workspaceQuestions,
  workspaceSiteChecks,
  workspaceSiteProfiles,
} from "../drizzle/schema";
import {
  DELIVERY_ROLE_LABELS,
  deliveryRoleOwnsOperation,
  deliveryWorkflowOperationSchema,
  type DeliveryRoleType,
} from "../shared/delivery-roles";
import { hasExplicitAdminRole } from "../shared/admin-access";
import {
  AuthServiceError,
  createManagedUser,
  deleteActiveApiCredential,
  getApiCredentialStatus,
  replaceApiCredential,
  replaceApiCredentialInTransaction,
  validateUpstreamApiKey,
  type AuthenticatedUser,
} from "./auth-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import { getDb } from "./db";
import {
  deriveEffectiveServiceStatus,
  selectPortalContract,
  type ServicePortalContractRecord,
} from "./service-entitlement";

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function requireDeliveryManager(actor: AuthenticatedUser) {
  if (!hasExplicitAdminRole(actor)) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "需要交付管理权限");
  }
}

async function getActiveDeliveryProjectOwner(
  executor: any,
  customerUserId: number,
  roleType: DeliveryRoleType,
) {
  const rows = await executor
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      engineerUserId: deliveryProjectAssignments.engineerUserId,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.customerUserId, customerUserId),
        eq(deliveryProjectAssignments.roleType, roleType),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, roleType),
        eq(users.isActive, true),
      ),
    )
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

function requiredRolesForPlan(planCode: string | null | undefined) {
  const roles: DeliveryRoleType[] = [
    "monitoring_optimization_engineer",
    "content_distribution_engineer",
  ];
  if (planCode === "advanced" || planCode === "luxury") {
    roles.unshift("ai_operations_engineer");
  }
  return roles;
}

async function assertCanManageProject(input: {
  executor: any;
  actor: AuthenticatedUser;
  customerUserId: number;
}) {
  if (input.actor.adminAccessLevel === "system_admin") return;
  const ownerRows = await input.executor
    .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
    .from(userUsageOwners)
    .where(
      and(
        eq(userUsageOwners.userId, input.customerUserId),
        eq(userUsageOwners.deliveryAdminId, input.actor.id),
      ),
    )
    .limit(1)
    .for("update");
  if (!ownerRows[0]) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只能管理由当前交付管理员负责的客户项目",
    );
  }
}

export async function listDeliveryRoleManagement(actor: AuthenticatedUser) {
  requireDeliveryManager(actor);
  const db = await requireDb();
  const [
    allCustomers,
    contracts,
    ownerRows,
    adminRows,
    engineers,
    credentials,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "user"))
      .orderBy(desc(users.createdAt)),
    db.select().from(serviceContracts).orderBy(desc(serviceContracts.revision)),
    db.select().from(userUsageOwners),
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        adminAccessLevel: users.adminAccessLevel,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "admin")),
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isActive: users.isActive,
        engineerRoleType: users.engineerRoleType,
      })
      .from(users)
      .where(eq(users.role, "delivery_member"))
      .orderBy(desc(users.createdAt)),
    db
      .select({ userId: apiCredentials.userId })
      .from(apiCredentials)
      .where(eq(apiCredentials.status, "active")),
  ]);
  const visibleCustomers =
    actor.adminAccessLevel === "system_admin"
      ? allCustomers
      : allCustomers.filter((customer) =>
          ownerRows.some(
            (owner) =>
              owner.userId === customer.id &&
              owner.deliveryAdminId === actor.id,
          ),
        );
  const customerIds = visibleCustomers.map((customer) => customer.id);
  const [assignmentRows, statisticsTickets] = customerIds.length
    ? await Promise.all([
        db
          .select()
          .from(deliveryProjectAssignments)
          .where(
            inArray(deliveryProjectAssignments.customerUserId, customerIds),
          ),
        db
          .select()
          .from(deliveryTickets)
          .where(inArray(deliveryTickets.userId, customerIds))
          .orderBy(desc(deliveryTickets.updatedAt)),
      ])
    : [[], []];
  const activeTickets = statisticsTickets.filter((ticket) =>
    ACTIVE_DELIVERY_STATUSES.includes(ticket.status as any),
  );
  const ticketEvents = activeTickets.length
    ? await db
        .select({
          id: deliveryTicketEvents.id,
          ticketId: deliveryTicketEvents.ticketId,
          actorUserId: deliveryTicketEvents.actorUserId,
          actorRole: deliveryTicketEvents.actorRole,
          kind: deliveryTicketEvents.kind,
          message: deliveryTicketEvents.message,
          fromStatus: deliveryTicketEvents.fromStatus,
          toStatus: deliveryTicketEvents.toStatus,
          createdAt: deliveryTicketEvents.createdAt,
        })
        .from(deliveryTicketEvents)
        .where(
          inArray(
            deliveryTicketEvents.ticketId,
            activeTickets.map((ticket) => ticket.id),
          ),
        )
        .orderBy(desc(deliveryTicketEvents.createdAt))
    : [];
  const adminById = new Map(adminRows.map((admin) => [admin.id, admin]));
  const contractByCustomer = new Map<number, (typeof contracts)[number]>();
  for (const customer of visibleCustomers) {
    const contract = selectPortalContract(
      contracts.filter(
        (candidate) => candidate.userId === customer.id,
      ) as ServicePortalContractRecord[],
    );
    if (contract) {
      contractByCustomer.set(
        customer.id,
        contract as (typeof contracts)[number],
      );
    }
  }
  const configuredEngineerIds = new Set(
    credentials.map((credential) => credential.userId),
  );
  const engineerById = new Map(
    engineers.map((engineer) => [engineer.id, engineer]),
  );
  const projects = visibleCustomers.map((customer) => {
    const contract = contractByCustomer.get(customer.id);
    const owner = ownerRows.find((row) => row.userId === customer.id);
    const manager = owner ? adminById.get(owner.deliveryAdminId) : null;
    return {
      ...customer,
      planCode: contract?.planCode ?? null,
      contractStatus: deriveEffectiveServiceStatus(contract),
      contractStartsAt: contract?.startsAt?.getTime() ?? null,
      contractEndsAt: contract?.endsAt?.getTime() ?? null,
      managerId: manager?.id ?? null,
      managerUsername: manager?.username ?? null,
      managerDisplayName: manager?.displayName ?? null,
      requiredRoleTypes: requiredRolesForPlan(contract?.planCode),
    };
  });
  const assignments = assignmentRows.map((assignment) => {
    const engineer =
      assignment.engineerUserId == null
        ? null
        : engineerById.get(assignment.engineerUserId);
    return {
      ...assignment,
      engineerUsername: engineer?.username ?? null,
      engineerDisplayName: engineer?.displayName ?? null,
      engineerApiKeyConfigured:
        assignment.engineerUserId != null &&
        configuredEngineerIds.has(assignment.engineerUserId),
    };
  });
  const enrichedEngineers = engineers.map((engineer) => ({
    ...engineer,
    apiKeyConfigured: configuredEngineerIds.has(engineer.id),
  }));
  const roleStats = Object.fromEntries(
    (
      [
        "ai_operations_engineer",
        "monitoring_optimization_engineer",
        "content_distribution_engineer",
      ] as const
    ).map((roleType) => {
      const rows = statisticsTickets.filter(
        (ticket) => ticket.workflowDomain === roleType,
      );
      const activeRows = rows.filter((ticket) =>
        ACTIVE_DELIVERY_STATUSES.includes(ticket.status as any),
      );
      const overdueCutoff = Date.now() - 72 * 60 * 60 * 1000;
      return [
        roleType,
        {
          pendingAssignment: activeRows.filter(
            (ticket) => ticket.assignedMemberId == null,
          ).length,
          processing: activeRows.filter(
            (ticket) =>
              ticket.assignedMemberId != null &&
              ["submitted", "scheduled", "in_progress"].includes(ticket.status),
          ).length,
          waitingUser: activeRows.filter(
            (ticket) => ticket.status === "needs_information",
          ).length,
          overdue: activeRows.filter(
            (ticket) => ticket.updatedAt.getTime() < overdueCutoff,
          ).length,
          completed: rows.filter((ticket) => ticket.status === "completed")
            .length,
        },
      ];
    }),
  ) as Record<
    DeliveryRoleType,
    {
      pendingAssignment: number;
      processing: number;
      waitingUser: number;
      overdue: number;
      completed: number;
    }
  >;
  return {
    projects,
    assignments,
    engineers: enrichedEngineers,
    tickets: activeTickets,
    ticketEvents,
    roleStats,
  };
}

const ACTIVE_DELIVERY_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

export async function createDeliveryEngineer(input: {
  actor: AuthenticatedUser;
  username: string;
  password: string;
  displayName?: string;
  engineerRoleType: DeliveryRoleType;
  apiKey?: string;
}) {
  requireDeliveryManager(input.actor);
  const apiKey = input.apiKey?.trim() || null;
  if (apiKey) await validateUpstreamApiKey(apiKey);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const user = await createManagedUser(
      {
        username: input.username,
        password: input.password,
        displayName: input.displayName,
        role: "delivery_member",
        engineerRoleType: input.engineerRoleType,
      },
      tx,
    );
    if (apiKey) {
      await replaceApiCredentialInTransaction({
        executor: tx,
        userId: user.id,
        apiKey,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "account.created",
        targetType: "user",
        targetId: user.id,
        workspaceUserId: null,
        metadata: {
          role: "delivery_member",
          engineerRoleType: input.engineerRoleType,
          apiKeyConfigured: Boolean(apiKey),
        },
      },
      tx,
    );
    return user;
  });
}

export async function setProjectEngineer(input: {
  actor: AuthenticatedUser;
  customerUserId: number;
  roleType: DeliveryRoleType;
  engineerUserId: number | null;
  expectedRevision: number;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  let result;
  try {
    result = await db.transaction(async (tx) => {
      const customerRows = await tx
        .select({ role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, input.customerUserId))
        .limit(1)
        .for("update");
      if (customerRows[0]?.role !== "user" || !customerRows[0]?.isActive) {
        throw new AuthServiceError("NOT_FOUND", "客户项目不存在或已停用");
      }
      await assertCanManageProject({
        executor: tx,
        actor: input.actor,
        customerUserId: input.customerUserId,
      });
      const contractRows = await tx
        .select()
        .from(serviceContracts)
        .where(eq(serviceContracts.userId, input.customerUserId));
      const currentContract = selectPortalContract(
        contractRows as ServicePortalContractRecord[],
      );
      if (
        input.engineerUserId != null &&
        !requiredRolesForPlan(currentContract?.planCode).includes(
          input.roleType,
        )
      ) {
        throw new AuthServiceError("CONFLICT", "当前套餐未启用该工程师岗位");
      }
      if (input.engineerUserId != null) {
        const engineerRows = await tx
          .select({
            role: users.role,
            isActive: users.isActive,
            engineerRoleType: users.engineerRoleType,
          })
          .from(users)
          .where(eq(users.id, input.engineerUserId))
          .limit(1)
          .for("update");
        const engineer = engineerRows[0];
        if (
          engineer?.role !== "delivery_member" ||
          !engineer.isActive ||
          engineer.engineerRoleType !== input.roleType
        ) {
          throw new AuthServiceError(
            "CONFLICT",
            "请选择岗位匹配且已启用的工程师账号",
          );
        }
      }
      const existingRows = await tx
        .select()
        .from(deliveryProjectAssignments)
        .where(
          and(
            eq(deliveryProjectAssignments.customerUserId, input.customerUserId),
            eq(deliveryProjectAssignments.roleType, input.roleType),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0] ?? null;
      if ((existing?.revision ?? 0) !== input.expectedRevision) {
        throw new AuthServiceError("CONFLICT", "项目团队已变化，请刷新后重试");
      }
      if (input.engineerUserId == null) {
        if (!existing) return { success: true as const, assignment: null };
        const [ticketRows, resetRows] = await Promise.all([
          tx
            .select({ id: deliveryTickets.id })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.userId, input.customerUserId),
                eq(deliveryTickets.workflowDomain, input.roleType),
                inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
              ),
            )
            .limit(1),
          input.roleType === "ai_operations_engineer"
            ? tx
                .select({ id: knowledgeBaseResetRequests.id })
                .from(knowledgeBaseResetRequests)
                .where(
                  and(
                    eq(knowledgeBaseResetRequests.userId, input.customerUserId),
                    eq(knowledgeBaseResetRequests.status, "pending"),
                  ),
                )
                .limit(1)
            : Promise.resolve([]),
        ]);
        if (ticketRows[0] || resetRows[0]) {
          throw new AuthServiceError(
            "CONFLICT",
            "该岗位仍有未结束任务，不能解除负责人，请直接更换工程师",
          );
        }
        const nextRevision = existing.revision + 1;
        await tx
          .update(deliveryProjectAssignments)
          .set({
            engineerUserId: null,
            assignedByUserId: input.actor.id,
            revision: nextRevision,
            updatedAt: new Date(),
          })
          .where(eq(deliveryProjectAssignments.id, existing.id));
        await writeWorkspaceAuditEvent(
          {
            actor: input.actor,
            action: "delivery.project_engineer.unassigned",
            targetType: "workspace",
            targetId: input.customerUserId,
            workspaceUserId: input.customerUserId,
            metadata: {
              roleType: input.roleType,
              previousEngineerUserId: existing.engineerUserId,
            },
          },
          tx,
        );
        return {
          success: true as const,
          assignment: { id: existing.id, revision: nextRevision },
        };
      }
      const assignmentId = existing?.id ?? randomUUID();
      if (existing) {
        await tx
          .update(deliveryProjectAssignments)
          .set({
            engineerUserId: input.engineerUserId,
            assignedByUserId: input.actor.id,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(deliveryProjectAssignments.id, existing.id));
      } else {
        await tx.insert(deliveryProjectAssignments).values({
          id: assignmentId,
          customerUserId: input.customerUserId,
          roleType: input.roleType,
          engineerUserId: input.engineerUserId,
          assignedByUserId: input.actor.id,
        });
      }
      await tx
        .update(deliveryTickets)
        .set({
          assignedProjectAssignmentId: assignmentId,
          assignedMemberId: input.engineerUserId,
          updatedByUserId: input.actor.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deliveryTickets.userId, input.customerUserId),
            eq(deliveryTickets.workflowDomain, input.roleType),
            inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
          ),
        );
      if (input.roleType === "ai_operations_engineer") {
        await tx
          .update(knowledgeBaseResetRequests)
          .set({
            assignedProjectAssignmentId: assignmentId,
            assignedMemberId: input.engineerUserId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(knowledgeBaseResetRequests.userId, input.customerUserId),
              eq(knowledgeBaseResetRequests.status, "pending"),
            ),
          );
      }
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery.project_engineer.assigned",
          targetType: "workspace",
          targetId: input.customerUserId,
          workspaceUserId: input.customerUserId,
          metadata: {
            roleType: input.roleType,
            previousEngineerUserId: existing?.engineerUserId ?? null,
            engineerUserId: input.engineerUserId,
            projectAssignmentId: assignmentId,
          },
        },
        tx,
      );
      return {
        success: true as const,
        assignment: {
          id: assignmentId,
          revision: existing ? existing.revision + 1 : 1,
        },
      };
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "项目团队已变化，请刷新后重试");
    }
    throw error;
  }
  if (
    input.engineerUserId != null &&
    input.roleType === "monitoring_optimization_engineer"
  ) {
    await createProjectMonitoringHandoffIfReady({
      customerUserId: input.customerUserId,
      roleType: input.roleType,
      actorUserId: input.actor.id,
    });
  }
  return result;
}

export async function createProjectMonitoringHandoffIfReady(input: {
  customerUserId: number;
  roleType: DeliveryRoleType;
  actorUserId: number;
}) {
  const db = await requireDb();
  if (input.roleType === "monitoring_optimization_engineer") {
    const snapshotRows = await db
      .select({ id: knowledgeBaseSnapshots.id })
      .from(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, input.customerUserId))
      .limit(1);
    if (snapshotRows[0]) {
      await createKnowledgeMonitoringHandoff({
        userId: input.customerUserId,
        actorUserId: input.actorUserId,
      });
    }
  }
}

export async function dispatchDeliveryTicket(input: {
  actor: AuthenticatedUser;
  ticketId: string;
  priority: "low" | "normal" | "high" | "urgent";
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, input.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (!ticket || !ACTIVE_DELIVERY_STATUSES.includes(ticket.status as any)) {
      throw new AuthServiceError("NOT_FOUND", "待调度工单不存在");
    }
    if (!ticket.workflowDomain) {
      throw new AuthServiceError(
        "CONFLICT",
        "旧版技术工单仅供只读查看，不能重新进入交付流程",
      );
    }
    await assertCanManageProject({
      executor: tx,
      actor: input.actor,
      customerUserId: ticket.userId,
    });
    await tx
      .update(deliveryTickets)
      .set({
        priority: input.priority,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: input.actor.id,
      actorRole: "admin",
      kind: "message",
      visibility: "internal",
      message: `工单优先级已调整为 ${input.priority}。`,
      createdAt: new Date(),
    });
    return { success: true as const };
  });
}

export async function urgeDeliveryTicket(input: {
  actor: AuthenticatedUser;
  ticketId: string;
  message?: string;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, input.ticketId))
      .limit(1)
      .for("update");
    const ticket = rows[0];
    if (
      !ticket ||
      !ticket.workflowDomain ||
      !ACTIVE_DELIVERY_STATUSES.includes(ticket.status as any)
    ) {
      throw new AuthServiceError("NOT_FOUND", "可催办工单不存在");
    }
    await assertCanManageProject({
      executor: tx,
      actor: input.actor,
      customerUserId: ticket.userId,
    });
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: input.actor.id,
      actorRole: "admin",
      kind: "message",
      visibility: "internal",
      message: input.message?.trim() || "交付管理员已催办，请尽快处理。",
      createdAt: new Date(),
    });
    return { success: true as const };
  });
}

export async function listMyProjectAssignments(actor: AuthenticatedUser) {
  if (actor.role !== "delivery_member") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "该工作台仅对工程师开放");
  }
  const db = await requireDb();
  const rows = await db
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      customerUserId: deliveryProjectAssignments.customerUserId,
      customerUsername: users.username,
      customerName: users.displayName,
      roleType: deliveryProjectAssignments.roleType,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.customerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.engineerUserId, actor.id),
        actor.engineerRoleType
          ? eq(deliveryProjectAssignments.roleType, actor.engineerRoleType)
          : sql`false`,
        eq(users.role, "user"),
        eq(users.isActive, true),
      ),
    )
    .orderBy(users.displayName, users.username);
  const [contracts, activeTickets] = rows.length
    ? await Promise.all([
        db
          .select()
          .from(serviceContracts)
          .where(
            inArray(serviceContracts.userId, [
              ...new Set(rows.map((row) => row.customerUserId)),
            ]),
          ),
        db
          .select({
            assignedProjectAssignmentId:
              deliveryTickets.assignedProjectAssignmentId,
          })
          .from(deliveryTickets)
          .where(
            and(
              inArray(
                deliveryTickets.assignedProjectAssignmentId,
                rows.map((row) => row.projectAssignmentId),
              ),
              inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
            ),
          ),
      ])
    : [[], []];
  const activeAssignmentIds = new Set(
    activeTickets
      .map((ticket) => ticket.assignedProjectAssignmentId)
      .filter((id): id is string => Boolean(id)),
  );
  return rows
    .filter((row) => {
      const currentContract = selectPortalContract(
        contracts.filter(
          (contract) => contract.userId === row.customerUserId,
        ) as ServicePortalContractRecord[],
      );
      return (
        requiredRolesForPlan(currentContract?.planCode).includes(
          row.roleType,
        ) || activeAssignmentIds.has(row.projectAssignmentId)
      );
    })
    .map((row) => ({
      ...row,
      customerName:
        row.customerName ||
        row.customerUsername ||
        `客户 ${row.customerUserId}`,
      roleLabel: DELIVERY_ROLE_LABELS[row.roleType],
    }));
}

export async function assertDeliveryProjectContext(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  customerUserId?: number;
  expectedRoleType?: DeliveryRoleType;
  executor?: any;
}) {
  if (input.actor.role !== "delivery_member") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "需要交付成员权限");
  }
  const db = input.executor ?? (await requireDb());
  const rows = await db
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      customerUserId: deliveryProjectAssignments.customerUserId,
      roleType: deliveryProjectAssignments.roleType,
      customerUsername: users.username,
      customerName: users.displayName,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.customerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.id, input.projectAssignmentId),
        eq(deliveryProjectAssignments.engineerUserId, input.actor.id),
        eq(users.role, "user"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const role = rows[0];
  if (
    !role ||
    role.roleType !== input.actor.engineerRoleType ||
    (input.expectedRoleType && role.roleType !== input.expectedRoleType)
  ) {
    throw new AuthServiceError("NOT_FOUND", "当前客户项目岗位不存在");
  }
  if (
    input.customerUserId !== undefined &&
    input.customerUserId !== role.customerUserId
  ) {
    throw new AuthServiceError("NOT_FOUND", "客户未分配给当前工程师");
  }
  const contractRows = await db
    .select()
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, role.customerUserId));
  const currentContract = selectPortalContract(
    contractRows as ServicePortalContractRecord[],
  );
  if (
    !requiredRolesForPlan(currentContract?.planCode).includes(role.roleType)
  ) {
    const activeTicketRows = await db
      .select({ id: deliveryTickets.id })
      .from(deliveryTickets)
      .where(
        and(
          eq(
            deliveryTickets.assignedProjectAssignmentId,
            role.projectAssignmentId,
          ),
          inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
        ),
      )
      .limit(1);
    if (!activeTicketRows[0]) {
      throw new AuthServiceError("NOT_FOUND", "当前套餐未启用该工程师岗位");
    }
  }
  return {
    ...role,
    customerName:
      role.customerName ||
      role.customerUsername ||
      `客户 ${role.customerUserId}`,
  };
}

export async function getMyDeliveryWorkbench(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
}) {
  const role = await assertDeliveryProjectContext(input);
  const db = await requireDb();
  const tickets = await db
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.workflowDomain, role.roleType),
        eq(
          deliveryTickets.assignedProjectAssignmentId,
          role.projectAssignmentId,
        ),
      ),
    )
    .orderBy(desc(deliveryTickets.updatedAt));
  const customerIds = [role.customerUserId];
  const [
    customers,
    builds,
    snapshots,
    questions,
    batches,
    profiles,
    checks,
    dashboards,
  ] = await Promise.all([
    customerIds.length
      ? db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
          })
          .from(users)
          .where(inArray(users.id, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: knowledgeBaseBuilds.userId,
            status: knowledgeBaseBuilds.status,
            updatedAt: knowledgeBaseBuilds.updatedAt,
          })
          .from(knowledgeBaseBuilds)
          .where(inArray(knowledgeBaseBuilds.userId, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: knowledgeBaseSnapshots.userId,
            status: knowledgeBaseSnapshots.status,
          })
          .from(knowledgeBaseSnapshots)
          .where(inArray(knowledgeBaseSnapshots.userId, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: workspaceQuestions.userId,
            status: workspaceQuestions.status,
          })
          .from(workspaceQuestions)
          .where(inArray(workspaceQuestions.userId, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: monitoringBatches.userId,
            sampleCount: monitoringBatches.sampleCount,
            citationCount: monitoringBatches.citationCount,
          })
          .from(monitoringBatches)
          .where(inArray(monitoringBatches.userId, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: workspaceSiteProfiles.userId,
            domain: workspaceSiteProfiles.domain,
            domainStatus: workspaceSiteProfiles.domainStatus,
            icpStatus: workspaceSiteProfiles.icpStatus,
          })
          .from(workspaceSiteProfiles)
          .where(inArray(workspaceSiteProfiles.userId, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: workspaceSiteChecks.userId,
            status: workspaceSiteChecks.status,
          })
          .from(workspaceSiteChecks)
          .where(inArray(workspaceSiteChecks.userId, customerIds))
      : [],
    customerIds.length
      ? db
          .select({
            userId: userDashboardContents.userId,
            revision: userDashboardContents.revision,
          })
          .from(userDashboardContents)
          .where(inArray(userDashboardContents.userId, customerIds))
      : [],
  ]);
  const counts = {
    submitted: 0,
    in_progress: 0,
    needs_information: 0,
    completed: 0,
  };
  for (const ticket of tickets) {
    if (ticket.status in counts) {
      counts[ticket.status as keyof typeof counts] += 1;
    }
  }
  const customersWithDetails = customers.map((customer) => {
    let details: string[];
    if (role.roleType === "ai_operations_engineer") {
      const customerBuilds = builds.filter((row) => row.userId === customer.id);
      const latestBuild = [...customerBuilds].sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )[0];
      const profile = profiles.find((row) => row.userId === customer.id);
      const customerChecks = checks.filter((row) => row.userId === customer.id);
      details = [
        `构建 ${customerBuilds.length}`,
        `展示版本 ${snapshots.filter((row) => row.userId === customer.id).length}`,
        `最新状态 ${latestBuild?.status ?? "未构建"}`,
        `域名 ${profile?.domain || "未配置"}`,
        `备案 ${profile?.icpStatus || "未提交"}`,
        `检查通过 ${
          customerChecks.filter((row) => row.status === "passed").length
        }/${customerChecks.length}`,
      ];
    } else if (role.roleType === "monitoring_optimization_engineer") {
      const customerBatches = batches.filter(
        (row) => row.userId === customer.id,
      );
      details = [
        `已选问题 ${
          questions.filter(
            (row) => row.userId === customer.id && row.status === "selected",
          ).length
        }`,
        `监控答案 ${customerBatches.reduce(
          (sum, row) => sum + row.sampleCount,
          0,
        )}`,
        `引用 ${customerBatches.reduce(
          (sum, row) => sum + row.citationCount,
          0,
        )}`,
      ];
    } else if (role.roleType === "content_distribution_engineer") {
      const customerTickets = tickets.filter(
        (row) => row.userId === customer.id,
      );
      details = [
        `内容工单 ${customerTickets.length}`,
        `已完成 ${
          customerTickets.filter((row) => row.status === "completed").length
        }`,
        `待处理 ${
          customerTickets.filter((row) =>
            ACTIVE_DELIVERY_STATUSES.includes(row.status as any),
          ).length
        }`,
      ];
    } else details = [];
    return { ...customer, details };
  });
  const dashboardRevisionByUser = new Map(
    dashboards.map((dashboard) => [dashboard.userId, dashboard.revision]),
  );
  return {
    assignment: role,
    customers: customersWithDetails,
    tickets: tickets.map((ticket) => ({
      ...ticket,
      dashboardRevision: dashboardRevisionByUser.get(ticket.userId) ?? 0,
    })),
    counts,
  };
}

const MEMBER_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  submitted: ["in_progress", "needs_information", "rejected", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["needs_information", "completed", "rejected", "cancelled"],
  needs_information: ["in_progress", "cancelled"],
};

async function createMonitoringRetestTicket(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
}) {
  if (!input.sourceTicket.sourceQuestionId) return null;
  const owner = await getActiveDeliveryProjectOwner(
    input.executor,
    input.sourceTicket.userId,
    "monitoring_optimization_engineer",
  );
  if (!owner) return null;
  const existingRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.operation, "monitoring_retest"),
        eq(
          deliveryTickets.sourceQuestionId,
          input.sourceTicket.sourceQuestionId,
        ),
        inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
      ),
    )
    .limit(1);
  if (existingRows[0]) return existingRows[0].id;
  const periods = await input.executor
    .select({
      id: serviceQuotaPeriods.id,
      contractId: serviceQuotaPeriods.contractId,
    })
    .from(serviceQuotaPeriods)
    .where(eq(serviceQuotaPeriods.userId, input.sourceTicket.userId))
    .orderBy(desc(serviceQuotaPeriods.endsAt))
    .limit(1);
  const period = periods[0];
  if (!period) return null;
  const id = randomUUID();
  await input.executor.insert(deliveryTickets).values({
    id,
    userId: input.sourceTicket.userId,
    contractId: period.contractId,
    quotaPeriodId: period.id,
    type: "website_operation",
    quotaPool: null,
    ordinal: 0,
    clientRequestId: randomUUID(),
    category: "monitoring_retest",
    title: "发布效果复测",
    description: "内容或官网页面已发布，请按原问题完成效果复测。",
    workflowDomain: "monitoring_optimization_engineer",
    operation: "monitoring_retest",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.engineerUserId,
    sourceQuestionId: input.sourceTicket.sourceQuestionId,
    monitoringBatchKey: input.sourceTicket.monitoringBatchKey,
    responseLogicRevision: input.sourceTicket.responseLogicRevision,
    contentAssetIds: input.sourceTicket.contentAssetIds,
    quotaState: "consumed",
    status: "submitted",
    createdByUserId: input.actorUserId,
    updatedByUserId: input.actorUserId,
  });
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: id,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: "system",
    kind: "created",
    visibility: "customer",
    message: "发布结果已登记，系统自动创建对应问题的效果复测工单。",
    toStatus: "submitted",
    createdAt: new Date(),
  });
  return id;
}

type DeliveryTicketHandoff = {
  monitoringBatchKey?: string;
  optimizationQuestionIds?: string[];
  responseLogicRevision?: number;
  contentAssetIds?: string[];
  publishTargets?: Array<"media" | "website">;
  websiteOperation?:
    | "company_facts"
    | "product_case_docs"
    | "industry_news"
    | "company_news"
    | "faq_content";
  needsFurtherOptimization?: boolean;
  domain?: string;
  icpProvince?: string;
  icpNumber?: string;
  icpNotRequired?: boolean;
  siteCheck?: {
    key: string;
    label: string;
    status: "passed" | "warning" | "failed" | "not_applicable";
    summary?: string;
    evidence?: string;
    source?: string;
  };
};

async function createAssignedWorkflowTicket(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
  actorRoleContext: {
    projectAssignmentId: string;
    customerUserId: number;
    roleType: DeliveryRoleType;
  };
  workflowDomain: DeliveryRoleType;
  operation:
    | "response_logic"
    | "content_asset_publish"
    | "channel_distribution"
    | "company_facts"
    | "product_case_docs"
    | "industry_news"
    | "company_news"
    | "faq_content"
    | "stage_report"
    | "site_check";
  title: string;
  description: string;
  sourceQuestionId?: string | null;
  monitoringBatchKey?: string | null;
  responseLogicRevision?: number | null;
  contentAssetIds?: string[];
}) {
  const owner = await getActiveDeliveryProjectOwner(
    input.executor,
    input.sourceTicket.userId,
    input.workflowDomain,
  );
  if (!owner) {
    throw new AuthServiceError(
      "CONFLICT",
      `${DELIVERY_ROLE_LABELS[input.workflowDomain]}尚未配置主负责人，不能创建下游工单`,
    );
  }
  const sourceQuestionId =
    input.sourceQuestionId?.trim() ||
    input.sourceTicket.sourceQuestionId ||
    null;
  const existingRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.operation, input.operation),
        sourceQuestionId
          ? eq(deliveryTickets.sourceQuestionId, sourceQuestionId)
          : isNull(deliveryTickets.sourceQuestionId),
        inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
      ),
    )
    .limit(1);
  if (existingRows[0]) return existingRows[0].id;

  const periodRows = await input.executor
    .select({
      id: serviceQuotaPeriods.id,
      contractId: serviceQuotaPeriods.contractId,
    })
    .from(serviceQuotaPeriods)
    .where(eq(serviceQuotaPeriods.userId, input.sourceTicket.userId))
    .orderBy(desc(serviceQuotaPeriods.endsAt))
    .limit(1);
  const period = periodRows[0];
  if (!period) {
    throw new AuthServiceError(
      "CONFLICT",
      "客户服务周期尚未配置，不能创建下游工单",
    );
  }

  const id = randomUUID();
  const now = new Date();
  await input.executor.insert(deliveryTickets).values({
    id,
    userId: input.sourceTicket.userId,
    contractId: period.contractId,
    quotaPeriodId: period.id,
    type:
      input.workflowDomain === "content_distribution_engineer"
        ? "content_asset"
        : "website_operation",
    quotaPool: null,
    ordinal: 0,
    clientRequestId: randomUUID(),
    category: input.operation,
    title: input.title,
    description: input.description,
    workflowDomain: input.workflowDomain,
    operation: input.operation,
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.engineerUserId,
    sourceQuestionId,
    monitoringBatchKey:
      input.monitoringBatchKey ?? input.sourceTicket.monitoringBatchKey ?? null,
    responseLogicRevision:
      input.responseLogicRevision ??
      input.sourceTicket.responseLogicRevision ??
      null,
    contentAssetIds:
      input.contentAssetIds ?? input.sourceTicket.contentAssetIds ?? [],
    quotaState: "consumed",
    status: "submitted",
    createdByUserId: input.actorUserId,
    updatedByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  });
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: id,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: "delivery_member",
    kind: "created",
    visibility: "customer",
    message: input.description,
    toStatus: "submitted",
    actorContext: {
      projectAssignmentId: input.actorRoleContext.projectAssignmentId,
      customerUserId: input.actorRoleContext.customerUserId,
      roleType: input.actorRoleContext.roleType,
      sourceTicketId: input.sourceTicket.id,
      assignedProjectAssignmentId: owner.projectAssignmentId,
      assignedMemberId: owner.engineerUserId,
    },
    createdAt: now,
  });
  return id;
}

export async function updateMyDeliveryTicket(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  ticketId: string;
  expectedRevision: number;
  status:
    | "in_progress"
    | "needs_information"
    | "completed"
    | "rejected"
    | "cancelled";
  message?: string;
  publicUrl?: string;
  handoff?: DeliveryTicketHandoff;
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, input.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (
      !ticket ||
      !ticket.workflowDomain ||
      ticket.assignedMemberId !== input.actor.id
    ) {
      throw new AuthServiceError("NOT_FOUND", "工单不属于当前交付成员");
    }
    const role = await assertDeliveryProjectContext({
      actor: input.actor,
      projectAssignmentId: input.projectAssignmentId,
      customerUserId: ticket.userId,
      expectedRoleType: ticket.workflowDomain,
      executor: tx,
    });
    if (ticket.assignedProjectAssignmentId !== role.projectAssignmentId) {
      throw new AuthServiceError("NOT_FOUND", "工单不属于当前客户项目岗位");
    }
    const operation = deliveryWorkflowOperationSchema.safeParse(
      ticket.operation,
    );
    if (
      !operation.success ||
      !deliveryRoleOwnsOperation(role.roleType, operation.data)
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "旧版技术工单仅供只读查看，不能执行交付操作",
      );
    }
    if (ticket.revision !== input.expectedRevision) {
      throw new AuthServiceError("CONFLICT", "工单已被更新，请刷新后重试");
    }
    if (ticket.operation === "knowledge_reset") {
      throw new AuthServiceError("CONFLICT", "知识库重置必须使用专用审批操作");
    }
    if (
      !(MEMBER_TICKET_TRANSITIONS[ticket.status] ?? []).includes(input.status)
    ) {
      throw new AuthServiceError("CONFLICT", "当前工单状态不能执行该操作");
    }
    const linkRequired =
      input.status === "completed" &&
      (ticket.operation === "content_asset_publish" ||
        ticket.operation === "channel_distribution" ||
        [
          "company_facts",
          "product_case_docs",
          "industry_news",
          "company_news",
          "faq_content",
        ].includes(ticket.operation || ""));
    if (linkRequired && !input.publicUrl) {
      throw new AuthServiceError("CONFLICT", "发布完成时必须登记公开链接");
    }
    const now = new Date();
    const deliveryLinks = input.publicUrl
      ? [{ label: "公开链接", url: input.publicUrl }]
      : ticket.deliveryLinks;
    const monitoringBatchKey =
      input.handoff?.monitoringBatchKey?.trim() ||
      ticket.monitoringBatchKey ||
      null;
    const responseLogicRevision =
      input.handoff?.responseLogicRevision ??
      ticket.responseLogicRevision ??
      null;
    const contentAssetIds = Array.from(
      new Set(
        (input.handoff?.contentAssetIds ?? ticket.contentAssetIds ?? [])
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    );
    const websiteContentOperations = [
      "company_facts",
      "product_case_docs",
      "industry_news",
      "company_news",
      "faq_content",
    ];
    if (
      input.status === "completed" &&
      ticket.workflowDomain === "ai_operations_engineer" &&
      websiteContentOperations.includes(ticket.operation || "")
    ) {
      if (!contentAssetIds.length) {
        throw new AuthServiceError(
          "CONFLICT",
          "官网内容发布前必须绑定已发布的内容资产",
        );
      }
      const publishedRows = await tx
        .select({ contentAssetIds: deliveryTickets.contentAssetIds })
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, ticket.userId),
            eq(deliveryTickets.workflowDomain, "content_distribution_engineer"),
            eq(deliveryTickets.operation, "content_asset_publish"),
            eq(deliveryTickets.status, "completed"),
          ),
        );
      const publishedAssetIds = new Set(
        publishedRows.flatMap((row) => row.contentAssetIds ?? []),
      );
      const unverifiedIds = contentAssetIds.filter(
        (id) => !publishedAssetIds.has(id),
      );
      if (unverifiedIds.length) {
        throw new AuthServiceError(
          "CONFLICT",
          `以下内容资产尚未由内容分发工程师发布：${unverifiedIds.join("、")}`,
        );
      }
    }
    if (
      input.status === "completed" &&
      ticket.operation === "knowledge_maintenance"
    ) {
      const replacementRows = await tx
        .select({ id: knowledgeBaseSnapshots.id })
        .from(knowledgeBaseSnapshots)
        .where(
          and(
            eq(knowledgeBaseSnapshots.userId, ticket.userId),
            eq(knowledgeBaseSnapshots.status, "active"),
            eq(knowledgeBaseSnapshots.maintenanceTicketId, ticket.id),
          ),
        )
        .limit(1);
      if (!replacementRows[0]) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成维护工单前必须先上传并发布通过校验的新知识库版本",
        );
      }
    }
    if (
      input.status === "completed" &&
      ticket.operation === "domain_application"
    ) {
      const domainInput = input.handoff?.domain?.trim() || "";
      let domain: string;
      try {
        domain = new URL(
          /^https?:\/\//i.test(domainInput)
            ? domainInput
            : `https://${domainInput}`,
        ).hostname.toLowerCase();
      } catch {
        throw new AuthServiceError(
          "CONFLICT",
          "完成域名申请前必须填写有效域名",
        );
      }
      if (!domain) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成域名申请前必须填写有效域名",
        );
      }
      const profileRows = await tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, ticket.userId))
        .limit(1)
        .for("update");
      const profile = profileRows[0];
      if (profile) {
        await tx
          .update(workspaceSiteProfiles)
          .set({
            domain,
            domainStatus: "completed",
            domainVerifiedAt: profile.domainVerifiedAt ?? now,
            revision: profile.revision + 1,
            updatedByUserId: input.actor.id,
            updatedAt: now,
          })
          .where(eq(workspaceSiteProfiles.userId, ticket.userId));
      } else {
        await tx.insert(workspaceSiteProfiles).values({
          userId: ticket.userId,
          domain,
          siteMode: "unknown",
          domainStatus: "completed",
          domainVerifiedAt: now,
          icpStatus: "not_submitted",
          revision: 1,
          updatedByUserId: input.actor.id,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (input.status === "completed" && ticket.operation === "icp_filing") {
      const profileRows = await tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, ticket.userId))
        .limit(1)
        .for("update");
      const profile = profileRows[0];
      if (!profile || profile.domainStatus !== "completed") {
        throw new AuthServiceError(
          "CONFLICT",
          "必须先完成域名核验，才能完成 ICP 备案工单",
        );
      }
      const notRequired = input.handoff?.icpNotRequired === true;
      const icpNumber = input.handoff?.icpNumber?.trim() || null;
      if (!notRequired && !icpNumber) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成 ICP 备案时必须填写备案号，或明确选择无需备案",
        );
      }
      await tx
        .update(workspaceSiteProfiles)
        .set({
          icpProvince:
            input.handoff?.icpProvince?.trim() || profile.icpProvince || null,
          icpNumber: notRequired ? null : icpNumber,
          icpStatus: notRequired ? "not_required" : "approved",
          icpVerifiedAt: now,
          revision: profile.revision + 1,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(workspaceSiteProfiles.userId, ticket.userId));
    }
    if (input.status === "completed" && ticket.operation === "site_check") {
      const check = input.handoff?.siteCheck;
      if (!check) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成站点检查前必须登记检查结果",
        );
      }
      const checkRows = await tx
        .select()
        .from(workspaceSiteChecks)
        .where(
          and(
            eq(workspaceSiteChecks.userId, ticket.userId),
            eq(workspaceSiteChecks.key, check.key),
          ),
        )
        .limit(1)
        .for("update");
      const current = checkRows[0];
      const values = {
        label: check.label,
        status: check.status,
        summary: check.summary?.trim() || null,
        evidence: check.evidence?.trim() || null,
        source: check.source?.trim() || null,
        checkedAt: now,
        revision: (current?.revision ?? 0) + 1,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      };
      if (current) {
        await tx
          .update(workspaceSiteChecks)
          .set(values)
          .where(eq(workspaceSiteChecks.id, current.id));
      } else {
        await tx.insert(workspaceSiteChecks).values({
          id: randomUUID(),
          userId: ticket.userId,
          key: check.key,
          ...values,
          createdAt: now,
        });
      }
    }
    await tx
      .update(deliveryTickets)
      .set({
        status: input.status,
        publicSummary: input.message?.trim() || ticket.publicSummary,
        deliveryLinks,
        monitoringBatchKey,
        responseLogicRevision,
        contentAssetIds,
        resolvedAt: ["completed", "rejected", "cancelled"].includes(
          input.status,
        )
          ? now
          : null,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: input.actor.id,
      actorRole: "delivery_member",
      kind: "status_change",
      visibility: "customer",
      message: input.message?.trim() || null,
      fromStatus: ticket.status,
      toStatus: input.status,
      actorContext: {
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: role.customerUserId,
        roleType: role.roleType,
      },
      createdAt: now,
    });
    const sourceTicket = {
      ...ticket,
      monitoringBatchKey,
      responseLogicRevision,
      contentAssetIds,
    };
    const actorRoleContext = {
      projectAssignmentId: input.projectAssignmentId,
      customerUserId: role.customerUserId,
      roleType: role.roleType,
    };
    const handoffTicketIds: string[] = [];
    if (input.status === "completed") {
      if (
        ticket.operation === "initial_monitoring" ||
        ticket.operation === "monitoring_import"
      ) {
        const questionIds = Array.from(
          new Set(
            (input.handoff?.optimizationQuestionIds ?? [])
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        );
        for (const questionId of questionIds) {
          handoffTicketIds.push(
            await createAssignedWorkflowTicket({
              executor: tx,
              sourceTicket,
              actorUserId: input.actor.id,
              actorRoleContext,
              workflowDomain: "content_distribution_engineer",
              operation: "response_logic",
              title: `制作问题 ${questionId} 的应答逻辑`,
              description:
                "首次监控已确认该问题需要优化，请基于已发布监控批次制作应答逻辑。",
              sourceQuestionId: questionId,
              monitoringBatchKey,
              responseLogicRevision: 1,
            }),
          );
        }
      } else if (ticket.operation === "response_logic") {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "content_distribution_engineer",
            operation: "content_asset_publish",
            title: "制作并发布 AI 友好内容资产",
            description: "应答逻辑已经确认，请据此生成、校验并发布内容资产。",
            responseLogicRevision:
              responseLogicRevision ?? (ticket.responseLogicRevision ?? 0) + 1,
          }),
        );
      } else if (ticket.operation === "content_asset_publish") {
        const targets: Array<"media" | "website"> = input.handoff
          ?.publishTargets?.length
          ? Array.from(new Set(input.handoff.publishTargets))
          : ["media"];
        if (targets.includes("media")) {
          handoffTicketIds.push(
            await createAssignedWorkflowTicket({
              executor: tx,
              sourceTicket,
              actorUserId: input.actor.id,
              actorRoleContext,
              workflowDomain: "content_distribution_engineer",
              operation: "channel_distribution",
              title: "登记媒体渠道分发结果",
              description: "内容资产已发布，请完成媒体渠道分发并登记公开链接。",
              contentAssetIds,
            }),
          );
        }
        if (targets.includes("website")) {
          if (!contentAssetIds.length) {
            throw new AuthServiceError(
              "CONFLICT",
              "创建官网发布工单前必须绑定已确认的内容资产 ID",
            );
          }
          if (!input.handoff?.websiteOperation) {
            throw new AuthServiceError("CONFLICT", "请选择官网内容工单类型");
          }
          handoffTicketIds.push(
            await createAssignedWorkflowTicket({
              executor: tx,
              sourceTicket,
              actorUserId: input.actor.id,
              actorRoleContext,
              workflowDomain: "ai_operations_engineer",
              operation: input.handoff.websiteOperation,
              title: "将已确认内容发布到客户官网",
              description:
                "内容资产已经确认，请按绑定资产发布官网页面并登记公开链接。",
              contentAssetIds,
            }),
          );
        }
      } else if (ticket.operation === "monitoring_retest") {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "monitoring_optimization_engineer",
            operation: "stage_report",
            title: "发布阶段效果报告",
            description: "效果复测已经完成，请汇总优化前后结果并发布阶段报告。",
          }),
        );
      } else if (
        ticket.operation === "stage_report" &&
        input.handoff?.needsFurtherOptimization
      ) {
        if (!sourceTicket.sourceQuestionId) {
          throw new AuthServiceError(
            "CONFLICT",
            "继续优化前必须绑定来源问题 ID",
          );
        }
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "content_distribution_engineer",
            operation: "response_logic",
            title: `继续优化问题 ${sourceTicket.sourceQuestionId}`,
            description:
              "阶段复测仍未达到目标，请基于最新监控结论修订应答逻辑和内容。",
            responseLogicRevision: (responseLogicRevision ?? 0) + 1,
          }),
        );
      } else if (
        ticket.workflowDomain === "ai_operations_engineer" &&
        websiteContentOperations.includes(ticket.operation || "")
      ) {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "ai_operations_engineer",
            operation: "site_check",
            title: "检查已发布官网页面",
            description:
              "官网内容已经发布，请检查目标页面可访问性、内容呈现与基础站点状态。",
            contentAssetIds,
          }),
        );
      }
    }
    let retestTicketId: string | null = null;
    if (
      input.status === "completed" &&
      input.publicUrl &&
      ticket.workflowDomain !== "monitoring_optimization_engineer"
    ) {
      retestTicketId = await createMonitoringRetestTicket({
        executor: tx,
        sourceTicket,
        actorUserId: input.actor.id,
      });
    }
    return {
      success: true as const,
      revision: ticket.revision + 1,
      retestTicketId,
      handoffTicketIds,
    };
  });
}

export async function createKnowledgeMonitoringHandoff(input: {
  userId: number;
  actorUserId: number;
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const owner = await getActiveDeliveryProjectOwner(
      tx,
      input.userId,
      "monitoring_optimization_engineer",
    );
    if (!owner) return { created: [] as string[], assigned: false as const };
    const periodRows = await tx
      .select({
        id: serviceQuotaPeriods.id,
        contractId: serviceQuotaPeriods.contractId,
      })
      .from(serviceQuotaPeriods)
      .where(eq(serviceQuotaPeriods.userId, input.userId))
      .orderBy(desc(serviceQuotaPeriods.endsAt))
      .limit(1);
    const period = periodRows[0];
    if (!period) return { created: [] as string[], assigned: false as const };
    const operations = ["question_catalog", "initial_monitoring"] as const;
    const existing = await tx
      .select({ operation: deliveryTickets.operation })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.userId),
          inArray(deliveryTickets.operation, [...operations]),
        ),
      );
    const existingOperations = new Set(existing.map((row) => row.operation));
    const created: string[] = [];
    for (const operation of operations) {
      if (existingOperations.has(operation)) continue;
      const id = randomUUID();
      created.push(id);
      await tx.insert(deliveryTickets).values({
        id,
        userId: input.userId,
        contractId: period.contractId,
        quotaPeriodId: period.id,
        type: "website_operation",
        quotaPool: null,
        ordinal: 0,
        clientRequestId: randomUUID(),
        category: operation,
        title:
          operation === "question_catalog"
            ? "配置品牌问题目录"
            : "执行首次问题监控",
        workflowDomain: "monitoring_optimization_engineer",
        operation,
        assignedProjectAssignmentId: owner.projectAssignmentId,
        assignedMemberId: owner.engineerUserId,
        quotaState: "consumed",
        status: "submitted",
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
      });
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: id,
        userId: input.userId,
        actorUserId: input.actorUserId,
        actorRole: "system",
        kind: "created",
        visibility: "customer",
        message:
          operation === "question_catalog"
            ? "知识库已发布，问题目录配置工单已解锁。"
            : "知识库已发布，首次问题监控工单已解锁。",
        toStatus: "submitted",
        createdAt: new Date(),
      });
    }
    return { created, assigned: true as const };
  });
}

export async function setDeliveryMemberCredential(input: {
  actor: AuthenticatedUser;
  memberUserId: number;
  apiKey: string;
}) {
  requireDeliveryManager(input.actor);
  if (input.actor.adminAccessLevel !== "system_admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以维护工程师 API Key",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.memberUserId))
    .limit(1);
  if (rows[0]?.role !== "delivery_member") {
    throw new AuthServiceError("NOT_FOUND", "工程师不存在");
  }
  const previous = await getApiCredentialStatus(input.memberUserId);
  const credential = await replaceApiCredential(
    input.memberUserId,
    input.apiKey,
  );
  await writeWorkspaceAuditEvent({
    actor: input.actor,
    action: "delivery.engineer_credential.replaced",
    targetType: "user",
    targetId: input.memberUserId,
    workspaceUserId: null,
    metadata: {
      previouslyConfigured: previous.configured,
      configured: credential.configured,
    },
  });
  return credential;
}

export async function revokeDeliveryMemberCredential(input: {
  actor: AuthenticatedUser;
  memberUserId: number;
}) {
  requireDeliveryManager(input.actor);
  if (input.actor.adminAccessLevel !== "system_admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以维护工程师 API Key",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.memberUserId))
    .limit(1);
  if (rows[0]?.role !== "delivery_member") {
    throw new AuthServiceError("NOT_FOUND", "工程师不存在");
  }
  const previous = await getApiCredentialStatus(input.memberUserId);
  await deleteActiveApiCredential(input.memberUserId);
  await writeWorkspaceAuditEvent({
    actor: input.actor,
    action: "delivery.engineer_credential.revoked",
    targetType: "user",
    targetId: input.memberUserId,
    workspaceUserId: null,
    metadata: {
      previouslyConfigured: previous.configured,
      configured: false,
    },
  });
  return { success: true as const };
}

export async function getMyDeliveryCredentialStatus(actor: AuthenticatedUser) {
  if (actor.role !== "delivery_member") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "需要交付成员权限");
  }
  return getApiCredentialStatus(actor.id);
}
