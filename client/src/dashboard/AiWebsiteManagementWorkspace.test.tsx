import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryTicketQuota } from "@shared/delivery-ticket";
import AiWebsiteManagementWorkspace from "./AiWebsiteManagementWorkspace";

const websiteContentCatalog = [
  { value: "company_facts" as const, label: "企业资料与品牌事实" },
  { value: "product_case_docs" as const, label: "产品案例与文档" },
  { value: "industry_news" as const, label: "行业新闻与观察" },
  { value: "company_news" as const, label: "企业新闻与动态" },
  { value: "faq_content" as const, label: "FAQ 与问答页面" },
];

function websiteQuota(
  input: Partial<DeliveryTicketQuota> = {},
): DeliveryTicketQuota {
  return {
    type: "website_content_publish",
    allowed: true,
    used: 0,
    reserved: 0,
    consumed: 0,
    limit: 20,
    remaining: 20,
    periodId: "period-1",
    validFrom: null,
    validUntil: null,
    reason: null,
    ...input,
  };
}

describe("AiWebsiteManagementWorkspace", () => {
  it("removes the old technical console and exposes the unified two-stage workflow", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitIcp: false,
          canSubmitContent: true,
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "官网开通进度" }),
    ).toBeInTheDocument();
    expect(screen.getByText("阿里云域名注册与 ICP 备案")).toBeInTheDocument();
    expect(screen.getByText("官网内容运营")).toBeInTheDocument();
    expect(screen.queryByText("域名申请")).not.toBeInTheDocument();
    expect(screen.queryByText("ICP 备案与主体材料")).not.toBeInTheDocument();
    for (const removedCopy of [
      "官网运营目录",
      "官网检查项",
      "处理方式",
      "官网资料",
      "当前官网",
      "查看发布页面",
    ]) {
      expect(screen.queryByText(removedCopy)).not.toBeInTheDocument();
    }
  });

  it("opens the Aliyun guide and final-result form without consuming content quota", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota({ limit: 20, remaining: 0 })}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("需求类型")).not.toBeInTheDocument();
    expect(screen.getByText("备案通过后，仅回填以下两项")).toBeInTheDocument();
    expect(
      screen.queryByText(/当前官网内容发布额度已用完/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /去阿里云注册域名/ }),
    ).toHaveAttribute("href", "https://wanwang.aliyun.com/");
    expect(
      screen.getByRole("link", { name: /去阿里云开始备案/ }),
    ).toHaveAttribute("href", "https://beian.aliyun.com/");
    expect(screen.getByLabelText("已备案域名")).toBeInTheDocument();
    expect(screen.getByLabelText("ICP 主体备案号")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交工单" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "提交备案结果" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/上传营业执照/)).not.toBeInTheDocument();
  });

  it("keeps the next stage locked while a domain ticket is pending", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "pending",
          icpStatus: "locked",
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        tickets={[
          {
            id: "domain-pending",
            type: "website_operation",
            category: "domain_application",
            topic: "申请企业域名",
            status: "in_progress",
            publicStatus: "pending",
            revision: 1,
            submittedAt: "2026-07-27",
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "域名与 ICP 备案结果已提交，平台确认后会自动开放内容运营。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交工单" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("申请企业域名")).toBeInTheDocument();
    expect(screen.getAllByText("待受理").length).toBeGreaterThan(0);
  });

  it("submits only the completed domain and ICP subject number", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "not_started",
          canSubmitIcp: true,
          canSubmitContent: false,
        }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("已备案域名"), {
      target: { value: "example.cn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交备案结果" }));
    expect(
      screen.getByText("请填写阿里云备案通过后获得的 ICP 主体备案号。"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("ICP 主体备案号"), {
      target: { value: "粤ICP备12345678号" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交备案结果" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "icp_filing",
        topic: "example.cn",
        description: "",
        targetPage: "",
        materialUrls: [],
        attachmentFiles: [],
        icpDeclarations: {
          icpNumber: "粤ICP备12345678号",
        },
      }),
    );
  });

  it("offers exactly five content categories after ICP is complete", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="luxury"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitIcp: false,
          canSubmitContent: true,
        }}
        contentCatalog={websiteContentCatalog}
        onSubmit={vi.fn()}
      />,
    );

    const select = screen.getByLabelText("需求类型");
    expect(select).toContainHTML("企业资料与品牌事实");
    for (const label of [
      "企业资料与品牌事实",
      "产品案例与文档",
      "行业新闻与观察",
      "企业新闻与动态",
      "FAQ 与问答页面",
    ]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(
      screen.queryByRole("option", { name: "官网技术诊断" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("目标页面（选填）")).not.toBeInTheDocument();
  });

  it("submits content references and attachments without target-page fields", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const sourceFile = new File(["brief"], "brief.pdf", {
      type: "application/pdf",
    });
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitContent: true,
        }}
        contentCatalog={websiteContentCatalog}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("需求类型"), {
      target: { value: "company_news" },
    });
    fireEvent.change(screen.getByLabelText("话题"), {
      target: { value: "发布企业合作动态" },
    });
    fireEvent.change(screen.getByLabelText("参考资料（选填）"), {
      target: { value: "https://example.com/source" },
    });
    fireEvent.change(screen.getByLabelText("上传官网工单附件"), {
      target: { files: [sourceFile] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "company_news",
        topic: "发布企业合作动态",
        description: "",
        targetPage: "",
        materialUrls: ["https://example.com/source"],
        attachmentFiles: [sourceFile],
      }),
    );
  });

  it("unifies pending and completed records and reveals only public summaries", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitContent: true,
        }}
        tickets={[
          {
            id: "pending",
            type: "website_operation",
            category: "company_facts",
            topic: "更新企业资料",
            status: "needs_information",
            publicStatus: "pending",
            revision: 1,
            submittedAt: "2026-07-26",
            latestPublicMessage: "这段过程回复不能在列表显示。",
          },
          {
            id: "completed",
            type: "website_operation",
            category: "company_news",
            topic: "发布企业动态",
            status: "completed",
            publicStatus: "completed",
            publicSummary: "已完成企业动态内容更新。",
            revision: 2,
            submittedAt: "2026-07-25",
            resolvedAt: "2026-07-27",
            attachmentCount: 2,
            deliveryLinks: [
              {
                label: "查看发布页面",
                url: "https://example.com/news",
              },
            ],
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("更新企业资料")).toBeInTheDocument();
    expect(screen.getByText("发布企业动态")).toBeInTheDocument();
    expect(
      screen.queryByText("这段过程回复不能在列表显示。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("查看发布页面")).not.toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
    expect(screen.queryByText(/交付文件/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("发布企业动态"));
    expect(screen.getByText("内容总结")).toBeInTheDocument();
    expect(screen.getByText("已完成企业动态内容更新。")).toBeInTheDocument();
  });

  it("does not invent a preview domain or technical check result", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("customer.example.invalid"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("已通过")).not.toBeInTheDocument();
    expect(screen.queryByText("核验依据")).not.toBeInTheDocument();
  });

  it("loads the next page of unified history on demand", () => {
    const onLoadMore = vi.fn();
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{ domainStatus: "not_started", icpStatus: "locked" }}
        tickets={[]}
        hasMore
        onLoadMore={onLoadMore}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
