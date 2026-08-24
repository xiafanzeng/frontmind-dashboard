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
    serviceReadiness: {
      visuals: { status: "configured" },
      website: { status: "configured" },
      publishing: { status: "configured" },
      domain: { status: "not_configured" },
    },
    aliyunConnection: {
      configured: false,
      status: "not_connected",
      verifiedAt: null,
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
        note: "克制的编辑式布局",
        visualFamily: "editorial",
        selected: false,
      },
      {
        id: "candidate-b",
        label: "B",
        title: "精密技术型布局",
        previewUrl: "/api/local-assets/preview-b",
        note: "精密技术型布局",
        visualFamily: "split_media",
        selected: false,
      },
    ],
    builds: [],
    deployments: [],
    socialPackages: [],
    resetCapability: { allowed: true },
    rebuildRequest: {
      allowed: false,
      ticketId: null,
      status: null,
      resetApplied: false,
      resetSourceBuildId: null,
    },
    interactionState: "awaiting_visual_selection",
    latestSequence: 1,
    ...input,
  };
}

describe("SiteOpsConversationPanel", () => {
  it("does not surface the cancelled failed build after a confirmed reset", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "draft",
            currentKnowledgeSnapshotId: null,
          },
          interactionState: "select_snapshot",
          visualCandidates: [],
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 1,
              parentBuildId: null,
              status: "cancelled",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: true,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
        })}
      />,
    );
    expect(screen.queryByText(/官网版本 1/u)).toBeNull();
  });

  it("requires confirmation before submitting a fresh pre-build reset", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重置建站流程" }));
    expect(
      screen.getByRole("alertdialog", { name: "确认重置建站流程？" }),
    ).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", {
          name: "确认重置建站流程？",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重置建站流程" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reset_workflow",
        input: { confirmed: true },
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", {
          name: "确认重置建站流程？",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps reset visible but disabled with the server reason", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          resetCapability: {
            allowed: false,
            reason: "当前仍有任务正在执行或结果待确认，完成后才能重置。",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "重置建站流程" })).toBeDisabled();
    expect(
      screen.getByText("当前仍有任务正在执行或结果待确认，完成后才能重置。"),
    ).toBeInTheDocument();
  });

  it("sanitizes technical reset reasons and reset failures", async () => {
    const onAction = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "canonical hostname 的 RAM Role 与 global_excluding_cn 归档哈希不一致",
        ),
      );
    const { rerender } = render(
      <SiteOpsConversationPanel
        observation={observation({
          resetCapability: {
            allowed: false,
            reason: "mainland_cn 的 Hero 构图合同缺少归档哈希。",
          },
        })}
        onAction={onAction}
      />,
    );

    expect(document.body.textContent).not.toMatch(
      /canonical hostname|RAM Role|global_excluding_cn|mainland_cn|Hero|归档哈希/iu,
    );
    expect(
      screen.getByText(
        "FrontMind 正在处理当前任务；如长时间未完成，请提交工单获取协助。",
      ),
    ).toBeInTheDocument();

    rerender(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重置建站流程" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() =>
      expect(
        screen.getAllByText(
          "FrontMind 正在处理当前任务；如长时间未完成，请提交工单获取协助。",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(document.body.textContent).not.toMatch(
      /canonical hostname|RAM Role|global_excluding_cn|归档哈希/iu,
    );
  });

  it("hides internal error codes and operation ids from customers", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "failed",
          },
          interactionState: "failed",
          messages: [
            {
              id: "message-recovery",
              role: "assistant",
              content: "视觉检索任务合同不一致，请重置后重新开始。",
              sequence: 2,
              metadata: {
                siteOps: {
                  kind: "operation_recovery",
                  subjectId: "operation-safe-id",
                  revision: 3,
                  status: "active",
                  payload: {
                    errorCode: "VISUAL_OPERATION_CONTRACT_MISMATCH",
                  },
                },
              },
              sentAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          visualCandidates: [],
        })}
      />,
    );

    expect(
      screen.queryByText(/VISUAL_OPERATION_CONTRACT_MISMATCH/u),
    ).toBeNull();
    expect(screen.queryByText(/operation-safe-id/u)).toBeNull();
  });

  it("shows customer-facing visual candidates and submits only the selection", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={onAction}
        onSendMessage={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "AI友好官网管理" }),
    ).toBeInTheDocument();
    expect(screen.getByAltText("A：编辑杂志式")).toHaveAttribute(
      "src",
      "/api/local-assets/preview-a",
    );
    expect(screen.getByText("首页 · 编辑杂志式")).toBeInTheDocument();
    expect(screen.queryByText(/匹配度/u)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "9 个视觉候选" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/示例图片与文案不会复制到官网/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/相同的企业资料真实渲染/u)).toBeNull();
    expect(document.body.textContent).not.toMatch(/API Key|Base|Pro|Hero/iu);
    fireEvent.click(
      screen.getByRole("button", { name: "重新生成 9 个视觉候选" }),
    );
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "reselect_visual",
        input: {},
        messageId: "message-1",
        cardKind: "visual_board",
      }),
    );
    onAction.mockClear();
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

  it("delegates a visual choice without exposing an AI mode", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onAction={onAction}
      />,
    );

    expect(document.body.textContent).not.toMatch(/API Key|Base|Pro/iu);
    fireEvent.click(screen.getByRole("button", { name: "让 FrontMind 推荐" }));

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "delegate_visual",
        input: {},
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
      screen.getByRole("heading", { name: "已选择的视觉方案" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 A" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "让 FrontMind 推荐" }),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /已随官网版本锁定|Base|Pro/iu,
    );
  });

  it("does not expose a build-frozen AI mode after refresh", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "building" },
          interactionState: "building",
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 1,
              parentBuildId: null,
              status: "building",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
        })}
        onAction={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toMatch(/API Key|Base|Pro/iu);
  });

  it("uses a customer-safe service message when building is not configured", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          serviceReadiness: {
            ...observation().serviceReadiness,
            website: {
              status: "not_configured",
              reason: "Upstream provider credential is missing.",
            },
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText("AI 建站服务尚未就绪，请联系 FrontMind。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 A" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "让 FrontMind 推荐" }),
    ).toBeDisabled();
    expect(document.body.textContent).not.toMatch(
      /21st|Manus|Upstream|API Key/iu,
    );
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
              needsHelp: false,
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
          serviceReadiness: {
            ...observation().serviceReadiness,
            visuals: {
              status: "not_configured",
              reason: "请让系统管理员配置 21st API Key。",
            },
          },
          visualCandidates: [],
        })}
      />,
    );
    expect(
      screen.getByText("视觉参考服务尚未配置，暂时不能检索视觉方向。"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/21st/iu);
    expect(screen.queryByRole("button", { name: /^选择 [A-I]$/u })).toBeNull();
  });

  it("opens and focuses private preview in the reusable named tab", () => {
    const focus = vi.fn();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({ focus } as unknown as Window);
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
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );
    const previewButton = screen.getByRole("button", {
      name: "在新标签页打开预览",
    });
    fireEvent.click(previewButton);
    fireEvent.click(previewButton);
    expect(open).toHaveBeenNthCalledWith(
      1,
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
      "frontmind-siteops-preview",
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
      "frontmind-siteops-preview",
    );
    expect(focus).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("link", { name: "下载网站源码" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/QA 报告|批准这个版本/u)).toBeNull();
    open.mockRestore();
  });

  it("shows future blog and industry publishing as disabled on a completed website", () => {
    const onAction = vi.fn();
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
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={onAction}
      />,
    );

    const futurePublishing = screen.getByRole("button", {
      name: "发布博客与行业近况（即将上线）",
    });
    expect(futurePublishing).toBeDisabled();
    fireEvent.click(futurePublishing);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows a safe retry link when the private preview popup is blocked", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
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
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "在新标签页打开预览",
      }),
    );
    expect(
      screen.getByText("预览标签页被浏览器阻止，请允许此站点打开弹窗后重试。"),
    ).toBeInTheDocument();

    const retryLink = screen.getByRole("link", {
      name: "重试打开预览",
    });
    expect(retryLink).toHaveAttribute(
      "href",
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
    );
    expect(retryLink).toHaveAttribute("target", "frontmind-siteops-preview");
    fireEvent.click(retryLink);
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  it("does not expose renderer details or historical comparisons", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 4,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 5,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "preview_ready",
              previewUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          interactionState: "preview_ready",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toMatch(/Astro|React|历史版本对比/iu);
  });

  it("keeps the last successful preview available when a child rebuild fails", () => {
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({ focus: vi.fn() } as unknown as Window);
    const currentPreview =
      "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/";
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 4,
              parentBuildId: null,
              status: "approved",
              previewUrl: currentPreview,
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 5,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "failed",
              previewUrl: null,
              sourceUrl: null,
              needsHelp: true,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
          interactionState: "failed",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText("最新重制暂未完成，当前官网仍可继续预览和使用。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在新标签页打开预览" }));
    expect(open).toHaveBeenCalledWith(
      currentPreview,
      "frontmind-siteops-preview",
    );
    open.mockRestore();
  });

  it("does not offer a duplicate publish while the same target is pending", () => {
    const approvedBuild = {
      id: "33333333-3333-4333-8333-333333333333",
      ordinal: 2,
      parentBuildId: null,
      status: "approved" as const,
      previewUrl: null,
      sourceUrl: null,
      needsHelp: false,
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

  it("submits a rebuild ticket instead of directly reselecting visuals", async () => {
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
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          project: { ...observation().project, status: "live" },
          interactionState: "live",
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.queryByRole("button", { name: "重置建站流程" })).toBeNull();
    fireEvent.click(
      screen.getAllByRole("button", { name: "提交官网重制需求" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("重制原因与期望（选填）"), {
      target: { value: "希望调整品牌风格" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交需求" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: { reason: "希望调整品牌风格" },
      }),
    );
  });

  it("hides the previous website surface after an approved rebuild reset", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: {
            ...observation().project,
            status: "draft",
            currentKnowledgeSnapshotId: null,
          },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/source",
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "in_progress",
            resetApplied: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "select_snapshot",
        })}
        onAction={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "选择知识库 ZIP 版本" }),
    ).toBeInTheDocument();
    expect(screen.getByText("当前阶段").parentElement).toHaveTextContent(
      "选择知识库 ZIP 版本",
    );
    expect(screen.queryByText("官网版本 2")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "在新标签页打开预览" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "下载网站源码" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "再次提交官网重制需求" }),
    ).toBeEnabled();
    expect(screen.queryByText("重制需求处理中")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "发布博客与行业近况（即将上线）",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("继续对话")).not.toBeInTheDocument();
  });

  it.each([
    "visual_searching",
    "awaiting_visual_selection",
    "building",
  ] as const)(
    "allows a reset request while the first workflow is %s",
    (status) => {
      render(
        <SiteOpsConversationPanel
          observation={observation({
            project: { ...observation().project, status },
            builds:
              status === "building"
                ? [
                    {
                      id: "33333333-3333-4333-8333-333333333333",
                      ordinal: 1,
                      parentBuildId: null,
                      status: "building",
                      previewUrl: null,
                      sourceUrl: null,
                      needsHelp: false,
                      createdAt: "2026-08-22T00:00:00.000Z",
                      updatedAt: "2026-08-22T00:01:00.000Z",
                    },
                  ]
                : [],
            interactionState: status,
            rebuildRequest: {
              allowed: true,
              ticketId: null,
              status: null,
              resetApplied: false,
              resetSourceBuildId: null,
            },
          })}
          onAction={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", { name: "提交官网重制需求" }),
      ).toBeEnabled();
    },
  );

  it("submits a reset request before a completed website exists", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          builds: [],
          rebuildRequest: {
            allowed: true,
            ticketId: null,
            status: null,
            resetApplied: false,
            resetSourceBuildId: null,
          },
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交官网重制需求" }));
    fireEvent.click(screen.getByRole("button", { name: "提交需求" }));

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        action: "request_rebuild",
        input: {},
      }),
    );
  });

  it("keeps the existing website visible before a submitted rebuild is approved", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "live" },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/source",
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: false,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "submitted",
            resetApplied: false,
            resetSourceBuildId: null,
          },
          interactionState: "live",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("官网版本 2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "下载网站源码" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "发布博客与行业近况（即将上线）",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重制需求处理中" })).toEqual(
      expect.arrayContaining([expect.any(HTMLButtonElement)]),
    );
    expect(
      screen
        .getAllByRole("button", { name: "重制需求处理中" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps a newly completed replacement visible while a second reset request awaits approval", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "approved" },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 3,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/preview/",
              sourceUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/source",
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: false,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "submitted",
            resetApplied: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "approved",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("官网版本 3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重制需求处理中" })).toEqual(
      expect.arrayContaining([expect.any(HTMLButtonElement)]),
    );
  });

  it("restores the completed replacement website after the rebuild ticket completes", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          project: { ...observation().project, status: "approved" },
          builds: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordinal: 2,
              parentBuildId: null,
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
              sourceUrl: null,
              needsHelp: false,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:01:00.000Z",
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              ordinal: 3,
              parentBuildId: "33333333-3333-4333-8333-333333333333",
              status: "approved",
              previewUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/preview/",
              sourceUrl:
                "/api/site-ops/builds/44444444-4444-4444-8444-444444444444/source",
              needsHelp: false,
              createdAt: "2026-08-23T00:00:00.000Z",
              updatedAt: "2026-08-23T00:01:00.000Z",
            },
          ],
          rebuildRequest: {
            allowed: true,
            ticketId: "77777777-7777-4777-8777-777777777777",
            status: "completed",
            resetApplied: true,
            resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
          },
          interactionState: "approved",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("官网版本 3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在新标签页打开预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "下载网站源码" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "发布博客与行业近况（即将上线）",
      }),
    ).toBeInTheDocument();
  });

  it.each([
    ["collecting_brief", "整理建站资料"],
    ["visual_searching", "生成视觉候选"],
    ["awaiting_visual_selection", "等待选择视觉方案"],
  ] as const)(
    "keeps the approved rebuild on the current %s stage before its child build exists",
    (interactionState, stageLabel) => {
      render(
        <SiteOpsConversationPanel
          observation={observation({
            project: {
              ...observation().project,
              status: interactionState,
            },
            builds: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                ordinal: 2,
                parentBuildId: null,
                status: "approved",
                previewUrl:
                  "/api/site-ops/builds/33333333-3333-4333-8333-333333333333/preview/",
                sourceUrl: null,
                needsHelp: false,
                createdAt: "2026-08-22T00:00:00.000Z",
                updatedAt: "2026-08-22T00:01:00.000Z",
              },
            ],
            rebuildRequest: {
              allowed: false,
              ticketId: "77777777-7777-4777-8777-777777777777",
              status: "in_progress",
              resetApplied: true,
              resetSourceBuildId: "33333333-3333-4333-8333-333333333333",
            },
            interactionState,
          })}
          onAction={vi.fn()}
          onSendMessage={vi.fn()}
        />,
      );

      expect(screen.getByText("当前阶段").parentElement).toHaveTextContent(
        stageLabel,
      );
      expect(screen.getByText("当前阶段").parentElement).not.toHaveTextContent(
        "官网已完成",
      );
    },
  );

  it("keeps deployment rollback out of the customer workspace", () => {
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

    expect(screen.queryByText("历史发布与回滚")).toBeNull();
    expect(screen.queryByRole("button", { name: /回滚海外版本/u })).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("opens official Alibaba authorization without exposing technical fields", async () => {
    const onBeginAliyun = vi.fn().mockResolvedValue({
      authorizationUrl: "https://signin.aliyun.com/oauth/authorize",
      expiresAt: "2026-08-23T01:00:00.000Z",
    });
    const authorizationWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation()}
        onBeginAliyun={onBeginAliyun}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "连接阿里云" }));
    await waitFor(() => expect(onBeginAliyun).toHaveBeenCalledOnce());
    expect(authorizationWindow.location.href).toBe(
      "https://signin.aliyun.com/oauth/authorize",
    );
    expect(document.body.textContent).not.toMatch(
      /UID|ARN|ExternalId|AccessKey|RAM Role|STS/iu,
    );
    open.mockRestore();
  });

  it("guides an identified account through official authorization", async () => {
    const onLoadAliyunAuthorizationGuide = vi.fn().mockResolvedValue({
      available: true,
      consoleUrl: "https://ram.console.aliyun.com/roles/create",
      configurationDownloadUrl: "/api/site-ops/aliyun/authorization-config",
      roleName: "FrontMindSiteOpsAccess",
      trustPolicyText: '{"trust":true}',
      permissionPolicyText: '{"permission":true}',
    });
    const onVerifyAliyun = vi.fn().mockResolvedValue(undefined);
    const authorizationWindow = {
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(authorizationWindow as unknown as Window);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: false,
            status: "authorization_required",
            verifiedAt: null,
            canRotate: true,
          },
        })}
        onLoadAliyunAuthorizationGuide={onLoadAliyunAuthorizationGuide}
        onVerifyAliyun={onVerifyAliyun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "前往阿里云完成授权" }));
    await waitFor(() =>
      expect(onLoadAliyunAuthorizationGuide).toHaveBeenCalledOnce(),
    );
    expect(authorizationWindow.location.href).toBe(
      "https://ram.console.aliyun.com/roles/create",
    );
    expect(
      await screen.findByRole("link", { name: "下载备用配置" }),
    ).toHaveAttribute("href", "/api/site-ops/aliyun/authorization-config");
    fireEvent.click(screen.getByRole("button", { name: "我已完成授权" }));
    await waitFor(() => expect(onVerifyAliyun).toHaveBeenCalledOnce());
    open.mockRestore();
  });

  it("requires exact domain text before submitting a quoted purchase", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          aliyunConnection: {
            configured: true,
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
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
              issue: null,
              createdAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        })}
        onAction={onAction}
      />,
    );
    const confirm = screen.getByRole("button", {
      name: "确认并从已连接的阿里云账号扣费",
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
            status: "active",
            verifiedAt: "2026-08-22T00:00:00.000Z",
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
      name: "接入已有域名",
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

  it("keeps exact DNS planning details out of the customer view", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 4,
            registrar: "aliyun",
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
            canApply: true,
            status: "succeeded",
            changeCount: 1,
            conflictCount: 0,
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.queryByText("edge.example.net")).toBeNull();
    expect(screen.queryByText(/DNS 精确差异|供应商快照/u)).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
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

  it("does not expose DNS conflict tuples to customers", () => {
    render(
      <SiteOpsConversationPanel
        observation={observation({
          domainState: {
            domain: "example.com",
            displayDomain: "example.com",
            revision: 4,
            registrar: "aliyun",
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
            canApply: false,
            status: "attention_required",
            changeCount: 1,
            conflictCount: 1,
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText(/相同 RR\/type/)).toBeNull();
    expect(screen.queryByRole("button", { name: /DNS/u })).toBeNull();
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
