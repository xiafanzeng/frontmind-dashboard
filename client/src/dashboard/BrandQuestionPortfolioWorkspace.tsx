import {
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

import {
  isTerminalBrandQuestionTaskFailure,
  parseStoredBrandQuestionTask,
  serializeStoredBrandQuestionTask,
  type StoredBrandQuestionTask,
} from "./brand-question-task";
import type { ServicePortalView } from "./service-portal";

type PortfolioQuestion = {
  id: string;
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario";
  question: string;
  intent: string | null;
  rationale: string | null;
  evidence: Array<{
    documentPath: string;
    excerpt: string;
    relevance: string;
  }>;
  risks: string[];
  status: "candidate" | "selected" | "archived";
  selectionApprovalStatus: "not_requested" | "pending" | "approved";
  locked: boolean;
  revision: number;
};

export type BrandQuestionSelectionDraft = Pick<
  PortfolioQuestion,
  "id" | "question" | "category" | "revision" | "status"
>;

const CATEGORY_META = {
  industry: {
    title: "行业词",
    description: "行业入口与品类决策问题",
  },
  competitor_comparison: {
    title: "竞品对比词",
    description: "差异定位与选择依据",
  },
  reputation: {
    title: "美誉舆情词",
    description: "信任证据与品牌口碑",
  },
  product_scenario: {
    title: "产品场景词",
    description: "应用需求与决策场景",
  },
} as const;

const CATEGORY_ORDER = [
  "industry",
  "competitor_comparison",
  "reputation",
  "product_scenario",
] as const;

async function readApiError(response: Response) {
  try {
    const body = await response.json();
    return {
      code: String(body?.error?.code || body?.code || ""),
      message: body?.error?.message || body?.message || "请求失败",
    };
  } catch {
    return { code: "", message: `请求失败 (${response.status})` };
  }
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export default function BrandQuestionPortfolioWorkspace({
  portal,
  onPortalRefresh,
  onUseQuestion,
}: {
  portal: ServicePortalView;
  onPortalRefresh?: () => void;
  onUseQuestion: (question: BrandQuestionSelectionDraft) => void;
}) {
  const taskStorageKey = `frontmind:brand-question-task:${
    portal.account.username || "current"
  }`;
  const [taskState, setTaskState] = useState<StoredBrandQuestionTask | null>(
    () => {
      if (typeof window === "undefined") return null;
      return parseStoredBrandQuestionTask(
        window.sessionStorage.getItem(taskStorageKey),
      );
    },
  );
  const taskId = taskState?.taskId ?? "";
  const startedAt = taskState?.startedAt ?? null;
  const [elapsed, setElapsed] = useState(0);
  const [starting, setStarting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncInFlightRef = useRef(false);
  const portfolioQuery = (trpc.workspace as any).questionPortfolio.useQuery(
    undefined,
    {
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  ) as {
    data?: {
      questions?: PortfolioQuestion[];
    };
    isLoading: boolean;
    isFetching: boolean;
    refetch: () => Promise<unknown>;
  };
  const visibleQuestions = portfolioQuery.data?.questions ?? [];

  useEffect(() => {
    if (!taskState) {
      window.sessionStorage.removeItem(taskStorageKey);
      return;
    }
    window.sessionStorage.setItem(
      taskStorageKey,
      serializeStoredBrandQuestionTask(taskState),
    );
    const timer = window.setInterval(() => {
      if (startedAt) setElapsed(Date.now() - startedAt);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt, taskState, taskStorageKey]);

  const clearTask = () => {
    window.sessionStorage.removeItem(taskStorageKey);
    setTaskState(null);
    setElapsed(0);
  };

  const syncTask = async (silent = false) => {
    if (!taskState || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setSyncing(true);
    try {
      const response = await fetch("/api/brand-question-portfolio/sync", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: taskState.taskId,
          contextToken: taskState.contextToken,
        }),
      });
      if (response.status === 202) return;
      if (!response.ok) {
        const failure = await readApiError(response);
        if (
          isTerminalBrandQuestionTaskFailure({
            status: response.status,
            code: failure.code,
          })
        ) {
          clearTask();
          toast.error("候选问题任务未完成", {
            description: `${failure.message}，现在可以重新生成。`,
          });
          return;
        }
        throw new Error(failure.message);
      }
      await response.json();
      clearTask();
      await portfolioQuery.refetch();
      onPortalRefresh?.();
      toast.success("候选问题已更新", {
        description: "请按当前服务额度确认本周期问题。",
      });
    } catch (error) {
      if (!silent) {
        toast.error("候选问题同步失败", {
          description: error instanceof Error ? error.message : "请稍后重试",
        });
      }
    } finally {
      syncInFlightRef.current = false;
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!taskId) return;
    const timer = window.setInterval(() => void syncTask(true), 4_000);
    void syncTask(true);
    return () => window.clearInterval(timer);
    // The ref prevents overlapping reads while retaining one polling timer per
    // task identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const startGeneration = async () => {
    setStarting(true);
    try {
      const response = await fetch("/api/brand-question-portfolio/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const failure = await readApiError(response);
        throw new Error(failure.message);
      }
      const body = await response.json();
      const nextTaskId = String(body?.task?.id || "");
      const contextToken = String(body?.contextToken || "");
      if (!nextTaskId) throw new Error("候选问题任务未返回标识");
      if (!contextToken) throw new Error("候选问题任务未返回安全上下文");
      const nextStartedAt = Number(body?.startedAt) || Date.now();
      const nextTask = {
        taskId: nextTaskId,
        contextToken,
        startedAt: nextStartedAt,
      };
      setTaskState(nextTask);
      setElapsed(Date.now() - nextStartedAt);
      window.sessionStorage.setItem(
        taskStorageKey,
        serializeStoredBrandQuestionTask(nextTask),
      );
      toast.success("候选问题生成已开始");
    } catch (error) {
      toast.error("无法生成候选问题", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setStarting(false);
    }
  };

  const selectedByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const question of visibleQuestions) {
      if (question.status === "selected") {
        counts.set(question.category, (counts.get(question.category) ?? 0) + 1);
      }
    }
    return counts;
  }, [visibleQuestions]);

  return (
    <section className="page-shell brand-deep-page">
      <div className="flex flex-col gap-5 rounded-[24px] border border-[#e6ddea] bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="fm-eyebrow text-[#6b378f]">
              MindPromise 智诺 · 品牌建设
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-[#1f1830]">
              品牌全域词库
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#716a80]">
              候选问题只基于当前已发布的企业知识库生成。选择问题后会进入问题优化，由您提交管理员确认；管理员确认启动后才会锁定并占用额度。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={portfolioQuery.isFetching}
              onClick={() => void portfolioQuery.refetch()}
            >
              <RefreshCw
                className={`h-4 w-4 ${
                  portfolioQuery.isFetching ? "animate-spin" : ""
                }`}
              />
              刷新
            </Button>
            <Button
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={starting || Boolean(taskId)}
              onClick={() => void startGeneration()}
            >
              {starting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {visibleQuestions.length ? "重新生成候选问题" : "生成候选问题"}
            </Button>
          </div>
        </div>

        {taskId && (
          <div
            className="flex flex-col gap-3 rounded-2xl border border-[#d9c8e5] bg-[#f8f3fb] p-4 sm:flex-row sm:items-center sm:justify-between"
            role="status"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-[#5b2a86]" />
              <div>
                <p className="text-sm font-semibold text-[#332842]">
                  正在分析知识库并生成企业专属候选问题
                </p>
                <p className="mt-1 text-xs text-[#716a80]">
                  执行时间 {formatDuration(elapsed)}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={syncing}
              onClick={() => void syncTask()}
            >
              {syncing && <Loader2 className="h-4 w-4 animate-spin" />}
              检查结果
            </Button>
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        {CATEGORY_ORDER.map((category) => {
          const meta = CATEGORY_META[category];
          const categoryQuestions = visibleQuestions.filter(
            (question) => question.category === category,
          );
          const selectedCount = selectedByCategory.get(category) ?? 0;
          return (
            <section
              key={category}
              className="overflow-hidden rounded-[22px] border border-[#e6ddea] bg-white shadow-sm"
            >
              <header className="border-b border-[#eee8f2] p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-[#251d33]">
                      {meta.title}
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-[#857e91]">
                      {meta.description}
                    </p>
                  </div>
                  {selectedCount > 0 && (
                    <span className="text-xs font-semibold text-[#16794f]">
                      已确认 {selectedCount}
                    </span>
                  )}
                </div>
              </header>
              <div className="divide-y divide-[#f0ebf3]">
                {portfolioQuery.isLoading ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-[#716a80]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    读取候选问题中…
                  </div>
                ) : categoryQuestions.length === 0 ? (
                  <div className="p-8 text-center text-sm leading-6 text-[#857e91]">
                    当前没有可展示的{meta.title}候选项。
                  </div>
                ) : (
                  categoryQuestions.map((question) => {
                    const selected = question.status === "selected";
                    const pending =
                      question.selectionApprovalStatus === "pending";
                    return (
                      <article key={question.id} className="p-5">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 text-[#6b378f]">
                            {selected ? (
                              <CheckCircle2 className="h-5 w-5 text-[#16794f]" />
                            ) : (
                              <Clock3 className="h-5 w-5" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold leading-6 text-[#30263e]">
                              {question.question}
                            </h3>
                            {question.rationale && (
                              <p className="mt-2 text-xs leading-5 text-[#716a80]">
                                {question.rationale}
                              </p>
                            )}
                            {question.evidence.length > 0 && (
                              <details className="mt-3 rounded-xl bg-[#faf8fb] p-3">
                                <summary className="cursor-pointer text-xs font-semibold text-[#5b2a86]">
                                  查看知识库依据
                                </summary>
                                <div className="mt-3 space-y-3">
                                  {question.evidence.map((evidence, index) => (
                                    <div
                                      key={`${evidence.documentPath}-${index}`}
                                    >
                                      <p className="break-all text-xs font-semibold text-[#61586f]">
                                        {evidence.documentPath}
                                      </p>
                                      <p className="mt-1 text-xs leading-5 text-[#857e91]">
                                        {evidence.excerpt}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                            <div className="mt-4">
                              <Button
                                size="sm"
                                variant={
                                  selected || pending ? "outline" : "default"
                                }
                                className={
                                  selected
                                    ? "border-emerald-200 text-emerald-700"
                                    : pending
                                      ? "border-amber-200 text-amber-700"
                                      : "bg-[#5b2a86] hover:bg-[#49216c]"
                                }
                                disabled={
                                  pending ||
                                  !portal.capabilities.questionSelection.allowed
                                }
                                onClick={() => onUseQuestion(question)}
                              >
                                {selected
                                  ? "进入问题优化"
                                  : pending
                                    ? "待管理员确认"
                                    : "选择并进入问题优化"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
