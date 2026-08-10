import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { tabularTablesFromFile } from "./dashboard-api";
import {
  importedKeywordCategoryCounts,
  normalizeImportedKeywordTables,
} from "./keyword-table-import";

const SPREADSHEETML_NAMESPACE =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

async function workbookWithPrefixedSpreadsheetMlElements(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer);
  await Promise.all(
    Object.values(archive.files).map(async (entry) => {
      if (entry.dir || !entry.name.toLowerCase().endsWith(".xml")) return;
      const source = await entry.async("string");
      const defaultNamespace = `xmlns="${SPREADSHEETML_NAMESPACE}"`;
      if (!source.includes(defaultNamespace)) return;
      const prefixed = source
        .replace(defaultNamespace, `xmlns:x="${SPREADSHEETML_NAMESPACE}"`)
        .replace(/<\/?[A-Za-z_][\w.-]*(?=[\s/>])/g, (tag) =>
          tag.replace(/^<(\/)?/, "<$1x:"),
        );
      archive.file(entry.name, prefixed);
    }),
  );
  return Buffer.from(await archive.generateAsync({ type: "nodebuffer" }));
}

describe("uploaded keyword workbook compatibility", () => {
  it("imports the latest seven-column workbook shape and preserves all 160 rows", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("问题列表");
    sheet.addRow([
      "序号",
      "问题",
      "核心词",
      "核心词分类",
      "热度",
      "创建日期",
      "问题细分",
    ]);
    const subdivisions = [
      "产品能力",
      "信任验证",
      "品牌认知",
      "品类发现",
      "售后合作",
      "场景方案",
      "竞品对比",
      "采购决策",
    ];
    for (let index = 0; index < 160; index += 1) {
      const category =
        index < 20
          ? "行业排名词"
          : index < 40
            ? "竞品对比词"
            : index < 60
              ? "美誉舆情词"
              : "产品场景词";
      sheet.addRow([
        index + 1,
        `硅基流动测试问题 ${index + 1}？`,
        `核心词 ${Math.floor(index / 12) + 1}`,
        category,
        10_000 + index,
        new Date("2026-07-27T00:00:00.000Z"),
        subdivisions[index % subdivisions.length],
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
      columns: [
        "序号",
        "问题",
        "核心词",
        "核心词分类",
        "热度",
        "创建日期",
        "问题细分",
      ],
    });
    expect(tables[0]?.rows).toHaveLength(160);
    expect(tables[0]?.rows[0]?.[5]).toBe("2026-07-27");
    expect(tables[0]?.rows[0]?.[6]).toBe("产品能力");
    expect(importedKeywordCategoryCounts(tables)).toEqual({
      行业排名词: 20,
      竞品对比词: 20,
      美誉舆情词: 20,
      产品场景词: 100,
    });
  });

  it("imports valid SpreadsheetML workbooks whose elements use a namespace prefix", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("问题列表");
    sheet.addRow([
      "序号",
      "问题",
      "核心词",
      "核心词分类",
      "热度",
      "创建日期",
      "问题细分",
    ]);
    sheet.addRow([
      1,
      "免费大模型 API 平台有哪些？",
      "大模型 API",
      "行业排名词",
      37_651,
      new Date("2026-07-27T00:00:00.000Z"),
      "采购决策",
    ]);
    const prefixedBuffer = await workbookWithPrefixedSpreadsheetMlElements(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    const archive = await JSZip.loadAsync(prefixedBuffer);
    expect(await archive.file("xl/workbook.xml")?.async("string")).toContain(
      "<x:workbook",
    );

    const tables = normalizeImportedKeywordTables(
      await tabularTablesFromFile({
        buffer: prefixedBuffer,
        sourceFileName: "prefixed-keywords.xlsx",
      }),
    );

    expect(tables).toHaveLength(1);
    expect(tables[0]?.columns).toEqual([
      "序号",
      "问题",
      "核心词",
      "核心词分类",
      "热度",
      "创建日期",
      "问题细分",
    ]);
    expect(tables[0]?.rows).toEqual([
      [
        "1",
        "免费大模型 API 平台有哪些？",
        "大模型 API",
        "行业排名词",
        "37651",
        "2026-07-27",
        "采购决策",
      ],
    ]);
  });
});
