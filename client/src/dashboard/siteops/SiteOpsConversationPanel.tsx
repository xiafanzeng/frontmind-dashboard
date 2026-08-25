import type {
  SiteOpsExecutionStep,
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
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { copyToClipboard } from "@/lib/utils";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  Loader2,
  RefreshCw,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  onStartAliyunRoleProvisioning?: () => Promise<
    | { status: "active"; connected: true }
    | {
        status: "ready";
        connected: false;
        rosAuthorizationUrl: string;
        expiresAt: string;
        retryAfterMs: number;
      }
  >;
  onProbeAliyunRole?: () => Promise<
    | { status: "active"; connected: true }
    | {
        status: "pending";
        connected: false;
        reason: "role_not_ready" | "permission_propagating" | "provider_retry";
        retryAfterMs: number;
      }
    | {
        status: "attention_required";
        connected: false;
        reason:
          | "account_mismatch"
          | "permission_incomplete"
          | "external_id_not_enforced";
        retryable: false;
      }
  >;
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
const ALIYUN_AUTHORIZATION_WINDOW_NAME = "frontmind-aliyun-authorization";
const ALIYUN_OAUTH_COMPLETION_MESSAGE =
  "frontmind:siteops:aliyun-oauth" as const;
const ALIYUN_ROLE_POLL_DELAYS_MS = [
  2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000,
] as const;
const ALIYUN_ROLE_POLL_MAX_DURATION_MS = 10 * 60 * 1_000;

type AliyunOAuthCompletionStatus = "success" | "cancelled" | "failed";

type AliyunOAuthWindowState = "checking" | "provisioning" | "failed";

type AliyunFlowPhase = "idle" | "oauth" | "starting" | "waiting";

const ALIYUN_OAUTH_WINDOW_COPY: Record<
  AliyunOAuthWindowState,
  { title: string; description: string }
> = {
  checking: {
    title: "正在检查阿里云授权配置",
    description: "请稍候，FrontMind 正在确认安全的授权入口。",
  },
  provisioning: {
    title: "正在准备安全角色",
    description:
      "请在即将打开的阿里云官方页面审阅并确认创建；FrontMind 会自动检查结果。",
  },
  failed: {
    title: "暂时无法打开阿里云授权",
    description: "请返回 FrontMind 页面查看处理提示，配置更新后再重试。",
  },
};

const ALIYUN_PENDING_COPY = {
  role_not_ready: "等待阿里云完成创建",
  permission_propagating: "等待阿里云完成创建",
  provider_retry: "等待阿里云完成创建",
} as const;

const ALIYUN_ATTENTION_COPY = {
  account_mismatch:
    "当前阿里云登录账号与已连接账号不一致，请切换到正确账号后重试。",
  permission_incomplete:
    "阿里云授权权限不完整，请重新打开一键授权并确认完整权限。",
  external_id_not_enforced:
    "阿里云授权的安全校验未完整生效，请重新执行一键授权。",
} as const;

function renderAliyunOAuthWindowState(
  authorizationWindow: Window,
  state: AliyunOAuthWindowState,
) {
  try {
    const copy = ALIYUN_OAUTH_WINDOW_COPY[state];
    const popupDocument = authorizationWindow.document;
    popupDocument.documentElement.lang = "zh-CN";
    popupDocument.title = copy.title;

    const main = popupDocument.createElement("main");
    main.setAttribute("role", state === "failed" ? "alert" : "status");
    main.setAttribute("aria-live", state === "failed" ? "assertive" : "polite");
    main.style.fontFamily =
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    main.style.maxWidth = "32rem";
    main.style.margin = "12vh auto";
    main.style.padding = "2rem";
    main.style.lineHeight = "1.65";
    main.style.color = "#25222d";

    const heading = popupDocument.createElement("h1");
    heading.textContent = copy.title;
    heading.style.fontSize = "1.35rem";
    heading.style.margin = "0 0 .75rem";
    main.appendChild(heading);

    const description = popupDocument.createElement("p");
    description.textContent = copy.description;
    description.style.margin = "0";
    main.appendChild(description);

    if (state === "failed") {
      const closeButton = popupDocument.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = "关闭窗口";
      closeButton.style.marginTop = "1.25rem";
      closeButton.style.padding = ".65rem 1rem";
      closeButton.addEventListener("click", () => authorizationWindow.close());
      main.appendChild(closeButton);
    }

    popupDocument.body.replaceChildren(main);
  } catch {
    // A popup may be closed between window.open and rendering. The parent page
    // remains the authoritative, accessible error surface in that case.
  }
}

function aliyunOAuthCompletionStatus(
  event: MessageEvent,
  authorizationWindow: Window | null,
): AliyunOAuthCompletionStatus | null {
  if (
    event.origin !== window.location.origin ||
    !authorizationWindow ||
    event.source !== authorizationWindow ||
    typeof event.data !== "object" ||
    event.data === null ||
    event.data.type !== ALIYUN_OAUTH_COMPLETION_MESSAGE
  ) {
    return null;
  }
  return ["success", "cancelled", "failed"].includes(event.data.status)
    ? (event.data.status as AliyunOAuthCompletionStatus)
    : null;
}

function isTrustedAliyunOAuthUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["signin.aliyun.com", "oauth.aliyun.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function isTrustedAliyunRosUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname === "ros.console.aliyun.com"
    );
  } catch {
    return false;
  }
}

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
  if (
    /(?:invalid_client|app\s+not\s+exists|appsecret|client[\s_-]*id)/iu.test(
      content,
    )
  ) {
    return "阿里云连接配置需要 FrontMind 管理员更新。";
  }
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

const SITEOPS_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatSiteOpsDuration(
  startedAt: string,
  completedAt: string | null,
  now: number,
) {
  const started = Date.parse(startedAt);
  const completed = completedAt ? Date.parse(completedAt) : now;
  const totalSeconds = Math.max(0, Math.floor((completed - started) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function SiteOpsMessageBubble({ item }: { item: SiteOpsMessageProjection }) {
  const [copied, setCopied] = useState(false);
  const content = customerFacingMessage(item.content);
  return (
    <article className="siteops-message" data-role={item.role}>
      <span className="siteops-message-avatar" aria-hidden="true">
        {item.role === "user" ? <UserRound size={17} /> : <Bot size={17} />}
      </span>
      <div className="siteops-message-bubble">
        <div className="siteops-message-meta">
          <strong>
            {item.role === "user" ? "你" : SITEOPS_CUSTOMER_DISPLAY_NAME}
          </strong>
          {item.metadata?.siteOps && (
            <span data-status={item.metadata.siteOps.status}>
              {CARD_LABELS[item.metadata.siteOps.kind] || "任务状态"}
            </span>
          )}
        </div>
        {item.role === "assistant" ? (
          <MarkdownRenderer
            content={content}
            className="siteops-message-markdown"
          />
        ) : (
          <p>{content}</p>
        )}
        <footer className="siteops-message-footer">
          <time dateTime={item.sentAt}>
            {SITEOPS_TIME_FORMATTER.format(new Date(item.sentAt))}
          </time>
          {item.role === "assistant" && (
            <button
              type="button"
              aria-label={copied ? "已复制消息" : "复制消息"}
              title={copied ? "已复制" : "复制"}
              onClick={() => {
                void copyToClipboard(content).then((ok) => setCopied(ok));
              }}
            >
              {copied ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                <Copy size={13} aria-hidden="true" />
              )}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
}

function visualGenerationProgressPage(item: SiteOpsMessageProjection) {
  const card = item.metadata?.siteOps;
  if (
    item.role !== "assistant" ||
    card?.kind !== "build_progress" ||
    card.payload.stage !== "visual_searching"
  ) {
    return null;
  }
  const numberedPage = item.content.match(/正在生成第\s*(\d+)\s*组/u);
  if (numberedPage) return Number(numberedPage[1]);
  return item.content.includes("正在生成 9 个视觉候选") ? 1 : null;
}

function SiteOpsExecutionTimeline({
  steps,
}: {
  steps: SiteOpsExecutionStep[];
}) {
  const [now, setNow] = useState(() => Date.now());
  const operationId = useMemo(() => {
    const active = steps.find((step) =>
      ["queued", "running"].includes(step.status),
    );
    const selected = active ?? steps[0];
    return selected?.id.split(":", 1)[0] ?? null;
  }, [steps]);
  const visibleSteps = useMemo(
    () =>
      operationId
        ? steps.filter((step) => step.id.startsWith(`${operationId}:`))
        : [],
    [operationId, steps],
  );
  const isRunning = visibleSteps.some((step) => step.status === "running");

  useEffect(() => {
    if (!isRunning) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRunning, operationId]);

  if (visibleSteps.length === 0) return null;
  return (
    <section
      className="siteops-execution-timeline"
      aria-labelledby="siteops-timeline-title"
    >
      <div className="siteops-timeline-heading">
        <div>
          <Clock3 size={17} aria-hidden="true" />
          <h3 id="siteops-timeline-title">执行时间线</h3>
        </div>
        {isRunning && <span>运行中 · 每秒更新</span>}
      </div>
      <ol>
        {visibleSteps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="siteops-timeline-icon" aria-hidden="true">
              {step.status === "running" ? (
                <Loader2 className="siteops-spin" size={15} />
              ) : step.status === "succeeded" ? (
                <Check size={15} />
              ) : ["failed", "attention_required"].includes(step.status) ? (
                <AlertCircle size={15} />
              ) : (
                <Clock3 size={14} />
              )}
            </span>
            <div>
              <strong>{step.label}</strong>
              <time dateTime={step.startedAt}>
                {SITEOPS_TIME_FORMATTER.format(new Date(step.startedAt))}
              </time>
            </div>
            <span className="siteops-timeline-duration">
              {step.status === "queued"
                ? "等待开始"
                : formatSiteOpsDuration(step.startedAt, step.completedAt, now)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
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
  onAction,
  onBeginAliyun,
  onLoadAliyunAuthorizationGuide,
  onStartAliyunRoleProvisioning,
  onProbeAliyunRole,
  onDisconnectAliyun,
  onSubmitIcpFiling,
}: SiteOpsConversationPanelProps) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [aliyunConnectionError, setAliyunConnectionError] = useState<
    string | null
  >(null);
  const [aliyunProvisioningMessage, setAliyunProvisioningMessage] = useState<
    string | null
  >(null);
  const [aliyunFlowPhase, setAliyunFlowPhase] =
    useState<AliyunFlowPhase>("idle");
  const [previewOpenError, setPreviewOpenError] = useState<string | null>(null);
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
  const [activeVisualPage, setActiveVisualPage] = useState(1);
  const aliyunAuthorizationWindow = useRef<Window | null>(null);
  const aliyunFlowPhaseRef = useRef<AliyunFlowPhase>("idle");
  const aliyunFlowGenerationRef = useRef(0);
  const aliyunPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliyunPollDeadlineRef = useRef(0);
  const aliyunPollDelayIndexRef = useRef(0);
  const aliyunProbeInFlightGenerationRef = useRef<number | null>(null);
  const continueAliyunProvisioningRef = useRef<() => void>(() => undefined);
  const probeAliyunRoleRef = useRef<() => void>(() => undefined);
  const stopAliyunFlowRef = useRef<
    (generation: number, authorizationWindow: Window, message: string) => void
  >(() => undefined);
  const clearAliyunPollTimerRef = useRef<() => void>(() => undefined);
  const aliyunCallbacksRef = useRef({
    onRefresh,
    onStartAliyunRoleProvisioning,
    onProbeAliyunRole,
  });
  aliyunCallbacksRef.current = {
    onRefresh,
    onStartAliyunRoleProvisioning,
    onProbeAliyunRole,
  };
  const previousVisualPageCount = useRef(0);
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
  const visualPages = useMemo(() => {
    if (observation?.visualCandidatePages?.length) {
      return observation.visualCandidatePages;
    }
    return observation?.visualCandidates.length
      ? [
          {
            batchId: "legacy-current-page",
            page: 1,
            candidates: observation.visualCandidates,
          },
        ]
      : [];
  }, [observation?.visualCandidatePages, observation?.visualCandidates]);

  useEffect(() => {
    const count = visualPages.length;
    if (count > previousVisualPageCount.current) {
      setActiveVisualPage(count);
    } else if (count === 0) {
      setActiveVisualPage(1);
    } else {
      setActiveVisualPage((current) => Math.min(Math.max(current, 1), count));
    }
    previousVisualPageCount.current = count;
  }, [visualPages.length]);

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

  async function requestRebuild() {
    if (!onAction || busyAction || !observation?.rebuildRequest.allowed) {
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
          : "重置申请没有提交成功，请稍后重试。";
      setRebuildError(message);
      setLocalError(message);
    } finally {
      setBusyAction(null);
    }
  }

  function setAliyunPhase(phase: AliyunFlowPhase) {
    aliyunFlowPhaseRef.current = phase;
    setAliyunFlowPhase(phase);
  }

  function clearAliyunPollTimer() {
    if (aliyunPollTimerRef.current !== null) {
      clearTimeout(aliyunPollTimerRef.current);
      aliyunPollTimerRef.current = null;
    }
  }

  function isCurrentAliyunFlow(
    generation: number,
    authorizationWindow: Window,
  ) {
    return (
      aliyunFlowGenerationRef.current === generation &&
      aliyunAuthorizationWindow.current === authorizationWindow
    );
  }

  function beginAliyunFlow(
    phase: Exclude<AliyunFlowPhase, "idle">,
    authorizationWindow: Window,
  ) {
    clearAliyunPollTimer();
    aliyunProbeInFlightGenerationRef.current = null;
    const generation = aliyunFlowGenerationRef.current + 1;
    aliyunFlowGenerationRef.current = generation;
    aliyunAuthorizationWindow.current = authorizationWindow;
    setAliyunPhase(phase);
    setAliyunConnectionError(null);
    setAliyunProvisioningMessage(null);
    setLocalError(null);
    return generation;
  }

  function stopAliyunFlow(
    generation: number,
    authorizationWindow: Window,
    message: string,
  ) {
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    clearAliyunPollTimer();
    aliyunProbeInFlightGenerationRef.current = null;
    setAliyunPhase("idle");
    setAliyunProvisioningMessage(null);
    setAliyunConnectionError(message);
    renderAliyunOAuthWindowState(authorizationWindow, "failed");
    if (authorizationWindow.closed === true) {
      aliyunAuthorizationWindow.current = null;
    }
  }

  async function completeAliyunRoleProvisioning(
    generation: number,
    authorizationWindow: Window,
  ) {
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    clearAliyunPollTimer();
    setAliyunPhase("starting");
    setAliyunProvisioningMessage("阿里云已连接");
    try {
      await aliyunCallbacksRef.current.onRefresh?.();
    } catch {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "阿里云授权已生效，但连接状态暂时无法刷新，请稍后重试。",
      );
      return;
    }
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    try {
      authorizationWindow.close();
    } catch {
      // The connection is already active. A browser denying close is harmless.
    }
    aliyunAuthorizationWindow.current = null;
    aliyunProbeInFlightGenerationRef.current = null;
    setAliyunPhase("idle");
    setAliyunConnectionError(null);
    setAliyunProvisioningMessage("阿里云已连接");
  }

  function aliyunRolePollDelay(retryAfterMs: number) {
    const index = Math.min(
      aliyunPollDelayIndexRef.current,
      ALIYUN_ROLE_POLL_DELAYS_MS.length - 1,
    );
    const sequenceDelay = ALIYUN_ROLE_POLL_DELAYS_MS[index];
    aliyunPollDelayIndexRef.current = Math.min(
      index + 1,
      ALIYUN_ROLE_POLL_DELAYS_MS.length - 1,
    );
    const providerDelay = Number.isFinite(retryAfterMs)
      ? Math.min(Math.max(0, retryAfterMs), 30_000)
      : 0;
    return Math.max(sequenceDelay, providerDelay);
  }

  function scheduleAliyunRoleProbe(
    generation: number,
    authorizationWindow: Window,
    retryAfterMs: number,
  ) {
    if (
      !isCurrentAliyunFlow(generation, authorizationWindow) ||
      aliyunFlowPhaseRef.current !== "waiting"
    ) {
      return;
    }
    clearAliyunPollTimer();
    const remainingMs = aliyunPollDeadlineRef.current - Date.now();
    if (remainingMs <= 0) {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "尚未检测到安全角色，可重新打开阿里云继续",
      );
      return;
    }
    const delayMs = aliyunRolePollDelay(retryAfterMs);
    aliyunPollTimerRef.current = setTimeout(
      () => {
        aliyunPollTimerRef.current = null;
        if (Date.now() >= aliyunPollDeadlineRef.current) {
          stopAliyunFlow(
            generation,
            authorizationWindow,
            "尚未检测到安全角色，可重新打开阿里云继续",
          );
          return;
        }
        probeAliyunRoleRef.current();
      },
      Math.min(delayMs, remainingMs),
    );
  }

  async function probeAliyunRoleNow() {
    const generation = aliyunFlowGenerationRef.current;
    const authorizationWindow = aliyunAuthorizationWindow.current;
    if (
      !authorizationWindow ||
      aliyunFlowPhaseRef.current !== "waiting" ||
      aliyunProbeInFlightGenerationRef.current === generation
    ) {
      return;
    }
    const probe = aliyunCallbacksRef.current.onProbeAliyunRole;
    if (!probe) {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "暂时无法检查阿里云授权结果，请稍后重试。",
      );
      return;
    }
    clearAliyunPollTimer();
    aliyunProbeInFlightGenerationRef.current = generation;
    try {
      const result = await probe();
      if (
        !isCurrentAliyunFlow(generation, authorizationWindow) ||
        aliyunFlowPhaseRef.current !== "waiting"
      ) {
        return;
      }
      if (result.status === "active") {
        await completeAliyunRoleProvisioning(generation, authorizationWindow);
        return;
      }
      if (result.status === "attention_required") {
        stopAliyunFlow(
          generation,
          authorizationWindow,
          ALIYUN_ATTENTION_COPY[result.reason],
        );
        return;
      }
      setAliyunProvisioningMessage(ALIYUN_PENDING_COPY[result.reason]);
      scheduleAliyunRoleProbe(
        generation,
        authorizationWindow,
        result.retryAfterMs,
      );
    } catch {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "暂时无法检查阿里云授权结果，请保留当前页面并稍后重试。",
      );
    } finally {
      if (aliyunProbeInFlightGenerationRef.current === generation) {
        aliyunProbeInFlightGenerationRef.current = null;
      }
    }
  }

  async function requestAliyunRoleProvisioning(
    generation: number,
    authorizationWindow: Window,
  ) {
    const start = aliyunCallbacksRef.current.onStartAliyunRoleProvisioning;
    if (!start) {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "阿里云一键授权暂时不可用，请稍后重试。",
      );
      return;
    }
    let result: Awaited<ReturnType<typeof start>>;
    try {
      result = await start();
    } catch {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "暂时无法准备阿里云一键授权，请保留当前页面并稍后重试。",
      );
      return;
    }
    if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
    if (result.status === "active") {
      await completeAliyunRoleProvisioning(generation, authorizationWindow);
      return;
    }
    if (!isTrustedAliyunRosUrl(result.rosAuthorizationUrl)) {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "暂时无法打开安全的阿里云授权页面，请稍后重试。",
      );
      return;
    }
    if (authorizationWindow.closed === true) {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "阿里云授权窗口已关闭，请重新执行一键授权。",
      );
      return;
    }
    const now = Date.now();
    const parsedExpiry = Date.parse(result.expiresAt);
    const expiry =
      Number.isFinite(parsedExpiry) && parsedExpiry > now
        ? parsedExpiry
        : now + ALIYUN_ROLE_POLL_MAX_DURATION_MS;
    aliyunPollDeadlineRef.current = Math.min(
      now + ALIYUN_ROLE_POLL_MAX_DURATION_MS,
      expiry,
    );
    aliyunPollDelayIndexRef.current = 0;
    setAliyunPhase("waiting");
    setAliyunProvisioningMessage(ALIYUN_PENDING_COPY.role_not_ready);
    renderAliyunOAuthWindowState(authorizationWindow, "provisioning");
    try {
      authorizationWindow.opener = null;
    } catch {
      // The callback has completed; severing opener is best-effort hardening.
    }
    try {
      authorizationWindow.location.href = result.rosAuthorizationUrl;
      authorizationWindow.focus();
    } catch {
      stopAliyunFlow(
        generation,
        authorizationWindow,
        "暂时无法打开阿里云一键授权页面，请保留当前页面并稍后重试。",
      );
      return;
    }
    scheduleAliyunRoleProbe(
      generation,
      authorizationWindow,
      result.retryAfterMs,
    );
  }

  async function continueAliyunProvisioningAfterOAuth() {
    const generation = aliyunFlowGenerationRef.current;
    const authorizationWindow = aliyunAuthorizationWindow.current;
    if (
      !authorizationWindow ||
      aliyunFlowPhaseRef.current !== "oauth" ||
      !isCurrentAliyunFlow(generation, authorizationWindow)
    ) {
      return;
    }
    setAliyunPhase("starting");
    setAliyunProvisioningMessage("正在准备安全角色");
    renderAliyunOAuthWindowState(authorizationWindow, "provisioning");
    setBusyAction("aliyun_start");
    try {
      try {
        await aliyunCallbacksRef.current.onRefresh?.();
      } catch {
        stopAliyunFlow(
          generation,
          authorizationWindow,
          "账号身份已确认，但连接状态暂时无法刷新，请稍后重试。",
        );
        return;
      }
      if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
      await requestAliyunRoleProvisioning(generation, authorizationWindow);
    } finally {
      if (aliyunFlowGenerationRef.current === generation) {
        setBusyAction(null);
      }
    }
  }

  async function beginAliyunConnection() {
    if (!onBeginAliyun || busyAction || aliyunFlowPhaseRef.current !== "idle") {
      return;
    }
    const authorizationWindow = window.open(
      "",
      ALIYUN_AUTHORIZATION_WINDOW_NAME,
    );
    setAliyunConnectionError(null);
    setLocalError(null);
    if (!authorizationWindow) {
      setAliyunConnectionError(
        "阿里云授权页面被浏览器阻止，请允许此站点打开弹窗后重试。",
      );
      return;
    }
    const generation = beginAliyunFlow("oauth", authorizationWindow);
    renderAliyunOAuthWindowState(authorizationWindow, "checking");
    authorizationWindow.focus();
    setBusyAction("aliyun_begin");
    try {
      const result = await onBeginAliyun();
      if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
      if (!isTrustedAliyunOAuthUrl(result.authorizationUrl)) {
        stopAliyunFlow(
          generation,
          authorizationWindow,
          "暂时无法打开安全的阿里云授权页面，请稍后重试。",
        );
        return;
      }
      if (authorizationWindow.closed === true) {
        stopAliyunFlow(
          generation,
          authorizationWindow,
          "阿里云授权窗口已关闭，请重新连接。",
        );
        return;
      }
      authorizationWindow.location.href = result.authorizationUrl;
      authorizationWindow.focus();
    } catch (connectionError) {
      if (!isCurrentAliyunFlow(generation, authorizationWindow)) return;
      stopAliyunFlow(
        generation,
        authorizationWindow,
        connectionError instanceof Error
          ? customerFacingMessage(connectionError.message)
          : "暂时无法打开阿里云授权页面，请稍后重试。",
      );
      authorizationWindow.focus();
    } finally {
      if (aliyunFlowGenerationRef.current === generation) {
        setBusyAction(null);
      }
    }
  }

  async function startAliyunOneClickAuthorization() {
    if (
      !onStartAliyunRoleProvisioning ||
      busyAction ||
      aliyunFlowPhaseRef.current !== "idle"
    ) {
      return;
    }
    const authorizationWindow = window.open(
      "",
      ALIYUN_AUTHORIZATION_WINDOW_NAME,
    );
    setAliyunConnectionError(null);
    setLocalError(null);
    if (!authorizationWindow) {
      setAliyunConnectionError(
        "阿里云授权页面被浏览器阻止，请允许此站点打开弹窗后重试。",
      );
      return;
    }
    const generation = beginAliyunFlow("starting", authorizationWindow);
    setAliyunProvisioningMessage("正在准备安全角色");
    renderAliyunOAuthWindowState(authorizationWindow, "provisioning");
    authorizationWindow.focus();
    setBusyAction("aliyun_start");
    try {
      await requestAliyunRoleProvisioning(generation, authorizationWindow);
    } finally {
      if (aliyunFlowGenerationRef.current === generation) {
        setBusyAction(null);
      }
    }
  }

  async function openAliyunAuthorizationGuide() {
    if (!onLoadAliyunAuthorizationGuide || busyAction) return;
    setBusyAction("aliyun_guide");
    setLocalError(null);
    try {
      const guide = await onLoadAliyunAuthorizationGuide();
      if (!guide.available) {
        setLocalError("阿里云授权配置尚未就绪，请联系 FrontMind。");
        return;
      }
      setAliyunGuide({
        consoleUrl: guide.consoleUrl,
        configurationDownloadUrl: guide.configurationDownloadUrl,
        roleName: guide.roleName,
        trustPolicyText: guide.trustPolicyText,
        permissionPolicyText: guide.permissionPolicyText,
      });
    } catch (guideError) {
      setLocalError(
        guideError instanceof Error
          ? customerFacingMessage(guideError.message)
          : "暂时无法载入阿里云手动配置，请稍后重试。",
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
      if (key === "aliyun_disconnect") {
        setAliyunGuide(null);
        setAliyunProvisioningMessage(null);
      }
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

  continueAliyunProvisioningRef.current = () => {
    void continueAliyunProvisioningAfterOAuth();
  };
  probeAliyunRoleRef.current = () => {
    void probeAliyunRoleNow();
  };
  stopAliyunFlowRef.current = stopAliyunFlow;
  clearAliyunPollTimerRef.current = clearAliyunPollTimer;

  useEffect(() => {
    function handleAliyunOAuthCompletion(event: MessageEvent) {
      const authorizationWindow = aliyunAuthorizationWindow.current;
      const status = aliyunOAuthCompletionStatus(event, authorizationWindow);
      if (
        !status ||
        !authorizationWindow ||
        aliyunFlowPhaseRef.current !== "oauth"
      ) {
        return;
      }
      const generation = aliyunFlowGenerationRef.current;
      if (status === "success") {
        setAliyunConnectionError(null);
        setLocalError(null);
        continueAliyunProvisioningRef.current();
        return;
      }
      stopAliyunFlowRef.current(
        generation,
        authorizationWindow,
        status === "cancelled"
          ? "你已取消阿里云授权，未产生任何连接。"
          : "阿里云连接配置需要 FrontMind 管理员更新。",
      );
    }

    function handleWindowFocus() {
      const authorizationWindow = aliyunAuthorizationWindow.current;
      if (!authorizationWindow) return;
      if (
        aliyunFlowPhaseRef.current === "oauth" &&
        authorizationWindow.closed === true
      ) {
        stopAliyunFlowRef.current(
          aliyunFlowGenerationRef.current,
          authorizationWindow,
          "你已关闭阿里云授权窗口，未产生任何连接。",
        );
        return;
      }
      if (aliyunFlowPhaseRef.current === "waiting") {
        probeAliyunRoleRef.current();
      }
    }

    window.addEventListener("message", handleAliyunOAuthCompletion);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("message", handleAliyunOAuthCompletion);
      window.removeEventListener("focus", handleWindowFocus);
      clearAliyunPollTimerRef.current();
      aliyunFlowGenerationRef.current += 1;
      aliyunProbeInFlightGenerationRef.current = null;
      aliyunFlowPhaseRef.current = "idle";
    };
  }, []);

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
  const interactionLocked = Boolean(
    busyAction || !onAction || observation.rebuildRequest.resetPending,
  );
  const visualGeneration = observation.visualGeneration ?? {
    status: "idle" as const,
    targetPage: null,
    generatedPages: visualPages.length,
    maxPages: 3 as const,
    canGenerateMore: visualPages.length < 3,
    canSelectExisting: true,
  };
  const visualGenerationPending =
    visualGeneration.status === "generating" ||
    busyAction === "reselect_visual";
  const visualGenerationTargetPage =
    visualGeneration.targetPage ??
    Math.min(visualGeneration.generatedPages + 1, visualGeneration.maxPages);
  const visualSelectionOpen =
    observation.interactionState === "awaiting_visual_selection";
  const visualSelectionDisabled =
    interactionLocked ||
    visualGenerationPending ||
    !visualGeneration.canSelectExisting ||
    !visualSelectionOpen ||
    !aiBuilderConfigured;
  const currentVisualPage =
    visualPages.find((page) => page.page === activeVisualPage) ??
    visualPages[visualPages.length - 1];
  const currentVisualGenerationMessage = observation.messages
    .filter(
      (item) =>
        visualGenerationProgressPage(item) === visualGeneration.targetPage,
    )
    .reduce<SiteOpsMessageProjection | null>(
      (latest, item) =>
        !latest || item.sequence > latest.sequence ? item : latest,
      null,
    );
  const visibleMessages = observation.messages.filter((item) => {
    if (visualGenerationProgressPage(item) === null) return true;
    return (
      visualGeneration.status === "generating" &&
      item.id === currentVisualGenerationMessage?.id
    );
  });
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
  const rebuildRequestActive = Boolean(
    observation.rebuildRequest.ticketId &&
      observation.rebuildRequest.status &&
      !["completed", "rejected", "cancelled"].includes(
        observation.rebuildRequest.status,
      ),
  );
  const rebuildRequestPending = Boolean(
    rebuildRequestActive && !observation.rebuildRequest.allowed,
  );
  const rebuildRequestLabel = observation.rebuildRequest.resetPending
    ? "正在下线旧官网"
    : rebuildRequestPending
      ? "重置申请处理中"
      : rebuildRequestActive && observation.rebuildRequest.resetApplied
        ? "重置已批准，请全新上传知识库"
        : "申请重置并全新开始";
  const hideExistingBuildDuringActiveRebuild = Boolean(
    rebuildRequestActive &&
      observation.rebuildRequest.resetApplied &&
      latestBuild?.id === observation.rebuildRequest.resetSourceBuildId,
  );
  const rebuildInProgress = observation.rebuildRequest.status === "in_progress";
  const rebuildNeedsKnowledgeSnapshot = Boolean(
    observation.rebuildRequest.resetApplied && !currentSnapshotId,
  );
  const rebuildInteractionLabel = observation.rebuildRequest.resetPending
    ? "正在下线旧官网"
    : observation.rebuildRequest.resetApplied
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
            {(observation.rebuildRequest.allowed || rebuildRequestActive) && (
              <button
                type="button"
                className="siteops-icon-button"
                aria-label={rebuildRequestLabel}
                disabled={Boolean(
                  busyAction || !observation.rebuildRequest.allowed,
                )}
                title={rebuildRequestLabel}
                onClick={() => {
                  setRebuildError(null);
                  setRebuildDialogOpen(true);
                }}
              >
                <Wrench size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </header>

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
            <AlertDialogTitle>{rebuildRequestLabel}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="siteops-reset-description">
                <p>提交后将由 FrontMind 人工受理；受理前不会改动当前官网。</p>
                <ul>
                  <li>批准后，当前线上官网会进入下线流程。</li>
                  <li>旧知识库、视觉方案和生成任务不会继续使用。</li>
                  <li>重置完成后必须全新上传知识库并重新生成。</li>
                  <li>域名、备案和阿里云连接会保留。</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="siteops-rebuild-reason">
            <span>重置原因与期望（选填）</span>
            <textarea
              value={rebuildReason}
              maxLength={2_000}
              rows={5}
              placeholder="例如：希望全新上传知识库并重新生成官网。"
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
              提交重置申请
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

      <SiteOpsExecutionTimeline steps={observation.executionSteps ?? []} />

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
        {visibleMessages.length === 0 ? (
          <div className="siteops-empty-copy">
            选择知识库版本后，FrontMind 会在这里整理建站资料。
          </div>
        ) : (
          visibleMessages.map((item) => (
            <SiteOpsMessageBubble item={item} key={item.id} />
          ))
        )}
      </div>

      {visualPages.length > 0 && currentVisualPage && (
        <section
          className="siteops-visual-board"
          aria-labelledby="siteops-visual-title"
        >
          <div className="siteops-board-heading">
            <div>
              <h3 id="siteops-visual-title">
                {visualSelectionOpen
                  ? `${visualPages.length * 9} 个视觉候选`
                  : "已选择的视觉方案"}
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
                  className="siteops-primary-button"
                  disabled={
                    interactionLocked ||
                    visualGenerationPending ||
                    !aiBuilderConfigured ||
                    !visualGeneration.canGenerateMore
                  }
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
                  {visualGenerationPending && (
                    <Loader2
                      className="siteops-spin"
                      size={15}
                      aria-hidden="true"
                    />
                  )}
                  {visualGenerationPending
                    ? `正在生成第 ${visualGenerationTargetPage} 组`
                    : visualGeneration.canGenerateMore
                      ? "重新生成 9 个视觉候选"
                      : "已生成全部 27 个候选"}
                </button>
              </div>
            )}
          </div>
          {visualGeneration.status === "retryable_error" && (
            <div className="siteops-notice error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>
                本次未能生成完整的新一组，当前候选仍可选择，也可稍后重试。
              </span>
            </div>
          )}
          {builderMessage && (
            <div className="siteops-builder-key-warning" role="status">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{builderMessage}</span>
            </div>
          )}
          {visualSelectionOpen && (
            <div
              className="siteops-visual-pagination"
              aria-label="视觉候选分组"
            >
              <button
                type="button"
                aria-label="上一组视觉候选"
                disabled={activeVisualPage <= 1}
                onClick={() =>
                  setActiveVisualPage((page) => Math.max(1, page - 1))
                }
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <div>
                {visualPages.map((page) => (
                  <button
                    type="button"
                    key={page.batchId}
                    data-active={page.page === activeVisualPage}
                    aria-current={
                      page.page === activeVisualPage ? "page" : undefined
                    }
                    onClick={() => setActiveVisualPage(page.page)}
                  >
                    第 {page.page} 组
                  </button>
                ))}
              </div>
              <span>
                {visualGeneration.canGenerateMore
                  ? `还可生成 ${visualGeneration.maxPages - visualGeneration.generatedPages} 组`
                  : "27 选 1"}
              </span>
              <button
                type="button"
                aria-label="下一组视觉候选"
                disabled={activeVisualPage >= visualPages.length}
                onClick={() =>
                  setActiveVisualPage((page) =>
                    Math.min(visualPages.length, page + 1),
                  )
                }
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="siteops-visual-grid">
            {currentVisualPage.candidates.map((candidate) => (
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
            <span>
              重置申请尚未完成；在批准并执行下线前，当前官网仍可继续预览和使用。
            </span>
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
            {latestBuild.previewUrl &&
              latestBuild.buildDelivery?.renderMode === "trusted_fallback" && (
                <p>
                  基础预览已生成，可以查看并继续完善；FrontMind
                  已记录主样式渲染的待优化项。
                </p>
              )}
            {latestBuild.previewUrl &&
              latestBuild.buildDelivery?.renderMode === "primary" &&
              latestBuild.buildDelivery.qaStatus !== "passed" && (
                <p>
                  官网预览已生成，质量检查中的非阻断建议已记录，不影响查看和后续发布。
                </p>
              )}
            {latestBuild.needsHelp && !latestBuild.previewUrl && (
              <p>
                本次没有生成可安全展示的版本。可以申请重置；批准并完成旧站下线后，请全新上传知识库并重新生成。
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
                  busyAction || !observation.rebuildRequest.allowed,
                )}
                onClick={() => {
                  setRebuildError(null);
                  setRebuildDialogOpen(true);
                }}
              >
                <Wrench size={15} aria-hidden="true" />
                {rebuildRequestLabel}
              </button>
            )}
            {latestBuild.needsHelp && !latestBuild.previewUrl && (
              <button
                type="button"
                className="siteops-primary-button"
                disabled={Boolean(
                  busyAction || !observation.rebuildRequest.allowed,
                )}
                onClick={() => {
                  setRebuildError(null);
                  setRebuildDialogOpen(true);
                }}
              >
                <Wrench size={15} aria-hidden="true" />
                {rebuildRequestLabel}
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
            <p className="siteops-aliyun-security-note">
              {
                "需阿里云主账号或具备 ROS、RAM 创建权限的管理员确认一次；FrontMind 不会获取客户 AccessKey。"
              }
            </p>
          </div>
          <span
            className="siteops-status-pill"
            data-status={observation.aliyunConnection.status ?? "none"}
          >
            {observation.aliyunConnection.status === "active"
              ? "阿里云已连接"
              : observation.aliyunConnection.status === "authorization_required"
                ? "等待完成授权"
                : observation.aliyunConnection.status === "attention_required"
                  ? "需要协助"
                  : "尚未连接"}
          </span>
        </div>

        {aliyunConnectionError && (
          <div
            className="siteops-notice error"
            role="alert"
            aria-live="assertive"
          >
            <AlertCircle size={18} aria-hidden="true" />
            <span>{aliyunConnectionError}</span>
          </div>
        )}

        {aliyunProvisioningMessage && !aliyunConnectionError && (
          <div
            className="siteops-notice siteops-aliyun-progress"
            role="status"
            aria-live="polite"
          >
            {aliyunProvisioningMessage === "阿里云已连接" ? (
              <Check size={18} aria-hidden="true" />
            ) : (
              <Loader2 className="siteops-spin" size={18} aria-hidden="true" />
            )}
            <span>{aliyunProvisioningMessage}</span>
          </div>
        )}

        <div className="siteops-domain-actions">
          {observation.aliyunConnection.status === "not_connected" && (
            <button
              type="button"
              className="siteops-primary-button"
              disabled={
                !onBeginAliyun ||
                Boolean(busyAction) ||
                aliyunFlowPhase !== "idle"
              }
              onClick={() => void beginAliyunConnection()}
            >
              {busyAction === "aliyun_begin" && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              一键连接阿里云
            </button>
          )}
          {["authorization_required", "attention_required"].includes(
            observation.aliyunConnection.status,
          ) && (
            <button
              type="button"
              className="siteops-primary-button"
              disabled={
                !onStartAliyunRoleProvisioning ||
                !onProbeAliyunRole ||
                Boolean(busyAction) ||
                aliyunFlowPhase !== "idle"
              }
              onClick={() => void startAliyunOneClickAuthorization()}
            >
              {["starting", "waiting"].includes(aliyunFlowPhase) && (
                <Loader2
                  className="siteops-spin"
                  size={15}
                  aria-hidden="true"
                />
              )}
              继续阿里云一键授权
            </button>
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
          <div className="siteops-notice warning" role="status">
            点击上方按钮后，只需在阿里云官方页面审阅并确认；FrontMind
            会自动检查授权结果。
          </div>
        )}
        {observation.aliyunConnection.status === "attention_required" && (
          <div
            className="siteops-notice warning"
            role="alert"
            aria-live="assertive"
          >
            当前授权需要重新确认，请使用上方一键授权修复。
          </div>
        )}
        {["authorization_required", "attention_required"].includes(
          observation.aliyunConnection.status,
        ) && (
          <details className="siteops-aliyun-manual">
            <summary>高级：手动配置</summary>
            <div className="siteops-aliyun-manual-content">
              <p>仅在一键授权无法使用时，按以下备用方式手动配置。</p>
              {!aliyunGuide && (
                <button
                  type="button"
                  className="siteops-secondary-button"
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
                  载入手动配置
                </button>
              )}
              {aliyunGuide && (
                <div
                  className="siteops-aliyun-guide"
                  role="region"
                  aria-label="阿里云手动授权步骤"
                >
                  <strong>备用手动配置（3 步）</strong>
                  <ol>
                    <li>
                      <span>在阿里云 RAM 控制台创建指定名称的角色。</span>
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
                        {copiedAliyunStep === "role"
                          ? "已复制"
                          : "复制角色名称"}
                      </button>
                    </li>
                    <li>
                      <span>在角色信任设置中粘贴信任配置。</span>
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
                          : "复制信任配置"}
                      </button>
                    </li>
                    <li>
                      <span>
                        创建并绑定权限策略；FrontMind 会继续自动检查结果。
                      </span>
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
                          : "复制权限配置"}
                      </button>
                    </li>
                  </ol>
                  <div className="siteops-aliyun-guide-links">
                    <a
                      href={aliyunGuide.consoleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={15} aria-hidden="true" />
                      打开 RAM 控制台
                    </a>
                    <a href={aliyunGuide.configurationDownloadUrl}>
                      <Download size={15} aria-hidden="true" />
                      下载备用配置
                    </a>
                  </div>
                </div>
              )}
            </div>
          </details>
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
    </section>
  );
}
