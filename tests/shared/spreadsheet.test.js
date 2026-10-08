// Phase 12: Luna's shared spreadsheet layer (shared/xlsx.js, shared/csv.js).
// Reads what Excel / Google Sheets actually write, never evaluates
// formulas, refuses damaged or oversized files, and writes injection-safe
// workbooks that read back identically.

import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readXlsx, writeXlsx, safeCellText, isXlsx, SpreadsheetError } from "../../shared/xlsx.js";
import { parseCsv, toCsv } from "../../shared/csv.js";

// A workbook shaped like Excel's output: shared strings (incl. rich text and
// phonetic runs), a formula with a cached value, a double like 19.99 stored
// as 19.989999999999998, a boolean, sparse cells, an inline string, and
// the first sheet resolved through the workbook relationships.
function excelLike({ extra = {}, sheetXml } = {}) {
  const sheet =
    sheetXml ??
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="E1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>19.989999999999998</v></c><c r="C2"><f>B2*2</f><v>39.979999999999997</v></c><c r="E2" t="b"><v>1</v></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>Inline &amp; text</t></is></c><c r="B4"><v>1E-3</v></c></row>
      <row r="5"/>
    </sheetData></worksheet>`;
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="7" r:id="rId3"/><sheet name="Other" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`),
    "xl/sharedStrings.xml": strToU8(`<sst><si><t>SKU</t></si><si><t>Price</t></si><si><r><t>Dou</t></r><r><rPr><b/></rPr><t>ble</t></r></si><si><t>Active</t></si><si><t xml:space="preserve"> WINGS-1 </t><rPh><t>ignored</t></rPh></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG SHEET</t></is></c></row></sheetData></worksheet>`),
    "xl/worksheets/sheet3.xml": strToU8(sheet),
    ...extra,
  });
}

describe("reading .xlsx", () => {
  it("reads the FIRST sheet in workbook order, values only, numbers as shortest decimals", () => {
    const { sheetName, rows } = readXlsx(excelLike());
    expect(sheetName).toBe("Products");
    expect(rows).toEqual([
      ["SKU", "Price", "Double", "", "Active"],
      [" WINGS-1 ", "19.99", "39.98", "", "TRUE"],
      ["", "", "", "", ""],
      ["Inline & text", "0.001", "", "", ""],
    ]);
  });

  it("formulas are never evaluated: a formula cell is its cached value; an uncached one is empty", () => {
    const sheetXml = `<worksheet><sheetData><row r="1"><c r="A1"><f>HYPERLINK("http://x","click")</f></c><c r="B1" t="str"><f>"=1+1"</f><v>=1+1</v></c></row></sheetData></worksheet>`;
    expect(readXlsx(excelLike({ sheetXml })).rows).toEqual([["", "=1+1"]]);
  });

  it("namespace-prefixed XML (some generators) reads the same", () => {
    const sheetXml = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Hi</x:t></x:is></x:c><x:c r="B1"><x:v>5</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
    expect(readXlsx(excelLike({ sheetXml })).rows).toEqual([["Hi", "5"]]);
  });

  it("refuses non-xlsx, damaged, too-wide, too-long and zip-bomb files", () => {
    expect(() => readXlsx(strToU8("SKU,Price\n"))).toThrow(SpreadsheetError);
    expect(() => readXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(/damaged/);
    const wide = `<worksheet><sheetData><row r="1"><c r="ZZ1"><v>1</v></c></row></sheetData></worksheet>`;
    expect(() => readXlsx(excelLike({ sheetXml: wide }))).toThrow(/more than 60 columns/);
    const tall = `<worksheet><sheetData><row r="9000"><c r="A9000"><v>1</v></c></row></sheetData></worksheet>`;
    expect(() => readXlsx(excelLike({ sheetXml: tall }))).toThrow(/more than 5000 rows/);
    const bomb = excelLike({ extra: { "xl/worksheets/sheet9.xml": new Uint8Array(41_000_000) } });
    expect(() => readXlsx(bomb)).toThrow(/expands too much/);
    expect(isXlsx(strToU8("PK"))).toBe(false);
  }, 30000); // building the 41 MB bomb is slow on a busy machine
});

describe("writing .xlsx", () => {
  it("round-trips text and numbers; no formulas are ever written", () => {
    const bytes = writeXlsx([{ name: "Sheet/[1]:*?", rows: [["Name", "Qty"], ["ABC & <Co> \"q\"", 12.5], [null, 0]] }, { name: "Sheet/[1]:*?", rows: [["x"]] }]);
    const back = readXlsx(bytes);
    expect(back.sheetName).toBe("Sheet 1");
    expect(back.rows).toEqual([["Name", "Qty"], ['ABC & <Co> "q"', "12.5"], ["", "0"]]);
    const xml = new TextDecoder().decode(bytes);
    expect(xml).not.toMatch(/<f>/);
  });

  it("neutralises formula-looking text (= + - @ tab CR) in every cell", () => {
    for (const v of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"]) expect(safeCellText(v)).toBe(`'${v}`);
    for (const v of ["ok", "1-2", "a=b", ""]) expect(safeCellText(v)).toBe(v);
    const back = readXlsx(writeXlsx([{ name: "S", rows: [["=HYPERLINK(\"http://evil\",\"x\")"]] }]));
    expect(back.rows[0][0]).toBe(`'=HYPERLINK("http://evil","x")`);
  });

  it("drops characters XML can't carry instead of producing a broken file", () => {
    expect(readXlsx(writeXlsx([{ name: "S", rows: [["a\u0000b\u0007c"]] }])).rows[0][0]).toBe("abc");
  });
});

describe("CSV", () => {
  it("parses quotes, commas and newlines inside quotes, doubled quotes, BOM, CRLF", () => {
    const text = `﻿Name,Notes\r\n"ABC, Inc.","He said ""hi""\nsecond line"\r\nXYZ,\r\n\r\n`;
    expect(parseCsv(text)).toEqual([["Name", "Notes"], ["ABC, Inc.", 'He said "hi"\nsecond line'], ["XYZ", ""]]);
  });
  it("reads ';' files from locales that use them; refuses an unclosed quote", () => {
    expect(parseCsv("SKU;Price\nA1;1,50\n")).toEqual([["SKU", "Price"], ["A1", "1,50"]]);
    expect(() => parseCsv('a,"b\n')).toThrow(/unclosed quote/);
  });
  it("writes injection-safe CSV", () => {
    expect(toCsv([["=1+1", 'a"b', 5]])).toBe(`"'=1+1","a""b","5"`);
  });
});
