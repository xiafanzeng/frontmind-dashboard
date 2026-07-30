import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  deliveryCustomerAssignments,
  deliveryRoleMembers,
  deliveryRoles,
  deliveryTicketEvents,
  deliveryTickets,
  knowledgeBaseResetRequests,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  monitoringBatches,
  serviceContracts,
  serviceQuotaPeriods,
  userDashboardContents,
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
  type AuthenticatedUser,
} from "./auth-service";
import { getDb } from "./db";

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

async function assertFixedRole(
  executor: any,
  roleId: string,
  expectedType?: DeliveryRoleType,
) {
  const rows = await executor
    .select()
    .from(deliveryRoles)
    .where(and(eq(deliveryRoles.id, roleId), eq(deliveryRoles.isActive, true)))
    .limit(1);
  const role = rows[0];
  if (!role || (expectedType && role.roleType !== expectedType)) {
    throw new AuthServiceError("NOT_FOUND", "交付团队不存在或类型不匹配");
  }
  return role;
}

async function assertActiveRoleMembership(input: {
  executor: any;
  roleId: string;
  memberUserId: number;
}) {
  const rows = await input.executor
    .select({ id: deliveryRoleMembers.id })
    .from(deliveryRoleMembers)
    .innerJoin(users, eq(users.id, deliveryRoleMembers.memberUserId))
    .where(
      and(
        eq(deliveryRoleMembers.roleId, input.roleId),
        eq(deliveryRoleMembers.memberUserId, input.memberUserId),
        eq(deliveryRoleMembers.isActive, true),
        eq(users.role, "delivery_member"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new AuthServiceError("CONFLICT", "负责人尚未加入该交付团队");
  }
}

async function getActiveDeliveryCustomerOwner(
  executor: any,
  customerUserId: number,
  roleType: DeliveryRoleType,
) {
  const rows = await executor
    .select({
      roleId: deliveryCustomerAssignments.roleId,
      primaryMemberId: deliveryCustomerAssignments.primaryMemberId,
    })
    .from(deliveryCustomerAssignments)
    .innerJoin(
      deliveryRoles,
      eq(deliveryCustomerAssignments.roleId, deliveryRoles.id),
    )
    .innerJoin(
      deliveryRoleMembers,
      and(
        eq(deliveryRoleMembers.roleId, deliveryCustomerAssignments.roleId),
        eq(
          deliveryRoleMembers.memberUserId,
          deliveryCustomerAssignments.primaryMemberId,
        ),
      ),
    )
    .innerJoin(users, eq(users.id, deliveryCustomerAssignments.primaryMemberId))
    .where(
      and(
        eq(deliveryCustomerAssignments.customerUserId, customerUserId),
        eq(deliveryCustomerAssignments.roleType, roleType),
        eq(deliveryRoles.roleType, roleType),
        eq(deliveryRoles.isActive, true),
        eq(deliveryRoleMembers.isActive, true),
        eq(users.role, "delivery_member"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listDeliveryRoleManagement(actor: AuthenticatedUser) {
  requireDeliveryManager(actor);
  const db = await requireDb();
  const [
    roles,
    memberships,
    assignments,
    members,
    customers,
    tickets,
    contracts,
    statisticsTickets,
  ] = await Promise.all([
    db
      .select()
      .from(deliveryRoles)
      .orderBy(deliveryRoles.roleType, deliveryRoles.name),
    db.select().from(deliveryRoleMembers),
    db.select().from(deliveryCustomerAssignments),
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "delivery_member"))
      .orderBy(desc(users.createdAt)),
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
    db
      .select()
      .from(deliveryTickets)
      .where(inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES))
      .orderBy(desc(deliveryTickets.updatedAt)),
    db
      .select({
        id: serviceContracts.id,
        userId: serviceContracts.userId,
        planCode: serviceContracts.planCode,
        status: serviceContracts.status,
        endsAt: serviceContracts.endsAt,
      })
      .from(serviceContracts)
      .where(
        inArray(serviceContracts.status, [
          "pending_confirmation",
          "scheduled",
          "active",
          "suspended",
        ]),
      )
      .orderBy(desc(serviceContracts.endsAt)),
    db
      .select({
        workflowDomain: deliveryTickets.workflowDomain,
        status: deliveryTickets.status,
        assignedMemberId: deliveryTickets.assignedMemberId,
        updatedAt: deliveryTickets.updatedAt,
      })
      .from(deliveryTickets),
  ]);
  const roleStats = Object.fromEntries(
    (
      [
        "knowledge_base_engineer",
        "monitoring_optimization_engineer",
        "content_distribution_engineer",
        "website_operations_engineer",
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
  const ticketEvents = tickets.length
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
            tickets.map((ticket) => ticket.id),
          ),
        )
        .orderBy(desc(deliveryTicketEvents.createdAt))
    : [];
  return {
    roles,
    memberships,
    assignments,
    members,
    customers,
    tickets,
    ticketEvents,
    contracts,
    roleStats,
  };
}

const ACTIVE_DELIVERY_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

export async function createDeliveryRole(input: {
  actor: AuthenticatedUser;
  name: string;
  roleType: DeliveryRoleType;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  const row = {
    id: randomUUID(),
    name: input.name.trim(),
    roleType: input.roleType,
    isActive: true,
    createdByUserId: input.actor.id,
  };
  try {
    await db.insert(deliveryRoles).values(row);
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "该角色类型下已存在同名团队");
    }
    throw error;
  }
  return row;
}

export async function createDeliveryMember(input: {
  actor: AuthenticatedUser;
  username: string;
  password: string;
  displayName?: string;
}) {
  requireDeliveryManager(input.actor);
  return createManagedUser({
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    role: "delivery_member",
  });
}

export async function setDeliveryRoleMember(input: {
  actor: AuthenticatedUser;
  roleId: string;
  memberUserId: number;
  active: boolean;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  await assertFixedRole(db, input.roleId);
  const memberRows = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, input.memberUserId))
    .limit(1);
  if (memberRows[0]?.role !== "delivery_member" || !memberRows[0]?.isActive) {
    throw new AuthServiceError("NOT_FOUND", "交付成员账号不存在或已停用");
  }
  await db
    .insert(deliveryRoleMembers)
    .values({
      id: randomUUID(),
      roleId: input.roleId,
      memberUserId: input.memberUserId,
      isActive: input.active,
      assignedByUserId: input.actor.id,
    })
    .onDuplicateKeyUpdate({
      set: {
        isActive: input.active,
        assignedByUserId: input.actor.id,
        updatedAt: new Date(),
      },
    });
  return { success: true as const };
}

export async function assignDeliveryCustomer(input: {
  actor: AuthenticatedUser;
  customerUserId: number;
  roleType: DeliveryRoleType;
  roleId: string;
  primaryMemberId: number;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  const role = await assertFixedRole(db, input.roleId, input.roleType);
  await assertActiveRoleMembership({
    executor: db,
    roleId: input.roleId,
    memberUserId: input.primaryMemberId,
  });
  const customerRows = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, input.customerUserId))
    .limit(1);
  if (customerRows[0]?.role !== "user" || !customerRows[0]?.isActive) {
    throw new AuthServiceError("NOT_FOUND", "客户账号不存在或已停用");
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(deliveryCustomerAssignments)
      .values({
        id: randomUUID(),
        customerUserId: input.customerUserId,
        roleType: input.roleType,
        roleId: role.id,
        primaryMemberId: input.primaryMemberId,
        assignedByUserId: input.actor.id,
      })
      .onDuplicateKeyUpdate({
        set: {
          roleId: role.id,
          primaryMemberId: input.primaryMemberId,
          assignedByUserId: input.actor.id,
          revision: sql`${deliveryCustomerAssignments.revision} + 1`,
          updatedAt: new Date(),
        },
      });
    await tx
      .update(deliveryTickets)
      .set({
        assignedRoleId: role.id,
        assignedMemberId: input.primaryMemberId,
        updatedByUserId: input.actor.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deliveryTickets.userId, input.customerUserId),
          eq(deliveryTickets.workflowDomain, input.roleType),
          inArray(deliveryTickets.status, [
            "submitted",
            "needs_information",
            "scheduled",
            "in_progress",
          ]),
        ),
      );
    if (input.roleType === "knowledge_base_engineer") {
      await tx
        .update(knowledgeBaseResetRequests)
        .set({
          assignedRoleId: role.id,
          assignedMemberId: input.primaryMemberId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeBaseResetRequests.userId, input.customerUserId),
            eq(knowledgeBaseResetRequests.status, "pending"),
          ),
        );
    }
  });
  if (input.roleType === "monitoring_optimization_engineer") {
    const snapshotRows = await db
      .select({ id: knowledgeBaseSnapshots.id })
      .from(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, input.customerUserId))
      .limit(1);
    if (snapshotRows[0]) {
      await createKnowledgeMonitoringHandoff({
        userId: input.customerUserId,
        actorUserId: input.actor.id,
      });
    }
  }
  return { success: true as const };
}

export async function dispatchDeliveryTicket(input: {
  actor: AuthenticatedUser;
  ticketId: string;
  roleId: string;
  memberUserId: number;
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
    const role = await assertFixedRole(tx, input.roleId, ticket.workflowDomain);
    await assertActiveRoleMembership({
      executor: tx,
      roleId: role.id,
      memberUserId: input.memberUserId,
    });
    await tx
      .update(deliveryTickets)
      .set({
        assignedRoleId: role.id,
        assignedMemberId: input.memberUserId,
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
      message: `工单调度：团队 ${role.name}，负责人 #${input.memberUserId}，优先级 ${input.priority}。`,
      createdAt: new Date(),
    });
    if (ticket.operation === "knowledge_reset") {
      await tx
        .update(knowledgeBaseResetRequests)
        .set({
          assignedRoleId: role.id,
          assignedMemberId: input.memberUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeBaseResetRequests.ticketId, ticket.id),
            eq(knowledgeBaseResetRequests.status, "pending"),
          ),
        );
    }
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

export async function listMyDeliveryRoles(actor: AuthenticatedUser) {
  if (actor.role !== "delivery_member") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "该工作台仅对交付成员开放",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select({
      assignmentId: deliveryRoleMembers.id,
      roleId: deliveryRoles.id,
      teamName: deliveryRoles.name,
      roleType: deliveryRoles.roleType,
    })
    .from(deliveryRoleMembers)
    .innerJoin(deliveryRoles, eq(deliveryRoleMembers.roleId, deliveryRoles.id))
    .innerJoin(users, eq(users.id, deliveryRoleMembers.memberUserId))
    .where(
      and(
        eq(deliveryRoleMembers.memberUserId, actor.id),
        eq(deliveryRoleMembers.isActive, true),
        eq(deliveryRoles.isActive, true),
        eq(users.role, "delivery_member"),
        eq(users.isActive, true),
      ),
    )
    .orderBy(deliveryRoles.roleType, deliveryRoles.name);
  return rows.map((row) => ({
    ...row,
    label: DELIVERY_ROLE_LABELS[row.roleType],
  }));
}

export async function assertDeliveryRoleContext(input: {
  actor: AuthenticatedUser;
  roleAssignmentId: string;
  customerUserId?: number;
  requirePrimaryCustomerAssignment?: boolean;
  expectedRoleType?: DeliveryRoleType;
  executor?: any;
}) {
  if (input.actor.role !== "delivery_member") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "需要交付成员权限");
  }
  const db = input.executor ?? (await requireDb());
  const rows = await db
    .select({
      assignmentId: deliveryRoleMembers.id,
      roleId: deliveryRoles.id,
      roleType: deliveryRoles.roleType,
      teamName: deliveryRoles.name,
    })
    .from(deliveryRoleMembers)
    .innerJoin(deliveryRoles, eq(deliveryRoleMembers.roleId, deliveryRoles.id))
    .innerJoin(users, eq(users.id, deliveryRoleMembers.memberUserId))
    .where(
      and(
        eq(deliveryRoleMembers.id, input.roleAssignmentId),
        eq(deliveryRoleMembers.memberUserId, input.actor.id),
        eq(deliveryRoleMembers.isActive, true),
        eq(deliveryRoles.isActive, true),
        eq(users.role, "delivery_member"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const role = rows[0];
  if (
    !role ||
    (input.expectedRoleType && role.roleType !== input.expectedRoleType)
  ) {
    throw new AuthServiceError("NOT_FOUND", "当前工作角色不存在");
  }
  if (
    input.customerUserId !== undefined &&
    input.requirePrimaryCustomerAssignment !== false
  ) {
    const assignmentRows = await db
      .select({ id: deliveryCustomerAssignments.id })
      .from(deliveryCustomerAssignments)
      .where(
        and(
          eq(deliveryCustomerAssignments.customerUserId, input.customerUserId),
          eq(deliveryCustomerAssignments.roleType, role.roleType),
          eq(deliveryCustomerAssignments.roleId, role.roleId),
          eq(deliveryCustomerAssignments.primaryMemberId, input.actor.id),
        ),
      )
      .limit(1);
    if (!assignmentRows[0]) {
      throw new AuthServiceError("NOT_FOUND", "客户未分配给当前工作角色");
    }
  }
  return role;
}

export async function getMyDeliveryWorkbench(input: {
  actor: AuthenticatedUser;
  roleAssignmentId: string;
}) {
  const role = await assertDeliveryRoleContext(input);
  const db = await requireDb();
  const assignments = await db
    .select()
    .from(deliveryCustomerAssignments)
    .where(
      and(
        eq(deliveryCustomerAssignments.roleId, role.roleId),
        eq(deliveryCustomerAssignments.primaryMemberId, input.actor.id),
        eq(deliveryCustomerAssignments.roleType, role.roleType),
      ),
    );
  const tickets = await db
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.workflowDomain, role.roleType),
        eq(deliveryTickets.assignedRoleId, role.roleId),
        eq(deliveryTickets.assignedMemberId, input.actor.id),
      ),
    )
    .orderBy(desc(deliveryTickets.updatedAt));
  const customerIds = Array.from(
    new Set([
      ...assignments.map((row) => row.customerUserId),
      ...tickets.map((ticket) => ticket.userId),
    ]),
  );
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
    if (role.roleType === "knowledge_base_engineer") {
      const customerBuilds = builds.filter((row) => row.userId === customer.id);
      const latestBuild = [...customerBuilds].sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )[0];
      details = [
        `构建 ${customerBuilds.length}`,
        `展示版本 ${snapshots.filter((row) => row.userId === customer.id).length}`,
        `最新状态 ${latestBuild?.status ?? "未构建"}`,
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
    } else {
      const profile = profiles.find((row) => row.userId === customer.id);
      const customerChecks = checks.filter((row) => row.userId === customer.id);
      details = [
        `域名 ${profile?.domain || "未配置"}`,
        `备案 ${profile?.icpStatus || "未提交"}`,
        `检查通过 ${
          customerChecks.filter((row) => row.status === "passed").length
        }/${customerChecks.length}`,
      ];
    }
    return { ...customer, details };
  });
  const dashboardRevisionByUser = new Map(
    dashboards.map((dashboard) => [dashboard.userId, dashboard.revision]),
  );
  return {
    role,
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
  const owner = await getActiveDeliveryCustomerOwner(
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
    assignedRoleId: owner.roleId,
    assignedMemberId: owner.primaryMemberId,
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
    assignmentId: string;
    roleId: string;
    roleType: DeliveryRoleType;
    teamName: string;
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
  const owner = await getActiveDeliveryCustomerOwner(
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
    assignedRoleId: owner.roleId,
    assignedMemberId: owner.primaryMemberId,
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
      roleAssignmentId: input.actorRoleContext.assignmentId,
      roleId: input.actorRoleContext.roleId,
      roleType: input.actorRoleContext.roleType,
      teamName: input.actorRoleContext.teamName,
      sourceTicketId: input.sourceTicket.id,
      assignedRoleId: owner.roleId,
      assignedMemberId: owner.primaryMemberId,
    },
    createdAt: now,
  });
  return id;
}

export async function updateMyDeliveryTicket(input: {
  actor: AuthenticatedUser;
  roleAssignmentId: string;
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
    const role = await assertDeliveryRoleContext({
      actor: input.actor,
      roleAssignmentId: input.roleAssignmentId,
      customerUserId: ticket.userId,
      requirePrimaryCustomerAssignment: false,
      expectedRoleType: ticket.workflowDomain,
      executor: tx,
    });
    if (ticket.assignedRoleId !== role.roleId) {
      throw new AuthServiceError("NOT_FOUND", "工单不属于当前工作角色");
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
      ticket.workflowDomain === "website_operations_engineer" &&
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
        roleAssignmentId: input.roleAssignmentId,
        roleId: role.roleId,
        roleType: role.roleType,
        teamName: role.teamName,
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
      assignmentId: input.roleAssignmentId,
      roleId: role.roleId,
      roleType: role.roleType,
      teamName: role.teamName,
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
              workflowDomain: "website_operations_engineer",
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
        ticket.workflowDomain === "website_operations_engineer" &&
        websiteContentOperations.includes(ticket.operation || "")
      ) {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "website_operations_engineer",
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
    const owner = await getActiveDeliveryCustomerOwner(
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
        assignedRoleId: owner.roleId,
        assignedMemberId: owner.primaryMemberId,
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
  const db = await requireDb();
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.memberUserId))
    .limit(1);
  if (rows[0]?.role !== "delivery_member") {
    throw new AuthServiceError("NOT_FOUND", "交付成员不存在");
  }
  return replaceApiCredential(input.memberUserId, input.apiKey);
}

export async function revokeDeliveryMemberCredential(input: {
  actor: AuthenticatedUser;
  memberUserId: number;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.memberUserId))
    .limit(1);
  if (rows[0]?.role !== "delivery_member") {
    throw new AuthServiceError("NOT_FOUND", "交付成员不存在");
  }
  await deleteActiveApiCredential(input.memberUserId);
  return { success: true as const };
}

export async function getMyDeliveryCredentialStatus(actor: AuthenticatedUser) {
  if (actor.role !== "delivery_member") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "需要交付成员权限");
  }
  return getApiCredentialStatus(actor.id);
}
