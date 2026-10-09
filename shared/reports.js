// Distributor Reports (Phase 11): pure definitions shared by the server
// (aggregation, rollup writes) and the browser (presets, display).
//
// Date ranges are business-local YYYY-MM-DD days, INCLUSIVE at both ends,
// at most REPORT_MAX_DAYS long and never past the business's today. The
// viewer's device timezone is never used: presets are computed from the
// business-local `today` the caller passes in.
//
// Report rollups (server-only, businesses/{bid}/reportRollups/{day|month})
// hold the breakdowns the metric documents don't: per product, per
// customer, per payment method, per expense category / method. They are
// maintained with increments in the same transaction as the business event
// and posted to the event's own day (fulfilment day, payment received day,
// expense date), so corrections restate history exactly like the metrics.

import { isDayId, addDays } from "./metrics.js";

export const REPORT_MAX_DAYS = 366;
// Up to this many days, reports read day documents and include a by-day
// series; longer ranges read month documents (+ partial edge days) and the
// series is by month.
export const DAILY_SERIES_MAX_DAYS = 62;
export const REPORT_TOP_ROWS = 50;
export const WALK_IN_KEY = "_walkin";

export class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- Day arithmetic on business-local day ids ----------

const toUTC = (dayId) => {
  const [y, m, d] = dayId.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
// One addDays for all of shared/ (metrics.js owns it; re-exported for callers).
export { addDays };
export const daysBetween = (from, to) => Math.round((toUTC(to) - toUTC(from)) / 86400000) + 1; // inclusive
const lastDayOfMonth = (monthId) => {
  const [y, m] = monthId.split("-").map(Number);
  return fromUTC(Date.UTC(y, m, 0));
};

// Presets from the business-local today. Weeks start on Monday.
export function reportPresets(today) {
  if (!isDayId(today)) throw new ReportError("invalid-range", "Invalid business date");
  const dow = (new Date(toUTC(today)).getUTCDay() + 6) % 7; // 0 = Monday
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = addDays(monthStart, -1);
  return {
    today: { label: "Today", from: today, to: today },
    yesterday: { label: "Yesterday", from: addDays(today, -1), to: addDays(today, -1) },
    thisWeek: { label: "This week", from: addDays(today, -dow), to: today },
    thisMonth: { label: "This month", from: monthStart, to: today },
    lastMonth: { label: "Last month", from: `${prevMonthEnd.slice(0, 7)}-01`, to: prevMonthEnd },
  };
}

export function validateRange({ from, to }, today) {
  if (!isDayId(from) || !isDayId(to)) throw new ReportError("invalid-range", "Choose valid start and end dates");
  if (from > to) throw new ReportError("invalid-range", "The start date is after the end date");
  if (today && to > today) throw new ReportError("invalid-range", "The range can't end after today");
  const days = daysBetween(from, to);
  if (days > REPORT_MAX_DAYS) throw new ReportError("invalid-range", `Choose at most ${REPORT_MAX_DAYS} days`);
  return { from, to, days };
}

// Sums metric documents (metrics / financialMetrics days or months) field
// by field. Every metrics write fills all counters, so a document that
// exists is a real (possibly zero) value; no document at all is "no data"
// (null), never a fabricated 0. Reports, the Dashboard period and both
// exports use this one function, so they can't disagree.
export function sumMetricDocs(docs, fields) {
  const out = {};
  let found = false;
  for (const d of docs) {
    if (!d) continue;
    found = true;
    for (const f of fields) if (Number.isSafeInteger(d[f])) out[f] = (out[f] ?? 0) + d[f];
  }
  return found ? out : null;
}

// Which summary documents cover [from, to] exactly:
//   daily   every day (span <= DAILY_SERIES_MAX_DAYS)
//   monthly whole months as month ids, partial edge months as their days
// `buckets` is the series: one per day, or one per month (each listing the
// document ids whose sum is that bucket).
export function rangePlan(from, to) {
  const days = daysBetween(from, to);
  if (days <= DAILY_SERIES_MAX_DAYS) {
    const ids = Array.from({ length: days }, (_, i) => addDays(from, i));
    return { granularity: "day", buckets: ids.map((id) => ({ period: id, docs: [id] })) };
  }
  const buckets = [];
  let cursor = from;
  while (cursor <= to) {
    const month = cursor.slice(0, 7);
    const monthEnd = lastDayOfMonth(month);
    const end = monthEnd < to ? monthEnd : to;
    const whole = cursor === `${month}-01` && end === monthEnd;
    if (whole) buckets.push({ period: month, docs: [month] });
    else buckets.push({ period: month, docs: Array.from({ length: daysBetween(cursor, end) }, (_, i) => addDays(cursor, i)) });
    cursor = addDays(end, 1);
  }
  return { granularity: "month", buckets };
}

// ---------- Contributions of one fulfilled order ----------

// Splits an order-level discount across its lines in proportion to their
// subtotals (largest remainder, deterministic), so per-product net sales
// add up exactly to the order's net sales.
export function allocateDiscount(lines, discount) {
  const subtotal = lines.reduce((s, l) => s + l.lineSubtotal, 0);
  if (!discount || !subtotal) return lines.map(() => 0);
  const raw = lines.map((l) => (l.lineSubtotal * discount) / subtotal);
  const floors = raw.map(Math.floor);
  let rest = discount - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}

// What a fulfilled order adds to its fulfilment day's rollup.
//   lines: [{ productId, quantity, lineSubtotal, costConsumed, sku, name, unit }]
export function orderContribution({ lines, discount = 0, customerId = null }) {
  const shares = allocateDiscount(lines, discount);
  const products = {};
  lines.forEach((l, i) => {
    const p = (products[l.productId] ||= { qty: 0, netSales: 0, cogs: 0, sku: l.sku ?? null, name: l.name ?? null, unit: l.unit ?? null });
    p.qty += l.quantity;
    p.netSales += l.lineSubtotal - shares[i];
    p.cogs += l.costConsumed ?? 0;
  });
  const netSales = lines.reduce((s, l) => s + l.lineSubtotal, 0) - discount;
  return { products, customers: { [customerId || WALK_IN_KEY]: { orders: 1, netSales } } };
}

const NUMERIC = { products: ["qty", "netSales", "cogs"], customers: ["orders", "netSales"], paymentMethods: ["count", "amount"], expenseCategories: ["count", "amount"], expenseMethods: ["count", "amount"] };
export const ROLLUP_SECTIONS = Object.freeze(Object.keys(NUMERIC));

// after - before, per section and key; zero entries dropped. Text fields
// (sku, name, unit) come from `after` (or `before` for a removed line).
export function diffRollup(after = {}, before = {}) {
  const out = {};
  for (const section of ROLLUP_SECTIONS) {
    const a = after[section] || {};
    const b = before[section] || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const entry = {};
      let nonZero = false;
      for (const f of NUMERIC[section]) {
        const d = (a[key]?.[f] ?? 0) - (b[key]?.[f] ?? 0);
        entry[f] = d;
        if (d) nonZero = true;
      }
      if (!nonZero) continue;
      if (section === "products") Object.assign(entry, { sku: (a[key] || b[key]).sku ?? null, name: (a[key] || b[key]).name ?? null, unit: (a[key] || b[key]).unit ?? null });
      (out[section] ||= {})[key] = entry;
    }
  }
  return out;
}

// Adds rollup b into a (in place), for summing documents into a range.
export function addRollup(a, b) {
  for (const section of ROLLUP_SECTIONS) {
    for (const [key, v] of Object.entries((b && b[section]) || {})) {
      const t = ((a[section] ||= {})[key] ||= {});
      for (const f of NUMERIC[section]) t[f] = (t[f] ?? 0) + (Number.isSafeInteger(v[f]) ? v[f] : 0);
      if (section === "products") for (const f of ["sku", "name", "unit"]) if (v[f]) t[f] = v[f];
    }
  }
  return a;
}

// Payment / expense single-record contributions.
export const paymentContribution = (p) => ({ paymentMethods: { [p.method]: { count: 1, amount: p.amount } } });
export const expenseContribution = (e) => ({ expenseCategories: { [e.category]: { count: 1, amount: e.amount } }, expenseMethods: { [e.method]: { count: 1, amount: e.amount } } });
