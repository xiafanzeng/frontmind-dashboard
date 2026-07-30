import type {
  DeliverySiteCheckStatus,
  DeliveryTicketQuota,
  DeliveryTicketStatus,
  WebsiteOperationCategory,
} from "@shared/delivery-ticket";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  LockKeyhole,
  Paperclip,
  RefreshCw,
  Send,
  Upload,
  X,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useMemo, useState } from "react";
import type { ServicePlanCode } from "./service-portal";
import "./ai-website-management-workspace.css";

/**
 * `domain_application` is included locally while older API clients still expose
 * the previous WebsiteOperationCategory union. The server schema owns the final
 * category list.
 */
export type AiWebsiteWorkOrderCategory =
  | WebsiteOperationCategory
  | "domain_application";

export type AiWebsiteSiteProfile = {
  domain: string;
  revision?: number;
  siteMode?: "managed" | "external" | "unknown";
  domainVerified?: boolean;
  domainStatus?: string | null;
  domainApplicationStatus?: string | null;
  icpVerified?: boolean;
  icpNumber?: string | null;
  icpStatus?: string | null;
  updatedAt?: string | number | Date | null;
};

export type AiWebsiteSiteCheck = {
  id: string;
  key: string;
  label: string;
  status: DeliverySiteCheckStatus;
  summary?: string | null;
  evidence?: string | null;
  source?: string | null;
  checkedAt?: string | number | Date | null;
  revision?: number;
  updatedAt?: string | number | Date | null;
};

export type AiWebsiteTicket = {
  id: string;
  type: "website_operation";
  category?: string | null;
  categoryLabel?: string | null;
  topic?: string | null;
  title?: string | null;
  status?: DeliveryTicketStatus;
  statusLabel?: string | null;
  publicStatus?: "pending" | "completed" | null;
  quotaState?: "reserved" | "consumed" | "released";
  revision?: number;
  submittedAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  resolvedAt?: string | number | Date | null;
  publicSummary?: string | null;
  adminPublicSummary?: string | null;
  completionSummary?: string | null;
  latestPublicMessage?: string | null;
  attachmentCount?: number;
  deliveryLinks?: Array<{
    id?: string;
    label: string;
    url: string;
  }>;
};

export type AiWebsiteWorkOrderSubmission = {
  category: AiWebsiteWorkOrderCategory | null;
  topic: string;
  description: string;
  /** Kept for compatibility with the current adapter; the new form never sets it. */
  targetPage: string;
  materialUrls: string[];
  attachmentFiles: File[];
  icpDeclarations?: {
    icpNumber: string;
  };
};

export type AiWebsiteWorkflowState = {
  domainApplication?: "not_started" | "pending" | "completed";
  icpFiling?: "locked" | "not_started" | "pending" | "completed";
  contentOperation?: "locked" | "available";
};

export type AiWebsiteWorkflowMetadata = {
  domainStatus?: string | null;
  icpStatus?: string | null;
  domainCompleted?: boolean;
  icpCompleted?: boolean;
  canSubmitDomain?: boolean;
  canSubmitIcp?: boolean;
  canSubmitContent?: boolean;
  lockReason?: string | null;
  icpLockReason?: string | null;
  contentLockReason?: string | null;
};

export type AiWebsiteManagementWorkspaceProps = {
  planCode: ServicePlanCode;
  siteProfile?: AiWebsiteSiteProfile | null;
  /** Historical check data is accepted for API compatibility but is never rendered. */
  siteChecks?: AiWebsiteSiteCheck[];
  websiteWorkflow?: AiWebsiteWorkflowMetadata | null;
  contentCatalog?: ReadonlyArray<{
    value: AiWebsiteWorkOrderCategory;
    label: string;
  }>;
  workflowState?: AiWebsiteWorkflowState | null;
  quota?: DeliveryTicketQuota | null;
  tickets?: AiWebsiteTicket[];
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  error?: string | null;
  onSubmit?: (input: AiWebsiteWorkOrderSubmission) => Promise<void> | void;
  /** Deprecated for this page. Website history details are summary-only in place. */
  onOpenTicket?: (ticketId: string) => void;
  onRefresh?: () => Promise<void> | void;
  onLoadMore?: () => Promise<void> | void;
  onUpgrade?: () => void;
};

type WorkOrderTypeDefinition = {
  id: AiWebsiteWorkOrderCategory;
  label: string;
};

const DOMAIN_APPLICATION: WorkOrderTypeDefinition = {
  id: "domain_application",
  label: "域名申请",
};

const ICP_FILING: WorkOrderTypeDefinition = {
  id: "icp_filing",
  label: "域名注册与 ICP 备案结果",
};

const ALIYUN_DOMAIN_URL = "https://wanwang.aliyun.com/";
const ALIYUN_DOMAIN_GUIDE_URL =
  "https://help.aliyun.com/zh/dws/getting-started/quickly-register-a-new-domain-name";
const ALIYUN_ICP_URL = "https://beian.aliyun.com/";
const ALIYUN_ICP_GUIDE_URL =
  "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview";
const ALIYUN_IDENTITY_GUIDE_URL =
  "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/upload-data-and-authenticity-verification/";

const CLOSED_TICKET_STATUSES = new Set<DeliveryTicketStatus>([
  "completed",
  "rejected",
  "cancelled",
]);

const VERIFIED_PROFILE_STATUSES = new Set([
  "active",
  "approved",
  "completed",
  "not_required",
  "passed",
  "verified",
]);

type WorkflowPhase = "icp" | "content";

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseReferenceLinks(value: string) {
  const candidates = Array.from(
    new Set(
      value
        .split(/[\r\n,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  const invalid: string[] = [];
  const urls = candidates.filter((candidate) => {
    const valid = isHttpUrl(candidate);
    if (!valid) invalid.push(candidate);
    return valid;
  });
  return { urls, invalid };
}

function ticketIsCompleted(ticket: AiWebsiteTicket) {
  if (ticket.publicStatus) return ticket.publicStatus === "completed";
  return Boolean(ticket.status && CLOSED_TICKET_STATUSES.has(ticket.status));
}

function ticketSummary(ticket: AiWebsiteTicket) {
  return (
    ticket.publicSummary?.trim() ||
    ticket.adminPublicSummary?.trim() ||
    ticket.completionSummary?.trim() ||
    ""
  );
}

function categoryLabel(
  ticket: AiWebsiteTicket,
  contentCatalog: WorkOrderTypeDefinition[],
) {
  return (
    ticket.categoryLabel?.trim() ||
    [DOMAIN_APPLICATION, ICP_FILING, ...contentCatalog].find(
      (item) => item.id === ticket.category,
    )?.label ||
    "官网内容需求"
  );
}

function profileStatusCompleted(value: string | null | undefined) {
  return Boolean(value && VERIFIED_PROFILE_STATUSES.has(value.toLowerCase()));
}

function activeTicketFor(
  tickets: AiWebsiteTicket[],
  category: AiWebsiteWorkOrderCategory,
) {
  return tickets.find(
    (ticket) => ticket.category === category && !ticketIsCompleted(ticket),
  );
}

function deriveWorkflow({
  websiteWorkflow,
  workflowState,
  siteProfile,
  tickets,
}: {
  websiteWorkflow?: AiWebsiteWorkflowMetadata | null;
  workflowState?: AiWebsiteWorkflowState | null;
  siteProfile?: AiWebsiteSiteProfile | null;
  tickets: AiWebsiteTicket[];
}) {
  const completedCategories = new Set(
    tickets.filter(ticketIsCompleted).map((ticket) => ticket.category),
  );
  const domainPending = Boolean(activeTicketFor(tickets, "domain_application"));
  const icpPending = Boolean(activeTicketFor(tickets, "icp_filing"));
  const domainCompleted = websiteWorkflow
    ? websiteWorkflow.domainCompleted === true ||
      websiteWorkflow.canSubmitIcp === true ||
      websiteWorkflow.canSubmitContent === true ||
      profileStatusCompleted(websiteWorkflow.domainStatus)
    : workflowState?.domainApplication === "completed" ||
      siteProfile?.domainVerified === true ||
      profileStatusCompleted(siteProfile?.domainStatus) ||
      profileStatusCompleted(siteProfile?.domainApplicationStatus) ||
      completedCategories.has("domain_application");
  const icpCompleted =
    domainCompleted &&
    (websiteWorkflow
      ? websiteWorkflow.icpCompleted === true ||
        websiteWorkflow.canSubmitContent === true ||
        profileStatusCompleted(websiteWorkflow.icpStatus)
      : workflowState?.icpFiling === "completed" ||
        siteProfile?.icpVerified === true ||
        Boolean(siteProfile?.icpNumber?.trim()) ||
        profileStatusCompleted(siteProfile?.icpStatus) ||
        completedCategories.has("icp_filing"));

  return {
    domainCompleted,
    domainPending:
      !domainCompleted &&
      (websiteWorkflow?.domainStatus === "pending" ||
        workflowState?.domainApplication === "pending" ||
        domainPending),
    icpCompleted,
    icpPending:
      !icpCompleted &&
      (websiteWorkflow?.icpStatus === "pending" ||
        websiteWorkflow?.icpStatus === "preparing" ||
        workflowState?.icpFiling === "pending" ||
        icpPending ||
        domainPending),
  };
}

function phaseDefinition(phase: WorkflowPhase) {
  if (phase === "icp") return ICP_FILING;
  return null;
}

export default function AiWebsiteManagementWorkspace({
  siteProfile = null,
  websiteWorkflow = null,
  contentCatalog = [],
  workflowState = null,
  quota = null,
  tickets = [],
  loading = false,
  loadingMore = false,
  hasMore = false,
  error = null,
  onSubmit,
  onRefresh,
  onLoadMore,
  onUpgrade,
}: AiWebsiteManagementWorkspaceProps) {
  const [selectedType, setSelectedType] =
    useState<AiWebsiteWorkOrderCategory | null>(null);
  const [topic, setTopic] = useState("");
  const [icpNumber, setIcpNumber] = useState("");
  const [details, setDetails] = useState("");
  const [referenceLinks, setReferenceLinks] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [submitMessage, setSubmitMessage] = useState("");

  const workflow = useMemo(
    () =>
      deriveWorkflow({
        websiteWorkflow,
        workflowState,
        siteProfile,
        tickets,
      }),
    [siteProfile, tickets, websiteWorkflow, workflowState],
  );
  const phase: WorkflowPhase = !workflow.icpCompleted ? "icp" : "content";
  const phaseTicketPending =
    phase === "icp" ? workflow.domainPending || workflow.icpPending : false;
  const phaseAllowedByWorkflow =
    !websiteWorkflow ||
    (phase === "icp"
      ? websiteWorkflow.canSubmitIcp !== false ||
        (!workflow.domainCompleted && websiteWorkflow.canSubmitDomain !== false)
      : websiteWorkflow.canSubmitContent !== false);
  const workflowLockReason =
    phase === "icp"
      ? websiteWorkflow?.icpLockReason || websiteWorkflow?.lockReason
      : phase === "content"
        ? websiteWorkflow?.contentLockReason || websiteWorkflow?.lockReason
        : websiteWorkflow?.lockReason;
  const fixedPhaseType = phaseDefinition(phase);
  const contentTypes = useMemo(
    () =>
      contentCatalog.map((item) => ({
        id: item.value,
        label: item.label,
      })),
    [contentCatalog],
  );
  const effectiveType = fixedPhaseType?.id ?? selectedType;
  const serviceAllowed = Boolean(quota?.allowed);
  const quotaExhausted =
    phase === "content" &&
    Boolean(quota && quota.limit > 0 && quota.remaining <= 0);
  const submitting = submitState === "submitting";
  const submitDisabled =
    submitting ||
    phaseTicketPending ||
    !phaseAllowedByWorkflow ||
    quotaExhausted ||
    !serviceAllowed ||
    !onSubmit;

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    setAttachments((current) => [...current, ...nextFiles]);
    event.target.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTopic = topic.trim();
    if (!effectiveType) {
      setSubmitState("error");
      setSubmitMessage("请选择一项官网内容需求类型。");
      return;
    }
    if (!normalizedTopic) {
      setSubmitState("error");
      setSubmitMessage(
        phase === "icp" ? "请填写已完成备案的域名。" : "请填写需要处理的话题。",
      );
      return;
    }
    if (phase === "icp" && !icpNumber.trim()) {
      setSubmitState("error");
      setSubmitMessage("请填写阿里云备案通过后获得的 ICP 主体备案号。");
      return;
    }
    if (submitDisabled || !onSubmit) return;

    const parsedLinks = parseReferenceLinks(referenceLinks);
    if (parsedLinks.invalid.length > 0) {
      setSubmitState("error");
      setSubmitMessage(
        `以下参考链接格式不正确：${parsedLinks.invalid.slice(0, 3).join("、")}`,
      );
      return;
    }

    setSubmitState("submitting");
    setSubmitMessage("");
    try {
      await onSubmit({
        category: effectiveType,
        topic: normalizedTopic,
        description: phase === "content" ? details.trim() : "",
        targetPage: "",
        materialUrls: phase === "content" ? parsedLinks.urls : [],
        attachmentFiles: phase === "content" ? attachments : [],
        ...(phase === "icp"
          ? {
              icpDeclarations: {
                icpNumber: icpNumber.trim(),
              },
            }
          : {}),
      });
      setTopic("");
      setIcpNumber("");
      setDetails("");
      setReferenceLinks("");
      setAttachments([]);
      setSelectedType(null);
      setSubmitState("success");
      setSubmitMessage(
        phase === "icp" ? "备案结果已提交，等待平台确认。" : "工单已提交。",
      );
    } catch (submissionError) {
      setSubmitState("error");
      setSubmitMessage(
        submissionError instanceof Error && submissionError.message
          ? submissionError.message
          : "提交失败，请稍后重试。",
      );
    }
  }

  return (
    <section
      className="ai-website-workspace"
      aria-labelledby="ai-website-title"
    >
      <header className="ai-website-header">
        <p className="ai-website-eyebrow">AI 友好内容资产</p>
        <h1 id="ai-website-title">AI 友好官网管理</h1>
        <p className="ai-website-intro">
          域名注册、备案材料提交和人脸核验均在阿里云完成。FrontMind
          只提供操作指引，并在备案通过后记录域名与 ICP 主体备案号。
        </p>
      </header>

      <section
        className="ai-website-prerequisites"
        aria-labelledby="ai-website-prerequisites-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="ai-website-prerequisites-title">官网开通进度</h2>
            <p>先在阿里云完成注册与备案，再提交最终备案结果。</p>
          </div>
        </div>
        <ol className="ai-website-stepper">
          <WorkflowStep
            index={1}
            label="阿里云域名注册与 ICP 备案"
            state={
              workflow.icpCompleted
                ? "completed"
                : workflow.domainPending || workflow.icpPending
                  ? "pending"
                  : "current"
            }
          />
          <WorkflowStep
            index={2}
            label="官网内容运营"
            state={
              !workflow.icpCompleted
                ? "locked"
                : phase === "content"
                  ? "current"
                  : "completed"
            }
          />
        </ol>
      </section>

      {!serviceAllowed ? (
        <section className="ai-website-locked" aria-label="官网运营功能未开放">
          <LockKeyhole size={24} aria-hidden="true" />
          <div>
            <h2>当前不能提交新的官网工单</h2>
            <p>{quota?.reason || "当前服务暂未开放官网运营工单。"}</p>
          </div>
          {onUpgrade && (
            <button
              type="button"
              className="ai-website-primary-button"
              onClick={onUpgrade}
            >
              查看服务方式
            </button>
          )}
        </section>
      ) : (
        <form className="ai-website-form" onSubmit={handleSubmit} noValidate>
          <div className="ai-website-section-heading">
            <div>
              <h2>
                {phase === "icp"
                  ? "前往阿里云完成域名注册与 ICP 备案"
                  : "提交官网内容运营工单"}
              </h2>
              {phase === "icp" && (
                <p>
                  本站不接收营业执照、身份证、授权书、负责人照片或人脸核验信息。
                </p>
              )}
            </div>
            {phase === "content" && quota && (
              <span className="ai-website-quota-copy">
                剩余 {quota.remaining} / {quota.limit}
              </span>
            )}
          </div>

          {phaseTicketPending || !phaseAllowedByWorkflow ? (
            <div className="ai-website-inline-state" role="status">
              {phaseTicketPending
                ? "域名与 ICP 备案结果已提交，平台确认后会自动开放内容运营。"
                : workflowLockReason || "当前阶段暂未开放。"}
            </div>
          ) : (
            <>
              {phase === "content" && (
                <label className="ai-website-form-field">
                  <span>需求类型</span>
                  <select
                    aria-label="需求类型"
                    aria-required="true"
                    value={selectedType ?? ""}
                    onChange={(event) =>
                      setSelectedType(
                        (event.target.value as AiWebsiteWorkOrderCategory) ||
                          null,
                      )
                    }
                  >
                    <option value="">请选择需求类型</option>
                    {contentTypes.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {phase === "icp" && (
                <>
                  <section
                    className="ai-website-aliyun-guide"
                    aria-labelledby="ai-website-aliyun-guide-title"
                  >
                    <div className="ai-website-guide-notice">
                      <LockKeyhole size={18} aria-hidden="true" />
                      <p>
                        <strong id="ai-website-aliyun-guide-title">
                          所有证件与人脸核验都留在阿里云
                        </strong>
                        FrontMind
                        不提供材料上传入口，也不会保存备案证件或人脸信息。
                      </p>
                    </div>
                    <ol className="ai-website-guide-steps">
                      <li>
                        <span>1</span>
                        <div>
                          <strong>注册并实名认证阿里云中国站账号</strong>
                          <p>
                            使用企业主体信息完成账号实名认证；后续域名持有人与备案主办单位信息应保持一致。
                          </p>
                          <a
                            href={ALIYUN_DOMAIN_GUIDE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            查看域名注册教程
                            <ExternalLink size={14} aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                      <li>
                        <span>2</span>
                        <div>
                          <strong>查询、购买并完成域名实名认证</strong>
                          <p>
                            在阿里云万网查询可用域名，选择已通过实名认证的持有者信息模板，支付后等待域名状态变为正常。
                          </p>
                          <a
                            href={ALIYUN_DOMAIN_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            去阿里云注册域名
                            <ExternalLink size={14} aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                      <li>
                        <span>3</span>
                        <div>
                          <strong>在阿里云发起 ICP 备案</strong>
                          <p>
                            确认网站使用阿里云中国内地节点，进入备案系统并按提示填写主办者、网站与接入信息。
                          </p>
                          <a
                            href={ALIYUN_ICP_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            去阿里云开始备案
                            <ExternalLink size={14} aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                      <li>
                        <span>4</span>
                        <div>
                          <strong>仅在阿里云上传材料并完成人脸核验</strong>
                          <p>
                            按当地管局与备案订单提示，在阿里云 App
                            上传所需原件照片，并由负责人在阿里云完成真实性 /
                            人脸核验。
                          </p>
                          <a
                            href={ALIYUN_IDENTITY_GUIDE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            查看材料与人脸核验说明
                            <ExternalLink size={14} aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                      <li>
                        <span>5</span>
                        <div>
                          <strong>完成审核并取得备案号</strong>
                          <p>
                            依次完成阿里云初审、工信部短信核验和管局审核；备案通过后，在阿里云备案系统查看
                            ICP 主体备案号。
                          </p>
                          <a
                            href={ALIYUN_ICP_GUIDE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            查看 ICP 备案全流程
                            <ExternalLink size={14} aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                    </ol>
                  </section>
                  <div className="ai-website-result-heading">
                    <strong>备案通过后，仅回填以下两项</strong>
                    <p>
                      请确认阿里云备案状态已显示通过，再提交域名与 ICP
                      主体备案号供平台确认。
                    </p>
                  </div>
                </>
              )}

              <label className="ai-website-form-field">
                <span>{phase === "icp" ? "已备案域名" : "话题"}</span>
                <input
                  type="text"
                  aria-label={phase === "icp" ? "已备案域名" : "话题"}
                  aria-required="true"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder={
                    phase === "icp"
                      ? "例如 example.com"
                      : "填写本次需要更新的官网话题"
                  }
                />
              </label>

              {phase === "icp" ? (
                <label className="ai-website-form-field">
                  <span>ICP 主体备案号</span>
                  <input
                    type="text"
                    aria-label="ICP 主体备案号"
                    aria-required="true"
                    value={icpNumber}
                    onChange={(event) => setIcpNumber(event.target.value)}
                    placeholder="例如 京ICP备12345678号"
                  />
                  <small className="ai-website-field-help">
                    请填写备案主体编号，不要填写密码、证件号码、负责人照片或其他备案材料。
                  </small>
                </label>
              ) : (
                <>
                  <label className="ai-website-form-field">
                    <span>内容说明（选填）</span>
                    <textarea
                      rows={5}
                      value={details}
                      onChange={(event) => setDetails(event.target.value)}
                      placeholder="补充本次需求的背景、范围和需要管理员关注的事项"
                    />
                  </label>

                  <label className="ai-website-form-field">
                    <span>参考资料（选填）</span>
                    <textarea
                      rows={3}
                      value={referenceLinks}
                      onChange={(event) =>
                        setReferenceLinks(event.target.value)
                      }
                      placeholder="每行一个公开参考链接"
                    />
                  </label>

                  <div className="ai-website-upload">
                    <div>
                      <strong>附件（选填）</strong>
                      <span>可上传与本次官网内容需求有关的资料。</span>
                    </div>
                    <label className="ai-website-upload-button">
                      <Upload size={17} aria-hidden="true" />
                      选择文件
                      <input
                        type="file"
                        multiple
                        onChange={handleFiles}
                        aria-label="上传官网工单附件"
                      />
                    </label>
                  </div>

                  {attachments.length > 0 && (
                    <ul
                      className="ai-website-file-list"
                      aria-label="待上传文件"
                    >
                      {attachments.map((file, index) => (
                        <li key={`${file.name}-${file.size}-${index}`}>
                          <Paperclip size={15} aria-hidden="true" />
                          <span>{file.name}</span>
                          <button
                            type="button"
                            aria-label={`移除 ${file.name}`}
                            onClick={() =>
                              setAttachments((current) =>
                                current.filter(
                                  (_, fileIndex) => fileIndex !== index,
                                ),
                              )
                            }
                          >
                            <X size={15} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {quotaExhausted && (
                <div className="ai-website-inline-state warning" role="alert">
                  当前官网内容发布额度已用完，暂时不能提交新的内容运营工单。
                </div>
              )}
              {!onSubmit && (
                <div className="ai-website-inline-state" role="status">
                  工单提交服务暂时不可用。
                </div>
              )}

              <div className="ai-website-form-actions">
                <p
                  className={`ai-website-submit-message ${submitState}`}
                  aria-live="polite"
                >
                  {submitMessage}
                </p>
                <button
                  type="submit"
                  className="ai-website-primary-button"
                  disabled={submitDisabled}
                >
                  <Send size={17} aria-hidden="true" />
                  {submitting
                    ? "正在提交…"
                    : phase === "icp"
                      ? "提交备案结果"
                      : "提交工单"}
                </button>
              </div>
            </>
          )}
        </form>
      )}

      <section
        className="ai-website-orders"
        aria-labelledby="ai-website-orders-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="ai-website-orders-title">官网历史与交付记录</h2>
            <p>备案结果确认与官网内容工单统一显示在这里。</p>
          </div>
          {onRefresh && (
            <button
              type="button"
              className="ai-website-secondary-button"
              onClick={() => void onRefresh()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              刷新
            </button>
          )}
        </div>

        {loading ? (
          <div className="ai-website-orders-state" role="status">
            正在载入官网历史记录…
          </div>
        ) : error ? (
          <div className="ai-website-orders-state error" role="alert">
            <AlertCircle size={19} aria-hidden="true" />
            {error}
          </div>
        ) : tickets.length === 0 ? (
          <div className="ai-website-orders-state">
            <FileText size={22} aria-hidden="true" />
            <strong>暂无官网历史记录</strong>
            <span>提交工单后，记录会显示在这里。</span>
          </div>
        ) : (
          <div className="ai-website-order-list">
            {tickets.map((ticket) => {
              const completed = ticketIsCompleted(ticket);
              const expanded = completed && expandedTicketId === ticket.id;
              const summary = ticketSummary(ticket);
              return (
                <article className="ai-website-order-row" key={ticket.id}>
                  <button
                    type="button"
                    className="ai-website-order-toggle"
                    disabled={!completed}
                    aria-expanded={completed ? expanded : undefined}
                    onClick={() =>
                      completed &&
                      setExpandedTicketId((current) =>
                        current === ticket.id ? null : ticket.id,
                      )
                    }
                  >
                    <span className="ai-website-order-main">
                      <small>{categoryLabel(ticket, contentTypes)}</small>
                      <strong>
                        {ticket.topic || ticket.title || "官网内容需求"}
                      </strong>
                    </span>
                    <span
                      className="ai-website-order-status"
                      data-status={completed ? "completed" : "pending"}
                    >
                      {completed ? (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      ) : null}
                      {completed ? "已完成" : "待受理"}
                    </span>
                    {completed && (
                      <ChevronDown
                        className={expanded ? "expanded" : undefined}
                        size={17}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {expanded && (
                    <div className="ai-website-order-summary">
                      <strong>内容总结</strong>
                      <p>{summary || "暂无公开内容总结。"}</p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {hasMore && onLoadMore && (
          <div className="ai-website-load-more">
            <button
              type="button"
              className="ai-website-secondary-button"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >
              <RefreshCw
                className={loadingMore ? "animate-spin" : undefined}
                size={16}
                aria-hidden="true"
              />
              {loadingMore ? "正在载入…" : "加载更多"}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

function WorkflowStep({
  index,
  label,
  state,
}: {
  index: number;
  label: string;
  state: "completed" | "pending" | "current" | "locked";
}) {
  const stateLabel = {
    completed: "已完成",
    pending: "待受理",
    current: "可提交",
    locked: "未开放",
  }[state];
  return (
    <li data-state={state}>
      <span className="ai-website-step-index">
        {state === "completed" ? (
          <Check size={16} aria-hidden="true" />
        ) : state === "locked" ? (
          <LockKeyhole size={14} aria-hidden="true" />
        ) : (
          index
        )}
      </span>
      <strong>{label}</strong>
      <small>{stateLabel}</small>
    </li>
  );
}
