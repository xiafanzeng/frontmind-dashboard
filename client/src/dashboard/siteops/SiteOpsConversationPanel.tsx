import type {
  SiteOpsMessageProjection,
  SiteOpsObservationV1,
  SiteOpsPublicVisualCandidate,
} from "@shared/siteops-contract";
import type { SiteOpsActInput } from "@shared/siteops";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
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
  Download,
  ExternalLink,
  FileArchive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  UserRound,
  Wrench,
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
  onBeginAliyun?: () => Promise<{
    authorizationUrl: string;
    expiresAt: string;
  }>;
  onLoadAliyunAuthorizationGuide?: () => Promise<{
    available: boolean;
    consoleUrl: string;
    configurationDownloadUrl: string;
    roleName: string;
    trustPolicyText: string;
    permissionPolicyText: string;
  }>;
  onVerifyAliyun?: () => Promise<void> | void;
  onDisconnectAliyun?: () => Promise<void> | void;
  onSubmitIcpFiling?: (input: {
    domain: string;
    icpNumber: string;
  }) => Promise<void> | void;
};

const BUILD_STATUS_LABELS: Record<string, string> = {
  preparing: "整理建站资料",
  visual_searching: "生成视觉候选",
  awaiting_visual_selection: "等待选择视觉方案",
  design_compiling: "正在制作官网",
  contract_ready: "正在制作官网",
  building: "正在制作官网",
  qa_running: "正在检查官网",
  preview_ready: "官网已完成",
  approved: "官网已完成",
  failed: "需要协助",
  attention_required: "需要协助",
  cancelled: "已取消",
  superseded: "已被新版本替代",
};

const REBUILD_INTERACTION_LABELS: Partial<
  Record<SiteOpsObservationV1["interactionState"], string>
> = {
  select_snapshot: "选择知识库 ZIP 版本",
  collecting_brief: "整理建站资料",
  visual_searching: "生成视觉候选",
  awaiting_visual_selection: "等待选择视觉方案",
};

const CARD_LABELS: Record<string, string> = {
  brief_question: "建站资料",
  visual_board: "视觉方向",
  visual_choice: "视觉选择",
  build_progress: "制作进度",
  build_preview: "官网预览",
  qa_failed: "官网检查",
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
  const provider = observation.serviceReadiness.visuals;
  if (provider.status === "configured") return null;
  return provider.status === "not_configured"
    ? "视觉参考服务尚未配置，暂时不能检索视觉方向。"
    : "视觉参考服务暂时不可用，请稍后重试或联系系统管理员。";
}

function aiBuilderMessage(observation: SiteOpsObservationV1) {
  const provider = observation.serviceReadiness.website;
  if (provider.status === "configured") return null;
  return provider.status === "not_configured"
    ? "AI 建站服务尚未就绪，请联系 FrontMind。"
    : "AI 建站服务暂时不可用，请稍后重试或联系 FrontMind。";
}

function visualCandidatePresentation(candidate: SiteOpsPublicVisualCandidate) {
  const family = candidate.visualFamily;
  const familyLabels: Record<string, string> = {
    floating_orbit: "浮动轨道式",
    split_media: "分屏媒体式",
    editorial: "编辑杂志式",
    bento: "Bento 模块式",
    feature_grid: "功能网格式",
    centered_dual_cta: "极简双按钮式",
    immersive_visual: "沉浸视觉式",
    product_stage: "产品舞台式",
    full_bleed_statement: "全幅宣言式",
  };
  const familyLabel = (family ? familyLabels[family] : null) || "首页视觉";
  return {
    badge: `首页 · ${familyLabel}`,
    title: family ? familyLabel : candidate.title,
    note:
      candidate.note && candidate.note !== candidate.title
        ? candidate.note
        : null,
  };
}

function customerFacingMessage(content: string) {
  const sanitized = content
    .replace(
      /(?:错误码|任务编号|operation(?:\s*id)?|task(?:\s*id)?)\s*[:：]\s*[A-Za-z0-9_-]+/giu,
      "",
    )
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu, "")
    .replace(/21st/giu, "视觉服务")
    .replace(/SiteOps/giu, SITEOPS_CUSTOMER_DISPLAY_NAME)
    .replace(/(?:原生\s*)?Astro/giu, "官网")
    .replace(/React(?:\s*静态)?/giu, "官网")
    .replace(/API\s*Key/giu, "服务配置")
    .replace(/frontmind-(?:base|pro)/giu, "建站模式")
    .replace(/\b(?:Base|Pro)\b/giu, "建站模式")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (
    /(?:\bESA\b|AliDNS|\bDNS\b|RecordId|\bCNAME\b|\bTXT\b|\bTLS\b|\bSTS\b|ExternalId|RAM\s*Role|Role\s*ARN|principal\s*ARN|\bARN\b|\bUID\b|canonical\s+hostname|global_excluding_cn|mainland_cn|\bHero\b|归档哈希|\bhash\b|record\s*tuple|remark\s*marker|provider)/iu.test(
      sanitized,
    )
  ) {
    return "FrontMind 正在处理当前任务；如长时间未完成，请提交工单获取协助。";
  }
  return sanitized || "任务需要协助，请稍后重试或提交工单。";
}

function customerDomainStateLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    verified: "已完成",
    approved: "已通过",
    active: "正常",
    pending: "处理中",
    preparing: "准备中",
    submitted: "审核中",
    not_submitted: "未提交",
    not_verified: "待验证",
    failed: "需要协助",
    conflict: "需要协助",
  };
  return value ? labels[value] || "处理中" : "待同步";
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
  onBeginAliyun,
  onLoadAliyunAuthorizationGuide,
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
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [rebuildReason, setRebuildReason] = useState("");
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [aliyunGuide, setAliyunGuide] = useState<{
    consoleUrl: string;
    configurationDownloadUrl: string;
    roleName: string;
    trustPolicyText: string;
    permissionPolicyText: string;
  } | null>(null);
  const [copiedAliyunStep, setCopiedAliyunStep] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [domainYears, setDomainYears] = useState(1);
  const [typedDomain, setTypedDomain] = useState("");
  const [registrantProfileId, setRegistrantProfileId] = useState("");
  const [icpNumber, setIcpNumber] = useState("");
  const latestAttempt = useMemo(() => {
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
  const latestBuild = useMemo(() => {
    if (!latestAttempt || latestAttempt.previewUrl) return latestAttempt;
    const completedBuilds = observation?.builds.filter(
      (build) =>
        Boolean(build.previewUrl) &&
        ["preview_ready", "approved"].includes(build.status),
    );
    return (
      completedBuilds?.reduce(
        (latest, build) =>
          !latest || build.ordinal > latest.ordinal ? build : latest,
        completedBuilds[0],
      ) ?? latestAttempt
    );
  }, [latestAttempt, observation?.builds]);
  const hasSuccessfulBuild = useMemo(
    () =>
      observation?.builds.some((build) =>
        ["preview_ready", "approved"].includes(build.status),
      ) || observation?.deployments.some((item) => item.status === "active"),
    [observation?.builds, observation?.deployments],
  );

  useEffect(() => {
    setPreviewOpenError(null);
  }, [latestBuild?.previewUrl]);

  function openPrivatePreview(previewUrl: string) {
    setPreviewOpenError(null);
    const previewWindow = window.open(previewUrl, PRIVATE_PREVIEW_WINDOW_NAME);
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
          ? customerFacingMessage(actionError.message)
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
          ? customerFacingMessage(messageError.message)
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
      setLocalError(null);
      setResetDialogOpen(false);
    } catch (resetActionError) {
      const rawMessage =
        resetActionError instanceof Error
          ? resetActionError.message
          : "建站流程没有重置，请刷新后重试。";
      const message = customerFacingMessage(rawMessage);
      setResetError(message);
      setLocalError(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function requestRebuild() {
    if (
      !onAction ||
      busyAction ||
      !latestBuild ||
      !observation?.rebuildRequest.allowed
    ) {
      return;
    }
    setBusyAction("request_rebuild");
    setLocalError(null);
    setRebuildError(null);
    try {
      await onAction({
        action: "request_rebuild",
        input: {
          ...(rebuildReason.trim() ? { reason: rebuildReason.trim() } : {}),
        },
      });
      setRebuildReason("");
      setRebuildDialogOpen(false);
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? customerFacingMessage(requestError.message)
          : "重制需求没有提交成功，请稍后重试。";
      setRebuildError(message);
      setLocalError(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function beginAliyunConnection() {
    if (!onBeginAliyun || busyAction) return;
    const authorizationWindow = window.open(
      "",
      "frontmind-aliyun-authorization",
    );
    setBusyAction("aliyun_begin");
    setLocalError(null);
    try {
      const result = await onBeginAliyun();
      if (authorizationWindow) {
        authorizationWindow.location.href = result.authorizationUrl;
        authorizationWindow.focus();
      } else {
        setLocalError("阿里云授权页面被浏览器阻止，请允许弹窗后重试。");
      }
    } catch (connectionError) {
      authorizationWindow?.close();
      setLocalError(
        connectionError instanceof Error
          ? customerFacingMessage(connectionError.message)
          : "暂时无法打开阿里云授权页面，请稍后重试。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function openAliyunAuthorizationGuide() {
    if (!onLoadAliyunAuthorizationGuide || busyAction) return;
    const authorizationWindow = window.open(
      "",
      "frontmind-aliyun-authorization",
    );
    setBusyAction("aliyun_guide");
    setLocalError(null);
    try {
      const guide = await onLoadAliyunAuthorizationGuide();
      if (!guide.available) {
        authorizationWindow?.close();
        setLocalError("阿里云授权配置尚未就绪，请联系 FrontMind。 ");
        return;
      }
      setAliyunGuide({
        consoleUrl: guide.consoleUrl,
        configurationDownloadUrl: guide.configurationDownloadUrl,
        roleName: guide.roleName,
        trustPolicyText: guide.trustPolicyText,
        permissionPolicyText: guide.permissionPolicyText,
      });
      if (authorizationWindow) {
        authorizationWindow.location.href = guide.consoleUrl;
        authorizationWindow.focus();
      } else {
        setLocalError("阿里云授权页面被浏览器阻止，请允许弹窗后重试。");
      }
    } catch (guideError) {
      authorizationWindow?.close();
      setLocalError(
        guideError instanceof Error
          ? customerFacingMessage(guideError.message)
          : "暂时无法打开阿里云授权页面，请稍后重试。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function copyAliyunAuthorizationStep(
    step: "role" | "trust" | "permission",
    value: string,
  ) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAliyunStep(step);
    } catch {
      setLocalError("复制未成功，请使用备用配置下载后按引导完成授权。");
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
      if (key === "aliyun_disconnect") setAliyunGuide(null);
    } catch (connectionError) {
      setLocalError(
        connectionError instanceof Error
          ? customerFacingMessage(connectionError.message)
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
          ? customerFacingMessage(filingError.message)
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
        aria-label={SITEOPS_CUSTOMER_DISPLAY_NAME}
      >
        <Loader2 className="siteops-spin" size={22} aria-hidden="true" />
        正在打开{SITEOPS_CUSTOMER_DISPLAY_NAME}…
      </section>
    );
  }

  if (!observation) {
    return (
      <section
        className="siteops-panel siteops-panel-state"
        aria-label={SITEOPS_CUSTOMER_DISPLAY_NAME}
      >
        <AlertCircle size={22} aria-hidden="true" />
        <div>
          <strong>{SITEOPS_CUSTOMER_DISPLAY_NAME}暂时不可用</strong>
          <p>{error ? customerFacingMessage(error) : "请稍后刷新重试。"}</p>
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
    observation.serviceReadiness.website.status === "configured";
  const interactionLocked = Boolean(busyAction || !onAction);
  const visualSelectionOpen =
    observation.interactionState === "awaiting_visual_selection";
  const visualSelectionDisabled =
    interactionLocked || !visualSelectionOpen || !aiBuilderConfigured;
  const currentSnapshotId = observation.project.currentKnowledgeSnapshotId;
  const effectiveSnapshotId = selectedSnapshotId || currentSnapshotId || "";
  const latestQuote = observation.domainOperations.find(
    (item) =>
      (["quoted", "succeeded"].includes(item.status) ||
        (item.status === "attention_required" &&
          item.issue === "quote_changed")) &&
      item.quoteHash &&
      item.quoteExpiresAt &&
      new Date(item.quoteExpiresAt).getTime() > Date.now() &&
      (item.kind === "purchase" || item.kind === "renewal"),
  );
  const latestSearch = observation.domainOperations.find(
    (item) => item.kind === "search" && item.searchResult,
  );
  const managedDomain = observation.domainState?.domain ?? "";
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
    ? customerFacingMessage(
        observation.resetCapability.reason || "当前流程暂时不能重置。",
      )
    : undefined;
  const rebuildRequestActive = Boolean(
    observation.rebuildRequest.ticketId &&
      observation.rebuildRequest.status &&
      !["completed", "rejected", "cancelled"].includes(
        observation.rebuildRequest.status,
      ),
  );
  const hideExistingBuildDuringActiveRebuild = Boolean(
    rebuildRequestActive && observation.rebuildRequest.resetApplied,
  );
  const rebuildInProgress = observation.rebuildRequest.status === "in_progress";
  const rebuildNeedsKnowledgeSnapshot = Boolean(
    observation.rebuildRequest.resetApplied && !currentSnapshotId,
  );
  const rebuildInteractionLabel = observation.rebuildRequest.resetApplied
    ? REBUILD_INTERACTION_LABELS[observation.interactionState]
    : undefined;

  return (
    <section className="siteops-panel" aria-labelledby="siteops-panel-title">
      <header className="siteops-panel-header">
        <div>
          <p>
            <Sparkles size={15} aria-hidden="true" />
            {SITEOPS_CUSTOMER_DISPLAY_NAME}
          </p>
          <h2 id="siteops-panel-title">{SITEOPS_CUSTOMER_DISPLAY_NAME}</h2>
          <span>
            选择企业知识库和视觉方案，FrontMind 将完成官网制作与检查。
          </span>
        </div>
        <div className="siteops-header-controls">
          <div className="siteops-header-actions">
            {onRefresh && (
              <button
                type="button"
                className="siteops-icon-button"
                aria-label={`刷新${SITEOPS_CUSTOMER_DISPLAY_NAME}`}
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
            {hasSuccessfulBuild ? (
              !hideExistingBuildDuringActiveRebuild && (
                <button
                  type="button"
                  className="siteops-icon-button"
                  aria-label="提交官网重制需求"
                  disabled={Boolean(
                    busyAction ||
                      rebuildRequestActive ||
                      !observation.rebuildRequest.allowed,
                  )}
                  title={
                    rebuildRequestActive ? "重制需求处理中" : "提交官网重制需求"
                  }
                  onClick={() => {
                    setRebuildError(null);
                    setRebuildDialogOpen(true);
                  }}
                >
                  <Wrench size={17} aria-hidden="true" />
                </button>
              )
            ) : (
              <button
                type="button"
                className="siteops-icon-button siteops-reset-button"
                aria-label="重置建站流程"
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
            )}
          </div>
          {!hasSuccessfulBuild && resetDisabledReason && (
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
            <AlertDialogTitle>确认重置建站流程？</AlertDialogTitle>
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

      <AlertDialog
        open={rebuildDialogOpen}
        onOpenChange={(open) => {
          if (busyAction === "request_rebuild") return;
          setRebuildDialogOpen(open);
          if (open) setRebuildError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>提交官网重制需求</AlertDialogTitle>
            <AlertDialogDescription>
              提交后将由 FrontMind
              人工受理。受理前不会改动当前官网，也不会创建新任务或扣减额度。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="siteops-rebuild-reason">
            <span>重制原因与期望（选填）</span>
            <textarea
              value={rebuildReason}
              maxLength={2_000}
              rows={5}
              placeholder="例如：希望调整品牌风格、页面结构或重新选择知识库。"
              onChange={(event) => setRebuildReason(event.target.value)}
            />
          </label>
          {rebuildError && (
            <p className="siteops-reset-error" role="alert">
              {rebuildError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === "request_rebuild"}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busyAction === "request_rebuild"}
              onClick={(event) => {
                event.preventDefault();
                void requestRebuild();
              }}
            >
              {busyAction === "request_rebuild" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              提交需求
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
          <span>{customerFacingMessage(localError || error || "")}</span>
        </div>
      )}

      <div className="siteops-stage" data-state={observation.interactionState}>
        <span>当前阶段</span>
        <strong>
          {rebuildInteractionLabel
            ? rebuildInteractionLabel
            : latestAttempt
              ? BUILD_STATUS_LABELS[latestAttempt.status] || "正在处理"
              : observation.interactionState === "select_snapshot"
                ? "选择知识库 ZIP 版本"
                : "整理建站资料"}
        </strong>
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
              <p>FrontMind 将根据所选知识库整理企业资料并制作官网。</p>
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

      {currentSnapshotId &&
        (!hasSuccessfulBuild || rebuildInProgress) &&
        observation.knowledgeSnapshots.length > 1 && (
          <section
            className="siteops-snapshot-card"
            aria-labelledby="siteops-change-snapshot-title"
          >
            <div>
              <FileArchive size={20} aria-hidden="true" />
              <div>
                <h3 id="siteops-change-snapshot-title">更换知识源</h3>
                <p>
                  新知识库会重新整理建站资料与视觉方案；旧官网和线上版本不会被改写。
                </p>
              </div>
            </div>
            <div className="siteops-snapshot-actions">
              <label>
                <span>更换知识库 ZIP 版本</span>
                <select
                  aria-label="更换知识库 ZIP 版本"
                  value={effectiveSnapshotId}
                  onChange={(event) =>
                    setSelectedSnapshotId(event.target.value)
                  }
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
                      `确认更换为“${selected.label}”并重新整理建站资料？旧官网版本和线上站点会保持不变。`,
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
                <h3 id="siteops-brief-title">建站资料核对</h3>
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
                <h3 id="siteops-visual-search-title">生成视觉候选</h3>
                <p>
                  可先在下方补充转化目标；准备好后将生成九种不同风格的官网方案。
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
              生成 9 个视觉候选
            </button>
          </section>
        )}

      <div
        className="siteops-message-list"
        aria-label={`${SITEOPS_CUSTOMER_DISPLAY_NAME}对话记录`}
      >
        {observation.messages.length === 0 ? (
          <div className="siteops-empty-copy">
            选择知识库版本后，FrontMind 会在这里整理建站资料。
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
                  <strong>
                    {item.role === "user"
                      ? "你"
                      : SITEOPS_CUSTOMER_DISPLAY_NAME}
                  </strong>
                  {item.metadata?.siteOps && (
                    <span data-status={item.metadata.siteOps.status}>
                      {CARD_LABELS[item.metadata.siteOps.kind] || "任务状态"}
                    </span>
                  )}
                </div>
                <p>{customerFacingMessage(item.content)}</p>
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
                {visualSelectionOpen ? "9 个视觉候选" : "已选择的视觉方案"}
              </h3>
              <p>
                以下为真实视觉参考；示例图片与文案不会复制到官网，FrontMind
                将按所选构图与视觉语言使用企业资料完成制作。
              </p>
            </div>
            {visualSelectionOpen && (
              <div className="siteops-inline-actions">
                <button
                  type="button"
                  className="siteops-secondary-button"
                  disabled={visualSelectionDisabled}
                  onClick={() =>
                    runAction(
                      "reselect_visual",
                      actionFromCard(
                        observation,
                        "visual_board",
                        "reselect_visual",
                        {},
                      ),
                    )
                  }
                >
                  重新生成 9 个视觉候选
                </button>
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
                        {},
                      ),
                    )
                  }
                >
                  让 FrontMind 推荐
                </button>
              </div>
            )}
          </div>
          {builderMessage && (
            <div className="siteops-builder-key-warning" role="status">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{builderMessage}</span>
            </div>
          )}
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
                      },
                    ),
                  )
                }
              />
            ))}
          </div>
        </section>
      )}

      {!hideExistingBuildDuringActiveRebuild &&
        latestAttempt?.needsHelp &&
        latestBuild?.id !== latestAttempt.id && (
          <div className="siteops-notice warning" role="status">
            <AlertCircle size={18} aria-hidden="true" />
            <span>最新重制暂未完成，当前官网仍可继续预览和使用。</span>
          </div>
        )}

      {latestBuild && !hideExistingBuildDuringActiveRebuild && (
        <section
          className="siteops-build-card"
          aria-labelledby="siteops-build-title"
        >
          <div>
            <span>官网版本 {latestBuild.ordinal}</span>
            <h3 id="siteops-build-title">
              {BUILD_STATUS_LABELS[latestBuild.status] || "正在处理"}
            </h3>
            {latestBuild.needsHelp && (
              <p>
                {latestBuild.status === "attention_required"
                  ? "官网制作需要协助，请提交工单。"
                  : "官网制作暂未完成，请稍后重试或提交工单。"}
              </p>
            )}
          </div>
          <div className="siteops-build-actions">
            {latestBuild.previewUrl && (
              <button
                type="button"
                className="siteops-secondary-button"
                onClick={() => openPrivatePreview(latestBuild.previewUrl!)}
              >
                <ExternalLink size={15} aria-hidden="true" />
                在新标签页打开预览
              </button>
            )}
            {latestBuild.sourceUrl && (
              <a href={latestBuild.sourceUrl}>
                <Download size={15} aria-hidden="true" />
                下载网站源码
              </a>
            )}
            {hasSuccessfulBuild && (
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={Boolean(
                  busyAction ||
                    rebuildRequestActive ||
                    !observation.rebuildRequest.allowed,
                )}
                onClick={() => {
                  setRebuildError(null);
                  setRebuildDialogOpen(true);
                }}
              >
                <Wrench size={15} aria-hidden="true" />
                {rebuildRequestActive ? "重制需求处理中" : "提交官网重制需求"}
              </button>
            )}
            {["preview_ready", "approved"].includes(latestBuild.status) && (
              <button
                type="button"
                className="siteops-secondary-button"
                disabled
                title="即将上线"
              >
                发布博客与行业近况（即将上线）
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
                  重试打开预览
                </a>
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
              域名与发布
            </p>
            <h3 id="siteops-domain-title">连接阿里云</h3>
            <p>授权完成后，FrontMind 将自动处理域名查询、网站配置与发布。</p>
          </div>
          <span
            className="siteops-status-pill"
            data-status={observation.aliyunConnection.status ?? "none"}
          >
            {observation.aliyunConnection.status === "active"
              ? "已连接"
              : observation.aliyunConnection.status === "authorization_required"
                ? "等待完成授权"
                : observation.aliyunConnection.status === "attention_required"
                  ? "需要协助"
                  : "尚未连接"}
          </span>
        </div>

        <div className="siteops-domain-actions">
          {observation.aliyunConnection.status === "not_connected" && (
            <button
              type="button"
              className="siteops-primary-button"
              disabled={!onBeginAliyun || Boolean(busyAction)}
              onClick={() => void beginAliyunConnection()}
            >
              {busyAction === "aliyun_begin" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              连接阿里云
            </button>
          )}
          {observation.aliyunConnection.status === "authorization_required" && (
            <>
              <button
                type="button"
                className="siteops-primary-button"
                disabled={
                  !onLoadAliyunAuthorizationGuide || Boolean(busyAction)
                }
                onClick={() => void openAliyunAuthorizationGuide()}
              >
                {busyAction === "aliyun_guide" && (
                  <Loader2
                    className="siteops-spin"
                    size={15}
                    aria-hidden="true"
                  />
                )}
                前往阿里云完成授权
              </button>
              <button
                type="button"
                className="siteops-secondary-button"
                disabled={!onVerifyAliyun || Boolean(busyAction)}
                onClick={() =>
                  runConnectionAction("aliyun_verify", onVerifyAliyun)
                }
              >
                我已完成授权
              </button>
            </>
          )}
          {aliyunGuide && (
            <div
              className="siteops-aliyun-guide"
              role="region"
              aria-label="阿里云授权步骤"
            >
              <strong>按以下 3 步完成一次授权</strong>
              <ol>
                <li>
                  <span>
                    复制固定角色名称，并在已打开的阿里云页面创建角色。
                  </span>
                  <button
                    type="button"
                    className="siteops-secondary-button"
                    onClick={() =>
                      void copyAliyunAuthorizationStep(
                        "role",
                        aliyunGuide.roleName,
                      )
                    }
                  >
                    {copiedAliyunStep === "role" ? "已复制" : "复制角色名称"}
                  </button>
                </li>
                <li>
                  <span>在角色信任设置中粘贴第 2 步配置。</span>
                  <button
                    type="button"
                    className="siteops-secondary-button"
                    onClick={() =>
                      void copyAliyunAuthorizationStep(
                        "trust",
                        aliyunGuide.trustPolicyText,
                      )
                    }
                  >
                    {copiedAliyunStep === "trust"
                      ? "已复制"
                      : "复制第 2 步配置"}
                  </button>
                </li>
                <li>
                  <span>创建并绑定权限策略，然后返回点击“我已完成授权”。</span>
                  <button
                    type="button"
                    className="siteops-secondary-button"
                    onClick={() =>
                      void copyAliyunAuthorizationStep(
                        "permission",
                        aliyunGuide.permissionPolicyText,
                      )
                    }
                  >
                    {copiedAliyunStep === "permission"
                      ? "已复制"
                      : "复制第 3 步配置"}
                  </button>
                </li>
              </ol>
              <a href={aliyunGuide.configurationDownloadUrl}>
                <Download size={15} aria-hidden="true" />
                下载备用配置
              </a>
            </div>
          )}
          {observation.aliyunConnection.status === "active" && (
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
              解除连接
            </button>
          )}
        </div>

        {observation.aliyunConnection.status === "authorization_required" && (
          <div className="siteops-notice warning">
            请在阿里云官方页面完成授权，然后返回这里继续。
          </div>
        )}
        {observation.aliyunConnection.status === "attention_required" && (
          <div className="siteops-notice warning">
            阿里云授权需要协助，请稍后重试或提交工单。
          </div>
        )}
        {!observation.aliyunConnection.canRotate && (
          <div className="siteops-notice warning">
            当前域名操作尚未完成，完成后才能解除连接。
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
                    `确认接入已有域名 ${domain}？系统会验证它属于您已连接的阿里云账号，不会购买或扣费。`,
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
              接入已有域名
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
              获取购买报价
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
            <p>证件、地址和电话等实名资料继续由您在阿里云官方页面管理。</p>
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
                ；从您已连接的阿里云账号扣费。
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
              确认并从已连接的阿里云账号扣费
            </button>
          </div>
        )}

        {observation.domainState && (
          <div className="siteops-domain-state">
            <strong>
              {observation.domainState.displayDomain ||
                observation.domainState.domain}
            </strong>
            <span>
              实名：
              {customerDomainStateLabel(observation.domainState.realNameStatus)}
            </span>
            <span>
              所有权：
              {customerDomainStateLabel(
                observation.domainState.ownershipStatus,
              )}
            </span>
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
              备案：
              {customerDomainStateLabel(observation.domainState.icpStatus)}
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
                      `确认开启 ${domain} 的自动续费？未来续费将按届时价格从您已连接的阿里云账号扣款；开启自动续费不代表本次续费已经成功。`,
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
            </div>
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
      </section>

      {(!hasSuccessfulBuild || rebuildInProgress) &&
        !rebuildNeedsKnowledgeSnapshot && (
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
                disabled={
                  !message.trim() || !onSendMessage || Boolean(busyAction)
                }
              >
                {busyAction === "message" ? (
                  <Loader2
                    className="siteops-spin"
                    size={16}
                    aria-hidden="true"
                  />
                ) : (
                  <Send size={16} aria-hidden="true" />
                )}
                发送
              </button>
            </div>
          </form>
        )}
    </section>
  );
}
