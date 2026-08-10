import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { DELIVERY_OPERATION_SPECS } from "../shared/delivery-operation-spec";

import {
  assertDeliveryCompletionEvidence,
  assertDeliveryCompletionContract,
  assertDeliveryCompletionSummary,
  assertGenericDeliveryTicketTransition,
  assertWorkflowGraphIntegrity,
  createAssignedWorkflowTicket,
  createMonitoringRetestTicket,
  deliveryExecutionActorRole,
  deriveDeliveryExecutionTransition,
  deliveryTicketActionRank,
  deliveryTicketDependencyState,
  deliveryWorkflowStageKey,
  deliveryHistoryTimestamp,
  deliveryHistoryTicketTitle,
  deliveryTicketStatusGroup,
  deriveWorkflowContainerStatus,
  formalMonitoringBatchOptionsScope,
  getMyDeliveryTickets,
  initialMonitoringExistingTicketAction,
  knowledgeMonitoringHandoffOperations,
  knowledgeMonitoringHandoffReusableTicketStatuses,
  listFormalMonitoringBatchOptions,
  monitoringRetestTechnicalDedupeKey,
  MY_DELIVERY_TICKET_LIMIT,
  resolveAssignedWorkflowBillingScope,
  reusableInitialMonitoringTicketScope,
  visibleInitialMonitoringTicketScope,
  workflowChildAttachmentMetadataRows,
  workflowContainerChildrenScope,
} from "./delivery-role-service";

function queuedQueryResult(
  value: unknown[] | (() => unknown[]),
): Record<string, any> {
  const query: Record<string, any> = {};
  for (const method of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
    "for",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (rows: unknown[]) => unknown, reject: unknown) =>
    Promise.resolve(typeof value === "function" ? value() : value).then(
      resolve,
      reject as never,
    );
  return query;
}

function queuedDeliveryExecutor(
  selectResults: Array<unknown[] | (() => unknown[])>,
) {
  const queue = [...selectResults];
  const insertCalls: Array<{
    table: unknown;
    values: any;
    onDuplicateKeyUpdate?: unknown;
  }> = [];
  const executor = {
    select: vi.fn(() => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected select query");
      return queuedQueryResult(next);
    }),
    insert: vi.fn((table: unknown) => {
      const call: (typeof insertCalls)[number] = { table, values: undefined };
      const builder: Record<string, any> = {};
      builder.values = vi.fn((values: unknown) => {
        call.values = values;
        insertCalls.push(call);
        return builder;
      });
      builder.onDuplicateKeyUpdate = vi.fn((value: unknown) => {
        call.onDuplicateKeyUpdate = value;
        return Promise.resolve();
      });
      builder.then = (resolve: (value?: unknown) => unknown, reject: unknown) =>
        Promise.resolve().then(resolve, reject as never);
      return builder;
    }),
  };
  return { executor, insertCalls, queue };
}

describe("delivery history timestamps", () => {
  it("accepts decoded dates and raw driver timestamp strings", () => {
    const date = new Date("2026-07-31T08:00:00.000Z");

    expect(deliveryHistoryTimestamp(date)).toBe(date.getTime());
    expect(deliveryHistoryTimestamp("2026-07-31T08:00:00.000Z")).toBe(
      date.getTime(),
    );
  });

  it("returns a controlled Chinese error for invalid driver values", () => {
    expect(() => deliveryHistoryTimestamp("not-a-date")).toThrow(
      "任务记录的时间数据无效，请稍后重试",
    );
  });

  it("never falls back to raw historical operation codes", () => {
    expect(
      deliveryHistoryTicketTitle({
        title: null,
        type: "website_operation",
        operation: "legacy_jenova_api_setup",
        category: "legacy_jenova_api_setup",
      }),
    ).toBe("官网运营需求");
    expect(
      deliveryHistoryTicketTitle({
        title: "配置 Jenova 平台 API 密钥",
        type: "website_operation",
        operation: "legacy_jenova_api_setup",
      }),
    ).toBe("配置 Jenova 平台 API 密钥");
  });
});

describe("formal monitoring batch completion options", () => {
  it("scopes options to the customer and batches containing formal samples", () => {
    const query = new MySqlDialect().sqlToQuery(
      formalMonitoringBatchOptionsScope(42) as Parameters<
        MySqlDialect["sqlToQuery"]
      >[0],
    );

    expect(query.sql).toContain("`monitoring_batches`.`userId` = ?");
    expect(query.sql).toContain("`monitoring_batches`.`sampleCount` > ?");
    expect(query.params).toEqual([42, 0]);
  });

  it("returns only the non-sensitive fields required by the completion selector", async () => {
    const { executor, queue } = queuedDeliveryExecutor([
      [
        {
          batchKey: "formal-batch-2026-08",
          sourceName: "正式监控.xlsx",
          collectedAt: new Date("2026-08-08T03:00:00.000Z"),
          sampleCount: 24,
        },
        {
          batchKey: "formal-batch-2026-08",
          sourceName: "历史同名批次.xlsx",
          collectedAt: new Date("2026-07-08T03:00:00.000Z"),
          sampleCount: 10,
        },
      ],
    ]);

    await expect(
      listFormalMonitoringBatchOptions({ executor, userId: 42 }),
    ).resolves.toEqual([
      {
        batchKey: "formal-batch-2026-08",
        sourceName: "正式监控.xlsx",
        collectedAt: Date.parse("2026-08-08T03:00:00.000Z"),
        sampleCount: 24,
      },
    ]);
    expect(queue).toHaveLength(0);
  });
});

describe("delivery completion contract", () => {
  const validCompletion = (operation: string) => {
    const base: any = {
      operation,
      nextStatus: "completed",
      message: "已完成并核验交付结果。",
    };
    if (
      [
        "channel_distribution",
        "website_build",
        "company_facts",
        "product_case_docs",
        "industry_news",
        "company_news",
        "faq_content",
      ].includes(operation)
    ) {
      base.publicUrl = "https://example.com/result";
    }
    if (operation === "website_build") base.previewVerified = true;
    if (["initial_monitoring", "monitoring_import"].includes(operation)) {
      base.handoff = { monitoringBatchKey: "batch-1" };
    }
    if (operation === "monitoring_retest") {
      base.handoff = { monitoringBatchKey: "batch-2" };
    }
    if (operation === "stage_report") {
      base.handoff = { needsFurtherOptimization: false };
    }
    if (operation === "response_logic") {
      base.handoff = { responseLogicRevision: 1 };
    }
    if (
      operation === "content_asset_publish" ||
      [
        "company_facts",
        "product_case_docs",
        "industry_news",
        "company_news",
        "faq_content",
      ].includes(operation)
    ) {
      base.handoff = { contentAssetIds: ["asset-1"] };
    }
    if (operation === "channel_distribution") {
      base.handoff = { targetMedia: "wechat" };
    }
    if (operation === "domain_application") {
      base.handoff = { domain: "example.com" };
    }
    if (operation === "icp_filing") {
      base.handoff = { icpNotRequired: false, icpNumber: "ICP-1" };
    }
    if (operation === "site_check") {
      base.handoff = {
        siteCheck: {
          key: "published-page-check",
          label: "发布页检查",
          status: "passed",
          source: "https://example.com/result",
        },
      };
    }
    return base;
  };

  it("uses the shared 23-operation specification as a strict evidence allowlist", () => {
    for (const spec of Object.values(DELIVERY_OPERATION_SPECS)) {
      const completion = validCompletion(spec.operation);
      if (spec.completion.mode === "form") {
        expect(() =>
          assertDeliveryCompletionContract(completion),
        ).not.toThrow();
        expect(() =>
          assertDeliveryCompletionContract({
            ...completion,
            handoff: {
              ...completion.handoff,
              publishTargets: ["media"],
            },
          }),
        ).toThrow("不接收以下交付字段");
      } else {
        expect(() => assertDeliveryCompletionContract(completion)).toThrow();
      }
    }
  });

  it("allows unknown operations to close with a non-sensitive summary only", () => {
    expect(() =>
      assertDeliveryCompletionContract({
        operation: "legacy_jenova_api_setup",
        nextStatus: "completed",
        message: "平台连接已由管理员确认。",
      }),
    ).not.toThrow();
    expect(() =>
      assertDeliveryCompletionContract({
        operation: "legacy_jenova_api_setup",
        nextStatus: "completed",
        message: "平台连接已确认。",
        publicUrl: "https://example.com",
      }),
    ).toThrow("不能提交链接");
    expect(() =>
      assertDeliveryCompletionContract({
        operation: "legacy_jenova_api_setup",
        nextStatus: "in_progress",
        message: "开始处理。",
      }),
    ).toThrow("只支持填写非敏感摘要后关闭");
  });

  it("rejects structured evidence on non-completion transitions", () => {
    expect(() =>
      assertDeliveryCompletionContract({
        operation: "channel_distribution",
        nextStatus: "in_progress",
        message: "开始处理。",
        handoff: { targetMedia: "wechat" },
      }),
    ).toThrow("只能填写说明");
  });

  it("keeps a root active through correction and completes only when every child completes", () => {
    expect(deriveWorkflowContainerStatus(["completed", "submitted"])).toBe(
      "in_progress",
    );
    expect(deriveWorkflowContainerStatus(["completed", "completed"])).toBe(
      "completed",
    );
    expect(
      deriveWorkflowContainerStatus(["completed", "needs_information"]),
    ).toBe("needs_information");
  });
});

describe("delivery workflow structural invariants", () => {
  const rootTicket = {
    id: "root-1",
    parentTicketId: null,
    rootTicketId: null,
    isWorkflowContainer: true,
    userId: 42,
    contractId: "contract-root",
    quotaPeriodId: "period-root",
  };
  const sourceTicket = {
    id: "child-1",
    parentTicketId: "root-1",
    rootTicketId: "root-1",
    isWorkflowContainer: false,
    userId: 42,
    contractId: "contract-stale-child",
    quotaPeriodId: "period-stale-child",
  };

  it("inherits immutable billing scope from the root and keeps non-root compatibility", () => {
    expect(
      resolveAssignedWorkflowBillingScope({
        sourceTicket,
        rootTicket,
        latestPeriod: {
          id: "period-latest",
          contractId: "contract-latest",
        },
      }),
    ).toEqual({
      rootTicketId: "root-1",
      contractId: "contract-root",
      quotaPeriodId: "period-root",
    });
    expect(() =>
      resolveAssignedWorkflowBillingScope({
        sourceTicket,
        rootTicket: { ...rootTicket, userId: 99 },
      }),
    ).toThrow("工作流根关系无效");
    expect(
      resolveAssignedWorkflowBillingScope({
        sourceTicket: {
          ...sourceTicket,
          id: "standalone-1",
          parentTicketId: null,
          rootTicketId: null,
        },
        latestPeriod: {
          id: "period-latest",
          contractId: "contract-latest",
        },
      }),
    ).toEqual({
      rootTicketId: null,
      contractId: "contract-latest",
      quotaPeriodId: "period-latest",
    });
  });

  it("scopes aggregation by root and tenant, then rejects malformed child graphs", () => {
    const query = new MySqlDialect().sqlToQuery(
      workflowContainerChildrenScope({
        rootTicketId: "root-1",
        userId: 42,
      }) as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(query.sql).toContain("`delivery_tickets`.`rootTicketId` = ?");
    expect(query.sql).toContain("`delivery_tickets`.`userId` = ?");
    expect(query.params).toEqual(["root-1", 42]);

    const children = [
      sourceTicket,
      {
        ...sourceTicket,
        id: "child-2",
        parentTicketId: "child-1",
      },
    ];
    expect(() =>
      assertWorkflowGraphIntegrity({
        root: rootTicket,
        sourceTicket,
        children,
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkflowGraphIntegrity({
        root: rootTicket,
        sourceTicket,
        children: [{ ...sourceTicket, userId: 99 }],
      }),
    ).toThrow("工作流根关系无效");
    expect(() =>
      assertWorkflowGraphIntegrity({
        root: rootTicket,
        sourceTicket,
        children: [{ ...sourceTicket, parentTicketId: "outside-root" }],
      }),
    ).toThrow("工作流根关系无效");
  });

  it("creates a child with root billing and metadata-only root attachments once", async () => {
    const rootAttachment = {
      id: "root-attachment-1",
      workspaceUserId: 42,
      ownerUserId: 42,
      kind: "input" as const,
      upstreamFileId: "upstream-file-1",
      filename: "客户原始资料.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      sha256: "a".repeat(64),
      purpose: "客户输入",
      authorization: "owned" as const,
      copyrightNote: "客户自有资料",
    };
    const { executor, insertCalls, queue } = queuedDeliveryExecutor([
      [{ projectAssignmentId: "assignment-owner", engineerUserId: 77 }],
      [rootTicket],
      [],
      [rootAttachment],
    ]);
    const createdId = await createAssignedWorkflowTicket({
      executor,
      sourceTicket: {
        ...sourceTicket,
        sourceQuestionId: "question-1",
        monitoringBatchKey: "batch-1",
        responseLogicRevision: 1,
        contentAssetIds: ["asset-1"],
        preferredMedia: "wechat",
        deliveryLinks: [],
        targetPage: null,
      } as any,
      actorUserId: 7,
      actorRoleContext: {
        projectAssignmentId: "assignment-source",
        customerUserId: 42,
        roleType: "content_distribution_engineer",
        eventActorRole: "delivery_member",
      },
      workflowDomain: "content_distribution_engineer",
      operation: "channel_distribution",
      title: "登记媒体渠道分发结果",
      description: "完成媒体渠道分发。",
    });

    expect(queue).toHaveLength(0);
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0]?.values).toMatchObject({
      id: createdId,
      parentTicketId: "child-1",
      rootTicketId: "root-1",
      workflowStageKey: deliveryWorkflowStageKey(
        "channel_distribution",
        "question-1",
      ),
      contractId: "contract-root",
      quotaPeriodId: "period-root",
    });
    const childEvent = insertCalls[1]?.values;
    const copiedAttachments = insertCalls[2]?.values;
    expect(copiedAttachments).toHaveLength(1);
    expect(copiedAttachments[0]).toMatchObject({
      ticketId: createdId,
      eventId: childEvent.id,
      workspaceUserId: 42,
      ownerUserId: 42,
      upstreamFileId: "upstream-file-1",
      filename: "客户原始资料.pdf",
      sha256: "a".repeat(64),
      copyrightNote: "客户自有资料",
    });
    expect(copiedAttachments[0].id).not.toBe(rootAttachment.id);
    expect(copiedAttachments[0]).not.toHaveProperty("blob");

    const mappedRows = workflowChildAttachmentMetadataRows({
      attachments: [rootAttachment],
      ticketId: "child-new",
      eventId: "event-new",
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
    });
    expect(mappedRows[0]).toMatchObject({
      ticketId: "child-new",
      eventId: "event-new",
      ownerUserId: rootAttachment.ownerUserId,
      upstreamFileId: rootAttachment.upstreamFileId,
    });
  });

  it("does not copy root attachments again when the child already exists", async () => {
    const { executor, insertCalls, queue } = queuedDeliveryExecutor([
      [{ projectAssignmentId: "assignment-owner", engineerUserId: 77 }],
      [rootTicket],
      [{ id: "existing-child" }],
    ]);
    const id = await createAssignedWorkflowTicket({
      executor,
      sourceTicket: sourceTicket as any,
      actorUserId: 7,
      actorRoleContext: {
        projectAssignmentId: "assignment-source",
        customerUserId: 42,
        roleType: "content_distribution_engineer",
        eventActorRole: "delivery_member",
      },
      workflowDomain: "content_distribution_engineer",
      operation: "channel_distribution",
      title: "登记媒体渠道分发结果",
      description: "完成媒体渠道分发。",
    });
    expect(id).toBe("existing-child");
    expect(insertCalls).toHaveLength(0);
    expect(queue).toHaveLength(0);
  });

  it("deduplicates concurrent monitoring retests with the existing unique technical key", async () => {
    const key = monitoringRetestTechnicalDedupeKey(" question-1 ");
    expect(key).toBe(monitoringRetestTechnicalDedupeKey("question-1"));
    expect(key).not.toBe(monitoringRetestTechnicalDedupeKey("question-2"));
    expect(key.length).toBeLessThanOrEqual(64);

    const { executor, insertCalls, queue } = queuedDeliveryExecutor([
      [{ projectAssignmentId: "monitor-owner", engineerUserId: 88 }],
      [],
      [{ id: "period-1", contractId: "contract-1" }],
      [{ id: "concurrent-winner" }],
    ]);
    const id = await createMonitoringRetestTicket({
      executor,
      sourceTicket: {
        userId: 42,
        sourceQuestionId: " question-1 ",
        monitoringBatchKey: "batch-1",
        responseLogicRevision: 2,
        contentAssetIds: ["asset-1"],
      } as any,
      actorUserId: 7,
    });

    expect(id).toBe("concurrent-winner");
    expect(queue).toHaveLength(0);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.values).toMatchObject({
      sourceQuestionId: "question-1",
      technicalDedupeKey: key,
      operation: "monitoring_retest",
    });
    expect(insertCalls[0]?.onDuplicateKeyUpdate).toBeDefined();
  });
});

describe("my delivery ticket pool", () => {
  it("uses the two public status groups and a bounded result", () => {
    expect(deliveryTicketStatusGroup("submitted")).toBe("pending");
    expect(deliveryTicketStatusGroup("in_progress")).toBe("pending");
    expect(deliveryTicketStatusGroup("completed")).toBe("completed");
    expect(deliveryTicketStatusGroup("rejected")).toBe("completed");
    expect(deliveryTicketStatusGroup("unknown")).toBeNull();
    expect(MY_DELIVERY_TICKET_LIMIT).toBe(50);
    expect(
      [
        "in_progress",
        "submitted",
        "scheduled",
        "needs_information",
        "completed",
      ].map(deliveryTicketActionRank),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it("makes the monitoring dependency an explicit server decision", () => {
    expect(knowledgeMonitoringHandoffOperations()).toEqual([
      "question_catalog",
    ]);
    expect(knowledgeMonitoringHandoffReusableTicketStatuses()).toEqual([
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
    ]);
    expect(knowledgeMonitoringHandoffReusableTicketStatuses()).not.toContain(
      "rejected" as any,
    );
    expect(knowledgeMonitoringHandoffReusableTicketStatuses()).not.toContain(
      "cancelled" as any,
    );
    expect(
      deliveryTicketDependencyState({
        operation: "initial_monitoring",
        status: "submitted",
        hasCompletedQuestionCatalog: false,
        hasApprovedQuestion: false,
      }),
    ).toMatchObject({
      dependencySatisfied: false,
      dependencyBlockReason: expect.stringContaining("品牌词库与问题目录"),
    });
    expect(
      deliveryTicketDependencyState({
        operation: "initial_monitoring",
        status: "submitted",
        hasCompletedQuestionCatalog: true,
        hasApprovedQuestion: true,
      }),
    ).toEqual({
      dependencySatisfied: true,
      dependencyBlockReason: null,
    });
    expect(
      deliveryTicketDependencyState({
        operation: "initial_monitoring",
        status: "submitted",
        hasCompletedQuestionCatalog: true,
        hasApprovedQuestion: false,
      }),
    ).toMatchObject({ dependencySatisfied: false });
    expect(
      deliveryTicketDependencyState({
        operation: "initial_monitoring",
        status: "cancelled",
        hasCompletedQuestionCatalog: false,
        hasApprovedQuestion: false,
      }),
    ).toEqual({
      dependencySatisfied: true,
      dependencyBlockReason: null,
    });
  });

  it("keeps stale monitoring tickets out of every SQL-backed pool until both prerequisites are met", () => {
    const query = new MySqlDialect().sqlToQuery(
      visibleInitialMonitoringTicketScope() as Parameters<
        MySqlDialect["sqlToQuery"]
      >[0],
    );

    expect(query.params).toEqual([]);
    expect(query.sql).toContain("FROM delivery_tickets AS completed_catalog");
    expect(query.sql).toContain("completed_catalog.quotaPeriodId");
    expect(query.sql).toContain(
      "FROM delivery_workflow_milestones AS archived_catalog",
    );
    expect(query.sql).toContain(
      "FROM workspace_questions AS approved_question",
    );
    expect(query.sql).toContain("approved_question.quotaPeriodId");

    const reuseQuery = new MySqlDialect().sqlToQuery(
      reusableInitialMonitoringTicketScope({
        userId: 42,
      }) as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(reuseQuery.sql).not.toContain("`delivery_tickets`.`quotaPeriodId`");
    expect(reuseQuery.params).toContain(42);
  });

  it("reuses the account-lifetime initial monitor and replaces only an invalid stale ticket", () => {
    expect(
      initialMonitoringExistingTicketAction({
        status: "completed",
        ticketQuotaPeriodId: "period-old",
        sourceQuotaPeriodId: "period-current",
        dependencySatisfied: false,
      }),
    ).toBe("reuse");
    expect(
      initialMonitoringExistingTicketAction({
        status: "submitted",
        ticketQuotaPeriodId: "period-old",
        sourceQuotaPeriodId: "period-current",
        dependencySatisfied: true,
      }),
    ).toBe("reuse");
    expect(
      initialMonitoringExistingTicketAction({
        status: "submitted",
        ticketQuotaPeriodId: "period-old",
        sourceQuotaPeriodId: "period-current",
        dependencySatisfied: false,
      }),
    ).toBe("replace_stale");
  });

  it("rejects non-engineers before attempting any database query", async () => {
    await expect(
      getMyDeliveryTickets({
        actor: { id: 9, role: "user" } as any,
      }),
    ).rejects.toThrow("该需求池仅对工程师或系统管理员开放");
  });
});

describe("delivery execution authorization and settlement", () => {
  it("requires the dedicated resolver to close question-maintenance requests", () => {
    for (const operation of ["question_maintenance"]) {
      expect(() =>
        assertGenericDeliveryTicketTransition({
          operation,
          nextStatus: "completed",
        }),
      ).toThrow("专用审批操作");
    }
  });

  it("allows engineers and system admins while excluding delivery admins", () => {
    expect(
      deliveryExecutionActorRole({
        role: "delivery_member",
        username: "engineer",
      } as any),
    ).toBe("delivery_member");
    expect(
      deliveryExecutionActorRole({
        role: "admin",
        username: "root-admin",
        adminAccessLevel: "system_admin",
      } as any),
    ).toBe("admin");
    expect(
      deliveryExecutionActorRole({
        role: "admin",
        username: "delivery-admin",
        adminAccessLevel: "delivery_admin",
      } as any),
    ).toBeNull();
  });

  it("consumes reserved quota on execution and records the first schedule", () => {
    const now = new Date("2026-08-04T08:00:00.000Z");

    expect(
      deriveDeliveryExecutionTransition({
        currentQuotaState: "reserved",
        scheduledAt: null,
        quotaReleasedAt: null,
        technicalDedupeKey: "ticket:42",
        nextStatus: "in_progress",
        now,
      }),
    ).toEqual({
      quotaState: "consumed",
      scheduledAt: now,
      quotaReleasedAt: null,
      technicalDedupeKey: "ticket:42",
      resolvedAt: null,
    });
  });

  it("releases an unused reservation and clears terminal dedupe state", () => {
    const now = new Date("2026-08-04T08:00:00.000Z");

    expect(
      deriveDeliveryExecutionTransition({
        currentQuotaState: "reserved",
        scheduledAt: null,
        quotaReleasedAt: null,
        technicalDedupeKey: "ticket:42",
        nextStatus: "cancelled",
        now,
      }),
    ).toEqual({
      quotaState: "released",
      scheduledAt: null,
      quotaReleasedAt: now,
      technicalDedupeKey: null,
      resolvedAt: now,
    });
  });

  it("reserves website style completion for customer sample selection", () => {
    expect(() =>
      assertGenericDeliveryTicketTransition({
        operation: "question_maintenance",
        nextStatus: "completed",
      }),
    ).toThrow("必须使用专用审批操作");
    expect(() =>
      assertGenericDeliveryTicketTransition({
        operation: "website_style_samples",
        nextStatus: "completed",
      }),
    ).toThrow("必须由客户通过专用选择操作确认");
    expect(() =>
      assertGenericDeliveryTicketTransition({
        operation: "website_style_samples",
        nextStatus: "in_progress",
      }),
    ).not.toThrow();
  });

  it("keeps website build recoverable instead of allowing terminal rejection", () => {
    for (const nextStatus of ["rejected", "cancelled"] as const) {
      expect(() =>
        assertGenericDeliveryTicketTransition({
          operation: "website_build",
          nextStatus,
        }),
      ).toThrow("官网构建工单不能拒绝或取消");
    }
    expect(() =>
      assertGenericDeliveryTicketTransition({
        operation: "website_build",
        nextStatus: "needs_information",
      }),
    ).not.toThrow();
  });

  it("requires a non-empty customer result summary on completion", () => {
    expect(() =>
      assertDeliveryCompletionSummary({
        nextStatus: "completed",
        message: "   ",
      }),
    ).toThrow("客户可见的结果摘要");
    expect(() =>
      assertDeliveryCompletionSummary({
        nextStatus: "completed",
        message: "已完成交付并核验结果。",
      }),
    ).not.toThrow();
    for (const message of [
      "API Key 为 sk-example-secret-value-123456",
      "Bearer abcdefghijklmnopqrstuvwxyz123456",
    ]) {
      expect(() =>
        assertDeliveryCompletionSummary({
          nextStatus: "completed",
          message,
        }),
      ).toThrow("疑似包含密钥或令牌");
    }
  });

  it("requires an audited http(s) preview before completing a website build", () => {
    const completion = {
      operation: "website_build",
      nextStatus: "completed" as const,
      linkRequired: true,
    };
    expect(() => assertDeliveryCompletionEvidence(completion)).toThrow(
      "必须登记公开链接",
    );
    expect(() =>
      assertDeliveryCompletionEvidence({
        ...completion,
        publicUrl: "ftp://example.com/site",
        previewVerified: true,
      }),
    ).toThrow("有效的 http(s) 地址");
    expect(() =>
      assertDeliveryCompletionEvidence({
        ...completion,
        publicUrl: "https://example.com",
      }),
    ).toThrow("必须确认已核验用户实际页面");
    expect(() =>
      assertDeliveryCompletionEvidence({
        ...completion,
        publicUrl: "https://example.com",
        previewVerified: true,
      }),
    ).not.toThrow();
  });

  it("requires an audited http(s) preview before completing a website build", () => {
    const completion = {
      operation: "website_build",
      nextStatus: "completed" as const,
      linkRequired: true,
    };
    expect(() => assertDeliveryCompletionEvidence(completion)).toThrow(
      "必须登记公开链接",
    );
    expect(() =>
      assertDeliveryCompletionEvidence({
        ...completion,
        publicUrl: "ftp://example.com/site",
        previewVerified: true,
      }),
    ).toThrow("有效的 http(s) 地址");
    expect(() =>
      assertDeliveryCompletionEvidence({
        ...completion,
        publicUrl: "https://example.com",
      }),
    ).toThrow("必须确认已核验用户实际页面");
    expect(() =>
      assertDeliveryCompletionEvidence({
        ...completion,
        publicUrl: "https://example.com",
        previewVerified: true,
      }),
    ).not.toThrow();
  });
});
