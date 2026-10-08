// Server-side metrics writer. Later phases (Orders, Inventory, Payments,
// Expenses) call these INSIDE the transaction that records the business
// event, so a metric can never drift from the data it summarizes:
//
//   await db.runTransaction(async (tx) => {
//     ...write the order...
//     recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, at: recognizedAt,
//       operational: { orderCount: 1 }, financial: { grossSales: total, cogs: costSnapshot } });
//     adjustCurrentMetrics({ tx, tenant, FieldValue, operational: { pendingFulfillment: 1 } });
//   });
//
// Everything is an atomic increment (FieldValue.increment), so concurrent
// events never overwrite each other. Unknown fields or non-integer deltas
// throw: a typo must fail the whole transaction, not create a stray field.
// Each event updates the business-local day AND its month rollup, so a month
// is one read, not thirty. Every counter is written on every update (0 if
// unchanged), so a document never has a partial set of components.

import {
  METRICS_SCHEMA_VERSION,
  CURRENT_METRICS_ID,
  OPERATIONAL_COUNTERS,
  FINANCIAL_COUNTERS,
  OPERATIONAL_GAUGES,
  FINANCIAL_GAUGES,
  businessDate,
} from "../../../shared/metrics.js";

function deltas(values, definitions, label) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!(key in definitions)) throw new Error(`metrics: unknown ${label} field ${key}`);
    if (!Number.isSafeInteger(value)) throw new Error(`metrics: ${label}.${key} must be an integer (centavos / count)`);
  }
  for (const key of Object.keys(definitions)) out[key] = (values && values[key]) || 0;
  return out;
}

function incrementAll(FieldValue, values) {
  return Object.fromEntries(Object.entries(values).map(([key, n]) => [key, FieldValue.increment(n)]));
}

// Flows for the business-local day of `at` (+ its month rollup).
export function recordDailyMetrics({ tx, tenant, FieldValue, timezone, at, operational = null, financial = null }) {
  const day = businessDate(timezone, at); // throws on a bad timezone
  const month = day.slice(0, 7);
  const meta = (period, id) => ({ schemaVersion: METRICS_SCHEMA_VERSION, period, id, timezone, updatedAt: FieldValue.serverTimestamp() });

  const writes = [];
  if (operational) {
    const values = incrementAll(FieldValue, deltas(operational, OPERATIONAL_COUNTERS, "operational"));
    writes.push(["metrics", day, { ...meta("day", day), ...values }], ["metrics", month, { ...meta("month", month), ...values }]);
  }
  if (financial) {
    const values = incrementAll(FieldValue, deltas(financial, FINANCIAL_COUNTERS, "financial"));
    writes.push(["financialMetrics", day, { ...meta("day", day), ...values }], ["financialMetrics", month, { ...meta("month", month), ...values }]);
  }
  for (const [collection, id, data] of writes) tx.set(tenant.doc(collection, id), data, { merge: true });
  return { day, month };
}

// Gauges ("how things stand now"): +1 when an order awaits fulfillment,
// -1 when it ships, and so on.
export function adjustCurrentMetrics({ tx, tenant, FieldValue, operational = null, financial = null }) {
  const meta = { schemaVersion: METRICS_SCHEMA_VERSION, period: "current", id: CURRENT_METRICS_ID, updatedAt: FieldValue.serverTimestamp() };
  if (operational) tx.set(tenant.doc("metrics", CURRENT_METRICS_ID), { ...meta, ...incrementAll(FieldValue, deltas(operational, OPERATIONAL_GAUGES, "operational gauge")) }, { merge: true });
  if (financial) tx.set(tenant.doc("financialMetrics", CURRENT_METRICS_ID), { ...meta, ...incrementAll(FieldValue, deltas(financial, FINANCIAL_GAUGES, "financial gauge")) }, { merge: true });
}
