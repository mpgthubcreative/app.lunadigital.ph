// CSV reading (RFC 4180) and writing for imports and downloads. Writing
// shares the formula-injection guard with the .xlsx writer.

import { safeCellText, SpreadsheetError, XLSX_LIMITS } from "./xlsx.js";

// text -> string[][]. Handles a UTF-8 BOM, quoted fields with commas /
// newlines / doubled quotes, CRLF or LF, and ';' files (Excel in some
// locales) when the header row clearly uses it.
export function parseCsv(text, { maxRows = XLSX_LIMITS.maxRows, maxCols = XLSX_LIMITS.maxCols } = {}) {
  if (typeof text !== "string") throw new SpreadsheetError("Invalid CSV");
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
      if (row.length >= maxCols) throw new SpreadsheetError(`The file has more than ${maxCols} columns`);
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      if (rows.length > maxRows + 1) throw new SpreadsheetError(`The file has more than ${maxRows} rows`);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new SpreadsheetError("The CSV has an unclosed quote");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length && rows.at(-1).every((c) => c.trim() === "")) rows.pop();
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
}

export function toCsv(rows) {
  return rows.map((r) => r.map((v) => `"${safeCellText(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}
