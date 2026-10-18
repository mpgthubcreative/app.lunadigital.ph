// Download Excel (Owner pilot, 2026-10-18): ONE clean workbook per
// workspace, the only customer-facing download (More → Download Excel).
// Shared by the page (src/modules/downloads) and the server
// (netlify/functions/workbook.js -> _lib/workbook/).
//
//   Household  Expenses, Payroll, Payroll Breakdown, Attendance, Advances,
//              Grocery List
//   Bridal     Money, Payments, Tasks, Guests, Party Members, Seating,
//              Roles, Crew Meals, Music & Program, Wedding Setup
//   Business   Orders, Payments, Users, Inventory, Customers
//
// Range (Household / Business; a wedding is one event, always everything):
//   month   this month in the business's timezone (the default)
//   custom  from .. to (inclusive, at most WORKBOOK_MAX_DAYS)
//   all     every record
// Dated records follow the range; lists (Users, Inventory, Customers,
// Grocery List, the wedding) are as they are now.
//
// The Master Backup (every record, technical) is NOT this: it is for Luna
// Super Admin only (/api/backup).

import { isDayId } from "./metrics.js";
import { daysBetween } from "./reports.js";
import { snapshotWorkspaceTemplateId } from "./workspaces.js";

export const WORKBOOK_PERMISSION = "data.export";
export const WORKBOOK_MAX_DAYS = 366;
export const WORKBOOK_RANGES = Object.freeze({ month: { label: "This month" }, custom: { label: "Custom range" }, all: { label: "All records" } });

export class WorkbookError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Which workbook a workspace gets.
export function workbookKind(entitlements) {
  const t = snapshotWorkspaceTemplateId(entitlements);
  if (t === "household-payroll") return "household";
  if (t === "bridal-expense") return "bridal";
  if (t === "baby-expense") return "baby";
  return "business";
}
// Bridal has no range choice (the whole wedding).
export const workbookHasRange = (kind) => kind !== "bridal";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;

// { range, from?, to? } -> { range, from, to, fileLabel, label } (from / to
// null for "all"). Refuses anything else.
export function resolveWorkbookRange(input, { today }) {
  const v = input && typeof input === "object" ? input : {};
  const range = v.range ?? "month";
  if (!Object.hasOwn(WORKBOOK_RANGES, range)) throw new WorkbookError("invalid-range", "Choose This month, Custom range or All records.");
  if (range === "all") return { range, from: null, to: null, fileLabel: "All-records", label: "All records" };
  if (range === "month") {
    const [y, m] = today.split("-").map(Number);
    return { range, from: `${today.slice(0, 7)}-01`, to: monthEnd(y, m), fileLabel: `${MONTHS[m - 1]}-${y}`, label: `${MONTHS[m - 1]} ${y}` };
  }
  const { from, to } = v;
  if (!isDayId(from) || !isDayId(to)) throw new WorkbookError("invalid-range", "Choose a start and end date.");
  if (from > to) throw new WorkbookError("invalid-range", "The start date is after the end date.");
  if (daysBetween(from, to) > WORKBOOK_MAX_DAYS) throw new WorkbookError("invalid-range", `Choose at most ${WORKBOOK_MAX_DAYS} days, or All records.`);
  // A whole calendar month reads as one.
  const [y, m] = from.split("-").map(Number);
  const whole = from.endsWith("-01") && to === monthEnd(y, m);
  return { range, from, to, fileLabel: whole ? `${MONTHS[m - 1]}-${y}` : `${from}-to-${to}`, label: whole ? `${MONTHS[m - 1]} ${y}` : `${from} to ${to}` };
}

// "Hayst Kopi" -> "Hayst-Kopi"; "Carlo & Yanie" -> "Carlo-Yanie".
export function fileWords(text, max = 40) {
  return (
    String(text ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || ""
  );
}

// Luna-Household-Oct-2026.xlsx, Luna-Business-Hayst-Kopi-Oct-2026.xlsx,
// Luna-Bridal-Carlo-Yanie.xlsx
export function workbookFileName(kind, { range = null, businessName = "", coupleNames = "" } = {}) {
  if (kind === "bridal") return `Luna-Bridal-${fileWords(coupleNames) || fileWords(businessName) || "Wedding"}.xlsx`;
  const head = kind === "household" ? "Luna-Household" : kind === "baby" ? "Luna-Baby" : ["Luna-Business", fileWords(businessName)].filter(Boolean).join("-");
  return `${head}-${range?.fileLabel || "All-records"}.xlsx`;
}
