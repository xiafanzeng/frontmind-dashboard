import { useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Bot,
  BriefcaseBusiness,
  ClipboardList,
  Gauge,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  UserCog,
  Users,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell, {
  PortalCard,
  type PortalNavItem,
} from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  getRoleScopedPreviewAdminNav,
  previewAdminWorkspaceHref,
} from "@/lib/preview-navigation";
import { isSystemAdminAccount } from "@/lib/admin-access";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

type ApiKeyUsageAlert = {
  id: string;
  scope: "website_frontend" | "managed_user";
  userId?: number | null;
  enterpriseName?: string | null;
  credentialFingerprint?: string | null;
  used: number;
  accountUsed: number;
  limit: number;
  warningRatio: number;
  windowDays: number;
  fetchedAt?: number | string | Date | null;
  periodStartedAt?: number | string | Date | null;
  syncStatus: "ok" | "error" | "pending" | string;
};

type AdminUsageHierarchyManager = {
  adminId: number;
  displayName: string;
  username: string | null;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  keyPool: {
    fingerprint: string | null;
    credentialCount: number;
    totalUsed: number;
    limit: number;
    warningRatio: number;
    syncStatus: string;
    fetchedAt: number | string | Date | null;
    severity: string;
  };
  ownAgentMonthUsed: number;
  attributedUsed: number;
  otherOrUnattributedUsed: number;
  users: Array<{
    userId: number;
    enterpriseName: string;
    username: string | null;
    monthUsed: number;
    fingerprint: string | null;
    usesManagerKey: boolean;
    credentialSource: "manager" | "customer" | "unconfigured";
    syncStatus: string;
    fetchedAt: number | string | Date | null;
  }>;
};

type AdminUsageHierarchyEngineer = {
  engineerId: number;
  displayName: string;
  username: string | null;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  keyTotalUsed: number;
  ownAgentMonthUsed: number;
  otherOrUnattributedUsed: number;
  fingerprint: string | null;
  syncStatus: string;
  fetchedAt: number | string | Date | null;
};

type AdminUsageHierarchyCustomer = {
  userId: number;
  enterpriseName: string;
  username: string | null;
  deliveryAdminId: number | null;
  deliveryAdminName: string | null;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  usesInheritedKey: boolean;
  keyTotalUsed: number;
  ownAgentMonthUsed: number;
  otherOrUnattributedUsed: number;
  fingerprint: string | null;
  syncStatus: string;
  fetchedAt: number | string | Date | null;
};

export function normalizeApiKeyUsageAlerts(value: unknown): ApiKeyUsageAlert[] {
  const payload =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const source = Array.isArray(value)
    ? value
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  return source.map((entry): ApiKeyUsageAlert => {
    const item =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const used = Math.max(0, Number(item.used) || 0);
    const limit = Math.max(1, Number(item.limit) || 230_000);
    const warningRatio = Math.min(
      1,
      Math.max(0, Number(item.warningRatio) || 0.8),
    );
    const scope =
      item.scope === "website_frontend" ? "website_frontend" : "managed_user";
    const id = String(
      item.id ||
        (scope === "website_frontend"
          ? "website-frontend"
          : `managed-user-${item.userId || ""}`),
    );
    return {
      id,
      scope,
      userId:
        Number.isInteger(Number(item.userId)) && Number(item.userId) > 0
          ? Number(item.userId)
          : null,
      enterpriseName: item.enterpriseName ? String(item.enterpriseName) : null,
      credentialFingerprint: item.credentialFingerprint
        ? String(item.credentialFingerprint)
        : null,
      used,
      accountUsed: Math.max(
        0,
        Number(
          item.accountUsed ?? (scope === "website_frontend" ? item.used : 0),
        ) || 0,
      ),
      limit,
      warningRatio,
      windowDays: Math.max(1, Number(item.windowDays) || 30),
      fetchedAt:
        (item.fetchedAt as number | string | Date | null | undefined) ?? null,
      periodStartedAt:
        (item.periodStartedAt as number | string | Date | null | undefined) ??
        null,
      syncStatus: String(item.syncStatus || "pending"),
    };
  });
}

function apiKeyUsageTone(
  item: Pick<
    ApiKeyUsageAlert,
    "syncStatus" | "used" | "limit" | "warningRatio"
  >,
) {
  if (item.syncStatus !== "ok") return "unavailable";
  if (item.used >= item.limit) return "critical";
  if (item.used >= item.limit * item.warningRatio) return "warning";
  return "normal";
}

export const issueMonitorUrl =
  "https://business.molizhishu.com/business/dashboard?view=projects";
export const channelDistributionUrl = "https://i.kol.cn/";

type AssignedTicketManager = { id: string; name: string };

type DeliveryEngineerStatusSource = {
  engineers?: Array<{
    id: number;
    username?: string | null;
    displayName?: string | null;
    isActive?: boolean | number | null;
    engineerRoleType?: DeliveryRoleType | null;
    apiKeyConfigured?: boolean | null;
    apiKeyVersion?: number | null;
  }>;
  assignments?: Array<{
    customerUserId: number;
    engineerUserId?: number | null;
  }>;
  projects?: Array<{
    id: number;
    username?: string | null;
    displayName?: string | null;
  }>;
  tickets?: Array<{
    assignedMemberId?: number | null;
    status?: string | null;
  }>;
};

export type DeliveryEngineerStatusRow = {
  id: number;
  username: string;
  displayName: string;
  roleType: DeliveryRoleType | null;
  projectNames: string[];
  projectCount: number;
  activeTicketCount: number;
  workStatus:
    | "processing"
    | "waiting_customer"
    | "available"
    | "unassigned"
    | "disabled";
  workStatusLabel: string;
  isActive: boolean;
  apiKeyConfigured: boolean;
  apiKeyVersion: number;
  keyTotalUsed: number;
  ownAgentMonthUsed: number;
  otherOrUnattributedUsed: number;
  usageSyncStatus: string;
};

export function buildDeliveryEngineerStatusRows(
  source?: DeliveryEngineerStatusSource | null,
): DeliveryEngineerStatusRow[] {
  const projectsById = new Map(
    (source?.projects ?? []).map((project) => [
      project.id,
      String(
        project.displayName || project.username || `客户 ${project.id}`,
      ).trim(),
    ]),
  );
  const assignments = source?.assignments ?? [];
  const tickets = source?.tickets ?? [];
  const statusPriority: Record<
    DeliveryEngineerStatusRow["workStatus"],
    number
  > = {
    processing: 0,
    waiting_customer: 1,
    available: 2,
    unassigned: 3,
    disabled: 4,
  };

  return (source?.engineers ?? [])
    .map((engineer): DeliveryEngineerStatusRow => {
      const engineerAssignments = assignments.filter(
        (assignment) => assignment.engineerUserId === engineer.id,
      );
      const projectNames = Array.from(
        new Set(
          engineerAssignments.map(
            (assignment) =>
              projectsById.get(assignment.customerUserId) ||
              `客户 ${assignment.customerUserId}`,
          ),
        ),
      );
      const engineerTickets = tickets.filter(
        (ticket) => ticket.assignedMemberId === engineer.id,
      );
      const processingTicketCount = engineerTickets.filter((ticket) =>
        ["submitted", "scheduled", "in_progress"].includes(
          String(ticket.status || ""),
        ),
      ).length;
      const waitingTicketCount = engineerTickets.filter(
        (ticket) => ticket.status === "needs_information",
      ).length;
      const isActive = Boolean(engineer.isActive);
      let workStatus: DeliveryEngineerStatusRow["workStatus"];
      let workStatusLabel: string;

      if (!isActive) {
        workStatus = "disabled";
        workStatusLabel = "账号已停用";
      } else if (processingTicketCount > 0) {
        workStatus = "processing";
        workStatusLabel = `处理中 · ${processingTicketCount} 单`;
      } else if (waitingTicketCount > 0) {
        workStatus = "waiting_customer";
        workStatusLabel = `等待客户 · ${waitingTicketCount} 单`;
      } else if (projectNames.length === 0) {
        workStatus = "unassigned";
        workStatusLabel = "未分配项目";
      } else {
        workStatus = "available";
        workStatusLabel = "当前空闲";
      }

      return {
        id: engineer.id,
        username: String(engineer.username || `engineer-${engineer.id}`),
        displayName: String(
          engineer.displayName || engineer.username || `工程师 ${engineer.id}`,
        ),
        roleType: engineer.engineerRoleType ?? null,
        projectNames,
        projectCount: projectNames.length,
        activeTicketCount: engineerTickets.length,
        workStatus,
        workStatusLabel,
        isActive,
        apiKeyConfigured: Boolean(engineer.apiKeyConfigured),
        apiKeyVersion: Math.max(0, Number(engineer.apiKeyVersion) || 0),
        keyTotalUsed: 0,
        ownAgentMonthUsed: 0,
        otherOrUnattributedUsed: 0,
        usageSyncStatus: "unconfigured",
      };
    })
    .sort((left, right) => {
      const statusDifference =
        statusPriority[left.workStatus] - statusPriority[right.workStatus];
      if (statusDifference !== 0) return statusDifference;
      return left.displayName.localeCompare(right.displayName, "zh-CN");
    });
}

function assignedManagersForTicket(ticket: any): AssignedTicketManager[] {
  if (Array.isArray(ticket?.assignedAdmins) && ticket.assignedAdmins.length) {
    return ticket.assignedAdmins
      .map((manager: any) => ({
        id: String(manager?.id ?? manager?.adminId ?? ""),
        name:
          String(manager?.name ?? manager?.displayName ?? "").trim() ||
          `管理员 ${manager?.id ?? manager?.adminId ?? ""}`,
      }))
      .filter((manager: { id: string }) => manager.id);
  }
  const id = String(ticket?.assignedAdminId ?? ticket?.assignedAdminName ?? "");
  return id
    ? [
        {
          id,
          name: ticket?.assignedAdminName || `管理员 ${id}`,
        },
      ]
    : [];
}

export function filterPreviewTicketsForAdmin(
  tickets: any[],
  systemAdmin: boolean,
  managedAdminId?: string | null,
) {
  if (systemAdmin) return tickets;
  return tickets.filter((ticket) =>
    assignedManagersForTicket(ticket).some(
      (manager) => manager.id === managedAdminId,
    ),
  );
}

export const adminNav: PortalNavItem[] = [
  { label: "交付总览", href: "/", icon: Gauge, group: "运营" },
  {
    label: "客户交付工作台",
    href: "/admin/workspace",
    icon: UserCog,
    group: "客户与服务",
    activePrefixes: ["/admin/customers"],
  },
  {
    label: "客户项目团队",
    href: "/admin/delivery-roles",
    icon: UsersRound,
    group: "客户与服务",
  },
  {
    label: "工单调度",
    href: "/admin/dispatch",
    icon: ClipboardList,
    group: "客户与服务",
  },
  {
    label: "官网任务与积分",
    href: "/admin/presales",
    icon: BriefcaseBusiness,
    group: "客户与服务",
  },
  {
    label: "账号与权限",
    href: "/admin/users",
    icon: Users,
    group: "系统管理",
  },
  {
    label: "问题监控",
    href: issueMonitorUrl,
    icon: Activity,
    group: "外部系统",
    external: true,
    newWindow: true,
  },
  {
    label: "渠道分发",
    href: channelDistributionUrl,
    icon: Send,
    group: "外部系统",
    external: true,
    newWindow: true,
  },
];

export function getAdminNav(systemAdmin: boolean) {
  if (systemAdmin) return adminNav;
  return [
    { label: "交付总览", href: "/", icon: Gauge, group: "交付管理" },
    {
      label: "客户管理",
      href: "/admin/workspace",
      icon: UserCog,
      group: "交付管理",
      activePrefixes: ["/admin/customers"],
    },
    {
      label: "客户项目团队",
      href: "/admin/delivery-roles",
      icon: UsersRound,
      group: "交付管理",
    },
    {
      label: "工单调度",
      href: "/admin/dispatch",
      icon: ClipboardList,
      group: "交付管理",
    },
    {
      label: "FrontMind Agent",
      href: "/admin/agent",
      icon: Bot,
      group: "Agent 与资源",
    },
    {
      label: "账号与权限",
      href: "/admin/users",
      icon: Users,
      group: "交付管理",
    },
  ];
}

export function getPreviewAdminNav(systemAdmin: boolean) {
  return getRoleScopedPreviewAdminNav(
    systemAdmin ? "system_admin" : "delivery_admin",
  );
}

export function getPreviewAdminWorkspaceHref(systemAdmin: boolean, query = "") {
  const href = previewAdminWorkspaceHref(
    systemAdmin ? "system_admin" : "delivery_admin",
  );
  const normalizedQuery = query.replace(/^\?/, "").trim();
  return normalizedQuery ? `${href}?${normalizedQuery}` : href;
}

export function filterApiKeyUsageForAdmin(
  items: ApiKeyUsageAlert[],
  systemAdmin: boolean,
) {
  return systemAdmin
    ? items
    : items.filter((item) => item.scope === "managed_user");
}

export function filterPreviewApiKeyUsageForAdmin(
  items: ApiKeyUsageAlert[],
  systemAdmin: boolean,
  managedUserIds: readonly number[] = [],
) {
  const roleVisible = filterApiKeyUsageForAdmin(items, systemAdmin);
  if (systemAdmin) return roleVisible;
  const allowed = new Set(managedUserIds);
  return roleVisible.filter(
    (item) => item.userId != null && allowed.has(item.userId),
  );
}

export function groupSharedKeyUsage(items: ApiKeyUsageAlert[]) {
  const groups = new Map<
    string,
    {
      id: string;
      fingerprint: string | null;
      scope: ApiKeyUsageAlert["scope"];
      used: number;
      limit: number;
      warningRatio: number;
      fetchedAt: ApiKeyUsageAlert["fetchedAt"];
      syncStatus: ApiKeyUsageAlert["syncStatus"];
      accountCount: number;
    }
  >();
  for (const item of items) {
    const groupId =
      item.scope === "website_frontend"
        ? `website:${item.id}`
        : item.credentialFingerprint
          ? `managed:${item.credentialFingerprint}`
          : `unconfigured:${item.userId ?? item.id}`;
    const existing = groups.get(groupId);
    if (!existing) {
      groups.set(groupId, {
        id: groupId,
        fingerprint: item.credentialFingerprint ?? null,
        scope: item.scope,
        used: item.used,
        limit: item.limit,
        warningRatio: item.warningRatio,
        fetchedAt: item.fetchedAt,
        syncStatus: item.syncStatus,
        accountCount: item.scope === "managed_user" ? 1 : 0,
      });
      continue;
    }
    // A shared Key's upstream total is the same value on every account
    // snapshot. Keep one pool total instead of adding duplicate snapshots.
    existing.used = Math.max(existing.used, item.used);
    existing.accountCount += item.scope === "managed_user" ? 1 : 0;
    if (existing.syncStatus === "ok" && item.syncStatus !== "ok") {
      existing.syncStatus = item.syncStatus;
    }
  }
  return [...groups.values()];
}

export function normalizeUsageHierarchy(value: unknown): {
  period: { label: string };
  managers: AdminUsageHierarchyManager[];
  engineers: AdminUsageHierarchyEngineer[];
  customers: AdminUsageHierarchyCustomer[];
} {
  const payload =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const managers = Array.isArray(payload.managers)
    ? payload.managers.map((entry: any) => ({
        adminId: Math.max(0, Number(entry?.adminId) || 0),
        displayName:
          String(entry?.displayName || "").trim() || "未命名交付管理员",
        username: entry?.username ? String(entry.username) : null,
        apiKeyConfigured: entry?.apiKeyConfigured === true,
        apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
        keyPool: {
          fingerprint: entry?.keyPool?.fingerprint
            ? String(entry.keyPool.fingerprint)
            : null,
          credentialCount: Math.max(
            0,
            Number(entry?.keyPool?.credentialCount) ||
              (entry?.keyPool?.fingerprint ? 1 : 0),
          ),
          totalUsed: Math.max(0, Number(entry?.keyPool?.totalUsed) || 0),
          limit: Math.max(1, Number(entry?.keyPool?.limit) || 230_000),
          warningRatio: Math.min(
            1,
            Math.max(0, Number(entry?.keyPool?.warningRatio) || 0.8),
          ),
          syncStatus: String(entry?.keyPool?.syncStatus || "pending"),
          fetchedAt: entry?.keyPool?.fetchedAt ?? null,
          severity: String(entry?.keyPool?.severity || "unavailable"),
        },
        ownAgentMonthUsed: Math.max(0, Number(entry?.ownAgentMonthUsed) || 0),
        attributedUsed: Math.max(0, Number(entry?.attributedUsed) || 0),
        otherOrUnattributedUsed: Math.max(
          0,
          Number(entry?.otherOrUnattributedUsed) || 0,
        ),
        users: Array.isArray(entry?.users)
          ? entry.users.map((customer: any) => ({
              userId: Math.max(0, Number(customer?.userId) || 0),
              enterpriseName:
                String(customer?.enterpriseName || "").trim() || "未命名客户",
              username: customer?.username ? String(customer.username) : null,
              monthUsed: Math.max(0, Number(customer?.monthUsed) || 0),
              fingerprint: customer?.fingerprint
                ? String(customer.fingerprint)
                : null,
              usesManagerKey: customer?.usesManagerKey === true,
              credentialSource:
                customer?.credentialSource === "manager" ||
                customer?.credentialSource === "customer"
                  ? customer.credentialSource
                  : customer?.usesManagerKey === true
                    ? "manager"
                    : customer?.fingerprint
                      ? "customer"
                      : "unconfigured",
              syncStatus: String(customer?.syncStatus || "pending"),
              fetchedAt: customer?.fetchedAt ?? null,
            }))
          : [],
      }))
    : [];
  const engineers = Array.isArray(payload.engineers)
    ? payload.engineers.map(
        (entry: any): AdminUsageHierarchyEngineer => ({
          engineerId: Math.max(0, Number(entry?.engineerId) || 0),
          displayName:
            String(entry?.displayName || "").trim() || "未命名工程师",
          username: entry?.username ? String(entry.username) : null,
          apiKeyConfigured: entry?.apiKeyConfigured === true,
          apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
          keyTotalUsed: Math.max(0, Number(entry?.keyTotalUsed) || 0),
          ownAgentMonthUsed: Math.max(0, Number(entry?.ownAgentMonthUsed) || 0),
          otherOrUnattributedUsed: Math.max(
            0,
            Number(entry?.otherOrUnattributedUsed) || 0,
          ),
          fingerprint: entry?.fingerprint ? String(entry.fingerprint) : null,
          syncStatus: String(entry?.syncStatus || "unconfigured"),
          fetchedAt: entry?.fetchedAt ?? null,
        }),
      )
    : [];
  const customers = Array.isArray(payload.customers)
    ? payload.customers.map(
        (entry: any): AdminUsageHierarchyCustomer => ({
          userId: Math.max(0, Number(entry?.userId) || 0),
          enterpriseName:
            String(entry?.enterpriseName || "").trim() || "未命名客户",
          username: entry?.username ? String(entry.username) : null,
          deliveryAdminId:
            Number.isInteger(Number(entry?.deliveryAdminId)) &&
            Number(entry.deliveryAdminId) > 0
              ? Number(entry.deliveryAdminId)
              : null,
          deliveryAdminName: entry?.deliveryAdminName
            ? String(entry.deliveryAdminName)
            : null,
          apiKeyConfigured: entry?.apiKeyConfigured === true,
          apiKeyVersion: Math.max(0, Number(entry?.apiKeyVersion) || 0),
          usesInheritedKey: entry?.usesInheritedKey === true,
          keyTotalUsed: Math.max(0, Number(entry?.keyTotalUsed) || 0),
          ownAgentMonthUsed: Math.max(0, Number(entry?.ownAgentMonthUsed) || 0),
          otherOrUnattributedUsed: Math.max(
            0,
            Number(entry?.otherOrUnattributedUsed) || 0,
          ),
          fingerprint: entry?.fingerprint ? String(entry.fingerprint) : null,
          syncStatus: String(entry?.syncStatus || "unconfigured"),
          fetchedAt: entry?.fetchedAt ?? null,
        }),
      )
    : [];
  return {
    period: {
      label: String(payload?.period?.label || "本月"),
    },
    managers,
    engineers,
    customers,
  };
}

type OverviewApiKeyTarget = {
  kind: "customer" | "delivery_admin" | "engineer";
  userId: number;
  displayName: string;
  username: string;
  configured: boolean;
  version: number;
};

type KeyManagementRow = OverviewApiKeyTarget & {
  typeLabel: string;
  scopeLabel: string;
  inherited: boolean;
  ownAgentMonthUsed: number;
  keyTotalUsed: number;
  otherOrUnattributedUsed: number;
};

function AdminOverviewApiKeyDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: OverviewApiKeyTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const setEngineerMutation =
    trpc.delivery.management.setEngineerApiKey.useMutation();
  const revokeEngineerMutation =
    trpc.delivery.management.revokeEngineerApiKey.useMutation();
  const setAdminMutation =
    trpc.delivery.management.setDeliveryAdminApiKey.useMutation();
  const revokeAdminMutation =
    trpc.delivery.management.revokeDeliveryAdminApiKey.useMutation();
  const setCustomerMutation =
    trpc.admin.workspace.replaceCredential.useMutation();
  const revokeCustomerMutation =
    trpc.admin.workspace.deleteCredential.useMutation();
  const busy =
    setEngineerMutation.isPending ||
    revokeEngineerMutation.isPending ||
    setAdminMutation.isPending ||
    revokeAdminMutation.isPending ||
    setCustomerMutation.isPending ||
    revokeCustomerMutation.isPending;
  const subjectLabel =
    target?.kind === "delivery_admin"
      ? "交付管理员"
      : target?.kind === "customer"
        ? "客户"
        : "工程师";

  const close = () => {
    if (busy) return;
    setApiKey("");
    setRevokeOpen(false);
    setEngineerMutation.reset();
    revokeEngineerMutation.reset();
    setAdminMutation.reset();
    revokeAdminMutation.reset();
    setCustomerMutation.reset();
    revokeCustomerMutation.reset();
    onOpenChange(false);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || apiKey.trim().length < 8) return;
    try {
      if (target.kind === "customer") {
        await setCustomerMutation.mutateAsync({
          userId: target.userId,
          apiKey: apiKey.trim(),
          reason: "交付总览统一配置客户 Key",
        });
      } else if (target.kind === "engineer") {
        await setEngineerMutation.mutateAsync({
          engineerUserId: target.userId,
          apiKey: apiKey.trim(),
          expectedVersion: target.version,
        });
      } else {
        await setAdminMutation.mutateAsync({
          adminUserId: target.userId,
          apiKey: apiKey.trim(),
          expectedVersion: target.version,
        });
      }
      await onSaved();
      toast.success(
        `${subjectLabel} API Key 已${target.configured ? "替换" : "配置"}`,
        { description: target.displayName },
      );
      setApiKey("");
      setRevokeOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(`无法配置${subjectLabel} API Key`, {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const revoke = async () => {
    if (!target) return;
    try {
      if (target.kind === "customer") {
        await revokeCustomerMutation.mutateAsync({
          userId: target.userId,
          reason: "交付总览统一撤销客户 Key",
        });
      } else if (target.kind === "engineer") {
        await revokeEngineerMutation.mutateAsync({
          engineerUserId: target.userId,
          expectedVersion: target.version,
        });
      } else {
        await revokeAdminMutation.mutateAsync({
          adminUserId: target.userId,
          expectedVersion: target.version,
        });
      }
      await onSaved();
      toast.success(`${subjectLabel} API Key 已撤销`, {
        description: target.displayName,
      });
      setApiKey("");
      setRevokeOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(`无法撤销${subjectLabel} API Key`, {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <>
      <Dialog open={Boolean(target)} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              配置{subjectLabel} API Key
            </DialogTitle>
            <DialogDescription>
              {target?.displayName} · @{target?.username}。Key
              仅在服务端加密保存，不会在页面返回明文。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={save}>
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
              当前状态：
              <span
                className={
                  target?.configured
                    ? "font-medium text-emerald-700"
                    : "font-medium text-amber-700"
                }
              >
                {target?.configured ? "已配置" : "未配置"}
              </span>
            </div>
            <div className="space-y-2">
              <Label htmlFor="overview-api-key">
                {target?.configured ? "新的 API Key" : "API Key"}
              </Label>
              <Input
                id="overview-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入后将先验证，再加密保存"
                disabled={busy}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                系统管理员统一维护账号 Key，交付管理员只负责岗位与项目安排。
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy || !target?.configured}
                onClick={() => setRevokeOpen(true)}
              >
                撤销 Key
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={busy || apiKey.trim().length < 8}
                >
                  {(setEngineerMutation.isPending ||
                    setAdminMutation.isPending ||
                    setCustomerMutation.isPending) && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  验证并{target?.configured ? "替换" : "配置"}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeOpen}
        onOpenChange={(open) => !busy && setRevokeOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销{subjectLabel} API Key</AlertDialogTitle>
            <AlertDialogDescription>
              撤销后，{target?.displayName}
              将无法调用通用智能体，直至系统管理员重新配置有效 Key。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void revoke();
              }}
            >
              {(revokeEngineerMutation.isPending ||
                revokeAdminMutation.isPending ||
                revokeCustomerMutation.isPending) && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function AdminDashboard({
  preview = false,
  previewAccessLevel = "system_admin",
  previewFixtures,
}: {
  preview?: boolean;
  previewAccessLevel?: "delivery_admin" | "system_admin";
  previewFixtures?: {
    managedAdminId: string;
    managedUserIds: number[];
    ticketOverview: {
      counts: Record<string, number>;
      tickets: unknown[];
    };
    usageAlerts: unknown[];
  };
}) {
  const previewMode = import.meta.env.DEV && preview;
  const { user } = useAuth();
  const systemAdmin = previewMode
    ? previewAccessLevel === "system_admin"
    : isSystemAdminAccount(user);
  const workspaceQuery = trpc.admin.workspace.list.useQuery(undefined, {
    enabled: !previewMode && user?.role === "admin",
    retry: false,
  });
  const usageHierarchyQuery = (
    trpc.admin as any
  ).apiKeyUsageAlerts.hierarchy.useQuery(undefined, {
    enabled: !previewMode && user?.role === "admin" && systemAdmin,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const usageSyncMutation = (
    trpc.admin as any
  ).apiKeyUsageAlerts.sync.useMutation({
    onSuccess: () => usageHierarchyQuery.refetch(),
  });
  const deliveryRoleOverviewQuery = trpc.delivery.management.overview.useQuery(
    undefined,
    {
      enabled: !previewMode && user?.role === "admin",
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const [apiKeyTarget, setApiKeyTarget] = useState<OverviewApiKeyTarget | null>(
    null,
  );
  const [keyAccountType, setKeyAccountType] = useState<
    "all" | OverviewApiKeyTarget["kind"]
  >("all");
  const [keyAccountSearch, setKeyAccountSearch] = useState("");
  const navItems = previewMode
    ? getPreviewAdminNav(systemAdmin)
    : getAdminNav(systemAdmin);
  const previewUsageHierarchy = useMemo(() => {
    const items = filterPreviewApiKeyUsageForAdmin(
      normalizeApiKeyUsageAlerts(previewFixtures?.usageAlerts ?? []),
      false,
      previewFixtures?.managedUserIds,
    );
    const pool = groupSharedKeyUsage(items)[0];
    const ownAgentMonthUsed = 12_600;
    const users = items.map((item) => ({
      userId: item.userId || 0,
      enterpriseName: item.enterpriseName || `客户 ${item.userId || ""}`,
      username: null,
      monthUsed: item.accountUsed,
      fingerprint: item.credentialFingerprint || null,
      usesManagerKey:
        Boolean(pool?.fingerprint) &&
        item.credentialFingerprint === pool?.fingerprint,
      credentialSource:
        Boolean(pool?.fingerprint) &&
        item.credentialFingerprint === pool?.fingerprint
          ? ("manager" as const)
          : item.credentialFingerprint
            ? ("customer" as const)
            : ("unconfigured" as const),
      syncStatus: item.syncStatus,
      fetchedAt: item.fetchedAt ?? null,
    }));
    const attributedUsed =
      ownAgentMonthUsed +
      users.reduce((sum, customer) => sum + customer.monthUsed, 0);
    return {
      period: { label: "2026 年 7 月" },
      engineers: [],
      customers: [],
      managers: [
        {
          adminId: Number(previewFixtures?.managedAdminId || 101),
          displayName: "交付管理员",
          username: "delivery.admin",
          apiKeyConfigured: true,
          apiKeyVersion: 1,
          keyPool: {
            fingerprint: pool?.fingerprint || "9f17b2d4a631c809",
            credentialCount: pool?.fingerprint ? 1 : 0,
            totalUsed: pool?.used || 84_200,
            limit: pool?.limit || 230_000,
            warningRatio: pool?.warningRatio || 0.8,
            syncStatus: pool?.syncStatus || "ok",
            fetchedAt: pool?.fetchedAt || "2026-07-28T08:00:00+08:00",
            severity: "normal",
          },
          ownAgentMonthUsed,
          attributedUsed,
          otherOrUnattributedUsed: Math.max(
            0,
            (pool?.used || 84_200) - attributedUsed,
          ),
          users,
        },
      ],
    };
  }, [previewFixtures, previewMode]);
  const usageHierarchy = previewMode
    ? previewUsageHierarchy
    : normalizeUsageHierarchy(usageHierarchyQuery.data);
  const usageManagers = usageHierarchy.managers;
  const engineerUsageById = new Map(
    usageHierarchy.engineers.map((engineer) => [engineer.engineerId, engineer]),
  );
  const deliveryEngineerStatusRows = buildDeliveryEngineerStatusRows(
    deliveryRoleOverviewQuery.data,
  ).map((engineer) => {
    const usage = engineerUsageById.get(engineer.id);
    return {
      ...engineer,
      apiKeyConfigured: usage?.apiKeyConfigured ?? engineer.apiKeyConfigured,
      apiKeyVersion: usage?.apiKeyVersion ?? engineer.apiKeyVersion,
      keyTotalUsed: usage?.keyTotalUsed ?? 0,
      ownAgentMonthUsed: usage?.ownAgentMonthUsed ?? 0,
      otherOrUnattributedUsed: usage?.otherOrUnattributedUsed ?? 0,
      usageSyncStatus: usage?.syncStatus ?? "unconfigured",
    };
  });
  const keyManagementRows: KeyManagementRow[] = [
    ...usageManagers.map(
      (manager): KeyManagementRow => ({
        kind: "delivery_admin",
        userId: manager.adminId,
        displayName: manager.displayName,
        username: manager.username || `admin-${manager.adminId}`,
        configured: manager.apiKeyConfigured,
        version: manager.apiKeyVersion,
        typeLabel: "交付管理员",
        scopeLabel: `负责 ${manager.users.length} 个客户`,
        inherited: false,
        ownAgentMonthUsed: manager.ownAgentMonthUsed,
        keyTotalUsed: manager.keyPool.totalUsed,
        otherOrUnattributedUsed: Math.max(
          0,
          manager.keyPool.totalUsed - manager.ownAgentMonthUsed,
        ),
      }),
    ),
    ...deliveryEngineerStatusRows.map(
      (engineer): KeyManagementRow => ({
        kind: "engineer",
        userId: engineer.id,
        displayName: engineer.displayName,
        username: engineer.username,
        configured: engineer.apiKeyConfigured,
        version: engineer.apiKeyVersion,
        typeLabel: "工程师",
        scopeLabel: engineer.roleType
          ? `${DELIVERY_ROLE_LABELS[engineer.roleType]} · ${engineer.projectCount} 个项目`
          : `岗位未设置 · ${engineer.projectCount} 个项目`,
        inherited: false,
        ownAgentMonthUsed: engineer.ownAgentMonthUsed,
        keyTotalUsed: engineer.keyTotalUsed,
        otherOrUnattributedUsed: engineer.otherOrUnattributedUsed,
      }),
    ),
    ...usageHierarchy.customers.map(
      (customer): KeyManagementRow => ({
        kind: "customer",
        userId: customer.userId,
        displayName: customer.enterpriseName,
        username: customer.username || `customer-${customer.userId}`,
        configured: customer.apiKeyConfigured,
        version: customer.apiKeyVersion,
        typeLabel: "客户",
        scopeLabel: customer.deliveryAdminName
          ? `负责人：${customer.deliveryAdminName}`
          : "负责人待分配",
        inherited: customer.usesInheritedKey,
        ownAgentMonthUsed: customer.ownAgentMonthUsed,
        keyTotalUsed: customer.keyTotalUsed,
        otherOrUnattributedUsed: customer.otherOrUnattributedUsed,
      }),
    ),
  ].sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? 1 : -1;
    return left.displayName.localeCompare(right.displayName, "zh-CN");
  });
  const normalizedKeySearch = keyAccountSearch.trim().toLocaleLowerCase();
  const visibleKeyManagementRows = keyManagementRows.filter((row) => {
    if (keyAccountType !== "all" && row.kind !== keyAccountType) return false;
    if (!normalizedKeySearch) return true;
    return `${row.displayName} ${row.username} ${row.scopeLabel}`
      .toLocaleLowerCase()
      .includes(normalizedKeySearch);
  });
  const missingKeyCount = keyManagementRows.filter(
    (row) => !row.configured,
  ).length;

  return (
    <PortalShell
      eyebrow="FrontMind 管理中心"
      title="交付总览"
      navItems={navItems}
      accountLabel={
        previewMode
          ? `${systemAdmin ? "系统管理员" : "交付管理员"}验收账号`
          : undefined
      }
      roleLabel={
        previewMode
          ? `${systemAdmin ? "系统管理员" : "交付管理员"} · 验收预览`
          : undefined
      }
    >
      <div className="space-y-5">
        {systemAdmin && !previewMode && (
          <PortalCard className="overflow-hidden">
            <div className="flex flex-col gap-4 border-b border-[#eee8f2] px-5 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="h-5 w-5 text-[#5b2a86]" />
                  <h2 className="font-semibold text-[#171321]">
                    统一 API Key 管理
                  </h2>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      missingKeyCount > 0
                        ? "bg-[#fff1f4] text-[#a02652]"
                        : "bg-[#eaf7f0] text-[#16794f]"
                    }`}
                  >
                    {missingKeyCount > 0
                      ? `${missingKeyCount} 个待配置`
                      : "全部已配置"}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-6 text-[#716a80]">
                  客户、交付管理员和工程师使用同一套管理入口；交付管理员端不展示
                  Key 配置能力。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  usageHierarchyQuery.isFetching || usageSyncMutation.isPending
                }
                onClick={() => usageSyncMutation.mutate()}
              >
                <RefreshCw
                  className={`h-4 w-4 ${
                    usageHierarchyQuery.isFetching ||
                    usageSyncMutation.isPending
                      ? "animate-spin"
                      : ""
                  }`}
                />
                {usageHierarchyQuery.isFetching || usageSyncMutation.isPending
                  ? "同步中"
                  : "刷新用量"}
              </Button>
            </div>

            <div className="flex flex-col gap-3 border-b border-[#eee8f2] bg-[#fbf9fd] px-5 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {[
                  ["all", "全部"],
                  ["customer", "客户"],
                  ["delivery_admin", "交付管理员"],
                  ["engineer", "工程师"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() =>
                      setKeyAccountType(
                        value as "all" | OverviewApiKeyTarget["kind"],
                      )
                    }
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      keyAccountType === value
                        ? "border-[#6f3a98] bg-[#6f3a98] text-white"
                        : "border-[#ddd4e5] bg-white text-[#5f576c] hover:border-[#a98cbd]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Input
                value={keyAccountSearch}
                onChange={(event) => setKeyAccountSearch(event.target.value)}
                placeholder="搜索账号、名称或负责人"
                aria-label="搜索 Key 管理账号"
                className="h-9 bg-white lg:w-72"
              />
            </div>

            {usageHierarchyQuery.isLoading ||
            deliveryRoleOverviewQuery.isLoading ? (
              <div className="p-6 text-sm text-[#716a80]">
                正在读取账号 Key 与积分…
              </div>
            ) : usageHierarchyQuery.error || deliveryRoleOverviewQuery.error ? (
              <div className="p-6 text-sm text-[#a02652]">
                Key 管理数据暂时无法读取。
              </div>
            ) : visibleKeyManagementRows.length === 0 ? (
              <div className="p-6 text-sm text-[#716a80]">
                没有符合当前筛选条件的账号。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[1050px]">
                  <div className="grid grid-cols-[minmax(200px,1.2fr)_110px_minmax(210px,1.2fr)_170px_130px_130px_140px] gap-4 border-b border-[#eee8f2] px-5 py-3 text-xs font-medium text-[#716a80] sm:px-6">
                    <span>账号</span>
                    <span>类型</span>
                    <span>归属范围</span>
                    <span>Key 状态</span>
                    <span>本月自用</span>
                    <span>Key 总额</span>
                    <span>操作</span>
                  </div>
                  {visibleKeyManagementRows.map((row) => (
                    <div
                      key={`${row.kind}-${row.userId}`}
                      className="grid grid-cols-[minmax(200px,1.2fr)_110px_minmax(210px,1.2fr)_170px_130px_130px_140px] items-center gap-4 border-b border-[#eee8f2] px-5 py-4 last:border-b-0 sm:px-6"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#332842]">
                          {row.displayName}
                        </p>
                        <p className="mt-1 truncate text-xs text-[#857e91]">
                          @{row.username}
                        </p>
                      </div>
                      <span className="w-fit rounded-full bg-[#f3edf7] px-2.5 py-1 text-xs font-medium text-[#6a338f]">
                        {row.typeLabel}
                      </span>
                      <p className="truncate text-sm text-[#5f576c]">
                        {row.scopeLabel}
                      </p>
                      <div className="text-xs">
                        <p
                          className={
                            row.configured
                              ? "font-medium text-[#16794f]"
                              : "font-medium text-[#a02652]"
                          }
                        >
                          {row.configured
                            ? "独立 Key 已配置"
                            : row.inherited
                              ? "使用历史共享 Key"
                              : "Key 待配置"}
                        </p>
                        {row.inherited && (
                          <p className="mt-1 text-[#946800]">
                            建议配置独立 Key
                          </p>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-[#5b2a86]">
                        {row.ownAgentMonthUsed.toLocaleString()}
                      </p>
                      <div>
                        <p className="text-sm font-semibold text-[#332842]">
                          {row.keyTotalUsed.toLocaleString()}
                        </p>
                        {row.keyTotalUsed > row.ownAgentMonthUsed && (
                          <p className="mt-1 text-xs text-[#857e91]">
                            其他 {row.otherOrUnattributedUsed.toLocaleString()}
                          </p>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={row.configured ? "outline" : "default"}
                        onClick={() =>
                          setApiKeyTarget({
                            kind: row.kind,
                            userId: row.userId,
                            displayName: row.displayName,
                            username: row.username,
                            configured: row.configured,
                            version: row.version,
                          })
                        }
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        {row.configured ? "更换 Key" : "配置 Key"}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </PortalCard>
        )}
        {!previewMode && (
          <PortalCard className="overflow-hidden">
            <div className="border-b border-[#eee8f2] px-5 py-4 sm:px-6">
              <h2 className="font-semibold text-[#171321]">工程师状态</h2>
              <p className="mt-1 text-sm text-[#716a80]">
                {systemAdmin
                  ? "按人员查看岗位、项目、本月自用与 Key 总额；工程师 Key 由系统管理员统一配置。"
                  : "按人员查看专业岗位、负责项目和当前工作状态；项目岗位缺员请前往客户项目团队处理。"}
              </p>
            </div>
            {deliveryRoleOverviewQuery.isLoading ? (
              <div className="p-6 text-sm text-[#716a80]">
                正在读取工程师状态…
              </div>
            ) : deliveryRoleOverviewQuery.error ? (
              <div className="p-6 text-sm text-[#a02652]">
                工程师状态暂时无法读取。
              </div>
            ) : deliveryEngineerStatusRows.length === 0 ? (
              <div className="p-6 text-sm text-[#716a80]">
                当前权限范围内暂无工程师账号。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div
                  className={systemAdmin ? "min-w-[1040px]" : "min-w-[720px]"}
                >
                  <div
                    className={`grid gap-4 border-b border-[#eee8f2] bg-[#fbf9fd] px-5 py-3 text-xs font-medium text-[#716a80] sm:px-6 ${
                      systemAdmin
                        ? "grid-cols-[minmax(160px,1.1fr)_minmax(160px,1fr)_minmax(180px,1.2fr)_140px_170px_180px]"
                        : "grid-cols-[minmax(180px,1.2fr)_minmax(170px,1.1fr)_minmax(220px,1.4fr)_150px]"
                    }`}
                  >
                    <span>工程师</span>
                    <span>专业岗位</span>
                    <span>负责项目</span>
                    <span>当前状态</span>
                    {systemAdmin && (
                      <>
                        <span>本月积分</span>
                        <span>账号与 Key 状态</span>
                      </>
                    )}
                  </div>
                  {deliveryEngineerStatusRows.map((engineer) => {
                    const statusTone =
                      engineer.workStatus === "processing"
                        ? "bg-[#f1e8f8] text-[#6a338f]"
                        : engineer.workStatus === "waiting_customer"
                          ? "bg-[#fff7e7] text-[#946800]"
                          : engineer.workStatus === "available"
                            ? "bg-[#eaf7f0] text-[#16794f]"
                            : engineer.workStatus === "disabled"
                              ? "bg-[#f2eff4] text-[#716a80]"
                              : "bg-[#fff1f4] text-[#a02652]";
                    return (
                      <div
                        key={engineer.id}
                        className={`grid items-center gap-4 border-b border-[#eee8f2] px-5 py-4 last:border-b-0 sm:px-6 ${
                          systemAdmin
                            ? "grid-cols-[minmax(160px,1.1fr)_minmax(160px,1fr)_minmax(180px,1.2fr)_140px_170px_180px]"
                            : "grid-cols-[minmax(180px,1.2fr)_minmax(170px,1.1fr)_minmax(220px,1.4fr)_150px]"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#332842]">
                            {engineer.displayName}
                          </p>
                          <p className="mt-1 truncate text-xs text-[#857e91]">
                            {engineer.username}
                          </p>
                        </div>
                        <p className="text-sm text-[#484057]">
                          {engineer.roleType
                            ? DELIVERY_ROLE_LABELS[engineer.roleType]
                            : "岗位未设置"}
                        </p>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-[#484057]">
                            {engineer.projectNames.length > 0
                              ? engineer.projectNames.join("、")
                              : "尚未负责客户项目"}
                          </p>
                          {engineer.projectCount > 1 && (
                            <p className="mt-1 text-xs text-[#857e91]">
                              共 {engineer.projectCount} 个项目
                            </p>
                          )}
                        </div>
                        <div>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone}`}
                          >
                            {engineer.workStatusLabel}
                          </span>
                        </div>
                        {systemAdmin && (
                          <>
                            <div className="space-y-1 text-xs text-[#716a80]">
                              <p>
                                自用{" "}
                                <span className="font-semibold text-[#5b2a86]">
                                  {engineer.ownAgentMonthUsed.toLocaleString()}
                                </span>
                              </p>
                              <p>
                                Key 总额{" "}
                                <span className="font-semibold text-[#332842]">
                                  {engineer.keyTotalUsed.toLocaleString()}
                                </span>
                              </p>
                            </div>
                            <div className="space-y-1 text-xs">
                              <p
                                className={
                                  engineer.isActive
                                    ? "text-[#16794f]"
                                    : "text-[#857e91]"
                                }
                              >
                                {engineer.isActive ? "账号启用" : "账号停用"}
                              </p>
                              <p
                                className={
                                  engineer.apiKeyConfigured
                                    ? "text-[#16794f]"
                                    : "text-[#a02652]"
                                }
                              >
                                {engineer.apiKeyConfigured
                                  ? "Key 已配置"
                                  : "Key 未配置"}
                              </p>
                              <p className="pt-1 text-[#857e91]">
                                在上方统一 Key 管理区操作
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </PortalCard>
        )}
      </div>
      {!previewMode && (
        <AdminOverviewApiKeyDialog
          target={apiKeyTarget}
          onOpenChange={(open) => !open && setApiKeyTarget(null)}
          onSaved={async () => {
            await Promise.all([
              deliveryRoleOverviewQuery.refetch(),
              usageHierarchyQuery.refetch(),
              workspaceQuery.refetch(),
            ]);
          }}
        />
      )}
    </PortalShell>
  );
}
