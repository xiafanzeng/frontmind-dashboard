import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { tabularTablesFromFile } from "./dashboard-api";
import {
  importedKeywordCategoryCounts,
  normalizeImportedKeywordTables,
} from "./keyword-table-import";

describe("uploaded keyword workbook compatibility", () => {
  it("imports the supplied six-column workbook shape and maps all 480 rows", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("问题列表");
    sheet.addRow(["序号", "问题", "核心词", "核心词分类", "热度", "创建日期"]);
    const categories = ["品牌核心词", "场景痛点词", "品类行业词", "竞品对比词"];
    for (let index = 0; index < 480; index += 1) {
      sheet.addRow([
        index + 1,
        `硅基流动测试问题 ${index + 1}？`,
        `核心词 ${Math.floor(index / 12) + 1}`,
        categories[Math.floor(index / 120)],
        10_000 + index,
        new Date("2026-07-27T00:00:00.000Z"),
      ]);
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const tables = normalizeImportedKeywordTables(
      await tabularTablesFromFile({
        buffer,
        sourceFileName: "硅基流动-全域词库-问题列表.xlsx",
      }),
    );

    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      title: "问题列表",
      columns: ["序号", "问题", "核心词", "核心词分类", "热度", "创建日期"],
    });
    expect(tables[0]?.rows).toHaveLength(480);
    expect(tables[0]?.rows[0]?.[5]).toBe("2026-07-27");
    expect(importedKeywordCategoryCounts(tables)).toEqual({
      行业排名词: 120,
      竞品对比词: 120,
      美誉舆情词: 120,
      产品场景词: 120,
    });
  });
});
