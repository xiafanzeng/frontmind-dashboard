import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Coins,
  Eye,
  EyeOff,
  Info,
  Key,
  Loader2,
  RefreshCw,
  Save,
  Settings,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import {
  isDeliveryAdminAccount,
  isSystemAdminAccount,
} from "@/lib/admin-access";
import {
  creditEventBus,
  fetchCreditUsage,
  type CreditUsageTask,
} from "@/lib/frontmind-api";
import { trpc } from "@/lib/trpc";
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
};

const EMPTY_STATUS: CredentialStatus = {
  configured: false,
  fingerprint: null,
};

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(
    null,
  );
  const [testLatencyMs, setTestLatencyMs] = useState<number | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditTotal, setCreditTotal] = useState<number | null>(null);
  const [creditTasks, setCreditTasks] = useState<CreditUsageTask[]>([]);
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const showCreditUsage =
    isSystemAdminAccount(user) || isDeliveryAdminAccount(user);

  const statusQuery = trpc.credential.status.useQuery(undefined, {
    enabled: open && showCreditUsage,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const setMutation = trpc.credential.set.useMutation();
  const replaceMutation = trpc.credential.replace.useMutation();
  const testMutation = trpc.credential.test.useMutation();

  const status = (statusQuery.data ?? EMPTY_STATUS) as CredentialStatus;
  const saving = setMutation.isPending || replaceMutation.isPending;

  const loadCreditUsage = useCallback(
    async (force = false, fingerprint?: string | null) => {
      setCreditLoading(true);
      try {
        const result = await fetchCreditUsage({
          force,
          fingerprint: fingerprint || undefined,
          accountId: user?.id,
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
    [user?.id],
  );

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setShowApiKey(false);
      setTestResult(null);
      setTestLatencyMs(null);
      setCreditTotal(null);
      setCreditTasks([]);
      setMutation.reset();
      replaceMutation.reset();
      testMutation.reset();
    }
  }, [open]);

  useEffect(() => {
    if (!showCreditUsage) {
      setCreditTotal(null);
      setCreditTasks([]);
      return;
    }
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
    showCreditUsage,
    status.configured,
    status.fingerprint,
    statusQuery.isLoading,
  ]);

  useEffect(() => {
    if (!showCreditUsage) return undefined;
    return creditEventBus.subscribe(() => {
      if (open && status.configured) {
        void loadCreditUsage(true, status.fingerprint);
      }
    });
  }, [
    loadCreditUsage,
    open,
    showCreditUsage,
    status.configured,
    status.fingerprint,
  ]);

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
      setTestResult("success");
      setTestLatencyMs(null);
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

  const handleTest = async () => {
    const normalizedKey = apiKey.trim();
    if (!normalizedKey && !status.configured) {
      toast.error("请先填写 API Key");
      return;
    }

    setTestResult(null);
    setTestLatencyMs(null);
    const startedAt = performance.now();
    try {
      await testMutation.mutateAsync({
        apiKey: normalizedKey || undefined,
      });
      const latency = Math.max(1, Math.round(performance.now() - startedAt));
      setTestLatencyMs(latency);
      setTestResult("success");
      toast.success("连接成功", {
        description: `FrontMind API 响应正常 · ${latency}ms`,
      });
    } catch (error) {
      setTestResult("error");
      toast.error("连接测试失败", {
        description:
          error instanceof Error ? error.message : "请检查 API Key 后重试",
      });
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (saving || testMutation.isPending)) return;
    onOpenChange(nextOpen);
  };

  if (!showCreditUsage) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[min(calc(100vw-1rem),460px)] max-w-[calc(100vw-1rem)] border-border/50 p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-8 text-lg">
              <Settings className="h-5 w-5 text-primary" />
              智能服务设置
            </DialogTitle>
            <DialogDescription className="text-sm leading-6 text-muted-foreground">
              智能服务由负责管理员统一维护，您可以直接使用当前套餐已开放的功能。
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[min(calc(100vw-1rem),560px)] max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden border-border/50 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-lg">
            <Settings className="h-5 w-5 text-primary" />
            API Key 设置
          </DialogTitle>
          <DialogDescription className="break-words text-sm text-muted-foreground">
            配置并测试 FrontMind API Key，查看当前账号的积分使用情况。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 min-w-0 space-y-5">
          <section className="rounded-xl border border-primary/10 bg-primary/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4 text-primary" />
              API Key 使用教程
            </div>
            <div className="mt-3 grid gap-2.5 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2">
              {[
                "在 FrontMind 服务中心获取 API Key",
                "将 API Key 粘贴到下方输入框",
                "点击“测试连接”确认 Key 可用",
                "验证并保存后，即可跨设备安全使用",
              ].map((step, index) => (
                <div key={step} className="flex min-w-0 items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {index + 1}
                  </span>
                  <span className="min-w-0 break-words">{step}</span>
                </div>
              ))}
            </div>
          </section>

          {showCreditUsage && (
            <section className="rounded-xl border border-primary/10 bg-primary/5 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Coins className="h-4 w-4 text-primary" />
                  当前 Key 本月总积分
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
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    同一 API Key 可供多个账号共享。总积分反映整个 Key
                    池的消耗，最近任务明细仅显示当前账号创建的任务。
                  </p>
                  <div className="flex items-end justify-between gap-3 rounded-lg border border-primary/10 bg-background/70 px-3.5 py-3">
                    <span className="text-sm text-muted-foreground">
                      已使用
                    </span>
                    <span className="text-xl font-semibold tracking-tight text-primary">
                      {creditTotal.toLocaleString()} 积分
                    </span>
                  </div>

                  {creditTasks.length > 0 ? (
                    <div className="space-y-1 border-t border-primary/10 pt-3">
                      <p className="mb-1.5 text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
                        最近任务明细
                      </p>
                      <div className="custom-scrollbar max-h-[180px] space-y-1 overflow-y-auto">
                        {creditTasks.map((task) => (
                          <div
                            key={task.id}
                            className="flex min-w-0 items-center justify-between gap-3 rounded-md px-1 py-1 text-xs"
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
                      本月暂无已记录的积分消耗。
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  暂时无法读取积分记录，请稍后刷新。
                </p>
              )}
            </section>
          )}

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
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setTestResult(null);
                    setTestLatencyMs(null);
                  }}
                  placeholder={
                    status.configured
                      ? "留空不会更改当前 Key"
                      : "填写 FrontMind API Key"
                  }
                  type={showApiKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={
                    saving || testMutation.isPending || statusQuery.isLoading
                  }
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
              <p className="text-xs leading-relaxed text-muted-foreground">
                {status.configured
                  ? "当前账号已配置 Key；留空可直接测试现有连接，填写新 Key 后可验证并更换。"
                  : "Key 验证通过后会加密保存，登录同一账号即可在其他设备使用。"}
              </p>
              {statusQuery.error && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <XCircle className="h-3.5 w-3.5" />
                  无法读取当前配置，请刷新页面后重试。
                </p>
              )}
            </div>

            {status.configured && (
              <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-muted/20 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  更换后，新会话会使用新的 Key；已有会话仍保留原有凭据关联。
                </p>
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                className={
                  testResult === "success"
                    ? "gap-2 border-emerald-300 text-emerald-700"
                    : testResult === "error"
                      ? "gap-2 border-red-300 text-red-600"
                      : "gap-2"
                }
                disabled={
                  saving ||
                  testMutation.isPending ||
                  (!apiKey.trim() && !status.configured)
                }
                onClick={() => void handleTest()}
              >
                {testMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : testResult === "error" ? (
                  <WifiOff className="h-4 w-4" />
                ) : (
                  <Wifi className="h-4 w-4" />
                )}
                {testMutation.isPending
                  ? "测试中"
                  : testResult === "success"
                    ? `连接正常${testLatencyMs ? ` · ${testLatencyMs}ms` : ""}`
                    : testResult === "error"
                      ? "连接失败"
                      : "测试连接"}
              </Button>

              <Button
                type="submit"
                className="gap-2"
                disabled={saving || testMutation.isPending || !apiKey.trim()}
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
