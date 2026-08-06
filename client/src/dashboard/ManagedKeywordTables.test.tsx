import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ManagedKeywordTables from "./ManagedKeywordTables";

const tables = [
  {
    id: "question-list-1",
    title: "问题列表",
    columns: ["序号", "问题", "核心词", "核心词分类", "热度", "创建日期"],
    rows: [
      ["1", "品牌问题", "品牌", "品牌核心词", "10", "2026-07-27"],
      ["2", "场景问题", "场景", "场景痛点词", "20", "2026-07-27"],
      ["3", "行业问题", "行业", "品类行业词", "30", "2026-07-27"],
      ["4", "竞品问题", "竞品", "竞品对比词", "40", "2026-07-27"],
    ],
  },
];

describe("ManagedKeywordTables", () => {
  it("renders the uploaded workbook with the four canonical filters", () => {
    render(<ManagedKeywordTables tables={tables} />);

    const categoryFilter = screen.getByLabelText("分类");
    expect(
      within(categoryFilter).getByRole("option", { name: "全部分类" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).getByRole("option", { name: "行业排名词" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).queryByRole("option", { name: "行业词" }),
    ).not.toBeInTheDocument();
    const keywordTable = screen.getByRole("table");
    expect(within(keywordTable).getByText("美誉舆情词")).toBeInTheDocument();
    expect(within(keywordTable).getByText("产品场景词")).toBeInTheDocument();
    expect(within(keywordTable).getByText("行业排名词")).toBeInTheDocument();
  });

  it("filters rows using the mapped category rather than the source wording", () => {
    render(<ManagedKeywordTables tables={tables} />);

    fireEvent.change(screen.getByLabelText("分类"), {
      target: { value: "industry" },
    });

    expect(screen.getByText("行业问题")).toBeInTheDocument();
    expect(screen.queryByText("品牌问题")).not.toBeInTheDocument();
    expect(screen.getByText(/当前显示/)).toHaveTextContent("当前显示 1 条");
  });
});
