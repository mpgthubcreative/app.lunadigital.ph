// Phase 18.6: every Luna Excel download is ONE worksheet: a title block, one
// header row (bold, frozen, filters), real numbers / dates, a totals row
// only for totalled columns, peso number format, a printable page setup.

import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { reportSheet, reportRows } from "../../shared/exports.js";
import { writeXlsx, readXlsx } from "../../shared/xlsx.js";

const cols = [
  { header: "Date", format: "date", value: (r) => r.date },
  { header: "Item", format: "text", value: (r) => r.item },
  { header: "Amount", format: "money", total: true, value: (r) => r.amount },
  { header: "Note", format: "text", value: (r) => r.note },
];
const rows = [
  { date: "2026-10-01", item: "Rice", amount: 10010, note: "=SUM(A1)" },
  { date: "2026-10-02", item: "Oil", amount: 20020 },
  { date: "2026-10-03", item: "Salt", amount: null },
];

describe("reportSheet + writeXlsx", () => {
  const sheet = reportSheet({ name: "Expenses", title: "Expenses · Biz", info: ["Filters: none", "3 records"], columns: cols, rows, timezone: "Asia/Manila" });
  const bytes = writeXlsx([sheet]);
  const files = unzipSync(bytes);
  const xml = (k) => new TextDecoder().decode(files[k]);

  it("title + info + blank row, then ONE header row, the data and a Total row", () => {
    const read = readXlsx(bytes, { sheet: "Expenses" }).rows;
    expect(read[0][0]).toBe("Expenses · Biz");
    expect(read[1][0]).toBe("Filters: none");
    expect(read[4]).toEqual(["Date", "Item", "Amount", "Note"]);
    expect(read.at(-1)).toEqual(["Total", "", "300.3", ""]);
    expect(reportRows(read)).toEqual([["Date", "Item", "Amount", "Note"], ["46296", "Rice", "100.1", "'=SUM(A1)"], ["46297", "Oil", "200.2", ""], ["46298", "Salt", "", ""]]);
    expect(Object.keys(files).filter((k) => k.startsWith("xl/worksheets/"))).toEqual(["xl/worksheets/sheet1.xml"]);
  });

  it("the header is frozen and filtered; money is pesos; totals bold; fits one page wide", () => {
    const s = xml("xl/worksheets/sheet1.xml");
    expect(s).toContain('<pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/>');
    expect(s).toContain('<autoFilter ref="A5:D8"/>');
    expect(s).toContain('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
    expect(s).toMatch(/<c r="C9" s="8"><v>300.3<\/v><\/c>/); // bold peso total
    expect(s).toMatch(/<c r="C6" s="2"><v>100.1<\/v><\/c>/);
    expect(xml("xl/styles.xml")).toContain('formatCode="&quot;₱&quot;#,##0.00;-&quot;₱&quot;#,##0.00"');
    expect(xml("xl/workbook.xml")).toContain("<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"0\" hidden=\"1\">'Expenses'!$A$5:$D$8</definedName>");
  });

  it("no totals row when nothing is totalled or there are no rows", () => {
    const plain = reportSheet({ name: "X", title: "X", columns: cols.map((c) => ({ ...c, total: false })), rows, timezone: "UTC" });
    expect(plain.totalRow).toBeUndefined();
    const empty = reportSheet({ name: "X", title: "X", columns: cols, rows: [], timezone: "UTC" });
    expect(empty.totalRow).toBeUndefined();
  });
});
