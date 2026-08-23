import type {
  SiteOpsAgentProfile,
  SiteOpsMessageProjection,
  SiteOpsObservationV1,
  SiteOpsPublicVisualCandidate,
} from "@shared/siteops-contract";
import type { SiteOpsActInput } from "@shared/siteops";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AlertCircle,
  Bot,
  Check,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import "./siteops-conversation-panel.css";

type SiteOpsActionContext = Pick<
  SiteOpsActInput,
  "action" | "input" | "messageId" | "cardKind"
>;

export type SiteOpsConversationPanelProps = {
  observation: SiteOpsObservationV1 | null;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  onRefresh?: () => Promise<void> | void;
  onSendMessage?: (text: string) => Promise<void> | void;
  onAction?: (input: SiteOpsActionContext) => Promise<void> | void;
  onSetupAliyun?: (input: { accountUid: string; roleArn: string }) => Promise<{
    externalId: string;
    trustedPrincipalArn: string | null;
    trustPolicy: Record<string, unknown> | null;
    requiredPermissions: Record<string, readonly string[]>;
    permissionPolicy: Record<string, unknown>;
  }>;
  onVerifyAliyun?: () => Promise<void> | void;
  onDisconnectAliyun?: () => Promise<void> | void;
  onSubmitIcpFiling?: (input: {
    domain: string;
    icpNumber: string;
  }) => Promise<void> | void;
};

const BUILD_STATUS_LABELS: Record<string, string> = {
  preparing: "准备构建资料",
  visual_searching: "检索视觉方向",
  awaiting_visual_selection: "等待选择视觉方向",
  design_compiling: "编译视觉与 SEO 契约",
  contract_ready: "建站契约已就绪",
  building: "生成原生 Astro 官网",
  qa_running: "执行静态、SEO 与视觉 QA",
  preview_ready: "私有预览已就绪",
  approved: "客户已批准",
  failed: "构建失败",
  attention_required: "需要人工处理",
  cancelled: "已取消",
  superseded: "已被新版本替代",
};

const CARD_LABELS: Record<string, string> = {
  brief_question: "建站资料",
  visual_board: "视觉方向",
  visual_choice: "视觉选择",
  build_progress: "构建进度",
  build_preview: "私有预览",
  qa_failed: "质量检查",
  publish_options: "发布选择",
  domain_quote: "域名报价",
  domain_status: "域名状态",
  icp_status: "ICP 状态",
  content_review: "内容核对",
  social_package: "内容包",
  operation_recovery: "任务恢复",
  release_status: "发布状态",
};

const PRIVATE_PREVIEW_WINDOW_NAME = "frontmind-siteops-preview";

function activeCardMessage(
  messages: SiteOpsMessageProjection[],
  kind: SiteOpsActionContext["cardKind"],
  currentRevision: number,
) {
  return [...messages].reverse().find((message) => {
    const card = message.metadata?.siteOps;
    return Boolean(
      card &&
        card.kind === kind &&
        card.status === "active" &&
        card.revision === currentRevision,
    );
  });
}

function actionFromCard(
  observation: SiteOpsObservationV1,
  cardKind: SiteOpsActionContext["cardKind"],
  action: SiteOpsActionContext["action"],
  input: Record<string, unknown>,
): SiteOpsActionContext {
  const message = activeCardMessage(
    observation.messages,
    cardKind,
    observation.project.revision,
  );
  return {
    action,
    input,
    ...(message ? { messageId: message.id, cardKind } : {}),
  };
}

function providerMessage(observation: SiteOpsObservationV1) {
  const provider = observation.providerState.twentyFirst;
  if (provider.status === "configured") return null;
  return provider.status === "not_configured"
    ? "视觉参考服务尚未配置，暂时不能检索视觉方向。"
    : "视觉参考服务暂时不可用，请稍后重试或联系系统管理员。";
}

function aiBuilderMessage(observation: SiteOpsObservationV1) {
  const provider = observation.providerState.aiBuilder;
  if (provider.status === "configured") return null;
  return provider.status === "not_configured"
    ? "请先为当前账号配置个人 AI 建站 API Key，配置完成后才能锁定视觉并开始建站。"
    : "当前账号的 AI 建站连接需要处理，恢复后才能锁定视觉并开始建站。";
}

function visualCandidatePresentation(candidate: SiteOpsPublicVisualCandidate) {
  const variantLabels = {
    centered_statement: "居中陈述",
    split_media: "分屏媒体",
    editorial_modular: "编辑模块",
    immersive_visual: "沉浸视觉",
  } as const;
  return {
    badge: candidate.heroVariant
      ? `Hero · ${variantLabels[candidate.heroVariant]}`
      : "Hero · 首页视觉",
    title: candidate.title,
    note:
      candidate.note && candidate.note !== candidate.title
        ? candidate.note
        : null,
  };
}

function VisualCandidateCard({
  candidate,
  disabled,
  onSelect,
}: {
  candidate: SiteOpsPublicVisualCandidate;
  disabled: boolean;
  onSelect: () => void;
}) {
  const presentation = visualCandidatePresentation(candidate);
  return (
    <article
      className="siteops-visual-card"
      data-selected={candidate.selected ? "true" : "false"}
    >
      <div className="siteops-visual-preview">
        <img
          src={candidate.previewUrl}
          alt={`${candidate.label}：${presentation.title}`}
        />
        <span>{candidate.label}</span>
      </div>
      <div className="siteops-visual-copy">
        <div>
          <strong>{presentation.title}</strong>
          <small className="siteops-hero-badge">{presentation.badge}</small>
        </div>
        {presentation.note && <p>{presentation.note}</p>}
        <button
          type="button"
          className="siteops-primary-button"
          disabled={disabled || candidate.selected}
          onClick={onSelect}
        >
          {candidate.selected && <Check size={15} aria-hidden="true" />}
          {candidate.selected ? "已选择" : `选择 ${candidate.label}`}
        </button>
      </div>
    </article>
  );
}

export default function SiteOpsConversationPanel({
  observation,
  loading = false,
  refreshing = false,
  error = null,
  onRefresh,
  onSendMessage,
  onAction,
  onSetupAliyun,
  onVerifyAliyun,
  onDisconnectAliyun,
  onSubmitIcpFiling,
}: SiteOpsConversationPanelProps) {
  const [message, setMessage] = useState("");
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewOpenError, setPreviewOpenError] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [managedAgentProfile, setManagedAgentProfile] =
    useState<SiteOpsAgentProfile>("frontmind-pro");
  const [aliyunAccountUid, setAliyunAccountUid] = useState("");
  const [aliyunRoleArn, setAliyunRoleArn] = useState("");
  const [aliyunSetup, setAliyunSetup] = useState<{
    externalId: string;
    trustedPrincipalArn: string | null;
    trustPolicy: Record<string, unknown> | null;
    requiredPermissions: Record<string, readonly string[]>;
    permissionPolicy: Record<string, unknown>;
  } | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [domainYears, setDomainYears] = useState(1);
  const [typedDomain, setTypedDomain] = useState("");
  const [registrantProfileId, setRegistrantProfileId] = useState("");
  const [icpNumber, setIcpNumber] = useState("");
  const latestBuild = useMemo(() => {
    const visibleBuilds = observation?.builds.filter(
      (build) => !["cancelled", "superseded"].includes(build.status),
    );
    return (
      visibleBuilds?.reduce(
        (latest, build) =>
          !latest || build.ordinal > latest.ordinal ? build : latest,
        visibleBuilds[0],
      ) ?? null
    );
  }, [observation?.builds]);
  const historicalPreviewBuilds = useMemo(
    () =>
      observation?.builds
        .filter(
          (build) =>
            build.id !== latestBuild?.id &&
            Boolean(build.previewUrl) &&
            !["cancelled"].includes(build.status),
        )
        .sort((left, right) => right.ordinal - left.ordinal) ?? [],
    [latestBuild?.id, observation?.builds],
  );

  useEffect(() => {
    if (latestBuild?.agentProfile) {
      setManagedAgentProfile(latestBuild.agentProfile);
    }
  }, [latestBuild?.agentProfile]);

  useEffect(() => {
    setPreviewOpenError(null);
  }, [latestBuild?.previewUrl]);

  function openPrivatePreview(previewUrl: string) {
    setPreviewOpenError(null);
    const previewWindow = window.open(
      previewUrl,
      PRIVATE_PREVIEW_WINDOW_NAME,
    );
    if (!previewWindow) {
      setPreviewOpenError(
        "预览标签页被浏览器阻止，请允许此站点打开弹窗后重试。",
      );
      return;
    }
    previewWindow.focus();
  }

  async function runAction(key: string, input: SiteOpsActionContext) {
    if (!onAction || busyAction) return;
    setBusyAction(key);
    setLocalError(null);
    try {
      await onAction(input);
    } catch (actionError) {
      setLocalError(
        actionError instanceof Error
          ? actionError.message
          : "操作没有完成，请刷新后重试。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !onSendMessage || busyAction) return;
    setBusyAction("message");
    setLocalError(null);
    try {
      await onSendMessage(text);
      setMessage("");
    } catch (messageError) {
      setLocalError(
        messageError instanceof Error
          ? messageError.message
          : "消息发送失败，请稍后重试。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function resetWorkflow() {
    if (!onAction || busyAction || !observation?.resetCapability.allowed) {
      return;
    }
    setBusyAction("reset_workflow");
    setLocalError(null);
    setResetError(null);
    try {
      await onAction({
        action: "reset_workflow",
        input: { confirmed: true },
      });
      setMessage("");
      setSelectedSnapshotId("");
      setManagedAgentProfile("frontmind-pro");
      setLocalError(null);
      setResetDialogOpen(false);
    } catch (resetActionError) {
      const message =
        resetActionError instanceof Error
          ? resetActionError.message
          : "AI 建站流程没有重置，请刷新后重试。";
      setResetError(message);
      setLocalError(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function setupAliyun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSetupAliyun || busyAction) return;
    setBusyAction("aliyun_setup");
    setLocalError(null);
    try {
      setAliyunSetup(
        await onSetupAliyun({
          accountUid: aliyunAccountUid.trim(),
          roleArn: aliyunRoleArn.trim(),
        }),
      );
    } catch (setupError) {
      setLocalError(
        setupError instanceof Error
          ? setupError.message
          : "阿里云 RAM Role 连接没有保存。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function runConnectionAction(
    key: string,
    action: (() => Promise<void> | void) | undefined,
  ) {
    if (!action || busyAction) return;
    setBusyAction(key);
    setLocalError(null);
    try {
      await action();
      if (key === "aliyun_disconnect") setAliyunSetup(null);
    } catch (connectionError) {
      setLocalError(
        connectionError instanceof Error
          ? connectionError.message
          : "阿里云连接操作没有完成。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function submitIcpFiling(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = observation?.domainState?.domain;
    const number = icpNumber.trim();
    if (!domain || !number || !onSubmitIcpFiling || busyAction) return;
    setBusyAction("icp_filing");
    setLocalError(null);
    try {
      await onSubmitIcpFiling({ domain, icpNumber: number });
      setIcpNumber("");
    } catch (filingError) {
      setLocalError(
        filingError instanceof Error
          ? filingError.message
          : "ICP 备案结果工单没有提交成功。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  if (loading && !observation) {
    return (
      <section
        className="siteops-panel siteops-panel-state"
        aria-label="对话式 AI 建站"
      >
        <Loader2 className="siteops-spin" size={22} aria-hidden="true" />
        正在打开 AI 建站会话…
      </section>
    );
  }

  if (!observation) {
    return (
      <section
        className="siteops-panel siteops-panel-state"
        aria-label="对话式 AI 建站"
      >
        <AlertCircle size={22} aria-hidden="true" />
        <div>
          <strong>AI 建站会话暂时不可用</strong>
          <p>{error || "请稍后刷新重试。"}</p>
        </div>
        {onRefresh && (
          <button type="button" onClick={() => onRefresh()}>
            重新载入
          </button>
        )}
      </section>
    );
  }

  const upstreamMessage = providerMessage(observation);
  const builderMessage = aiBuilderMessage(observation);
  const aiBuilderConfigured =
    observation.providerState.aiBuilder.status === "configured";
  const interactionLocked = Boolean(busyAction || !onAction);
  const visualSelectionOpen =
    observation.interactionState === "awaiting_visual_selection";
  const agentProfileLocked = interactionLocked || !visualSelectionOpen;
  const visualSelectionDisabled =
    interactionLocked || !visualSelectionOpen || !aiBuilderConfigured;
  const currentSnapshotId = observation.project.currentKnowledgeSnapshotId;
  const effectiveSnapshotId = selectedSnapshotId || currentSnapshotId || "";
  const latestQuote = observation.domainOperations.find(
    (item) =>
      (["quoted", "succeeded"].includes(item.status) ||
        (item.status === "attention_required" &&
          item.errorCode === "QUOTE_CHANGED")) &&
      item.quoteHash &&
      item.quoteExpiresAt &&
      new Date(item.quoteExpiresAt).getTime() > Date.now() &&
      (item.kind === "purchase" || item.kind === "renewal"),
  );
  const latestSearch = observation.domainOperations.find(
    (item) => item.kind === "search" && item.searchResult,
  );
  const managedDomain = observation.domainState?.domain ?? "";
  const currentDnsPlan =
    observation.dnsPlan &&
    observation.domainState &&
    observation.dnsPlan.domain === observation.domainState.domain &&
    observation.dnsPlan.domainRevision === observation.domainState.revision
      ? observation.dnsPlan
      : null;
  const availableRegistrantProfiles =
    observation.domainOperations.find(
      (item) => item.registrantProfiles.length > 0,
    )?.registrantProfiles ?? [];
  const deploymentStateFor = (
    target: "global_excluding_cn" | "mainland_cn",
  ) => {
    const pending = observation.deployments.find(
      (deployment) =>
        deployment.target === target &&
        ["reserved", "deploying", "verifying"].includes(deployment.status),
    );
    const active = observation.deployments.find(
      (deployment) =>
        deployment.target === target && deployment.status === "active",
    );
    return { pending, active };
  };
  const globalDeployment = deploymentStateFor("global_excluding_cn");
  const mainlandDeployment = deploymentStateFor("mainland_cn");
  const sourceChangeBlocked =
    observation.interactionState === "visual_searching" ||
    observation.builds.some((build) =>
      [
        "preparing",
        "visual_searching",
        "awaiting_visual_selection",
        "design_compiling",
        "contract_ready",
        "building",
        "qa_running",
      ].includes(build.status),
    ) ||
    observation.deployments.some((deployment) =>
      ["reserved", "deploying", "verifying"].includes(deployment.status),
    );
  const resetDisabled =
    !onAction || Boolean(busyAction) || !observation.resetCapability.allowed;
  const resetDisabledReason = !observation.resetCapability.allowed
    ? observation.resetCapability.reason
    : undefined;

  return (
    <section className="siteops-panel" aria-labelledby="siteops-panel-title">
      <header className="siteops-panel-header">
        <div>
          <p>
            <Sparkles size={15} aria-hidden="true" />
            SiteOps · 原生 Astro
          </p>
          <h2 id="siteops-panel-title">对话式 AI 建站</h2>
          <span>
            选择知识库版本、确定视觉方向，然后在同一会话中完成构建与预览。
          </span>
        </div>
        <div className="siteops-header-controls">
          <div className="siteops-header-actions">
            {onRefresh && (
              <button
                type="button"
                className="siteops-icon-button"
                aria-label="刷新 AI 建站会话"
                disabled={refreshing}
                onClick={() => onRefresh()}
              >
                <RefreshCw
                  className={refreshing ? "siteops-spin" : undefined}
                  size={17}
                  aria-hidden="true"
                />
              </button>
            )}
            <button
              type="button"
              className="siteops-icon-button siteops-reset-button"
              aria-label="重置 AI 建站流程"
              aria-describedby={
                resetDisabledReason
                  ? "siteops-reset-disabled-reason"
                  : undefined
              }
              disabled={resetDisabled}
              title={resetDisabledReason}
              onClick={() => {
                setResetError(null);
                setResetDialogOpen(true);
              }}
            >
              <RotateCcw size={17} aria-hidden="true" />
            </button>
          </div>
          {resetDisabledReason && (
            <small
              className="siteops-reset-disabled-reason"
              id="siteops-reset-disabled-reason"
            >
              {resetDisabledReason}
            </small>
          )}
        </div>
      </header>

      <AlertDialog
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (busyAction === "reset_workflow") return;
          setResetDialogOpen(open);
          if (open) setResetError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认重置 AI 建站流程？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="siteops-reset-description">
                <p>当前未完成的会话会被隐藏，知识库选择和视觉候选会被清空。</p>
                <ul>
                  <li>旧任务不会恢复或续跑。</li>
                  <li>重置后需要全新上传或重新选择知识库。</li>
                  <li>域名、备案和阿里云连接不会被删除。</li>
                  <li>正在执行或结果待确认的任务结束前不能重置。</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {resetError && (
            <p className="siteops-reset-error" role="alert">
              {resetError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === "reset_workflow"}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busyAction === "reset_workflow"}
              onClick={(event) => {
                event.preventDefault();
                void resetWorkflow();
              }}
            >
              {busyAction === "reset_workflow" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              确认重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {upstreamMessage && (
        <div className="siteops-notice warning" role="status">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{upstreamMessage}</span>
        </div>
      )}
      {(error || localError) && (
        <div className="siteops-notice error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{localError || error}</span>
        </div>
      )}

      <div className="siteops-stage" data-state={observation.interactionState}>
        <span>当前阶段</span>
        <strong>
          {latestBuild
            ? BUILD_STATUS_LABELS[latestBuild.status] || latestBuild.status
            : observation.interactionState === "select_snapshot"
              ? "选择知识库 ZIP 版本"
              : "整理建站资料"}
        </strong>
        <small>项目版本 {observation.project.revision}</small>
      </div>

      {(observation.interactionState === "select_snapshot" ||
        !currentSnapshotId) && (
        <section
          className="siteops-snapshot-card"
          aria-labelledby="siteops-snapshot-title"
        >
          <div>
            <FileArchive size={20} aria-hidden="true" />
            <div>
              <h3 id="siteops-snapshot-title">选择知识库 ZIP 版本</h3>
              <p>建站会冻结所选不可变快照；以后更换知识源会创建新版本。</p>
            </div>
          </div>
          {observation.knowledgeSnapshots.length > 0 ? (
            <div className="siteops-snapshot-actions">
              <label>
                <span>知识库版本</span>
                <select
                  aria-label="知识库 ZIP 版本"
                  value={effectiveSnapshotId}
                  onChange={(event) =>
                    setSelectedSnapshotId(event.target.value)
                  }
                >
                  <option value="">请选择</option>
                  {observation.knowledgeSnapshots.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {snapshot.label}
                      {snapshot.active ? "（当前）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="siteops-primary-button"
                disabled={!effectiveSnapshotId || interactionLocked}
                onClick={() =>
                  runAction(
                    "select_snapshot",
                    actionFromCard(
                      observation,
                      "brief_question",
                      "select_snapshot",
                      { knowledgeSnapshotId: effectiveSnapshotId },
                    ),
                  )
                }
              >
                {busyAction === "select_snapshot" && (
                  <Loader2
                    className="siteops-spin"
                    size={15}
                    aria-hidden="true"
                  />
                )}
                使用此版本
              </button>
            </div>
          ) : (
            <p className="siteops-empty-copy">
              当前没有可用于建站的知识库快照。
            </p>
          )}
        </section>
      )}

      {currentSnapshotId && observation.knowledgeSnapshots.length > 1 && (
        <section
          className="siteops-snapshot-card"
          aria-labelledby="siteops-change-snapshot-title"
        >
          <div>
            <FileArchive size={20} aria-hidden="true" />
            <div>
              <h3 id="siteops-change-snapshot-title">更换知识源</h3>
              <p>
                新快照会重新生成 SiteBrief
                与视觉方向；旧源码、预览及线上版本不会被改写。
              </p>
            </div>
          </div>
          <div className="siteops-snapshot-actions">
            <label>
              <span>更换知识库 ZIP 版本</span>
              <select
                aria-label="更换知识库 ZIP 版本"
                value={effectiveSnapshotId}
                onChange={(event) => setSelectedSnapshotId(event.target.value)}
              >
                {observation.knowledgeSnapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.label}
                    {snapshot.id === currentSnapshotId ? "（当前）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="siteops-secondary-button"
              disabled={
                !effectiveSnapshotId ||
                effectiveSnapshotId === currentSnapshotId ||
                interactionLocked ||
                sourceChangeBlocked
              }
              onClick={() => {
                const selected = observation.knowledgeSnapshots.find(
                  (snapshot) => snapshot.id === effectiveSnapshotId,
                );
                if (
                  !selected ||
                  !window.confirm(
                    `确认更换为“${selected.label}”并重新整理 SiteBrief？旧官网版本和线上站点会保持不变。`,
                  )
                ) {
                  return;
                }
                void runAction(
                  "change_snapshot",
                  actionFromCard(
                    observation,
                    "brief_question",
                    "change_snapshot",
                    { knowledgeSnapshotId: effectiveSnapshotId },
                  ),
                );
              }}
            >
              更换知识源并重新整理
            </button>
          </div>
          {sourceChangeBlocked && (
            <p className="siteops-empty-copy">
              当前视觉、建站或发布任务尚未结束，完成后才能更换知识源。
            </p>
          )}
        </section>
      )}

      {currentSnapshotId &&
        observation.interactionState === "collecting_brief" && (
          <section
            className="siteops-snapshot-card siteops-brief-card"
            aria-labelledby="siteops-brief-title"
          >
            <div>
              <FileArchive size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-brief-title">SiteBrief 核对</h3>
                <p>
                  {observation.brief
                    ? `${observation.brief.companyName} · ${observation.brief.primaryLanguage}`
                    : "正在整理知识库中的可公开事实。"}
                </p>
              </div>
            </div>
            {observation.brief && (
              <div className="siteops-brief-summary">
                <p>
                  <strong>转化目标：</strong>
                  {observation.brief.conversionGoal}
                </p>
                <p>
                  <strong>目标受众：</strong>
                  {observation.brief.audience.join("、")}
                </p>
                <p>
                  <strong>页面：</strong>
                  {observation.brief.routes
                    .map((route) => route.title)
                    .join("、")}
                </p>
                <p>
                  <strong>已确认联系方式：</strong>
                  {observation.brief.contacts.length > 0
                    ? observation.brief.contacts
                        .map((contact) => contact.value)
                        .join("、")
                    : "暂无"}
                </p>
                {observation.brief.unknowns.length > 0 && (
                  <p>
                    <strong>仍可补充：</strong>
                    {observation.brief.unknowns.join("；")}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

      {currentSnapshotId &&
        observation.interactionState === "collecting_brief" && (
          <section
            className="siteops-snapshot-card"
            aria-labelledby="siteops-visual-search-title"
          >
            <div>
              <Sparkles size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-visual-search-title">开始检索视觉方向</h3>
                <p>
                  可先在下方补充转化目标；准备好后将从视觉目录检索真实候选。
                </p>
              </div>
            </div>
            <button
              type="button"
              className="siteops-primary-button"
              disabled={interactionLocked || Boolean(upstreamMessage)}
              onClick={() =>
                runAction(
                  "start_visual_search",
                  actionFromCard(
                    observation,
                    "brief_question",
                    "start_visual_search",
                    {},
                  ),
                )
              }
            >
              {busyAction === "start_visual_search" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              检索 A–I 视觉方向
            </button>
          </section>
        )}

      <div className="siteops-message-list" aria-label="AI 建站对话记录">
        {observation.messages.length === 0 ? (
          <div className="siteops-empty-copy">
            选择知识库版本后，AI 会在这里整理 SiteBrief。
          </div>
        ) : (
          observation.messages.map((item) => (
            <article
              className="siteops-message"
              data-role={item.role}
              key={item.id}
            >
              <span className="siteops-message-avatar" aria-hidden="true">
                {item.role === "user" ? (
                  <UserRound size={16} />
                ) : (
                  <Bot size={16} />
                )}
              </span>
              <div>
                <div className="siteops-message-meta">
                  <strong>{item.role === "user" ? "你" : "AI 建站"}</strong>
                  {item.metadata?.siteOps && (
                    <span data-status={item.metadata.siteOps.status}>
                      {CARD_LABELS[item.metadata.siteOps.kind] ||
                        item.metadata.siteOps.kind}
                    </span>
                  )}
                </div>
                <p>{item.content}</p>
                {item.metadata?.siteOps?.kind === "operation_recovery" && (
                  <p className="siteops-operation-reference">
                    {typeof item.metadata.siteOps.payload.errorCode ===
                      "string" && (
                      <span>
                        错误码：{item.metadata.siteOps.payload.errorCode}
                      </span>
                    )}
                    <span>任务编号：{item.metadata.siteOps.subjectId}</span>
                  </p>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {observation.visualCandidates.length > 0 && (
        <section
          className="siteops-visual-board"
          aria-labelledby="siteops-visual-title"
        >
          <div className="siteops-board-heading">
            <div>
              <h3 id="siteops-visual-title">
                {visualSelectionOpen
                  ? "选择首页 Hero 视觉方向"
                  : "已锁定的首页 Hero 视觉方向"}
              </h3>
              <p>
                以下均为视觉目录返回并通过 Hero
                资格校验的真实预览。选择只决定首页视觉语言，不复制组件代码或示例内容。
              </p>
            </div>
            {visualSelectionOpen && (
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={visualSelectionDisabled}
                onClick={() =>
                  runAction(
                    "delegate_visual",
                    actionFromCard(
                      observation,
                      "visual_board",
                      "delegate_visual",
                      { agentProfile: managedAgentProfile },
                    ),
                  )
                }
              >
                委托 AI 选择
              </button>
            )}
          </div>
          <div className="siteops-agent-profile-card">
            <div className="siteops-agent-profile-heading">
              <div>
                <strong>AI 建站模式</strong>
                <p>
                  任务会使用当前账号配置的个人 API Key，并出现在该 Key
                  对应的私有账号中。
                </p>
              </div>
              {!visualSelectionOpen && <span>已随官网版本锁定</span>}
            </div>
            <div
              className="siteops-agent-profile-options"
              role="radiogroup"
              aria-label="AI 建站模式"
            >
              <button
                type="button"
                role="radio"
                aria-checked={managedAgentProfile === "frontmind-pro"}
                data-selected={
                  managedAgentProfile === "frontmind-pro" ? "true" : "false"
                }
                disabled={agentProfileLocked}
                onClick={() => setManagedAgentProfile("frontmind-pro")}
              >
                <strong>Pro</strong>
                <span>适合复杂官网的信息架构与表达</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={managedAgentProfile === "frontmind-base"}
                data-selected={
                  managedAgentProfile === "frontmind-base" ? "true" : "false"
                }
                disabled={agentProfileLocked}
                onClick={() => setManagedAgentProfile("frontmind-base")}
              >
                <strong>Base</strong>
                <span>适合结构清晰的标准企业官网</span>
              </button>
            </div>
            <small>Base / Pro 只对本次不可变官网版本生效。</small>
            {builderMessage && (
              <div className="siteops-builder-key-warning" role="status">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{builderMessage}</span>
              </div>
            )}
          </div>
          <div className="siteops-visual-grid">
            {observation.visualCandidates.map((candidate) => (
              <VisualCandidateCard
                key={candidate.id}
                candidate={candidate}
                disabled={visualSelectionDisabled}
                onSelect={() =>
                  runAction(
                    `visual:${candidate.id}`,
                    actionFromCard(
                      observation,
                      "visual_board",
                      "select_visual",
                      {
                        sampleId: candidate.id,
                        agentProfile: managedAgentProfile,
                      },
                    ),
                  )
                }
              />
            ))}
          </div>
        </section>
      )}

      {latestBuild && (
        <section
          className="siteops-build-card"
          aria-labelledby="siteops-build-title"
        >
          <div>
            <span>
              官网版本 {latestBuild.ordinal}
              {latestBuild.renderer
                ? ` · ${latestBuild.renderer === "react_static" ? "React 静态" : "Astro"}`
                : ""}
            </span>
            <h3 id="siteops-build-title">
              {BUILD_STATUS_LABELS[latestBuild.status] || latestBuild.status}
            </h3>
            {latestBuild.errorMessage && <p>{latestBuild.errorMessage}</p>}
          </div>
          <div className="siteops-build-actions">
            {latestBuild.previewUrl && (
              <button
                type="button"
                className="siteops-secondary-button"
                onClick={() => openPrivatePreview(latestBuild.previewUrl!)}
              >
                <ExternalLink size={15} aria-hidden="true" />
                在新标签页打开私有预览
              </button>
            )}
            {latestBuild.sourceUrl && (
              <a href={latestBuild.sourceUrl}>
                <Download size={15} aria-hidden="true" />
                下载源码 ZIP
              </a>
            )}
            {latestBuild.qaUrl && (
              <a href={latestBuild.qaUrl}>
                <Download size={15} aria-hidden="true" />
                下载 QA 报告
              </a>
            )}
            {latestBuild.status === "preview_ready" && (
              <button
                type="button"
                className="siteops-primary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "approve_build",
                    actionFromCard(
                      observation,
                      "build_preview",
                      "approve_build",
                      { buildId: latestBuild.id },
                    ),
                  )
                }
              >
                批准这个版本
              </button>
            )}
            {[
              "preview_ready",
              "approved",
              "failed",
              "attention_required",
            ].includes(latestBuild.status) && (
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "reselect_visual",
                    actionFromCard(
                      observation,
                      "visual_choice",
                      "reselect_visual",
                      {},
                    ),
                  )
                }
              >
                重新选择视觉方向
              </button>
            )}
            {previewOpenError && latestBuild.previewUrl && (
              <div
                className="siteops-notice error siteops-preview-open-error"
                role="alert"
              >
                <AlertCircle size={18} aria-hidden="true" />
                <span>{previewOpenError}</span>
                <a
                  href={latestBuild.previewUrl}
                  target={PRIVATE_PREVIEW_WINDOW_NAME}
                  onClick={(event) => {
                    event.preventDefault();
                    openPrivatePreview(latestBuild.previewUrl!);
                  }}
                >
                  重试打开私有预览
                </a>
              </div>
            )}
            {historicalPreviewBuilds.length > 0 && (
              <div
                className="siteops-preview-history"
                aria-label="历史官网版本对比"
              >
                <strong>历史版本对比</strong>
                <span>当前版本与旧版本均保持不可变，可在同一预览标签页切换查看。</span>
                <div>
                  {historicalPreviewBuilds.map((build) => (
                    <button
                      key={build.id}
                      type="button"
                      className="siteops-secondary-button"
                      onClick={() => openPrivatePreview(build.previewUrl!)}
                    >
                      <ExternalLink size={15} aria-hidden="true" />
                      官网版本 {build.ordinal} · {build.renderer === "react_static" ? "React 静态" : "Astro"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {latestBuild.status === "approved" && (
              <>
                <button
                  type="button"
                  className="siteops-primary-button"
                  disabled={
                    interactionLocked ||
                    Boolean(globalDeployment.pending) ||
                    globalDeployment.active?.buildId === latestBuild.id
                  }
                  onClick={() =>
                    runAction(
                      "publish_global",
                      actionFromCard(
                        observation,
                        "publish_options",
                        "publish_global",
                        {
                          buildId: latestBuild.id,
                          expectedHeadDeploymentId: globalDeployment.active?.id,
                        },
                      ),
                    )
                  }
                >
                  {globalDeployment.pending
                    ? "海外站点发布中"
                    : globalDeployment.active?.buildId === latestBuild.id
                      ? "海外站点已在线"
                      : "发布海外站点"}
                </button>
                <button
                  type="button"
                  className="siteops-secondary-button"
                  disabled={
                    interactionLocked ||
                    Boolean(mainlandDeployment.pending) ||
                    mainlandDeployment.active?.buildId === latestBuild.id
                  }
                  onClick={() =>
                    runAction(
                      "publish_mainland",
                      actionFromCard(
                        observation,
                        "publish_options",
                        "publish_mainland",
                        {
                          buildId: latestBuild.id,
                          expectedHeadDeploymentId:
                            mainlandDeployment.active?.id,
                        },
                      ),
                    )
                  }
                >
                  {mainlandDeployment.pending
                    ? "大陆站点发布中"
                    : mainlandDeployment.active?.buildId === latestBuild.id
                      ? "大陆站点已在线"
                      : "发布大陆站点"}
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {observation.deployments.some(
        (deployment) => deployment.status === "superseded",
      ) && (
        <section className="siteops-build-card" aria-label="历史发布与回滚">
          <div>
            <span>已验证版本</span>
            <h3>历史发布与回滚</h3>
            <p>回滚会重新验证精确 dist 摘要；失败时当前线上版本保持不变。</p>
          </div>
          <div className="siteops-build-actions">
            {observation.deployments
              .filter((deployment) => deployment.status === "superseded")
              .map((deployment) => (
                <button
                  type="button"
                  className="siteops-secondary-button"
                  key={deployment.id}
                  disabled={interactionLocked}
                  onClick={() =>
                    runAction(`rollback:${deployment.id}`, {
                      action: "rollback",
                      input: { deploymentId: deployment.id },
                    })
                  }
                >
                  回滚{deployment.target === "mainland_cn" ? "大陆" : "海外"}
                  版本 · {deployment.buildId.slice(0, 8)}
                </button>
              ))}
          </div>
        </section>
      )}

      {currentSnapshotId &&
        ["preview_ready", "approved", "live"].includes(
          observation.interactionState,
        ) && (
          <section className="siteops-build-card" aria-label="企业内容包">
            <div>
              <span>可下载交付</span>
              <h3>企业社媒内容包</h3>
              <p>生成、预览与下载，不连接社媒账号，也不会定时发布。</p>
            </div>
            <div className="siteops-build-actions">
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "create_wechat_package",
                    actionFromCard(
                      observation,
                      "content_review",
                      "create_wechat_package",
                      {},
                    ),
                  )
                }
              >
                生成微信内容包
              </button>
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "create_xiaohongshu_package",
                    actionFromCard(
                      observation,
                      "content_review",
                      "create_xiaohongshu_package",
                      {},
                    ),
                  )
                }
              >
                生成小红书内容包
              </button>
              {observation.socialPackages
                .filter((item) => item.archiveUrl)
                .map((item) => (
                  <a key={item.id} href={item.archiveUrl!}>
                    <Download size={15} aria-hidden="true" />
                    下载{item.channel === "wechat" ? "微信" : "小红书"} ZIP
                  </a>
                ))}
            </div>
          </section>
        )}

      <section
        className="siteops-domain-card"
        aria-labelledby="siteops-domain-title"
      >
        <div className="siteops-domain-heading">
          <div>
            <p className="siteops-eyebrow">
              <Cloud size={15} aria-hidden="true" />
              客户自有阿里云账号
            </p>
            <h3 id="siteops-domain-title">域名、续费与 AliDNS</h3>
            <p>
              FrontMind 仅通过带唯一 ExternalId 的 RAM Role 获取短期
              STS；不接收主账号密码或永久 AccessKey。
            </p>
          </div>
          <span
            className="siteops-status-pill"
            data-status={observation.aliyunConnection.status ?? "none"}
          >
            {observation.aliyunConnection.status === "active"
              ? "连接已验证"
              : observation.aliyunConnection.status === "unverified"
                ? "等待验证"
                : observation.aliyunConnection.status === "invalid"
                  ? "验证失败"
                  : "尚未连接"}
          </span>
        </div>

        {observation.aliyunConnection.configured && (
          <div className="siteops-connection-summary">
            <span>账号 UID：{observation.aliyunConnection.accountUid}</span>
            <span>Role：{observation.aliyunConnection.roleArn}</span>
            <span>
              ExternalId 指纹：
              {observation.aliyunConnection.externalIdFingerprint}
            </span>
            <span>
              能力：
              {observation.aliyunConnection.capabilities.join("、") ||
                "尚未验证"}
            </span>
          </div>
        )}

        <form className="siteops-connection-form" onSubmit={setupAliyun}>
          <label>
            <span>阿里云账号 UID</span>
            <input
              value={aliyunAccountUid}
              inputMode="numeric"
              pattern="[0-9]{6,64}"
              placeholder={
                observation.aliyunConnection.accountUid ?? "例如 123456789012"
              }
              required
              onChange={(event) => setAliyunAccountUid(event.target.value)}
            />
          </label>
          <label>
            <span>客户 RAM Role ARN</span>
            <input
              value={aliyunRoleArn}
              placeholder={
                observation.aliyunConnection.roleArn ??
                "acs:ram::账号UID:role/frontmind-siteops"
              }
              required
              onChange={(event) => setAliyunRoleArn(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="siteops-secondary-button"
            disabled={
              !onSetupAliyun ||
              !observation.aliyunConnection.canRotate ||
              Boolean(busyAction)
            }
          >
            {busyAction === "aliyun_setup" && (
              <Loader2 className="siteops-spin" size={15} aria-hidden="true" />
            )}
            {observation.aliyunConnection.configured
              ? "重新生成 ExternalId"
              : "生成连接配置"}
          </button>
        </form>

        {aliyunSetup && (
          <div className="siteops-external-id" role="status">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>
                ExternalId 仅在这里显示一次，请现在写入 Role 信任策略
              </strong>
              <code>{aliyunSetup.externalId}</code>
              <button
                type="button"
                className="siteops-inline-button"
                onClick={() =>
                  navigator.clipboard.writeText(aliyunSetup.externalId)
                }
              >
                <Copy size={14} aria-hidden="true" />
                复制 ExternalId
              </button>
              {aliyunSetup.trustPolicy ? (
                <pre>{JSON.stringify(aliyunSetup.trustPolicy, null, 2)}</pre>
              ) : (
                <p>
                  FrontMind 服务身份 ARN
                  尚未配置，请勿验证；系统不会退回收集永久 AccessKey。
                </p>
              )}
              <strong>Role 最小权限策略</strong>
              <pre>{JSON.stringify(aliyunSetup.permissionPolicy, null, 2)}</pre>
              <button
                type="button"
                className="siteops-inline-button"
                onClick={() =>
                  navigator.clipboard.writeText(
                    JSON.stringify(aliyunSetup.permissionPolicy, null, 2),
                  )
                }
              >
                <Copy size={14} aria-hidden="true" />
                复制最小权限策略
              </button>
              <p>
                日常只读、购买、续费、自动续费和 DNS 写入权限已明确列出；每次
                AssumeRole 还会叠加本次操作的更窄 session policy。
              </p>
            </div>
          </div>
        )}

        <div className="siteops-domain-actions">
          <button
            type="button"
            className="siteops-primary-button"
            disabled={
              !observation.aliyunConnection.configured ||
              !onVerifyAliyun ||
              Boolean(busyAction)
            }
            onClick={() => runConnectionAction("aliyun_verify", onVerifyAliyun)}
          >
            验证 RAM Role
          </button>
          {observation.aliyunConnection.configured && (
            <button
              type="button"
              className="siteops-secondary-button"
              disabled={
                !onDisconnectAliyun ||
                !observation.aliyunConnection.canRotate ||
                Boolean(busyAction)
              }
              onClick={() =>
                runConnectionAction("aliyun_disconnect", onDisconnectAliyun)
              }
            >
              撤销连接
            </button>
          )}
        </div>

        {observation.aliyunConnection.status === "unverified" && (
          <div className="siteops-notice warning">
            请先在客户阿里云账号中完成 Role 信任策略与最小权限，再点击“验证 RAM
            Role”。
          </div>
        )}
        {!observation.aliyunConnection.canRotate && (
          <div className="siteops-notice warning">
            当前仍有域名扣费或 DNS 操作正在执行/对账；为保留原 Role 与
            ExternalId，完成前不能重新生成或撤销连接。
          </div>
        )}

        <div className="siteops-domain-divider" />
        <div className="siteops-domain-form">
          <label>
            <span>查询或报价域名</span>
            <input
              value={domainInput}
              placeholder={managedDomain || "example.com"}
              onChange={(event) => setDomainInput(event.target.value)}
            />
          </label>
          <label>
            <span>年限</span>
            <select
              value={domainYears}
              onChange={(event) => setDomainYears(Number(event.target.value))}
            >
              {[1, 2, 3, 5, 10].map((years) => (
                <option key={years} value={years}>
                  {years} 年
                </option>
              ))}
            </select>
          </label>
          <div className="siteops-domain-actions">
            <button
              type="button"
              className="siteops-secondary-button"
              disabled={
                !domainInput.trim() ||
                observation.aliyunConnection.status !== "active" ||
                interactionLocked
              }
              onClick={() => {
                const domain = domainInput.trim();
                if (
                  !window.confirm(
                    `确认通过当前客户阿里云 RAM Role 只读查询并接入已有域名 ${domain}？系统会验证它属于该客户账号，不会购买或扣费。`,
                  )
                ) {
                  return;
                }
                void runAction(
                  "domain_sync",
                  actionFromCard(observation, "domain_status", "domain_sync", {
                    domain,
                    typedDomain: domain,
                    customerConfirmed: true,
                  }),
                );
              }}
            >
              只读接入已有域名
            </button>
            <button
              type="button"
              className="siteops-secondary-button"
              disabled={
                !domainInput.trim() ||
                observation.aliyunConnection.status !== "active" ||
                interactionLocked
              }
              onClick={() =>
                runAction(
                  "domain_search",
                  actionFromCard(
                    observation,
                    "domain_status",
                    "domain_search",
                    { domain: domainInput.trim() },
                  ),
                )
              }
            >
              查询可注册性
            </button>
            <button
              type="button"
              className="siteops-primary-button"
              disabled={
                !domainInput.trim() ||
                observation.aliyunConnection.status !== "active" ||
                interactionLocked
              }
              onClick={() =>
                runAction(
                  "domain_prepare_purchase",
                  actionFromCard(
                    observation,
                    "domain_quote",
                    "domain_prepare_purchase",
                    {
                      domain: domainInput.trim(),
                      years: domainYears,
                      ...(registrantProfileId ? { registrantProfileId } : {}),
                    },
                  ),
                )
              }
            >
              获取购买精确报价
            </button>
            <button
              type="button"
              className="siteops-secondary-button"
              disabled={
                !managedDomain ||
                observation.aliyunConnection.status !== "active" ||
                interactionLocked
              }
              onClick={() =>
                runAction(
                  "domain_prepare_renewal",
                  actionFromCard(
                    observation,
                    "domain_quote",
                    "domain_prepare_renewal",
                    { domain: managedDomain, years: domainYears },
                  ),
                )
              }
            >
              获取当前域名续费报价
            </button>
          </div>
        </div>

        {availableRegistrantProfiles.length > 0 && (
          <div className="siteops-registrant-picker">
            <label>
              <span>选择已实名且邮箱已验证的持有人模板</span>
              <select
                value={registrantProfileId}
                onChange={(event) => setRegistrantProfileId(event.target.value)}
              >
                <option value="">请选择</option>
                {availableRegistrantProfiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.maskedName} ·{" "}
                    {profile.holderType === "enterprise"
                      ? "企业"
                      : profile.holderType === "individual"
                        ? "个人"
                        : "未知"}
                    {profile.isDefault ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Dashboard 只保存模板 ID
              与掩码名称；证件、地址、电话等材料继续由客户在阿里云控制台管理。
            </p>
          </div>
        )}

        {latestSearch?.searchResult && (
          <div className="siteops-domain-result">
            <strong>{latestSearch.displayDomain || latestSearch.domain}</strong>
            <span>
              {latestSearch.searchResult.available
                ? latestSearch.searchResult.premium
                  ? "可注册，但属于溢价域名（首版不自动购买）"
                  : "当前可注册"
                : "当前不可注册"}
            </span>
            {latestSearch.searchResult.reason && (
              <small>{latestSearch.searchResult.reason}</small>
            )}
          </div>
        )}

        {latestQuote && (
          <div className="siteops-quote-confirm">
            <div>
              <strong>
                {latestQuote.kind === "purchase" ? "购买" : "续费"}报价：
                {latestQuote.domain}
              </strong>
              <p>
                {latestQuote.currency}{" "}
                {((latestQuote.amountMinor ?? 0) / 100).toFixed(2)} /{" "}
                {latestQuote.years} 年； 持有人{" "}
                {latestQuote.maskedRegistrantName || "当前域名持有人"}
                ；从客户账号 {observation.aliyunConnection.accountUid} 扣费。
              </p>
              <p>
                报价不锁定库存，操作通常不可撤销。系统不会自动购买，必须由你输入完整域名确认。
              </p>
            </div>
            <label>
              <span>完整输入 {latestQuote.domain}</span>
              <input
                value={typedDomain}
                onChange={(event) => setTypedDomain(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="siteops-primary-button"
              disabled={
                typedDomain.trim().toLowerCase() !== latestQuote.domain ||
                interactionLocked
              }
              onClick={() =>
                runAction(
                  `domain_confirm_${latestQuote.kind}`,
                  actionFromCard(
                    observation,
                    "domain_quote",
                    latestQuote.kind === "purchase"
                      ? "domain_confirm_purchase"
                      : "domain_confirm_renewal",
                    {
                      domain: latestQuote.domain,
                      typedDomain: typedDomain.trim(),
                      quoteHash: latestQuote.quoteHash!,
                      domainOperationId: latestQuote.id,
                    },
                  ),
                )
              }
            >
              确认并从客户阿里云账号扣费
            </button>
          </div>
        )}

        {observation.domainState && (
          <div className="siteops-domain-state">
            <strong>
              {observation.domainState.displayDomain ||
                observation.domainState.domain}
            </strong>
            <span>域名版本 {observation.domainState.revision}</span>
            <span>
              实名：{observation.domainState.realNameStatus || "待同步"}
            </span>
            <span>
              所有权：{observation.domainState.ownershipStatus || "待验证"}
            </span>
            <span>DNS：{observation.domainState.dnsStatus || "待规划"}</span>
            <span>
              到期：
              {observation.domainState.expiresAt
                ? new Date(
                    observation.domainState.expiresAt,
                  ).toLocaleDateString("zh-CN")
                : "待同步"}
            </span>
            <span>
              自动续费：
              {observation.domainState.autoRenewObserved == null
                ? "待同步"
                : observation.domainState.autoRenewObserved
                  ? "已开启"
                  : "已关闭"}
            </span>
            <span>
              ICP：{observation.domainState.icpStatus}（与域名实名独立）
            </span>
            <div className="siteops-domain-actions">
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() => {
                  const domain = observation.domainState!.domain!;
                  if (
                    !window.confirm(
                      `确认开启 ${domain} 的自动续费？未来续费将按届时价格从当前客户阿里云账号扣款；开启自动续费不代表本次续费已经成功。`,
                    )
                  ) {
                    return;
                  }
                  void runAction(
                    "auto_renew_on",
                    actionFromCard(
                      observation,
                      "domain_status",
                      "domain_set_auto_renew",
                      {
                        domain,
                        enabled: true,
                        customerConfirmed: true,
                      },
                    ),
                  );
                }}
              >
                开启自动续费
              </button>
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "auto_renew_off",
                    actionFromCard(
                      observation,
                      "domain_status",
                      "domain_set_auto_renew",
                      {
                        domain: observation.domainState!.domain!,
                        enabled: false,
                        customerConfirmed: true,
                      },
                    ),
                  )
                }
              >
                关闭自动续费
              </button>
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "dns_plan",
                    actionFromCard(
                      observation,
                      "domain_status",
                      "dns_plan",
                      {},
                    ),
                  )
                }
              >
                查看 DNS 精确差异
              </button>
              <button
                type="button"
                className="siteops-primary-button"
                disabled={
                  interactionLocked ||
                  !currentDnsPlan ||
                  !currentDnsPlan.canApply
                }
                onClick={() =>
                  runAction(
                    "dns_apply",
                    actionFromCard(observation, "domain_status", "dns_apply", {
                      domainRevision: observation.domainState!.revision,
                      planOperationId: currentDnsPlan!.operationId,
                      planHash: currentDnsPlan!.planHash,
                      providerSnapshotHash:
                        currentDnsPlan!.providerSnapshotHash,
                    }),
                  )
                }
              >
                应用 FrontMind DNS
              </button>
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={interactionLocked}
                onClick={() =>
                  runAction(
                    "dns_rollback",
                    actionFromCard(
                      observation,
                      "domain_status",
                      "dns_rollback",
                      { domainRevision: observation.domainState!.revision },
                    ),
                  )
                }
              >
                回滚 FrontMind DNS
              </button>
            </div>
            {currentDnsPlan ? (
              <div className="siteops-dns-plan" aria-label="DNS 精确差异计划">
                <div className="siteops-dns-plan-heading">
                  <strong>DNS 精确差异计划</strong>
                  <span>
                    {currentDnsPlan.canApply
                      ? "供应商快照未写入，确认后才会应用"
                      : "存在冲突或未知结果，不能应用"}
                  </span>
                </div>
                {currentDnsPlan.items.map((item) => (
                  <div
                    className={`siteops-dns-plan-item siteops-dns-plan-item-${item.action}`}
                    key={item.id}
                  >
                    <strong>{item.action}</strong>
                    <span>
                      {item.rr} {item.type}
                    </span>
                    <code>{item.expectedValue}</code>
                    {item.currentValue && (
                      <small>
                        当前：{item.currentValue} / TTL {item.currentTtl}
                      </small>
                    )}
                    {item.reason && <small>{item.reason}</small>}
                  </div>
                ))}
                <small>
                  计划 {currentDnsPlan.planHash.slice(0, 12)} · 供应商快照{" "}
                  {currentDnsPlan.providerSnapshotHash.slice(0, 12)}
                </small>
              </div>
            ) : (
              <p className="siteops-dns-plan-empty">
                请先生成当前域名版本的 DNS
                精确差异；记录或域名版本发生变化时必须重新规划。
              </p>
            )}
            {observation.domainState.icpStatus !== "approved" && (
              <div className="siteops-icp-filing">
                <p className="siteops-icp-note">
                  域名购买成功不等于可在中国大陆发布；只有当前域名版本 ICP
                  审核通过后，大陆发布才会放行。
                </p>
                <a
                  href="https://beian.aliyun.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  前往阿里云 ICP 备案系统
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
                <form onSubmit={submitIcpFiling}>
                  <label>
                    <span>当前域名版本的 ICP 主体备案号</span>
                    <input
                      value={icpNumber}
                      maxLength={128}
                      placeholder="例如 京ICP备12345678号"
                      required
                      onChange={(event) => setIcpNumber(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="siteops-secondary-button"
                    disabled={
                      !onSubmitIcpFiling ||
                      !icpNumber.trim() ||
                      Boolean(busyAction)
                    }
                  >
                    提交现有 ICP 核验工单
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {observation.domainOperations.length > 0 && (
          <div className="siteops-operation-list">
            {observation.domainOperations.slice(0, 5).map((operation) => (
              <div key={operation.id}>
                <span>
                  {operation.kind} · {operation.domain}
                </span>
                <strong>{operation.status}</strong>
                {operation.errorMessage && (
                  <small>{operation.errorMessage}</small>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <form className="siteops-composer" onSubmit={submitMessage}>
        <label htmlFor="siteops-message-input">继续对话</label>
        <div>
          <textarea
            id="siteops-message-input"
            rows={3}
            value={message}
            disabled={!onSendMessage}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="补充公司信息，或说明需要修改的文案、布局与内容…"
          />
          <button
            type="submit"
            className="siteops-primary-button"
            disabled={!message.trim() || !onSendMessage || Boolean(busyAction)}
          >
            {busyAction === "message" ? (
              <Loader2 className="siteops-spin" size={16} aria-hidden="true" />
            ) : (
              <Send size={16} aria-hidden="true" />
            )}
            发送
          </button>
        </div>
      </form>
    </section>
  );
}
