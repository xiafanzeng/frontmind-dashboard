import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  CheckCircle2,
  Coins,
  Eye,
  EyeOff,
  Fingerprint,
  Info,
  Key,
  Loader2,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  creditEventBus,
  fetchCreditUsage,
  type CreditUsageTask,
} from "@/lib/frontmind-api";
import { trpc } from "@/lib/trpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CredentialStatus = {
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  verifiedAt: Date | number | string | null;
};

const EMPTY_STATUS: CredentialStatus = {
  configured: false,
  fingerprint: null,
  status: null,
  verifiedAt: null,
};

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditTotal, setCreditTotal] = useState<number | null>(null);
  const [creditTasks, setCreditTasks] = useState<CreditUsageTask[]>([]);
  const utils = trpc.useUtils();

  const statusQuery = trpc.credential.status.useQuery(undefined, {
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const setMutation = trpc.credential.set.useMutation();
  const replaceMutation = trpc.credential.replace.useMutation();
  const deleteMutation = trpc.credential.delete.useMutation();

  const status = (statusQuery.data ?? EMPTY_STATUS) as CredentialStatus;
  const saving = setMutation.isPending || replaceMutation.isPending;

  const loadCreditUsage = useCallback(
    async (force = false, fingerprint?: string | null) => {
      setCreditLoading(true);
      try {
        const result = await fetchCreditUsage({
          force,
          fingerprint: fingerprint || undefined,
        });
        setCreditTotal(result.totalUsed);
        setCreditTasks(result.recentTasks);
      } catch {
        setCreditTotal(null);
        setCreditTasks([]);
      } finally {
        setCreditLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setShowApiKey(false);
      setDeleteOpen(false);
      setMutation.reset();
      replaceMutation.reset();
      deleteMutation.reset();
    }
  }, [open]);

  useEffect(() => {
    if (!open || statusQuery.isLoading) return;
    if (!status.configured) {
      setCreditTotal(null);
      setCreditTasks([]);
      return;
    }
    void loadCreditUsage(false, status.fingerprint);
  }, [
    loadCreditUsage,
    open,
    status.configured,
    status.fingerprint,
    statusQuery.isLoading,
  ]);

  useEffect(
    () =>
      creditEventBus.subscribe(() => {
        if (open && status.configured) {
          void loadCreditUsage(true, status.fingerprint);
        }
      }),
    [loadCreditUsage, open, status.configured, status.fingerprint],
  );

  const verifiedLabel = useMemo(() => {
    if (!status.verifiedAt) return null;
    const date =
      status.verifiedAt instanceof Date
        ? status.verifiedAt
        : new Date(status.verifiedAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [status.verifiedAt]);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedKey = apiKey.trim();
    if (!normalizedKey) {
      toast.error("请输入 API Key");
      return;
    }

    try {
      if (status.configured) {
        await replaceMutation.mutateAsync({ apiKey: normalizedKey });
      } else {
        await setMutation.mutateAsync({ apiKey: normalizedKey });
      }
      setCreditTotal(null);
      setCreditTasks([]);
      await utils.credential.status.invalidate();
      setApiKey("");
      setShowApiKey(false);
      toast.success(status.configured ? "API Key 已更换" : "API Key 已保存", {
        description: "已通过服务端验证并加密保存",
      });
    } catch (error) {
      toast.error("API Key 保存失败", {
        description:
          error instanceof Error ? error.message : "请确认 Key 有效后重试",
      });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      await utils.credential.status.invalidate();
      setApiKey("");
      setCreditTotal(null);
      setCreditTasks([]);
      setDeleteOpen(false);
      toast.success("API Key 已删除", {
        description: "历史记录仍可查看，但关联会话可能无法继续运行",
      });
    } catch (error) {
      toast.error("无法删除 API Key", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (saving || deleteMutation.isPending)) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[min(calc(100vw-1rem),560px)] max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden border-border/50 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-lg">
            <Settings className="h-5 w-5 text-primary" />
            API Key 设置
          </DialogTitle>
          <DialogDescription className="break-words text-sm text-muted-foreground">
            Key 由服务端验证并加密保存，积分统计通过安全代理读取。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 min-w-0 space-y-5">
          <section className="rounded-xl border border-border/60 bg-muted/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="h-4 w-4 text-primary" />
                云端凭据状态
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-xs"
                disabled={statusQuery.isFetching}
                onClick={() => void statusQuery.refetch()}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${statusQuery.isFetching ? "animate-spin" : ""}`}
                />
                刷新
              </Button>
            </div>

            {statusQuery.isLoading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取凭据状态
              </div>
            ) : statusQuery.error ? (
              <div className="flex items-start gap-2 rounded-lg bg-destructive/8 p-3 text-sm text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">状态读取失败</p>
                  <p className="mt-0.5 text-xs opacity-80">
                    {statusQuery.error.message}
                  </p>
                </div>
              </div>
            ) : status.configured ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CredentialBadge status={status.status} />
                  {verifiedLabel && (
                    <span className="text-xs text-muted-foreground">
                      验证于 {verifiedLabel}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
                  <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Key 指纹
                  </span>
                  <code className="min-w-0 flex-1 truncate text-right text-xs font-medium text-foreground">
                    {status.fingerprint || "已安全保存"}
                  </code>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-dashed border-border/70 bg-background/40 p-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                尚未配置 API Key。保存后可在当前账号的所有设备使用。
              </div>
            )}
          </section>

          <section className="rounded-xl border border-primary/10 bg-primary/5 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Coins className="h-4 w-4 text-primary" />近 30 天积分使用
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-xs"
                disabled={!status.configured || creditLoading}
                onClick={() => void loadCreditUsage(true, status.fingerprint)}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${creditLoading ? "animate-spin" : ""}`}
                />
                {creditLoading ? "刷新中" : "刷新积分"}
              </Button>
            </div>

            {!status.configured ? (
              <p className="text-sm text-muted-foreground">
                配置并验证 API Key 后即可查看积分使用情况。
              </p>
            ) : creditLoading && creditTotal === null ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在读取积分记录
              </div>
            ) : creditTotal !== null ? (
              <div className="space-y-3">
                <div className="flex items-end justify-between gap-3 rounded-lg border border-primary/10 bg-background/70 px-3.5 py-3">
                  <span className="text-sm text-muted-foreground">已使用</span>
                  <span className="text-xl font-semibold tracking-tight text-primary">
                    {creditTotal.toLocaleString()} 积分
                  </span>
                </div>

                {creditTasks.length > 0 ? (
                  <div className="space-y-1 border-t border-primary/10 pt-3">
                    <p className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                      最近任务明细
                    </p>
                    <div className="custom-scrollbar max-h-[180px] space-y-1 overflow-y-auto">
                      {creditTasks.map((task) => (
                        <div
                          key={task.id}
                          className="flex min-w-0 items-center justify-between gap-3 rounded-md px-1 py-1 text-[11px]"
                        >
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {task.title || "未命名任务"}
                            {task.createdAt && (
                              <span className="ml-1 text-muted-foreground/50">
                                {task.createdAt}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-mono text-foreground/75">
                            {task.creditUsage}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    最近 30 天暂无已记录的积分消耗。
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂时无法读取积分记录，请稍后刷新。
              </p>
            )}
          </section>

          <form className="space-y-4" onSubmit={handleSave}>
            <div className="space-y-2">
              <Label
                htmlFor="frontmind-api-key"
                className="flex items-center gap-1.5"
              >
                <Key className="h-3.5 w-3.5 text-muted-foreground" />
                {status.configured ? "输入新的 API Key" : "API Key"}
              </Label>
              <div className="relative">
                <Input
                  id="frontmind-api-key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    status.configured
                      ? "留空不会更改当前 Key"
                      : "填写 FrontMind API Key"
                  }
                  type={showApiKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving || statusQuery.isLoading}
                  className="min-w-0 border-border/60 bg-muted/20 pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                  aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                为保护凭据安全，已保存的 Key 不会再次显示，也不会发送回浏览器。
              </p>
            </div>

            {status.configured && (
              <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-muted/20 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  更换后，新会话会使用新的 Key；已有会话仍保留原有凭据关联。
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              {status.configured ? (
                <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={saving || deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除 Key
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>删除 API Key？</AlertDialogTitle>
                      <AlertDialogDescription>
                        删除后，历史记录仍可查看，但依赖该凭据的会话将不能继续运行。此操作不会在浏览器保留
                        Key 副本。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={deleteMutation.isPending}>
                        取消
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-white hover:bg-destructive/90"
                        disabled={deleteMutation.isPending}
                        onClick={(event) => {
                          event.preventDefault();
                          void handleDelete();
                        }}
                      >
                        {deleteMutation.isPending && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        确认删除
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <span />
              )}

              <Button
                type="submit"
                className="gap-2"
                disabled={saving || !apiKey.trim()}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving
                  ? "正在验证并保存"
                  : status.configured
                    ? "验证并更换"
                    : "验证并保存"}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CredentialBadge({ status }: { status: CredentialStatus["status"] }) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-200 bg-emerald-50 text-emerald-700"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        已验证
      </Badge>
    );
  }

  if (status === "invalid") {
    return (
      <Badge
        variant="outline"
        className="border-red-200 bg-red-50 text-red-700"
      >
        <XCircle className="mr-1 h-3 w-3" />
        验证失败
      </Badge>
    );
  }

  return (
    <Badge variant="secondary">
      {status === "retired" ? "已停用" : "已保存"}
    </Badge>
  );
}
