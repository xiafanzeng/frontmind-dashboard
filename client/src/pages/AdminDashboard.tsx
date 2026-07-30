import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  ClipboardList,
  Gauge,
  RefreshCw,
  Search,
  Send,
  UserCog,
  Users,
  UsersRound,
} from "lucide-react";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell, {
  PortalCard,
  type PortalNavItem,
} from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import {
  getRoleScopedPreviewAdminNav,
  previewAdminWorkspaceHref,
} from "@/lib/preview-navigation";
import { isSystemAdminAccount } from "@/lib/admin-access";
import {
  buildAdminTicketListInput,
  deliveryTicketPublicStatus,
  flattenAdminTicketPages,
  formatAdminTicketDate,
  normalizeAdminTicketList,
} from "@/components/AdminDeliveryTicketWorkspace";
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
    label: "FrontMind Agent",
    href: "/admin/agent",
    icon: Bot,
    group: "Agent 与资源",
  },
  {
    label: "官网任务与积分",
    href: "/admin/presales",
    icon: BriefcaseBusiness,
    group: "Agent 与资源",
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

export function canCreateCustomerFromDashboard(_systemAdmin: boolean) {
  return true;
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
} {
  const payload =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const managers = Array.isArray(payload.managers)
    ? payload.managers.map((entry: any) => ({
        adminId: Math.max(0, Number(entry?.adminId) || 0),
        displayName:
          String(entry?.displayName || "").trim() || "未命名交付管理员",
        username: entry?.username ? String(entry.username) : null,
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
  return {
    period: {
      label: String(payload?.period?.label || "本月"),
    },
    managers,
  };
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
  const [, setLocation] = useLocation();
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
    enabled: !previewMode && user?.role === "admin",
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
  const [ticketKeyword, setTicketKeyword] = useState("");
  const [ticketType, setTicketType] = useState("all");
  const [ticketStatus, setTicketStatus] = useState("all");
  const [ticketManager, setTicketManager] = useState("all");
  const [selectedUsageManagerId, setSelectedUsageManagerId] = useState<
    number | null
  >(null);
  const [debouncedTicketKeyword, setDebouncedTicketKeyword] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedTicketKeyword(ticketKeyword.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [ticketKeyword]);

  const ticketListInput = useMemo(
    () =>
      buildAdminTicketListInput({
        assignedAdminId: ticketManager,
        query: debouncedTicketKeyword,
        type: ticketType,
        publicStatus: ticketStatus,
        limit: 100,
        order: "created_asc",
      }),
    [debouncedTicketKeyword, ticketManager, ticketStatus, ticketType],
  );
  const ticketListQuery = (
    trpc.admin as any
  ).deliveryTickets.list.useInfiniteQuery(ticketListInput, {
    enabled: !previewMode && user?.role === "admin",
    retry: false,
    getNextPageParam: (lastPage: any) => lastPage?.nextCursor || undefined,
  });
  const navItems = previewMode
    ? getPreviewAdminNav(systemAdmin)
    : getAdminNav(systemAdmin);
  const previewTicketOverview = previewFixtures?.ticketOverview ?? {
    counts: {},
    tickets: [],
  };
  const ticketListPages = (ticketListQuery.data?.pages || []) as unknown[];
  const previewPermissionTickets = useMemo(
    () =>
      filterPreviewTicketsForAdmin(
        normalizeAdminTicketList(previewTicketOverview),
        systemAdmin,
        previewFixtures?.managedAdminId,
      ),
    [previewTicketOverview, previewFixtures?.managedAdminId, systemAdmin],
  );
  const ticketQueue = useMemo(() => {
    const tickets = previewMode
      ? previewPermissionTickets
      : flattenAdminTicketPages(ticketListPages);
    if (!previewMode) return tickets;
    const query = ticketKeyword.trim().toLocaleLowerCase("zh-CN");
    return tickets.filter((ticket) => {
      if (ticketType !== "all" && ticket.type !== ticketType) return false;
      if (
        ticketManager !== "all" &&
        !assignedManagersForTicket(ticket).some(
          (manager: AssignedTicketManager) => manager.id === ticketManager,
        )
      ) {
        return false;
      }
      if (
        ticketStatus !== "all" &&
        deliveryTicketPublicStatus(ticket) !== ticketStatus
      ) {
        return false;
      }
      if (!query) return true;
      return [
        ticket.enterpriseName,
        ticket.title,
        ticket.topic,
        ticket.category,
      ].some((value) =>
        String(value || "")
          .toLocaleLowerCase("zh-CN")
          .includes(query),
      );
    });
  }, [
    previewMode,
    previewPermissionTickets,
    ticketKeyword,
    ticketListPages,
    ticketManager,
    ticketStatus,
    ticketType,
  ]);
  const ticketManagers = useMemo(() => {
    if (!previewMode) {
      return (workspaceQuery.data?.admins ?? []).map(
        (manager) =>
          [
            String(manager.id),
            manager.displayName || manager.username || `管理员 ${manager.id}`,
          ] as const,
      );
    }
    const unique = new Map<string, string>();
    normalizeAdminTicketList(previewTicketOverview).forEach((ticket) => {
      assignedManagersForTicket(ticket).forEach(
        (manager: AssignedTicketManager) => {
          unique.set(manager.id, manager.name);
        },
      );
    });
    return [...unique.entries()];
  }, [previewMode, workspaceQuery.data?.admins]);
  const ticketCounts = previewMode
    ? previewPermissionTickets.reduce(
        (counts, ticket) => {
          counts[deliveryTicketPublicStatus(ticket)] += 1;
          return counts;
        },
        { pending: 0, completed: 0 },
      )
    : (ticketListQuery.data?.pages?.[0] as any)?.counts || {};
  const ticketListUnavailable =
    !previewMode &&
    (ticketListQuery.isLoading || Boolean(ticketListQuery.error));
  const sortedTicketQueue = useMemo(
    () =>
      [...ticketQueue].sort((left, right) => {
        const leftTime = new Date(
          left.createdAt || left.updatedAt || 0,
        ).getTime();
        const rightTime = new Date(
          right.createdAt || right.updatedAt || 0,
        ).getTime();
        return leftTime - rightTime;
      }),
    [ticketQueue],
  );
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
      managers: [
        {
          adminId: Number(previewFixtures?.managedAdminId || 101),
          displayName: "交付管理员",
          username: "delivery.admin",
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
  const selectedUsageManager =
    usageManagers.find(
      (manager) => manager.adminId === selectedUsageManagerId,
    ) ||
    usageManagers[0] ||
    null;
  const deliveryEngineerStatusRows = buildDeliveryEngineerStatusRows(
    deliveryRoleOverviewQuery.data,
  );

  useEffect(() => {
    if (selectedUsageManagerId == null && usageManagers[0]?.adminId != null) {
      setSelectedUsageManagerId(usageManagers[0].adminId);
    }
  }, [selectedUsageManagerId, usageManagers]);

  return (
    <PortalShell
      eyebrow="FrontMind 管理中心"
      title="交付总览"
      navItems={navItems}
      toolbar={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-[#d8cde0] bg-white/85 text-[#4f2b6d]"
            onClick={() =>
              setLocation(
                previewMode
                  ? getPreviewAdminWorkspaceHref(systemAdmin)
                  : "/admin/workspace",
              )
            }
          >
            <BriefcaseBusiness className="h-4 w-4" />
            <span className="hidden sm:inline">打开客户交付工作台</span>
            <span className="sm:hidden">客户工作台</span>
          </Button>
          {canCreateCustomerFromDashboard(systemAdmin) && (
            <Button
              size="sm"
              onClick={() =>
                setLocation(
                  previewMode
                    ? getPreviewAdminWorkspaceHref(systemAdmin, "action=create")
                    : "/admin/workspace?action=create",
                )
              }
            >
              <UserCog className="h-4 w-4" />
              创建客户
            </Button>
          )}
        </div>
      }
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
        {!previewMode && (
          <PortalCard className="overflow-hidden">
            <div className="border-b border-[#eee8f2] px-5 py-4 sm:px-6">
              <h2 className="font-semibold text-[#171321]">工程师状态</h2>
              <p className="mt-1 text-sm text-[#716a80]">
                按人员查看专业岗位、负责项目和当前工作状态；项目岗位缺员请前往客户项目团队处理。
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
                <div className="min-w-[760px]">
                  <div className="grid grid-cols-[minmax(180px,1.2fr)_minmax(170px,1.1fr)_minmax(190px,1.3fr)_150px_140px] gap-4 border-b border-[#eee8f2] bg-[#fbf9fd] px-5 py-3 text-xs font-medium text-[#716a80] sm:px-6">
                    <span>工程师</span>
                    <span>专业岗位</span>
                    <span>负责项目</span>
                    <span>当前状态</span>
                    <span>账号与 Key</span>
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
                        className="grid grid-cols-[minmax(180px,1.2fr)_minmax(170px,1.1fr)_minmax(190px,1.3fr)_150px_140px] items-center gap-4 border-b border-[#eee8f2] px-5 py-4 last:border-b-0 sm:px-6"
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
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </PortalCard>
        )}
        <PortalCard className="overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b border-[#eee8f2] px-5 py-4 sm:px-6">
            <div>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-[#c89013]" />
                <h2 className="font-semibold text-[#171321]">交付管理员积分</h2>
              </div>
              <p className="mt-1 text-sm leading-6 text-[#716a80]">
                {systemAdmin
                  ? "先选择交付管理员，再查看该管理员名下的 Key 池、管理员自用 Agent 积分与用户本月消耗。"
                  : "名下各 Key 池总消耗取自上游；管理员本人和名下用户按任务归属独立记账。"}
              </p>
            </div>
            {!previewMode && (
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
            )}
          </div>
          {!previewMode && usageHierarchyQuery.isLoading ? (
            <div className="p-6 text-sm text-[#716a80]">正在读取用量快照…</div>
          ) : !previewMode && usageHierarchyQuery.error ? (
            <div className="p-6 text-sm text-[#a02652]">用量暂时无法读取。</div>
          ) : usageManagers.length === 0 ? (
            <div className="p-6 text-sm text-[#716a80]">
              当前权限范围内暂无交付管理员用量记录。
            </div>
          ) : (
            <div
              className={`grid gap-5 p-5 sm:p-6 ${
                systemAdmin ? "lg:grid-cols-[250px_minmax(0,1fr)]" : ""
              }`}
            >
              {systemAdmin && (
                <aside className="space-y-2">
                  {usageManagers.map((manager) => (
                    <button
                      key={manager.adminId}
                      type="button"
                      onClick={() => setSelectedUsageManagerId(manager.adminId)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                        selectedUsageManager?.adminId === manager.adminId
                          ? "border-[#7a45a7] bg-[#f6f0fa]"
                          : "border-[#e8e1ee] bg-white hover:border-[#cdb9dc]"
                      }`}
                    >
                      <p className="truncate text-sm font-semibold text-[#332842]">
                        {manager.displayName}
                      </p>
                      <p className="mt-1 truncate text-xs text-[#857e91]">
                        {manager.users.length} 个受管用户
                      </p>
                    </button>
                  ))}
                </aside>
              )}

              {selectedUsageManager && (
                <section className="min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-[#221a33]">
                        {selectedUsageManager.displayName}
                      </h3>
                      <p className="mt-1 font-mono text-xs text-[#857e91]">
                        {selectedUsageManager.keyPool.credentialCount === 0
                          ? "尚未配置有效 Key"
                          : selectedUsageManager.keyPool.credentialCount === 1
                            ? selectedUsageManager.keyPool.fingerprint ||
                              "1 个有效 Key"
                            : `${selectedUsageManager.keyPool.credentialCount} 个有效 Key`}
                      </p>
                    </div>
                    <p className="text-xs text-[#857e91]">
                      {usageHierarchy.period.label} · 北京时间自然月
                    </p>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      [
                        "名下 Key 池总消耗",
                        selectedUsageManager.keyPool.totalUsed,
                      ],
                      [
                        "管理员自用 Agent 积分",
                        selectedUsageManager.ownAgentMonthUsed,
                      ],
                      ["已归属到本管理员", selectedUsageManager.attributedUsed],
                      [
                        "其他或未归属",
                        selectedUsageManager.otherOrUnattributedUsed,
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={String(label)}
                        className="rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                      >
                        <p className="text-xs font-medium text-[#716a80]">
                          {label}
                        </p>
                        <p className="mt-2 text-2xl font-semibold text-[#5b2a86]">
                          {Number(value).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                  {selectedUsageManager.keyPool.syncStatus !== "ok" && (
                    <p className="mt-3 rounded-xl border border-[#ead7a5] bg-[#fffaf0] px-3 py-2 text-xs leading-5 text-[#8a6200]">
                      名下 Key
                      池的本月用量尚未完整同步，请刷新用量后再据此判断是否更换
                      Key。
                    </p>
                  )}

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-[#332842]">
                      名下用户本月消耗
                    </h4>
                    <p className="text-xs text-[#857e91]">
                      用户端不展示积分信息
                    </p>
                  </div>
                  <div className="mt-3 overflow-hidden rounded-2xl border border-[#e8e1ee]">
                    {selectedUsageManager.users.length === 0 ? (
                      <p className="px-4 py-8 text-center text-sm text-[#716a80]">
                        该管理员暂未分配用户。
                      </p>
                    ) : (
                      selectedUsageManager.users.map((customer) => (
                        <button
                          key={customer.userId}
                          type="button"
                          onClick={() =>
                            setLocation(
                              previewMode
                                ? `${getPreviewAdminWorkspaceHref(systemAdmin)}?user=${customer.userId}&tab=credential`
                                : `/admin/workspace?user=${customer.userId}&tab=credential`,
                            )
                          }
                          className="grid w-full gap-2 border-b border-[#eee8f2] px-4 py-3 text-left last:border-b-0 hover:bg-[#fbf9fd] sm:grid-cols-[minmax(0,1fr)_150px_120px] sm:items-center"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[#332842]">
                              {customer.enterpriseName}
                            </p>
                            <p className="mt-1 truncate text-xs text-[#857e91]">
                              {customer.username || `用户 ${customer.userId}`}
                            </p>
                          </div>
                          <p className="text-sm font-semibold text-[#5b2a86]">
                            {customer.monthUsed.toLocaleString()}
                          </p>
                          <p
                            className={`text-xs sm:text-right ${
                              customer.credentialSource !== "unconfigured"
                                ? "text-[#16794f]"
                                : "text-[#a02652]"
                            }`}
                          >
                            {customer.usesManagerKey
                              ? "使用管理员 Key"
                              : customer.credentialSource === "customer"
                                ? "客户独立 Key"
                                : "Key 未配置"}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </PortalCard>

        <PortalCard className="overflow-hidden">
          <div className="border-b border-[#eee8f2] px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ClipboardList className="h-5 w-5 text-[#5b2a86]" />
                  <h2 className="font-semibold text-[#171321]">待受理工单</h2>
                </div>
                <p className="mt-2 text-sm leading-6 text-[#716a80]">
                  按提交时间从旧到新排列；仅展示当前管理员有权处理的客户工单。
                </p>
              </div>
              <div
                className={`grid gap-2 sm:grid-cols-2 ${
                  systemAdmin
                    ? "xl:grid-cols-[220px_140px_140px_150px]"
                    : "xl:grid-cols-[220px_140px_150px]"
                }`}
              >
                <label className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a94a8]" />
                  <Input
                    value={ticketKeyword}
                    onChange={(event) => setTicketKeyword(event.target.value)}
                    className="bg-[#fbf9fd] pl-9"
                    placeholder="搜索企业或话题"
                    aria-label="搜索工单"
                  />
                </label>
                <select
                  value={ticketType}
                  onChange={(event) => setTicketType(event.target.value)}
                  aria-label="筛选工单类型"
                  className="h-10 rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#484057]"
                >
                  <option value="all">全部类型</option>
                  <option value="content_asset">内容资产</option>
                  <option value="website_operation">官网运营</option>
                </select>
                {systemAdmin && (
                  <select
                    value={ticketManager}
                    onChange={(event) => setTicketManager(event.target.value)}
                    aria-label="筛选负责人"
                    className="h-10 rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#484057]"
                  >
                    <option value="all">全部负责人</option>
                    {ticketManagers.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  value={ticketStatus}
                  onChange={(event) => setTicketStatus(event.target.value)}
                  aria-label="筛选工单状态"
                  className="h-10 rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#484057]"
                >
                  <option value="all">全部状态</option>
                  <option value="pending">待受理</option>
                  <option value="completed">已完成</option>
                </select>
              </div>
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {[
                [
                  "待受理",
                  ticketListUnavailable
                    ? null
                    : (ticketCounts.pending ?? ticketCounts.publicPending ?? 0),
                ],
                [
                  "已完成",
                  ticketListUnavailable
                    ? null
                    : (ticketCounts.completed ??
                      ticketCounts.publicCompleted ??
                      0),
                ],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] px-4 py-3"
                >
                  <p className="text-xs font-medium text-[#857e91]">
                    {String(label)}
                  </p>
                  <p className="mt-1 text-xl font-semibold text-[#332842]">
                    {value === null ? "—" : Number(value)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {ticketListQuery.isLoading && !previewMode ? (
            <div className="p-8 text-center text-sm text-[#716a80]">
              正在汇总工单…
            </div>
          ) : ticketListQuery.error && !previewMode ? (
            <div className="p-6 text-sm text-[#a02652]">
              工单队列暂时无法载入：
              {ticketListQuery.error.message || "请刷新后重试。"}
            </div>
          ) : sortedTicketQueue.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#716a80]">
              当前没有符合条件的工单。
            </div>
          ) : (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1020px] text-left">
                  <thead className="bg-[#fbf9fd] text-xs text-[#716a80]">
                    <tr>
                      <th className="px-5 py-3 font-medium sm:px-6">企业</th>
                      <th className="px-5 py-3 font-medium">需求</th>
                      <th className="px-5 py-3 font-medium">类型</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">负责人</th>
                      <th className="px-5 py-3 font-medium">提交时间</th>
                      <th className="px-5 py-3 text-right font-medium sm:px-6">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#eee8f2]">
                    {sortedTicketQueue.map((ticket) => (
                      <tr key={ticket.id} className="text-sm">
                        <td className="px-5 py-4 font-semibold text-[#332842] sm:px-6">
                          {ticket.enterpriseName ||
                            `客户 ${ticket.userId || ""}`}
                        </td>
                        <td className="max-w-[360px] px-5 py-4">
                          <p className="truncate font-medium text-[#484057]">
                            {ticket.title || ticket.topic || "未命名工单"}
                          </p>
                          {ticket.topic && ticket.title !== ticket.topic && (
                            <p className="mt-1 truncate text-xs text-[#9a94a8]">
                              {ticket.topic}
                            </p>
                          )}
                        </td>
                        <td className="px-5 py-4 text-[#716a80]">
                          {ticket.type === "website_operation"
                            ? "官网运营"
                            : "内容资产"}
                        </td>
                        <td className="px-5 py-4">
                          <span className="rounded-full bg-[#f2ebf7] px-2.5 py-1 text-xs font-semibold text-[#5b2a86]">
                            {deliveryTicketPublicStatus(ticket) === "completed"
                              ? "已完成"
                              : "待受理"}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-[#716a80]">
                          {assignedManagersForTicket(ticket)
                            .map((manager) => manager.name)
                            .join("、") || "待分配"}
                        </td>
                        <td className="px-5 py-4 text-xs text-[#857e91]">
                          <span className="inline-flex items-center gap-1.5">
                            <CalendarClock className="h-3.5 w-3.5" />
                            {formatAdminTicketDate(
                              ticket.createdAt || ticket.updatedAt,
                            )}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right sm:px-6">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 font-semibold text-[#5b2a86]"
                            onClick={() => {
                              const customerId = Number(ticket.userId);
                              if (
                                !Number.isInteger(customerId) ||
                                customerId <= 0
                              )
                                return;
                              if (previewMode) {
                                setLocation(
                                  getPreviewAdminWorkspaceHref(
                                    systemAdmin,
                                    "tab=tickets",
                                  ),
                                );
                                return;
                              }
                              setLocation(
                                `/admin/customers/${customerId}/tickets?ticketId=${encodeURIComponent(ticket.id)}`,
                              );
                            }}
                          >
                            处理工单
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ticketListQuery.hasNextPage && !previewMode && (
                <div className="flex justify-center border-t border-[#eee8f2] p-4">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={ticketListQuery.isFetchingNextPage}
                    onClick={() => void ticketListQuery.fetchNextPage()}
                  >
                    {ticketListQuery.isFetchingNextPage
                      ? "正在加载…"
                      : "加载更多工单"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </PortalCard>
      </div>
    </PortalShell>
  );
}
