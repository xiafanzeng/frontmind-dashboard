import { describe, expect, it } from "vitest";

import {
  adminDeliveryTicketListInputSchema,
  createDeliveryTicketSchema,
  deliveryTicketListInputSchema,
  deliveryTicketStatusSchema,
  publicContentAssetTicketDetailSchema,
  publicWebsiteTicketDetailSchema,
  resolveDeliveryTicketQuotaPool,
} from "../shared/delivery-ticket";
import {
  CONTENT_ASSET_CATALOG,
  icpMaterialChecklistForProvince,
} from "../shared/delivery-catalog";
import {
  aggregateDeliveryTicketQuotaCapacity,
  assertExistingDeliveryTicketSettlementScope,
  assertDeliveryTicketServiceEligibility,
  assertDeliveryOperationPolicy,
  assertDeliveryTicketMessagePolicy,
  assertWebsiteTicketWorkflow,
  decodeDeliveryTicketCursor,
  deliveryLinksFromOperationResults,
  deriveTicketQuotaTransition,
  encodeDeliveryTicketCursor,
  isDeliveryTicketAttachmentVisible,
  missingIcpCompletionRequirements,
  missingOwnedAttachmentIds,
  selectDeliveryTicketQuotaPeriod,
  technicalTicketDedupeKey,
  toPublicDeliveryTicketCreationResult,
  toPublicDeliveryTicketSummary,
  toPublicDeliveryTicketWorkspaceMetadata,
  withSerializedTicketCreation,
} from "./delivery-ticket-service";

function settlementExecutor(
  periods: Array<{ id: string; userId: number; contractId: string }>,
) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return {
                    async for() {
                      return periods.slice(0, 1);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("delivery ticket contract", () => {
  it("publishes six explained content types without the retired media type", () => {
    expect(CONTENT_ASSET_CATALOG).toHaveLength(6);
    expect(
      CONTENT_ASSET_CATALOG.some(
        (item) => item.label === "媒体稿件与权威信源",
      ),
    ).toBe(false);
    expect(
      CONTENT_ASSET_CATALOG.every((item) => item.description.length > 0),
    ).toBe(true);
  });

  it("derives public media links only from successful structured delivery records", () => {
    expect(
      deliveryLinksFromOperationResults([
        {
          platform: "搜狐",
          targetUrl: "https://example.com/published",
          executedAt: 1_774_700_000_000,
          resultStatus: "success",
        },
        {
          platform: "失败平台",
          targetUrl: "https://example.com/failed",
          executedAt: 1_774_700_000_001,
          resultStatus: "failed",
        },
        {
          platform: "重复记录",
          targetUrl: "https://example.com/published",
          executedAt: 1_774_700_000_002,
          resultStatus: "success",
        },
        { platform: "无效记录", targetUrl: "javascript:alert(1)" },
      ]),
    ).toEqual([
      {
        label: "搜狐",
        url: "https://example.com/published",
      },
    ]);
  });

  it("enforces summary-only website communication at the service boundary", () => {
    expect(() =>
      assertDeliveryTicketMessagePolicy({
        ticketType: "website_operation",
        actorRole: "user",
        visibility: "customer",
      }),
    ).toThrow("官网工单不提供公开交流");
    expect(() =>
      assertDeliveryTicketMessagePolicy({
        ticketType: "website_operation",
        actorRole: "admin",
        visibility: "customer",
      }),
    ).toThrow("官网工单不提供公开交流");
    expect(() =>
      assertDeliveryTicketMessagePolicy({
        ticketType: "website_operation",
        actorRole: "admin",
        visibility: "internal",
      }),
    ).not.toThrow();
    expect(() => assertDeliveryOperationPolicy("website_operation")).toThrow(
      "官网工单不回传",
    );
    expect(() => assertDeliveryOperationPolicy("content_asset")).not.toThrow();
  });

  it("keeps the canonical status set stable", () => {
    expect(deliveryTicketStatusSchema.options).toEqual([
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled",
    ]);
  });

  it("chooses quota pools from server-owned website categories", () => {
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "content_asset",
        category: "A1",
      }),
    ).toBe("content_asset_publish");
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "company_facts",
      }),
    ).toBe("website_content_publish");
    expect(
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "domain_application",
      }),
    ).toBeNull();
    expect(() =>
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "blog_update",
      }),
    ).toThrow("旧版官网技术类别");
    expect(() =>
      resolveDeliveryTicketQuotaPool({
        type: "website_operation",
        category: "made_up_free_category",
      }),
    ).toThrow("有效的官网运营类别");
    expect(() =>
      resolveDeliveryTicketQuotaPool({
        type: "content_asset",
        category: "company_facts",
      }),
    ).toThrow("不能使用内容资产额度");
  });

  it("accepts a category-only request but not a content-free request", () => {
    expect(
      createDeliveryTicketSchema.parse({
        clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
        type: "content_asset",
        category: "A1",
      }).category,
    ).toBe("A1");
    expect(() =>
      createDeliveryTicketSchema.parse({
        clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
        type: "content_asset",
      }),
    ).toThrow();
  });

  it("keeps attachment rights metadata in the validated contract", () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "content_asset",
      category: "A1",
      attachments: [
        {
          fileId: "file-1",
          filename: "brand-photo.jpg",
          purpose: "文章头图",
          authorization: "licensed",
          copyrightNote: "已取得摄影师书面授权",
        },
      ],
    });
    expect(value.attachments[0]).toMatchObject({
      purpose: "文章头图",
      authorization: "licensed",
    });
  });

  it("requires all structured ICP declarations on an ICP filing request", () => {
    const common = {
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "website_operation",
      category: "icp_filing",
      topic: "企业网站备案",
      icpProvince: "广东",
    } as const;
    expect(() => createDeliveryTicketSchema.parse(common)).toThrow(
      "域名实名信息",
    );
    expect(
      createDeliveryTicketSchema.parse({
        ...common,
        icpDeclarations: {
          domainHolderInformation: "域名已完成企业实名，持有人与营业执照一致",
          websiteInformation: "企业官网、品牌与产品资料、负责人联系方式已填写",
          aliyunAppVerificationCompleted: true,
        },
      }).icpDeclarations,
    ).toMatchObject({ aliyunAppVerificationCompleted: true });
  });

  it("accepts one combined domain and ICP submission before a site profile exists", async () => {
    const value = createDeliveryTicketSchema.parse({
      clientRequestId: "5f05091b-0e0a-4482-8f11-654c4502b3e1",
      type: "website_operation",
      category: "icp_filing",
      topic: "https://Example.com/path",
      icpProvince: "浙江",
      icpDeclarations: {
        domainHolderInformation: "域名持有人与主办单位一致",
        websiteInformation: "验收企业官网，展示产品与案例",
        aliyunAppVerificationCompleted: true,
      },
      attachments: [
        {
          storageKind: "icp_protected",
          protectedMaterialId: "00000000-0000-4000-8000-000000000001",
          sensitiveCategory: "business_license",
          filename: "营业执照.pdf",
        },
        {
          storageKind: "icp_protected",
          protectedMaterialId: "00000000-0000-4000-8000-000000000002",
          sensitiveCategory: "subject_responsible_person_id",
          filename: "主体负责人证件.pdf",
        },
        {
          storageKind: "icp_protected",
          protectedMaterialId: "00000000-0000-4000-8000-000000000003",
          sensitiveCategory: "website_responsible_person_id",
          filename: "网站负责人证件.pdf",
        },
      ],
    });
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [],
            }),
          }),
        }),
      }),
    };

    await expect(
      assertWebsiteTicketWorkflow(executor, 42, value),
    ).resolves.toEqual({
      profile: null,
      domain: "example.com",
    });
  });

  it("returns province-specific ICP requirements from the server catalog", () => {
    const guangdong = icpMaterialChecklistForProvince("广东");
    const zhejiang = icpMaterialChecklistForProvince("浙江");
    expect(
      guangdong.find((item) => item.key === "other_provincial_material"),
    ).toMatchObject({ required: true });
    expect(
      zhejiang.find((item) => item.key === "other_provincial_material"),
    ).toMatchObject({ required: false });
  });

  it("validates bounded user and administrator list filters", () => {
    expect(
      deliveryTicketListInputSchema.parse({
        type: "content_asset",
        publicStatus: "pending",
        direction: "forward",
      }),
    ).toMatchObject({
      type: "content_asset",
      publicStatus: "pending",
      direction: "forward",
      limit: 20,
    });
    expect(
      adminDeliveryTicketListInputSchema.parse({
        userId: 42,
        assignedAdminId: 7,
        query: " 验收企业 ",
        type: "website_operation",
        quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
        limit: 100,
      }),
    ).toMatchObject({
      userId: 42,
      assignedAdminId: 7,
      query: "验收企业",
      type: "website_operation",
      limit: 100,
    });
    expect(() => deliveryTicketListInputSchema.parse({ limit: 101 })).toThrow();
    expect(() =>
      deliveryTicketListInputSchema.parse({ status: "in_progress" }),
    ).toThrow();
    expect(() =>
      deliveryTicketListInputSchema.parse({
        quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
      }),
    ).toThrow();
    expect(() =>
      adminDeliveryTicketListInputSchema.parse({ userId: 0 }),
    ).toThrow();
    expect(() =>
      adminDeliveryTicketListInputSchema.parse({ query: "x".repeat(101) }),
    ).toThrow();
  });

  it("round-trips an opaque keyset cursor and rejects tampering", () => {
    const updatedAt = new Date("2026-07-27T02:03:04.000Z");
    const id = "970b87d8-d4f4-45db-8f11-44c45f52ade9";
    const cursor = encodeDeliveryTicketCursor({ updatedAt, id });

    expect(cursor).not.toContain(id);
    expect(decodeDeliveryTicketCursor(cursor)).toEqual({
      version: 1,
      updatedAt: updatedAt.getTime(),
      id,
    });
    expect(() => decodeDeliveryTicketCursor(`${cursor}!`)).toThrow(
      "工单列表游标无效",
    );
    expect(() =>
      decodeDeliveryTicketCursor(
        Buffer.from(
          JSON.stringify({
            version: 2,
            updatedAt: updatedAt.getTime(),
            id,
          }),
        ).toString("base64url"),
      ),
    ).toThrow("工单列表游标无效");
  });

  it("binds an oldest-first cursor to the created-time ordering", () => {
    const createdAt = new Date("2026-07-27T02:03:04.000Z");
    const id = "970b87d8-d4f4-45db-8f11-44c45f52ade9";
    const cursor = encodeDeliveryTicketCursor({
      updatedAt: createdAt,
      id,
      order: "created_asc",
    });

    expect(decodeDeliveryTicketCursor(cursor)).toEqual({
      version: 1,
      updatedAt: createdAt.getTime(),
      id,
      order: "created_asc",
    });
  });
});

describe("customer delivery-ticket DTO boundary", () => {
  const internalTicket = {
    id: "970b87d8-d4f4-45db-8f11-44c45f52ade9",
    userId: 42,
    contractId: "contract-internal",
    quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
    ordinal: 3,
    enterpriseName: "内部企业名称",
    type: "content_asset",
    quotaPool: "content_asset_publish",
    quotaState: "consumed",
    category: "D1",
    topic: "如何核验品牌事实",
    title: "不应单独暴露的内部标题",
    description: "包含内部材料说明",
    preferredMedia: "知乎",
    icpProvince: null,
    targetPage: "https://example.com/internal-target",
    materialUrls: ["https://example.com/internal-source"],
    status: "completed",
    statusLabel: "已完成",
    publicStatus: "completed",
    publicStatusLabel: "已完成",
    publicSummary: "已完成问答内容整理。",
    deliveryLinks: [
      {
        label: "知乎",
        url: "https://www.zhihu.com/question/example",
      },
    ],
    revision: 4,
    submittedAt: 1_774_560_000_000,
    createdAt: 1_774_560_000_000,
    updatedAt: 1_774_646_400_000,
    resolvedAt: 1_774_646_400_000,
    scheduledAt: 1_774_603_200_000,
    attachmentCount: 2,
    latestPublicMessage: "列表不应返回过程消息。",
    assignedAdmins: [{ id: 7, name: "内部管理员" }],
    assignedAdminId: 7,
    assignedAdminName: "内部管理员",
  } as const;

  it("projects content history to the two-state public contract only", () => {
    const value = toPublicDeliveryTicketSummary(internalTicket as any);

    expect(value).toEqual({
      id: internalTicket.id,
      type: "content_asset",
      category: "D1",
      categoryLabel: "知乎问答",
      topic: "如何核验品牌事实",
      publicStatus: "completed",
      publicStatusLabel: "已完成",
      publicSummary: "已完成问答内容整理。",
      deliveryLinks: [
        {
          label: "知乎",
          url: "https://www.zhihu.com/question/example",
        },
      ],
    });
    for (const forbidden of [
      "contractId",
      "quotaPeriodId",
      "quotaState",
      "assignedAdminName",
      "materialUrls",
      "submittedAt",
      "updatedAt",
      "resolvedAt",
      "attachmentCount",
    ]) {
      expect(value).not.toHaveProperty(forbidden);
    }
  });

  it("never returns delivery links from website history or create results", () => {
    const ticket = {
      ...internalTicket,
      type: "website_operation",
      category: "company_news",
    } as any;
    const value = toPublicDeliveryTicketSummary(ticket);
    const created = toPublicDeliveryTicketCreationResult({
      ticket,
      idempotent: false,
    });

    expect(value).toEqual({
      id: internalTicket.id,
      type: "website_operation",
      category: "company_news",
      categoryLabel: "企业新闻与动态",
      topic: "如何核验品牌事实",
      publicStatus: "completed",
      publicStatusLabel: "已完成",
      publicSummary: "已完成问答内容整理。",
    });
    expect(value).not.toHaveProperty("deliveryLinks");
    expect(created.ticket).toEqual(value);
    expect(created).not.toHaveProperty("contractId");
  });

  it("keeps website detail summary-only and content detail dialogue-only", () => {
    const websiteTicket = toPublicDeliveryTicketSummary({
      ...internalTicket,
      type: "website_operation",
      category: "company_news",
    } as any);
    expect(
      publicWebsiteTicketDetailSchema.safeParse({
        ticket: websiteTicket,
      }).success,
    ).toBe(true);
    expect(
      publicWebsiteTicketDetailSchema.safeParse({
        ticket: websiteTicket,
        events: [{ id: "internal-event" }],
        attachments: [{ downloadUrl: "/api/private" }],
      }).success,
    ).toBe(false);

    const contentTicket = toPublicDeliveryTicketSummary(internalTicket as any);
    const publicDetail = {
      ticket: {
        ...contentTicket,
        preferredMedia: null,
        revision: 4,
        canReply: false,
      },
      events: [
        {
          id: "7e39705a-ae06-4e7b-8d45-6284903ee86f",
          actorRole: "admin",
          actorLabel: "服务团队",
          message: "公开回复",
          createdAt: 1_774_646_400_000,
        },
      ],
      attachments: [
        {
          id: "4a67e445-37bb-45ed-9268-4ca9437e4d70",
          filename: "客户授权书.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          purpose: "客户案例授权",
          kind: "input",
          createdAt: 1_774_646_400_000,
          downloadUrl:
            "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
        },
      ],
    };
    expect(
      publicContentAssetTicketDetailSchema.safeParse(publicDetail).success,
    ).toBe(true);
    expect(
      publicContentAssetTicketDetailSchema.safeParse({
        ...publicDetail,
        attachments: [
          {
            ...publicDetail.attachments[0],
            downloadUrl: "/api/private",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      publicContentAssetTicketDetailSchema.safeParse({
        ...publicDetail,
        events: [
          {
            ...publicDetail.events[0],
            visibility: "internal",
            operationResult: { targetUrl: "https://internal.example" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("removes site identity, ICP verification and internal quota allocation", () => {
    const metadata = toPublicDeliveryTicketWorkspaceMetadata({
      siteProfile: {
        domain: "private.example.com",
        domainStatus: "completed",
        domainVerifiedAt: 1_774_560_000_000,
        icpProvince: "广东",
        icpNumber: "粤ICP备内部号",
        icpStatus: "approved",
        icpVerifiedAt: 1_774_646_400_000,
        revision: 9,
        updatedAt: 1_774_646_400_000,
      },
      quotas: {
        content_asset_publish: {
          type: "content_asset_publish",
          allowed: true,
          used: 2,
          reserved: 1,
          consumed: 1,
          limit: 5,
          remaining: 3,
          periodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
          revision: 4,
          validFrom: 1_774_560_000_000,
          validUntil: 1_782_336_000_000,
          reason: null,
        },
        website_content_publish: {
          type: "website_content_publish",
          allowed: true,
          used: 1,
          reserved: 1,
          consumed: 0,
          limit: 20,
          remaining: 19,
          periodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
          revision: 4,
          validFrom: 1_774_560_000_000,
          validUntil: 1_782_336_000_000,
          reason: null,
        },
      },
      pendingCount: 1,
      contentAssetCatalog: [
        {
          id: "D1",
          code: "D1",
          group: "D",
          type: "问答内容",
          label: "知乎问答",
        },
      ],
      websiteContentCatalog: [
        { value: "company_facts", label: "企业资料与品牌事实" },
      ],
      preferredMediaOptions: ["微博"],
      websiteWorkflow: {
        domainStatus: "completed",
        icpStatus: "approved",
        domainCompleted: true,
        icpCompleted: true,
        canSubmitDomain: false,
        canSubmitIcp: false,
        canSubmitContent: true,
        icpProvince: "广东",
        icpProvinceOptions: ["广东"],
        icpMaterialChecklist: [{ key: "business_license" }],
        icpLockReason: null,
        contentLockReason: null,
      },
    } as any);

    expect(metadata).not.toHaveProperty("siteProfile");
    expect(metadata).not.toHaveProperty("pendingCount");
    expect(metadata.websiteWorkflow).toEqual({
      domainCompleted: true,
      icpCompleted: true,
      canSubmitDomain: false,
      canSubmitIcp: false,
      canSubmitContent: true,
      domainLockReason: null,
      icpLockReason: null,
      contentLockReason: null,
      icpProvinceOptions: ["广东"],
    });
    expect(metadata.websiteWorkflow).not.toHaveProperty("icpProvince");
    expect(metadata.websiteWorkflow).not.toHaveProperty("icpMaterialChecklist");
    expect(metadata.quotas.content_asset_publish).toEqual({
      type: "content_asset_publish",
      allowed: true,
      used: 2,
      limit: 5,
      remaining: 3,
      reason: null,
    });
    expect(metadata.quotas.content_asset_publish).not.toHaveProperty(
      "periodId",
    );
    expect(metadata.quotas.content_asset_publish).not.toHaveProperty(
      "reserved",
    );
  });
});

describe("delivery ticket quota lifecycle", () => {
  it("allows Basic content assets but rejects Basic website operations", () => {
    expect(
      assertDeliveryTicketServiceEligibility(
        {
          service: {
            status: "active",
            planCode: "basic",
            contractId: "contract-basic",
          },
          quotas: { periodId: "basic-aggregate:contract-basic" },
          quotaPeriods: [
            {
              periodId: "period-basic-1",
              contractId: "contract-basic-1",
            },
            {
              periodId: "period-basic-2",
              contractId: "contract-basic-2",
            },
          ],
        } as any,
        "content_asset",
      ),
    ).toMatchObject({
      quotaPeriodIds: ["period-basic-1", "period-basic-2"],
    });
    expect(() =>
      assertDeliveryTicketServiceEligibility(
        {
          service: {
            status: "active",
            planCode: "basic",
            contractId: "contract-basic",
          },
          quotas: { periodId: "period-basic" },
          quotaPeriods: [],
        } as any,
        "website_operation",
      ),
    ).toThrow("普通版不包含 AI 友好官网管理");
  });

  it("rejects expired services on the server", () => {
    expect(() =>
      assertDeliveryTicketServiceEligibility({
        service: {
          status: "expired",
          planCode: "luxury",
          contractId: "contract-luxury",
        },
        quotas: { periodId: "period-luxury" },
      } as any),
    ).toThrow("仅可查看历史工单");
  });

  it("allocates concurrent Basic purchases to the next real period", () => {
    const periods = [
      {
        id: "period-expiring-first",
        contractId: "contract-1",
        contentAssetPublishLimit: 1,
        websiteContentPublishLimit: 0,
      },
      {
        id: "period-expiring-second",
        contractId: "contract-2",
        contentAssetPublishLimit: 1,
        websiteContentPublishLimit: 0,
      },
    ];
    expect(
      selectDeliveryTicketQuotaPeriod({
        periods,
        quotaPool: "content_asset_publish",
        activeCounts: new Map([["period-expiring-first", 1]]),
      }),
    ).toMatchObject({ id: "period-expiring-second" });
    expect(
      selectDeliveryTicketQuotaPeriod({
        periods,
        quotaPool: "content_asset_publish",
        activeCounts: new Map([
          ["period-expiring-first", 1],
          ["period-expiring-second", 1],
        ]),
      }),
    ).toBeNull();
    expect(
      selectDeliveryTicketQuotaPeriod({
        periods,
        quotaPool: "website_content_publish",
        activeCounts: new Map(),
      }),
    ).toBeNull();
  });

  it("aggregates content quota across every concurrent Basic period", () => {
    const capacity = aggregateDeliveryTicketQuotaCapacity({
      periods: [
        {
          id: "period-1",
          contractId: "contract-1",
          contentAssetPublishLimit: 1,
          websiteContentPublishLimit: 0,
        },
        {
          id: "period-2",
          contractId: "contract-2",
          contentAssetPublishLimit: 1,
          websiteContentPublishLimit: 0,
        },
      ],
      quotaPool: "content_asset_publish",
      activeRows: [
        {
          quotaPool: "content_asset_publish",
          quotaState: "consumed",
          value: 1,
        },
      ],
    });
    expect(capacity).toEqual({
      limit: 2,
      reserved: 0,
      consumed: 1,
      used: 1,
      remaining: 1,
    });
  });

  it("detects attachment ownership gaps without trusting descriptors", () => {
    expect(
      missingOwnedAttachmentIds(
        ["file-owned", "file-other", "file-other"],
        ["file-owned"],
      ),
    ).toEqual(["file-other"]);
  });

  it("never exposes internal or unscoped attachments to customers", () => {
    expect(isDeliveryTicketAttachmentVisible(false, "customer")).toBe(true);
    expect(isDeliveryTicketAttachmentVisible(false, "internal")).toBe(false);
    expect(isDeliveryTicketAttachmentVisible(false, null)).toBe(false);
    expect(isDeliveryTicketAttachmentVisible(true, "internal")).toBe(true);
    expect(isDeliveryTicketAttachmentVisible(true, null)).toBe(true);
  });

  it("blocks ICP completion when active files or declarations are missing", () => {
    const completeDeclarations = {
      domainHolderInformation: "域名持有人信息",
      websiteInformation: "网站名称、服务内容和联系方式",
      aliyunAppVerificationCompleted: true,
    };
    expect(
      missingIcpCompletionRequirements({
        activeSensitiveCategories: [
          "business_license",
          "subject_responsible_person_id",
          "website_responsible_person_id",
        ],
        declarations: completeDeclarations,
      }),
    ).toEqual([]);
    expect(
      missingIcpCompletionRequirements({
        activeSensitiveCategories: ["business_license"],
        declarations: null,
      }),
    ).toEqual(
      expect.arrayContaining([
        "subject_responsible_person_id",
        "website_responsible_person_id",
        "domain_holder_information",
        "website_information",
        "aliyun_app_verification",
      ]),
    );
  });

  it("reserves at submission and consumes only when scheduled", () => {
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "scheduled",
      }),
    ).toBe("consumed");
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "in_progress",
      }),
    ).toBe("consumed");
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "completed",
      }),
    ).toBe("consumed");
  });

  it("settles a submitted ticket against its original service period after a later expiry or downgrade", async () => {
    const ticket = {
      userId: 42,
      contractId: "contract-original",
      quotaPeriodId: "period-original",
      quotaPool: "website_content_publish",
      quotaState: "reserved",
    } as const;

    await expect(
      assertExistingDeliveryTicketSettlementScope({
        executor: settlementExecutor([
          {
            id: "period-original",
            userId: 42,
            contractId: "contract-original",
          },
        ]),
        userId: 42,
        ticket,
      }),
    ).resolves.toEqual({
      id: "period-original",
      userId: 42,
      contractId: "contract-original",
    });
  });

  it("rejects completion when the original quota binding is invalid or already released", async () => {
    const ticket = {
      userId: 42,
      contractId: "contract-original",
      quotaPeriodId: "period-original",
      quotaPool: "content_asset_publish",
      quotaState: "reserved",
    } as const;

    await expect(
      assertExistingDeliveryTicketSettlementScope({
        executor: settlementExecutor([]),
        userId: 42,
        ticket,
      }),
    ).rejects.toMatchObject({ code: "TICKET_QUOTA_SCOPE_INVALID" });
    await expect(
      assertExistingDeliveryTicketSettlementScope({
        executor: settlementExecutor([
          {
            id: "period-original",
            userId: 42,
            contractId: "contract-original",
          },
        ]),
        userId: 42,
        ticket: { ...ticket, quotaState: "released" },
      }),
    ).rejects.toMatchObject({ code: "TICKET_QUOTA_ALREADY_RELEASED" });
  });

  it("releases a reserved slot before scheduling", () => {
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "rejected",
      }),
    ).toBe("released");
    expect(
      deriveTicketQuotaTransition({
        currentState: "reserved",
        scheduledAt: null,
        nextStatus: "cancelled",
      }),
    ).toBe("released");
  });

  it("does not refund an already scheduled slot", () => {
    expect(
      deriveTicketQuotaTransition({
        currentState: "consumed",
        scheduledAt: new Date("2026-07-27T00:00:00Z"),
        nextStatus: "cancelled",
      }),
    ).toBe("consumed");
  });

  it("normalizes technical target pages into the same dedupe key", () => {
    expect(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "https://example.com/docs/",
      }),
    ).toBe(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "/docs",
      }),
    );
    expect(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "/other",
      }),
    ).not.toBe(
      technicalTicketDedupeKey({
        category: "bulk_redirect",
        targetPage: "/docs",
      }),
    );
  });

  it("serializes duplicate submissions before the idempotency lookup", async () => {
    let queue = Promise.resolve();
    let stored: { id: string } | null = null;
    let creates = 0;
    const withLock = async <T>(
      criticalSection: (scope: { periodId: string }) => Promise<T>,
    ) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await criticalSection({ periodId: "period-1" });
      } finally {
        release();
      }
    };
    const submit = () =>
      withSerializedTicketCreation({
        withLock,
        findDuplicate: async () => stored,
        onDuplicate: (existing) => ({
          id: existing.id,
          idempotent: true,
        }),
        create: async () => {
          creates += 1;
          await Promise.resolve();
          stored = { id: "ticket-1" };
          return { id: stored.id, idempotent: false };
        },
      });

    const results = await Promise.all([submit(), submit()]);
    expect(creates).toBe(1);
    expect(results).toEqual([
      { id: "ticket-1", idempotent: false },
      { id: "ticket-1", idempotent: true },
    ]);
  });
});
