import {
  ArrowLeft,
  CheckCircle2,
  Database,
  Eye,
  FileText,
  LockKeyhole,
  MessageSquareText,
  Radar,
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

import KnowledgeBaseViewer from "@/components/KnowledgeBaseViewer";
import PortalShell, { PortalCard } from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
import { ManagedDashboardSection } from "@/dashboard/UserBrandDashboard";
import { trpc } from "@/lib/trpc";
import { getAdminNav } from "@/pages/AdminDashboard";

type PreviewSection =
  | "overview"
  | "brand"
  | "knowledge"
  | "questions"
  | "monitoring"
  | "delivery";

function formatDate(value: number | string | Date | null | undefined) {
  if (!value) return "未配置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未配置";
  return date.toLocaleDateString("zh-CN");
}

function ReadError({ title, message }: { title: string; message?: string }) {
  return (
    <PortalCard className="border-[#ebc8d4] bg-[#fff8fa] p-5 text-sm text-[#a02652]">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 leading-6">{message || "请刷新后重试。"}</p>
    </PortalCard>
  );
}

function EmptyResult({ children }: { children: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#dcd1e3] bg-[#fbf9fd] p-8 text-center text-sm text-[#716a80]">
      {children}
    </div>
  );
}

export default function AdminCustomerPreview({ userId }: { userId: number }) {
  const [, setLocation] = useLocation();
  const [section, setSection] = useState<PreviewSection>("overview");
  const input = { userId };
  const workspaceQuery = trpc.admin.workspace.list.useQuery(undefined, {
    retry: false,
  });
  const account = workspaceQuery.data?.users.find((item) => item.id === userId);
  const queryEnabled = Boolean(account);
  const serviceQuery = trpc.admin.workspace.service.useQuery(input, {
    enabled: queryEnabled,
    retry: false,
  });
  const dashboardQuery = trpc.admin.workspace.dashboard.useQuery(input, {
    enabled: queryEnabled,
    retry: false,
  });
  const knowledgeQuery = trpc.admin.workspace.knowledge.useQuery(input, {
    enabled: queryEnabled,
    retry: false,
  });
  const responseLogicQuery = trpc.admin.workspace.responseLogic.useQuery(
    input,
    {
      enabled: queryEnabled,
      retry: false,
    },
  );
  const monitoringFiltersQuery =
    trpc.admin.workspace.monitoring.filters.useQuery(input, {
      enabled: queryEnabled,
      retry: false,
    });
  const latestBatchKey = monitoringFiltersQuery.data?.batches?.[0]?.batchKey;
  const firstMonitoringQuestionId =
    monitoringFiltersQuery.data?.questions?.[0]?.id;
  const monitoringSamplesQuery =
    trpc.admin.workspace.monitoring.samples.useQuery(
      {
        userId,
        batchKey: latestBatchKey,
        query: "",
        page: 1,
        pageSize: 100,
        sortOrder: "desc",
      },
      {
        enabled: queryEnabled && Boolean(latestBatchKey),
        retry: false,
      },
    );
  const monitoringSummaryQuery =
    trpc.admin.workspace.monitoring.citationSummary.useQuery(
      {
        userId,
        batchKey: latestBatchKey || "",
        questionId: firstMonitoringQuestionId || "",
      },
      {
        enabled:
          queryEnabled &&
          Boolean(latestBatchKey) &&
          Boolean(firstMonitoringQuestionId),
        retry: false,
      },
    );
  const service = serviceQuery.data?.service;
  const steps = serviceQuery.data?.workflowSteps ?? [];
  const dashboardPublished = Boolean(
    dashboardQuery.data?.sourceName &&
      (dashboardQuery.data?.revision ?? 0) > 0 &&
      dashboardQuery.data?.updatedAt,
  );
  const payload = dashboardPublished ? dashboardQuery.data?.payload : null;
  const responseRecords = responseLogicQuery.data?.records ?? [];
  const confirmedResponseCount = responseRecords.filter(
    (record) => record.confirmed,
  ).length;
  const contentArticleCount = (payload?.contentAssets ?? []).reduce(
    (sum, asset) => sum + asset.articles.length,
    0,
  );
  const keywordRowCount = (payload?.keywordTables ?? []).reduce(
    (sum, table) => sum + table.rows.length,
    0,
  );

  const navItems: Array<{
    id: PreviewSection;
    label: string;
    icon: typeof Eye;
  }> = [
    { id: "overview", label: "服务状态", icon: Eye },
    { id: "brand", label: "品牌建设", icon: FileText },
    { id: "knowledge", label: "知识库", icon: Database },
    { id: "questions", label: "问题与应答", icon: MessageSquareText },
    { id: "monitoring", label: "监控与渠道", icon: Radar },
    { id: "delivery", label: "报告与内容", icon: CheckCircle2 },
  ];

  return (
    <PortalShell
      eyebrow="客户交付工作台 · 只读验收"
      title={
        account?.enterpriseName ||
        account?.displayName ||
        (workspaceQuery.isLoading ? "正在核验客户…" : "客户不可用")
      }
      navItems={getAdminNav(Boolean(workspaceQuery.data?.isSystemAdmin))}
      toolbar={
        <Button
          variant="outline"
          className="border-[#ded4e5] bg-white"
          onClick={() => setLocation(`/admin/customers/${userId}/service`)}
        >
          <ArrowLeft className="h-4 w-4" />
          返回管理
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-2xl border border-[#ddcdeb] bg-[#f7f1fb] p-4 text-sm text-[#5b2a86]">
          <Eye className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">只读交付验收</p>
            <p className="mt-1 leading-6 text-[#716a80]">
              此页按客户维度读取套餐、已发布内容、知识库、应答逻辑、
              规范化监控批次、报告和内容资产。不挂载对话、不调用模型，也不提供任何写操作。
            </p>
          </div>
        </div>

        {workspaceQuery.error ? (
          <ReadError
            title="客户访问权限暂时无法核验"
            message={workspaceQuery.error.message}
          />
        ) : workspaceQuery.isLoading ? (
          <PortalCard className="p-6 text-sm text-[#716a80]">
            正在核验客户访问权限…
          </PortalCard>
        ) : !account ? (
          <ReadError
            title="无法打开该客户"
            message="客户不存在，或尚未分配给当前管理员。"
          />
        ) : (
          <>
            <PortalCard className="overflow-x-auto p-2">
              <div className="flex min-w-max gap-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
                        section === item.id
                          ? "bg-[#5b2a86] text-white"
                          : "text-[#716a80] hover:bg-[#f3eef6] hover:text-[#5b2a86]"
                      }`}
                      onClick={() => setSection(item.id)}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </PortalCard>

            {section === "overview" &&
              (serviceQuery.error ? (
                <ReadError
                  title="服务状态暂时无法载入"
                  message={serviceQuery.error.message}
                />
              ) : (
                <PortalCard className="p-5 sm:p-6">
                  {serviceQuery.isLoading ? (
                    <p className="text-sm text-[#716a80]">正在载入服务状态…</p>
                  ) : (
                    <>
                      <div className="grid gap-4 md:grid-cols-4">
                        <div>
                          <p className="text-xs text-[#8d8499]">套餐</p>
                          <p className="mt-1 font-semibold text-[#221a33]">
                            {service?.planName || "版本待配置"}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-[#8d8499]">有效期</p>
                          <p className="mt-1 font-semibold text-[#221a33]">
                            {formatDate(service?.validFrom)} —{" "}
                            {formatDate(service?.validUntil)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-[#8d8499]">当前问题</p>
                          <p className="mt-1 font-semibold text-[#221a33]">
                            {serviceQuery.data?.purchasedQuestions?.length ?? 0}{" "}
                            个
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-[#8d8499]">下一步</p>
                          <p className="mt-1 font-semibold text-[#221a33]">
                            {serviceQuery.data?.nextAction?.label ||
                              "暂无待处理动作"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-5 grid gap-2 border-t border-[#eee8f2] pt-5 sm:grid-cols-2 xl:grid-cols-4">
                        {steps.map((step) => (
                          <div
                            key={step.id}
                            className="rounded-xl bg-[#f8f5fa] px-3 py-3 text-sm"
                          >
                            <div className="flex items-center gap-2">
                              {step.status === "locked" ? (
                                <LockKeyhole className="h-4 w-4 text-[#9a94a8]" />
                              ) : (
                                <CheckCircle2
                                  className={`h-4 w-4 ${
                                    step.status === "complete"
                                      ? "text-[#16794f]"
                                      : "text-[#5b2a86]"
                                  }`}
                                />
                              )}
                              <span className="font-medium text-[#484057]">
                                {step.label}
                              </span>
                            </div>
                            {step.lockedReason && (
                              <p className="mt-2 text-xs leading-5 text-[#857e91]">
                                {step.lockedReason}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </PortalCard>
              ))}

            {section === "brand" &&
              (dashboardQuery.error ? (
                <ReadError
                  title="品牌内容暂时无法载入"
                  message={dashboardQuery.error.message}
                />
              ) : dashboardQuery.isLoading ? (
                <PortalCard className="p-6 text-sm text-[#716a80]">
                  正在读取已发布品牌内容…
                </PortalCard>
              ) : !payload ? (
                <EmptyResult>
                  当前客户尚未发布企业看板；默认编辑草稿不会作为客户成果展示。
                </EmptyResult>
              ) : (
                <div className="user-brand-dashboard rounded-[18px] border border-[#e8e1ee] bg-white/90 p-1 shadow-[0_18px_48px_rgba(33,19,58,.07)]">
                  <ManagedDashboardSection
                    payload={payload}
                    loading={false}
                    error={false}
                    embedded
                  />
                </div>
              ))}

            {section === "knowledge" &&
              (knowledgeQuery.error ? (
                <ReadError
                  title="知识库展示版本暂时无法载入"
                  message={knowledgeQuery.error.message}
                />
              ) : (
                <KnowledgeBaseViewer
                  snapshot={knowledgeQuery.data?.snapshot}
                  loading={knowledgeQuery.isLoading}
                />
              ))}

            {section === "questions" && (
              <div className="grid gap-5 xl:grid-cols-2">
                <PortalCard className="p-5 sm:p-6">
                  <h2 className="font-semibold text-[#171321]">当前服务问题</h2>
                  {serviceQuery.error ? (
                    <p className="mt-4 text-sm text-[#a02652]">
                      {serviceQuery.error.message}
                    </p>
                  ) : serviceQuery.isLoading ? (
                    <p className="mt-4 text-sm text-[#716a80]">读取中…</p>
                  ) : serviceQuery.data?.purchasedQuestions?.length ? (
                    <div className="mt-4 space-y-2">
                      {serviceQuery.data.purchasedQuestions.map((question) => (
                        <article
                          key={question.id}
                          className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                        >
                          <p className="text-xs font-semibold text-[#5b2a86]">
                            {question.category}
                          </p>
                          <p className="mt-2 text-sm font-semibold leading-6 text-[#332842]">
                            {question.question}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-[#716a80]">
                      当前服务周期尚无已启动问题。
                    </p>
                  )}
                </PortalCard>
                <PortalCard className="p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-semibold text-[#171321]">
                      已确认应答逻辑
                    </h2>
                    {!responseLogicQuery.error &&
                      !responseLogicQuery.isLoading && (
                        <span className="text-sm font-semibold text-[#5b2a86]">
                          {confirmedResponseCount}/{responseRecords.length}
                        </span>
                      )}
                  </div>
                  {responseLogicQuery.error ? (
                    <p className="mt-4 text-sm text-[#a02652]">
                      {responseLogicQuery.error.message}
                    </p>
                  ) : responseLogicQuery.isLoading ? (
                    <p className="mt-4 text-sm text-[#716a80]">读取中…</p>
                  ) : responseRecords.length ? (
                    <div className="mt-4 space-y-2">
                      {responseRecords.map((record) => (
                        <article
                          key={record.id}
                          className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-semibold leading-6 text-[#332842]">
                              {record.question}
                            </p>
                            <span className="shrink-0 text-xs font-semibold text-[#716a80]">
                              {record.confirmed ? "已确认" : "草稿"}
                            </span>
                          </div>
                          {record.confirmed?.conclusion && (
                            <p className="mt-2 line-clamp-3 text-xs leading-5 text-[#716a80]">
                              {record.confirmed.conclusion}
                            </p>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-[#716a80]">
                      当前尚无应答逻辑记录。
                    </p>
                  )}
                </PortalCard>
              </div>
            )}

            {section === "monitoring" && (
              <div className="space-y-5">
                {monitoringFiltersQuery.error ? (
                  <ReadError
                    title="监控批次暂时无法载入"
                    message={monitoringFiltersQuery.error.message}
                  />
                ) : monitoringFiltersQuery.isLoading ? (
                  <PortalCard className="p-6 text-sm text-[#716a80]">
                    正在读取规范化监控批次…
                  </PortalCard>
                ) : !latestBatchKey ? (
                  <EmptyResult>当前客户尚无监控批次。</EmptyResult>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <PortalCard className="p-5">
                        <p className="text-xs text-[#8d8499]">最新批次</p>
                        <p className="mt-2 break-all font-mono text-sm font-semibold text-[#332842]">
                          {latestBatchKey}
                        </p>
                      </PortalCard>
                      <PortalCard className="p-5">
                        <p className="text-xs text-[#8d8499]">监控答案</p>
                        <p className="mt-2 text-2xl font-semibold text-[#332842]">
                          {monitoringSamplesQuery.isLoading
                            ? "—"
                            : (monitoringSamplesQuery.data?.total ?? 0)}
                        </p>
                      </PortalCard>
                      <PortalCard className="p-5">
                        <p className="text-xs text-[#8d8499]">引用记录</p>
                        <p className="mt-2 text-2xl font-semibold text-[#332842]">
                          {monitoringSummaryQuery.isLoading
                            ? "—"
                            : (monitoringSummaryQuery.data?.totalCitations ??
                              0)}
                        </p>
                      </PortalCard>
                    </div>
                    {(monitoringSamplesQuery.error ||
                      monitoringSummaryQuery.error) && (
                      <ReadError
                        title="监控明细暂时无法载入"
                        message={
                          monitoringSamplesQuery.error?.message ||
                          monitoringSummaryQuery.error?.message
                        }
                      />
                    )}
                    <div className="grid gap-5 xl:grid-cols-2">
                      <PortalCard className="p-5 sm:p-6">
                        <h2 className="font-semibold text-[#171321]">
                          答案样本
                        </h2>
                        <div className="mt-4 space-y-2">
                          {(monitoringSamplesQuery.data?.items ?? [])
                            .slice(0, 20)
                            .map((sample) => (
                              <article
                                key={sample.id}
                                className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                              >
                                <div className="flex items-center justify-between gap-3 text-xs text-[#857e91]">
                                  <span>{sample.platform}</span>
                                  <span>
                                    {new Date(
                                      sample.collectedAt,
                                    ).toLocaleDateString("zh-CN")}
                                  </span>
                                </div>
                                <p className="mt-2 line-clamp-3 text-sm leading-6 text-[#484057]">
                                  {sample.content || "该答案没有正文。"}
                                </p>
                              </article>
                            ))}
                        </div>
                      </PortalCard>
                      <PortalCard className="p-5 sm:p-6">
                        <h2 className="font-semibold text-[#171321]">
                          高频引用内容
                        </h2>
                        <div className="mt-4 space-y-2">
                          {(monitoringSummaryQuery.data?.contents ?? [])
                            .slice(0, 20)
                            .map((item, index) => (
                              <article
                                key={`${item.url}-${index}`}
                                className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                              >
                                {item.url ? (
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-sm font-semibold leading-6 text-[#5b2a86]"
                                  >
                                    {item.title || item.url}
                                  </a>
                                ) : (
                                  <p className="text-sm font-semibold leading-6 text-[#332842]">
                                    {item.title || "未标注内容"}
                                  </p>
                                )}
                                <p className="mt-1 text-xs text-[#857e91]">
                                  {item.channelName ||
                                    item.domain ||
                                    "未标注渠道"}{" "}
                                  · {item.citationCount} 次
                                </p>
                              </article>
                            ))}
                        </div>
                      </PortalCard>
                    </div>
                  </>
                )}
              </div>
            )}

            {section === "delivery" &&
              (dashboardQuery.error ? (
                <ReadError
                  title="报告与内容资产暂时无法载入"
                  message={dashboardQuery.error.message}
                />
              ) : dashboardQuery.isLoading ? (
                <PortalCard className="p-6 text-sm text-[#716a80]">
                  正在读取报告与内容资产…
                </PortalCard>
              ) : !payload ? (
                <EmptyResult>当前客户尚未发布报告或内容资产。</EmptyResult>
              ) : (
                <div className="grid gap-5 xl:grid-cols-3">
                  <PortalCard className="p-5">
                    <p className="text-xs text-[#8d8499]">品牌全域词库</p>
                    <p className="mt-2 text-2xl font-semibold text-[#332842]">
                      {keywordRowCount}
                    </p>
                    <p className="mt-1 text-xs text-[#716a80]">
                      {payload.keywordTables.length} 个表格
                    </p>
                  </PortalCard>
                  <PortalCard className="p-5">
                    <p className="text-xs text-[#8d8499]">进度报告</p>
                    <p className="mt-2 text-2xl font-semibold text-[#332842]">
                      {payload.progressReports.length ||
                        (payload.optimizationReport ? 1 : 0)}
                    </p>
                    <p className="mt-1 text-xs text-[#716a80]">
                      已发布周期版本
                    </p>
                  </PortalCard>
                  <PortalCard className="p-5">
                    <p className="text-xs text-[#8d8499]">内容资产文章</p>
                    <p className="mt-2 text-2xl font-semibold text-[#332842]">
                      {contentArticleCount}
                    </p>
                    <p className="mt-1 text-xs text-[#716a80]">
                      {payload.contentAssets.length} 个资产类型
                    </p>
                  </PortalCard>
                  <PortalCard className="p-5 xl:col-span-3">
                    <h2 className="font-semibold text-[#171321]">
                      已发布内容目录
                    </h2>
                    {contentArticleCount ? (
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {payload.contentAssets.flatMap((asset) =>
                          asset.articles.map((article) => (
                            <article
                              key={`${asset.id}-${article.id}`}
                              className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
                            >
                              <p className="text-xs font-semibold text-[#5b2a86]">
                                {asset.name}
                              </p>
                              <p className="mt-2 text-sm font-semibold leading-6 text-[#332842]">
                                {article.title}
                              </p>
                            </article>
                          )),
                        )}
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-[#716a80]">
                        当前尚无已发布内容文章。
                      </p>
                    )}
                  </PortalCard>
                </div>
              ))}
          </>
        )}
      </div>
    </PortalShell>
  );
}
