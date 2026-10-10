// Luna's ONE spreadsheet implementation (Phase 12): a small, controlled
// .xlsx reader and writer on top of fflate (zip only). Shared by imports
// now and by every future Excel download (docs/ARCHITECTURE.md, Luna-wide
// requirements), in the browser or on the server.
//
// Deliberately minimal and safe:
//   reading  first worksheet only, values only. Formulas are never
//            evaluated (a formula cell gives its cached value), styles /
//            macros / external links are ignored, and size limits stop
//            zip bombs. Numbers come back as their shortest decimal text
//            ("19.99", never "19.989999999999998").
//   writing  every cell is a plain number or an inline string, never a
//            formula. Text that a spreadsheet could treat as a formula
//            (= + - @, tab, CR) is prefixed with ' (safeCellText).

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

export const XLSX_LIMITS = Object.freeze({ maxFileBytes: 5_000_000, maxUnzippedBytes: 40_000_000, maxRows: 5000, maxCols: 60 });

export class SpreadsheetError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid-file";
  }
}

// ---------- shared cell safety ----------

// Neutralises spreadsheet formula injection for text cells (OWASP CSV
// injection guidance), used by every Luna export (xlsx and csv).
export function safeCellText(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// ---------- XML helpers ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e];
  });
}
// Escapes text for XML and drops characters XML 1.0 can't carry.
function encodeXml(s) {
  return String(s)
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1].replace(/^\w+:/, (p) => (p === "r:" ? "r:" : "")), decodeXml(m[2])]));
// All <t> text inside a fragment (shared string / inline string, incl. rich
// text runs); phonetic runs (<rPh>) are skipped.
const textOf = (xml) => [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decodeXml(m[1])).join("");

function colIndex(ref) {
  const letters = /^([A-Z]{1,3})\d+$/.exec(ref);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// ---------- reading ----------

export function isXlsx(bytes) {
  return bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// bytes: Uint8Array of an .xlsx file -> { sheetName, rows: string[][] }
// (first worksheet; trailing empty rows dropped; ragged rows padded).
// sheet: a sheet name to read instead of the first (imports always read the first).
export function readXlsx(bytes, { maxRows = XLSX_LIMITS.maxRows, maxCols = XLSX_LIMITS.maxCols, sheet: sheetName = null } = {}) {
  if (!isXlsx(bytes)) throw new SpreadsheetError("This isn't an .xlsx file");
  if (bytes.length > XLSX_LIMITS.maxFileBytes) throw new SpreadsheetError("The file is too large (max 5 MB)");
  let total = 0;
  let files;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (f.originalSize > XLSX_LIMITS.maxUnzippedBytes || total > XLSX_LIMITS.maxUnzippedBytes) throw new SpreadsheetError("The file expands too much to be a normal spreadsheet");
        return f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name);
      },
    });
  } catch (err) {
    if (err instanceof SpreadsheetError) throw err;
    throw new SpreadsheetError("The .xlsx file is damaged or isn't a real spreadsheet");
  }
  const text = (name) => (files[name] ? strFromU8(files[name]) : null);
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new SpreadsheetError("The .xlsx file has no workbook");
  const sheetTags = [...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)].map((m) => attrs(m[1]));
  if (!sheetTags.length) throw new SpreadsheetError("The workbook has no sheets");
  const sheetAttrs = sheetName === null ? sheetTags[0] : sheetTags.find((a) => decodeXml(a.name || "") === sheetName);
  if (!sheetAttrs) throw new SpreadsheetError(`The workbook has no sheet named ${sheetName}`);
  const rid = sheetAttrs["r:id"] || sheetAttrs.id;
  let target = null;
  const rels = text("xl/_rels/workbook.xml.rels") || "";
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id === rid) target = a.Target;
  }
  const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  const sheet = text(path) || (sheetName === null ? text("xl/worksheets/sheet1.xml") : null);
  if (!sheet) throw new SpreadsheetError("The first worksheet is missing");

  const shared = [];
  const sst = text("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textOf(m[1]));

  const rows = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const r = Number(attrs(rm[1]).r) || rows.length + 1;
    if (r > maxRows + 1) throw new SpreadsheetError(`The sheet has more than ${maxRows} rows`);
    const cells = [];
    for (const cm of (rm[2] || "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const a = attrs(cm[1]);
      let col = a.r ? colIndex(a.r) : cells.length;
      if (col < 0) col = cells.length;
      if (col >= maxCols) throw new SpreadsheetError(`The sheet has more than ${maxCols} columns`);
      const inner = cm[2] || "";
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
      const raw = v ? decodeXml(v[1]) : "";
      let value = "";
      switch (a.t) {
        case "s":
          value = shared[Number(raw)] ?? "";
          break;
        case "inlineStr":
          value = textOf(inner);
          break;
        case "b":
          value = raw === "1" ? "TRUE" : "FALSE";
          break;
        case "str":
        case "e":
          value = raw;
          break;
        default:
          value = raw === "" ? "" : Number.isFinite(Number(raw)) ? String(Number(raw)) : raw;
      }
      cells[col] = value;
    }
    rows[r - 1] = Array.from(cells, (c) => c ?? "");
  }
  const dense = Array.from(rows, (r) => r ?? []);
  while (dense.length && dense.at(-1).every((c) => String(c).trim() === "")) dense.pop();
  const width = Math.max(0, ...dense.map((r) => r.length));
  return { sheetName: sheetAttrs.name || "Sheet1", rows: dense.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "")) };
}

// ---------- writing ----------

const cleanSheetName = (name, used) => {
  let n = String(name || "Sheet").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let k = 2;
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${k++}`;
  used.add(n.toLowerCase());
  return n;
};

// Number formats a column may declare (cell values stay plain numbers).
const NUMBER_STYLES = Object.freeze({ money: 2, integer: 3, percent: 4, date: 5, datetime: 6 });
// Phase 18.6: bold variants for a totals row (same number formats), and a title.
const BOLD_STYLES = Object.freeze({ text: 1, money: 8, integer: 9, number: 1, percent: 10, date: 1, datetime: 1 });
const TITLE_STYLE = 7;
export const XLSX_COLUMN_FORMATS = Object.freeze(["text", "number", ...Object.keys(NUMBER_STYLES)]);

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  // Money is Philippine peso: ₱1,234.50 / -₱1,234.50 (Phase 18.6).
  `<numFmts count="3"><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="168" formatCode="&quot;₱&quot;#,##0.00;-&quot;₱&quot;#,##0.00"/></numFmts>` +
  `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>` +
  `<cellXfs count="11"><xf fontId="0"/><xf fontId="1" applyFont="1"/><xf fontId="0" numFmtId="168" applyNumberFormat="1"/><xf fontId="0" numFmtId="3" applyNumberFormat="1"/><xf fontId="0" numFmtId="10" applyNumberFormat="1"/><xf fontId="0" numFmtId="166" applyNumberFormat="1"/><xf fontId="0" numFmtId="167" applyNumberFormat="1"/><xf fontId="2" applyFont="1"/><xf fontId="1" numFmtId="168" applyFont="1" applyNumberFormat="1"/><xf fontId="1" numFmtId="3" applyFont="1" applyNumberFormat="1"/><xf fontId="1" numFmtId="10" applyFont="1" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const coreXml = (meta) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  (meta.title ? `<dc:title>${encodeXml(String(meta.title).slice(0, 200))}</dc:title>` : "") +
  `<dc:creator>${encodeXml(String(meta.creator || "Luna Business OS").slice(0, 200))}</dc:creator>` +
  (meta.created instanceof Date && !Number.isNaN(meta.created.getTime()) ? `<dcterms:created xsi:type="dcterms:W3CDTF">${meta.created.toISOString().replace(/\.\d{3}Z$/, "Z")}</dcterms:created>` : "") +
  `</cp:coreProperties>`;

// sheets: [{ name, rows: (string|number|null)[][], header?: true,
//            columns?: [{ format?: "text"|"number"|"money"|"integer"|"percent"|"date"|"datetime", width? }],
//            Phase 18.6 (one worksheet per report):
//            headerRow?: index of THE header row (default 0): bold, frozen below
//            titleRows?: row indexes shown as a title (bold, larger)
//            filter?: true -> AutoFilter on the header row and the rows under it
//            totalRow?: index of a totals row (bold, same number formats)
//            print?: true -> landscape, fit all columns on one page wide }]
// meta (optional): { title, creator, created: Date } -> document properties.
// -> Uint8Array .xlsx. Numbers stay numbers (styled by their column's
// format; dates are Excel serials, see shared/exports.js excelSerial); everything else is an
// inline string passed through safeCellText. With a header row, the first
// row is bold and frozen.
export function writeXlsx(sheets, meta = null) {
  if (!Array.isArray(sheets) || !sheets.length) throw new SpreadsheetError("Nothing to write");
  const used = new Set();
  const names = sheets.map((s) => cleanSheetName(s.name, used));
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${meta ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : ""}${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>${meta ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : ""}</Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${encodeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ),
    "xl/styles.xml": strToU8(STYLES_XML),
  };
  if (meta) files["docProps/core.xml"] = strToU8(coreXml(meta));
  const filterNames = [];
  sheets.forEach((s, i) => {
    const header = s.header !== false;
    const headerRow = header ? (Number.isSafeInteger(s.headerRow) && s.headerRow >= 0 ? s.headerRow : 0) : -1;
    const titles = new Set(Array.isArray(s.titleRows) ? s.titleRows : []);
    const totalRow = Number.isSafeInteger(s.totalRow) ? s.totalRow : -1;
    const columns = Array.isArray(s.columns) ? s.columns : [];
    const numberStyle = columns.map((c) => (c && NUMBER_STYLES[c.format] ? ` s="${NUMBER_STYLES[c.format]}"` : ""));
    const boldStyle = columns.map((c) => ` s="${BOLD_STYLES[c?.format] ?? 1}"`);
    const rows = s.rows || [];
    const width = Math.max(1, columns.length, ...rows.map((r) => (r || []).length));
    const body = rows
      .map((row, r) => {
        const head = r === headerRow;
        const style = (c, num) => (titles.has(r) ? ` s="${TITLE_STYLE}"` : head ? ' s="1"' : r === totalRow ? (num ? boldStyle[c] : ' s="1"') : num ? numberStyle[c] || "" : "");
        const cells = (row || [])
          .map((v, c) => {
            const ref = `${colName(c)}${r + 1}`;
            if (v === null || v === undefined || v === "") return "";
            if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style(c, true)}><v>${v}</v></c>`;
            return `<c r="${ref}"${style(c, false)} t="inlineStr"><is><t xml:space="preserve">${encodeXml(safeCellText(v))}</t></is></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    const split = headerRow + 1;
    const views = header && rows.length > split ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${split}" topLeftCell="A${split + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
    const widths = columns.some((c) => c && c.width)
      ? `<cols>${columns.map((c, k) => (c && c.width ? `<col min="${k + 1}" max="${k + 1}" width="${Math.min(80, Math.max(4, Number(c.width) || 10))}" customWidth="1"/>` : "")).join("")}</cols>`
      : "";
    // AutoFilter over the header and its data rows (the totals row stays out).
    const lastData = (totalRow > headerRow ? totalRow - 1 : rows.length - 1) + 1;
    const range = header && s.filter ? `A${split}:${colName(width - 1)}${Math.max(split, lastData)}` : null;
    if (range) filterNames.push({ sheet: i, name: names[i], range });
    const filter = range ? `<autoFilter ref="${range}"/>` : "";
    const sheetPr = s.print ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : "";
    const page = s.print ? '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : "";
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetPr}${views}${widths}<sheetData>${body}</sheetData>${filter}${page}</worksheet>`);
  });
  // Excel expects a hidden _FilterDatabase name for each AutoFilter.
  if (filterNames.length) {
    const quote = (n) => `'${n.replace(/'/g, "''")}'`;
    const abs = (range) => range.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
    const defined = `<definedNames>${filterNames.map((f) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${f.sheet}" hidden="1">${encodeXml(`${quote(f.name)}!${abs(f.range)}`)}</definedName>`).join("")}</definedNames>`;
    files["xl/workbook.xml"] = strToU8(new TextDecoder().decode(files["xl/workbook.xml"]).replace("</sheets>", `</sheets>${defined}`));
  }
  return zipSync(files, { level: 6 });
}
