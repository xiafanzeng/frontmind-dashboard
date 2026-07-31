import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  BookOpenText,
  Database,
  FileText,
  Globe2,
  LibraryBig,
  ListChecks,
  Newspaper,
} from "lucide-react";

import KnowledgeBaseProgressPanel from "@/components/KnowledgeBaseProgressPanel";
import KnowledgeBaseViewer, {
  type KnowledgeSnapshotView,
} from "@/components/KnowledgeBaseViewer";
import { PortalCard } from "@/components/PortalShell";
import AiWebsiteManagementWorkspace from "@/dashboard/AiWebsiteManagementWorkspace";
import ProgressReportWorkspace from "@/dashboard/ProgressReportWorkspace";
import QuestionMonitoringWorkspace from "@/dashboard/QuestionMonitoringWorkspace";
import {
  ManagedDashboardSection,
  ManagedKeywordTables,
  PublishedContentAssets,
} from "@/dashboard/UserBrandDashboard";
import type { DashboardPayload } from "@shared/dashboard";
import type {
  PublicDeliveryTicketSummary,
  PublicDeliveryTicketWorkspaceMetadata,
} from "@shared/delivery-ticket";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";

export type CustomerDashboardMirrorSection =
  | "brand"
  | "website"
  | "knowledge"
  | "keywords"
  | "questions"
  | "monitoring"
  | "report"
  | "content";

const CUSTOMER_DASHBOARD_SECTIONS = [
  { value: "brand", label: "品牌建设", icon: BookOpenText },
  { value: "website", label: "AI 友好官网", icon: Globe2 },
  { value: "knowledge", label: "知识库", icon: Database },
  { value: "keywords", label: "品牌全域词库", icon: LibraryBig },
  { value: "questions", label: "问题目录", icon: ListChecks },
  { value: "monitoring", label: "问题监控", icon: BarChart3 },
  { value: "report", label: "进度报告", icon: FileText },
  { value: "content", label: "AI 友好内容", icon: Newspaper },
] as const;

type CustomerDashboardMirrorProps = {
  payload: DashboardPayload;
  websiteWorkspace?:
    | (PublicDeliveryTicketWorkspaceMetadata & {
        tickets: PublicDeliveryTicketSummary[];
      })
    | null;
  knowledgePreview?: {
    progress?: KnowledgeBaseProgressDto | null;
    snapshot?: KnowledgeSnapshotView | null;
  } | null;
  initialSection?: CustomerDashboardMirrorSection;
  allowedSections?: readonly CustomerDashboardMirrorSection[];
  heading?: string;
  description?: string;
};

export default function CustomerDashboardMirror({
  payload,
  websiteWorkspace = null,
  knowledgePreview = null,
  initialSection = "brand",
  allowedSections,
  heading = "客户页面实时版本",
  description = "这里读取与客户账号相同的数据；切换分区即可核对客户实际看到的内容。",
}: CustomerDashboardMirrorProps) {
  const sections = useMemo(
    () =>
      CUSTOMER_DASHBOARD_SECTIONS.filter(
        (section) =>
          !allowedSections || allowedSections.includes(section.value),
      ),
    [allowedSections],
  );
  const [activeSection, setActiveSection] =
    useState<CustomerDashboardMirrorSection>(
      sections.some((section) => section.value === initialSection)
        ? initialSection
        : (sections[0]?.value ?? "brand"),
    );

  useEffect(() => {
    if (sections.some((section) => section.value === initialSection)) {
      setActiveSection(initialSection);
    } else {
      setActiveSection(sections[0]?.value ?? "brand");
    }
  }, [initialSection, sections]);

  return (
    <PortalCard className="overflow-hidden">
      <div className="border-b border-[#e8e1ee] bg-[linear-gradient(135deg,#fbf8fd,#f4edf8)] px-5 py-4 sm:px-6">
        <h3 className="font-semibold text-[#171321]">{heading}</h3>
        <p className="mt-1 text-sm leading-6 text-[#716a80]">{description}</p>
        <div
          className="mt-4 flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="客户页面分区"
        >
          {sections.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={activeSection === value}
              onClick={() => setActiveSection(value)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${
                activeSection === value
                  ? "bg-[#5b2a86] text-white"
                  : "border border-[#ded3e6] bg-white text-[#655c70] hover:text-[#5b2a86]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="bg-[#f6f3f8] p-3 sm:p-5">
        <CustomerDashboardSection
          section={activeSection}
          payload={payload}
          websiteWorkspace={websiteWorkspace}
          knowledgePreview={knowledgePreview}
        />
      </div>
    </PortalCard>
  );
}

function CustomerDashboardSection({
  section,
  payload,
  websiteWorkspace,
  knowledgePreview,
}: {
  section: CustomerDashboardMirrorSection;
  payload: DashboardPayload;
  websiteWorkspace: CustomerDashboardMirrorProps["websiteWorkspace"];
  knowledgePreview: CustomerDashboardMirrorProps["knowledgePreview"];
}) {
  const questionGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        title: string;
        subtitle: string;
        tone: "plum" | "teal" | "amber" | "blue";
        questions: Array<{
          id: string;
          question: string;
          intent: string;
          summary: string;
        }>;
      }
    >();
    for (const question of payload.questions) {
      const current = groups.get(question.groupId) || {
        id: question.groupId,
        title: question.groupTitle,
        subtitle: question.groupSubtitle || "",
        tone: question.tone || "plum",
        questions: [],
      };
      current.questions.push({
        id: question.id,
        question: question.question,
        intent: question.intent || "",
        summary: question.summary || "",
      });
      groups.set(question.groupId, current);
    }
    return [...groups.values()];
  }, [payload.questions]);

  if (section === "brand") {
    return (
      <ManagedDashboardSection
        payload={payload}
        loading={false}
        error={null}
        embedded
      />
    );
  }

  if (section === "website") {
    return websiteWorkspace ? (
      <div className="user-brand-dashboard overflow-hidden rounded-2xl bg-white">
        <AiWebsiteManagementWorkspace
          planCode="advanced"
          marketEdition={websiteWorkspace.marketEdition}
          websiteWorkflow={websiteWorkspace.websiteWorkflow}
          contentCatalog={websiteWorkspace.websiteContentCatalog}
          quota={websiteWorkspace.quotas.website_content_publish}
          tickets={websiteWorkspace.tickets.filter(
            (ticket) => ticket.type === "website_operation",
          )}
          readOnlyPreview
        />
      </div>
    ) : (
      <MirrorEmpty title="AI 友好官网" />
    );
  }

  if (section === "knowledge") {
    return knowledgePreview?.progress || knowledgePreview?.snapshot ? (
      <div className="grid gap-4">
        <KnowledgeBaseProgressPanel
          progress={knowledgePreview.progress}
          title="客户当前知识库构建进度"
        />
        <div className="overflow-hidden rounded-2xl border border-[#e5ddea] bg-white p-4 sm:p-6">
          <KnowledgeBaseViewer snapshot={knowledgePreview.snapshot} />
        </div>
      </div>
    ) : (
      <MirrorEmpty title="知识库" />
    );
  }

  if (section === "keywords") {
    return (
      <div className="user-brand-dashboard overflow-hidden rounded-2xl bg-white">
        <ManagedKeywordTables
          tables={payload.keywordTables}
          loading={false}
          error={null}
          embedded
        />
      </div>
    );
  }

  if (section === "questions") {
    return payload.questions.length ? (
      <div className="grid gap-3 lg:grid-cols-2">
        {payload.questions.map((question) => (
          <article
            key={question.id}
            className="rounded-2xl border border-[#e5ddea] bg-white p-4"
          >
            <p className="text-xs font-semibold text-[#7b4b9d]">
              {question.groupTitle}
            </p>
            <h4 className="mt-2 font-semibold leading-6 text-[#332842]">
              {question.question}
            </h4>
            {question.intent && (
              <p className="mt-3 text-sm leading-6 text-[#655c70]">
                {question.intent}
              </p>
            )}
            {question.summary && (
              <p className="mt-2 text-xs leading-5 text-[#8a8194]">
                {question.summary}
              </p>
            )}
          </article>
        ))}
      </div>
    ) : (
      <MirrorEmpty title="问题目录" />
    );
  }

  if (section === "monitoring") {
    return questionGroups.length || payload.monitoringAnswers.length ? (
      <div className="user-brand-dashboard overflow-hidden rounded-2xl bg-white">
        <QuestionMonitoringWorkspace
          questionGroups={questionGroups}
          monitoringAnswers={payload.monitoringAnswers}
          citationMode="inline"
          monitoringAnswersLoading={false}
          monitoringAnswersError={false}
        />
      </div>
    ) : (
      <MirrorEmpty title="问题监控" />
    );
  }

  if (section === "report") {
    return payload.optimizationReport ? (
      <div className="overflow-hidden rounded-2xl border border-[#e5ddea] bg-white">
        <ProgressReportWorkspace report={payload.optimizationReport} />
      </div>
    ) : (
      <MirrorEmpty title="进度报告" />
    );
  }

  return payload.contentAssets.length ? (
    <div className="user-brand-dashboard overflow-hidden rounded-2xl bg-white p-4 sm:p-6">
      <PublishedContentAssets assets={payload.contentAssets} />
    </div>
  ) : (
    <MirrorEmpty title="AI 友好内容" />
  );
}

function MirrorEmpty({ title }: { title: string }) {
  return (
    <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-[#dcd1e3] bg-white p-8 text-center">
      <div>
        <p className="font-semibold text-[#403748]">{title}尚未发布内容</p>
        <p className="mt-2 text-sm text-[#81778a]">
          上传并通过预检后，这里会立即呈现客户看到的结果。
        </p>
      </div>
    </div>
  );
}
