import { useEffect, useMemo, useRef, useState } from "react";
import {
  CreditCard,
  ClipboardList,
  Database,
  Eye,
  ExternalLink,
  FileArchive,
  FileCheck2,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  PackageCheck,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  UploadCloud,
  UserCog,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { useAuth } from "@/_core/hooks/useAuth";
import DashboardSkeletonEditor from "@/components/DashboardSkeletonEditor";
import DashboardVersionHistory from "@/components/DashboardVersionHistory";
import AdminDeliveryTicketWorkspace from "@/components/AdminDeliveryTicketWorkspace";
import KnowledgeBaseViewer from "@/components/KnowledgeBaseViewer";
import KnowledgeBaseProgressPanel from "@/components/KnowledgeBaseProgressPanel";
import ManagerAssignmentEditor from "@/components/ManagerAssignmentEditor";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import PortalShell, { PortalCard } from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadFile } from "@/lib/frontmind-api";
import {
  ADMIN_WORKSPACE_TAB_IDS,
  type WorkspaceTab,
} from "@/lib/admin-workspace-tabs";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";
import { CreateUserDialog } from "@/pages/AdminUsers";

export { ADMIN_WORKSPACE_TAB_IDS };
export type { WorkspaceTab };

export function canCreateManagedCustomer(isSystemAdmin?: boolean) {
  return isSystemAdmin === true;
}

export const ADMIN_WORKSPACE_TABS = [
  { value: "service", label: "套餐与问题", icon: PackageCheck },
  { value: "knowledge", label: "知识库流程", icon: Database },
  { value: "tickets", label: "工单与官网", icon: ClipboardList },
  { value: "delivery", label: "内容、监控与报告", icon: Database },
  { value: "credential", label: "共享 Key 与积分", icon: KeyRound },
  { value: "activity", label: "操作记录", icon: History },
] as const satisfies ReadonlyArray<{
  value: WorkspaceTab;
  label: string;
  icon: typeof PackageCheck;
}>;

export type ManualOrderStatus =
  | "pending_admin"
  | "signature_required"
  | "payment_required"
  | "account_setup_required"
  | "activation_required"
  | "active";

export type ManualOrderPrimaryAction =
  | "prepare"
  | "confirm_signed"
  | "wait_payment"
  | "wait_account"
  | "activate";

type ManualOrder = {
  reference: string;
  status: ManualOrderStatus;
  companyName: string;
  orderId?: string | null;
  question?: string | null;
  category?: string | null;
  contractId?: string | null;
  signingUrl?: string | null;
  createdAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  payment?: {
    orderId?: string | null;
    tradeNo?: string | null;
    paidAt?: number | string | Date | null;
  } | null;
  paymentOrderId?: string | null;
  paymentTradeNo?: string | null;
  paidAt?: number | string | Date | null;
};

type ManualOrderPreparationDraft = {
  contractId: string;
  signingUrl: string;
};

type ManualOrderSignatureDraft = {
  signedContract?: File;
  signingReport?: File;
  signedAtLocal: string;
  signatoryId: string;
  note: string;
};

type ManualOrderBusyState = {
  reference: string;
  action: "prepare" | "confirm_signed" | "activate" | "reject";
};

type UploadedManualOrderFile = {
  fileId: string;
  filename: string;
  sha256: string;
};

const MANUAL_ORDER_PDF_MAX_BYTES = 20 * 1024 * 1024;

const QUESTION_CATEGORY_LABELS: Record<string, string> = {
  industry: "行业词",
  competitor_comparison: "竞品对比词",
  reputation: "美誉舆情词",
  product_scenario: "产品场景词",
};

const MANUAL_ORDER_STATUS_COPY: Record<
  Exclude<ManualOrderStatus, "active">,
  { label: string; description: string; tone: string }
> = {
  pending_admin: {
    label: "待管理员发起签署",
    description: "填写合同编号和第三方签署链接，再通知客户签署。",
    tone: "bg-violet-50 text-violet-700",
  },
  signature_required: {
    label: "待核验签署",
    description: "上传已签合同与签署证据，核对实际签署信息。",
    tone: "bg-blue-50 text-blue-700",
  },
  payment_required: {
    label: "待客户付款",
    description: "签署已确认，系统正在等待客户完成付款。",
    tone: "bg-amber-50 text-amber-700",
  },
  account_setup_required: {
    label: "待企业设置账号",
    description: "付款已确认，等待企业提交登录账号和密码。",
    tone: "bg-sky-50 text-sky-700",
  },
  activation_required: {
    label: "待确认到账并开通",
    description: "账号资料已就绪；核对付款记录后再单独开通服务。",
    tone: "bg-emerald-50 text-emerald-700",
  },
};

export function manualOrderPrimaryAction(
  status: ManualOrderStatus,
): ManualOrderPrimaryAction | null {
  if (status === "pending_admin") return "prepare";
  if (status === "signature_required") return "confirm_signed";
  if (status === "payment_required") return "wait_payment";
  if (status === "account_setup_required") return "wait_account";
  if (status === "activation_required") return "activate";
  return null;
}

export function isSecureSigningUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function validateManualOrderPdf(file: File | undefined) {
  if (!file) return "请选择 PDF 文件。";
  const pdfFilename = /\.pdf$/i.test(file.name);
  const pdfMime = !file.type || file.type === "application/pdf";
  if (!pdfFilename || !pdfMime) return "仅支持 PDF 文件。";
  if (file.size <= 0) return "PDF 文件为空，请重新选择。";
  if (file.size > MANUAL_ORDER_PDF_MAX_BYTES) return "PDF 文件不能超过 20 MB。";
  return "";
}

export async function sha256ManualOrderFile(file: File) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前浏览器无法计算文件校验值，请使用最新版浏览器重试。");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toDateTimeLocal(value?: number | string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function displayDateTime(value: number | string | Date | null | undefined) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function manualOrderError(error: unknown) {
  return error instanceof Error ? error.message : "请刷新后重试";
}

function toDateInput(value: number | string | Date | null | undefined) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function displayDate(value: number | string | Date | null | undefined) {
  if (!value) return "待配置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待配置";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function displayDuration(value: number | null | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return "执行中或未记录";
  const seconds = Math.round((value ?? 0) / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} 分 ${remainder} 秒`;
}

async function readImportError(response: Response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || payload?.message || "导入失败";
  } catch {
    return `导入失败 (${response.status})`;
  }
}

async function uploadWorkspaceFile(input: {
  userId: number;
  file: File;
  mode: "knowledge";
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-File-Name": encodeURIComponent(input.file.name),
    "X-Import-Mode": input.mode,
  };
  const response = await fetch(`/api/dashboard/import/${input.userId}`, {
    method: "PUT",
    credentials: "include",
    headers,
    body: input.file,
  });
  if (!response.ok) throw new Error(await readImportError(response));
  return response.json();
}

function AdminQuestionRow({
  question,
  editable,
  saving,
  canConfirm,
  confirming,
  onSave,
  onConfirm,
}: {
  question: {
    id: string;
    question: string;
    rationale?: string | null;
    category?: string;
    quotaPeriodId?: string;
    evidence?: Array<{
      documentPath: string;
      excerpt: string;
      relevance: string;
    }>;
    status: "candidate" | "selected" | "archived";
    selectionApprovalStatus: "not_requested" | "pending" | "approved";
    locked: boolean;
    revision: number;
  };
  editable: boolean;
  saving: boolean;
  canConfirm: boolean;
  confirming: boolean;
  onSave: (value: {
    question: string;
    rationale: string | null;
    locked: boolean;
  }) => Promise<void>;
  onConfirm: () => Promise<void>;
}) {
  const [text, setText] = useState(question.question);
  const [rationale, setRationale] = useState(question.rationale ?? "");
  const [locked, setLocked] = useState(question.locked);

  useEffect(() => {
    setText(question.question);
    setRationale(question.rationale ?? "");
    setLocked(question.locked);
  }, [
    question.id,
    question.locked,
    question.question,
    question.rationale,
    question.revision,
  ]);

  return (
    <div className="rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {question.category && (
            <span className="rounded-full bg-[#eee7f3] px-2.5 py-1 text-xs font-semibold text-[#5b2a86]">
              {QUESTION_CATEGORY_LABELS[question.category] || question.category}
            </span>
          )}
          <span className="text-xs font-semibold text-[#5b2a86]">
            {question.status === "selected"
              ? "已启动 · 已锁定"
              : question.selectionApprovalStatus === "pending"
                ? "用户申请启动"
                : "候选问题"}
          </span>
        </div>
        {editable && question.selectionApprovalStatus !== "pending" ? (
          <label className="flex items-center gap-2 text-xs text-[#716a80]">
            <input
              type="checkbox"
              checked={locked}
              onChange={(event) => setLocked(event.target.checked)}
            />
            锁定，不被后续生成替换
          </label>
        ) : question.locked ? (
          <span className="flex items-center gap-1 text-xs text-[#716a80]">
            <LockKeyhole className="h-3.5 w-3.5" />
            已锁定
          </span>
        ) : null}
      </div>
      {editable ? (
        <>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-20 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 py-2 text-sm leading-6 text-[#332842] outline-none focus:border-[#5b2a86]"
          />
          <textarea
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="推荐依据与管理员说明"
            className="mt-2 min-h-16 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 py-2 text-xs leading-5 text-[#716a80] outline-none focus:border-[#5b2a86]"
          />
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={!text.trim() || saving}
            onClick={() =>
              void onSave({
                question: text.trim(),
                rationale: rationale.trim() || null,
                locked,
              })
            }
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            保存调整
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold leading-6 text-[#332842]">
            {question.question}
          </p>
          {question.rationale && (
            <p className="mt-2 text-xs leading-5 text-[#716a80]">
              {question.rationale}
            </p>
          )}
        </>
      )}
      {question.selectionApprovalStatus === "pending" && (
        <div className="mt-3 flex flex-col gap-2 border-t border-[#e8e1ee] pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-xs leading-5 text-[#716a80]">
            确认后将锁定该问题，并占用当前服务周期对应类别额度。
          </p>
          <Button
            size="sm"
            className="bg-[#5b2a86] hover:bg-[#49216c]"
            disabled={!canConfirm || confirming}
            onClick={() => void onConfirm()}
          >
            {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
            {canConfirm ? "确认启动并占用额度" : "等待管理员确认"}
          </Button>
        </div>
      )}
      {(question.evidence?.length || question.quotaPeriodId) && (
        <details className="mt-3 border-t border-[#e8e1ee] pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-[#716a80]">
            配额周期与知识库证据
          </summary>
          {question.quotaPeriodId && (
            <p className="mt-3 break-all font-mono text-xs text-[#9a94a8]">
              {question.quotaPeriodId}
            </p>
          )}
          {(question.evidence ?? []).map((evidence, index) => (
            <div
              key={`${evidence.documentPath}-${index}`}
              className="mt-2 rounded-xl border border-[#e8e1ee] bg-white p-3"
            >
              <p className="break-all text-xs font-semibold text-[#484057]">
                {evidence.documentPath}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#716a80]">
                {evidence.excerpt}
              </p>
              {evidence.relevance && (
                <p className="mt-1 text-xs text-[#9a94a8]">
                  {evidence.relevance}
                </p>
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function ManualOrderCard({
  order,
  busy,
  uploadProgress,
  onPrepare,
  onConfirmSigned,
  onActivate,
  onReject,
}: {
  order: ManualOrder;
  busy?: ManualOrderBusyState;
  uploadProgress?: { label: string; percent: number };
  onPrepare: (
    order: ManualOrder,
    draft: ManualOrderPreparationDraft,
  ) => Promise<void>;
  onConfirmSigned: (
    order: ManualOrder,
    draft: ManualOrderSignatureDraft,
  ) => Promise<void>;
  onActivate: (order: ManualOrder) => Promise<void>;
  onReject: (order: ManualOrder, note: string) => Promise<void>;
}) {
  const [preparation, setPreparation] = useState<ManualOrderPreparationDraft>({
    contractId: order.contractId ?? "",
    signingUrl: order.signingUrl ?? "",
  });
  const [signature, setSignature] = useState<ManualOrderSignatureDraft>({
    signedAtLocal: "",
    signatoryId: "",
    note: "",
  });
  const [rejectNote, setRejectNote] = useState("");
  const [fileError, setFileError] = useState("");
  const statusCopy =
    order.status === "active" ? null : MANUAL_ORDER_STATUS_COPY[order.status];
  const action = manualOrderPrimaryAction(order.status);
  const working = Boolean(busy);
  const paymentOrderId =
    order.payment?.orderId ?? order.paymentOrderId ?? order.orderId;
  const paymentTradeNo = order.payment?.tradeNo ?? order.paymentTradeNo;
  const paidAt = order.payment?.paidAt ?? order.paidAt;

  useEffect(() => {
    setPreparation({
      contractId: order.contractId ?? "",
      signingUrl: order.signingUrl ?? "",
    });
    setSignature({
      signedAtLocal: "",
      signatoryId: "",
      note: "",
    });
    setRejectNote("");
    setFileError("");
  }, [order.contractId, order.reference, order.signingUrl, order.status]);

  if (!statusCopy || !action) return null;

  const selectPdf = (
    kind: "signedContract" | "signingReport",
    file: File | undefined,
  ) => {
    if (!file) {
      setSignature((current) => ({ ...current, [kind]: undefined }));
      return;
    }
    const error = validateManualOrderPdf(file);
    if (error) {
      setFileError(error);
      setSignature((current) => ({ ...current, [kind]: undefined }));
      return;
    }
    setFileError("");
    setSignature((current) => ({ ...current, [kind]: file }));
  };

  return (
    <article className="rounded-2xl border border-[#e5dce9] bg-[#fbf9fd] p-4 sm:p-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold text-[#2e243d]">
              {order.companyName || "待确认企业"}
            </h4>
            <Badge className={statusCopy.tone}>{statusCopy.label}</Badge>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#61586f]">
            {order.question || "本次 GEO 服务问题待同步"}
          </p>
          <p className="mt-1 text-xs text-[#938b9f]">
            业务订单 {order.orderId || order.reference} · 创建于{" "}
            {displayDateTime(order.createdAt)}
          </p>
        </div>
        <p className="max-w-md text-xs leading-5 text-[#716a80]">
          {statusCopy.description}
        </p>
      </header>

      {action === "prepare" && (
        <div className="mt-4 grid gap-3 border-t border-[#e8e1ee] pt-4 lg:grid-cols-2">
          <label className="text-xs font-semibold text-[#716a80]">
            合同编号
            <Input
              className="mt-2 bg-white"
              value={preparation.contractId}
              maxLength={128}
              placeholder="填写已生成合同的唯一编号"
              onChange={(event) =>
                setPreparation((current) => ({
                  ...current,
                  contractId: event.target.value,
                }))
              }
            />
          </label>
          <label className="text-xs font-semibold text-[#716a80]">
            HTTPS 签署链接
            <Input
              className="mt-2 bg-white"
              type="url"
              inputMode="url"
              value={preparation.signingUrl}
              placeholder="https://..."
              onChange={(event) =>
                setPreparation((current) => ({
                  ...current,
                  signingUrl: event.target.value,
                }))
              }
            />
          </label>
          <div className="flex justify-end lg:col-span-2">
            <Button
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={
                working ||
                !preparation.contractId.trim() ||
                !isSecureSigningUrl(preparation.signingUrl)
              }
              onClick={() => void onPrepare(order, preparation)}
            >
              {busy?.action === "prepare" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              已发起签署
            </Button>
          </div>
        </div>
      )}

      {action === "confirm_signed" && (
        <div className="mt-4 border-t border-[#e8e1ee] pt-4">
          {order.signingUrl && isSecureSigningUrl(order.signingUrl) && (
            <a
              href={order.signingUrl}
              target="_blank"
              rel="noreferrer"
              className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#5b2a86]"
            >
              打开本单签署页面 <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="rounded-xl border border-[#e5dce9] bg-white p-3 text-xs font-semibold text-[#716a80]">
              已签合同 PDF（必填，最大 20 MB）
              <input
                className="mt-2 block w-full text-xs font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-[#f1eaf5] file:px-3 file:py-2 file:font-semibold file:text-[#5b2a86]"
                type="file"
                accept=".pdf,application/pdf"
                disabled={working}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  selectPdf("signedContract", file);
                  if (file && validateManualOrderPdf(file))
                    event.currentTarget.value = "";
                }}
              />
              {signature.signedContract && (
                <span className="mt-2 block font-normal text-[#484057]">
                  {signature.signedContract.name} ·{" "}
                  {(signature.signedContract.size / 1024 / 1024).toFixed(2)} MB
                </span>
              )}
            </label>
            <label className="rounded-xl border border-[#e5dce9] bg-white p-3 text-xs font-semibold text-[#716a80]">
              签署报告 PDF（可选，最大 20 MB）
              <input
                className="mt-2 block w-full text-xs font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-[#f1eaf5] file:px-3 file:py-2 file:font-semibold file:text-[#5b2a86]"
                type="file"
                accept=".pdf,application/pdf"
                disabled={working}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  selectPdf("signingReport", file);
                  if (file && validateManualOrderPdf(file))
                    event.currentTarget.value = "";
                }}
              />
              {signature.signingReport && (
                <span className="mt-2 block font-normal text-[#484057]">
                  {signature.signingReport.name} ·{" "}
                  {(signature.signingReport.size / 1024 / 1024).toFixed(2)} MB
                </span>
              )}
            </label>
            <label className="text-xs font-semibold text-[#716a80]">
              实际签署时间
              <Input
                className="mt-2 bg-white"
                type="datetime-local"
                value={signature.signedAtLocal}
                max={toDateTimeLocal(new Date())}
                onChange={(event) =>
                  setSignature((current) => ({
                    ...current,
                    signedAtLocal: event.target.value,
                  }))
                }
              />
            </label>
            <label className="text-xs font-semibold text-[#716a80]">
              签署主体
              <Input
                className="mt-2 bg-white"
                value={signature.signatoryId}
                maxLength={128}
                placeholder="企业全称 / 签署人 / 统一社会信用代码"
                onChange={(event) =>
                  setSignature((current) => ({
                    ...current,
                    signatoryId: event.target.value,
                  }))
                }
              />
            </label>
            <label className="text-xs font-semibold text-[#716a80] lg:col-span-2">
              核验备注（必填，至少 8 个字）
              <textarea
                className="mt-2 min-h-20 w-full rounded-xl border border-input bg-white px-3 py-2 text-sm font-normal leading-6 text-[#332842] outline-none focus:border-[#5b2a86]"
                value={signature.note}
                maxLength={2000}
                placeholder="记录核验渠道、文件差异或其他需要留痕的信息（至少 8 个字）"
                onChange={(event) =>
                  setSignature((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          {fileError && (
            <p className="mt-3 text-xs font-medium text-[#ba2454]" role="alert">
              {fileError}
            </p>
          )}
          {uploadProgress && (
            <p className="mt-3 text-xs text-[#5b2a86]" role="status">
              {uploadProgress.label} {uploadProgress.percent}%
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <Button
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={
                working ||
                Boolean(validateManualOrderPdf(signature.signedContract)) ||
                (signature.signingReport
                  ? Boolean(validateManualOrderPdf(signature.signingReport))
                  : false) ||
                !signature.signedAtLocal ||
                !signature.signatoryId.trim() ||
                signature.note.trim().length < 8
              }
              onClick={() => void onConfirmSigned(order, signature)}
            >
              {busy?.action === "confirm_signed" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileCheck2 className="h-4 w-4" />
              )}
              确认签署完成
            </Button>
          </div>
        </div>
      )}

      {action === "wait_payment" && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-amber-900">
          <CreditCard className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">等待客户付款</p>
            <p className="mt-1 text-xs leading-5">
              此阶段只读，不允许提前开通。客户付款成功后，订单会进入“待企业设置账号”。
            </p>
          </div>
        </div>
      )}

      {action === "wait_account" && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50/70 p-4 text-sky-900">
          <KeyRound className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">等待企业设置登录账号</p>
            <p className="mt-1 text-xs leading-5">
              企业会在官网填写账号和密码；完成前不会开放管理员开通操作。
            </p>
          </div>
        </div>
      )}

      {action === "activate" && (
        <div className="mt-4 border-t border-[#e8e1ee] pt-4">
          <dl className="grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-[#716a80]">付款订单</dt>
              <dd className="mt-1 break-all font-semibold text-[#332842]">
                {paymentOrderId || "待确认"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[#716a80]">平台交易号</dt>
              <dd className="mt-1 break-all font-semibold text-[#332842]">
                {paymentTradeNo || "待确认"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[#716a80]">付款时间</dt>
              <dd className="mt-1 font-semibold text-[#332842]">
                {displayDateTime(paidAt)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex justify-end">
            <Button
              className="bg-[#16794f] hover:bg-[#12623f]"
              disabled={working || !paymentOrderId || !paidAt}
              onClick={() => void onActivate(order)}
            >
              {busy?.action === "activate" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PackageCheck className="h-4 w-4" />
              )}
              确认到账并开通
            </Button>
          </div>
        </div>
      )}

      {(order.status === "pending_admin" ||
        order.status === "signature_required") && (
        <details className="mt-4 border-t border-[#eadfe5] pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-[#9a4664]">
            异常处理：拒绝并终止订单
          </summary>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              className="bg-white"
              value={rejectNote}
              maxLength={2000}
              placeholder="填写拒绝原因（至少 8 个字）"
              onChange={(event) => setRejectNote(event.target.value)}
            />
            <Button
              variant="outline"
              className="shrink-0 border-[#d9aabb] text-[#a02652] hover:bg-[#fff5f8]"
              disabled={working || rejectNote.trim().length < 8}
              onClick={() => void onReject(order, rejectNote.trim())}
            >
              {busy?.action === "reject" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              拒绝订单
            </Button>
          </div>
        </details>
      )}
    </article>
  );
}

export default function AdminWorkspace({
  initialUserId = null,
  initialTab = "service",
}: {
  initialUserId?: number | null;
  initialTab?: WorkspaceTab;
}) {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    initialUserId,
  );
  const [createClientOpen, setCreateClientOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get("action") === "create"
    );
  });
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [servicePlan, setServicePlan] = useState<
    "basic" | "advanced" | "luxury"
  >("basic");
  const [serviceStatus, setServiceStatus] = useState<
    "pending_confirmation" | "scheduled" | "active" | "suspended" | "cancelled"
  >("active");
  const [serviceStartsAt, setServiceStartsAt] = useState(
    toDateInput(new Date()),
  );
  const [serviceOrderReference, setServiceOrderReference] = useState("");
  const [serviceContractReference, setServiceContractReference] = useState("");
  const [serviceSignedAt, setServiceSignedAt] = useState("");
  const [serviceSignatory, setServiceSignatory] = useState("");
  const [serviceEvidenceNote, setServiceEvidenceNote] = useState("");
  const [carryQuestionIds, setCarryQuestionIds] = useState<string[]>([]);
  const [manualOrderBusy, setManualOrderBusy] =
    useState<ManualOrderBusyState>();
  const [manualOrderUploadProgress, setManualOrderUploadProgress] = useState<
    Record<string, { label: string; percent: number }>
  >({});
  const manualOrderLocksRef = useRef(new Set<string>());
  const [uploading, setUploading] = useState<"knowledge" | null>(null);
  const knowledgeFileRef = useRef<HTMLInputElement>(null);

  const workspaceQuery = trpc.admin.workspace.list.useQuery(undefined, {
    enabled: user?.role === "admin",
    retry: false,
  });
  const selectedUser = workspaceQuery.data?.users.find(
    (item) => item.id === selectedUserId,
  );
  const usageOwnerAdmin = selectedUser?.usageOwner
    ? workspaceQuery.data?.admins.find(
        (admin) => admin.id === selectedUser.usageOwner?.adminId,
      )
    : null;
  const canViewSelectedUserUsage = Boolean(
    selectedUser &&
      (workspaceQuery.data?.isSystemAdmin ||
        selectedUser.usageOwner?.adminId === user?.id),
  );

  useEffect(() => {
    setSelectedUserId(initialUserId);
    setTab(initialTab);
  }, [initialTab, initialUserId]);

  const queryInput = { userId: selectedUserId || 1 };
  const dashboardQuery = trpc.admin.workspace.dashboard.useQuery(queryInput, {
    enabled: Boolean(selectedUser),
    retry: false,
  });
  const knowledgeQuery = trpc.admin.workspace.knowledge.useQuery(queryInput, {
    enabled: Boolean(selectedUser),
    retry: false,
  });
  const knowledgeProgressQuery = trpc.admin.workspace.progress.useQuery(
    queryInput,
    {
      enabled: Boolean(selectedUser),
      retry: false,
    },
  );
  const knowledgeActivityQuery =
    trpc.admin.workspace.knowledgeActivity.useQuery(queryInput, {
      enabled: Boolean(selectedUser),
      retry: false,
    });
  const serviceQuery = (trpc.admin.workspace as any).service.useQuery(
    queryInput,
    {
      enabled: Boolean(selectedUser),
      retry: false,
    },
  );
  const questionPortfolioQuery = (
    trpc.admin.workspace as any
  ).questionPortfolio.useQuery(queryInput, {
    enabled: Boolean(selectedUser),
    retry: false,
  });
  const manualOrdersApi = (trpc.admin as any).manualOrders;
  const manualOrdersQuery = manualOrdersApi.list.useQuery(undefined, {
    enabled: Boolean(workspaceQuery.data?.isSystemAdmin),
    retry: false,
  });
  const usageQuery = trpc.admin.workspace.creditUsage.useQuery(queryInput, {
    enabled: Boolean(
      canViewSelectedUserUsage && selectedUser?.credential.configured,
    ),
    retry: false,
    staleTime: 60_000,
  });
  const auditQuery = (trpc.admin as any).controlPlane.audit.useQuery(
    {
      workspaceUserId: selectedUserId || undefined,
      limit: 100,
    },
    {
      enabled: Boolean(selectedUser),
      retry: false,
    },
  );
  const taskActivityQuery = trpc.admin.workspace.taskActivity.useQuery(
    queryInput,
    {
      enabled: Boolean(selectedUser),
      retry: false,
    },
  );

  const assignmentMutation = trpc.admin.workspace.assignments.useMutation({
    onSuccess: (data) => {
      utils.admin.workspace.list.setData(undefined, data);
      toast.success("管理员分配已更新");
    },
  });
  const updateServiceMutation = (
    trpc.admin.workspace as any
  ).updateService.useMutation({
    onSuccess: async () => {
      await Promise.all([
        serviceQuery.refetch(),
        questionPortfolioQuery.refetch(),
        workspaceQuery.refetch(),
      ]);
      toast.success("服务版本已更新");
    },
  });
  const updateQuestionMutation = (
    trpc.admin.workspace as any
  ).updateQuestion.useMutation({
    onSuccess: async () => {
      await questionPortfolioQuery.refetch();
      toast.success("候选问题已更新");
    },
  });
  const confirmQuestionSelectionMutation = (
    trpc.admin.workspace as any
  ).confirmQuestionSelection.useMutation({
    onSuccess: async () => {
      await Promise.all([
        questionPortfolioQuery.refetch(),
        serviceQuery.refetch(),
        workspaceQuery.refetch(),
      ]);
      toast.success("问题已确认启动并计入额度");
    },
  });
  const prepareManualOrderMutation = manualOrdersApi.prepare.useMutation();
  const confirmSignedManualOrderMutation =
    manualOrdersApi.confirmSigned.useMutation();
  const activateManualOrderMutation = manualOrdersApi.activate.useMutation();
  const rejectManualOrderMutation = manualOrdersApi.reject.useMutation();

  const manualOrders = useMemo(() => {
    const value =
      manualOrdersQuery.data?.orders ?? manualOrdersQuery.data?.manualOrders;
    if (!Array.isArray(value)) return [] as ManualOrder[];
    return (value as ManualOrder[]).filter(
      (order) =>
        order &&
        order.status !== "active" &&
        manualOrderPrimaryAction(order.status) !== null,
    );
  }, [manualOrdersQuery.data?.manualOrders, manualOrdersQuery.data?.orders]);

  useEffect(() => {
    const service = serviceQuery.data?.service;
    const nextPlan = service?.planCode;
    if (
      nextPlan === "basic" ||
      nextPlan === "advanced" ||
      nextPlan === "luxury"
    ) {
      setServicePlan(nextPlan);
    } else {
      setServicePlan("basic");
    }
    const nextStatus = service?.status;
    if (
      nextStatus === "pending_confirmation" ||
      nextStatus === "scheduled" ||
      nextStatus === "active" ||
      nextStatus === "suspended" ||
      nextStatus === "cancelled"
    ) {
      setServiceStatus(nextStatus);
    } else {
      setServiceStatus("active");
    }
    setServiceStartsAt(toDateInput(service?.validFrom));
    const currentPurchase = (serviceQuery.data?.purchases ?? []).find(
      (purchase: any) => purchase.id === service?.contractId,
    );
    setServiceOrderReference(currentPurchase?.orderReference ?? "");
    setServiceContractReference(currentPurchase?.contractReference ?? "");
    setServiceSignedAt(toDateTimeLocal(currentPurchase?.signedAt));
    setServiceSignatory(currentPurchase?.signatoryId ?? "");
    setServiceEvidenceNote("");
    const activeBasicIds =
      service?.planCode === "basic"
        ? (serviceQuery.data?.purchases ?? [])
            .filter(
              (purchase: any) =>
                purchase.planCode === "basic" &&
                (purchase.status === "active" ||
                  purchase.status === "scheduled"),
            )
            .map((purchase: any) => purchase.id)
        : [];
    const sourceContractIds = activeBasicIds.length
      ? activeBasicIds
      : service?.contractId
        ? [service.contractId]
        : [];
    setCarryQuestionIds(
      (questionPortfolioQuery.data?.questions ?? [])
        .filter(
          (question: any) =>
            question.status === "selected" &&
            sourceContractIds.includes(question.contractId),
        )
        .map((question: any) => question.id),
    );
  }, [
    questionPortfolioQuery.data?.questions,
    selectedUserId,
    serviceQuery.data?.service,
  ]);

  const handleAssignment = async (
    adminIds: number[],
    usageOwnerAdminId?: number | null,
  ) => {
    if (!selectedUser || !workspaceQuery.data?.isSystemAdmin) return;
    try {
      await assignmentMutation.mutateAsync({
        userId: selectedUser.id,
        adminIds,
        usageOwnerAdminId,
      });
    } catch (error) {
      toast.error("无法更新管理员分配", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
      throw error;
    }
  };

  const handleUpload = async (file: File) => {
    if (!selectedUserId) return;
    setUploading("knowledge");
    try {
      await uploadWorkspaceFile({
        userId: selectedUserId,
        file,
        mode: "knowledge",
      });
      await Promise.all([
        dashboardQuery.refetch(),
        knowledgeQuery.refetch(),
        workspaceQuery.refetch(),
      ]);
      toast.success("知识库新版本已发布", {
        description: file.name,
      });
    } catch (error) {
      toast.error("文件导入失败", {
        description: error instanceof Error ? error.message : "请检查文件格式",
      });
    } finally {
      setUploading(null);
      if (knowledgeFileRef.current) knowledgeFileRef.current.value = "";
    }
  };

  const refreshManualOrders = async () => {
    await Promise.all([manualOrdersQuery.refetch(), workspaceQuery.refetch()]);
  };

  const runManualOrderAction = async (
    order: ManualOrder,
    action: ManualOrderBusyState["action"],
    work: () => Promise<unknown>,
    successMessage: string,
  ) => {
    const lockKey = order.reference;
    if (manualOrderLocksRef.current.has(lockKey)) return;
    manualOrderLocksRef.current.add(lockKey);
    setManualOrderBusy({ reference: order.reference, action });
    try {
      await work();
      await refreshManualOrders();
      toast.success(successMessage, {
        description: order.companyName || order.orderId || order.reference,
      });
    } catch (error) {
      toast.error("订单处理失败", {
        description: manualOrderError(error),
      });
    } finally {
      manualOrderLocksRef.current.delete(lockKey);
      setManualOrderBusy((current) =>
        current?.reference === order.reference && current.action === action
          ? undefined
          : current,
      );
      setManualOrderUploadProgress((current) => {
        if (!(order.reference in current)) return current;
        const next = { ...current };
        delete next[order.reference];
        return next;
      });
    }
  };

  const handlePrepareManualOrder = async (
    order: ManualOrder,
    draft: ManualOrderPreparationDraft,
  ) => {
    const contractId = draft.contractId.trim();
    const signingUrl = draft.signingUrl.trim();
    if (!contractId) {
      toast.error("请填写合同编号");
      return;
    }
    if (!isSecureSigningUrl(signingUrl)) {
      toast.error("签署链接必须是有效的 HTTPS 地址");
      return;
    }
    await runManualOrderAction(
      order,
      "prepare",
      () =>
        prepareManualOrderMutation.mutateAsync({
          reference: order.reference,
          contractId,
          signingUrl,
        }),
      "签署已发起",
    );
  };

  const uploadManualOrderPdf = async (
    order: ManualOrder,
    file: File,
    label: string,
    sha256: string,
  ): Promise<UploadedManualOrderFile> => {
    setManualOrderUploadProgress((current) => ({
      ...current,
      [order.reference]: { label, percent: 0 },
    }));
    const uploaded = await uploadFile(file, (percent) => {
      setManualOrderUploadProgress((current) => ({
        ...current,
        [order.reference]: { label, percent },
      }));
    });
    return {
      ...uploaded,
      sha256,
    };
  };

  const handleConfirmSignedManualOrder = async (
    order: ManualOrder,
    draft: ManualOrderSignatureDraft,
  ) => {
    const signedContractError = validateManualOrderPdf(draft.signedContract);
    if (signedContractError) {
      toast.error("已签合同不可用", { description: signedContractError });
      return;
    }
    if (draft.signingReport) {
      const signingReportError = validateManualOrderPdf(draft.signingReport);
      if (signingReportError) {
        toast.error("签署报告不可用", { description: signingReportError });
        return;
      }
    }
    const signedAt = new Date(draft.signedAtLocal).getTime();
    if (!Number.isFinite(signedAt) || signedAt > Date.now()) {
      toast.error("请填写真实且不晚于当前时间的签署时间");
      return;
    }
    const signatoryId = draft.signatoryId.trim();
    if (!signatoryId) {
      toast.error("请填写签署主体");
      return;
    }
    const note = draft.note.trim();
    if (note.length < 8) {
      toast.error("请填写至少 8 个字的核验备注");
      return;
    }
    const signedContract = draft.signedContract!;
    await runManualOrderAction(
      order,
      "confirm_signed",
      async () => {
        setManualOrderUploadProgress((current) => ({
          ...current,
          [order.reference]: { label: "正在计算文件校验值", percent: 0 },
        }));
        const [signedContractSha256, signingReportSha256] = await Promise.all([
          sha256ManualOrderFile(signedContract),
          draft.signingReport
            ? sha256ManualOrderFile(draft.signingReport)
            : Promise.resolve(undefined),
        ]);
        const uploadedSignedContract = await uploadManualOrderPdf(
          order,
          signedContract,
          "正在上传已签合同",
          signedContractSha256,
        );
        const uploadedSigningReport =
          draft.signingReport && signingReportSha256
            ? await uploadManualOrderPdf(
                order,
                draft.signingReport,
                "正在上传签署报告",
                signingReportSha256,
              )
            : undefined;
        return confirmSignedManualOrderMutation.mutateAsync({
          reference: order.reference,
          signedPdf: uploadedSignedContract,
          ...(uploadedSigningReport
            ? { evidenceReport: uploadedSigningReport }
            : {}),
          signedAt,
          signatoryId,
          note,
        });
      },
      "签署证据已确认",
    );
  };

  const handleActivateManualOrder = async (order: ManualOrder) => {
    await runManualOrderAction(
      order,
      "activate",
      () =>
        activateManualOrderMutation.mutateAsync({
          reference: order.reference,
        }),
      "到账已确认，服务正在开通",
    );
  };

  const handleRejectManualOrder = async (order: ManualOrder, note: string) => {
    if (note.trim().length < 8) {
      toast.error("请填写至少 8 个字的拒绝原因");
      return;
    }
    await runManualOrderAction(
      order,
      "reject",
      () =>
        rejectManualOrderMutation.mutateAsync({
          reference: order.reference,
          note: note.trim(),
        }),
      "订单已拒绝",
    );
  };

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="客户交付工作台"
      navItems={getAdminNav(Boolean(workspaceQuery.data?.isSystemAdmin))}
      toolbar={
        <div className="flex items-center gap-2">
          {canCreateManagedCustomer(workspaceQuery.data?.isSystemAdmin) && (
            <Button size="sm" onClick={() => setCreateClientOpen(true)}>
              <Plus className="h-4 w-4" />
              创建客户
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="border-[#e1d8e8] bg-white"
            disabled={
              workspaceQuery.isFetching ||
              (Boolean(workspaceQuery.data?.isSystemAdmin) &&
                manualOrdersQuery.isFetching)
            }
            onClick={() =>
              void Promise.all([
                workspaceQuery.refetch(),
                ...(workspaceQuery.data?.isSystemAdmin
                  ? [manualOrdersQuery.refetch()]
                  : []),
              ])
            }
          >
            <RefreshCw
              className={`h-4 w-4 ${
                workspaceQuery.isFetching || manualOrdersQuery.isFetching
                  ? "animate-spin"
                  : ""
              }`}
            />
            刷新
          </Button>
        </div>
      }
    >
      {canCreateManagedCustomer(workspaceQuery.data?.isSystemAdmin) && (
        <CreateUserDialog
          open={createClientOpen}
          onOpenChange={setCreateClientOpen}
          userOnly
          onCreated={(userId) => {
            setSelectedUserId(userId);
            void workspaceQuery.refetch();
          }}
        />
      )}
      {workspaceQuery.error && (
        <PortalCard className="mb-5 border-[#ebc8d4] bg-[#fff8fa] p-5 text-sm text-[#a02652]">
          <p className="font-semibold">客户工作区暂时无法载入</p>
          <p className="mt-1 leading-6">
            {workspaceQuery.error.message || "请检查连接后重试。"}
          </p>
        </PortalCard>
      )}

      {workspaceQuery.data?.isSystemAdmin && (
        <PortalCard className="mb-5 p-5 sm:p-6">
          <div className="flex flex-col gap-4 border-b border-[#eee8f2] pb-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[#5b2a86]" />
                <h2 className="font-semibold text-[#171321]">
                  人工签约与开通待办
                </h2>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#716a80]">
                严格按“管理员发起签署 → 核验已签文件 → 客户付款 → 企业设置账号 →
                确认到账并开通”推进。每个状态只开放当前阶段的操作，签署确认不会自动开户。
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {(
                [
                  ["pending_admin", "待发签"],
                  ["signature_required", "待核签"],
                  ["payment_required", "待付款"],
                  ["account_setup_required", "待设账号"],
                  ["activation_required", "待开通"],
                ] as const
              ).map(([status, label]) => (
                <span
                  key={status}
                  className="rounded-full border border-[#e2d8e8] bg-[#faf7fc] px-3 py-1.5 text-[#716a80]"
                >
                  {label}{" "}
                  <strong className="text-[#332842]">
                    {
                      manualOrders.filter((order) => order.status === status)
                        .length
                    }
                  </strong>
                </span>
              ))}
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {manualOrdersQuery.isLoading ? (
              <p className="py-10 text-center text-sm text-[#716a80]">
                正在读取人工订单…
              </p>
            ) : manualOrdersQuery.error ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                <p className="font-semibold">人工订单暂时无法读取</p>
                <p className="mt-1 text-xs">
                  {manualOrdersQuery.error.message || "请刷新后重试"}
                </p>
              </div>
            ) : manualOrders.length > 0 ? (
              manualOrders.map((order) => (
                <ManualOrderCard
                  key={order.reference}
                  order={order}
                  busy={
                    manualOrderBusy?.reference === order.reference
                      ? manualOrderBusy
                      : undefined
                  }
                  uploadProgress={manualOrderUploadProgress[order.reference]}
                  onPrepare={handlePrepareManualOrder}
                  onConfirmSigned={handleConfirmSignedManualOrder}
                  onActivate={handleActivateManualOrder}
                  onReject={handleRejectManualOrder}
                />
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-[#ded4e5] py-10 text-center">
                <FileCheck2 className="mx-auto h-6 w-6 text-[#9a94a8]" />
                <p className="mt-3 text-sm font-medium text-[#484057]">
                  当前没有人工订单待办
                </p>
                <p className="mt-1 text-xs text-[#9a94a8]">
                  已开通订单不会继续显示在此队列。
                </p>
              </div>
            )}
          </div>
        </PortalCard>
      )}

      <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
        <PortalCard className="h-fit overflow-hidden">
          <div className="border-b border-[#e8e1ee] p-5">
            <div className="flex items-center gap-2">
              <UserCog className="h-5 w-5 text-[#5b2a86]" />
              <h2 className="font-semibold text-[#171321]">用户列表</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#716a80]">
              {workspaceQuery.data?.isSystemAdmin
                ? "系统管理员可分配所有用户；其他管理员仅看到被分配的用户。"
                : "仅显示已分配给你的用户。"}
            </p>
          </div>
          <div className="max-h-[680px] divide-y divide-[#eee8f2] overflow-y-auto custom-scrollbar">
            {workspaceQuery.isLoading ? (
              <div className="p-8 text-center text-sm text-[#716a80]">
                加载用户中…
              </div>
            ) : workspaceQuery.error ? (
              <div className="p-8 text-center text-sm text-[#a02652]">
                无法读取客户列表，请点击刷新重试。
              </div>
            ) : workspaceQuery.data?.users.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#716a80]">
                暂无可管理用户
              </div>
            ) : (
              workspaceQuery.data?.users.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => {
                    setSelectedUserId(account.id);
                    setLocation(`/admin/customers/${account.id}/${tab}`);
                  }}
                  className={`w-full p-4 text-left transition ${
                    selectedUserId === account.id
                      ? "bg-[#5b2a86]/8"
                      : "hover:bg-[#fbf9fd]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#221a33]">
                        {account.enterpriseName ||
                          account.displayName ||
                          account.username}
                      </p>
                      <p className="mt-1 truncate text-xs text-[#9a94a8]">
                        @{account.username}
                      </p>
                    </div>
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        account.isActive ? "bg-[#16794f]" : "bg-[#ba2454]"
                      }`}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="secondary" className="text-xs">
                      {account.service?.planCode === "advanced"
                        ? "进阶版"
                        : account.service?.planCode === "luxury"
                          ? "豪华版"
                          : account.service?.planCode === "basic"
                            ? "基础版"
                            : "版本待配置"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      管理员 {account.assignedAdmins.length}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={`text-xs ${
                        account.usageOwner && account.credential.configured
                          ? "text-[#16794f]"
                          : "text-[#c06f00]"
                      }`}
                    >
                      {account.usageOwner
                        ? account.credential.configured
                          ? "共享 Key 可用"
                          : "共享 Key 待配置"
                        : "Key 归属待指定"}
                    </Badge>
                  </div>
                </button>
              ))
            )}
          </div>
        </PortalCard>

        {!selectedUser ? (
          <PortalCard className="grid min-h-[520px] place-items-center p-8 text-center text-sm text-[#716a80]">
            {workspaceQuery.isLoading
              ? "正在核验客户访问权限…"
              : selectedUserId
                ? "该客户不存在，或尚未分配给当前管理员。"
                : "请选择一个用户开始管理"}
          </PortalCard>
        ) : (
          <div className="min-w-0 space-y-5">
            <PortalCard className="p-5 sm:p-6">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#5b2a86]">
                    用户工作空间
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-[#171321]">
                    {selectedUser.enterpriseName ||
                      selectedUser.displayName ||
                      selectedUser.username}
                  </h2>
                  <p className="mt-2 text-sm text-[#716a80]">
                    @{selectedUser.username}
                  </p>
                </div>

                <ManagerAssignmentEditor
                  key={selectedUser.id}
                  options={(workspaceQuery.data?.admins ?? []).map((admin) => ({
                    id: admin.id,
                    label:
                      admin.displayName ||
                      admin.username ||
                      `管理员 ${admin.id}`,
                    secondary: admin.username ? `@${admin.username}` : null,
                    accessLevel: admin.adminAccessLevel,
                  }))}
                  selectedIds={selectedUser.assignedAdmins.map(
                    (admin) => admin!.id,
                  )}
                  usageOwnerId={selectedUser.usageOwner?.adminId ?? null}
                  editable={Boolean(workspaceQuery.data?.isSystemAdmin)}
                  saving={assignmentMutation.isPending}
                  onSave={handleAssignment}
                />
              </div>

              <div className="mt-5 grid gap-3 border-t border-[#eee8f2] pt-5 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">套餐</p>
                  <p className="mt-1 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "暂时无法读取"
                        : serviceQuery.data?.service?.planName || "版本待配置"}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">
                    服务周期
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "暂时无法读取"
                        : `${displayDate(
                            serviceQuery.data?.service?.validFrom,
                          )} — ${displayDate(
                            serviceQuery.data?.service?.validUntil,
                          )}`}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">
                    当期问题
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "—"
                        : `${serviceQuery.data?.purchasedQuestions?.length ?? 0} 个`}
                  </p>
                </div>
                <div className="rounded-xl bg-[#f8f4fa] p-3">
                  <p className="text-xs font-semibold text-[#8d8499]">
                    服务端下一步
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm font-semibold text-[#332842]">
                    {serviceQuery.isLoading
                      ? "读取中…"
                      : serviceQuery.error
                        ? "暂时无法读取"
                        : serviceQuery.data?.nextAction?.label ||
                          serviceQuery.data?.nextAction?.title ||
                          "暂无待处理动作"}
                  </p>
                </div>
              </div>

              {serviceQuery.error && (
                <div className="mt-4 rounded-xl border border-[#ebc8d4] bg-[#fff8fa] px-4 py-3 text-sm text-[#a02652]">
                  套餐、配额与交付状态读取失败：
                  {serviceQuery.error.message || "请刷新后重试。"}
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-2 border-t border-[#eee8f2] pt-4">
                {ADMIN_WORKSPACE_TABS.filter(
                  ({ value }) =>
                    value !== "credential" || canViewSelectedUserUsage,
                ).map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setTab(value);
                      setLocation(
                        `/admin/customers/${selectedUser.id}/${value}`,
                      );
                    }}
                    className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                      tab === value
                        ? "bg-[#5b2a86] text-white"
                        : "bg-[#f3eef6] text-[#716a80] hover:text-[#5b2a86]"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
                <Button
                  variant="outline"
                  className="ml-auto border-[#dcd1e3] bg-white text-[#5b2a86]"
                  onClick={() =>
                    setLocation(`/admin/customers/${selectedUser.id}/preview`)
                  }
                >
                  <Eye className="h-4 w-4" />
                  只读验收
                </Button>
              </div>
            </PortalCard>

            {tab === "service" && (
              <div className="space-y-5">
                <PortalCard className="p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <PackageCheck className="h-5 w-5 text-[#5b2a86]" />
                        <h3 className="font-semibold text-[#171321]">
                          套餐与服务周期
                        </h3>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[#716a80]">
                        当前版本：
                        <span className="font-semibold text-[#332842]">
                          {serviceQuery.isLoading
                            ? "读取中…"
                            : serviceQuery.error
                              ? "暂时无法读取"
                              : serviceQuery.data?.service?.planName ||
                                "版本待配置"}
                        </span>
                        {!serviceQuery.error && !serviceQuery.isLoading && (
                          <>
                            {" · "}
                            {displayDate(serviceQuery.data?.service?.validFrom)}
                            {" 至 "}
                            {displayDate(
                              serviceQuery.data?.service?.validUntil,
                            )}
                          </>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-[#9a94a8]">
                        商业权益仅系统管理员可调整；所属管理员可查看并维护交付内容。
                      </p>
                    </div>
                  </div>

                  {workspaceQuery.data?.isSystemAdmin &&
                    !serviceQuery.error &&
                    !serviceQuery.isLoading && (
                      <div className="mt-6 grid gap-4 border-t border-[#eee8f2] pt-5 lg:grid-cols-3">
                        <label className="text-xs font-semibold text-[#716a80]">
                          套餐版本
                          <select
                            value={servicePlan}
                            onChange={(event) => {
                              const nextPlan = event.target.value as
                                | "basic"
                                | "advanced"
                                | "luxury";
                              setServicePlan(nextPlan);
                            }}
                            className="mt-2 h-10 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#332842]"
                          >
                            <option value="basic">基础版 · 30 天单题</option>
                            <option value="advanced">进阶版</option>
                            <option value="luxury">豪华版</option>
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          生效日期
                          <Input
                            type="date"
                            className="mt-2"
                            value={serviceStartsAt}
                            onChange={(event) =>
                              setServiceStartsAt(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          合同状态
                          <select
                            value={serviceStatus}
                            onChange={(event) =>
                              setServiceStatus(
                                event.target.value as typeof serviceStatus,
                              )
                            }
                            className="mt-2 h-10 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#332842]"
                          >
                            <option value="active">生效</option>
                            <option value="scheduled">待生效</option>
                            <option value="pending_confirmation">待确认</option>
                            <option value="suspended">暂停</option>
                            <option value="cancelled">取消</option>
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          订单 / 付款编号
                          <Input
                            className="mt-2"
                            value={serviceOrderReference}
                            placeholder="线下收款单或官网订单编号"
                            onChange={(event) =>
                              setServiceOrderReference(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          合同编号
                          <Input
                            className="mt-2"
                            value={serviceContractReference}
                            placeholder="已签合同的唯一编号"
                            onChange={(event) =>
                              setServiceContractReference(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          签署主体
                          <Input
                            className="mt-2"
                            value={serviceSignatory}
                            placeholder="企业名 / 签署人 / 统一社会信用代码"
                            onChange={(event) =>
                              setServiceSignatory(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80]">
                          实际签署时间
                          <Input
                            type="datetime-local"
                            className="mt-2"
                            value={serviceSignedAt}
                            onChange={(event) =>
                              setServiceSignedAt(event.target.value)
                            }
                          />
                        </label>
                        <label className="text-xs font-semibold text-[#716a80] lg:col-span-2">
                          新增签署或收款核验依据
                          <Input
                            className="mt-2"
                            value={serviceEvidenceNote}
                            placeholder={
                              (serviceQuery.data?.purchases ?? []).find(
                                (purchase: any) =>
                                  purchase.id ===
                                  serviceQuery.data?.service?.contractId,
                              )?.hasSigningEvidence
                                ? "已有核验依据；仅在补充或更正时填写"
                                : "例如：已核对盖章合同与银行回单（至少 8 个字）"
                            }
                            onChange={(event) =>
                              setServiceEvidenceNote(event.target.value)
                            }
                          />
                        </label>

                        {(questionPortfolioQuery.data?.questions ?? []).some(
                          (question: any) => question.status === "selected",
                        ) && (
                          <div className="lg:col-span-3 rounded-2xl border border-[#e7dced] bg-[#fbf9fd] p-4">
                            <p className="text-sm font-semibold text-[#332842]">
                              升级后继续服务的问题
                            </p>
                            <p className="mt-1 text-xs leading-5 text-[#857e91]">
                              已勾选问题会复制到新套餐并计入对应分类额度；若超额，保存会被服务端拒绝，必须先明确保留项。
                            </p>
                            <div className="mt-3 space-y-2">
                              {(questionPortfolioQuery.data?.questions ?? [])
                                .filter(
                                  (question: any) =>
                                    question.status === "selected",
                                )
                                .map((question: any) => (
                                  <label
                                    key={question.id}
                                    className="flex items-start gap-3 rounded-xl bg-white p-3 text-sm text-[#484057]"
                                  >
                                    <input
                                      type="checkbox"
                                      className="mt-1"
                                      checked={carryQuestionIds.includes(
                                        question.id,
                                      )}
                                      onChange={(event) =>
                                        setCarryQuestionIds((current) =>
                                          event.target.checked
                                            ? [
                                                ...new Set([
                                                  ...current,
                                                  question.id,
                                                ]),
                                              ]
                                            : current.filter(
                                                (id) => id !== question.id,
                                              ),
                                        )
                                      }
                                    />
                                    <span>{question.question}</span>
                                  </label>
                                ))}
                            </div>
                          </div>
                        )}

                        <div className="lg:col-span-3 flex justify-end">
                          <Button
                            className="bg-[#5b2a86] hover:bg-[#49216c]"
                            disabled={
                              !serviceStartsAt ||
                              updateServiceMutation.isPending
                            }
                            onClick={async () => {
                              if (!selectedUserId) return;
                              const isCommerciallyActive =
                                serviceStatus === "active" ||
                                serviceStatus === "scheduled";
                              const currentPurchase = (
                                serviceQuery.data?.purchases ?? []
                              ).find(
                                (purchase: any) =>
                                  purchase.id ===
                                  serviceQuery.data?.service?.contractId,
                              );
                              const hasExistingEvidence = Boolean(
                                currentPurchase?.signedAt &&
                                  currentPurchase?.signatoryId &&
                                  currentPurchase?.hasSigningEvidence,
                              );
                              if (
                                isCommerciallyActive &&
                                (!serviceOrderReference.trim() ||
                                  !serviceContractReference.trim() ||
                                  !serviceSignatory.trim() ||
                                  !serviceSignedAt ||
                                  (!hasExistingEvidence &&
                                    serviceEvidenceNote.trim().length < 8))
                              ) {
                                toast.error("请补全商业与签署依据", {
                                  description:
                                    "生效或待生效合同必须填写订单编号、合同编号、真实签署时间与签署主体；首次确认还需不少于 8 个字的核验依据。",
                                });
                                return;
                              }
                              const startsAt = new Date(
                                `${serviceStartsAt}T00:00:00+08:00`,
                              ).getTime();
                              const currentContractId =
                                serviceQuery.data?.service?.contractId;
                              const activeBasicIds =
                                serviceQuery.data?.service?.planCode === "basic"
                                  ? (serviceQuery.data?.purchases ?? [])
                                      .filter(
                                        (purchase: any) =>
                                          purchase.planCode === "basic" &&
                                          (purchase.status === "active" ||
                                            purchase.status === "scheduled"),
                                      )
                                      .map((purchase: any) => purchase.id)
                                  : [];
                              const sourceContractIds = activeBasicIds.length
                                ? activeBasicIds
                                : currentContractId
                                  ? [currentContractId]
                                  : undefined;
                              const allowedCarryIds = new Set(
                                (questionPortfolioQuery.data?.questions ?? [])
                                  .filter(
                                    (question: any) =>
                                      question.status === "selected" &&
                                      (!sourceContractIds ||
                                        sourceContractIds.includes(
                                          question.contractId,
                                        )),
                                  )
                                  .map((question: any) => question.id),
                              );
                              try {
                                await updateServiceMutation.mutateAsync({
                                  userId: selectedUserId,
                                  expectedRevision:
                                    serviceQuery.data?.revision ?? 0,
                                  planCode: servicePlan,
                                  startsAt,
                                  status: serviceStatus,
                                  sourceReference:
                                    serviceOrderReference.trim() ||
                                    serviceContractReference.trim() ||
                                    undefined,
                                  prepaidMonths:
                                    servicePlan === "basic" ? null : 3,
                                  orderReference:
                                    serviceOrderReference.trim() || undefined,
                                  contractReference:
                                    serviceContractReference.trim() ||
                                    undefined,
                                  signedAt: serviceSignedAt
                                    ? new Date(serviceSignedAt).getTime()
                                    : undefined,
                                  signatoryId:
                                    serviceSignatory.trim() || undefined,
                                  signingEvidence: serviceEvidenceNote.trim()
                                    ? {
                                        kind: "system_admin_manual_confirmation",
                                        note: serviceEvidenceNote.trim(),
                                        confirmedAt: serviceSignedAt
                                          ? new Date(
                                              serviceSignedAt,
                                            ).toISOString()
                                          : undefined,
                                        confirmedByUserId: user?.id,
                                      }
                                    : undefined,
                                  sourceContractIds,
                                  carryQuestionIds: carryQuestionIds.filter(
                                    (id) => allowedCarryIds.has(id),
                                  ),
                                });
                              } catch (error) {
                                toast.error("服务版本更新失败", {
                                  description:
                                    error instanceof Error
                                      ? error.message
                                      : "请刷新后重试",
                                });
                              }
                            }}
                          >
                            {updateServiceMutation.isPending && (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            保存服务版本
                          </Button>
                        </div>
                      </div>
                    )}
                </PortalCard>

                <PortalCard className="p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-[#171321]">
                        智能交付路径
                      </h3>
                      <p className="mt-1 text-sm text-[#716a80]">
                        状态和前置条件由服务端统一计算；未完成步骤不会显示虚构进度。
                      </p>
                    </div>
                    {serviceQuery.data?.nextAction?.label && (
                      <Badge className="bg-[#5b2a86]/10 text-[#5b2a86]">
                        {serviceQuery.data.nextAction.label}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {serviceQuery.error ? (
                      <div className="rounded-xl border border-[#ebc8d4] bg-[#fff8fa] p-4 text-sm text-[#a02652] sm:col-span-2 xl:col-span-3">
                        无法读取交付步骤：
                        {serviceQuery.error.message || "请刷新后重试。"}
                      </div>
                    ) : serviceQuery.isLoading ? (
                      <div className="p-4 text-sm text-[#716a80]">
                        正在读取交付步骤…
                      </div>
                    ) : (
                      (serviceQuery.data?.workflowSteps ?? []).map(
                        (step: any) => (
                          <button
                            type="button"
                            key={step.id}
                            disabled={step.status === "locked"}
                            className="rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4 text-left transition enabled:hover:border-[#cdb9db] enabled:hover:bg-white disabled:cursor-not-allowed disabled:opacity-75"
                            onClick={() => {
                              const targetTab: WorkspaceTab =
                                step.id === "knowledge"
                                  ? "knowledge"
                                  : step.id === "question"
                                    ? "service"
                                    : "delivery";
                              setTab(targetTab);
                              setLocation(
                                `/admin/customers/${selectedUser.id}/${targetTab}`,
                              );
                            }}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-semibold text-[#332842]">
                                {step.label}
                              </span>
                              <span
                                className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                  step.status === "complete"
                                    ? "bg-[#16794f]/10 text-[#16794f]"
                                    : step.status === "ready"
                                      ? "bg-[#5b2a86]/10 text-[#5b2a86]"
                                      : "bg-[#eee9f1] text-[#857e91]"
                                }`}
                              >
                                {step.status === "complete"
                                  ? "已完成"
                                  : step.status === "ready"
                                    ? "可处理"
                                    : "未解锁"}
                              </span>
                            </div>
                            {step.lockedReason && (
                              <p className="mt-3 text-xs leading-5 text-[#857e91]">
                                {step.lockedReason}
                              </p>
                            )}
                          </button>
                        ),
                      )
                    )}
                  </div>
                </PortalCard>

                <PortalCard className="p-5 sm:p-6">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h3 className="font-semibold text-[#171321]">
                        当前服务周期配额
                      </h3>
                      <p className="mt-1 text-sm text-[#716a80]">
                        {serviceQuery.data?.quotas
                          ? `${displayDate(
                              serviceQuery.data.quotas.validFrom,
                            )} 至 ${displayDate(
                              serviceQuery.data.quotas.validUntil,
                            )}`
                          : serviceQuery.isLoading
                            ? "正在读取配额…"
                            : serviceQuery.error
                              ? "配额暂时无法读取"
                              : "当前没有生效的配额周期"}
                      </p>
                    </div>
                    {serviceQuery.data?.quotas && (
                      <span className="text-sm font-semibold text-[#5b2a86]">
                        总计 {serviceQuery.data.quotas.usage.total}/
                        {serviceQuery.data.quotas.limits.totalQuestionLimit}
                      </span>
                    )}
                  </div>
                  {serviceQuery.data?.quotas && (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {[
                        [
                          "行业词",
                          serviceQuery.data.quotas.usage.industry,
                          serviceQuery.data.quotas.limits.industryLimit,
                        ],
                        [
                          "竞品对比词",
                          serviceQuery.data.quotas.usage.competitorComparison,
                          serviceQuery.data.quotas.limits
                            .competitorComparisonLimit,
                        ],
                        [
                          "美誉舆情词",
                          serviceQuery.data.quotas.usage.reputation,
                          serviceQuery.data.quotas.limits.reputationLimit,
                        ],
                        [
                          "产品场景词",
                          serviceQuery.data.quotas.usage.productScenario,
                          serviceQuery.data.quotas.limits.productScenarioLimit,
                        ],
                      ].map(([label, used, limit]) => (
                        <div
                          key={String(label)}
                          className="rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                        >
                          <p className="text-xs font-semibold text-[#716a80]">
                            {String(label)}
                          </p>
                          <p className="mt-2 text-2xl font-semibold text-[#332842]">
                            {Number(used)}/{Number(limit)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </PortalCard>

                <PortalCard className="p-5 sm:p-6">
                  <div>
                    <h3 className="font-semibold text-[#171321]">企业问题库</h3>
                    <p className="mt-1 text-sm leading-6 text-[#716a80]">
                      展示模型候选、已购问题与当前选题。接管该客户的管理员可以调整文字并锁定需要保留的候选项。
                    </p>
                  </div>
                  <div className="mt-5 grid gap-3">
                    {questionPortfolioQuery.isLoading ? (
                      <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#716a80]">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        读取问题库中…
                      </div>
                    ) : questionPortfolioQuery.error ? (
                      <div className="rounded-xl border border-[#ebc8d4] bg-[#fff8fa] p-4 text-sm text-[#a02652]">
                        问题库读取失败：
                        {questionPortfolioQuery.error.message ||
                          "请刷新后重试。"}
                      </div>
                    ) : questionPortfolioQuery.data?.questions?.length ? (
                      questionPortfolioQuery.data.questions.map(
                        (question: any) => (
                          <AdminQuestionRow
                            key={question.id}
                            question={question}
                            editable={true}
                            saving={updateQuestionMutation.isPending}
                            canConfirm={true}
                            confirming={
                              confirmQuestionSelectionMutation.isPending
                            }
                            onSave={async (value) => {
                              if (!selectedUserId) return;
                              try {
                                await updateQuestionMutation.mutateAsync({
                                  userId: selectedUserId,
                                  questionId: question.id,
                                  expectedRevision: question.revision,
                                  ...value,
                                });
                              } catch (error) {
                                toast.error("候选问题更新失败", {
                                  description:
                                    error instanceof Error
                                      ? error.message
                                      : "请刷新后重试",
                                });
                              }
                            }}
                            onConfirm={async () => {
                              if (!selectedUserId) return;
                              try {
                                await confirmQuestionSelectionMutation.mutateAsync(
                                  {
                                    userId: selectedUserId,
                                    questionId: question.id,
                                    expectedRevision: question.revision,
                                  },
                                );
                              } catch (error) {
                                toast.error("问题确认启动失败", {
                                  description:
                                    error instanceof Error
                                      ? error.message
                                      : "请刷新后重试",
                                });
                              }
                            }}
                          />
                        ),
                      )
                    ) : (
                      <p className="py-10 text-center text-sm text-[#716a80]">
                        当前账号尚无已购或已生成的问题。
                      </p>
                    )}
                  </div>
                </PortalCard>
              </div>
            )}

            {tab === "delivery" &&
              (dashboardQuery.error ? (
                <PortalCard className="border-[#ebc8d4] bg-[#fff8fa] p-6 text-sm text-[#a02652]">
                  <p className="font-semibold">交付内容暂时无法载入</p>
                  <p className="mt-1 leading-6">
                    {dashboardQuery.error.message || "请刷新后重试。"}
                  </p>
                </PortalCard>
              ) : (
                <div className="space-y-5">
                  <DashboardSkeletonEditor
                    userId={selectedUser.id}
                    workspace={dashboardQuery.data}
                    loading={dashboardQuery.isLoading}
                    authoritativeQuestions={
                      serviceQuery.data?.purchasedQuestions
                    }
                    authoritativeQuestionsLoading={serviceQuery.isLoading}
                    authoritativeQuestionsError={
                      serviceQuery.error?.message ?? null
                    }
                    onWorkspaceChanged={async () => {
                      await Promise.all([
                        dashboardQuery.refetch(),
                        workspaceQuery.refetch(),
                        serviceQuery.refetch(),
                        questionPortfolioQuery.refetch(),
                      ]);
                    }}
                  />
                  <DashboardVersionHistory
                    userId={selectedUser.id}
                    onWorkspaceChanged={async () => {
                      await Promise.all([
                        dashboardQuery.refetch(),
                        workspaceQuery.refetch(),
                      ]);
                    }}
                  />
                </div>
              ))}

            {tab === "tickets" && (
              <AdminDeliveryTicketWorkspace
                userId={selectedUser.id}
                enterpriseName={
                  selectedUser.enterpriseName ||
                  selectedUser.displayName ||
                  selectedUser.username
                }
                servicePlanCode={selectedUser.service?.planCode}
                serviceStatus={selectedUser.service?.status}
                canAdjustQuota={Boolean(workspaceQuery.data?.isSystemAdmin)}
              />
            )}

            {tab === "knowledge" && (
              <>
                {knowledgeActivityQuery.error ? (
                  <PortalCard className="border-[#ebc8d4] bg-[#fff8fa] p-6 text-sm text-[#a02652]">
                    <p className="font-semibold">知识库任务记录读取失败</p>
                    <p className="mt-1 leading-6">
                      {knowledgeActivityQuery.error.message || "请刷新后重试。"}
                    </p>
                  </PortalCard>
                ) : knowledgeActivityQuery.isLoading ? (
                  <PortalCard className="p-6 text-sm text-[#716a80]">
                    正在读取知识库任务与对话…
                  </PortalCard>
                ) : knowledgeActivityQuery.data?.build ? (
                  <PortalCard className="overflow-hidden">
                    <div className="border-b border-[#eee8f2] p-5 sm:p-6">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-xs font-semibold text-[#5b2a86]">
                            当前知识库构建
                          </p>
                          <h3 className="mt-1 font-semibold text-[#171321]">
                            {knowledgeActivityQuery.data.build.companyName}
                          </h3>
                          <p className="mt-2 break-all font-mono text-xs text-[#9a94a8]">
                            {knowledgeActivityQuery.data.build.conversationId}
                          </p>
                        </div>
                        <Badge className="bg-[#5b2a86]/10 text-[#5b2a86]">
                          {knowledgeActivityQuery.data.build.status}
                        </Badge>
                      </div>
                      {knowledgeActivityQuery.data.build.protocolError && (
                        <div className="mt-4 rounded-xl border border-[#ebc8d4] bg-[#fff8fa] p-3 text-sm leading-6 text-[#a02652]">
                          {knowledgeActivityQuery.data.build.protocolError}
                        </div>
                      )}
                    </div>
                    <div className="grid gap-0 xl:grid-cols-[360px_minmax(0,1fr)]">
                      <div className="border-b border-[#eee8f2] p-5 xl:border-b-0 xl:border-r">
                        <h4 className="text-sm font-semibold text-[#332842]">
                          执行任务
                        </h4>
                        {knowledgeActivityQuery.data.turns.length ? (
                          <div className="mt-3 max-h-[430px] space-y-2 overflow-y-auto custom-scrollbar">
                            {knowledgeActivityQuery.data.turns.map((turn) => (
                              <article
                                key={turn.id}
                                className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-3"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-xs font-semibold text-[#484057]">
                                    {turn.model || "模型未记录"}
                                  </span>
                                  <span className="text-xs text-[#857e91]">
                                    {turn.status}
                                  </span>
                                </div>
                                <p className="mt-2 text-xs text-[#857e91]">
                                  {displayDuration(turn.durationMs)}
                                </p>
                                {turn.errorMessage && (
                                  <p className="mt-2 text-xs leading-5 text-[#a02652]">
                                    {turn.errorMessage}
                                  </p>
                                )}
                              </article>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-[#716a80]">
                            暂无执行任务记录。
                          </p>
                        )}
                      </div>
                      <div className="p-5">
                        <h4 className="text-sm font-semibold text-[#332842]">
                          最近对话
                        </h4>
                        {knowledgeActivityQuery.data.messages.length ? (
                          <div className="mt-3 max-h-[520px] space-y-3 overflow-y-auto pr-1 custom-scrollbar">
                            {knowledgeActivityQuery.data.messages.map(
                              (message) => (
                                <article
                                  key={message.id}
                                  className={`rounded-2xl border p-4 ${
                                    message.role === "user"
                                      ? "border-[#ddd1e5] bg-[#f7f1fb]"
                                      : "border-[#e8e1ee] bg-white"
                                  }`}
                                >
                                  <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-[#857e91]">
                                    <span>
                                      {message.role === "user"
                                        ? "用户"
                                        : message.role === "assistant"
                                          ? "Agent"
                                          : message.role}
                                    </span>
                                    <span>
                                      {message.sentAt
                                        ? new Date(
                                            message.sentAt,
                                          ).toLocaleString("zh-CN")
                                        : "时间未记录"}
                                    </span>
                                  </div>
                                  <div className="text-sm leading-6 text-[#484057]">
                                    <MarkdownRenderer
                                      content={message.content}
                                    />
                                  </div>
                                </article>
                              ),
                            )}
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-[#716a80]">
                            暂无持久化对话记录。
                          </p>
                        )}
                      </div>
                    </div>
                  </PortalCard>
                ) : (
                  <PortalCard className="p-6 text-sm text-[#716a80]">
                    该客户尚未开始对话式知识库构建。
                  </PortalCard>
                )}

                {knowledgeProgressQuery.error ? (
                  <PortalCard className="border-[#ebc8d4] bg-[#fff8fa] p-6 text-sm text-[#a02652]">
                    <p className="font-semibold">知识库构建进度读取失败</p>
                    <p className="mt-1 leading-6">
                      {knowledgeProgressQuery.error.message || "请刷新后重试。"}
                    </p>
                  </PortalCard>
                ) : (
                  <KnowledgeBaseProgressPanel
                    progress={knowledgeProgressQuery.data?.progress}
                    loading={knowledgeProgressQuery.isLoading}
                    title="客户知识库构建进度"
                    emptyMessage="该客户尚未开始对话式知识库构建；官网导入的一次性知识库不会伪造节点进度。"
                  />
                )}
                <PortalCard className="p-5 sm:p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="font-semibold text-[#171321]">
                        发布知识库版本
                      </h3>
                      <p className="mt-1 text-sm leading-6 text-[#716a80]">
                        ZIP 会完整解析 Markdown、TXT、JSON、CSV、HTML
                        与图片；网页不会执行，只作为安全知识内容展示。
                      </p>
                    </div>
                    <Button
                      className="shrink-0 bg-[#5b2a86] hover:bg-[#49216c]"
                      disabled={uploading !== null}
                      onClick={() => knowledgeFileRef.current?.click()}
                    >
                      {uploading === "knowledge" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FileArchive className="h-4 w-4" />
                      )}
                      上传知识库
                    </Button>
                    <input
                      ref={knowledgeFileRef}
                      type="file"
                      accept=".zip,.md,.markdown,.txt,.json,.csv,.html,.htm"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handleUpload(file);
                      }}
                    />
                  </div>
                </PortalCard>
                {knowledgeQuery.error ? (
                  <PortalCard className="border-[#ebc8d4] bg-[#fff8fa] p-6 text-sm text-[#a02652]">
                    <p className="font-semibold">知识库展示版本读取失败</p>
                    <p className="mt-1 leading-6">
                      {knowledgeQuery.error.message || "请刷新后重试。"}
                    </p>
                  </PortalCard>
                ) : (
                  <KnowledgeBaseViewer
                    snapshot={knowledgeQuery.data?.snapshot}
                    loading={knowledgeQuery.isLoading}
                  />
                )}
              </>
            )}

            {tab === "credential" && canViewSelectedUserUsage && (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
                <PortalCard className="p-5 sm:p-6">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-5 w-5 text-[#5b2a86]" />
                    <h3 className="font-semibold text-[#171321]">
                      共享 Key 归属
                    </h3>
                  </div>
                  <div className="mt-5 rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-[#716a80]">
                        负责交付管理员
                      </span>
                      <Badge
                        className={
                          selectedUser.usageOwner &&
                          selectedUser.credential.configured
                            ? "bg-[#16794f]/10 text-[#16794f]"
                            : "bg-[#c89013]/10 text-[#9a6900]"
                        }
                      >
                        {selectedUser.usageOwner
                          ? selectedUser.credential.configured
                            ? "共享 Key 可用"
                            : "共享 Key 待配置"
                          : "待指定"}
                      </Badge>
                    </div>
                    <p className="mt-3 text-base font-semibold text-[#332842]">
                      {selectedUser.usageOwner
                        ? usageOwnerAdmin?.displayName ||
                          usageOwnerAdmin?.username ||
                          `交付管理员 ${selectedUser.usageOwner.adminId}`
                        : "尚未指定积分与 Key 归属管理员"}
                    </p>
                    {usageOwnerAdmin?.username && (
                      <p className="mt-1 text-xs text-[#9a94a8]">
                        @{usageOwnerAdmin.username}
                      </p>
                    )}
                    {selectedUser.credential.fingerprint && (
                      <p className="mt-4 break-all rounded-xl border border-[#e8e1ee] bg-white px-3 py-2 font-mono text-xs text-[#716a80]">
                        {selectedUser.credential.fingerprint}
                      </p>
                    )}
                  </div>
                  <p className="mt-4 text-sm leading-6 text-[#716a80]">
                    {selectedUser.usageOwner
                      ? "该用户不单独保存 API Key。用户任务与负责管理员自己的 FrontMind Agent 共用同一个 Key；Key 的录入和更换由该管理员在自己的设置中完成。"
                      : workspaceQuery.data?.isSystemAdmin
                        ? "请先在上方“负责管理员”中指定一名积分与 Key 归属管理员。系统不会继续为普通用户维护独立 API Key。"
                        : "该用户尚未完成共享 Key 归属配置，请联系系统管理员指定负责交付管理员。"}
                  </p>
                </PortalCard>

                <PortalCard className="p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-[#171321]">
                        本月积分使用
                      </h3>
                      <p className="mt-1 text-xs text-[#9a94a8]">
                        {usageQuery.data?.period?.label ?? "当前自然月"} ·
                        按北京时间自然月统计
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        !selectedUser.credential.configured ||
                        usageQuery.isFetching
                      }
                      onClick={() => void usageQuery.refetch()}
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${usageQuery.isFetching ? "animate-spin" : ""}`}
                      />
                    </Button>
                  </div>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl bg-[#f5eef9] p-4">
                      <p className="text-xs font-semibold text-[#716a80]">
                        该用户任务使用
                      </p>
                      <p className="mt-2 text-3xl font-semibold text-[#5b2a86]">
                        {(usageQuery.data?.accountUsed ?? 0).toLocaleString(
                          "zh-CN",
                        )}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
                      <p className="text-xs font-semibold text-[#716a80]">
                        共享 Key 总消耗
                      </p>
                      <p className="mt-2 text-3xl font-semibold text-[#332842]">
                        {(usageQuery.data?.totalUsed ?? 0).toLocaleString(
                          "zh-CN",
                        )}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-[#9a94a8]">
                    共享 Key 总消耗来自上游 Key 池，可能还包含负责管理员自己的
                    FrontMind Agent
                    任务及其他账号任务，因此不要求与该用户使用量相等。
                  </p>
                  {usageQuery.data?.complete === false && (
                    <p className="mt-3 rounded-xl border border-[#ead7a5] bg-[#fffaf0] px-3 py-2 text-xs leading-5 text-[#8a6200]">
                      当前 Key 的本月任务量超过单次同步上限，数据尚未完整，请稍后重试后再据此更换
                      Key。
                    </p>
                  )}
                  <div className="mt-5 max-h-[330px] divide-y divide-[#eee8f2] overflow-y-auto custom-scrollbar">
                    {!selectedUser.credential.configured ? (
                      <p className="py-8 text-center text-sm text-[#716a80]">
                        负责管理员尚未配置共享 Key
                      </p>
                    ) : usageQuery.isLoading ? (
                      <p className="py-8 text-center text-sm text-[#716a80]">
                        读取使用记录中…
                      </p>
                    ) : usageQuery.error ? (
                      <p className="py-8 text-center text-sm text-[#ba2454]">
                        {usageQuery.error.message}
                      </p>
                    ) : usageQuery.data?.recentTasks.length === 0 ? (
                      <p className="py-8 text-center text-sm text-[#716a80]">
                        本月暂无该用户的积分记录
                      </p>
                    ) : (
                      usageQuery.data?.recentTasks.map((task) => (
                        <div
                          key={task.id}
                          className="flex items-center justify-between gap-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[#484057]">
                              {task.title}
                            </p>
                            <p className="mt-1 text-xs text-[#9a94a8]">
                              {task.createdAt || task.id}
                            </p>
                          </div>
                          <span className="shrink-0 text-sm font-semibold text-[#5b2a86]">
                            {task.creditUsage.toLocaleString("zh-CN")}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </PortalCard>
              </div>
            )}

            {tab === "credential" && !canViewSelectedUserUsage && (
              <PortalCard className="p-6 text-sm leading-6 text-[#716a80]">
                该用户的共享 Key 与积分由其归属交付管理员维护。协作管理员可以继续处理交付内容，但不能查看其他管理员 Key
                池的积分信息。
              </PortalCard>
            )}

            {tab === "activity" && (
              <div className="space-y-5">
                <PortalCard className="overflow-hidden">
                  <div className="border-b border-[#eee8f2] p-5 sm:p-6">
                    <h3 className="font-semibold text-[#171321]">
                      客户智能体任务
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-[#716a80]">
                      展示最近 100 条持久化任务的真实状态、模型、耗时与错误。
                    </p>
                  </div>
                  {taskActivityQuery.isLoading ? (
                    <p className="p-6 text-sm text-[#716a80]">
                      正在读取任务记录…
                    </p>
                  ) : taskActivityQuery.error ? (
                    <p className="p-6 text-sm text-[#a02652]">
                      {taskActivityQuery.error.message ||
                        "任务记录暂时无法载入"}
                    </p>
                  ) : taskActivityQuery.data?.turns.length ? (
                    <>
                      <div className="grid grid-cols-2 gap-2 border-b border-[#eee8f2] p-4 sm:grid-cols-5">
                        {[
                          ["排队", taskActivityQuery.data.counts.queued],
                          ["执行中", taskActivityQuery.data.counts.running],
                          ["已完成", taskActivityQuery.data.counts.completed],
                          ["失败", taskActivityQuery.data.counts.failed],
                          ["已取消", taskActivityQuery.data.counts.cancelled],
                        ].map(([label, value]) => (
                          <div
                            key={String(label)}
                            className="rounded-xl bg-[#f8f5fa] p-3"
                          >
                            <p className="text-xs text-[#857e91]">
                              {String(label)}
                            </p>
                            <p className="mt-1 text-xl font-semibold text-[#332842]">
                              {Number(value)}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="max-h-[480px] divide-y divide-[#eee8f2] overflow-y-auto custom-scrollbar">
                        {taskActivityQuery.data.turns.map((turn) => (
                          <article
                            key={turn.id}
                            className="grid gap-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_110px_130px_180px] sm:items-center sm:px-6"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-mono text-xs font-semibold text-[#484057]">
                                {turn.conversationId}
                              </p>
                              {turn.errorMessage && (
                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#a02652]">
                                  {turn.errorMessage}
                                </p>
                              )}
                            </div>
                            <span className="text-xs text-[#716a80]">
                              {turn.model || "未记录"}
                            </span>
                            <span className="text-xs font-semibold text-[#5b2a86]">
                              {turn.status}
                            </span>
                            <span className="text-xs text-[#857e91] sm:text-right">
                              {displayDuration(turn.durationMs)}
                            </span>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="p-6 text-sm text-[#716a80]">
                      当前客户尚无持久化任务记录。
                    </p>
                  )}
                </PortalCard>

                <PortalCard className="overflow-hidden">
                  <div className="border-b border-[#eee8f2] p-5 sm:p-6">
                    <div className="flex items-center gap-2">
                      <History className="h-5 w-5 text-[#5b2a86]" />
                      <h3 className="font-semibold text-[#171321]">
                        客户工作区操作记录
                      </h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#716a80]">
                      记录权限、套餐、知识库、问题、内容、密钥与发布操作；
                      密钥和敏感元数据只保留脱敏信息。
                    </p>
                  </div>
                  {auditQuery.isLoading ? (
                    <p className="p-6 text-sm text-[#716a80]">
                      正在读取操作记录…
                    </p>
                  ) : auditQuery.error ? (
                    <p className="p-6 text-sm text-[#a02652]">
                      {auditQuery.error.message || "操作记录暂时无法载入"}
                    </p>
                  ) : auditQuery.data?.events?.length ? (
                    <div className="divide-y divide-[#eee8f2]">
                      {auditQuery.data.events.map((event: any) => (
                        <article
                          key={event.id}
                          className="grid gap-2 px-5 py-4 sm:grid-cols-[170px_minmax(0,1fr)_180px] sm:px-6"
                        >
                          <div>
                            <p className="text-sm font-semibold text-[#332842]">
                              {event.actorUsername || "系统"}
                            </p>
                            <p className="mt-1 text-xs text-[#9a94a8]">
                              {event.actorAccessLevel === "system_admin"
                                ? "系统管理员"
                                : event.actorAccessLevel === "delivery_admin"
                                  ? "交付管理员"
                                  : "系统"}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[#484057]">
                              {event.action}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-[#857e91]">
                              {event.reason ||
                                [event.targetType, event.targetId]
                                  .filter(Boolean)
                                  .join(" · ") ||
                                "已记录"}
                            </p>
                          </div>
                          <time className="text-xs text-[#9a94a8] sm:text-right">
                            {event.createdAt
                              ? new Date(event.createdAt).toLocaleString(
                                  "zh-CN",
                                )
                              : "时间未记录"}
                          </time>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="p-6 text-sm text-[#716a80]">
                      当前客户尚无可显示的操作记录。
                    </p>
                  )}
                </PortalCard>
              </div>
            )}
          </div>
        )}
      </div>
    </PortalShell>
  );
}
