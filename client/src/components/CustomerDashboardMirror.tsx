import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  Database,
  FileText,
  Globe2,
  House,
  LibraryBig,
  ListChecks,
  Menu,
  Newspaper,
  Shield,
  Target,
  X,
} from "lucide-react";

import KnowledgeBaseProgressPanel from "@/components/KnowledgeBaseProgressPanel";
import KnowledgeBaseViewer, {
  type KnowledgeSnapshotView,
} from "@/components/KnowledgeBaseViewer";
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

import "@/dashboard/dashboard-styles.css";
import "./customer-dashboard-mirror.css";

export type CustomerDashboardMirrorSection =
  | "home"
  | "knowledge-build"
  | "knowledge"
  | "keywords"
  | "questions"
  | "response-logic"
  | "monitoring"
  | "report"
  | "content"
  | "website";

type CustomerDashboardNavigationItem = {
  value: CustomerDashboardMirrorSection;
  label: string;
  icon: typeof House;
};

const CUSTOMER_DASHBOARD_GROUPS: ReadonlyArray<{
  label: string;
  icon: typeof House;
  items: readonly CustomerDashboardNavigationItem[];
}> = [
  {
    label: "服务概览",
    icon: House,
    items: [{ value: "home", label: "服务首页", icon: House }],
  },
  {
    label: "品牌建设",
    icon: Shield,
    items: [
      {
        value: "knowledge-build",
        label: "知识库智能体",
        icon: Database,
      },
      { value: "knowledge", label: "知识库展示", icon: Database },
      { value: "keywords", label: "品牌全域词库", icon: LibraryBig },
    ],
  },
  {
    label: "意图优化",
    icon: Target,
    items: [
      { value: "questions", label: "问题优化", icon: ListChecks },
      { value: "response-logic", label: "应答逻辑智能体", icon: Bot },
    ],
  },
  {
    label: "进度监控",
    icon: Activity,
    items: [
      { value: "monitoring", label: "问题监控", icon: BarChart3 },
      { value: "report", label: "进度报告", icon: FileText },
    ],
  },
  {
    label: "AI 友好内容资产",
    icon: Database,
    items: [
      { value: "content", label: "内容资产运营", icon: Newspaper },
      { value: "website", label: "AI 友好官网管理", icon: Globe2 },
    ],
  },
];

const ALL_CUSTOMER_DASHBOARD_SECTIONS = CUSTOMER_DASHBOARD_GROUPS.flatMap(
  (group) => group.items.map((item) => item.value),
);

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
  editActions?: ReactNode;
  renderSectionActions?: (section: CustomerDashboardMirrorSection) => ReactNode;
  statusLabel?: string;
};

export default function CustomerDashboardMirror({
  payload,
  websiteWorkspace = null,
  knowledgePreview = null,
  initialSection = "home",
  allowedSections,
  heading,
  description,
  editActions,
  renderSectionActions,
  statusLabel,
}: CustomerDashboardMirrorProps) {
  const visibleSections = useMemo(
    () =>
      ALL_CUSTOMER_DASHBOARD_SECTIONS.filter(
        (section) => !allowedSections || allowedSections.includes(section),
      ),
    [allowedSections],
  );
  const [activeSection, setActiveSection] =
    useState<CustomerDashboardMirrorSection>(
      visibleSections.includes(initialSection)
        ? initialSection
        : (visibleSections[0] ?? "home"),
    );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (visibleSections.includes(initialSection)) {
      setActiveSection(initialSection);
    } else {
      setActiveSection(visibleSections[0] ?? "home");
    }
  }, [initialSection, visibleSections]);

  const selectSection = (section: CustomerDashboardMirrorSection) => {
    setActiveSection(section);
    setMobileNavOpen(false);
  };
  const sectionActions = renderSectionActions?.(activeSection);
  const showEditorBar = Boolean(
    heading || description || editActions || sectionActions || statusLabel,
  );

  return (
    <section
      className="user-brand-dashboard customer-dashboard-mirror"
      aria-label={heading || "客户看板"}
    >
      <div
        className={`app-shell customer-dashboard-mirror-shell ${
          mobileNavOpen ? "nav-open" : ""
        }`}
      >
        <button
          className="mobile-menu-btn"
          type="button"
          onClick={() => setMobileNavOpen((open) => !open)}
          aria-label="切换客户看板菜单"
        >
          {mobileNavOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        {mobileNavOpen && (
          <button
            type="button"
            className="mobile-nav-overlay"
            aria-label="关闭客户看板菜单"
            onClick={() => setMobileNavOpen(false)}
          />
        )}

        <aside className="global-nav customer-dashboard-mirror-nav">
          <div className="nav-title-block">
            <img
              className="frontmind-logo frontmind-reference-logo"
              src="/frontmind-contract-logo-white.svg"
              alt="FrontMind"
            />
            <p>智能品牌优化看板</p>
          </div>

          <div
            className="nav-group-card promise-card"
            role="tablist"
            aria-label="客户页面分区"
          >
            <div className="nav-group-head">
              <span>MindPromise智诺</span>
            </div>
            {CUSTOMER_DASHBOARD_GROUPS.map((group) => {
              const items = group.items.filter((item) =>
                visibleSections.includes(item.value),
              );
              if (!items.length) return null;
              const GroupIcon = group.icon;
              const groupActive = items.some(
                (item) => item.value === activeSection,
              );
              return (
                <div key={group.label} className="customer-mirror-nav-group">
                  <div
                    className={`nav-section-label ${
                      groupActive ? "active" : ""
                    }`}
                  >
                    <GroupIcon className="nav-icon" size={16} />
                    <span>{group.label}</span>
                  </div>
                  <div className="sub-nav">
                    {items.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        role="tab"
                        aria-selected={activeSection === item.value}
                        className={activeSection === item.value ? "active" : ""}
                        onClick={() => selectSection(item.value)}
                      >
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sidebar-footer-brand">
            <small>当前企业</small>
            <strong>{payload.brandName}</strong>
            <small>客户账号实际页面</small>
          </div>
        </aside>

        <main className="dashboard-main customer-dashboard-mirror-main">
          <div className="project-ribbon final-ribbon">
            <div>
              <span>FrontMind 智能品牌优化看板</span>
              <h1>{payload.brandName}</h1>
            </div>
          </div>

          {showEditorBar && (
            <div className="customer-dashboard-editor-bar">
              <div className="customer-dashboard-editor-copy">
                {heading && <strong>{heading}</strong>}
                {description && <p>{description}</p>}
              </div>
              <div className="customer-dashboard-editor-actions">
                {statusLabel && (
                  <span className="customer-dashboard-status">
                    {statusLabel}
                  </span>
                )}
                {editActions}
                {sectionActions}
              </div>
            </div>
          )}

          <CustomerDashboardSection
            section={activeSection}
            payload={payload}
            websiteWorkspace={websiteWorkspace}
            knowledgePreview={knowledgePreview}
          />
        </main>
      </div>
    </section>
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

  if (section === "home") {
    return (
      <ManagedDashboardSection payload={payload} loading={false} error={null} />
    );
  }

  if (section === "website") {
    return websiteWorkspace ? (
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
    ) : (
      <MirrorEmpty title="AI 友好官网管理" />
    );
  }

  if (section === "knowledge-build") {
    return knowledgePreview?.progress ? (
      <section className="page-shell">
        <KnowledgeBaseProgressPanel
          progress={knowledgePreview.progress}
          title="知识库构建进度"
        />
      </section>
    ) : (
      <MirrorEmpty title="知识库智能体" />
    );
  }

  if (section === "knowledge") {
    return knowledgePreview?.snapshot ? (
      <section className="page-shell">
        <div className="overflow-hidden rounded-2xl border border-[#e5ddea] bg-white p-4 sm:p-6">
          <KnowledgeBaseViewer snapshot={knowledgePreview.snapshot} />
        </div>
      </section>
    ) : (
      <MirrorEmpty title="知识库展示" />
    );
  }

  if (section === "keywords") {
    return (
      <ManagedKeywordTables
        tables={payload.keywordTables}
        loading={false}
        error={null}
      />
    );
  }

  if (section === "questions" || section === "response-logic") {
    return payload.questions.length ? (
      <section className="page-shell">
        <header className="page-header">
          <span className="eyebrow">MindPromise智诺 / 意图优化</span>
          <h2>
            {section === "response-logic" ? "应答逻辑智能体" : "问题优化"}
          </h2>
          <p>
            {section === "response-logic"
              ? "逐题核对已发布的用户问题、应答目标与确认口径。"
              : "查看客户问题目录与每个问题对应的真实用户意图。"}
          </p>
        </header>
        <div className="customer-dashboard-question-grid">
          {payload.questions.map((question) => (
            <article key={question.id}>
              <span>{question.groupTitle}</span>
              <h4>{question.question}</h4>
              {question.intent && <p>{question.intent}</p>}
              {question.summary && <small>{question.summary}</small>}
            </article>
          ))}
        </div>
      </section>
    ) : (
      <MirrorEmpty
        title={section === "response-logic" ? "应答逻辑智能体" : "问题优化"}
      />
    );
  }

  if (section === "monitoring") {
    return questionGroups.length || payload.monitoringAnswers.length ? (
      <QuestionMonitoringWorkspace
        questionGroups={questionGroups}
        monitoringAnswers={payload.monitoringAnswers}
        citationMode="inline"
        monitoringAnswersLoading={false}
        monitoringAnswersError={false}
      />
    ) : (
      <MirrorEmpty title="问题监控" />
    );
  }

  if (section === "report") {
    return payload.optimizationReport ? (
      <ProgressReportWorkspace report={payload.optimizationReport} />
    ) : (
      <MirrorEmpty title="进度报告" />
    );
  }

  return payload.contentAssets.length ? (
    <section className="page-shell">
      <PublishedContentAssets assets={payload.contentAssets} />
    </section>
  ) : (
    <MirrorEmpty title="内容资产运营" />
  );
}

function MirrorEmpty({ title }: { title: string }) {
  return (
    <section className="page-shell">
      <header className="page-header">
        <span className="eyebrow">MindPromise智诺</span>
        <h2>{title}</h2>
        <p>当前客户账号尚未发布这一分区的正式内容。</p>
      </header>
      <section className="panel">
        <div className="empty-state">
          <Database size={24} />
          <p>发布后，管理员、工程师和客户会在同一位置看到结果。</p>
        </div>
      </section>
    </section>
  );
}
