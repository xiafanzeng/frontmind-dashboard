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
  FileText,
  LockKeyhole,
  Paperclip,
  RefreshCw,
  Send,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
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
  icpMaterialFiles: Array<{
    category: string;
    file: File;
  }>;
  icpProvince?: string;
  icpDeclarations?: {
    domainHolderInformation: string;
    websiteInformation: string;
    aliyunAppVerificationCompleted: true;
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
  icpProvince?: string | null;
  icpProvinceOptions?: readonly string[];
  icpMaterialChecklist?: ReadonlyArray<
    | string
    | {
        id?: string;
        key?: string;
        label: string;
        required?: boolean;
        sensitive?: boolean;
        note?: string;
      }
  >;
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
  onIcpProvinceChange?: (province: string) => Promise<void> | void;
  /** Deprecated for this page. Website history details are summary-only in place. */
  onOpenTicket?: (ticketId: string) => void;
  onRefresh?: () => Promise<void> | void;
  onLoadMore?: () => Promise<void> | void;
  onUpgrade?: () => void;
  enableIcpMaterialManagement?: boolean;
};

type IcpMaterialSummary = {
  id: string;
  category: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  retentionUntil: number;
  createdAt: number;
  downloadUrl: string;
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
  label: "ICP 备案与主体材料",
};

const ICP_BASE_MATERIAL_FIELDS = [
  {
    category: "business_license",
    fallbackLabel: "营业执照",
  },
  {
    category: "subject_responsible_person_id",
    fallbackLabel: "主体负责人身份证件",
  },
  {
    category: "website_responsible_person_id",
    fallbackLabel: "网站负责人身份证件",
  },
] as const;

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

type WorkflowPhase = "domain" | "icp" | "content";

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
  return Boolean(
    ticket.status && CLOSED_TICKET_STATUSES.has(ticket.status),
  );
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
    (ticket) =>
      ticket.category === category &&
      !ticketIsCompleted(ticket),
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
    tickets
      .filter(ticketIsCompleted)
      .map((ticket) => ticket.category),
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
      domainCompleted &&
      !icpCompleted &&
      (websiteWorkflow?.icpStatus === "pending" ||
        workflowState?.icpFiling === "pending" ||
        icpPending),
  };
}

function phaseDefinition(phase: WorkflowPhase) {
  if (phase === "domain") return DOMAIN_APPLICATION;
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
  onIcpProvinceChange,
  onRefresh,
  onLoadMore,
  onUpgrade,
  enableIcpMaterialManagement = false,
}: AiWebsiteManagementWorkspaceProps) {
  const [selectedType, setSelectedType] =
    useState<AiWebsiteWorkOrderCategory | null>(null);
  const [topic, setTopic] = useState("");
  const [details, setDetails] = useState("");
  const [referenceLinks, setReferenceLinks] = useState("");
  const [icpProvince, setIcpProvince] = useState(
    websiteWorkflow?.icpProvince ?? "",
  );
  const [attachments, setAttachments] = useState<File[]>([]);
  const [icpMaterialFiles, setIcpMaterialFiles] = useState<
    Record<string, File>
  >({});
  const [domainHolderInformation, setDomainHolderInformation] = useState("");
  const [websiteInformation, setWebsiteInformation] = useState("");
  const [aliyunAppVerificationCompleted, setAliyunAppVerificationCompleted] =
    useState(false);
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [submitMessage, setSubmitMessage] = useState("");
  const [storedIcpMaterials, setStoredIcpMaterials] = useState<
    IcpMaterialSummary[]
  >([]);
  const [icpMaterialState, setIcpMaterialState] = useState<
    "idle" | "loading" | "updating" | "error"
  >("idle");
  const [icpMaterialMessage, setIcpMaterialMessage] = useState("");

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
  const phase: WorkflowPhase = !workflow.domainCompleted
    ? "domain"
    : !workflow.icpCompleted
      ? "icp"
      : "content";
  const phaseTicketPending =
    phase === "domain"
      ? workflow.domainPending
      : phase === "icp"
        ? workflow.icpPending
        : false;
  const phaseAllowedByWorkflow =
    !websiteWorkflow ||
    (phase === "domain"
      ? websiteWorkflow.canSubmitDomain !== false
      : phase === "icp"
        ? websiteWorkflow.canSubmitIcp !== false
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
  const icpSensitiveMaterialFields = useMemo(() => {
    const baseFields = ICP_BASE_MATERIAL_FIELDS.map((field) => {
      const checklistItem = websiteWorkflow?.icpMaterialChecklist?.find(
        (item) =>
          typeof item !== "string" &&
          (item.key === field.category || item.id === field.category),
      );
      return {
        category: field.category,
        label:
          checklistItem && typeof checklistItem !== "string"
            ? checklistItem.label
            : field.fallbackLabel,
        required: true,
      };
    });
    const baseCategories = new Set(baseFields.map((field) => field.category));
    const additionalFields = (
      websiteWorkflow?.icpMaterialChecklist ?? []
    ).flatMap((item) => {
      if (
        typeof item === "string" ||
        !item.sensitive ||
        !item.key ||
        baseCategories.has(
          item.key as (typeof ICP_BASE_MATERIAL_FIELDS)[number]["category"],
        )
      ) {
        return [];
      }
      return [
        {
          category: item.key,
          label: item.label,
          required: item.required !== false,
        },
      ];
    });
    return [...baseFields, ...additionalFields];
  }, [websiteWorkflow?.icpMaterialChecklist]);
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

  async function loadStoredIcpMaterials() {
    if (!enableIcpMaterialManagement) return;
    setIcpMaterialState("loading");
    setIcpMaterialMessage("");
    try {
      const response = await fetch("/api/icp-materials", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          result?.error?.message || "备案材料暂时无法载入。",
        );
      }
      setStoredIcpMaterials(
        Array.isArray(result?.materials) ? result.materials : [],
      );
      setIcpMaterialState("idle");
    } catch (error) {
      setIcpMaterialState("error");
      setIcpMaterialMessage(
        error instanceof Error ? error.message : "备案材料暂时无法载入。",
      );
    }
  }

  useEffect(() => {
    if (!enableIcpMaterialManagement) return;
    void loadStoredIcpMaterials();
  }, [enableIcpMaterialManagement]);

  async function replaceStoredIcpMaterial(
    material: IcpMaterialSummary,
    file: File,
  ) {
    setIcpMaterialState("updating");
    setIcpMaterialMessage("");
    try {
      const response = await fetch("/api/icp-materials/upload", {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-file-content-type": encodeURIComponent(
            file.type || "application/octet-stream",
          ),
          "x-icp-material-category": material.category,
          "x-replaces-material-id": material.id,
        },
        body: file,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          result?.error?.message || "备案材料替换失败。",
        );
      }
      await loadStoredIcpMaterials();
      setIcpMaterialMessage("备案材料已替换，原工单关联已同步更新。");
    } catch (error) {
      setIcpMaterialState("error");
      setIcpMaterialMessage(
        error instanceof Error ? error.message : "备案材料替换失败。",
      );
    }
  }

  async function withdrawStoredIcpMaterial(material: IcpMaterialSummary) {
    setIcpMaterialState("updating");
    setIcpMaterialMessage("");
    try {
      const response = await fetch(
        `/api/icp-materials/${encodeURIComponent(material.id)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
        },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          result?.error?.message || "备案材料撤回失败。",
        );
      }
      await loadStoredIcpMaterials();
      setIcpMaterialMessage("备案材料已撤回并从受保护存储删除。");
    } catch (error) {
      setIcpMaterialState("error");
      setIcpMaterialMessage(
        error instanceof Error ? error.message : "备案材料撤回失败。",
      );
    }
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    setAttachments((current) => [...current, ...nextFiles]);
    event.target.value = "";
  }

  function handleIcpMaterialFile(
    category: string,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    if (!file) return;
    setIcpMaterialFiles((current) => ({ ...current, [category]: file }));
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
      setSubmitMessage("请填写需要处理的话题。");
      return;
    }
    if (phase === "icp" && !icpProvince) {
      setSubmitState("error");
      setSubmitMessage("请先选择备案省份。");
      return;
    }
    if (phase === "icp") {
      const missingMaterials = icpSensitiveMaterialFields.filter(
        (field) => field.required && !icpMaterialFiles[field.category],
      );
      if (missingMaterials.length > 0) {
        setSubmitState("error");
        setSubmitMessage(
          `请上传${missingMaterials.map((field) => field.label).join("、")}。`,
        );
        return;
      }
      if (
        !domainHolderInformation.trim() ||
        !websiteInformation.trim() ||
        !aliyunAppVerificationCompleted
      ) {
        setSubmitState("error");
        setSubmitMessage(
          "请填写域名实名及持有人信息、网站信息，并确认已完成阿里云 App 真实性 / 人脸核验。",
        );
        return;
      }
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
        description: details.trim(),
        targetPage: "",
        materialUrls: parsedLinks.urls,
        attachmentFiles: attachments,
        icpMaterialFiles:
          phase === "icp"
            ? icpSensitiveMaterialFields.flatMap((field) => {
                const file = icpMaterialFiles[field.category];
                return file ? [{ category: field.category, file }] : [];
              })
            : [],
        ...(phase === "icp" ? { icpProvince } : {}),
        ...(phase === "icp"
          ? {
              icpDeclarations: {
                domainHolderInformation: domainHolderInformation.trim(),
                websiteInformation: websiteInformation.trim(),
                aliyunAppVerificationCompleted: true as const,
              },
            }
          : {}),
      });
      setTopic("");
      setDetails("");
      setReferenceLinks("");
      setIcpProvince("");
      setAttachments([]);
      setIcpMaterialFiles({});
      setDomainHolderInformation("");
      setWebsiteInformation("");
      setAliyunAppVerificationCompleted(false);
      setSelectedType(null);
      setSubmitState("success");
      setSubmitMessage("工单已提交。");
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
          完成域名申请与 ICP 备案后，即可持续提交企业官网内容运营需求。
        </p>
      </header>

      <section
        className="ai-website-prerequisites"
        aria-labelledby="ai-website-prerequisites-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="ai-website-prerequisites-title">官网开通进度</h2>
            <p>前一阶段经管理员确认完成后，下一阶段才会开放。</p>
          </div>
        </div>
        <ol className="ai-website-stepper">
          <WorkflowStep
            index={1}
            label="域名申请"
            state={
              workflow.domainCompleted
                ? "completed"
                : workflow.domainPending
                  ? "pending"
                  : "current"
            }
          />
          <WorkflowStep
            index={2}
            label="ICP 备案与主体材料"
            state={
              workflow.icpCompleted
                ? "completed"
                : !workflow.domainCompleted
                  ? "locked"
                  : workflow.icpPending
                    ? "pending"
                    : "current"
            }
          />
          <WorkflowStep
            index={3}
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
                {phase === "domain"
                  ? "提交域名申请工单"
                  : phase === "icp"
                    ? "提交 ICP 备案与主体材料"
                    : "提交官网内容运营工单"}
              </h2>
              {phase === "icp" && (
                <p>
                  身份证、营业执照和授权书属于敏感材料，仅通过受保护的备案材料通道提交。
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
                ? "当前阶段已有待受理工单。管理员确认完成后，下一阶段会自动开放。"
                : workflowLockReason || "当前阶段暂未开放。"}
            </div>
          ) : (
            <>
              <label className="ai-website-form-field">
                <span>需求类型</span>
                {fixedPhaseType ? (
                  <input
                    aria-label="需求类型"
                    type="text"
                    value={fixedPhaseType.label}
                    readOnly
                  />
                ) : (
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
                )}
              </label>

              {phase === "icp" && (
                <>
                  <label className="ai-website-form-field">
                    <span>备案省份</span>
                    <select
                      aria-label="备案省份"
                      aria-required="true"
                      value={icpProvince}
                      onChange={(event) => {
                        const nextProvince = event.target.value;
                        setIcpProvince(nextProvince);
                        void onIcpProvinceChange?.(nextProvince);
                      }}
                    >
                      <option value="">请选择备案省份</option>
                      {(websiteWorkflow?.icpProvinceOptions ?? []).map(
                        (province) => (
                          <option value={province} key={province}>
                            {province}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <div className="ai-website-material-checklist">
                    <strong>备案材料清单</strong>
                    {websiteWorkflow?.icpMaterialChecklist?.length ? (
                      <ul>
                        {websiteWorkflow.icpMaterialChecklist.map(
                          (material, index) => {
                            const item =
                              typeof material === "string"
                                ? {
                                    label: material,
                                    required: true,
                                    sensitive: false,
                                  }
                                : material;
                            return (
                              <li
                                key={
                                  item.id ||
                                  item.key ||
                                  `${item.label}-${index}`
                                }
                              >
                                <span>
                                  {item.label}
                                  {item.note ? <em>{item.note}</em> : null}
                                </span>
                                <small>
                                  {item.required === false ? "按需" : "必需"}
                                  {item.sensitive ? " · 敏感材料" : ""}
                                </small>
                              </li>
                            );
                          },
                        )}
                      </ul>
                    ) : (
                      <p>
                        {icpProvince
                          ? "该省份的材料清单正在从服务端载入。"
                          : "选择备案省份后，将按所在地规则显示材料清单。"}
                      </p>
                    )}
                  </div>
                  <fieldset className="ai-website-sensitive-materials">
                    <legend>受保护备案材料</legend>
                    <p>
                      以下材料为备案必需项，将通过受保护存储单独上传，不进入普通附件或大模型服务。
                    </p>
                    <div>
                      {icpSensitiveMaterialFields.map((field) => {
                        const selectedFile =
                          icpMaterialFiles[field.category] ?? null;
                        return (
                          <label key={field.category}>
                            <span>
                              {field.label}
                              {!field.required ? "（按需）" : ""}
                            </span>
                            <input
                              type="file"
                              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                              aria-label={`上传${field.label}`}
                              onChange={(event) =>
                                handleIcpMaterialFile(field.category, event)
                              }
                            />
                            <small>
                              {selectedFile
                                ? selectedFile.name
                                : "请选择 PDF、PNG 或 JPG 文件"}
                            </small>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <fieldset className="ai-website-sensitive-materials">
                    <legend>备案主体与核验状态</legend>
                    <p>
                      以下信息用于备案材料完整性校验，不会在官网历史列表中展示。
                    </p>
                    <div>
                      <label>
                        <span>域名实名及持有人信息</span>
                        <textarea
                          rows={3}
                          aria-label="域名实名及持有人信息"
                          value={domainHolderInformation}
                          onChange={(event) =>
                            setDomainHolderInformation(event.target.value)
                          }
                          placeholder="说明域名实名主体、持有人及其与主办单位的关系"
                        />
                      </label>
                      <label>
                        <span>网站名称、服务内容和联系方式</span>
                        <textarea
                          rows={4}
                          aria-label="网站名称、服务内容和联系方式"
                          value={websiteInformation}
                          onChange={(event) =>
                            setWebsiteInformation(event.target.value)
                          }
                          placeholder="填写网站名称、主要服务内容及备案联系人信息"
                        />
                      </label>
                      <label>
                        <span>
                          <input
                            type="checkbox"
                            aria-label="已完成阿里云 App 真实性或人脸核验"
                            checked={aliyunAppVerificationCompleted}
                            onChange={(event) =>
                              setAliyunAppVerificationCompleted(
                                event.target.checked,
                              )
                            }
                          />
                          已完成阿里云 App 真实性 / 人脸核验
                        </span>
                      </label>
                    </div>
                  </fieldset>
                </>
              )}

              <label className="ai-website-form-field">
                <span>话题</span>
                <input
                  type="text"
                  aria-label="话题"
                  aria-required="true"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder={
                    phase === "domain"
                      ? "填写希望申请的域名或命名方向"
                      : phase === "icp"
                        ? "填写备案主体与网站用途"
                        : "填写本次需要更新的官网话题"
                  }
                />
              </label>

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
                  onChange={(event) => setReferenceLinks(event.target.value)}
                  placeholder="每行一个公开参考链接"
                />
              </label>

              <div className="ai-website-upload">
                <div>
                  <strong>
                    {phase === "icp"
                      ? "其他非敏感附件（选填）"
                      : "附件（选填）"}
                  </strong>
                  <span>
                    {phase === "icp"
                      ? "请勿在这里上传身份证、营业执照、授权书等敏感备案材料。"
                      : "可上传与本次需求有关的资料。"}
                  </span>
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
                <ul className="ai-website-file-list" aria-label="待上传文件">
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
                  {submitting ? "正在提交…" : "提交工单"}
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {enableIcpMaterialManagement && workflow.domainCompleted && (
        <section
          className="ai-website-icp-material-manager"
          aria-labelledby="ai-website-icp-material-manager-title"
        >
          <div className="ai-website-section-heading">
            <div>
              <h2 id="ai-website-icp-material-manager-title">
                已提交备案材料
              </h2>
              <p>
                材料保存在受保护存储中；待受理备案工单使用中的材料请直接替换。
              </p>
            </div>
            <button
              type="button"
              className="ai-website-secondary-button"
              onClick={() => void loadStoredIcpMaterials()}
              disabled={
                icpMaterialState === "loading" ||
                icpMaterialState === "updating"
              }
            >
              <RefreshCw size={16} aria-hidden="true" />
              刷新
            </button>
          </div>
          {icpMaterialState === "loading" ? (
            <div className="ai-website-inline-state" role="status">
              正在载入备案材料…
            </div>
          ) : storedIcpMaterials.length === 0 ? (
            <div className="ai-website-inline-state">
              暂无已上传的备案敏感材料。
            </div>
          ) : (
            <div className="ai-website-icp-material-list">
              {storedIcpMaterials.map((material) => {
                const definition = icpSensitiveMaterialFields.find(
                  (field) => field.category === material.category,
                );
                return (
                  <article key={material.id}>
                    <div>
                      <strong>
                        {definition?.label || "备案补充材料"}
                      </strong>
                      <span>
                        {(material.sizeBytes / 1024 / 1024).toFixed(2)} MB
                      </span>
                    </div>
                    <div>
                      <a
                        className="ai-website-secondary-button"
                        href={material.downloadUrl}
                      >
                        下载
                      </a>
                      <label className="ai-website-secondary-button">
                        替换
                        <input
                          type="file"
                          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                          aria-label={`替换${definition?.label || "备案材料"}`}
                          disabled={icpMaterialState === "updating"}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              void replaceStoredIcpMaterial(material, file);
                            }
                            event.target.value = "";
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="ai-website-secondary-button"
                        disabled={icpMaterialState === "updating"}
                        onClick={() => void withdrawStoredIcpMaterial(material)}
                      >
                        撤回
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {icpMaterialMessage && (
            <p
              className={`ai-website-submit-message ${
                icpMaterialState === "error" ? "error" : "success"
              }`}
              role={icpMaterialState === "error" ? "alert" : "status"}
            >
              {icpMaterialMessage}
            </p>
          )}
        </section>
      )}

      <section
        className="ai-website-orders"
        aria-labelledby="ai-website-orders-title"
      >
        <div className="ai-website-section-heading">
          <div>
            <h2 id="ai-website-orders-title">官网历史与交付记录</h2>
            <p>域名、备案与官网内容工单统一显示在这里。</p>
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
