import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Send,
  Upload,
  Users,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import PortalShell, { type PortalNavItem } from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { DELIVERY_ROLE_STORAGE_KEY } from "@/lib/frontmind-api";
import {
  channelDistributionUrl,
  issueMonitorUrl,
} from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

export const deliveryMemberNav: PortalNavItem[] = [
  { label: "我的工作台", href: "/", icon: ClipboardList, group: "交付" },
  {
    label: "通用智能体",
    href: "/delivery/agent",
    icon: Bot,
    group: "工具",
  },
  {
    label: "我的任务记录",
    href: "/delivery/tasks",
    icon: Clock3,
    group: "记录",
  },
];

const ROLE_PANELS: Record<DeliveryRoleType, string[]> = {
  knowledge_base_engineer: [
    "企业资料摘要",
    "知识库构建进度",
    "知识库对话与节点",
    "知识库展示版本",
  ],
  monitoring_optimization_engineer: [
    "品牌全域词库与问题目录",
    "监控答案与逐答案信源",
    "引用分析与优化复测",
    "阶段效果报告",
  ],
  content_distribution_engineer: [
    "应答逻辑",
    "AI 友好内容资产",
    "内容板块与卡片",
    "媒体发布与分发结果",
  ],
  website_operations_engineer: [
    "域名与 ICP 备案",
    "官网资料和内容模板",
    "站点检查",
    "目标页面与发布链接",
  ],
};

const TICKET_MODULE_IMPORTS: Record<
  string,
  {
    module:
      | "questions"
      | "monitoring"
      | "optimization-report"
      | "response-logic"
      | "content-assets";
    label: string;
    accept: string;
  }
> = {
  question_catalog: {
    module: "questions",
    label: "上传问题目录",
    accept: ".json,application/json",
  },
  initial_monitoring: {
    module: "monitoring",
    label: "预检并发布监控数据",
    accept: ".json,.csv,.xlsx,application/json,text/csv",
  },
  monitoring_import: {
    module: "monitoring",
    label: "预检并发布监控数据",
    accept: ".json,.csv,.xlsx,application/json,text/csv",
  },
  monitoring_retest: {
    module: "monitoring",
    label: "上传复测结果",
    accept: ".json,.csv,.xlsx,application/json,text/csv",
  },
  stage_report: {
    module: "optimization-report",
    label: "上传阶段报告",
    accept: ".json,application/json",
  },
  response_logic: {
    module: "response-logic",
    label: "上传应答逻辑",
    accept: ".json,application/json",
  },
  content_asset_publish: {
    module: "content-assets",
    label: "上传内容资产",
    accept: ".json,application/json",
  },
};

export default function DeliveryMemberDashboard({
  taskHistory = false,
}: {
  taskHistory?: boolean;
}) {
  const rolesQuery = trpc.delivery.mine.roles.useQuery();
  const [roleAssignmentId, setRoleAssignmentId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : localStorage.getItem(DELIVERY_ROLE_STORAGE_KEY) || "",
  );
  useEffect(() => {
    if (
      rolesQuery.data?.length &&
      !rolesQuery.data.some((role) => role.assignmentId === roleAssignmentId)
    ) {
      setRoleAssignmentId(rolesQuery.data[0]!.assignmentId);
    }
  }, [roleAssignmentId, rolesQuery.data]);
  useEffect(() => {
    if (roleAssignmentId) {
      localStorage.setItem(DELIVERY_ROLE_STORAGE_KEY, roleAssignmentId);
    }
  }, [roleAssignmentId]);
  const workbench = trpc.delivery.mine.workbench.useQuery(
    { roleAssignmentId },
    { enabled: Boolean(roleAssignmentId) },
  );
  const currentRole = rolesQuery.data?.find(
    (role) => role.assignmentId === roleAssignmentId,
  );
  const tickets = useMemo(
    () =>
      (workbench.data?.tickets ?? []).filter((ticket) =>
        taskHistory
          ? ["completed", "rejected", "cancelled"].includes(ticket.status)
          : !["completed", "rejected", "cancelled"].includes(ticket.status),
      ),
    [taskHistory, workbench.data?.tickets],
  );
  const external =
    currentRole?.roleType === "monitoring_optimization_engineer"
      ? { label: "打开问题监控", href: issueMonitorUrl, icon: Activity }
      : currentRole?.roleType === "content_distribution_engineer"
        ? { label: "打开渠道分发", href: channelDistributionUrl, icon: Send }
        : null;

  if (!rolesQuery.isLoading && !rolesQuery.data?.length) {
    return (
      <PortalShell
        eyebrow="交付成员"
        title="我的工作台"
        navItems={deliveryMemberNav}
      >
        <Card className="mx-auto max-w-xl">
          <CardContent className="py-14 text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-4 font-medium">尚未分配工作角色</p>
            <p className="mt-2 text-sm text-muted-foreground">
              请联系交付管理员，将你的账号加入固定角色团队。
            </p>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  return (
    <PortalShell
      eyebrow="交付成员 · 角色隔离工作台"
      title={taskHistory ? "我的任务记录" : "我的工作台"}
      navItems={deliveryMemberNav}
      roleLabel={
        currentRole
          ? `${DELIVERY_ROLE_LABELS[currentRole.roleType]} · ${currentRole.teamName}`
          : undefined
      }
      toolbar={
        <div className="flex items-center gap-2">
          <select
            aria-label="当前工作角色"
            className="h-10 rounded-md border bg-card px-3 text-sm"
            value={roleAssignmentId}
            onChange={(event) => setRoleAssignmentId(event.target.value)}
          >
            {(rolesQuery.data ?? []).map((role) => (
              <option key={role.assignmentId} value={role.assignmentId}>
                {DELIVERY_ROLE_LABELS[role.roleType]} · {role.teamName}
              </option>
            ))}
          </select>
          {external && (
            <a
              href={external.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              <external.icon className="h-4 w-4" />
              {external.label}
            </a>
          )}
        </div>
      }
    >
      {currentRole && !taskHistory && (
        <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {ROLE_PANELS[currentRole.roleType].map((panel) => (
            <Card key={panel}>
              <CardContent className="flex min-h-24 items-center p-5 font-medium">
                {panel}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[0.75fr_1.25fr]">
        <Card>
          <CardHeader>
            <CardTitle>我的客户</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(workbench.data?.customers ?? []).map((customer) => (
              <div
                key={customer.id}
                className="rounded-xl border px-4 py-3 text-sm"
              >
                <p className="font-medium">
                  {customer.displayName || customer.username}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  客户 #{customer.id}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {customer.details.map((detail) => (
                    <Badge
                      key={detail}
                      variant="secondary"
                      className="font-normal"
                    >
                      {detail}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
            {!workbench.data?.customers.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                当前角色尚未分配客户
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{taskHistory ? "已完成任务" : "当前工单"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {tickets.map((ticket) => (
              <div key={ticket.id} className="rounded-xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">
                    {ticket.title ||
                      ticket.operation ||
                      ticket.category ||
                      "交付工单"}
                  </p>
                  <Badge variant="outline">{ticket.status}</Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {ticket.operation} · 客户 #{ticket.userId}
                </p>
                {ticket.operation === "knowledge_reset" &&
                  ticket.status === "submitted" && (
                    <KnowledgeResetDecision
                      roleAssignmentId={roleAssignmentId}
                      requestId={ticket.clientRequestId}
                      onDone={() => workbench.refetch()}
                    />
                  )}
                {ticket.operation !== "knowledge_reset" &&
                  ticket.status !== "completed" && (
                    <DeliveryTicketActions
                      roleAssignmentId={roleAssignmentId}
                      ticket={ticket}
                      onDone={() => workbench.refetch()}
                    />
                  )}
              </div>
            ))}
            {!tickets.length && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <CheckCircle2 className="mx-auto mb-3 h-7 w-7" />
                暂无{taskHistory ? "已完成" : "待处理"}工单
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function DeliveryTicketActions({
  roleAssignmentId,
  ticket,
  onDone,
}: {
  roleAssignmentId: string;
  ticket: any;
  onDone: () => Promise<unknown>;
}) {
  const update = trpc.delivery.mine.updateTicket.useMutation();
  const [uploadingKnowledge, setUploadingKnowledge] = useState(false);
  const [uploadingModule, setUploadingModule] = useState(false);
  const moduleImport = TICKET_MODULE_IMPORTS[ticket.operation];
  const uploadKnowledgeArchive = async (file: File) => {
    setUploadingKnowledge(true);
    try {
      const response = await fetch(`/api/dashboard/import/${ticket.userId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-import-mode": "knowledge",
          "x-maintenance-ticket-id": ticket.id,
          "x-delivery-role-assignment-id": roleAssignmentId,
        },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || "知识库文件上传与校验失败");
      }
      await onDone();
      toast.success("新知识库版本已上传并发布", {
        description: "现在可以完成知识库维护工单。",
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "知识库文件上传失败",
      );
    } finally {
      setUploadingKnowledge(false);
    }
  };
  const uploadBusinessModule = async (file: File) => {
    if (!moduleImport) return;
    setUploadingModule(true);
    try {
      const request = async (input: {
        preview: boolean;
        targetBatchKey?: string;
        fileHash?: string;
        preflightToken?: string;
      }) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-import-mode": "dashboard",
          "x-dashboard-module": moduleImport.module,
          "x-dashboard-revision": String(ticket.dashboardRevision),
          "x-delivery-role-assignment-id": roleAssignmentId,
          "x-delivery-ticket-id": ticket.id,
        };
        if (input.preview) headers["x-import-preview"] = "true";
        if (input.targetBatchKey) {
          headers["x-monitoring-target-batch-key"] = input.targetBatchKey;
        }
        if (input.fileHash) {
          headers[
            moduleImport.module === "monitoring"
              ? "x-monitoring-file-hash"
              : "x-import-file-hash"
          ] = input.fileHash;
        }
        if (input.preflightToken) {
          headers["x-import-preflight-token"] = input.preflightToken;
        }
        const response = await fetch(`/api/dashboard/import/${ticket.userId}`, {
          method: "PUT",
          credentials: "include",
          headers,
          body: file,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message || "业务文件预检失败");
        }
        return payload;
      };
      let previewResult = await request({ preview: true });
      let preview = previewResult?.preview || previewResult;
      let targetBatchKey: string | undefined =
        preview?.preflightTargetBatchKey || undefined;
      if (
        moduleImport.module === "monitoring" &&
        preview?.targetBatchRequired
      ) {
        targetBatchKey =
          window
            .prompt(
              "请选择需要补充信源的监控批次标识：",
              preview?.suggestedBatchKey || targetBatchKey || "",
            )
            ?.trim() || undefined;
        if (!targetBatchKey) return;
        previewResult = await request({
          preview: true,
          targetBatchKey,
        });
        preview = previewResult?.preview || previewResult;
      }
      if (!preview?.fileHash || !preview?.preflightToken) {
        throw new Error("未取得有效预检凭证，请重新上传");
      }
      if (
        !window.confirm(
          `预检已通过：${file.name}\n模块：${moduleImport.label}\n确认发布到客户 #${ticket.userId}？`,
        )
      ) {
        return;
      }
      await request({
        preview: false,
        targetBatchKey,
        fileHash: preview.fileHash,
        preflightToken: preview.preflightToken,
      });
      await onDone();
      toast.success(`${moduleImport.label}已发布`, {
        description: "数据已写入该角色负责的正式业务模块。",
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `${moduleImport.label}失败`,
      );
    } finally {
      setUploadingModule(false);
    }
  };
  const run = async (
    status:
      | "in_progress"
      | "needs_information"
      | "completed"
      | "rejected"
      | "cancelled",
  ) => {
    let handoff:
      | {
          monitoringBatchKey?: string;
          optimizationQuestionIds?: string[];
          responseLogicRevision?: number;
          contentAssetIds?: string[];
          publishTargets?: Array<"media" | "website">;
          websiteOperation?:
            | "company_facts"
            | "product_case_docs"
            | "industry_news"
            | "company_news"
            | "faq_content";
          needsFurtherOptimization?: boolean;
          domain?: string;
          icpProvince?: string;
          icpNumber?: string;
          icpNotRequired?: boolean;
          siteCheck?: {
            key: string;
            label: string;
            status: "passed" | "warning" | "failed" | "not_applicable";
            summary?: string;
            evidence?: string;
            source?: string;
          };
        }
      | undefined;
    if (status === "completed" && ticket.operation === "domain_application") {
      const domain =
        window.prompt("请输入已经核验完成的客户域名：", ticket.topic || "") ||
        "";
      if (!domain.trim()) return;
      handoff = { domain: domain.trim() };
    } else if (status === "completed" && ticket.operation === "icp_filing") {
      const icpNotRequired = window.confirm(
        "该域名是否依法无需 ICP 备案？选择“取消”将继续登记备案号。",
      );
      if (icpNotRequired) {
        handoff = { icpNotRequired: true };
      } else {
        const icpNumber = window.prompt("请输入已核验的 ICP 备案号：") || "";
        if (!icpNumber.trim()) return;
        const icpProvince =
          window.prompt("请输入备案省份（可选）：", ticket.icpProvince || "") ||
          undefined;
        handoff = {
          icpNotRequired: false,
          icpNumber: icpNumber.trim(),
          icpProvince: icpProvince?.trim() || undefined,
        };
      }
    } else if (
      status === "completed" &&
      ["initial_monitoring", "monitoring_import"].includes(ticket.operation)
    ) {
      const batch =
        window.prompt(
          "请输入本次已发布监控批次标识（用于跨角色核验）：",
          ticket.monitoringBatchKey || "",
        ) || undefined;
      const questionIds =
        window.prompt(
          "请输入需要进入应答逻辑优化的问题 ID，多个 ID 用逗号分隔；没有则留空：",
        ) || "";
      handoff = {
        monitoringBatchKey: batch,
        optimizationQuestionIds: questionIds
          .split(/[,，\s]+/)
          .map((id) => id.trim())
          .filter(Boolean),
      };
    } else if (
      status === "completed" &&
      ticket.operation === "response_logic"
    ) {
      const revision = Number(
        window.prompt(
          "请输入本次已确认的应答逻辑版本号：",
          String(ticket.responseLogicRevision || 1),
        ),
      );
      if (!Number.isInteger(revision) || revision < 1) return;
      handoff = { responseLogicRevision: revision };
    } else if (
      status === "completed" &&
      ticket.operation === "content_asset_publish"
    ) {
      const assetIds =
        window.prompt(
          "请输入已确认内容资产 ID，多个 ID 用逗号分隔；仅媒体分发时可留空：",
          (ticket.contentAssetIds || []).join(","),
        ) || "";
      const targetText =
        window.prompt(
          "请输入发布目标：media、website 或 media,website：",
          "media",
        ) || "";
      const publishTargets = targetText
        .split(/[,，\s]+/)
        .map((target) => target.trim().toLowerCase())
        .filter(
          (target): target is "media" | "website" =>
            target === "media" || target === "website",
        );
      if (!publishTargets.length) return;
      const contentAssetIds = assetIds
        .split(/[,，\s]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      let websiteOperation:
        | "company_facts"
        | "product_case_docs"
        | "industry_news"
        | "company_news"
        | "faq_content"
        | undefined;
      if (publishTargets.includes("website")) {
        const operation = window.prompt(
          "请输入官网工单类型：company_facts、product_case_docs、industry_news、company_news 或 faq_content：",
          "company_facts",
        );
        if (
          !operation ||
          ![
            "company_facts",
            "product_case_docs",
            "industry_news",
            "company_news",
            "faq_content",
          ].includes(operation)
        ) {
          return;
        }
        websiteOperation = operation as typeof websiteOperation;
      }
      handoff = {
        contentAssetIds,
        publishTargets,
        websiteOperation,
      };
    } else if (
      status === "completed" &&
      [
        "company_facts",
        "product_case_docs",
        "industry_news",
        "company_news",
        "faq_content",
      ].includes(ticket.operation)
    ) {
      const assetIds =
        window.prompt(
          "请输入本官网页面绑定的已发布内容资产 ID，多个 ID 用逗号分隔：",
          (ticket.contentAssetIds || []).join(","),
        ) || "";
      const contentAssetIds = assetIds
        .split(/[,，\s]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      if (!contentAssetIds.length) return;
      handoff = { contentAssetIds };
    } else if (status === "completed" && ticket.operation === "site_check") {
      const key =
        window.prompt("请输入检查项标识：", "published-page-check") || "";
      const label = window.prompt("请输入检查项名称：", "已发布页面检查") || "";
      const result =
        window.prompt(
          "请输入检查结果：passed、warning、failed 或 not_applicable：",
          "passed",
        ) || "";
      if (
        !key.trim() ||
        !label.trim() ||
        !["passed", "warning", "failed", "not_applicable"].includes(result)
      ) {
        return;
      }
      handoff = {
        siteCheck: {
          key: key.trim(),
          label: label.trim(),
          status: result as "passed" | "warning" | "failed" | "not_applicable",
          summary:
            window.prompt("请输入站点检查摘要（可选）：")?.trim() || undefined,
          evidence:
            window.prompt("请输入检查证据或公开链接（可选）：")?.trim() ||
            undefined,
        },
      };
    } else if (status === "completed" && ticket.operation === "stage_report") {
      handoff = {
        needsFurtherOptimization: window.confirm(
          "本阶段是否仍未达到目标，需要重新生成内容优化工单？",
        ),
      };
    }
    const publicUrl =
      status === "completed"
        ? window.prompt(
            [
              "content_asset_publish",
              "channel_distribution",
              "company_facts",
              "product_case_docs",
              "industry_news",
              "company_news",
              "faq_content",
            ].includes(ticket.operation)
              ? "本工单完成时必须登记公开链接："
              : "如本工单产生公开页面或报告，请登记公开链接：",
          ) || undefined
        : undefined;
    const message =
      status === "needs_information" || status === "rejected"
        ? window.prompt(
            status === "rejected"
              ? "请填写驳回原因："
              : "请填写需要客户补充的信息：",
          ) || undefined
        : undefined;
    if ((status === "needs_information" || status === "rejected") && !message) {
      return;
    }
    try {
      await update.mutateAsync({
        roleAssignmentId,
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        status,
        message,
        publicUrl,
        handoff,
      });
      await onDone();
      toast.success("工单状态已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  };
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ticket.status !== "in_progress" && (
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => void run("in_progress")}
        >
          开始处理
        </Button>
      )}
      {ticket.status === "in_progress" && (
        <>
          {ticket.operation === "knowledge_maintenance" && (
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted">
              <Upload className="h-3.5 w-3.5" />
              {uploadingKnowledge ? "正在校验" : "上传并发布新版本"}
              <input
                className="hidden"
                type="file"
                accept=".zip,application/zip"
                disabled={uploadingKnowledge}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadKnowledgeArchive(file);
                }}
              />
            </label>
          )}
          {moduleImport && (
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted">
              <Upload className="h-3.5 w-3.5" />
              {uploadingModule ? "正在预检" : moduleImport.label}
              <input
                className="hidden"
                type="file"
                accept={moduleImport.accept}
                disabled={uploadingModule}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadBusinessModule(file);
                }}
              />
            </label>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void run("needs_information")}
          >
            等待用户补充
          </Button>
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => void run("completed")}
          >
            完成交付
          </Button>
        </>
      )}
    </div>
  );
}

function KnowledgeResetDecision({
  roleAssignmentId,
  requestId,
  onDone,
}: {
  roleAssignmentId: string;
  requestId: string;
  onDone: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const preview = trpc.delivery.mine.knowledgeResetPreview.useQuery(
    { roleAssignmentId, requestId },
    { enabled: open },
  );
  const decide = trpc.delivery.mine.decideKnowledgeReset.useMutation();
  const submit = async (decision: "approve" | "reject") => {
    if (!preview.data) return;
    if (decision === "approve" && !confirmed) {
      toast.warning("请先确认已核对清理范围");
      return;
    }
    if (decision === "reject" && !decisionNote.trim()) {
      toast.warning("驳回时必须填写原因");
      return;
    }
    try {
      await decide.mutateAsync({
        roleAssignmentId,
        requestId,
        expectedRevision: preview.data.expectedRevision,
        decision,
        decisionNote: decisionNote.trim() || undefined,
      });
      await onDone();
      setOpen(false);
      toast.success(
        decision === "approve"
          ? "知识库已完成重置"
          : "重置申请已驳回，知识库锁定已解除",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审批失败");
    }
  };
  const cleanup = preview.data?.cleanup;
  return (
    <>
      <Button
        className="mt-3"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" /> 审批知识库重置
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>知识库重置审批</DialogTitle>
            <DialogDescription>
              只有该客户当前负责的 AI 知识库工程师可以执行。批准后正文、
              历史快照和上传文件内容不会保留。
            </DialogDescription>
          </DialogHeader>
          {preview.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : preview.error ? (
            <p className="py-6 text-sm text-destructive">
              {preview.error.message}
            </p>
          ) : cleanup ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <CleanupCount label="构建记录" value={cleanup.builds} />
                <CleanupCount label="展示版本" value={cleanup.snapshots} />
                <CleanupCount label="专属对话" value={cleanup.conversations} />
                <CleanupCount label="附件" value={cleanup.attachments} />
                <CleanupCount
                  label="官网导入回执"
                  value={cleanup.importReceipts}
                />
              </div>
              <label className="grid gap-2 text-sm">
                审批说明（驳回时必填）
                <textarea
                  className="min-h-24 rounded-md border p-3"
                  value={decisionNote}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  maxLength={2_000}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对清理预览，确认本操作会永久删除该客户全部知识库内容。
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void submit("reject")}
              disabled={decide.isPending || !preview.data}
            >
              驳回并解除锁定
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submit("approve")}
              disabled={decide.isPending || !preview.data || !confirmed}
            >
              {decide.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              二次确认并清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CleanupCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-muted/25 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
