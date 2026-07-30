import { useEffect, useRef, useState } from "react";
import {
  CreditCard,
  ClipboardList,
  Database,
  Eye,
  FileArchive,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  PackageCheck,
  Plus,
  RefreshCw,
  UserCog,
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
import {
  ADMIN_WORKSPACE_TAB_IDS,
  type WorkspaceTab,
} from "@/lib/admin-workspace-tabs";
import { trpc } from "@/lib/trpc";
import { auditActionLabel, auditEventDetail } from "@/lib/audit-display";
import { getAdminNav } from "@/pages/AdminDashboard";
import { CreateUserDialog } from "@/pages/AdminUsers";

export { ADMIN_WORKSPACE_TAB_IDS };
export type { WorkspaceTab };

export function canCreateManagedCustomer(
  adminAccessLevel?: "system_admin" | "delivery_admin" | null,
) {
  return (
    adminAccessLevel === "system_admin" || adminAccessLevel === "delivery_admin"
  );
}

export const ADMIN_WORKSPACE_TABS = [
  { value: "service", label: "套餐与问题", icon: PackageCheck },
  { value: "knowledge", label: "知识库流程", icon: Database },
  { value: "tickets", label: "工单与官网", icon: ClipboardList },
  { value: "delivery", label: "内容、监控与报告", icon: Database },
  { value: "credential", label: "客户 Key 与积分", icon: KeyRound },
  { value: "activity", label: "操作记录", icon: History },
] as const satisfies ReadonlyArray<{
  value: WorkspaceTab;
  label: string;
  icon: typeof PackageCheck;
}>;

const QUESTION_CATEGORY_LABELS: Record<string, string> = {
  industry: "行业词",
  competitor_comparison: "竞品对比词",
  reputation: "美誉舆情词",
  product_scenario: "产品场景词",
};

function toDateTimeLocal(value?: number | string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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
  const [serviceSignedAt, setServiceSignedAt] = useState("");
  const [serviceSignatory, setServiceSignatory] = useState("");
  const [customerApiKey, setCustomerApiKey] = useState("");
  const [carryQuestionIds, setCarryQuestionIds] = useState<string[]>([]);
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
  useEffect(() => {
    if (
      workspaceQuery.data &&
      !workspaceQuery.data.isSystemAdmin &&
      !["service", "activity"].includes(tab)
    ) {
      setTab("service");
      if (selectedUserId) {
        setLocation(`/admin/customers/${selectedUserId}/service`, {
          replace: true,
        });
      }
    }
  }, [selectedUserId, setLocation, tab, workspaceQuery.data]);

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
  const replaceCredentialMutation =
    trpc.admin.workspace.replaceCredential.useMutation({
      onSuccess: async () => {
        setCustomerApiKey("");
        await Promise.all([workspaceQuery.refetch(), usageQuery.refetch()]);
        toast.success("客户 API Key 已更新");
      },
      onError: (error) => toast.error(error.message),
    });
  const completeProvisioningMutation =
    trpc.admin.workspace.completeProvisioning.useMutation({
      onSuccess: async (result) => {
        setCustomerApiKey("");
        await Promise.all([
          workspaceQuery.refetch(),
          serviceQuery.refetch(),
          questionPortfolioQuery.refetch(),
          usageQuery.refetch(),
        ]);
        toast.success(
          result.idempotent
            ? "该客户已完成开通"
            : "套餐、额度与 Key 已完成开通",
        );
      },
      onError: (error) => toast.error(error.message),
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
    setServiceSignedAt(toDateTimeLocal(currentPurchase?.signedAt));
    setServiceSignatory(currentPurchase?.signatoryId ?? "");
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

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="客户交付工作台"
      navItems={getAdminNav(Boolean(workspaceQuery.data?.isSystemAdmin))}
      toolbar={
        <div className="flex items-center gap-2">
          {canCreateManagedCustomer(user?.adminAccessLevel) && (
            <Button size="sm" onClick={() => setCreateClientOpen(true)}>
              <Plus className="h-4 w-4" />
              创建客户
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="border-[#e1d8e8] bg-white"
            disabled={workspaceQuery.isFetching}
            onClick={() => void workspaceQuery.refetch()}
          >
            <RefreshCw
              className={`h-4 w-4 ${workspaceQuery.isFetching ? "animate-spin" : ""}`}
            />
            刷新
          </Button>
        </div>
      }
    >
      {canCreateManagedCustomer(user?.adminAccessLevel) && (
        <CreateUserDialog
          open={createClientOpen}
          onOpenChange={setCreateClientOpen}
          userOnly
          fixedDeliveryAdmin={
            user?.adminAccessLevel === "delivery_admin"
              ? {
                  id: user.id,
                  username: user.username,
                  displayName: user.displayName,
                }
              : undefined
          }
          deliveryAdmins={(workspaceQuery.data?.admins ?? [])
            .filter(
              (admin) =>
                admin.isActive && admin.adminAccessLevel === "delivery_admin",
            )
            .map((admin) => ({
              ...admin,
              username: admin.username || `admin-${admin.id}`,
            }))}
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
                            ? "普通版"
                            : "版本待配置"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {account.marketEdition === "overseas"
                        ? "海外版"
                        : "海内版"}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      管理员 {account.assignedAdmins.length}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={`text-xs ${
                        account.credential.configured
                          ? "text-[#16794f]"
                          : "text-[#c06f00]"
                      }`}
                    >
                      {account.credential.configured
                        ? account.credential.inherited
                          ? "历史共享 Key"
                          : "客户 Key 可用"
                        : "客户 Key 待配置"}
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
                    (workspaceQuery.data?.isSystemAdmin ||
                      ["service", "activity"].includes(value)) &&
                    (value !== "credential" || canViewSelectedUserUsage),
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
                            <option value="basic">普通版 · 30 天单题</option>
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
                              if (
                                isCommerciallyActive &&
                                (!serviceSignatory.trim() || !serviceSignedAt)
                              ) {
                                toast.error("请补全签署信息", {
                                  description:
                                    "生效或待生效合同必须填写真实签署时间与签署主体。",
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
                                  prepaidMonths:
                                    servicePlan === "basic" ? null : 3,
                                  signedAt: serviceSignedAt
                                    ? new Date(serviceSignedAt).getTime()
                                    : undefined,
                                  signatoryId:
                                    serviceSignatory.trim() || undefined,
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
                    profileOnly={false}
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
                      客户 API Key
                    </h3>
                  </div>
                  <div className="mt-5 rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-[#716a80]">主负责人</span>
                      <Badge
                        className={
                          selectedUser.credential.configured
                            ? "bg-[#16794f]/10 text-[#16794f]"
                            : "bg-[#c89013]/10 text-[#9a6900]"
                        }
                      >
                        {selectedUser.credential.configured
                          ? selectedUser.credential.inherited
                            ? "历史共享 Key"
                            : "客户 Key 可用"
                          : "客户 Key 待配置"}
                      </Badge>
                    </div>
                    <p className="mt-3 text-base font-semibold text-[#332842]">
                      {selectedUser.usageOwner
                        ? usageOwnerAdmin?.displayName ||
                          usageOwnerAdmin?.username ||
                          `管理员 ${selectedUser.usageOwner.adminId}`
                        : "尚未指定主负责人"}
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
                    客户 Key 按账号独立加密和版本化；客户自己的有效 Key
                    始终优先于历史共享 Key。设置或更换主负责人不会废弃该 Key。
                  </p>
                  <div className="mt-5 space-y-3 border-t border-[#eee8f2] pt-5">
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label="客户 API Key"
                      value={customerApiKey}
                      onChange={(event) =>
                        setCustomerApiKey(event.target.value)
                      }
                      placeholder={
                        selectedUser.service?.status === "pending_confirmation"
                          ? "输入 Key 并完成现有账号开通"
                          : "输入新的客户 API Key"
                      }
                    />
                    <Button
                      className="w-full"
                      disabled={
                        !customerApiKey.trim() ||
                        replaceCredentialMutation.isPending ||
                        completeProvisioningMutation.isPending ||
                        (selectedUser.service?.status ===
                          "pending_confirmation" &&
                          !selectedUser.usageOwner?.adminId) ||
                        (selectedUser.service?.status ===
                          "pending_confirmation" &&
                          !workspaceQuery.data?.isSystemAdmin)
                      }
                      onClick={() => {
                        if (
                          selectedUser.service?.status ===
                          "pending_confirmation"
                        ) {
                          completeProvisioningMutation.mutate({
                            userId: selectedUser.id,
                            expectedRevision: selectedUser.service.revision,
                            deliveryAdminId: selectedUser.usageOwner!.adminId,
                            apiKey: customerApiKey.trim(),
                          });
                          return;
                        }
                        replaceCredentialMutation.mutate({
                          userId: selectedUser.id,
                          apiKey: customerApiKey.trim(),
                          reason: "客户交付工作台更新客户自有 Key",
                        });
                      }}
                    >
                      {(replaceCredentialMutation.isPending ||
                        completeProvisioningMutation.isPending) && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      {selectedUser.service?.status === "pending_confirmation"
                        ? "完成套餐、额度与 Key 开通"
                        : selectedUser.credential.inherited
                          ? "设置客户自有 Key"
                          : "验证并更新客户 Key"}
                    </Button>
                    {selectedUser.service?.status === "pending_confirmation" &&
                      !workspaceQuery.data?.isSystemAdmin && (
                        <p className="text-xs leading-5 text-[#9a6900]">
                          该历史账号需由系统管理员完成一次性开通。
                        </p>
                      )}
                    {selectedUser.service?.status === "pending_confirmation" &&
                      workspaceQuery.data?.isSystemAdmin &&
                      !selectedUser.usageOwner?.adminId && (
                        <p className="text-xs leading-5 text-[#9a6900]">
                          请先在客户概览中分配一位已启用的管理员作为主负责人，再完成历史账号开通。
                        </p>
                      )}
                  </div>
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
                        当前 Key 总消耗
                      </p>
                      <p className="mt-2 text-3xl font-semibold text-[#332842]">
                        {(usageQuery.data?.totalUsed ?? 0).toLocaleString(
                          "zh-CN",
                        )}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-[#9a94a8]">
                    当前 Key 总消耗来自上游 Key 池；若同一原始 Key
                    分配给多个账号，可能包含其他账号任务，因此不要求与该用户使用量相等。
                  </p>
                  {usageQuery.data?.complete === false && (
                    <p className="mt-3 rounded-xl border border-[#ead7a5] bg-[#fffaf0] px-3 py-2 text-xs leading-5 text-[#8a6200]">
                      当前 Key
                      的本月任务量超过单次同步上限，数据尚未完整，请稍后重试后再据此更换
                      Key。
                    </p>
                  )}
                  <div className="mt-5 max-h-[330px] divide-y divide-[#eee8f2] overflow-y-auto custom-scrollbar">
                    {!selectedUser.credential.configured ? (
                      <p className="py-8 text-center text-sm text-[#716a80]">
                        该客户尚未配置可用 Key
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
                该用户的客户 Key
                与积分由主负责人维护。协作管理员可以继续处理交付内容，但不能查看该客户的
                Key 使用信息。
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
                              {auditActionLabel(event.action)}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-[#857e91]">
                              {auditEventDetail(
                                event,
                                selectedUser?.displayName ||
                                  selectedUser?.username,
                              )}
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
