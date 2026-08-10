import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ManagedKeywordTables from "./ManagedKeywordTables";

const tables = [
  {
    id: "question-list-1",
    title: "问题列表",
    columns: [
      "序号",
      "问题",
      "核心词",
      "核心词分类",
      "热度",
      "创建日期",
      "问题细分",
    ],
    rows: [
      ["1", "品牌问题", "品牌", "品牌核心词", "10", "2026-07-27", "品牌认知"],
      ["2", "场景问题", "场景", "场景痛点词", "20", "2026-07-27", "场景方案"],
      ["3", "行业问题", "行业", "品类行业词", "30", "2026-07-27", "品类发现"],
      ["4", "竞品问题", "竞品", "竞品对比词", "40", "2026-07-27", "竞品对比"],
    ],
  },
];

describe("ManagedKeywordTables", () => {
  it("renders the customer word bank without internal delivery copy or hidden source columns", () => {
    render(<ManagedKeywordTables tables={tables} />);

    expect(
      screen.getByText(
        "基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合反馈的真实热度呈现 GEO 优化问题。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "全域词库" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/AI 监控与优化工程师|正式词表|交付工单/),
    ).not.toBeInTheDocument();

    const categoryFilter = screen.getByLabelText("主分类");
    expect(
      within(categoryFilter).getByRole("option", { name: "全部主分类" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).getByRole("option", { name: "行业排名词" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).queryByRole("option", { name: "行业词" }),
    ).not.toBeInTheDocument();
    const keywordTable = screen.getByRole("table");
    expect(
      within(keywordTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["问题", "主分类", "问题细分", "热度"]);
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "序号" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "核心词" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByRole("columnheader", { name: "创建日期" }),
    ).not.toBeInTheDocument();
    expect(
      within(keywordTable).queryByText("2026-07-27"),
    ).not.toBeInTheDocument();
    expect(within(keywordTable).getByText("美誉舆情词")).toBeInTheDocument();
    expect(within(keywordTable).getByText("产品场景词")).toBeInTheDocument();
    expect(within(keywordTable).getByText("行业排名词")).toBeInTheDocument();
  });

  it("filters rows using the mapped category rather than the source wording", () => {
    render(<ManagedKeywordTables tables={tables} />);

    fireEvent.change(screen.getByLabelText("主分类"), {
      target: { value: "industry" },
    });

    expect(screen.getByText("行业问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌问题")).not.toBeInTheDocument();
    expect(screen.getByText(/当前显示/)).toHaveTextContent("当前显示 1 条");
  });

  it("sends the authoritative table id and original row index into problem optimization", () => {
    const onUseQuestion = vi.fn();
    render(
      <ManagedKeywordTables tables={tables} onUseQuestion={onUseQuestion} />,
    );

    fireEvent.change(screen.getByLabelText("主分类"), {
      target: { value: "product_scenario" },
    });

    const scenarioRow = screen.getByText("场景问题").closest("tr");
    expect(scenarioRow).not.toBeNull();
    expect(
      within(scenarioRow!).getByRole("cell", { name: "选择并进入问题优化" }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(scenarioRow!).getByRole("button", {
        name: "选择并进入问题优化",
      }),
    );

    expect(onUseQuestion).toHaveBeenCalledWith({
      question: "场景问题",
      category: "product_scenario",
      tableId: "question-list-1",
      rowIndex: 1,
    });
  });

  it("filters by question subdivision and sorts heat in both directions", () => {
    render(<ManagedKeywordTables tables={tables} />);

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]!).getByText("竞品问题")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("品牌问题")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("排序"), {
      target: { value: "heat-asc" },
    });
    const ascendingRows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(ascendingRows[1]!).getByText("品牌问题")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("问题细分"), {
      target: { value: "场景方案" },
    });
    expect(screen.getByText("场景问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌问题")).not.toBeInTheDocument();
    expect(screen.getByText(/当前显示/)).toHaveTextContent("当前显示 1 条");
  });

  it("does not allow an unknown source category to fall back to another quota", () => {
    const onUseQuestion = vi.fn();
    render(
      <ManagedKeywordTables
        tables={[
          {
            ...tables[0],
            rows: [["1", "未知类型问题", "未知", "无法识别", "10", ""]],
          },
        ]}
        onUseQuestion={onUseQuestion}
      />,
    );

    const action = screen.getByRole("button", {
      name: "选择并进入问题优化",
    });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onUseQuestion).not.toHaveBeenCalled();
  });

  it("shows a neutral waiting state before a word bank is published", () => {
    render(<ManagedKeywordTables tables={[]} />);

    expect(
      screen.getByRole("heading", { name: "品牌全域词库正在准备中" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("内容发布后会自动显示在这里。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/工单|AI 监控与优化工程师|候选问题目录/),
    ).not.toBeInTheDocument();
  });
});
