import { useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth, type AuthUser } from "@/_core/hooks/useAuth";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@shared/auth-constraints";
import {
  ACCOUNT_MARKET_EDITION_LABELS,
  type AccountMarketEdition,
} from "@shared/account-edition";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";
import type { ProvisionableServicePlanCode } from "@shared/service-portal";
import { trpc } from "@/lib/trpc";
import {
  isProtectedBuiltinAdminUsername,
  isSystemAdminAccount,
} from "@/lib/admin-access";
import PortalShell from "@/components/PortalShell";
import { getAdminNav } from "@/pages/AdminDashboard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type StatusChange = {
  user: AuthUser;
  isActive: boolean;
};

type AccessLevelChange = {
  user: AuthUser;
  adminAccessLevel: "system_admin" | "delivery_admin";
};

type CreatableAccountRole = "user" | "admin" | "delivery_member";

export default function AdminUsers() {
  const [, setLocation] = useLocation();
  const { user: currentUser, refresh: refreshCurrentUser } = useAuth();
  const systemAdmin = isSystemAdminAccount(currentUser);
  const deliveryAdmin =
    currentUser?.role === "admin" &&
    currentUser.adminAccessLevel === "delivery_admin";
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<AuthUser | null>(null);
  const [statusChange, setStatusChange] = useState<StatusChange | null>(null);
  const [accessLevelChange, setAccessLevelChange] =
    useState<AccessLevelChange | null>(null);
  const [deleteUser, setDeleteUser] = useState<AuthUser | null>(null);
  const [engineerApiKeyUser, setEngineerApiKeyUser] = useState<AuthUser | null>(
    null,
  );

  const usersQuery = trpc.admin.users.list.useQuery(undefined, {
    enabled: systemAdmin,
    retry: false,
  });
  const deliveryOverviewQuery = trpc.delivery.management.overview.useQuery(
    undefined,
    {
      enabled: deliveryAdmin,
      retry: false,
    },
  );
  const utils = trpc.useUtils();
  const setActiveMutation = trpc.admin.users.setActive.useMutation({
    onSuccess: () => utils.admin.users.list.invalidate(),
  });
  const deleteMutation = trpc.admin.users.delete.useMutation({
    onSuccess: () => utils.admin.users.list.invalidate(),
  });
  const setAdminAccessLevelMutation =
    trpc.admin.users.setAdminAccessLevel.useMutation();

  const users = (usersQuery.data?.users ?? []) as AuthUser[];
  const deliveryEngineers = useMemo(
    () =>
      (deliveryOverviewQuery.data?.engineers ?? []).map(
        (engineer): AuthUser => ({
          id: engineer.id,
          username: engineer.username || `engineer-${engineer.id}`,
          displayName: engineer.displayName,
          role: "delivery_member",
          adminAccessLevel: null,
          engineerRoleType: engineer.engineerRoleType,
          engineerApiKeyConfigured: engineer.apiKeyConfigured,
          engineerApiKeyVersion: engineer.apiKeyVersion,
          engineerApiKeyManageable: engineer.apiKeyManageable,
          engineerApiKeyManageReason: engineer.apiKeyManageReason,
          marketEdition: "domestic",
          isActive: engineer.isActive,
        }),
      ),
    [deliveryOverviewQuery.data?.engineers],
  );
  const activeCount = useMemo(
    () => users.filter((account) => account.isActive).length,
    [users],
  );

  const applyStatusChange = async () => {
    if (!statusChange) return;
    try {
      await setActiveMutation.mutateAsync({
        userId: statusChange.user.id,
        isActive: statusChange.isActive,
      });
      toast.success(statusChange.isActive ? "账号已启用" : "账号已禁用", {
        description:
          statusChange.user.displayName || statusChange.user.username,
      });
      setStatusChange(null);
    } catch (error) {
      toast.error("无法更新账号状态", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const applyDelete = async () => {
    if (!deleteUser) return;
    try {
      await deleteMutation.mutateAsync({ userId: deleteUser.id });
      toast.success("账号已永久删除", {
        description: deleteUser.displayName || deleteUser.username,
      });
      setDeleteUser(null);
    } catch (error) {
      toast.error("无法删除账号", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const applyAccessLevelChange = async () => {
    if (!accessLevelChange) return;
    try {
      const result = await setAdminAccessLevelMutation.mutateAsync({
        userId: accessLevelChange.user.id,
        adminAccessLevel: accessLevelChange.adminAccessLevel,
      });
      await utils.admin.users.list.invalidate();
      if (accessLevelChange.user.id === currentUser?.id) {
        await refreshCurrentUser();
      }
      toast.success(
        result.changed ? "管理员权限已更新" : "管理员权限未发生变化",
        {
          description: `${
            accessLevelChange.user.displayName ||
            accessLevelChange.user.username
          } · ${
            accessLevelChange.adminAccessLevel === "system_admin"
              ? "系统管理员"
              : "交付管理员"
          }`,
        },
      );
      setAccessLevelChange(null);
    } catch (error) {
      toast.error("无法更新管理员权限", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  if (deliveryAdmin) {
    return (
      <PortalShell
        eyebrow="管理中心 · 客户与服务"
        title="账号与权限"
        navItems={getAdminNav(false)}
        toolbar={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            创建账号
          </Button>
        }
      >
        <div className="mx-auto w-full max-w-3xl space-y-5">
          <Card className="border-border/70 bg-card/85 shadow-sm backdrop-blur-xl">
            <CardContent className="flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:p-8">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <UserRoundCheck className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold">创建客户或工程师账号</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  客户账号会自动归属当前交付管理员；工程师账号需固定选择一个岗位，
                  后续再按客户项目分配负责人。
                </p>
              </div>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                开始创建
              </Button>
            </CardContent>
          </Card>
          <Card className="border-border/70 bg-card/85 shadow-sm backdrop-blur-xl">
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">工程师账号与 Key</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    工程师岗位固定；你可以维护自己客户项目中的工程师，以及自己创建且尚未分配的工程师 Key。
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={deliveryOverviewQuery.isFetching}
                  onClick={() => void deliveryOverviewQuery.refetch()}
                >
                  <RefreshCw
                    className={
                      deliveryOverviewQuery.isFetching ? "animate-spin" : ""
                    }
                  />
                  刷新
                </Button>
              </div>
              <div className="mt-5 divide-y divide-border/60 rounded-xl border">
                {deliveryOverviewQuery.isLoading ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    正在载入工程师账号…
                  </p>
                ) : deliveryOverviewQuery.error ? (
                  <div className="p-6 text-center">
                    <p className="font-medium text-destructive">
                      工程师账号加载失败
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {deliveryOverviewQuery.error.message ||
                        "请检查网络连接后重试。"}
                    </p>
                    <Button
                      className="mt-4"
                      size="sm"
                      variant="outline"
                      onClick={() => void deliveryOverviewQuery.refetch()}
                    >
                      <RefreshCw className="h-4 w-4" />
                      重试
                    </Button>
                  </div>
                ) : deliveryEngineers.length ? (
                  deliveryEngineers.map((engineer) => (
                    <div
                      key={engineer.id}
                      className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {engineer.displayName || engineer.username}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          @{engineer.username}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">
                          {engineer.engineerRoleType
                            ? DELIVERY_ROLE_LABELS[engineer.engineerRoleType]
                            : "岗位未配置"}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={
                            engineer.engineerApiKeyConfigured
                              ? "text-emerald-700"
                              : "text-amber-700"
                          }
                        >
                          {engineer.engineerApiKeyConfigured
                            ? "Key 已配置"
                            : "Key 未配置"}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={engineer.engineerApiKeyManageable === false}
                          title={
                            engineer.engineerApiKeyManageReason || undefined
                          }
                          onClick={() => setEngineerApiKeyUser(engineer)}
                        >
                          <KeyRound className="h-4 w-4" />
                          管理 Key
                        </Button>
                      </div>
                      {engineer.engineerApiKeyManageable === false &&
                        engineer.engineerApiKeyManageReason && (
                          <p className="text-xs text-muted-foreground sm:basis-full sm:text-right">
                            {engineer.engineerApiKeyManageReason}
                          </p>
                        )}
                    </div>
                  ))
                ) : (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    暂无工程师账号
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <CreateUserDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          userOnly
          allowEngineer
          fixedDeliveryAdmin={{
            id: currentUser.id,
            username: currentUser.username,
            displayName: currentUser.displayName,
          }}
          onCreated={(userId, createdRole) => {
            if (createdRole === "user") {
              setLocation(`/admin/customers/${userId}/service`);
            }
          }}
        />
        <EngineerApiKeyDialog
          user={engineerApiKeyUser}
          onOpenChange={(open) => !open && setEngineerApiKeyUser(null)}
        />
      </PortalShell>
    );
  }

  if (!systemAdmin) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-10 text-center">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h1 className="text-xl font-semibold">没有访问权限</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              只有系统管理员和交付管理员可以访问此页面。
            </p>
            <Button
              className="mt-6"
              variant="outline"
              onClick={() => setLocation("/")}
            >
              <ArrowLeft className="h-4 w-4" />
              返回工作空间
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <PortalShell
      eyebrow="管理中心 · 系统管理"
      title="账号与权限"
      navItems={getAdminNav(true)}
      toolbar={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="bg-card/80"
            disabled={usersQuery.isFetching}
            onClick={() => void usersQuery.refetch()}
          >
            <RefreshCw
              className={`h-4 w-4 ${usersQuery.isFetching ? "animate-spin" : ""}`}
            />
            刷新
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            创建账号
          </Button>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-6xl">
        <p className="mb-5 text-sm text-[#716a80]">
          创建客户、管理员与工程师账号，配置岗位、凭据和管理员权限，并管理账号生命周期。
        </p>

        <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="账号总数" value={users.length} />
          <MetricCard label="已启用" value={activeCount} tone="positive" />
          <MetricCard
            label="客户"
            value={users.filter((account) => account.role === "user").length}
          />
          <MetricCard
            label="管理员"
            value={users.filter((account) => account.role === "admin").length}
          />
          <MetricCard
            label="工程师"
            value={
              users.filter((account) => account.role === "delivery_member")
                .length
            }
          />
        </section>

        <Card className="border-border/70 bg-card/85 shadow-sm backdrop-blur-xl">
          <CardContent className="p-0">
            {usersQuery.isLoading ? (
              <div className="space-y-3 p-5">
                {[0, 1, 2].map((item) => (
                  <Skeleton key={item} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            ) : usersQuery.error ? (
              <div className="px-5 py-14 text-center">
                <ShieldAlert className="mx-auto mb-3 h-7 w-7 text-destructive" />
                <p className="font-medium">账号列表加载失败</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {usersQuery.error.message}
                </p>
                <Button
                  className="mt-5"
                  variant="outline"
                  onClick={() => void usersQuery.refetch()}
                >
                  重试
                </Button>
              </div>
            ) : users.length === 0 ? (
              <div className="px-5 py-14 text-center text-sm text-muted-foreground">
                暂无账号
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {users.map((account) => (
                  <UserRow
                    key={account.id}
                    account={account}
                    isCurrent={account.id === currentUser?.id}
                    pending={
                      (setActiveMutation.isPending &&
                        statusChange?.user.id === account.id) ||
                      (deleteMutation.isPending &&
                        deleteUser?.id === account.id)
                    }
                    accessPending={
                      setAdminAccessLevelMutation.isPending &&
                      accessLevelChange?.user.id === account.id
                    }
                    onResetPassword={() => setResetUser(account)}
                    onChangeAccessLevel={(adminAccessLevel) =>
                      setAccessLevelChange({ user: account, adminAccessLevel })
                    }
                    onChangeStatus={(isActive) =>
                      setStatusChange({ user: account, isActive })
                    }
                    onManageApiKey={() => setEngineerApiKeyUser(account)}
                    onDelete={() => setDeleteUser(account)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        deliveryAdmins={users.filter(
          (account) =>
            account.role === "admin" &&
            (account.adminAccessLevel === "system_admin" ||
              account.adminAccessLevel === "delivery_admin") &&
            account.isActive,
        )}
      />
      <ResetPasswordDialog
        user={resetUser}
        onOpenChange={(open) => !open && setResetUser(null)}
      />
      <EngineerApiKeyDialog
        user={engineerApiKeyUser}
        onOpenChange={(open) => !open && setEngineerApiKeyUser(null)}
      />

      <AlertDialog
        open={Boolean(accessLevelChange)}
        onOpenChange={(open) =>
          !open &&
          !setAdminAccessLevelMutation.isPending &&
          setAccessLevelChange(null)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {accessLevelChange?.adminAccessLevel === "system_admin"
                ? "设为系统管理员"
                : "设为交付管理员"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {accessLevelChange?.adminAccessLevel === "system_admin"
                ? `${accessLevelChange?.user.displayName || accessLevelChange?.user.username} 将可以管理全部客户、套餐合同、账号权限和官网全局凭据。`
                : `${
                    accessLevelChange?.user.displayName ||
                    accessLevelChange?.user.username
                  } 将只能管理被分配的客户，并失去账号、商业权益和全局凭据管理权限。系统会拒绝降级最后一名已启用的系统管理员。`}
              {accessLevelChange?.user.id === currentUser?.id &&
                accessLevelChange?.adminAccessLevel === "delivery_admin" &&
                " 这是当前登录账号；确认后会立即退出本页的系统管理权限。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setAdminAccessLevelMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void applyAccessLevelChange();
              }}
              disabled={setAdminAccessLevelMutation.isPending}
            >
              {setAdminAccessLevelMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认调整权限
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(statusChange)}
        onOpenChange={(open) =>
          !open && !setActiveMutation.isPending && setStatusChange(null)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {statusChange?.isActive ? "启用账号" : "禁用账号"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {statusChange?.isActive
                ? `启用后，${statusChange.user.displayName || statusChange?.user.username} 可以重新登录。`
                : `禁用后，${statusChange?.user.displayName || statusChange?.user.username} 的登录会话将失效。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setActiveMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void applyStatusChange();
              }}
              disabled={setActiveMutation.isPending}
              className={
                statusChange?.isActive
                  ? ""
                  : "bg-destructive text-white hover:bg-destructive/90"
              }
            >
              {setActiveMutation.isPending && (
                <Loader2 className="animate-spin" />
              )}
              确认{statusChange?.isActive ? "启用" : "禁用"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleteUser)}
        onOpenChange={(open) =>
          !open && !deleteMutation.isPending && setDeleteUser(null)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>永久删除账号</AlertDialogTitle>
            <AlertDialogDescription>
              删除后，{deleteUser?.displayName || deleteUser?.username}
              的账号、会话、消息、附件、API 凭据及登录会话都会从 FrontMind
              数据库永久删除，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void applyDelete();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteMutation.isPending && <Loader2 className="animate-spin" />}
              确认永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PortalShell>
  );
}

function MetricCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "positive";
}) {
  return (
    <Card className="border-border/70 bg-card/75 shadow-sm backdrop-blur-xl">
      <CardContent className="flex items-center justify-between px-4 py-3.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span
          className={
            tone === "positive"
              ? "text-xl font-semibold text-emerald-600"
              : "text-xl font-semibold"
          }
        >
          {value}
        </span>
      </CardContent>
    </Card>
  );
}

export function UserRow({
  account,
  isCurrent,
  pending,
  accessPending,
  onResetPassword,
  onChangeAccessLevel,
  onChangeStatus,
  onManageApiKey,
  onDelete,
}: {
  account: AuthUser;
  isCurrent: boolean;
  pending: boolean;
  accessPending: boolean;
  onResetPassword: () => void;
  onChangeAccessLevel: (
    adminAccessLevel: "system_admin" | "delivery_admin",
  ) => void;
  onChangeStatus: (isActive: boolean) => void;
  onManageApiKey: () => void;
  onDelete: () => void;
}) {
  const name = account.displayName || account.username;
  const initials = Array.from(name).slice(0, 2).join("").toUpperCase();
  const busy = pending || accessPending;
  const systemAdmin = isSystemAdminAccount(account);
  const protectedBuiltinAdmin = isProtectedBuiltinAdminUsername(
    account.username,
  );

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar className="h-10 w-10 border border-border/70">
          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-medium">{name}</p>
            {isCurrent && (
              <Badge variant="outline" className="text-xs">
                当前账号
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            @{account.username}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-[52px] sm:pl-0">
        <Badge variant={account.role === "admin" ? "default" : "secondary"}>
          {account.role === "admin" ? (
            <ShieldCheck className="mr-1 h-3 w-3" />
          ) : null}
          {account.role === "admin"
            ? systemAdmin
              ? "系统管理员"
              : "交付管理员"
            : account.role === "delivery_member"
              ? "工程师"
              : "客户"}
        </Badge>
        {account.role === "user" && (
          <Badge variant="secondary">
            {ACCOUNT_MARKET_EDITION_LABELS[account.marketEdition || "domestic"]}
          </Badge>
        )}
        {account.role === "delivery_member" && account.engineerRoleType && (
          <Badge variant="secondary">
            {DELIVERY_ROLE_LABELS[account.engineerRoleType]}
          </Badge>
        )}
        {account.role === "delivery_member" && (
          <Badge
            variant="outline"
            className={
              account.engineerApiKeyConfigured
                ? "text-emerald-700"
                : "border-amber-300 bg-amber-50 text-amber-700"
            }
          >
            {account.engineerApiKeyConfigured ? "Key 已配置" : "Key 未配置"}
          </Badge>
        )}
        <Badge
          variant="outline"
          className={
            account.isActive ? "text-emerald-700" : "text-muted-foreground"
          }
        >
          {account.isActive ? "已启用" : "已禁用"}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2 pl-[52px] sm:pl-0">
        {account.role === "admin" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || protectedBuiltinAdmin}
            title={
              protectedBuiltinAdmin
                ? "内置 admin 必须保持为系统管理员"
                : undefined
            }
            onClick={() =>
              onChangeAccessLevel(
                systemAdmin ? "delivery_admin" : "system_admin",
              )
            }
          >
            {accessPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {systemAdmin ? "设为交付管理员" : "设为系统管理员"}
          </Button>
        )}
        {account.role === "delivery_member" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onManageApiKey}
          >
            <KeyRound className="h-3.5 w-3.5" />
            管理 Key
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onResetPassword}
        >
          <KeyRound className="h-3.5 w-3.5" />
          重置密码
        </Button>
        <Button
          size="sm"
          variant={account.isActive ? "outline" : "default"}
          disabled={busy || isCurrent || protectedBuiltinAdmin}
          title={
            protectedBuiltinAdmin
              ? "内置 admin 必须保持启用"
              : isCurrent
                ? "不能在此处禁用当前账号"
                : undefined
          }
          onClick={() => onChangeStatus(!account.isActive)}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : account.isActive ? (
            <UserRoundX className="h-3.5 w-3.5" />
          ) : (
            <UserRoundCheck className="h-3.5 w-3.5" />
          )}
          {account.isActive ? "禁用" : "启用"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy || isCurrent || protectedBuiltinAdmin}
          title={
            protectedBuiltinAdmin
              ? "内置 admin 系统管理员不能被删除"
              : isCurrent
                ? "不能删除当前登录账号"
                : undefined
          }
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </Button>
      </div>
    </div>
  );
}

export function CreateUserDialog({
  open,
  onOpenChange,
  userOnly = false,
  allowEngineer = false,
  deliveryAdmins = [],
  fixedDeliveryAdmin,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userOnly?: boolean;
  allowEngineer?: boolean;
  deliveryAdmins?: Array<{
    id: number;
    username: string;
    displayName?: string | null;
  }>;
  fixedDeliveryAdmin?: {
    id: number;
    username: string;
    displayName?: string | null;
  };
  onCreated?: (userId: number, role: CreatableAccountRole) => void;
}) {
  const utils = trpc.useUtils();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [role, setRole] = useState<CreatableAccountRole>("user");
  const [engineerRoleType, setEngineerRoleType] = useState<
    DeliveryRoleType | ""
  >("");
  const [planCode, setPlanCode] = useState<ProvisionableServicePlanCode | "">(
    "",
  );
  const [marketEdition, setMarketEdition] = useState<AccountMarketEdition | "">(
    "",
  );
  const [deliveryAdminId, setDeliveryAdminId] = useState("");
  const [adminAccessLevel, setAdminAccessLevel] = useState<
    "system_admin" | "delivery_admin"
  >("delivery_admin");
  const effectiveDeliveryAdminId = fixedDeliveryAdmin
    ? String(fixedDeliveryAdmin.id)
    : deliveryAdminId;
  const createMutation = trpc.admin.users.create.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.admin.users.list.invalidate(),
        utils.admin.workspace.list.invalidate(),
        utils.delivery.management.overview.invalidate(),
      ]),
  });

  const reset = () => {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setConfirmPassword("");
    setApiKey("");
    setRole("user");
    setEngineerRoleType("");
    setPlanCode("");
    setMarketEdition("");
    setDeliveryAdminId("");
    setAdminAccessLevel("delivery_admin");
    createMutation.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && createMutation.isPending) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      toast.error("请填写用户名");
      return;
    }
    if (!password) {
      toast.error("请填写初始密码");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`初始密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
      return;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      toast.error(`初始密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符`);
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的初始密码不一致");
      return;
    }
    if (role === "user" && !planCode) {
      toast.error("请选择客户套餐");
      return;
    }
    if (role === "user" && !marketEdition) {
      toast.error("请选择客户版本");
      return;
    }
    if (role === "user" && !apiKey.trim()) {
      toast.error("请填写客户 API Key");
      return;
    }
    if (role === "user" && !effectiveDeliveryAdminId) {
      toast.error("请选择客户主负责人");
      return;
    }
    if (role === "delivery_member" && !engineerRoleType) {
      toast.error("请选择工程师岗位");
      return;
    }

    try {
      const result =
        role === "admin"
          ? await createMutation.mutateAsync({
              username: normalizedUsername,
              displayName: displayName.trim() || undefined,
              password,
              role: "admin",
              adminAccessLevel,
            })
          : role === "delivery_member"
            ? await createMutation.mutateAsync({
                username: normalizedUsername,
                displayName: displayName.trim() || undefined,
                password,
                role: "delivery_member",
                engineerRoleType: engineerRoleType as DeliveryRoleType,
                apiKey: apiKey.trim() || undefined,
              })
            : await createMutation.mutateAsync({
                username: normalizedUsername,
                displayName: displayName.trim() || undefined,
                password,
                role: "user",
                planCode: planCode as ProvisionableServicePlanCode,
                marketEdition: marketEdition as AccountMarketEdition,
                deliveryAdminId: Number(effectiveDeliveryAdminId),
                apiKey: apiKey.trim(),
              });
      toast.success("账号已创建", {
        description: displayName.trim() || normalizedUsername,
      });
      onCreated?.(result.user.id, role);
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error("无法创建账号", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[min(calc(100vw-1rem),720px)] flex-col overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)]">
        <>
          <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pt-6">
            <DialogTitle className="flex items-center gap-2 pr-8">
              <Plus className="h-5 w-5 text-primary" />
              {userOnly && !allowEngineer ? "创建客户账号" : "创建账号"}
            </DialogTitle>
            <DialogDescription>
              {userOnly && allowEngineer
                ? "创建客户或工程师账号。客户自动归属当前交付管理员；工程师岗位创建后固定，API Key 可稍后补充。"
                : userOnly && fixedDeliveryAdmin
                  ? "设置客户初始密码、套餐和有效 API Key；创建后客户自动归属当前交付管理员，账号立即可用。"
                  : userOnly
                    ? "设置客户初始密码、套餐、主负责人和有效 API Key；创建完成后账号立即可用。"
                    : "客户、管理员和工程师均由系统管理员设置初始密码；客户需配置套餐、主负责人和有效 API Key，工程师需固定选择岗位。"}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={handleSubmit}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              {(!userOnly || allowEngineer) && (
                <div className="space-y-2">
                  <Label>账号角色</Label>
                  <Select
                    value={role}
                    onValueChange={(value) => {
                      setRole(value as CreatableAccountRole);
                      setPlanCode("");
                      setMarketEdition("");
                      setEngineerRoleType("");
                      setApiKey("");
                    }}
                    disabled={createMutation.isPending}
                  >
                    <SelectTrigger className="w-full" aria-label="账号角色">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">客户</SelectItem>
                      {!userOnly && (
                        <SelectItem value="admin">管理员</SelectItem>
                      )}
                      <SelectItem value="delivery_member">工程师</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="create-username">用户名</Label>
                  <Input
                    id="create-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="例如 zhangsan"
                    disabled={createMutation.isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-display-name">显示名称（可选）</Label>
                  <Input
                    id="create-display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="例如 张三"
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="create-password">初始密码</Label>
                  <Input
                    id="create-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={MAX_PASSWORD_LENGTH}
                    placeholder={`至少 ${MIN_PASSWORD_LENGTH} 个字符`}
                    disabled={createMutation.isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-confirm-password">确认初始密码</Label>
                  <Input
                    id="create-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={MAX_PASSWORD_LENGTH}
                    placeholder="再次输入初始密码"
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>
              {role === "delivery_member" && (
                <div className="space-y-2">
                  <Label>工程师岗位</Label>
                  <Select
                    value={engineerRoleType}
                    onValueChange={(value) =>
                      setEngineerRoleType(value as DeliveryRoleType)
                    }
                    disabled={createMutation.isPending}
                  >
                    <SelectTrigger className="w-full" aria-label="工程师岗位">
                      <SelectValue placeholder="请选择固定岗位" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(DELIVERY_ROLE_LABELS).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    岗位创建后不可在项目分配时改变；同一工程师可以负责多个客户项目。
                  </p>
                </div>
              )}
              {role === "user" && (
                <>
                  <div className="space-y-2">
                    <Label>客户套餐</Label>
                    <Select
                      value={planCode}
                      onValueChange={(value) =>
                        setPlanCode(value as ProvisionableServicePlanCode)
                      }
                      disabled={createMutation.isPending}
                    >
                      <SelectTrigger className="w-full" aria-label="客户套餐">
                        <SelectValue placeholder="请选择客户套餐" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="basic">普通版</SelectItem>
                        <SelectItem value="advanced">进阶版</SelectItem>
                        <SelectItem value="luxury">豪华版</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>客户版本</Label>
                    <Select
                      value={marketEdition}
                      onValueChange={(value) =>
                        setMarketEdition(value as AccountMarketEdition)
                      }
                      disabled={createMutation.isPending}
                    >
                      <SelectTrigger className="w-full" aria-label="客户版本">
                        <SelectValue placeholder="请选择海内版或海外版" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="domestic">海内版</SelectItem>
                        <SelectItem value="overseas">海外版</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">
                      海外版使用独立的内容资产媒体渠道；其他功能暂与海内版保持一致。
                    </p>
                  </div>
                  {fixedDeliveryAdmin ? (
                    <div className="space-y-2">
                      <Label>客户主负责人</Label>
                      <div className="rounded-md border border-border bg-muted/35 px-3 py-2 text-sm">
                        {fixedDeliveryAdmin.displayName ||
                          fixedDeliveryAdmin.username}{" "}
                        · @{fixedDeliveryAdmin.username}
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        交付管理员创建的客户自动归属当前账号，不能分配给其他管理员。
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>客户主负责人</Label>
                      <Select
                        value={deliveryAdminId}
                        onValueChange={setDeliveryAdminId}
                        disabled={
                          createMutation.isPending ||
                          deliveryAdmins.length === 0
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="客户主负责人"
                        >
                          <SelectValue
                            placeholder={
                              deliveryAdmins.length
                                ? "请选择主负责人"
                                : "暂无可用管理员"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {deliveryAdmins.map((admin) => (
                            <SelectItem key={admin.id} value={String(admin.id)}>
                              {admin.displayName || admin.username} · @
                              {admin.username}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs leading-5 text-muted-foreground">
                        客户主负责人可以是 Admin 或交付管理员，并承担该客户的交付与任务用量归属。
                      </p>
                    </div>
                  )}
                </>
              )}
              {(role === "user" || role === "delivery_member") && (
                <div className="space-y-2">
                  <Label htmlFor="create-api-key">
                    {role === "user"
                      ? "客户 API Key"
                      : "工程师 API Key（可选）"}
                  </Label>
                  <Input
                    id="create-api-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      role === "user"
                        ? "创建前会验证 Key，可与其他客户使用相同原始 Key"
                        : "可留空；创建后由有权限的交付管理员或系统管理员配置"
                    }
                    disabled={createMutation.isPending}
                  />
                  {role === "user" ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Key 将按客户账号独立加密和版本化。以后替换该客户的 Key
                      不会影响其他账号。
                    </p>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      未填写也可以创建账号，列表和客户项目团队会提示“Key
                      未配置”。未分配工程师由创建者管理；只服务单一交付管理员客户时由该管理员管理；跨管理员共享时由系统管理员管理。
                    </p>
                  )}
                </div>
              )}
              {role === "admin" && (
                <div className="space-y-2">
                  <Label>管理员权限</Label>
                  <Select
                    value={adminAccessLevel}
                    onValueChange={(value) =>
                      setAdminAccessLevel(
                        value as "system_admin" | "delivery_admin",
                      )
                    }
                    disabled={createMutation.isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="delivery_admin">交付管理员</SelectItem>
                      <SelectItem value="system_admin">系统管理员</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    交付管理员仅管理被分配客户；系统管理员可调整合同权益、
                    管理账号及官网全局凭据。
                  </p>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/60 px-6 py-4 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={createMutation.isPending}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  createMutation.isPending ||
                  !password ||
                  password !== confirmPassword ||
                  (role === "user" &&
                    (!planCode ||
                      !marketEdition ||
                      !apiKey.trim() ||
                      !effectiveDeliveryAdminId)) ||
                  (role === "delivery_member" && !engineerRoleType)
                }
              >
                {createMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {role === "user"
                  ? "创建客户账号"
                  : role === "delivery_member"
                    ? "创建工程师账号"
                    : "创建管理员"}
              </Button>
            </div>
          </form>
        </>
      </DialogContent>
    </Dialog>
  );
}

export function EngineerApiKeyDialog({
  user,
  onOpenChange,
}: {
  user: AuthUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [apiKey, setApiKey] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const setApiKeyMutation =
    trpc.delivery.management.setEngineerApiKey.useMutation();
  const revokeApiKeyMutation =
    trpc.delivery.management.revokeEngineerApiKey.useMutation();
  const busy = setApiKeyMutation.isPending || revokeApiKeyMutation.isPending;

  const close = () => {
    if (busy) return;
    setApiKey("");
    setRevokeOpen(false);
    setApiKeyMutation.reset();
    revokeApiKeyMutation.reset();
    onOpenChange(false);
  };

  const handleSetApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user || !apiKey.trim()) return;
    try {
      await setApiKeyMutation.mutateAsync({
        engineerUserId: user.id,
        apiKey: apiKey.trim(),
        expectedVersion: user.engineerApiKeyVersion ?? 0,
      });
      await utils.admin.users.list.invalidate();
      await utils.delivery.management.overview.invalidate();
      toast.success(
        user.engineerApiKeyConfigured
          ? "工程师 API Key 已替换"
          : "工程师 API Key 已配置",
        { description: user.displayName || user.username },
      );
      close();
    } catch (error) {
      toast.error("无法配置工程师 API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const handleRevokeApiKey = async () => {
    if (!user) return;
    try {
      await revokeApiKeyMutation.mutateAsync({
        engineerUserId: user.id,
        expectedVersion: user.engineerApiKeyVersion ?? 0,
      });
      await utils.admin.users.list.invalidate();
      await utils.delivery.management.overview.invalidate();
      toast.success("工程师 API Key 已撤销", {
        description: user.displayName || user.username,
      });
      close();
    } catch (error) {
      toast.error("无法撤销工程师 API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <>
      <Dialog open={Boolean(user)} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              管理工程师 API Key
            </DialogTitle>
            <DialogDescription>
              {user?.displayName || user?.username} · @{user?.username}。Key
              只在服务端加密保存，此处不会返回明文。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleSetApiKey}>
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
              当前状态：
              <span
                className={
                  user?.engineerApiKeyConfigured
                    ? "font-medium text-emerald-700"
                    : "font-medium text-amber-700"
                }
              >
                {user?.engineerApiKeyConfigured ? "已配置" : "未配置"}
              </span>
            </div>
            <div className="space-y-2">
              <Label htmlFor="engineer-api-key">
                {user?.engineerApiKeyConfigured ? "新的 API Key" : "API Key"}
              </Label>
              <Input
                id="engineer-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入后将先验证，再加密保存"
                disabled={busy}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                保存成功后只显示配置状态，无法在页面查看原始 Key。
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy || !user?.engineerApiKeyConfigured}
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
                  {setApiKeyMutation.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  验证并{user?.engineerApiKeyConfigured ? "替换" : "配置"}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeOpen}
        onOpenChange={(open) =>
          !revokeApiKeyMutation.isPending && setRevokeOpen(open)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销工程师 API Key</AlertDialogTitle>
            <AlertDialogDescription>
              撤销后，{user?.displayName || user?.username}
              将无法调用通用智能体，直至重新配置有效 Key。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeApiKeyMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={revokeApiKeyMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleRevokeApiKey();
              }}
            >
              {revokeApiKeyMutation.isPending && (
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

function ResetPasswordDialog({
  user,
  onOpenChange,
}: {
  user: AuthUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const resetMutation = trpc.admin.users.resetPassword.useMutation();

  const close = () => {
    if (resetMutation.isPending) return;
    setPassword("");
    setConfirmation("");
    resetMutation.reset();
    onOpenChange(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
      return;
    }
    if (password !== confirmation) {
      toast.error("两次输入的密码不一致");
      return;
    }

    try {
      await resetMutation.mutateAsync({
        userId: user.id,
        newPassword: password,
      });
      toast.success("密码已重置", {
        description: `${user.displayName || user.username} 需要使用新密码重新登录`,
      });
      setPassword("");
      setConfirmation("");
      resetMutation.reset();
      onOpenChange(false);
    } catch (error) {
      toast.error("无法重置密码", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="w-[min(calc(100vw-1rem),440px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <KeyRound className="h-5 w-5 text-primary" />
            重置密码
          </DialogTitle>
          <DialogDescription>
            为 {user?.displayName || user?.username}{" "}
            设置新密码，现有登录会话将失效。
          </DialogDescription>
        </DialogHeader>
        <form className="mt-2 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="reset-password">新密码</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={resetMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-password-confirmation">确认新密码</Label>
            <Input
              id="reset-password-confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={resetMutation.isPending}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={resetMutation.isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={resetMutation.isPending}>
              {resetMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认重置
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
