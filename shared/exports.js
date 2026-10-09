// Luna Export Core (Phase 12.5): the one controlled way data leaves Luna as
// a spreadsheet. Pure and workspace-agnostic; the server (netlify/functions/
// _lib/export-core.js) runs it, the browser uses the descriptors only to
// decide whether to offer a download.
//
// Filter -> View -> Download: an export takes the SAME validated filters as
// the list on screen and returns every matching row (all pages), up to
// EXPORT_MAX_ROWS; beyond that it is refused, never silently truncated.
//
// Access (all checked on the server, before anything is read):
//   membership + subscription (requireTenant) AND the dataset's module
//   (entitled, built, allowed by the workspace) AND every `view` permission
//   AND the dataset's export permission (data.export; Reports keeps
//   reports.export). Columns that need more (costs, money) declare `needs`;
//   the server never READS what a caller may not receive.
//
// A dataset descriptor names its module, permissions and filters; the
// domain code (one file per dataset on the server) supplies columns and
// queries. Future workspaces (payroll, bridal, baby) add descriptors with
// their own modules; nothing here is Distributor-specific.

import { daysBetween, REPORT_MAX_DAYS } from "./reports.js";
import { isDayId } from "./metrics.js";
import { canUseModule } from "./modules.js";
import { QTY_SCALE } from "./quantity.js";

// INITIAL synchronous safety limit, not a scalability claim. Measured
// locally (scripts/measure-export.js): 10,000 orders + 30,000 lines build
// in ~1.8 s CPU into a 2.1 MB workbook (2.9 MB base64; Netlify allows 6 MB).
// To be re-benchmarked on production infrastructure (Phase 19).
export const EXPORT_MAX_ROWS = 10_000;
export const EXPORT_MAX_DAYS = REPORT_MAX_DAYS;
export const EXPORT_PERMISSION = "data.export";
export const TOO_MANY_ROWS_MESSAGE = "This export contains too many rows. Narrow your filters and try again.";

export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- filter schemas ----------

export const filter = Object.freeze({
  oneOf: (values) => ({ type: "enum", values: Object.freeze([...values]) }),
  day: () => ({ type: "day" }),
  text: (max = 100) => ({ type: "text", max }),
  flag: () => ({ type: "bool" }),
  // A record id (e.g. one staff member): letters and digits only.
  id: () => ({ type: "id" }),
});

// Validates `raw` against a dataset's filter schema. Unknown keys, wrong
// types and bad ranges are refused (never ignored); empty values are
// dropped. A from/to pair is inclusive, ordered and at most EXPORT_MAX_DAYS;
// `rangeRequired` datasets need both.
export function validateExportFilters(descriptor, raw, { today = null } = {}) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ExportError("invalid-filters", "Invalid filters");
  const schema = descriptor.filters;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : null;
    if (!rule) throw new ExportError("invalid-filters", `Unknown filter ${key}`);
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (rule.type === "enum") {
      if (!rule.values.includes(value)) throw new ExportError("invalid-filters", `Invalid ${key}`);
      out[key] = value;
    } else if (rule.type === "day") {
      if (!isDayId(value)) throw new ExportError("invalid-filters", `${key} must be a date (YYYY-MM-DD)`);
      out[key] = value;
    } else if (rule.type === "text") {
      if (typeof value !== "string" || value.length > rule.max) throw new ExportError("invalid-filters", `Invalid ${key}`);
      const t = value.trim();
      if (t) out[key] = t;
    } else if (rule.type === "id") {
      if (typeof value !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(value)) throw new ExportError("invalid-filters", `Invalid ${key}`);
      out[key] = value;
    } else if (rule.type === "bool") {
      if (value !== true) throw new ExportError("invalid-filters", `Invalid ${key}`);
      out[key] = true;
    }
  }
  if (descriptor.rangeRequired && (!out.from || !out.to)) throw new ExportError("invalid-range", "Choose a start and end date");
  if (out.from && out.to) {
    if (out.from > out.to) throw new ExportError("invalid-range", "The start date is after the end date");
    if (daysBetween(out.from, out.to) > EXPORT_MAX_DAYS) throw new ExportError("invalid-range", `Choose at most ${EXPORT_MAX_DAYS} days`);
  }
  if (descriptor.rangeRequired && today && out.to > today) throw new ExportError("invalid-range", "The range can't end after today");
  return out;
}

// ---------- access ----------

// May this member download this dataset? (The server checks the same, plus
// membership/subscription in requireTenant.)
export function canExport({ entitlements, permissions }, descriptor) {
  if (!descriptor || !permissions) return false;
  return canUseModule({ entitlements, permissions }, descriptor.module) && descriptor.view.every((p) => permissions[p] === true) && permissions[descriptor.exportPermission] === true;
}

// The columns this member may receive: `needs` lists extra permissions.
export function visibleColumns(columns, permissions) {
  return columns.filter((c) => !c.needs || c.needs.every((p) => permissions && permissions[p] === true));
}

// ---------- cells ----------

// Excel serial for a wall-clock date/time { y, m, d, hh?, mm? } (1900 date
// system): what "date" / "datetime" columns hold. No timezone here: callers
// pass business-local wall-clock parts.
export function excelSerial({ y, m, d, hh = 0, mm = 0, ss = 0 }) {
  return (Date.UTC(y, m - 1, d, hh, mm, ss) - Date.UTC(1899, 11, 30)) / 86400000;
}


const PARTS_CACHE = new Map();
function wallClock(date, timezone) {
  let fmt = PARTS_CACHE.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    PARTS_CACHE.set(timezone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}
const toDate = (v) => (v instanceof Date ? v : v && typeof v.toDate === "function" ? v.toDate() : v && typeof v._seconds === "number" ? new Date(v._seconds * 1000) : null);

// One value -> one cell for a column `format` (business timezone for times).
export function cellValue(format, v, timezone) {
  if (v === null || v === undefined || v === "") return null;
  switch (format) {
    case "money":
      return Number.isSafeInteger(v) ? v / 100 : null; // centavos -> pesos
    case "quantity":
      return Number.isSafeInteger(v) ? v / QTY_SCALE : null;
    case "integer":
      return Number.isSafeInteger(v) ? v : null;
    case "percent":
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    case "date": {
      if (!isDayId(v)) return null;
      const [y, m, d] = v.split("-").map(Number);
      return excelSerial({ y, m, d });
    }
    case "datetime": {
      const date = toDate(v);
      return date && !Number.isNaN(date.getTime()) ? Math.round(excelSerial(wallClock(date, timezone)) * 86400) / 86400 : null;
    }
    case "bool":
      return v === true ? "Yes" : "No";
    default:
      return String(v);
  }
}
const SHEET_FORMAT = { money: "money", quantity: "number", integer: "integer", percent: "percent", date: "date", datetime: "datetime" };

// columns: [{ header, format, width?, value: (row) => raw }] -> one writeXlsx sheet.
export function tableSheet({ name, columns, rows, timezone }) {
  return {
    name,
    columns: columns.map((c) => ({ format: SHEET_FORMAT[c.format] || "text", width: c.width || Math.max(10, Math.min(40, c.header.length + 4)) })),
    rows: [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => cellValue(c.format, c.value(r), timezone)))],
  };
}

// Label/value sheet (summaries and the export information sheet).
export function pairsSheet({ name, rows, timezone }) {
  return {
    name,
    header: true,
    columns: [{ width: 34 }, { width: 28 }, { width: 40 }],
    rows: [["Item", "Value", "Note"], ...rows.map(([label, format, v, note]) => [label, cellValue(format, v, timezone), note ?? null])],
  };
}

// Plain-language filter summary for the information sheet.
export function describeFilters(descriptor, filters) {
  const entries = Object.entries(filters);
  if (!entries.length) return "None (all records)";
  return entries.map(([k, v]) => `${descriptor.filterLabels?.[k] ?? k}: ${v === true ? "yes" : v}`).join("; ");
}

// ---------- file names ----------

export function safeFileSegment(text, max = 40) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, max);
}

// Luna_Orders_2026-10-01_to_2026-10-31.xlsx, Luna_Inventory_2026-10-08.xlsx
export function exportFileName(label, { from = null, to = null, day = null } = {}) {
  const name = safeFileSegment(label) || "Export";
  if (from && to) return from === to ? `Luna_${name}_${from}.xlsx` : `Luna_${name}_${from}_to_${to}.xlsx`;
  if (from) return `Luna_${name}_from_${from}.xlsx`;
  if (to) return `Luna_${name}_to_${to}.xlsx`;
  return `Luna_${name}_${day}.xlsx`;
}
