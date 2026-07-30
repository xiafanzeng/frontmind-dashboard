import { useMemo, useState, type FormEvent } from "react";
import {
  KeyRound,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

import PortalShell from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { getAdminNav } from "@/pages/AdminDashboard";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

const ROLE_TYPES = Object.keys(DELIVERY_ROLE_LABELS) as DeliveryRoleType[];

export default function AdminDeliveryRoles() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const overview = trpc.delivery.management.overview.useQuery();
  const createTeam = trpc.delivery.management.createTeam.useMutation();
  const createMember = trpc.delivery.management.createMember.useMutation();
  const setMember = trpc.delivery.management.setMember.useMutation();
  const assignCustomer = trpc.delivery.management.assignCustomer.useMutation();
  const setApiKey = trpc.delivery.management.setMemberApiKey.useMutation();
  const revokeApiKey =
    trpc.delivery.management.revokeMemberApiKey.useMutation();
  const [teamName, setTeamName] = useState("");
  const [roleType, setRoleType] = useState<DeliveryRoleType>(
    "knowledge_base_engineer",
  );
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [membershipRoleId, setMembershipRoleId] = useState("");
  const [membershipMemberId, setMembershipMemberId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [assignmentRoleId, setAssignmentRoleId] = useState("");
  const [assignmentMemberId, setAssignmentMemberId] = useState("");
  const [memberApiKey, setMemberApiKey] = useState("");
  const [apiMemberId, setApiMemberId] = useState("");

  const data = overview.data;
  const roles = data?.roles ?? [];
  const members = data?.members ?? [];
  const customers = data?.customers ?? [];
  const selectedAssignmentRole = roles.find(
    (role) => role.id === assignmentRoleId,
  );
  const eligibleMembers = useMemo(() => {
    if (!assignmentRoleId) return members;
    const ids = new Set(
      (data?.memberships ?? [])
        .filter((row) => row.roleId === assignmentRoleId && row.isActive)
        .map((row) => row.memberUserId),
    );
    return members.filter((member) => ids.has(member.id));
  }, [assignmentRoleId, data?.memberships, members]);
  const migrationGaps = useMemo(() => {
    if (!data) return [];
    const latestContractByCustomer = new Map<
      number,
      (typeof data.contracts)[number]
    >();
    for (const contract of data.contracts) {
      if (!latestContractByCustomer.has(contract.userId)) {
        latestContractByCustomer.set(contract.userId, contract);
      }
    }
    const assigned = new Set(
      data.assignments.map(
        (assignment) => `${assignment.customerUserId}:${assignment.roleType}`,
      ),
    );
    return data.customers
      .filter((customer) => customer.isActive)
      .flatMap((customer) => {
        const contract = latestContractByCustomer.get(customer.id);
        if (!contract) return [];
        const required: DeliveryRoleType[] = [
          "knowledge_base_engineer",
          "monitoring_optimization_engineer",
          "content_distribution_engineer",
          ...(contract.planCode === "basic"
            ? []
            : (["website_operations_engineer"] as DeliveryRoleType[])),
        ];
        return required
          .filter((type) => !assigned.has(`${customer.id}:${type}`))
          .map((type) => ({
            customerId: customer.id,
            customerName:
              customer.displayName ||
              customer.username ||
              `客户 ${customer.id}`,
            roleType: type,
            planCode: contract.planCode,
          }));
      });
  }, [data]);

  const refresh = async () => {
    await utils.delivery.management.overview.invalidate();
  };
  const submit = async (
    action: () => Promise<unknown>,
    success: string,
    reset?: () => void,
  ) => {
    try {
      await action();
      reset?.();
      await refresh();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <PortalShell
      eyebrow="交付管理 · 固定角色"
      title="角色与团队"
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
      <div className="mx-auto grid w-full max-w-7xl gap-5">
        <Card>
          <CardHeader>
            <CardTitle>固定交付团队</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {ROLE_TYPES.map((type) => {
                const teams = roles.filter((role) => role.roleType === type);
                return (
                  <div key={type} className="rounded-xl border p-4">
                    <p className="font-medium">{DELIVERY_ROLE_LABELS[type]}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {teams.length ? (
                        teams.map((team) => (
                          <Badge key={team.id} variant="secondary">
                            {team.name}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          尚未创建团队
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <form
              className="mt-5 grid gap-3 md:grid-cols-[1fr_1fr_auto]"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void submit(
                  () => createTeam.mutateAsync({ name: teamName, roleType }),
                  "团队已创建",
                  () => setTeamName(""),
                );
              }}
            >
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={roleType}
                onChange={(event) =>
                  setRoleType(event.target.value as DeliveryRoleType)
                }
              >
                {ROLE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {DELIVERY_ROLE_LABELS[type]}
                  </option>
                ))}
              </select>
              <Input
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
                placeholder="例如：国内知识库一组"
                required
              />
              <Button type="submit" disabled={createTeam.isPending}>
                <Plus /> 创建团队
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card
          className={
            migrationGaps.length
              ? "border-amber-300 bg-amber-50/40"
              : "border-emerald-200 bg-emerald-50/30"
          }
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {migrationGaps.length ? (
                <ShieldAlert className="h-5 w-5 text-amber-600" />
              ) : (
                <ShieldCheck className="h-5 w-5 text-emerald-600" />
              )}
              正式启用前迁移检查
            </CardTitle>
          </CardHeader>
          <CardContent>
            {migrationGaps.length ? (
              <>
                <p className="text-sm text-muted-foreground">
                  仍有 {migrationGaps.length} 项在用套餐角色未配置主负责人。
                  未配置完成前，对应客户提交入口会保持禁用。
                </p>
                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {migrationGaps.slice(0, 20).map((gap) => (
                    <div
                      key={`${gap.customerId}:${gap.roleType}`}
                      className="rounded-lg border border-amber-200 bg-white/80 px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{gap.customerName}</span>
                      <span className="ml-2 text-muted-foreground">
                        缺少 {DELIVERY_ROLE_LABELS[gap.roleType]}
                      </span>
                    </div>
                  ))}
                </div>
                {migrationGaps.length > 20 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    另有 {migrationGaps.length - 20}{" "}
                    项，请继续完成下方客户负责人配置。
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-emerald-800">
                当前所有在用套餐需要的固定业务角色均已配置主负责人。
              </p>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UsersRound className="h-5 w-5" /> 创建交付成员
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void submit(
                    () =>
                      createMember.mutateAsync({
                        username,
                        password,
                        displayName: displayName || undefined,
                      }),
                    "交付成员已创建",
                    () => {
                      setUsername("");
                      setDisplayName("");
                      setPassword("");
                    },
                  );
                }}
              >
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="登录用户名"
                  required
                />
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="成员姓名"
                />
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="初始密码"
                  required
                />
                <Button type="submit" disabled={createMember.isPending}>
                  创建账号
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>成员加入团队</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void submit(
                    () =>
                      setMember.mutateAsync({
                        roleId: membershipRoleId,
                        memberUserId: Number(membershipMemberId),
                        active: true,
                      }),
                    "成员角色已更新",
                  );
                }}
              >
                <NativeSelect
                  value={membershipRoleId}
                  onChange={setMembershipRoleId}
                  placeholder="选择固定角色团队"
                  options={roles.map((role) => ({
                    value: role.id,
                    label: `${DELIVERY_ROLE_LABELS[role.roleType]} · ${role.name}`,
                  }))}
                />
                <NativeSelect
                  value={membershipMemberId}
                  onChange={setMembershipMemberId}
                  placeholder="选择交付成员"
                  options={members.map((member) => ({
                    value: String(member.id),
                    label:
                      member.displayName ||
                      member.username ||
                      String(member.id),
                  }))}
                />
                <Button
                  type="submit"
                  disabled={
                    setMember.isPending ||
                    !membershipRoleId ||
                    !membershipMemberId
                  }
                >
                  加入团队
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>客户主负责人</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  if (!selectedAssignmentRole) return;
                  void submit(
                    () =>
                      assignCustomer.mutateAsync({
                        customerUserId: Number(customerId),
                        roleType: selectedAssignmentRole.roleType,
                        roleId: selectedAssignmentRole.id,
                        primaryMemberId: Number(assignmentMemberId),
                      }),
                    "客户负责人已配置，未完成工单已同步转派",
                  );
                }}
              >
                <NativeSelect
                  value={customerId}
                  onChange={setCustomerId}
                  placeholder="选择客户"
                  options={customers.map((customer) => ({
                    value: String(customer.id),
                    label:
                      customer.displayName ||
                      customer.username ||
                      String(customer.id),
                  }))}
                />
                <NativeSelect
                  value={assignmentRoleId}
                  onChange={(value) => {
                    setAssignmentRoleId(value);
                    setAssignmentMemberId("");
                  }}
                  placeholder="选择业务角色与团队"
                  options={roles.map((role) => ({
                    value: role.id,
                    label: `${DELIVERY_ROLE_LABELS[role.roleType]} · ${role.name}`,
                  }))}
                />
                <NativeSelect
                  value={assignmentMemberId}
                  onChange={setAssignmentMemberId}
                  placeholder="选择该团队成员"
                  options={eligibleMembers.map((member) => ({
                    value: String(member.id),
                    label:
                      member.displayName ||
                      member.username ||
                      String(member.id),
                  }))}
                />
                <Button
                  type="submit"
                  disabled={
                    assignCustomer.isPending ||
                    !customerId ||
                    !assignmentRoleId ||
                    !assignmentMemberId
                  }
                >
                  设置主负责人
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" /> 成员通用智能体 Key
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">
                Key 仅在服务端加密保存，交付成员只能看到是否已配置。
              </p>
              <form
                className="grid gap-3"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void submit(
                    () =>
                      setApiKey.mutateAsync({
                        memberUserId: Number(apiMemberId),
                        apiKey: memberApiKey,
                      }),
                    "成员 API Key 已验证并更新",
                    () => setMemberApiKey(""),
                  );
                }}
              >
                <NativeSelect
                  value={apiMemberId}
                  onChange={setApiMemberId}
                  placeholder="选择交付成员"
                  options={members.map((member) => ({
                    value: String(member.id),
                    label:
                      member.displayName ||
                      member.username ||
                      String(member.id),
                  }))}
                />
                <Label htmlFor="member-api-key">API Key</Label>
                <Input
                  id="member-api-key"
                  type="password"
                  autoComplete="off"
                  value={memberApiKey}
                  onChange={(event) => setMemberApiKey(event.target.value)}
                  required
                />
                <Button
                  type="submit"
                  disabled={
                    setApiKey.isPending || !apiMemberId || !memberApiKey
                  }
                >
                  验证并分配
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive"
                  disabled={revokeApiKey.isPending || !apiMemberId}
                  onClick={() => {
                    if (!window.confirm("确认撤销该成员当前 API Key？")) return;
                    void submit(
                      () =>
                        revokeApiKey.mutateAsync({
                          memberUserId: Number(apiMemberId),
                        }),
                      "成员 API Key 已撤销",
                    );
                  }}
                >
                  撤销当前 Key
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </PortalShell>
  );
}

function NativeSelect(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      className="h-10 rounded-md border bg-background px-3 text-sm"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      required
    >
      <option value="">{props.placeholder}</option>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
