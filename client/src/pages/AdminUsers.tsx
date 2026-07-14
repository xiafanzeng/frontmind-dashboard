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
  UserRoundCheck,
  UserRoundX,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth, type AuthUser } from "@/_core/hooks/useAuth";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@shared/auth-constraints";
import { trpc } from "@/lib/trpc";
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

export default function AdminUsers() {
  const [, setLocation] = useLocation();
  const { user: currentUser } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<AuthUser | null>(null);
  const [statusChange, setStatusChange] = useState<StatusChange | null>(null);

  const usersQuery = trpc.admin.users.list.useQuery(undefined, {
    enabled: currentUser?.role === "admin",
    retry: false,
  });
  const utils = trpc.useUtils();
  const setActiveMutation = trpc.admin.users.setActive.useMutation({
    onSuccess: () => utils.admin.users.list.invalidate(),
  });

  const users = (usersQuery.data?.users ?? []) as AuthUser[];
  const activeCount = useMemo(
    () => users.filter((account) => account.isActive).length,
    [users]
  );

  const applyStatusChange = async () => {
    if (!statusChange) return;
    try {
      await setActiveMutation.mutateAsync({
        userId: statusChange.user.id,
        isActive: statusChange.isActive,
      });
      toast.success(statusChange.isActive ? "账号已启用" : "账号已禁用", {
        description: statusChange.user.displayName || statusChange.user.username,
      });
      setStatusChange(null);
    } catch (error) {
      toast.error("无法更新账号状态", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  if (currentUser?.role !== "admin") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-10 text-center">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h1 className="text-xl font-semibold">没有访问权限</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              账号管理仅对管理员开放。
            </p>
            <Button className="mt-6" variant="outline" onClick={() => setLocation("/")}>
              <ArrowLeft className="h-4 w-4" />
              返回工作空间
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-background">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(750px circle at 18% 0%, oklch(0.88 0.03 178 / 34%), transparent 52%), linear-gradient(180deg, oklch(0.988 0.006 83), oklch(0.965 0.011 83))",
        }}
      />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              className="shrink-0 bg-card/80"
              onClick={() => setLocation("/")}
              aria-label="返回工作空间"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 shrink-0 text-primary" />
                <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                  账号管理
                </h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                创建员工账号、重置密码及控制访问权限。
              </p>
            </div>
          </div>

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
        </header>

        <section className="mb-5 grid gap-3 sm:grid-cols-3">
          <MetricCard label="账号总数" value={users.length} />
          <MetricCard label="已启用" value={activeCount} tone="positive" />
          <MetricCard
            label="管理员"
            value={users.filter((account) => account.role === "admin").length}
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
                    isCurrent={account.id === currentUser.id}
                    pending={
                      setActiveMutation.isPending &&
                      statusChange?.user.id === account.id
                    }
                    onResetPassword={() => setResetUser(account)}
                    onChangeStatus={(isActive) =>
                      setStatusChange({ user: account, isActive })
                    }
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ResetPasswordDialog user={resetUser} onOpenChange={(open) => !open && setResetUser(null)} />

      <AlertDialog
        open={Boolean(statusChange)}
        onOpenChange={(open) => !open && !setActiveMutation.isPending && setStatusChange(null)}
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
              className={statusChange?.isActive ? "" : "bg-destructive text-white hover:bg-destructive/90"}
            >
              {setActiveMutation.isPending && <Loader2 className="animate-spin" />}
              确认{statusChange?.isActive ? "启用" : "禁用"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
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
        <span className={tone === "positive" ? "text-xl font-semibold text-emerald-600" : "text-xl font-semibold"}>
          {value}
        </span>
      </CardContent>
    </Card>
  );
}

function UserRow({
  account,
  isCurrent,
  pending,
  onResetPassword,
  onChangeStatus,
}: {
  account: AuthUser;
  isCurrent: boolean;
  pending: boolean;
  onResetPassword: () => void;
  onChangeStatus: (isActive: boolean) => void;
}) {
  const name = account.displayName || account.username;
  const initials = Array.from(name).slice(0, 2).join("").toUpperCase();

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
            {isCurrent && <Badge variant="outline" className="text-[10px]">当前账号</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">@{account.username}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-[52px] sm:pl-0">
        <Badge variant={account.role === "admin" ? "default" : "secondary"}>
          {account.role === "admin" ? (
            <ShieldCheck className="mr-1 h-3 w-3" />
          ) : null}
          {account.role === "admin" ? "管理员" : "员工"}
        </Badge>
        <Badge variant="outline" className={account.isActive ? "text-emerald-700" : "text-muted-foreground"}>
          {account.isActive ? "已启用" : "已禁用"}
        </Badge>
      </div>

      <div className="flex gap-2 pl-[52px] sm:pl-0">
        <Button size="sm" variant="outline" onClick={onResetPassword}>
          <KeyRound className="h-3.5 w-3.5" />
          重置密码
        </Button>
        <Button
          size="sm"
          variant={account.isActive ? "outline" : "default"}
          disabled={pending || isCurrent}
          title={isCurrent ? "不能在此处禁用当前账号" : undefined}
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
      </div>
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const createMutation = trpc.admin.users.create.useMutation({
    onSuccess: () => utils.admin.users.list.invalidate(),
  });

  const reset = () => {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("user");
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
    if (!normalizedUsername || !password) {
      toast.error("请填写用户名和初始密码");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`初始密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
      return;
    }

    try {
      await createMutation.mutateAsync({
        username: normalizedUsername,
        displayName: displayName.trim() || undefined,
        password,
        role,
      });
      toast.success("账号已创建", { description: displayName.trim() || normalizedUsername });
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
      <DialogContent className="w-[min(calc(100vw-1rem),480px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Plus className="h-5 w-5 text-primary" />
            创建账号
          </DialogTitle>
          <DialogDescription>员工首次登录后可以自行修改密码并配置 API Key。</DialogDescription>
        </DialogHeader>
        <form className="mt-2 space-y-4" onSubmit={handleSubmit}>
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
            <Label>账号角色</Label>
            <Select value={role} onValueChange={(value) => setRole(value as "user" | "admin")} disabled={createMutation.isPending}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">员工</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={createMutation.isPending}>
              取消
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              创建账号
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
      await resetMutation.mutateAsync({ userId: user.id, newPassword: password });
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
            为 {user?.displayName || user?.username} 设置新密码，现有登录会话将失效。
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
            <Button type="button" variant="outline" onClick={close} disabled={resetMutation.isPending}>
              取消
            </Button>
            <Button type="submit" disabled={resetMutation.isPending}>
              {resetMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              确认重置
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
