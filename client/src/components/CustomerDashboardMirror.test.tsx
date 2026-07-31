import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardPayload } from "@shared/dashboard";

vi.mock("@/dashboard/UserBrandDashboard", () => ({
  ManagedDashboardSection: () => <div>品牌建设用户页</div>,
  ManagedKeywordTables: () => <div>品牌全域词库用户页</div>,
  PublishedContentAssets: () => <div>已发布内容资产用户页</div>,
}));

vi.mock("@/dashboard/QuestionMonitoringWorkspace", () => ({
  default: () => <div>问题监控用户页</div>,
}));

vi.mock("@/dashboard/ProgressReportWorkspace", () => ({
  default: () => <div>用户进度报告</div>,
}));

vi.mock("@/dashboard/AiWebsiteManagementWorkspace", () => ({
  default: () => <div>AI 友好官网用户页</div>,
}));

vi.mock("@/components/KnowledgeBaseProgressPanel", () => ({
  default: () => <div>知识库构建进度用户页</div>,
}));

vi.mock("@/components/KnowledgeBaseViewer", () => ({
  default: () => <div>知识库展示用户页</div>,
}));

import CustomerDashboardMirror from "./CustomerDashboardMirror";

const payload: DashboardPayload = {
  brandName: "示例品牌",
  headline: "示例用户流程",
  summary: "",
  metrics: [],
  sections: [],
  keywordTables: [],
  questions: [],
  monitoringAnswers: [],
  citations: [],
  contentAssets: [],
  optimizationReport: null,
  progressReports: [],
};

describe("CustomerDashboardMirror", () => {
  it("shows only the user-flow sections owned by the engineer role", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        allowedSections={["keywords", "questions", "monitoring", "report"]}
        initialSection="monitoring"
      />,
    );

    expect(
      screen.getByRole("tab", { name: "品牌全域词库" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "问题目录" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "问题监控" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "进度报告" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "AI 友好内容" })).toBeNull();
  });

  it("lets AI operations verify the formal website and knowledge views", () => {
    render(
      <CustomerDashboardMirror
        payload={payload}
        allowedSections={["website", "knowledge"]}
        initialSection="website"
        websiteWorkspace={
          {
            marketEdition: "domestic",
            quotas: {
              content_asset_publish: {},
              website_content_publish: {},
            },
            contentAssetCatalog: [],
            websiteContentCatalog: [],
            preferredMediaOptions: [],
            deliveryOwners: {},
            websiteWorkflow: {},
            tickets: [],
          } as any
        }
        knowledgePreview={{
          progress: {} as any,
          snapshot: {} as any,
        }}
      />,
    );

    expect(screen.getByText("AI 友好官网用户页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "知识库" }));
    expect(screen.getByText("知识库构建进度用户页")).toBeInTheDocument();
    expect(screen.getByText("知识库展示用户页")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "品牌建设" })).toBeNull();
  });
});
