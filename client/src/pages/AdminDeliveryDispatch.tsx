import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  UserCog,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ticketTypeLabel } from "@/components/AdminDeliveryTicketWorkspace";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";
import {
  DELIVERY_TICKET_STATUS_LABELS,
  type DeliveryTicketStatus,
} from "@shared/delivery-ticket";

type DispatchPriority = "low" | "normal" | "high" | "urgent";

type DispatchTicket = {
  id: string;
  userId: number;
  type: "content_asset" | "website_operation" | "knowledge_base";
  title?: string | null;
  topic?: string | null;
  operation?: string | null;
  category?: string | null;
  status: DeliveryTicketStatus;
  workflowDomain: DeliveryRoleType | null;
  assignedProjectAssignmentId?: string | null;
  assignedMemberId: number | null;
  priority: DispatchPriority;
  createdAt?: Date | string | null;
  resolvedAt?: Date | string | null;
};

type DispatchProject = {
  id: number;
  username: string | null;
  displayName: string | null;
  managerId?: number | null;
  managerUsername?: string | null;
  managerDisplayName?: string | null;
};

type DispatchAssignment = {
  id: string;
  customerUserId: number;
  roleType: DeliveryRoleType;
  engineerUserId: number | null;
  engineerUsername: string | null;
  engineerDisplayName: string | null;
};

type DispatchEngineer = {
  id: number;
  username: string | null;
  displayName: string | null;
};

type DispatchTicketEvent = {
  id: string;
  ticketId: string;
  actorRole: string;
  message: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: Date | string;
};

type DispatchOverview = {
  projects: DispatchProject[];
  assignments: DispatchAssignment[];
  engineers: DispatchEngineer[];
  tickets: DispatchTicket[];
  completedTickets: DispatchTicket[];
  terminalTickets?: DispatchTicket[];
  ticketEvents: DispatchTicketEvent[];
};

type DispatchFilters = {
  query: string;
  type: string;
  status: string;
  role: string;
  managerId: string;
};

export function projectTeamConfigurationHref(
  customerUserId: number,
  roleType: DeliveryRoleType,
) {
  return `/admin/delivery-roles?customer=${customerUserId}&role=${encodeURIComponent(roleType)}`;
}

export function ticketNeedsProjectEngineer(
  ticket: Pick<DispatchTicket, "workflowDomain" | "assignedMemberId">,
) {
  return Boolean(ticket.workflowDomain) && ticket.assignedMemberId == null;
}

export function filterDispatchTickets(
  tickets: DispatchTicket[],
  projects: DispatchProject[],
  filters: DispatchFilters,
) {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("zh-CN");
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return tickets.filter((ticket) => {
    if (filters.type !== "all" && ticket.type !== filters.type) return false;
    if (filters.status !== "all" && ticket.status !== filters.status) {
      return false;
    }
    if (filters.role !== "all" && ticket.workflowDomain !== filters.role) {
      return false;
    }
    const project = projectById.get(ticket.userId);
    if (
      filters.managerId !== "all" &&
      String(project?.managerId ?? "") !== filters.managerId
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    return [
      ticket.title,
      ticket.topic,
      ticket.operation,
      ticket.category,
      project?.displayName,
      project?.username,
    ].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery),
    );
  });
}

export default function AdminDeliveryDispatch() {
  const { user } = useAuth();
  const systemAdmin = isSystemAdminAccount(user);
  const overview = trpc.delivery.management.overview.useQuery();
  const [, setLocation] = useLocation();
  const data = overview.data as unknown as DispatchOverview | undefined;
  const [query, setQuery] = useState("");
  const [ticketType, setTicketType] = useState("all");
  const [ticketStatus, setTicketStatus] = useState("all");
  const [roleType, setRoleType] = useState("all");
  const [managerId, setManagerId] = useState("all");
  const terminalTickets = data?.terminalTickets ?? data?.completedTickets ?? [];
  const allTickets = useMemo(
    () => [...(data?.tickets ?? []), ...terminalTickets],
    [data?.tickets, terminalTickets],
  );
  const filteredTickets = useMemo(
    () =>
      filterDispatchTickets(allTickets, data?.projects ?? [], {
        query,
        type: ticketType,
        status: ticketStatus,
        role: roleType,
        managerId,
      }),
    [
      allTickets,
      data?.projects,
      managerId,
      query,
      roleType,
      ticketStatus,
      ticketType,
    ],
  );
  const managerOptions = useMemo(() => {
    const managers = new Map<string, string>();
    for (const project of data?.projects ?? []) {
      if (project.managerId == null) continue;
      managers.set(
        String(project.managerId),
        project.managerDisplayName ||
          project.managerUsername ||
          `管理员 ${project.managerId}`,
      );
    }
    return [...managers.entries()];
  }, [data?.projects]);
  const activeTicketIds = useMemo(
    () => new Set((data?.tickets ?? []).map((ticket) => ticket.id)),
    [data?.tickets],
  );
  const filteredActiveTickets = filteredTickets.filter((ticket) =>
    activeTicketIds.has(ticket.id),
  );
  const filteredTerminalTickets = filteredTickets.filter(
    (ticket) => !activeTicketIds.has(ticket.id),
  );
  const openTicketDetail = (ticket: DispatchTicket) =>
    setLocation(
      `/admin/customers/${ticket.userId}/tickets?ticketId=${encodeURIComponent(ticket.id)}`,
    );

  return (
    <PortalShell
      eyebrow="交付管理 · 工单调度"
      title="工单调度"
      navItems={getAdminNav(systemAdmin)}
      toolbar={
        <Button
          variant="outline"
          onClick={() => void overview.refetch()}
          disabled={overview.isFetching}
        >
          <RefreshCw className={overview.isFetching ? "animate-spin" : ""} />
          刷新
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-7xl">
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["全部工单", allTickets.length],
            [
              "待补齐岗位",
              (data?.tickets ?? []).filter(ticketNeedsProjectEngineer).length,
            ],
            [
              "执行中",
              (data?.tickets ?? []).filter((ticket) =>
                ["scheduled", "in_progress"].includes(ticket.status),
              ).length,
            ],
            ["已完成", data?.completedTickets?.length ?? 0],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-xl border bg-card px-4 py-3"
            >
              <p className="text-xs font-medium text-muted-foreground">
                {label}
              </p>
              <p className="mt-1 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>

        <Card className="mb-5">
          <CardHeader>
            <CardTitle>交付工单总览与筛选</CardTitle>
          </CardHeader>
          <CardContent
            className={`grid gap-3 md:grid-cols-2 ${
              systemAdmin ? "xl:grid-cols-5" : "xl:grid-cols-4"
            }`}
          >
            <label className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder="搜索企业或工单"
                aria-label="搜索工单"
              />
            </label>
            <select
              value={ticketType}
              onChange={(event) => setTicketType(event.target.value)}
              aria-label="筛选工单类型"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部类型</option>
              <option value="knowledge_base">品牌知识库</option>
              <option value="content_asset">内容资产</option>
              <option value="website_operation">官网运营</option>
            </select>
            <select
              value={ticketStatus}
              onChange={(event) => setTicketStatus(event.target.value)}
              aria-label="筛选工单状态"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部状态</option>
              <option value="submitted">已提交</option>
              <option value="needs_information">待补充资料</option>
              <option value="scheduled">已排期</option>
              <option value="in_progress">处理中</option>
              <option value="completed">已完成</option>
              <option value="rejected">未受理</option>
              <option value="cancelled">已取消</option>
            </select>
            <select
              value={roleType}
              onChange={(event) => setRoleType(event.target.value)}
              aria-label="筛选执行岗位"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">全部岗位</option>
              {Object.entries(DELIVERY_ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {systemAdmin && (
              <select
                value={managerId}
                onChange={(event) => setManagerId(event.target.value)}
                aria-label="筛选交付管理员"
                className="h-10 rounded-md border bg-background px-3 text-sm"
              >
                <option value="all">全部交付管理员</option>
                {managerOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </CardContent>
        </Card>

        <div className="mb-4 rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-sm leading-6 text-muted-foreground">
          <strong className="text-foreground">调度规则：</strong>
          先在客户项目中配齐固定岗位，再设置优先级和催办。更换岗位负责人会自动转交该岗位全部未结束工单；管理员不在调度页代替工程师执行或完成工单。
        </div>
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>未结束工单</CardTitle>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">
                  共 {filteredActiveTickets.length} 个
                </Badge>
                <Badge
                  variant="outline"
                  className="border-amber-300 text-amber-700"
                >
                  待分配{" "}
                  {
                    filteredActiveTickets.filter(ticketNeedsProjectEngineer)
                      .length
                  }{" "}
                  个
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                正在读取未结束工单…
              </p>
            ) : overview.error ? (
              <p className="py-10 text-center text-sm text-destructive">
                工单暂时无法读取，请刷新后重试。
              </p>
            ) : (
              filteredActiveTickets.map((ticket) => (
                <DispatchRow
                  key={ticket.id}
                  ticket={ticket}
                  overview={data!}
                  onConfigureProject={() => {
                    if (!ticket.workflowDomain) return;
                    setLocation(
                      projectTeamConfigurationHref(
                        ticket.userId,
                        ticket.workflowDomain,
                      ),
                    );
                  }}
                  onDone={() => overview.refetch()}
                  onOpenDetail={() => openTicketDetail(ticket)}
                />
              ))
            )}
            {!overview.isLoading &&
              !overview.error &&
              !filteredActiveTickets.length && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  当前没有待调度工单
                </p>
              )}
          </CardContent>
        </Card>
        <Card className="mt-5">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>已结束工单</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  筛选结果 {filteredTerminalTickets.length} 个
                </Badge>
                <Badge
                  variant="outline"
                  className="border-emerald-300 text-emerald-700"
                >
                  已完成 {data?.completedTickets?.length ?? 0} 个
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                正在读取已结束工单…
              </p>
            ) : overview.error ? (
              <p className="py-10 text-center text-sm text-destructive">
                已结束工单暂时无法读取，请刷新后重试。
              </p>
            ) : (
              filteredTerminalTickets.map((ticket) => (
                <CompletedDispatchRow
                  key={ticket.id}
                  ticket={ticket}
                  overview={data!}
                  onOpenDetail={() => openTicketDetail(ticket)}
                />
              ))
            )}
            {!overview.isLoading &&
              !overview.error &&
              !filteredTerminalTickets.length && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  当前没有符合条件的已结束工单
                </p>
              )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function DispatchRow({
  ticket,
  overview,
  onConfigureProject,
  onDone,
  onOpenDetail,
}: {
  ticket: DispatchTicket;
  overview: DispatchOverview;
  onConfigureProject: () => void;
  onDone: () => Promise<unknown>;
  onOpenDetail: () => void;
}) {
  const [priority, setPriority] = useState<DispatchPriority>(
    ticket.priority || "normal",
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const dispatch = trpc.delivery.management.dispatchTicket.useMutation();
  const urge = trpc.delivery.management.urgeTicket.useMutation();
  const events = overview.ticketEvents.filter(
    (event) => event.ticketId === ticket.id,
  );
  const project = overview.projects.find(
    (candidate) => candidate.id === ticket.userId,
  );
  const projectAssignment = overview.assignments.find(
    (assignment) =>
      assignment.id === ticket.assignedProjectAssignmentId ||
      (assignment.customerUserId === ticket.userId &&
        assignment.roleType === ticket.workflowDomain),
  );
  const assignedEngineer =
    overview.engineers.find(
      (engineer) => engineer.id === ticket.assignedMemberId,
    ) ??
    (projectAssignment?.engineerUserId != null
      ? {
          id: projectAssignment.engineerUserId,
          username: projectAssignment.engineerUsername,
          displayName: projectAssignment.engineerDisplayName,
        }
      : undefined);
  const needsEngineer = ticketNeedsProjectEngineer(ticket);

  const save = async () => {
    try {
      await dispatch.mutateAsync({
        ticketId: ticket.id,
        priority,
      });
      await onDone();
      toast.success("工单优先级已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "调度失败");
    }
  };

  const sendUrge = async () => {
    try {
      await urge.mutateAsync({ ticketId: ticket.id });
      await onDone();
      toast.success("已写入催办记录");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "催办失败");
    }
  };

  return (
    <div
      className={
        needsEngineer
          ? "rounded-xl border border-amber-300 bg-amber-50/30 p-4"
          : "rounded-xl border p-4"
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">
              {ticket.title ||
                ticket.operation ||
                ticket.category ||
                "交付工单"}
            </p>
            <Badge variant="outline">
              {DELIVERY_TICKET_STATUS_LABELS[ticket.status]}
            </Badge>
            {needsEngineer && (
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700"
              >
                <AlertTriangle className="mr-1 h-3 w-3" />
                待分配
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {project?.displayName ||
              project?.username ||
              `客户 #${ticket.userId}`}{" "}
            · {ticketTypeLabel(ticket.type)} ·{" "}
            {ticket.workflowDomain
              ? DELIVERY_ROLE_LABELS[ticket.workflowDomain]
              : "旧版技术工单（只读）"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            交付管理员：
            {project?.managerDisplayName ||
              project?.managerUsername ||
              "待设置"}
          </p>
          {ticket.workflowDomain && !needsEngineer && (
            <p className="mt-2 text-xs">
              负责人：
              <span className="font-medium">
                {assignedEngineer
                  ? engineerName(assignedEngineer)
                  : "项目岗位负责人"}
              </span>
            </p>
          )}
        </div>

        <select
          className="h-10 rounded-md border bg-background px-3 text-sm"
          aria-label="工单优先级"
          value={priority}
          disabled={!ticket.workflowDomain}
          onChange={(event) =>
            setPriority(event.target.value as DispatchPriority)
          }
        >
          <option value="low">低优先级</option>
          <option value="normal">普通优先级</option>
          <option value="high">高优先级</option>
          <option value="urgent">紧急优先级</option>
        </select>

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={dispatch.isPending || !ticket.workflowDomain}
            onClick={() => void save()}
          >
            保存优先级
          </Button>
          {needsEngineer && (
            <Button variant="outline" onClick={onConfigureProject}>
              <UserCog className="h-4 w-4" />
              配置项目岗位
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {ticket.workflowDomain && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={urge.isPending}
              onClick={() => void sendUrge()}
            >
              <BellRing className="h-3.5 w-3.5" />
              催办
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              {historyOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              处理记录（{events.length}）
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onOpenDetail}>
          查看工单
        </Button>
      </div>

      {historyOpen && <TicketEventHistory events={events} />}
    </div>
  );
}

function CompletedDispatchRow({
  ticket,
  overview,
  onOpenDetail,
}: {
  ticket: DispatchTicket;
  overview: DispatchOverview;
  onOpenDetail: () => void;
}) {
  const project = overview.projects.find(
    (candidate) => candidate.id === ticket.userId,
  );
  const projectAssignment = overview.assignments.find(
    (assignment) =>
      assignment.id === ticket.assignedProjectAssignmentId ||
      (assignment.customerUserId === ticket.userId &&
        assignment.roleType === ticket.workflowDomain),
  );
  const assignedEngineer =
    overview.engineers.find(
      (engineer) => engineer.id === ticket.assignedMemberId,
    ) ??
    (projectAssignment?.engineerUserId != null
      ? {
          id: projectAssignment.engineerUserId,
          username: projectAssignment.engineerUsername,
          displayName: projectAssignment.engineerDisplayName,
        }
      : undefined);

  return (
    <div className="rounded-xl border bg-muted/15 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">
              {ticket.title ||
                ticket.operation ||
                ticket.category ||
                "交付工单"}
            </p>
            <Badge
              variant="outline"
              className="border-emerald-300 text-emerald-700"
            >
              {DELIVERY_TICKET_STATUS_LABELS[ticket.status]}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {project?.displayName ||
              project?.username ||
              `客户 #${ticket.userId}`}{" "}
            · {ticketTypeLabel(ticket.type)} ·{" "}
            {ticket.workflowDomain
              ? DELIVERY_ROLE_LABELS[ticket.workflowDomain]
              : "旧版技术工单"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            交付管理员：
            <span className="font-medium text-foreground">
              {project?.managerDisplayName ||
                project?.managerUsername ||
                "历史记录未保留"}
            </span>
            {" · "}
            负责人：
            <span className="font-medium text-foreground">
              {assignedEngineer
                ? engineerName(assignedEngineer)
                : "历史记录未保留负责人"}
            </span>
            {ticket.resolvedAt
              ? ` · 完成于 ${new Date(ticket.resolvedAt).toLocaleString("zh-CN")}`
              : ""}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-fit shrink-0"
          onClick={onOpenDetail}
        >
          查看工单详情
        </Button>
      </div>
    </div>
  );
}

function TicketEventHistory({ events }: { events: DispatchTicketEvent[] }) {
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-muted/35 p-3">
      {events.slice(0, 20).map((event) => (
        <div key={event.id} className="text-xs leading-5">
          <span className="text-muted-foreground">
            {new Date(event.createdAt).toLocaleString("zh-CN")} ·{" "}
            {event.actorRole}
          </span>
          <p>{event.message || `${event.fromStatus} → ${event.toStatus}`}</p>
        </div>
      ))}
      {!events.length && (
        <p className="text-xs text-muted-foreground">暂无处理记录</p>
      )}
    </div>
  );
}

function engineerName(engineer: {
  id: number;
  displayName: string | null;
  username: string | null;
}) {
  return engineer.displayName || engineer.username || `工程师 ${engineer.id}`;
}
