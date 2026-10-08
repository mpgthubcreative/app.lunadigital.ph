// Tenant-scoped metric documents: what they hold, how they're keyed by the
// BUSINESS's local date, and which documents a date range needs.
//
// The dashboard (and later reports) read a handful of these summary
// documents instead of scanning orders / payments / expenses. They are
// written only by server functions, with atomic increments inside the same
// transaction as the business event (netlify/functions/_lib/metrics.js).
//
// Two collections, because Firestore rules secure whole documents, not
// fields:
//   businesses/{bid}/metrics/{id}            operational counts    dashboard.view
//   businesses/{bid}/financialMetrics/{id}   money (centavos)      dashboard.financials
// Document ids:
//   YYYY-MM-DD   one business-local day (flows: what happened that day)
//   YYYY-MM      the same flows rolled up for one business-local month
//   current      gauges: how things stand right now (e.g. orders awaiting fulfillment)

export const METRICS_SCHEMA_VERSION = 1;
export const CURRENT_METRICS_ID = "current";

// Flows, incremented per business-local day (and month).
export const OPERATIONAL_COUNTERS = Object.freeze({
  orderCount: { label: "Orders", unit: "count", fedBy: "orders" },
  fulfilledOrders: { label: "Orders fulfilled", unit: "count", fedBy: "orders" },
  cancelledOrders: { label: "Orders cancelled", unit: "count", fedBy: "orders" },
});

export const FINANCIAL_COUNTERS = Object.freeze({
  grossSales: { label: "Gross sales", unit: "centavos", fedBy: "orders" },
  discounts: { label: "Discounts", unit: "centavos", fedBy: "orders" },
  returns: { label: "Returns / refunds", unit: "centavos", fedBy: "orders" },
  // Cost basis snapshotted on each sale, never re-derived from current product cost.
  cogs: { label: "Cost of goods sold", unit: "centavos", fedBy: "orders" },
  operatingExpenses: { label: "Operating expenses", unit: "centavos", fedBy: "expenses" },
  paymentsReceived: { label: "Payments received", unit: "centavos", fedBy: "payments" },
});

// Gauges on the `current` documents: adjusted up and down as state changes.
export const OPERATIONAL_GAUGES = Object.freeze({
  pendingFulfillment: { label: "Orders for fulfillment / delivery", unit: "count", fedBy: "orders" },
  unpaidOrders: { label: "Unpaid orders", unit: "count", fedBy: "payments" },
  lowStockProducts: { label: "Low-stock products", unit: "count", fedBy: "inventory" },
});

export const FINANCIAL_GAUGES = Object.freeze({
  receivablesOutstanding: { label: "Unpaid balance", unit: "centavos", fedBy: "payments" },
  // Deliberately NO inventory-value gauge: it would make this document a
  // write hot spot for every stock movement in the business. Total value is
  // a sum() aggregation over productCosts.inventoryValue instead.
});

const DAY_ID = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ID = /^(\d{4})-(\d{2})$/;

export function isDayId(value) {
  const m = typeof value === "string" && DAY_ID.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return date.getUTCFullYear() === +m[1] && date.getUTCMonth() === +m[2] - 1 && date.getUTCDate() === +m[3];
}

export function isMonthId(value) {
  const m = typeof value === "string" && MONTH_ID.exec(value);
  return Boolean(m) && +m[2] >= 1 && +m[2] <= 12;
}

export function isMetricsDocId(value) {
  return value === CURRENT_METRICS_ID || isDayId(value) || isMonthId(value);
}

// The calendar date at `at` in the business's IANA timezone. Throws on an
// invalid timezone or date: a metric must never land on a guessed day.
export function businessDate(timezone, at = new Date()) {
  const instant = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(instant.getTime())) throw new RangeError("businessDate: invalid date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function businessMonth(timezone, at = new Date()) {
  return businessDate(timezone, at).slice(0, 7);
}

// Pure calendar arithmetic on day ids (no timezone involved).
function toUtc(dayId) {
  const [y, m, d] = dayId.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const fromUtc = (date) => date.toISOString().slice(0, 10);

export function addDays(dayId, days) {
  const date = toUtc(dayId);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

export const RANGE_PRESETS = Object.freeze(["today", "yesterday", "thisWeek", "thisMonth", "custom"]);
export const MAX_RANGE_DAYS = 366;

// Resolves a dashboard/report range to inclusive business-local day ids.
// Weeks start on Monday (weekStartsOn: 1) unless told otherwise.
export function resolveRange(preset, { timezone, now = new Date(), from, to, weekStartsOn = 1 } = {}) {
  const today = businessDate(timezone, now);
  switch (preset) {
    case "today":
      return { preset, from: today, to: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { preset, from: day, to: day };
    }
    case "thisWeek": {
      const weekday = toUtc(today).getUTCDay();
      const back = (weekday - weekStartsOn + 7) % 7;
      return { preset, from: addDays(today, -back), to: today };
    }
    case "thisMonth":
      return { preset, from: `${today.slice(0, 7)}-01`, to: today };
    case "custom": {
      if (!isDayId(from) || !isDayId(to)) throw new RangeError("custom range needs from/to as YYYY-MM-DD");
      if (from > to) throw new RangeError("custom range: from is after to");
      if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new RangeError(`custom range is longer than ${MAX_RANGE_DAYS} days`);
      return { preset, from, to };
    }
    default:
      throw new RangeError(`unknown range preset ${preset}`);
  }
}

// The fewest metric documents that cover [from, to]: whole calendar months
// as month rollups, the remaining days as day documents. A full year is
// 12 reads, not 365.
export function metricDocIdsForRange({ from, to }) {
  if (!isDayId(from) || !isDayId(to) || from > to) throw new RangeError("metricDocIdsForRange: invalid range");
  const ids = [];
  let day = from;
  while (day <= to) {
    const month = day.slice(0, 7);
    const monthEnd = addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1);
    if (day.endsWith("-01") && monthEnd <= to) {
      ids.push(month);
      day = addDays(monthEnd, 1);
    } else {
      ids.push(day);
      day = addDays(day, 1);
    }
  }
  return ids;
}

const isCount = (v) => Number.isSafeInteger(v);

// Sums counter fields across metric documents. A missing document means
// "nothing recorded that day" (0); a present but non-integer field makes
// that total unknown (null) instead of silently wrong.
export function sumCounters(docs, keys) {
  const present = docs.filter((d) => d && typeof d === "object");
  const totals = {};
  for (const key of keys) {
    let total = 0;
    for (const doc of present) {
      const value = doc[key];
      if (value === undefined) continue;
      if (!isCount(value)) {
        total = null;
        break;
      }
      total += value;
    }
    totals[key] = total;
  }
  return { hasData: present.length > 0, totals };
}
