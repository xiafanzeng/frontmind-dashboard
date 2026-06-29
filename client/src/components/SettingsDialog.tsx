/**
 * SettingsDialog Component - API configuration
 * Design: Compact settings dialog for key setup, connection test, and credit usage.
 */
import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  getConfig,
  saveConfig,
  testConnection,
  fetchCreditUsage,
  creditEventBus,
} from "@/lib/frontmind-api";
import { toast } from "sonner";
import {
  Settings,
  Key,
  Save,
  Wifi,
  WifiOff,
  Loader2,
  Info,
  Eye,
  EyeOff,
  Coins,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_TEST_DISPLAY_MS = 500;

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CreditTask = {
  id: string;
  title?: string;
  creditUsage: number;
  createdAt?: string;
};

export default function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testLatencyMs, setTestLatencyMs] = useState<number | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const [creditLoading, setCreditLoading] = useState(false);
  const [creditTotal, setCreditTotal] = useState<number | null>(null);
  const [creditTasks, setCreditTasks] = useState<CreditTask[]>([]);

  const loadCreditUsage = useCallback(async (force = false) => {
    setCreditLoading(true);
    try {
      const result = await fetchCreditUsage({ force });
      setCreditTotal(result.totalUsed);
      setCreditTasks(result.recentTasks);
    } catch {
      setCreditTotal(null);
      setCreditTasks([]);
    } finally {
      setCreditLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      const config = getConfig();
      setApiKey(config.apiKey);
      setTestResult(null);
      setTestLatencyMs(null);
      loadCreditUsage(false);
    }
  }, [open, loadCreditUsage]);

  useEffect(() => {
    const unsubscribe = creditEventBus.subscribe(() => {
      loadCreditUsage(true);
    });
    return unsubscribe;
  }, [loadCreditUsage]);

  const handleSave = () => {
    if (!apiKey.trim()) {
      toast.error("请输入 API Key");
      return;
    }

    const currentConfig = getConfig();
    const keyChanged = apiKey.trim() !== currentConfig.apiKey;

    saveConfig({
      baseUrl: currentConfig.baseUrl,
      apiKey: apiKey.trim(),
      agentProfile: currentConfig.agentProfile,
    });

    if (keyChanged) {
      toast.success("API Key 已更新，已自动切换到新内容流程", {
        description: "更换 Key 后需要在新内容流程中继续对话",
        duration: 5000,
      });
    } else {
      toast.success("设置已保存");
    }
    onOpenChange(false);
  };

  const handleTest = async () => {
    if (!apiKey.trim()) {
      toast.error("请先填写 API Key");
      return;
    }

    setTesting(true);
    setTestResult(null);
    setTestLatencyMs(null);

    const startTime = Date.now();

    try {
      const currentConfig = getConfig();
      saveConfig({
        baseUrl: currentConfig.baseUrl,
        apiKey: apiKey.trim(),
        agentProfile: currentConfig.agentProfile,
      });

      const result = await testConnection();
      const latency = Date.now() - startTime;
      setTestLatencyMs(latency);

      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_TEST_DISPLAY_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_TEST_DISPLAY_MS - elapsed));
      }

      if (result.ok) {
        setTestResult("success");
        toast.success(`连接成功！延迟 ${latency}ms`);
      } else {
        setTestResult("error");
        toast.error(`连接失败: ${result.message}`);
      }
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_TEST_DISPLAY_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_TEST_DISPLAY_MS - elapsed));
      }

      setTestResult("error");
      toast.error("连接失败", {
        description: err.message || "未知错误",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1rem),500px)] max-w-[calc(100vw-1rem)] border-border/30 max-h-[calc(100dvh-1rem)] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-lg">
            <Settings className="w-5 h-5 text-primary" />
            API 设置
          </DialogTitle>
          <DialogDescription className="break-words text-muted-foreground text-sm">
            配置 FrontMind Studio 连接参数并查看当前积分使用。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 min-w-0 space-y-5">
          <div className="min-w-0 rounded-xl border border-primary/10 bg-primary/5 p-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Info className="h-4 w-4 text-primary" />
              使用教程（仅每次更换key的首次需要）
            </div>
            <div className="mt-3 grid min-w-0 gap-2 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2">
              {[
                { index: 1, text: "填入 API Key到下方" },
                { index: 2, text: "点击“测试连接”，确认网络状态" },
                { index: 3, text: "点击刷新积分，查看当前已使用积分" },
                { index: 4, text: "确认无误后保存设置，开始使用" },
              ].map((step) => (
                <div key={step.index} className="flex min-w-0 items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                    {step.index}
                  </span>
                  <span className="min-w-0 break-words">{step.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-sm font-medium">
              <Key className="w-3.5 h-3.5 text-muted-foreground" />
              API Key
            </Label>
            <div className="relative">
              <Input
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                placeholder="填写 API Key"
                type={showApiKey ? "text" : "password"}
                className="min-w-0 bg-muted/30 border-border/40 focus:border-primary/50 font-mono text-xs pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="flex items-center gap-1.5 text-sm font-medium">
                <Coins className="w-3.5 h-3.5 text-muted-foreground" />
                积分使用情况
              </Label>
              <button
                type="button"
                onClick={() => loadCreditUsage(true)}
                disabled={creditLoading}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                title="刷新积分信息"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", creditLoading && "animate-spin")} />
                {creditLoading ? "刷新中" : "刷新积分"}
              </button>
            </div>
            <div className="min-w-0 overflow-hidden rounded-xl bg-muted/30 border border-border/40 p-3">
              {creditLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  加载中...
                </div>
              ) : creditTotal !== null ? (
                <div className="min-w-0 space-y-3">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="shrink-0 text-sm text-muted-foreground">已使用</span>
                    <span className="min-w-0 truncate text-right text-lg font-bold text-primary">
                      {creditTotal.toLocaleString()} 积分
                    </span>
                  </div>

                  {creditTasks.length > 0 && (
                    <div className="min-w-0 space-y-1 pt-1 border-t border-border/30">
                      <p className="text-[10px] text-muted-foreground/50 mb-1">最近30天任务明细</p>
                      <div className="max-h-[180px] min-w-0 overflow-y-auto overflow-x-hidden custom-scrollbar space-y-0.5">
                        {creditTasks.map((task) => (
                          <div key={task.id} className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {task.title || "未命名任务"}
                              {task.createdAt && (
                                <span className="ml-1 text-muted-foreground/40">({task.createdAt})</span>
                              )}
                            </span>
                            <span className="ml-2 shrink-0 font-mono text-foreground/70">{task.creditUsage}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground/60">
                  请先配置 API Key 并测试连接
                </p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-muted/25 border border-border/40">
            <Info className="w-4 h-4 text-primary/60 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              保存后，新的内容流程会使用当前 Key 和模型设置；如更换 Key，建议先测试连接再继续工作。
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={handleTest}
              variant="outline"
              disabled={testing}
              className={cn(
                "flex-1 gap-2",
                testResult === "success" && "border-emerald-300 text-emerald-600",
                testResult === "error" && "border-red-300 text-red-600"
              )}
            >
              {testing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : testResult === "success" ? (
                <Wifi className="w-4 h-4" />
              ) : testResult === "error" ? (
                <WifiOff className="w-4 h-4" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              {testing
                ? "测试中..."
                : testResult === "success"
                  ? `连接正常${testLatencyMs != null ? ` (${testLatencyMs}ms)` : ""}`
                  : testResult === "error"
                    ? "连接失败"
                    : "测试连接"}
            </Button>
            <Button onClick={handleSave} className="flex-1 gap-2">
              <Save className="w-4 h-4" />
              保存设置
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
