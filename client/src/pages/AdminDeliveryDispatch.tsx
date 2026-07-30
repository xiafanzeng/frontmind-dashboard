import { useState } from "react";
import {
  AlertTriangle,
  BellRing,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  UserCog,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

type DispatchPriority = "low" | "normal" | "high" | "urgent";

type DispatchTicket = {
  id: string;
  userId: number;
  title?: string | null;
  operation?: string | null;
  category?: string | null;
  status: string;
  workflowDomain: DeliveryRoleType | null;
  assignedProjectAssignmentId?: string | null;
  assignedMemberId: number | null;
  priority: DispatchPriority;
};

type DispatchProject = {
  id: number;
  username: string | null;
  displayName: string | null;
};

type DispatchAssignment = {
  id: string;
  customerUserId: number;
  roleType: DeliveryRoleType;
  engineerUserId: number;
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
  ticketEvents: DispatchTicketEvent[];
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

export default function AdminDeliveryDispatch() {
  const { user } = useAuth();
  const overview = trpc.delivery.management.overview.useQuery();
  const [, setLocation] = useLocation();
  const data = overview.data as unknown as DispatchOverview | undefined;

  return (
    <PortalShell
      eyebrow="交付管理 · 工单调度"
      title="工单调度"
      navItems={getAdminNav(isSystemAdminAccount(user))}
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
      <div className="mx-auto w-full max-w-6xl">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>未结束工单</CardTitle>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">
                  共 {data?.tickets.length ?? 0} 个
                </Badge>
                <Badge
                  variant="outline"
                  className="border-amber-300 text-amber-700"
                >
                  待分配{" "}
                  {
                    (data?.tickets ?? []).filter(ticketNeedsProjectEngineer)
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
              (data?.tickets ?? []).map((ticket) => (
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
                />
              ))
            )}
            {!overview.isLoading &&
              !overview.error &&
              !data?.tickets.length && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  当前没有待调度工单
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
}: {
  ticket: DispatchTicket;
  overview: DispatchOverview;
  onConfigureProject: () => void;
  onDone: () => Promise<unknown>;
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
    (projectAssignment
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
            <Badge variant="outline">{ticket.status}</Badge>
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
            ·{" "}
            {ticket.workflowDomain
              ? DELIVERY_ROLE_LABELS[ticket.workflowDomain]
              : "旧版技术工单（只读）"}
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

      {ticket.workflowDomain && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
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
        </div>
      )}

      {historyOpen && (
        <div className="mt-3 space-y-2 rounded-lg bg-muted/35 p-3">
          {events.slice(0, 20).map((event) => (
            <div key={event.id} className="text-xs leading-5">
              <span className="text-muted-foreground">
                {new Date(event.createdAt).toLocaleString("zh-CN")} ·{" "}
                {event.actorRole}
              </span>
              <p>
                {event.message || `${event.fromStatus} → ${event.toStatus}`}
              </p>
            </div>
          ))}
          {!events.length && (
            <p className="text-xs text-muted-foreground">暂无处理记录</p>
          )}
        </div>
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
