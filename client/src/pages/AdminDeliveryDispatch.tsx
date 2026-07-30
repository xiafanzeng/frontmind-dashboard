import { useMemo, useState } from "react";
import { BellRing, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { toast } from "sonner";

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

export default function AdminDeliveryDispatch() {
  const { user } = useAuth();
  const overview = trpc.delivery.management.overview.useQuery();
  return (
    <PortalShell
      eyebrow="交付管理 · 工单调度"
      title="工单调度"
      navItems={getAdminNav(isSystemAdminAccount(user))}
      toolbar={
        <Button variant="outline" onClick={() => void overview.refetch()}>
          <RefreshCw className={overview.isFetching ? "animate-spin" : ""} />
          刷新
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-6xl">
        <Card>
          <CardHeader>
            <CardTitle>未结束工单</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(overview.data?.tickets ?? []).map((ticket) => (
              <DispatchRow
                key={ticket.id}
                ticket={ticket}
                overview={overview.data!}
                onDone={() => overview.refetch()}
              />
            ))}
            {!overview.data?.tickets.length && (
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
  onDone,
}: {
  ticket: any;
  overview: any;
  onDone: () => Promise<unknown>;
}) {
  const roles = (overview.roles ?? []).filter(
    (role: any) => role.roleType === ticket.workflowDomain,
  );
  const [roleId, setRoleId] = useState(
    ticket.assignedRoleId || roles[0]?.id || "",
  );
  const memberIds = useMemo(
    () =>
      new Set(
        (overview.memberships ?? [])
          .filter((row: any) => row.roleId === roleId && row.isActive)
          .map((row: any) => row.memberUserId),
      ),
    [overview.memberships, roleId],
  );
  const members = (overview.members ?? []).filter((member: any) =>
    memberIds.has(member.id),
  );
  const [memberUserId, setMemberUserId] = useState(
    String(ticket.assignedMemberId || ""),
  );
  const [priority, setPriority] = useState<
    "low" | "normal" | "high" | "urgent"
  >(ticket.priority || "normal");
  const [historyOpen, setHistoryOpen] = useState(false);
  const dispatch = trpc.delivery.management.dispatchTicket.useMutation();
  const urge = trpc.delivery.management.urgeTicket.useMutation();
  const events = (overview.ticketEvents ?? []).filter(
    (event: any) => event.ticketId === ticket.id,
  );
  const save = async () => {
    try {
      await dispatch.mutateAsync({
        ticketId: ticket.id,
        roleId,
        memberUserId: Number(memberUserId),
        priority,
      });
      await onDone();
      toast.success("工单调度已更新");
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
    <div className="rounded-xl border p-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_220px_180px_130px_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">
              {ticket.title ||
                ticket.operation ||
                ticket.category ||
                "交付工单"}
            </p>
            <Badge variant="outline">{ticket.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            客户 #{ticket.userId} ·{" "}
            {ticket.workflowDomain
              ? DELIVERY_ROLE_LABELS[ticket.workflowDomain as DeliveryRoleType]
              : "旧版技术工单（只读）"}
          </p>
        </div>
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm"
          value={roleId}
          disabled={!ticket.workflowDomain}
          onChange={(event) => {
            setRoleId(event.target.value);
            setMemberUserId("");
          }}
        >
          <option value="">选择团队</option>
          {roles.map((role: any) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm"
          value={memberUserId}
          disabled={!ticket.workflowDomain}
          onChange={(event) => setMemberUserId(event.target.value)}
        >
          <option value="">选择负责人</option>
          {members.map((member: any) => (
            <option key={member.id} value={member.id}>
              {member.displayName || member.username}
            </option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm"
          value={priority}
          disabled={!ticket.workflowDomain}
          onChange={(event) =>
            setPriority(event.target.value as typeof priority)
          }
        >
          <option value="low">低</option>
          <option value="normal">普通</option>
          <option value="high">高</option>
          <option value="urgent">紧急</option>
        </select>
        <Button
          disabled={
            dispatch.isPending ||
            !ticket.workflowDomain ||
            !roleId ||
            !memberUserId
          }
          onClick={() => void save()}
        >
          保存调度
        </Button>
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
          {events.slice(0, 20).map((event: any) => (
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
