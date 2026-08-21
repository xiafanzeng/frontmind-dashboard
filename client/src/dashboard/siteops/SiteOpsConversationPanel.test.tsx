import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SiteOpsObservationV1 } from "@shared/siteops-contract";
import SiteOpsConversationPanel from "./SiteOpsConversationPanel";

function observation(
  input: Partial<SiteOpsObservationV1> = {},
): SiteOpsObservationV1 {
  return {
    schemaVersion: 1,
    executionKind: "site_ops",
    providerState: {
      twentyFirst: { status: "configured" },
      manus: { status: "configured" },
      esa: { status: "configured" },
      aliyun: { status: "not_configured" },
    },
    aliyunConnection: {
      configured: false,
      accountUid: null,
      roleArn: null,
      externalIdFingerprint: null,
      status: null,
      capabilities: [],
      verifiedAt: null,
      lastErrorCode: null,
      canRotate: true,
    },
    domainState: null,
    domainOperations: [],
    dnsPlan: null,
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "siteops:1",
      revision: 3,
      status: "awaiting_visual_selection",
      currentKnowledgeSnapshotId: "22222222-2222-4222-8222-222222222222",
      primaryLanguage: "zh-CN",
      canonicalHostname: null,
      updatedAt: "2026-08-22T00:00:00.000Z",
    },
    brief: null,
    knowledgeSnapshots: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        label: "知识库 ZIP · 第 3 版",
        archiveSha256: "a".repeat(64),
        sourceProfile: "dashboard-core-v1",
        createdAt: "2026-08-22T00:00:00.000Z",
        active: true,
      },
    ],
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "已根据知识库准备好 2 个真实视觉候选，请选择一个方向。",
        sequence: 1,
        metadata: {
          siteOps: {
            kind: "visual_board",
            subjectId: "batch-1",
            revision: 3,
            status: "active",
            payload: {},
          },
        },
        sentAt: "2026-08-22T00:00:00.000Z",
      },
    ],
    visualCandidates: [
      {
        id: "candidate-a",
        label: "A",
        title: "克制的编辑式布局",
        previewUrl: "/api/local-assets/preview-a",
        note: "大标题与模块化信息层级",
        score: 91,
        selected: false,
      },
      {
        id: "candidate-b",
        label: "B",
        title: "精密技术型布局",
        previewUrl: "/api/local-assets/preview-b",
        note: null,
        score: 88,
        selected: false,
      },
    ],
    builds: [],
    deployments: [],
    socialPackages: [],
    interactionState: "awaiting_visual_selection",
    latestSequence: 1,
    ...input,
  };
}

describe("SiteOpsConversationPanel", () => {
  it("shows real A-I candidates and submits a structured selection", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={onAction}
        onSendMessage={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "对话式 AI 建站" }),
    ).toBeInTheDocument();
    expect(screen.getByAltText("A：克制的编辑式布局")).toHaveAttribute(
      "src",
      "/api/local-assets/preview-a",
    );
    fireEvent.click(screen.getByRole("button", { name: "选择 B" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "candidate-b" },
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
  });

  it("does not attach a stale action card after the worker advances revision", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const stale = observation();
    stale.messages[0]!.metadata!.siteOps!.revision = 2;
    render(
      <SiteOpsConversationPanel
        observation={stale}
        onAction={onAction}
        onSendMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择 A" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_visual",
        input: { sampleId: "candidate-a" },
      }),
    );
  });

  it("keeps a completed visual board read-only while a build is running", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "building" },
          interactionState: "building",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "已锁定的视觉方向" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 A" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "委托 AI 选择最高分" }),
    ).toBeNull();
  });

  it("selects an immutable knowledge snapshot through a structured action", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            currentKnowledgeSnapshotId: null,
            status: "draft",
          },
          messages: [],
          visualCandidates: [],
          interactionState: "select_snapshot",
        })}
        onAction={onAction}
      />,
    );

    fireEvent.change(screen.getByLabelText("知识库 ZIP 版本"), {
      target: { value: "22222222-2222-4222-8222-222222222222" },
    });
    fireEvent.click(screen.getByRole("button", { name: "使用此版本" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "select_snapshot",
        input: {
          knowledgeSnapshotId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    );
  });

  it("changes to another owned snapshot explicitly without rewriting the old build", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "live" },
          interactionState: "live",
          knowledgeSnapshots: [
            ...observation().knowledgeSnapshots,
            {
              id: "99999999-9999-4999-8999-999999999999",
              label: "知识库 ZIP · 第 4 版",
              archiveSha256: "b".repeat(64),
              sourceProfile: "dashboard-core-v1",
              createdAt: "2026-08-22T01:00:00.000Z",
              active: false,
            },
          ],
        })}
        onAction={onAction}
      />,
    );

    fireEvent.change(screen.getByLabelText("更换知识库 ZIP 版本"), {
      target: { value: "99999999-9999-4999-8999-999999999999" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "更换知识源并重新整理" }),
    );
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "change_snapshot",
        input: {
          knowledgeSnapshotId: "99999999-9999-4999-8999-999999999999",
        },
      }),
    );
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("旧官网版本"));
    confirm.mockRestore();
  });

  it("disables a knowledge-source change while a build is nonterminal", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "building",
              previewUrl: null,
              sourceUrl: null,
              qaUrl: null,
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          project: { ...observation().project, status: "building" },
          interactionState: "building",
          knowledgeSnapshots: [
            ...observation().knowledgeSnapshots,
            {
              id: "99999999-9999-4999-8999-999999999999",
              label: "知识库 ZIP · 第 4 版",
              archiveSha256: "b".repeat(64),
              sourceProfile: "dashboard-core-v1",
              createdAt: "2026-08-22T01:00:00.000Z",
              active: false,
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("更换知识库 ZIP 版本"), {
      target: { value: "99999999-9999-4999-8999-999999999999" },
    });
    expect(
      screen.getByRole("button", { name: "更换知识源并重新整理" }),
    ).toBeDisabled();
  });

  it("keeps provider configuration failures visible without inventing candidates", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          providerState: {
            ...observation().providerState,
            twentyFirst: {
              status: "not_configured",
              reason: "请让系统管理员配置 21st API Key。",
            },
          },
          visualCandidates: [],
        })}
      />,
    );
    expect(
      screen.getByText("请让系统管理员配置 21st API Key。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^选择 [A-I]$/u })).toBeNull();
  });

  it("renders private preview and source actions for a ready build", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/source",
              qaUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/qa",
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "打开私有预览" })).toHaveAttribute(
      "href",
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
    );
    expect(
      screen.getByRole("link", { name: "下载源码 ZIP" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "批准这个版本" }),
    ).toBeInTheDocument();
  });

  it("does not offer a duplicate publish while the same target is pending", () => {
    const approvedBuild = {
      id: "33333333-3333-4333-8333-333333333333",
      ordinal: 2,
      parentBuildId: null,
      status: "approved" as const,
      previewUrl: null,
      sourceUrl: null,
      qaUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:01:00.000Z",
    };
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [approvedBuild],
          deployments: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              buildId: approvedBuild.id,
              target: "global_excluding_cn",
              status: "deploying",
              publicUrl: null,
              createdAt: "2026-08-22T00:02:00.000Z",
            },
          ],
          interactionState: "approved",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "海外站点发布中" }),
    ).toBeDisabled();
  });

  it("starts an explicit visual re-selection without mutating the live build", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl: null,
              sourceUrl: null,
              qaUrl: null,
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          project: { ...observation().project, status: "live" },
          interactionState: "live",
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重新选择视觉方向" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reselect_visual",
        input: {},
      }),
    );
  });

  it("offers append-only rollback for a superseded verified deployment", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          deployments: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              buildId: "33333333-3333-4333-8333-333333333333",
              target: "global_excluding_cn",
              status: "superseded",
              publicUrl: "https://example.com",
              createdAt: "2026-08-22T00:00:00.000Z",
            },
          ],
          interactionState: "live",
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "回滚海外版本 · 33333333" }),
    );
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "rollback",
        input: { deploymentId: "55555555-5555-4555-8555-555555555555" },
      }),
    );
  });

  it("shows the one-time ExternalId returned by customer RAM Role setup", async () => {
    const onSetupAliyun = vi.fn().mockResolvedValue({
      externalId: "external-id-once",
      trustedPrincipalArn: "acs:ram::100000000000:role/frontmind",
      trustPolicy: { Version: "1", Statement: [] },
      requiredPermissions: { daily: ["domain:CheckDomain"] },
      permissionPolicy: {
        Version: "1",
        Statement: [
          { Action: ["domain:CheckDomain"], Effect: "Allow", Resource: ["*"] },
        ],
      },
    });
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onSetupAliyun={onSetupAliyun}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("例如 123456789012"), {
      target: { value: "123456789012" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("acs:ram::账号UID:role/frontmind-siteops"),
      {
        target: {
          value: "acs:ram::123456789012:role/frontmind-siteops",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "生成连接配置" }));
    await waitFor(() =>
      expect(onSetupAliyun).toHaveBeenCalledWith({
        accountUid: "123456789012",
        roleArn: "acs:ram::123456789012:role/frontmind-siteops",
      }),
    );
    expect(await screen.findByText("external-id-once")).toBeInTheDocument();
    expect(screen.getByText("复制最小权限策略")).toBeInTheDocument();
  });

  it("requires exact domain text before submitting a quoted purchase", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            accountUid: "123456789012",
            roleArn: "acs:ram::123456789012:role/frontmind-siteops",
            externalIdFingerprint: "f".repeat(32),
            status: "active",
            capabilities: ["domain_read"],
            verifiedAt: "2026-08-22T00:00:00.000Z",
            lastErrorCode: null,
            canRotate: true,
          },
          domainOperations: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              kind: "purchase",
              domain: "example.com",
              displayDomain: "example.com",
              status: "succeeded",
              quoteHash: "b".repeat(64),
              quoteExpiresAt: "2099-08-22T00:01:00.000Z",
              amountMinor: 8_800,
              currency: "CNY",
              years: 1,
              maskedRegistrantName: "北**司",
              searchResult: null,
              registrantProfiles: [],
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        })}
        onAction={onAction}
      />,
    );
    const confirm = screen.getByRole("button", {
      name: "确认并从客户阿里云账号扣费",
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("完整输入 example.com"), {
      target: { value: "example.com" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "domain_confirm_purchase",
        input: {
          domain: "example.com",
          typedDomain: "example.com",
          quoteHash: "b".repeat(64),
          domainOperationId: "44444444-4444-4444-8444-444444444444",
        },
      }),
    );
  });

  it("explicitly confirms a read-only sync for a domain already in the customer account", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            accountUid: "123456789012",
            roleArn: "acs:ram::123456789012:role/frontmind-siteops",
            externalIdFingerprint: "f".repeat(32),
            status: "active",
            capabilities: ["domain_read"],
            verifiedAt: "2026-08-22T00:00:00.000Z",
            lastErrorCode: null,
            canRotate: true,
          },
        })}
        onAction={onAction}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("example.com"), {
      target: { value: "owned.example.com" },
    });
    const button = screen.getByRole("button", {
      name: "只读接入已有域名",
    });
    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("不会购买或扣费"),
    );

    confirm.mockReturnValueOnce(true);
    fireEvent.click(button);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "domain_sync",
        input: {
          domain: "owned.example.com",
          typedDomain: "owned.example.com",
          customerConfirmed: true,
        },
      }),
    );
    confirm.mockRestore();
  });

  it("shows the exact DNS plan and binds apply to its provider snapshot", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 4,
            registrar: "aliyun",
            providerAccountUid: "123456789012",
            expiresAt: null,
            realNameStatus: "verified",
            emailStatus: "verified",
            clientHold: false,
            ownershipStatus: "verified",
            dnsStatus: "planned",
            autoRenewDesired: false,
            autoRenewObserved: false,
            icpStatus: "not_submitted",
            icpDomainRevision: null,
            icpVerifiedAt: null,
          },
          dnsPlan: {
            operationId: "55555555-5555-4555-8555-555555555555",
            domain: "example.com",
            domainRevision: 4,
            planHash: "c".repeat(64),
            providerSnapshotHash: "d".repeat(64),
            canApply: true,
            status: "succeeded",
            items: [
              {
                id: "dns-1",
                action: "create",
                rr: "www",
                type: "CNAME",
                expectedValue: "edge.example.net",
                expectedTtl: 600,
                currentValue: null,
                currentTtl: null,
                reason: null,
              },
            ],
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.getByText("edge.example.net")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "应用 FrontMind DNS" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "dns_apply",
        input: {
          domainRevision: 4,
          planOperationId: "55555555-5555-4555-8555-555555555555",
          planHash: "c".repeat(64),
          providerSnapshotHash: "d".repeat(64),
        },
      }),
    );
  });

  it("requires explicit future-charge confirmation before enabling auto-renew", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 4,
            registrar: "aliyun",
            providerAccountUid: "123456789012",
            expiresAt: null,
            realNameStatus: "verified",
            emailStatus: "verified",
            clientHold: false,
            ownershipStatus: "verified",
            dnsStatus: "active",
            autoRenewDesired: false,
            autoRenewObserved: false,
            icpStatus: "not_submitted",
            icpDomainRevision: null,
            icpVerifiedAt: null,
          },
        })}
        onAction={onAction}
      />,
    );

    const button = screen.getByRole("button", { name: "开启自动续费" });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("按届时价格"));
    expect(onAction).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(button);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "domain_set_auto_renew",
        input: {
          domain: "example.com",
          enabled: true,
          customerConfirmed: true,
        },
      }),
    );
    confirm.mockRestore();
  });

  it("disables DNS apply when the exact plan contains a conflict", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 4,
            registrar: "aliyun",
            providerAccountUid: "123456789012",
            expiresAt: null,
            realNameStatus: "verified",
            emailStatus: "verified",
            clientHold: false,
            ownershipStatus: "verified",
            dnsStatus: "conflict",
            autoRenewDesired: false,
            autoRenewObserved: false,
            icpStatus: "not_submitted",
            icpDomainRevision: null,
            icpVerifiedAt: null,
          },
          dnsPlan: {
            operationId: "66666666-6666-4666-8666-666666666666",
            domain: "example.com",
            domainRevision: 4,
            planHash: "e".repeat(64),
            providerSnapshotHash: "f".repeat(64),
            canApply: false,
            status: "attention_required",
            items: [
              {
                id: "dns-2",
                action: "conflict",
                rr: "www",
                type: "CNAME",
                expectedValue: "edge.example.net",
                expectedTtl: 600,
                currentValue: "customer.example.org",
                currentTtl: 600,
                reason: "相同 RR/type 已有非 FrontMind 记录，拒绝覆盖。",
              },
            ],
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText(/相同 RR\/type/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "应用 FrontMind DNS" }),
    ).toBeDisabled();
  });

  it("submits the current domain through the existing ICP filing entry", async () => {
    const onSubmitIcpFiling = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 7,
            registrar: "aliyun_cn",
            providerAccountUid: "123456789012",
            expiresAt: null,
            realNameStatus: "verified",
            emailStatus: "verified",
            clientHold: false,
            ownershipStatus: "verified",
            dnsStatus: "active",
            autoRenewDesired: false,
            autoRenewObserved: false,
            icpStatus: "not_submitted",
            icpDomainRevision: null,
            icpVerifiedAt: null,
          },
        })}
        onSubmitIcpFiling={onSubmitIcpFiling}
      />,
    );

    fireEvent.change(screen.getByLabelText("当前域名版本的 ICP 主体备案号"), {
      target: { value: "京ICP备12345678号" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "提交现有 ICP 核验工单" }),
    );
    await waitFor(() =>
      expect(onSubmitIcpFiling).toHaveBeenCalledWith({
        domain: "example.com",
        icpNumber: "京ICP备12345678号",
      }),
    );
  });
});
